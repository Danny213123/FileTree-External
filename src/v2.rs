//! FileTree v2 bounded-storage core.
//!
//! The v1 scanner returned one `Vec<NodeRecord>` and the renderer then built
//! several complete maps over it. That made resident memory proportional to the
//! number of files and multiplied the cost for every open tab. V2 writes scan
//! rows through a bounded channel into a per-scan SQLite database and exposes
//! only paginated DTOs.

use base64::Engine;
use regex::RegexBuilder;
use rusqlite::functions::FunctionFlags;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::dupes::{
    FingerprintEntry, HashCandidateProgress, HashInput, hash_candidate_groups_with_fingerprints,
    next_hash_cache_seq,
};
use crate::model::HashCacheEntry;

pub const TREE_PAGE_DEFAULT: usize = 500;
pub const TREE_PAGE_MAX: usize = 500;
pub const SUBTREE_FILE_PAGE_MAX: usize = 5_000;
pub const COMPRESSION_PAGE_MAX: usize = 250;
pub const SCAN_CHANNEL_CAPACITY: usize = 8_192;
pub const SCAN_TRANSACTION_ROWS: usize = 10_000;
pub const SCAN_DISK_BUDGET_BYTES: u64 = 10 * 1024 * 1024 * 1024;
pub const SQLITE_CACHE_KIB: i64 = 8 * 1024;
pub const MANAGED_MEMORY_BUDGET_BYTES: u64 = 96 * 1024 * 1024;
pub const SETTINGS_JSON_MAX_BYTES: usize = 1024 * 1024;
pub const BOOKMARKS_JSON_MAX_BYTES: usize = 2 * 1024 * 1024;
const DUPLICATE_HASH_BATCH_FILE_TARGET: u64 = 4_096;
const DUPLICATE_HASH_BATCH_SIZE_LIMIT: usize = 500;

static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);

