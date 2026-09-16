use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::export::push_json_string;
use crate::model::{DupesProgress, HashCacheEntry, NodeRecord, node_abs_path};

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

// ── Fast content hash (FxHash-style, 8 bytes/step) ───────────────────────────
//
// Replaces the old byte-serial FNV-1a with a multiply-rotate hash that consumes
// 8 bytes per step (~8× fewer multiplies), so full-file hashing of large dupe
// candidates is markedly faster. It is not cryptographic: callers can request
// a byte-wise discovery confirmation, and every destructive desktop action
// always performs one immediately before changing a file.
//
// Determinism note: `FastHasher` carries leftover (<8) bytes between `write`
// calls so the 8-byte word boundaries are fixed to absolute byte offsets,
// independent of how `File::read` chops the stream. Identical content therefore
// always yields the same hash regardless of read chunking.

const QUICK_SAMPLE_OFFSET: u64 = 16 * 1024;
const QUICK_SAMPLE_BYTES: usize = 16 * 1024;
const QUICK_FULL_LIMIT: u64 = QUICK_SAMPLE_OFFSET + QUICK_SAMPLE_BYTES as u64;
const SAMPLE_BYTES: usize = 64 * 1024;
const SAMPLE_REGIONS: u64 = 3;
pub(crate) const FULL_SAMPLE_LIMIT: u64 = (SAMPLE_BYTES as u64) * SAMPLE_REGIONS;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;

/// Multiplier from the FxHash/SeaHash family (a large odd constant with good
/// avalanche behavior).
const HASH_K: u64 = 0x51_7c_c1_b7_27_22_0a_95;

struct FastHasher {
    hash: u64,
    carry: [u8; 8],
    carry_len: usize,
}

impl FastHasher {
    fn new(seed: u64) -> Self {
        FastHasher {
            hash: seed ^ 0xcbf2_9ce4_8422_2325,
            carry: [0u8; 8],
            carry_len: 0,
        }
    }

    #[inline]
    fn add_word(&mut self, word: u64) {
        self.hash = (self.hash.rotate_left(5) ^ word).wrapping_mul(HASH_K);
    }

    fn write(&mut self, mut bytes: &[u8]) {
        // Top up a pending partial word first.
        if self.carry_len > 0 {
            let need = 8 - self.carry_len;
            let take = need.min(bytes.len());
            self.carry[self.carry_len..self.carry_len + take].copy_from_slice(&bytes[..take]);
            self.carry_len += take;
            bytes = &bytes[take..];
            if self.carry_len == 8 {
                let w = u64::from_le_bytes(self.carry);
                self.add_word(w);
                self.carry_len = 0;
            }
        }
        let mut chunks = bytes.chunks_exact(8);
        for c in &mut chunks {
            let w = u64::from_le_bytes(c.try_into().unwrap());
            self.add_word(w);
        }
        let rem = chunks.remainder();
        if !rem.is_empty() {
            self.carry[..rem.len()].copy_from_slice(rem);
            self.carry_len = rem.len();
        }
    }

    fn finish(mut self) -> u64 {
        if self.carry_len > 0 {
            for b in self.carry.iter_mut().skip(self.carry_len) {
                *b = 0;
            }
            let w = u64::from_le_bytes(self.carry);
            self.add_word(w);
        }
        // Final mix.
        let mut h = self.hash;
        h ^= h >> 32;
        h = h.wrapping_mul(HASH_K);
        h ^= h >> 29;
        h
    }
}

#[cfg(windows)]
fn open_sequential(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;

    // Hint Windows' cache manager to use aggressive read-ahead and discard old
    // pages promptly. Duplicate hashing is a one-way sequential workload.
    OpenOptions::new()
        .read(true)
        .custom_flags(0x0800_0000) // FILE_FLAG_SEQUENTIAL_SCAN
        .open(path)
}

#[cfg(not(windows))]
fn open_sequential(path: &Path) -> io::Result<File> {
    File::open(path)
}

fn content_hash_file_with_buffer(path: &Path, buffer: &mut [u8]) -> io::Result<u64> {
    content_hash_file_reporting(path, buffer, None, |_| {})
}

fn content_hash_file_reporting(
    path: &Path,
    buffer: &mut [u8],
    cancel: Option<&Arc<AtomicBool>>,
    on_read: impl Fn(u64),
) -> io::Result<u64> {
    let mut file = open_sequential(path)?;
    let mut hasher = FastHasher::new(0);
    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Hashing cancelled",
            ));
        }
        let read = file.read(buffer)?;
        if read == 0 {
            break;
        }
        hasher.write(&buffer[..read]);
        on_read(read as u64);
    }
    Ok(hasher.finish())
}

pub(crate) fn content_hash_file(path: &Path) -> io::Result<u64> {
    let mut buffer = vec![0u8; HASH_BUFFER_BYTES];
    content_hash_file_with_buffer(path, &mut buffer)
}

fn content_hash_file_quick_with_buffer(
    path: &Path,
    size: u64,
    buffer: &mut [u8],
) -> io::Result<(u64, bool)> {
    let mut file = File::open(path)?;
    let buffer = &mut buffer[..QUICK_SAMPLE_BYTES];
    let mut hasher = FastHasher::new(0);
    if size <= QUICK_FULL_LIMIT {
        loop {
            let read = file.read(buffer)?;
            if read == 0 {
                break;
            }
            hasher.write(&buffer[..read]);
        }
        return Ok((hasher.finish(), true));
    }
    file.seek(SeekFrom::Start(QUICK_SAMPLE_OFFSET))?;
    let read = read_full(&mut file, buffer)?;
    hasher.write(&buffer[..read]);
    Ok((hasher.finish(), false))
}

fn content_hash_file_sample_with_buffer(
    path: &Path,
    size: u64,
    buffer: &mut [u8],
) -> io::Result<u64> {
    let mut file = File::open(path)?;
    let buffer = &mut buffer[..SAMPLE_BYTES];
    let mut hasher = FastHasher::new(0);

    if size <= FULL_SAMPLE_LIMIT {
        loop {
            let read = file.read(buffer)?;
            if read == 0 {
                break;
            }
            hasher.write(&buffer[..read]);
        }
        return Ok(hasher.finish());
    }

    let read = read_full(&mut file, buffer)?;
    hasher.write(&buffer[..read]);

    let middle = size
        .saturating_div(2)
        .saturating_sub((SAMPLE_BYTES as u64) / 2);
    file.seek(SeekFrom::Start(middle))?;
    let read = read_full(&mut file, buffer)?;
    hasher.write(&buffer[..read]);

    file.seek(SeekFrom::End(-(SAMPLE_BYTES as i64)))?;
    let read = read_full(&mut file, buffer)?;
    hasher.write(&buffer[..read]);

    Ok(hasher.finish())
}

// ── Candidate-list hash engine (POST /api/dupes-hash) ───────────────────────
//
// The dedicated Duplicates page aggregates candidate file metadata on the
// client (from already-scanned tabs + caches) and posts only the size-collision
// candidates here, so this engine NEVER walks the filesystem. It groups by size,
// uses a persistent `(path,size,mtime)->hash` cache, hashes uncached candidates
// in parallel (16 KiB quick fingerprint, three-region sample, then a full fast
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
    let mut fa = open_sequential(a)?;
    let mut fb = open_sequential(b)?;
    let mut ba = vec![0u8; HASH_BUFFER_BYTES];
    let mut bb = vec![0u8; HASH_BUFFER_BYTES];
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

fn is_reparse_metadata(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(windows)]
fn lock_keeper_for_action(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0)
        .open(path)
}

