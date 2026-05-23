#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, OnceLock};

use crate::model::ScanResult;

use super::ffi::{
    CopyDataStruct, FILETREE_PATH_MSG_ID, Handle, Hfont, Hicon, Hwnd, Lparam, Lresult,
    MAX_COPYDATA_BYTES, SetForegroundWindow, SetWindowTextW,
};

pub(super) static STATE: OnceLock<Mutex<DesktopState>> = OnceLock::new();

pub(super) struct DesktopState {
    pub(super) initial_path: PathBuf,
    pub(super) hwnd: Hwnd,
    /// ComboBoxEx32 drive picker HWND — populated in create_controls (Plan 02-03).
    /// Initialized to 0; destroyed implicitly by DestroyWindow on WM_DESTROY.
    pub(super) drive_picker: Hwnd,
    /// Accelerator table handle — created before the message loop (Plan 02-03),
    /// destroyed via DestroyAcceleratorTable after the message loop exits.
    pub(super) accel_table: Handle,
    pub(super) path_edit: Hwnd,
    pub(super) browse_button: Hwnd,
    pub(super) scan_button: Hwnd,
    pub(super) stop_button: Hwnd,
    pub(super) refresh_button: Hwnd,
    pub(super) expand_button: Hwnd,
    pub(super) collapse_button: Hwnd,
    pub(super) columns_button: Hwnd,
    pub(super) hidden_check: Hwnd,
    pub(super) files_check: Hwnd,
    pub(super) follow_check: Hwnd,
    pub(super) dark_check: Hwnd,
    pub(super) status: Hwnd,
    pub(super) list: Hwnd,
    pub(super) font: Hfont,
    pub(super) bold_font: Hfont,
    pub(super) current_scan: Option<Arc<ScanResult>>,
    pub(super) current_cancel: Option<Arc<AtomicBool>>,
    pub(super) expanded: BTreeSet<usize>,
    pub(super) visible_rows: Vec<usize>,
    pub(super) icon_cache: HashMap<String, Hicon>,
    pub(super) show_files: bool,
    pub(super) scanning: bool,
    pub(super) dark_mode: bool,
    pub(super) path_column_visible: bool,
    pub(super) selected_id: usize,
    pub(super) scroll_row: usize,
    pub(super) hovered_id: Option<usize>,
    pub(super) active_tab: usize,
}

pub(super) struct ScanDone {
    pub(super) result: Result<ScanResult, String>,
    pub(super) canceled: bool,
}

pub(super) struct ScanProgressInfo {
    pub(super) node_count: usize,
    pub(super) elapsed_ms: u128,
    pub(super) partial_result: Option<ScanResult>,
}

impl DesktopState {
    pub(super) fn new(initial_path: PathBuf) -> Self {
        Self {
            initial_path,
            hwnd: 0,
            drive_picker: 0,
            accel_table: 0,
            path_edit: 0,
            browse_button: 0,
            scan_button: 0,
            stop_button: 0,
            refresh_button: 0,
            expand_button: 0,
            collapse_button: 0,
            columns_button: 0,
            hidden_check: 0,
            files_check: 0,
            follow_check: 0,
            dark_check: 0,
            status: 0,
            list: 0,
            font: 0,
            bold_font: 0,
            current_scan: None,
            current_cancel: None,
            expanded: BTreeSet::new(),
            visible_rows: Vec::new(),
            icon_cache: HashMap::new(),
            show_files: true,
            scanning: false,
            dark_mode: true,
            path_column_visible: true,
            selected_id: 0,
            scroll_row: 0,
            hovered_id: None,
            active_tab: 1,
        }
    }
}

