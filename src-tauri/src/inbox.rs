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
    // When set, content was appended to this existing project note instead of
    // creating a new per-capture file. Holds the note's display title for the
    // status toast — the user picks notes by title in the popup so they
    // recognize the same string back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appended_to: Option<String>,
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
    // Append-to-existing flow: tag was `@Project/Note Title`. Holds the
    // resolved project, the cleaned title we matched on (for the toast), and
    // the relative path of the note file to append into.
    AppendToProjectNote {
        project: &'a KnownProject,
        note_title: String,
        note_rel_path: String,
    },
    ExistingNote(String),   // relative vault path
    NewNote(String),        // tag (preserved verbatim as filename stem)
}

fn resolve_tag<'a>(tag: &str, vault: &Path, projects: &'a [KnownProject]) -> TagResolution<'a> {
    // `@Project/Note Title` — drill into a project's notes and append into a
    // chosen one. Split on the first `/` only; note titles can contain slashes
    // but the project name can't.
    if let Some((left, right)) = tag.split_once('/') {
        let note_query = right.trim();
        if !note_query.is_empty() {
            if let Some(project) = resolve_project(left.trim(), projects) {
                if let Some((rel, title)) = find_project_note_by_title(vault, project, note_query) {
                    return TagResolution::AppendToProjectNote {
                        project,
                        note_title: title,
                        note_rel_path: rel,
                    };
                }
                // Project resolved but the note name didn't match anything —
                // fall through to plain project routing so the capture still
                // lands somewhere sensible instead of becoming a stray new note.
                return TagResolution::Project(project);
            }
        }
    }

    if let Some(p) = resolve_project(tag, projects) {
        return TagResolution::Project(p);
    }
    if let Some(rel) = find_note_or_wiki_file(tag, vault) {
        return TagResolution::ExistingNote(rel);
    }
    TagResolution::NewNote(tag.to_string())
}

/// Find a note inside `projects/.../notes/` whose `derive_title` (markdown
/// stripped) normalizes to the same key as `query`. On ties, prefers the
/// most recently modified file so an active note wins over an old duplicate.
fn find_project_note_by_title(
    vault: &Path,
    project: &KnownProject,
    query: &str,
) -> Option<(String, String)> {
    let notes_dir = vault.join(&project.rel_path).join("notes");
    if !notes_dir.is_dir() { return None; }

    let target = normalize_for_match(query);
    if target.is_empty() { return None; }

    let entries = fs::read_dir(&notes_dir).ok()?;
    let mut best: Option<(String, String, std::time::SystemTime)> = None;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (_, body) = split_frontmatter(&content);
        let title = crate::note_meta::derive_title(&body);
        if title.is_empty() {
            continue;
        }
        if normalize_for_match(&title) != target {
            continue;
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).ok();
        let rel = path.strip_prefix(vault).ok()
            .map(|r| r.to_string_lossy().replace('\\', "/"))?;
        match (&best, mtime) {
            (None, Some(t)) => best = Some((rel, title, t)),
            (Some((_, _, prev)), Some(t)) if t > *prev => best = Some((rel, title, t)),
            _ => {}
        }
    }

    best.map(|(rel, title, _)| (rel, title))
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

        // Slash-tag form: `@Project/Note Title`. Note titles can contain any
        // punctuation (apostrophes, colons, commas, the `…` from title
        // truncation), so accept any non-newline char after `@`. The leading
        // `@` plus the `/` keeps this from gobbling stray sentences — prose
        // rarely contains `@word/word`.
        if trimmed.starts_with('@')
            && !trimmed.starts_with("@[")
            && trimmed.contains('/')
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

