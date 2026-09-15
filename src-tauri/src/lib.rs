use filetree_core::v2::{
    BOOKMARKS_JSON_MAX_BYTES, DuplicatePathRule, DuplicateProgress, DuplicateScanRequest,
    DuplicateScanResult, MemoryStats, NodePage, NodePageItem, SETTINGS_JSON_MAX_BYTES, ScanHandle,
    ScanProgress, ScanQuery, ScanRequest, SubtreeFileItem, SubtreeFilePage, SubtreeFilesQuery,
    V2Store,
};
use filetree_core::{
    CompressionEligibility, CompressionFilesRequest, CompressionStartRequest,
    CompressionStartResult, DesktopRuntime, compression_eligibility,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, State};

mod terminal;
mod cyberdrop;
mod fileops;
mod ollama;

struct FsWatchRegistry {
    next_id: AtomicU64,
    watchers: Mutex<HashMap<u64, FsWatchEntry>>,
}

struct FsWatchEntry {
    watcher: notify::RecommendedWatcher,
    worker: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct DuplicateScanRegistry {
    next_review_id: AtomicU64,
    cancel: Mutex<Option<DuplicateScanCancellation>>,
    review: Mutex<DuplicateReviewState>,
}

struct DuplicateScanCancellation {
    request_id: String,
    flag: Arc<AtomicBool>,
}

#[derive(Default)]
struct DuplicateReviewState {
    token: Option<String>,
    members: HashMap<String, DuplicateMemberSnapshot>,
    active_by_group: HashMap<u64, HashSet<String>>,
    in_flight: HashSet<String>,
    authorized_roots: Vec<PathBuf>,
    scope_rules: Vec<CanonicalDuplicateScopeRule>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum DuplicateScopeState {
    Normal,
    Reference,
    Excluded,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateScopeRule {
    path: String,
    state: DuplicateScopeState,
}

#[derive(Clone, Debug)]
struct CanonicalDuplicateScopeRule {
    path: PathBuf,
    state: DuplicateScopeState,
}

struct DuplicateMemberSnapshot {
    group_id: u64,
    size: u64,
    modified_ns: u128,
    // Discovery uses indexed metadata. Resolve identities only for action plans.
    identity: Option<DuplicateFileIdentity>,
}

struct DuplicateFileIdentity {
    identity_key: String,
    canonical_path: PathBuf,
    file_identity: (u64, u64),
}

impl DuplicateMemberSnapshot {
    fn matches_current(&self, current: &Self) -> bool {
        if self.size != current.size { return false; }
        match (&self.identity, &current.identity) {
            (Some(expected), Some(actual)) => self.modified_ns == current.modified_ns
                && expected.identity_key == actual.identity_key
                && expected.file_identity == actual.file_identity,
            (None, Some(_)) => self.modified_ns / 1_000_000_000 == current.modified_ns / 1_000_000_000,
            _ => false,
        }
    }
}

const EXTERNAL_DROP_PENDING_TTL: Duration = Duration::from_secs(30);
const EXTERNAL_CAPABILITY_LIMIT: usize = 128;

/// One-shot capabilities for paths supplied by the operating system rather
/// than by the renderer. Tauri commands otherwise accept only paths beneath a
/// scanned root. A native drop is claimable only briefly; clipboard reads mint
/// their capability directly. Claimed tokens remain valid while a transfer is
/// confirmed or queued, and the eventual copy/move consumes the token.
#[derive(Default)]
struct ExternalCopyGrants {
    next_token: AtomicU64,
    inner: Mutex<ExternalCopyGrantState>,
}

#[derive(Default)]
struct ExternalCopyGrantState {
    pending_drop_paths: HashMap<String, Instant>,
    capabilities: HashMap<String, ExternalPathCapability>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ExternalTransferKind {
    Copy,
    Move,
}

struct ExternalPathCapability {
    paths: HashSet<String>,
    kind: ExternalTransferKind,
    issued_at: Instant,
}

impl ExternalCopyGrants {
    fn path_key(path: &Path) -> Option<String> {
        if !path.is_absolute() {
            return None;
        }
        Some(
            fs::canonicalize(path)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_ascii_lowercase(),
        )
    }

    fn keys_from_strings(paths: &[String]) -> Option<HashSet<String>> {
        paths
            .iter()
            .map(|path| Self::path_key(Path::new(path)))
            .collect()
    }

    fn next_capability_token(&self) -> String {
        let sequence = self.next_token.fetch_add(1, Ordering::Relaxed) + 1;
        let issued = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{:x}-{issued:x}-{sequence:x}", std::process::id())
    }

    fn insert_capability(
        &self,
        state: &mut ExternalCopyGrantState,
        paths: HashSet<String>,
        kind: ExternalTransferKind,
    ) -> Option<String> {
        if paths.is_empty() {
            return None;
        }
        while state.capabilities.len() >= EXTERNAL_CAPABILITY_LIMIT {
            let Some(oldest) = state
                .capabilities
                .iter()
                .min_by_key(|(_, capability)| capability.issued_at)
                .map(|(token, _)| token.clone())
            else {
                break;
            };
            state.capabilities.remove(&oldest);
        }
        let token = self.next_capability_token();
        state.capabilities.insert(
            token.clone(),
            ExternalPathCapability {
                paths,
                kind,
                issued_at: Instant::now(),
            },
        );
        Some(token)
    }

    fn grant_clipboard(&self, paths: &[String], kind: ExternalTransferKind) -> Option<String> {
        let keys = Self::keys_from_strings(paths)?;
        let mut state = self.inner.lock().ok()?;
        self.insert_capability(&mut state, keys, kind)
    }

    fn grant_native_drop(&self, paths: &[PathBuf]) {
        let expires_at = Instant::now() + EXTERNAL_DROP_PENDING_TTL;
        if let Ok(mut state) = self.inner.lock() {
            state.pending_drop_paths.clear();
            state.pending_drop_paths.extend(
                paths
                    .iter()
                    .filter_map(|path| Self::path_key(path))
                    .map(|key| (key, expires_at)),
            );
        }
    }

    fn claim_native_drop(&self, paths: &[String], kind: ExternalTransferKind) -> Option<String> {
        let keys = Self::keys_from_strings(paths)?;
        if keys.is_empty() {
            return None;
        }
        let now = Instant::now();
        let mut state = self.inner.lock().ok()?;
        state
            .pending_drop_paths
            .retain(|_, expires_at| *expires_at > now);
        if !keys
            .iter()
            .all(|key| state.pending_drop_paths.contains_key(key))
        {
            return None;
        }
        for key in &keys {
            state.pending_drop_paths.remove(key);
        }
        self.insert_capability(&mut state, keys, kind)
    }

    fn consume_capability(
        &self,
        token: Option<&str>,
        paths: &[String],
        kind: ExternalTransferKind,
    ) -> bool {
        let Some(token) = token else {
            return paths.is_empty();
        };
        let Some(keys) = Self::keys_from_strings(paths) else {
            return false;
        };
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        let Some(capability) = state.capabilities.remove(token) else {
            return false;
        };
        capability.kind == kind && keys.iter().all(|key| capability.paths.contains(key))
    }

    fn revoke_capability(&self, token: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.capabilities.remove(token);
        }
    }
}

impl Default for FsWatchRegistry {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

#[tauri::command]
fn fs_watch_start(
    state: State<'_, Arc<V2Store>>,
    registry: State<'_, FsWatchRegistry>,
    root_path: String,
    on_change: Channel<Vec<String>>,
) -> Result<u64, String> {
    use notify::{RecursiveMode, Watcher};

    require_authorized_path(&state, &root_path)?;
    if !Path::new(&root_path).is_dir() {
        return Err(format!("Watch root is not a folder: {root_path}"));
    }

    // notify may emit one callback per item during a large move/copy. Sending
    // every callback through IPC overwhelms WebView2 long before the actual
    // shallow refresh becomes expensive, so collect paths in a shared set and
    // wake one short-lived batch worker.
    let pending = Arc::new(Mutex::new(HashSet::<String>::new()));
    let callback_pending = Arc::clone(&pending);
    let callback_root = root_path.clone();
    let (wake_tx, wake_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(mut changed_dirs) = callback_pending.lock() {
            match result {
                Ok(event) => {
                    for directory in watch_directories_for_paths(event.paths) {
                        changed_dirs.insert(directory);
                    }
                }
                // notify reports backend overflows/errors without reliable item
                // paths. Re-enumerate the watched directory itself rather than
                // silently going stale or rebuilding the complete volume.
                Err(_) => {
                    changed_dirs.insert(callback_root.clone());
                }
            }
        }
        let _ = wake_tx.try_send(());
    })
    .map_err(|error| format!("Could not create folder watcher: {error}"))?;
    watcher
        .watch(Path::new(&root_path), RecursiveMode::Recursive)
        .map_err(|error| format!("Could not watch {root_path}: {error}"))?;

    let worker = std::thread::Builder::new()
        .name("filetree-fs-watch".to_string())
        .spawn(move || forward_watch_batches(wake_rx, pending, on_change))
        .map_err(|error| format!("Could not start folder watcher worker: {error}"))?;

    let id = registry.next_id.fetch_add(1, Ordering::Relaxed);
    registry
        .watchers
        .lock()
        .map_err(|_| "Folder watcher registry is unavailable".to_string())?
        .insert(
            id,
            FsWatchEntry {
                watcher,
                worker: Some(worker),
            },
        );
    Ok(id)
}

const WATCH_IDLE_WINDOW: Duration = Duration::from_millis(40);
const WATCH_MAX_WINDOW: Duration = Duration::from_millis(120);

fn watch_directories_for_paths(paths: Vec<PathBuf>) -> Vec<String> {
    let mut directories = Vec::with_capacity(paths.len() * 2);
    for path in paths {
        // A create/rename into the watched tree must refresh both the parent's
        // entry list and the new directory's recursive aggregate. Keeping the
        // directory itself in the batch lets the lazy renderer fill its size
        // after the parent has grafted the new row.
        let is_directory = path.is_dir();
        if let Some(parent) = path.parent() {
            directories.push(parent.to_string_lossy().into_owned());
        }
        if is_directory {
            directories.push(path.to_string_lossy().into_owned());
        }
    }
    directories
}

fn collapse_changed_directories(mut directories: Vec<String>) -> Vec<String> {
    directories.sort_by_key(|path| path.len());
    let mut collapsed = Vec::<String>::new();
    let mut normalized = HashSet::<String>::new();
    for directory in directories {
        let candidate = directory.trim_end_matches(['\\', '/']).to_ascii_lowercase();
        if candidate.is_empty() || !normalized.insert(candidate) {
            continue;
        }
        collapsed.push(directory);
    }
    collapsed
}

fn forward_watch_batches(
    wake_rx: std::sync::mpsc::Receiver<()>,
    pending: Arc<Mutex<HashSet<String>>>,
    on_change: Channel<Vec<String>>,
) {
    while wake_rx.recv().is_ok() {
        let started = Instant::now();
        loop {
            let remaining = WATCH_MAX_WINDOW.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                break;
            }
            match wake_rx.recv_timeout(WATCH_IDLE_WINDOW.min(remaining)) {
                Ok(()) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let directories = pending
            .lock()
            .map(|mut values| values.drain().collect::<Vec<_>>())
            .unwrap_or_default();
        let directories = collapse_changed_directories(directories);
        if !directories.is_empty() && on_change.send(directories).is_err() {
            break;
        }
    }
}

#[tauri::command]
fn fs_watch_stop(registry: State<'_, FsWatchRegistry>, watch_id: u64) -> Result<(), String> {
    let entry = registry
        .watchers
        .lock()
        .map_err(|_| "Folder watcher registry is unavailable".to_string())?
        .remove(&watch_id);
    if let Some(mut entry) = entry {
        // Dropping the watcher drops its wake sender, allowing the batch worker
        // to exit cleanly instead of accumulating detached threads as tabs move.
        drop(entry.watcher);
        if let Some(worker) = entry.worker.take() {
            let _ = worker.join();
        }
    }
    Ok(())
}

const DIRECTORY_SNAPSHOT_LIMIT: usize = 50_000;
/// Subdirectories returned for one folder-picker expansion. Well past any real
/// folder while keeping a pathological directory from flooding the renderer.
const DIRECTORY_BROWSE_LIMIT: usize = 5_000;

#[derive(Default)]
struct DirectoryAggregate {
    size: u64,
    allocated: u64,
    files: u64,
    folders: u64,
    errors: u64,
    modified: u64,
}

#[cfg(windows)]
fn metadata_attributes(metadata: &fs::Metadata) -> u32 {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes()
}

#[cfg(not(windows))]
fn metadata_attributes(_metadata: &fs::Metadata) -> u32 {
    0
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata_attributes(metadata) & 0x400 != 0
}

fn time_ms(value: Result<SystemTime, std::io::Error>) -> u64 {
    value
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

// Recursively summarize one newly-created/moved branch without retaining its
// complete node tree. Memory is bounded by the directory traversal frontier,
// and existing branches continue to use the cheap one-level snapshot.
fn summarize_directory(path: &Path) -> DirectoryAggregate {
    let mut aggregate = DirectoryAggregate::default();
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                aggregate.errors = aggregate.errors.saturating_add(1);
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    aggregate.errors = aggregate.errors.saturating_add(1);
                    continue;
                }
            };
            let entry_path = entry.path();
            let link_metadata = match fs::symlink_metadata(&entry_path) {
                Ok(metadata) => metadata,
                Err(_) => {
                    aggregate.errors = aggregate.errors.saturating_add(1);
                    continue;
                }
            };
            let is_link = link_metadata.file_type().is_symlink();
            let is_reparse = is_reparse_point(&link_metadata);
            let metadata = if is_link {
                fs::metadata(&entry_path).unwrap_or(link_metadata)
            } else {
                link_metadata
            };
            aggregate.modified = aggregate.modified.max(time_ms(metadata.modified()));
            if metadata.is_dir() {
                aggregate.folders = aggregate.folders.saturating_add(1);
                if !is_link && !is_reparse {
                    pending.push(entry_path);
                }
            } else {
                aggregate.files = aggregate.files.saturating_add(1);
                aggregate.size = aggregate.size.saturating_add(metadata.len());
                // The live refresh path does not need an allocation-size system
                // call per file. Logical bytes are a stable bounded fallback.
                aggregate.allocated = aggregate.allocated.saturating_add(metadata.len());
            }
        }
    }
    aggregate
}

fn directory_snapshot_rows(
    path: PathBuf,
    recursive_aggregates: bool,
    cached_children: &HashMap<String, NodePageItem>,
) -> Result<Vec<Value>, String> {
    let entries = fs::read_dir(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let mut children = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= DIRECTORY_SNAPSHOT_LIMIT {
            return Err(format!(
                "Folder has more than {DIRECTORY_SNAPSHOT_LIMIT} immediate entries; refresh it manually"
            ));
        }
        let entry = entry.map_err(|error| format!("Could not read folder entry: {error}"))?;
        let entry_path = entry.path();
        let link_metadata = fs::symlink_metadata(&entry_path)
            .map_err(|error| format!("Could not inspect {}: {error}", entry_path.display()))?;
        let is_link = link_metadata.file_type().is_symlink();
        let metadata = if is_link {
            fs::metadata(&entry_path).unwrap_or(link_metadata)
        } else {
            link_metadata
        };
        let is_dir = metadata.is_dir();
        let name = entry.file_name().to_string_lossy().into_owned();
        let cached = if is_dir && !recursive_aggregates {
            cached_children.get(&name.to_ascii_lowercase())
        } else {
            None
        };
        let aggregate_known = !is_dir || recursive_aggregates || cached.is_some();
        let aggregate = if is_dir && recursive_aggregates {
            summarize_directory(&entry_path)
        } else if let Some(cached) = cached {
            DirectoryAggregate {
                size: cached.size,
                allocated: cached.allocated,
                files: cached.files,
                folders: cached.folders,
                errors: cached.errors,
                modified: cached.modified_ms,
            }
        } else {
            DirectoryAggregate::default()
        };
        let size = if is_dir {
            aggregate.size
        } else {
            metadata.len()
        };
        let allocated = if is_dir {
            aggregate.allocated
        } else {
            metadata.len()
        };
        let attributes = metadata_attributes(&metadata);
        let extension = if is_dir {
            String::new()
        } else {
            entry_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
        };
        children.push(serde_json::json!({
            "id": index + 1,
            "parent": 0,
            "name": name,
            "path": entry_path.to_string_lossy(),
            "dir": is_dir,
            "link": is_link,
            "hidden": attributes & 0x2 != 0,
            "readonly": metadata.permissions().readonly(),
            "size": size,
            "allocated": allocated,
            "files": if is_dir { aggregate.files } else { 1 },
            "folders": if is_dir { aggregate.folders } else { 0 },
            "modified": time_ms(metadata.modified()).max(aggregate.modified),
            "created": time_ms(metadata.created()),
            "accessed": time_ms(metadata.accessed()),
            "depth": 1,
            "errors": if is_dir { aggregate.errors } else { 0 },
            "extension": extension,
            "children": [],
            "owner": "",
            "attributes": attributes,
            "aggregateKnown": aggregate_known
        }));
    }

    let root_metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    let root_attributes = metadata_attributes(&root_metadata);
    let root_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_else(|| path.to_str().unwrap_or(""));
    let child_ids = (1..=children.len()).collect::<Vec<_>>();
    let root = serde_json::json!({
        "id": 0,
        "parent": null,
        "name": root_name,
        "path": path.to_string_lossy(),
        "dir": true,
        "link": false,
        "hidden": root_attributes & 0x2 != 0,
        "readonly": root_metadata.permissions().readonly(),
        "size": 0,
        "allocated": 0,
        "files": 0,
        "folders": 0,
        "modified": time_ms(root_metadata.modified()),
        "created": time_ms(root_metadata.created()),
        "accessed": time_ms(root_metadata.accessed()),
        "depth": 0,
        "errors": 0,
        "extension": "",
        "children": child_ids,
        "owner": "",
        "attributes": root_attributes,
        "aggregateKnown": true
    });
    let mut rows = Vec::with_capacity(children.len() + 1);
    rows.push(root);
    rows.extend(children);
    Ok(rows)
}

#[tauri::command]
async fn directory_snapshot(
    state: State<'_, Arc<V2Store>>,
    path: String,
    recursive_aggregates: Option<bool>,
    scan_id: Option<String>,
    directory_id: Option<i64>,
) -> Result<Vec<Value>, String> {
    require_authorized_path(&state, &path)?;
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let recursive_aggregates = recursive_aggregates.unwrap_or(false);
        let cached_children = if !recursive_aggregates {
            match (scan_id.as_deref(), directory_id) {
                (Some(scan_id), Some(directory_id)) => store
                    .query_snapshot_children(scan_id, directory_id, DIRECTORY_SNAPSHOT_LIMIT)?
                    .into_iter()
                    .filter(|item| item.is_dir)
                    .map(|item| (item.name.to_ascii_lowercase(), item))
                    .collect(),
                _ => HashMap::new(),
            }
        } else {
            HashMap::new()
        };
        directory_snapshot_rows(PathBuf::from(path), recursive_aggregates, &cached_children)
    })
    .await
    .map_err(|error| format!("Folder snapshot worker failed: {error}"))?
}

