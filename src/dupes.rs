use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::export::push_json_string;
use crate::model::{node_abs_path, DupesProgress, HashCacheEntry, NodeRecord};

/// Upper bound on resident `(path)->hash` cache entries. A long session can
/// otherwise grow the map without limit; surplus entries are evicted (a miss
/// just re-hashes). Durable copies live in the on-disk cache regardless.
pub(crate) const MAX_HASH_CACHE_ENTRIES: usize = 500_000;

/// Monotonic source for `HashCacheEntry::seq`. One per process (the hash cache is
/// a single per-`AppState` map), so a global counter gives every insert/refresh a
/// strictly increasing stamp that eviction uses to drop oldest-first.
static HASH_CACHE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Mint the next monotonic cache sequence number.
pub(crate) fn next_hash_cache_seq() -> u64 {
    HASH_CACHE_SEQ.fetch_add(1, Ordering::Relaxed)
}

// ── Core types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScanMode {
    Exact,
    Filename,
    Audio,
}

#[derive(Debug, Clone)]
pub(crate) struct DupeFileV2 {
    pub(crate) path: PathBuf,
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) modified: u64,
    pub(crate) is_ref: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct DupeGroupV2 {
    pub(crate) files: Vec<DupeFileV2>, // files[0] is the reference
    pub(crate) score: u8,              // 100 for exact; 0-100 for fuzzy
    pub(crate) waste: u64,             // size * (count - 1)
}

// ── FNV-1a file hash ────────────────────────────────────────────────────────

const SAMPLE_BYTES: usize = 256 * 1024;

fn fnv1a_update(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn fnv1a_update_u64(hash: &mut u64, value: u64) {
    fnv1a_update(hash, &value.to_le_bytes());
}

pub(crate) fn fnv1a_file(path: &Path) -> io::Result<u64> {
    let mut file = File::open(path)?;
    let mut buffer = [0u8; 1024 * 1024];
    let mut hash = 0xcbf29ce484222325u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        fnv1a_update(&mut hash, &buffer[..read]);
    }
    Ok(hash)
}

fn fnv1a_file_sample(path: &Path, size: u64) -> io::Result<u64> {
    let mut file = File::open(path)?;
    let mut buffer = [0u8; SAMPLE_BYTES];
    let mut hash = 0xcbf29ce484222325u64;
    fnv1a_update_u64(&mut hash, size);

    if size <= (SAMPLE_BYTES as u64).saturating_mul(2) {
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            fnv1a_update(&mut hash, &buffer[..read]);
        }
        return Ok(hash);
    }

    let read = file.read(&mut buffer)?;
    fnv1a_update(&mut hash, &buffer[..read]);

    file.seek(SeekFrom::End(-(SAMPLE_BYTES as i64)))?;
    let read = file.read(&mut buffer)?;
    fnv1a_update(&mut hash, &buffer[..read]);

    Ok(hash)
}

// ── Candidate-list hash engine (POST /api/dupes-hash) ───────────────────────
//
// The dedicated Duplicates page aggregates candidate file metadata on the
// client (from already-scanned tabs + caches) and posts only the size-collision
// candidates here, so this engine NEVER walks the filesystem. It groups by size,
// uses a persistent `(path,size,mtime)->hash` cache, hashes uncached candidates
// in parallel (sample fingerprint first to skip lone files, then a full FNV
// hash), and optionally does a byte-wise confirm so confirmed groups are truly
// identical (eliminates the astronomically rare 64-bit hash collision).

/// One candidate file as provided by the client.
#[derive(Debug, Clone)]
pub(crate) struct HashInput {
    pub(crate) path: PathBuf,
    pub(crate) size: u64,
    pub(crate) mtime: u64,
}

/// Read up to `buf.len()` bytes, looping past short reads / EINTR so a single
/// call yields a full buffer (or the remaining tail at EOF).
fn read_full(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// True when `a` and `b` are byte-for-byte identical. Assumes equal size is the
/// caller's expectation but re-checks it defensively.
fn files_identical(a: &Path, b: &Path) -> io::Result<bool> {
    let mut fa = File::open(a)?;
    let mut fb = File::open(b)?;
    let mut ba = vec![0u8; 64 * 1024];
    let mut bb = vec![0u8; 64 * 1024];
    loop {
        let na = read_full(&mut fa, &mut ba)?;
        let nb = read_full(&mut fb, &mut bb)?;
        if na != nb {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
        if ba[..na] != bb[..nb] {
            return Ok(false);
        }
    }
}

/// Partition a set of same-size, same-hash candidate indices into byte-identical
/// equivalence classes. Virtually always returns a single class, but guards
/// against hash collisions when the caller asked for byte confirmation.
fn byte_confirm_partition(indices: &[usize], files: &[HashInput], errors: &Mutex<Vec<String>>) -> Vec<Vec<usize>> {
    let mut classes: Vec<Vec<usize>> = Vec::new();
    'outer: for &idx in indices {
        for class in classes.iter_mut() {
            match files_identical(&files[class[0]].path, &files[idx].path) {
                Ok(true) => {
                    class.push(idx);
                    continue 'outer;
                }
                Ok(false) => {}
                Err(e) => {
                    errors
                        .lock()
                        .expect("hash errors lock")
                        .push(format!("{}: {}", files[idx].path.display(), e));
                    continue 'outer;
                }
            }
        }
        classes.push(vec![idx]);
    }
    classes
}

/// Run `work` items across up to `threads` worker threads, calling `f(index)`
/// for each item index. Cooperative cancellation via `cancel`. Uses scoped
/// threads so `f` can borrow surrounding state without `Arc`.
fn parallel_for<F>(count: usize, threads: usize, cancel: Option<&Arc<AtomicBool>>, f: F)
where
    F: Fn(usize) + Sync,
{
    if count == 0 {
        return;
    }
    let workers = threads.clamp(1, 64).min(count);
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
                    break;
                }
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= count {
                    break;
                }
                f(i);
            });
        }
    });
}

