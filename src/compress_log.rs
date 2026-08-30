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
//!  out_path, recycled, error, reason, exit_code, tool_version, command,
//!  stderr_excerpt`
//!
//! The last five columns were added for the diagnostics work; they are appended
//! (never reordered) so older logs and any external readers keying off the
//! original columns keep working. A pre-existing file simply gains the new
//! columns from the next row written (the parser tolerates short rows).
//!
//! ## Size cap
//! Append-only history would otherwise grow without bound. After each append the
//! file is compacted in place once it crosses [`MAX_BYTES`] (~8 MB): the header
//! plus the most recent [`KEEP_ROWS`] rows are rewritten atomically via a temp
//! file + rename. Because compaction drops the file well below the cap it fires
//! only periodically, never on the hot path of a normal append.
//!
//! ## Guarantees
//! Logging is best-effort: any failure (missing APPDATA, I/O error, …) is
//! swallowed and never blocks or fails the real compression.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::export::push_json_string;

/// CSV header, also used to detect a freshly-created file. Column order MUST
/// match [`format_row`] and the JSON mapping in [`read_rows_json`].
const HEADER: &str = "ts,job_id,index,path,name,kind,preset,status,orig_bytes,new_bytes,saved_bytes,pct_saved,ratio,tool,codec_params,duration_ms,out_path,recycled,error,reason,exit_code,tool_version,command,stderr_excerpt\n";

/// Compact the CSV once it grows past ~8 MB so a long-running install's history
/// can't grow without bound. Compaction keeps the header plus the most recent
/// [`KEEP_ROWS`] rows (the History tab only ever shows a recent window anyway).
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Rows retained on compaction (most recent).
const KEEP_ROWS: usize = 5000;

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
    /// Precise outcome code (see `compress_job::Reason`): `success`,
    /// `skipped_no_gain`, `error_tool_missing`, `error_encoder`, …
    pub reason: &'a str,
    /// Encoder process exit code, when one was produced.
    pub exit_code: Option<i32>,
    /// Detected version string of the tool used (or `built-in` for zip).
    pub tool_version: &'a str,
    /// Full command line spawned (empty when no tool ran).
    pub command: &'a str,
    /// Bounded tail of the encoder's stderr (empty on success/no tool).
    pub stderr_excerpt: &'a str,
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

/// Durable fingerprint of an unchanged source that completed a real encode but
/// produced no savings. This is intentionally separate from the display log:
/// History is compacted to 5,000 rows, while skip decisions must survive large
/// multi-day batches without dropping older entries.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct NoGainKey {
    path: String,
    source_bytes: u64,
    source_modified_ms: u64,
}

static NO_GAIN_INDEX: Mutex<Option<(PathBuf, HashSet<NoGainKey>)>> = Mutex::new(None);
// Keep the legacy profile column so existing index files remain readable. New
// records use `all-profiles`: once an unchanged source has proven unable to
// shrink, later encoder or preset changes must not spend hours proving it again.
const NO_GAIN_HEADER: &str = "path,source_bytes,source_modified_ms,profile\n";

fn no_gain_path() -> PathBuf {
    log_path().with_file_name("compress-no-gain-v1.csv")
}

fn normalized_source_path(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    #[cfg(windows)]
    {
        normalized.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

fn no_gain_key(path: &str, source_bytes: u64, source_modified_ms: u64) -> Option<NoGainKey> {
    if source_bytes == 0 || source_modified_ms == 0 {
        return None;
    }
    Some(NoGainKey {
        path: normalized_source_path(path),
        source_bytes,
        source_modified_ms,
    })
}

fn load_no_gain_index(path: &Path) -> HashSet<NoGainKey> {
    let mut index: HashSet<NoGainKey> = fs::read_to_string(path)
        .ok()
        .map(|text| parse_csv(&text))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|record| {
            if col(&record, 0) == "path" {
                return None;
            }
            no_gain_key(
                col(&record, 0),
                col(&record, 1).parse().ok()?,
                col(&record, 2).parse().ok()?,
            )
        })
        .collect();

    // v1.14.1 introduced the durable index, so older verified no-gain outcomes
    // may exist only in the compact History CSV. Import only real encoder runs
    // whose source still has the logged size and was not modified after that
    // outcome. Pre-skips and stale/replaced sources are deliberately ignored.
    let history_path = path.with_file_name("compress-log.csv");
    if let Ok(history) = fs::read_to_string(history_path) {
        for record in parse_csv(&history) {
            if col(&record, 0) == "ts"
                || col(&record, 7) != "skipped_no_gain"
                || col(&record, 19) != "skipped_no_gain"
                || col(&record, 22).starts_with("pre-skip")
            {
                continue;
            }
            let source_path = col(&record, 3);
            let Ok(source_bytes) = col(&record, 8).parse::<u64>() else {
                continue;
            };
            let Ok(metadata) = fs::metadata(source_path) else {
                continue;
            };
            if metadata.len() != source_bytes {
                continue;
            }
            let source_modified_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            if source_modified_ms == 0
                || crate::audit::unix_ms_to_iso8601(source_modified_ms).as_str() > col(&record, 0)
            {
                continue;
            }
            if let Some(key) = no_gain_key(source_path, source_bytes, source_modified_ms) {
                index.insert(key);
            }
        }
    }
    index
}

fn ensure_no_gain_index<'a>(
    slot: &'a mut Option<(PathBuf, HashSet<NoGainKey>)>,
    path: &Path,
) -> &'a mut HashSet<NoGainKey> {
    if slot
        .as_ref()
        .map(|(loaded_path, _)| loaded_path != path)
        .unwrap_or(true)
    {
        *slot = Some((path.to_path_buf(), load_no_gain_index(path)));
    }
    &mut slot.as_mut().expect("no-gain cache initialized").1
}