/// Writes a brand-new note file for a single routed capture. Filename is
/// `YYYY-MM-DD-HHMM.md` derived from `stamp` (`YYYY-MM-DDTHH:MM`), with a
/// numeric suffix on collision. Stamps frontmatter (type/status/created/
/// updated/pinned). Does not append to existing files: per-capture granularity
/// is the whole point of this function.
fn write_project_note_per_capture(
    vault: &Path,
    project_path: &str,
    notes: &[String],
    stamp: &str,
) -> Result<(), String> {
    let notes_dir = vault.join(project_path).join("notes");
    if !notes_dir.exists() {
        fs::create_dir_all(&notes_dir)
            .map_err(|e| format!("Failed to create notes dir: {}", e))?;
    }

    let body = notes.join("\n").trim().to_string();
    if body.is_empty() {
        return Ok(());
    }

    let base_name = stamp.replacen('T', "-", 1).replace(':', "");
    let mut filename = format!("{}.md", base_name);
    let mut suffix = 0u32;
    while notes_dir.join(&filename).exists() {
        suffix += 1;
        filename = format!("{}-{}.md", base_name, suffix);
    }

    let note_path = notes_dir.join(&filename);
    let frontmatter = format!(
        "---\ntype: note\nstatus: active\ncreated: {ts}\nupdated: {ts}\npinned: false\n---\n\n",
        ts = stamp
    );
    let content = format!("{}{}\n", frontmatter, body);
    fs::write(&note_path, content).map_err(|e| format!("Failed to write note: {}", e))
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

/// Create a new notes/{tag}.md file, stamping frontmatter. Path separators
/// in the tag are flattened to `-` so a manually-typed `@Foo/Bar` (where
/// neither side resolves to a project) doesn't try to create a subdirectory.
fn create_new_note_file(vault: &Path, tag: &str, content: &str, date_str: &str) -> Result<String, String> {
    let notes_dir = vault.join("notes");
    fs::create_dir_all(&notes_dir)
        .map_err(|e| format!("Failed to create notes dir: {}", e))?;

    let safe_stem = tag.replace('/', "-");
    let rel_path = format!("notes/{}.md", safe_stem);
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
pub(crate) fn split_frontmatter(content: &str) -> (String, String) {
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
    stamp: &str,
    routed: &mut Vec<RoutedProject>,
) -> Result<(), String> {
    let (todo_blocks, notes, todo_count) = split_todos_and_notes(lines);
    let note_count = notes.iter().filter(|l| !l.trim().is_empty()).count();

    if !todo_blocks.is_empty() {
        append_todos(vault, &project.rel_path, &todo_blocks, today)?;
    }
    if notes.iter().any(|l| !l.trim().is_empty()) {
        write_project_note_per_capture(vault, &project.rel_path, &notes, stamp)?;
    }
    if todo_count > 0 || note_count > 0 {
        routed.push(RoutedProject {
            project: project.display.clone(),
            path: project.rel_path.clone(),
            todos_added: todo_count,
            notes_added: note_count,
            appended_to: None,
        });
    }
    Ok(())
}

/// Append-into-existing project note: todos still flow to the project's
/// `todos.md` (unchanged from the per-capture path), but notes are appended
/// to the chosen note file rather than minting a new one.
fn route_to_project_append(
    vault: &Path,
    project: &KnownProject,
    note_title: &str,
    note_rel_path: &str,
    lines: &[String],
    today: &str,
    routed: &mut Vec<RoutedProject>,
) -> Result<(), String> {
    let (todo_blocks, notes, todo_count) = split_todos_and_notes(lines);
    let note_count = notes.iter().filter(|l| !l.trim().is_empty()).count();

    if !todo_blocks.is_empty() {
        append_todos(vault, &project.rel_path, &todo_blocks, today)?;
    }
    if note_count > 0 {
        let body: String = notes.iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let trimmed = body.trim();
        if !trimmed.is_empty() {
            append_to_note_file(vault, note_rel_path, trimmed, today)?;
        }
    }
    if todo_count > 0 || note_count > 0 {
        routed.push(RoutedProject {
            project: project.display.clone(),
            path: project.rel_path.clone(),
            todos_added: todo_count,
            notes_added: note_count,
            appended_to: Some(note_title.to_string()),
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
                        route_to_project(&vault, project, &section.lines, &today, &timestamp, &mut routed)?;
                    }
                    TagResolution::AppendToProjectNote { project, note_title, note_rel_path } => {
                        route_to_project_append(&vault, project, &note_title, &note_rel_path, &section.lines, &today, &mut routed)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_slash_tag_without_spaces() {
        // `@Project/Note` (no spaces) hits the first parser branch which
        // accepts any non-space chars after `@`.
        let body = "---\n---\n@Foo/Bar Title\nthe captured line\nanother\n";
        let sections = parse_inbox(body);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].tag.as_deref(), Some("Foo/Bar Title"));
        assert_eq!(sections[0].lines, vec!["the captured line", "another"]);
    }

    #[test]
    fn parses_slash_tag_with_spaces_in_note_name() {
        // `@Project/Note Title With Spaces` — handled by the dedicated
        // slash-tag branch (spaces + slash combo).
        let body = "@Kalkyl/Note With Spaces\ncaptured content\n";
        let sections = parse_inbox(body);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].tag.as_deref(), Some("Kalkyl/Note With Spaces"));
    }

    #[test]
    fn parses_slash_tag_with_punctuation_in_note_title() {
        // Real note titles routinely contain apostrophes, commas, colons,
        // parens — and `derive_title` adds `…` on 80-char truncation. The
        // slash-tag branch must accept all of these or the section gets
        // misclassified as untagged content.
        let cases = [
            "@Kalkyl/Don't forget",
            "@Kalkyl/Idea: spike on auth",
            "@Kalkyl/Note, with comma",
            "@Kalkyl/Some really long title that needs truncation…",
            "@Kalkyl/Refactor (work in progress)",
            "@Kalkyl/Bug #1234",
        ];
        for line in cases {
            let body = format!("{}\ncaptured line\n", line);
            let sections = parse_inbox(&body);
            assert_eq!(
                sections.len(),
                1,
                "expected one section for {}",
                line,
            );
            assert!(
                sections[0].tag.is_some(),
                "expected tag recognised for {}",
                line,
            );
            assert_eq!(sections[0].lines, vec!["captured line"]);
        }
    }

    #[test]
    fn unrelated_at_line_without_slash_still_strict() {
        // Sanity: a line that starts with `@` but has no slash and contains
        // disallowed punctuation is NOT treated as a tag — it stays content.
        let body = "@some random sentence, with comma\n";
        let sections = parse_inbox(body);
        assert_eq!(sections.len(), 1);
        assert!(sections[0].tag.is_none());
    }
}
