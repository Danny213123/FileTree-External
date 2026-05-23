#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::collections::BTreeSet;
use std::ffi::{OsStr, c_void};
use std::fs;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::Command;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;

use crate::cli::APP_NAME;
use crate::io::{default_thread_count, epoch_ms_to_utc, path_to_string, reveal_path};
use crate::model::*;
use crate::scan::scan_path_with_progress;

mod state;
use state::{DesktopState, STATE, ScanDone, ScanProgressInfo, with_state_mut};
mod ffi;
use ffi::*;

static DARK_BRUSH: OnceLock<Hbrush> = OnceLock::new();
static LIGHT_BRUSH: OnceLock<Hbrush> = OnceLock::new();
static DARK_MODE_ATOMIC: AtomicBool = AtomicBool::new(true);

unsafe fn enable_visual_styles() {
    let manifest_content = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
<assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="FileTree" type="win32"/>
<dependency>
<dependentAssembly>
    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
</dependentAssembly>
</dependency>
</assembly>"#;

    let mut temp_path = std::env::temp_dir();
    temp_path.push("filetree.manifest");
    if std::fs::write(&temp_path, manifest_content).is_ok() {
        let path_wide = wide(&temp_path.to_string_lossy());
        let act_ctx = ACTCTXW {
            cbSize: size_of::<ACTCTXW>() as Dword,
            dwFlags: 0,
            lpSource: path_wide.as_ptr(),
            wProcessorArchitecture: 0,
            wLangId: 0,
            lpAssemblyDirectory: null(),
            lpResourceName: null(),
            lpApplicationName: null(),
            hModule: 0,
        };
        let h_ctx = CreateActCtxW(&act_ctx);
        if h_ctx != -1 {
            let mut cookie: UlongPtr = 0;
            ActivateActCtx(h_ctx, &mut cookie);
        }
    }
}

pub(crate) fn run(initial_path: PathBuf) -> io::Result<()> {
    unsafe {
        enable_visual_styles();
        let com_initialized = CoInitializeEx(null_mut(), COINIT_APARTMENTTHREADED) >= 0;
        let controls = InitCommonControlsEx {
            dwSize: size_of::<InitCommonControlsEx>() as Dword,
            dwICC: ICC_LISTVIEW_CLASSES,
        };
        InitCommonControlsEx(&controls);

        let _ = STATE.set(Mutex::new(DesktopState::new(initial_path)));

        let h_instance = GetModuleHandleW(null());
        let class_name = wide("FileTreeDesktopWindow");
        let cursor = LoadCursorW(0, IDC_ARROW as *const u16);
        let app_icon = LoadImageW(
            0,
            IDI_APPLICATION as *const u16,
            IMAGE_ICON,
            0,
            0,
            LR_SHARED,
        ) as Hicon;
        let window_class = WndClassW {
            style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: h_instance,
            hIcon: app_icon,
            hCursor: cursor,
            hbrBackground: dark_brush(),
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&window_class);

        let title = wide(&format!("{APP_NAME} - Native Disk Explorer"));
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1280,
            760,
            0,
            0,
            h_instance,
            null_mut(),
        );

        if hwnd == 0 {
            if com_initialized {
                CoUninitialize();
            }
            return Err(io::Error::last_os_error());
        }

        set_window_dark_mode(hwnd, true);

        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);
        start_scan_from_controls(hwnd);

        let mut message: Msg = zeroed();
        while GetMessageW(&mut message, 0, 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        if com_initialized {
            CoUninitialize();
        }
    }

    Ok(())
}

