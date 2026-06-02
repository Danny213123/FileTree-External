//! Scan snapshots + growth diff (roadmap item #5).
//!
//! A *snapshot* is a point-in-time capture of a scan's per-path sizes/counts,
//! persisted under `%APPDATA%/FileTree/snapshots/`. Each snapshot is stored as
//! NDJSON (mirroring the scan-stream wire shape, but with a compact per-path
//! object so the file stays small): the first line is a meta object, every
//! following line is one entry `{"p":path,"s":size,"a":alloc,"f":files,
//! "d":folders,"dir":bool}`. A single `index.json` manifest enumerates them.
//!
//! The diff compares two entry maps (snapshot↔snapshot, or snapshot↔current
//! live scan of the same root) by path and reports added / removed / grown /
//! shrunk deltas, sorted by the largest absolute size change. Lookups are O(1)
//! via a `HashMap` keyed on the lowercased path.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::PathBuf;

use crate::export::push_json_string;
use crate::io::now_ms;
use crate::json;
use crate::model::{node_abs_path, ScanResult};

const SNAPSHOT_VERSION: u32 = 1;
/// Cap on the number of diff rows returned to the UI. The full per-path diff of
/// two large drives can be millions of rows; the UI only needs the biggest
/// changes ("what grew"), so we sort by |delta| and keep the top N.
const DIFF_ROW_CAP: usize = 5000;

/// Lightweight description of a saved snapshot (also the manifest entry shape).
#[derive(Clone, Debug)]
pub(crate) struct SnapMeta {
    pub(crate) id: String,
    pub(crate) root_path: String,
    pub(crate) scanned_at: u64,
    pub(crate) saved_at: u64,
    pub(crate) label: String,
    pub(crate) node_count: u64,
    pub(crate) total_size: u64,
}

/// One per-path record used for diffing. `path` keeps the original casing for
/// display; the map key is the lowercased path so case-insensitive Windows
/// paths still line up across snapshots.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) is_dir: bool,
}

pub(crate) type EntryMap = HashMap<String, Entry>;

// ── Paths ────────────────────────────────────────────────────

/// `%APPDATA%/FileTree/snapshots` (Windows) or `~/.config/filetree/snapshots`.
pub(crate) fn snapshots_dir() -> PathBuf {
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
    snapshots_dir().join("index.json")
}

fn snapshot_file(id: &str) -> PathBuf {
    snapshots_dir().join(format!("{id}.ndjson"))
}

/// Reject ids that aren't our own (defends the file routes from path traversal
/// via a crafted `?id=`). Our ids are `<ms>-<hex>`.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

// ── Save ─────────────────────────────────────────────────────

/// Persist `result` as a new snapshot, update the manifest, and return its
/// meta. The id is `<savedMs>-<rootHash>` so repeated saves never collide.
pub(crate) fn save_snapshot(result: &ScanResult, label: &str) -> io::Result<SnapMeta> {
    let dir = snapshots_dir();
    fs::create_dir_all(&dir)?;

    let saved_at = now_ms();
    let id = format!("{saved_at}-{:08x}", fnv1a(result.root_path.as_bytes()) & 0xffff_ffff);
    let total_size = result.nodes.first().map(|n| n.size).unwrap_or(0);

    let meta = SnapMeta {
        id: id.clone(),
        root_path: result.root_path.clone(),
        scanned_at: result.scanned_at_ms,
        saved_at,
        label: label.to_string(),
        node_count: result.nodes.len() as u64,
        total_size,
    };

    // Write the NDJSON body (meta line + one compact line per node).
    let mut body = Vec::with_capacity(result.nodes.len().saturating_mul(64) + 256);
    {
        let mut line = String::new();
        push_meta_line(&mut line, &meta);
        body.extend_from_slice(line.as_bytes());
        body.push(b'\n');
    }
    let nodes = &result.nodes;
    for node in nodes {
        // Files have their path interned away (see `node_abs_path`); reconstruct
        // the absolute path so a snapshot still records every file, not just dirs.
        let abs = node_abs_path(nodes, node.id);
        if abs.is_empty() {
            continue;
        }
        let mut line = String::with_capacity(abs.len() + 48);
        line.push_str("{\"p\":");
        push_json_string(&mut line, &abs);
        let _ = write!(
            line,
            ",\"s\":{},\"a\":{},\"f\":{},\"d\":{},\"dir\":{}}}",
            node.size,
            node.allocated,
            node.files,
            node.folders,
            if node.is_dir { "true" } else { "false" }
        );
        body.extend_from_slice(line.as_bytes());
        body.push(b'\n');
    }

    let target = snapshot_file(&id);
    let tmp = target.with_extension("ndjson.tmp");
    fs::write(&tmp, &body)?;
    fs::rename(&tmp, &target)?;

    add_to_manifest(&meta)?;
    Ok(meta)
}

