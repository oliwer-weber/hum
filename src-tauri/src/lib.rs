// Project Assistant — Tauri backend
use std::fs;
use std::path::PathBuf;
use std::process::Command;

mod hum;
mod inbox;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[derive(serde::Serialize)]
struct ProjectGravity {
    name: String,
    path: String,
    open_todos: usize,
    completed_todos: usize,
    gravity: f64,
    color_index: usize,
}

fn vault_path() -> PathBuf {
    if cfg!(target_os = "windows") {
        PathBuf::from(r"C:\Users\oliwer.weber\Documents\Oliwers Remote Vault")
    } else {
        dirs::home_dir()
            .unwrap_or_default()
            .join("Documents")
            .join("Oliwers Remote Vault")
    }
}

#[tauri::command]
fn read_dashboard() -> Result<String, String> {
    let path = vault_path().join("00 Home").join("dashboard.md");
    fs::read_to_string(&path).map_err(|e| format!("Failed to read dashboard: {}", e))
}

#[tauri::command]
fn read_inbox() -> Result<String, String> {
    let path = vault_path().join("00 Home").join("inbox.md");
    fs::read_to_string(&path).map_err(|e| format!("Failed to read inbox: {}", e))
}

#[tauri::command]
fn write_inbox(content: String) -> Result<(), String> {
    let path = vault_path().join("00 Home").join("inbox.md");
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let new_content = if existing.trim().is_empty() || existing.trim() == "---\ncssclasses:\n  - home-title\n---" {
        format!("{}\n{}\n", existing.trim(), content)
    } else {
        format!("{}\n{}\n", existing.trim_end(), content)
    };

    fs::write(&path, new_content).map_err(|e| format!("Failed to write inbox: {}", e))
}

#[tauri::command]
fn write_inbox_raw(content: String) -> Result<(), String> {
    let path = vault_path().join("00 Home").join("inbox.md");
    fs::write(&path, content).map_err(|e| format!("Failed to write inbox: {}", e))
}

#[tauri::command]
fn get_vault_path() -> String {
    vault_path().to_string_lossy().to_string()
}

#[tauri::command]
fn toggle_dashboard_todo(project: String, todo_text: String, checked: bool) -> Result<(), String> {
    let path = vault_path().join("00 Home").join("dashboard.md");
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read dashboard: {}", e))?;

    let from = if checked {
        format!("- [ ] {}", todo_text)
    } else {
        format!("- [x] {}", todo_text)
    };
    let to = if checked {
        format!("- [x] {}", todo_text)
    } else {
        format!("- [ ] {}", todo_text)
    };

    let updated = content.replacen(&from, &to, 1);
    fs::write(&path, updated).map_err(|e| format!("Failed to write dashboard: {}", e))
}

/// File info returned by vault_all_files — used for wikilink suggestions and existence checks.
#[derive(serde::Serialize)]
struct VaultFileInfo {
    stem: String,   // lowercase, no extension — for filtering/matching
    name: String,   // original-case filename without extension — for display
    path: String,   // relative path from vault root (forward slashes) — stored in wikiLink target
}

/// Recursively collect all files in the vault.
#[tauri::command]
fn vault_all_files() -> Result<Vec<VaultFileInfo>, String> {
    use std::path::Path;

    fn collect(dir: &Path, base: &Path, files: &mut Vec<VaultFileInfo>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                collect(&path, base, files);
            } else {
                let stem_os = path.file_stem().map(|s| s.to_string_lossy().to_string());
                let relative = path.strip_prefix(base)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if let Some(name) = stem_os {
                    files.push(VaultFileInfo {
                        stem: name.to_lowercase(),
                        name,
                        path: relative,
                    });
                }
            }
        }
    }

    let base = vault_path();
    let mut files = Vec::new();
    collect(&base, &base, &mut files);
    files.sort_by(|a, b| a.stem.cmp(&b.stem));
    Ok(files)
}

/// Resolve a wikilink target to a relative vault path.
/// Searches recursively by filename (Obsidian-style shortest-match).
#[tauri::command]
fn vault_resolve_link(target: String) -> Result<String, String> {
    use std::path::Path;

    let base = vault_path();
    let search_name = if target.contains('.') {
        target.clone()
    } else {
        format!("{}.md", target)
    };

    // Try exact relative path first
    if base.join(&search_name).exists() {
        return Ok(search_name.replace('\\', "/"));
    }

    // Extract just the filename for recursive search
    let file_name = Path::new(&search_name)
        .file_name()
        .map(|f| f.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
        let Ok(entries) = fs::read_dir(dir) else { return None };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                if let Some(found) = find_file(&path, name) {
                    return Some(found);
                }
            } else if path.file_name()
                .map(|f| f.to_string_lossy().to_lowercase()) == Some(name.to_string())
            {
                return Some(path);
            }
        }
        None
    }

    match find_file(&base, &file_name) {
        Some(path) => {
            let relative = path.strip_prefix(&base).unwrap_or(&path);
            Ok(relative.to_string_lossy().replace('\\', "/"))
        }
        None => Err(format!("Not found: {}", target))
    }
}

