//! F2 Scan snapshots + historical diff.
//!
//! A *snapshot* is a compact point-in-time capture of a scanned tree's directory
//! sizes, persisted as one JSON file per snapshot under
//! `%APPDATA%\FileTree\snapshots\<id>.json`:
//!
//! ```json
//! { "id", "createdAt", "path", "total", "fileCount", "dirs": { "<dir>": size } }
//! ```
//!
//! A small `manifest.json` in the same directory indexes every snapshot's meta so
//! the list endpoint never has to open (and parse the big `dirs` map of) each
//! file. Writes are atomic (temp + rename); the manifest additionally keeps a
//! `.bak`, mirroring the bookmarks store.
//!
//! The diff compares two snapshots' directory maps by path (case-insensitive,
//! Windows-style) and reports added / removed / changed folders (`b` minus `a`),
//! each sorted by the largest absolute byte change and capped.
//!
//! NOTE: this is a distinct store from the older `crate::diff` snapshots (which
//! persist `<id>.ndjson` + `index.json` in the same directory); the file names
//! never collide.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::PathBuf;

use crate::export::push_json_string;
use crate::io::now_ms;
use crate::json::{self, JsonValue};
use crate::model::{node_abs_path, ScanResult};

/// Cap on entries returned per diff bucket (added / removed / changed). A diff of
/// two large drives can be enormous; the UI only needs the biggest movers.
const DIFF_CAP: usize = 1000;

/// Lightweight description of a saved snapshot (also the manifest entry shape and
/// the `GET /api/snapshots` list element).
#[derive(Clone, Debug)]
pub(crate) struct SnapMeta {
    pub(crate) id: String,
    pub(crate) created_at: u64, // unix seconds
    pub(crate) path: String,
    pub(crate) total: u64,
    pub(crate) file_count: u64,
}

/// A loaded snapshot: its meta + the directory map keyed by the lowercased path
/// (so case-insensitive Windows paths line up across snapshots) with the
/// original-cased path kept for display.
pub(crate) struct SnapData {
    #[allow(dead_code)]
    pub(crate) meta: SnapMeta,
    pub(crate) dirs: HashMap<String, (String, u64)>,
}

// ── Paths ────────────────────────────────────────────────────

/// `%APPDATA%\FileTree\snapshots` (Windows) or `~/.config/filetree/snapshots`.
fn snapshots_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("FileTree")
            .join("snapshots")
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("filetree")
            .join("snapshots")
    }
}

fn manifest_path() -> PathBuf {
    snapshots_dir().join("manifest.json")
}

fn snapshot_file(id: &str) -> PathBuf {
    snapshots_dir().join(format!("{id}.json"))
}

/// Reject ids that aren't our own (guards the file routes against path traversal
/// via a crafted `?id=`). Our ids are `<secs>-<hex>`.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ── Save ─────────────────────────────────────────────────────

/// Persist `result` as a new snapshot (directory size map + meta), update the
/// manifest, and return the meta. The id is `<createdSecs>-<rootHash>` so
/// repeated saves of the same root never collide.
pub(crate) fn save_snapshot(result: &ScanResult) -> io::Result<SnapMeta> {
    let dir = snapshots_dir();
    fs::create_dir_all(&dir)?;

    let created_at = now_ms() / 1000;
    let id = format!(
        "{created_at}-{:08x}",
        fnv1a(result.root_path.as_bytes()) & 0xffff_ffff
    );
    // The root node aggregates the whole tree's size + recursive file count.
    let total = result.nodes.first().map(|n| n.size).unwrap_or(0);
    let file_count = result.nodes.first().map(|n| n.files).unwrap_or(0);

    let meta = SnapMeta {
        id: id.clone(),
        created_at,
        path: result.root_path.clone(),
        total,
        file_count,
    };

    // Body: meta fields + a compact directory->size map (directories only).
    let mut body = String::with_capacity(result.nodes.len().saturating_mul(24) + 256);
    body.push('{');
    push_meta_fields(&mut body, &meta);
    body.push_str(",\"dirs\":{");
    let nodes = &result.nodes;
    let mut first = true;
    for n in nodes {
        if !n.is_dir {
            continue;
        }
        let abs = node_abs_path(nodes, n.id);
        if abs.is_empty() {
            continue;
        }
        if !first {
            body.push(',');
        }
        first = false;
        push_json_string(&mut body, &abs);
        let _ = write!(body, ":{}", n.size);
    }
    body.push_str("}}");

    let target = snapshot_file(&id);
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, body.as_bytes())?;
    fs::rename(&tmp, &target)?;

    add_to_manifest(&meta)?;
    Ok(meta)
}