fn push_meta_line(out: &mut String, meta: &SnapMeta) {
    out.push_str("{\"version\":");
    out.push_str(&SNAPSHOT_VERSION.to_string());
    out.push_str(",\"id\":");
    push_json_string(out, &meta.id);
    out.push_str(",\"rootPath\":");
    push_json_string(out, &meta.root_path);
    let _ = write!(
        out,
        ",\"scannedAt\":{},\"savedAt\":{},\"nodeCount\":{},\"totalSize\":{},\"label\":",
        meta.scanned_at, meta.saved_at, meta.node_count, meta.total_size
    );
    push_json_string(out, &meta.label);
    out.push('}');
}

// ── Manifest ─────────────────────────────────────────────────

fn read_manifest() -> Vec<SnapMeta> {
    let text = match fs::read_to_string(manifest_path()) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let Some(root) = json::parse(&text) else { return Vec::new() };
    let Some(arr) = root.get("snapshots").and_then(|v| v.as_array()) else { return Vec::new() };
    arr.iter().filter_map(meta_from_json).collect()
}

fn meta_from_json(v: &json::JsonValue) -> Option<SnapMeta> {
    Some(SnapMeta {
        id: v.get("id")?.as_str()?.to_string(),
        root_path: v.get("rootPath").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        scanned_at: v.get("scannedAt").and_then(|x| x.as_u64()).unwrap_or(0),
        saved_at: v.get("savedAt").and_then(|x| x.as_u64()).unwrap_or(0),
        label: v.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        node_count: v.get("nodeCount").and_then(|x| x.as_u64()).unwrap_or(0),
        total_size: v.get("totalSize").and_then(|x| x.as_u64()).unwrap_or(0),
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
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, out.as_bytes())?;
    fs::rename(&tmp, &path)
}

fn push_meta_obj(out: &mut String, m: &SnapMeta) {
    out.push_str("{\"id\":");
    push_json_string(out, &m.id);
    out.push_str(",\"rootPath\":");
    push_json_string(out, &m.root_path);
    let _ = write!(
        out,
        ",\"scannedAt\":{},\"savedAt\":{},\"nodeCount\":{},\"totalSize\":{},\"label\":",
        m.scanned_at, m.saved_at, m.node_count, m.total_size
    );
    push_json_string(out, &m.label);
    out.push('}');
}

fn add_to_manifest(meta: &SnapMeta) -> io::Result<()> {
    let mut metas = read_manifest();
    metas.retain(|m| m.id != meta.id);
    metas.push(meta.clone());
    // Newest first.
    metas.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    write_manifest(&metas)
}

/// Manifest as a JSON string for `GET /api/snapshots` (always valid, even when
/// no snapshots exist yet).
pub(crate) fn list_snapshots_json() -> String {
    let metas = read_manifest();
    let mut out = String::from("{\"snapshots\":[");
    for (i, m) in metas.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_meta_obj(&mut out, m);
    }
    out.push_str("]}");
    out
}

pub(crate) fn delete_snapshot(id: &str) -> io::Result<()> {
    if !is_safe_id(id) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid snapshot id"));
    }
    let _ = fs::remove_file(snapshot_file(id)); // best-effort; manifest is source of truth
    let mut metas = read_manifest();
    metas.retain(|m| m.id != id);
    write_manifest(&metas)
}

// ── Load ─────────────────────────────────────────────────────

