// Vault state manifest. Replaces the legacy .app/claude-config.md markdown file
// with structured JSON. Tracks active projects, excluded directories, attachment
// location, and the last inbox-processing timestamp.
//
// Project rel_paths are stored as an ordered Vec so color assignment
// (build_project_color_map) remains deterministic across runs.

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

pub const CURRENT_VERSION: u32 = 2;
pub const MANIFEST_FILENAME: &str = "vault.json";

fn default_version() -> u32 {
    CURRENT_VERSION
}

fn default_attachment_location() -> String {
    ".app/metadata/Assets".to_string()
}

/// One project row in the manifest. `path` is the vault-relative folder path
/// (e.g. "projects/work/Hum"). `pinned` floats the project to the top of L1
/// Projects view; defaults to false so legacy manifests roll forward cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub path: String,
    #[serde(default)]
    pub pinned: bool,
}

impl ProjectEntry {
    pub fn new(path: impl Into<String>) -> Self {
        Self { path: path.into(), pinned: false }
    }
}

/// Tolerant form used only for deserialization. Accepts the legacy
/// `["projects/foo", …]` shape and the modern `[{path, pinned}, …]` shape,
/// so bumping CURRENT_VERSION from 1 to 2 never breaks existing vaults.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ProjectItem {
    Legacy(String),
    Modern(ProjectEntry),
}

impl From<ProjectItem> for ProjectEntry {
    fn from(item: ProjectItem) -> Self {
        match item {
            ProjectItem::Legacy(path) => ProjectEntry::new(path),
            ProjectItem::Modern(entry) => entry,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    projects: Vec<ProjectItem>,
    #[serde(default)]
    excluded_directories: Vec<String>,
    #[serde(default = "default_attachment_location")]
    attachment_location: String,
    #[serde(default)]
    last_inbox_processing: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultManifest {
    pub version: u32,
    pub projects: Vec<ProjectEntry>,
    pub excluded_directories: Vec<String>,
    pub attachment_location: String,
    pub last_inbox_processing: String,
}

impl Default for VaultManifest {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            projects: Vec::new(),
            excluded_directories: Vec::new(),
            attachment_location: default_attachment_location(),
            last_inbox_processing: String::new(),
        }
    }
}

impl VaultManifest {
    pub fn path_in(vault: &std::path::Path) -> PathBuf {
        vault.join(".app").join(MANIFEST_FILENAME)
    }

    pub fn read_in(vault: &std::path::Path) -> Result<Self, String> {
        let path = Self::path_in(vault);
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read vault manifest: {}", e))?;
        let raw: RawManifest = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse vault manifest: {}", e))?;
        Ok(VaultManifest {
            version: CURRENT_VERSION,
            projects: raw.projects.into_iter().map(ProjectEntry::from).collect(),
            excluded_directories: raw.excluded_directories,
            attachment_location: raw.attachment_location,
            last_inbox_processing: raw.last_inbox_processing,
        })
    }

    pub fn write_in(&self, vault: &std::path::Path) -> Result<(), String> {
        let path = Self::path_in(vault);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .app dir: {}", e))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize vault manifest: {}", e))?;
        fs::write(&path, json)
            .map_err(|e| format!("Failed to write vault manifest: {}", e))
    }

    /// Iterate project rel_paths. Preserves insertion order, which callers
    /// (e.g. color assignment) depend on for deterministic output.
    pub fn project_paths(&self) -> impl Iterator<Item = &str> {
        self.projects.iter().map(|p| p.path.as_str())
    }

    /// Last path segment of each project rel_path, in order.
    pub fn project_names(&self) -> impl Iterator<Item = &str> {
        self.projects.iter().map(|p| {
            p.path.rsplit('/').next().unwrap_or(p.path.as_str())
        })
    }

    /// True if the given project path exists in the manifest.
    pub fn has_project(&self, rel_path: &str) -> bool {
        self.projects.iter().any(|p| p.path == rel_path)
    }

    /// True if the project is marked pinned. False if not pinned or missing.
    pub fn is_project_pinned(&self, rel_path: &str) -> bool {
        self.projects.iter().any(|p| p.path == rel_path && p.pinned)
    }

    /// Flip a project's pinned flag. No-op if the project isn't in the
    /// manifest (caller should have reconciled first).
    pub fn set_project_pinned(&mut self, rel_path: &str, pinned: bool) -> bool {
        for entry in &mut self.projects {
            if entry.path == rel_path {
                entry.pinned = pinned;
                return true;
            }
        }
        false
    }

    pub fn set_last_inbox_processing(&mut self, timestamp: &str) {
        self.last_inbox_processing = timestamp.to_string();
    }
}

// ── One-shot migration: .app/claude-config.md → .app/vault.json ──
//
// Parses the legacy markdown manifest, writes an equivalent vault.json,
// renames the old file to .bak. Fires only when the markdown exists and
// the JSON does not; safe to call on every startup.

