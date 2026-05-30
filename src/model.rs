use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

pub(crate) use crate::dupes::IgnoreList;

#[derive(Clone, Debug)]
pub(crate) struct ScanOptions {
    pub(crate) root: PathBuf,
    pub(crate) include_hidden: bool,
    pub(crate) follow_links: bool,
    pub(crate) exclude_patterns: Vec<String>,
    pub(crate) max_depth: Option<usize>,
    pub(crate) threads: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct NodeRecord {
    pub(crate) id: usize,
    pub(crate) parent: Option<usize>,
    pub(crate) name: String,
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
}

#[derive(Clone, Debug)]
pub(crate) struct ScanError {
    pub(crate) path: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ScanResult {
    pub(crate) root_path: String,
    pub(crate) scanned_at_ms: u64,
    pub(crate) elapsed_ms: u64,
    pub(crate) thread_count: usize,
    pub(crate) nodes: Vec<NodeRecord>,
    pub(crate) errors: Vec<ScanError>,
}

#[derive(Debug)]
pub(crate) struct QueueState {
    pub(crate) dirs: VecDeque<usize>,
    pub(crate) active: usize,
    pub(crate) done: bool,
}

#[derive(Debug)]
pub(crate) struct WorkerShared {
    pub(crate) options: ScanOptions,
    pub(crate) nodes: Mutex<Vec<NodeRecord>>,
    pub(crate) errors: Mutex<Vec<ScanError>>,
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

#[derive(Debug)]
pub(crate) struct AppState {
    pub(crate) initial_path: PathBuf,
    pub(crate) last_scan: Mutex<Option<Arc<ScanResult>>>,
    /// Per-path scan result cache keyed by lowercase path. TTL enforced in server.rs.
    pub(crate) scan_cache: Mutex<HashMap<String, (Arc<ScanResult>, Instant)>>,
    /// Cached shell icon BMPs, keyed by lowercase extension (no dot).
    pub(crate) icon_cache: Mutex<HashMap<String, Vec<u8>>>,
    pub(crate) dupes_progress: Arc<DupesProgress>,
    pub(crate) dupes_cancel: Arc<AtomicBool>,
    pub(crate) ignore_list: Mutex<IgnoreList>,
    pub(crate) ignore_list_path: PathBuf,
}

#[derive(Debug)]
pub(crate) struct HttpRequest {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) body: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct ExtensionStat {
    pub(crate) ext: String,
    pub(crate) bytes: u64,
    pub(crate) allocated: u64,
    pub(crate) files: u64,
}

#[derive(Debug)]
pub(crate) struct AgeBucket {
    pub(crate) label: &'static str,
    pub(crate) bytes: u64,
    pub(crate) files: u64,
}

#[derive(Debug)]
pub(crate) struct DuplicateCandidate {
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) waste: u64,
    pub(crate) ids: Vec<usize>,
}