/// The single parallel duplicate-detection pipeline shared by every endpoint:
/// size-grouping -> head/tail sample fingerprint -> full FNV hash only for the
/// sample-colliding groups, reusing the persistent `(path,size,mtime)->hash`
/// cache. Returns one `(full_hash, indices_into_files)` entry per duplicate
/// group plus any per-file errors. When `cache_path` is set, newly-computed
/// hashes are appended to the on-disk cache incrementally (survives restarts).
pub(crate) fn hash_candidate_groups(
    files: &[HashInput],
    confirm_bytes: bool,
    cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    cache_path: Option<&Path>,
    progress: Option<&Arc<DupesProgress>>,
    cancel: Option<&Arc<AtomicBool>>,
    threads: usize,
) -> (Vec<(u64, Vec<usize>)>, Vec<String>) {
    // 1. Bucket by size — only equal-size files can be byte-identical.
    let mut by_size: HashMap<u64, Vec<usize>> = HashMap::new();
    for (idx, f) in files.iter().enumerate() {
        by_size.entry(f.size).or_default().push(idx);
    }
    let buckets: Vec<Vec<usize>> = by_size.into_values().filter(|v| v.len() > 1).collect();

    // 2. Seed known hashes from the persistent cache (one lock, no I/O held).
    let mut full_hash: Vec<Option<u64>> = vec![None; files.len()];
    {
        let guard = cache.lock().expect("hash_cache lock");
        for bucket in &buckets {
            for &i in bucket {
                if let Some(entry) = guard.get(&files[i].path) {
                    if entry.size == files[i].size && entry.mtime == files[i].mtime {
                        full_hash[i] = Some(entry.hash);
                    }
                }
            }
        }
    }

    let errors: Mutex<Vec<String>> = Mutex::new(Vec::new());

    // 3. Sample-fingerprint phase: cheap pre-filter for uncached candidates so a
    //    lone file (unique by size+sample) never triggers a full read.
    let uncached: Vec<usize> = buckets
        .iter()
        .flatten()
        .copied()
        .filter(|&i| full_hash[i].is_none())
        .collect();
    // Lock-free per-file sample store: `sample_fp[i]` holds the fingerprint and
    // `sample_done[i]` marks it computed. A real FNV-1a sample can be ANY u64
    // (a reserved sentinel could collide with a genuine hash), so a separate
    // "done" flag distinguishes "not computed" from a real value instead of a
    // magic hash. Each index is written by exactly one worker, and `parallel_for`
    // (scoped threads) joins every worker before these are read in step 4, so the
    // join supplies the happens-before edge and Relaxed ordering is sufficient.
    let sample_fp: Vec<AtomicU64> = (0..files.len()).map(|_| AtomicU64::new(0)).collect();
    let sample_done: Vec<AtomicBool> = (0..files.len()).map(|_| AtomicBool::new(false)).collect();
    parallel_for(uncached.len(), threads, cancel, |k| {
        let i = uncached[k];
        match fnv1a_file_sample(&files[i].path, files[i].size) {
            Ok(fp) => {
                sample_fp[i].store(fp, Ordering::Relaxed);
                sample_done[i].store(true, Ordering::Relaxed);
            }
            Err(e) => errors
                .lock()
                .expect("hash errors lock")
                .push(format!("{}: {}", files[i].path.display(), e)),
        }
    });
    if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
        return (Vec::new(), Vec::new());
    }

    // 4. Decide which uncached files still need a full hash: any uncached file
    //    that shares a sample fingerprint with another uncached file in its
    //    bucket, OR sits in a bucket that already has cached (full-hash) files.
    let mut need_full: Vec<usize> = Vec::new();
    for bucket in &buckets {
        let cached_present = bucket.iter().any(|&i| full_hash[i].is_some());
        let mut by_sample: HashMap<u64, Vec<usize>> = HashMap::new();
        for &i in bucket {
            if full_hash[i].is_some() {
                continue;
            }
            if sample_done[i].load(Ordering::Relaxed) {
                let fp = sample_fp[i].load(Ordering::Relaxed);
                by_sample.entry(fp).or_default().push(i);
            }
        }
        for (_, members) in by_sample {
            if members.len() > 1 || cached_present {
                need_full.extend(members);
            }
        }
    }

    if let Some(p) = progress {
        p.files_hashing.store(need_full.len() as u64, Ordering::Relaxed);
        p.files_hashed.store(0, Ordering::Relaxed);
    }

    // 5. Full-hash phase (parallel). Collect (index, hash) then merge.
    let computed: Mutex<Vec<(usize, u64)>> = Mutex::new(Vec::new());
    parallel_for(need_full.len(), threads, cancel, |k| {
        let i = need_full[k];
        match fnv1a_file(&files[i].path) {
            Ok(h) => computed.lock().expect("computed lock").push((i, h)),
            Err(e) => errors
                .lock()
                .expect("hash errors lock")
                .push(format!("{}: {}", files[i].path.display(), e)),
        }
        if let Some(p) = progress {
            p.files_hashed.fetch_add(1, Ordering::Relaxed);
        }
    });
    if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
        return (Vec::new(), Vec::new());
    }

    let computed = computed.into_inner().expect("computed lock");
    if !computed.is_empty() {
        let mut new_entries: Vec<(PathBuf, HashCacheEntry)> = Vec::with_capacity(computed.len());
        // Update the in-memory cache (insert + bounded eviction) under the lock,
        // collecting the new rows to persist. The lock is dropped at the end of
        // this block — BEFORE any disk I/O — so a hashing thread elsewhere never
        // waits on this thread's file write to read/seed/insert into the cache.
        {
            let mut guard = cache.lock().expect("hash_cache lock");
            for &(i, h) in &computed {
                full_hash[i] = Some(h);
                let entry = HashCacheEntry {
                    size: files[i].size,
                    mtime: files[i].mtime,
                    hash: h,
                    seq: next_hash_cache_seq(),
                };
                guard.insert(files[i].path.clone(), entry);
                new_entries.push((files[i].path.clone(), entry));
            }
            // Bound the resident cache so a long session can't grow it without
            // limit. Evicting an entry only costs a future re-hash; the durable
            // copy is appended to disk just below, so nothing persistent is lost.
            //
            // Evict OLDEST-FIRST by insertion/refresh `seq` (deterministic), rather
            // than the previous arbitrary `HashMap::keys().take()` order. `seq`s are
            // unique (minted via `fetch_add`), so the `surplus`-th smallest seq is a
            // clean threshold: drop every entry below it. Only the cheap `u64` seqs
            // are collected here (no per-path clones over the whole map).
            if guard.len() > MAX_HASH_CACHE_ENTRIES {
                let surplus = guard.len() - MAX_HASH_CACHE_ENTRIES;
                let mut seqs: Vec<u64> = guard.values().map(|e| e.seq).collect();
                seqs.select_nth_unstable(surplus);
                let threshold = seqs[surplus];
                guard.retain(|_, e| e.seq >= threshold);
            }
        }
        // Incremental persistence, now performed AFTER releasing the cache lock so
        // disk I/O never blocks concurrent hashers. Appends only the new rows (not
        // the whole map); the on-disk format tolerates these trailing rows (see
        // `load_hash_cache`), and a stale duplicate row is overridden on load by
        // the later one for the same path. `new_entries` is this call's own buffer,
        // so dropping the lock first cannot corrupt it; a rare interleave with
        // another appender only yields a malformed line that `load_hash_cache`
        // skips (that path is simply re-hashed later).
        if let Some(path) = cache_path {
            let _ = append_hash_cache(path, &new_entries);
        }
    }

    // 6. Group: within each size bucket, cluster by full hash, then optionally
    //    byte-confirm each cluster before emitting it as a duplicate group.
    //    Each emitted group carries its full hash so callers that surface a
    //    content hash (legacy `/api/dupes*`) don't need a second cache lookup.
    let mut groups: Vec<(u64, Vec<usize>)> = Vec::new();
    for bucket in &buckets {
        let mut by_full: HashMap<u64, Vec<usize>> = HashMap::new();
        for &i in bucket {
            if let Some(h) = full_hash[i] {
                by_full.entry(h).or_default().push(i);
            }
        }
        for (hash, members) in by_full {
            if members.len() < 2 {
                continue;
            }
            if confirm_bytes {
                for class in byte_confirm_partition(&members, files, &errors) {
                    if class.len() >= 2 {
                        groups.push((hash, class));
                    }
                }
            } else {
                groups.push((hash, members));
            }
        }
    }

    (groups, errors.into_inner().expect("hash errors lock"))
}

