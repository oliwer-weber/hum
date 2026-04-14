// Project Assistant — Tauri backend
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;
use once_cell::sync::Lazy;

// ── Cached vault file index (5s TTL) ──
struct VaultFileCache {
    files: Vec<VaultFileInfo>,
    updated_at: Instant,
}
static VAULT_FILE_CACHE: Lazy<Mutex<Option<VaultFileCache>>> = Lazy::new(|| Mutex::new(None));

fn invalidate_vault_cache() {
    if let Ok(mut cache) = VAULT_FILE_CACHE.lock() {
        *cache = None;
    }
}

static SKIP_DIRS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [".git", ".obsidian", ".trash", ".claude", "node_modules"].iter().copied().collect()
});
static BINARY_EXTS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "pdf", "mp3", "mp4",
     "zip", "tar", "gz", "exe", "dll", "woff", "woff2", "ttf", "otf"].iter().copied().collect()
});

mod hum;
mod inbox;
mod todo_index;
mod todo_parser;

use chrono::{Datelike, Local};
use std::collections::HashMap;

/// Number of project pip colors (excludes red which signals errors).
const NUM_PROJECT_COLORS: usize = 6;

/// Build a deterministic project-name → color_index map from claude-config.md.
/// Colors are assigned in config order, cycling after all 6 are used.
/// The palette order (matching the frontend): aqua=0, green=1, yellow=2, blue=3, purple=4, orange=5.
/// Red (index 6) is intentionally excluded.
fn build_project_color_map(config: &str) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    let mut idx = 0usize;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("- 01 projects/") {
            let rel = trimmed.trim_start_matches("- ");
            let name = rel.rsplit('/').next().unwrap_or(rel).to_string();
            if !map.contains_key(&name) {
                map.insert(name, idx % NUM_PROJECT_COLORS);
                idx += 1;
            }
        }
    }
    map
}

#[derive(serde::Serialize)]
struct ProjectGravity {
    name: String,
    path: String,
    open_todos: usize,
    completed_todos: usize,
    gravity: f64,
    color_index: usize,
    // Gravity breakdown (for potential UI use)
    todo_pressure: f64,
    neglect_signal: f64,
    silence_penalty: f64,
    blocked_weight: f64,
    blocked_count: usize,
    waiting_count: usize,
    days_silent: u32,
    // Top todos ranked by individual weight (age)
    top_todos: Vec<GravityTodo>,
}

#[derive(serde::Serialize, Clone)]
struct GravityTodo {
    text: String,
    project_name: String,
    project_path: String,
    color_index: usize,
    age_days: u32,
    is_blocked: bool,
    is_waiting: bool,
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
    let vault = vault_path();

