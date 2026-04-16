// Deterministic inbox processor — routes @project-tagged content to the correct
// vault files without AI involvement. Untagged content stays in the inbox for
// the AI to handle in a follow-up pass.

use std::fs;
use std::path::{Path, PathBuf};
use chrono::Local;
use serde::Serialize;

use crate::todo_index;
use crate::todo_parser;
use crate::vault_path;

// ── Types ────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct RoutedProject {
    pub project: String,       // display name
    pub path: String,          // relative vault path (e.g. "01 projects/01 work/Kalkyl-X")
    pub todos_added: usize,
    pub notes_added: usize,
}

#[derive(Serialize)]
pub struct ProcessResult {
    pub routed: Vec<RoutedProject>,
    pub untagged_remaining: Vec<String>,      // lines left in inbox (no @tag)
    pub unknown_tags: Vec<String>,            // @tags that didn't match any project
    pub hub_files_updated: Vec<String>,       // hub files where new date embeds were added
    pub timestamp: String,
}

// ── Known project index ──────────────────────────────

struct KnownProject {
    name: String,       // last segment, lowercase for matching
    display: String,    // last segment, original case
    rel_path: String,   // full relative path from vault root
}

fn load_known_projects(vault: &Path) -> Vec<KnownProject> {
    let config_path = vault.join("claude-config.md");
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut projects = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("- 01 projects/") {
            let rel = trimmed.trim_start_matches("- ").to_string();
            let display = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            projects.push(KnownProject {
                name: display.to_lowercase(),
                display,
                rel_path: rel,
            });
        }
    }
    projects
}

/// Fuzzy-match an @tag against known projects. Normalizes spaces/hyphens and
/// does case-insensitive comparison.
fn resolve_project<'a>(tag: &str, projects: &'a [KnownProject]) -> Option<&'a KnownProject> {
    let normalized = tag.to_lowercase().replace('-', " ").replace('_', " ");

    // Exact match first
    for p in projects {
        let p_norm = p.name.replace('-', " ").replace('_', " ");
        if p_norm == normalized {
            return Some(p);
        }
    }

    // Substring / contains match (e.g. "@galderma" matches "SE512 - Galderma")
    for p in projects {
        let p_norm = p.name.replace('-', " ").replace('_', " ");
        if p_norm.contains(&normalized) || normalized.contains(&p_norm) {
            return Some(p);
        }
    }

    None
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

    // Strip frontmatter
    let body = strip_frontmatter(content);

    for line in body.lines() {
        let trimmed = line.trim();

        // Detect @projectname marker (a line that starts with @ and is just a tag)
        if trimmed.starts_with('@') && !trimmed.contains(' ') && trimmed.len() > 1 {
            // Save previous section
            if !current_lines.is_empty() || current_tag.is_some() {
                sections.push(ParsedSection {
                    tag: current_tag.take(),
                    lines: std::mem::take(&mut current_lines),
                });
            }
            current_tag = Some(trimmed[1..].to_string());
            continue;
        }

        // Also handle "@project name" with spaces on the tag line
        if trimmed.starts_with('@')
            && !trimmed.starts_with("@[")  // not a markdown link
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

    // Final section
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

// ── File operations ──────────────────────────────────

/// Append todo blocks to a project's todos.md. Each block is the full raw
/// markdown (checkbox line + continuation lines). UUID and created tag are
/// stamped on the first line of each block.
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

            // Stamp UUID if not already present
            if !stamped.contains("<!-- id:") {
                let id = todo_index::generate_id();
                stamped = format!("{} <!-- id:{} -->", stamped, id);
            }

            // Stamp created date if not already present
            if !stamped.contains("<!-- created:") {
                stamped = format!("{}{}", stamped, created_tag);
            }

            new_content.push_str(&stamped);

            // Append continuation lines as-is
            for continuation in lines {
                new_content.push('\n');
                new_content.push_str(continuation);
            }
        }
    }
    new_content.push('\n');

    fs::write(&path, new_content).map_err(|e| format!("Failed to write todos: {}", e))
}

fn append_notes(
    vault: &Path,
    project_path: &str,
    project_display: &str,
    notes: &[String],
    date_str: &str,
) -> Result<bool, String> {
    // bool: true if a new date file was created
    let notes_dir = vault.join(project_path).join("notes");
    if !notes_dir.exists() {
        fs::create_dir_all(&notes_dir)
            .map_err(|e| format!("Failed to create notes dir: {}", e))?;
    }

    let note_file = notes_dir.join(format!("{}.md", date_str));
    let is_new = !note_file.exists();

    let existing = fs::read_to_string(&note_file).unwrap_or_default();
    let mut new_content = existing.trim_end().to_string();

    if !new_content.is_empty() {
        new_content.push_str("\n\n");
    }

    let note_text = notes.join("\n").trim().to_string();
    new_content.push_str(&note_text);
    new_content.push('\n');

    fs::write(&note_file, new_content).map_err(|e| format!("Failed to write notes: {}", e))?;

    // If new date file, update the hub
    if is_new {
        update_hub_file(vault, project_path, project_display, date_str)?;
    }

    Ok(is_new)
}

