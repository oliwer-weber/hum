// Deterministic inbox processor — routes @tagged content to projects, existing
// notes/wiki files, or new notes. Untagged content stays in the inbox for AI
// follow-up. No AI in the hot path: resolution is a pure function of the vault.

use std::fs;
use std::path::{Path, PathBuf};
use chrono::Local;
use serde::Serialize;

use crate::todo_index;
use crate::todo_parser;
use crate::vault_manifest::VaultManifest;
use crate::vault_path;

// ── Types ────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct RoutedProject {
    pub project: String,       // display name
    pub path: String,          // relative vault path (e.g. "projects/work/Kalkyl-X")
    pub todos_added: usize,
    pub notes_added: usize,
}

#[derive(Serialize, Clone)]
pub struct RoutedNote {
    pub tag: String,           // the tag as typed (never renamed)
    pub path: String,          // relative vault path (e.g. "notes/songtips.md")
    pub entries_added: usize,  // non-empty lines added
    pub is_new: bool,          // true if the file was just created
}

#[derive(Serialize)]
pub struct ProcessResult {
    pub routed: Vec<RoutedProject>,
    pub notes_routed: Vec<RoutedNote>,
    pub untagged_remaining: Vec<String>,
    pub timestamp: String,
}

// ── Known project index ──────────────────────────────

struct KnownProject {
    name: String,       // last segment, lowercase for matching
    display: String,    // last segment, original case
    rel_path: String,   // full relative path from vault root
}

fn load_known_projects(vault: &Path) -> Vec<KnownProject> {
    let manifest = match VaultManifest::read_in(vault) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };

    manifest
        .project_paths()
        .map(|rel| {
            let display = rel.rsplit('/').next().unwrap_or(rel).to_string();
            KnownProject {
                name: display.to_lowercase(),
                display,
                rel_path: rel.to_string(),
            }
        })
        .collect()
}

/// Normalize for matching: strip non-alphanumeric, lowercase. So `song-tips`,
/// `song_tips`, `Song Tips`, `songtips` all collapse to `songtips`.
fn normalize_for_match(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

/// Split a string into words (alphanumeric runs) and normalize each to lowercase.
fn word_tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// Resolve an @tag to a known project. Matches only when:
/// 1. The tag, normalized, equals the full project name normalized, OR
/// 2. The tag is a single word that appears as a full word in the project name.
/// Deliberately strict — loose substring matching caused false positives
/// (e.g. `@seeding_test` resolving to project `test`).
fn resolve_project<'a>(tag: &str, projects: &'a [KnownProject]) -> Option<&'a KnownProject> {
    let tag_norm = normalize_for_match(tag);
    if tag_norm.is_empty() { return None; }
    let tag_tokens = word_tokens(tag);
    let single_word_tag = tag_tokens.len() == 1;

    for p in projects {
        if normalize_for_match(&p.name) == tag_norm {
            return Some(p);
        }
    }

    if single_word_tag {
        for p in projects {
            let p_tokens = word_tokens(&p.name);
            if p_tokens.iter().any(|w| w == &tag_tokens[0]) {
                return Some(p);
            }
        }
    }

    None
}

/// Search `notes/` and `wiki/` (including subdirectories) for a file whose stem
/// matches the tag under the same normalization as project matching (strip
/// non-alphanumeric, lowercase). Returns the relative path from vault root.
fn find_note_or_wiki_file(tag: &str, vault: &Path) -> Option<String> {
    let tag_norm = normalize_for_match(tag);
    if tag_norm.is_empty() { return None; }

    fn recur(dir: &Path, tag_norm: &str, found: &mut Option<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            if found.is_some() { return; }
            let path = entry.path();
            if path.is_dir() {
                recur(&path, tag_norm, found);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if normalize_for_match(stem) == tag_norm {
                        *found = Some(path);
                        return;
                    }
                }
            }
        }
    }

    let mut found = None;
    for subdir in &["notes", "wiki"] {
        let d = vault.join(subdir);
        if d.exists() {
            recur(&d, &tag_norm, &mut found);
            if found.is_some() { break; }
        }
    }

    found.and_then(|p| p.strip_prefix(vault).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
}

enum TagResolution<'a> {
    Project(&'a KnownProject),
    ExistingNote(String),   // relative vault path
    NewNote(String),        // tag (preserved verbatim as filename stem)
}