/// One immediate subdirectory returned by [`browse_directories`].
#[derive(Serialize)]
struct BrowseDirectoryEntry {
    name: String,
    path: String,
    hidden: bool,
}

/// Immediate subdirectories of `path`, name-sorted, for the folder pickers
/// (duplicate scan targets, move/copy destinations).
///
/// Unlike [`directory_snapshot`] this is deliberately NOT limited to scanned
/// roots: a folder picker has to walk down from a drive letter before anything
/// has been scanned. The capability it grants — directory *names* one level
/// deep — is the same one `drives`/`special_folders` already expose without a
/// grant, and it reads no file content, sizes or metadata beyond the hidden
/// attribute. Unreadable entries are skipped rather than failing the listing so
/// system folders (`System Volume Information`, per-user profiles) don't break
/// browsing a drive root.
fn browse_directory_entries(path: &Path) -> Result<Vec<BrowseDirectoryEntry>, String> {
    let entries = fs::read_dir(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        if dirs.len() >= DIRECTORY_BROWSE_LIMIT {
            break;
        }
        let entry_path = entry.path();
        // file_type() answers from the directory entry itself on Windows, so the
        // common case costs no extra stat. Symlinked folders need the follow.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_dir = if file_type.is_symlink() {
            fs::metadata(&entry_path).map(|meta| meta.is_dir()).unwrap_or(false)
        } else {
            file_type.is_dir()
        };
        if !is_dir {
            continue;
        }
        let hidden = fs::symlink_metadata(&entry_path)
            .map(|meta| metadata_attributes(&meta) & 0x2 != 0)
            .unwrap_or(false);
        dirs.push(BrowseDirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry_path.to_string_lossy().into_owned(),
            hidden,
        });
    }
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(dirs)
}