/// Adapt the unified pipeline to the legacy pairwise-match shape consumed by
/// `matches_to_groups` (used by `/api/dupes-v2` exact mode). Emits every pair
/// inside each content-identical group with a perfect score; ignore-list
/// filtering and reference selection then happen in `matches_to_groups`.
pub(crate) fn exact_matches_via_hash_cache(
    files: &[DupeFileV2],
    cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    cache_path: Option<&Path>,
    progress: Option<&Arc<DupesProgress>>,
    cancel: Option<&Arc<AtomicBool>>,
    threads: usize,
) -> Vec<(usize, usize, u8)> {
    let inputs: Vec<HashInput> = files
        .iter()
        .map(|f| HashInput { path: f.path.clone(), size: f.size, mtime: f.modified })
        .collect();
    let (groups, _errors) =
        hash_candidate_groups(&inputs, false, cache, cache_path, progress, cancel, threads);
    let mut matches = Vec::new();
    for (_hash, indices) in &groups {
        for i in 0..indices.len() {
            for j in (i + 1)..indices.len() {
                matches.push((indices[i], indices[j], 100u8));
            }
        }
    }
    matches
}

/// Append newly-computed hash rows to the on-disk cache (one JSON array per
/// line: `["path",size,mtime,hash]`). `load_hash_cache` parses these trailing
/// rows even when they follow a previously written bracketed array, so the file
/// is grown in place rather than fully rewritten on every dedup.
pub(crate) fn append_hash_cache(path: &Path, entries: &[(PathBuf, HashCacheEntry)]) -> io::Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = String::with_capacity(entries.len() * 64);
    for (p, e) in entries {
        out.push('[');
        push_json_string(&mut out, &p.to_string_lossy());
        out.push(',');
        out.push_str(&e.size.to_string());
        out.push(',');
        out.push_str(&e.mtime.to_string());
        out.push(',');
        out.push_str(&e.hash.to_string());
        out.push_str("]\n");
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(out.as_bytes())
}

// ── Persistent content-hash cache (JSON) ────────────────────────────────────

/// Load the hash cache from JSON `["path", size, mtime, hash]` rows. Returns the
/// deduplicated map plus whether the file should be compacted: true when it held
/// more rows than unique entries (incremental-append bloat from `append_hash_cache`)
/// or had to be capped at `MAX_HASH_CACHE_ENTRIES`, so the caller can rewrite a
/// tidy snapshot once at startup and keep the file bounded across restarts.
pub(crate) fn load_hash_cache(path: &Path) -> (HashMap<PathBuf, HashCacheEntry>, bool) {
    let mut map = HashMap::new();
    let Ok(raw) = fs::read_to_string(path) else { return (map, false); };
    let mut rows = 0usize;
    let mut capped = false;
    for line in raw.lines() {
        let line = line.trim().trim_end_matches(',');
        if !line.starts_with('[') {
            continue;
        }
        if let Some((p, size, mtime, hash)) = parse_hash_row(line) {
            rows += 1;
            let key = PathBuf::from(p);
            // A later row for the same path wins (newest append overrides), so
            // duplicates from incremental appends collapse to the freshest hash.
            if map.len() >= MAX_HASH_CACHE_ENTRIES && !map.contains_key(&key) {
                capped = true;
                continue;
            }
            // Re-mint `seq` in file order: rows written earlier (older) get smaller
            // stamps, so runtime eviction drops them first. `seq` is not persisted.
            map.insert(key, HashCacheEntry { size, mtime, hash, seq: next_hash_cache_seq() });
        }
    }
    let should_compact = capped || rows > map.len();
    (map, should_compact)
}

/// Persist (compact) the whole hash cache as a JSON array of
/// `["path", size, mtime, hash]` rows. This is the full-rewrite/compaction path;
/// steady-state growth uses the cheaper incremental `append_hash_cache`.
pub(crate) fn save_hash_cache(path: &Path, cache: &HashMap<PathBuf, HashCacheEntry>) -> io::Result<()> {
    let mut out = String::from("[\n");
    let mut first = true;
    for (p, e) in cache {
        if !first {
            out.push_str(",\n");
        }
        first = false;
        out.push('[');
        push_json_string(&mut out, &p.to_string_lossy());
        out.push(',');
        out.push_str(&e.size.to_string());
        out.push(',');
        out.push_str(&e.mtime.to_string());
        out.push(',');
        out.push_str(&e.hash.to_string());
        out.push(']');
    }
    out.push_str("\n]\n");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, out)
}

/// Parse a line like `["C:\\a.bin",1024,1730000000,1234567890]`.
fn parse_hash_row(line: &str) -> Option<(String, u64, u64, u64)> {
    let s = line.strip_prefix('[')?.trim_start();
    let (path, rest) = parse_json_string(s)?;
    let rest = rest.trim_start().strip_prefix(',')?;
    let mut nums = rest.trim_end_matches(']').split(',');
    let size = nums.next()?.trim().parse().ok()?;
    let mtime = nums.next()?.trim().parse().ok()?;
    let hash = nums.next()?.trim().parse().ok()?;
    Some((path, size, mtime, hash))
}