#[cfg(not(windows))]
fn lock_keeper_for_action(path: &Path) -> io::Result<File> {
    File::open(path)
}

pub(crate) fn verified_duplicate_pair(original: &Path, duplicate: &Path) -> Result<bool, String> {
    let original_meta = fs::symlink_metadata(original)
        .map_err(|error| format!("{}: {error}", original.display()))?;
    let duplicate_meta = fs::symlink_metadata(duplicate)
        .map_err(|error| format!("{}: {error}", duplicate.display()))?;
    if !original_meta.is_file()
        || !duplicate_meta.is_file()
        || is_reparse_metadata(&original_meta)
        || is_reparse_metadata(&duplicate_meta)
    {
        return Err(format!(
            "{}: duplicate actions require regular non-link files",
            duplicate.display()
        ));
    }
    if original_meta.len() != duplicate_meta.len() {
        return Ok(false);
    }
    files_identical(original, duplicate).map_err(|error| {
        format!(
            "{}: could not revalidate file: {error}",
            duplicate.display()
        )
    })
}

/// Partition a set of same-size, same-hash candidate indices into byte-identical
/// equivalence classes. Virtually always returns a single class, but guards
/// against hash collisions when the caller asked for byte confirmation.
fn byte_confirm_partition(
    indices: &[usize],
    files: &[HashInput],
    errors: &Mutex<Vec<String>>,
) -> Vec<Vec<usize>> {
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
                    errors.lock().expect("hash errors lock").push(format!(
                        "{}: {}",
                        files[idx].path.display(),
                        e
                    ));
                    continue 'outer;
                }
            }
        }
        classes.push(vec![idx]);
    }
    classes
}

/// Run `work` items across up to `threads` workers. `init` creates reusable
/// worker-local state (notably read buffers), avoiding a large allocation and
/// zero-fill for every file. Scoped threads let the callbacks borrow inputs.
fn parallel_for_with_state<S, I, F>(
    count: usize,
    threads: usize,
    cancel: Option<&Arc<AtomicBool>>,
    init: I,
    f: F,
) where
    S: Send,
    I: Fn() -> S + Sync,
    F: Fn(usize, &mut S) + Sync,
{
    if count == 0 {
        return;
    }
    let workers = threads.clamp(1, 64).min(count);
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                let mut state = init();
                loop {
                    if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= count {
                        break;
                    }
                    f(i, &mut state);
                }
            });
        }
    });
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct HashCandidateProgress {
    pub(crate) fraction: f64,
    pub(crate) stage: &'static str,
    pub(crate) bytes_read: u64,
    pub(crate) completed: usize,
    pub(crate) total: usize,
}