unsafe extern "system" fn window_proc(
    hwnd: Hwnd,
    msg: Uint,
    wparam: Wparam,
    lparam: Lparam,
) -> Lresult {
    match msg {
        WM_CREATE => {
            create_controls(hwnd);
            resize_controls(hwnd);
            0
        }
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            paint_window(hwnd);
            0
        }
        WM_SIZE => {
            resize_controls(hwnd);
            InvalidateRect(hwnd, null(), 1);
            0
        }
        WM_LBUTTONDOWN => {
            handle_mouse_click(hwnd, lparam, false);
            0
        }
        WM_LBUTTONDBLCLK => {
            handle_mouse_click(hwnd, lparam, true);
            0
        }
        WM_RBUTTONDOWN => {
            let y = hiword_signed(lparam);
            with_state_mut(|state| {
                let row_top = table_top() + 30;
                if y >= row_top {
                    let row_h = 27;
                    let row_index = state.scroll_row + ((y - row_top) / row_h) as usize;
                    if let Some(node_id) = state.visible_rows.get(row_index).copied() {
                        state.selected_id = node_id;
                        InvalidateRect(hwnd, null(), 0);
                    }
                }
            });
            0
        }
        WM_RBUTTONUP => {
            let x = loword_signed(lparam);
            let y = hiword_signed(lparam);
            handle_right_click(hwnd, x, y);
            0
        }
        WM_MOUSEMOVE => {
            let x = loword_signed(lparam);
            let y = hiword_signed(lparam);
            handle_mouse_move(hwnd, x, y);
            0
        }
        WM_MOUSEWHEEL => {
            handle_mouse_wheel(hwnd, wparam);
            0
        }
        WM_KEYDOWN => {
            handle_key(hwnd, wparam);
            0
        }
        WM_COMMAND => {
            let id = (wparam & 0xffff) as isize;
            match id {
                ID_BROWSE_BUTTON => choose_and_set_directory(hwnd),
                ID_SCAN_BUTTON | ID_REFRESH_BUTTON => start_scan_from_controls(hwnd),
                ID_STOP_BUTTON => stop_current_scan(),
                ID_EXPAND_BUTTON => expand_all_directories(),
                ID_COLLAPSE_BUTTON => collapse_to_root(),
                ID_COLUMNS_BUTTON => toggle_path_column(),
                ID_FILES_CHECK => {
                    with_state_mut(|state| {
                        state.show_files = button_checked(state.files_check);
                        render_list(state);
                    });
                }
                ID_DARK_CHECK => {
                    let status_text = with_state_mut(|state| {
                        state.dark_mode = button_checked(state.dark_check);
                        DARK_MODE_ATOMIC.store(state.dark_mode, Ordering::Relaxed);
                        apply_theme(state);
                        render_list(state)
                    })
                    .flatten();
                    if let Some(text) = status_text {
                        with_state_mut(|state| set_window_text(state.status, &text));
                    }
                }
                ID_MENU_OPEN => {
                    let path = with_state_mut(|state| {
                        let scan = state.current_scan.as_ref()?;
                        let node = scan.nodes.get(state.selected_id)?;
                        Some(node.path.clone())
                    })
                    .flatten();
                    if let Some(p) = path {
                        thread::spawn(move || unsafe {
                            ShellExecuteW(
                                0,
                                wide("open").as_ptr(),
                                wide(&p).as_ptr(),
                                null(),
                                null(),
                                5,
                            );
                        });
                    }
                }
                ID_MENU_REVEAL => {
                    let path = with_state_mut(|state| {
                        let scan = state.current_scan.as_ref()?;
                        let node = scan.nodes.get(state.selected_id)?;
                        Some(node.path.clone())
                    })
                    .flatten();
                    if let Some(p) = path {
                        thread::spawn(move || {
                            let _ = reveal_path(&p);
                        });
                    }
                }
                ID_MENU_COPY_PATH => {
                    let path = with_state_mut(|state| {
                        let scan = state.current_scan.as_ref()?;
                        let node = scan.nodes.get(state.selected_id)?;
                        Some(node.path.clone())
                    })
                    .flatten();
                    if let Some(p) = path {
                        unsafe {
                            copy_to_clipboard(&p);
                        }
                    }
                }
                ID_MENU_DELETE => {
                    let path = with_state_mut(|state| {
                        let scan = state.current_scan.as_ref()?;
                        let node = scan.nodes.get(state.selected_id)?;
                        Some(node.path.clone())
                    })
                    .flatten();
                    if let Some(p) = path {
                        unsafe {
                            let title = wide("Confirm Delete");
                            let msg = wide(&format!(
                                "Are you sure you want to permanently delete this item?\n\n{}",
                                p
                            ));
                            let response = MessageBoxW(
                                hwnd,
                                msg.as_ptr(),
                                title.as_ptr(),
                                0x00000004 | 0x00000020, // MB_YESNO | MB_ICONQUESTION
                            );
                            if response == 6 {
                                // IDYES is 6
                                thread::spawn(move || {
                                    let path_buf = PathBuf::from(p);
                                    let delete_result = if path_buf.is_dir() {
                                        fs::remove_dir_all(&path_buf)
                                    } else {
                                        fs::remove_file(&path_buf)
                                    };
                                    match delete_result {
                                        Ok(_) => {
                                            PostMessageW(
                                                hwnd,
                                                WM_COMMAND,
                                                ID_REFRESH_BUTTON as Wparam,
                                                0,
                                            );
                                        }
                                        Err(err) => {
                                            let err_msg =
                                                format!("Failed to delete item:\n{}", err);
                                            show_error_in_thread(hwnd, err_msg);
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
                ID_MENU_PROPERTIES => {
                    let path = with_state_mut(|state| {
                        let scan = state.current_scan.as_ref()?;
                        let node = scan.nodes.get(state.selected_id)?;
                        Some(node.path.clone())
                    })
                    .flatten();
                    if let Some(p) = path {
                        thread::spawn(move || {
                            use std::os::windows::process::CommandExt;
                            const CREATE_NO_WINDOW: u32 = 0x08000000;
                            let script = format!(
                                "(New-Object -ComObject Shell.Application).NameSpace((Split-Path '{}')).ParseName((Split-Path '{}' -Leaf)).InvokeVerb('Properties')",
                                p.replace("'", "''"),
                                p.replace("'", "''")
                            );
                            let _ = Command::new("powershell")
                                .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
                                .creation_flags(CREATE_NO_WINDOW)
                                .spawn();
                        });
                    }
                }
                _ => {}
            }
            0
        }
        WM_NOTIFY => {
            let _ = lparam;
            0
        }
        WM_SCAN_DONE => {
            if lparam != 0 {
                let payload = Box::from_raw(lparam as *mut ScanDone);
                finish_scan(hwnd, payload.result, payload.canceled);
            }
            0
        }
        WM_SCAN_PROGRESS => {
            if lparam != 0 {
                let payload = Box::from_raw(lparam as *mut ScanProgressInfo);
                apply_scan_progress(
                    payload.node_count,
                    payload.elapsed_ms,
                    payload.partial_result,
                );
            }
            0
        }
        WM_CTLCOLOREDIT | WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => {
            // Must NOT acquire the STATE mutex here Ã¢â‚¬â€ this message is sent
            // synchronously by child controls during repaint, which can
            // happen while the mutex is already held (reentrant call).
            // Using Mutex::lock() here would deadlock.
            let hdc = wparam as Hdc;
            if DARK_MODE_ATOMIC.load(Ordering::Relaxed) {
                SetTextColor(hdc, rgb(238, 242, 246));
                SetBkColor(hdc, rgb(24, 26, 30));
                dark_brush() as Lresult
            } else {
                SetTextColor(hdc, rgb(18, 22, 27));
                SetBkColor(hdc, rgb(242, 244, 247));
                light_brush() as Lresult
            }
        }
        WM_DESTROY => {
            stop_current_scan();
            destroy_cached_icons();
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

unsafe fn create_controls(hwnd: Hwnd) {
    let h_instance = GetModuleHandleW(null());
    with_state_mut(|state| {
        state.hwnd = hwnd;
        let face = wide("Segoe UI");
        state.font = CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr());
        state.bold_font = CreateFontW(-15, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr());

        state.path_edit = create_child(
            hwnd,
            h_instance,
            "EDIT",
            &path_to_string(&state.initial_path),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
            0,
            ID_PATH_EDIT,
        );
        state.browse_button = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Select Directory",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0,
            ID_BROWSE_BUTTON,
        );
        state.scan_button = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Scan",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0,
            ID_SCAN_BUTTON,
        );
        state.stop_button = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Stop",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0,
            ID_STOP_BUTTON,
        );
        state.refresh_button = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Refresh",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0,
            ID_REFRESH_BUTTON,
        );
        state.expand_button = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Expand",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0,
            ID_EXPAND_BUTTON,
        );
        state.collapse_button = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Collapse",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0,
            ID_COLLAPSE_BUTTON,
        );
        state.columns_button = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Path Column",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
            0,
            ID_COLUMNS_BUTTON,
        );
        state.hidden_check = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Hidden",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
            0,
            ID_HIDDEN_CHECK,
        );
        state.files_check = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Files",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
            0,
            ID_FILES_CHECK,
        );
        state.follow_check = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Links",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
            0,
            ID_FOLLOW_CHECK,
        );
        state.dark_check = create_child(
            hwnd,
            h_instance,
            "BUTTON",
            "Dark",
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
            0,
            ID_DARK_CHECK,
        );
        state.status = create_child(
            hwnd,
            h_instance,
            "STATIC",
            "Ready",
            WS_CHILD | WS_VISIBLE,
            0,
            ID_STATUS,
        );
        state.list = 0;

        SendMessageW(state.hidden_check, BM_SETCHECK, BST_CHECKED, 0);
        SendMessageW(state.files_check, BM_SETCHECK, BST_CHECKED, 0);
        SendMessageW(state.dark_check, BM_SETCHECK, BST_CHECKED, 0);
        for control in [
            state.path_edit,
            state.browse_button,
            state.scan_button,
            state.stop_button,
            state.refresh_button,
            state.expand_button,
            state.collapse_button,
            state.columns_button,
            state.hidden_check,
            state.files_check,
            state.follow_check,
            state.dark_check,
            state.status,
        ] {
            SendMessageW(control, WM_SETFONT, state.font as Wparam, 1);
        }
        apply_theme(state);
        EnableWindow(state.stop_button, 0);
    });
}

