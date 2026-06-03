//! F1 Disk cleanup / reclaim-space scan.
//!
//! Buckets reclaimable space into categories — temp, browser caches, build
//! artifacts, the Recycle Bin, old/large downloads, and confirmed duplicates —
//! each with a true total/count plus a capped (`ITEM_CAP`) item sample. The
//! actual multi-select Recycle-Bin delete lives in the server (`/api/recycle-items`,
//! reusing `crate::recycle`); this module only measures.
//!
//! Every filesystem walk here is access-denied tolerant: an unreadable directory
//! or file is skipped, never fatal (a cleanup scan must finish even when it
//! crosses protected system folders).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use crate::dupes::{build_candidates_from_nodes, hash_candidate_groups, DupeFilter2, HashInput};
use crate::export::push_json_string;
use crate::io::now_ms;
use crate::model::{HashCacheEntry, ScanResult};

/// Per-category cap on the item sample. The true `total`/`count` are always
/// reported; only the listed `items` are bounded so the response stays small.
const ITEM_CAP: usize = 500;
/// Downloads bucket thresholds: a file qualifies if larger than this …
const DOWNLOADS_BIG_BYTES: u64 = 100 * 1024 * 1024; // 100 MB
/// … OR older than this (≈180 days).
const DOWNLOADS_OLD_SECS: u64 = 180 * 24 * 60 * 60;

/// Directory names treated as reclaimable build output.
const ARTIFACT_NAMES: &[&str] = &["node_modules", "target", "dist", "build", ".next", "bin", "obj"];

struct Item {
    path: String,
    size: u64,
    modified: u64,
}

#[derive(Default)]
struct Bucket {
    total: u64,
    count: u64,
    items: Vec<Item>,
}

impl Bucket {
    fn add(&mut self, path: String, size: u64, modified: u64) {
        self.total = self.total.saturating_add(size);
        self.count = self.count.saturating_add(1);
        if self.items.len() < ITEM_CAP {
            self.items.push(Item { path, size, modified });
        }
    }
}

fn secs_from_modified(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `(size, modified_secs)` for a regular file, or `None` for anything else /
/// unreadable.
fn file_meta(path: &Path) -> Option<(u64, u64)> {
    let md = fs::symlink_metadata(path).ok()?;
    if !md.is_file() {
        return None;
    }
    Some((md.len(), secs_from_modified(&md)))
}

/// Recursively add every regular file under `dir` to `bucket`. Symlinks/reparse
/// points are not followed (their `file_type` is neither dir nor file here), so
/// the walk cannot loop. Unreadable directories are skipped.
fn walk_into(dir: &Path, bucket: &mut Bucket) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            walk_into(&path, bucket);
        } else if ft.is_file() {
            if let Some((size, modified)) = file_meta(&path) {
                bucket.add(path.to_string_lossy().into_owned(), size, modified);
            }
        }
    }
}

/// `(total_bytes, file_count)` for the whole subtree rooted at `dir`. Resilient
/// to access errors.
fn dir_size(dir: &Path) -> (u64, u64) {
    let mut total = 0u64;
    let mut count = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            let (t, c) = dir_size(&entry.path());
            total = total.saturating_add(t);
            count = count.saturating_add(c);
        } else if ft.is_file() {
            if let Ok(md) = entry.metadata() {
                total = total.saturating_add(md.len());
                count = count.saturating_add(1);
            }
        }
    }
    (total, count)
}

fn dir_modified(path: &Path) -> u64 {
    fs::metadata(path).ok().map(|m| secs_from_modified(&m)).unwrap_or(0)
}

/// Canonicalize-and-dedupe a set of candidate directories so e.g. `%TEMP%` and
/// `%TMP%` (usually the same folder) aren't double-counted.
fn dedup_dirs(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        let key = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
        if seen.insert(key) {
            out.push(p);
        }
    }
    out
}

// ── Category sources ─────────────────────────────────────────

fn temp_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for var in ["TEMP", "TMP"] {
        if let Some(v) = std::env::var_os(var) {
            let p = PathBuf::from(v);
            if p.is_dir() {
                dirs.push(p);
            }
        }
    }
    let windir = std::env::var_os("SystemRoot")
        .or_else(|| std::env::var_os("windir"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    let win_temp = windir.join("Temp");
    if win_temp.is_dir() {
        dirs.push(win_temp);
    }
    dedup_dirs(dirs)
}

fn browser_cache_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return dirs;
    };

    // Chromium-family browsers: <vendor>\User Data\<profile>\{Cache,Code Cache,GPUCache,...}
    let chromium_bases = [
        local.join("Google\\Chrome\\User Data"),
        local.join("Microsoft\\Edge\\User Data"),
        local.join("BraveSoftware\\Brave-Browser\\User Data"),
        local.join("Chromium\\User Data"),
    ];
    for base in chromium_bases {
        let Ok(entries) = fs::read_dir(&base) else {
            continue;
        };
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let profile = e.path();
            for sub in ["Cache", "Code Cache", "GPUCache", "Service Worker\\CacheStorage"] {
                let c = profile.join(sub);
                if c.is_dir() {
                    dirs.push(c);
                }
            }
        }
    }

    // Firefox: <local>\Mozilla\Firefox\Profiles\<profile>\cache2
    let ff = local.join("Mozilla\\Firefox\\Profiles");
    if let Ok(entries) = fs::read_dir(&ff) {
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let c = e.path().join("cache2");
            if c.is_dir() {
                dirs.push(c);
            }
        }
    }
    dirs
}

