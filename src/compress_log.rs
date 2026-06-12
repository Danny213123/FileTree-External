//! Append-only CSV log of every compressed file at
//! `%APPDATA%\FileTree\compress-log.csv`.
//!
//! Mirrors the append-only pattern in [`crate::audit`]: a process-wide `Mutex`
//! serializes writers (the compress worker runs on its own thread, and several
//! jobs can run at once) and the file is opened with
//! `OpenOptions::create(true).append(true)` so rows never interleave or
//! truncate prior history. A header row is written exactly once, when the file
//! is first created.
//!
//! One row is appended per *terminal* file outcome (success, no-gain skip, or
//! error) by [`crate::compress_job::run_job`]; the resume-skip branch is
//! deliberately NOT logged so re-running a job never produces duplicate rows.
//!
//! ## Columns
//! `ts, job_id, index, path, name, kind, preset, status, orig_bytes,
//!  new_bytes, saved_bytes, pct_saved, ratio, tool, codec_params, duration_ms,
//!  out_path, recycled, error`
//!
//! ## Guarantees
//! Logging is best-effort: any failure (missing APPDATA, I/O error, …) is
//! swallowed and never blocks or fails the real compression.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::export::push_json_string;

/// CSV header, also used to detect a freshly-created file. Column order MUST
/// match [`format_row`] and the JSON mapping in [`read_rows_json`].
const HEADER: &str = "ts,job_id,index,path,name,kind,preset,status,orig_bytes,new_bytes,saved_bytes,pct_saved,ratio,tool,codec_params,duration_ms,out_path,recycled,error\n";

/// One compressed-file record. All fields borrow so this is cheap to build at
/// the call site (see `run_job`'s outcome arms).
pub(crate) struct Row<'a> {
    pub job_id: &'a str,
    pub index: usize,
    pub path: &'a str,
    pub name: &'a str,
    pub kind: &'a str,
    pub preset: &'a str,
    /// `"success"` | `"skipped_no_gain"` | `"error"`.
    pub status: &'a str,
    pub orig_bytes: u64,
    pub new_bytes: u64,
    pub saved_bytes: u64,
    pub pct_saved: f64,
    pub ratio: f64,
    pub tool: &'a str,
    pub codec_params: &'a str,
    pub duration_ms: u64,
    pub out_path: &'a str,
    pub recycled: bool,
    pub error: &'a str,
}

/// Resolve `%APPDATA%\FileTree\compress-log.csv` (or the same non-Windows
/// fallback the other stores use).
pub(crate) fn log_path() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("compress-log.csv")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("compress-log.csv")
    }
}

/// Append one CSV row. Best-effort: any error is silently ignored so the real
/// compression is never affected.
pub(crate) fn append_row(row: &Row) {
    let path = log_path();
    let line = format_row(row);
    let _ = append_line(&path, &line);
}

fn append_line(path: &Path, line: &str) -> io::Result<()> {
    // Serialize concurrent writers so rows never interleave; recover a poisoned
    // lock — the data is just bytes.
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // A header is written once, when the file does not yet exist (or is empty).
    let needs_header = match fs::metadata(path) {
        Ok(m) => m.len() == 0,
        Err(_) => true,
    };
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    if needs_header {
        file.write_all(HEADER.as_bytes())?;
    }
    file.write_all(line.as_bytes())
}

fn format_row(r: &Row) -> String {
    let mut s = String::with_capacity(256);
    push_field(&mut s, &crate::audit::now_iso8601());
    push_field(&mut s, r.job_id);
    push_field(&mut s, &r.index.to_string());
    push_field(&mut s, r.path);
    push_field(&mut s, r.name);
    push_field(&mut s, r.kind);
    push_field(&mut s, r.preset);
    push_field(&mut s, r.status);
    push_field(&mut s, &r.orig_bytes.to_string());
    push_field(&mut s, &r.new_bytes.to_string());
    push_field(&mut s, &r.saved_bytes.to_string());
    push_field(&mut s, &format!("{:.2}", r.pct_saved));
    push_field(&mut s, &format!("{:.4}", r.ratio));
    push_field(&mut s, r.tool);
    push_field(&mut s, r.codec_params);
    push_field(&mut s, &r.duration_ms.to_string());
    push_field(&mut s, r.out_path);
    push_field(&mut s, if r.recycled { "true" } else { "false" });
    // Last column: no trailing comma, then the row terminator.
    s.push_str(&csv_escape(r.error));
    s.push('\n');
    s
}

/// Push one escaped field followed by a comma separator.
fn push_field(s: &mut String, field: &str) {
    s.push_str(&csv_escape(field));
    s.push(',');
}

