//! Verbose, append-only diagnostic log for the compression pipeline at
//! `%APPDATA%\FileTree\compress-debug.log`.
//!
//! This is the human-readable companion to the machine-readable CSV in
//! [`crate::compress_log`]. Where the CSV records one tidy row per terminal file
//! outcome, this log captures the full story of a job — detected tools and their
//! versions, the exact command line spawned for each file, the encoder's exit
//! code and a tail of its stderr, the keep/skip/error decision and its reason
//! code, recycle/tag results, and per-file + per-job timings — so any outcome
//! ("why did this file compress but that one didn't?") is explainable after the
//! fact.
//!
//! Mirrors the append-only patterns of [`crate::audit`] and
//! [`crate::compress_log`]: a process-wide `Mutex` serializes writers, the file
//! is opened `create(true).append(true)`, and every line is timestamped with the
//! shared [`crate::audit::now_iso8601`] clock. Unlike those stores it is
//! size-capped: when the file grows past [`MAX_BYTES`] it is rotated to a single
//! `.1` sidecar so it can never grow without bound during a long diagnosing
//! session.
//!
//! ## Verbosity toggle
//! Logging is gated by [`enabled`], which reads the `FILETREE_COMPRESS_DEBUG`
//! environment variable. It defaults to ON (the user is actively diagnosing);
//! set the variable to `0`/`false`/`off`/`no` to silence it.
//!
//! ## Guarantees
//! Best-effort, exactly like the audit/CSV logs: any failure (missing APPDATA,
//! I/O error, …) is swallowed and never blocks or fails the real compression.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Rotate the log once it grows past ~5 MB so a long diagnosing session can't
/// fill the disk. The previous contents move to a single `.1` sidecar.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Whether the verbose debug log is active. Reads `FILETREE_COMPRESS_DEBUG`;
/// defaults to ON. Recognized "off" values: `0`, `false`, `off`, `no` (any
/// case). Anything else (including unset) is ON.
pub(crate) fn enabled() -> bool {
    match std::env::var("FILETREE_COMPRESS_DEBUG") {
        Ok(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        Err(_) => true,
    }
}

/// Resolve `%APPDATA%\FileTree\compress-debug.log` (or the same non-Windows
/// fallback the other stores use).
pub(crate) fn log_path() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("compress-debug.log")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("compress-debug.log")
    }
}

/// Append one timestamped, possibly multi-line entry to the debug log. A no-op
/// when [`enabled`] is false. Best-effort: any error is silently ignored so the
/// real compression is never affected.
pub(crate) fn log(entry: &str) {
    if !enabled() {
        return;
    }
    let _ = append(&log_path(), entry);
}

/// Append a debug entry REGARDLESS of the verbosity toggle (still respecting the
/// rotation cap). Used for failing-file diagnostics, which are worth keeping even
/// when verbose logging is otherwise disabled. Best-effort.
pub(crate) fn log_force(entry: &str) {
    let _ = append(&log_path(), entry);
}

fn append(path: &Path, entry: &str) -> io::Result<()> {
    // Serialize concurrent writers (several jobs can run at once, each on its own
    // thread) so entries never interleave; recover a poisoned lock — it's bytes.
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    rotate_if_needed(path);

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let line = format!("{} {}\n", crate::audit::now_iso8601(), entry);
    file.write_all(line.as_bytes())
}

/// Move the current log to a single `.1` sidecar once it exceeds [`MAX_BYTES`],
/// so the active file restarts empty. Best-effort.
fn rotate_if_needed(path: &Path) {
    let too_big = fs::metadata(path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false);
    if !too_big {
        return;
    }
    let mut rotated = path.as_os_str().to_owned();
    rotated.push(".1");
    let rotated = PathBuf::from(rotated);
    let _ = fs::remove_file(&rotated);
    let _ = fs::rename(path, &rotated);
}