unsafe fn create_child(
    parent: Hwnd,
    h_instance: Hinstance,
    class_name: &str,
    text: &str,
    style: Dword,
    ex_style: Dword,
    id: isize,
) -> Hwnd {
    let class = wide(class_name);
    let text = wide(text);
    CreateWindowExW(
        ex_style,
        class.as_ptr(),
        text.as_ptr(),
        style,
        0,
        0,
        10,
        10,
        parent,
        id as Hmenu,
        h_instance,
        null_mut(),
    )
}

unsafe fn resize_controls(hwnd: Hwnd) {
    let mut rect: Rect = zeroed();
    if GetClientRect(hwnd, &mut rect) == 0 {
        return;
    }

    let width = (rect.right - rect.left).max(500);
    let height = (rect.bottom - rect.top).max(300);
    with_state_mut(|state| {
        let margin = 10;
        let browse_w = 110;
        let button_h = 26;
        let path_y = 38;
        let actions_y = 74;
        let status_h = 26;

        // Path edit takes all width minus browse button
        let path_w = (width - margin * 2 - browse_w - 8).max(260);

        MoveWindow(state.path_edit, margin, path_y, path_w, button_h, 1);
        MoveWindow(
            state.browse_button,
            margin + path_w + 8,
            path_y,
            browse_w,
            button_h,
            1,
        );

        // Dynamically layout row 2 controls based on active tab
        let tab = state.active_tab;
        let mut current_x = margin;
        let spacing = 6;
        let show = 5;
        let hide = 0;

        // 1. Home tab controls (Scan, Stop, Refresh, Expand, Collapse)
        if tab == 1 {
            ShowWindow(state.scan_button, show);
            MoveWindow(state.scan_button, current_x, actions_y, 75, button_h, 1);
            current_x += 75 + spacing;

            ShowWindow(state.stop_button, show);
            MoveWindow(state.stop_button, current_x, actions_y, 75, button_h, 1);
            current_x += 75 + spacing;

            ShowWindow(state.refresh_button, show);
            MoveWindow(state.refresh_button, current_x, actions_y, 80, button_h, 1);
            current_x += 80 + spacing;

            ShowWindow(state.expand_button, show);
            MoveWindow(state.expand_button, current_x, actions_y, 80, button_h, 1);
            current_x += 80 + spacing;

            ShowWindow(state.collapse_button, show);
            MoveWindow(state.collapse_button, current_x, actions_y, 90, button_h, 1);
        } else {
            ShowWindow(state.scan_button, hide);
            ShowWindow(state.stop_button, hide);
            ShowWindow(state.refresh_button, hide);
            ShowWindow(state.expand_button, hide);
            ShowWindow(state.collapse_button, hide);
        }

        // 2. Scan tab controls (Hidden, Files, Links)
        if tab == 2 {
            ShowWindow(state.hidden_check, show);
            MoveWindow(state.hidden_check, current_x, actions_y, 92, button_h, 1);
            current_x += 92 + spacing;

            ShowWindow(state.files_check, show);
            MoveWindow(state.files_check, current_x, actions_y, 78, button_h, 1);
            current_x += 78 + spacing;

            ShowWindow(state.follow_check, show);
            MoveWindow(state.follow_check, current_x, actions_y, 78, button_h, 1);
        } else if tab != 4 && tab != 3 {
            ShowWindow(state.hidden_check, hide);
            ShowWindow(state.files_check, hide);
            ShowWindow(state.follow_check, hide);
        }

        // 3. View tab controls (Columns, Files, Dark)
        if tab == 3 {
            ShowWindow(state.columns_button, show);
            MoveWindow(state.columns_button, current_x, actions_y, 100, button_h, 1);
            current_x += 100 + spacing;

            ShowWindow(state.files_check, show);
            MoveWindow(state.files_check, current_x, actions_y, 78, button_h, 1);
            current_x += 78 + spacing;

            ShowWindow(state.dark_check, show);
            MoveWindow(state.dark_check, current_x, actions_y, 72, button_h, 1);
        } else if tab != 4 {
            ShowWindow(state.columns_button, hide);
            if tab != 2 {
                ShowWindow(state.files_check, hide);
            }
            ShowWindow(state.dark_check, hide);
        }

        // 4. Options tab controls (Hidden, Files, Links, Dark)
        if tab == 4 {
            ShowWindow(state.hidden_check, show);
            MoveWindow(state.hidden_check, current_x, actions_y, 92, button_h, 1);
            current_x += 92 + spacing;

            ShowWindow(state.files_check, show);
            MoveWindow(state.files_check, current_x, actions_y, 78, button_h, 1);
            current_x += 78 + spacing;

            ShowWindow(state.follow_check, show);
            MoveWindow(state.follow_check, current_x, actions_y, 78, button_h, 1);
            current_x += 78 + spacing;

            ShowWindow(state.dark_check, show);
            MoveWindow(state.dark_check, current_x, actions_y, 72, button_h, 1);
        }

        // 5. Help / File tabs (No specific controls shown)
        if tab == 0 || tab == 5 {
            ShowWindow(state.scan_button, hide);
            ShowWindow(state.stop_button, hide);
            ShowWindow(state.refresh_button, hide);
            ShowWindow(state.expand_button, hide);
            ShowWindow(state.collapse_button, hide);
            ShowWindow(state.columns_button, hide);
            ShowWindow(state.hidden_check, hide);
            ShowWindow(state.files_check, hide);
            ShowWindow(state.follow_check, hide);
            ShowWindow(state.dark_check, hide);
        }

        MoveWindow(
            state.status,
            margin,
            height - status_h,
            width - margin * 2,
            status_h,
            1,
        );
    });
}

unsafe fn start_scan_from_controls(hwnd: Hwnd) {
    // Collect everything we need from state, then release the mutex
    // BEFORE calling any Win32 APIs that could send messages back.
    let scan_setup = with_state_mut(|state| {
        if state.scanning {
            return None;
        }
        let path = get_window_text(state.path_edit);
        state.scanning = true;
        state.current_scan = None;
        state.visible_rows.clear();
        state.expanded.clear();
        state.expanded.insert(0);
        for (_key, icon) in state.icon_cache.drain() {
            if icon != 0 {
                DestroyIcon(icon);
            }
        }
        state.show_files = button_checked(state.files_check);
        let cancel_flag = Arc::new(AtomicBool::new(false));
        state.current_cancel = Some(Arc::clone(&cancel_flag));

        let options = ScanOptions {
            root: PathBuf::from(path),
            include_hidden: button_checked(state.hidden_check),
            follow_links: button_checked(state.follow_check),
            exclude_patterns: Vec::new(),
            max_depth: None,
            threads: default_thread_count(),
        };
        let controls = (
            state.status,
            state.path_edit,
            state.browse_button,
            state.scan_button,
            state.refresh_button,
            state.stop_button,
        );
        Some((options, cancel_flag, controls))
    })
    .flatten();

    let Some((options, cancel, controls)) = scan_setup else {
        return;
    };

    // Win32 calls OUTSIDE the mutex Ã¢â‚¬â€ safe from deadlock.
    set_window_text(controls.0, "Scanning...");
    EnableWindow(controls.1, 0);
    EnableWindow(controls.2, 0);
    EnableWindow(controls.3, 0);
    EnableWindow(controls.4, 0);
    EnableWindow(controls.5, 1);
    InvalidateRect(hwnd, null(), 1);

    thread::spawn(move || {
        let progress_cancel = Arc::clone(&cancel);
        let result = scan_path_with_progress(
            options,
            Arc::clone(&cancel),
            |node_count, elapsed_ms, partial| {
                if !progress_cancel.load(Ordering::Relaxed) {
                    let payload = Box::new(ScanProgressInfo {
                        node_count,
                        elapsed_ms,
                        partial_result: partial,
                    });
                    unsafe {
                        PostMessageW(hwnd, WM_SCAN_PROGRESS, 0, Box::into_raw(payload) as Lparam);
                    }
                }
            },
        )
        .map_err(|error| error.to_string());
        let canceled = cancel.load(Ordering::Relaxed);
        let payload = Box::new(ScanDone { result, canceled });
        unsafe {
            PostMessageW(hwnd, WM_SCAN_DONE, 0, Box::into_raw(payload) as Lparam);
        }
    });
}

