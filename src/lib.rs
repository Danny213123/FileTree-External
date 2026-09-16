// The crate still carries v1 code paths (snapshots, schedules, smart folders,
// archive and analytics helpers) that the v2 desktop and CLI have not re-wired
// yet. They compile and are tested, so dead-code warnings are allowed rather
// than deleting work the v2 UI is expected to call again.
#![allow(dead_code)]

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
mod mft;
mod model;
mod owner;
mod preflight;
mod recycle;
mod refresh;
mod scan;
mod schedule;
#[cfg(windows)]
mod settings;
mod smartfolders;
mod snapshots;
mod tags;
mod usn;
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

/// Capacity, filesystem and cluster size of the volume holding `path`.
pub fn volume_info_json(path: &str) -> String {
    export::volume_info_json(path)
}

pub fn open_system_path(path: &str) -> Result<(), String> {
    io::open_path(path).map_err(|error| error.to_string())
}

pub fn reveal_system_path(path: &str) -> Result<(), String> {
    io::reveal_path(path).map_err(|error| error.to_string())
}

/// Recycle (default) or permanently delete one file or folder. Authorization
/// and scanned-root policy are enforced by the Tauri command boundary.
pub fn delete_path(path: &str, permanent: bool) -> Result<(), String> {
    let path = std::path::Path::new(path);
    let result = if permanent {
        recycle::delete_path_permanent(path)
    } else {
        recycle::recycle_path(path)
    };
    result.map_err(|error| error.to_string())
}

/// File actions used by the desktop duplicate-review workflow. Authorization
/// and protected-location policy are enforced by the Tauri command boundary;
/// these helpers keep the proven action implementations shared with legacy.
pub fn delete_duplicate_paths(paths: Vec<String>, permanent: bool) -> Vec<String> {
    let paths = paths
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    dupes::action_delete(&paths, permanent)
}

pub fn delete_verified_duplicate(
    keeper: String,
    duplicate: String,
    permanent: bool,
) -> Vec<String> {
    dupes::action_delete_verified(
        std::path::Path::new(&keeper),
        std::path::Path::new(&duplicate),
        permanent,
    )
}

/// Reversible deletion after the desktop has validated the review snapshot,
/// keeper and scope. Metadata matches do not imply identical file contents.
pub fn recycle_reviewed_duplicate(keeper: String, duplicate: String) -> Vec<String> {
    dupes::action_recycle_reviewed(
        std::path::Path::new(&keeper),
        std::path::Path::new(&duplicate),
    )
}

pub fn transfer_duplicate_paths(
    action: &str,
    paths: Vec<String>,
    destination: String,
) -> Vec<String> {
    let destination = std::path::PathBuf::from(destination);
    let mut errors = Vec::new();
    let mut pairs = Vec::new();
    for source in paths.into_iter().map(std::path::PathBuf::from) {
        let Some(name) = source.file_name().map(|value| value.to_owned()) else {
            errors.push(format!("{}: source has no file name", source.display()));
            continue;
        };
        pairs.push((source, destination.join(name)));
    }
    errors.extend(match action {
        "move" => dupes::action_move(&pairs),
        "copy" => dupes::action_copy(&pairs),
        _ => vec!["Unknown duplicate transfer action".to_string()],
    });
    errors
}

pub fn transfer_verified_duplicate(
    action: &str,
    keeper: String,
    duplicate: String,
    destination: String,
) -> Vec<String> {
    dupes::action_transfer_verified(
        action,
        std::path::Path::new(&keeper),
        std::path::Path::new(&duplicate),
        std::path::Path::new(&destination),
    )
}

pub fn replace_duplicate_paths_with_links(
    pairs: Vec<(String, String)>,
    symbolic: bool,
    permanent: bool,
) -> Vec<String> {
    let pairs = pairs
        .into_iter()
        .map(|(original, link)| {
            (
                std::path::PathBuf::from(original),
                std::path::PathBuf::from(link),
            )
        })
        .collect::<Vec<_>>();
    dupes::action_link(&pairs, symbolic, permanent)
}

pub fn verified_duplicate_pair(original: &str, duplicate: &str) -> Result<bool, String> {
    dupes::verified_duplicate_pair(
        std::path::Path::new(original),
        std::path::Path::new(duplicate),
    )
}

/// Recent per-file compression outcomes for the desktop History view.
pub fn compression_history_json(limit: usize) -> String {
    compress_log::read_rows_json(limit.min(10_000))
}

/// App-owned compression artifacts. These are exposed individually so the
/// desktop shell never needs to authorize an arbitrary renderer-supplied path.
pub fn compression_history_path() -> std::path::PathBuf {
    compress_log::log_path()
}

pub fn compression_debug_log_path() -> std::path::PathBuf {
    compress_debug::log_path()
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
    defer_paste: bool,
) -> Result<Option<String>, String> {
    windows_native::shell_context_menu(paths, owner_handle, screen_x, screen_y, defer_paste)
}

pub fn run_cli() {
    cli::run();
}