fn update_hub_file(
    vault: &Path,
    project_path: &str,
    project_display: &str,
    date_str: &str,
) -> Result<(), String> {
    let hub_path = vault
        .join(project_path)
        .join(format!("{}.md", project_display));

    if !hub_path.exists() {
        return Ok(()); // no hub file to update
    }

    let content = fs::read_to_string(&hub_path)
        .map_err(|e| format!("Failed to read hub: {}", e))?;

    let embed = format!("![[{}]]", date_str);

    // Insert after "## Notes" heading
    if let Some(pos) = content.find("## Notes") {
        let after_heading = pos + "## Notes".len();
        // Find the end of the heading line
        let line_end = content[after_heading..]
            .find('\n')
            .map(|i| after_heading + i)
            .unwrap_or(content.len());

        let mut updated = String::new();
        updated.push_str(&content[..line_end]);
        updated.push_str("\n\n");
        updated.push_str(&embed);
        updated.push_str(&content[line_end..]);

        fs::write(&hub_path, updated)
            .map_err(|e| format!("Failed to update hub: {}", e))?;
    }

    Ok(())
}

fn update_config_timestamp(vault: &Path, timestamp: &str) -> Result<(), String> {
    let config_path = vault.join("claude-config.md");
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    // Replace the timestamp line
    let updated = if content.contains("last_inbox_processing:") {
        let mut result = String::new();
        for line in content.lines() {
            if line.starts_with("last_inbox_processing:") {
                result.push_str(&format!("last_inbox_processing: {}", timestamp));
            } else {
                result.push_str(line);
            }
            result.push('\n');
        }
        result
    } else {
        content
    };

    fs::write(&config_path, updated)
        .map_err(|e| format!("Failed to update config: {}", e))
}

/// Scaffold a new project: create folder, hub file, todos.md, notes/, and
/// register it in claude-config.md. Returns the KnownProject for routing.
fn scaffold_new_project(vault: &Path, tag: &str) -> Result<KnownProject, String> {
    // Default to "01 work" category for new projects
    let rel_path = format!("01 projects/01 work/{}", tag);
    let project_dir = vault.join(&rel_path);

    // Create directory structure
    fs::create_dir_all(project_dir.join("notes"))
        .map_err(|e| format!("Failed to create project dirs: {}", e))?;

    // Create hub file
    let hub_content = format!(
        "## Todos\n\n![[todos]]\n\n## Notes\n"
    );
    let hub_path = project_dir.join(format!("{}.md", tag));
    if !hub_path.exists() {
        fs::write(&hub_path, &hub_content)
            .map_err(|e| format!("Failed to create hub file: {}", e))?;
    }

    // Create empty todos.md
    let todos_path = project_dir.join("todos.md");
    if !todos_path.exists() {
        fs::write(&todos_path, "")
            .map_err(|e| format!("Failed to create todos.md: {}", e))?;
    }

    // Register in claude-config.md
    let config_path = vault.join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let entry = format!("- {}", rel_path);
    if !config.contains(&entry) {
        // Insert after the last "- 01 projects/" line
        let mut lines: Vec<&str> = config.lines().collect();
        let mut insert_idx = lines.len();
        for (i, line) in lines.iter().enumerate().rev() {
            if line.trim().starts_with("- 01 projects/") {
                insert_idx = i + 1;
                break;
            }
        }
        lines.insert(insert_idx, &entry);
        let updated = lines.join("\n");
        // Ensure trailing newline
        let updated = if updated.ends_with('\n') { updated } else { format!("{}\n", updated) };
        fs::write(&config_path, updated)
            .map_err(|e| format!("Failed to update config: {}", e))?;
    }

    Ok(KnownProject {
        name: tag.to_lowercase(),
        display: tag.to_string(),
        rel_path,
    })
}