// ── Build candidate file list from scan result ──────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct DupeFilter2 {
    pub(crate) min_size: u64,
    pub(crate) max_size: Option<u64>,
    pub(crate) extensions: Vec<String>,
}

pub(crate) fn build_candidates_from_nodes(nodes: &[NodeRecord], filter: &DupeFilter2) -> Vec<DupeFileV2> {
    nodes
        .iter()
        .filter(|n| !n.is_dir && n.size >= filter.min_size.max(1))
        .filter(|n| filter.max_size.map_or(true, |max| n.size <= max))
        .filter(|n| {
            filter.extensions.is_empty()
                || filter.extensions.contains(&n.extension.to_lowercase())
        })
        .map(|n| DupeFileV2 {
            // Files no longer store their absolute path (interned away to cut
            // scan memory); reconstruct it from the parent directory + name.
            path: PathBuf::from(node_abs_path(nodes, n.id)),
            name: n.name.clone(),
            size: n.size,
            modified: (n.modified_ms / 1000) as u64,
            is_ref: false,
        })
        .collect()
}

// ── Exact duplicate detection now funnels through `hash_candidate_groups`
//    (size-group -> sample fingerprint -> cached full hash). The old standalone
//    `scan_exact` / `scan_exact_with_progress` walkers were removed; callers use
//    `exact_matches_via_hash_cache` (above) so every path shares one engine and
//    the persistent hash cache.

// ── Filename fuzzy (Sørensen-Dice) ─────────────────────────────────────────

fn get_words(name: &str) -> Vec<String> {
    // Strip file extension
    let stem = match name.rfind('.') {
        Some(pos) if pos > 0 => &name[..pos],
        _ => name,
    };
    let mut result = String::with_capacity(stem.len());
    for ch in stem.chars() {
        match ch {
            '-' | '_' | '(' | ')' | '[' | ']' | '{' | '}' => result.push(' '),
            '\'' | '.' | ',' => {}
            c => result.push(c),
        }
    }
    result
        .to_lowercase()
        .split_whitespace()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
        .collect()
}

fn dice_score(a: &[String], b: &[String], weighted: bool) -> u8 {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    // Build frequency maps
    let mut count_a: HashMap<&str, usize> = HashMap::new();
    let mut count_b: HashMap<&str, usize> = HashMap::new();
    for w in a {
        *count_a.entry(w.as_str()).or_default() += 1;
    }
    for w in b {
        *count_b.entry(w.as_str()).or_default() += 1;
    }

    let intersection: usize = count_a
        .iter()
        .map(|(&w, &ca)| {
            let cb = count_b.get(w).copied().unwrap_or(0);
            let overlap = ca.min(cb);
            if weighted { overlap * w.len() } else { overlap }
        })
        .sum();

    let total_a: usize = if weighted {
        a.iter().map(|w| w.len()).sum()
    } else {
        a.len()
    };
    let total_b: usize = if weighted {
        b.iter().map(|w| w.len()).sum()
    } else {
        b.len()
    };

    let total = total_a + total_b;
    if total == 0 {
        return 0;
    }
    ((2 * intersection * 100) / total).min(100) as u8
}

fn build_word_dict(files: &[DupeFileV2]) -> HashMap<String, Vec<usize>> {
    let mut dict: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, f) in files.iter().enumerate() {
        for word in get_words(&f.name) {
            dict.entry(word).or_default().push(idx);
        }
    }
    dict
}

pub(crate) fn scan_filename(
    files: &[DupeFileV2],
    min_pct: u8,
    weighted: bool,
    mix_kinds: bool,
) -> Vec<(usize, usize, u8)> {
    let dict = build_word_dict(files);
    let words_cache: Vec<Vec<String>> = files.iter().map(|f| get_words(&f.name)).collect();

    // Collect candidate pairs (share ≥1 word)
    let mut candidate_pairs: HashSet<(usize, usize)> = HashSet::new();
    for indices in dict.values() {
        if indices.len() < 2 {
            continue;
        }
        for i in 0..indices.len() {
            for j in (i + 1)..indices.len() {
                let a = indices[i].min(indices[j]);
                let b = indices[i].max(indices[j]);
                candidate_pairs.insert((a, b));
            }
        }
    }

    let mut matches = Vec::new();
    for (a, b) in candidate_pairs {
        // Optionally skip pairs with different extensions
        if !mix_kinds {
            let ext_a = files[a].path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let ext_b = files[b].path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext_a.eq_ignore_ascii_case(ext_b) {
                continue;
            }
        }
        let score = dice_score(&words_cache[a], &words_cache[b], weighted);
        if score >= min_pct {
            matches.push((a, b, score));
        }
    }
    matches
}

// ── Algorithm 3: Audio tag matching (ID3v2 hand-parser) ────────────────────

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "ogg", "m4a", "aac", "wav", "wma", "opus"];

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn syncsafe_to_u32(bytes: &[u8; 4]) -> u32 {
    ((bytes[0] as u32) << 21)
        | ((bytes[1] as u32) << 14)
        | ((bytes[2] as u32) << 7)
        | (bytes[3] as u32)
}

