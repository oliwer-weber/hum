// Todo index — single source of truth for todo state.
// Built from scanning todos.md files, persisted as .todo-index.json in the vault.
// The markdown files remain authoritative; the index is a cache that enables
// fast lookups without re-parsing every file.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};

use crate::todo_parser;

const INDEX_FILENAME: &str = ".todo-index.json";

/// A single entry in the todo index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoEntry {
    /// UUID (short hex, e.g. "a1b2c3d4")
    pub id: String,
    /// Source file relative to vault root (forward slashes)
    pub source: String,
    /// 1-based line number of the checkbox line
    pub line: usize,
    /// Headline text (clean, no HTML comments or completion stamps)
    pub text: String,
    /// Continuation body (empty string if none)
    pub body: String,
    /// "open" or "completed"
    pub status: String,
    /// Creation date (YYYY-MM-DD) or null
    pub created: Option<String>,
    /// Completion date (YYYY-MM-DD) or null
    pub completed: Option<String>,
    /// Status tags (#blocked, #waiting, #on-hold)
    pub tags: Vec<String>,
    /// Project display name (last path segment)
    pub project_name: String,
    /// Relative project path from vault root
    pub project_path: String,
    /// Whether this todo is in an archived project
    pub archived: bool,
}

/// The full index structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoIndex {
    /// Map from UUID to entry
    pub entries: HashMap<String, TodoEntry>,
    /// When the index was last rebuilt (ISO timestamp)
    pub rebuilt_at: String,
}

impl TodoIndex {
    pub fn new() -> Self {
        TodoIndex {
            entries: HashMap::new(),
            rebuilt_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
        }
    }
}

/// Generate a short UUID (8 hex chars from uuid v4).
pub fn generate_id() -> String {
    let full = uuid::Uuid::new_v4();
    // Take first 8 hex chars (32 bits of entropy — sufficient for personal vault)
    full.simple().to_string()[..8].to_string()
}

/// Build the full index by scanning all project todos.md files.
/// Active projects come from claude-config.md; archived projects are scanned
/// from the archive directory but marked as archived.
pub fn build_index(vault: &Path) -> Result<TodoIndex, String> {
    let config_path = vault.join(".app").join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let mut index = TodoIndex::new();

    // Active projects from config
    for line in config.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- projects/") {
            continue;
        }
        let rel_path = trimmed.trim_start_matches("- ").to_string();
        let project_name = rel_path
            .rsplit('/')
            .next()
            .unwrap_or(&rel_path)
            .to_string();

        scan_project_todos(vault, &rel_path, &project_name, false, &mut index)?;
    }

    // Archived projects
    let archive_dir = vault.join("projects").join("archive");
    if archive_dir.exists() {
        scan_archived_projects(&archive_dir, vault, &mut index)?;
    }

    Ok(index)
}

/// Scan a single project's todos.md and add entries to the index.
fn scan_project_todos(
    vault: &Path,
    rel_path: &str,
    project_name: &str,
    archived: bool,
    index: &mut TodoIndex,
) -> Result<(), String> {
    let todos_path = vault.join(rel_path).join("todos.md");
    let content = match fs::read_to_string(&todos_path) {
        Ok(c) => c,
        Err(_) => return Ok(()), // no todos.md, that's fine
    };

    let blocks = todo_parser::parse_todo_blocks(&content);
    let source = format!("{}/todos.md", rel_path).replace('\\', "/");

    for block in &blocks {
        let id = block.id.clone().unwrap_or_else(generate_id);

        index.entries.insert(id.clone(), TodoEntry {
            id: id.clone(),
            source: source.clone(),
            line: block.line_number,
            text: block.text.clone(),
            body: block.body.clone(),
            status: if block.checked { "completed".to_string() } else { "open".to_string() },
            created: block.created.clone(),
            completed: block.completed.clone(),
            tags: block.tags.clone(),
            project_name: project_name.to_string(),
            project_path: rel_path.to_string(),
            archived,
        });
    }

    Ok(())
}