fn resolve_tag<'a>(tag: &str, vault: &Path, projects: &'a [KnownProject]) -> TagResolution<'a> {
    if let Some(p) = resolve_project(tag, projects) {
        return TagResolution::Project(p);
    }
    if let Some(rel) = find_note_or_wiki_file(tag, vault) {
        return TagResolution::ExistingNote(rel);
    }
    TagResolution::NewNote(tag.to_string())
}

// ── Inbox parser ─────────────────────────────────────

struct ParsedSection {
    tag: Option<String>,   // None = untagged
    lines: Vec<String>,
}

fn parse_inbox(content: &str) -> Vec<ParsedSection> {
    let mut sections: Vec<ParsedSection> = Vec::new();
    let mut current_tag: Option<String> = None;
    let mut current_lines: Vec<String> = Vec::new();

    let body = strip_frontmatter(content);

    for line in body.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with('@') && !trimmed.contains(' ') && trimmed.len() > 1 {
            if !current_lines.is_empty() || current_tag.is_some() {
                sections.push(ParsedSection {
                    tag: current_tag.take(),
                    lines: std::mem::take(&mut current_lines),
                });
            }
            current_tag = Some(trimmed[1..].to_string());
            continue;
        }

        if trimmed.starts_with('@')
            && !trimmed.starts_with("@[")
            && trimmed.chars().skip(1).all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ' ')
            && trimmed.len() > 1
        {
            if !current_lines.is_empty() || current_tag.is_some() {
                sections.push(ParsedSection {
                    tag: current_tag.take(),
                    lines: std::mem::take(&mut current_lines),
                });
            }
            current_tag = Some(trimmed[1..].trim().to_string());
            continue;
        }

        current_lines.push(line.to_string());
    }

    if !current_lines.is_empty() || current_tag.is_some() {
        sections.push(ParsedSection {
            tag: current_tag,
            lines: current_lines,
        });
    }

    sections
}

fn strip_frontmatter(content: &str) -> &str {
    if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            let after = &content[3 + end + 3..];
            return after.trim_start_matches('\n').trim_start_matches('\r');
        }
    }
    content
}

// ── File operations: projects ────────────────────────

fn append_todos(vault: &Path, project_path: &str, todo_blocks: &[String], date_str: &str) -> Result<(), String> {
    let path = vault.join(project_path).join("todos.md");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let created_tag = format!(" <!-- created:{} -->", date_str);

    let mut new_content = existing.trim_end().to_string();
    for block in todo_blocks {
        new_content.push('\n');
        let mut lines = block.lines();
        if let Some(first_line) = lines.next() {
            let mut stamped = first_line.trim_end().to_string();

            if !stamped.contains("<!-- id:") {
                let id = todo_index::generate_id();
                stamped = format!("{} <!-- id:{} -->", stamped, id);
            }

            if !stamped.contains("<!-- created:") {
                stamped = format!("{}{}", stamped, created_tag);
            }

            new_content.push_str(&stamped);

            for continuation in lines {
                new_content.push('\n');
                new_content.push_str(continuation);
            }
        }
    }
    new_content.push('\n');

    fs::write(&path, new_content).map_err(|e| format!("Failed to write todos: {}", e))
}

fn append_project_notes(
    vault: &Path,
    project_path: &str,
    notes: &[String],
    date_str: &str,
) -> Result<(), String> {
    let notes_dir = vault.join(project_path).join("notes");
    if !notes_dir.exists() {
        fs::create_dir_all(&notes_dir)
            .map_err(|e| format!("Failed to create notes dir: {}", e))?;
    }

    let note_file = notes_dir.join(format!("{}.md", date_str));
    let existing = fs::read_to_string(&note_file).unwrap_or_default();
    let mut new_content = existing.trim_end().to_string();

    if !new_content.is_empty() {
        new_content.push_str("\n\n");
    }

    let note_text = notes.join("\n").trim().to_string();
    new_content.push_str(&note_text);
    new_content.push('\n');

    fs::write(&note_file, new_content).map_err(|e| format!("Failed to write notes: {}", e))
}

// ── File operations: notes/wiki running-list files ───