    // Find the project's todos.md by scanning config for matching project name
    let config_path = vault.join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let mut project_rel: Option<String> = None;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("- 01 projects/") {
            let rel = trimmed.trim_start_matches("- ").to_string();
            let name = rel.rsplit('/').next().unwrap_or(&rel);
            if name.eq_ignore_ascii_case(&project) {
                project_rel = Some(rel);
                break;
            }
        }
    }

    let rel = project_rel.ok_or_else(|| format!("Project not found: {}", project))?;
    let todos_path = vault.join(&rel).join("todos.md");
    let content = fs::read_to_string(&todos_path)
        .map_err(|e| format!("Failed to read todos.md: {}", e))?;

    let blocks = todo_parser::parse_todo_blocks(&content);
    let today_str = chrono::Local::now().format("%Y-%m-%d").to_string();

    // Find the target block — try UUID match first (if todo_text looks like a UUID),
    // then fall back to text match
    let target_line = blocks.iter().find(|b| {
        // UUID match: todo_text matches the block's id
        if let Some(ref id) = b.id {
            if id == &todo_text {
                return true;
            }
        }
        // Text match (backwards compat): clean text matches todo_text
        b.text == todo_text
    });

    let target = target_line
        .ok_or_else(|| format!("Todo not found: {}", todo_text))?;

    // Replace the checkbox line in the raw content
    let lines: Vec<&str> = content.lines().collect();
    let mut updated_lines: Vec<String> = Vec::new();

    for (i, line) in lines.iter().enumerate() {
        let line_num = i + 1; // 1-based
        if line_num == target.line_number {
            let trimmed = line.trim();
            if checked && trimmed.starts_with("- [ ]") {
                // Check it off: rebuild as - [x] text ✅ date <!-- id:xxx --> <!-- created:xxx -->
                let mut new_line = format!("- [x] {}", target.text);
                // Add status tags back
                for tag in &target.tags {
                    new_line.push(' ');
                    new_line.push_str(tag);
                }
                new_line.push_str(&format!(" ✅ {}", today_str));
                // Preserve id and created comments
                if let Some(ref id) = target.id {
                    new_line.push_str(&format!(" <!-- id:{} -->", id));
                }
                if let Some(ref created) = target.created {
                    new_line.push_str(&format!(" <!-- created:{} -->", created));
                }
                updated_lines.push(new_line);
            } else if !checked && trimmed.starts_with("- [x]") {
                // Uncheck it
                let mut new_line = format!("- [ ] {}", target.text);
                for tag in &target.tags {
                    new_line.push(' ');
                    new_line.push_str(tag);
                }
                if let Some(ref id) = target.id {
                    new_line.push_str(&format!(" <!-- id:{} -->", id));
                }
                if let Some(ref created) = target.created {
                    new_line.push_str(&format!(" <!-- created:{} -->", created));
                }
                updated_lines.push(new_line);
            } else {
                updated_lines.push(line.to_string());
            }
        } else {
            updated_lines.push(line.to_string());
        }
    }

    let result = updated_lines.join("\n");
    let result = if content.ends_with('\n') && !result.ends_with('\n') {
        result + "\n"
    } else {
        result
    };

    fs::write(&todos_path, result).map_err(|e| format!("Failed to write todos.md: {}", e))?;

    // Update the todo index after toggling
    if let Err(e) = todo_index::rebuild_and_persist(&vault) {
        eprintln!("Warning: todo index rebuild failed: {}", e);
    }

    Ok(())
}

/// File info returned by vault_all_files — used for wikilink suggestions and existence checks.
#[derive(serde::Serialize, Clone)]
struct VaultFileInfo {
    stem: String,   // lowercase, no extension — for filtering/matching
    name: String,   // original-case filename without extension — for display
    path: String,   // relative path from vault root (forward slashes) — stored in wikiLink target
}

/// Recursively collect all files in the vault (uncached).
fn vault_all_files_uncached() -> Result<Vec<VaultFileInfo>, String> {
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

/// Cached wrapper — returns cached results if <5s old.
#[tauri::command]
fn vault_all_files() -> Result<Vec<VaultFileInfo>, String> {
    let mut cache = VAULT_FILE_CACHE.lock().map_err(|e| format!("Cache lock error: {}", e))?;
    if let Some(ref cached) = *cache {
        if cached.updated_at.elapsed().as_secs() < 5 {
            return Ok(cached.files.clone());
        }
    }
    let files = vault_all_files_uncached()?;
    *cache = Some(VaultFileCache { files: files.clone(), updated_at: Instant::now() });
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

    fn find_all(dir: &Path, name: &str, results: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                find_all(&path, name, results);
            } else if path.file_name()
                .map(|f| f.to_string_lossy().to_lowercase()) == Some(name.to_string())
            {
                results.push(path);
            }
        }
    }

    let mut matches = Vec::new();
    find_all(&base, &file_name, &mut matches);

    if matches.is_empty() {
        return Err(format!("Not found: {}", target));
    }

    // Prefer hub file: parent directory name matches the file stem (e.g. Project/Project.md)
    let stem = file_name.trim_end_matches(".md");
    let best = matches.iter()
        .find(|p| {
            p.parent()
                .and_then(|d| d.file_name())
                .map(|d| d.to_string_lossy().to_lowercase() == stem)
                .unwrap_or(false)
        })
        .unwrap_or(&matches[0]);

    let relative = best.strip_prefix(&base).unwrap_or(best);
    Ok(relative.to_string_lossy().replace('\\', "/"))
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
fn vault_create_file(relative_path: String, content: String) -> Result<(), String> {
    let base = vault_path();
    let resolved = base.join(&relative_path);
    if let Some(parent) = resolved.parent() {
        if parent.exists() {
            let parent_canon = parent.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
            let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
            if !parent_canon.starts_with(&base_canon) {
                return Err("Path outside vault".to_string());
            }
        }
    }
    if resolved.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }
    fs::write(&resolved, content).map_err(|e| format!("Failed to create file: {}", e))?;
    invalidate_vault_cache();
    Ok(())
}