/// Recursively scan archived project directories.
fn scan_archived_projects(dir: &Path, vault: &Path, index: &mut TodoIndex) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read archive: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let rel_path = path.strip_prefix(vault)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let project_name = path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            if path.join("todos.md").exists() {
                scan_project_todos(vault, &rel_path, &project_name, true, index)?;
            }

            // Recurse into subdirectories (archive may have nested structure)
            if let Ok(sub_entries) = fs::read_dir(&path) {
                for sub in sub_entries.flatten() {
                    if sub.path().is_dir() {
                        scan_archived_projects(&sub.path(), vault, index)?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Stamp UUIDs on all todos that don't have one yet in a project's todos.md.
/// Returns the number of todos stamped.
pub fn stamp_uuids(vault: &Path, rel_path: &str) -> Result<usize, String> {
    let todos_path = vault.join(rel_path).join("todos.md");
    let content = match fs::read_to_string(&todos_path) {
        Ok(c) => c,
        Err(_) => return Ok(0),
    };

    let blocks = todo_parser::parse_todo_blocks(&content);
    let lines: Vec<&str> = content.lines().collect();
    let mut updated_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let mut stamped = 0usize;

    for block in &blocks {
        if block.id.is_some() {
            continue; // already has a UUID
        }

        let new_id = generate_id();
        let line_idx = block.line_number - 1; // 0-based

        if line_idx < updated_lines.len() {
            let line = &updated_lines[line_idx];
            // Insert <!-- id:xxx --> before the <!-- created: --> comment if present,
            // otherwise at the end of the checkbox line
            let id_comment = format!("<!-- id:{} -->", new_id);

            let new_line = if let Some(pos) = line.find("<!-- created:") {
                format!("{}{} {}", &line[..pos], id_comment, &line[pos..])
            } else {
                format!("{} {}", line.trim_end(), id_comment)
            };

            updated_lines[line_idx] = new_line;
            stamped += 1;
        }
    }

    if stamped > 0 {
        let mut result = updated_lines.join("\n");
        if content.ends_with('\n') && !result.ends_with('\n') {
            result.push('\n');
        }
        fs::write(&todos_path, result)
            .map_err(|e| format!("Failed to write todos.md: {}", e))?;
    }

    Ok(stamped)
}

/// Stamp UUIDs across all active projects. Returns total count stamped.
pub fn stamp_all_active(vault: &Path) -> Result<usize, String> {
    let config_path = vault.join(".app").join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let mut total = 0usize;

    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("- projects/") {
            let rel_path = trimmed.trim_start_matches("- ").to_string();
            total += stamp_uuids(vault, &rel_path)?;
        }
    }

    Ok(total)
}

/// Read the index from disk.
pub fn read_index(vault: &Path) -> Result<TodoIndex, String> {
    let path = vault.join(INDEX_FILENAME);
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read todo index: {}", e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse todo index: {}", e))
}

/// Write the index to disk.
pub fn write_index(vault: &Path, index: &TodoIndex) -> Result<(), String> {
    let path = vault.join(INDEX_FILENAME);
    let json = serde_json::to_string_pretty(index)
        .map_err(|e| format!("Failed to serialize todo index: {}", e))?;
    fs::write(&path, json)
        .map_err(|e| format!("Failed to write todo index: {}", e))
}

/// Full rebuild: stamp UUIDs on active projects, then build and persist the index.
/// This is the "safe" entry point — call on app launch or after detecting drift.
pub fn rebuild_and_persist(vault: &Path) -> Result<TodoIndex, String> {
    // Step 1: stamp UUIDs on any active project todos that lack them
    let stamped = stamp_all_active(vault)?;
    if stamped > 0 {
        eprintln!("Stamped {} todo(s) with UUIDs", stamped);
    }

    // Step 2: build the index from all files
    let index = build_index(vault)?;

    // Step 3: persist
    write_index(vault, &index)?;

    Ok(index)
}

