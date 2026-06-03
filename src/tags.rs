//! F4 Tags & color labels store.
//!
//! Multi-tag + colored labels on files/folders (beyond the single bookmark
//! star), persisted to `%APPDATA%\FileTree\tags.json` exactly like the bookmarks
//! store: the whole document is replaced on save (atomic temp-then-rename with a
//! `.bak` backup of the previous file). The on-disk JSON IS the API shape
//! verbatim (`{"items":[{"path","tags":[..],"color"?}]}`), so a GET just streams
//! the file back and a POST persists the posted body as-is — no parse round-trip,
//! mirroring how `/api/bookmarks` works.

use std::fs;
use std::io;
use std::path::PathBuf;

/// `%APPDATA%\FileTree\tags.json` (Windows) or `~/.config/filetree/tags.json`
/// elsewhere — mirrors `server::bookmarks_path`.
pub(crate) fn tags_path() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("tags.json")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("tags.json")
    }
}

/// Current tags document as a JSON string. Defaults to an empty
/// `{"items":[]}` when nothing has been saved yet, so the route always returns
/// valid JSON in the contract shape.
pub(crate) fn load_tags_json() -> String {
    fs::read_to_string(tags_path()).unwrap_or_else(|_| "{\"items\":[]}".to_string())
}

/// Persist the tags document (full replace), keeping one `.bak` of the previous
/// file and writing atomically via a temp file + rename — identical to
/// `server::save_bookmarks`.
pub(crate) fn save_tags(body: &[u8]) -> io::Result<()> {
    let path = tags_path();
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