/// Write `"id":..,"createdAt":..,"path":..,"total":..,"fileCount":..` (no
/// surrounding braces) — the shared body of the per-file header, the manifest
/// entry, and the list element.
fn push_meta_fields(out: &mut String, m: &SnapMeta) {
    out.push_str("\"id\":");
    push_json_string(out, &m.id);
    let _ = write!(out, ",\"createdAt\":{},\"path\":", m.created_at);
    push_json_string(out, &m.path);
    let _ = write!(out, ",\"total\":{},\"fileCount\":{}", m.total, m.file_count);
}

fn push_meta_obj(out: &mut String, m: &SnapMeta) {
    out.push('{');
    push_meta_fields(out, m);
    out.push('}');
}

/// One snapshot meta serialized as a standalone JSON object — the
/// `POST /api/snapshots-save` response.
pub(crate) fn meta_to_json(m: &SnapMeta) -> String {
    let mut out = String::new();
    push_meta_obj(&mut out, m);
    out
}

// ── Manifest ─────────────────────────────────────────────────

fn read_manifest() -> Vec<SnapMeta> {
    let text = match fs::read_to_string(manifest_path()) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let Some(root) = json::parse(&text) else {
        return Vec::new();
    };
    let Some(arr) = root.get("snapshots").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter().filter_map(meta_from_json).collect()
}

fn meta_from_json(v: &JsonValue) -> Option<SnapMeta> {
    Some(SnapMeta {
        id: v.get("id")?.as_str()?.to_string(),
        created_at: v.get("createdAt").and_then(|x| x.as_u64()).unwrap_or(0),
        path: v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        total: v.get("total").and_then(|x| x.as_u64()).unwrap_or(0),
        file_count: v.get("fileCount").and_then(|x| x.as_u64()).unwrap_or(0),
    })
}

fn write_manifest(metas: &[SnapMeta]) -> io::Result<()> {
    let dir = snapshots_dir();
    fs::create_dir_all(&dir)?;
    let mut out = String::from("{\"snapshots\":[");
    for (i, m) in metas.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_meta_obj(&mut out, m);
    }
    out.push_str("]}");
    let path = manifest_path();
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, out.as_bytes())?;
    fs::rename(&tmp, &path)
}

fn add_to_manifest(meta: &SnapMeta) -> io::Result<()> {
    let mut metas = read_manifest();
    metas.retain(|m| m.id != meta.id);
    metas.push(meta.clone());
    metas.sort_by(|a, b| b.created_at.cmp(&a.created_at)); // newest first
    write_manifest(&metas)
}

/// The manifest as a JSON array for `GET /api/snapshots`
/// (`[{id,createdAt,path,total,fileCount}]`). Always valid JSON, even empty.
pub(crate) fn list_json() -> String {
    let metas = read_manifest();
    let mut out = String::from("[");
    for (i, m) in metas.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_meta_obj(&mut out, m);
    }
    out.push(']');
    out
}

