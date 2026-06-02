//! Minimal mirror of the main crate's audit writer (`src/audit.rs`).
//!
//! The native addon is a separate crate and can't import the main binary's
//! module, so this duplicates just enough to append to the SAME log file —
//! `%APPDATA%/FileTree/operations.log` — in the SAME JSONL schema, tagged
//! `"by":"native"`. Keep the line format byte-for-byte compatible with
//! `src/audit.rs` so a single reader can parse entries from both writers.
//!
//! Best-effort + failure-tolerant: any error is swallowed and never affects the
//! real file operation. Concurrent writers are serialized so lines don't
//! interleave.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// One audit entry. Mirror of `crate::audit::Entry` minus the `by` field, which
/// the native writer always sets to `"native"`.
pub struct Entry<'a> {
    pub op: &'a str,
    pub disposition: &'a str,
    pub conflict: &'a str,
    pub src: &'a [String],
    pub dst: &'a str,
    pub error: Option<&'a str>,
}

impl<'a> Default for Entry<'a> {
    fn default() -> Self {
        Entry {
            op: "",
            disposition: "",
            conflict: "",
            src: &[],
            dst: "",
            error: None,
        }
    }
}

/// Append one entry to the shared audit log. Never panics, never blocks the
/// caller's real work; failures are silently ignored.
pub fn record(entry: Entry) {
    let Some(path) = log_path() else {
        return;
    };
    let line = format_line(&entry);
    let _ = append_line(&path, &line);
}

fn log_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("FileTree").join("operations.log"))
}

fn format_line(e: &Entry) -> String {
    let mut s = String::with_capacity(256);
    s.push_str("{\"ts\":");
    push_json_string(&mut s, &now_iso8601());
    s.push_str(",\"by\":");
    push_json_string(&mut s, "native");
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
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

/// JSON string escaping identical to the main crate's `export::push_json_string`.
fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for ch in value.chars() {
        match ch {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            ch if ch < ' ' => output.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => output.push(ch),
        }
    }
    output.push('"');
}

/// ISO-8601 UTC timestamp with millisecond precision (no external date crate).
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

/// Howard Hinnant's days-from-civil inverse (proleptic Gregorian, UTC).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}
