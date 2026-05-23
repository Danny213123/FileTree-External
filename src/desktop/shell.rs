#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::thread;

use super::ffi::{
    AppendMenuW, CF_UNICODETEXT, CMINVOKECOMMANDINFO, CloseClipboard, CoTaskMemFree,
    CreatePopupMenu, DestroyMenu, Dword, EmptyClipboard, FILE_ATTRIBUTE_DIRECTORY, GMEM_MOVEABLE,
    GetCursorPos, GetFileAttributesW, GetFullPathNameW, GlobalAlloc, GlobalFree, GlobalLock,
    GlobalUnlock, Hwnd, IContextMenuVtbl, ID_MENU_COPY_PATH, ID_MENU_DELETE, ID_MENU_OPEN,
    ID_MENU_PROPERTIES, ID_MENU_REVEAL, IID_IContextMenu, IID_IShellFolder,
    INVALID_FILE_ATTRIBUTES, IShellFolderVtbl, ITEMIDLIST, InvalidateRect, MB_ICONERROR, MB_OK,
    MF_SEPARATOR, MF_STRING, MessageBoxW, OpenClipboard, Point, SHBindToParent, SHParseDisplayName,
    SW_SHOW, SetClipboardData, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
};
use super::paint::table_top;
use super::state::with_state_mut;
use crate::cli::APP_NAME;

pub(super) unsafe fn show_shell_context_menu(hwnd: Hwnd, path: &str, x: i32, y: i32) -> bool {
    let wide_path = crate::io::wide(path);
    let mut pidl: *mut ITEMIDLIST = null_mut();

    let hr_parse = SHParseDisplayName(wide_path.as_ptr(), null_mut(), &mut pidl, 0, null_mut());
    if hr_parse < 0 || pidl.is_null() {
        return false;
    }

    let mut parent_folder_ptr: *mut *mut IShellFolderVtbl = null_mut();
    let mut relative_pidl: *const ITEMIDLIST = null();

    let hr_bind = SHBindToParent(
        pidl,
        &IID_IShellFolder,
        &mut parent_folder_ptr as *mut *mut *mut IShellFolderVtbl as *mut *mut c_void,
        &mut relative_pidl,
    );
    if hr_bind < 0 || parent_folder_ptr.is_null() || relative_pidl.is_null() {
        CoTaskMemFree(pidl as *mut c_void);
        return false;
    }

    let mut context_menu_ptr: *mut *mut IContextMenuVtbl = null_mut();
    let hr_gui = ((**parent_folder_ptr).GetUIObjectOf)(
        parent_folder_ptr as *mut c_void,
        hwnd,
        1,
        &mut relative_pidl,
        &IID_IContextMenu,
        null_mut(),
        &mut context_menu_ptr as *mut *mut *mut IContextMenuVtbl as *mut *mut c_void,
    );
    if hr_gui < 0 || context_menu_ptr.is_null() {
        ((**parent_folder_ptr).Release)(parent_folder_ptr as *mut c_void);
        CoTaskMemFree(pidl as *mut c_void);
        return false;
    }

    let hmenu = CreatePopupMenu();
    if hmenu == 0 {
        ((**context_menu_ptr).Release)(context_menu_ptr as *mut c_void);
        ((**parent_folder_ptr).Release)(parent_folder_ptr as *mut c_void);
        CoTaskMemFree(pidl as *mut c_void);
        return false;
    }

    let min_id = 1;
    let max_id = 30000;
    let hr_query = ((**context_menu_ptr).QueryContextMenu)(
        context_menu_ptr as *mut c_void,
        hmenu,
        0,
        min_id,
        max_id,
        0, // CMF_NORMAL
    );

    let mut success = false;
    if hr_query >= 0 {
        success = true;
        let selected_id = TrackPopupMenu(
            hmenu,
            TPM_RETURNCMD | TPM_LEFTALIGN | TPM_RIGHTBUTTON,
            x,
            y,
            0,
            hwnd,
            null_mut(),
        );

        if selected_id >= min_id as i32 && selected_id <= max_id as i32 {
            let verb = (selected_id - min_id as i32) as usize;
            let info = CMINVOKECOMMANDINFO {
                cbSize: size_of::<CMINVOKECOMMANDINFO>() as u32,
                fMask: 0,
                hwnd,
                lpVerb: verb as *const u8,
                lpParameters: null(),
                lpDirectory: null(),
                nShow: SW_SHOW,
                dwHotKey: 0,
                hIcon: 0,
            };
            ((**context_menu_ptr).InvokeCommand)(context_menu_ptr as *mut c_void, &info);
        }
    }

    DestroyMenu(hmenu);
    ((**context_menu_ptr).Release)(context_menu_ptr as *mut c_void);
    ((**parent_folder_ptr).Release)(parent_folder_ptr as *mut c_void);
    CoTaskMemFree(pidl as *mut c_void);
    success
}

