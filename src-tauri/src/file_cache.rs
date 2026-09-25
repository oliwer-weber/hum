// In-memory cache of vault file contents, keyed by path and validated against
// the file's (mtime, length) on every read.
//
// The Find corpus, search, backlinks, titles and gravity all walk the whole
// vault and read every note. On Windows each file open is expensive (antivirus
// scans on open, cold disk cache after boot), so re-reading hundreds of notes
// per call is what made Find and startup feel slow. A metadata stat is far
// cheaper than open + read, so unchanged files come straight from memory.
//
// Only the read-only scanners use this. Commands that read-modify-write a file
// keep using fs::read_to_string so they always see the bytes on disk.

use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

struct Entry {
    modified: SystemTime,
    len: u64,
    content: Arc<str>,
}

static CACHE: Lazy<Mutex<HashMap<PathBuf, Entry>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Drop-in for `fs::read_to_string` that serves unchanged files from memory.
pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    let path = path.as_ref();
    let meta = fs::metadata(path)?;
    let modified = meta.modified()?;
    let len = meta.len();

    if let Ok(cache) = CACHE.lock() {
        if let Some(e) = cache.get(path) {
            if e.modified == modified && e.len == len {
                return Ok(e.content.to_string());
            }
        }
    }

    let content = fs::read_to_string(path)?;
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(
            path.to_path_buf(),
            Entry { modified, len, content: Arc::from(content.as_str()) },
        );
    }
    Ok(content)
}