/// The single parallel duplicate-detection pipeline shared by every endpoint:
/// size-grouping -> 16 KiB quick fingerprint -> head/middle/tail sample -> full
/// fast hash only for sample-colliding groups, reusing `(path,size,mtime)->hash`
/// cache. Returns one `(full_hash, indices_into_files)` entry per duplicate
/// group plus any per-file errors. When `cache_path` is set, newly-computed
/// hashes are appended to the on-disk cache incrementally (survives restarts).
#[allow(clippy::too_many_arguments)]
pub(crate) fn hash_candidate_groups(
    files: &[HashInput],
    confirm_bytes: bool,
    cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    cache_path: Option<&Path>,
    progress: Option<&Arc<DupesProgress>>,
    cancel: Option<&Arc<AtomicBool>>,
    threads: usize,
    candidate_progress: Option<&(dyn Fn(HashCandidateProgress) + Sync)>,
) -> (Vec<(u64, Vec<usize>)>, Vec<String>) {
    hash_candidate_groups_with_fingerprints(
        files,
        confirm_bytes,
        cache,
        cache_path,
        progress,
        cancel,
        threads,
        candidate_progress,
        None,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FingerprintEntry {
    pub size: u64,
    pub mtime: u64,
    pub quick: Option<u64>,
    pub sample: Option<u64>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn hash_candidate_groups_with_fingerprints(
    files: &[HashInput],
    confirm_bytes: bool,
    cache: &Mutex<HashMap<PathBuf, HashCacheEntry>>,
    cache_path: Option<&Path>,
    progress: Option<&Arc<DupesProgress>>,
    cancel: Option<&Arc<AtomicBool>>,
    threads: usize,
    candidate_progress: Option<&(dyn Fn(HashCandidateProgress) + Sync)>,
    fingerprints: Option<&Mutex<HashMap<PathBuf, FingerprintEntry>>>,
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
                if let Some(entry) = guard.get(&files[i].path)
                    && entry.size == files[i].size
                    && entry.mtime == files[i].mtime
                {
                    full_hash[i] = Some(entry.hash);
                }
            }
        }
    }

    // Snapshot valid fingerprints once; worker threads never hold a cache lock
    // while reading. Partial values are rejection filters, never full hashes.
    let saved_fingerprints = fingerprints
        .map(|cache| {
            let cache = cache.lock().expect("fingerprint cache lock");
            files
                .iter()
                .map(|file| {
                    cache
                        .get(&file.path)
                        .copied()
                        .filter(|entry| entry.size == file.size && entry.mtime == file.mtime)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![None; files.len()]);

    let errors: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let bytes_read = AtomicU64::new(0);
    let hash_bytes_total = AtomicU64::new(0);
    let reported_pipeline = Mutex::new((0usize, "", std::time::Instant::now()));
    let report_pipeline = |stage: &'static str, completed: usize, stage_fraction: f64| {
        let Some(callback) = candidate_progress else {
            return;
        };
        let completed = completed.min(files.len());
        let step = (files.len() / 200).max(1);
        let mut reported = reported_pipeline.lock().expect("candidate progress lock");
        if (stage != reported.1
            || stage_fraction >= 1.0
            || (completed >= files.len() && reported.0 < files.len())
            || reported.2.elapsed() >= std::time::Duration::from_millis(200)
            || completed.saturating_sub(reported.0) >= step)
            && completed >= reported.0
        {
            *reported = (completed, stage, std::time::Instant::now());
            let total_bytes = hash_bytes_total.load(Ordering::Relaxed);
            let fraction = if stage == "hashing" && total_bytes > 0 {
                (bytes_read.load(Ordering::Relaxed) as f64 / total_bytes as f64).min(1.0)
            } else {
                stage_fraction
            };
            callback(HashCandidateProgress {
                fraction,
                stage,
                bytes_read: bytes_read.load(Ordering::Relaxed),
                completed,
                total: files.len(),
            });
        }
    };

    // 3. dupeGuru-style quick fingerprint: read only 16 KiB at a 16 KiB offset
    //    before the wider head/middle/tail sample. In a mostly warm bucket,
    //    full-hashing a few misses can be cheaper than reopening every cached
    //    member just to make their partial fingerprints comparable.
    let mut need_full: Vec<usize> = Vec::new();
    let mut staged_buckets = vec![false; buckets.len()];
    for (bucket_index, bucket) in buckets.iter().enumerate() {
        let missing = bucket
            .iter()
            .copied()
            .filter(|&index| full_hash[index].is_none())
            .collect::<Vec<_>>();
        if missing.is_empty() {
            continue;
        }
        let cached_count = bucket.len().saturating_sub(missing.len());
        let size = files[bucket[0]].size;
        let cached_probe_per_file = if size <= QUICK_FULL_LIMIT {
            size
        } else {
            QUICK_SAMPLE_BYTES as u64
        };
        let direct_read_bytes = (size as u128).saturating_mul(missing.len() as u128);
        let cached_probe_bytes =
            (cached_probe_per_file as u128).saturating_mul(cached_count as u128);
        if cached_count > 0 && direct_read_bytes <= cached_probe_bytes {
            need_full.extend(missing);
        } else {
            staged_buckets[bucket_index] = true;
        }
    }
    let quick_candidates = buckets
        .iter()
        .enumerate()
        .filter(|(index, _)| staged_buckets[*index])
        .flat_map(|(_, bucket)| bucket)
        .copied()
        .collect::<Vec<_>>();
    let quick_fp: Vec<AtomicU64> = (0..files.len()).map(|_| AtomicU64::new(0)).collect();
    let quick_done: Vec<AtomicBool> = (0..files.len()).map(|_| AtomicBool::new(false)).collect();
    let quick_completed = AtomicUsize::new(0);
    let quick_progress_end = if quick_candidates.is_empty() {
        0
    } else {
        files.len() / 3
    };
    if !quick_candidates.is_empty() {
        report_pipeline("fingerprinting", 0, 0.0);
    }
    parallel_for_with_state(
        quick_candidates.len(),
        threads,
        cancel,
        || vec![0u8; QUICK_SAMPLE_BYTES],
        |k, buffer| {
            let i = quick_candidates[k];
            let result = match saved_fingerprints[i].and_then(|entry| entry.quick) {
                Some(hash) => Ok((hash, files[i].size <= QUICK_FULL_LIMIT)),
                None => content_hash_file_quick_with_buffer(&files[i].path, files[i].size, buffer),
            };
            match result {
                Ok((fingerprint, _is_full)) => {
                    quick_fp[i].store(fingerprint, Ordering::Relaxed);
                    quick_done[i].store(true, Ordering::Relaxed);
                }
                Err(error) => errors
                    .lock()
                    .expect("hash errors lock")
                    .push(format!("{}: {error}", files[i].path.display())),
            }
            let stage_done = quick_completed.fetch_add(1, Ordering::Relaxed) + 1;
            report_pipeline(
                "fingerprinting",
                quick_progress_end
                    .saturating_mul(stage_done)
                    .saturating_div(quick_candidates.len()),
                stage_done as f64 / quick_candidates.len() as f64,
            );
        },
    );
    if !quick_candidates.is_empty() {
        report_pipeline("fingerprinting", quick_progress_end, 1.0);
    }
    if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
        return (Vec::new(), Vec::new());
    }

    let mut sampled_full: Vec<(usize, u64)> = Vec::new();
    let mut sample_candidates: Vec<usize> = Vec::new();
    for (bucket_index, bucket) in buckets.iter().enumerate() {
        if !staged_buckets[bucket_index] {
            continue;
        }
        let mut by_quick: HashMap<u64, Vec<usize>> = HashMap::new();
        for &i in bucket {
            if quick_done[i].load(Ordering::Relaxed) {
                by_quick
                    .entry(quick_fp[i].load(Ordering::Relaxed))
                    .or_default()
                    .push(i);
            }
        }
        for (quick, members) in by_quick {
            // A quick read covers small files completely, even when their
            // fingerprint is unique. Retain that hash for the next scan.
            if files[members[0]].size <= QUICK_FULL_LIMIT {
                for i in members {
                    if full_hash[i].is_none() {
                        full_hash[i] = Some(quick);
                        sampled_full.push((i, quick));
                    }
                }
            } else if members.len() > 1 && members.iter().any(|&i| full_hash[i].is_none()) {
                sample_candidates.extend(members);
            }
        }
    }

    // 4. Wider three-region sample. This remains a rejection filter only:
    //    colliding large files continue to a full hash before they are grouped.
    let sample_fp: Vec<AtomicU64> = (0..files.len()).map(|_| AtomicU64::new(0)).collect();
    let sample_done: Vec<AtomicBool> = (0..files.len()).map(|_| AtomicBool::new(false)).collect();
    let sample_completed = AtomicUsize::new(0);
    let sample_progress_end = if sample_candidates.is_empty() {
        quick_progress_end
    } else {
        quick_progress_end.saturating_add(files.len().saturating_sub(quick_progress_end) / 2)
    };
    if !sample_candidates.is_empty() {
        report_pipeline("sampling", quick_progress_end, 0.0);
    }
    parallel_for_with_state(
        sample_candidates.len(),
        threads,
        cancel,
        || vec![0u8; SAMPLE_BYTES],
        |k, buffer| {
            let i = sample_candidates[k];
            let result = match saved_fingerprints[i].and_then(|entry| entry.sample) {
                Some(hash) => Ok(hash),
                None => content_hash_file_sample_with_buffer(&files[i].path, files[i].size, buffer),
            };
            match result {
                Ok(fingerprint) => {
                    sample_fp[i].store(fingerprint, Ordering::Relaxed);
                    sample_done[i].store(true, Ordering::Relaxed);
                }
                Err(error) => errors
                    .lock()
                    .expect("hash errors lock")
                    .push(format!("{}: {error}", files[i].path.display())),
            }
            let stage_done = sample_completed.fetch_add(1, Ordering::Relaxed) + 1;
            report_pipeline(
                "sampling",
                quick_progress_end.saturating_add(
                    sample_progress_end
                        .saturating_sub(quick_progress_end)
                        .saturating_mul(stage_done)
                        .saturating_div(sample_candidates.len()),
                ),
                stage_done as f64 / sample_candidates.len() as f64,
            );
        },
    );
    if !sample_candidates.is_empty() {
        report_pipeline("sampling", sample_progress_end, 1.0);
    }
    if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
        return (Vec::new(), Vec::new());
    }

    for (bucket_index, bucket) in buckets.iter().enumerate() {
        if !staged_buckets[bucket_index] {
            continue;
        }
        let mut by_sample: HashMap<u64, Vec<usize>> = HashMap::new();
        for &i in bucket {
            if sample_done[i].load(Ordering::Relaxed) {
                by_sample
                    .entry(sample_fp[i].load(Ordering::Relaxed))
                    .or_default()
                    .push(i);
            }
        }
        for (sample, members) in by_sample {
            // Full-file samples are reusable even when they reject a candidate.
            if files[members[0]].size <= FULL_SAMPLE_LIMIT {
                for i in members {
                    if full_hash[i].is_none() {
                        full_hash[i] = Some(sample);
                        sampled_full.push((i, sample));
                    }
                }
            } else if members.len() > 1 {
                need_full.extend(members.into_iter().filter(|&i| full_hash[i].is_none()));
            }
        }
    }

    if let Some(p) = progress {
        p.files_hashing
            .store(need_full.len() as u64, Ordering::Relaxed);
        p.files_hashed.store(0, Ordering::Relaxed);
    }

    // 5. Full-hash phase (parallel). Counts retain their pipeline position;
    //    the displayed fraction measures this stage's bytes independently.
    let full_progress_start = sample_progress_end.max(quick_progress_end);
    let full_completed = AtomicUsize::new(0);
    hash_bytes_total.store(
        need_full
            .iter()
            .fold(0u64, |sum, &i| sum.saturating_add(files[i].size)),
        Ordering::Relaxed,
    );
    if !need_full.is_empty() {
        report_pipeline("hashing", full_progress_start, 0.0);
    }
    let computed: Mutex<Vec<(usize, u64)>> = Mutex::new(Vec::new());
    parallel_for_with_state(
        need_full.len(),
        threads,
        cancel,
        || vec![0u8; HASH_BUFFER_BYTES],
        |k, buffer| {
            let i = need_full[k];
            match content_hash_file_reporting(&files[i].path, buffer, cancel, |read| {
                bytes_read.fetch_add(read, Ordering::Relaxed);
                report_pipeline(
                    "hashing",
                    full_progress_start.saturating_add(
                        files
                            .len()
                            .saturating_sub(full_progress_start)
                            .saturating_mul(full_completed.load(Ordering::Relaxed))
                            .saturating_div(need_full.len()),
                    ),
                    full_completed.load(Ordering::Relaxed) as f64 / need_full.len() as f64,
                );
            }) {
                Ok(h) => computed.lock().expect("computed lock").push((i, h)),
                Err(e) => errors.lock().expect("hash errors lock").push(format!(
                    "{}: {}",
                    files[i].path.display(),
                    e
                )),
            }
            if let Some(p) = progress {
                p.files_hashed.fetch_add(1, Ordering::Relaxed);
            }
            let stage_done = full_completed.fetch_add(1, Ordering::Relaxed) + 1;
            report_pipeline(
                "hashing",
                full_progress_start.saturating_add(
                    files
                        .len()
                        .saturating_sub(full_progress_start)
                        .saturating_mul(stage_done)
                        .saturating_div(need_full.len()),
                ),
                stage_done as f64 / need_full.len() as f64,
            );
        },
    );
    if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
        return (Vec::new(), Vec::new());
    }
    report_pipeline(
        if need_full.is_empty() {
            "finalizing"
        } else {
            "hashing"
        },
        files.len(),
        1.0,
    );

    let mut computed = computed.into_inner().expect("computed lock");
    computed.extend(sampled_full);
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

    if let Some(cache) = fingerprints {
        let mut cache = cache.lock().expect("fingerprint cache lock");
        for i in 0..files.len() {
            // Small complete reads already enter the full-hash cache.
            if files[i].size <= FULL_SAMPLE_LIMIT {
                continue;
            }
            if !quick_done[i].load(Ordering::Relaxed) && !sample_done[i].load(Ordering::Relaxed) {
                continue;
            }
            let saved = saved_fingerprints[i];
            cache.insert(
                files[i].path.clone(),
                FingerprintEntry {
                    size: files[i].size,
                    mtime: files[i].mtime,
                    quick: if quick_done[i].load(Ordering::Relaxed) {
                        Some(quick_fp[i].load(Ordering::Relaxed))
                    } else {
                        saved.and_then(|entry| entry.quick)
                    },
                    sample: if sample_done[i].load(Ordering::Relaxed) {
                        Some(sample_fp[i].load(Ordering::Relaxed))
                    } else {
                        saved.and_then(|entry| entry.sample)
                    },
                },
            );
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
        .map(|f| HashInput {
            path: f.path.clone(),
            size: f.size,
            mtime: f.modified,
        })
        .collect();
    let (groups, _errors) = hash_candidate_groups(
        &inputs, false, cache, cache_path, progress, cancel, threads, None,
    );
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
pub(crate) fn append_hash_cache(
    path: &Path,
    entries: &[(PathBuf, HashCacheEntry)],
) -> io::Result<()> {
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
    let Ok(raw) = fs::read_to_string(path) else {
        return (map, false);
    };
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
            map.insert(
                key,
                HashCacheEntry {
                    size,
                    mtime,
                    hash,
                    seq: next_hash_cache_seq(),
                },
            );
        }
    }
    let should_compact = capped || rows > map.len();
    (map, should_compact)
}