/// True only when a prior real encode with the exact same source fingerprint
/// produced no savings. Encoder and preset changes deliberately do not retry an
/// unchanged source: the user can modify/replace the source to invalidate it.
pub(crate) fn was_unchanged_no_gain(
    path: &str,
    source_bytes: u64,
    source_modified_ms: u64,
) -> bool {
    let Some(key) = no_gain_key(path, source_bytes, source_modified_ms) else {
        return false;
    };
    let cache_path = no_gain_path();
    let mut slot = NO_GAIN_INDEX
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    ensure_no_gain_index(&mut slot, &cache_path).contains(&key)
}

/// Remember a verified no-gain result. Duplicate fingerprints stay in memory
/// and are not appended again, keeping the durable index compact across retries.
pub(crate) fn remember_unchanged_no_gain(path: &str, source_bytes: u64, source_modified_ms: u64) {
    let Some(key) = no_gain_key(path, source_bytes, source_modified_ms) else {
        return;
    };
    let cache_path = no_gain_path();
    let mut slot = NO_GAIN_INDEX
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !ensure_no_gain_index(&mut slot, &cache_path).insert(key.clone()) {
        return;
    }
    if let Some(parent) = cache_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let needs_header = fs::metadata(&cache_path)
        .map(|metadata| metadata.len() == 0)
        .unwrap_or(true);
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&cache_path)
    else {
        return;
    };
    if needs_header && file.write_all(NO_GAIN_HEADER.as_bytes()).is_err() {
        return;
    }
    let line = format!(
        "{},{},{},{}\n",
        csv_escape(&key.path),
        key.source_bytes,
        key.source_modified_ms,
        "all-profiles",
    );
    let _ = file.write_all(line.as_bytes());
}

#[cfg(test)]
pub(crate) fn reset_no_gain_index_for_tests() {
    *NO_GAIN_INDEX
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
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
    {
        let mut file = OpenOptions::new().create(true).append(true).open(path)?;
        if needs_header {
            file.write_all(HEADER.as_bytes())?;
        }
        file.write_all(line.as_bytes())?;
    }
    // Best-effort compaction once the file crosses the cap. Because compaction
    // shrinks the file well below the cap it only fires periodically, never on
    // the hot path of a typical append.
    compact_if_needed(path);
    Ok(())
}

/// When the CSV exceeds [`MAX_BYTES`], rewrite it keeping the header plus the
/// last [`KEEP_ROWS`] data rows. Atomic via a temp file + rename. Best-effort:
/// any error leaves the existing (oversized) file untouched. Runs under the
/// caller's `LOCK`, so no other writer can interleave.
fn compact_if_needed(path: &Path) {
    let too_big = fs::metadata(path)
        .map(|m| m.len() >= MAX_BYTES)
        .unwrap_or(false);
    if !too_big {
        return;
    }
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return,
    };
    let mut records = parse_csv(&text);
    if records.is_empty() {
        return;
    }
    // Drop a leading header row if present (re-emitted from the constant below).
    if records
        .first()
        .map(|r| r.first().map(|c| c == "ts").unwrap_or(false))
        .unwrap_or(false)
    {
        records.remove(0);
    }
    let start = records.len().saturating_sub(KEEP_ROWS);
    let kept = &records[start..];

    let mut out = String::with_capacity(HEADER.len() + kept.len() * 160);
    out.push_str(HEADER);
    for rec in kept {
        for (i, f) in rec.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&csv_escape(f));
        }
        out.push('\n');
    }

    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    if fs::write(&tmp, out.as_bytes()).is_ok() {
        let _ = fs::rename(&tmp, path);
    } else {
        let _ = fs::remove_file(&tmp);
    }
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
    push_field(&mut s, r.error);
    push_field(&mut s, r.reason);
    push_field(
        &mut s,
        &r.exit_code.map(|c| c.to_string()).unwrap_or_default(),
    );
    push_field(&mut s, r.tool_version);
    push_field(&mut s, r.command);
    // Last column: no trailing comma, then the row terminator.
    s.push_str(&csv_escape(r.stderr_excerpt));
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
    s.push_str(if col(rec, 17) == "true" {
        "true"
    } else {
        "false"
    });
    s.push_str(",\"error\":");
    push_json_string(s, col(rec, 18));
    // Diagnostics columns (appended; absent in older rows → sensible defaults).
    // `reason` falls back to the legacy `status` so pre-upgrade rows still map
    // to a badge in the UI.
    let reason = col(rec, 19);
    s.push_str(",\"reason\":");
    push_json_string(
        s,
        if reason.is_empty() {
            col(rec, 7)
        } else {
            reason
        },
    );
    s.push_str(",\"exitCode\":");
    s.push_str(&inum(col(rec, 20)));
    s.push_str(",\"toolVersion\":");
    push_json_string(s, col(rec, 21));
    s.push_str(",\"command\":");
    push_json_string(s, col(rec, 22));
    s.push_str(",\"stderrExcerpt\":");
    push_json_string(s, col(rec, 23));
    s.push('}');
}

/// Emit a JSON integer from a CSV cell, defaulting to `0` on a parse failure so
/// the body is always valid JSON.
fn num(cell: &str) -> String {
    cell.trim()
        .parse::<u64>()
        .map(|n| n.to_string())
        .unwrap_or_else(|_| "0".to_string())
}

/// Emit a JSON integer (possibly negative) or `null` from a CSV cell. Used for
/// the optional `exit_code` column, which is blank when no process ran.
fn inum(cell: &str) -> String {
    match cell.trim().parse::<i64>() {
        Ok(n) => n.to_string(),
        Err(_) => "null".to_string(),
    }
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