fn read_id3v2(path: &Path) -> HashMap<String, String> {
    let mut tags: HashMap<String, String> = HashMap::new();
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(_) => return tags,
    };

    let mut header = [0u8; 10];
    if f.read_exact(&mut header).is_err() {
        return tags;
    }
    if &header[0..3] != b"ID3" {
        // Try ID3v1 fallback (last 128 bytes)
        if let Ok(len) = f.seek(SeekFrom::End(-128)) {
            let _ = len;
            let mut v1 = [0u8; 128];
            if f.read_exact(&mut v1).is_ok() && &v1[0..3] == b"TAG" {
                let decode = |s: &[u8]| {
                    let s = s.iter().take_while(|&&b| b != 0).cloned().collect::<Vec<u8>>();
                    String::from_utf8_lossy(&s).trim().to_string()
                };
                tags.insert("title".into(), decode(&v1[3..33]));
                tags.insert("artist".into(), decode(&v1[33..63]));
                tags.insert("album".into(), decode(&v1[63..93]));
                tags.insert("year".into(), decode(&v1[93..97]));
                // Genre: byte 127 is genre index — skip for text matching
            }
        }
        return tags;
    }

    let size = syncsafe_to_u32(header[6..10].try_into().unwrap_or(&[0; 4]));
    let version = header[3];

    // Read all frames
    let mut pos: u32 = 0;
    while pos + 10 <= size {
        let mut frame_id = [0u8; 4];
        if f.read_exact(&mut frame_id).is_err() {
            break;
        }
        if frame_id[0] == 0 {
            break; // padding
        }

        let frame_size = if version >= 4 {
            let mut sb = [0u8; 4];
            if f.read_exact(&mut sb).is_err() { break; }
            syncsafe_to_u32(&sb)
        } else {
            let mut sb = [0u8; 4];
            if f.read_exact(&mut sb).is_err() { break; }
            u32::from_be_bytes(sb)
        };
        let mut flags = [0u8; 2];
        if f.read_exact(&mut flags).is_err() { break; }

        pos += 10 + frame_size;

        if frame_size == 0 || frame_size > 1024 * 1024 {
            // Skip oversized or zero frames safely
            let _ = f.seek(SeekFrom::Current(frame_size as i64));
            continue;
        }

        let mut data = vec![0u8; frame_size as usize];
        if f.read_exact(&mut data).is_err() {
            break;
        }

        let id_str = match std::str::from_utf8(&frame_id) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let tag_key = match id_str {
            "TIT2" => "title",
            "TPE1" => "artist",
            "TALB" => "album",
            "TCON" => "genre",
            "TRCK" => "track",
            "TYER" | "TDRC" => "year",
            _ => continue,
        };

        // Text encoding byte at data[0]: 0=latin1, 1=utf16, 3=utf8
        if data.is_empty() { continue; }
        let encoding = data[0];
        let text_bytes = &data[1..];
        let text = match encoding {
            1 => {
                // UTF-16 with BOM
                if text_bytes.len() < 2 { continue; }
                let is_le = text_bytes[0] == 0xFF && text_bytes[1] == 0xFE;
                let start = if text_bytes[0] == 0xFF || text_bytes[0] == 0xFE { 2 } else { 0 };
                let words: Vec<u16> = text_bytes[start..]
                    .chunks(2)
                    .filter(|c| c.len() == 2)
                    .map(|c| if is_le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
                    .take_while(|&w| w != 0)
                    .collect();
                String::from_utf16_lossy(&words).trim().to_string()
            }
            3 => {
                // UTF-8
                let end = text_bytes.iter().position(|&b| b == 0).unwrap_or(text_bytes.len());
                String::from_utf8_lossy(&text_bytes[..end]).trim().to_string()
            }
            _ => {
                // Latin-1
                let end = text_bytes.iter().position(|&b| b == 0).unwrap_or(text_bytes.len());
                text_bytes[..end].iter().map(|&b| b as char).collect::<String>().trim().to_string()
            }
        };

        if !text.is_empty() {
            tags.insert(tag_key.to_string(), text);
        }
    }

    tags
}

fn compare_fields(fields_a: &[Vec<String>], fields_b: &[Vec<String>]) -> u8 {
    fields_a
        .iter()
        .zip(fields_b.iter())
        .map(|(a, b)| dice_score(a, b, false))
        .min()
        .unwrap_or(0)
}