/// Coalesce many small equal-size groups into one hashing pass. The hash engine
/// creates scoped workers per pass, so processing one two-file size bucket at a
/// time can spend more time creating threads and opening SQLite transactions
/// than reading data. Batches stay bounded by both candidate count and SQLite's
/// conservative host-parameter limit; a single unusually large size group is
/// kept intact because equal-size members must be compared together.
fn duplicate_hash_batches(size_groups: &[(i64, u64)]) -> Vec<Vec<i64>> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut batch_files = 0u64;

    for &(size, files) in size_groups {
        if !batch.is_empty()
            && (batch_files.saturating_add(files) > DUPLICATE_HASH_BATCH_FILE_TARGET
                || batch.len() >= DUPLICATE_HASH_BATCH_SIZE_LIMIT)
        {
            batches.push(std::mem::take(&mut batch));
            batch_files = 0;
        }
        batch.push(size);
        batch_files = batch_files.saturating_add(files);
        if batch_files >= DUPLICATE_HASH_BATCH_FILE_TARGET {
            batches.push(std::mem::take(&mut batch));
            batch_files = 0;
        }
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

/// Load persistent hashes in bounded `IN` queries instead of issuing one
/// SQLite statement per file. The candidates table already deduplicates paths
/// case-insensitively, so an ASCII-folded key mirrors SQLite's `NOCASE`
/// collation while preserving the current input path in the in-memory cache.
fn load_duplicate_hash_cache(
    state: &Connection,
    inputs: &[HashInput],
) -> Result<HashMap<PathBuf, HashCacheEntry>, String> {
    const CACHE_QUERY_PATHS: usize = 400;
    let mut cached = HashMap::new();
    // Cold scans have no reusable hashes. Avoid thousands of empty IN queries
    // and path allocations for multi-million-file candidate sets.
    let populated: bool = state
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM duplicate_hashes LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !populated {
        return Ok(cached);
    }

    for chunk in inputs.chunks(CACHE_QUERY_PATHS) {
        let paths = chunk
            .iter()
            .map(|input| input.path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let inputs_by_path = chunk
            .iter()
            .map(|input| (input.path.to_string_lossy().to_ascii_lowercase(), input))
            .collect::<HashMap<_, _>>();
        let placeholders = std::iter::repeat_n("?", paths.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT path,size,modified,hash FROM duplicate_hashes \
             WHERE path IN ({placeholders})"
        );
        let mut statement = state.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(paths.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?.max(0) as u64,
                    row.get::<_, i64>(2)?.max(0) as u64,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (stored_path, size, modified, hash) = row.map_err(|error| error.to_string())?;
            let Some(input) = inputs_by_path.get(&stored_path.to_ascii_lowercase()) else {
                continue;
            };
            if size != input.size || modified != input.mtime {
                continue;
            }
            let Some(hash) = hash.parse::<u64>().ok() else {
                continue;
            };
            cached.insert(
                input.path.clone(),
                HashCacheEntry {
                    size,
                    mtime: modified,
                    hash,
                    seq: next_hash_cache_seq(),
                },
            );
        }
    }
    Ok(cached)
}

// Separate, versioned table: samples must never be mistaken for full hashes.
fn load_duplicate_fingerprints(
    state: &Connection,
    inputs: &[HashInput],
) -> Result<HashMap<PathBuf, FingerprintEntry>, String> {
    let mut cache = HashMap::new();
    let populated: bool = state
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM duplicate_fingerprints_v1 LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !populated {
        return Ok(cache);
    }
    let large_inputs = inputs
        .iter()
        .filter(|file| file.size > crate::dupes::FULL_SAMPLE_LIMIT)
        .collect::<Vec<_>>();
    for chunk in large_inputs.chunks(400) {
        let paths = chunk
            .iter()
            .map(|file| file.path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let by_path = chunk
            .iter()
            .map(|file| (file.path.to_string_lossy().to_ascii_lowercase(), file))
            .collect::<HashMap<_, _>>();
        let sql = format!(
            "SELECT path,size,modified,quick,sample FROM duplicate_fingerprints_v1 WHERE path IN ({})",
            std::iter::repeat_n("?", paths.len())
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut statement = state.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params_from_iter(paths.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, size, modified, quick, sample) = row.map_err(|e| e.to_string())?;
            let Some(file) = by_path.get(&path.to_ascii_lowercase()) else {
                continue;
            };
            if size != as_sql_i64(file.size) || modified != as_sql_i64(file.mtime) {
                continue;
            }
            cache.insert(
                file.path.clone(),
                FingerprintEntry {
                    size: file.size,
                    mtime: file.mtime,
                    quick: quick.and_then(|value| value.parse().ok()),
                    sample: sample.and_then(|value| value.parse().ok()),
                },
            );
        }
    }
    Ok(cache)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanRequest {
    pub root: String,
    pub include_hidden: bool,
    pub follow_links: bool,
    pub exclude_patterns: Vec<String>,
    pub threads: usize,
}

impl Default for ScanRequest {
    fn default() -> Self {
        Self {
            root: String::new(),
            include_hidden: true,
            follow_links: false,
            exclude_patterns: Vec::new(),
            threads: std::thread::available_parallelism()
                .map(|value| value.get())
                .unwrap_or(4)
                .clamp(1, 16),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHandle {
    pub scan_id: String,
    pub root_path: String,
    pub database_path: String,
    pub status: String,
    pub node_count: u64,
    pub started_at: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: String,
    pub stage: String,
    pub node_count: u64,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanQuery {
    pub directory_paths: Vec<String>,
    pub scan_id: String,
    pub parent_id: Option<i64>,
    pub offset: usize,
    pub limit: usize,
    pub search: String,
    pub sort: String,
    pub direction: String,
    pub directories_only: bool,
    pub files_only: bool,
    pub regex: bool,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub modified_after: Option<u64>,
    pub modified_before: Option<u64>,
    pub ext: String,
    pub category: String,
    #[serde(default = "default_true")]
    pub count_total: bool,
}

fn default_true() -> bool {
    true
}

impl Default for ScanQuery {
    fn default() -> Self {
        Self {
            directory_paths: Vec::new(),
            scan_id: String::new(),
            parent_id: Some(0),
            offset: 0,
            limit: TREE_PAGE_DEFAULT,
            search: String::new(),
            sort: "size".to_string(),
            direction: "desc".to_string(),
            directories_only: false,
            files_only: false,
            regex: false,
            min_size: None,
            max_size: None,
            modified_after: None,
            modified_before: None,
            ext: String::new(),
            category: String::new(),
            count_total: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePageItem {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub hidden: bool,
    pub readonly: bool,
    pub size: u64,
    pub allocated: u64,
    pub files: u64,
    pub folders: u64,
    pub modified_ms: u64,
    pub created_ms: u64,
    pub accessed_ms: u64,
    pub depth: u32,
    pub errors: u64,
    pub extension: String,
    pub owner: String,
    pub attributes: u32,
    /// Newest creation date of any file in this subtree; 0 when it holds none.
    /// Kept apart from `created_ms` so rewriting a file — recompressing it, say
    /// — cannot move the date a folder reports for its last addition.
    pub newest_created_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePage {
    pub items: Vec<NodePageItem>,
    pub total: u64,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubtreeFilesQuery {
    pub scan_id: String,
    pub directory_id: i64,
    pub offset: usize,
    pub limit: usize,
}

impl Default for SubtreeFilesQuery {
    fn default() -> Self {
        Self {
            scan_id: String::new(),
            directory_id: 0,
            offset: 0,
            limit: TREE_PAGE_DEFAULT,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtreeFileItem {
    pub path: String,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct IndexedCompressionSource {
    pub path: String,
    pub size: u64,
    pub is_link: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtreeFilePage {
    pub items: Vec<SubtreeFileItem>,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionSummary {
    pub id: String,
    pub status: String,
    pub total: u64,
    pub processed: u64,
    pub active: u64,
    pub saved_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionFileItem {
    pub index: usize,
    pub path: String,
    pub kind: String,
    pub status: String,
    pub stage: String,
    pub pct: u64,
    pub orig_bytes: u64,
    pub new_bytes: u64,
    pub saved_bytes: u64,
    pub pct_saved: f64,
    pub error: Option<String>,
    pub reason: String,
    pub encoder: String,
    pub disposition: String,
    pub out_path: String,
    pub duration_ms: u64,
    pub elapsed_ms: u64,
    pub fps: Option<f64>,
    pub processing_rate: Option<f64>,
    pub output_bytes: u64,
    pub started_at: u64,
    pub updated_at: u64,
    pub finished_at: u64,
    pub attempt: usize,
    pub tool: String,
    pub tool_version: String,
    pub command: String,
    pub stderr: String,
    pub recycled: bool,
    pub queue_position: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionFilePage {
    pub id: String,
    pub items: Vec<CompressionFileItem>,
    pub total: u64,
    pub total_matches: u64,
    pub offset: usize,
    pub limit: usize,
    pub facets: HashMap<String, HashMap<String, u64>>,
}

#[derive(Clone, Debug)]
pub struct CompressionFileRecord {
    pub job_id: String,
    pub index: usize,
    pub path: String,
    pub kind: String,
    pub status: String,
    pub stage: String,
    pub pct: u64,
    pub orig_bytes: u64,
    pub new_bytes: u64,
    pub error: Option<String>,
    pub reason: String,
    pub encoder: String,
    pub disposition: String,
    pub out_path: String,
    pub duration_ms: u64,
    pub fps: Option<f64>,
    pub started_at: u64,
    pub updated_at: u64,
    pub finished_at: u64,
    pub attempt: usize,
    pub tool: String,
    pub tool_version: String,
    pub command: String,
    pub stderr: String,
    pub recycled: bool,
    pub queue_position: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct CompressionPageQuery {
    pub offset: usize,
    pub limit: usize,
    pub search: String,
    pub status: String,
    pub kind: String,
    pub encoder: String,
    pub outcome: String,
    pub disposition: String,
    pub path: String,
    pub attention: bool,
    pub sort: String,
    pub direction: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub working_set_bytes: Option<u64>,
    pub private_bytes: Option<u64>,
    pub managed_budget_bytes: u64,
    pub scan_index_bytes: u64,
    pub active_scans: usize,
    pub retained_scan_handles: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateSource {
    pub scan_id: String,
    pub target_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicatePathRule {
    pub path: String,
    pub excluded: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DuplicateScanRequest {
    pub metadata_only: bool,
    pub metadata_name: bool,
    pub metadata_size: bool,
    pub metadata_date: bool,
    pub date_tolerance_sec: u64,
    pub sources: Vec<DuplicateSource>,
    pub min_size: u64,
    pub max_size: Option<u64>,
    pub extensions: Vec<String>,
    pub excluded_paths: Vec<String>,
    pub path_rules: Vec<DuplicatePathRule>,
    pub include_hidden: bool,
    pub threads: usize,
}

impl Default for DuplicateScanRequest {
    fn default() -> Self {
        Self {
            metadata_only: false,
            metadata_name: true,
            metadata_size: true,
            metadata_date: false,
            date_tolerance_sec: 0,
            sources: Vec::new(),
            min_size: 1,
            max_size: None,
            extensions: Vec::new(),
            excluded_paths: Vec::new(),
            path_rules: Vec::new(),
            include_hidden: true,
            threads: 4,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateProgress {
    #[serde(default)]
    pub fraction: Option<f64>,
    #[serde(default)]
    pub bytes_read: u64,
    pub phase: String,
    pub scanned: u64,
    pub hashing: u64,
    pub hashed: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub files: Vec<DuplicateFile>,
    pub waste: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanResult {
    pub groups: Vec<DuplicateGroup>,
    pub errors: Vec<String>,
    pub scanned: u64,
    pub hashing: u64,
    pub cancelled: bool,
}

#[derive(Debug)]
struct ScanJob {
    handle: ScanHandle,
    cancel: Arc<AtomicBool>,
    terminal: bool,
}

#[derive(Debug)]
enum CompressionWrite {
    // Boxed: a file record dwarfs the job-state variant, and every queued
    // message would otherwise be sized for the larger one.
    File(Box<CompressionFileRecord>),
    JobState {
        id: String,
        status: String,
        saved_bytes: u64,
    },
}

#[derive(Debug)]
pub struct V2Store {
    root: PathBuf,
    scans_dir: PathBuf,
    state_path: PathBuf,
    jobs: Mutex<HashMap<String, ScanJob>>,
    compression_tx: SyncSender<CompressionWrite>,
}

impl V2Store {
    pub fn open_default() -> Result<Arc<Self>, String> {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        Self::open(local.join("FileTree").join("v2"))
    }

    pub fn open(root: PathBuf) -> Result<Arc<Self>, String> {
        let scans_dir = root.join("scans");
        fs::create_dir_all(&scans_dir).map_err(|error| error.to_string())?;
        let state_path = root.join("state.db");
        let (compression_tx, compression_rx) =
            std::sync::mpsc::sync_channel::<CompressionWrite>(SCAN_CHANNEL_CAPACITY);
        let store = Arc::new(Self {
            root,
            scans_dir,
            state_path,
            jobs: Mutex::new(HashMap::new()),
            compression_tx,
        });
        store
            .initialize_state()
            .map_err(|error| error.to_string())?;
        store
            .import_v1_catalog()
            .map_err(|error| error.to_string())?;
        // Interrupted scans never reach scan_catalog. Reclaim indexes left by
        // dead FileTree processes before they can accumulate outside the cache
        // budget. A live process's in-progress index is deliberately preserved.
        let _ = store.cleanup_orphan_scan_databases();
        spawn_compression_writer(store.state_path.clone(), compression_rx);
        Ok(store)
    }

    pub fn data_root(&self) -> &Path {
        &self.root
    }

    pub fn start_scan<F>(
        self: &Arc<Self>,
        request: ScanRequest,
        progress: F,
    ) -> Result<ScanHandle, String>
    where
        F: Fn(ScanProgress) + Send + Sync + 'static,
    {
        let root = PathBuf::from(request.root.trim());
        if !root.is_dir() {
            return Err(format!("Scan root is not a directory: {}", root.display()));
        }
        let scan_id = new_scan_id();
        let db_path = self.scans_dir.join(format!("{scan_id}.db"));
        let started_at = now_ms();
        let handle = ScanHandle {
            scan_id: scan_id.clone(),
            root_path: root.to_string_lossy().into_owned(),
            database_path: db_path.to_string_lossy().into_owned(),
            status: "scanning".to_string(),
            node_count: 0,
            started_at,
            elapsed_ms: 0,
            error: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.jobs.lock_unpoisoned().insert(
            scan_id.clone(),
            ScanJob {
                handle: handle.clone(),
                cancel: Arc::clone(&cancel),
                terminal: false,
            },
        );

        let store = Arc::clone(self);
        let thread_handle = handle.clone();
        std::thread::Builder::new()
            .name(format!("scan-{scan_id}"))
            .spawn(move || {
                let started = Instant::now();
                let callback: Arc<dyn Fn(ScanProgress) + Send + Sync> = Arc::new(progress);
                let outcome = run_bounded_scan(
                    &thread_handle.scan_id,
                    &root,
                    &db_path,
                    &request,
                    &cancel,
                    Arc::clone(&callback),
                );
                let elapsed_ms = started.elapsed().as_millis() as u64;
                let (status, nodes, error_message) = match outcome {
                    Ok(nodes) if cancel.load(Ordering::Relaxed) => ("cancelled", nodes, None),
                    Ok(nodes) => ("done", nodes, None),
                    Err(error) => {
                        let _ = write_scan_metadata(
                            &db_path,
                            "error",
                            0,
                            elapsed_ms,
                            Some(&error),
                            None,
                        );
                        ("error", 0, Some(error))
                    }
                };
                {
                    let mut jobs = store.jobs.lock_unpoisoned();
                    if let Some(job) = jobs.get_mut(&thread_handle.scan_id) {
                        job.handle.status = status.to_string();
                        job.handle.node_count = nodes;
                        job.handle.elapsed_ms = elapsed_ms;
                        job.handle.error = error_message.clone();
                        job.terminal = true;
                    }
                    prune_job_handles(&mut jobs);
                }
                let _ = store.upsert_scan_catalog(
                    &thread_handle.scan_id,
                    &root,
                    &db_path,
                    status,
                    nodes,
                );
                // The result is published to the renderer immediately after
                // this call, so the just-completed index must remain available
                // even when it alone exceeds the cache budget.
                let _ = store.enforce_scan_disk_budget_preserving(&thread_handle.scan_id);
                callback(ScanProgress {
                    scan_id: thread_handle.scan_id,
                    stage: status.to_string(),
                    node_count: nodes,
                    elapsed_ms,
                });
            })
            .map_err(|error| error.to_string())?;
        Ok(handle)
    }

    pub fn cancel_scan(&self, scan_id: &str) -> bool {
        let jobs = self.jobs.lock_unpoisoned();
        let Some(job) = jobs.get(scan_id) else {
            return false;
        };
        if job.terminal {
            return false;
        }
        job.cancel.store(true, Ordering::Relaxed);
        true
    }

    pub fn scan_status(&self, scan_id: &str) -> Option<ScanHandle> {
        if let Some(job) = self.jobs.lock_unpoisoned().get(scan_id) {
            return Some(job.handle.clone());
        }
        self.catalog_handle(scan_id).ok().flatten()
    }

    pub fn find_completed_scan(&self, root_path: &str) -> Option<ScanHandle> {
        let conn = self.open_state().ok()?;
        let handle = conn
            .query_row(
                "SELECT scan_id,root_path,db_path,status,node_count,created_at FROM scan_catalog \
                 WHERE root_path=?1 COLLATE NOCASE AND status='done' ORDER BY last_used DESC LIMIT 1",
                params![root_path],
                |row| {
                    Ok(ScanHandle {
                        scan_id: row.get(0)?,
                        root_path: row.get(1)?,
                        database_path: row.get(2)?,
                        status: row.get(3)?,
                        node_count: row.get::<_, i64>(4)?.max(0) as u64,
                        started_at: row.get::<_, i64>(5)?.max(0) as u64,
                        elapsed_ms: 0,
                        error: None,
                    })
                },
            )
            .optional()
            .ok()??;
        if !Path::new(&handle.database_path).is_file() {
            return None;
        }

        // A cached scan is only worth reopening if it can be proven current.
        // The change journal answers that in the time it takes to read the
        // records written since the scan; anything it can't vouch for returns
        // None here, which sends the caller down the normal scan path.
        let mut handle = handle;
        let db_path = PathBuf::from(&handle.database_path);
        let root = PathBuf::from(&handle.root_path);
        if let Err(error) = migrate_scan_database(&db_path) {
            eprintln!("[v2] {}: {error} — rescanning", handle.root_path);
            return None;
        }
        match crate::refresh::refresh_scan(&db_path, &root) {
            crate::refresh::Refresh::Current => {}
            crate::refresh::Refresh::Updated { applied } => {
                eprintln!("[usn] {}: replayed {applied} changes", handle.root_path);
                if let Some(count) = crate::refresh::node_count(&db_path) {
                    handle.node_count = count;
                    self.set_scan_node_count(&handle.scan_id, count).ok();
                }
            }
            // No journal to consult. Serve the cache exactly as this code did
            // before the journal existed rather than punishing every unelevated
            // reopen with a full rescan.
            crate::refresh::Refresh::Unverifiable(_) => {}
            crate::refresh::Refresh::Rescan(reason) => {
                eprintln!("[usn] {}: {reason} — rescanning", handle.root_path);
                return None;
            }
        }

        self.touch_scan(&handle.scan_id).ok();
        Some(handle)
    }

    /// Keep the catalog's node count in step after an incremental refresh.
    fn set_scan_node_count(&self, scan_id: &str, count: u64) -> Result<(), String> {
        let conn = self.open_state().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE scan_catalog SET node_count=?2 WHERE scan_id=?1",
            params![scan_id, as_sql_i64(count)],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn query_nodes(&self, mut query: ScanQuery) -> Result<NodePage, String> {
        if !safe_scan_id(&query.scan_id) {
            return Err("Invalid scan id".to_string());
        }
        query.limit = query.limit.clamp(1, TREE_PAGE_MAX);
        let db_path = self.scans_dir.join(format!("{}.db", query.scan_id));
        let conn = open_scan_connection(&db_path).map_err(|error| error.to_string())?;
        let mut clauses = vec!["1=1".to_string()];
        let mut values: Vec<Value> = Vec::new();
        if let Some(parent) = query.parent_id {
            clauses.push("n.parent_id = ?".to_string());
            values.push(Value::Integer(parent));
        }
        if query.directories_only {
            clauses.push("n.is_dir = 1".to_string());
        }
        if !query.directory_paths.is_empty() {
            if query.directory_paths.len() > 500 {
                return Err("Too many directory paths in one page".into());
            }
            let placeholders = vec!["?"; query.directory_paths.len()].join(",");
            clauses.push(format!("n.is_dir=1 AND RTRIM(REPLACE(n.dir_path, '\\', '/'), '/') COLLATE NOCASE IN ({placeholders})"));
            values.extend(query.directory_paths.iter().map(|path| {
                Value::Text(path.replace('\\', "/").trim_end_matches('/').to_string())
            }));
        }
        if query.files_only {
            clauses.push("n.is_dir = 0".to_string());
        }
        if let Some(min_size) = query.min_size {
            clauses.push("n.size >= ?".to_string());
            values.push(Value::Integer(as_sql_i64(min_size)));
        }
        if let Some(max_size) = query.max_size {
            clauses.push("n.size <= ?".to_string());
            values.push(Value::Integer(as_sql_i64(max_size)));
        }
        if let Some(modified_after) = query.modified_after {
            clauses.push("n.modified_ms >= ?".to_string());
            values.push(Value::Integer(as_sql_i64(modified_after)));
        }
        if let Some(modified_before) = query.modified_before {
            clauses.push("n.modified_ms <= ?".to_string());
            values.push(Value::Integer(as_sql_i64(modified_before)));
        }
        append_extension_filter(&mut clauses, &mut values, &query.ext);
        append_category_filter(&mut clauses, &mut values, &query.category);
        if !query.search.trim().is_empty() {
            if query.regex {
                let expression = RegexBuilder::new(query.search.trim())
                    .case_insensitive(true)
                    .build()
                    .map_err(|error| format!("Invalid regular expression: {error}"))?;
                conn.create_scalar_function(
                    "filetree_regex",
                    1,
                    FunctionFlags::SQLITE_DETERMINISTIC,
                    move |context| {
                        let name = context.get::<String>(0)?;
                        Ok(expression.is_match(&name))
                    },
                )
                .map_err(|error| error.to_string())?;
                clauses.push("filetree_regex(n.name) = 1".to_string());
            } else {
                for term in parse_search_terms(&query.search) {
                    append_search_term(&mut clauses, &mut values, &term);
                }
            }
        }
        let where_sql = clauses.join(" AND ");
        let mut total = 0u64;
        if query.count_total {
            let count_sql = format!(
                "SELECT COUNT(*) FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id WHERE {where_sql}"
            );
            total = conn
                .query_row(&count_sql, params_from_iter(values.iter()), |row| {
                    row.get(0)
                })
                .map_err(|error| error.to_string())?;
        }
        let order = sort_column(&query.sort);
        let direction = if query.direction.eq_ignore_ascii_case("asc") {
            "ASC"
        } else {
            "DESC"
        };
        let page_sql = format!(
            r#"SELECT n.id,n.parent_id,n.name,
               CASE WHEN n.is_dir=1 THEN n.dir_path
                    WHEN p.dir_path IS NULL OR p.dir_path='' THEN n.name
                    WHEN substr(p.dir_path,-1,1) IN ('\','/') THEN p.dir_path || n.name
                    ELSE p.dir_path || '\' || n.name END,
               n.is_dir,n.is_link,n.hidden,n.readonly,n.size,n.allocated,n.files,n.folders,
               n.modified_ms,n.created_ms,n.accessed_ms,n.depth,n.errors,n.extension,n.owner,n.attributes,
               n.newest_created_ms
               FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id
               WHERE {where_sql} ORDER BY {order} {direction}, n.id ASC LIMIT ? OFFSET ?"#
        );
        let mut page_values = values;
        let fetch_limit = if query.count_total {
            query.limit
        } else {
            query.limit.saturating_add(1)
        };
        page_values.push(Value::Integer(fetch_limit as i64));
        page_values.push(Value::Integer(query.offset as i64));
        let mut stmt = conn.prepare(&page_sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(page_values.iter()), node_from_row)
            .map_err(|error| error.to_string())?;
        let mut items = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        let has_more = if query.count_total {
            query.offset.saturating_add(items.len()) < total as usize
        } else {
            let more = items.len() > query.limit;
            items.truncate(query.limit);
            total = query.offset.saturating_add(items.len()) as u64 + u64::from(more);
            more
        };
        self.touch_scan(&query.scan_id).ok();
        Ok(NodePage {
            has_more,
            items,
            total,
            offset: query.offset,
            limit: query.limit,
        })
    }

    /// Return one bounded page of descendant files for a directory in a v2
    /// scan. Directory paths are persisted in SQLite, so this avoids rebuilding
    /// an in-memory subtree just to launch a compression selection.
    pub fn query_subtree_files(
        &self,
        mut query: SubtreeFilesQuery,
    ) -> Result<SubtreeFilePage, String> {
        if !safe_scan_id(&query.scan_id) {
            return Err("Invalid scan id".to_string());
        }
        query.limit = query.limit.clamp(1, SUBTREE_FILE_PAGE_MAX);
        let db_path = self.scans_dir.join(format!("{}.db", query.scan_id));
        let conn = open_scan_connection(&db_path).map_err(|error| error.to_string())?;
        subtree_directory_file_count(&conn, query.directory_id)?;
        let fetch_limit = query.limit.saturating_add(1);
        let sql = format!("{SUBTREE_FILE_SELECT_SQL} ORDER BY n.id ASC LIMIT ?2 OFFSET ?3");
        let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(
                params![query.directory_id, fetch_limit as i64, query.offset as i64],
                subtree_file_from_row,
            )
            .map_err(|error| error.to_string())?;
        let mut items = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        let has_more = items.len() > query.limit;
        items.truncate(query.limit);
        self.touch_scan(&query.scan_id).ok();
        Ok(SubtreeFilePage {
            items,
            offset: query.offset,
            limit: query.limit,
            has_more,
        })
    }

    /// Resolve every file under one persisted scan directory in a single
    /// SQLite traversal. Folder-compression jobs call this inside Rust so a
    /// large selection never crosses Tauri IPC as hundreds of paged path DTOs.
    pub fn query_all_subtree_files(
        &self,
        scan_id: &str,
        directory_id: i64,
    ) -> Result<Vec<IndexedCompressionSource>, String> {
        if !safe_scan_id(scan_id) {
            return Err("Invalid scan id".to_string());
        }
        let db_path = self.scans_dir.join(format!("{scan_id}.db"));
        let conn = open_scan_connection(&db_path).map_err(|error| error.to_string())?;
        let expected = subtree_directory_file_count(&conn, directory_id)?;
        let mut stmt = conn
            .prepare(SUBTREE_FILE_SELECT_SQL)
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![directory_id], indexed_subtree_file_from_row)
            .map_err(|error| error.to_string())?;
        let mut items = Vec::with_capacity(expected);
        for row in rows {
            items.push(row.map_err(|error| error.to_string())?);
        }
        self.touch_scan(scan_id).ok();
        Ok(items)
    }

    /// Stream a directory's complete recursive file list in bounded chunks.
    /// One SQLite cursor performs the traversal, so the renderer can list every
    /// file without either side constructing a giant IPC response.
    pub fn stream_subtree_files<F>(
        &self,
        scan_id: &str,
        directory_id: i64,
        chunk_size: usize,
        mut on_chunk: F,
    ) -> Result<usize, String>
    where
        F: FnMut(Vec<SubtreeFileItem>) -> Result<(), String>,
    {
        if !safe_scan_id(scan_id) {
            return Err("Invalid scan id".to_string());
        }
        let db_path = self.scans_dir.join(format!("{scan_id}.db"));
        let conn = open_scan_connection(&db_path).map_err(|error| error.to_string())?;
        subtree_directory_file_count(&conn, directory_id)?;
        let mut stmt = conn
            .prepare(SUBTREE_FILE_SELECT_SQL)
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![directory_id], subtree_file_from_row)
            .map_err(|error| error.to_string())?;
        let chunk_size = chunk_size.clamp(1, SUBTREE_FILE_PAGE_MAX);
        let mut chunk = Vec::with_capacity(chunk_size);
        let mut total = 0usize;
        for row in rows {
            chunk.push(row.map_err(|error| error.to_string())?);
            total += 1;
            if chunk.len() == chunk_size {
                on_chunk(std::mem::replace(
                    &mut chunk,
                    Vec::with_capacity(chunk_size),
                ))?;
            }
        }
        if !chunk.is_empty() {
            on_chunk(chunk)?;
        }
        self.touch_scan(scan_id).ok();
        Ok(total)
    }

    /// Return the largest file anywhere below a directory. Folder hover uses
    /// this single-row query instead of walking the renderer's partial lazy
    /// tree or transferring the complete subtree over IPC.
    pub fn query_largest_subtree_file(
        &self,
        scan_id: &str,
        directory_id: i64,
    ) -> Result<Option<SubtreeFileItem>, String> {
        if !safe_scan_id(scan_id) {
            return Err("Invalid scan id".to_string());
        }
        let db_path = self.scans_dir.join(format!("{scan_id}.db"));
        let conn = open_scan_connection(&db_path).map_err(|error| error.to_string())?;
        let directory_path = conn
            .query_row(
                "SELECT dir_path FROM nodes WHERE id=?1 AND is_dir=1",
                params![directory_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Directory is not present in scan: {directory_id}"))?;
        let descendant_pattern = format!("{}\\%", escape_duplicate_like(&directory_path));
        let item = conn
            .query_row(
                r#"SELECT
                     CASE WHEN p.dir_path IS NULL OR p.dir_path='' THEN n.name
                          WHEN substr(p.dir_path,-1,1) IN ('\','/') THEN p.dir_path || n.name
                          ELSE p.dir_path || '\' || n.name END,
                     n.size
                   FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id
                   WHERE n.is_dir=0 AND (p.dir_path=?1 OR p.dir_path LIKE ?2 ESCAPE '!')
                   ORDER BY n.size DESC,n.id ASC LIMIT 1"#,
                params![directory_path, descendant_pattern],
                |row| {
                    Ok(SubtreeFileItem {
                        path: row.get(0)?,
                        size: row.get::<_, i64>(1)?.max(0) as u64,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        self.touch_scan(scan_id).ok();
        Ok(item)
    }

    /// Find byte-identical files from one or more completed v2 scan indexes.
    /// Candidate metadata is staged in a temporary SQLite database so the
    /// renderer and Rust heap never retain every file path from a large drive.
    /// Hashing then runs one same-size bucket at a time and persists full hashes
    /// in state.db for later scans.
    pub fn find_exact_duplicates<F>(
        &self,
        mut request: DuplicateScanRequest,
        cancel: Arc<AtomicBool>,
        progress: F,
    ) -> Result<DuplicateScanResult, String>
    where
        F: Fn(DuplicateProgress) + Sync,
    {
        if request.sources.is_empty() || request.sources.len() > 16 {
            return Err("Select between 1 and 16 duplicate scan targets".to_string());
        }
        request.min_size = request.min_size.max(1);
        request.threads = request.threads.clamp(1, 16);
        request.extensions = request
            .extensions
            .into_iter()
            .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|value| !value.is_empty() && value.len() <= 64)
            .collect();
        request.extensions.sort();
        request.extensions.dedup();
        if request.excluded_paths.len() > 256
            || request
                .excluded_paths
                .iter()
                .any(|path| path.len() > 32_768)
            || request.path_rules.len() > 1_000
            || request
                .path_rules
                .iter()
                .any(|rule| rule.path.len() > 32_768)
        {
            return Err("Duplicate folder-state policy exceeds scan limits".to_string());
        }
        request.excluded_paths = request
            .excluded_paths
            .into_iter()
            .map(|path| duplicate_query_path(path.trim()))
            .filter(|path| !path.is_empty())
            .collect();
        request
            .excluded_paths
            .sort_by_key(|path| normalized_path_text(path));
        request
            .excluded_paths
            .dedup_by(|left, right| normalized_path_text(left) == normalized_path_text(right));
        request.path_rules = request
            .path_rules
            .into_iter()
            .filter_map(|mut rule| {
                rule.path = duplicate_query_path(rule.path.trim());
                (!rule.path.is_empty()).then_some(rule)
            })
            .collect();
        request
            .path_rules
            .extend(
                request
                    .excluded_paths
                    .iter()
                    .cloned()
                    .map(|path| DuplicatePathRule {
                        path,
                        excluded: true,
                    }),
            );
        request.path_rules.sort_by(|left, right| {
            normalized_path_text(&right.path)
                .len()
                .cmp(&normalized_path_text(&left.path).len())
                .then_with(|| {
                    normalized_path_text(&left.path).cmp(&normalized_path_text(&right.path))
                })
        });
        let mut folder_states = HashMap::<String, bool>::new();
        let mut conflicting_folder_state = false;
        request.path_rules.retain(|rule| {
            let key = normalized_path_text(&rule.path);
            match folder_states.get(&key) {
                Some(state) => {
                    conflicting_folder_state |= *state != rule.excluded;
                    false
                }
                None => {
                    folder_states.insert(key, rule.excluded);
                    true
                }
            }
        });
        if conflicting_folder_state {
            return Err("A duplicate folder can have only one state".to_string());
        }

        let work_path = self.scans_dir.join(format!(
            ".duplicate-work-{}-{}.db",
            std::process::id(),
            NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed),
        ));
        let _cleanup = TemporaryDatabase::new(work_path.clone());
        let mut work = open_scan_connection(&work_path).map_err(|error| error.to_string())?;
        work.execute_batch(
            "CREATE TABLE candidates(\
               path TEXT PRIMARY KEY COLLATE NOCASE,name TEXT NOT NULL,\
               size INTEGER NOT NULL,modified_ms INTEGER NOT NULL\
             );",
        )
        .map_err(|error| error.to_string())?;

        let mut scanned = 0u64;
        progress(DuplicateProgress {
            fraction: None,
            bytes_read: 0,
            phase: "indexing".to_string(),
            scanned,
            hashing: 0,
            hashed: 0,
        });

        for (source_index, source) in request.sources.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Ok(DuplicateScanResult {
                    groups: Vec::new(),
                    errors: Vec::new(),
                    scanned,
                    hashing: 0,
                    cancelled: true,
                });
            }
            let handle = self
                .catalog_handle(&source.scan_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("Scan index no longer exists: {}", source.scan_id))?;
            if handle.status != "done" && handle.status != "stale" {
                return Err(format!("Scan index is not ready: {}", source.scan_id));
            }
            if !path_is_within_text(&source.target_path, &handle.root_path) {
                return Err(format!(
                    "Duplicate target is outside its scan root: {}",
                    source.target_path
                ));
            }
            let scan_path = PathBuf::from(&handle.database_path);
            if !scan_path.is_file() {
                return Err(format!(
                    "Scan database no longer exists: {}",
                    source.scan_id
                ));
            }
            let schema = format!("duplicate_source_{source_index}");
            work.execute(
                &format!("ATTACH DATABASE ?1 AS {schema}"),
                params![scan_path.to_string_lossy()],
            )
            .map_err(|error| error.to_string())?;
            let max_node_id = work
                .query_row(
                    &format!("SELECT COALESCE(MAX(id),0) FROM {schema}.nodes"),
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())?
                .max(0);
            let path_expr = "CASE WHEN p.dir_path IS NULL OR p.dir_path='' THEN n.name WHEN substr(p.dir_path,-1,1) IN ('\\','/') THEN p.dir_path || n.name ELSE p.dir_path || '\\' || n.name END";
            let query_dir_path = duplicate_query_dir_path_sql();
            let mut clauses = vec![
                "n.is_dir=0".to_string(),
                "n.size>=?".to_string(),
                format!(
                    "({query_dir_path}=? COLLATE NOCASE OR {query_dir_path} LIKE ? ESCAPE '!')"
                ),
            ];
            let target = duplicate_query_path(&source.target_path);
            let mut values = vec![
                Value::Integer(as_sql_i64(request.min_size)),
                Value::Text(target.clone()),
                Value::Text(duplicate_descendant_pattern(&target)),
            ];
            let relevant_rules = request
                .path_rules
                .iter()
                .filter(|rule| {
                    path_is_within_text(&rule.path, &source.target_path)
                        || path_is_within_text(&source.target_path, &rule.path)
                })
                .collect::<Vec<_>>();
            if !relevant_rules.is_empty() {
                let mut scope_case = "CASE ".to_string();
                for rule in relevant_rules {
                    scope_case.push_str(&format!(
                        "WHEN ({query_dir_path}=? COLLATE NOCASE OR {query_dir_path} LIKE ? ESCAPE '!') THEN {} ",
                        if rule.excluded { 0 } else { 1 },
                    ));
                    let path = duplicate_query_path(&rule.path);
                    values.push(Value::Text(path.clone()));
                    values.push(Value::Text(duplicate_descendant_pattern(&path)));
                }
                scope_case.push_str("ELSE 1 END=1");
                clauses.push(scope_case);
            }
            if let Some(max_size) = request.max_size {
                clauses.push("n.size<=?".to_string());
                values.push(Value::Integer(as_sql_i64(max_size)));
            }
            if !request.include_hidden {
                clauses.push("n.hidden=0".to_string());
            }
            if !request.extensions.is_empty() {
                clauses.push(format!(
                    "lower(n.extension) IN ({})",
                    std::iter::repeat_n("?", request.extensions.len())
                        .collect::<Vec<_>>()
                        .join(",")
                ));
                values.extend(request.extensions.iter().cloned().map(Value::Text));
            }
            clauses.push("n.id>?".to_string());
            clauses.push("n.id<=?".to_string());
            let sql = format!(
                "INSERT OR IGNORE INTO candidates(path,name,size,modified_ms) \
                 SELECT {path_expr},n.name,n.size,n.modified_ms FROM {schema}.nodes n \
                 LEFT JOIN {schema}.nodes p ON p.id=n.parent_id WHERE {} ORDER BY n.id",
                clauses.join(" AND ")
            );
            let tx = work.transaction().map_err(|error| error.to_string())?;
            const INDEX_BATCH_IDS: i64 = 50_000;
            let mut lower_id = 0i64;
            while lower_id < max_node_id {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let upper_id = lower_id.saturating_add(INDEX_BATCH_IDS).min(max_node_id);
                let mut batch_values = values.clone();
                batch_values.push(Value::Integer(lower_id));
                batch_values.push(Value::Integer(upper_id));
                let inserted = tx
                    .execute(&sql, params_from_iter(batch_values.iter()))
                    .map_err(|error| error.to_string())?;
                scanned = scanned.saturating_add(inserted as u64);
                progress(DuplicateProgress {
                    fraction: Some(
                        (source_index as f64 + upper_id as f64 / max_node_id.max(1) as f64)
                            / request.sources.len() as f64,
                    ),
                    bytes_read: 0,
                    phase: "indexing".to_string(),
                    scanned,
                    hashing: 0,
                    hashed: 0,
                });
                lower_id = upper_id;
            }
            tx.commit().map_err(|error| error.to_string())?;
            work.execute_batch(&format!("DETACH DATABASE {schema}"))
                .map_err(|error| error.to_string())?;
            progress(DuplicateProgress {
                fraction: Some((source_index + 1) as f64 / request.sources.len() as f64),
                bytes_read: 0,
                phase: "indexing".to_string(),
                scanned,
                hashing: 0,
                hashed: 0,
            });
        }

        if cancel.load(Ordering::Relaxed) {
            return Ok(DuplicateScanResult {
                groups: Vec::new(),
                errors: Vec::new(),
                scanned,
                hashing: 0,
                cancelled: true,
            });
        }
        if request.metadata_only {
            let mut keys = Vec::new();
            if request.metadata_size {
                keys.push("size".to_string());
            }
            if request.metadata_name {
                keys.push("lower(name)".to_string());
            }
            if request.metadata_date {
                keys.push(format!(
                    "round((modified_ms / 1000) / {}.0)",
                    request.date_tolerance_sec.max(1)
                ));
            }
            if keys.is_empty() {
                return Err("Enable Filename, Size, or Date for a metadata scan".to_string());
            }
            progress(DuplicateProgress {
                fraction: Some(0.0),
                phase: "grouping".into(),
                scanned,
                hashing: 0,
                hashed: 0,
                bytes_read: 0,
            });
            // Stream metadata once. Keep only keys and first row IDs for singletons,
            // rather than sorting/materializing several SQL window-function results.
            let key_columns = keys
                .iter()
                .map(|key| format!("CAST({key} AS TEXT)"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!("SELECT rowid,{key_columns} FROM candidates");
            let mut statement = work.prepare(&sql).map_err(|error| error.to_string())?;
            let mut lookup = work
                .prepare("SELECT path,name,size,modified_ms FROM candidates WHERE rowid=?1")
                .map_err(|error| error.to_string())?;
            let mut read_file = |id: i64| -> Result<DuplicateFile, String> {
                lookup
                    .query_row([id], |row| {
                        Ok(DuplicateFile {
                            path: row.get(0)?,
                            name: row.get(1)?,
                            size: row.get::<_, i64>(2)?.max(0) as u64,
                            modified: row.get::<_, i64>(3)?.max(0) as u64 / 1000,
                        })
                    })
                    .map_err(|error| error.to_string())
            };
            let mut rows = statement.query([]).map_err(|error| error.to_string())?;
            let mut groups: Vec<DuplicateGroup> = Vec::new();
            let mut buckets: HashMap<Vec<String>, (i64, Option<usize>)> = HashMap::new();
            let mut grouped = 0u64;
            let mut last_report = Instant::now();
            while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(DuplicateScanResult {
                        groups: Vec::new(),
                        errors: Vec::new(),
                        scanned,
                        hashing: 0,
                        cancelled: true,
                    });
                }
                let id: i64 = row.get(0).map_err(|error| error.to_string())?;
                let key = (1..=keys.len())
                    .map(|column| row.get::<_, String>(column))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                match buckets.entry(key) {
                    std::collections::hash_map::Entry::Vacant(entry) => {
                        entry.insert((id, None));
                    }
                    std::collections::hash_map::Entry::Occupied(mut entry) => {
                        let (first_id, group_index) = entry.get_mut();
                        let index = match *group_index {
                            Some(index) => index,
                            None => {
                                let index = groups.len();
                                groups.push(DuplicateGroup {
                                    files: vec![read_file(*first_id)?],
                                    waste: 0,
                                });
                                *group_index = Some(index);
                                index
                            }
                        };
                        let file = read_file(id)?;
                        groups[index].waste = groups[index].waste.saturating_add(file.size);
                        groups[index].files.push(file);
                    }
                }
                grouped += 1;
                if grouped == 1
                    || grouped == scanned
                    || last_report.elapsed() >= Duration::from_millis(100)
                {
                    progress(DuplicateProgress {
                        fraction: Some(grouped as f64 / scanned.max(1) as f64),
                        bytes_read: 0,
                        phase: "grouping".into(),
                        scanned,
                        hashing: scanned,
                        hashed: grouped,
                    });
                    last_report = Instant::now();
                }
            }
            progress(DuplicateProgress {
                fraction: None,
                phase: "done".into(),
                scanned,
                hashing: 0,
                hashed: 0,
                bytes_read: 0,
            });
            return Ok(DuplicateScanResult {
                groups,
                errors: Vec::new(),
                scanned,
                hashing: 0,
                cancelled: false,
            });
        }

        work.execute_batch("CREATE INDEX candidates_size ON candidates(size); PRAGMA optimize;")
            .map_err(|error| error.to_string())?;
        let size_groups = {
            let mut stmt = work
                .prepare(
                    "SELECT size,COUNT(*) FROM candidates \
                     GROUP BY size HAVING COUNT(*)>1 ORDER BY size DESC",
                )
                .map_err(|error| error.to_string())?;
            stmt.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?.max(0) as u64))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?
        };
        let hashing = size_groups.iter().map(|(_, count)| count).sum::<u64>();
        let hash_batches = duplicate_hash_batches(&size_groups);

        progress(DuplicateProgress {
            fraction: None,
            bytes_read: 0,
            phase: "hashing".to_string(),
            scanned,
            hashing,
            hashed: 0,
        });
        let state = self.open_state().map_err(|error| error.to_string())?;
        state
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS duplicate_fingerprints_v1(
            path TEXT PRIMARY KEY COLLATE NOCASE, size INTEGER NOT NULL, modified INTEGER NOT NULL,
            quick TEXT, sample TEXT) WITHOUT ROWID;",
            )
            .map_err(|e| e.to_string())?;
        let mut groups = Vec::new();
        let mut errors = Vec::new();
        let mut hashed = 0u64;
        let mut total_bytes_read = 0u64;
        for size_batch in hash_batches {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let files = {
                let placeholders = std::iter::repeat_n("?", size_batch.len())
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT path,name,size,modified_ms FROM candidates \
                     WHERE size IN ({placeholders}) ORDER BY size DESC,path COLLATE NOCASE"
                );
                let mut stmt = work.prepare(&sql).map_err(|error| error.to_string())?;
                stmt.query_map(params_from_iter(size_batch.iter()), |row| {
                    Ok(DuplicateFile {
                        path: row.get(0)?,
                        name: row.get(1)?,
                        size: row.get::<_, i64>(2)?.max(0) as u64,
                        modified: (row.get::<_, i64>(3)?.max(0) as u64) / 1000,
                    })
                })
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?
            };
            let inputs = files
                .iter()
                .map(|file| HashInput {
                    path: PathBuf::from(&file.path),
                    size: file.size,
                    mtime: file.modified,
                })
                .collect::<Vec<_>>();
            let cached = load_duplicate_hash_cache(&state, &inputs)?;
            let saved_fingerprints = load_duplicate_fingerprints(&state, &inputs)?;
            let fingerprints = Mutex::new(saved_fingerprints.clone());
            let existing_cache_paths = cached.keys().cloned().collect::<HashSet<_>>();
            let cache = Mutex::new(cached);
            let hashed_before_batch = hashed;
            let batch_bytes_read = AtomicU64::new(0);
            let report_batch_progress = |batch_progress: HashCandidateProgress| {
                batch_bytes_read.store(batch_progress.bytes_read, Ordering::Relaxed);
                progress(DuplicateProgress {
                    fraction: Some(batch_progress.fraction),
                    bytes_read: total_bytes_read.saturating_add(batch_progress.bytes_read),
                    phase: batch_progress.stage.to_string(),
                    scanned,
                    hashing,
                    hashed: hashed_before_batch
                        .saturating_add(batch_progress.completed.min(batch_progress.total) as u64)
                        .min(hashing),
                });
            };
            let (bucket_groups, bucket_errors) = hash_candidate_groups_with_fingerprints(
                &inputs,
                // A full-file hash is sufficient for discovery. Every move,
                // delete, copy, or link is still rechecked byte-for-byte by the
                // duplicate action boundary immediately before mutation. Doing
                // the same full read here made cached repeat scans unnecessarily
                // reread all duplicate data.
                false,
                &cache,
                None,
                None,
                Some(&cancel),
                request.threads,
                Some(&report_batch_progress),
                Some(&fingerprints),
            );
            total_bytes_read =
                total_bytes_read.saturating_add(batch_bytes_read.load(Ordering::Relaxed));
            errors.extend(
                bucket_errors
                    .into_iter()
                    .take(200usize.saturating_sub(errors.len())),
            );
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let updated_fingerprints = fingerprints
                .into_inner()
                .map_err(|_| "Fingerprint cache unavailable")?;
            let changed = updated_fingerprints
                .iter()
                .filter(|(path, value)| saved_fingerprints.get(*path) != Some(*value))
                .collect::<Vec<_>>();
            if !changed.is_empty() {
                let tx = state.unchecked_transaction().map_err(|e| e.to_string())?;
                {
                    let mut insert = tx.prepare_cached("INSERT INTO duplicate_fingerprints_v1(path,size,modified,quick,sample) VALUES(?1,?2,?3,?4,?5)
                        ON CONFLICT(path) DO UPDATE SET size=excluded.size,modified=excluded.modified,quick=excluded.quick,sample=excluded.sample").map_err(|e| e.to_string())?;
                    for (path, entry) in changed {
                        insert
                            .execute(params![
                                path.to_string_lossy(),
                                as_sql_i64(entry.size),
                                as_sql_i64(entry.mtime),
                                entry.quick.map(|value| value.to_string()),
                                entry.sample.map(|value| value.to_string())
                            ])
                            .map_err(|e| e.to_string())?;
                    }
                }
                tx.commit().map_err(|e| e.to_string())?;
            }
            let cached = cache
                .into_inner()
                .map_err(|_| "Duplicate hash cache is unavailable")?;
            let new_cache_entries = cached
                .into_iter()
                .filter(|(path, _)| !existing_cache_paths.contains(path))
                .collect::<Vec<_>>();
            if !new_cache_entries.is_empty() {
                let tx = state
                    .unchecked_transaction()
                    .map_err(|error| error.to_string())?;
                {
                    let mut upsert = tx
                        .prepare_cached(
                            "INSERT INTO duplicate_hashes(path,size,modified,hash,updated_at) VALUES(?1,?2,?3,?4,?5)\
                             ON CONFLICT(path) DO UPDATE SET size=excluded.size,modified=excluded.modified,hash=excluded.hash,updated_at=excluded.updated_at",
                        )
                        .map_err(|error| error.to_string())?;
                    let updated_at = now_ms() as i64;
                    for (path, entry) in new_cache_entries {
                        upsert
                            .execute(params![
                                path.to_string_lossy(),
                                as_sql_i64(entry.size),
                                as_sql_i64(entry.mtime),
                                entry.hash.to_string(),
                                updated_at,
                            ])
                            .map_err(|error| error.to_string())?;
                    }
                }
                tx.commit().map_err(|error| error.to_string())?;
            }
            for (_, indices) in bucket_groups {
                let group_files = indices
                    .into_iter()
                    .filter_map(|index| files.get(index).cloned())
                    .collect::<Vec<_>>();
                if group_files.len() >= 2 {
                    let waste = group_files[0]
                        .size
                        .saturating_mul((group_files.len() - 1) as u64);
                    groups.push(DuplicateGroup {
                        files: group_files,
                        waste,
                    });
                }
            }
            hashed = hashed.saturating_add(files.len() as u64);
            progress(DuplicateProgress {
                fraction: None,
                bytes_read: total_bytes_read,
                phase: "hashing".to_string(),
                scanned,
                hashing,
                hashed: hashed.min(hashing),
            });
        }
        let cancelled = cancel.load(Ordering::Relaxed);
        if !cancelled {
            groups.sort_by(|left, right| right.waste.cmp(&left.waste));
            progress(DuplicateProgress {
                fraction: None,
                bytes_read: total_bytes_read,
                phase: "done".to_string(),
                scanned,
                hashing,
                hashed: hashing,
            });
        }
        Ok(DuplicateScanResult {
            groups: if cancelled { Vec::new() } else { groups },
            errors,
            scanned,
            hashing,
            cancelled,
        })
    }

    /// Return one directory's cached children in a single bounded query. Live
    /// filesystem snapshots use this to retain aggregate totals for branches
    /// that are not materialized in the renderer.
    pub fn query_snapshot_children(
        &self,
        scan_id: &str,
        parent_id: i64,
        limit: usize,
    ) -> Result<Vec<NodePageItem>, String> {
        if !safe_scan_id(scan_id) {
            return Err("Invalid scan id".to_string());
        }
        let db_path = self.scans_dir.join(format!("{scan_id}.db"));
        let conn = open_scan_connection(&db_path).map_err(|error| error.to_string())?;
        let sql = r#"SELECT n.id,n.parent_id,n.name,
               CASE WHEN n.is_dir=1 THEN n.dir_path
                    WHEN p.dir_path IS NULL OR p.dir_path='' THEN n.name
                    WHEN substr(p.dir_path,-1,1) IN ('\','/') THEN p.dir_path || n.name
                    ELSE p.dir_path || '\' || n.name END,
               n.is_dir,n.is_link,n.hidden,n.readonly,n.size,n.allocated,n.files,n.folders,
               n.modified_ms,n.created_ms,n.accessed_ms,n.depth,n.errors,n.extension,n.owner,n.attributes,
               n.newest_created_ms
               FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id
               WHERE n.parent_id=?1 ORDER BY n.id ASC LIMIT ?2"#;
        let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(
                params![parent_id, limit.clamp(1, 50_000) as i64],
                node_from_row,
            )
            .map_err(|error| error.to_string())?;
        let items = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        self.touch_scan(scan_id).ok();
        Ok(items)
    }

    pub fn set_scan_pinned(&self, scan_id: &str, pinned: bool) -> Result<(), String> {
        let conn = self.open_state().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE scan_catalog SET pinned=?2,last_used=?3 WHERE scan_id=?1",
            params![scan_id, pinned as i64, now_ms() as i64],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn mark_scans_stale_for_path(&self, path: &Path) -> Result<usize, String> {
        let resolved = if path.exists() {
            fs::canonicalize(path).ok()
        } else {
            path.parent()
                .and_then(|parent| fs::canonicalize(parent).ok())
        };
        let Some(resolved) = resolved else {
            return Ok(0);
        };
        let conn = self.open_state().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare("SELECT scan_id,root_path FROM scan_catalog WHERE status='done'")
            .map_err(|error| error.to_string())?;
        let stale = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .filter_map(|(id, root)| fs::canonicalize(root).ok().map(|root| (id, root)))
            .filter(|(_, root)| resolved.starts_with(root))
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        drop(stmt);
        for id in &stale {
            conn.execute(
                "UPDATE scan_catalog SET status='stale',last_used=?2 WHERE scan_id=?1",
                params![id, now_ms() as i64],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(stale.len())
    }

    pub fn source_path_is_authorized(&self, path: &str) -> bool {
        self.source_paths_are_authorized(&[path])
    }

    /// Authorize a batch with one catalog read and one canonicalization per
    /// matching scan root. Context menus commonly receive a large selection;
    /// validating each item with a fresh SQLite connection made right-click
    /// latency grow linearly with the selection size.
    pub fn source_paths_are_authorized(&self, paths: &[&str]) -> bool {
        if paths.is_empty() {
            return false;
        }
        let Ok(conn) = self.open_state() else {
            return false;
        };
        let Ok(mut stmt) = conn.prepare(
            "SELECT root_path FROM scan_catalog \
             WHERE status IN ('scanning','done','stale') ORDER BY last_used DESC",
        ) else {
            return false;
        };
        let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
            return false;
        };
        let roots = rows.filter_map(Result::ok).collect::<Vec<_>>();
        let mut canonical_roots = HashMap::<String, Option<PathBuf>>::new();
        paths.iter().all(|path| {
            let requested = Path::new(path);
            // canonicalize already determines whether the item exists; calling
            // exists first added a redundant filesystem round trip to every
            // context-menu request. Keep the parent fallback for operations on
            // an item that disappeared after its scan.
            let resolved = fs::canonicalize(requested).ok().or_else(|| {
                requested
                    .parent()
                    .and_then(|parent| fs::canonicalize(parent).ok())
            });
            let Some(resolved) = resolved else {
                return false;
            };
            roots.iter().any(|root| {
                // Avoid touching unrelated historical/offline roots. This text
                // check is only a prefilter; canonical containment below remains
                // the security boundary against symlink/path traversal escapes.
                if !path_is_within_text(path, root) {
                    return false;
                }
                canonical_roots
                    .entry(root.clone())
                    .or_insert_with(|| fs::canonicalize(root).ok())
                    .as_ref()
                    .is_some_and(|root| resolved.starts_with(root))
            })
        })
    }

    /// Validate scan-indexed sources against live filesystem metadata. Parent
    /// canonicalization is cached, while current or scan-time file links are
    /// resolved individually. Sources removed since the scan are dropped.
    pub fn validate_indexed_sources_authorized(
        &self,
        sources: &mut Vec<IndexedCompressionSource>,
    ) -> Result<usize, String> {
        if sources.is_empty() {
            return Ok(0);
        }
        let conn = self.open_state().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT root_path FROM scan_catalog \
                 WHERE status IN ('scanning','done','stale') ORDER BY last_used DESC",
            )
            .map_err(|error| error.to_string())?;
        let root_rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let root_texts = root_rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        let canonical_roots = root_texts
            .iter()
            .filter_map(|root| fs::canonicalize(root).ok())
            .collect::<Vec<_>>();
        let mut parent_authorized = HashMap::<PathBuf, bool>::new();
        let mut retained = Vec::with_capacity(sources.len());
        let mut missing = 0usize;

        for source in std::mem::take(sources) {
            let requested = Path::new(&source.path);
            let metadata = match fs::symlink_metadata(requested) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing += 1;
                    continue;
                }
                Err(error) => {
                    return Err(format!(
                        "Could not validate compression source {}: {error}",
                        source.path
                    ));
                }
            };
            let authorized = if source.is_link || metadata.file_type().is_symlink() {
                let resolved = fs::canonicalize(requested).map_err(|error| {
                    format!(
                        "Could not resolve compression source {}: {error}",
                        source.path
                    )
                })?;
                canonical_roots
                    .iter()
                    .any(|root| resolved.starts_with(root))
            } else if let Some(parent) = requested.parent() {
                *parent_authorized
                    .entry(parent.to_path_buf())
                    .or_insert_with(|| {
                        fs::canonicalize(parent).ok().is_some_and(|resolved| {
                            canonical_roots
                                .iter()
                                .any(|root| resolved.starts_with(root))
                        })
                    })
            } else {
                false
            };
            if !authorized {
                return Err(format!(
                    "Source path is outside the scanned directories: {}",
                    source.path
                ));
            }
            retained.push(source);
        }
        *sources = retained;
        Ok(missing)
    }

    pub fn load_json_setting(&self, key: &str, fallback: &str) -> Result<String, String> {
        let conn = self.open_state().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT value FROM settings WHERE key=?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map(|value| value.unwrap_or_else(|| fallback.to_string()))
        .map_err(|error| error.to_string())
    }

    pub fn save_json_setting(
        &self,
        key: &str,
        value: &str,
        max_bytes: usize,
    ) -> Result<(), String> {
        if value.len() > max_bytes {
            return Err(format!("Setting {key} exceeds the {max_bytes}-byte limit"));
        }
        serde_json::from_str::<serde_json::Value>(value)
            .map_err(|error| format!("Invalid JSON for setting {key}: {error}"))?;
        let conn = self.open_state().map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)\
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            params![key, value, now_ms() as i64],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn persist_compression_job<I>(
        &self,
        id: &str,
        status: &str,
        total: usize,
        settings_json: &str,
        files: I,
    ) -> Result<(), String>
    where
        I: IntoIterator<Item = CompressionFileRecord>,
    {
        if !safe_job_id(id) {
            return Err("Invalid compression job id".to_string());
        }
        serde_json::from_str::<serde_json::Value>(settings_json)
            .map_err(|error| format!("Invalid compression settings: {error}"))?;
        let mut conn = self.open_state().map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let now = now_ms() as i64;
        tx.execute(
            "INSERT INTO compression_jobs(id,status,total,processed,active,saved_bytes,settings_json,created_at,updated_at)\
             VALUES(?1,?2,?3,0,0,0,?4,?5,?5)\
             ON CONFLICT(id) DO UPDATE SET status=excluded.status,total=excluded.total,settings_json=excluded.settings_json,updated_at=excluded.updated_at",
            params![id, status, total as i64, settings_json, now],
        )
        .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM compression_files WHERE job_id=?1", params![id])
            .map_err(|error| error.to_string())?;
        {
            let mut statement = tx
                .prepare(COMPRESSION_FILE_UPSERT_SQL)
                .map_err(|error| error.to_string())?;
            for file in files {
                persist_compression_file(&mut statement, &file)
                    .map_err(|error| error.to_string())?;
            }
        }
        tx.commit().map_err(|error| error.to_string())
    }

    pub fn queue_compression_file(&self, file: CompressionFileRecord, terminal: bool) {
        match self
            .compression_tx
            .try_send(CompressionWrite::File(Box::new(file)))
        {
            Ok(()) => {}
            Err(TrySendError::Full(CompressionWrite::File(file))) if terminal => {
                let _ = self.compression_tx.send(CompressionWrite::File(file));
            }
            Err(TrySendError::Full(_)) => {}
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    pub fn queue_compression_job_state(&self, id: &str, status: &str, saved_bytes: u64) {
        let _ = self.compression_tx.send(CompressionWrite::JobState {
            id: id.to_string(),
            status: status.to_string(),
            saved_bytes,
        });
    }

    pub fn delete_compression_job(&self, id: &str) -> Result<(), String> {
        if !safe_job_id(id) {
            return Err("Invalid compression job id".to_string());
        }
        let mut conn = self.open_state().map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM compression_files WHERE job_id=?1", params![id])
            .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM compression_jobs WHERE id=?1", params![id])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    }

    pub fn query_compression_files(
        &self,
        id: &str,
        query: CompressionPageQuery,
    ) -> Result<Option<CompressionFilePage>, String> {
        if !safe_job_id(id) {
            return Ok(None);
        }
        let conn = self.open_state().map_err(|error| error.to_string())?;
        let exists = conn
            .query_row(
                "SELECT 1 FROM compression_jobs WHERE id=?1",
                params![id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some();
        if !exists {
            return Ok(None);
        }

        let now = now_ms();
        let mut where_sql = "job_id=?1".to_string();
        let mut values = vec![Value::Text(id.to_string())];
        let search = query.search.trim();
        if !search.is_empty() {
            let value = Value::Text(format!("%{}%", escape_like(&search.to_ascii_lowercase())));
            where_sql.push_str(
                " AND (LOWER(path) LIKE ? ESCAPE '\\' OR LOWER(reason) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(error_text,'')) LIKE ? ESCAPE '\\')",
            );
            values.extend([value.clone(), value.clone(), value]);
        }
        push_csv_sql(&mut where_sql, &mut values, "status", &query.status);
        push_csv_sql(&mut where_sql, &mut values, "kind", &query.kind);
        push_csv_sql(&mut where_sql, &mut values, "reason", &query.outcome);
        push_csv_sql(
            &mut where_sql,
            &mut values,
            "disposition",
            &query.disposition,
        );
        if !query.encoder.trim().is_empty() {
            where_sql.push_str(" AND LOWER(encoder) LIKE ? ESCAPE '\\'");
            values.push(Value::Text(format!(
                "%{}%",
                escape_like(&query.encoder.trim().to_ascii_lowercase())
            )));
        }
        if !query.path.trim().is_empty() {
            where_sql.push_str(" AND LOWER(path) LIKE ? ESCAPE '\\'");
            values.push(Value::Text(format!(
                "%{}%",
                escape_like(&query.path.trim().to_ascii_lowercase())
            )));
        }
        if query.attention {
            where_sql.push_str(" AND (status='error' OR (status='running' AND updated_at<?))");
            values.push(Value::Integer(now.saturating_sub(120_000) as i64));
        }

        let total = conn
            .query_row(
                "SELECT total FROM compression_jobs WHERE id=?1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
            .max(0) as u64;
        let total_matches = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM compression_files WHERE {where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?
            .max(0) as u64;

        let sort = compression_sort_sql(&query.sort);
        let direction = if query.direction.eq_ignore_ascii_case("desc") {
            "DESC"
        } else {
            "ASC"
        };
        let limit = query.limit.clamp(1, COMPRESSION_PAGE_MAX);
        let offset = query.offset.min(total_matches as usize);
        let mut page_values = values.clone();
        page_values.push(Value::Integer(now.saturating_sub(15_000) as i64));
        page_values.push(Value::Integer(limit as i64));
        page_values.push(Value::Integer(offset as i64));
        let sql = format!(
            "SELECT id,path,kind,status,stage,progress,original_bytes,output_bytes,error_text,reason,encoder,disposition,out_path,duration_ms,fps,started_at,updated_at,finished_at,attempt,tool,tool_version,command_text,stderr_text,recycled,queue_position \
             FROM compression_files WHERE {where_sql} \
             ORDER BY CASE WHEN status='running' THEN 0 WHEN finished_at>0 AND finished_at>=? THEN 1 ELSE 2 END ASC,\
                      CASE WHEN status='running' THEN started_at ELSE 0 END ASC,\
                      CASE WHEN finished_at>0 AND finished_at>=? THEN finished_at ELSE 0 END DESC,\
                      {sort} {direction},id ASC LIMIT ? OFFSET ?"
        );
        // The recent-finish cutoff is referenced twice in the ORDER BY.
        let cutoff = page_values.remove(page_values.len() - 3);
        let insert_at = page_values.len() - 2;
        page_values.insert(insert_at, cutoff.clone());
        page_values.insert(insert_at, cutoff);
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params_from_iter(page_values.iter()), |row| {
                compression_item_from_row(row, now)
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;

        let mut facets = HashMap::new();
        for (name, column) in [
            ("status", "status"),
            ("type", "kind"),
            ("encoder", "encoder"),
            ("outcome", "reason"),
            ("disposition", "disposition"),
        ] {
            let facet_sql = format!(
                "SELECT {column},COUNT(*) FROM compression_files WHERE {where_sql} AND {column}<>'' GROUP BY {column} ORDER BY {column}"
            );
            let mut statement = conn
                .prepare(&facet_sql)
                .map_err(|error| error.to_string())?;
            let values_for_facet = statement
                .query_map(params_from_iter(values.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?.max(0) as u64,
                    ))
                })
                .map_err(|error| error.to_string())?
                .collect::<rusqlite::Result<HashMap<_, _>>>()
                .map_err(|error| error.to_string())?;
            facets.insert(name.to_string(), values_for_facet);
        }

        Ok(Some(CompressionFilePage {
            id: id.to_string(),
            items: rows,
            total,
            total_matches,
            offset,
            limit,
            facets,
        }))
    }

    pub fn memory_stats(&self) -> MemoryStats {
        let (working_set_bytes, private_bytes) = process_memory_bytes();
        let active_scans = self
            .jobs
            .lock_unpoisoned()
            .values()
            .filter(|job| !job.terminal)
            .count();
        MemoryStats {
            working_set_bytes,
            private_bytes,
            managed_budget_bytes: MANAGED_MEMORY_BUDGET_BYTES,
            scan_index_bytes: directory_size(&self.scans_dir),
            active_scans,
            retained_scan_handles: self.jobs.lock_unpoisoned().len(),
        }
    }

    pub fn enforce_scan_disk_budget(&self) -> Result<u64, String> {
        self.enforce_scan_disk_budget_with_limit(SCAN_DISK_BUDGET_BYTES, None)
    }

    fn enforce_scan_disk_budget_preserving(&self, scan_id: &str) -> Result<u64, String> {
        self.enforce_scan_disk_budget_with_limit(SCAN_DISK_BUDGET_BYTES, Some(scan_id))
    }

    fn enforce_scan_disk_budget_with_limit(
        &self,
        budget_bytes: u64,
        preserve_scan_id: Option<&str>,
    ) -> Result<u64, String> {
        let active: HashSet<String> = self
            .jobs
            .lock_unpoisoned()
            .iter()
            .filter(|(_, job)| !job.terminal)
            .map(|(id, _)| id.clone())
            .collect();
        let conn = self.open_state().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT scan_id,db_path,pinned,last_used FROM scan_catalog ORDER BY last_used ASC",
            )
            .map_err(|error| error.to_string())?;
        let entries = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PathBuf::from(row.get::<_, String>(1)?),
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        // Only catalogued databases participate in LRU eviction. Counting
        // abandoned files here could make them evict the sole valid result,
        // after which scan_page would open an empty SQLite file and report
        // "no such table: nodes".
        let mut total = entries
            .iter()
            .map(|(_, path, _, _)| database_family_size(path))
            .sum::<u64>();
        let mut freed = 0u64;
        for (scan_id, path, pinned, _) in entries {
            if total <= budget_bytes {
                break;
            }
            if pinned
                || active.contains(&scan_id)
                || preserve_scan_id.is_some_and(|preserved| preserved == scan_id)
            {
                continue;
            }
            let bytes = database_family_size(&path);
            remove_database_family(&path);
            conn.execute(
                "DELETE FROM scan_catalog WHERE scan_id=?1",
                params![scan_id],
            )
            .map_err(|error| error.to_string())?;
            total = total.saturating_sub(bytes);
            freed = freed.saturating_add(bytes);
        }
        Ok(freed)
    }

    fn cleanup_orphan_scan_databases(&self) -> Result<u64, String> {
        let conn = self.open_state().map_err(|error| error.to_string())?;
        let mut stmt = conn
            .prepare("SELECT scan_id FROM scan_catalog")
            .map_err(|error| error.to_string())?;
        let catalogued = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<HashSet<_>>>()
            .map_err(|error| error.to_string())?;
        drop(stmt);
        drop(conn);

        // V2Store::open calls this before scans can start in this process. The
        // jobs check also keeps the helper safe for tests and future runtime use.
        let jobs = self.jobs.lock_unpoisoned();
        let mut freed = 0u64;
        let entries = fs::read_dir(&self.scans_dir).map_err(|error| error.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("db") {
                continue;
            }
            let Some(scan_id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if !safe_scan_id(scan_id) || catalogued.contains(scan_id) || jobs.contains_key(scan_id)
            {
                continue;
            }
            let Some(owner_pid) = scan_owner_process_id(scan_id) else {
                continue;
            };
            if owner_pid != std::process::id() && process_is_alive(owner_pid) {
                continue;
            }
            let bytes = database_family_size(&path);
            remove_database_family(&path);
            freed = freed.saturating_add(bytes);
        }
        Ok(freed)
    }

    fn initialize_state(&self) -> rusqlite::Result<()> {
        let conn = self.open_state()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_info(version INTEGER NOT NULL);\
             INSERT INTO schema_info(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_info);\
             CREATE TABLE IF NOT EXISTS scan_catalog(\
               scan_id TEXT PRIMARY KEY, root_path TEXT NOT NULL, db_path TEXT NOT NULL,\
               status TEXT NOT NULL, node_count INTEGER NOT NULL DEFAULT 0,\
               created_at INTEGER NOT NULL, last_used INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0\
             );\
              CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);\
              CREATE TABLE IF NOT EXISTS secrets(key TEXT PRIMARY KEY,value BLOB NOT NULL,updated_at INTEGER NOT NULL);\
              CREATE TABLE IF NOT EXISTS duplicate_hashes(\
                path TEXT PRIMARY KEY COLLATE NOCASE,size INTEGER NOT NULL,modified INTEGER NOT NULL,\
                hash TEXT NOT NULL,updated_at INTEGER NOT NULL\
              );\
              CREATE TABLE IF NOT EXISTS compression_jobs(\
               id TEXT PRIMARY KEY,status TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,\
               processed INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 0,\
               saved_bytes INTEGER NOT NULL DEFAULT 0,settings_json TEXT NOT NULL DEFAULT '{}',\
               created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS compression_files(\
               job_id TEXT NOT NULL,id INTEGER NOT NULL,path TEXT NOT NULL,status TEXT NOT NULL,\
               stage TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,original_bytes INTEGER NOT NULL DEFAULT 0,\
               output_bytes INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,\
               kind TEXT NOT NULL DEFAULT 'other',reason TEXT NOT NULL DEFAULT '',\
               encoder TEXT NOT NULL DEFAULT '',disposition TEXT NOT NULL DEFAULT '',\
               out_path TEXT NOT NULL DEFAULT '',error_text TEXT,duration_ms INTEGER NOT NULL DEFAULT 0,\
               fps REAL,started_at INTEGER NOT NULL DEFAULT 0,finished_at INTEGER NOT NULL DEFAULT 0,\
               attempt INTEGER NOT NULL DEFAULT 0,tool TEXT NOT NULL DEFAULT '',\
               tool_version TEXT NOT NULL DEFAULT '',command_text TEXT NOT NULL DEFAULT '',\
               stderr_text TEXT NOT NULL DEFAULT '',recycled INTEGER NOT NULL DEFAULT 0,queue_position INTEGER,\
               PRIMARY KEY(job_id,id)\
             );\
             CREATE INDEX IF NOT EXISTS compression_files_status ON compression_files(job_id,status,id);\
             CREATE TABLE IF NOT EXISTS legacy_catalog(\
               source_path TEXT PRIMARY KEY,kind TEXT NOT NULL,size INTEGER NOT NULL,modified_ms INTEGER NOT NULL,\
               imported_at INTEGER NOT NULL\
             );"
        )?;
        for (name, definition) in [
            ("kind", "TEXT NOT NULL DEFAULT 'other'"),
            ("reason", "TEXT NOT NULL DEFAULT ''"),
            ("encoder", "TEXT NOT NULL DEFAULT ''"),
            ("disposition", "TEXT NOT NULL DEFAULT ''"),
            ("out_path", "TEXT NOT NULL DEFAULT ''"),
            ("error_text", "TEXT"),
            ("duration_ms", "INTEGER NOT NULL DEFAULT 0"),
            ("fps", "REAL"),
            ("started_at", "INTEGER NOT NULL DEFAULT 0"),
            ("finished_at", "INTEGER NOT NULL DEFAULT 0"),
            ("attempt", "INTEGER NOT NULL DEFAULT 0"),
            ("tool", "TEXT NOT NULL DEFAULT ''"),
            ("tool_version", "TEXT NOT NULL DEFAULT ''"),
            ("command_text", "TEXT NOT NULL DEFAULT ''"),
            ("stderr_text", "TEXT NOT NULL DEFAULT ''"),
            ("recycled", "INTEGER NOT NULL DEFAULT 0"),
            ("queue_position", "INTEGER"),
        ] {
            ensure_column(&conn, "compression_files", name, definition)?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS compression_files_activity ON compression_files(job_id,status,finished_at,started_at);\
             CREATE INDEX IF NOT EXISTS compression_files_size ON compression_files(job_id,original_bytes,id);\
             CREATE INDEX IF NOT EXISTS compression_files_queue ON compression_files(job_id,queue_position,id);",
        )?;
        Ok(())
    }

    fn open_state(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open(&self.state_path)?;
        configure_connection(&conn)?;
        Ok(conn)
    }

    pub fn load_secret_blob(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        validate_secret_key(key)?;
        self.open_state()
            .map_err(|error| error.to_string())?
            .query_row(
                "SELECT value FROM secrets WHERE key=?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn save_secret_blob(&self, key: &str, value: &[u8]) -> Result<(), String> {
        validate_secret_key(key)?;
        if value.len() > 64 * 1024 {
            return Err("Encrypted secret exceeds the 64 KiB limit".to_string());
        }
        self.open_state()
            .map_err(|error| error.to_string())?
            .execute(
                "INSERT INTO secrets(key,value,updated_at) VALUES(?1,?2,?3)\
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                params![key, value, now_ms() as i64],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn delete_secret(&self, key: &str) -> Result<(), String> {
        validate_secret_key(key)?;
        self.open_state()
            .map_err(|error| error.to_string())?
            .execute("DELETE FROM secrets WHERE key=?1", params![key])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn upsert_scan_catalog(
        &self,
        scan_id: &str,
        root: &Path,
        db_path: &Path,
        status: &str,
        node_count: u64,
    ) -> rusqlite::Result<()> {
        let conn = self.open_state()?;
        let now = now_ms() as i64;
        conn.execute(
            "INSERT INTO scan_catalog(scan_id,root_path,db_path,status,node_count,created_at,last_used,pinned)\
             VALUES(?1,?2,?3,?4,?5,?6,?6,0)\
             ON CONFLICT(scan_id) DO UPDATE SET status=excluded.status,node_count=excluded.node_count,last_used=excluded.last_used",
            params![scan_id, root.to_string_lossy(), db_path.to_string_lossy(), status, node_count as i64, now],
        )?;
        Ok(())
    }

    fn catalog_handle(&self, scan_id: &str) -> rusqlite::Result<Option<ScanHandle>> {
        let conn = self.open_state()?;
        conn.query_row(
            "SELECT scan_id,root_path,db_path,status,node_count,created_at FROM scan_catalog WHERE scan_id=?1",
            params![scan_id],
            |row| {
                Ok(ScanHandle {
                    scan_id: row.get(0)?,
                    root_path: row.get(1)?,
                    database_path: row.get(2)?,
                    status: row.get(3)?,
                    node_count: row.get::<_, i64>(4)?.max(0) as u64,
                    started_at: row.get::<_, i64>(5)?.max(0) as u64,
                    elapsed_ms: 0,
                    error: None,
                })
            },
        )
        .optional()
    }

    fn touch_scan(&self, scan_id: &str) -> rusqlite::Result<()> {
        self.open_state()?.execute(
            "UPDATE scan_catalog SET last_used=?2 WHERE scan_id=?1",
            params![scan_id, now_ms() as i64],
        )?;
        Ok(())
    }

    fn import_v1_catalog(&self) -> rusqlite::Result<()> {
        let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) else {
            return Ok(());
        };
        let legacy_root = appdata.join("FileTree");
        if !legacy_root.is_dir() {
            return Ok(());
        }
        let conn = self.open_state()?;
        for (kind, path) in [
            ("jobs", legacy_root.join("jobs")),
            ("snapshots", legacy_root.join("snapshots")),
            ("audit", legacy_root.join("audit.jsonl")),
            ("compression-log", legacy_root.join("compression-log.jsonl")),
            ("no-gain", legacy_root.join("compression-no-gain.jsonl")),
            ("tags", legacy_root.join("tags.json")),
            ("hash-cache", legacy_root.join("hash_cache_v2.json")),
            ("secrets", legacy_root.join("secrets.json")),
        ] {
            if !path.exists() {
                continue;
            }
            let metadata = fs::metadata(&path).ok();
            let size = metadata.as_ref().map(|value| value.len()).unwrap_or(0);
            let modified = metadata
                .and_then(|value| value.modified().ok())
                .map(system_time_ms)
                .unwrap_or(0);
            conn.execute(
                "INSERT OR IGNORE INTO legacy_catalog(source_path,kind,size,modified_ms,imported_at) VALUES(?1,?2,?3,?4,?5)",
                params![path.to_string_lossy(), kind, size as i64, modified as i64, now_ms() as i64],
            )?;
        }
        for (key, path, fallback, max_bytes) in [
            (
                "app.settings",
                legacy_root.join("settings.json"),
                "{}",
                SETTINGS_JSON_MAX_BYTES,
            ),
            (
                "app.bookmarks",
                legacy_root.join("bookmarks.json"),
                "[]",
                BOOKMARKS_JSON_MAX_BYTES,
            ),
        ] {
            let exists = conn
                .query_row("SELECT 1 FROM settings WHERE key=?1", params![key], |_| {
                    Ok(())
                })
                .optional()?
                .is_some();
            if exists {
                continue;
            }
            let value = fs::read_to_string(path).unwrap_or_else(|_| fallback.to_string());
            if value.len() <= max_bytes && serde_json::from_str::<serde_json::Value>(&value).is_ok()
            {
                conn.execute(
                    "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)",
                    params![key, value, now_ms() as i64],
                )?;
            }
        }
        if let Ok(text) = fs::read_to_string(legacy_root.join("secrets.json"))
            && let Ok(entries) = serde_json::from_str::<HashMap<String, String>>(&text)
        {
            for (key, encoded) in entries {
                if validate_secret_key(&key).is_err() {
                    continue;
                }
                let exists = conn
                    .query_row("SELECT 1 FROM secrets WHERE key=?1", params![key], |_| {
                        Ok(())
                    })
                    .optional()?
                    .is_some();
                if exists {
                    continue;
                }
                let decoded = if let Some(plain) = encoded.strip_prefix("plain:") {
                    base64::engine::general_purpose::STANDARD.decode(plain).ok()
                } else {
                    base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .ok()
                        .and_then(|cipher| crate::windows_native::unprotect_secret(&cipher).ok())
                };
                let Some(decoded) = decoded else { continue };
                let Ok(cipher) = crate::windows_native::protect_secret(&decoded) else {
                    continue;
                };
                conn.execute(
                    "INSERT INTO secrets(key,value,updated_at) VALUES(?1,?2,?3)",
                    params![key, cipher, now_ms() as i64],
                )?;
            }
        }
        Ok(())
    }
}

fn run_bounded_scan(
    scan_id: &str,
    root: &Path,
    db_path: &Path,
    request: &ScanRequest,
    cancel: &Arc<AtomicBool>,
    progress: Arc<dyn Fn(ScanProgress) + Send + Sync>,
) -> Result<u64, String> {
    if db_path.exists() {
        remove_database_family(db_path);
    }
    let started = Instant::now();
    // Taken before a single entry is enumerated. Anything written while the scan
    // runs then lands past this mark and replays as a normal change; taking it
    // afterwards would silently swallow every edit made during the scan.
    let checkpoint = capture_scan_checkpoint(root);
    let (row_tx, row_rx) = std::sync::mpsc::sync_channel::<ScanRow>(SCAN_CHANNEL_CAPACITY);
    let writer_path = db_path.to_path_buf();
    let root_text = root.to_string_lossy().into_owned();
    // Directories the walker was refused. Collected here rather than counted so
    // each one can be attributed to the folder it happened in.
    let unreadable = Arc::new(Mutex::new(Vec::<i64>::new()));
    let writer_unreadable = Arc::clone(&unreadable);
    let writer = std::thread::Builder::new()
        .name(format!("scan-writer-{scan_id}"))
        .spawn(move || write_scan_rows(&writer_path, &root_text, row_rx, writer_unreadable))
        .map_err(|error| error.to_string())?;

    let next_id = Arc::new(AtomicI64::new(1));
    let node_count = Arc::new(AtomicU64::new(1));
    let queue = Arc::new(DirectoryQueue::new(DirectoryTask {
        id: 0,
        path: root.to_path_buf(),
        depth: 0,
    }));
    let visited = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    if request.follow_links
        && let Ok(canonical) = fs::canonicalize(root)
    {
        visited.lock_unpoisoned().insert(canonical);
    }

    row_tx
        .send(scan_row(0, None, root, root, 0, true, false))
        .map_err(|error| error.to_string())?;
    progress(ScanProgress {
        scan_id: scan_id.to_string(),
        stage: "scanning".to_string(),
        node_count: 1,
        elapsed_ms: started.elapsed().as_millis() as u64,
    });
    let last_progress_ms = Arc::new(AtomicU64::new(0));

    // NTFS fast path. Reading the volume's Master File Table sequentially beats
    // walking directories by an order of magnitude, because a walk pays a small
    // random metadata read per directory plus a kernel transition per entry.
    // Returns false whenever the volume, the request, or our privileges rule it
    // out, in which case the directory walk below runs exactly as before.
    // Records the scan root's own MFT reference, which the walker can't know.
    // Journal replay needs it to recognise changes made directly in the root.
    let root_frn = Arc::new(AtomicU64::new(0));
    let used_mft = try_mft_scan(
        scan_id,
        root,
        request,
        cancel,
        &progress,
        &row_tx,
        &next_id,
        &node_count,
        started,
        &root_frn,
    );

    // The fast path already emitted every row; leave the walker unstaffed.
    let threads = if used_mft {
        0
    } else {
        request.threads.clamp(1, 16)
    };
    let mut workers = Vec::with_capacity(threads);
    for worker_id in 0..threads {
        let tx = row_tx.clone();
        let queue = Arc::clone(&queue);
        let next_id = Arc::clone(&next_id);
        let node_count = Arc::clone(&node_count);
        let cancel = Arc::clone(cancel);
        let request = request.clone();
        let progress = Arc::clone(&progress);
        let scan_id = scan_id.to_string();
        let visited = Arc::clone(&visited);
        let last_progress_ms = Arc::clone(&last_progress_ms);
        let unreadable = Arc::clone(&unreadable);
        workers.push(
            std::thread::Builder::new()
                .name(format!("scan-enumerator-{worker_id}"))
                .spawn(move || {
                    while let Some(task) = queue.claim(&cancel) {
                        if cancel.load(Ordering::Relaxed) {
                            queue.finish();
                            break;
                        }
                        if let Ok(entries) = fs::read_dir(&task.path) {
                            for entry in entries.flatten() {
                                if cancel.load(Ordering::Relaxed) {
                                    break;
                                }
                                let path = entry.path();
                                let name = entry.file_name().to_string_lossy().into_owned();
                                if !request.include_hidden && is_hidden_name(&name) {
                                    continue;
                                }
                                if request.exclude_patterns.iter().any(|pattern| {
                                    wildcard_match(pattern, &name)
                                        || wildcard_match(pattern, &path.to_string_lossy())
                                }) {
                                    continue;
                                }
                                let Ok(file_type) = entry.file_type() else {
                                    continue;
                                };
                                let is_link = file_type.is_symlink();
                                let is_dir = file_type.is_dir()
                                    || (is_link && request.follow_links && path.is_dir());
                                let id = next_id.fetch_add(1, Ordering::Relaxed);
                                // Free on Windows (served from the enumeration
                                // buffer). Symlinks fall through to a path query
                                // so the row keeps describing the TARGET, as it
                                // did before this became a cached read.
                                let cached = if is_link { None } else { entry.metadata().ok() };
                                let row = scan_row_with_metadata(
                                    id,
                                    Some(task.id),
                                    &path,
                                    &path,
                                    task.depth.saturating_add(1),
                                    is_dir,
                                    is_link,
                                    cached,
                                );
                                if tx.send(row).is_err() {
                                    cancel.store(true, Ordering::Relaxed);
                                    break;
                                }
                                let count = node_count.fetch_add(1, Ordering::Relaxed) + 1;
                                if is_dir && (!is_link || request.follow_links) {
                                    let should_queue = if request.follow_links {
                                        fs::canonicalize(&path)
                                            .ok()
                                            .map(|canonical| {
                                                visited.lock_unpoisoned().insert(canonical)
                                            })
                                            .unwrap_or(false)
                                    } else {
                                        true
                                    };
                                    if should_queue {
                                        queue.push(DirectoryTask {
                                            id,
                                            path,
                                            depth: task.depth.saturating_add(1),
                                        });
                                    }
                                }
                                let elapsed_ms = started.elapsed().as_millis() as u64;
                                let previous_ms = last_progress_ms.load(Ordering::Relaxed);
                                let periodic_update = elapsed_ms.saturating_sub(previous_ms) >= 250;
                                if (count.is_multiple_of(2_048) || periodic_update)
                                    && last_progress_ms
                                        .compare_exchange(
                                            previous_ms,
                                            elapsed_ms.max(previous_ms.saturating_add(1)),
                                            Ordering::Relaxed,
                                            Ordering::Relaxed,
                                        )
                                        .is_ok()
                                {
                                    progress(ScanProgress {
                                        scan_id: scan_id.clone(),
                                        stage: "scanning".to_string(),
                                        node_count: count,
                                        elapsed_ms,
                                    });
                                }
                            }
                        } else {
                            // A folder the walker was refused. Attributed to
                            // that folder so the total rolls up with the rest.
                            unreadable.lock_unpoisoned().push(task.id);
                        }
                        queue.finish();
                    }
                })
                .map_err(|error| error.to_string())?,
        );
    }
    drop(row_tx);
    for worker in workers {
        if worker.join().is_err() {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    let writer_result = writer
        .join()
        .map_err(|_| "Scan writer panicked".to_string())?;
    let rows = writer_result?;
    let status = if cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else {
        "done"
    };
    // Only an MFT-backed scan carries the file reference numbers a journal
    // replay matches against, so only that path earns a checkpoint. Recording
    // one for a walker scan would promise an incremental refresh that could
    // never actually be applied.
    let refresh = checkpoint
        .filter(|_| used_mft)
        .map(|checkpoint| ScanRefresh {
            checkpoint,
            root_frn: root_frn.load(Ordering::Relaxed),
        });
    write_scan_metadata(
        db_path,
        status,
        rows,
        started.elapsed().as_millis() as u64,
        None,
        refresh.as_ref(),
    )?;
    Ok(rows)
}

/// What a completed scan needs to remember to be caught up later instead of
/// redone: where the volume's change journal stood when it began, and the MFT
/// reference of the root it was rooted at.
#[derive(Clone, Copy, Debug)]
struct ScanRefresh {
    checkpoint: crate::usn::Checkpoint,
    root_frn: u64,
}

/// The volume journal mark a scan of `root` should resume from, or `None` when
/// the volume has no usable journal (non-NTFS, unelevated, network path). A
/// `None` here simply means this scan can only ever be refreshed by rescanning.
fn capture_scan_checkpoint(root: &Path) -> Option<crate::usn::Checkpoint> {
    let letter = crate::mft::volume_letter(root)?;
    match crate::usn::capture_checkpoint(letter) {
        Ok(checkpoint) => Some(checkpoint),
        Err(error) => {
            eprintln!("[usn] {letter}: {error} — scan will not be incrementally refreshable");
            None
        }
    }
}

#[derive(Debug)]
struct DirectoryTask {
    id: i64,
    path: PathBuf,
    depth: u32,
}

#[derive(Debug)]
struct DirectoryQueueState {
    pending: VecDeque<DirectoryTask>,
    active: usize,
    closed: bool,
}

#[derive(Debug)]
struct DirectoryQueue {
    state: Mutex<DirectoryQueueState>,
    cv: Condvar,
}

impl DirectoryQueue {
    fn new(root: DirectoryTask) -> Self {
        Self {
            state: Mutex::new(DirectoryQueueState {
                pending: VecDeque::from([root]),
                active: 0,
                closed: false,
            }),
            cv: Condvar::new(),
        }
    }

    fn claim(&self, cancel: &AtomicBool) -> Option<DirectoryTask> {
        let mut state = self.state.lock_unpoisoned();
        loop {
            if state.closed || cancel.load(Ordering::Relaxed) {
                return None;
            }
            if let Some(task) = state.pending.pop_front() {
                state.active += 1;
                return Some(task);
            }
            if state.active == 0 {
                state.closed = true;
                self.cv.notify_all();
                return None;
            }
            state = self
                .cv
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn push(&self, task: DirectoryTask) {
        let mut state = self.state.lock_unpoisoned();
        if !state.closed {
            state.pending.push_back(task);
            self.cv.notify_one();
        }
    }

    fn finish(&self) {
        let mut state = self.state.lock_unpoisoned();
        state.active = state.active.saturating_sub(1);
        if state.active == 0 && state.pending.is_empty() {
            state.closed = true;
        }
        self.cv.notify_all();
    }
}

#[derive(Debug)]
struct ScanRow {
    id: i64,
    parent_id: Option<i64>,
    name: String,
    dir_path: String,
    is_dir: bool,
    is_link: bool,
    hidden: bool,
    readonly: bool,
    size: u64,
    allocated: u64,
    files: u64,
    folders: u64,
    modified_ms: u64,
    created_ms: u64,
    accessed_ms: u64,
    depth: u32,
    errors: u64,
    extension: String,
    owner: String,
    attributes: u32,
    /// NTFS file reference number, or 0 when the row came from the directory
    /// walker. This is the key a USN journal record is matched against, so a
    /// scan without it can only ever be refreshed by rescanning.
    frn: u64,
}

fn scan_row(
    id: i64,
    parent_id: Option<i64>,
    path: &Path,
    dir_path: &Path,
    depth: u32,
    is_dir: bool,
    is_link: bool,
) -> ScanRow {
    scan_row_with_metadata(id, parent_id, path, dir_path, depth, is_dir, is_link, None)
}

/// As [`scan_row`], but reuses metadata the caller already holds.
///
/// Windows returns size, timestamps and attributes as part of directory
/// enumeration, and `DirEntry::metadata()` serves them from that buffer without
/// a syscall. Re-querying by path with `fs::metadata` instead cost one extra
/// syscall per file and replaced a sequential directory-index read with a random
/// per-file metadata lookup — the dominant cost of a large scan. `cached` is
/// therefore the enumeration's own metadata; `None` falls back to a path query
/// (the scan root, and symlinks when the target's metadata is wanted).
#[allow(clippy::too_many_arguments)]
fn scan_row_with_metadata(
    id: i64,
    parent_id: Option<i64>,
    path: &Path,
    dir_path: &Path,
    depth: u32,
    is_dir: bool,
    is_link: bool,
    cached: Option<fs::Metadata>,
) -> ScanRow {
    let metadata = match cached {
        Some(metadata) => Some(metadata),
        None => fs::metadata(path).ok(),
    };
    let size = if is_dir {
        0
    } else {
        metadata.as_ref().map(|value| value.len()).unwrap_or(0)
    };
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let extension = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default()
    };
    ScanRow {
        id,
        parent_id,
        name: name.clone(),
        dir_path: if is_dir {
            dir_path.to_string_lossy().into_owned()
        } else {
            String::new()
        },
        is_dir,
        is_link,
        hidden: is_hidden_name(&name),
        readonly: metadata
            .as_ref()
            .map(|value| value.permissions().readonly())
            .unwrap_or(false),
        size,
        allocated: size,
        files: (!is_dir) as u64,
        folders: 0,
        modified_ms: metadata
            .as_ref()
            .and_then(|value| value.modified().ok())
            .map(system_time_ms)
            .unwrap_or(0),
        created_ms: metadata
            .as_ref()
            .and_then(|value| value.created().ok())
            .map(system_time_ms)
            .unwrap_or(0),
        accessed_ms: metadata
            .as_ref()
            .and_then(|value| value.accessed().ok())
            .map(system_time_ms)
            .unwrap_or(0),
        depth,
        errors: 0,
        extension,
        owner: String::new(),
        attributes: 0,
        // The walker never learns a file's MFT reference; only the MFT path
        // fills this in, which is why incremental refresh needs that path.
        frn: 0,
    }
}

// ── NTFS Master File Table fast path ────────────────────────────────────────

/// How eagerly to use the MFT reader.
///
/// Overridable with `FILETREE_MFT` (`0`/`off`/`never`, `1`/`on`/`always`,
/// anything else = auto) so both scan paths can be measured against each other
/// on the same machine without a rebuild.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MftMode {
    Never,
    Auto,
    Always,
}

/// Read per scan rather than cached, so the two paths can be compared inside a
/// single process (a scan is far too coarse for one env lookup to matter).
fn mft_mode() -> MftMode {
    match std::env::var("FILETREE_MFT")
        .ok()
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("0" | "off" | "never" | "false") => MftMode::Never,
        Some("1" | "on" | "always" | "true") => MftMode::Always,
        _ => MftMode::Auto,
    }
}

fn join_child_path(parent: &str, name: &str) -> String {
    let mut out = String::with_capacity(parent.len() + 1 + name.len());
    out.push_str(parent);
    if !out.ends_with('\\') && !out.ends_with('/') {
        out.push('\\');
    }
    out.push_str(name);
    out
}

/// One scan row from a parsed MFT entry.
///
/// `hidden` deliberately keeps the walker's dotfile rule rather than reading
/// Windows' HIDDEN attribute, so the two scan paths agree on which entries
/// `include_hidden` filters. The raw attribute bitmask still travels in
/// `attributes`, which the walker leaves at 0.
fn mft_row(
    id: i64,
    parent_id: i64,
    entry: &crate::mft::MftEntry,
    path: &str,
    depth: u32,
    record: u32,
) -> ScanRow {
    const FILE_ATTRIBUTE_READONLY: u32 = 0x0000_0001;
    let is_dir = entry.is_dir;
    ScanRow {
        id,
        parent_id: Some(parent_id),
        name: entry.name.clone(),
        // Interned exactly as the walker does it: directories carry their path,
        // files inherit theirs from the parent row.
        dir_path: if is_dir {
            path.to_string()
        } else {
            String::new()
        },
        is_dir,
        is_link: entry.is_reparse,
        hidden: is_hidden_name(&entry.name),
        readonly: entry.attributes & FILE_ATTRIBUTE_READONLY != 0,
        size: entry.size,
        // Resident content has no clusters of its own; report the logical size
        // so a tiny file never shows as occupying nothing.
        allocated: if entry.allocated > 0 {
            entry.allocated
        } else {
            entry.size
        },
        files: u64::from(!is_dir),
        folders: 0,
        modified_ms: entry.modified_ms,
        created_ms: entry.created_ms,
        accessed_ms: entry.accessed_ms,
        depth,
        errors: 0,
        extension: if is_dir {
            String::new()
        } else {
            Path::new(&entry.name)
                .extension()
                .map(|value| value.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default()
        },
        owner: String::new(),
        attributes: entry.attributes,
        frn: u64::from(record),
    }
}

/// Scan by reading the volume's MFT instead of walking directories.
///
/// Returns true when the fast path owns the scan (rows emitted, or cancelled),
/// false when the caller must fall back to the directory walk. Every rejection
/// is expected and silent-ish: non-NTFS volumes, unelevated processes, network
/// paths and link-following requests all simply walk.
#[cfg(windows)]
#[allow(clippy::too_many_arguments)]
fn try_mft_scan(
    scan_id: &str,
    root: &Path,
    request: &ScanRequest,
    cancel: &Arc<AtomicBool>,
    progress: &Arc<dyn Fn(ScanProgress) + Send + Sync>,
    row_tx: &std::sync::mpsc::SyncSender<ScanRow>,
    next_id: &AtomicI64,
    node_count: &AtomicU64,
    started: Instant,
    root_frn: &AtomicU64,
) -> bool {
    let mode = mft_mode();
    if mode == MftMode::Never {
        return false;
    }
    // Following links resolves mount points into other volumes, which one
    // volume's table cannot answer.
    if request.follow_links {
        return false;
    }
    let Some(letter) = crate::mft::volume_letter(root) else {
        return false; // UNC path: no volume to read
    };
    // Auto sticks to whole volumes. Streaming a multi-hundred-MiB table to
    // answer a small subtree would be slower than just walking it.
    if mode == MftMode::Auto && !crate::mft::is_volume_root(root) {
        return false;
    }

    let report = |node_count: u64| {
        progress(ScanProgress {
            scan_id: scan_id.to_string(),
            stage: "scanning".to_string(),
            node_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    };

    let index = match crate::mft::read_index(letter, cancel, report) {
        Ok(index) => index,
        // Already stopping; don't start the walker just to have it stop too.
        Err(crate::mft::MftError::Cancelled) => return true,
        Err(error) => {
            eprintln!("[mft] {letter}: {error} — falling back to directory walk");
            return false;
        }
    };

    let children = index.children_map();
    let components = crate::mft::components_below_root(root);
    let Some(target) = index.resolve(&children, &components) else {
        eprintln!(
            "[mft] {}: not found in table — falling back",
            root.display()
        );
        return false;
    };
    if !index.get(target).is_some_and(|entry| entry.is_dir) {
        return false;
    }
    // The root row was emitted before this path was chosen, so its own MFT
    // reference is reported out of band rather than carried on the row.
    root_frn.store(u64::from(target), Ordering::Relaxed);

    // Breadth-first from the target so each directory's children land in one
    // contiguous id block, matching the walker's id layout.
    let mut queue: VecDeque<(u32, i64, String, u32)> = VecDeque::new();
    queue.push_back((target, 0, root.to_string_lossy().into_owned(), 0));

    while let Some((dir_record, dir_id, dir_path, depth)) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Some(entries) = children.get(dir_record as usize) else {
            continue;
        };
        for &record in entries {
            let Some(entry) = index.get(record) else {
                continue;
            };
            if !request.include_hidden && is_hidden_name(&entry.name) {
                continue;
            }
            let child_path = join_child_path(&dir_path, &entry.name);
            if request.exclude_patterns.iter().any(|pattern| {
                wildcard_match(pattern, &entry.name) || wildcard_match(pattern, &child_path)
            }) {
                continue;
            }

            let id = next_id.fetch_add(1, Ordering::Relaxed);
            let row = mft_row(
                id,
                dir_id,
                entry,
                &child_path,
                depth.saturating_add(1),
                record,
            );
            if row_tx.send(row).is_err() {
                cancel.store(true, Ordering::Relaxed);
                return true;
            }
            let count = node_count.fetch_add(1, Ordering::Relaxed) + 1;
            if count.is_multiple_of(4_096) {
                report(count);
            }

            // Reparse points are recorded but never descended into — the target
            // may live on another volume entirely.
            if entry.is_dir && !entry.is_reparse {
                queue.push_back((record, id, child_path, depth.saturating_add(1)));
            }
        }
    }

    report(node_count.load(Ordering::Relaxed));
    true
}

#[cfg(not(windows))]
#[allow(clippy::too_many_arguments)]
fn try_mft_scan(
    _scan_id: &str,
    _root: &Path,
    _request: &ScanRequest,
    _cancel: &Arc<AtomicBool>,
    _progress: &Arc<dyn Fn(ScanProgress) + Send + Sync>,
    _row_tx: &std::sync::mpsc::SyncSender<ScanRow>,
    _next_id: &AtomicI64,
    _node_count: &AtomicU64,
    _started: Instant,
    _root_frn: &AtomicU64,
) -> bool {
    false
}

fn write_scan_rows(
    db_path: &Path,
    root_path: &str,
    receiver: std::sync::mpsc::Receiver<ScanRow>,
    unreadable: Arc<Mutex<Vec<i64>>>,
) -> Result<u64, String> {
    let mut conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    configure_connection(&conn).map_err(|error| error.to_string())?;
    create_scan_schema(&conn).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata(key,value) VALUES('rootPath',?1)",
        params![root_path],
    )
    .map_err(|error| error.to_string())?;
    let mut batch = Vec::with_capacity(SCAN_TRANSACTION_ROWS);
    let mut total = 0u64;
    for row in receiver {
        batch.push(row);
        if batch.len() >= SCAN_TRANSACTION_ROWS {
            insert_scan_batch(&mut conn, &batch).map_err(|error| error.to_string())?;
            total += batch.len() as u64;
            batch.clear();
        }
    }
    if !batch.is_empty() {
        insert_scan_batch(&mut conn, &batch).map_err(|error| error.to_string())?;
        total += batch.len() as u64;
    }
    // Every worker has dropped its sender by the time the loop above ends, so
    // this list is complete. Marking the folders before aggregating lets the
    // ordinary rollup carry the count to the root.
    {
        let mut failures = unreadable.lock_unpoisoned();
        if !failures.is_empty() {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            {
                let mut stmt = tx
                    .prepare_cached("UPDATE nodes SET errors=1 WHERE id=?1")
                    .map_err(|error| error.to_string())?;
                for id in failures.iter() {
                    stmt.execute(params![id])
                        .map_err(|error| error.to_string())?;
                }
            }
            tx.commit().map_err(|error| error.to_string())?;
            failures.clear();
        }
    }
    aggregate_scan(&conn).map_err(|error| error.to_string())?;
    Ok(total)
}

const COMPRESSION_FILE_UPSERT_SQL: &str = "INSERT INTO compression_files(job_id,id,path,kind,status,stage,progress,original_bytes,output_bytes,error_text,reason,encoder,disposition,out_path,duration_ms,fps,started_at,updated_at,finished_at,attempt,tool,tool_version,command_text,stderr_text,recycled,queue_position)\
     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)\
     ON CONFLICT(job_id,id) DO UPDATE SET path=excluded.path,kind=excluded.kind,status=excluded.status,stage=excluded.stage,progress=excluded.progress,original_bytes=excluded.original_bytes,output_bytes=excluded.output_bytes,error_text=excluded.error_text,reason=excluded.reason,encoder=excluded.encoder,disposition=excluded.disposition,out_path=excluded.out_path,duration_ms=excluded.duration_ms,fps=excluded.fps,started_at=excluded.started_at,updated_at=excluded.updated_at,finished_at=excluded.finished_at,attempt=excluded.attempt,tool=excluded.tool,tool_version=excluded.tool_version,command_text=excluded.command_text,stderr_text=excluded.stderr_text,recycled=excluded.recycled,queue_position=excluded.queue_position";

fn persist_compression_file(
    statement: &mut rusqlite::Statement<'_>,
    file: &CompressionFileRecord,
) -> rusqlite::Result<usize> {
    statement.execute(params![
        file.job_id,
        file.index as i64,
        file.path,
        file.kind,
        file.status,
        file.stage,
        file.pct as f64,
        as_sql_i64(file.orig_bytes),
        as_sql_i64(file.new_bytes),
        file.error,
        file.reason,
        file.encoder,
        file.disposition,
        file.out_path,
        as_sql_i64(file.duration_ms),
        file.fps,
        as_sql_i64(file.started_at),
        as_sql_i64(file.updated_at),
        as_sql_i64(file.finished_at),
        file.attempt as i64,
        file.tool,
        file.tool_version,
        file.command,
        file.stderr,
        file.recycled as i64,
        file.queue_position.map(|value| value as i64),
    ])
}

fn spawn_compression_writer(state_path: PathBuf, receiver: Receiver<CompressionWrite>) {
    let _ = std::thread::Builder::new()
        .name("compression-state-writer".to_string())
        .spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut files = HashMap::<(String, usize), CompressionFileRecord>::new();
                let mut jobs = HashMap::<String, (String, u64)>::new();
                collect_compression_write(first, &mut files, &mut jobs);
                let deadline = Instant::now() + Duration::from_millis(100);
                while files.len() + jobs.len() < 512 && Instant::now() < deadline {
                    match receiver.try_recv() {
                        Ok(write) => collect_compression_write(write, &mut files, &mut jobs),
                        Err(std::sync::mpsc::TryRecvError::Empty) => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                    }
                }
                let Ok(mut conn) = Connection::open(&state_path) else {
                    continue;
                };
                if configure_connection(&conn).is_err() {
                    continue;
                }
                let Ok(tx) = conn.transaction() else {
                    continue;
                };
                let mut failed = false;
                if let Ok(mut statement) = tx.prepare(COMPRESSION_FILE_UPSERT_SQL) {
                    for file in files.values() {
                        if persist_compression_file(&mut statement, file).is_err() {
                            failed = true;
                            break;
                        }
                    }
                } else {
                    failed = true;
                }
                if !failed {
                    for (id, (status, saved_bytes)) in jobs {
                        if tx
                            .execute(
                                "UPDATE compression_jobs SET status=?2,saved_bytes=?3,updated_at=?4 WHERE id=?1",
                                params![id, status, as_sql_i64(saved_bytes), now_ms() as i64],
                            )
                            .is_err()
                        {
                            failed = true;
                            break;
                        }
                    }
                }
                if !failed {
                    let _ = tx.commit();
                }
            }
        });
}

fn collect_compression_write(
    write: CompressionWrite,
    files: &mut HashMap<(String, usize), CompressionFileRecord>,
    jobs: &mut HashMap<String, (String, u64)>,
) {
    match write {
        CompressionWrite::File(file) => {
            files.insert((file.job_id.clone(), file.index), *file);
        }
        CompressionWrite::JobState {
            id,
            status,
            saved_bytes,
        } => {
            jobs.insert(id, (status, saved_bytes));
        }
    }
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let exists = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !exists {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn push_csv_sql(sql: &mut String, values: &mut Vec<Value>, column: &str, filter: &str) {
    let parts = filter
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return;
    }
    sql.push_str(" AND LOWER(");
    sql.push_str(column);
    sql.push_str(") IN (");
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            sql.push(',');
        }
        sql.push('?');
        values.push(Value::Text(part));
    }
    sql.push(')');
}

fn compression_sort_sql(sort: &str) -> &'static str {
    match sort {
        "queue" => "COALESCE(queue_position,9223372036854775807)",
        "name" => "path COLLATE NOCASE",
        "size" => "original_bytes",
        "progress" => "progress",
        "elapsed" => {
            "CASE WHEN duration_ms>0 THEN duration_ms WHEN started_at>0 THEN (unixepoch('subsec')*1000-started_at) ELSE 0 END"
        }
        "eta" => {
            "CASE WHEN progress>0 THEN ((CASE WHEN duration_ms>0 THEN duration_ms WHEN started_at>0 THEN (unixepoch('subsec')*1000-started_at) ELSE 0 END)*(100-progress)/progress) ELSE 9223372036854775807 END"
        }
        "speed" => {
            "CASE WHEN progress>0 AND started_at>0 THEN (original_bytes*progress)/(unixepoch('subsec')*1000-started_at+1) ELSE 0 END"
        }
        "savings" => "MAX(0,original_bytes-output_bytes)",
        "result" => "reason COLLATE NOCASE",
        "start" => "started_at",
        "finish" => "finished_at",
        _ => "COALESCE(queue_position,id)",
    }
}

fn compression_item_from_row(
    row: &rusqlite::Row<'_>,
    now: u64,
) -> rusqlite::Result<CompressionFileItem> {
    let pct = row.get::<_, f64>(5)?.clamp(0.0, 100.0).round() as u64;
    let orig_bytes = row.get::<_, i64>(6)?.max(0) as u64;
    let new_bytes = row.get::<_, i64>(7)?.max(0) as u64;
    let duration_ms = row.get::<_, i64>(13)?.max(0) as u64;
    let started_at = row.get::<_, i64>(15)?.max(0) as u64;
    let elapsed_ms = if duration_ms > 0 {
        duration_ms
    } else if started_at > 0 {
        now.saturating_sub(started_at)
    } else {
        0
    };
    let saved_bytes = orig_bytes.saturating_sub(new_bytes);
    let processing_rate = (elapsed_ms > 0).then(|| {
        orig_bytes.saturating_mul(pct).saturating_div(100) as f64 * 1000.0 / elapsed_ms as f64
    });
    Ok(CompressionFileItem {
        index: row.get::<_, i64>(0)?.max(0) as usize,
        path: row.get(1)?,
        kind: row.get(2)?,
        status: row.get(3)?,
        stage: row.get(4)?,
        pct,
        orig_bytes,
        new_bytes,
        saved_bytes,
        pct_saved: if orig_bytes > 0 {
            saved_bytes as f64 * 100.0 / orig_bytes as f64
        } else {
            0.0
        },
        error: row.get(8)?,
        reason: row.get(9)?,
        encoder: row.get(10)?,
        disposition: row.get(11)?,
        out_path: row.get(12)?,
        duration_ms,
        elapsed_ms,
        fps: row.get(14)?,
        processing_rate,
        output_bytes: new_bytes,
        started_at,
        updated_at: row.get::<_, i64>(16)?.max(0) as u64,
        finished_at: row.get::<_, i64>(17)?.max(0) as u64,
        attempt: row.get::<_, i64>(18)?.max(0) as usize,
        tool: row.get(19)?,
        tool_version: row.get(20)?,
        command: row.get(21)?,
        stderr: row.get(22)?,
        recycled: row.get::<_, i64>(23)? != 0,
        queue_position: row
            .get::<_, Option<i64>>(24)?
            .map(|value| value.max(0) as usize),
    })
}

fn safe_job_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn validate_secret_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("Invalid secret key".to_string());
    }
    Ok(())
}

fn configure_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.execute_batch(&format!(
        "PRAGMA journal_mode=WAL;\
         PRAGMA synchronous=NORMAL;\
         PRAGMA temp_store=FILE;\
         PRAGMA mmap_size=0;\
         PRAGMA cache_size=-{SQLITE_CACHE_KIB};\
         PRAGMA cache_spill=ON;\
         PRAGMA foreign_keys=ON;"
    ))?;
    Ok(())
}

fn create_scan_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);\
         CREATE TABLE nodes(\
           id INTEGER PRIMARY KEY,parent_id INTEGER,name TEXT NOT NULL,dir_path TEXT NOT NULL DEFAULT '',\
           is_dir INTEGER NOT NULL,is_link INTEGER NOT NULL,hidden INTEGER NOT NULL,readonly INTEGER NOT NULL,\
           size INTEGER NOT NULL,allocated INTEGER NOT NULL,files INTEGER NOT NULL,folders INTEGER NOT NULL,\
           modified_ms INTEGER NOT NULL,created_ms INTEGER NOT NULL,accessed_ms INTEGER NOT NULL,\
           depth INTEGER NOT NULL,errors INTEGER NOT NULL,extension TEXT NOT NULL,owner TEXT NOT NULL,attributes INTEGER NOT NULL,\
           frn INTEGER NOT NULL DEFAULT 0,newest_created_ms INTEGER NOT NULL DEFAULT 0\
         );\
         CREATE INDEX nodes_parent ON nodes(parent_id,id);\
         CREATE INDEX nodes_parent_kind ON nodes(parent_id,is_dir,id);\
         CREATE INDEX nodes_parent_size ON nodes(parent_id,size DESC,id);\
         CREATE INDEX nodes_parent_name ON nodes(parent_id,name COLLATE NOCASE,id);\
         CREATE INDEX nodes_extension ON nodes(extension,id);\
         CREATE INDEX nodes_depth ON nodes(depth,is_dir,id);\
         CREATE INDEX nodes_frn ON nodes(frn) WHERE frn<>0;"
    )?;
    Ok(())
}

/// Bring a scan database written by an older build up to the current column
/// set. Cache files outlive the build that wrote them, so reopening one is only
/// worth it if it can answer the queries this build makes. Back-filled columns
/// read as zero, which every consumer already renders as "unknown".
fn migrate_scan_schema(conn: &Connection) -> rusqlite::Result<()> {
    let mut columns = std::collections::HashSet::new();
    {
        let mut stmt = conn.prepare("PRAGMA table_info(nodes)")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            columns.insert(row.get::<_, String>(1)?);
        }
    }
    if columns.is_empty() {
        return Ok(()); // a database still being created
    }
    for (column, statement) in [
        (
            "frn",
            "ALTER TABLE nodes ADD COLUMN frn INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "newest_created_ms",
            "ALTER TABLE nodes ADD COLUMN newest_created_ms INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        if !columns.contains(column) {
            conn.execute_batch(statement)?;
        }
    }
    Ok(())
}

fn migrate_scan_database(path: &Path) -> rusqlite::Result<()> {
    migrate_scan_schema(&Connection::open(path)?)
}

fn insert_scan_batch(conn: &mut Connection, batch: &[ScanRow]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO nodes(id,parent_id,name,dir_path,is_dir,is_link,hidden,readonly,size,allocated,files,folders,\
             modified_ms,created_ms,accessed_ms,depth,errors,extension,owner,attributes,frn,newest_created_ms)\
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)"
        )?;
        for row in batch {
            stmt.execute(params![
                row.id,
                row.parent_id,
                row.name,
                row.dir_path,
                row.is_dir as i64,
                row.is_link as i64,
                row.hidden as i64,
                row.readonly as i64,
                as_sql_i64(row.size),
                as_sql_i64(row.allocated),
                as_sql_i64(row.files),
                as_sql_i64(row.folders),
                as_sql_i64(row.modified_ms),
                as_sql_i64(row.created_ms),
                as_sql_i64(row.accessed_ms),
                row.depth as i64,
                as_sql_i64(row.errors),
                row.extension,
                row.owner,
                row.attributes as i64,
                as_sql_i64(row.frn),
                // Seeded from files only. A directory's own birth date says
                // nothing about when something was last put inside it, so it
                // starts empty and is filled in by the rollup below.
                as_sql_i64(if row.is_dir { 0 } else { row.created_ms }),
            ])?;
        }
    }
    tx.commit()
}

fn aggregate_scan(conn: &Connection) -> rusqlite::Result<()> {
    let max_depth: i64 = conn.query_row("SELECT COALESCE(MAX(depth),0) FROM nodes", [], |row| {
        row.get(0)
    })?;
    for depth in (0..=max_depth).rev() {
        conn.execute(
            "UPDATE nodes AS parent SET \
               size=COALESCE((SELECT SUM(child.size) FROM nodes child WHERE child.parent_id=parent.id),0),\
               allocated=COALESCE((SELECT SUM(child.allocated) FROM nodes child WHERE child.parent_id=parent.id),0),\
               files=COALESCE((SELECT SUM(child.files) FROM nodes child WHERE child.parent_id=parent.id),0),\
               folders=COALESCE((SELECT SUM(child.folders + child.is_dir) FROM nodes child WHERE child.parent_id=parent.id),0),\
               errors=errors+COALESCE((SELECT SUM(child.errors) FROM nodes child WHERE child.parent_id=parent.id),0),\
               modified_ms=MAX(modified_ms,COALESCE((SELECT MAX(child.modified_ms) FROM nodes child WHERE child.parent_id=parent.id),0)),\
               newest_created_ms=COALESCE((SELECT MAX(child.newest_created_ms) FROM nodes child WHERE child.parent_id=parent.id),0)\
             WHERE parent.is_dir=1 AND parent.depth=?1",
            params![depth],
        )?;
    }
    conn.execute_batch("PRAGMA optimize;")?;
    Ok(())
}

fn write_scan_metadata(
    db_path: &Path,
    status: &str,
    nodes: u64,
    elapsed_ms: u64,
    error: Option<&str>,
    refresh: Option<&ScanRefresh>,
) -> Result<(), String> {
    let conn = open_scan_connection(db_path).map_err(|value| value.to_string())?;
    // Absent for a walker scan; the reader treats a zeroed checkpoint as "not
    // incrementally refreshable" and rescans.
    let refresh = refresh.copied().unwrap_or(ScanRefresh {
        checkpoint: crate::usn::Checkpoint::default(),
        root_frn: 0,
    });
    for (key, value) in [
        ("status", status.to_string()),
        ("nodeCount", nodes.to_string()),
        ("elapsedMs", elapsed_ms.to_string()),
        ("scannedAt", now_ms().to_string()),
        ("error", error.unwrap_or("").to_string()),
        ("volumeSerial", refresh.checkpoint.volume_serial.to_string()),
        ("journalId", refresh.checkpoint.journal_id.to_string()),
        ("journalUsn", refresh.checkpoint.next_usn.to_string()),
        ("rootFrn", refresh.root_frn.to_string()),
    ] {
        conn.execute(
            "INSERT OR REPLACE INTO metadata(key,value) VALUES(?1,?2)",
            params![key, value],
        )
        .map_err(|value| value.to_string())?;
    }
    Ok(())
}

fn open_scan_connection(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    configure_connection(&conn)?;
    Ok(conn)
}

struct TemporaryDatabase {
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        remove_database_family(&self.path);
    }
}

fn normalized_path_text(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn path_is_within_text(candidate: &str, root: &str) -> bool {
    let candidate = normalized_path_text(candidate);
    let root = normalized_path_text(root);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn escape_duplicate_like(value: &str) -> String {
    value
        .replace('!', "!!")
        .replace('%', "!%")
        .replace('_', "!_")
}

fn duplicate_query_path(value: &str) -> String {
    let normalized = if cfg!(windows) {
        value.replace('\\', "/")
    } else {
        value.to_string()
    };
    let trimmed = normalized.trim().trim_end_matches('/');
    if trimmed.is_empty() && normalized.trim().starts_with('/') {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn duplicate_query_dir_path_sql() -> &'static str {
    if cfg!(windows) {
        "replace(p.dir_path,'\\','/')"
    } else {
        "p.dir_path"
    }
}

fn duplicate_descendant_pattern(value: &str) -> String {
    let value = duplicate_query_path(value);
    if value == "/" {
        "/%".to_string()
    } else {
        format!("{}/%", escape_duplicate_like(&value))
    }
}

const SUBTREE_FILE_SELECT_SQL: &str = r#"WITH RECURSIVE directories(id,dir_path) AS (
    SELECT id,dir_path FROM nodes WHERE id=?1 AND is_dir=1
    UNION ALL
    SELECT n.id,n.dir_path
      FROM nodes n JOIN directories d ON n.parent_id=d.id
     WHERE n.is_dir=1
)
SELECT CASE WHEN d.dir_path IS NULL OR d.dir_path='' THEN n.name
            WHEN substr(d.dir_path,-1,1) IN ('\','/') THEN d.dir_path || n.name
            ELSE d.dir_path || '\' || n.name END,
       n.size,
       n.is_link
  FROM directories d JOIN nodes n ON n.parent_id=d.id
 WHERE n.is_dir=0"#;

fn subtree_directory_file_count(conn: &Connection, directory_id: i64) -> Result<usize, String> {
    conn.query_row(
        "SELECT files FROM nodes WHERE id=?1 AND is_dir=1",
        params![directory_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .map(|count| count.max(0) as usize)
    .ok_or_else(|| format!("Directory is not present in scan: {directory_id}"))
}

fn subtree_file_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubtreeFileItem> {
    Ok(SubtreeFileItem {
        path: row.get(0)?,
        size: row.get::<_, i64>(1)?.max(0) as u64,
    })
}

fn indexed_subtree_file_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<IndexedCompressionSource> {
    Ok(IndexedCompressionSource {
        path: row.get(0)?,
        size: row.get::<_, i64>(1)?.max(0) as u64,
        is_link: row.get::<_, i64>(2)? != 0,
    })
}

fn node_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NodePageItem> {
    Ok(NodePageItem {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        path: row.get(3)?,
        is_dir: row.get::<_, i64>(4)? != 0,
        is_link: row.get::<_, i64>(5)? != 0,
        hidden: row.get::<_, i64>(6)? != 0,
        readonly: row.get::<_, i64>(7)? != 0,
        size: row.get::<_, i64>(8)?.max(0) as u64,
        allocated: row.get::<_, i64>(9)?.max(0) as u64,
        files: row.get::<_, i64>(10)?.max(0) as u64,
        folders: row.get::<_, i64>(11)?.max(0) as u64,
        modified_ms: row.get::<_, i64>(12)?.max(0) as u64,
        created_ms: row.get::<_, i64>(13)?.max(0) as u64,
        accessed_ms: row.get::<_, i64>(14)?.max(0) as u64,
        depth: row.get::<_, i64>(15)?.max(0) as u32,
        errors: row.get::<_, i64>(16)?.max(0) as u64,
        extension: row.get(17)?,
        owner: row.get(18)?,
        attributes: row.get::<_, i64>(19)?.max(0) as u32,
        newest_created_ms: row.get::<_, i64>(20)?.max(0) as u64,
    })
}

fn sort_column(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "name" => "n.name COLLATE NOCASE",
        "allocated" => "n.allocated",
        "files" => "n.files",
        "folders" => "n.folders",
        "modified" | "modifiedms" => "n.modified_ms",
        "created" | "createdms" => "n.created_ms",
        "lastfilecreated" | "newestcreated" | "newestcreatedms" => "n.newest_created_ms",
        "accessed" | "accessedms" => "n.accessed_ms",
        "extension" => "n.extension COLLATE NOCASE",
        "depth" => "n.depth",
        _ => "n.size",
    }
}

fn prune_job_handles(jobs: &mut HashMap<String, ScanJob>) {
    const RETAINED: usize = 64;
    if jobs.len() <= RETAINED {
        return;
    }
    let mut terminal = jobs
        .iter()
        .filter(|(_, job)| job.terminal)
        .map(|(id, job)| (id.clone(), job.handle.started_at))
        .collect::<Vec<_>>();
    terminal.sort_by_key(|(_, started)| *started);
    let remove = jobs.len().saturating_sub(RETAINED);
    for (id, _) in terminal.into_iter().take(remove) {
        jobs.remove(&id);
    }
}

fn new_scan_id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        now_ms(),
        std::process::id(),
        NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn safe_scan_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn scan_owner_process_id(scan_id: &str) -> Option<u32> {
    let mut parts = scan_id.split('-');
    parts.next()?;
    let process_id = u32::from_str_radix(parts.next()?, 16).ok()?;
    parts.next()?;
    if process_id == 0 || parts.next().is_some() {
        return None;
    }
    Some(process_id)
}

#[cfg(windows)]
fn process_is_alive(process_id: u32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return false;
        };
        let mut exit_code = 0u32;
        let running = GetExitCodeProcess(handle, &mut exit_code).is_ok()
            && exit_code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(handle);
        running
    }
}

#[cfg(target_os = "linux")]
fn process_is_alive(process_id: u32) -> bool {
    Path::new("/proc").join(process_id.to_string()).exists()
}

#[cfg(all(not(windows), not(target_os = "linux")))]
fn process_is_alive(_process_id: u32) -> bool {
    // Without a portable liveness primitive, preserve another process's file.
    true
}

fn now_ms() -> u64 {
    system_time_ms(SystemTime::now())
}

fn system_time_ms(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn as_sql_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') && name != "." && name != ".."
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SearchField {
    Any,
    Name,
    Path,
    Extension,
    Type,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SearchTerm {
    value: String,
    field: SearchField,
    excluded: bool,
}

fn parse_search_terms(query: &str) -> Vec<SearchTerm> {
    let mut raw_tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    for character in query.chars() {
        match character {
            '"' => quoted = !quoted,
            value if value.is_whitespace() && !quoted => {
                if !token.is_empty() {
                    raw_tokens.push(std::mem::take(&mut token));
                }
            }
            value => token.push(value),
        }
    }
    if !token.is_empty() {
        raw_tokens.push(token);
    }

    raw_tokens
        .into_iter()
        .filter_map(|mut raw| {
            let excluded = raw.starts_with('-') && raw.len() > 1;
            if excluded {
                raw.remove(0);
            }
            let (field, value) = match raw.find(':') {
                Some(separator) if separator > 0 && separator < raw.len() - 1 => {
                    let field = match raw[..separator].to_ascii_lowercase().as_str() {
                        "name" => SearchField::Name,
                        "path" | "in" => SearchField::Path,
                        "ext" | "extension" => SearchField::Extension,
                        "type" | "kind" => SearchField::Type,
                        _ => SearchField::Any,
                    };
                    if field == SearchField::Any {
                        (field, raw.clone())
                    } else {
                        (field, raw[separator + 1..].to_string())
                    }
                }
                _ => (SearchField::Any, raw),
            };
            let value = value.trim().to_ascii_lowercase();
            (!value.is_empty()).then_some(SearchTerm {
                value,
                field,
                excluded,
            })
        })
        .collect()
}

fn append_search_term(clauses: &mut Vec<String>, values: &mut Vec<Value>, term: &SearchTerm) {
    let mut sql = match term.field {
        SearchField::Any => {
            let pattern = search_like_pattern(&term.value);
            values.push(Value::Text(pattern.clone()));
            values.push(Value::Text(pattern));
            // A literal without separators cannot straddle the folder/name
            // boundary. Match folder paths once rather than reconstructing and
            // lowercasing a full path for every file in a multi-million-row scan.
            if !term
                .value
                .chars()
                .any(|c| matches!(c, '/' | '\\' | '*' | '?'))
            {
                return clauses.push(format!(
                    "{}(LOWER(n.name) LIKE ? ESCAPE '\\' OR \
                     CASE WHEN n.is_dir=1 THEN n.id ELSE n.parent_id END IN \
                     (SELECT id FROM nodes WHERE is_dir=1 AND LOWER(dir_path) LIKE ? ESCAPE '\\'))",
                    if term.excluded { "NOT " } else { "" }
                ));
            }
            format!(
                "(LOWER(n.name) LIKE ? ESCAPE '\\' OR LOWER({}) LIKE ? ESCAPE '\\')",
                node_path_sql()
            )
        }
        SearchField::Name => {
            values.push(Value::Text(search_like_pattern(&term.value)));
            "LOWER(n.name) LIKE ? ESCAPE '\\'".to_string()
        }
        SearchField::Path => {
            values.push(Value::Text(search_like_pattern(&term.value)));
            format!("LOWER({}) LIKE ? ESCAPE '\\'", node_path_sql())
        }
        SearchField::Extension => {
            values.push(Value::Text(search_like_pattern(
                term.value.trim_start_matches('.'),
            )));
            "LOWER(n.extension) LIKE ? ESCAPE '\\'".to_string()
        }
        SearchField::Type => category_clause(&term.value, values).unwrap_or_else(|| {
            values.push(Value::Text(search_like_pattern(
                term.value.trim_start_matches('.'),
            )));
            "(n.is_dir=0 AND LOWER(n.extension) LIKE ? ESCAPE '\\')".to_string()
        }),
    };
    if term.excluded {
        sql = format!("NOT ({sql})");
    }
    clauses.push(sql);
}

fn append_extension_filter(clauses: &mut Vec<String>, values: &mut Vec<Value>, raw: &str) {
    let mut extensions = raw
        .split(|character: char| character.is_whitespace() || character == ',')
        .map(|extension| {
            extension
                .trim()
                .trim_start_matches(['.', '*'])
                .to_ascii_lowercase()
        })
        .filter(|extension| !extension.is_empty())
        .collect::<Vec<_>>();
    extensions.sort_unstable();
    extensions.dedup();
    if extensions.is_empty() {
        return;
    }
    let placeholders = vec!["?"; extensions.len()].join(",");
    clauses.push(format!(
        "(n.is_dir=0 AND LOWER(n.extension) IN ({placeholders}))"
    ));
    values.extend(extensions.into_iter().map(Value::Text));
}

fn append_category_filter(clauses: &mut Vec<String>, values: &mut Vec<Value>, category: &str) {
    let category = category.trim().to_ascii_lowercase();
    if category.is_empty() || category == "any" {
        return;
    }
    if let Some(clause) = category_clause(&category, values) {
        clauses.push(clause);
    }
}

fn category_clause(category: &str, values: &mut Vec<Value>) -> Option<String> {
    match category {
        "folder" | "folders" | "directory" | "directories" | "dir" => {
            Some("n.is_dir=1".to_string())
        }
        "file" | "files" => Some("n.is_dir=0".to_string()),
        _ => {
            let extensions = category_extensions(category)?;
            let placeholders = vec!["?"; extensions.len()].join(",");
            values.extend(
                extensions
                    .iter()
                    .map(|extension| Value::Text((*extension).to_string())),
            );
            Some(format!(
                "(n.is_dir=0 AND LOWER(n.extension) IN ({placeholders}))"
            ))
        }
    }
}

fn category_extensions(category: &str) -> Option<&'static [&'static str]> {
    match category {
        "image" | "images" => Some(&[
            "jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "svg", "heic", "heif",
            "ico", "raw", "cr2", "nef", "arw", "dng",
        ]),
        "video" | "videos" => Some(&[
            "mp4", "mkv", "mov", "avi", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts",
            "3gp",
        ]),
        "audio" => Some(&[
            "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff", "alac", "opus", "mid",
        ]),
        "document" | "documents" => Some(&[
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "odp",
            "md", "csv", "epub", "pages",
        ]),
        "archive" | "archives" => Some(&[
            "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab", "tgz", "zst", "lz",
        ]),
        "code" => Some(&[
            "js", "ts", "jsx", "tsx", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb",
            "php", "html", "css", "json", "xml", "yaml", "yml", "sh", "sql", "swift", "kt", "lua",
            "vue",
        ]),
        "executable" | "executables" => Some(&[
            "exe", "msi", "dll", "bat", "cmd", "com", "ps1", "app", "sys", "scr",
        ]),
        _ => None,
    }
}

fn node_path_sql() -> &'static str {
    "CASE WHEN n.is_dir=1 THEN n.dir_path WHEN p.dir_path IS NULL OR p.dir_path='' THEN n.name WHEN substr(p.dir_path,-1,1) IN ('\\','/') THEN p.dir_path || n.name ELSE p.dir_path || '\\' || n.name END"
}

fn search_like_pattern(value: &str) -> String {
    let has_wildcard = value.contains('*') || value.contains('?');
    let mut pattern = String::with_capacity(value.len() + 2);
    if !has_wildcard {
        pattern.push('%');
    }
    for character in value.chars() {
        match character {
            '*' => pattern.push('%'),
            '?' => pattern.push('_'),
            '\\' => pattern.push_str("\\\\"),
            '%' => pattern.push_str("\\%"),
            '_' => pattern.push_str("\\_"),
            value => pattern.push(value),
        }
    }
    if !has_wildcard {
        pattern.push('%');
    }
    pattern
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.replace('\\', "/").to_ascii_lowercase();
    let value = value.replace('\\', "/").to_ascii_lowercase();
    let (p, v) = (pattern.as_bytes(), value.as_bytes());
    let (mut pi, mut vi, mut star, mut mark) = (0usize, 0usize, None, 0usize);
    while vi < v.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == v[vi]) {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            mark = vi;
        } else if let Some(star_index) = star {
            pi = star_index + 1;
            mark += 1;
            vi = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

fn directory_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn database_family_size(path: &Path) -> u64 {
    let mut total = fs::metadata(path).map(|value| value.len()).unwrap_or(0);
    for suffix in ["-wal", "-shm"] {
        total += fs::metadata(format!("{}{suffix}", path.to_string_lossy()))
            .map(|value| value.len())
            .unwrap_or(0);
    }
    total
}

fn remove_database_family(path: &Path) {
    let _ = fs::remove_file(path);
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", path.to_string_lossy()));
    }
}

trait LockUnpoisoned<T> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T>;
}

impl<T> LockUnpoisoned<T> for Mutex<T> {
    fn lock_unpoisoned(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(windows)]
fn process_memory_bytes() -> (Option<u64>, Option<u64>) {
    #[repr(C)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut ProcessMemoryCountersEx,
            cb: u32,
        ) -> i32;
    }
    let mut counters = ProcessMemoryCountersEx {
        cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32,
        page_fault_count: 0,
        peak_working_set_size: 0,
        working_set_size: 0,
        quota_peak_paged_pool_usage: 0,
        quota_paged_pool_usage: 0,
        quota_peak_non_paged_pool_usage: 0,
        quota_non_paged_pool_usage: 0,
        pagefile_usage: 0,
        peak_pagefile_usage: 0,
        private_usage: 0,
    };
    let ok = unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters,
            std::mem::size_of::<ProcessMemoryCountersEx>() as u32,
        )
    };
    if ok == 0 {
        (None, None)
    } else {
        (
            Some(counters.working_set_size as u64),
            Some(counters.private_usage as u64),
        )
    }
}

#[cfg(not(windows))]
fn process_memory_bytes() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> Arc<V2Store> {
        let root = std::env::temp_dir().join(format!("filetree-v2-{name}-{}", new_scan_id()));
        V2Store::open(root).expect("open v2 store")
    }

    /// One file per directory, each with a distinct creation and modification
    /// time, so a rollup that confuses the two is visible in the assertions.
    fn tree_with_creation_dates() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        create_scan_schema(&conn).expect("schema");
        let mut conn = conn;
        let row = |id: i64, parent: Option<i64>, name: &str, is_dir: bool, created: u64| ScanRow {
            id,
            parent_id: parent,
            name: name.to_string(),
            dir_path: if is_dir {
                name.to_string()
            } else {
                String::new()
            },
            is_dir,
            is_link: false,
            hidden: false,
            readonly: false,
            size: 10,
            allocated: 10,
            files: u64::from(!is_dir),
            folders: 0,
            modified_ms: 9_000,
            created_ms: created,
            accessed_ms: 0,
            depth: if parent.is_none() { 0 } else { 1 },
            errors: 0,
            extension: String::new(),
            owner: String::new(),
            attributes: 0,
            frn: 0,
        };
        insert_scan_batch(
            &mut conn,
            &[
                // The root's own birth date is later than anything inside it.
                row(0, None, "C:\\", true, 8_000),
                row(1, Some(0), "old.txt", false, 1_000),
                row(2, Some(0), "new.txt", false, 5_000),
            ],
        )
        .expect("insert");
        aggregate_scan(&conn).expect("aggregate");
        conn
    }

    fn newest_created(conn: &Connection, id: i64) -> i64 {
        conn.query_row(
            "SELECT newest_created_ms FROM nodes WHERE id=?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn a_folder_reports_the_newest_creation_date_beneath_it() {
        let conn = tree_with_creation_dates();
        assert_eq!(newest_created(&conn, 0), 5_000);
    }

    #[test]
    fn a_folders_own_birth_date_never_counts_as_a_file_arriving() {
        let conn = tree_with_creation_dates();
        // 8_000 is the directory's own created_ms; only the files may date it.
        assert_ne!(newest_created(&conn, 0), 8_000);
        assert_eq!(
            newest_created(&conn, 1),
            1_000,
            "a file dates itself by its own creation"
        );
    }

    #[test]
    fn an_unreadable_folder_is_counted_at_every_level_above_it() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        create_scan_schema(&conn).expect("schema");
        let mut conn = conn;
        let dir = |id: i64, parent: Option<i64>, depth: u32| ScanRow {
            id,
            parent_id: parent,
            name: format!("d{id}"),
            dir_path: format!("d{id}"),
            is_dir: true,
            is_link: false,
            hidden: false,
            readonly: false,
            size: 0,
            allocated: 0,
            files: 0,
            folders: 0,
            modified_ms: 0,
            created_ms: 0,
            accessed_ms: 0,
            depth,
            errors: 0,
            extension: String::new(),
            owner: String::new(),
            attributes: 0,
            frn: 0,
        };
        insert_scan_batch(&mut conn, &[dir(0, None, 0), dir(1, Some(0), 1)]).expect("insert");
        // What the walker does when a folder refuses to be read.
        conn.execute("UPDATE nodes SET errors=1 WHERE id=1", [])
            .expect("mark");
        aggregate_scan(&conn).expect("aggregate");

        let errors = |id: i64| -> i64 {
            conn.query_row("SELECT errors FROM nodes WHERE id=?1", params![id], |row| {
                row.get(0)
            })
            .unwrap()
        };
        assert_eq!(errors(1), 1, "the folder keeps its own failure");
        assert_eq!(errors(0), 1, "and the root reports it exactly once");
    }

    #[test]
    fn an_older_scan_database_gains_the_columns_this_build_reads() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE nodes(id INTEGER PRIMARY KEY,parent_id INTEGER,name TEXT NOT NULL);",
        )
        .expect("legacy schema");
        migrate_scan_schema(&conn).expect("migrate");
        // Running twice must be harmless: every reopen goes through this path.
        migrate_scan_schema(&conn).expect("migrate again");
        conn.execute("INSERT INTO nodes(id,name) VALUES(1,'a.txt')", [])
            .expect("insert");
        assert_eq!(newest_created(&conn, 1), 0, "back-filled as unknown");
    }

    #[test]
    fn wildcard_matching_is_case_insensitive() {
        assert!(wildcard_match("*.MP4", "folder/test.mp4"));
        assert!(wildcard_match("folder/*", "Folder/test.mp4"));
        assert!(!wildcard_match("*.zip", "test.mp4"));
    }

    #[test]
    fn duplicate_hash_batches_coalesce_small_groups_without_splitting_large_ones() {
        let many_pairs = (1..=1_200).map(|size| (size, 2u64)).collect::<Vec<_>>();
        let batches = duplicate_hash_batches(&many_pairs);
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            [500, 500, 200]
        );
        assert_eq!(
            batches.into_iter().flatten().collect::<Vec<_>>().len(),
            1_200
        );

        let oversized = duplicate_hash_batches(&[(9, 5_000), (8, 2), (7, 2)]);
        assert_eq!(oversized, vec![vec![9], vec![8, 7]]);
    }

    #[test]
    fn search_query_parser_supports_tokens_phrases_exclusions_and_scopes() {
        assert_eq!(
            parse_search_terms(
                r#"summer "annual report" -backup name:final in:archive ext:pdf type:document"#
            ),
            vec![
                SearchTerm {
                    value: "summer".to_string(),
                    field: SearchField::Any,
                    excluded: false,
                },
                SearchTerm {
                    value: "annual report".to_string(),
                    field: SearchField::Any,
                    excluded: false,
                },
                SearchTerm {
                    value: "backup".to_string(),
                    field: SearchField::Any,
                    excluded: true,
                },
                SearchTerm {
                    value: "final".to_string(),
                    field: SearchField::Name,
                    excluded: false,
                },
                SearchTerm {
                    value: "archive".to_string(),
                    field: SearchField::Path,
                    excluded: false,
                },
                SearchTerm {
                    value: "pdf".to_string(),
                    field: SearchField::Extension,
                    excluded: false,
                },
                SearchTerm {
                    value: "document".to_string(),
                    field: SearchField::Type,
                    excluded: false,
                },
            ]
        );
    }

    #[test]
    fn scan_search_is_tokenized_filtered_and_paginated_in_sqlite() {
        let store = temp_store("search");
        let source = store.data_root().join("fixture");
        fs::create_dir_all(source.join("Finance Archive")).unwrap();
        fs::write(source.join("Summer Vacation 2024.mp4"), vec![1u8; 40]).unwrap();
        fs::write(source.join("Summer Backup 2024.mp4"), vec![2u8; 60]).unwrap();
        fs::write(
            source
                .join("Finance Archive")
                .join("Annual Report Final.pdf"),
            vec![3u8; 20],
        )
        .unwrap();
        let handle = store
            .start_scan(
                ScanRequest {
                    root: source.to_string_lossy().into_owned(),
                    threads: 2,
                    ..Default::default()
                },
                |_| {},
            )
            .unwrap();
        for _ in 0..200 {
            let status = store.scan_status(&handle.scan_id).unwrap();
            if status.status != "scanning" {
                assert_eq!(status.status, "done");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let tokenized = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                search: "summer 2024 -backup".to_string(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(tokenized.total, 1);
        assert_eq!(tokenized.items[0].name, "Summer Vacation 2024.mp4");
        let bookmarked = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                directory_paths: vec![
                    source
                        .join("Finance Archive")
                        .to_string_lossy()
                        .into_owned(),
                    "Q:/another-scan".into(),
                ],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(bookmarked.items.len(), 1);
        assert!(bookmarked.items[0].is_dir);
        assert_eq!(bookmarked.items[0].name, "Finance Archive");

        let folder_matches = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                search: "\"finance archive\"".into(),
                ..Default::default()
            })
            .unwrap();
        assert!(
            folder_matches
                .items
                .iter()
                .any(|item| item.name == "Annual Report Final.pdf")
        );

        let preview = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                search: "summer 2024".to_string(),
                limit: 1,
                count_total: false,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(preview.items.len(), 1);
        assert!(preview.has_more);
        assert_eq!(preview.total, 2);

        let scoped = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                search: r#""annual report" path:"finance archive" ext:p?f"#.to_string(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(scoped.total, 1);
        assert_eq!(scoped.items[0].name, "Annual Report Final.pdf");

        let filtered = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                category: "video".to_string(),
                min_size: Some(50),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items[0].name, "Summer Backup 2024.mp4");

        let regex = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id,
                parent_id: None,
                search: "^annual.*final\\.pdf$".to_string(),
                regex: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(regex.total, 1);
    }

    #[test]
    fn scan_pages_are_bounded_and_aggregated() {
        let store = temp_store("page");
        let source = store.data_root().join("fixture");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("a.bin"), vec![1u8; 10]).unwrap();
        fs::write(source.join("nested").join("b.bin"), vec![2u8; 20]).unwrap();
        let request = ScanRequest {
            root: source.to_string_lossy().into_owned(),
            threads: 2,
            ..Default::default()
        };
        let progress_events = Arc::new(Mutex::new(Vec::<ScanProgress>::new()));
        let captured_events = Arc::clone(&progress_events);
        let handle = store
            .start_scan(request, move |event| {
                captured_events.lock_unpoisoned().push(event);
            })
            .unwrap();
        for _ in 0..200 {
            let status = store.scan_status(&handle.scan_id).unwrap();
            if status.status != "scanning" {
                assert_eq!(status.status, "done");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let first_progress = progress_events
            .lock_unpoisoned()
            .first()
            .cloned()
            .expect("scan should publish progress immediately");
        assert_eq!(first_progress.stage, "scanning");
        assert_eq!(first_progress.node_count, 1);
        let root = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                limit: 1,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(root.items.len(), 1);
        assert_eq!(root.items[0].size, 30);
        let children = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: Some(0),
                limit: 5000,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(children.total, 2);
        assert_eq!(children.limit, TREE_PAGE_MAX);

        let snapshot_children = store
            .query_snapshot_children(&handle.scan_id, 0, 50_000)
            .unwrap();
        assert_eq!(snapshot_children.len(), 2);
        let nested = snapshot_children
            .iter()
            .find(|item| item.name == "nested")
            .expect("nested aggregate");
        assert_eq!(nested.size, 20);
        assert_eq!(nested.files, 1);
    }

    fn mft_entry(name: &str) -> crate::mft::MftEntry {
        crate::mft::MftEntry {
            name: name.to_string(),
            present: true,
            ..Default::default()
        }
    }

    #[test]
    fn mft_file_rows_match_the_walker_row_shape() {
        let entry = crate::mft::MftEntry {
            parent: 5,
            size: 4096,
            allocated: 8192,
            created_ms: 111,
            modified_ms: 222,
            accessed_ms: 333,
            attributes: 0x21, // READONLY | ARCHIVE
            ..mft_entry("Report.PDF")
        };
        let row = mft_row(7, 3, &entry, "C:\\docs\\Report.PDF", 2, 91);

        assert_eq!(row.id, 7);
        assert_eq!(row.parent_id, Some(3));
        assert_eq!(row.name, "Report.PDF");
        assert_eq!(
            row.dir_path, "",
            "file rows intern their path through the parent row"
        );
        assert_eq!(row.extension, "pdf", "extensions are lowercased");
        assert_eq!(row.size, 4096);
        assert_eq!(row.allocated, 8192);
        assert!(row.readonly, "READONLY comes out of the attribute bitmask");
        assert_eq!(row.files, 1);
        assert_eq!(row.depth, 2);
        assert_eq!(row.attributes, 0x21);
        assert_eq!(
            row.frn, 91,
            "the MFT record number is what journal replay matches on"
        );
    }

    #[test]
    fn mft_directory_rows_carry_their_own_path() {
        let entry = crate::mft::MftEntry {
            is_dir: true,
            ..mft_entry("docs")
        };
        let row = mft_row(3, 0, &entry, "C:\\docs", 1, 42);
        assert_eq!(row.dir_path, "C:\\docs");
        assert_eq!(row.extension, "");
        assert_eq!(row.files, 0, "a directory is not itself a file");
        assert_eq!(row.size, 0, "directory size arrives via aggregation");
    }

    #[test]
    fn mft_resident_files_report_a_nonzero_allocation() {
        let entry = crate::mft::MftEntry {
            size: 64,
            allocated: 0, // content lives inside the MFT record
            ..mft_entry("tiny.txt")
        };
        assert_eq!(mft_row(1, 0, &entry, "C:\\tiny.txt", 1, 17).allocated, 64);
    }

    #[test]
    fn join_child_path_inserts_exactly_one_separator() {
        assert_eq!(join_child_path("C:\\", "Users"), "C:\\Users");
        assert_eq!(join_child_path("C:\\Users", "alex"), "C:\\Users\\alex");
        assert_eq!(join_child_path("C:/Users", "alex"), "C:/Users\\alex");
    }

    /// End-to-end equivalence: the fast path must be invisible in the results.
    ///
    /// Ignored by default because it sets a process-wide env var that would
    /// leak into tests running in parallel, and because forcing the MFT path at
    /// a subtree streams the whole volume table. Run it deliberately, from an
    /// ELEVATED shell on an NTFS volume — the only configuration where the fast
    /// path actually engages rather than falling back:
    ///
    /// ```text
    /// cargo test --lib mft_scan_matches_the_directory_walk -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "sets FILETREE_MFT process-wide; needs elevation to exercise the reader"]
    fn mft_scan_matches_the_directory_walk() {
        let store = temp_store("mft-equivalence");
        let source = store.data_root().join("fixture");
        fs::create_dir_all(source.join("nested").join("deeper")).unwrap();
        fs::write(source.join("a.bin"), vec![1u8; 10]).unwrap();
        fs::write(source.join("nested").join("b.bin"), vec![2u8; 20]).unwrap();
        fs::write(
            source.join("nested").join("deeper").join("c.txt"),
            vec![3u8; 30],
        )
        .unwrap();

        let run = |mode: &str| {
            // SAFETY: single-threaded section of this test; no other test reads
            // FILETREE_MFT.
            unsafe { std::env::set_var("FILETREE_MFT", mode) };
            let started = Instant::now();
            let handle = store
                .start_scan(
                    ScanRequest {
                        root: source.to_string_lossy().into_owned(),
                        threads: 4,
                        ..Default::default()
                    },
                    |_| {},
                )
                .unwrap();
            let mut status = store.scan_status(&handle.scan_id).unwrap();
            for _ in 0..6_000 {
                if status.status != "scanning" {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
                status = store.scan_status(&handle.scan_id).unwrap();
            }
            assert_eq!(status.status, "done", "{mode} scan should finish");
            let elapsed = started.elapsed();

            let root = store
                .query_nodes(ScanQuery {
                    scan_id: handle.scan_id.clone(),
                    parent_id: None,
                    limit: 1,
                    ..Default::default()
                })
                .unwrap();
            let mut tree = store
                .query_snapshot_children(&handle.scan_id, 0, 50_000)
                .unwrap()
                .into_iter()
                .map(|item| (item.name, item.size, item.files))
                .collect::<Vec<_>>();
            tree.sort();
            println!(
                "FILETREE_MFT={mode}: {} nodes, {} bytes, {:?}",
                status.node_count, root.items[0].size, elapsed
            );
            (status.node_count, root.items[0].size, tree)
        };

        let walked = run("never");
        let fast = run("always");
        unsafe { std::env::remove_var("FILETREE_MFT") };

        assert_eq!(walked.0, fast.0, "node counts must match");
        assert_eq!(walked.1, fast.1, "total sizes must match");
        assert_eq!(walked.2, fast.2, "the trees themselves must match");
        assert_eq!(walked.1, 60, "fixture holds 10 + 20 + 30 bytes");
    }

    #[test]
    fn subtree_file_pages_are_recursive_and_bounded() {
        let store = temp_store("subtree-files");
        let source = store.data_root().join("fixture");
        let selected = source.join("selected");
        fs::create_dir_all(selected.join("nested")).unwrap();
        fs::write(selected.join("a.mp4"), vec![1u8; 10]).unwrap();
        fs::write(selected.join("b.jpg"), vec![2u8; 20]).unwrap();
        fs::write(selected.join("nested").join("c.mp4"), vec![3u8; 30]).unwrap();
        fs::write(source.join("outside.mp4"), vec![4u8; 40]).unwrap();
        let handle = store
            .start_scan(
                ScanRequest {
                    root: source.to_string_lossy().into_owned(),
                    threads: 2,
                    ..Default::default()
                },
                |_| {},
            )
            .unwrap();
        for _ in 0..200 {
            let status = store.scan_status(&handle.scan_id).unwrap();
            if status.status != "scanning" {
                assert_eq!(status.status, "done");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let directory = store
            .query_nodes(ScanQuery {
                scan_id: handle.scan_id.clone(),
                parent_id: None,
                search: "name:selected".to_string(),
                directories_only: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(directory.items.len(), 1);
        let first = store
            .query_subtree_files(SubtreeFilesQuery {
                scan_id: handle.scan_id.clone(),
                directory_id: directory.items[0].id,
                offset: 0,
                limit: 2,
            })
            .unwrap();
        assert_eq!(first.items.len(), 2);
        assert!(first.has_more);
        let second = store
            .query_subtree_files(SubtreeFilesQuery {
                scan_id: handle.scan_id.clone(),
                directory_id: directory.items[0].id,
                offset: 2,
                limit: 2,
            })
            .unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(!second.has_more);
        assert_eq!(
            first.items.iter().map(|item| item.size).sum::<u64>()
                + second.items.iter().map(|item| item.size).sum::<u64>(),
            60
        );
        assert!(
            first
                .items
                .iter()
                .all(|item| !item.path.ends_with("outside.mp4"))
        );
        let widened = store
            .query_subtree_files(SubtreeFilesQuery {
                scan_id: handle.scan_id.clone(),
                directory_id: directory.items[0].id,
                offset: 0,
                limit: usize::MAX,
            })
            .unwrap();
        assert_eq!(widened.limit, SUBTREE_FILE_PAGE_MAX);
        assert_eq!(widened.items.len(), 3);
        let mut all = store
            .query_all_subtree_files(&handle.scan_id, directory.items[0].id)
            .unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.iter().map(|item| item.size).sum::<u64>(), 60);
        let mut streamed = Vec::new();
        let streamed_total = store
            .stream_subtree_files(&handle.scan_id, directory.items[0].id, 2, |batch| {
                streamed.push(batch);
                Ok(())
            })
            .unwrap();
        assert_eq!(streamed_total, 3);
        assert_eq!(
            streamed.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(
            streamed.iter().flatten().map(|item| item.size).sum::<u64>(),
            60
        );
        assert_eq!(
            store.validate_indexed_sources_authorized(&mut all).unwrap(),
            0
        );
        assert!(
            store.source_paths_are_authorized(
                &all.iter()
                    .map(|item| item.path.as_str())
                    .collect::<Vec<_>>()
            )
        );
        let outside_root = store.data_root().join("not-scanned.txt");
        fs::write(&outside_root, b"not authorized").unwrap();
        let outside_text = outside_root.to_string_lossy().into_owned();
        assert!(
            !store.source_paths_are_authorized(&[all[0].path.as_str(), outside_text.as_str(),])
        );
        assert_eq!(
            store
                .mark_scans_stale_for_path(&selected.join("a.mp4"))
                .unwrap(),
            1
        );
        assert!(
            store
                .find_completed_scan(&source.to_string_lossy())
                .is_none()
        );
        // Staleness invalidates indexed measurements, not the user's authority
        // over the root they explicitly scanned. Live open/context/watch
        // commands must remain usable while the watcher reconciles its rows.
        assert!(
            store.source_paths_are_authorized(
                &all.iter()
                    .map(|item| item.path.as_str())
                    .collect::<Vec<_>>()
            )
        );
        assert!(!store.source_path_is_authorized(&outside_text));
        let mut stale_sources = all.clone();
        assert_eq!(
            store
                .validate_indexed_sources_authorized(&mut stale_sources)
                .unwrap(),
            0
        );
        assert_eq!(stale_sources.len(), all.len());
        let mut unauthorized = vec![IndexedCompressionSource {
            path: outside_text,
            size: 14,
            is_link: false,
        }];
        assert!(
            store
                .validate_indexed_sources_authorized(&mut unauthorized)
                .is_err()
        );
        let mut removed = vec![IndexedCompressionSource {
            path: selected
                .join("removed-after-scan.txt")
                .to_string_lossy()
                .into_owned(),
            size: 1,
            is_link: false,
        }];
        assert_eq!(
            store
                .validate_indexed_sources_authorized(&mut removed)
                .unwrap(),
            1
        );
        assert!(removed.is_empty());
        let entire_scan = store.query_all_subtree_files(&handle.scan_id, 0).unwrap();
        assert_eq!(entire_scan.len(), 4);
        assert_eq!(entire_scan.iter().map(|item| item.size).sum::<u64>(), 100);
        let preview = store
            .query_largest_subtree_file(&handle.scan_id, directory.items[0].id)
            .unwrap()
            .expect("largest subtree file");
        assert!(preview.path.ends_with("c.mp4"));
        assert_eq!(preview.size, 30);
    }

    #[test]
    fn duplicate_scan_persists_large_file_fingerprints() {
        let store = temp_store("persistent_fingerprints");
        let source = store.data_root().join("fixture");
        fs::create_dir_all(&source).unwrap();
        for name in ["first.bin", "second.bin", "different.bin"] {
            let mut data = vec![42u8; 256 * 1024];
            if name == "different.bin" {
                data[0] = 9;
            }
            fs::write(source.join(name), data).unwrap();
        }
        let handle = store
            .start_scan(
                ScanRequest {
                    root: source.to_string_lossy().into_owned(),
                    threads: 2,
                    ..Default::default()
                },
                |_| {},
            )
            .unwrap();
        for _ in 0..200 {
            let status = store.scan_status(&handle.scan_id).unwrap();
            if status.status != "scanning" {
                assert_eq!(status.status, "done");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let request = DuplicateScanRequest {
            sources: vec![DuplicateSource {
                scan_id: handle.scan_id,
                target_path: source.to_string_lossy().into_owned(),
            }],
            min_size: 1,
            threads: 2,
            ..Default::default()
        };
        let first = store
            .find_exact_duplicates(request.clone(), Arc::new(AtomicBool::new(false)), |_| {})
            .unwrap();
        assert_eq!(first.groups.len(), 1);
        assert_eq!(first.groups[0].files.len(), 2);
        assert!(first.errors.is_empty());
        let state = store.open_state().unwrap();
        let count: i64 = state.query_row("SELECT COUNT(*) FROM duplicate_fingerprints_v1 WHERE quick IS NOT NULL AND sample IS NOT NULL", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 3);
        drop(state);
        for name in ["first.bin", "second.bin", "different.bin"] {
            fs::remove_file(source.join(name)).unwrap();
        }
        // A fresh pipeline instance must load both cache types from SQLite.
        let repeated = store
            .find_exact_duplicates(request, Arc::new(AtomicBool::new(false)), |_| {})
            .unwrap();
        assert_eq!(repeated.groups.len(), 1);
        assert!(
            repeated.errors.is_empty(),
            "warm discovery should perform no file reads"
        );
    }

    #[test]
    fn duplicate_metadata_scan_does_not_read_contents() {
        let store = temp_store("metadata_only");
        let source = store.data_root().join("fixture");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("same.bin"), b"aaaa").unwrap();
        fs::write(source.join("nested/same.bin"), b"bbbb").unwrap();
        let handle = store
            .start_scan(
                ScanRequest {
                    root: source.to_string_lossy().into_owned(),
                    threads: 2,
                    ..Default::default()
                },
                |_| {},
            )
            .unwrap();
        for _ in 0..200 {
            let status = store.scan_status(&handle.scan_id).unwrap();
            if status.status != "scanning" {
                assert_eq!(status.status, "done");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Removing payloads proves grouping uses the index alone.
        fs::remove_file(source.join("same.bin")).unwrap();
        fs::remove_file(source.join("nested/same.bin")).unwrap();
        let request = DuplicateScanRequest {
            metadata_only: true,
            sources: vec![DuplicateSource {
                scan_id: handle.scan_id,
                target_path: source.to_string_lossy().into_owned(),
            }],
            ..Default::default()
        };
        let fractions = Mutex::new(Vec::new());
        let result = store
            .find_exact_duplicates(request.clone(), Arc::new(AtomicBool::new(false)), |event| {
                assert_eq!(event.bytes_read, 0);
                assert_ne!(event.phase, "hashing");
                if event.phase == "grouping" {
                    fractions.lock().unwrap().push(event.fraction.unwrap());
                }
            })
            .unwrap();
        assert!(result.errors.is_empty());
        assert_eq!(result.hashing, 0);
        assert_eq!(result.groups.len(), 1);
        assert_eq!(result.groups[0].files.len(), 2);
        let fractions = fractions.into_inner().unwrap();
        assert_eq!(fractions.first(), Some(&0.0));
        assert_eq!(fractions.last(), Some(&1.0));
        assert!(
            fractions
                .iter()
                .any(|fraction| *fraction > 0.0 && *fraction < 1.0)
        );
        assert!(fractions.windows(2).all(|pair| pair[0] <= pair[1]));
        let excluded = store
            .find_exact_duplicates(
                DuplicateScanRequest {
                    excluded_paths: vec![source.join("nested").to_string_lossy().into_owned()],
                    ..request
                },
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .unwrap();
        assert!(excluded.groups.is_empty());
    }

    #[test]
    fn duplicate_scan_uses_persisted_index_and_full_content_hashes() {
        let store = temp_store("duplicates");
        let source = store.data_root().join("fixture");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("first.bin"), b"identical duplicate bytes").unwrap();
        fs::write(
            source.join("nested").join("second.bin"),
            b"identical duplicate bytes",
        )
        .unwrap();
        fs::write(source.join("different.bin"), b"different content bytes!!").unwrap();
        let handle = store
            .start_scan(
                ScanRequest {
                    root: source.to_string_lossy().into_owned(),
                    threads: 2,
                    ..Default::default()
                },
                |_| {},
            )
            .unwrap();
        for _ in 0..200 {
            let status = store.scan_status(&handle.scan_id).unwrap();
            if status.status != "scanning" {
                assert_eq!(status.status, "done");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        let request = DuplicateScanRequest {
            sources: vec![DuplicateSource {
                scan_id: handle.scan_id,
                target_path: source.to_string_lossy().into_owned(),
            }],
            min_size: 1,
            threads: 2,
            ..Default::default()
        };
        let result = store
            .find_exact_duplicates(request.clone(), Arc::new(AtomicBool::new(false)), |_| {})
            .unwrap();

        assert!(!result.cancelled);
        assert_eq!(result.groups.len(), 1);
        let names = result.groups[0]
            .files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(names, HashSet::from(["first.bin", "second.bin"]));
        assert_eq!(
            result.groups[0].waste,
            b"identical duplicate bytes".len() as u64
        );

        let state = store.open_state().unwrap();
        assert_eq!(
            state
                .query_row("SELECT COUNT(*) FROM duplicate_hashes", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            3 // Includes the fully read, rejected candidate.
        );
        state
            .execute("UPDATE duplicate_hashes SET updated_at=17", [])
            .unwrap();
        drop(state);
        let repeated = store
            .find_exact_duplicates(request.clone(), Arc::new(AtomicBool::new(false)), |_| {})
            .unwrap();
        assert_eq!(repeated.groups.len(), 1);
        let state = store.open_state().unwrap();
        assert_eq!(
            state
                .query_row(
                    "SELECT COUNT(*) FROM duplicate_hashes WHERE updated_at=17",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            3 // Includes the fully read, rejected candidate.
        );

        let excluded = store
            .find_exact_duplicates(
                DuplicateScanRequest {
                    excluded_paths: vec![source.join("nested").to_string_lossy().into_owned()],
                    ..request
                },
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .unwrap();
        assert!(
            excluded.groups.is_empty(),
            "files under an explicitly excluded child folder must not be candidates"
        );
    }

    #[test]
    fn duplicate_scan_uses_deepest_scope_rule_with_normalized_separators() {
        let store = temp_store("duplicate-scope-rules");
        let source = store.data_root().join("fixture");
        let excluded = source.join("excluded");
        let included = excluded.join("included");
        fs::create_dir_all(&included).unwrap();
        fs::write(source.join("root.bin"), b"scope duplicate").unwrap();
        fs::write(excluded.join("blocked.bin"), b"scope duplicate").unwrap();
        fs::write(included.join("included.bin"), b"scope duplicate").unwrap();
        let handle = store
            .start_scan(
                ScanRequest {
                    root: source.to_string_lossy().into_owned(),
                    threads: 2,
                    ..Default::default()
                },
                |_| {},
            )
            .unwrap();
        for _ in 0..200 {
            let status = store.scan_status(&handle.scan_id).unwrap();
            if status.status != "scanning" {
                assert_eq!(status.status, "done");
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let query_path = |path: &Path| {
            let value = path.to_string_lossy().into_owned();
            if cfg!(windows) {
                value.replace('\\', "/")
            } else {
                value
            }
        };

        let result = store
            .find_exact_duplicates(
                DuplicateScanRequest {
                    sources: vec![DuplicateSource {
                        scan_id: handle.scan_id,
                        target_path: query_path(&source),
                    }],
                    min_size: 1,
                    threads: 2,
                    path_rules: vec![
                        DuplicatePathRule {
                            path: query_path(&source),
                            excluded: false,
                        },
                        DuplicatePathRule {
                            path: query_path(&excluded),
                            excluded: true,
                        },
                        DuplicatePathRule {
                            path: query_path(&included),
                            excluded: false,
                        },
                    ],
                    ..Default::default()
                },
                Arc::new(AtomicBool::new(false)),
                |_| {},
            )
            .unwrap();

        assert_eq!(result.groups.len(), 1);
        let names = result.groups[0]
            .files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(names, HashSet::from(["root.bin", "included.bin"]));
    }

    #[test]
    fn scan_id_rejects_path_traversal() {
        assert!(!safe_scan_id("../state"));
        assert!(safe_scan_id("abc-123"));
    }

    #[test]
    fn disk_budget_ignores_and_reclaims_uncatalogued_scan_files() {
        let store = temp_store("orphan-budget");
        let scan_id = new_scan_id();
        let scan_path = store.scans_dir.join(format!("{scan_id}.db"));
        fs::write(&scan_path, [0u8; 64]).unwrap();
        store
            .upsert_scan_catalog(&scan_id, store.data_root(), &scan_path, "done", 1)
            .unwrap();

        let orphan_id = new_scan_id();
        let orphan_path = store.scans_dir.join(format!("{orphan_id}.db"));
        fs::write(&orphan_path, [0u8; 128]).unwrap();

        let valid_bytes = database_family_size(&scan_path);
        assert_eq!(
            store
                .enforce_scan_disk_budget_with_limit(valid_bytes, None)
                .unwrap(),
            0
        );
        assert!(scan_path.is_file());
        assert!(store.catalog_handle(&scan_id).unwrap().is_some());

        assert!(store.cleanup_orphan_scan_databases().unwrap() >= 128);
        assert!(!orphan_path.exists());
        assert!(scan_path.is_file());
    }

    #[test]
    fn disk_budget_preserves_the_scan_being_published() {
        let store = temp_store("published-budget");
        let scan_id = new_scan_id();
        let scan_path = store.scans_dir.join(format!("{scan_id}.db"));
        fs::write(&scan_path, [0u8; 64]).unwrap();
        store
            .upsert_scan_catalog(&scan_id, store.data_root(), &scan_path, "done", 1)
            .unwrap();

        assert_eq!(
            store
                .enforce_scan_disk_budget_with_limit(0, Some(&scan_id))
                .unwrap(),
            0
        );
        assert!(scan_path.is_file());
        assert!(store.catalog_handle(&scan_id).unwrap().is_some());
    }

    #[test]
    fn json_settings_are_bounded_and_persisted() {
        let store = temp_store("settings");
        assert_eq!(store.load_json_setting("app.settings", "{}").unwrap(), "{}");
        store
            .save_json_setting("app.settings", r#"{"darkMode":true}"#, 128)
            .unwrap();
        assert_eq!(
            store.load_json_setting("app.settings", "{}").unwrap(),
            r#"{"darkMode":true}"#
        );
        assert!(
            store
                .save_json_setting("app.settings", "invalid", 128)
                .is_err()
        );
        assert!(
            store
                .save_json_setting("app.settings", r#"{"value":"too large"}"#, 8)
                .is_err()
        );
    }

    #[test]
    fn compression_files_are_persisted_filtered_and_paged() {
        let store = temp_store("compression-page");
        let record = |index: usize, status: &str, size: u64| CompressionFileRecord {
            job_id: "abc-123".to_string(),
            index,
            path: format!(r"C:\fixture\file-{index}.mp4"),
            kind: "video".to_string(),
            status: status.to_string(),
            stage: if status == "running" {
                "encoding"
            } else {
                "queued"
            }
            .to_string(),
            pct: if status == "running" { 25 } else { 0 },
            orig_bytes: size,
            new_bytes: 0,
            error: None,
            reason: String::new(),
            encoder: "nvenc_h264".to_string(),
            disposition: String::new(),
            out_path: String::new(),
            duration_ms: 0,
            fps: Some(120.0),
            started_at: if status == "running" { now_ms() } else { 0 },
            updated_at: now_ms(),
            finished_at: 0,
            attempt: usize::from(status == "running"),
            tool: "HandBrakeCLI".to_string(),
            tool_version: "1.10".to_string(),
            command: String::new(),
            stderr: String::new(),
            recycled: false,
            queue_position: (status == "pending").then_some(index),
        };
        store
            .persist_compression_job(
                "abc-123",
                "running",
                3,
                "{}",
                [
                    record(0, "pending", 10),
                    record(1, "running", 20),
                    record(2, "pending", 30),
                ],
            )
            .unwrap();
        let page = store
            .query_compression_files(
                "abc-123",
                CompressionPageQuery {
                    limit: 2,
                    sort: "size".to_string(),
                    direction: "desc".to_string(),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.total_matches, 3);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].index, 1, "active work stays pinned first");

        let pending = store
            .query_compression_files(
                "abc-123",
                CompressionPageQuery {
                    status: "pending".to_string(),
                    limit: 250,
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(pending.total_matches, 2);
        assert_eq!(pending.facets["status"]["pending"], 2);
    }
}
