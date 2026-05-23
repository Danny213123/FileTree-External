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

use super::{Hfont, Hicon, Hwnd};

pub(super) static STATE: OnceLock<Mutex<DesktopState>> = OnceLock::new();

pub(super) struct DesktopState {
    pub(super) initial_path: PathBuf,
    pub(super) hwnd: Hwnd,
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