unsafe fn finish_scan(hwnd: Hwnd, result: Result<ScanResult, String>, canceled: bool) {
    // Collect deferred Win32 actions from state, then execute them
    // AFTER releasing the mutex to avoid deadlock.
    let deferred = with_state_mut(|state| {
        state.scanning = false;
        state.current_cancel = None;
        let controls = (
            state.status,
            state.path_edit,
            state.browse_button,
            state.scan_button,
            state.refresh_button,
            state.stop_button,
        );

        match result {
            Ok(scan) => {
                let elapsed = scan.elapsed_ms;
                let node_count = scan.nodes.len();
                let root_size = scan.nodes.first().map(|node| node.size).unwrap_or(0);
                state.current_scan = Some(Arc::new(scan));
                state.expanded.clear();
                state.expanded.insert(0);
                let list_status = render_list(state);
                let status_message = if canceled {
                    format!(
                        "Stopped after {node_count} nodes in {} | partial total {}",
                        format_duration_ui(elapsed),
                        format_bytes_ui(root_size)
                    )
                } else {
                    format!(
                        "Scanned {node_count} nodes in {} | {}",
                        format_duration_ui(elapsed),
                        format_bytes_ui(root_size)
                    )
                };
                let _ = list_status; // render_list already invalidated
                (controls, Some(status_message), None)
            }
            Err(message) => (controls, Some("Scan failed".to_string()), Some(message)),
        }
    });

    if let Some((controls, status_msg, error_msg)) = deferred {
        // Win32 calls OUTSIDE the mutex.
        EnableWindow(controls.1, 1);
        EnableWindow(controls.2, 1);
        EnableWindow(controls.3, 1);
        EnableWindow(controls.4, 1);
        EnableWindow(controls.5, 0);
        if let Some(msg) = status_msg {
            set_window_text(controls.0, &msg);
        }
        if let Some(msg) = error_msg {
            show_error(hwnd, &msg);
        }
    }
}

unsafe fn apply_scan_progress(
    node_count: usize,
    elapsed_ms: u128,
    partial_result: Option<ScanResult>,
) {
    // Update the scan result inside state and trigger render_list if a partial result is present.
    let status_hwnd = with_state_mut(|state| {
        if !state.scanning {
            return None;
        }
        if let Some(scan) = partial_result {
            state.current_scan = Some(Arc::new(scan));
            let _ = render_list(state);
        }
        Some(state.status)
    })
    .flatten();

    // Win32 call OUTSIDE the mutex Ã¢â‚¬â€ safe from deadlock.
    if let Some(status) = status_hwnd {
        set_window_text(
            status,
            &format!(
                "Scanning... {} nodes | {} elapsed",
                format_count_ui(node_count as u64),
                format_duration_ui(elapsed_ms)
            ),
        );
    }
}

unsafe fn stop_current_scan() {
    let status = with_state_mut(|state| {
        if let Some(cancel) = &state.current_cancel {
            cancel.store(true, Ordering::Relaxed);
            Some(state.status)
        } else {
            None
        }
    })
    .flatten();
    if let Some(status) = status {
        set_window_text(status, "Stopping scan...");
    }
}

unsafe fn destroy_cached_icons() {
    with_state_mut(|state| {
        for (_key, icon) in state.icon_cache.drain() {
            if icon != 0 {
                DestroyIcon(icon);
            }
        }
    });
}

unsafe fn expand_all_directories() {
    let deferred = with_state_mut(|state| {
        if let Some(scan) = &state.current_scan {
            state.expanded = scan
                .nodes
                .iter()
                .filter(|node| node.is_dir)
                .map(|node| node.id)
                .collect();
            render_list(state)
        } else {
            None
        }
    })
    .flatten();
    if let Some(text) = deferred {
        with_state_mut(|state| set_window_text(state.status, &text));
    }
}

unsafe fn collapse_to_root() {
    let deferred = with_state_mut(|state| {
        state.expanded.clear();
        state.expanded.insert(0);
        render_list(state)
    })
    .flatten();
    if let Some(text) = deferred {
        with_state_mut(|state| set_window_text(state.status, &text));
    }
}

unsafe fn toggle_path_column() {
    let deferred = with_state_mut(|state| {
        state.path_column_visible = !state.path_column_visible;
        update_column_widths(state);
        let msg = if state.path_column_visible {
            "Path column shown"
        } else {
            "Path column hidden"
        };
        (state.status, msg.to_string())
    });
    if let Some((status, msg)) = deferred {
        set_window_text(status, &msg);
    }
}

unsafe fn choose_and_set_directory(hwnd: Hwnd) {
    if let Some(path) = browse_for_directory(hwnd) {
        let hwnds = with_state_mut(|state| (state.path_edit, state.status));
        if let Some((path_edit, status)) = hwnds {
            set_window_text(path_edit, &path);
            set_window_text(status, "Directory selected");
        }
    }
}

unsafe fn browse_for_directory(hwnd: Hwnd) -> Option<String> {
    let title = wide("Select a directory to scan");
    let mut display_name = [0u16; 260];
    let mut info = BrowseInfoW {
        hwndOwner: hwnd,
        pidlRoot: null_mut(),
        pszDisplayName: display_name.as_mut_ptr(),
        lpszTitle: title.as_ptr(),
        ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE,
        lpfn: None,
        lParam: 0,
        iImage: 0,
    };
    let pidl = SHBrowseForFolderW(&mut info);
    if pidl.is_null() {
        return None;
    }

    let mut path = [0u16; 260];
    let ok = SHGetPathFromIDListW(pidl, path.as_mut_ptr()) != 0;
    CoTaskMemFree(pidl);
    if !ok {
        return None;
    }

    let len = path.iter().position(|ch| *ch == 0).unwrap_or(path.len());
    Some(String::from_utf16_lossy(&path[..len]))
}