#[tauri::command]
fn vault_create_dir(relative_path: String) -> Result<(), String> {
    let base = vault_path();
    let resolved = base.join(&relative_path);
    if let Some(parent) = resolved.parent() {
        if parent.exists() {
            let parent_canon = parent.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
            let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
            if !parent_canon.starts_with(&base_canon) {
                return Err("Path outside vault".to_string());
            }
        }
    }
    if resolved.exists() {
        return Err("Directory already exists".to_string());
    }
    fs::create_dir_all(&resolved).map_err(|e| format!("Failed to create directory: {}", e))?;
    invalidate_vault_cache();
    Ok(())
}

#[tauri::command]
fn vault_rename(relative_path: String, new_name: String) -> Result<String, String> {
    let base = vault_path();
    let resolved = base.join(&relative_path);
    let canon = resolved.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
    if !canon.starts_with(&base_canon) {
        return Err("Path outside vault".to_string());
    }
    let new_path = resolved.parent()
        .ok_or("Cannot determine parent directory")?
        .join(&new_name);
    let new_canon_parent = new_path.parent()
        .ok_or("Cannot determine parent directory")?
        .canonicalize()
        .map_err(|e| format!("Invalid path: {}", e))?;
    if !new_canon_parent.starts_with(&base_canon) {
        return Err("Path outside vault".to_string());
    }
    if new_path.exists() {
        return Err(format!("'{}' already exists", new_name));
    }
    fs::rename(&resolved, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;
    // Return new relative path
    let new_relative = new_path.strip_prefix(&base)
        .map_err(|_| "Failed to compute relative path".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    invalidate_vault_cache();
    Ok(new_relative)
}

#[tauri::command]
fn vault_delete(relative_path: String) -> Result<(), String> {
    let base = vault_path();
    let resolved = base.join(&relative_path);
    let canon = resolved.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
    if !canon.starts_with(&base_canon) {
        return Err("Path outside vault".to_string());
    }
    // Don't allow deleting the vault root
    if canon == base_canon {
        return Err("Cannot delete vault root".to_string());
    }
    if resolved.is_dir() {
        fs::remove_dir_all(&resolved).map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        fs::remove_file(&resolved).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    invalidate_vault_cache();
    Ok(())
}

#[tauri::command]
fn vault_move(source: String, dest_dir: String) -> Result<String, String> {
    let base = vault_path();
    let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;

    let src_resolved = base.join(&source);
    let src_canon = src_resolved.canonicalize().map_err(|e| format!("Invalid source: {}", e))?;
    if !src_canon.starts_with(&base_canon) {
        return Err("Source outside vault".to_string());
    }

    let dest_resolved = base.join(&dest_dir);
    let dest_canon = dest_resolved.canonicalize().map_err(|e| format!("Invalid destination: {}", e))?;
    if !dest_canon.starts_with(&base_canon) {
        return Err("Destination outside vault".to_string());
    }
    if !dest_resolved.is_dir() {
        return Err("Destination is not a directory".to_string());
    }

    let file_name = src_resolved.file_name()
        .ok_or("Cannot determine file name")?;
    let new_path = dest_resolved.join(file_name);
    if new_path.exists() {
        return Err(format!("'{}' already exists in destination", file_name.to_string_lossy()));
    }

    fs::rename(&src_resolved, &new_path).map_err(|e| format!("Failed to move: {}", e))?;

    let new_relative = new_path.strip_prefix(&base)
        .map_err(|_| "Failed to compute relative path".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    invalidate_vault_cache();
    Ok(new_relative)
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create directory: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn vault_copy(source: String, dest_dir: String) -> Result<String, String> {
    let base = vault_path();
    let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;

    let src_resolved = base.join(&source);
    let src_canon = src_resolved.canonicalize().map_err(|e| format!("Invalid source: {}", e))?;
    if !src_canon.starts_with(&base_canon) {
        return Err("Source outside vault".to_string());
    }

    let dest_resolved = base.join(&dest_dir);
    let dest_canon = dest_resolved.canonicalize().map_err(|e| format!("Invalid destination: {}", e))?;
    if !dest_canon.starts_with(&base_canon) {
        return Err("Destination outside vault".to_string());
    }
    if !dest_resolved.is_dir() {
        return Err("Destination is not a directory".to_string());
    }

    let stem = src_resolved.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = src_resolved.extension()
        .map(|e| format!(".{}", e.to_string_lossy()));

    // Find a non-conflicting name
    let mut copy_name = if let Some(ref ext) = ext {
        format!("{} (copy){}", stem, ext)
    } else {
        format!("{} (copy)", stem)
    };
    let mut new_path = dest_resolved.join(&copy_name);
    let mut counter = 2;
    while new_path.exists() {
        copy_name = if let Some(ref ext) = ext {
            format!("{} (copy {}){}", stem, counter, ext)
        } else {
            format!("{} (copy {})", stem, counter)
        };
        new_path = dest_resolved.join(&copy_name);
        counter += 1;
    }

    if src_resolved.is_dir() {
        copy_dir_all(&src_resolved, &new_path)?;
    } else {
        fs::copy(&src_resolved, &new_path).map_err(|e| format!("Failed to copy: {}", e))?;
    }

    let new_relative = new_path.strip_prefix(&base)
        .map_err(|_| "Failed to compute relative path".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    invalidate_vault_cache();
    Ok(new_relative)
}

#[tauri::command]
fn vault_search_files(query: String) -> Result<Vec<VaultFileInfo>, String> {
    let all_files = vault_all_files()?;
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut results: Vec<(usize, VaultFileInfo)> = all_files
        .into_iter()
        .filter_map(|f| {
            let stem_lower = f.stem.to_lowercase();
            let name_lower = f.name.to_lowercase();
            if stem_lower.starts_with(&q) {
                Some((0, f)) // prefix match = highest priority
            } else if name_lower.contains(&q) {
                Some((1, f)) // contains match
            } else if f.path.to_lowercase().contains(&q) {
                Some((2, f)) // path match
            } else {
                None
            }
        })
        .collect();

    results.sort_by_key(|(priority, _)| *priority);
    let files: Vec<VaultFileInfo> = results.into_iter().take(50).map(|(_, f)| f).collect();
    Ok(files)
}

#[derive(serde::Serialize)]
struct ContentSearchResult {
    path: String,
    name: String,
    line_number: u32,
    line_content: String,
    context_before: String,
    context_after: String,
}

fn walk_text_files(dir: &Path, base: &Path, results: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !SKIP_DIRS.contains(name.as_str()) {
                    walk_text_files(&path, base, results);
                }
            } else {
                let ext = path.extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if !BINARY_EXTS.contains(ext.as_str()) {
                    results.push(path);
                }
            }
        }
    }
}

#[tauri::command]
fn vault_search_content(query: String, max_results: Option<u32>) -> Result<Vec<ContentSearchResult>, String> {
    let base = vault_path();
    let limit = max_results.unwrap_or(100) as usize;
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut file_paths = Vec::new();
    walk_text_files(&base, &base, &mut file_paths);

    let mut results = Vec::new();

    for file_path in file_paths {
        if results.len() >= limit { break; }

        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let lines: Vec<&str> = content.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if results.len() >= limit { break; }
            if line.to_lowercase().contains(&q) {
                let relative = file_path.strip_prefix(&base)
                    .unwrap_or(&file_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let name = file_path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                results.push(ContentSearchResult {
                    path: relative,
                    name,
                    line_number: (i + 1) as u32,
                    line_content: line.trim().to_string(),
                    context_before: if i > 0 { lines[i - 1].trim().to_string() } else { String::new() },
                    context_after: if i + 1 < lines.len() { lines[i + 1].trim().to_string() } else { String::new() },
                });
            }
        }
    }

    Ok(results)
}

#[derive(serde::Serialize)]
struct BacklinkResult {
    path: String,
    name: String,
    line_number: u32,
    line_content: String,
}

#[tauri::command]
fn vault_get_backlinks(target_stem: String) -> Result<Vec<BacklinkResult>, String> {
    let base = vault_path();
    let stem_lower = target_stem.to_lowercase();

    // Build regex: [[stem]] or [[stem|display]]
    let pattern = format!(r"(?i)\[\[{0}(\|[^\]]+)?\]\]", regex::escape(&stem_lower));
    let re = regex::Regex::new(&pattern).map_err(|e| format!("Invalid pattern: {}", e))?;

    let mut md_files = Vec::new();
    walk_text_files(&base, &base, &mut md_files);

    let mut results = Vec::new();

    for file_path in md_files {
        // Only scan markdown files
        let ext = file_path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if ext != "md" { continue; }

        // Skip the target file itself
        let file_stem = file_path.file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if file_stem == stem_lower { continue; }

        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (i, line) in content.lines().enumerate() {
            if re.is_match(&line.to_lowercase()) {
                let relative = file_path.strip_prefix(&base)
                    .unwrap_or(&file_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let name = file_path.file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                results.push(BacklinkResult {
                    path: relative,
                    name,
                    line_number: (i + 1) as u32,
                    line_content: line.trim().to_string(),
                });
            }
        }
    }

    Ok(results)
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

/// Deterministic dashboard rebuild — scans all project todos and regenerates
/// the Open Todos section of dashboard.md, preserving Blocked and Activity sections.
fn regenerate_dashboard() -> Result<(), String> {
    let vault = vault_path();
    let config_path = vault.join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read claude-config.md: {}", e))?;

    let dashboard_path = vault.join("00 Home").join("dashboard.md");
    let existing = fs::read_to_string(&dashboard_path).unwrap_or_default();

    // Extract preserved sections from existing dashboard
    let mut blocked_lines: Vec<String> = Vec::new();
    let mut activity_lines: Vec<String> = Vec::new();
    {
        let mut section = "";
        for line in existing.lines() {
            if line.starts_with("## Blocked") {
                section = "blocked";
                continue;
            }
            if line.starts_with("## Recent Activity") {
                section = "activity";
                continue;
            }
            if line.starts_with("## ") {
                section = "";
                continue;
            }
            match section {
                "blocked" => blocked_lines.push(line.to_string()),
                "activity" => activity_lines.push(line.to_string()),
                _ => {}
            }
        }
    }

    // Scan all projects for todos using block parser
    struct ProjectTodos {
        display: String,
        open: Vec<String>, // raw markdown blocks for open todos
    }

    let mut projects: Vec<ProjectTodos> = Vec::new();

    for line in config.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- 01 projects/") {
            continue;
        }
        let rel_path = trimmed.trim_start_matches("- ").to_string();
        let display = rel_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&rel_path)
            .to_string();

        let todos_path = vault.join(&rel_path).join("todos.md");
        let content = match fs::read_to_string(&todos_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let blocks = todo_parser::parse_todo_blocks(&content);
        let open: Vec<String> = blocks.iter()
            .filter(|b| !b.checked)
            .map(todo_parser::block_to_markdown)
            .collect();

        if !open.is_empty() {
            projects.push(ProjectTodos {
                display,
                open,
            });
        }
    }

    // Sort: most open todos first
    projects.sort_by(|a, b| b.open.len().cmp(&a.open.len()));

    // Build dashboard markdown
    let now = Local::now();
    let mut md = String::new();
    md.push_str(&format!(
        "*Last updated: {}*\n\n",
        now.format("%Y-%m-%d %H:%M")
    ));

    md.push_str("## Open Todos\n\n");
    for p in &projects {
        if p.open.is_empty() {
            continue;
        }
        md.push_str(&format!(
            "### \\[\\[{}\\]\\] ({} open)\n",
            p.display,
            p.open.len()
        ));
        for todo in &p.open {
            md.push_str(todo);
            md.push('\n');
        }
        md.push('\n');
    }

    md.push_str("## Blocked / Waiting\n");
    let blocked_content: String = blocked_lines.join("\n");
    let blocked_trimmed = blocked_content.trim();
    if !blocked_trimmed.is_empty() {
        md.push_str(blocked_trimmed);
        md.push('\n');
    }
    md.push('\n');

    md.push_str("## Recent Activity\n");
    let activity_content: String = activity_lines.join("\n");
    let activity_trimmed = activity_content.trim();
    if !activity_trimmed.is_empty() {
        md.push_str(activity_trimmed);
        md.push('\n');
    }
    md.push('\n');

    fs::write(&dashboard_path, md)
        .map_err(|e| format!("Failed to write dashboard: {}", e))
}

#[derive(serde::Serialize)]
struct ProjectInfo {
    name: String,      // display name (last path segment)
    path: String,      // relative vault path
}

#[tauri::command]
fn list_projects() -> Result<Vec<ProjectInfo>, String> {
    let vault = vault_path();
    let config_path = vault.join("claude-config.md");
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read claude-config.md: {}", e))?;

    let mut projects = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("- 01 projects/") {
            let rel = trimmed.trim_start_matches("- ").to_string();
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            projects.push(ProjectInfo { name, path: rel });
        }
    }
    Ok(projects)
}

#[tauri::command]
fn process_inbox() -> Result<inbox::ProcessResult, String> {
    let result = inbox::process(None)?;
    // Deterministically rebuild dashboard after inbox processing
    if let Err(e) = regenerate_dashboard() {
        eprintln!("Warning: dashboard rebuild failed: {}", e);
    }
    Ok(result)
}

#[tauri::command]
fn get_project_gravity() -> Result<Vec<ProjectGravity>, String> {
    let vault = vault_path();
    let config_path = vault.join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read claude-config.md: {}", e))?;

    let today = chrono::Local::now().date_naive();
    let color_map = build_project_color_map(&config);
    let mut results = Vec::new();

    for line in config.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("- 01 projects/") {
            continue;
        }
        let rel = trimmed.trim_start_matches("- ").to_string();
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();

        let color_index = color_map.get(&name).copied().unwrap_or(0);

        // Parse todos using block parser
        let todos_path = vault.join(&rel).join("todos.md");
        let mut open = 0usize;
        let mut completed = 0usize;
        let mut blocked_count = 0usize;
        let mut waiting_count = 0usize;
        let mut neglect_signal = 0.0f64;
        let mut top_todos: Vec<GravityTodo> = Vec::new();

        if let Ok(content) = fs::read_to_string(&todos_path) {
            let blocks = todo_parser::parse_todo_blocks(&content);
            for block in &blocks {
                if block.checked {
                    completed += 1;
                    continue;
                }
                open += 1;

                let is_blocked = block.tags.contains(&"#blocked".to_string());
                let is_waiting = block.tags.contains(&"#waiting".to_string());
                if is_blocked { blocked_count += 1; }
                if is_waiting { waiting_count += 1; }

                let age_days = if let Some(ref created_str) = block.created {
                    if let Ok(created) = chrono::NaiveDate::parse_from_str(created_str, "%Y-%m-%d") {
                        (today - created).num_days().max(0) as u32
                    } else {
                        14
                    }
                } else {
                    14
                };

                let neglect_i = (age_days as f64 / 14.0).min(5.0);
                neglect_signal += neglect_i;

                top_todos.push(GravityTodo {
                    text: block.text.clone(),
                    project_name: name.clone(),
                    project_path: rel.clone(),
                    color_index,
                    age_days,
                    is_blocked,
                    is_waiting,
                });
            }
        }

        // Last activity: scan notes/ folder for most recent YYYY-MM-DD.md
        let notes_dir = vault.join(&rel).join("notes");
        let mut last_note_date: Option<chrono::NaiveDate> = None;
        if let Ok(entries) = fs::read_dir(&notes_dir) {
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                if let Some(date_part) = fname.strip_suffix(".md") {
                    if let Ok(d) = chrono::NaiveDate::parse_from_str(date_part, "%Y-%m-%d") {
                        if last_note_date.map_or(true, |prev| d > prev) {
                            last_note_date = Some(d);
                        }
                    }
                }
            }
        }

        let days_silent = last_note_date
            .map(|d| (today - d).num_days().max(0) as u32)
            .unwrap_or(30); // no notes at all — treat as 30 days silent

        // ── Gravity formula ──────────────────────────────
        // todo_pressure: ln(1 + open) * 10
        let todo_pressure = (1.0 + open as f64).ln() * 10.0;

        // silence_penalty: min(days_silent/7, 8) * ln(1 + open)
        let silence_penalty = (days_silent as f64 / 7.0).min(8.0) * (1.0 + open as f64).ln();

        // blocked_weight: blocked * 3.0 + waiting * 1.5
        let blocked_weight = blocked_count as f64 * 3.0 + waiting_count as f64 * 1.5;

        let gravity = todo_pressure + neglect_signal + silence_penalty + blocked_weight;

        // Sort top_todos by age descending (oldest first = most neglected)
        top_todos.sort_by(|a, b| b.age_days.cmp(&a.age_days));

        results.push(ProjectGravity {
            name,
            path: rel,
            open_todos: open,
            completed_todos: completed,
            gravity,
            color_index,
            todo_pressure,
            neglect_signal,
            silence_penalty,
            blocked_weight,
            blocked_count,
            waiting_count,
            days_silent,
            top_todos,
        });
    }

    // Sort projects by gravity descending
    results.sort_by(|a, b| b.gravity.partial_cmp(&a.gravity).unwrap_or(std::cmp::Ordering::Equal));

    Ok(results)
}