#[tauri::command]
async fn browse_directories(path: String) -> Result<Vec<BrowseDirectoryEntry>, String> {
    if path.trim().is_empty() || path.len() > 32_768 {
        return Err("Invalid folder path".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || browse_directory_entries(Path::new(&path)))
        .await
        .map_err(|error| format!("Folder browse worker failed: {error}"))?
}

/// One dropped path classified by [`stat_dropped_paths`].
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedPathInfo {
    path: String,
    is_dir: bool,
    size: u64,
}

/// Classify paths dropped in from the shell.
///
/// A shell drop arrives as bare paths (Tauri's drag-drop payload carries no
/// metadata), but the UI needs to know folder-vs-file to route each item and
/// needs a size to display files. Paths that no longer exist are dropped from
/// the result rather than failing the batch, since a drag can outlive its
/// source.
#[tauri::command]
async fn stat_dropped_paths(paths: Vec<String>) -> Result<Vec<DroppedPathInfo>, String> {
    if paths.len() > 65_536 {
        return Err("Too many dropped paths".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .filter(|path| !path.trim().is_empty() && path.len() <= 32_768)
            .filter_map(|path| {
                let meta = std::fs::metadata(&path).ok()?;
                let is_dir = meta.is_dir();
                Some(DroppedPathInfo {
                    path,
                    is_dir,
                    size: if is_dir { 0 } else { meta.len() },
                })
            })
            .collect()
    })
    .await
    .map_err(|error| format!("Path stat worker failed: {error}"))
}

#[cfg(test)]
mod desktop_tests {
    use super::{
        CanonicalDuplicateScopeRule, DuplicateActionItem, DuplicateReviewState,
        DuplicateScopeState, ExternalCopyGrants, ExternalTransferKind, browse_directory_entries,
        collapse_changed_directories, directory_snapshot_rows, duplicate_member_snapshot,
        duplicate_scope_state, normalize_icon_extension, normalized_review_path,
        validate_duplicate_plan_and_reserve, watch_directories_for_paths,
    };
    use std::collections::{HashMap, HashSet};
    use std::fs;

    #[test]
    fn external_copy_grants_are_exact_and_one_shot() {
        let root = std::env::temp_dir().join(format!(
            "filetree_desktop_copy_grant_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create grant test folder");
        let granted = root.join("granted.txt");
        let other = root.join("other.txt");
        fs::write(&granted, b"granted").expect("create granted file");
        fs::write(&other, b"other").expect("create other file");
        let granted = granted.to_string_lossy().into_owned();
        let other = other.to_string_lossy().into_owned();
        let grants = ExternalCopyGrants::default();

        let clipboard_token = grants
            .grant_clipboard(std::slice::from_ref(&granted), ExternalTransferKind::Move)
            .expect("clipboard capability");
        let native_path = std::path::PathBuf::from(&granted);
        grants.grant_native_drop(std::slice::from_ref(&native_path));
        let drop_token = grants
            .claim_native_drop(std::slice::from_ref(&granted), ExternalTransferKind::Copy)
            .expect("drop capability");

        // A later OS event must not revoke an operation already waiting in the
        // pausable transfer queue.
        assert!(grants.consume_capability(
            Some(&clipboard_token),
            std::slice::from_ref(&granted),
            ExternalTransferKind::Move,
        ));
        assert!(!grants.consume_capability(
            Some(&clipboard_token),
            std::slice::from_ref(&granted),
            ExternalTransferKind::Move,
        ));
        // Native drops are copy-only; presenting their token to the destructive
        // move command consumes and rejects it.
        assert!(!grants.consume_capability(
            Some(&drop_token),
            std::slice::from_ref(&granted),
            ExternalTransferKind::Move,
        ));
        assert!(!grants.consume_capability(
            Some(&drop_token),
            std::slice::from_ref(&granted),
            ExternalTransferKind::Copy,
        ));
        let wrong_path_token = grants
            .grant_clipboard(std::slice::from_ref(&granted), ExternalTransferKind::Copy)
            .expect("second clipboard capability");
        assert!(!grants.consume_capability(
            Some(&wrong_path_token),
            std::slice::from_ref(&other),
            ExternalTransferKind::Copy,
        ));

        fs::remove_dir_all(root).expect("remove grant test folder");
    }

    #[test]
    fn directory_snapshot_drops_removed_children() {
        let root = std::env::temp_dir().join(format!(
            "filetree_desktop_snapshot_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("destination")).expect("create test folder");
        let first =
            directory_snapshot_rows(root.clone(), false, &HashMap::new()).expect("first snapshot");
        assert!(first.iter().any(|row| row["name"] == "destination"));

        fs::remove_dir(root.join("destination")).expect("remove test folder");
        let second =
            directory_snapshot_rows(root.clone(), false, &HashMap::new()).expect("second snapshot");
        assert!(!second.iter().any(|row| row["name"] == "destination"));
        fs::remove_dir(root).expect("remove test root");
    }

    #[test]
    fn directory_snapshot_can_aggregate_a_new_branch() {
        let root = std::env::temp_dir().join(format!(
            "filetree_desktop_aggregate_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("moved").join("nested")).expect("create nested folder");
        fs::write(root.join("moved").join("clip.bin"), [1_u8, 2, 3, 4]).expect("write direct file");
        fs::write(
            root.join("moved").join("nested").join("image.bin"),
            [5_u8, 6],
        )
        .expect("write nested file");

        let rows = directory_snapshot_rows(root.clone(), true, &HashMap::new())
            .expect("aggregate snapshot");
        let moved = rows
            .iter()
            .find(|row| row["name"] == "moved")
            .expect("moved row");
        assert_eq!(moved["size"], 6);
        assert_eq!(moved["files"], 2);
        assert_eq!(moved["folders"], 1);

        fs::remove_dir_all(root).expect("remove aggregate test root");
    }

    #[test]
    fn browse_directories_lists_only_sorted_subfolders() {
        let root = std::env::temp_dir().join(format!(
            "filetree_desktop_browse_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("zeta")).expect("create zeta folder");
        fs::create_dir_all(root.join("Alpha")).expect("create Alpha folder");
        fs::write(root.join("notes.txt"), b"skip me").expect("write loose file");

        let entries = browse_directory_entries(&root).expect("browse listing");
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["Alpha", "zeta"]);
        assert_eq!(entries[0].path, root.join("Alpha").to_string_lossy());

        fs::remove_dir_all(root).expect("remove browse test root");
    }

    #[test]
    fn watcher_batches_remove_duplicates_but_keep_nested_directories() {
        let collapsed = collapse_changed_directories(vec![
            r"E:\Downloads\Videos\Finished".to_string(),
            r"e:\downloads".to_string(),
            r"E:\Downloads\Videos".to_string(),
            r"E:\Other".to_string(),
            r"E:\Other".to_string(),
        ]);
        assert_eq!(collapsed.len(), 4);
        assert!(
            collapsed
                .iter()
                .any(|path| path.eq_ignore_ascii_case(r"e:\downloads"))
        );
        assert!(
            collapsed
                .iter()
                .any(|path| path.eq_ignore_ascii_case(r"e:\other"))
        );
    }

    #[test]
    fn watcher_reports_new_directory_and_parent() {
        let root = std::env::temp_dir().join(format!(
            "filetree_desktop_watch_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let created = root.join("moved-folder");
        fs::create_dir_all(&created).expect("create watched folder");

        let directories = watch_directories_for_paths(vec![created.clone()]);
        assert!(
            directories
                .iter()
                .any(|path| path == root.to_string_lossy().as_ref())
        );
        assert!(
            directories
                .iter()
                .any(|path| path == created.to_string_lossy().as_ref())
        );

        fs::remove_dir_all(root).expect("remove watcher test root");
    }

    #[test]
    fn shell_icon_extensions_are_normalized_and_bounded() {
        assert_eq!(normalize_icon_extension(".DOCX").unwrap(), "docx");
        assert!(normalize_icon_extension("").is_err());
        assert!(normalize_icon_extension("../exe").is_err());
        assert!(normalize_icon_extension(&"x".repeat(65)).is_err());
    }

    #[test]
    fn duplicate_review_reports_attempted_files_and_honors_cancellation() {
        use super::{prepare_duplicate_review, DuplicateScanResult};
        use std::sync::{Mutex, atomic::AtomicBool};
        use std::time::{SystemTime, UNIX_EPOCH};
        let root = std::env::temp_dir().join(format!("filetree_review_progress_{}_{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let file = root.join("present.bin");
        fs::write(&file, b"test").unwrap();
        let result = DuplicateScanResult {
            groups: vec![filetree_core::v2::DuplicateGroup {
                files: [file.clone(), root.join("missing.bin")].into_iter().map(|path| filetree_core::v2::DuplicateFile {
                    name: path.file_name().unwrap().to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(), size: 4, modified: 0,
                }).collect(), waste: 4,
            }], errors: Vec::new(), scanned: 2, hashing: 0, cancelled: false,
        };
        let mut review = DuplicateReviewState { authorized_roots: vec![fs::canonicalize(&root).unwrap()], ..Default::default() };
        let updates = Mutex::new(Vec::new());
        prepare_duplicate_review(&result, &mut review, &AtomicBool::new(false), |event| updates.lock().unwrap().push(event));
        let updates = updates.into_inner().unwrap();
        assert_eq!(updates.first().unwrap().fraction, Some(0.0));
        assert_eq!(updates.last().unwrap().fraction, Some(1.0));
        assert_eq!(updates.last().unwrap().hashed, 2);
        assert!(updates.iter().all(|event| event.phase == "reviewing" && event.bytes_read == 0));
        assert_eq!(review.members.len(), 2);
        assert!(review.members.values().all(|member| member.identity.is_none()));
        let mut canceled = DuplicateReviewState::default();
        prepare_duplicate_review(&result, &mut canceled, &AtomicBool::new(true), |event| assert_eq!(event.hashed, 0));
        assert!(canceled.members.is_empty());
        fs::remove_file(file).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn duplicate_review_registers_large_index_without_disk_access() {
        use super::{prepare_duplicate_review, DuplicateScanResult};
        use std::sync::atomic::AtomicBool;
        let root = std::env::temp_dir().join("filetree_nonexistent_index_fixture");
        let result = DuplicateScanResult {
            groups: vec![filetree_core::v2::DuplicateGroup {
                files: (0..100_000).map(|index| filetree_core::v2::DuplicateFile {
                    name: format!("{index}.bin"),
                    path: root.join(format!("{index}.bin")).to_string_lossy().into_owned(),
                    size: 4096, modified: 0,
                }).collect(), waste: 0,
            }], errors: Vec::new(), scanned: 100_000, hashing: 0, cancelled: false,
        };
        let mut review = DuplicateReviewState::default();
        let started = std::time::Instant::now();
        prepare_duplicate_review(&result, &mut review, &AtomicBool::new(false), |_| {});
        eprintln!("Registered 100,000 indexed matches in {:?}", started.elapsed());
        assert_eq!(review.members.len(), 100_000);
        assert!(review.members.values().all(|member| member.identity.is_none()));
    }

    #[test]
    fn duplicate_review_deferred_identity_rejects_changed_files() {
        let root = std::env::temp_dir().join(format!("filetree_deferred_review_{}_{}",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let first = root.join("first.bin");
        let keeper = root.join("keeper.bin");
        fs::write(&first, b"same").unwrap();
        fs::write(&keeper, b"same").unwrap();
        let mut members = HashMap::new();
        for path in [&first, &keeper] {
            let mut indexed = duplicate_member_snapshot(path, 0).unwrap();
            indexed.identity = None;
            indexed.modified_ns = indexed.modified_ns / 1_000_000_000 * 1_000_000_000;
            members.insert(normalized_review_path(&path.to_string_lossy()).unwrap(), indexed);
        }
        let active = members.keys().cloned().collect();
        let review = DuplicateReviewState {
            token: Some("indexed".into()), members,
            active_by_group: HashMap::from([(0, active)]),
            authorized_roots: vec![fs::canonicalize(&root).unwrap()],
            ..Default::default()
        };
        let items = vec![DuplicateActionItem {
            path: first.to_string_lossy().into_owned(), keeper: keeper.to_string_lossy().into_owned(),
        }];
        let plan = validate_duplicate_plan_and_reserve(&review, "indexed", &items).unwrap();
        assert_eq!(plan[0].canonical_path, fs::canonicalize(&first).unwrap().to_string_lossy());
        let missing = root.join("missing.bin").to_string_lossy().into_owned();
        let mixed = vec![
            DuplicateActionItem { path: missing, keeper: keeper.to_string_lossy().into_owned() },
            DuplicateActionItem { path: first.to_string_lossy().into_owned(), keeper: keeper.to_string_lossy().into_owned() },
        ];
        let (accepted, errors) = super::prepare_duplicate_action_batch(&review, "indexed", &mixed).unwrap();
        assert_eq!(accepted.len(), 1);
        assert_eq!(errors.len(), 1);
        assert!(first.exists());
        let both_selected = vec![
            DuplicateActionItem { path: first.to_string_lossy().into_owned(), keeper: keeper.to_string_lossy().into_owned() },
            DuplicateActionItem { path: keeper.to_string_lossy().into_owned(), keeper: first.to_string_lossy().into_owned() },
        ];
        assert!(super::prepare_duplicate_action_batch(&review, "indexed", &both_selected).is_err());
        fs::write(&first, b"changed size").unwrap();
        assert!(validate_duplicate_plan_and_reserve(&review, "indexed", &items).err().unwrap().contains("identity changed"));
        fs::remove_file(&first).unwrap();
        fs::remove_file(&keeper).unwrap();
        fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn duplicate_review_tokens_enforce_membership_protection_and_survival() {
        let root = std::env::temp_dir().join(format!(
            "filetree_desktop_duplicate_review_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let protected = root.join("protected");
        fs::create_dir_all(&protected).expect("create protected test folder");
        let keeper = root.join("keeper.bin");
        let duplicate = protected.join("duplicate.bin");
        fs::write(&keeper, b"same").expect("write keeper");
        fs::write(&duplicate, b"same").expect("write duplicate");

        let keeper_text = keeper.to_string_lossy().into_owned();
        let duplicate_text = duplicate.to_string_lossy().into_owned();
        let keeper_key = normalized_review_path(&keeper_text).expect("keeper key");
        let duplicate_key = normalized_review_path(&duplicate_text).expect("duplicate key");
        let members = HashMap::from([
            (
                keeper_key.clone(),
                duplicate_member_snapshot(&keeper, 7).expect("keeper snapshot"),
            ),
            (
                duplicate_key.clone(),
                duplicate_member_snapshot(&duplicate, 7).expect("duplicate snapshot"),
            ),
        ]);
        let mut review = DuplicateReviewState {
            token: Some("review-token".to_string()),
            members,
            active_by_group: HashMap::from([(
                7,
                HashSet::from([keeper_key.clone(), duplicate_key.clone()]),
            )]),
            authorized_roots: vec![fs::canonicalize(&root).expect("canonical root")],
            scope_rules: vec![CanonicalDuplicateScopeRule {
                path: fs::canonicalize(&protected).expect("canonical protected root"),
                state: DuplicateScopeState::Reference,
            }],
            ..DuplicateReviewState::default()
        };
        let plan = [DuplicateActionItem {
            path: duplicate_text,
            keeper: keeper_text,
        }];

        assert!(validate_duplicate_plan_and_reserve(&review, "stale-token", &plan).is_err());
        assert!(validate_duplicate_plan_and_reserve(&review, "review-token", &plan).is_err());

        review.scope_rules.clear();
        assert_eq!(
            validate_duplicate_plan_and_reserve(&review, "review-token", &plan)
                .expect("valid plan")
                .len(),
            1
        );
        review.in_flight.insert(keeper_key);
        assert!(validate_duplicate_plan_and_reserve(&review, "review-token", &plan).is_err());

        fs::remove_dir_all(root).expect("remove duplicate review test root");
    }

    #[test]
    fn duplicate_scope_uses_the_deepest_folder_rule() {
        let root = std::env::temp_dir().join(format!(
            "filetree_desktop_duplicate_scope_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let child = root.join("scratch");
        fs::create_dir_all(&child).expect("create scope folders");
        let canonical_root = fs::canonicalize(&root).expect("canonical root");
        let canonical_child = fs::canonicalize(&child).expect("canonical child");
        let rules = vec![
            CanonicalDuplicateScopeRule {
                path: canonical_root.clone(),
                state: DuplicateScopeState::Reference,
            },
            CanonicalDuplicateScopeRule {
                path: canonical_child.clone(),
                state: DuplicateScopeState::Normal,
            },
        ];

        assert_eq!(
            duplicate_scope_state(&canonical_root.join("master.bin"), &rules),
            Some(DuplicateScopeState::Reference)
        );
        assert_eq!(
            duplicate_scope_state(&canonical_child.join("draft.bin"), &rules),
            Some(DuplicateScopeState::Normal)
        );
        fs::remove_dir_all(root).expect("remove duplicate scope test root");
    }
}

#[tauri::command]
async fn scan_start(
    state: State<'_, Arc<V2Store>>,
    request: ScanRequest,
    on_progress: Channel<ScanProgress>,
) -> Result<ScanHandle, String> {
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || store.start_scan(request, move |event| {
        let _ = on_progress.send(event);
    })).await.map_err(|error| format!("Scan startup worker failed: {error}"))?
}

#[tauri::command]
fn scan_cancel(state: State<'_, Arc<V2Store>>, scan_id: String) -> bool {
    state.cancel_scan(&scan_id)
}

#[tauri::command]
async fn scan_status(app: AppHandle, scan_id: String) -> Option<ScanHandle> {
    let store = Arc::clone(&*app.state::<Arc<V2Store>>());
    tauri::async_runtime::spawn_blocking(move || store.scan_status(&scan_id)).await.unwrap_or(None)
}

#[tauri::command]
async fn scan_find(app: tauri::AppHandle, root_path: String) -> Option<ScanHandle> {
    // Looking up a cached scan reads the volume's change journal and replays it
    // into SQLite. That is blocking work on a raw device handle, so it must not
    // sit on the command thread every time a tab opens. Taking the store from an
    // owned `AppHandle` rather than `State<'_, _>` keeps this returning a plain
    // `Option`: an async command with a borrowed input is forced to return a
    // `Result`, and a rejected promise here would read as a scan failure instead
    // of a cache miss.
    let store = Arc::clone(&*app.state::<Arc<V2Store>>());
    tauri::async_runtime::spawn_blocking(move || store.find_completed_scan(&root_path))
        .await
        .unwrap_or(None)
}

#[tauri::command]
async fn scan_page(state: State<'_, Arc<V2Store>>, query: ScanQuery) -> Result<NodePage, String> {
    // Search/sort over a multi-million-row scan is blocking SQLite work. Keep it
    // off Tauri's command/event thread so typing, painting and cancellation stay
    // responsive while the bounded page is produced.
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || store.query_nodes(query))
        .await
        .map_err(|error| format!("Scan query worker failed: {error}"))?
}

#[tauri::command]
async fn scan_subtree_files(
    state: State<'_, Arc<V2Store>>,
    query: SubtreeFilesQuery,
) -> Result<SubtreeFilePage, String> {
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || store.query_subtree_files(query))
        .await
        .map_err(|error| format!("Subtree file query worker failed: {error}"))?
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressionCandidateStats {
    scanned: usize,
    eligible: usize,
    skipped_unavailable: usize,
    skipped_no_gain: usize,
    skipped_too_small: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompressionCandidateBatch {
    items: Vec<SubtreeFileItem>,
    progress: CompressionCandidateStats,
}

#[tauri::command]
async fn scan_compression_candidates_stream(
    state: State<'_, Arc<V2Store>>,
    scan_id: String,
    directory_id: i64,
    allow_video: bool,
    allow_image: bool,
    min_size_bytes: u64,
    on_batch: Channel<CompressionCandidateBatch>,
) -> Result<CompressionCandidateStats, String> {
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut stats = CompressionCandidateStats::default();
        let mut pending = Vec::with_capacity(500);
        let mut last_sent_scanned = 0usize;
        store
            .stream_subtree_files(&scan_id, directory_id, 500, |batch| {
                stats.scanned += batch.len();
                for item in batch {
                    match compression_eligibility(
                        &item.path,
                        item.size,
                        allow_video,
                        allow_image,
                        min_size_bytes,
                    ) {
                        CompressionEligibility::Eligible => {
                            stats.eligible += 1;
                            pending.push(item);
                        }
                        CompressionEligibility::EncoderUnavailable => {
                            stats.skipped_unavailable += 1;
                        }
                        CompressionEligibility::KnownNoGain => stats.skipped_no_gain += 1,
                        CompressionEligibility::TooSmall => stats.skipped_too_small += 1,
                    }
                }
                let first_progress = last_sent_scanned == 0 && stats.scanned > 0;
                let items = if pending.len() >= 500 {
                    let remainder = pending.split_off(500);
                    Some(std::mem::replace(&mut pending, remainder))
                } else if first_progress || stats.scanned.saturating_sub(last_sent_scanned) >= 5_000
                {
                    Some(std::mem::take(&mut pending))
                } else {
                    None
                };
                if let Some(items) = items {
                    last_sent_scanned = stats.scanned;
                    on_batch
                        .send(CompressionCandidateBatch {
                            items,
                            progress: stats.clone(),
                        })
                        .map_err(|error| error.to_string())?;
                    pending.reserve(500);
                }
                Ok(())
            })
            .and_then(|_| {
                if !pending.is_empty() || stats.scanned != last_sent_scanned {
                    on_batch
                        .send(CompressionCandidateBatch {
                            items: pending,
                            progress: stats.clone(),
                        })
                        .map_err(|error| error.to_string())?;
                }
                Ok(stats)
            })
    })
    .await
    .map_err(|error| format!("Compression candidate stream worker failed: {error}"))?
}

#[tauri::command]
async fn scan_folder_preview(
    state: State<'_, Arc<V2Store>>,
    scan_id: String,
    directory_id: i64,
) -> Result<Option<filetree_core::v2::SubtreeFileItem>, String> {
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        store.query_largest_subtree_file(&scan_id, directory_id)
    })
    .await
    .map_err(|error| format!("Folder preview query worker failed: {error}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDuplicateScanResult {
    #[serde(flatten)]
    result: DuplicateScanResult,
    review_token: String,
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|error| format!("{path}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{path}: expected an existing folder"));
    }
    Ok(canonical)
}

fn normalized_canonical_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn duplicate_metadata_identity(
    file: &fs::File,
    path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(u64, u64), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|error| format!("{}: could not read file identity: {error}", path.display()))?;
    Ok((
        info.dwVolumeSerialNumber as u64,
        ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    ))
}

#[cfg(unix)]
fn duplicate_metadata_identity(
    _file: &fs::File,
    _path: &Path,
    metadata: &fs::Metadata,
) -> Result<(u64, u64), String> {
    use std::os::unix::fs::MetadataExt;

    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(windows, unix)))]
fn duplicate_metadata_identity(
    _file: &fs::File,
    _path: &Path,
    metadata: &fs::Metadata,
) -> Result<(u64, u64), String> {
    Ok((metadata.len(), 0))
}

fn duplicate_member_snapshot(
    path: &Path,
    group_id: u64,
) -> Result<DuplicateMemberSnapshot, String> {
    let path_metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if path_metadata.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "{}: reparse points are not actionable",
                path.display()
            ));
        }
    }
    if !path_metadata.is_file() || path_metadata.file_type().is_symlink() {
        return Err(format!("{}: expected a regular file", path.display()));
    }
    let file = fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    Ok(DuplicateMemberSnapshot {
        group_id,
        size: metadata.len(),
        modified_ns,
        identity: Some(DuplicateFileIdentity {
            identity_key: normalized_canonical_path(&canonical),
            canonical_path: canonical,
            file_identity: duplicate_metadata_identity(&file, path, &metadata)?,
        }),
    })
}

// Register scan membership from the index without filesystem I/O. Identity and
// scope validation remain mandatory when an action plan selects files and keepers.
fn prepare_duplicate_review(
    result: &DuplicateScanResult,
    review: &mut DuplicateReviewState,
    cancel: &AtomicBool,
    on_progress: impl Fn(DuplicateProgress),
) {
    let total = result.groups.iter().map(|group| group.files.len() as u64).sum::<u64>();
    let report = |completed: u64| {
        on_progress(DuplicateProgress {
            phase: "reviewing".into(), scanned: result.scanned,
            hashing: total, hashed: completed, bytes_read: 0,
            fraction: Some(if total == 0 { 1.0 } else { completed as f64 / total as f64 }),
        });
    };
    report(0);
    let mut completed = 0u64;
    let mut last_report = Instant::now();
    'groups: for (group_index, group) in result.groups.iter().enumerate() {
        let group_id = group_index as u64;
        for file in &group.files {
            if cancel.load(Ordering::Relaxed) { break 'groups; }
            // Register the index result without opening or stat-ing any file.
            // Selected files and keepers are resolved and checked at action time.
            if let Ok(path_key) = normalized_review_path(&file.path) {
                let snapshot = DuplicateMemberSnapshot {
                    group_id, size: file.size,
                    modified_ns: file.modified as u128 * 1_000_000_000,
                    identity: None,
                };
                review.active_by_group.entry(group_id).or_default().insert(path_key.clone());
                review.members.insert(path_key, snapshot);
            }
            completed += 1;
            if completed == total || last_report.elapsed() >= Duration::from_millis(100) {
                report(completed);
                last_report = Instant::now();
            }
        }
    }
}

#[tauri::command]
async fn duplicates_scan(
    state: State<'_, Arc<V2Store>>,
    registry: State<'_, DuplicateScanRegistry>,
    request_id: String,
    mut request: DuplicateScanRequest,
    scope_rules: Vec<DuplicateScopeRule>,
    on_progress: Channel<DuplicateProgress>,
) -> Result<DesktopDuplicateScanResult, String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("Invalid duplicate scan request id".to_string());
    }
    if scope_rules.len() > 1_000 || scope_rules.iter().any(|rule| rule.path.len() > 32_768) {
        return Err("Duplicate folder-state policy exceeds desktop limits".to_string());
    }
    request.excluded_paths = scope_rules
        .iter()
        .filter(|rule| rule.state == DuplicateScopeState::Excluded)
        .map(|rule| rule.path.clone())
        .collect();
    request.path_rules = scope_rules
        .iter()
        .map(|rule| DuplicatePathRule {
            path: rule.path.clone(),
            excluded: rule.state == DuplicateScopeState::Excluded,
        })
        .collect();
    let mut authorized_roots = request
        .sources
        .iter()
        .map(|source| canonical_directory(&source.target_path))
        .collect::<Result<Vec<_>, _>>()?;
    authorized_roots.sort_by_key(|path| normalized_canonical_path(path));
    authorized_roots.dedup_by(|left, right| {
        normalized_canonical_path(left) == normalized_canonical_path(right)
    });

    let mut canonical_scope_rules = scope_rules
        .into_iter()
        .map(|rule| {
            Ok(CanonicalDuplicateScopeRule {
                path: canonical_directory(&rule.path)?,
                state: rule.state,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if canonical_scope_rules.iter().any(|rule| {
        !authorized_roots.iter().any(|root| {
            review_path_is_within(&rule.path, root) || review_path_is_within(root, &rule.path)
        })
    }) {
        return Err("Folder states must apply to selected scan targets".to_string());
    }
    canonical_scope_rules.sort_by_key(|rule| normalized_canonical_path(&rule.path));
    let mut seen_scope_paths = HashSet::new();
    if canonical_scope_rules
        .iter()
        .any(|rule| !seen_scope_paths.insert(normalized_canonical_path(&rule.path)))
    {
        return Err("A duplicate folder can have only one state".to_string());
    }
    if authorized_roots.iter().any(|root| {
        !canonical_scope_rules.iter().any(|rule| {
            rule.state != DuplicateScopeState::Excluded
                && (review_path_is_within(root, &rule.path)
                    || review_path_is_within(&rule.path, root))
        })
    }) {
        return Err("Every scan target needs a Normal or Reference folder state".to_string());
    }

    {
        let mut review = registry
            .review
            .lock()
            .map_err(|_| "Duplicate review state is unavailable".to_string())?;
        if !review.in_flight.is_empty() {
            return Err("Wait for the current duplicate action to finish".to_string());
        }
        *review = DuplicateReviewState::default();
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = registry
            .cancel
            .lock()
            .map_err(|_| "Duplicate scan registry is unavailable".to_string())?;
        if let Some(previous) = active.replace(DuplicateScanCancellation {
            request_id: request_id.clone(),
            flag: Arc::clone(&cancel),
        }) {
            previous.flag.store(true, Ordering::Relaxed);
        }
    }
    let store = Arc::clone(state.inner());
    let worker_cancel = Arc::clone(&cancel);
    let scan_progress = on_progress.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        store.find_exact_duplicates(request, worker_cancel, move |event| {
            // Discovery completion is followed by desktop review preparation.
            if event.phase != "done" { let _ = scan_progress.send(event); }
        })
    })
    .await
    .map_err(|error| format!("Duplicate scan worker failed: {error}"))?;
    let mut result = outcome?;
    if result.cancelled {
        if let Ok(mut active) = registry.cancel.lock()
            && active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(&current.flag, &cancel))
        {
            active.take();
        }
        return Ok(DesktopDuplicateScanResult {
            result,
            review_token: String::new(),
        });
    }

    let sequence = registry.next_review_id.fetch_add(1, Ordering::Relaxed) + 1;
    let issued = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let review_token = format!("{:x}-{issued:x}-{sequence:x}", std::process::id());
    let mut review = DuplicateReviewState {
        token: Some(review_token.clone()),
        authorized_roots,
        scope_rules: canonical_scope_rules,
        ..DuplicateReviewState::default()
    };
    let review_cancel = Arc::clone(&cancel);
    let (result_after_review, prepared_review) = tauri::async_runtime::spawn_blocking(move || {
        prepare_duplicate_review(&result, &mut review, &review_cancel, |event| {
            let _ = on_progress.send(event);
        });
        (result, review)
    }).await.map_err(|error| format!("Duplicate review worker failed: {error}"))?;
    result = result_after_review;
    let review = prepared_review;
    let mut active = registry
        .cancel
        .lock()
        .map_err(|_| "Duplicate scan registry is unavailable".to_string())?;
    if cancel.load(Ordering::Relaxed)
        || !active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current.flag, &cancel))
    {
        result.groups.clear();
        result.cancelled = true;
        return Ok(DesktopDuplicateScanResult {
            result,
            review_token: String::new(),
        });
    }
    *registry
        .review
        .lock()
        .map_err(|_| "Duplicate review state is unavailable".to_string())? = review;
    active.take();
    Ok(DesktopDuplicateScanResult {
        result,
        review_token,
    })
}

#[tauri::command]
fn duplicates_cancel(registry: State<'_, DuplicateScanRegistry>, request_id: String) -> bool {
    let Ok(active) = registry.cancel.lock() else {
        return false;
    };
    let Some(active) = active.as_ref() else {
        return false;
    };
    if active.request_id != request_id {
        return false;
    }
    active.flag.store(true, Ordering::Relaxed);
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateActionResponse {
    ok: bool,
    errors: Vec<String>,
    succeeded: Vec<String>,
    missing: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateLinkPair {
    original: String,
    link: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateActionItem {
    path: String,
    keeper: String,
}

struct DuplicatePlanReservation {
    path_key: String,
    group_id: u64,
    requested_path: String,
    canonical_path: String,
    canonical_keeper: String,
}

fn normalized_review_path(path: &str) -> Result<String, String> {
    let path_value = Path::new(path);
    if !path_value.is_absolute()
        || path_value
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(format!("{path}: expected an absolute normalized path"));
    }
    Ok(path
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase())
}

fn review_path_is_within(candidate: &Path, root: &Path) -> bool {
    let candidate = normalized_canonical_path(candidate);
    let root = normalized_canonical_path(root);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn duplicate_scope_state(
    path: &Path,
    rules: &[CanonicalDuplicateScopeRule],
) -> Option<DuplicateScopeState> {
    rules
        .iter()
        .filter(|rule| review_path_is_within(path, &rule.path))
        .max_by_key(|rule| normalized_canonical_path(&rule.path).len())
        .map(|rule| rule.state)
}

fn canonical_location_without_following_entry(path: &str) -> Result<PathBuf, String> {
    let normalized = normalized_review_path(path)?;
    let value = Path::new(path);
    let parent = value
        .parent()
        .ok_or_else(|| format!("{normalized}: path has no parent folder"))?;
    let name = value
        .file_name()
        .ok_or_else(|| format!("{normalized}: path has no file name"))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    Ok(canonical_parent.join(name))
}

fn validate_duplicate_plan_and_reserve(
    review: &DuplicateReviewState,
    review_token: &str,
    items: &[DuplicateActionItem],
) -> Result<Vec<DuplicatePlanReservation>, String> {
    if review.token.as_deref() != Some(review_token) || review_token.is_empty() {
        return Err(
            "Duplicate results are stale; run a new scan before changing files".to_string(),
        );
    }
    let selected = items
        .iter()
        .map(|item| normalized_review_path(&item.path))
        .collect::<Result<HashSet<_>, _>>()?;
    if selected.len() != items.len() {
        return Err("Duplicate action plan contains the same file more than once".to_string());
    }
    let mut selected_by_group = HashMap::<u64, usize>::new();
    let mut reservations = Vec::with_capacity(items.len());
    for item in items {
        let path = normalized_review_path(&item.path)?;
        let keeper = normalized_review_path(&item.keeper)?;
        if path == keeper || selected.contains(&keeper) {
            return Err("Every duplicate group must retain an unselected keeper".to_string());
        }
        if review.in_flight.contains(&path) || review.in_flight.contains(&keeper) {
            return Err("Another duplicate action is already using one of these files".to_string());
        }
        let Some(path_member) = review.members.get(&path) else {
            return Err(format!(
                "{}: file and keeper are not in the current verified duplicate scan",
                item.path
            ));
        };
        let Some(keeper_member) = review.members.get(&keeper) else {
            return Err(format!(
                "{}: file and keeper are not in the current verified duplicate scan",
                item.path
            ));
        };
        if path_member.group_id != keeper_member.group_id {
            return Err(format!(
                "{}: file and keeper are not in the same verified duplicate group",
                item.path
            ));
        }
        let Some(active) = review.active_by_group.get(&path_member.group_id) else {
            return Err(format!(
                "{}: duplicate group is no longer active",
                item.path
            ));
        };
        if !active.contains(&path) || !active.contains(&keeper) {
            return Err(format!(
                "{}: duplicate result was already changed; run a new scan",
                item.path
            ));
        }
        let current_path = duplicate_member_snapshot(Path::new(&item.path), path_member.group_id)?;
        if !path_member.matches_current(&current_path)
        {
            return Err(format!(
                "{}: file identity changed since the duplicate scan",
                item.path
            ));
        }
        let canonical = &current_path.identity.as_ref().expect("resolved action identity").canonical_path;
        if !review
            .authorized_roots
            .iter()
            .any(|root| review_path_is_within(&canonical, root))
        {
            return Err(format!(
                "{}: file resolves outside the authorized scan locations",
                item.path
            ));
        }
        let current_keeper =
            duplicate_member_snapshot(Path::new(&item.keeper), keeper_member.group_id)?;
        if !keeper_member.matches_current(&current_keeper)
        {
            return Err(format!(
                "{}: keeper identity changed since the duplicate scan",
                item.keeper
            ));
        }
        let canonical_keeper = &current_keeper.identity.as_ref().expect("resolved keeper identity").canonical_path;
        if !review
            .authorized_roots
            .iter()
            .any(|root| review_path_is_within(&canonical_keeper, root))
        {
            return Err(format!(
                "{}: keeper resolves outside the authorized scan locations",
                item.keeper
            ));
        }
        let protected_location = canonical_location_without_following_entry(&item.path)?;
        if matches!(
            duplicate_scope_state(&protected_location, &review.scope_rules),
            Some(DuplicateScopeState::Reference | DuplicateScopeState::Excluded)
        ) {
            return Err(format!(
                "{}: file is inside a non-actionable duplicate location",
                item.path
            ));
        }
        *selected_by_group.entry(path_member.group_id).or_default() += 1;
        reservations.push(DuplicatePlanReservation {
            path_key: path,
            group_id: path_member.group_id,
            requested_path: item.path.clone(),
            canonical_path: canonical.to_string_lossy().into_owned(),
            canonical_keeper: canonical_keeper.to_string_lossy().into_owned(),
        });
    }
    for (group_id, selected_count) in selected_by_group {
        let active_count = review
            .active_by_group
            .get(&group_id)
            .map_or(0, HashSet::len);
        if selected_count >= active_count {
            return Err("Every verified duplicate group must retain at least one file".to_string());
        }
    }
    Ok(reservations)
}

// Preserve selection-wide keeper rules, but let a missing/stale file fail on its
// own instead of preventing unrelated valid files in this batch from running.
fn prepare_duplicate_action_batch(
    review: &DuplicateReviewState,
    token: &str,
    items: &[DuplicateActionItem],
) -> Result<(Vec<DuplicatePlanReservation>, Vec<String>), String> {
    let selected = items.iter().map(|item| normalized_review_path(&item.path))
        .collect::<Result<HashSet<_>, _>>()?;
    if selected.len() != items.len() {
        return Err("Duplicate action plan contains the same file more than once".into());
    }
    for item in items {
        if selected.contains(&normalized_review_path(&item.keeper)?) {
            return Err("Every duplicate group must retain an unselected keeper".into());
        }
    }
    let mut reservations = Vec::new();
    let mut errors = Vec::new();
    for item in items {
        match validate_duplicate_plan_and_reserve(review, token, std::slice::from_ref(item)) {
            Ok(accepted) => reservations.extend(accepted),
            Err(error) => errors.push(error),
        }
    }
    Ok((reservations, errors))
}

fn validate_duplicate_destination(
    review: &DuplicateReviewState,
    destination: &str,
) -> Result<PathBuf, String> {
    let canonical = canonical_directory(destination)?;
    if !review
        .authorized_roots
        .iter()
        .any(|root| review_path_is_within(&canonical, root))
    {
        return Err(
            "Destination must be inside one of the folders authorized by this scan".to_string(),
        );
    }
    Ok(canonical)
}

#[tauri::command]
async fn duplicates_action(
    registry: State<'_, DuplicateScanRegistry>,
    review_token: String,
    action: String,
    mut items: Vec<DuplicateActionItem>,
    permanent: Option<bool>,
    destination: Option<String>,
) -> Result<DuplicateActionResponse, String> {
    if items.is_empty() || items.len() > 1_000 {
        return Err("Select between 1 and 1,000 duplicate files".to_string());
    }
    if !matches!(action.as_str(), "delete" | "move" | "copy") {
        return Err("Unknown duplicate file action".to_string());
    }
    let destination = destination.unwrap_or_default();
    let mut missing = Vec::new();
    let (reservations, locked_paths, destination_for_worker, preflight_errors) = {
        let mut review = registry
            .review
            .lock()
            .map_err(|_| "Duplicate review state is unavailable".to_string())?;
        // Absence is not a successful deletion. Only retire paths from this
        // active review, and never mistake access/other I/O errors for absence.
        if action == "delete" && review.token.as_deref() == Some(review_token.as_str()) {
            items.retain(|item| {
                let known = normalized_review_path(&item.path).ok()
                    .is_some_and(|key| review.members.contains_key(&key));
                if known && matches!(fs::symlink_metadata(&item.path), Err(error) if error.kind() == std::io::ErrorKind::NotFound) {
                    missing.push(item.path.clone());
                    false
                } else { true }
            });
        }
        // Validation runs before any file changes. Report a normal failed action,
        // rather than an IPC rejection that makes the client retire the review.
        let (reservations, preflight_errors) = match prepare_duplicate_action_batch(&review, &review_token, &items) {
            Ok(prepared) => prepared,
            Err(error) => return Ok(DuplicateActionResponse { ok: false, errors: vec![error], succeeded: Vec::new(), missing }),
        };
        if reservations.is_empty() {
            return Ok(DuplicateActionResponse { ok: preflight_errors.is_empty(), errors: preflight_errors, succeeded: Vec::new(), missing });
        }
        let mut destination_for_worker = destination.clone();
        if matches!(action.as_str(), "move" | "copy") {
            if destination.trim().is_empty() {
                return Err("Choose a destination folder".to_string());
            }
            let canonical_destination = validate_duplicate_destination(&review, &destination)?;
            destination_for_worker = canonical_destination.to_string_lossy().into_owned();
            if action == "move" {
                for item in &items {
                    let parent = Path::new(&item.path)
                        .parent()
                        .ok_or_else(|| format!("{}: path has no parent folder", item.path))?;
                    let canonical_parent = fs::canonicalize(parent)
                        .map_err(|error| format!("{}: {error}", parent.display()))?;
                    if normalized_canonical_path(&canonical_parent)
                        == normalized_canonical_path(&canonical_destination)
                    {
                        return Err(format!(
                            "{}: source is already in the destination folder",
                            item.path
                        ));
                    }
                }
            }
        }
        let locked_paths = items
            .iter()
            .flat_map(|item| [&item.path, &item.keeper])
            .map(|path| normalized_review_path(path))
            .collect::<Result<HashSet<_>, _>>()?;
        review.in_flight.extend(locked_paths.iter().cloned());
        (reservations, locked_paths, destination_for_worker, preflight_errors)
    };
    let action_for_worker = action.clone();
    let worker_items = reservations
        .iter()
        .map(|reservation| {
            (
                reservation.canonical_keeper.clone(),
                reservation.canonical_path.clone(),
                reservation.requested_path.clone(),
            )
        })
        .collect::<Vec<_>>();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let mut errors = preflight_errors;
        let mut succeeded = Vec::new();
        for (keeper, path, requested_path) in worker_items {
            let item_errors = match action_for_worker.as_str() {
                "delete" if !permanent.unwrap_or(false) =>
                    filetree_core::recycle_reviewed_duplicate(keeper, path),
                "delete" => filetree_core::delete_verified_duplicate(
                    keeper,
                    path,
                    permanent.unwrap_or(false),
                ),
                "move" | "copy" => filetree_core::transfer_verified_duplicate(
                    &action_for_worker,
                    keeper,
                    path,
                    destination_for_worker.clone(),
                ),
                _ => unreachable!(),
            };
            if item_errors.is_empty() {
                succeeded.push(requested_path);
            } else {
                errors.extend(item_errors);
            }
        }
        DuplicateActionResponse {
            ok: errors.is_empty(),
            errors,
            succeeded,
            missing,
        }
    })
    .await
    .map_err(|error| format!("Duplicate action worker failed: {error}"));

    let mut review = registry
        .review
        .lock()
        .map_err(|_| "Duplicate review state is unavailable".to_string())?;
    if review.token.as_deref() == Some(review_token.as_str()) {
        for path in &locked_paths {
            review.in_flight.remove(path);
        }
    }
    let response = response?;
    if action != "copy" && review.token.as_deref() == Some(review_token.as_str()) {
        let succeeded = response
            .succeeded
            .iter()
            .filter_map(|path| normalized_review_path(path).ok())
            .collect::<HashSet<_>>();
        for reservation in reservations {
            if succeeded.contains(&reservation.path_key)
                && let Some(active) = review.active_by_group.get_mut(&reservation.group_id)
            {
                active.remove(&reservation.path_key);
            }
        }
    }
    Ok(response)
}

#[tauri::command]
async fn duplicates_link(
    registry: State<'_, DuplicateScanRegistry>,
    review_token: String,
    pairs: Vec<DuplicateLinkPair>,
    mode: String,
    permanent: Option<bool>,
) -> Result<DuplicateActionResponse, String> {
    if pairs.is_empty() || pairs.len() > 1_000 {
        return Err("Select between 1 and 1,000 duplicate files".to_string());
    }
    if !matches!(mode.as_str(), "hardlink" | "symlink") {
        return Err("Unknown duplicate link type".to_string());
    }
    let plan = pairs
        .iter()
        .map(|pair| DuplicateActionItem {
            path: pair.link.clone(),
            keeper: pair.original.clone(),
        })
        .collect::<Vec<_>>();
    let (reservations, locked_paths) = {
        let mut review = registry
            .review
            .lock()
            .map_err(|_| "Duplicate review state is unavailable".to_string())?;
        let reservations = validate_duplicate_plan_and_reserve(&review, &review_token, &plan)?;
        let locked_paths = plan
            .iter()
            .flat_map(|item| [&item.path, &item.keeper])
            .map(|path| normalized_review_path(path))
            .collect::<Result<HashSet<_>, _>>()?;
        review.in_flight.extend(locked_paths.iter().cloned());
        (reservations, locked_paths)
    };
    let worker_pairs = reservations
        .iter()
        .map(|reservation| {
            (
                reservation.canonical_keeper.clone(),
                reservation.canonical_path.clone(),
                reservation.requested_path.clone(),
            )
        })
        .collect::<Vec<_>>();
    let response = tauri::async_runtime::spawn_blocking(move || {
        let mut errors = Vec::new();
        let mut succeeded = Vec::new();
        for (keeper, path, requested_path) in worker_pairs {
            let item_errors = filetree_core::replace_duplicate_paths_with_links(
                vec![(keeper, path)],
                mode == "symlink",
                permanent.unwrap_or(false),
            );
            if item_errors.is_empty() {
                succeeded.push(requested_path);
            } else {
                errors.extend(item_errors);
            }
        }
        DuplicateActionResponse {
            ok: errors.is_empty(),
            errors,
            succeeded,
            missing: Vec::new(),
        }
    })
    .await
    .map_err(|error| format!("Duplicate link worker failed: {error}"));

    let mut review = registry
        .review
        .lock()
        .map_err(|_| "Duplicate review state is unavailable".to_string())?;
    if review.token.as_deref() == Some(review_token.as_str()) {
        for path in &locked_paths {
            review.in_flight.remove(path);
        }
    }
    let response = response?;
    if review.token.as_deref() == Some(review_token.as_str()) {
        let succeeded = response
            .succeeded
            .iter()
            .filter_map(|path| normalized_review_path(path).ok())
            .collect::<HashSet<_>>();
        for reservation in reservations {
            if succeeded.contains(&reservation.path_key)
                && let Some(active) = review.active_by_group.get_mut(&reservation.group_id)
            {
                active.remove(&reservation.path_key);
            }
        }
    }
    Ok(response)
}

#[tauri::command]
fn scan_pin(state: State<'_, Arc<V2Store>>, scan_id: String, pinned: bool) -> Result<(), String> {
    state.set_scan_pinned(&scan_id, pinned)
}

#[tauri::command]
async fn memory_stats(state: State<'_, Arc<V2Store>>) -> Result<MemoryStats, String> {
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || store.memory_stats()).await.map_err(|error| error.to_string())
}

fn json_value(text: String) -> Result<Value, String> {
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

#[tauri::command]
fn app_version() -> Value {
    serde_json::json!({ "version": filetree_core::app_version() })
}

/// Quit the whole app. Closing the window only tears down the webview, so the
/// Exit menu and the renderer's close watchdog both come through here: a wedged
/// teardown can then never leave behind a window the user is unable to close.
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn app_config() -> Result<Value, String> {
    json_value(filetree_core::app_config_json())
}

#[tauri::command]
async fn drives() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| json_value(filetree_core::drives_json())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn special_folders() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| json_value(filetree_core::special_folders_json())).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn volume_info(path: String) -> Result<Value, String> {
    // Querying a volume can stall for seconds on a disconnected network share,
    // and a tab footer polls this on a timer. Keep it off the command thread so
    // an unreachable drive can never freeze the window.
    tauri::async_runtime::spawn_blocking(move || {
        json_value(filetree_core::volume_info_json(&path))
    })
    .await
    .map_err(|error| format!("Volume query worker failed: {error}"))?
}

#[tauri::command]
async fn app_settings_get(state: State<'_, Arc<V2Store>>) -> Result<Value, String> {
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || json_value(store.load_json_setting("app.settings", "{}")?)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn app_settings_set(state: State<'_, Arc<V2Store>>, settings: Value) -> Result<(), String> {
    let text = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    let store = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || store.save_json_setting("app.settings", &text, SETTINGS_JSON_MAX_BYTES)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn bookmarks_get(state: State<'_, Arc<V2Store>>) -> Result<Value, String> {
    json_value(state.load_json_setting("app.bookmarks", "[]")?)
}

#[tauri::command]
fn bookmarks_set(state: State<'_, Arc<V2Store>>, paths: Vec<String>) -> Result<(), String> {
    if paths.len() > 10_000 || paths.iter().any(|path| path.len() > 32_768) {
        return Err("Bookmark collection exceeds the desktop limits".to_string());
    }
    let text = serde_json::to_string(&paths).map_err(|error| error.to_string())?;
    state.save_json_setting("app.bookmarks", &text, BOOKMARKS_JSON_MAX_BYTES)
}

fn require_authorized_path(store: &V2Store, path: &str) -> Result<(), String> {
    if store.source_path_is_authorized(path) {
        Ok(())
    } else {
        Err("Path is outside the scanned directories".to_string())
    }
}

fn require_authorized_paths(store: &V2Store, paths: &[String]) -> Result<(), String> {
    let paths = paths.iter().map(String::as_str).collect::<Vec<_>>();
    if store.source_paths_are_authorized(&paths) {
        Ok(())
    } else {
        Err("One or more paths are outside the scanned directories".to_string())
    }
}

fn require_existing_copy_sources(paths: &[String]) -> Result<(), String> {
    if paths.iter().all(|path| {
        path.len() <= 32_768 && Path::new(path).is_absolute() && fs::symlink_metadata(path).is_ok()
    }) {
        Ok(())
    } else {
        Err("One or more copy sources are missing or invalid".to_string())
    }
}

fn require_native_source_authorization(
    store: &V2Store,
    grants: &ExternalCopyGrants,
    paths: &[String],
    provenance: Option<&str>,
    kind: ExternalTransferKind,
) -> Result<(), String> {
    let external_paths = paths
        .iter()
        .filter(|path| !store.source_path_is_authorized(path))
        .cloned()
        .collect::<Vec<_>>();
    if external_paths.is_empty() {
        // Clipboard reads also mint a token for in-root sources. Discard it so
        // the bounded capability store does not retain completed operations.
        if let Some(provenance) = provenance {
            grants.revoke_capability(provenance);
        }
        return Ok(());
    }
    if grants.consume_capability(provenance, &external_paths, kind) {
        Ok(())
    } else {
        Err(
            "Sources outside scanned directories must come from the current clipboard or file drop"
                .to_string(),
        )
    }
}

#[tauri::command]
fn open_path(state: State<'_, Arc<V2Store>>, path: String) -> Result<(), String> {
    require_authorized_path(&state, &path)?;
    filetree_core::open_system_path(&path)
}

#[tauri::command]
fn reveal_path(state: State<'_, Arc<V2Store>>, path: String) -> Result<(), String> {
    require_authorized_path(&state, &path)?;
    filetree_core::reveal_system_path(&path)
}

#[tauri::command]
async fn move_items(
    state: State<'_, Arc<V2Store>>,
    paths: Vec<String>,
    destination: String,
    conflict: Option<String>,
) -> Result<filetree_core::MoveItemsResult, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 items to move".to_string());
    }
    require_authorized_path(&state, &destination)?;
    require_authorized_paths(&state, &paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        filetree_core::move_items(paths, destination, conflict)
    })
    .await
    .map_err(|error| format!("Move worker failed: {error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeMoveResponse {
    aborted: bool,
    moved: usize,
    skipped: usize,
    failed: usize,
}

#[tauri::command]
async fn native_move_items(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<V2Store>>,
    grants: State<'_, ExternalCopyGrants>,
    paths: Vec<String>,
    destination: String,
    provenance: Option<String>,
) -> Result<NativeMoveResponse, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 items to move".to_string());
    }
    require_authorized_path(&state, &destination)?;
    require_existing_copy_sources(&paths)?;
    require_native_source_authorization(
        &state,
        &grants,
        &paths,
        provenance.as_deref(),
        ExternalTransferKind::Move,
    )?;
    // The shell helper initializes its own COM apartment, just like copying.
    // Do not hold up the window's command dispatch while a drive is busy.
    let owner = window.hwnd().map_err(|error| error.to_string())?;
    let owner_handle = owner.0 as isize;
    let result = tauri::async_runtime::spawn_blocking(move || {
        filetree_core::move_items_with_windows(paths, destination, owner_handle)
    }).await.map_err(|error| format!("Windows move worker failed: {error}"))??;
    Ok(NativeMoveResponse {
        aborted: result.aborted,
        moved: result.moved,
        skipped: result.skipped,
        failed: result.failed,
    })
}

#[tauri::command]
async fn native_copy_items(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<V2Store>>,
    grants: State<'_, ExternalCopyGrants>,
    paths: Vec<String>,
    destination: String,
    provenance: Option<String>,
) -> Result<NativeMoveResponse, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 items to copy".to_string());
    }
    require_authorized_path(&state, &destination)?;
    require_existing_copy_sources(&paths)?;
    require_native_source_authorization(
        &state,
        &grants,
        &paths,
        provenance.as_deref(),
        ExternalTransferKind::Copy,
    )?;
    let owner = window.hwnd().map_err(|error| error.to_string())?;
    let owner_handle = owner.0 as isize;
    let result = tauri::async_runtime::spawn_blocking(move || {
        filetree_core::copy_items_with_windows(paths, destination, owner_handle)
    })
    .await
    .map_err(|error| format!("Windows copy worker failed: {error}"))??;
    Ok(NativeMoveResponse {
        aborted: result.aborted,
        moved: result.moved,
        skipped: result.skipped,
        failed: result.failed,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardFilesResponse {
    paths: Vec<String>,
    prefer_move: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    provenance: Option<String>,
}

#[tauri::command]
async fn clipboard_write_files(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<V2Store>>,
    paths: Vec<String>,
    cut: bool,
) -> Result<bool, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 files or folders".to_string());
    }
    require_authorized_paths(&state, &paths)?;
    let owner = window.hwnd().map_err(|error| error.to_string())?;
    let owner_handle = owner.0 as isize;
    tauri::async_runtime::spawn_blocking(move || {
        filetree_core::write_files_to_clipboard(paths, owner_handle, cut)
    })
    .await
    .map_err(|error| format!("Windows clipboard worker failed: {error}"))?
}

#[tauri::command]
async fn clipboard_read_files(
    window: tauri::WebviewWindow,
    grants: State<'_, ExternalCopyGrants>,
) -> Result<ClipboardFilesResponse, String> {
    let owner = window.hwnd().map_err(|error| error.to_string())?;
    let owner_handle = owner.0 as isize;
    let result = tauri::async_runtime::spawn_blocking(move || {
        filetree_core::read_files_from_clipboard(owner_handle)
    })
    .await
    .map_err(|error| format!("Windows clipboard worker failed: {error}"))??;
    let kind = if result.prefer_move {
        ExternalTransferKind::Move
    } else {
        ExternalTransferKind::Copy
    };
    let provenance = grants.grant_clipboard(&result.paths, kind);
    Ok(ClipboardFilesResponse {
        paths: result.paths,
        prefer_move: result.prefer_move,
        provenance,
    })
}

#[tauri::command]
fn claim_external_paths(
    grants: State<'_, ExternalCopyGrants>,
    paths: Vec<String>,
    mode: Option<String>,
) -> Result<String, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 dropped items".to_string());
    }
    require_existing_copy_sources(&paths)?;
    // Explorer semantics: a drop on the same drive moves, otherwise it copies.
    // The client picks the mode; the grant only covers the paths actually dropped.
    let kind = if mode.as_deref() == Some("move") { ExternalTransferKind::Move } else { ExternalTransferKind::Copy };
    grants
        .claim_native_drop(&paths, kind)
        .ok_or_else(|| "The dropped-file authorization expired; drop the items again".to_string())
}