unsafe fn icon_for_node(state: &mut DesktopState, node: &NodeRecord) -> Hicon {
    let key = if node.is_dir {
        "[dir]".to_string()
    } else if node.extension.is_empty() {
        "[file]".to_string()
    } else {
        format!(".{}", node.extension)
    };

    if let Some(icon) = state.icon_cache.get(&key) {
        return *icon;
    }

    let sample_path = if node.is_dir {
        "folder".to_string()
    } else if node.extension.is_empty() {
        "file".to_string()
    } else {
        format!("file.{0}", node.extension)
    };
    let sample_path = wide(&sample_path);
    let attributes = if node.is_dir {
        FILE_ATTRIBUTE_DIRECTORY
    } else {
        FILE_ATTRIBUTE_NORMAL
    };
    let mut info: ShFileInfoW = zeroed();
    SHGetFileInfoW(
        sample_path.as_ptr(),
        attributes,
        &mut info,
        size_of::<ShFileInfoW>() as Uint,
        SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
    );
    state.icon_cache.insert(key, info.hIcon);
    info.hIcon
}

unsafe fn apply_theme(state: &mut DesktopState) {
    set_window_dark_mode(state.hwnd, state.dark_mode);
    let theme = if state.dark_mode {
        wide("DarkMode_Explorer")
    } else {
        wide("Explorer")
    };

    // Setting Explorer themes on buttons and checkboxes strips their ComCtl32 v6
    // modern visuals and falls back to flat ugly legacy classic styles.
    // We only set it on edit and status static controls.
    SetWindowTheme(state.path_edit, theme.as_ptr(), null());
    SetWindowTheme(state.status, theme.as_ptr(), null());

    let buttons = [
        state.browse_button,
        state.scan_button,
        state.stop_button,
        state.refresh_button,
        state.expand_button,
        state.collapse_button,
        state.columns_button,
        state.hidden_check,
        state.files_check,
        state.follow_check,
        state.dark_check,
    ];
    for btn in buttons {
        SetWindowTheme(btn, null(), null());
    }

    update_column_widths(state);
    InvalidateRect(state.hwnd, null(), 1);
}

unsafe fn update_column_widths(state: &DesktopState) {
    InvalidateRect(state.hwnd, null(), 0);
}

unsafe fn set_window_dark_mode(hwnd: Hwnd, enabled: bool) {
    let value: i32 = if enabled { 1 } else { 0 };
    let value_ptr = &value as *const i32 as *const c_void;
    DwmSetWindowAttribute(hwnd, 20, value_ptr, size_of::<i32>() as Dword);
    DwmSetWindowAttribute(hwnd, 19, value_ptr, size_of::<i32>() as Dword);
}

unsafe fn dark_brush() -> Hbrush {
    *DARK_BRUSH.get_or_init(|| CreateSolidBrush(rgb(24, 26, 30)))
}

unsafe fn light_brush() -> Hbrush {
    *LIGHT_BRUSH.get_or_init(|| CreateSolidBrush(rgb(242, 244, 247)))
}

const fn rgb(red: u8, green: u8, blue: u8) -> Dword {
    red as Dword | ((green as Dword) << 8) | ((blue as Dword) << 16)
}

unsafe fn paint_window(hwnd: Hwnd) {
    let mut paint: PaintStruct = zeroed();
    let hdc = BeginPaint(hwnd, &mut paint);
    if hdc == 0 {
        return;
    }

    let mut rect: Rect = zeroed();
    GetClientRect(hwnd, &mut rect);
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    if width > 0 && height > 0 {
        let mem_dc = CreateCompatibleDC(hdc);
        if mem_dc != 0 {
            let mem_bmp = CreateCompatibleBitmap(hdc, width, height);
            if mem_bmp != 0 {
                let old_bmp = SelectObject(mem_dc, mem_bmp);

                with_state_mut(|state| {
                    fill_rect(mem_dc, rect, palette_bg(state));
                    draw_toolbar_background(mem_dc, rect, state);
                    draw_table(mem_dc, rect, state);
                });

                BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);

                SelectObject(mem_dc, old_bmp);
                DeleteObject(mem_bmp);
            }
            DeleteDC(mem_dc);
        }
    }

    EndPaint(hwnd, &paint);
}

unsafe fn draw_toolbar_background(hdc: Hdc, client: Rect, state: &DesktopState) {
    // 1. Draw top tab bar background
    let tab_bar_bg = if state.dark_mode {
        rgb(16, 17, 20)
    } else {
        rgb(215, 219, 226)
    };
    let tab_bar_rect = Rect {
        left: 0,
        top: 0,
        right: client.right,
        bottom: 30,
    };
    fill_rect(hdc, tab_bar_rect, tab_bar_bg);

    // 2. Draw active tab ("Home") and other tabs
    let tabs = [
        ("File", 10, 60),
        ("Home", 60, 120),
        ("Scan", 120, 180),
        ("View", 180, 240),
        ("Options", 240, 310),
        ("Help", 310, 370),
    ];

    let old_font = SelectObject(hdc, state.bold_font as Hgdobj);
    SetBkMode(hdc, TRANSPARENT);

    for (i, &(name, left, right)) in tabs.iter().enumerate() {
        let is_active = state.active_tab == i;
        let tab_rect = Rect {
            left,
            top: 0,
            right,
            bottom: 30,
        };

        if is_active {
            // Active tab background (palette_panel)
            fill_rect(hdc, tab_rect, palette_panel(state));

            // Beautiful blue bottom accent line for active tab
            let accent_color = if state.dark_mode {
                rgb(92, 93, 242)
            } else {
                rgb(65, 122, 232)
            };
            let accent_rect = Rect {
                left,
                top: 27,
                right,
                bottom: 30,
            };
            fill_rect(hdc, accent_rect, accent_color);

            let text_color = if state.dark_mode {
                rgb(255, 255, 255)
            } else {
                rgb(10, 11, 13)
            };
            SetTextColor(hdc, text_color);
        } else {
            let text_color = if state.dark_mode {
                rgb(150, 155, 160)
            } else {
                rgb(80, 85, 90)
            };
            SetTextColor(hdc, text_color);
        }

        let mut text_rect = tab_rect;
        draw_text(
            hdc,
            name,
            &mut text_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        );
    }

    SelectObject(hdc, old_font);

    // 3. Draw main ribbon panel body below the tabs
    let ribbon_body_rect = Rect {
        left: 0,
        top: 30,
        right: client.right,
        bottom: table_top() - 4,
    };
    fill_rect(hdc, ribbon_body_rect, palette_panel(state));

    // 4. Draw separator line below ribbon
    let separator_rect = Rect {
        left: 0,
        top: table_top() - 4,
        right: client.right,
        bottom: table_top() - 3,
    };
    fill_rect(hdc, separator_rect, palette_line(state));
}

