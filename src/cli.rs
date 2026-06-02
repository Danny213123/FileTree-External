use std::env;
use std::fs;
use std::io::{self as sio};
use std::path::{Path, PathBuf};

use crate::export::{scan_result_to_csv, scan_result_to_json};
use crate::io::{
    current_dir_or_dot, default_thread_count, first_positional_arg, has_flag, option_value,
    split_patterns,
};
use crate::model::ScanOptions;
use crate::scan::scan_path;
use crate::server::run_server;

pub(crate) const APP_NAME: &str = "FileTree";
pub(crate) const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub(crate) fn run() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_usage();
        return;
    }

    // Default (no args): run headless server on default port so Electron can connect.
    if args.is_empty() {
        if let Err(error) = run_server(current_dir_or_dot(), 7878) {
            eprintln!("{}: {}", APP_NAME, error);
            std::process::exit(1);
        }
        return;
    }

    let result = match args[0].as_str() {
        "serve" => {
            let initial_path = option_value(&args, "--path")
                .map(PathBuf::from)
                .unwrap_or_else(current_dir_or_dot);
            let port = option_value(&args, "--port")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(7878);
            run_server(initial_path, port)
        }
        "scan" => run_scan_command(&args[1..]),
        _ => {
            print_usage();
            Ok(())
        }
    };

    if let Err(error) = result {
        eprintln!("{}: {}", APP_NAME, error);
        std::process::exit(1);
    }
}

fn print_usage() {
    println!(
        "{APP_NAME} {APP_VERSION}

Usage:
  filetree                              Start server on port 7878 (for Electron)
  filetree serve [--path PATH] [--port PORT]
  filetree scan PATH [--format json|csv] [--out FILE] [--threads N] [--exclude PATTERNS]

Examples:
  filetree serve --path C:\\ --port 7878
  filetree scan D:\\Data --format csv --out report.csv
"
    );
}

fn run_scan_command(args: &[String]) -> sio::Result<()> {
    let path = option_value(args, "--path")
        .map(PathBuf::from)
        .or_else(|| first_positional_arg(args).map(PathBuf::from))
        .unwrap_or_else(current_dir_or_dot);
    let format = option_value(args, "--format").unwrap_or_else(|| "json".to_string());
    let out = option_value(args, "--out");
    let options = ScanOptions {
        root: path,
        include_hidden: !has_flag(args, "--no-hidden"),
        follow_links: has_flag(args, "--follow-links"),
        exclude_patterns: option_value(args, "--exclude")
            .map(|value| split_patterns(&value))
            .unwrap_or_default(),
        max_depth: option_value(args, "--max-depth").and_then(|value| value.parse().ok()),
        threads: option_value(args, "--threads")
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(default_thread_count),
    };

    let result = scan_path(options)?;
    let body = match format.as_str() {
        "csv" => scan_result_to_csv(&result),
        "json" => scan_result_to_json(&result),
        other => {
            return Err(sio::Error::new(
                sio::ErrorKind::InvalidInput,
                format!("unsupported format '{other}'"),
            ));
        }
    };

    if let Some(out) = out {
        // Atomic write: stream to a sibling temp file, then rename over the
        // destination. A crash/error mid-write can't leave a half-written or
        // truncated export in place — the user either gets the old file or the
        // complete new one (Phase 3).
        write_atomic(Path::new(&out), body.as_bytes())?;
    } else {
        println!("{body}");
    }

    Ok(())
}

/// Write `bytes` to `path` atomically: write a temp file in the same directory,
/// flush+sync it, then rename it onto `path` (an atomic replace on Windows and
/// POSIX). On any error the temp file is cleaned up and the original is left
/// untouched.
fn write_atomic(path: &Path, bytes: &[u8]) -> sio::Result<()> {
    use std::io::Write;

    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("output");
    let tmp = dir.join(format!(".{file_name}.{}.tmp", std::process::id()));

    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        // Best-effort durability; ignore platforms/filesystems that reject it.
        let _ = file.sync_all();
    }

    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            Err(error)
        }
    }
}