/// Delete a snapshot by id (file + manifest entry). Returns whether the id was
/// valid and the manifest update succeeded.
pub(crate) fn delete_snapshot(id: &str) -> bool {
    if !is_safe_id(id) {
        return false;
    }
    let _ = fs::remove_file(snapshot_file(id)); // best-effort; manifest is source of truth
    let mut metas = read_manifest();
    metas.retain(|m| m.id != id);
    write_manifest(&metas).is_ok()
}

// ── Load + diff ──────────────────────────────────────────────

/// Load a saved snapshot's meta + directory map. `None` if the id is
/// unknown/invalid or the file is missing/corrupt.
pub(crate) fn load_snapshot(id: &str) -> Option<SnapData> {
    if !is_safe_id(id) {
        return None;
    }
    let text = fs::read_to_string(snapshot_file(id)).ok()?;
    let v = json::parse(&text)?;
    let meta = SnapMeta {
        id: v.get("id").and_then(|x| x.as_str()).unwrap_or(id).to_string(),
        created_at: v.get("createdAt").and_then(|x| x.as_u64()).unwrap_or(0),
        path: v.get("path").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        total: v.get("total").and_then(|x| x.as_u64()).unwrap_or(0),
        file_count: v.get("fileCount").and_then(|x| x.as_u64()).unwrap_or(0),
    };
    let mut dirs: HashMap<String, (String, u64)> = HashMap::new();
    if let Some(JsonValue::Object(entries)) = v.get("dirs") {
        dirs.reserve(entries.len());
        for (k, val) in entries {
            let size = val.as_u64().unwrap_or(0);
            dirs.insert(k.to_lowercase(), (k.clone(), size));
        }
    }
    Some(SnapData { meta, dirs })
}

/// Diff two loaded snapshots (`b` minus `a`) and emit the response JSON:
/// `{added:[{path,size}], removed:[{path,size}], changed:[{path,sizeA,sizeB,delta}]}`.
/// `changed` is sorted by `abs(delta)` desc; every bucket is capped at `DIFF_CAP`.
pub(crate) fn diff_json(a: &SnapData, b: &SnapData) -> String {
    let mut added: Vec<(&str, u64)> = Vec::new();
    let mut removed: Vec<(&str, u64)> = Vec::new();
    let mut changed: Vec<(&str, u64, u64, i64)> = Vec::new();

    for (key, (path_b, size_b)) in &b.dirs {
        match a.dirs.get(key) {
            Some((_, size_a)) => {
                if size_a != size_b {
                    let delta = *size_b as i64 - *size_a as i64;
                    changed.push((path_b.as_str(), *size_a, *size_b, delta));
                }
            }
            None => added.push((path_b.as_str(), *size_b)),
        }
    }
    for (key, (path_a, size_a)) in &a.dirs {
        if !b.dirs.contains_key(key) {
            removed.push((path_a.as_str(), *size_a));
        }
    }

    added.sort_by(|x, y| y.1.cmp(&x.1));
    removed.sort_by(|x, y| y.1.cmp(&x.1));
    changed.sort_by(|x, y| y.3.abs().cmp(&x.3.abs()));
    added.truncate(DIFF_CAP);
    removed.truncate(DIFF_CAP);
    changed.truncate(DIFF_CAP);

    let mut out = String::with_capacity(
        (added.len() + removed.len() + changed.len()) * 80 + 64,
    );
    out.push_str("{\"added\":[");
    for (i, (p, s)) in added.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        push_json_string(&mut out, p);
        let _ = write!(out, ",\"size\":{}}}", s);
    }
    out.push_str("],\"removed\":[");
    for (i, (p, s)) in removed.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        push_json_string(&mut out, p);
        let _ = write!(out, ",\"size\":{}}}", s);
    }
    out.push_str("],\"changed\":[");
    for (i, (p, sa, sb, d)) in changed.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        push_json_string(&mut out, p);
        let _ = write!(out, ",\"sizeA\":{},\"sizeB\":{},\"delta\":{}}}", sa, sb, d);
    }
    out.push_str("]}");
    out
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