unsafe fn draw_table(hdc: Hdc, client: Rect, state: &mut DesktopState) {
    let table_left = 10;
    let table_right = client.right - 10;
    let header_top = table_top();
    let header_h = 30;
    let row_h = 27;
    let row_top = header_top + header_h;
    let bottom = client.bottom - 30;

    let table_bg = Rect {
        left: table_left,
        top: header_top,
        right: table_right,
        bottom,
    };
    fill_rect(hdc, table_bg, palette_table(state));

    SelectObject(hdc, state.bold_font as Hgdobj);
    SetBkMode(hdc, TRANSPARENT);
    draw_header(hdc, table_left, table_right, header_top, header_h, state);

    SelectObject(hdc, state.font as Hgdobj);
    if state.visible_rows.is_empty() {
        let message = if state.scanning {
            "Scanning... discovered rows will appear here"
        } else {
            "Select a directory, then scan"
        };
        let mut empty_rect = Rect {
            left: table_left + 12,
            top: row_top + 14,
            right: table_right - 12,
            bottom: row_top + 46,
        };
        SetTextColor(hdc, palette_muted(state));
        draw_text(
            hdc,
            message,
            &mut empty_rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        return;
    }

    let visible_capacity = ((bottom - row_top).max(row_h) / row_h) as usize;
    if state.scroll_row + visible_capacity > state.visible_rows.len() {
        state.scroll_row = state.visible_rows.len().saturating_sub(visible_capacity);
    }

    let Some(scan) = state.current_scan.clone() else {
        return;
    };

    for screen_index in 0..visible_capacity {
        let row_index = state.scroll_row + screen_index;
        let Some(node_id) = state.visible_rows.get(row_index).copied() else {
            break;
        };
        let node = &scan.nodes[node_id];
        let top = row_top + (screen_index as i32 * row_h);
        draw_row(
            hdc,
            table_left,
            table_right,
            top,
            row_h,
            state,
            &scan,
            node,
            row_index,
        );
    }
}

unsafe fn draw_header(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &DesktopState,
) {
    fill_rect(
        hdc,
        Rect {
            left,
            top,
            right,
            bottom: top + height,
        },
        palette_header(state),
    );
    let mut x = left;
    for (label, width, align) in columns(state) {
        let col_right = (x + width).min(right);
        let mut text_rect = Rect {
            left: x + 8,
            top,
            right: col_right - 8,
            bottom: top + height,
        };
        SetTextColor(hdc, palette_text(state));
        draw_text(
            hdc,
            label,
            &mut text_rect,
            if align {
                DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
            } else {
                DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS
            },
        );
        fill_rect(
            hdc,
            Rect {
                left: col_right,
                top,
                right: col_right + 1,
                bottom: top + height,
            },
            palette_line(state),
        );
        x = col_right;
        if x >= right {
            break;
        }
    }
    fill_rect(
        hdc,
        Rect {
            left,
            top: top + height - 1,
            right,
            bottom: top + height,
        },
        palette_line(state),
    );
}

unsafe fn draw_row(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &mut DesktopState,
    scan: &ScanResult,
    node: &NodeRecord,
    row_index: usize,
) {
    let selected = state.selected_id == node.id;
    let hovered = state.hovered_id == Some(node.id);
    let bg = if selected {
        palette_selected(state)
    } else if hovered {
        palette_hovered(state)
    } else if row_index % 2 == 0 {
        palette_table(state)
    } else {
        palette_table_alt(state)
    };
    fill_rect(
        hdc,
        Rect {
            left,
            top,
            right,
            bottom: top + height,
        },
        bg,
    );

    let parent_size = node
        .parent
        .and_then(|parent| scan.nodes.get(parent))
        .map(|parent| parent.size)
        .unwrap_or(node.size);
    let percent = if parent_size > 0 {
        (node.size as f64 / parent_size as f64) * 100.0
    } else {
        0.0
    };

    let mut x = left;
    let cols = columns(state);
    for (column_index, (_label, width, align)) in cols.iter().enumerate() {
        let col_right = (x + *width).min(right);
        if column_index == 0 {
            draw_name_cell(hdc, x, col_right, top, height, state, node, percent);
        } else if column_index == 5 {
            draw_percent_cell(hdc, x, col_right, top, height, state, percent);
        } else {
            let text = match column_index {
                1 => format_bytes_ui(node.size),
                2 => format_bytes_ui(node.allocated),
                3 => format_count_ui(node.files),
                4 => format_count_ui(node.folders),
                6 => epoch_ms_to_utc(node.modified_ms),
                7 => node.path.clone(),
                _ => String::new(),
            };
            let mut text_rect = Rect {
                left: x + 8,
                top,
                right: col_right - 8,
                bottom: top + height,
            };
            SetTextColor(hdc, palette_text(state));
            draw_text(
                hdc,
                &text,
                &mut text_rect,
                if *align {
                    DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX
                } else {
                    DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX
                },
            );
        }
        fill_rect(
            hdc,
            Rect {
                left: col_right,
                top,
                right: col_right + 1,
                bottom: top + height,
            },
            palette_grid(state),
        );
        x = col_right;
        if x >= right {
            break;
        }
    }

    fill_rect(
        hdc,
        Rect {
            left,
            top: top + height - 1,
            right,
            bottom: top + height,
        },
        palette_grid(state),
    );
}

unsafe fn draw_name_cell(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &mut DesktopState,
    node: &NodeRecord,
    percent: f64,
) {
    let bar_w = (((right - left) as f64) * (percent / 100.0).clamp(0.0, 1.0)) as i32;
    if bar_w > 2 {
        fill_rect(
            hdc,
            Rect {
                left,
                top: top + 3,
                right: left + bar_w,
                bottom: top + height - 3,
            },
            palette_size_bar(state),
        );
    }

    let indent = 8 + (node.depth as i32 * 18);
    let twist = if node.is_dir {
        if state.expanded.contains(&node.id) {
            "v"
        } else {
            ">"
        }
    } else {
        ""
    };
    let mut twist_rect = Rect {
        left: left + indent,
        top,
        right: left + indent + 16,
        bottom: top + height,
    };
    SetTextColor(hdc, palette_muted(state));
    draw_text(
        hdc,
        twist,
        &mut twist_rect,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER,
    );

    let icon = icon_for_node(state, node);
    if icon != 0 {
        DrawIconEx(
            hdc,
            left + indent + 19,
            top + ((height - 16) / 2),
            icon,
            16,
            16,
            0,
            0,
            DI_NORMAL,
        );
    }

    // Prefix formatted size directly onto the node's name for classic TreeSize style
    let display_name = format!("{} {}", format_bytes_ui(node.size), node.name);

    let mut text_rect = Rect {
        left: left + indent + 40,
        top,
        right: right - 8,
        bottom: top + height,
    };
    SetTextColor(hdc, palette_text(state));
    draw_text(
        hdc,
        &display_name,
        &mut text_rect,
        DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX,
    );
}

unsafe fn draw_percent_cell(
    hdc: Hdc,
    left: i32,
    right: i32,
    top: i32,
    height: i32,
    state: &DesktopState,
    percent: f64,
) {
    let inner = Rect {
        left: left + 5,
        top: top + 5,
        right: right - 5,
        bottom: top + height - 5,
    };

    // 1. Draw outer 1px border around the progress track
    let border_color = palette_line(state);
    fill_rect(
        hdc,
        Rect {
            left: inner.left,
            top: inner.top,
            right: inner.left + 1,
            bottom: inner.bottom,
        },
        border_color,
    );
    fill_rect(
        hdc,
        Rect {
            left: inner.right - 1,
            top: inner.top,
            right: inner.right,
            bottom: inner.bottom,
        },
        border_color,
    );
    fill_rect(
        hdc,
        Rect {
            left: inner.left,
            top: inner.top,
            right: inner.right,
            bottom: inner.top + 1,
        },
        border_color,
    );
    fill_rect(
        hdc,
        Rect {
            left: inner.left,
            top: inner.bottom - 1,
            right: inner.right,
            bottom: inner.bottom,
        },
        border_color,
    );

    // 2. Fill background of the track
    let track_bg = Rect {
        left: inner.left + 1,
        top: inner.top + 1,
        right: inner.right - 1,
        bottom: inner.bottom - 1,
    };
    fill_rect(hdc, track_bg, palette_percent_track(state));

    // 3. Fill the progress bar indicator with top highlight
    let max_fill_w = track_bg.right - track_bg.left;
    let fill_w = (((max_fill_w) as f64) * (percent / 100.0).clamp(0.0, 1.0)) as i32;
    if fill_w > 0 {
        let fill_rect_area = Rect {
            left: track_bg.left,
            top: track_bg.top,
            right: track_bg.left + fill_w,
            bottom: track_bg.bottom,
        };
        fill_rect(hdc, fill_rect_area, palette_percent_fill(state));

        // Accent highlighting stripe for high-fidelity visual appeal
        let highlight_rect = Rect {
            left: track_bg.left,
            top: track_bg.top,
            right: track_bg.left + fill_w,
            bottom: track_bg.top + 2,
        };
        let highlight_color = if state.dark_mode {
            rgb(140, 142, 255)
        } else {
            rgb(130, 180, 255)
        };
        fill_rect(hdc, highlight_rect, highlight_color);
    }

    // 4. Draw percent text aligned to the right (slightly padded)
    let mut text_rect = Rect {
        left,
        top,
        right: right - 12,
        bottom: top + height,
    };
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, palette_text(state));
    draw_text(
        hdc,
        &format!("{percent:.1}%"),
        &mut text_rect,
        DT_RIGHT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
    );
}