/* ── Todo index commands ─────────────────────────── */

/// Rebuild the todo index from scratch (stamps UUIDs on active projects, scans all files).
#[tauri::command]
fn rebuild_todo_index() -> Result<String, String> {
    let vault = vault_path();
    let index = todo_index::rebuild_and_persist(&vault)?;
    let open = index.entries.values().filter(|e| e.status == "open" && !e.archived).count();
    let completed = index.entries.values().filter(|e| e.status == "completed" && !e.archived).count();
    let archived = index.entries.values().filter(|e| e.archived).count();
    Ok(format!("Index rebuilt: {} open, {} completed, {} archived", open, completed, archived))
}

/// Get the current todo index as JSON.
#[tauri::command]
fn get_todo_index() -> Result<todo_index::TodoIndex, String> {
    let vault = vault_path();
    // Try reading existing index; rebuild if missing
    match todo_index::read_index(&vault) {
        Ok(idx) => Ok(idx),
        Err(_) => todo_index::rebuild_and_persist(&vault),
    }
}

/* ── Weekly Summary ──────────────────────────────────────────── */

#[derive(serde::Serialize)]
struct WeeklySummaryDay {
    date: String,          // YYYY-MM-DD
    weekday: String,       // "Monday", "Tuesday", etc.
    projects: Vec<WeeklySummaryProject>,
}