pub(super) unsafe fn handle_right_click(hwnd: Hwnd, _client_x: i32, client_y: i32) {
    let clicked_node_id = with_state_mut(|state| {
        let row_top = table_top() + 30;
        if client_y < row_top {
            return None;
        }
        let row_h = 27;
        let row_index = state.scroll_row + ((client_y - row_top) / row_h) as usize;
        let node_id = state.visible_rows.get(row_index).copied()?;
        state.selected_id = node_id;
        InvalidateRect(hwnd, null(), 0);
        Some(node_id)
    })
    .flatten();

    let Some(_node_id) = clicked_node_id else {
        return;
    };

    // For TrackPopupMenu, we need screen coordinates of the cursor
    let mut screen_pt = Point { x: 0, y: 0 };
    if GetCursorPos(&mut screen_pt) == 0 {
        return;
    }

    let path = with_state_mut(|state| {
        let scan = state.current_scan.as_ref()?;
        let node = scan.nodes.get(state.selected_id)?;
        Some(node.path.clone())
    })
    .flatten();

    if let Some(p) = path
        && show_shell_context_menu(hwnd, &p, screen_pt.x, screen_pt.y)
    {
        return;
    }

    let menu = CreatePopupMenu();
    if menu == 0 {
        return;
    }

    let label_open = crate::io::wide("Open / Play");
    let label_reveal = crate::io::wide("Reveal in Explorer");
    let label_copy = crate::io::wide("Copy Path");
    let label_delete = crate::io::wide("Delete");
    let label_properties = crate::io::wide("Properties");

    AppendMenuW(menu, MF_STRING, ID_MENU_OPEN as usize, label_open.as_ptr());
    AppendMenuW(
        menu,
        MF_STRING,
        ID_MENU_REVEAL as usize,
        label_reveal.as_ptr(),
    );
    AppendMenuW(
        menu,
        MF_STRING,
        ID_MENU_COPY_PATH as usize,
        label_copy.as_ptr(),
    );
    AppendMenuW(menu, MF_SEPARATOR, 0, null());
    AppendMenuW(
        menu,
        MF_STRING,
        ID_MENU_DELETE as usize,
        label_delete.as_ptr(),
    );
    AppendMenuW(menu, MF_SEPARATOR, 0, null());
    AppendMenuW(
        menu,
        MF_STRING,
        ID_MENU_PROPERTIES as usize,
        label_properties.as_ptr(),
    );

    TrackPopupMenu(
        menu,
        TPM_LEFTALIGN | TPM_RIGHTBUTTON,
        screen_pt.x,
        screen_pt.y,
        0,
        hwnd,
        null(),
    );

    DestroyMenu(menu);
}

