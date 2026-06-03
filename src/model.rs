use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

pub(crate) use crate::dupes::IgnoreList;

#[derive(Clone, Debug)]
pub(crate) struct ScanOptions {
    pub(crate) root: PathBuf,
    pub(crate) include_hidden: bool,
    pub(crate) follow_links: bool,
    pub(crate) exclude_patterns: Vec<String>,
    pub(crate) max_depth: Option<usize>,
    pub(crate) threads: usize,
    /// Opt-in (default false): resolve each entry's owner account during the
    /// scan. OFF by default because `GetNamedSecurityInfo` adds one syscall per
    /// file and would noticeably slow large scans; a cached SID→name map keeps
    /// the translation cheap when it IS enabled. See `crate::owner`.
    pub(crate) collect_owners: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct NodeRecord {
    pub(crate) id: usize,
    pub(crate) parent: Option<usize>,
    pub(crate) name: String,
    /// Absolute path — but INTERNED to cut scan memory: only directory (and root)
    /// nodes store it; file nodes leave this empty and their path is rebuilt on
    /// demand from the parent directory's path + `name` (see [`node_abs_path`]).
    /// Since files dominate a scan and each would otherwise repeat its parent's
    /// full prefix, this removes the single largest per-node allocation. Read a
    /// node's absolute path via [`node_abs_path`], never `node.path` directly.
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) is_link: bool,
    pub(crate) hidden: bool,
    pub(crate) readonly: bool,
    pub(crate) size: u64,
    pub(crate) allocated: u64,
    pub(crate) files: u64,
    pub(crate) folders: u64,
    pub(crate) modified_ms: u64,
    pub(crate) created_ms: u64,
    pub(crate) accessed_ms: u64,
    pub(crate) depth: usize,
    pub(crate) errors: u64,
    pub(crate) children: Vec<usize>,
    pub(crate) extension: String,
    /// Owner account ("DOMAIN\\user"). Empty unless owner collection was
    /// enabled for the scan (`ScanOptions::collect_owners`).
    pub(crate) owner: String,
    /// Raw Windows file-attribute bitmask (`FILE_ATTRIBUTE_*`). 0 on non-Windows
    /// or when unavailable. Carries the full attribute set (System/Archive/
    /// Compressed/Encrypted/Temporary/Offline/…) so the client can decode any
    /// flag without the model growing a bool per attribute.
    pub(crate) attributes: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct ScanError {
    pub(crate) path: String,
    pub(crate) message: String,
}

/// Reconstruct the absolute path of node `id`. Directory and root nodes carry
/// their full path; file nodes have it interned away (empty `path`), so theirs
/// is rebuilt from the parent directory path + file name. This is the single
/// source of truth for "what is this node's path" — every endpoint that emits an
/// absolute path (exports, dupes, diff, scan-root checks) must go through it so
/// interning stays transparent.
pub(crate) fn node_abs_path(nodes: &[NodeRecord], id: usize) -> String {
    let Some(node) = nodes.get(id) else {
        return String::new();
    };
    if !node.path.is_empty() {
        return node.path.clone();
    }
    // Interned file node: a file's parent is always a directory, which keeps its
    // full path, so one join yields the correct absolute path at any depth.
    match node.parent.and_then(|pid| nodes.get(pid)) {
        Some(parent) if !parent.path.is_empty() => join_abs(&parent.path, &node.name),
        _ => node.name.clone(),
    }
}

/// Join a parent directory path and a child name. Mirrors `scan::join_path`'s
/// separator handling so a reconstructed path is byte-identical to what the scan
/// originally stored.
fn join_abs(parent: &str, name: &str) -> String {
    let mut s = String::with_capacity(parent.len() + 1 + name.len());
    s.push_str(parent);
    if !parent.ends_with('\\') && !parent.ends_with('/') {
        s.push('\\');
    }
    s.push_str(name);
    s
}

#[derive(Clone, Debug)]
pub(crate) struct ScanResult {
    pub(crate) root_path: String,
    pub(crate) scanned_at_ms: u64,
    pub(crate) elapsed_ms: u64,
    pub(crate) thread_count: usize,
    pub(crate) nodes: Vec<NodeRecord>,
    pub(crate) errors: Vec<ScanError>,
    /// Capped analytics computed once when the scan finalises, so JSON/NDJSON
    /// responses, cache hits, and exports reuse them instead of recomputing.
    pub(crate) summary: ScanSummary,
}

/// Precomputed, size-capped analytics for a scan. Built once in
/// `finalize_scan_result` and stored on `ScanResult`.
#[derive(Clone, Debug, Default)]
pub(crate) struct ScanSummary {
    pub(crate) top_files: Vec<usize>,
    pub(crate) largest_dirs: Vec<usize>,
    pub(crate) extension_stats: Vec<ExtensionStat>,
    pub(crate) age_stats: Vec<AgeBucket>,
    pub(crate) duplicate_candidates: Vec<DuplicateCandidate>,
}

/// A directory queued for scanning. Carries the directory's own path and depth so
/// a worker can scan it WITHOUT consulting a shared node buffer — the node records
/// now live in per-worker thread-local buffers, so the path/depth that the job
/// needs travel with the job instead of being looked up by id.
#[derive(Clone, Debug)]
pub(crate) struct DirJob {
    pub(crate) id: usize,
    pub(crate) path: String,
    pub(crate) depth: usize,
}

#[derive(Debug)]
pub(crate) struct QueueState {
    pub(crate) dirs: VecDeque<DirJob>,
    pub(crate) active: usize,
    pub(crate) done: bool,
}

/// State shared by all scan workers. The node buffer is intentionally NOT here:
/// to remove the single `Mutex<Vec<NodeRecord>>` whose lock every worker took once
/// per directory, each worker accumulates its records in a thread-local
/// `Vec<NodeRecord>` (returned from `worker_loop` and merged once at finalize).
/// `errors` carries the owning node id alongside each message so the per-node error
/// count can be applied during that single-threaded merge.
#[derive(Debug)]
pub(crate) struct WorkerShared {
    pub(crate) options: ScanOptions,
    pub(crate) errors: Mutex<Vec<(usize, ScanError)>>,
    pub(crate) queue: Mutex<QueueState>,
    pub(crate) queue_ready: Condvar,
    pub(crate) cancel: Arc<AtomicBool>,
}

/// Shared progress counter for the current /api/dupes-scan operation.
/// `files_scanned` is updated by the scan callback; `files_hashed` by the hash phase.
/// `phase`: 0=idle, 1=scanning, 2=hashing, 3=done.
#[derive(Debug, Default)]
pub(crate) struct DupesProgress {
    pub(crate) phase: AtomicU64,         // 0=idle 1=scan 2=hash 3=done
    pub(crate) files_scanned: AtomicU64,
    pub(crate) files_hashing: AtomicU64, // total files to hash
    pub(crate) files_hashed: AtomicU64,
}

/// One persistent content-hash cache entry. Keyed by file path; the
/// `(size, mtime)` pair is the validity stamp — a cached `hash` is reused only
/// when both still match, so a changed file is re-hashed. `hash` is the full
/// FNV-1a content hash produced by `dupes::fnv1a_file`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct HashCacheEntry {
    pub(crate) size: u64,
    pub(crate) mtime: u64,
    pub(crate) hash: u64,
    /// In-memory insertion/refresh sequence (monotonic, minted on insert). NOT
    /// persisted — re-minted in file order on load — so over-cap eviction can drop
    /// the oldest entries first deterministically instead of dropping arbitrary
    /// `HashMap` iteration-order entries. Larger = more recently inserted/re-hashed.
    pub(crate) seq: u64,
}