/// Derive build-artifact directories from an already-walked scan: each dir node
/// whose name matches `ARTIFACT_NAMES` and which is NOT nested inside another
/// artifact dir (so a `node_modules` within a `node_modules` is counted once).
fn build_artifacts_from_scan(result: &ScanResult, bucket: &mut Bucket) {
    let nodes = &result.nodes;
    for n in nodes {
        if !n.is_dir || !ARTIFACT_NAMES.contains(&n.name.to_ascii_lowercase().as_str()) {
            continue;
        }
        // Skip if any ancestor directory is itself an artifact.
        let mut anc = n.parent;
        let mut nested = false;
        while let Some(pid) = anc {
            let Some(p) = nodes.get(pid) else { break };
            if p.is_dir && ARTIFACT_NAMES.contains(&p.name.to_ascii_lowercase().as_str()) {
                nested = true;
                break;
            }
            anc = p.parent;
        }
        if nested {
            continue;
        }
        let path = crate::model::node_abs_path(nodes, n.id);
        if path.is_empty() {
            continue;
        }
        bucket.add(path, n.size, n.modified_ms / 1000);
    }
}

/// Fallback when no scan is available: walk `root`, and for each directory whose
/// name matches `ARTIFACT_NAMES` record its recursive size WITHOUT descending
/// into it (so nested artifacts collapse into the outermost one).
fn build_artifacts_walk(dir: &Path, bucket: &mut Bucket) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
        if ARTIFACT_NAMES.contains(&name.as_str()) {
            let (size, _count) = dir_size(&path);
            bucket.add(path.to_string_lossy().into_owned(), size, dir_modified(&path));
        } else {
            build_artifacts_walk(&path, bucket);
        }
    }
}

#[cfg(windows)]
fn recycle_bin_size() -> (u64, u64) {
    #[repr(C)]
    struct ShQueryRBInfo {
        cb_size: u32,
        i64_size: i64,
        i64_num_items: i64,
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHQueryRecycleBinW(psz_root_path: *const u16, p_info: *mut ShQueryRBInfo) -> i32;
    }
    let mut info = ShQueryRBInfo {
        cb_size: std::mem::size_of::<ShQueryRBInfo>() as u32,
        i64_size: 0,
        i64_num_items: 0,
    };
    // A null root path queries the Recycle Bin across all drives.
    let ret = unsafe { SHQueryRecycleBinW(std::ptr::null(), &mut info) };
    if ret == 0 {
        (info.i64_size.max(0) as u64, info.i64_num_items.max(0) as u64)
    } else {
        (0, 0)
    }
}

#[cfg(not(windows))]
fn recycle_bin_size() -> (u64, u64) {
    (0, 0)
}

fn downloads_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(|p| PathBuf::from(p).join("Downloads"))
        .filter(|p| p.is_dir())
}

/// Recursively collect Downloads files that are large (>100 MB) OR old (~180+
/// days). Resilient to access errors.
fn downloads_old(dir: &Path, now_secs: u64, bucket: &mut Bucket) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        if ft.is_dir() {
            downloads_old(&path, now_secs, bucket);
        } else if ft.is_file() {
            if let Some((size, modified)) = file_meta(&path) {
                let big = size > DOWNLOADS_BIG_BYTES;
                let old = modified != 0 && now_secs.saturating_sub(modified) > DOWNLOADS_OLD_SECS;
                if big || old {
                    bucket.add(path.to_string_lossy().into_owned(), size, modified);
                }
            }
        }
    }
}

/// Reclaimable-duplicate summary under the scanned root, reusing the shared
/// content-hash pipeline (`crate::dupes`). The redundant copies (every member of
/// a duplicate group except one) are the reclaimable bytes; they are listed
/// (capped) and summed.
fn duplicates_bucket(
    result: &ScanResult,
    hash_cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    hash_cache_path: &Path,
    threads: usize,
    bucket: &mut Bucket,
) {
    let filter = DupeFilter2 {
        min_size: 1,
        max_size: None,
        extensions: Vec::new(),
    };
    let files = build_candidates_from_nodes(&result.nodes, &filter);
    if files.len() < 2 {
        return;
    }
    let inputs: Vec<HashInput> = files
        .iter()
        .map(|f| HashInput {
            path: f.path.clone(),
            size: f.size,
            mtime: f.modified,
        })
        .collect();
    let (groups, _errors) = hash_candidate_groups(
        &inputs,
        false,
        hash_cache,
        Some(hash_cache_path),
        None,
        None,
        threads,
    );
    for (_hash, idxs) in &groups {
        if idxs.len() < 2 {
            continue;
        }
        // Keep one copy; every other member is reclaimable.
        for &k in idxs.iter().skip(1) {
            let f = &files[k];
            bucket.add(f.path.to_string_lossy().into_owned(), f.size, f.modified);
        }
    }
}