#[derive(serde::Serialize)]
struct WeeklySummaryProject {
    name: String,
    color_index: usize,
    todos_completed: Vec<String>,
    has_notes: bool,
}

#[derive(serde::Serialize)]
struct WeeklySummary {
    week_start: String,
    week_end: String,
    days: Vec<WeeklySummaryDay>,
    total_completed: usize,
    active_project_count: usize,
}

#[tauri::command]
fn get_weekly_summary(week_offset: i32) -> Result<WeeklySummary, String> {
    let vault = vault_path();
    let config_path = vault.join("claude-config.md");
    let config = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    // Calculate week boundaries (Mon-Sun)
    let today = chrono::Local::now().date_naive();
    let weekday_num = today.weekday().num_days_from_monday() as i64;
    let this_monday = today - chrono::Duration::days(weekday_num);
    let target_monday = this_monday + chrono::Duration::weeks(week_offset as i64);
    let target_sunday = target_monday + chrono::Duration::days(6);

    let weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

    // Collect project paths
    let color_map = build_project_color_map(&config);
    let mut project_entries: Vec<(String, String, usize)> = Vec::new(); // (name, rel_path, color_index)
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("- 01 projects/") {
            let rel = trimmed.trim_start_matches("- ").to_string();
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let color_index = color_map.get(&name).copied().unwrap_or(0);
            project_entries.push((name, rel, color_index));
        }
    }

    // For each day in the week, collect data per project
    let mut days: Vec<WeeklySummaryDay> = Vec::new();
    let mut total_completed = 0usize;
    let mut active_projects = std::collections::HashSet::new();

    for day_offset in 0..7 {
        let date = target_monday + chrono::Duration::days(day_offset);
        let date_str = date.format("%Y-%m-%d").to_string();
        let weekday = weekday_names[day_offset as usize].to_string();

        let mut day_projects: Vec<WeeklySummaryProject> = Vec::new();

        for (name, rel, color_index) in &project_entries {
            let mut todos_completed: Vec<String> = Vec::new();

            // Scan todos.md for completed todos matching this date
            let todos_path = vault.join(rel).join("todos.md");
            if let Ok(content) = fs::read_to_string(&todos_path) {
                let blocks = todo_parser::parse_todo_blocks(&content);
                for block in &blocks {
                    if block.checked {
                        if let Some(ref completed) = block.completed {
                            if completed == &date_str {
                                todos_completed.push(block.text.clone());
                            }
                        }
                    }
                }
            }

            // Check for notes on this date
            let note_path = vault.join(rel).join("notes").join(format!("{}.md", date_str));
            let has_notes = note_path.exists();

            if !todos_completed.is_empty() || has_notes {
                total_completed += todos_completed.len();
                active_projects.insert(name.clone());
                day_projects.push(WeeklySummaryProject {
                    name: name.clone(),
                    color_index: *color_index,
                    todos_completed,
                    has_notes,
                });
            }
        }

        // Only include days that have activity
        if !day_projects.is_empty() {
            days.push(WeeklySummaryDay {
                date: date_str,
                weekday,
                projects: day_projects,
            });
        }
    }

    Ok(WeeklySummary {
        week_start: target_monday.format("%Y-%m-%d").to_string(),
        week_end: target_sunday.format("%Y-%m-%d").to_string(),
        days,
        total_completed,
        active_project_count: active_projects.len(),
    })
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

            // Rebuild todo index on app launch (stamps UUIDs on unstamped todos,
            // builds .todo-index.json from authoritative markdown files)
            let vault = vault_path();
            match todo_index::rebuild_and_persist(&vault) {
                Ok(index) => {
                    let open = index.entries.values().filter(|e| e.status == "open" && !e.archived).count();
                    eprintln!("Todo index rebuilt on launch: {} open todos indexed", open);
                }
                Err(e) => eprintln!("Warning: todo index rebuild failed on launch: {}", e),
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
            vault_create_file,
            vault_create_dir,
            vault_rename,
            vault_delete,
            vault_move,
            vault_copy,
            vault_search_files,
            vault_search_content,
            vault_get_backlinks,
            hum::hum_send,
            list_projects,
            process_inbox,
            get_project_gravity,
            get_weekly_summary,
            rebuild_todo_index,
            get_todo_index,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