const LEGACY_FILENAME: &str = "claude-config.md";
const LEGACY_BACKUP_SUFFIX: &str = ".bak";

pub fn migrate_from_legacy_if_needed(vault: &std::path::Path) -> Result<bool, String> {
    let legacy_path = vault.join(".app").join(LEGACY_FILENAME);
    let new_path = VaultManifest::path_in(vault);

    if !legacy_path.exists() || new_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(&legacy_path)
        .map_err(|e| format!("Failed to read legacy manifest: {}", e))?;

    let manifest = parse_legacy_markdown(&content);
    manifest.write_in(vault)?;

    let backup_path = legacy_path.with_file_name(format!("{}{}", LEGACY_FILENAME, LEGACY_BACKUP_SUFFIX));
    fs::rename(&legacy_path, &backup_path)
        .map_err(|e| format!("Failed to rename legacy manifest: {}", e))?;

    Ok(true)
}

fn parse_legacy_markdown(content: &str) -> VaultManifest {
    let mut manifest = VaultManifest::default();
    let mut section: Option<&str> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();

        if let Some(header) = line.strip_prefix("## ") {
            section = Some(match header.trim() {
                "Active Projects" => "projects",
                "Excluded Directories" => "excluded",
                _ => "",
            });
            continue;
        }

        if let Some(rest) = line.strip_prefix("last_inbox_processing:") {
            manifest.last_inbox_processing = rest.trim().to_string();
            continue;
        }

        if let Some(rest) = line.strip_prefix("attachment_location:") {
            manifest.attachment_location = rest.trim().to_string();
            continue;
        }

        match section {
            Some("projects") => {
                if let Some(entry) = line.strip_prefix("- projects/") {
                    let path = format!("projects/{}", entry.trim());
                    manifest.projects.push(ProjectEntry::new(path));
                }
            }
            Some("excluded") => {
                if let Some(entry) = line.strip_prefix("- ") {
                    let cleaned = entry
                        .split(" — ")
                        .next()
                        .unwrap_or(entry)
                        .trim()
                        .trim_end_matches('/')
                        .to_string();
                    if !cleaned.is_empty() {
                        manifest.excluded_directories.push(cleaned);
                    }
                }
            }
            _ => {}
        }
    }

    manifest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_legacy_v1_string_array_projects() {
        let json = r#"{
            "version": 1,
            "projects": ["projects/work/foo", "projects/personal/bar"],
            "excluded_directories": [],
            "attachment_location": ".app/metadata/Assets",
            "last_inbox_processing": ""
        }"#;
        let raw: RawManifest = serde_json::from_str(json).expect("parses");
        let projects: Vec<ProjectEntry> = raw.projects.into_iter().map(ProjectEntry::from).collect();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, "projects/work/foo");
        assert!(!projects[0].pinned);
        assert_eq!(projects[1].path, "projects/personal/bar");
    }

    #[test]
    fn reads_modern_v2_object_projects_with_pinned() {
        let json = r#"{
            "version": 2,
            "projects": [
                {"path": "projects/work/foo", "pinned": true},
                {"path": "projects/personal/bar"}
            ],
            "excluded_directories": [],
            "attachment_location": ".app/metadata/Assets",
            "last_inbox_processing": ""
        }"#;
        let raw: RawManifest = serde_json::from_str(json).expect("parses");
        let projects: Vec<ProjectEntry> = raw.projects.into_iter().map(ProjectEntry::from).collect();
        assert_eq!(projects.len(), 2);
        assert!(projects[0].pinned);
        assert!(!projects[1].pinned);
    }

    #[test]
    fn parses_sample_legacy_file() {
        let sample = r#"
# Vault State

## Active Projects

### work
- projects/work/air validator
- projects/work/Kalkyl-X

### personal
- projects/personal/QUIP

## Excluded Directories

- projects/archive/ — inactive projects
- notes/ — standalone running-list notes
- .app/ — app plumbing

## Vault Settings

### Attachment Handling

```
attachment_location: .app/metadata/Assets
```

## Processing State

### Last Inbox Processing

```
last_inbox_processing: 2026-04-21T14:09
```
"#;
        let m = parse_legacy_markdown(sample);
        let paths: Vec<&str> = m.projects.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(paths, vec![
            "projects/work/air validator",
            "projects/work/Kalkyl-X",
            "projects/personal/QUIP",
        ]);
        assert!(m.projects.iter().all(|p| !p.pinned));
        assert_eq!(m.excluded_directories, vec![
            "projects/archive",
            "notes",
            ".app",
        ]);
        assert_eq!(m.attachment_location, ".app/metadata/Assets");
        assert_eq!(m.last_inbox_processing, "2026-04-21T14:09");
    }
}