#[tauri::command]
fn release_external_paths(grants: State<'_, ExternalCopyGrants>, provenance: String) {
    grants.revoke_capability(&provenance);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDragResponse {
    outcome: String,
    client_x: Option<f64>,
    client_y: Option<f64>,
}

#[tauri::command]
fn native_drag(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<V2Store>>,
    paths: Vec<String>,
) -> Result<NativeDragResponse, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 items to drag".to_string());
    }
    require_authorized_paths(&state, &paths)?;
    // This command intentionally remains synchronous: OLE must inherit the UI
    // thread's active mouse capture for SHDoDragDrop to own the gesture.
    let result = filetree_core::start_native_drag(paths)?;
    let position = window.inner_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let inside = result.drop_x >= position.x
        && result.drop_y >= position.y
        && result.drop_x < position.x.saturating_add(size.width as i32)
        && result.drop_y < position.y.saturating_add(size.height as i32);
    let outcome = if result.outcome != "cancel" && inside {
        "internal".to_string()
    } else if result.outcome == "move" {
        "external-move".to_string()
    } else if result.outcome == "copy" {
        "external-copy".to_string()
    } else {
        "cancel".to_string()
    };
    Ok(NativeDragResponse {
        client_x: inside.then_some((result.drop_x - position.x) as f64 / scale),
        client_y: inside.then_some((result.drop_y - position.y) as f64 / scale),
        outcome,
    })
}

