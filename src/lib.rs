mod analytics;
mod archive;
mod audit;
mod cleanup;
mod cli;
mod compress_debug;
mod compress_job;
mod compress_log;
mod compress_tools;
mod desktop_runtime;
mod diff;
mod dupes;
mod export;
mod file_ops;
mod fileattr;
mod io;
mod json;
mod model;
mod owner;
mod preflight;
mod recycle;
mod scan;
mod schedule;
#[cfg(windows)]
mod settings;
mod smartfolders;
mod snapshots;
mod tags;
mod v2_headless;
mod windows_native;
mod xlsx;

pub mod v2;

pub use desktop_runtime::{
    CompressionFilesRequest, CompressionScanDirectory, CompressionStartRequest,
    CompressionStartResult, DesktopRuntime,
};
pub use file_ops::{MoveItemsResult, move_items};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompressionEligibility {
    Eligible,
    EncoderUnavailable,
    KnownNoGain,
    TooSmall,
}

/// Cheap scan-index eligibility check shared by folder discovery and job start.
/// It deliberately avoids opening file contents so very large folders remain
/// fast; definitive filesystem and encoder validation still happens at start.
pub fn compression_eligibility(
    path: &str,
    size: u64,
    video_encoder_available: bool,
    image_encoder_available: bool,
    min_size_bytes: u64,
) -> CompressionEligibility {
    compress_job::compression_eligibility(
        std::path::Path::new(path),
        size,
        video_encoder_available,
        image_encoder_available,
        min_size_bytes,
    )
}

pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn app_config_json() -> String {
    format!(
        "{{\"initialPath\":\"\",\"defaultThreads\":{}}}",
        io::default_thread_count()
    )
}

pub fn drives_json() -> String {
    export::drives_json()
}

pub fn special_folders_json() -> String {
    export::special_folders_json()
}

pub fn open_system_path(path: &str) -> Result<(), String> {
    io::open_path(path).map_err(|error| error.to_string())
}

pub fn reveal_system_path(path: &str) -> Result<(), String> {
    io::reveal_path(path).map_err(|error| error.to_string())
}

pub fn protect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    windows_native::protect_secret(value)
}

pub fn unprotect_secret(value: &[u8]) -> Result<Vec<u8>, String> {
    windows_native::unprotect_secret(value)
}

pub fn set_keep_awake(active: bool) {
    windows_native::set_keep_awake(active);
}

pub fn shell_icon_data_url(extension: &str) -> Option<String> {
    use base64::Engine as _;
    windows_native::shell_icon_png(extension).map(|png| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    })
}

pub fn shell_thumbnail_data_url(path: &str, size: i32, icon_fallback: bool) -> Option<String> {
    use base64::Engine as _;
    windows_native::shell_thumbnail_png(path, size, icon_fallback).map(|png| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    })
}

pub struct NativeDragOutcome {
    pub outcome: String,
    pub drop_x: i32,
    pub drop_y: i32,
}

pub fn start_native_drag(paths: Vec<String>) -> Result<NativeDragOutcome, String> {
    windows_native::native_drag_files(paths).map(|result| NativeDragOutcome {
        outcome: result.outcome,
        drop_x: result.drop_x,
        drop_y: result.drop_y,
    })
}

pub struct NativeMoveOutcome {
    pub aborted: bool,
    pub moved: usize,
    pub skipped: usize,
    pub failed: usize,
}

pub fn move_items_with_windows(
    paths: Vec<String>,
    destination: String,
    owner_handle: isize,
) -> Result<NativeMoveOutcome, String> {
    windows_native::native_move_files(paths, destination, owner_handle).map(|result| {
        NativeMoveOutcome {
            aborted: result.aborted,
            moved: result.moved,
            skipped: result.skipped,
            failed: result.failed,
        }
    })
}

pub fn copy_items_with_windows(
    paths: Vec<String>,
    destination: String,
    owner_handle: isize,
) -> Result<NativeMoveOutcome, String> {
    windows_native::native_copy_files(paths, destination, owner_handle).map(|result| {
        NativeMoveOutcome {
            aborted: result.aborted,
            moved: result.moved,
            skipped: result.skipped,
            failed: result.failed,
        }
    })
}

pub struct ClipboardFilesOutcome {
    pub paths: Vec<String>,
    pub prefer_move: bool,
}

pub fn write_files_to_clipboard(
    paths: Vec<String>,
    owner_handle: isize,
    cut: bool,
) -> Result<bool, String> {
    windows_native::clipboard_write_files(paths, owner_handle, cut)
}

pub fn read_files_from_clipboard(owner_handle: isize) -> Result<ClipboardFilesOutcome, String> {
    windows_native::clipboard_read_files(owner_handle).map(|result| ClipboardFilesOutcome {
        paths: result.paths,
        prefer_move: result.prefer_move,
    })
}

pub fn show_shell_context_menu(
    paths: Vec<String>,
    owner_handle: isize,
    screen_x: i32,
    screen_y: i32,
) -> Result<Option<String>, String> {
    windows_native::shell_context_menu(paths, owner_handle, screen_x, screen_y)
}

pub fn run_cli() {
    cli::run();
}