/// Load a saved snapshot's meta + per-path entry map. Returns `None` if the id
/// is unknown/invalid or the file is missing/corrupt.
pub(crate) fn load_snapshot(id: &str) -> Option<(SnapMeta, EntryMap)> {
    if !is_safe_id(id) {
        return None;
    }
    let text = fs::read_to_string(snapshot_file(id)).ok()?;
    let mut lines = text.lines();
    let meta_line = lines.next()?;
    let meta_json = json::parse(meta_line)?;
    let meta = SnapMeta {
        id: meta_json.get("id").and_then(|x| x.as_str()).unwrap_or(id).to_string(),
        root_path: meta_json.get("rootPath").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        scanned_at: meta_json.get("scannedAt").and_then(|x| x.as_u64()).unwrap_or(0),
        saved_at: meta_json.get("savedAt").and_then(|x| x.as_u64()).unwrap_or(0),
        label: meta_json.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        node_count: meta_json.get("nodeCount").and_then(|x| x.as_u64()).unwrap_or(0),
        total_size: meta_json.get("totalSize").and_then(|x| x.as_u64()).unwrap_or(0),
    };

    let mut map: EntryMap = HashMap::with_capacity(meta.node_count as usize + 16);
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Some(v) = json::parse(line) else { continue };
        let Some(path) = v.get("p").and_then(|x| x.as_str()) else { continue };
        let entry = Entry {
            path: path.to_string(),
            size: v.get("s").and_then(|x| x.as_u64()).unwrap_or(0),
            is_dir: v.get("dir").and_then(|x| x.as_bool()).unwrap_or(false),
        };
        map.insert(path.to_lowercase(), entry);
    }
    Some((meta, map))
}

/// Build an entry map + synthetic meta for a *live* scan result so it can be
/// diffed against a saved snapshot without first persisting it.
pub(crate) fn scan_entry_map(result: &ScanResult) -> EntryMap {
    let mut map: EntryMap = HashMap::with_capacity(result.nodes.len() + 16);
    let nodes = &result.nodes;
    for n in nodes {
        // Reconstruct interned-away file paths so the live map mirrors a saved
        // snapshot (which records absolute paths for every entry).
        let abs = node_abs_path(nodes, n.id);
        if abs.is_empty() {
            continue;
        }
        map.insert(
            abs.to_lowercase(),
            Entry { path: abs, size: n.size, is_dir: n.is_dir },
        );
    }
    map
}

pub(crate) fn current_meta(result: &ScanResult) -> SnapMeta {
    SnapMeta {
        id: "current".to_string(),
        root_path: result.root_path.clone(),
        scanned_at: result.scanned_at_ms,
        saved_at: 0,
        label: "Current scan".to_string(),
        node_count: result.nodes.len() as u64,
        total_size: result.nodes.first().map(|n| n.size).unwrap_or(0),
    }
}

// ── Diff ─────────────────────────────────────────────────────

struct DiffRow {
    path: String,
    status: &'static str, // "added" | "removed" | "grown" | "shrunk"
    old_size: u64,
    new_size: u64,
    delta: i64,
    is_dir: bool,
}