#[tauri::command]
async fn shell_context_menu(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<V2Store>>,
    paths: Vec<String>,
    client_x: i32,
    client_y: i32,
    defer_paste: Option<bool>,
) -> Result<Option<String>, String> {
    if paths.is_empty() || paths.len() > 1_000 {
        return Err("Select between 1 and 1,000 files or folders".to_string());
    }
    require_authorized_paths(&state, &paths)?;

    // Browser pointer coordinates are logical client pixels. Explorer's popup
    // API expects physical screen pixels, so translate through Tauri's client
    // origin and current monitor scale factor before entering the modal menu.
    let position = window.inner_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let local_x =
        ((client_x.max(0) as f64 * scale).round() as i32).min(size.width.saturating_sub(1) as i32);
    let local_y =
        ((client_y.max(0) as f64 * scale).round() as i32).min(size.height.saturating_sub(1) as i32);
    let owner = window.hwnd().map_err(|error| error.to_string())?;
    let owner_handle = owner.0 as isize;
    let screen_x = position.x.saturating_add(local_x);
    let screen_y = position.y.saturating_add(local_y);
    tauri::async_runtime::spawn_blocking(move || {
        filetree_core::show_shell_context_menu(
            paths,
            owner_handle,
            screen_x,
            screen_y,
            defer_paste.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| format!("Windows context-menu worker failed: {error}"))?
}

#[tauri::command]
async fn file_icon(extension: String) -> Result<Option<String>, String> {
    let extension = normalize_icon_extension(&extension)?;
    tauri::async_runtime::spawn_blocking(move || filetree_core::shell_icon_data_url(&extension))
        .await
        .map_err(|error| format!("Shell icon worker failed: {error}"))
}

const FILE_ICON_BATCH_MAX: usize = 128;

fn normalize_icon_extension(extension: &str) -> Result<String, String> {
    let normalized = extension.trim_start_matches('.').to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 64
        || normalized.chars().any(|value| {
            value.is_control()
                || matches!(value, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    {
        return Err("Invalid file extension".to_string());
    }
    Ok(normalized)
}

#[tauri::command]
async fn file_icons(extensions: Vec<String>) -> Result<HashMap<String, Option<String>>, String> {
    if extensions.len() > FILE_ICON_BATCH_MAX {
        return Err(format!(
            "Too many file extensions (maximum {FILE_ICON_BATCH_MAX})"
        ));
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(extensions.len());
    for extension in extensions {
        let extension = normalize_icon_extension(&extension)?;
        if seen.insert(extension.clone()) {
            normalized.push(extension);
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        normalized
            .into_iter()
            .map(|extension| {
                let image = filetree_core::shell_icon_data_url(&extension);
                (extension, image)
            })
            .collect()
    })
    .await
    .map_err(|error| format!("Shell icon batch worker failed: {error}"))
}

#[tauri::command]
async fn file_thumbnail(
    state: State<'_, Arc<V2Store>>,
    path: String,
    size: i32,
    icon_fallback: bool,
) -> Result<Option<String>, String> {
    require_authorized_path(&state, &path)?;
    let size = size.clamp(16, 512);
    tauri::async_runtime::spawn_blocking(move || {
        filetree_core::shell_thumbnail_data_url(&path, size, icon_fallback)
    })
    .await
    .map_err(|error| format!("Shell thumbnail worker failed: {error}"))
}

#[tauri::command]
fn secret_get(state: State<'_, Arc<V2Store>>, key: String) -> Result<Option<String>, String> {
    let Some(cipher) = state.load_secret_blob(&key)? else {
        return Ok(None);
    };
    let plain = filetree_core::unprotect_secret(&cipher)?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "Stored secret is not valid UTF-8".to_string())
}

#[tauri::command]
fn secret_set(state: State<'_, Arc<V2Store>>, key: String, value: String) -> Result<(), String> {
    if value.len() > 32 * 1024 {
        return Err("Secret exceeds the 32 KiB limit".to_string());
    }
    let cipher = filetree_core::protect_secret(value.as_bytes())?;
    state.save_secret_blob(&key, &cipher)
}

#[tauri::command]
fn secret_delete(state: State<'_, Arc<V2Store>>, key: String) -> Result<(), String> {
    state.delete_secret(&key)
}

#[tauri::command]
async fn compression_presence(
    app: AppHandle,
    enabled: bool,
    active: bool,
    status: String,
    progress: f64,
) -> Result<(), String> {
    filetree_core::set_keep_awake(enabled && active);
    let taskbar_status = match status.as_str() {
        "paused" | "pausing" if enabled => ProgressBarStatus::Paused,
        "error" => ProgressBarStatus::Error,
        _ if active => ProgressBarStatus::Normal,
        _ => ProgressBarStatus::None,
    };
    let progress = (progress.clamp(0.0, 1.0) * 100.0).round() as u64;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    window
        .set_progress_bar(ProgressBarState {
            status: Some(taskbar_status),
            progress: Some(progress),
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn compression_tools(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<Value, String> {
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || json_value(runtime.compression_tools_json()))
        .await
        .map_err(|error| format!("Compression tool probe failed: {error}"))?
}

#[tauri::command]
async fn compression_start(
    store: State<'_, Arc<V2Store>>,
    runtime: State<'_, Arc<DesktopRuntime>>,
    request: CompressionStartRequest,
) -> Result<CompressionStartResult, String> {
    let store = Arc::clone(store.inner());
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(path) = request
            .paths
            .iter()
            .find(|path| !store.source_path_is_authorized(path))
        {
            return Err(format!(
                "Source path is outside the scanned directories: {path}"
            ));
        }
        runtime.start_compression(request)
    })
    .await
    .map_err(|error| format!("Compression start worker failed: {error}"))?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompressionControl {
    #[serde(default)]
    id: String,
    #[serde(default)]
    concurrency: usize,
    #[serde(default)]
    indices: Vec<usize>,
    #[serde(default)]
    ids: Vec<String>,
}

#[tauri::command]
async fn compression_control(
    runtime: State<'_, Arc<DesktopRuntime>>,
    action: String,
    request: CompressionControl,
) -> Result<Value, String> {
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || match action.as_str() {
        "cancel" => {
            runtime.cancel_compression(&request.id)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "pause" => {
            Ok(serde_json::json!({ "ok": true, "status": runtime.pause_compression(&request.id)? }))
        }
        "resume" => {
            runtime.resume_compression(&request.id)?;
            Ok(serde_json::json!({ "ok": true, "status": "running" }))
        }
        "concurrency" => Ok(serde_json::json!({
            "ok": true,
            "concurrency": runtime.set_compression_concurrency(&request.id, request.concurrency)?,
        })),
        "prioritize" => Ok(serde_json::json!({
            "ok": true,
            "changed": runtime.prioritize_compression_files(&request.id, &request.indices)?,
        })),
        "skip" => Ok(serde_json::json!({
            "ok": true,
            "changed": runtime.skip_compression_files(&request.id, &request.indices)?,
        })),
        "retry" => {
            runtime.resume_compression(&request.id)?;
            Ok(serde_json::json!({ "ok": true, "jobId": request.id }))
        }
        "retry-files" => {
            let result = runtime.retry_compression_files(&request.id, &request.indices)?;
            Ok(serde_json::json!({ "ok": true, "jobId": result.job_id }))
        }
        "queue-reorder" => Ok(serde_json::json!({
            "ok": true,
            "changed": runtime.reorder_queued_compressions(&request.ids),
        })),
        "queue-remove" => {
            runtime.remove_queued_compression(&request.id)?;
            Ok(serde_json::json!({ "ok": true }))
        }
        _ => Err(format!("Unknown compression action: {action}")),
    })
    .await
    .map_err(|error| format!("Compression control worker failed: {error}"))?
}

#[tauri::command]
async fn compression_list(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<Value, String> {
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || json_value(runtime.list_compressions_json()))
        .await
        .map_err(|error| format!("Compression list worker failed: {error}"))?
}

fn compression_artifact_path(kind: &str) -> Result<std::path::PathBuf, String> {
    match kind {
        "history" => Ok(filetree_core::compression_history_path()),
        "debug" => Ok(filetree_core::compression_debug_log_path()),
        _ => Err("Unknown compression log kind".to_string()),
    }
}

#[tauri::command]
async fn compression_log(limit: Option<usize>) -> Result<Value, String> {
    let limit = limit.unwrap_or(500).clamp(1, 10_000);
    tauri::async_runtime::spawn_blocking(move || {
        json_value(filetree_core::compression_history_json(limit))
    })
    .await
    .map_err(|error| format!("Compression history worker failed: {error}"))?
}

#[tauri::command]
fn compression_log_path(kind: String) -> Result<Value, String> {
    let path = compression_artifact_path(&kind)?;
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "exists": path.is_file(),
    }))
}

#[tauri::command]
fn compression_log_action(kind: String, reveal: bool) -> Result<(), String> {
    let path = compression_artifact_path(&kind)?;
    if !path.is_file() {
        return Err("The compression log has not been created yet".to_string());
    }
    let path = path.to_string_lossy();
    if reveal {
        filetree_core::reveal_system_path(&path)
    } else {
        filetree_core::open_system_path(&path)
    }
}

#[tauri::command]
async fn compression_files(
    runtime: State<'_, Arc<DesktopRuntime>>,
    id: String,
    query: CompressionFilesRequest,
) -> Result<Option<Value>, String> {
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        runtime
            .compression_files_json(&id, query)
            .map(json_value)
            .transpose()
    })
    .await
    .map_err(|error| format!("Compression files worker failed: {error}"))?
}

#[tauri::command]
async fn compression_telemetry(
    runtime: State<'_, Arc<DesktopRuntime>>,
    id: String,
) -> Result<Value, String> {
    let runtime = Arc::clone(runtime.inner());
    tauri::async_runtime::spawn_blocking(move || {
        json_value(runtime.compression_telemetry_json(&id))
    })
    .await
    .map_err(|error| format!("Compression telemetry worker failed: {error}"))?
}

#[tauri::command]
fn compression_subscribe(
    runtime: State<'_, Arc<DesktopRuntime>>,
    id: String,
    on_event: Channel<Value>,
) -> Result<(), String> {
    runtime.subscribe_compression(&id, move |line| {
        if let Ok(event) = serde_json::from_str::<Value>(line.trim()) {
            let _ = on_event.send(event);
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The demo build must never touch the user's FileTree data. Every store,
    // including the compression queue restored at startup, resolves under
    // these variables, so point them at an empty demo folder first.
    #[cfg(feature = "demo")]
    {
        let home = std::env::temp_dir().join("FileTree-Demo");
        let _ = std::fs::create_dir_all(home.join("Roaming"));
        let _ = std::fs::create_dir_all(home.join("Local"));
        unsafe {
            std::env::set_var("APPDATA", home.join("Roaming"));
            std::env::set_var("LOCALAPPDATA", home.join("Local"));
        }
    }
    #[cfg(windows)]
    unsafe {
        // FileTree deliberately keeps the WebView compositor in software. Video
        // encoding remains in HandBrake/NVENC and is unaffected by this process.
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --disable-gpu-compositing --disable-http-cache",
        );
    }

    let store = V2Store::open_default().expect("initialize FileTree v2 state");
    let runtime = DesktopRuntime::new(Arc::clone(&store));
    let app = tauri::Builder::default()
        .manage(store)
        .manage(runtime)
        .manage(FsWatchRegistry::default())
        .manage(DuplicateScanRegistry::default())
        .manage(ExternalCopyGrants::default())
        .manage(Arc::new(terminal::TerminalRegistry::default()))
        .manage(Arc::new(cyberdrop::CyberdropState::default()))
        .manage(Arc::new(ollama::OllamaRequests::default()))
        .invoke_handler(tauri::generate_handler![
            cyberdrop::cyberdrop_workspace,
            cyberdrop::cyberdrop_document,
            cyberdrop::cyberdrop_start,
            cyberdrop::cyberdrop_stop,
            cyberdrop::cyberdrop_status,
            fileops::rename_path,
            fileops::delete_paths,
            fileops::create_folder,
            fileops::restore_recycled,
            ollama::ollama_models,
            ollama::ollama_chat,
            ollama::ollama_cancel,
            app_version,
            app_exit,
            app_config,
            drives,
            special_folders,
            volume_info,
            app_settings_get,
            app_settings_set,
            bookmarks_get,
            bookmarks_set,
            open_path,
            reveal_path,
            move_items,
            native_move_items,
            native_copy_items,
            clipboard_write_files,
            clipboard_read_files,
            claim_external_paths,
            release_external_paths,
            native_drag,
            shell_context_menu,
            fs_watch_start,
            fs_watch_stop,
            directory_snapshot,
            browse_directories,
            stat_dropped_paths,
            file_icon,
            file_icons,
            file_thumbnail,
            terminal::terminal_profiles,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            secret_get,
            secret_set,
            secret_delete,
            compression_presence,
            scan_start,
            scan_cancel,
            scan_status,
            scan_find,
            scan_page,
            scan_subtree_files,
            scan_compression_candidates_stream,
            scan_folder_preview,
            duplicates_scan,
            duplicates_cancel,
            duplicates_action,
            duplicates_link,
            scan_pin,
            memory_stats,
            compression_tools,
            compression_start,
            compression_control,
            compression_list,
            compression_log,
            compression_log_path,
            compression_log_action,
            compression_files,
            compression_telemetry,
            compression_subscribe,
        ])
        .build(tauri::generate_context!())
        .expect("build FileTree v2");
    app.run(|app_handle, event| {
        match &event {
            tauri::RunEvent::WebviewEvent {
                event: tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
                ..
            }
            | tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
                ..
            } => app_handle
                .state::<ExternalCopyGrants>()
                .grant_native_drop(paths),
            _ => {}
        }
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<Arc<cyberdrop::CyberdropState>>().shutdown();
            filetree_core::set_keep_awake(false);
            app_handle.state::<Arc<DesktopRuntime>>().shutdown();
            app_handle
                .state::<Arc<terminal::TerminalRegistry>>()
                .kill_all();
        }
    });
}