pub(super) fn with_state_mut<T>(callback: impl FnOnce(&mut DesktopState) -> T) -> Option<T> {
    let state = STATE.get()?;
    // Use try_lock instead of lock to prevent deadlocks from reentrant
    // calls. Win32 APIs (e.g. SetWindowTextW, EnableWindow) can send
    // synchronous messages back to our window proc while we hold this
    // lock. Rust's std::Mutex is NOT reentrant — lock() on the same
    // thread would deadlock permanently. try_lock() returns Err
    // (WouldBlock) for reentrant calls, allowing the reentrant handler
    // to gracefully skip non-critical work.
    let mut state = state.try_lock().ok()?;
    Some(callback(&mut state))
}

/// Handles an incoming `WM_COPYDATA` message from a second instance of FileTree.
///
/// Validates the `COPYDATASTRUCT` payload (magic discriminator, size cap, UTF-16
/// alignment), memcopies the path out IMMEDIATELY (see Pitfall #2 — `lpData` is
/// valid only for the duration of the synchronous `SendMessageW` call in the
/// sender), then canonicalizes and validates the path before triggering a scan.
/// Invalid payloads are silently dropped per D-06.4; the window still receives
/// focus even on a rejected payload.
///
/// Returns 1 if the message was handled, 0 otherwise.
pub(crate) fn handle_copy_data(hwnd: Hwnd, lparam: Lparam) -> Lresult {
    if lparam == 0 {
        return 0;
    }

    // SAFETY: lparam is a valid pointer to COPYDATASTRUCT for the duration of
    // the synchronous SendMessageW call in the sender. We memcpy all fields we
    // need into local variables BEFORE any other call that could release the
    // sender (Pitfall #2 — WM_COPYDATA lpData lifetime discipline).
    let (dwdata, cbdata, lpdata) = unsafe {
        let cds = &*(lparam as *const CopyDataStruct);
        // Memcpy field values out before any further function calls.
        (cds.dwData, cds.cbData, cds.lpData)
    };

    // Validate magic discriminator (D-06.2).
    if dwdata != FILETREE_PATH_MSG_ID {
        return 0;
    }
    // Validate size: must be non-zero, within the 64 KB cap (D-06.1), and
    // an even number of bytes (UTF-16 pairs require 2 bytes each).
    if cbdata == 0 || cbdata > MAX_COPYDATA_BYTES || cbdata % 2 != 0 {
        return 0;
    }

    // Memcpy payload into a local Vec<u16> — after this, lpdata is no longer touched.
    // This is the critical memcpy-out discipline: no use of lpdata after this point.
    let u16_len = (cbdata as usize) / 2;
    let mut buf = vec![0u16; u16_len];
    unsafe {
        std::ptr::copy_nonoverlapping(lpdata as *const u16, buf.as_mut_ptr(), u16_len);
    }
    // Strip optional trailing NUL added by the sender.
    if buf.last() == Some(&0) {
        buf.pop();
    }

    let raw = String::from_utf16_lossy(&buf);

    // Validate the path: must be an existing directory (D-06.3).
    // On non-Windows builds this function is not reachable (the mutex path
    // is #[cfg(windows)] guarded), but the compiler still checks both arms.
    #[cfg(windows)]
    if let Some(canonical) = unsafe { super::shell::canonicalize_and_check_dir(&raw) } {
        // Extract the path_edit HWND inside the state lock, then release the lock
        // before calling Win32 APIs (reentrancy discipline from with_state_mut).
        let path_edit = with_state_mut(|s| s.path_edit).unwrap_or(0);
        if path_edit != 0 {
            let wide = crate::io::wide(&canonical);
            unsafe { SetWindowTextW(path_edit, wide.as_ptr()) };
        }
        // Trigger a scan with the new path (function lives in desktop/mod.rs).
        // SAFETY: called from the Win32 message pump thread; state is valid.
        unsafe { super::start_scan_from_controls(hwnd) };
    }

    // Bring the window to the foreground regardless of whether the path was valid
    // (D-06.4: silent drop on invalid payload, but still focus the primary window).
    unsafe { SetForegroundWindow(hwnd) };

    1
}