/* ── Vault browser commands ────────────────────────── */

#[derive(serde::Serialize)]
struct VaultEntry {
    name: String,
    is_dir: bool,
    extension: Option<String>,
}

#[tauri::command]
fn vault_list(relative_path: String) -> Result<Vec<VaultEntry>, String> {
    let base = vault_path();
    let dir = if relative_path.is_empty() || relative_path == "." {
        base.clone()
    } else {
        let resolved = base.join(&relative_path);
        // Safety: ensure we stay within the vault
        let canon = resolved.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
        let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
        if !canon.starts_with(&base_canon) {
            return Err("Path outside vault".to_string());
        }
        resolved
    };

    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut items: Vec<VaultEntry> = entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.path().is_dir();
            let extension = if is_dir {
                None
            } else {
                e.path().extension().map(|ext| ext.to_string_lossy().to_string())
            };
            VaultEntry { name, is_dir, extension }
        })
        .collect();

    // Sort: directories first, then alphabetical
    items.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(items)
}

#[tauri::command]
fn vault_read_file(relative_path: String) -> Result<String, String> {
    let base = vault_path();
    let resolved = base.join(&relative_path);
    let canon = resolved.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
    if !canon.starts_with(&base_canon) {
        return Err("Path outside vault".to_string());
    }
    fs::read_to_string(&resolved).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn vault_write_file(relative_path: String, content: String) -> Result<(), String> {
    let base = vault_path();
    let resolved = base.join(&relative_path);
    // For new files, canonicalize the parent
    if let Some(parent) = resolved.parent() {
        if parent.exists() {
            let parent_canon = parent.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
            let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
            if !parent_canon.starts_with(&base_canon) {
                return Err("Path outside vault".to_string());
            }
        }
    }
    fs::write(&resolved, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn fetch_calendar() -> Result<String, String> {
    let skill_dir = vault_path().join(".claude").join("skills").join("check-calendar");
    let script = skill_dir.join("fetch_calendar.py");

    let py_win = skill_dir.join(".venv").join("Scripts").join("python.exe");
    let py_unix = skill_dir.join(".venv").join("bin").join("python");

    let python = if py_win.exists() {
        py_win
    } else if py_unix.exists() {
        py_unix
    } else {
        return Err("Calendar venv not found. Run the check-calendar skill once to bootstrap it.".to_string());
    };

    #[cfg(target_os = "windows")]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        Command::new(&python)
            .arg(&script)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run calendar script: {}", e))?
    };

    #[cfg(not(target_os = "windows"))]
    let output = Command::new(&python)
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to run calendar script: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Calendar script failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn process_inbox() -> Result<inbox::ProcessResult, String> {
    inbox::process(None)
}

#[tauri::command]
fn get_project_gravity() -> Result<Vec<ProjectGravity>, String> {
    let vault = vault_path();
    let config_path = vault.join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read claude-config.md: {}", e))?;

    let mut results = Vec::new();

    for line in config.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- 01 projects/") {
            continue;
        }
        let rel = trimmed.trim_start_matches("- ").to_string();
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();

        let todos_path = vault.join(&rel).join("todos.md");
        let (open, completed) = if let Ok(content) = fs::read_to_string(&todos_path) {
            let mut o = 0usize;
            let mut c = 0usize;
            for l in content.lines() {
                let t = l.trim();
                if t.starts_with("- [ ]") {
                    o += 1;
                } else if t.starts_with("- [x]") {
                    c += 1;
                }
            }
            (o, c)
        } else {
            (0, 0)
        };

        let gravity = (open as f64) * 10.0 + if open > 5 { 20.0 } else { 0.0 };

        // Simple hash for color_index
        let hash: usize = name.bytes().map(|b| b as usize).sum();
        let color_index = hash % 7;

        results.push(ProjectGravity {
            name,
            path: rel,
            open_todos: open,
            completed_todos: completed,
            gravity,
            color_index,
        });
    }

    Ok(results)
}

/* ── Plan (Time Canvas) commands ──────────────────── */

#[derive(serde::Serialize, Clone)]
struct TodoItem {
    id: String,
    text: String,
    project_name: String,
    project_path: String,
    color_index: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct FocusBlock {
    title: String,
    date: String,
    start_time: String,
    end_time: String,
    project_name: String,
    color_index: usize,
}

fn hash_string(s: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

#[tauri::command]
fn get_all_open_todos() -> Result<Vec<TodoItem>, String> {
    let vault = vault_path();
    let config_path = vault.join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read claude-config.md: {}", e))?;

    let mut todos = Vec::new();

    for line in config.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- 01 projects/") {
            continue;
        }
        let rel_path = trimmed.trim_start_matches("- ").to_string();
        let project_name = rel_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&rel_path)
            .to_string();
        let color_index = (hash_string(&project_name) % 7) as usize;

        let todos_path = vault.join(&rel_path).join("todos.md");
        let content = match fs::read_to_string(&todos_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for todo_line in content.lines() {
            let t = todo_line.trim();
            if t.starts_with("- [ ] ") {
                let text = t.trim_start_matches("- [ ] ").to_string();
                let id_source = format!("{}:{}", rel_path, text);
                let id = format!("{:x}", hash_string(&id_source));
                todos.push(TodoItem {
                    id,
                    text,
                    project_name: project_name.clone(),
                    project_path: rel_path.clone(),
                    color_index,
                });
            }
        }
    }

    Ok(todos)
}

#[tauri::command]
fn get_focus_blocks() -> Result<Vec<FocusBlock>, String> {
    let path = vault_path().join("00 Home").join("focus-blocks.md");
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut blocks = Vec::new();
    let lines: Vec<&str> = content.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        // Match: ## YYYY-MM-DD HH:MM-HH:MM
        if line.starts_with("## ") {
            let header = line.trim_start_matches("## ");
            // Parse "YYYY-MM-DD HH:MM-HH:MM"
            let parts: Vec<&str> = header.splitn(2, ' ').collect();
            if parts.len() == 2 {
                let date = parts[0].to_string();
                let time_parts: Vec<&str> = parts[1].splitn(2, '-').collect();
                if time_parts.len() == 2 {
                    let start_time = time_parts[0].to_string();
                    let end_time = time_parts[1].to_string();

                    // Next line: **ProjectName** — Todo text
                    if i + 1 < lines.len() {
                        let body = lines[i + 1].trim();
                        // Parse **ProjectName** — text
                        if body.starts_with("**") {
                            if let Some(end_bold) = body[2..].find("**") {
                                let project_name = body[2..2 + end_bold].to_string();
                                let rest = &body[2 + end_bold + 2..];
                                let title = rest
                                    .trim_start_matches(" — ")
                                    .trim_start_matches(" - ")
                                    .trim()
                                    .to_string();
                                let color_index =
                                    (hash_string(&project_name) % 7) as usize;
                                blocks.push(FocusBlock {
                                    title,
                                    date,
                                    start_time,
                                    end_time,
                                    project_name,
                                    color_index,
                                });
                            }
                        }
                        i += 2;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }

    Ok(blocks)
}

#[tauri::command]
fn create_focus_block(
    title: String,
    date: String,
    start_time: String,
    end_time: String,
    project_name: String,
    color_index: usize,
) -> Result<(), String> {
    let _ = color_index; // stored in format implicitly via project_name
    let path = vault_path().join("00 Home").join("focus-blocks.md");
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let entry = format!(
        "\n## {} {}-{}\n**{}** — {}\n",
        date, start_time, end_time, project_name, title
    );

    let new_content = if existing.is_empty() {
        entry.trim_start().to_string() + "\n"
    } else {
        format!("{}{}", existing.trim_end(), entry)
    };

    fs::write(&path, new_content).map_err(|e| format!("Failed to write focus-blocks.md: {}", e))
}

#[tauri::command]
fn delete_focus_block(
    title: String,
    date: String,
    start_time: String,
    end_time: String,
) -> Result<(), String> {
    let path = vault_path().join("00 Home").join("focus-blocks.md");
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read focus-blocks.md: {}", e))?;

    let header_match = format!("## {} {}-{}", date, start_time, end_time);
    let lines: Vec<&str> = content.lines().collect();
    let mut result_lines: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim() == header_match {
            // Check next line contains the title
            if i + 1 < lines.len() && lines[i + 1].contains(&title) {
                // Skip both lines
                i += 2;
                // Also skip any trailing blank line
                if i < lines.len() && lines[i].trim().is_empty() {
                    i += 1;
                }
                continue;
            }
        }
        result_lines.push(lines[i]);
        i += 1;
    }

    let new_content = result_lines.join("\n");
    fs::write(&path, new_content.trim_end().to_string() + "\n")
        .map_err(|e| format!("Failed to write focus-blocks.md: {}", e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env from the project root (one level up from src-tauri)
    let _ = dotenvy::from_filename(
        std::env::current_dir()
            .unwrap_or_default()
            .join(".env"),
    );
    // Also try parent directory (when running from src-tauri/)
    let _ = dotenvy::from_filename(
        std::env::current_dir()
            .unwrap_or_default()
            .parent()
            .map(|p| p.join(".env"))
            .unwrap_or_default(),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_dashboard,
            read_inbox,
            write_inbox,
            write_inbox_raw,
            get_vault_path,
            toggle_dashboard_todo,
            fetch_calendar,
            vault_all_files,
            vault_resolve_link,
            vault_list,
            vault_read_file,
            vault_write_file,
            hum::hum_send,
            process_inbox,
            get_project_gravity,
            get_all_open_todos,
            get_focus_blocks,
            create_focus_block,
            delete_focus_block,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