unsafe fn handle_mouse_click(hwnd: Hwnd, lparam: Lparam, double_click: bool) {
    let x = loword_signed(lparam);
    let y = hiword_signed(lparam);

    let mut tab_clicked = None;
    if y >= 0 && y < 30 {
        if x >= 10 && x < 60 {
            tab_clicked = Some(0);
        } else if x >= 60 && x < 120 {
            tab_clicked = Some(1);
        } else if x >= 120 && x < 180 {
            tab_clicked = Some(2);
        } else if x >= 180 && x < 240 {
            tab_clicked = Some(3);
        } else if x >= 240 && x < 310 {
            tab_clicked = Some(4);
        } else if x >= 310 && x < 370 {
            tab_clicked = Some(5);
        }
    }

    if let Some(tab_idx) = tab_clicked {
        with_state_mut(|state| {
            state.active_tab = tab_idx;
        });
        resize_controls(hwnd);
        InvalidateRect(hwnd, null(), 0);
        return;
    }

    with_state_mut(|state| {
        let row_top = table_top() + 30;
        if y < row_top {
            return;
        }
        let row_h = 27;
        let row_index = state.scroll_row + ((y - row_top) / row_h) as usize;
        let Some(node_id) = state.visible_rows.get(row_index).copied() else {
            return;
        };
        state.selected_id = node_id;

        let Some(scan) = state.current_scan.clone() else {
            InvalidateRect(hwnd, null(), 0);
            return;
        };
        let Some(node) = scan.nodes.get(node_id) else {
            InvalidateRect(hwnd, null(), 0);
            return;
        };
        let twist_x = 10 + 8 + (node.depth as i32 * 18);
        let in_twist = x >= twist_x && x <= twist_x + 20;
        if node.is_dir && (double_click || in_twist) {
            if state.expanded.contains(&node_id) {
                state.expanded.remove(&node_id);
            } else {
                state.expanded.insert(node_id);
            }
            render_list(state);
        } else {
            if !node.is_dir && double_click {
                let path_clone = node.path.clone();
                thread::spawn(move || unsafe {
                    ShellExecuteW(
                        0,
                        wide("open").as_ptr(),
                        wide(&path_clone).as_ptr(),
                        null(),
                        null(),
                        5,
                    );
                });
            }
            InvalidateRect(hwnd, null(), 0);
        }
    });
}

unsafe fn show_shell_context_menu(hwnd: Hwnd, path: &str, x: i32, y: i32) -> bool {
    let wide_path = wide(path);
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

unsafe fn handle_right_click(hwnd: Hwnd, _client_x: i32, client_y: i32) {
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

    let label_open = wide("Open / Play");
    let label_reveal = wide("Reveal in Explorer");
    let label_copy = wide("Copy Path");
    let label_delete = wide("Delete");
    let label_properties = wide("Properties");

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

unsafe fn copy_to_clipboard(text: &str) -> bool {
    let wide_str = wide(text);
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

fn show_error_in_thread(hwnd: Hwnd, message: String) {
    thread::spawn(move || unsafe {
        let title = wide(APP_NAME);
        let msg = wide(&message);
        MessageBoxW(hwnd, msg.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    });
}

unsafe fn handle_mouse_wheel(hwnd: Hwnd, wparam: Wparam) {
    let delta = ((wparam >> 16) as i16) as i32;
    with_state_mut(|state| {
        if state.visible_rows.is_empty() {
            return;
        }
        let step = if delta > 0 { -3 } else { 3 };
        scroll_rows(state, step);
        InvalidateRect(hwnd, null(), 0);
    });
}

unsafe fn handle_mouse_move(hwnd: Hwnd, _client_x: i32, client_y: i32) {
    let hovered = with_state_mut(|state| {
        let row_top = table_top() + 30;
        if client_y < row_top {
            let old = state.hovered_id;
            state.hovered_id = None;
            return (old, None);
        }
        let row_h = 27;
        let row_index = state.scroll_row + ((client_y - row_top) / row_h) as usize;
        let node_id = state.visible_rows.get(row_index).copied();
        let old = state.hovered_id;
        state.hovered_id = node_id;
        (old, node_id)
    });

    if let Some((old_hover, new_hover)) = hovered
        && old_hover != new_hover
    {
        InvalidateRect(hwnd, null(), 0);
    }
}

unsafe fn handle_key(hwnd: Hwnd, key: Wparam) {
    with_state_mut(|state| {
        match key {
            VK_UP => move_selection(state, -1),
            VK_DOWN => move_selection(state, 1),
            VK_PRIOR => scroll_rows(state, -20),
            VK_NEXT => scroll_rows(state, 20),
            VK_HOME => state.scroll_row = 0,
            VK_END => state.scroll_row = state.visible_rows.len().saturating_sub(1),
            _ => {}
        }
        InvalidateRect(hwnd, null(), 0);
    });
}

fn move_selection(state: &mut DesktopState, delta: isize) {
    if state.visible_rows.is_empty() {
        return;
    }
    let current = state
        .visible_rows
        .iter()
        .position(|id| *id == state.selected_id)
        .unwrap_or(0);
    let next = current
        .saturating_add_signed(delta)
        .min(state.visible_rows.len().saturating_sub(1));
    state.selected_id = state.visible_rows[next];
    if next < state.scroll_row {
        state.scroll_row = next;
    }
}

fn scroll_rows(state: &mut DesktopState, delta: isize) {
    let max = state.visible_rows.len().saturating_sub(1);
    state.scroll_row = state.scroll_row.saturating_add_signed(delta).min(max);
}

unsafe fn fill_rect(hdc: Hdc, rect: Rect, color: Dword) {
    let brush = CreateSolidBrush(color);
    FillRect(hdc, &rect, brush);
    DeleteObject(brush as Hgdobj);
}

unsafe fn draw_text(hdc: Hdc, text: &str, rect: &mut Rect, flags: Uint) {
    let wide = wide(text);
    DrawTextW(hdc, wide.as_ptr(), -1, rect, flags);
}

fn table_top() -> i32 {
    115
}

fn columns(state: &DesktopState) -> Vec<(&'static str, i32, bool)> {
    let mut columns = vec![
        ("Name", 520, false),
        ("Size", 110, true),
        ("Allocated", 118, true),
        ("Files", 88, true),
        ("Folders", 88, true),
        ("% Parent", 110, true),
        ("Last Modified", 168, false),
    ];
    if state.path_column_visible {
        columns.push(("Path", 520, false));
    }
    columns
}

fn loword_signed(value: Lparam) -> i32 {
    (value as u32 & 0xffff) as i16 as i32
}

fn hiword_signed(value: Lparam) -> i32 {
    ((value as u32 >> 16) & 0xffff) as i16 as i32
}

fn palette_bg(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(12, 13, 15)
    } else {
        rgb(242, 244, 247)
    }
}

fn palette_panel(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(28, 30, 34)
    } else {
        rgb(236, 238, 241)
    }
}

fn palette_table(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(24, 26, 29)
    } else {
        rgb(255, 255, 255)
    }
}

fn palette_table_alt(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(21, 23, 26)
    } else {
        rgb(249, 250, 252)
    }
}