/// RFC-4180 CSV escaping: wrap in double quotes and double any embedded quote
/// when the field contains a quote, comma, CR or LF.
fn csv_escape(field: &str) -> String {
    if field.contains(['"', ',', '\n', '\r']) {
        let mut out = String::with_capacity(field.len() + 2);
        out.push('"');
        for c in field.chars() {
            if c == '"' {
                out.push('"');
            }
            out.push(c);
        }
        out.push('"');
        out
    } else {
        field.to_string()
    }
}

/// Read the log and return the last `limit` data rows (most recent last) as a
/// JSON array of objects with camelCase keys for the History tab. Returns `[]`
/// when the file does not exist yet or has only a header. Best-effort: a parse
/// failure yields whatever parsed cleanly.
pub(crate) fn read_rows_json(limit: usize) -> String {
    let path = log_path();
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return "[]".to_string(),
    };
    let mut records = parse_csv(&text);
    if records.is_empty() {
        return "[]".to_string();
    }
    // Drop the header row.
    records.remove(0);
    let start = records.len().saturating_sub(limit.max(0));
    let slice = &records[start..];

    let mut s = String::with_capacity(slice.len() * 160 + 2);
    s.push('[');
    for (i, rec) in slice.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        push_record_json(&mut s, rec);
    }
    s.push(']');
    s
}

/// Field accessor that tolerates short/long records.
fn col<'a>(rec: &'a [String], i: usize) -> &'a str {
    rec.get(i).map(|s| s.as_str()).unwrap_or("")
}

fn push_record_json(s: &mut String, rec: &[String]) {
    s.push_str("{\"ts\":");
    push_json_string(s, col(rec, 0));
    s.push_str(",\"jobId\":");
    push_json_string(s, col(rec, 1));
    s.push_str(",\"index\":");
    s.push_str(&num(col(rec, 2)));
    s.push_str(",\"path\":");
    push_json_string(s, col(rec, 3));
    s.push_str(",\"name\":");
    push_json_string(s, col(rec, 4));
    s.push_str(",\"kind\":");
    push_json_string(s, col(rec, 5));
    s.push_str(",\"preset\":");
    push_json_string(s, col(rec, 6));
    s.push_str(",\"status\":");
    push_json_string(s, col(rec, 7));
    s.push_str(",\"origBytes\":");
    s.push_str(&num(col(rec, 8)));
    s.push_str(",\"newBytes\":");
    s.push_str(&num(col(rec, 9)));
    s.push_str(",\"savedBytes\":");
    s.push_str(&num(col(rec, 10)));
    s.push_str(",\"pctSaved\":");
    s.push_str(&fnum(col(rec, 11)));
    s.push_str(",\"ratio\":");
    s.push_str(&fnum(col(rec, 12)));
    s.push_str(",\"tool\":");
    push_json_string(s, col(rec, 13));
    s.push_str(",\"codecParams\":");
    push_json_string(s, col(rec, 14));
    s.push_str(",\"durationMs\":");
    s.push_str(&num(col(rec, 15)));
    s.push_str(",\"outPath\":");
    push_json_string(s, col(rec, 16));
    s.push_str(",\"recycled\":");
    s.push_str(if col(rec, 17) == "true" { "true" } else { "false" });
    s.push_str(",\"error\":");
    push_json_string(s, col(rec, 18));
    s.push('}');
}

/// Emit a JSON integer from a CSV cell, defaulting to `0` on a parse failure so
/// the body is always valid JSON.
fn num(cell: &str) -> String {
    cell.trim().parse::<u64>().map(|n| n.to_string()).unwrap_or_else(|_| "0".to_string())
}

/// Emit a JSON number (float) from a CSV cell, defaulting to `0`.
fn fnum(cell: &str) -> String {
    match cell.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => format!("{n}"),
        _ => "0".to_string(),
    }
}

/// Minimal RFC-4180 CSV parser: handles quoted fields with embedded commas,
/// quotes (`""`) and newlines. Returns a vec of records, each a vec of fields.
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    let mut started = false;

    while let Some(c) = chars.next() {
        started = true;
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    record.push(std::mem::take(&mut field));
                }
                '\r' => {
                    // Swallow a following \n (CRLF) — handled by the \n arm.
                }
                '\n' => {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                }
                _ => field.push(c),
            }
        }
    }
    // Flush a trailing record with no final newline.
    if started && (!field.is_empty() || !record.is_empty()) {
        record.push(field);
        records.push(record);
    }
    records
}
