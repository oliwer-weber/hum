// Vault-backed user preferences. Single source of truth for settings that
// both the renderer (TS) and backend (Rust) need to read — e.g. the ICS URL
// is used by Rust to fetch the calendar, but the user sets it from the UI.

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

use crate::vault_path;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Prefs {
    #[serde(default)]
    pub ics_url: String,
    #[serde(default = "default_starting_tab")]
    pub starting_tab: String,
    // Default true: existing users (and anyone whose prefs.json predates this field)
    // never see the welcome screen. Fresh scaffolds explicitly write this as false.
    #[serde(default = "default_first_run_completed")]
    pub first_run_completed: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            ics_url: String::new(),
            starting_tab: default_starting_tab(),
            first_run_completed: default_first_run_completed(),
        }
    }
}

fn default_starting_tab() -> String {
    "write".to_string()
}

fn default_first_run_completed() -> bool {
    true
}

/// Write a fresh prefs.json marking the welcome screen as pending.
/// Called by vault scaffold when a brand-new vault is created.
pub fn mark_first_run_pending() -> Result<(), String> {
    let mut prefs = read();
    prefs.first_run_completed = false;
    write(&prefs)
}

fn prefs_path() -> PathBuf {
    vault_path().join(".app").join("prefs.json")
}

pub fn read() -> Prefs {
    let path = prefs_path();
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Prefs::default(),
    }
}

fn write(prefs: &Prefs) -> Result<(), String> {
    let path = prefs_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create .app dir: {}", e))?;
    }
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("Failed to serialize prefs: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write prefs: {}", e))
}

#[tauri::command]
pub fn get_prefs() -> Prefs {
    read()
}

#[tauri::command]
pub fn set_prefs(prefs: Prefs) -> Result<(), String> {
    write(&prefs)
}