fn palette_header(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(50, 53, 58)
    } else {
        rgb(226, 229, 234)
    }
}

fn palette_line(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(64, 68, 74)
    } else {
        rgb(196, 202, 210)
    }
}

fn palette_grid(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(36, 39, 43)
    } else {
        rgb(231, 234, 238)
    }
}

fn palette_text(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(240, 244, 248)
    } else {
        rgb(18, 22, 27)
    }
}

fn palette_muted(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(156, 165, 174)
    } else {
        rgb(91, 100, 112)
    }
}

fn palette_selected(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(70, 74, 79)
    } else {
        rgb(211, 226, 246)
    }
}

fn palette_hovered(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(38, 41, 46)
    } else {
        rgb(228, 236, 247)
    }
}

fn palette_size_bar(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(72, 78, 84)
    } else {
        rgb(217, 225, 235)
    }
}

fn palette_percent_track(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(54, 56, 59)
    } else {
        rgb(232, 235, 240)
    }
}

fn palette_percent_fill(state: &DesktopState) -> Dword {
    if state.dark_mode {
        rgb(92, 93, 242)
    } else {
        rgb(65, 122, 232)
    }
}

/// Rebuilds the visible_rows list and invalidates the window.
/// Returns a status message string that should be set on the status
/// bar AFTER the mutex is released (to avoid deadlock from
/// SetWindowTextW sending synchronous messages back to our proc).
unsafe fn render_list(state: &mut DesktopState) -> Option<String> {
    state.visible_rows.clear();

    let Some(scan) = state.current_scan.clone() else {
        state.scroll_row = 0;
        InvalidateRect(state.hwnd, null(), 1);
        return None;
    };

    collect_rows(
        &scan,
        0,
        &state.expanded,
        state.show_files,
        &mut state.visible_rows,
    );
    if state.scroll_row >= state.visible_rows.len() {
        state.scroll_row = state.visible_rows.len().saturating_sub(1);
    }

    InvalidateRect(state.hwnd, null(), 0);

    scan.nodes.first().map(|root| {
        format!(
            "{} | {} | {} files | {} folders | {} visible rows",
            root.path,
            format_bytes_ui(root.size),
            format_count_ui(root.files),
            format_count_ui(root.folders),
            format_count_ui(state.visible_rows.len() as u64)
        )
    })
}

fn collect_rows(
    scan: &ScanResult,
    id: usize,
    expanded: &BTreeSet<usize>,
    show_files: bool,
    rows: &mut Vec<usize>,
) {
    let Some(node) = scan.nodes.get(id) else {
        return;
    };

    if rows.len() >= MAX_VISIBLE_ROWS {
        return;
    }

    if node.is_dir || show_files {
        rows.push(id);
    }

    if node.is_dir && expanded.contains(&id) {
        for child in &node.children {
            if rows.len() >= MAX_VISIBLE_ROWS {
                break;
            }
            collect_rows(scan, *child, expanded, show_files, rows);
        }
    }
}

unsafe fn button_checked(hwnd: Hwnd) -> bool {
    SendMessageW(hwnd, BM_GETCHECK, 0, 0) as Wparam == BST_CHECKED
}

unsafe fn get_window_text(hwnd: Hwnd) -> String {
    let len = GetWindowTextLengthW(hwnd).max(0);
    let mut buffer = vec![0u16; len as usize + 1];
    let read = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
    String::from_utf16_lossy(&buffer[..read.max(0) as usize])
}

unsafe fn set_window_text(hwnd: Hwnd, text: &str) {
    let text = wide(text);
    SetWindowTextW(hwnd, text.as_ptr());
}

unsafe fn show_error(hwnd: Hwnd, message: &str) {
    let title = wide(APP_NAME);
    let message = wide(message);
    MessageBoxW(hwnd, message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn format_bytes_ui(value: u64) -> String {
    const UNITS: &[(&str, f64)] = &[
        ("TB", 1024.0 * 1024.0 * 1024.0 * 1024.0),
        ("GB", 1024.0 * 1024.0 * 1024.0),
        ("MB", 1024.0 * 1024.0),
        ("KB", 1024.0),
    ];

    for (unit, factor) in UNITS {
        if value as f64 >= *factor {
            let amount = value as f64 / *factor;
            return format!("{amount:.1} {unit}");
        }
    }
    format!("{} B", format_count_ui(value))
}

fn format_count_ui(value: u64) -> String {
    let text = value.to_string();
    let mut output = String::new();
    for (index, ch) in text.chars().rev().enumerate() {
        if index > 0 && index % 3 == 0 {
            output.push(',');
        }
        output.push(ch);
    }
    output.chars().rev().collect()
}

fn format_duration_ui(ms: u128) -> String {
    if ms < 1_000 {
        format!("{ms} ms")
    } else if ms < 60_000 {
        format!("{:.1} s", ms as f64 / 1_000.0)
    } else {
        format!("{}m {}s", ms / 60_000, (ms % 60_000) / 1_000)
    }
}