fn write_inbox_remainder(vault: &Path, untagged_lines: &[String]) -> Result<(), String> {
    let path = vault.join("00 Home").join("inbox.md");
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

// ── Main processor ───────────────────────────────────

pub fn process(vault_override: Option<PathBuf>) -> Result<ProcessResult, String> {
    let vault = vault_override.unwrap_or_else(vault_path);
    let projects = load_known_projects(&vault);
    let today = Local::now().format("%Y-%m-%d").to_string();
    let timestamp = Local::now().format("%Y-%m-%dT%H:%M").to_string();

    // Read inbox
    let inbox_path = vault.join("00 Home").join("inbox.md");
    let inbox_content = fs::read_to_string(&inbox_path)
        .map_err(|e| format!("Failed to read inbox: {}", e))?;

    let sections = parse_inbox(&inbox_content);

    let mut routed: Vec<RoutedProject> = Vec::new();
    let mut all_untagged: Vec<String> = Vec::new();
    let mut unknown_tags: Vec<String> = Vec::new();
    let mut hub_files_updated: Vec<String> = Vec::new();

    for section in sections {
        match section.tag {
            None => {
                // Untagged content — keep in inbox
                let non_empty: Vec<String> = section.lines.clone();
                if non_empty.iter().any(|l| !l.trim().is_empty()) {
                    all_untagged.extend(non_empty);
                }
            }
            Some(tag) => {
                // Try to resolve the tag
                match resolve_project(&tag, &projects) {
                    None => {
                        // Unknown project — scaffold it and route content there
                        let new_project = scaffold_new_project(&vault, &tag)?;
                        unknown_tags.push(tag.clone());

                        // Route content to the new project (same logic as known projects)
                        let section_text = section.lines.join("\n");
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
                        for (i, line) in section.lines.iter().enumerate() {
                            let in_todo = todo_line_ranges.iter().any(|(s, e)| i >= *s && i < *e);
                            if !in_todo {
                                notes.push(line.clone());
                            }
                        }

                        let todo_count = blocks.len();
                        let note_count = notes.iter().filter(|l| !l.trim().is_empty()).count();

                        if !todo_raw_blocks.is_empty() {
                            append_todos(&vault, &new_project.rel_path, &todo_raw_blocks, &today)?;
                        }

                        if notes.iter().any(|l| !l.trim().is_empty()) {
                            let is_new = append_notes(
                                &vault,
                                &new_project.rel_path,
                                &new_project.display,
                                &notes,
                                &today,
                            )?;
                            if is_new {
                                hub_files_updated.push(new_project.display.clone());
                            }
                        }

                        if todo_count > 0 || note_count > 0 {
                            routed.push(RoutedProject {
                                project: new_project.display.clone(),
                                path: new_project.rel_path.clone(),
                                todos_added: todo_count,
                                notes_added: note_count,
                            });
                        }
                    }
                    Some(project) => {
                        // Block-aware split: parse todo blocks (checkbox + continuations),
                        // everything else goes to notes
                        let section_text = section.lines.join("\n");
                        let blocks = todo_parser::parse_todo_blocks(&section_text);

                        // Collect line ranges covered by todo blocks
                        let mut todo_line_ranges: Vec<(usize, usize)> = Vec::new();
                        let mut todo_raw_blocks: Vec<String> = Vec::new();
                        for block in &blocks {
                            let start = block.line_number - 1; // 0-based
                            let end = start + block.line_count;
                            todo_line_ranges.push((start, end));
                            todo_raw_blocks.push(todo_parser::block_to_markdown(block));
                        }

                        // Lines not covered by any todo block are notes
                        let mut notes: Vec<String> = Vec::new();
                        for (i, line) in section.lines.iter().enumerate() {
                            let in_todo = todo_line_ranges.iter().any(|(s, e)| i >= *s && i < *e);
                            if !in_todo {
                                notes.push(line.clone());
                            }
                        }

                        let todo_count = blocks.len();
                        let note_count = notes.iter().filter(|l| !l.trim().is_empty()).count();

                        if !todo_raw_blocks.is_empty() {
                            append_todos(&vault, &project.rel_path, &todo_raw_blocks, &today)?;
                        }

                        if notes.iter().any(|l| !l.trim().is_empty()) {
                            let is_new = append_notes(
                                &vault,
                                &project.rel_path,
                                &project.display,
                                &notes,
                                &today,
                            )?;
                            if is_new {
                                hub_files_updated.push(project.display.clone());
                            }
                        }

                        if todo_count > 0 || note_count > 0 {
                            routed.push(RoutedProject {
                                project: project.display.clone(),
                                path: project.rel_path.clone(),
                                todos_added: todo_count,
                                notes_added: note_count,
                            });
                        }
                    }
                }
            }
        }
    }

    // Write back untagged content (or clear inbox if nothing left)
    write_inbox_remainder(&vault, &all_untagged)?;

    // Update config timestamp
    update_config_timestamp(&vault, &timestamp)?;

    // Rebuild todo index after routing
    if let Err(e) = todo_index::rebuild_and_persist(&vault) {
        eprintln!("Warning: todo index rebuild failed: {}", e);
    }

    Ok(ProcessResult {
        routed,
        untagged_remaining: all_untagged.iter()
            .filter(|l| !l.trim().is_empty())
            .cloned()
            .collect(),
        unknown_tags,
        hub_files_updated,
        timestamp,
    })
}
