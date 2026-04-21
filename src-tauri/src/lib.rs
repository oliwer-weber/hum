// Project Assistant — Tauri backend
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Instant;
use once_cell::sync::Lazy;
use rayon::prelude::*;

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
    [".git", ".obsidian", ".trash", ".claude", ".app", "node_modules"].iter().copied().collect()
});
static BINARY_EXTS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "pdf", "mp3", "mp4",
     "zip", "tar", "gz", "exe", "dll", "woff", "woff2", "ttf", "otf"].iter().copied().collect()
});

mod calendar;
mod hum;
mod inbox;
mod prefs;
mod todo_index;
mod todo_parser;
mod vault_manifest;

use chrono::{Datelike, Local};
use std::collections::HashMap;

/// Number of project pip colors (excludes red which signals errors).
const NUM_PROJECT_COLORS: usize = 6;

/// Build a deterministic project-name → color_index map from the vault manifest.
/// Colors are assigned in manifest order, cycling after all 6 are used.
/// The palette order (matching the frontend): aqua=0, green=1, yellow=2, blue=3, purple=4, orange=5.
/// Red (index 6) is intentionally excluded.
fn build_project_color_map(manifest: &vault_manifest::VaultManifest) -> HashMap<String, usize> {
    let mut map = HashMap::new();
    let mut idx = 0usize;
    for name in manifest.project_names() {
        if !map.contains_key(name) {
            map.insert(name.to_string(), idx % NUM_PROJECT_COLORS);
            idx += 1;
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
    dirs::home_dir()
        .unwrap_or_default()
        .join("Documents")
        .join("Hum")
}

/// Ensure the vault directory tree exists. Returns true if the vault was freshly
/// created (dir did not exist before). Idempotent: safe to call on every launch.
fn ensure_vault_scaffold(vault: &Path) -> Result<bool, String> {
    let is_fresh = !vault.exists();

    let required_dirs = [
        vault.join(".app").join("metadata").join("Assets"),
        vault.join("inbox"),
        vault.join("projects"),
    ];
    for dir in &required_dirs {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }

    let inbox_path = vault.join("inbox").join("inbox.md");
    if !inbox_path.exists() {
        fs::write(&inbox_path, "")
            .map_err(|e| format!("Failed to create inbox.md: {}", e))?;
    }

    // Only write a default vault.json if neither it nor the legacy markdown exists.
    // If the legacy file is present, migration (run immediately after this)
    // produces the manifest from real data.
    let manifest_path = vault_manifest::VaultManifest::path_in(vault);
    let legacy_path = vault.join(".app").join("claude-config.md");
    if !manifest_path.exists() && !legacy_path.exists() {
        vault_manifest::VaultManifest::default().write_in(vault)?;
    }

    Ok(is_fresh)
}

#[tauri::command]
fn read_dashboard() -> Result<String, String> {
    let path = vault_path().join(".app").join("dashboard.md");
    fs::read_to_string(&path).map_err(|e| format!("Failed to read dashboard: {}", e))
}

#[tauri::command]
fn read_inbox() -> Result<String, String> {
    let path = vault_path().join("inbox").join("inbox.md");
    fs::read_to_string(&path).map_err(|e| format!("Failed to read inbox: {}", e))
}

#[tauri::command]
fn write_inbox(content: String) -> Result<(), String> {
    let path = vault_path().join("inbox").join("inbox.md");
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
    let path = vault_path().join("inbox").join("inbox.md");
    fs::write(&path, content).map_err(|e| format!("Failed to write inbox: {}", e))
}

#[tauri::command]
fn get_vault_path() -> String {
    vault_path().to_string_lossy().to_string()
}

#[tauri::command]
fn toggle_dashboard_todo(project: String, todo_text: String, checked: bool) -> Result<(), String> {
    let vault = vault_path();
    let manifest = vault_manifest::VaultManifest::read_in(&vault)?;

    let mut project_rel: Option<String> = None;
    for rel in manifest.project_paths() {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if name.eq_ignore_ascii_case(&project) {
            project_rel = Some(rel.to_string());
            break;
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

/// Read and parse the todos.md file for a single project. Returns parsed
/// blocks (checkbox + any continuation body) so the client can render a
/// polished view without duplicating the parser. Empty file / missing file
/// returns an empty vec instead of an error so the view can render the
/// "no todos yet" state cleanly.
#[tauri::command]
fn read_project_todos(project_rel_path: String) -> Result<Vec<todo_parser::TodoBlock>, String> {
    let vault = vault_path();
    let todos_path = vault.join(&project_rel_path).join("todos.md");
    let content = match fs::read_to_string(&todos_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Failed to read todos.md: {}", e)),
    };
    Ok(todo_parser::parse_todo_blocks(&content))
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
/// When `context_path` is provided, prefer matches in the same directory subtree.
#[tauri::command]
fn vault_resolve_link(target: String, context_path: Option<String>) -> Result<String, String> {
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
                let dir_name = entry.file_name();
                let dir_name_str = dir_name.to_string_lossy();
                // Skip dot-prefixed directories except `.app`, which holds resolvable assets.
                if dir_name_str.starts_with('.') && dir_name_str != ".app" {
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

    if matches.len() == 1 {
        let relative = matches[0].strip_prefix(&base).unwrap_or(&matches[0]);
        return Ok(relative.to_string_lossy().replace('\\', "/"));
    }

    // Context-aware: prefer matches sharing longest common path prefix
    if let Some(ref ctx) = context_path {
        let ctx_lower = ctx.to_lowercase().replace('\\', "/");
        let ctx_parts: Vec<&str> = ctx_lower.split('/').collect();
        let mut best_idx = 0;
        let mut best_shared = 0usize;
        for (i, m) in matches.iter().enumerate() {
            let rel = m.strip_prefix(&base).unwrap_or(m);
            let rel_str = rel.to_string_lossy().to_lowercase().replace('\\', "/");
            let m_parts: Vec<&str> = rel_str.split('/').collect();
            let shared = ctx_parts.iter().zip(m_parts.iter())
                .take_while(|(a, b)| a == b).count();
            if shared > best_shared { best_shared = shared; best_idx = i; }
        }
        if best_shared > 0 {
            let relative = matches[best_idx].strip_prefix(&base).unwrap_or(&matches[best_idx]);
            return Ok(relative.to_string_lossy().replace('\\', "/"));
        }
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
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
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
fn vault_save_image(filename: String, data: Vec<u8>) -> Result<String, String> {
    let base = vault_path();
    let assets_dir = base.join(".app").join("metadata").join("Assets");
    fs::create_dir_all(&assets_dir).map_err(|e| format!("Failed to create Assets dir: {}", e))?;
    let resolved = assets_dir.join(&filename);
    // Security: ensure we stay inside the vault
    let assets_canon = assets_dir.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let base_canon = base.canonicalize().map_err(|e| format!("Vault error: {}", e))?;
    if !assets_canon.starts_with(&base_canon) {
        return Err("Path outside vault".to_string());
    }
    fs::write(&resolved, &data).map_err(|e| format!("Failed to save image: {}", e))?;
    invalidate_vault_cache();
    let relative = format!(".app/metadata/Assets/{}", filename);
    Ok(relative)
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

// ── Hub search: unified, proximity-biased, parallel ──

#[derive(serde::Serialize, Clone)]
struct HubSearchResult {
    path: String,
    name: String,
    match_kind: String,
    line_number: Option<u32>,
    line_content: Option<String>,
    score: u32,
    proximity: String,
}

#[tauri::command]
fn hub_search(query: String, project_prefix: String) -> Result<Vec<HubSearchResult>, String> {
    let q = query.to_lowercase();
    if q.len() < 2 {
        return Ok(Vec::new());
    }

    let base = vault_path();
    let all_files = vault_all_files()?;

    // Collect text file paths for content search
    let mut file_paths = Vec::new();
    walk_text_files(&base, &base, &mut file_paths);

    let prefix_lower = project_prefix.to_lowercase();

    // Run file matching and content matching in parallel
    let (file_results, content_results) = rayon::join(
        || -> Vec<HubSearchResult> {
            all_files
                .iter()
                .filter_map(|f| {
                    let stem_lower = f.stem.to_lowercase();
                    let name_lower = f.name.to_lowercase();
                    let path_lower = f.path.to_lowercase();

                    let relevance: u32 = if stem_lower.starts_with(&q) {
                        0
                    } else if name_lower.contains(&q) {
                        10
                    } else if path_lower.contains(&q) {
                        20
                    } else {
                        return None;
                    };

                    let proximity_score: u32 = if path_lower.starts_with(&prefix_lower) { 0 } else { 100 };
                    let prox_label = if path_lower.starts_with(&prefix_lower) { "project" } else { "vault" };

                    Some(HubSearchResult {
                        path: f.path.clone(),
                        name: f.name.clone(),
                        match_kind: "file".to_string(),
                        line_number: None,
                        line_content: None,
                        score: relevance + proximity_score,
                        proximity: prox_label.to_string(),
                    })
                })
                .collect()
        },
        || -> Vec<HubSearchResult> {
            let results: Vec<Vec<HubSearchResult>> = file_paths
                .par_iter()
                .filter_map(|file_path| {
                    let content = fs::read_to_string(file_path).ok()?;
                    let relative = file_path.strip_prefix(&base)
                        .unwrap_or(file_path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let name = file_path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let rel_lower = relative.to_lowercase();
                    let proximity_score: u32 = if rel_lower.starts_with(&prefix_lower) { 0 } else { 100 };
                    let prox_label = if rel_lower.starts_with(&prefix_lower) { "project" } else { "vault" };

                    let mut hits = Vec::new();
                    for (i, line) in content.lines().enumerate() {
                        if line.to_lowercase().contains(&q) {
                            hits.push(HubSearchResult {
                                path: relative.clone(),
                                name: name.clone(),
                                match_kind: "content".to_string(),
                                line_number: Some((i + 1) as u32),
                                line_content: Some(line.trim().to_string()),
                                score: 40 + proximity_score,
                                proximity: prox_label.to_string(),
                            });
                            if hits.len() >= 3 { break; } // max 3 hits per file
                        }
                    }
                    if hits.is_empty() { None } else { Some(hits) }
                })
                .collect();
            results.into_iter().flatten().collect()
        },
    );

    // Merge, deduplicate (prefer file match over content match for same path), sort
    let mut merged = file_results;
    let file_paths_set: HashSet<String> = merged.iter().map(|r| r.path.clone()).collect();
    for cr in content_results {
        if !file_paths_set.contains(&cr.path) {
            merged.push(cr);
        }
    }

    merged.sort_by(|a, b| {
        a.score.cmp(&b.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
    });
    merged.truncate(30);

    Ok(merged)
}

// ── Hub ambient: recent notes + stats ──

#[derive(serde::Serialize)]
struct HubAmbient {
    recent_notes: Vec<HubRecentNote>,
    note_count: u32,
    open_todos: u32,
}

#[derive(serde::Serialize)]
struct HubRecentNote {
    path: String,
    date: String,
    gist: String,
}

fn get_first_meaningful_line(content: &str) -> String {
    let mut in_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            in_frontmatter = !in_frontmatter;
            continue;
        }
        if in_frontmatter { continue; }
        if trimmed.is_empty() { continue; }
        if trimmed.starts_with('#') { continue; }
        return trimmed.to_string();
    }
    String::new()
}

#[tauri::command]
fn hub_ambient(project_prefix: String) -> Result<HubAmbient, String> {
    let base = vault_path();
    let project_dir = base.join(&project_prefix);
    let notes_dir = project_dir.join("notes");

    // Find date-named notes
    let date_re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap();
    let mut date_notes: Vec<(String, PathBuf)> = Vec::new();
    let mut note_count: u32 = 0;

    if notes_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&notes_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "md").unwrap_or(false) {
                    note_count += 1;
                    if let Some(stem) = path.file_stem() {
                        let stem_str = stem.to_string_lossy().to_string();
                        if date_re.is_match(&stem_str) {
                            date_notes.push((stem_str, path));
                        }
                    }
                }
            }
        }
    }

    // Also count md files directly in project dir (excluding the hub file itself)
    if project_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&project_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().map(|e| e == "md").unwrap_or(false) {
                    // Don't double-count notes/ files, and skip hub file
                    let fname = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let parent_name = project_dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    if fname.to_lowercase() != parent_name.to_lowercase() {
                        note_count += 1;
                    }
                }
            }
        }
    }

    // Sort by date descending, take 5
    date_notes.sort_by(|a, b| b.0.cmp(&a.0));
    date_notes.truncate(5);

    let recent_notes: Vec<HubRecentNote> = date_notes
        .into_iter()
        .map(|(date, path)| {
            let gist = fs::read_to_string(&path)
                .map(|c| get_first_meaningful_line(&c))
                .unwrap_or_default();
            let relative = path.strip_prefix(&base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            HubRecentNote { path: relative, date, gist }
        })
        .collect();

    // Count todos
    let todos_path = project_dir.join("todos.md");
    let (open_todos, _done_todos) = if todos_path.is_file() {
        let content = fs::read_to_string(&todos_path).unwrap_or_default();
        let open = content.lines().filter(|l| l.trim_start().starts_with("- [ ]")).count() as u32;
        let done = content.lines().filter(|l| {
            let t = l.trim_start();
            t.starts_with("- [x]") || t.starts_with("- [X]")
        }).count() as u32;
        (open, done)
    } else {
        (0, 0)
    };

    Ok(HubAmbient {
        recent_notes,
        note_count,
        open_todos,
    })
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
async fn fetch_calendar() -> Result<String, String> {
    let url = prefs::read().ics_url;
    let data = calendar::fetch_ics(&url).await?;
    serde_json::to_string(&data).map_err(|e| format!("Failed to serialize calendar: {}", e))
}

/// Deterministic dashboard rebuild — scans all project todos and regenerates
/// the Open Todos section of dashboard.md, preserving Blocked and Activity sections.
fn regenerate_dashboard() -> Result<(), String> {
    let vault = vault_path();
    let manifest = vault_manifest::VaultManifest::read_in(&vault)?;

    let dashboard_path = vault.join(".app").join("dashboard.md");
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

    for rel_path in manifest.project_paths() {
        let display = rel_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(rel_path)
            .to_string();

        let todos_path = vault.join(rel_path).join("todos.md");
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
    let manifest = vault_manifest::VaultManifest::read_in(&vault)?;

    let projects = manifest
        .project_paths()
        .map(|rel| ProjectInfo {
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            path: rel.to_string(),
        })
        .collect();
    Ok(projects)
}

#[derive(serde::Serialize)]
struct MentionableItem {
    name: String,     // display name (project name or file stem)
    path: String,     // relative vault path
    kind: String,     // "project" | "note" | "wiki"
}

/// Return everything an `@` mention can target: active projects, notes/*.md,
/// wiki/*.md. Used by the inbox autocomplete so users see existing notes/wiki
/// files alongside projects.
#[tauri::command]
fn list_mentionables() -> Result<Vec<MentionableItem>, String> {
    let vault = vault_path();
    let mut items: Vec<MentionableItem> = Vec::new();

    // Projects from manifest (tolerate missing file: empty mentionables fall back to notes/wiki scan below)
    if let Ok(manifest) = vault_manifest::VaultManifest::read_in(&vault) {
        for rel in manifest.project_paths() {
            items.push(MentionableItem {
                name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
                path: rel.to_string(),
                kind: "project".into(),
            });
        }
    }

    fn collect_md(dir: &Path, base: &Path, kind: &str, items: &mut Vec<MentionableItem>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let n = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if n == "archive" || n.starts_with('.') { continue; }
                collect_md(&path, base, kind, items);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let (Some(stem), Ok(rel)) = (
                    path.file_stem().and_then(|s| s.to_str()),
                    path.strip_prefix(base),
                ) {
                    items.push(MentionableItem {
                        name: stem.to_string(),
                        path: rel.to_string_lossy().replace('\\', "/"),
                        kind: kind.to_string(),
                    });
                }
            }
        }
    }

    let notes_dir = vault.join("notes");
    if notes_dir.exists() {
        collect_md(&notes_dir, &vault, "note", &mut items);
    }
    let wiki_dir = vault.join("wiki");
    if wiki_dir.exists() {
        collect_md(&wiki_dir, &vault, "wiki", &mut items);
    }

    Ok(items)
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
    let manifest = vault_manifest::VaultManifest::read_in(&vault)?;

    let today = chrono::Local::now().date_naive();
    let color_map = build_project_color_map(&manifest);
    let mut results = Vec::new();

    for rel_ref in manifest.project_paths() {
        let rel = rel_ref.to_string();
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

/* ── Focus & snooze ──────────────────────────────── */

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct SnoozeEntry {
    project: String,
    until: String, // YYYY-MM-DD
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct FocusState {
    #[serde(default)]
    focus: Vec<String>,
    #[serde(default, rename = "focusSetAt")]
    focus_set_at: String,
    #[serde(default)]
    snoozed: Vec<SnoozeEntry>,
}

fn focus_file_path() -> PathBuf {
    vault_path().join(".app").join("focus.json")
}

/// Read focus state from disk, auto-clearing stale focus (set before today)
/// and auto-dropping snoozes whose `until` date has passed.
fn read_focus_state() -> FocusState {
    let path = focus_file_path();
    let mut state: FocusState = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let today = chrono::Local::now().date_naive();
    let today_str = today.format("%Y-%m-%d").to_string();

    if state.focus_set_at != today_str {
        state.focus.clear();
        state.focus_set_at = String::new();
    }

    state.snoozed.retain(|s| {
        chrono::NaiveDate::parse_from_str(&s.until, "%Y-%m-%d")
            .map(|d| d >= today)
            .unwrap_or(false)
    });

    state
}

fn write_focus_state(state: &FocusState) -> Result<(), String> {
    let path = focus_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create .app dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize focus state: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write focus.json: {}", e))
}

#[tauri::command]
fn get_focus_state() -> Result<FocusState, String> {
    Ok(read_focus_state())
}

#[tauri::command]
fn set_focus(projects: Vec<String>) -> Result<FocusState, String> {
    let mut state = read_focus_state();
    let today_str = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
    state.focus = projects;
    state.focus_set_at = if state.focus.is_empty() { String::new() } else { today_str };
    write_focus_state(&state)?;
    Ok(state)
}

#[tauri::command]
fn snooze_project(project: String, until: String) -> Result<FocusState, String> {
    chrono::NaiveDate::parse_from_str(&until, "%Y-%m-%d")
        .map_err(|_| format!("Invalid until date (expected YYYY-MM-DD): {}", until))?;

    let mut state = read_focus_state();
    state.snoozed.retain(|s| s.project != project);
    state.snoozed.push(SnoozeEntry { project, until });
    write_focus_state(&state)?;
    Ok(state)
}

#[tauri::command]
fn unsnooze_project(project: String) -> Result<FocusState, String> {
    let mut state = read_focus_state();
    state.snoozed.retain(|s| s.project != project);
    write_focus_state(&state)?;
    Ok(state)
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
    let manifest = vault_manifest::VaultManifest::read_in(&vault)?;

    // Calculate week boundaries (Mon-Sun)
    let today = chrono::Local::now().date_naive();
    let weekday_num = today.weekday().num_days_from_monday() as i64;
    let this_monday = today - chrono::Duration::days(weekday_num);
    let target_monday = this_monday + chrono::Duration::weeks(week_offset as i64);
    let target_sunday = target_monday + chrono::Duration::days(6);

    let weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

    // Collect project paths
    let color_map = build_project_color_map(&manifest);
    let mut project_entries: Vec<(String, String, usize)> = Vec::new(); // (name, rel_path, color_index)
    for rel_ref in manifest.project_paths() {
        let rel = rel_ref.to_string();
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let color_index = color_map.get(&name).copied().unwrap_or(0);
        project_entries.push((name, rel, color_index));
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

            let vault = vault_path();

            // Scaffold vault tree if missing, then flag welcome as pending
            match ensure_vault_scaffold(&vault) {
                Ok(true) => {
                    if let Err(e) = prefs::mark_first_run_pending() {
                        eprintln!("Warning: could not flag first run: {}", e);
                    }
                    eprintln!("Fresh vault scaffolded at {}", vault.display());
                }
                Ok(false) => {}
                Err(e) => eprintln!("Warning: vault scaffold failed: {}", e),
            }

            // Migrate legacy claude-config.md → vault.json if needed (one-shot)
            match vault_manifest::migrate_from_legacy_if_needed(&vault) {
                Ok(true) => eprintln!("Migrated legacy claude-config.md → vault.json"),
                Ok(false) => {}
                Err(e) => eprintln!("Warning: manifest migration failed: {}", e),
            }

            // Rebuild todo index on app launch (stamps UUIDs on unstamped todos,
            // builds .todo-index.json from authoritative markdown files)
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
            vault_save_image,
            vault_create_file,
            vault_create_dir,
            vault_rename,
            vault_delete,
            vault_move,
            vault_copy,
            vault_search_files,
            vault_search_content,
            vault_get_backlinks,
            hub_search,
            hub_ambient,
            hum::hum_send,
            list_projects,
            list_mentionables,
            process_inbox,
            get_project_gravity,
            get_weekly_summary,
            rebuild_todo_index,
            get_todo_index,
            get_focus_state,
            set_focus,
            snooze_project,
            unsnooze_project,
            read_project_todos,
            prefs::get_prefs,
            prefs::set_prefs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