/// Compare two entry maps (`a` = older/base, `b` = newer/target) and emit the
/// full diff response JSON consumed by the Compare UI.
pub(crate) fn diff_response_json(a_meta: &SnapMeta, b_meta: &SnapMeta, a: &EntryMap, b: &EntryMap) -> String {
    let mut rows: Vec<DiffRow> = Vec::new();
    let (mut added, mut removed, mut grown, mut shrunk) = (0u64, 0u64, 0u64, 0u64);
    let mut net_delta: i64 = 0;

    for (key, be) in b {
        match a.get(key) {
            Some(ae) => {
                if ae.size != be.size {
                    let delta = be.size as i64 - ae.size as i64;
                    net_delta += delta;
                    let status = if be.size > ae.size {
                        grown += 1;
                        "grown"
                    } else {
                        shrunk += 1;
                        "shrunk"
                    };
                    rows.push(DiffRow {
                        path: be.path.clone(),
                        status,
                        old_size: ae.size,
                        new_size: be.size,
                        delta,
                        is_dir: be.is_dir,
                    });
                }
            }
            None => {
                added += 1;
                net_delta += be.size as i64;
                rows.push(DiffRow {
                    path: be.path.clone(),
                    status: "added",
                    old_size: 0,
                    new_size: be.size,
                    delta: be.size as i64,
                    is_dir: be.is_dir,
                });
            }
        }
    }
    for (key, ae) in a {
        if !b.contains_key(key) {
            removed += 1;
            net_delta -= ae.size as i64;
            rows.push(DiffRow {
                path: ae.path.clone(),
                status: "removed",
                old_size: ae.size,
                new_size: 0,
                delta: -(ae.size as i64),
                is_dir: ae.is_dir,
            });
        }
    }

    // Largest absolute change first — that's the "what grew/shrank most" view.
    rows.sort_by(|x, y| y.delta.abs().cmp(&x.delta.abs()));
    let total_rows = rows.len();
    rows.truncate(DIFF_ROW_CAP);

    let mut out = String::with_capacity(rows.len() * 96 + 512);
    out.push_str("{\"a\":");
    push_meta_obj(&mut out, a_meta);
    out.push_str(",\"b\":");
    push_meta_obj(&mut out, b_meta);
    let _ = write!(
        out,
        ",\"summary\":{{\"added\":{added},\"removed\":{removed},\"grown\":{grown},\"shrunk\":{shrunk},\"netDelta\":{net_delta},\"oldTotal\":{},\"newTotal\":{},\"rowCount\":{total_rows},\"capped\":{}}}",
        a_meta.total_size,
        b_meta.total_size,
        if total_rows > DIFF_ROW_CAP { "true" } else { "false" }
    );
    out.push_str(",\"rows\":[");
    for (i, r) in rows.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"path\":");
        push_json_string(&mut out, &r.path);
        out.push_str(",\"name\":");
        push_json_string(&mut out, base_name(&r.path));
        let _ = write!(
            out,
            ",\"status\":\"{}\",\"oldSize\":{},\"newSize\":{},\"delta\":{},\"dir\":{}}}",
            r.status,
            r.old_size,
            r.new_size,
            r.delta,
            if r.is_dir { "true" } else { "false" }
        );
    }
    out.push_str("]}");
    out
}

fn base_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rfind(['\\', '/']) {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, size: u64, is_dir: bool) -> Entry {
        Entry { path: path.to_string(), size, is_dir }
    }

    #[test]
    fn diff_classifies_changes() {
        let mut a: EntryMap = HashMap::new();
        a.insert("c:\\x\\a.txt".into(), entry("C:\\x\\a.txt", 100, false));
        a.insert("c:\\x\\b.txt".into(), entry("C:\\x\\b.txt", 200, false));
        a.insert("c:\\x\\gone.txt".into(), entry("C:\\x\\gone.txt", 50, false));

        let mut b: EntryMap = HashMap::new();
        b.insert("c:\\x\\a.txt".into(), entry("C:\\x\\a.txt", 100, false)); // unchanged
        b.insert("c:\\x\\b.txt".into(), entry("C:\\x\\b.txt", 500, false)); // grown +300
        b.insert("c:\\x\\new.txt".into(), entry("C:\\x\\new.txt", 80, false)); // added

        let am = SnapMeta { id: "a".into(), root_path: "C:\\x".into(), scanned_at: 0, saved_at: 0, label: "".into(), node_count: 3, total_size: 350 };
        let bm = SnapMeta { id: "b".into(), root_path: "C:\\x".into(), scanned_at: 0, saved_at: 0, label: "".into(), node_count: 3, total_size: 680 };
        let json = diff_response_json(&am, &bm, &a, &b);
        assert!(json.contains("\"grown\":1"));
        assert!(json.contains("\"added\":1"));
        assert!(json.contains("\"removed\":1"));
        // Largest change (b.txt +300) should sort first.
        let first_row = json.split("\"rows\":[").nth(1).unwrap();
        assert!(first_row.starts_with("{\"path\":\"C:\\\\x\\\\b.txt\""));
    }

    #[test]
    fn base_name_handles_separators() {
        assert_eq!(base_name("C:\\a\\b\\c.txt"), "c.txt");
        assert_eq!(base_name("C:\\a\\b\\"), "b");
        assert_eq!(base_name("solo"), "solo");
    }
}
