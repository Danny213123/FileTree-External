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
    CompressionFilesRequest, CompressionStartRequest, CompressionStartResult, DesktopRuntime,
};

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

pub fn run_cli() {
    cli::run();
}