pub(crate) fn scan_audio(
    files: &[DupeFileV2],
    active_tags: &[&str],
    min_pct: u8,
) -> Vec<(usize, usize, u8)> {
    if active_tags.is_empty() {
        return Vec::new();
    }

    // Filter to audio files only
    let audio_indices: Vec<usize> = files
        .iter()
        .enumerate()
        .filter(|(_, f)| is_audio(&f.path))
        .map(|(i, _)| i)
        .collect();

    if audio_indices.len() < 2 {
        return Vec::new();
    }

    // Read tags for each audio file; build per-file Vec<Vec<String>> (one per active tag)
    let tag_words: Vec<Vec<Vec<String>>> = audio_indices
        .iter()
        .map(|&idx| {
            let tags = read_id3v2(&files[idx].path);
            active_tags
                .iter()
                .map(|&t| {
                    tags.get(t)
                        .map(|v| get_words(v))
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect();

    // Pre-filter: build word dict from first active tag to find candidates
    let mut first_word_dict: HashMap<String, Vec<usize>> = HashMap::new();
    for (pos, words_per_tag) in tag_words.iter().enumerate() {
        if let Some(first) = words_per_tag.first() {
            for w in first {
                first_word_dict.entry(w.clone()).or_default().push(pos);
            }
        }
    }

    let mut candidate_pairs: HashSet<(usize, usize)> = HashSet::new();
    for indices in first_word_dict.values() {
        for i in 0..indices.len() {
            for j in (i + 1)..indices.len() {
                let a = indices[i].min(indices[j]);
                let b = indices[i].max(indices[j]);
                candidate_pairs.insert((a, b));
            }
        }
    }

    let mut matches = Vec::new();
    for (pos_a, pos_b) in candidate_pairs {
        let score = compare_fields(&tag_words[pos_a], &tag_words[pos_b]);
        if score >= min_pct {
            matches.push((audio_indices[pos_a], audio_indices[pos_b], score));
        }
    }
    matches
}

// ── Grouping (dupeguru clique-safe merge) ───────────────────────────────────

pub(crate) fn matches_to_groups(
    mut matches: Vec<(usize, usize, u8)>,
    files: &[DupeFileV2],
    mode: ScanMode,
    ignore_list: &IgnoreList,
) -> Vec<DupeGroupV2> {
    // Sort by score desc so highest-confidence pairs form groups first
    matches.sort_by(|a, b| b.2.cmp(&a.2));

    // Track which group each file index belongs to (index into `groups`)
    let mut file_to_group: HashMap<usize, usize> = HashMap::new();
    // For clique safety: remember all match scores between file pairs
    let mut pair_score: HashMap<(usize, usize), u8> = HashMap::new();
    for &(a, b, s) in &matches {
        let key = (a.min(b), a.max(b));
        pair_score.insert(key, s);
    }

    // groups[i] = list of file indices in that group
    let mut groups: Vec<Vec<usize>> = Vec::new();

    for (a, b, _score) in matches {
        // Skip ignored pairs
        if ignore_list.are_ignored(&files[a].path, &files[b].path) {
            continue;
        }

        let ga = file_to_group.get(&a).copied();
        let gb = file_to_group.get(&b).copied();

        match (ga, gb) {
            (None, None) => {
                let gid = groups.len();
                groups.push(vec![a, b]);
                file_to_group.insert(a, gid);
                file_to_group.insert(b, gid);
            }
            (Some(gid), None) => {
                // Check that b matches every existing member of the group
                let all_match = groups[gid].iter().all(|&m| {
                    if m == a { return true; }
                    let key = (m.min(b), m.max(b));
                    pair_score.get(&key).copied().unwrap_or(0) > 0
                });
                if all_match {
                    groups[gid].push(b);
                    file_to_group.insert(b, gid);
                }
            }
            (None, Some(gid)) => {
                let all_match = groups[gid].iter().all(|&m| {
                    if m == b { return true; }
                    let key = (m.min(a), m.max(a));
                    pair_score.get(&key).copied().unwrap_or(0) > 0
                });
                if all_match {
                    groups[gid].push(a);
                    file_to_group.insert(a, gid);
                }
            }
            (Some(ga), Some(gb)) => {
                if ga == gb {
                    // Already in same group
                } else {
                    // Discard — clique safety: would require all pairs across both groups to match
                }
            }
        }
    }

    // Convert index groups to DupeGroupV2
    let mut result: Vec<DupeGroupV2> = groups
        .into_iter()
        .filter(|g| g.len() >= 2)
        .map(|mut indices| {
            // Reference = largest file
            indices.sort_by(|&a, &b| files[b].size.cmp(&files[a].size));
            let ref_size = files[indices[0]].size;
            let waste = ref_size.saturating_mul((indices.len() - 1) as u64);

            // Find score between ref and first dupe as group score
            let group_score = if mode == ScanMode::Exact {
                100
            } else if indices.len() >= 2 {
                let key = (indices[0].min(indices[1]), indices[0].max(indices[1]));
                pair_score.get(&key).copied().unwrap_or(0)
            } else {
                0
            };

            let file_objs: Vec<DupeFileV2> = indices
                .iter()
                .enumerate()
                .map(|(pos, &idx)| DupeFileV2 {
                    path: files[idx].path.clone(),
                    name: files[idx].name.clone(),
                    size: files[idx].size,
                    modified: files[idx].modified,
                    is_ref: pos == 0,
                })
                .collect();

            DupeGroupV2 { files: file_objs, score: group_score, waste }
        })
        .collect();

    // Sort groups by waste descending
    result.sort_by(|a, b| b.waste.cmp(&a.waste));
    result
}

// ── Re-prioritize ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub(crate) enum ReprioritizeCriterion {
    Largest,
    Smallest,
    Newest,
    Oldest,
    ShortestPath,
    LongestPath,
    AlphaFirst,
    AlphaLast,
}

impl ReprioritizeCriterion {
    pub(crate) fn from_str(s: &str) -> Option<Self> {
        match s {
            "largest"     => Some(Self::Largest),
            "smallest"    => Some(Self::Smallest),
            "newest"      => Some(Self::Newest),
            "oldest"      => Some(Self::Oldest),
            "shortestPath"=> Some(Self::ShortestPath),
            "longestPath" => Some(Self::LongestPath),
            "alphaFirst"  => Some(Self::AlphaFirst),
            "alphaLast"   => Some(Self::AlphaLast),
            _ => None,
        }
    }
}

pub(crate) fn reprioritize(groups: &mut [DupeGroupV2], criterion: ReprioritizeCriterion) {
    for group in groups.iter_mut() {
        group.files.sort_by(|a, b| {
            match criterion {
                ReprioritizeCriterion::Largest     => b.size.cmp(&a.size),
                ReprioritizeCriterion::Smallest    => a.size.cmp(&b.size),
                ReprioritizeCriterion::Newest      => b.modified.cmp(&a.modified),
                ReprioritizeCriterion::Oldest      => a.modified.cmp(&b.modified),
                ReprioritizeCriterion::ShortestPath => a.path.as_os_str().len().cmp(&b.path.as_os_str().len()),
                ReprioritizeCriterion::LongestPath  => b.path.as_os_str().len().cmp(&a.path.as_os_str().len()),
                ReprioritizeCriterion::AlphaFirst  => a.name.cmp(&b.name),
                ReprioritizeCriterion::AlphaLast   => b.name.cmp(&a.name),
            }
        });
        for (pos, f) in group.files.iter_mut().enumerate() {
            f.is_ref = pos == 0;
        }
        // Recompute waste based on new reference (all files same size in exact mode, but not in filename mode)
        let ref_size = group.files.first().map(|f| f.size).unwrap_or(0);
        group.waste = ref_size.saturating_mul((group.files.len() - 1) as u64);
    }
}

// ── Actions ─────────────────────────────────────────────────────────────────

/// Delete each path. Recoverable by default (Recycle Bin via the shared
/// `recycle_path`, which recurses directories), permanent only when the caller
/// explicitly asked for it. Both branches handle files AND directories — the
/// old code used `fs::remove_file` only, so a selected duplicate *folder* (or a
/// permanent delete of one) silently failed.
pub(crate) fn action_delete(paths: &[PathBuf], permanent: bool) -> Vec<String> {
    let mut errors = Vec::new();
    for path in paths {
        let result = if permanent {
            crate::recycle::delete_path_permanent(path)
        } else {
            crate::recycle::recycle_path(path)
        };
        // Audit every delete (Phase 5) for forensics + future undo.
        let path_str = path.to_string_lossy().to_string();
        let err_text = result
            .as_ref()
            .err()
            .map(|e| crate::preflight::describe_fs_error(e, path));
        crate::audit::record(crate::audit::Entry {
            op: if permanent { "permanent-delete" } else { "delete" },
            disposition: if permanent { "permanent" } else { "recycle" },
            src: std::slice::from_ref(&path_str),
            error: err_text.as_deref(),
            by: "server",
            ..Default::default()
        });
        if let Err(e) = result {
            errors.push(crate::preflight::describe_fs_error(&e, path));
        }
    }
    errors
}

/// Canonicalized "same on-disk object?" check. Guards against copying a file
/// onto itself (which `fs::copy` would truncate to zero bytes — silent data
/// loss) and against treating a same-file move as a collision.
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// True when the destination lands inside `src_dir` itself (moving/copying a
/// directory into its own subtree). `dst` usually doesn't exist yet, so its
/// PARENT is canonicalized and compared against the source.
fn dest_inside_dir(src_dir: &Path, dst: &Path) -> bool {
    if let (Ok(s), Some(parent)) = (fs::canonicalize(src_dir), dst.parent()) {
        if let Ok(p) = fs::canonicalize(parent) {
            return p == s || p.starts_with(&s);
        }
    }
    false
}

/// If `dst` is free, return it; otherwise append " (2)", " (3)", … before the
/// extension (the Explorer "Keep both" rule) so an existing item is NEVER
/// silently overwritten — the gap the old `fs::copy` clobber left open.
fn unique_dst(dst: &Path) -> PathBuf {
    if !dst.exists() {
        return dst.to_path_buf();
    }
    let parent = dst
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = dst
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = dst.extension().map(|e| e.to_string_lossy().to_string());
    let mut n: u32 = 2;
    loop {
        let candidate_name = match &ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() || n >= 9999 {
            return candidate;
        }
        n += 1;
    }
}

/// Move each `src` to `dst`. Adds no-op / self-descendant guards and keep-both
/// collision handling (an existing target is never silently clobbered), then
/// tries an atomic rename, falling back to copy + remove for a cross-device move.
pub(crate) fn action_move(src_dst: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errors = Vec::new();
    for (src, dst) in src_dst {
        if !src.exists() {
            errors.push(format!("{}: source does not exist", src.display()));
            continue;
        }
        // Source already IS the destination object → nothing to do.
        if same_file(src, dst) {
            continue;
        }
        if src.is_dir() && dest_inside_dir(src, dst) {
            errors.push(format!(
                "{}: cannot move a folder into itself or one of its descendants",
                src.display()
            ));
            continue;
        }
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                errors.push(format!("{}: {}", dst.display(), e));
                continue;
            }
        }
        // Keep-both on collision: route to a unique name rather than overwrite.
        let target = if dst.exists() { unique_dst(dst) } else { dst.clone() };
        // Try atomic rename first; fall back to copy + remove for cross-device.
        // Pre-flight the destination's free space before starting a copy we
        // might not be able to finish (Phase 3).
        let result: io::Result<()> = match fs::rename(src, &target) {
            Ok(_) => Ok(()),
            Err(_) => {
                let dest_dir = target.parent().unwrap_or_else(|| target.as_path());
                if let Err(message) = crate::preflight::ensure_space_for_copy(src, dest_dir) {
                    Err(io::Error::new(io::ErrorKind::Other, message))
                } else {
                    fs::copy(src, &target).and_then(|_| fs::remove_file(src))
                }
            }
        };
        // Audit the move (Phase 5): exact src -> dst supports a future undo.
        let src_str = src.to_string_lossy().to_string();
        let target_str = target.to_string_lossy().to_string();
        match &result {
            Ok(()) => crate::audit::record(crate::audit::Entry {
                op: "move",
                src: std::slice::from_ref(&src_str),
                dst: &target_str,
                by: "server",
                ..Default::default()
            }),
            Err(e) => {
                let message = crate::preflight::describe_fs_error(e, src);
                crate::audit::record(crate::audit::Entry {
                    op: "move",
                    src: std::slice::from_ref(&src_str),
                    dst: &target_str,
                    error: Some(message.as_str()),
                    by: "server",
                    ..Default::default()
                });
                errors.push(message);
            }
        }
    }
    errors
}

/// Copy each `src` to `dst`. Refuses a self-copy (which `fs::copy` would
/// truncate) and self-descendant copies, and applies keep-both collision
/// handling so an existing target is never silently overwritten.
pub(crate) fn action_copy(src_dst: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut errors = Vec::new();
    for (src, dst) in src_dst {
        if !src.exists() {
            errors.push(format!("{}: source does not exist", src.display()));
            continue;
        }
        if same_file(src, dst) {
            errors.push(format!(
                "{}: source and destination are the same file",
                src.display()
            ));
            continue;
        }
        if src.is_dir() && dest_inside_dir(src, dst) {
            errors.push(format!(
                "{}: cannot copy a folder into itself or one of its descendants",
                src.display()
            ));
            continue;
        }
        if let Some(parent) = dst.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                errors.push(format!("{}: {}", dst.display(), e));
                continue;
            }
        }
        let target = if dst.exists() { unique_dst(dst) } else { dst.clone() };
        // Pre-flight the destination's free space before starting the copy
        // (Phase 3) — don't begin a copy we can't finish.
        let dest_dir = target.parent().unwrap_or_else(|| target.as_path());
        let result: io::Result<()> = match crate::preflight::ensure_space_for_copy(src, dest_dir) {
            Err(message) => Err(io::Error::new(io::ErrorKind::Other, message)),
            Ok(()) => fs::copy(src, &target).map(|_| ()),
        };
        // Audit the copy (Phase 5).
        let src_str = src.to_string_lossy().to_string();
        let target_str = target.to_string_lossy().to_string();
        match &result {
            Ok(()) => crate::audit::record(crate::audit::Entry {
                op: "copy",
                src: std::slice::from_ref(&src_str),
                dst: &target_str,
                by: "server",
                ..Default::default()
            }),
            Err(e) => {
                let message = crate::preflight::describe_fs_error(e, src);
                crate::audit::record(crate::audit::Entry {
                    op: "copy",
                    src: std::slice::from_ref(&src_str),
                    dst: &target_str,
                    error: Some(message.as_str()),
                    by: "server",
                    ..Default::default()
                });
                errors.push(message);
            }
        }
    }
    errors
}

