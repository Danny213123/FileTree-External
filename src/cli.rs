use std::env;
use std::fs;
use std::io::{self as sio};
use std::path::PathBuf;

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

    if args.is_empty() {
        let result = run_desktop(current_dir_or_dot());
        if let Err(error) = result {
            eprintln!("{}: {}", APP_NAME, error);
            std::process::exit(1);
        }
        return;
    }

    let result = match args[0].as_str() {
        "desktop" | "gui" => {
            let initial_path = option_value(&args, "--path")
                .map(PathBuf::from)
                .or_else(|| first_positional_arg(&args[1..]).map(PathBuf::from))
                .unwrap_or_else(current_dir_or_dot);
            run_desktop(initial_path)
        }
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
  filetree
  filetree desktop [--path PATH]
  filetree serve [--path PATH] [--port PORT]
  filetree scan PATH [--format json|csv] [--out FILE] [--threads N] [--exclude PATTERNS]

Examples:
  filetree desktop --path D:\\Data
  filetree serve --path C:\\ --port 7878
  filetree scan D:\\Data --format csv --out report.csv
"
    );
}

fn run_desktop(initial_path: PathBuf) -> sio::Result<()> {
    #[cfg(windows)]
    {
        crate::desktop::run(initial_path)
    }

    #[cfg(not(windows))]
    {
        let _ = initial_path;
        Err(sio::Error::new(
            sio::ErrorKind::Unsupported,
            "the native desktop app is currently implemented for Windows",
        ))
    }
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
        fs::write(out, body)?;
    } else {
        println!("{body}");
    }

    Ok(())
}