/// Persist (compact) the whole hash cache as a JSON array of
/// `["path", size, mtime, hash]` rows. This is the full-rewrite/compaction path;
/// steady-state growth uses the cheaper incremental `append_hash_cache`.
pub(crate) fn save_hash_cache(
    path: &Path,
    cache: &HashMap<PathBuf, HashCacheEntry>,
) -> io::Result<()> {
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

pub(crate) fn build_candidates_from_nodes(
    nodes: &[NodeRecord],
    filter: &DupeFilter2,
) -> Vec<DupeFileV2> {
    nodes
        .iter()
        .filter(|n| !n.is_dir && n.size >= filter.min_size.max(1))
        .filter(|n| filter.max_size.is_none_or(|max| n.size <= max))
        .filter(|n| {
            filter.extensions.is_empty() || filter.extensions.contains(&n.extension.to_lowercase())
        })
        .map(|n| DupeFileV2 {
            // Files no longer store their absolute path (interned away to cut
            // scan memory); reconstruct it from the parent directory + name.
            path: PathBuf::from(node_abs_path(nodes, n.id)),
            name: n.name.clone(),
            size: n.size,
            modified: (n.modified_ms / 1000),
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
            let ext_a = files[a]
                .path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let ext_b = files[b]
                .path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
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
                    let s = s
                        .iter()
                        .take_while(|&&b| b != 0)
                        .cloned()
                        .collect::<Vec<u8>>();
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
            if f.read_exact(&mut sb).is_err() {
                break;
            }
            syncsafe_to_u32(&sb)
        } else {
            let mut sb = [0u8; 4];
            if f.read_exact(&mut sb).is_err() {
                break;
            }
            u32::from_be_bytes(sb)
        };
        let mut flags = [0u8; 2];
        if f.read_exact(&mut flags).is_err() {
            break;
        }

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
        if data.is_empty() {
            continue;
        }
        let encoding = data[0];
        let text_bytes = &data[1..];
        let text = match encoding {
            1 => {
                // UTF-16 with BOM
                if text_bytes.len() < 2 {
                    continue;
                }
                let is_le = text_bytes[0] == 0xFF && text_bytes[1] == 0xFE;
                let start = if text_bytes[0] == 0xFF || text_bytes[0] == 0xFE {
                    2
                } else {
                    0
                };
                let words: Vec<u16> = text_bytes[start..]
                    .chunks(2)
                    .filter(|c| c.len() == 2)
                    .map(|c| {
                        if is_le {
                            u16::from_le_bytes([c[0], c[1]])
                        } else {
                            u16::from_be_bytes([c[0], c[1]])
                        }
                    })
                    .take_while(|&w| w != 0)
                    .collect();
                String::from_utf16_lossy(&words).trim().to_string()
            }
            3 => {
                // UTF-8
                let end = text_bytes
                    .iter()
                    .position(|&b| b == 0)
                    .unwrap_or(text_bytes.len());
                String::from_utf8_lossy(&text_bytes[..end])
                    .trim()
                    .to_string()
            }
            _ => {
                // Latin-1
                let end = text_bytes
                    .iter()
                    .position(|&b| b == 0)
                    .unwrap_or(text_bytes.len());
                text_bytes[..end]
                    .iter()
                    .map(|&b| b as char)
                    .collect::<String>()
                    .trim()
                    .to_string()
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
                .map(|&t| tags.get(t).map(|v| get_words(v)).unwrap_or_default())
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
                    if m == a {
                        return true;
                    }
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
                    if m == b {
                        return true;
                    }
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

            DupeGroupV2 {
                files: file_objs,
                score: group_score,
                waste,
            }
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
            "largest" => Some(Self::Largest),
            "smallest" => Some(Self::Smallest),
            "newest" => Some(Self::Newest),
            "oldest" => Some(Self::Oldest),
            "shortestPath" => Some(Self::ShortestPath),
            "longestPath" => Some(Self::LongestPath),
            "alphaFirst" => Some(Self::AlphaFirst),
            "alphaLast" => Some(Self::AlphaLast),
            _ => None,
        }
    }
}

pub(crate) fn reprioritize(groups: &mut [DupeGroupV2], criterion: ReprioritizeCriterion) {
    for group in groups.iter_mut() {
        group.files.sort_by(|a, b| match criterion {
            ReprioritizeCriterion::Largest => b.size.cmp(&a.size),
            ReprioritizeCriterion::Smallest => a.size.cmp(&b.size),
            ReprioritizeCriterion::Newest => b.modified.cmp(&a.modified),
            ReprioritizeCriterion::Oldest => a.modified.cmp(&b.modified),
            ReprioritizeCriterion::ShortestPath => {
                a.path.as_os_str().len().cmp(&b.path.as_os_str().len())
            }
            ReprioritizeCriterion::LongestPath => {
                b.path.as_os_str().len().cmp(&a.path.as_os_str().len())
            }
            ReprioritizeCriterion::AlphaFirst => a.name.cmp(&b.name),
            ReprioritizeCriterion::AlphaLast => b.name.cmp(&a.name),
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
            op: if permanent {
                "permanent-delete"
            } else {
                "delete"
            },
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

static DUPLICATE_ACTION_SEQ: AtomicU64 = AtomicU64::new(1);

fn duplicate_stage_path(path: &Path, operation: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{}: path has no parent folder", path.display()))?;
    for _ in 0..32 {
        let sequence = DUPLICATE_ACTION_SEQ.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".filetree-{operation}-{}-{sequence}.tmp",
            std::process::id()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "{}: could not allocate a temporary action path",
        path.display()
    ))
}

fn rollback_staged_file(staged: &Path, original: &Path, error: String) -> String {
    match fs::rename(staged, original) {
        Ok(()) => error,
        Err(rollback_error) => format!("{error}; rollback also failed: {rollback_error}"),
    }
}

fn stage_verified_duplicate(
    keeper: &Path,
    duplicate: &Path,
    operation: &str,
) -> Result<(PathBuf, File), String> {
    let keeper_lock = lock_keeper_for_action(keeper)
        .map_err(|error| format!("{}: could not lock keeper: {error}", keeper.display()))?;
    match verified_duplicate_pair(keeper, duplicate)? {
        true => {}
        false => {
            return Err(format!(
                "{}: file changed since the duplicate scan",
                duplicate.display()
            ));
        }
    }
    let staged = duplicate_stage_path(duplicate, operation)?;
    fs::rename(duplicate, &staged)
        .map_err(|error| format!("{}: could not stage file: {error}", duplicate.display()))?;
    match verified_duplicate_pair(keeper, &staged) {
        Ok(true) => Ok((staged, keeper_lock)),
        Ok(false) => Err(rollback_staged_file(
            &staged,
            duplicate,
            format!(
                "{}: staged file no longer matches its keeper",
                duplicate.display()
            ),
        )),
        Err(error) => Err(rollback_staged_file(&staged, duplicate, error)),
    }
}

fn recycle_reviewed_with(
    keeper: &Path,
    duplicate: &Path,
    recycle: impl FnOnce(&Path) -> Vec<String>,
) -> Vec<String> {
    let _keeper_lock = match lock_keeper_for_action(keeper) {
        Ok(lock) => lock,
        Err(error) => {
            return vec![format!(
                "{}: could not lock keeper: {error}",
                keeper.display()
            )];
        }
    };
    recycle(duplicate)
}

pub(crate) fn action_recycle_reviewed(keeper: &Path, duplicate: &Path) -> Vec<String> {
    recycle_reviewed_with(keeper, duplicate, |path| {
        action_delete(&[path.to_path_buf()], false)
    })
}

pub(crate) fn action_delete_verified(
    keeper: &Path,
    duplicate: &Path,
    permanent: bool,
) -> Vec<String> {
    if !permanent {
        let _keeper_lock = match lock_keeper_for_action(keeper) {
            Ok(lock) => lock,
            Err(error) => {
                return vec![format!(
                    "{}: could not lock keeper: {error}",
                    keeper.display()
                )];
            }
        };
        return match verified_duplicate_pair(keeper, duplicate) {
            Ok(true) => action_delete(&[duplicate.to_path_buf()], false),
            Ok(false) => vec![format!(
                "{}: file changed since the duplicate scan",
                duplicate.display()
            )],
            Err(error) => vec![error],
        };
    }

    let (staged, _keeper_lock) = match stage_verified_duplicate(keeper, duplicate, "delete") {
        Ok(value) => value,
        Err(error) => return vec![error],
    };
    let result = crate::recycle::delete_path_permanent(&staged);
    let error = result
        .as_ref()
        .err()
        .map(|value| crate::preflight::describe_fs_error(value, duplicate));
    let duplicate_text = duplicate.to_string_lossy().into_owned();
    crate::audit::record(crate::audit::Entry {
        op: "permanent-delete",
        disposition: "permanent",
        src: std::slice::from_ref(&duplicate_text),
        error: error.as_deref(),
        by: "server",
        ..Default::default()
    });
    match error {
        None => Vec::new(),
        Some(error) => vec![rollback_staged_file(&staged, duplicate, error)],
    }
}

pub(crate) fn action_transfer_verified(
    action: &str,
    keeper: &Path,
    duplicate: &Path,
    destination: &Path,
) -> Vec<String> {
    if action == "copy" {
        let _keeper_lock = match lock_keeper_for_action(keeper) {
            Ok(lock) => lock,
            Err(error) => {
                return vec![format!(
                    "{}: could not lock keeper: {error}",
                    keeper.display()
                )];
            }
        };
        return match verified_duplicate_pair(keeper, duplicate) {
            Ok(true) => {
                let Some(name) = duplicate.file_name() else {
                    return vec![format!("{}: source has no file name", duplicate.display())];
                };
                action_copy(&[(duplicate.to_path_buf(), destination.join(name))])
            }
            Ok(false) => vec![format!(
                "{}: file changed since the duplicate scan",
                duplicate.display()
            )],
            Err(error) => vec![error],
        };
    }
    if action != "move" {
        return vec!["Unknown duplicate transfer action".to_string()];
    }
    let (staged, _keeper_lock) = match stage_verified_duplicate(keeper, duplicate, "move") {
        Ok(value) => value,
        Err(error) => return vec![error],
    };
    let Some(name) = duplicate.file_name() else {
        return vec![rollback_staged_file(
            &staged,
            duplicate,
            format!("{}: source has no file name", duplicate.display()),
        )];
    };
    let errors = action_move(&[(staged.clone(), destination.join(name))]);
    if errors.is_empty() {
        return errors;
    }
    if staged.exists() {
        vec![rollback_staged_file(&staged, duplicate, errors.join("; "))]
    } else {
        errors
    }
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
    if let (Ok(s), Some(parent)) = (fs::canonicalize(src_dir), dst.parent())
        && let Ok(p) = fs::canonicalize(parent)
    {
        return p == s || p.starts_with(&s);
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

#[cfg(windows)]
fn copy_file_exclusive(src: &Path, dst: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::CopyFileW;
    use windows::core::PCWSTR;

    let source = src
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = dst
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe { CopyFileW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), true) }
        .map_err(|error| io::Error::from_raw_os_error(error.code().0 & 0xffff))?;
    Ok(fs::metadata(dst)?.len())
}

#[cfg(not(windows))]
fn copy_file_exclusive(src: &Path, dst: &Path) -> io::Result<u64> {
    let mut source = File::open(src)?;
    let mut destination = OpenOptions::new().write(true).create_new(true).open(dst)?;
    let copied = match io::copy(&mut source, &mut destination) {
        Ok(copied) => copied,
        Err(error) => {
            drop(destination);
            let _ = fs::remove_file(dst);
            return Err(error);
        }
    };
    if let Err(error) = destination.flush() {
        drop(destination);
        let _ = fs::remove_file(dst);
        return Err(error);
    }
    if let Ok(metadata) = fs::metadata(src)
        && let Err(error) = fs::set_permissions(dst, metadata.permissions())
    {
        drop(destination);
        let _ = fs::remove_file(dst);
        return Err(error);
    }
    Ok(copied)
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
        if let Some(parent) = dst.parent()
            && let Err(e) = fs::create_dir_all(parent)
        {
            errors.push(format!("{}: {}", dst.display(), e));
            continue;
        }
        // Keep-both on collision: route to a unique name rather than overwrite.
        let target = if dst.exists() {
            unique_dst(dst)
        } else {
            dst.clone()
        };
        // Try atomic rename first; fall back to copy + remove for cross-device.
        // Pre-flight the destination's free space before starting a copy we
        // might not be able to finish (Phase 3).
        let result: io::Result<()> = match fs::rename(src, &target) {
            Ok(_) => Ok(()),
            Err(error) if matches!(error.raw_os_error(), Some(17 | 18)) => {
                let dest_dir = target.parent().unwrap_or(target.as_path());
                if let Err(message) = crate::preflight::ensure_space_for_copy(src, dest_dir) {
                    Err(io::Error::other(message))
                } else {
                    copy_file_exclusive(src, &target).and_then(|_| {
                        if let Err(remove_error) = fs::remove_file(src) {
                            if let Err(cleanup_error) = fs::remove_file(&target) {
                                return Err(io::Error::other(format!(
                                    "{remove_error}; copied destination cleanup also failed: {cleanup_error}"
                                )));
                            }
                            return Err(remove_error);
                        }
                        Ok(())
                    })
                }
            }
            Err(error) => Err(error),
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
        if let Some(parent) = dst.parent()
            && let Err(e) = fs::create_dir_all(parent)
        {
            errors.push(format!("{}: {}", dst.display(), e));
            continue;
        }
        let target = if dst.exists() {
            unique_dst(dst)
        } else {
            dst.clone()
        };
        // Pre-flight the destination's free space before starting the copy
        // (Phase 3) — don't begin a copy we can't finish.
        let dest_dir = target.parent().unwrap_or(target.as_path());
        let result: io::Result<()> = match crate::preflight::ensure_space_for_copy(src, dest_dir) {
            Err(message) => Err(io::Error::other(message)),
            Ok(()) => copy_file_exclusive(src, &target).map(|_| ()),
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

static LINK_BACKUP_SEQ: AtomicU64 = AtomicU64::new(1);

fn create_duplicate_link(original: &Path, link: &Path, symbolic: bool) -> io::Result<()> {
    if !symbolic {
        return fs::hard_link(original, link);
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(original, link)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(original, link)
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (original, link);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Symbolic links are not supported on this platform",
        ))
    }
}

/// Replace duplicate files with hard/symbolic links to their kept originals.
/// The duplicate is renamed out of the way first; link creation is rolled back
/// on failure, and the backup is recycled (or permanently deleted) only after
/// the replacement exists.
pub(crate) fn action_link(
    pairs: &[(PathBuf, PathBuf)],
    symbolic: bool,
    permanent: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    for (original, link) in pairs {
        let _keeper_lock = match lock_keeper_for_action(original) {
            Ok(lock) => lock,
            Err(error) => {
                errors.push(format!(
                    "{}: could not lock keeper: {error}",
                    original.display()
                ));
                continue;
            }
        };
        if same_file(original, link) {
            continue;
        }
        match verified_duplicate_pair(original, link) {
            Ok(true) => {}
            Ok(false) => {
                errors.push(format!(
                    "{}: file changed since the duplicate scan; link replacement was skipped",
                    link.display()
                ));
                continue;
            }
            Err(error) => {
                errors.push(error);
                continue;
            }
        }

        let Some(parent) = link.parent() else {
            errors.push(format!(
                "{}: duplicate has no parent folder",
                link.display()
            ));
            continue;
        };
        let sequence = LINK_BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
        let backup = parent.join(format!(
            ".filetree-link-{}-{sequence}.bak",
            std::process::id()
        ));
        let temporary_link = parent.join(format!(
            ".filetree-link-{}-{sequence}.pending",
            std::process::id()
        ));

        if let Err(error) = fs::rename(link, &backup) {
            errors.push(format!(
                "{}: could not stage duplicate: {error}",
                link.display()
            ));
            continue;
        }

        match verified_duplicate_pair(original, &backup) {
            Ok(true) => {}
            Ok(false) => {
                let rollback = fs::rename(&backup, link);
                let suffix = rollback
                    .err()
                    .map(|error| format!("; rollback also failed: {error}"))
                    .unwrap_or_default();
                errors.push(format!(
                    "{}: staged file changed during validation{suffix}",
                    link.display()
                ));
                continue;
            }
            Err(error) => {
                let rollback = fs::rename(&backup, link);
                let suffix = rollback
                    .err()
                    .map(|rollback_error| format!("; rollback also failed: {rollback_error}"))
                    .unwrap_or_default();
                errors.push(format!("{error}{suffix}"));
                continue;
            }
        }

        if let Err(error) = create_duplicate_link(original, &temporary_link, symbolic) {
            let rollback = fs::rename(&backup, link);
            let suffix = rollback
                .err()
                .map(|rollback_error| format!("; rollback also failed: {rollback_error}"))
                .unwrap_or_default();
            errors.push(format!(
                "{}: could not create replacement link: {error}{suffix}",
                link.display()
            ));
            continue;
        }

        match files_identical(&backup, &temporary_link) {
            Ok(true) => {}
            Ok(false) => {
                let _ = fs::remove_file(&temporary_link);
                let rollback = fs::rename(&backup, link);
                let suffix = rollback
                    .err()
                    .map(|error| format!("; rollback also failed: {error}"))
                    .unwrap_or_default();
                errors.push(format!(
                    "{}: keeper changed while the replacement link was created{suffix}",
                    link.display()
                ));
                continue;
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary_link);
                let rollback = fs::rename(&backup, link);
                let suffix = rollback
                    .err()
                    .map(|rollback_error| format!("; rollback also failed: {rollback_error}"))
                    .unwrap_or_default();
                errors.push(format!(
                    "{}: could not verify replacement link: {error}{suffix}",
                    link.display()
                ));
                continue;
            }
        }

        if let Err(error) = fs::rename(&temporary_link, link) {
            let _ = fs::remove_file(&temporary_link);
            let rollback = fs::rename(&backup, link);
            let suffix = rollback
                .err()
                .map(|rollback_error| format!("; rollback also failed: {rollback_error}"))
                .unwrap_or_default();
            errors.push(format!(
                "{}: could not install replacement link: {error}{suffix}",
                link.display()
            ));
            continue;
        }

        let dispose = if permanent {
            crate::recycle::delete_permanent(&backup)
        } else {
            crate::recycle::recycle_path(&backup)
        };
        if let Err(error) = dispose {
            let rollback = fs::remove_file(link).and_then(|_| fs::rename(&backup, link));
            let suffix = rollback
                .err()
                .map(|rollback_error| format!("; rollback also failed: {rollback_error}"))
                .unwrap_or_default();
            let verb = if permanent { "deleted" } else { "recycled" };
            errors.push(format!(
                "{}: staged duplicate could not be {verb} ({error}){suffix}",
                link.display(),
            ));
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
        self.pairs
            .entry(a.to_owned())
            .or_default()
            .insert(b.to_owned());
        self.pairs
            .entry(b.to_owned())
            .or_default()
            .insert(a.to_owned());
    }

    pub(crate) fn are_ignored(&self, a: &Path, b: &Path) -> bool {
        self.pairs.get(a).is_some_and(|s| s.contains(b))
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
                    if !first {
                        out.push_str(",\n");
                    }
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
        ScanMode::Exact => "exact",
        ScanMode::Filename => "filename",
        ScanMode::Audio => "audio",
    };
    let mut out = String::new();
    out.push_str("{\"mode\":");
    push_json_string(&mut out, mode_str);
    out.push_str(",\"groups\":[");
    for (gi, group) in groups.iter().enumerate() {
        if gi > 0 {
            out.push(',');
        }
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
            if fi > 0 {
                out.push(',');
            }
            let is_ref = f.is_ref;
            let (name_m, size_m, date_m): (u8, u8, u8) = match reference {
                Some(r) if !is_ref => (
                    if f.name.eq_ignore_ascii_case(&r.name) {
                        100
                    } else {
                        0
                    },
                    if f.size == r.size { 100 } else { 0 },
                    if f.modified == r.modified { 100 } else { 0 },
                ),
                _ => (100, 100, 100),
            };
            let content_m: u8 = if is_ref || mode == ScanMode::Exact {
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
        if i > 0 {
            out.push(',');
        }
        push_json_string(&mut out, e);
    }
    out.push_str("],\"ignoredCount\":");
    out.push_str(&ignored_count.to_string());
    out.push('}');
    w.write_all(out.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Arc, AtomicBool, AtomicU64, Ordering, content_hash_file_reporting};
    use super::{
        HashCacheEntry, HashInput, action_delete_verified, action_link, action_transfer_verified,
        content_hash_file, copy_file_exclusive, hash_candidate_groups, verified_duplicate_pair,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::io;
    use std::sync::Mutex;

    fn test_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "filetree_dupes_{name}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    #[test]
    fn reviewed_recycling_does_not_compare_contents_and_requires_keeper() {
        let root = test_root("reviewed_recycling");
        fs::create_dir_all(&root).unwrap();
        let keeper = root.join("keeper.bin");
        let duplicate = root.join("copy.bin");
        fs::write(&keeper, b"aaa").unwrap();
        fs::write(&duplicate, b"bbb").unwrap();
        let mut called = false;
        let errors = super::recycle_reviewed_with(&keeper, &duplicate, |path| {
            assert_eq!(path, duplicate);
            called = true;
            vec!["simulated shell failure".into()]
        });
        assert!(called);
        assert_eq!(errors, vec!["simulated shell failure"]);
        fs::remove_file(&keeper).unwrap();
        let errors = super::recycle_reviewed_with(&keeper, &duplicate, |_| {
            panic!("must not recycle without a keeper")
        });
        assert!(!errors.is_empty());
        assert!(duplicate.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_actions_stage_destructive_changes() {
        let root = test_root("verified_actions");
        let destination = root.join("destination");
        fs::create_dir_all(&destination).expect("create destination");
        let keeper = root.join("keeper.bin");
        let moved = root.join("moved-copy.bin");
        let deleted = root.join("deleted-copy.bin");
        fs::write(&keeper, b"verified duplicate").expect("write keeper");
        fs::write(&moved, b"verified duplicate").expect("write moved copy");
        fs::write(&deleted, b"verified duplicate").expect("write deleted copy");

        assert_eq!(verified_duplicate_pair(&keeper, &moved), Ok(true));
        assert!(action_transfer_verified("move", &keeper, &moved, &destination).is_empty());
        assert!(!moved.exists());
        assert_eq!(
            fs::read(destination.join("moved-copy.bin")).expect("read moved copy"),
            b"verified duplicate"
        );

        assert!(action_delete_verified(&keeper, &deleted, true).is_empty());
        assert!(!deleted.exists());
        assert_eq!(
            fs::read(&keeper).expect("read keeper"),
            b"verified duplicate"
        );
        fs::remove_dir_all(root).expect("remove verified action test root");
    }

    #[test]
    fn link_replacement_can_permanently_remove_the_staged_backup() {
        let root = test_root("permanent_link");
        fs::create_dir_all(&root).expect("create link test root");
        let keeper = root.join("keeper.bin");
        let duplicate = root.join("duplicate.bin");
        fs::write(&keeper, b"linked duplicate").expect("write keeper");
        fs::write(&duplicate, b"linked duplicate").expect("write duplicate");

        assert!(action_link(&[(keeper.clone(), duplicate.clone())], false, true).is_empty());
        assert_eq!(fs::read(&keeper).expect("read keeper"), b"linked duplicate");
        assert_eq!(
            fs::read(&duplicate).expect("read replacement"),
            b"linked duplicate"
        );
        let leftover_backups = fs::read_dir(&root)
            .expect("read link test root")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".filetree-link-")
            })
            .count();
        assert_eq!(leftover_backups, 0);
        fs::remove_dir_all(root).expect("remove link test root");
    }

    #[test]
    fn exclusive_copy_never_overwrites_an_existing_file() {
        let root = test_root("exclusive_copy");
        fs::create_dir_all(&root).expect("create copy test root");
        let source = root.join("source.bin");
        let destination = root.join("destination.bin");
        fs::write(&source, b"new").expect("write source");
        fs::write(&destination, b"existing").expect("write destination");

        assert!(copy_file_exclusive(&source, &destination).is_err());
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"existing"
        );
        fs::remove_dir_all(root).expect("remove copy test root");
    }

    #[test]
    fn small_file_samples_become_reusable_full_hashes() {
        let root = test_root("small_hash_cache");
        fs::create_dir_all(&root).expect("create hash cache test root");
        let first = root.join("first.bin");
        let second = root.join("second.bin");
        let content = vec![0x5au8; 96 * 1024];
        fs::write(&first, &content).expect("write first candidate");
        fs::write(&second, &content).expect("write second candidate");
        let files = vec![
            HashInput {
                path: first.clone(),
                size: content.len() as u64,
                mtime: 1,
            },
            HashInput {
                path: second.clone(),
                size: content.len() as u64,
                mtime: 1,
            },
        ];
        let cache = Mutex::new(HashMap::new());

        let (groups, errors) =
            hash_candidate_groups(&files, false, &cache, None, None, None, 2, None);
        assert!(errors.is_empty());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 2);
        let expected = content_hash_file(&first).expect("hash first candidate");
        let cached = cache.lock().expect("hash cache lock");
        assert_eq!(cached.len(), 2);
        assert!(cached.values().all(|entry| entry.hash == expected));
        drop(cached);

        // A repeat discovery pass should be served entirely by the cache. File
        // actions perform their own byte comparison, so discovery does not need
        // to reopen unchanged cached files.
        fs::remove_file(&first).expect("remove first candidate");
        fs::remove_file(&second).expect("remove second candidate");
        let (cached_groups, cached_errors) =
            hash_candidate_groups(&files, false, &cache, None, None, None, 2, None);
        assert!(cached_errors.is_empty());
        assert_eq!(cached_groups.len(), 1);
        fs::remove_dir_all(root).expect("remove hash cache test root");
    }

    #[test]
    fn large_rejected_files_reuse_fingerprints_and_invalidate_on_change() {
        use super::hash_candidate_groups_with_fingerprints;
        let root = test_root("fingerprint_reuse");
        fs::create_dir_all(&root).unwrap();
        let mut files = Vec::new();
        for i in 0..32 {
            let path = root.join(format!("{i}.bin"));
            let mut data = vec![42u8; 256 * 1024];
            data[0] = i; // Same quick fingerprint, different wide sample.
            fs::write(&path, data).unwrap();
            files.push(HashInput {
                path,
                size: 256 * 1024,
                mtime: 1,
            });
        }
        let full = Mutex::new(HashMap::new());
        let partial = Mutex::new(HashMap::new());
        let start = std::time::Instant::now();
        let (groups, errors) = hash_candidate_groups_with_fingerprints(
            &files,
            false,
            &full,
            None,
            None,
            None,
            4,
            None,
            Some(&partial),
        );
        let cold = start.elapsed();
        assert!(groups.is_empty() && errors.is_empty());
        assert!(
            full.lock().unwrap().is_empty(),
            "partial hashes are not full-content hashes"
        );
        assert_eq!(partial.lock().unwrap().len(), 32);
        let start = std::time::Instant::now();
        let (groups, errors) = hash_candidate_groups_with_fingerprints(
            &files,
            false,
            &full,
            None,
            None,
            None,
            4,
            None,
            Some(&partial),
        );
        let warm = start.elapsed();
        assert!(groups.is_empty() && errors.is_empty());
        eprintln!("32 x 256 KiB fingerprint benchmark: cold={cold:?}, warm={warm:?}");
        for file in &files {
            fs::remove_file(&file.path).unwrap();
        }
        // Cached rejections need no file reads, even when the files are absent.
        let (groups, errors) = hash_candidate_groups_with_fingerprints(
            &files,
            false,
            &full,
            None,
            None,
            None,
            4,
            None,
            Some(&partial),
        );
        assert!(groups.is_empty() && errors.is_empty());
        for file in &mut files {
            file.mtime = 2;
        }
        let (_, errors) = hash_candidate_groups_with_fingerprints(
            &files,
            false,
            &full,
            None,
            None,
            None,
            4,
            None,
            Some(&partial),
        );
        assert!(
            !errors.is_empty(),
            "changed metadata must force fresh reads"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_hash_reports_bytes_and_cancels_between_reads() {
        let root = test_root("hash_live_progress");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("large.bin");
        fs::write(&path, vec![42u8; 128 * 1024]).unwrap();
        let mut buffer = vec![0u8; 4096];
        let bytes = AtomicU64::new(0);
        let hash = content_hash_file_reporting(&path, &mut buffer, None, |read| {
            bytes.fetch_add(read, Ordering::Relaxed);
        })
        .unwrap();
        assert_eq!(bytes.load(Ordering::Relaxed), 128 * 1024);
        assert_eq!(hash, content_hash_file(&path).unwrap());
        let cancel = Arc::new(AtomicBool::new(false));
        bytes.store(0, Ordering::Relaxed);
        let error = content_hash_file_reporting(&path, &mut buffer, Some(&cancel), |read| {
            bytes.fetch_add(read, Ordering::Relaxed);
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(bytes.load(Ordering::Relaxed), 4096);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejected_small_candidates_reuse_complete_hashes() {
        for size in [8 * 1024, 96 * 1024] {
            let root = test_root(&format!("rejected_cache_{size}"));
            fs::create_dir_all(&root).unwrap();
            let first = root.join("first.bin");
            let second = root.join("second.bin");
            let left = vec![7u8; size];
            let mut right = left.clone();
            // Outside the quick sample for the larger fixture, so it reaches
            // the full-file sampling stage before being rejected.
            right[0] = 9;
            fs::write(&first, left).unwrap();
            fs::write(&second, right).unwrap();
            let files = vec![
                HashInput {
                    path: first.clone(),
                    size: size as u64,
                    mtime: 1,
                },
                HashInput {
                    path: second.clone(),
                    size: size as u64,
                    mtime: 1,
                },
            ];
            let cache = Mutex::new(HashMap::new());
            let (groups, errors) =
                hash_candidate_groups(&files, false, &cache, None, None, None, 2, None);
            assert!(groups.is_empty());
            assert!(errors.is_empty());
            assert_eq!(cache.lock().unwrap().len(), 2);
            fs::remove_file(first).unwrap();
            fs::remove_file(second).unwrap();
            let (groups, errors) =
                hash_candidate_groups(&files, false, &cache, None, None, None, 2, None);
            assert!(groups.is_empty());
            assert!(
                errors.is_empty(),
                "warm rejected candidates must not be reopened"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn mostly_cached_bucket_hashes_misses_without_reopening_cached_files() {
        let root = test_root("mixed_warm_cache");
        fs::create_dir_all(&root).expect("create mixed cache test root");
        let fresh = root.join("fresh.bin");
        let cached_a = root.join("cached-a.bin");
        let cached_b = root.join("cached-b.bin");
        let content = b"same-data";
        fs::write(&fresh, content).expect("write fresh candidate");
        let hash = content_hash_file(&fresh).expect("hash fresh candidate");
        let size = content.len() as u64;
        let files = vec![
            HashInput {
                path: cached_a.clone(),
                size,
                mtime: 1,
            },
            HashInput {
                path: cached_b.clone(),
                size,
                mtime: 1,
            },
            HashInput {
                path: fresh,
                size,
                mtime: 1,
            },
        ];
        let cache = Mutex::new(HashMap::from([
            (
                cached_a,
                HashCacheEntry {
                    size,
                    mtime: 1,
                    hash,
                    seq: 1,
                },
            ),
            (
                cached_b,
                HashCacheEntry {
                    size,
                    mtime: 1,
                    hash,
                    seq: 2,
                },
            ),
        ]));

        let (groups, errors) =
            hash_candidate_groups(&files, false, &cache, None, None, None, 2, None);

        assert!(
            errors.is_empty(),
            "cached paths must not be reopened: {errors:?}"
        );
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 3);
        fs::remove_dir_all(root).expect("remove mixed cache test root");
    }

    #[test]
    fn staged_hashing_filters_quick_collisions_and_reports_inside_the_batch() {
        let root = test_root("staged_hash_progress");
        fs::create_dir_all(&root).expect("create staged hash test root");
        let first = root.join("first.bin");
        let second = root.join("second.bin");
        let different = root.join("different.bin");
        let content = vec![0x31u8; 256 * 1024];
        let mut changed = content.clone();
        // Keep the 16-32 KiB quick-fingerprint window identical while changing
        // a later region so the wider sample rejects this file.
        changed[100 * 1024] = 0x7f;
        fs::write(&first, &content).expect("write first candidate");
        fs::write(&second, &content).expect("write second candidate");
        fs::write(&different, &changed).expect("write different candidate");
        let files = [first, second, different]
            .into_iter()
            .map(|path| HashInput {
                path,
                size: content.len() as u64,
                mtime: 1,
            })
            .collect::<Vec<_>>();
        let cache = Mutex::new(HashMap::new());
        let updates = Mutex::new(Vec::new());
        let observer = |done| updates.lock().expect("progress lock").push(done);

        let (groups, errors) =
            hash_candidate_groups(&files, false, &cache, None, None, None, 2, Some(&observer));

        assert!(errors.is_empty());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].1.len(), 2);
        let updates = updates.into_inner().expect("progress updates");
        assert_eq!(
            updates.last().map(|progress| progress.completed),
            Some(files.len())
        );
        assert!(
            updates
                .iter()
                .any(|progress| progress.stage == "fingerprinting")
        );
        assert!(updates.iter().any(|progress| progress.stage == "sampling"));
        for stage in ["fingerprinting", "sampling", "hashing"] {
            let stage_updates = updates
                .iter()
                .filter(|progress| progress.stage == stage)
                .collect::<Vec<_>>();
            assert_eq!(stage_updates.first().unwrap().fraction, 0.0);
            assert_eq!(stage_updates.last().unwrap().fraction, 1.0);
        }

        assert!(
            updates
                .windows(2)
                .all(|pair| pair[0].completed <= pair[1].completed)
        );
        fs::remove_dir_all(root).expect("remove staged hash test root");
    }
}