// ── Ignore list ─────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct IgnoreList {
    /// Symmetric: if (a,b) stored, (b,a) is also stored for O(1) lookup.
    pairs: HashMap<PathBuf, HashSet<PathBuf>>,
}

impl IgnoreList {
    pub(crate) fn add(&mut self, a: &Path, b: &Path) {
        self.pairs.entry(a.to_owned()).or_default().insert(b.to_owned());
        self.pairs.entry(b.to_owned()).or_default().insert(a.to_owned());
    }

    pub(crate) fn are_ignored(&self, a: &Path, b: &Path) -> bool {
        self.pairs.get(a).map_or(false, |s| s.contains(b))
    }

    pub(crate) fn clear(&mut self) {
        self.pairs.clear();
    }

    /// Number of unique pairs (not paths).
    pub(crate) fn pair_count(&self) -> usize {
        self.pairs.values().map(|s| s.len()).sum::<usize>() / 2
    }

    /// Save as JSON array of [path_a, path_b] pairs (canonical a < b ordering).
    pub(crate) fn save(&self, path: &Path) -> io::Result<()> {
        let mut seen: HashSet<(PathBuf, PathBuf)> = HashSet::new();
        let mut out = String::from("[\n");
        let mut first = true;
        for (a, bs) in &self.pairs {
            for b in bs {
                let key = if a <= b {
                    (a.clone(), b.clone())
                } else {
                    (b.clone(), a.clone())
                };
                if seen.insert(key) {
                    if !first { out.push_str(",\n"); }
                    first = false;
                    out.push('[');
                    push_json_string(&mut out, &a.to_string_lossy());
                    out.push(',');
                    push_json_string(&mut out, &b.to_string_lossy());
                    out.push(']');
                }
            }
        }
        out.push_str("\n]\n");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, out)
    }

    /// Load from JSON produced by `save()`.
    pub(crate) fn load(path: &Path) -> io::Result<Self> {
        let raw = fs::read_to_string(path)?;
        let mut list = IgnoreList::default();
        // Minimal hand-parser: each line like ["path_a","path_b"]
        for line in raw.lines() {
            let line = line.trim().trim_start_matches(',');
            if !line.starts_with('[') || line == "[" || line == "]" {
                continue;
            }
            // Extract the two quoted strings
            if let Some((a, b)) = parse_json_pair(line) {
                list.add(Path::new(&a), Path::new(&b));
            }
        }
        Ok(list)
    }
}

