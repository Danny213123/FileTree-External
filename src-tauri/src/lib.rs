use filetree_core::v2::{
    BOOKMARKS_JSON_MAX_BYTES, MemoryStats, NodePage, SETTINGS_JSON_MAX_BYTES, ScanHandle,
    ScanProgress, ScanQuery, ScanRequest, V2Store,
};
use filetree_core::{
    CompressionFilesRequest, CompressionStartRequest, CompressionStartResult, DesktopRuntime,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, State};

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
    if extension.len() > 32 || !extension.chars().all(|value| value.is_ascii_alphanumeric()) {
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
            file_icon,
            file_thumbnail,
            secret_get,
            secret_set,
            secret_delete,
            compression_presence,
            scan_start,
            scan_cancel,
            scan_status,
            scan_find,
            scan_page,
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
    app.run(|_, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            filetree_core::set_keep_awake(false);
        }
    });
}
