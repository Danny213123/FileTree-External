use filetree_core::v2::{
    BOOKMARKS_JSON_MAX_BYTES, DuplicateProgress, DuplicateScanRequest, DuplicateScanResult,
    MemoryStats, NodePage, NodePageItem, SETTINGS_JSON_MAX_BYTES, ScanHandle, ScanProgress,
    ScanQuery, ScanRequest, SubtreeFilePage, SubtreeFilesQuery, V2Store,
};
use filetree_core::{
    CompressionFilesRequest, CompressionStartRequest, CompressionStartResult, DesktopRuntime,
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
    cancel: Mutex<Option<Arc<AtomicBool>>>,
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

#[cfg(test)]
mod desktop_tests {
    use super::{
        collapse_changed_directories, directory_snapshot_rows, watch_directories_for_paths,
    };
    use std::{collections::HashMap, fs};

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
}

#[tauri::command]
fn scan_start(
    state: State<'_, Arc<V2Store>>,
    request: ScanRequest,
    on_progress: Channel<ScanProgress>,
) -> Result<ScanHandle, String> {
    state.start_scan(request, move |event| {
        let _ = on_progress.send(event);
    })
}

#[tauri::command]
fn scan_cancel(state: State<'_, Arc<V2Store>>, scan_id: String) -> bool {
    state.cancel_scan(&scan_id)
}

#[tauri::command]
fn scan_status(state: State<'_, Arc<V2Store>>, scan_id: String) -> Option<ScanHandle> {
    state.scan_status(&scan_id)
}

#[tauri::command]
fn scan_find(state: State<'_, Arc<V2Store>>, root_path: String) -> Option<ScanHandle> {
    state.find_completed_scan(&root_path)
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

#[tauri::command]
async fn duplicates_scan(
    state: State<'_, Arc<V2Store>>,
    registry: State<'_, DuplicateScanRegistry>,
    request: DuplicateScanRequest,
    on_progress: Channel<DuplicateProgress>,
) -> Result<DuplicateScanResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = registry
            .cancel
            .lock()
            .map_err(|_| "Duplicate scan registry is unavailable".to_string())?;
        if let Some(previous) = active.replace(Arc::clone(&cancel)) {
            previous.store(true, Ordering::Relaxed);
        }
    }
    let store = Arc::clone(state.inner());
    let worker_cancel = Arc::clone(&cancel);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        store.find_exact_duplicates(request, worker_cancel, move |event| {
            let _ = on_progress.send(event);
        })
    })
    .await
    .map_err(|error| format!("Duplicate scan worker failed: {error}"))?;
    if let Ok(mut active) = registry.cancel.lock() {
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &cancel))
        {
            active.take();
        }
    }
    outcome
}

#[tauri::command]
fn duplicates_cancel(registry: State<'_, DuplicateScanRegistry>) -> bool {
    let Ok(active) = registry.cancel.lock() else {
        return false;
    };
    let Some(cancel) = active.as_ref() else {
        return false;
    };
    cancel.store(true, Ordering::Relaxed);
    true
}

#[tauri::command]
fn scan_pin(state: State<'_, Arc<V2Store>>, scan_id: String, pinned: bool) -> Result<(), String> {
    state.set_scan_pinned(&scan_id, pinned)
}

#[tauri::command]
fn memory_stats(state: State<'_, Arc<V2Store>>) -> MemoryStats {
    state.memory_stats()
}

fn json_value(text: String) -> Result<Value, String> {
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

#[tauri::command]
fn app_version() -> Value {
    serde_json::json!({ "version": filetree_core::app_version() })
}

#[tauri::command]
fn app_config() -> Result<Value, String> {
    json_value(filetree_core::app_config_json())
}

#[tauri::command]
fn drives() -> Result<Value, String> {
    json_value(filetree_core::drives_json())
}

#[tauri::command]
fn special_folders() -> Result<Value, String> {
    json_value(filetree_core::special_folders_json())
}

#[tauri::command]
fn app_settings_get(state: State<'_, Arc<V2Store>>) -> Result<Value, String> {
    json_value(state.load_json_setting("app.settings", "{}")?)
}

#[tauri::command]
fn app_settings_set(state: State<'_, Arc<V2Store>>, settings: Value) -> Result<(), String> {
    let text = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    state.save_json_setting("app.settings", &text, SETTINGS_JSON_MAX_BYTES)
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
    for path in &paths {
        require_authorized_path(&state, path)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        filetree_core::move_items(paths, destination, conflict)
    })
    .await
    .map_err(|error| format!("Move worker failed: {error}"))
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
    for path in &paths {
        require_authorized_path(&state, path)?;
    }
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
async fn file_icon(extension: String) -> Result<Option<String>, String> {
    if extension.is_empty()
        || extension.len() > 64
        || extension.chars().any(|value| {
            value.is_control()
                || matches!(value, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    {
        return Err("Invalid file extension".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || filetree_core::shell_icon_data_url(&extension))
        .await
        .map_err(|error| format!("Shell icon worker failed: {error}"))
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
fn compression_presence(
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
fn compression_tools(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<Value, String> {
    json_value(runtime.compression_tools_json())
}

#[tauri::command]
fn compression_start(
    store: State<'_, Arc<V2Store>>,
    runtime: State<'_, Arc<DesktopRuntime>>,
    request: CompressionStartRequest,
) -> Result<CompressionStartResult, String> {
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
fn compression_control(
    runtime: State<'_, Arc<DesktopRuntime>>,
    action: String,
    request: CompressionControl,
) -> Result<Value, String> {
    match action.as_str() {
        "cancel" => Ok(serde_json::json!({ "ok": runtime.cancel_compression(&request.id) })),
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
    }
}

#[tauri::command]
fn compression_list(runtime: State<'_, Arc<DesktopRuntime>>) -> Result<Value, String> {
    json_value(runtime.list_compressions_json())
}

#[tauri::command]
fn compression_files(
    runtime: State<'_, Arc<DesktopRuntime>>,
    id: String,
    query: CompressionFilesRequest,
) -> Result<Option<Value>, String> {
    runtime
        .compression_files_json(&id, query)
        .map(json_value)
        .transpose()
}

#[tauri::command]
fn compression_telemetry(
    runtime: State<'_, Arc<DesktopRuntime>>,
    id: String,
) -> Result<Value, String> {
    json_value(runtime.compression_telemetry_json(&id))
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
        .manage(Arc::new(terminal::TerminalRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            app_version,
            app_config,
            drives,
            special_folders,
            app_settings_get,
            app_settings_set,
            bookmarks_get,
            bookmarks_set,
            open_path,
            reveal_path,
            move_items,
            native_drag,
            fs_watch_start,
            fs_watch_stop,
            directory_snapshot,
            file_icon,
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
            scan_folder_preview,
            duplicates_scan,
            duplicates_cancel,
            scan_pin,
            memory_stats,
            compression_tools,
            compression_start,
            compression_control,
            compression_list,
            compression_files,
            compression_telemetry,
            compression_subscribe,
        ])
        .build(tauri::generate_context!())
        .expect("build FileTree v2");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            filetree_core::set_keep_awake(false);
            app_handle
                .state::<Arc<terminal::TerminalRegistry>>()
                .kill_all();
        }
    });
}