/// Parse a line like `["path a","path b"]` into two strings.
fn parse_json_pair(line: &str) -> Option<(String, String)> {
    // Find first quoted string
    let s = line.strip_prefix('[').unwrap_or(line);
    let (first, rest) = parse_json_string(s.trim_start())?;
    let rest = rest.trim_start().strip_prefix(',')?.trim_start();
    let (second, _) = parse_json_string(rest)?;
    Some((first, second))
}

fn parse_json_string(s: &str) -> Option<(String, &str)> {
    let s = s.strip_prefix('"')?;
    let mut result = String::new();
    let mut chars = s.char_indices();
    loop {
        let (i, ch) = chars.next()?;
        if ch == '"' {
            return Some((result, &s[i + 1..]));
        }
        if ch == '\\' {
            let (_, esc) = chars.next()?;
            match esc {
                '"' => result.push('"'),
                '\\' => result.push('\\'),
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                c => result.push(c),
            }
        } else {
            result.push(ch);
        }
    }
}

// ── JSON serialization ──────────────────────────────────────────────────────

/// Serialize duplicate groups to a `String`. Thin wrapper over
/// [`write_groups_to_json`] for the small single-group `/api/dupes-make-ref`
/// response; writing into a `Vec<u8>` is infallible so the result is always `Ok`.
pub(crate) fn groups_to_json(
    groups: &[DupeGroupV2],
    mode: ScanMode,
    errors: &[String],
    ignored_count: usize,
) -> String {
    let mut out: Vec<u8> = Vec::new();
    let _ = write_groups_to_json(&mut out, groups, mode, errors, ignored_count);
    String::from_utf8(out).unwrap_or_default()
}

/// Stream duplicate groups as JSON to `w` through a small reused buffer that is
/// flushed per-group, so a large `/api/dupes-v2` response is delivered
/// incrementally instead of materialising one giant `String`. The emitted bytes
/// are byte-for-byte identical to the previous in-memory serialization.
pub(crate) fn write_groups_to_json<W: Write>(
    w: &mut W,
    groups: &[DupeGroupV2],
    mode: ScanMode,
    errors: &[String],
    ignored_count: usize,
) -> io::Result<()> {
    const FLUSH_THRESHOLD: usize = 64 * 1024;
    let mode_str = match mode {
        ScanMode::Exact    => "exact",
        ScanMode::Filename => "filename",
        ScanMode::Audio    => "audio",
    };
    let mut out = String::new();
    out.push_str("{\"mode\":");
    push_json_string(&mut out, mode_str);
    out.push_str(",\"groups\":[");
    for (gi, group) in groups.iter().enumerate() {
        if gi > 0 { out.push(','); }
        out.push_str("{\"score\":");
        out.push_str(&group.score.to_string());
        out.push_str(",\"waste\":");
        out.push_str(&group.waste.to_string());
        out.push_str(",\"files\":[");
        // Reference is files[0]; per-file match breakdown is scored relative to
        // it so the client's delta columns work the same for the server-side
        // fallback as for the client-first content path.
        let reference = group.files.first();
        for (fi, f) in group.files.iter().enumerate() {
            if fi > 0 { out.push(','); }
            let is_ref = f.is_ref;
            let (name_m, size_m, date_m): (u8, u8, u8) = match reference {
                Some(r) if !is_ref => (
                    if f.name.eq_ignore_ascii_case(&r.name) { 100 } else { 0 },
                    if f.size == r.size { 100 } else { 0 },
                    if f.modified == r.modified { 100 } else { 0 },
                ),
                _ => (100, 100, 100),
            };
            let content_m: u8 = if is_ref {
                100
            } else if mode == ScanMode::Exact {
                100
            } else {
                group.score
            };
            let file_score: u8 = if is_ref { 100 } else { group.score };
            out.push('{');
            out.push_str("\"path\":");
            push_json_string(&mut out, &f.path.to_string_lossy());
            out.push_str(",\"name\":");
            push_json_string(&mut out, &f.name);
            out.push_str(",\"size\":");
            out.push_str(&f.size.to_string());
            out.push_str(",\"modified\":");
            out.push_str(&f.modified.to_string());
            out.push_str(",\"ref\":");
            out.push_str(if f.is_ref { "true" } else { "false" });
            out.push_str(",\"score\":");
            out.push_str(&file_score.to_string());
            out.push_str(",\"match\":{\"name\":");
            out.push_str(&name_m.to_string());
            out.push_str(",\"size\":");
            out.push_str(&size_m.to_string());
            out.push_str(",\"date\":");
            out.push_str(&date_m.to_string());
            out.push_str(",\"content\":");
            out.push_str(&content_m.to_string());
            out.push_str("}}");
        }
        out.push_str("]}");
        if out.len() >= FLUSH_THRESHOLD {
            w.write_all(out.as_bytes())?;
            out.clear();
        }
    }
    out.push_str("],\"errors\":[");
    for (i, e) in errors.iter().enumerate() {
        if i > 0 { out.push(','); }
        push_json_string(&mut out, e);
    }
    out.push_str("],\"ignoredCount\":");
    out.push_str(&ignored_count.to_string());
    out.push('}');
    w.write_all(out.as_bytes())?;
    Ok(())
}
