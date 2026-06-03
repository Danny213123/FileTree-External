//! F7 Saved searches / Smart Folders store.
//!
//! A Smart Folder is a named, persisted search+filter query that the UI
//! re-evaluates live against the loaded scan. The query set is stored as a JSON
//! array at `%APPDATA%\FileTree\smart-folders.json`, replaced wholesale on save
//! (atomic temp-then-rename with a `.bak` backup) — the same store pattern as
//! bookmarks/tags. The on-disk JSON IS the API shape verbatim
//! (`[{"id","name","query":{"text"?,"rules"?}}]`), so GET streams the file and
//! POST persists the posted array as-is.

use std::fs;
use std::io;
use std::path::PathBuf;

/// `%APPDATA%\FileTree\smart-folders.json` (Windows) or
/// `~/.config/filetree/smart-folders.json` elsewhere.
pub(crate) fn smart_folders_path() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("smart-folders.json")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("smart-folders.json")
    }
}

/// Current smart-folder array as a JSON string. Defaults to an empty array when
/// nothing has been saved yet, so the route always returns valid JSON.
pub(crate) fn load_json() -> String {
    fs::read_to_string(smart_folders_path()).unwrap_or_else(|_| "[]".to_string())
}

/// Persist the smart-folder array (full replace), keeping one `.bak` of the
/// previous file and writing atomically via a temp file + rename.
pub(crate) fn save(body: &[u8]) -> io::Result<()> {
    let path = smart_folders_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(&path, &bak);
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, &path)
}