/// Upper bound on the in-memory scan-result cache, measured in estimated
/// resident bytes. The cache holds whole walked trees (`Arc<ScanResult>`);
/// without a cap a session that scans several large roots would grow without
/// limit. ~512 MB keeps a few big trees hot (so multi-root duplicate scans reuse
/// them) while bounding peak memory — least-recently-used roots evict first once
/// the running total exceeds this.
pub(crate) const SCAN_CACHE_MAX_BYTES: usize = 512 * 1024 * 1024;

struct ScanCacheEntry {
    result: Arc<ScanResult>,
    inserted: Instant,
    last_used: u64,
    bytes: usize,
}

/// Bounded LRU cache of recent scan results, keyed by normalized root path and
/// evicted by total estimated bytes. Replaces the previously unbounded
/// `HashMap<String, (Arc<ScanResult>, Instant)>`: cache hits for the scan and
/// duplicate routes still work, but resident memory can no longer grow without
/// limit. Recency is tracked with a monotonically increasing tick so eviction
/// drops the least-recently-used root.
pub(crate) struct ScanCache {
    entries: HashMap<String, ScanCacheEntry>,
    cap_bytes: usize,
    total_bytes: usize,
    tick: u64,
}

impl std::fmt::Debug for ScanCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScanCache")
            .field("entries", &self.entries.len())
            .field("total_bytes", &self.total_bytes)
            .field("cap_bytes", &self.cap_bytes)
            .finish()
    }
}