/// True when `path` lives inside one of the well-known cleanup locations this
/// module reports (temp dirs, browser caches, the Downloads folder). The
/// `/api/recycle-items` route allows recycling these *in addition* to anything
/// under a scanned root, because cleanup targets (e.g. `%TEMP%`, a browser cache)
/// legitimately sit outside the user's scanned tree — strict scan-root gating
/// alone would make the whole cleanup feature unable to delete anything it found.
/// Both sides are canonicalized first so `..` / symlink tricks can't dodge it.
pub(crate) fn is_within_cleanup_root(path: &Path) -> bool {
    let Ok(canon) = fs::canonicalize(path) else {
        return false;
    };
    let mut roots: Vec<PathBuf> = Vec::new();
    roots.extend(temp_dirs());
    roots.extend(browser_cache_dirs());
    if let Some(dl) = downloads_dir() {
        roots.push(dl);
    }
    roots.iter().any(|r| {
        fs::canonicalize(r)
            .map(|rc| canon.starts_with(&rc))
            .unwrap_or(false)
    })
}

// ── Top-level serializer ─────────────────────────────────────

/// Build the `GET /api/cleanup-scan` response JSON for `root`. `scan` (when
/// available) is reused for the build-artifact and duplicate categories so no
/// extra full walk of `root` is needed; the other categories measure well-known
/// system locations directly.
pub(crate) fn cleanup_scan_json(
    root: &Path,
    scan: Option<&ScanResult>,
    hash_cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    hash_cache_path: &Path,
    threads: usize,
) -> String {
    let now_secs = now_ms() / 1000;

    let mut temp = Bucket::default();
    for d in temp_dirs() {
        walk_into(&d, &mut temp);
    }

    let mut browser = Bucket::default();
    for d in browser_cache_dirs() {
        walk_into(&d, &mut browser);
    }

    let mut artifacts = Bucket::default();
    match scan {
        Some(r) => build_artifacts_from_scan(r, &mut artifacts),
        None => build_artifacts_walk(root, &mut artifacts),
    }

    let (rb_size, rb_count) = recycle_bin_size();
    let recycle = Bucket {
        total: rb_size,
        count: rb_count,
        items: Vec::new(),
    };

    let mut downloads = Bucket::default();
    if let Some(dl) = downloads_dir() {
        downloads_old(&dl, now_secs, &mut downloads);
    }

    let mut dupes = Bucket::default();
    if let Some(r) = scan {
        duplicates_bucket(r, hash_cache, hash_cache_path, threads, &mut dupes);
    }

    let categories: [(&str, &str, &str, &Bucket); 6] = [
        (
            "temp",
            "Temporary files",
            "Windows %TEMP% / %TMP% and C:\\Windows\\Temp",
            &temp,
        ),
        (
            "browser-cache",
            "Browser caches",
            "Chrome, Edge, Brave, Chromium and Firefox cache folders",
            &browser,
        ),
        (
            "build-artifacts",
            "Build artifacts",
            "node_modules, target, dist, build, .next, bin and obj under the scanned folder",
            &artifacts,
        ),
        (
            "recycle-bin",
            "Recycle Bin",
            "Items currently in the Windows Recycle Bin (all drives)",
            &recycle,
        ),
        (
            "downloads-old",
            "Old or large downloads",
            "Files in your Downloads folder larger than 100 MB or older than ~180 days",
            &downloads,
        ),
        (
            "duplicates",
            "Duplicate files",
            "Reclaimable space from duplicate file copies under the scanned folder",
            &dupes,
        ),
    ];

    let mut out = String::from("{\"categories\":[");
    for (i, (id, label, description, b)) in categories.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"id\":");
        push_json_string(&mut out, id);
        out.push_str(",\"label\":");
        push_json_string(&mut out, label);
        out.push_str(",\"description\":");
        push_json_string(&mut out, description);
        let _ = write!(out, ",\"total\":{},\"count\":{},\"items\":[", b.total, b.count);
        for (j, it) in b.items.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str("{\"path\":");
            push_json_string(&mut out, &it.path);
            let _ = write!(out, ",\"size\":{},\"modified\":{}}}", it.size, it.modified);
        }
        out.push_str("]}");
    }
    out.push_str("]}");
    out
}
