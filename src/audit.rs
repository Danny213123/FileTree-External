//! Append-only JSONL operation audit log at `%APPDATA%/FileTree/operations.log`.
//!
//! Every user-data mutation performed by the HTTP server (`server.rs`) and the
//! duplicates engine (`dupes.rs`) records one line here. The native drag/shell
//! addon (a separate crate) mirrors this exact format with its own minimal
//! writer (`electron/native/src/audit.rs`) so both write to the same file.
//!
//! ## Schema (one JSON object per line)
//! ```json
//! {
//!   "ts":          "2026-06-02T02:12:34.567Z",  // ISO-8601 UTC, ms precision
//!   "by":          "server" | "native" | "cli", // which component wrote it
//!   "op":          "delete" | "move" | "rename" | "copy" | "mkdir"
//!                  | "recycle" | "permanent-delete" | "external-move",
//!   "disposition": "recycle" | "permanent" | "",  // for deletes/replaces
//!   "conflict":    "" | "replace" | "keep-both" | "skip" | "detect",
//!   "result":      "ok" | "error",
//!   "error":       string | null,               // present when result=="error"
//!   "src":         ["<full source path>", ...],  // original path(s)
//!   "dst":         "<full destination path>" | null
//! }
//! ```
//!
//! ## Undo (Phase 6) support
//! Entries capture enough to reverse an op: moves/renames record the exact
//! `src` -> `dst` (undo moves it back); deletes record the original full path
//! and a `disposition` of `recycle` (undo can attempt a Recycle Bin restore) or
//! `permanent` (unrecoverable).
//!
//! ## Guarantees
//! Logging is cheap and failure-tolerant: a logging error is swallowed and NEVER
//! blocks or fails the real file operation. Concurrent writers are serialized so
//! lines can't interleave.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::export::push_json_string;

/// A single audit entry. Construct with a struct literal + `..Default::default()`
/// and pass to [`record`]; all fields borrow, so this is cheap to build.
#[derive(Default)]
pub(crate) struct Entry<'a> {
    /// Operation kind (see module schema docs).
    pub op: &'a str,
    /// `recycle` / `permanent` for deletes & replaces; `""` otherwise.
    pub disposition: &'a str,
    /// Collision resolution mode, when applicable; `""` otherwise.
    pub conflict: &'a str,
    /// Original source path(s).
    pub src: &'a [String],
    /// Destination path, or `""` when the op has none (delete/mkdir/recycle).
    pub dst: &'a str,
    /// `Some(message)` when the op failed; `None` on success.
    pub error: Option<&'a str>,
    /// Component that produced the entry (`"server"` / `"cli"`).
    pub by: &'a str,
}

/// Append one entry to the audit log. Best-effort: any failure (missing APPDATA,
/// I/O error, …) is silently ignored so the real operation is never affected.
pub(crate) fn record(entry: Entry) {
    let Some(path) = log_path() else {
        return;
    };
    let line = format_line(&entry);
    let _ = append_line(&path, &line);
}

/// Resolve `%APPDATA%/FileTree/operations.log`.
fn log_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("FileTree").join("operations.log"))
}

fn format_line(e: &Entry) -> String {
    let mut s = String::with_capacity(256);
    s.push_str("{\"ts\":");
    push_json_string(&mut s, &now_iso8601());
    s.push_str(",\"by\":");
    push_json_string(&mut s, e.by);
    s.push_str(",\"op\":");
    push_json_string(&mut s, e.op);
    s.push_str(",\"disposition\":");
    push_json_string(&mut s, e.disposition);
    s.push_str(",\"conflict\":");
    push_json_string(&mut s, e.conflict);
    s.push_str(",\"result\":");
    push_json_string(&mut s, if e.error.is_some() { "error" } else { "ok" });
    s.push_str(",\"error\":");
    match e.error {
        Some(msg) => push_json_string(&mut s, msg),
        None => s.push_str("null"),
    }
    s.push_str(",\"src\":[");
    for (i, p) in e.src.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        push_json_string(&mut s, p);
    }
    s.push_str("],\"dst\":");
    if e.dst.is_empty() {
        s.push_str("null");
    } else {
        push_json_string(&mut s, e.dst);
    }
    s.push('}');
    s.push('\n');
    s
}

fn append_line(path: &Path, line: &str) -> io::Result<()> {
    // Serialize concurrent writers (server runs many worker threads) so lines
    // never interleave. A poisoned lock is recovered — the data is just bytes.
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

/// Current time as an ISO-8601 UTC string with millisecond precision, computed
/// from the Unix epoch with no external date crate.
fn now_iso8601() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    let days = (secs / 86_400) as i64;
    let secs_of_day = (secs % 86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's days-from-civil inverse: turn a day count since the Unix
/// epoch (1970-01-01) into a proleptic-Gregorian (year, month, day) in UTC.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}