/// Append content verbatim to an existing notes/ or wiki/ file, bumping the
/// `updated` frontmatter date.
fn append_to_note_file(vault: &Path, rel_path: &str, content: &str, date_str: &str) -> Result<(), String> {
    let full_path = vault.join(rel_path);
    let existing = fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read {}: {}", rel_path, e))?;

    let (frontmatter, body) = split_frontmatter(&existing);
    let new_frontmatter = bump_updated_field(&frontmatter, date_str);
    let new_body = {
        let trimmed = body.trim_end();
        let addition = content.trim();
        if trimmed.is_empty() {
            format!("{}\n", addition)
        } else {
            format!("{}\n\n{}\n", trimmed, addition)
        }
    };

    let combined = if new_frontmatter.is_empty() {
        new_body
    } else {
        format!("{}\n{}", new_frontmatter, new_body)
    };

    fs::write(&full_path, combined)
        .map_err(|e| format!("Failed to write note file: {}", e))
}

/// Create a new notes/{tag}.md file, stamping frontmatter.
fn create_new_note_file(vault: &Path, tag: &str, content: &str, date_str: &str) -> Result<String, String> {
    let notes_dir = vault.join("notes");
    fs::create_dir_all(&notes_dir)
        .map_err(|e| format!("Failed to create notes dir: {}", e))?;

    let rel_path = format!("notes/{}.md", tag);
    let full_path = vault.join(&rel_path);

    let frontmatter = format!(
        "---\ntype: note\nstatus: active\ncreated: {}\nupdated: {}\n---\n",
        date_str, date_str
    );
    let body = content.trim();
    let full = if body.is_empty() {
        frontmatter
    } else {
        format!("{}\n{}\n", frontmatter, body)
    };

    fs::write(&full_path, full)
        .map_err(|e| format!("Failed to create note file: {}", e))?;

    Ok(rel_path)
}

/// Split content into (frontmatter_with_fences, body). Returns empty frontmatter
/// if the file doesn't start with `---`.
fn split_frontmatter(content: &str) -> (String, String) {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return (String::new(), content.to_string());
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let mut end = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim_end() == "---" {
            end = Some(i);
            break;
        }
    }
    match end {
        Some(e) => {
            let fm = lines[..=e].join("\n");
            let body = lines.get(e + 1..).map(|s| s.join("\n")).unwrap_or_default();
            // Trim leading blank after frontmatter
            let body = body.trim_start_matches('\n').to_string();
            (fm, body)
        }
        None => (String::new(), content.to_string()),
    }
}

/// Replace or insert the `updated:` field in a frontmatter block.
fn bump_updated_field(frontmatter: &str, date_str: &str) -> String {
    if frontmatter.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = frontmatter.split('\n').map(|s| s.to_string()).collect();
    let mut found = false;
    for line in lines.iter_mut() {
        if line.starts_with("updated:") {
            *line = format!("updated: {}", date_str);
            found = true;
            break;
        }
    }
    if !found {
        // Insert before the closing `---`
        if let Some(close_idx) = lines.iter().rposition(|l| l.trim_end() == "---") {
            lines.insert(close_idx, format!("updated: {}", date_str));
        }
    }
    lines.join("\n")
}

// ── Inbox remainder / config timestamp ───────────────

fn update_manifest_timestamp(vault: &Path, timestamp: &str) -> Result<(), String> {
    let mut manifest = VaultManifest::read_in(vault)?;
    manifest.set_last_inbox_processing(timestamp);
    manifest.write_in(vault)
}

fn write_inbox_remainder(vault: &Path, untagged_lines: &[String]) -> Result<(), String> {
    let path = vault.join("inbox").join("inbox.md");
    let frontmatter = "---\ncssclasses:\n  - home-title\n---\n";

    let body = untagged_lines
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    let content = if body.is_empty() {
        frontmatter.to_string()
    } else {
        format!("{}\n{}\n", frontmatter, body)
    };

    fs::write(&path, content).map_err(|e| format!("Failed to write inbox: {}", e))
}

// ── Routing helpers ──────────────────────────────────