impl Default for ScanCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ScanCache {
    pub(crate) fn new() -> Self {
        Self {
            entries: HashMap::new(),
            cap_bytes: SCAN_CACHE_MAX_BYTES,
            total_bytes: 0,
            tick: 0,
        }
    }

    fn bump(&mut self) -> u64 {
        self.tick = self.tick.wrapping_add(1);
        self.tick
    }

    /// Look up `key`, returning a cheap `Arc` clone only when the entry is still
    /// within `ttl`. Records the access for LRU recency.
    pub(crate) fn get_fresh(&mut self, key: &str, ttl: Duration) -> Option<Arc<ScanResult>> {
        let tick = self.bump();
        let entry = self.entries.get_mut(key)?;
        if entry.inserted.elapsed() >= ttl {
            return None;
        }
        entry.last_used = tick;
        Some(Arc::clone(&entry.result))
    }

    /// Look up `key` ignoring TTL (the "current view" the user is looking at).
    /// Records the access for LRU recency.
    pub(crate) fn get_any(&mut self, key: &str) -> Option<Arc<ScanResult>> {
        let tick = self.bump();
        let entry = self.entries.get_mut(key)?;
        entry.last_used = tick;
        Some(Arc::clone(&entry.result))
    }

    /// Insert (or replace) `key`, then evict least-recently-used roots until the
    /// running byte total fits under the cap. The just-inserted entry is never
    /// the eviction victim.
    pub(crate) fn insert(&mut self, key: String, result: Arc<ScanResult>) {
        let bytes = estimate_scan_bytes(&result);
        let tick = self.bump();
        if let Some(prev) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(prev.bytes);
        }
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.entries.insert(
            key.clone(),
            ScanCacheEntry {
                result,
                inserted: Instant::now(),
                last_used: tick,
                bytes,
            },
        );
        self.evict_to_cap(&key);
    }

    fn evict_to_cap(&mut self, keep: &str) {
        while self.total_bytes > self.cap_bytes && self.entries.len() > 1 {
            let victim = self
                .entries
                .iter()
                .filter(|(k, _)| k.as_str() != keep)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone());
            let Some(victim) = victim else { break };
            if let Some(removed) = self.entries.remove(&victim) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.bytes);
            }
        }
    }

    /// Evict entries that are descendants OR ancestors of `path`. A move/rename
    /// changes both the subtree and every parent aggregate up to the root, so all
    /// of them are stale.
    pub(crate) fn invalidate(&mut self, path: &str) {
        let norm = path.replace('\\', "/").to_lowercase();
        let mut freed = 0usize;
        self.entries.retain(|k, e| {
            let keep = !k.starts_with(&norm) && !norm.starts_with(k.as_str());
            if !keep {
                freed = freed.saturating_add(e.bytes);
            }
            keep
        });
        self.total_bytes = self.total_bytes.saturating_sub(freed);
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Rough resident-byte estimate of a cached scan: node structs + their heap
/// strings + children index vectors + a small per-error allowance. Only used to
/// drive LRU eviction, so an approximation is fine (and cheap: one pass over a
/// buffer we just finished building).
fn estimate_scan_bytes(result: &ScanResult) -> usize {
    let mut bytes = result
        .nodes
        .len()
        .saturating_mul(std::mem::size_of::<NodeRecord>());
    for n in &result.nodes {
        bytes = bytes.saturating_add(n.name.len() + n.path.len() + n.extension.len() + n.owner.len());
        bytes = bytes.saturating_add(n.children.len().saturating_mul(std::mem::size_of::<usize>()));
    }
    bytes = bytes.saturating_add(result.errors.len().saturating_mul(96));
    bytes
}

#[derive(Debug)]
pub(crate) struct AppState {
    pub(crate) initial_path: PathBuf,
    /// Read-dominated: every read-only route clones the `Arc` to view the current
    /// scan, while only the scan routes replace it — an `RwLock` lets those reads
    /// proceed concurrently instead of serializing on a `Mutex`.
    pub(crate) last_scan: RwLock<Option<Arc<ScanResult>>>,
    /// Per-path scan-result cache keyed by normalized lowercase path, bounded by
    /// total estimated bytes with LRU eviction (see [`ScanCache`]). TTL freshness
    /// is enforced via `get_fresh`.
    pub(crate) scan_cache: Mutex<ScanCache>,
    /// Cached shell icon BMPs, keyed by lowercase extension (no dot).
    pub(crate) icon_cache: Mutex<HashMap<String, Vec<u8>>>,
    /// Cached shell-generated thumbnail PNGs, keyed by
    /// `"<normalized_lower_path>|<mtime_nanos>|<size>"`. The mtime+size token
    /// means a file that is edited or replaced misses and regenerates instead of
    /// serving a stale image. Bounded to ~512 entries with arbitrary-entry
    /// eviction in `serve_thumbnail`, so repeated hovers skip the slow Windows
    /// Shell thumbnail API. Mirrors `icon_cache`'s `Mutex<HashMap<…>>` style.
    pub(crate) thumbnail_cache: Mutex<HashMap<String, Vec<u8>>>,
    pub(crate) dupes_progress: Arc<DupesProgress>,
    pub(crate) dupes_cancel: Arc<AtomicBool>,
    /// Read-dominated: consulted (read) on every duplicate scan to filter ignored
    /// pairs, but mutated only when the user adds/clears an ignore entry. `RwLock`
    /// so concurrent dupe scans don't serialize on it.
    pub(crate) ignore_list: RwLock<IgnoreList>,
    pub(crate) ignore_list_path: PathBuf,
    /// Persistent content-hash cache `(path) -> (size, mtime, hash)` so unchanged
    /// files are never re-hashed across repeat duplicate scans. Persisted to
    /// `%APPDATA%\FileTree\hash_cache.json`.
    pub(crate) hash_cache: Mutex<HashMap<PathBuf, HashCacheEntry>>,
    pub(crate) hash_cache_path: PathBuf,
    /// Per-session local auth token minted by Electron (passed in via the
    /// `FILETREE_AUTH_TOKEN` env var) and required on the destructive mutation
    /// routes. `None` when the server is launched standalone without a token
    /// (dev), in which case those routes fall back to POST-only with no token.
    pub(crate) auth_token: Option<String>,
    /// Canonicalized directories the user has scanned this session. File-content
    /// reads (file-text / thumbnail / owner) are confined to paths located under
    /// one of these roots, so a request can't read arbitrary files outside the
    /// trees the user actually opened. Populated by the scan routes. Read-dominated
    /// (checked on every confined read and every `dupes-hash` candidate, appended
    /// to only when a new root is scanned), so an `RwLock` keeps those checks
    /// concurrent.
    pub(crate) scan_roots: RwLock<Vec<PathBuf>>,
}

#[derive(Debug)]
pub(crate) struct HttpRequest {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) body: Vec<u8>,
    /// Value of the `X-FileTree-Token` request header, if present. Compared
    /// against `AppState::auth_token` to authorize destructive routes.
    pub(crate) auth_token: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ExtensionStat {
    pub(crate) ext: String,
    pub(crate) bytes: u64,
    pub(crate) allocated: u64,
    pub(crate) files: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct AgeBucket {
    pub(crate) label: &'static str,
    pub(crate) bytes: u64,
    pub(crate) files: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct DuplicateCandidate {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) waste: u64,
    pub(crate) ids: Vec<usize>,
}