pub(super) unsafe fn copy_to_clipboard(text: &str) -> bool {
    let wide_str = crate::io::wide(text);
    let len_bytes = wide_str.len() * 2;
    let h_mem = GlobalAlloc(GMEM_MOVEABLE, len_bytes);
    if h_mem == 0 {
        return false;
    }
    let ptr = GlobalLock(h_mem);
    if ptr.is_null() {
        GlobalFree(h_mem);
        return false;
    }
    std::ptr::copy_nonoverlapping(wide_str.as_ptr() as *const c_void, ptr, len_bytes);
    GlobalUnlock(h_mem);

    if OpenClipboard(0) == 0 {
        GlobalFree(h_mem);
        return false;
    }
    EmptyClipboard();
    let success = SetClipboardData(CF_UNICODETEXT, h_mem) != 0;
    CloseClipboard();
    if !success {
        GlobalFree(h_mem);
    }
    success
}

pub(super) fn show_error_in_thread(hwnd: Hwnd, message: String) {
    thread::spawn(move || unsafe {
        let title = crate::io::wide(APP_NAME);
        let msg = crate::io::wide(&message);
        MessageBoxW(hwnd, msg.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    });
}

pub(super) unsafe fn destroy_icons_on_shutdown(_hwnd: Hwnd) {}

/// Canonicalizes `raw` via `GetFullPathNameW` and verifies it is an existing
/// directory via `GetFileAttributesW`. Returns `Some(canonical_path)` on
/// success, `None` on any failure (non-existent path, not a directory, etc.).
///
/// Used to validate WM_COPYDATA path payloads before triggering a scan (D-06.3).
/// Invalid payloads are silently dropped per D-06.4.
#[cfg(windows)]
pub(crate) unsafe fn canonicalize_and_check_dir(raw: &str) -> Option<String> {
    let raw_w = crate::io::wide(raw);

    // First call: query the required buffer length (no NUL in the count).
    let needed = GetFullPathNameW(
        raw_w.as_ptr(),
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    if needed == 0 {
        return None;
    }

    // Second call: fill the buffer. `needed` includes the NUL terminator.
    let mut buf: Vec<u16> = vec![0u16; needed as usize];
    let written = GetFullPathNameW(
        raw_w.as_ptr(),
        buf.len() as Dword,
        buf.as_mut_ptr(),
        std::ptr::null_mut(),
    );
    // `written` is the char count WITHOUT the NUL. A return of 0 or >= buf.len()
    // indicates truncation or error.
    if written == 0 || written >= buf.len() as Dword {
        return None;
    }
    // Truncate to the actual content (no trailing NUL).
    buf.truncate(written as usize);

    // GetFileAttributesW requires a NUL-terminated string, so clone and append.
    let mut nul_term = buf.clone();
    nul_term.push(0);
    let attrs = GetFileAttributesW(nul_term.as_ptr());
    if attrs == INVALID_FILE_ATTRIBUTES {
        return None;
    }
    if attrs & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return None;
    }

    Some(String::from_utf16_lossy(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn canonicalize_rejects_empty() {
        // An empty string has no canonical directory form.
        assert!(unsafe { canonicalize_and_check_dir("") }.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn canonicalize_accepts_temp_dir() {
        let temp = std::env::temp_dir();
        let temp_str = temp.to_str().expect("temp dir must be valid UTF-8");
        let result = unsafe { canonicalize_and_check_dir(temp_str) };
        assert!(
            result.is_some(),
            "temp dir should be accepted as a directory"
        );
        let canonical = result.unwrap();
        // Canonical path must be absolute (starts with a drive letter on Windows).
        assert!(
            canonical.contains(':'),
            "canonical path should contain a drive colon"
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonicalize_rejects_existing_file() {
        use std::io::Write;
        // Create a temp FILE and assert it is rejected (it's not a directory).
        let mut tmp = std::env::temp_dir();
        tmp.push("filetree_test_not_a_dir.tmp");
        {
            let mut f = std::fs::File::create(&tmp).expect("create temp file");
            f.write_all(b"test").expect("write temp file");
        }
        let path_str = tmp.to_str().expect("path to str");
        let result = unsafe { canonicalize_and_check_dir(path_str) };
        // Clean up before asserting so the file is removed even on failure.
        let _ = std::fs::remove_file(&tmp);
        assert!(
            result.is_none(),
            "a file should be rejected, not accepted as a directory"
        );
    }
}