/// Split section lines into todo blocks and note lines. Returns (raw_blocks, notes, todo_count).
fn split_todos_and_notes(lines: &[String]) -> (Vec<String>, Vec<String>, usize) {
    let section_text = lines.join("\n");
    let blocks = todo_parser::parse_todo_blocks(&section_text);

    let mut todo_line_ranges: Vec<(usize, usize)> = Vec::new();
    let mut todo_raw_blocks: Vec<String> = Vec::new();
    for block in &blocks {
        let start = block.line_number - 1;
        let end = start + block.line_count;
        todo_line_ranges.push((start, end));
        todo_raw_blocks.push(todo_parser::block_to_markdown(block));
    }

    let mut notes: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let in_todo = todo_line_ranges.iter().any(|(s, e)| i >= *s && i < *e);
        if !in_todo {
            notes.push(line.clone());
        }
    }

    (todo_raw_blocks, notes, blocks.len())
}

fn route_to_project(
    vault: &Path,
    project: &KnownProject,
    lines: &[String],
    today: &str,
    routed: &mut Vec<RoutedProject>,
) -> Result<(), String> {
    let (todo_blocks, notes, todo_count) = split_todos_and_notes(lines);
    let note_count = notes.iter().filter(|l| !l.trim().is_empty()).count();

    if !todo_blocks.is_empty() {
        append_todos(vault, &project.rel_path, &todo_blocks, today)?;
    }
    if notes.iter().any(|l| !l.trim().is_empty()) {
        append_project_notes(vault, &project.rel_path, &notes, today)?;
    }
    if todo_count > 0 || note_count > 0 {
        routed.push(RoutedProject {
            project: project.display.clone(),
            path: project.rel_path.clone(),
            todos_added: todo_count,
            notes_added: note_count,
        });
    }
    Ok(())
}

fn route_to_note_file(
    vault: &Path,
    tag: &str,
    rel_path: String,
    is_new: bool,
    lines: &[String],
    today: &str,
    notes_routed: &mut Vec<RoutedNote>,
) -> Result<(), String> {
    let content: String = lines.iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let entries_added = lines.iter().filter(|l| !l.trim().is_empty()).count();

    let final_path = if is_new {
        create_new_note_file(vault, tag, trimmed, today)?
    } else {
        append_to_note_file(vault, &rel_path, trimmed, today)?;
        rel_path
    };

    notes_routed.push(RoutedNote {
        tag: tag.to_string(),
        path: final_path,
        entries_added,
        is_new,
    });
    Ok(())
}

// ── Main processor ───────────────────────────────────

pub fn process(vault_override: Option<PathBuf>) -> Result<ProcessResult, String> {
    let vault = vault_override.unwrap_or_else(vault_path);
    let projects = load_known_projects(&vault);
    let today = Local::now().format("%Y-%m-%d").to_string();
    let timestamp = Local::now().format("%Y-%m-%dT%H:%M").to_string();

    let inbox_path = vault.join("inbox").join("inbox.md");
    let inbox_content = fs::read_to_string(&inbox_path)
        .map_err(|e| format!("Failed to read inbox: {}", e))?;

    let sections = parse_inbox(&inbox_content);

    let mut routed: Vec<RoutedProject> = Vec::new();
    let mut notes_routed: Vec<RoutedNote> = Vec::new();
    let mut all_untagged: Vec<String> = Vec::new();

    for section in sections {
        match section.tag {
            None => {
                let non_empty: Vec<String> = section.lines.clone();
                if non_empty.iter().any(|l| !l.trim().is_empty()) {
                    all_untagged.extend(non_empty);
                }
            }
            Some(tag) => {
                match resolve_tag(&tag, &vault, &projects) {
                    TagResolution::Project(project) => {
                        route_to_project(&vault, project, &section.lines, &today, &mut routed)?;
                    }
                    TagResolution::ExistingNote(rel) => {
                        route_to_note_file(&vault, &tag, rel, false, &section.lines, &today, &mut notes_routed)?;
                    }
                    TagResolution::NewNote(new_tag) => {
                        route_to_note_file(&vault, &new_tag, String::new(), true, &section.lines, &today, &mut notes_routed)?;
                    }
                }
            }
        }
    }

    write_inbox_remainder(&vault, &all_untagged)?;
    update_manifest_timestamp(&vault, &timestamp)?;

    if let Err(e) = todo_index::rebuild_and_persist(&vault) {
        eprintln!("Warning: todo index rebuild failed: {}", e);
    }

    Ok(ProcessResult {
        routed,
        notes_routed,
        untagged_remaining: all_untagged.iter()
            .filter(|l| !l.trim().is_empty())
            .cloned()
            .collect(),
        timestamp,
    })
}
