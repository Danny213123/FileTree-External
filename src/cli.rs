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

/// Clamp `geom` so the window is fully visible within the primary monitor work area.
/// Accepts an injected `workarea` for testability; production code calls
/// `primary_workarea()` to get the real value via `SystemParametersInfoW`.
///
/// Clamp BEFORE CreateWindowExW to preserve no-jank invariant per UI-SPEC
/// §"Window restore order": geometry passes directly into CreateWindowExW.
pub(crate) fn clamp_window_to_workarea(
    geom: crate::settings::WindowGeometry,
    workarea: crate::desktop::ffi::Rect,
) -> crate::settings::WindowGeometry {
    let wa_w = (workarea.right - workarea.left).max(1);
    let wa_h = (workarea.bottom - workarea.top).max(1);

    // Clamp width/height to not exceed work area dimensions.
    let w = geom.w.min(wa_w).max(320);
    let h = geom.h.min(wa_h).max(200);

    // Clamp x so that the right edge stays within the work area.
    let x = geom.x.min(workarea.right - w).max(workarea.left);
    // Clamp y so that the bottom edge stays within the work area.
    let y = geom.y.min(workarea.bottom - h).max(workarea.top);

    crate::settings::WindowGeometry {
        x,
        y,
        w,
        h,
        unknown: geom.unknown,
    }
}

/// Retrieve the primary monitor's work area via SystemParametersInfoW(SPI_GETWORKAREA).
/// Falls back to a generous default rectangle on failure so the app still launches.
#[cfg(windows)]
fn primary_workarea() -> crate::desktop::ffi::Rect {
    use crate::desktop::ffi::{Rect, SPI_GETWORKAREA, SystemParametersInfoW};
    let mut rect: Rect = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            &mut rect as *mut Rect as *mut std::ffi::c_void,
            0,
        )
    };
    if ok == 0 {
        // Fallback: assume 1920×1080 desktop with no taskbar.
        rect.right = 1920;
        rect.bottom = 1080;
    }
    rect
}

fn run_desktop(initial_path: PathBuf) -> sio::Result<()> {
    #[cfg(windows)]
    {
        // Acquire the single-instance named mutex BEFORE creating any window.
        // If a primary instance is already running, try_forward_or_acquire will
        // forward `initial_path` via WM_COPYDATA and call std::process::exit(0)
        // — it never returns for the second instance.
        // The handle is kept alive for the lifetime of run_desktop; no explicit
        // CloseHandle is needed because the OS releases the mutex automatically
        // when the process exits.
        let _mutex = unsafe { crate::desktop::ffi::try_forward_or_acquire(&initial_path) }
            .map_err(|error| {
                sio::Error::other(format!("single-instance mutex acquire failed: {error}"))
            })?;

        // Load settings BEFORE window creation (no-jank invariant, UI-SPEC §"Window restore order").
        let settings_store =
            std::sync::Arc::new(crate::settings::SettingsStore::default().map_err(|error| {
                sio::Error::other(format!("settings store init failed: {error}"))
            })?);
        let settings = settings_store.load_or_default();

        // POL-03 / D-04 — pre-window dark-mode bootstrap.
        // Set the process-wide AppMode BEFORE desktop::run registers any window class.
        // This tells uxtheme to dark-theme built-in scrollbar / combobox chrome from
        // the very first CreateWindowExW call, preventing the white-flash on launch.
        // See bootstrap_dark_mode for cross-version behavior notes (Pitfall 2).
        crate::desktop::bootstrap_dark_mode(settings.dark_mode);

        // Clamp geometry to primary monitor work area BEFORE CreateWindowExW (T-02-18).
        let wa = primary_workarea();
        let clamped_geom = clamp_window_to_workarea(settings.window.clone(), wa);

        crate::desktop::run(initial_path, settings, settings_store, clamped_geom)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::ffi::Rect;
    use crate::settings::WindowGeometry;
    use std::collections::BTreeMap;

    fn workarea(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }

    fn geom(x: i32, y: i32, w: i32, h: i32) -> WindowGeometry {
        WindowGeometry {
            x,
            y,
            w,
            h,
            unknown: BTreeMap::new(),
        }
    }

    #[test]
    fn clamp_window_to_workarea_keeps_in_bounds() {
        let wa = workarea(0, 0, 1920, 1080);
        let g = geom(100, 100, 800, 600);
        let result = clamp_window_to_workarea(g, wa);
        assert_eq!(result.x, 100);
        assert_eq!(result.y, 100);
        assert_eq!(result.w, 800);
        assert_eq!(result.h, 600);
    }

    #[test]
    fn clamp_window_to_workarea_offscreen_x_pulls_in() {
        let wa = workarea(0, 0, 1920, 1080);
        let g = geom(5000, 100, 800, 600);
        let result = clamp_window_to_workarea(g, wa);
        // x clamped so right edge fits: 1920 - 800 = 1120
        assert_eq!(result.x, 1920 - 800);
        assert_eq!(result.y, 100);
        assert_eq!(result.w, 800);
        assert_eq!(result.h, 600);
    }

    #[test]
    fn clamp_window_to_workarea_oversized_w_caps() {
        let wa = workarea(0, 0, 1920, 1080);
        let g = geom(0, 0, 4000, 600);
        let result = clamp_window_to_workarea(g, wa);
        assert_eq!(result.w, 1920);
        assert_eq!(result.h, 600);
    }
}
