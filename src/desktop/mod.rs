#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::mem::{size_of, zeroed};
use std::path::PathBuf;
use std::process::Command;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use crate::cli::APP_NAME;
use crate::io::{default_thread_count, path_to_string, reveal_path};
use crate::model::*;
use crate::scan::scan_path_with_progress;

mod state;
use state::{DesktopState, STATE, ScanDone, ScanProgressInfo, handle_copy_data, with_state_mut};
pub(crate) mod ffi;
use ffi::*;
mod theme;
use theme::*;
mod paint;
use paint::*;
mod shell;
use shell::*;
mod tabs;
mod treemap;

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
        let path_wide = crate::io::wide(&temp_path.to_string_lossy());
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
        // ICC_USEREX_CLASSES enables ComboBoxEx32; ICC_BAR_CLASSES enables msctls_statusbar32.
        // Without these, CreateWindowExW for those classes returns 0 silently (RESEARCH anti-pattern).
        let controls = InitCommonControlsEx {
            dwSize: size_of::<InitCommonControlsEx>() as Dword,
            dwICC: ICC_LISTVIEW_CLASSES | ICC_USEREX_CLASSES | ICC_BAR_CLASSES,
        };
        InitCommonControlsEx(&controls);

        let _ = STATE.set(Mutex::new(DesktopState::new(initial_path)));

        let h_instance = GetModuleHandleW(null());
        let class_name = crate::io::wide("FileTreeDesktopWindow");
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

        let title = crate::io::wide(&format!("{APP_NAME} - Native Disk Explorer"));
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

        // Build the accelerator table (Plan 02-03, Pattern 6).
        // Use MaybeUninit + ptr::write to build the packed Accel array without triggering
        // Rust's unaligned-references lint (fields of packed structs cannot be directly
        // referenced). TranslateAcceleratorW is called BEFORE TranslateMessage (Pitfall #8):
        // the accelerator wins over the edit control's default key handling for Enter/Esc/F5.
        let mut accel_uninit = [
            core::mem::MaybeUninit::<Accel>::uninit(),
            core::mem::MaybeUninit::<Accel>::uninit(),
            core::mem::MaybeUninit::<Accel>::uninit(),
            core::mem::MaybeUninit::<Accel>::uninit(),
            core::mem::MaybeUninit::<Accel>::uninit(),
            core::mem::MaybeUninit::<Accel>::uninit(),
        ];
        let accel_data: [(u8, u16, u16); 6] = [
            (FVIRTKEY, VK_RETURN, CMD_SCAN),
            (FVIRTKEY, VK_ESCAPE, CMD_CANCEL_SCAN),
            (FVIRTKEY, VK_DELETE, CMD_DELETE_SEL),
            (FVIRTKEY | FCONTROL, 'F' as u16, CMD_FOCUS_SEARCH),
            (FVIRTKEY | FCONTROL, 'E' as u16, CMD_EXPORT),
            (FVIRTKEY, VK_F5, CMD_REFRESH),
        ];
        for (slot, (fvirt, key, cmd)) in accel_uninit.iter_mut().zip(accel_data.iter()) {
            // SAFETY: MaybeUninit::as_mut_ptr() gives a valid pointer to write the value.
            let ptr = slot.as_mut_ptr();
            core::ptr::write_unaligned(core::ptr::addr_of_mut!((*ptr).fVirt), *fvirt);
            core::ptr::write_unaligned(core::ptr::addr_of_mut!((*ptr).key), *key);
            core::ptr::write_unaligned(core::ptr::addr_of_mut!((*ptr).cmd), *cmd);
        }
        // SAFETY: all six slots were initialized via write_unaligned above.
        let accels: [Accel; 6] = core::mem::transmute(accel_uninit);
        let haccel = CreateAcceleratorTableW(accels.as_ptr(), 6);
        with_state_mut(|s| s.accel_table = haccel);

        let mut message: Msg = zeroed();
        // TranslateAcceleratorW MUST come before TranslateMessage (Pitfall #8).
        // When it returns non-zero the accelerator was dispatched as WM_COMMAND;
        // we skip TranslateMessage + DispatchMessageW for that iteration.
        while GetMessageW(&mut message, 0, 0, 0) > 0 {
            if TranslateAcceleratorW(hwnd, haccel, &mut message) == 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        // Destroy accelerator table after the message loop exits.
        if haccel != 0 {
            DestroyAcceleratorTable(haccel);
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
            let notify_code = ((wparam >> 16) & 0xffff) as u32;
            match id {
                // --- Accelerator-table shortcut commands (Plan 02-03, Pattern 6) ---
                // CMD_SCAN (Enter): start a scan if none is in flight.
                // UI-SPEC: no-op when already scanning (button is disabled by EnableWindow).
                id if id == CMD_SCAN as isize => {
                    let scanning = with_state_mut(|s| s.scanning).unwrap_or(false);
                    if !scanning {
                        start_scan_from_controls(hwnd);
                    }
                }
                // CMD_CANCEL_SCAN (Esc): cancel an active scan; no-op otherwise.
                id if id == CMD_CANCEL_SCAN as isize => {
                    let scanning = with_state_mut(|s| s.scanning).unwrap_or(false);
                    if scanning {
                        stop_current_scan();
                    }
                }
                // CMD_REFRESH (F5): restart the scan (cancel if in flight, then re-start).
                id if id == CMD_REFRESH as isize => {
                    let scanning = with_state_mut(|s| s.scanning).unwrap_or(false);
                    if scanning {
                        stop_current_scan();
                    }
                    start_scan_from_controls(hwnd);
                }
                // CMD_EXPORT (Ctrl+E): route to the existing export entry (no-op stub until
                // Phase 4 wires the export pipeline; debug-only log confirms dispatch).
                id if id == CMD_EXPORT as isize => {
                    #[cfg(debug_assertions)]
                    eprintln!("CMD_EXPORT fired (stub — Phase 4 wires export pipeline)");
                }
                // CMD_FOCUS_SEARCH (Ctrl+F): no-op stub per UI-SPEC (Phase 3 wires focus call).
                id if id == CMD_FOCUS_SEARCH as isize => {
                    #[cfg(debug_assertions)]
                    eprintln!("CMD_FOCUS_SEARCH fired (stub — Phase 3 wires search focus)");
                }
                // CMD_DELETE_SEL (Del): focus-conditional per UI-SPEC.
                // Fires ONLY when the custom tree list has focus; when path edit has focus,
                // the accelerator handler checks GetFocus() and no-ops so Del falls through
                // to the edit control's default delete-char behavior.
                id if id == CMD_DELETE_SEL as isize => {
                    let list_hwnd = with_state_mut(|s| s.list).unwrap_or(0);
                    if GetFocus() == list_hwnd && list_hwnd != 0 {
                        #[cfg(debug_assertions)]
                        eprintln!("CMD_DELETE_SEL fired (stub — Phase 5 wires IFileOperation)");
                    }
                    // When list does not have focus, fall through — let the edit control handle Del.
                }
                // Drive picker CBN_SELCHANGE: user selected a drive — set path edit to X:\
                ID_DRIVE_PICKER if notify_code == CBN_SELCHANGE => {
                    handle_drive_picker_change(hwnd);
                }
                // --- Existing button / menu commands ---
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
                                crate::io::wide("open").as_ptr(),
                                crate::io::wide(&p).as_ptr(),
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
                            let title = crate::io::wide("Confirm Delete");
                            let msg = crate::io::wide(&format!(
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
        WM_COPYDATA => handle_copy_data(hwnd, lparam),
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
        let face = crate::io::wide("Segoe UI");
        state.font = CreateFontW(-15, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr());
        state.bold_font = CreateFontW(-15, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 5, 0, face.as_ptr());

        // Create drive picker (ComboBoxEx32) — left of the path edit (Plan 02-03, Pattern 4).
        // Positioned at placeholder coords (0, 0, 10, 10); resize_controls does final layout.
        {
            let class = crate::io::wide("ComboBoxEx32");
            state.drive_picker = CreateWindowExW(
                0,
                class.as_ptr(),
                null(),
                WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST,
                0,
                0,
                10,
                10,
                hwnd,
                ID_DRIVE_PICKER as Hmenu,
                h_instance,
                null_mut(),
            );
        }
        // Populate the drive picker with all non-empty drives.
        if state.drive_picker != 0 {
            populate_drive_picker(state.drive_picker, &path_to_string(&state.initial_path));
        }

        // Create path edit EDIT control (Plan 02-03).
        state.path_edit = create_child(
            hwnd,
            h_instance,
            "EDIT",
            &path_to_string(&state.initial_path),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
            0,
            ID_PATH_EDIT,
        );
        // SHAutoComplete MUST be called AFTER CreateWindowExW returns a non-zero HWND
        // (Pitfall #3 — calling before the edit HWND is valid silently fails).
        // This wires the Explorer-style filesystem autocomplete dropdown to the path edit.
        if state.path_edit != 0 {
            SHAutoComplete(
                state.path_edit,
                SHACF_FILESYS_DIRS | SHACF_AUTOSUGGEST_FORCE_ON | SHACF_AUTOAPPEND_FORCE_ON,
            );
        }
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
        // Create the 5-pane msctls_statusbar32 status bar (Plan 02-04, UI-SPEC §"Status bar").
        // ICC_BAR_CLASSES must be set in InitCommonControlsEx (already done in run()).
        // Coordinates are ignored — the status bar auto-sizes to the bottom of the parent.
        {
            let class = crate::io::wide("msctls_statusbar32");
            state.status = CreateWindowExW(
                0,
                class.as_ptr(),
                null(),
                WS_CHILD | WS_VISIBLE | SBARS_SIZEGRIP,
                0,
                0,
                0,
                0,
                hwnd,
                ID_STATUS as Hmenu,
                h_instance,
                null_mut(),
            );
        }
        // Set initial idle-state pane texts.
        if state.status != 0 {
            set_status_pane(state.status, PANE_FILES, "-- files");
            set_status_pane(state.status, PANE_FOLDERS, "-- folders");
            set_status_pane(state.status, PANE_ERRORS, "-- errors");
            set_status_pane(state.status, PANE_ELAPSED, "--:--");
            set_status_pane(state.status, PANE_THROUGHPUT, "-- MB/s");
        }
        state.list = 0;

        SendMessageW(state.hidden_check, BM_SETCHECK, BST_CHECKED, 0);
        SendMessageW(state.files_check, BM_SETCHECK, BST_CHECKED, 0);
        SendMessageW(state.dark_check, BM_SETCHECK, BST_CHECKED, 0);
        for control in [
            state.drive_picker,
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
            if control != 0 {
                SendMessageW(control, WM_SETFONT, state.font as Wparam, 1);
            }
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
    let class = crate::io::wide(class_name);
    let text = crate::io::wide(text);
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
    let _height = (rect.bottom - rect.top).max(300);
    with_state_mut(|state| {
        let margin = 10;
        let browse_w = 110;
        let button_h = 26;
        let path_y = 38;
        let actions_y = 74;
        let _status_h = 26;

        // Drive picker: 80 logical px wide (UI-SPEC), left-inset of `margin` (8px sm spacing)
        let picker_w = 80;
        let picker_gap = 4; // xs spacing between picker and path edit
        let bar_h = 32; // xl token — path bar height

        // Layout drive picker + path edit:
        //   [margin] [picker_w] [picker_gap] [path_edit_w] [8] [browse_w] [margin]
        let path_edit_x = margin + picker_w + picker_gap;
        let path_edit_w = (width - path_edit_x - 8 - browse_w - margin).max(100);

        if state.drive_picker != 0 {
            MoveWindow(state.drive_picker, margin, path_y, picker_w, bar_h, 1);
        }
        MoveWindow(
            state.path_edit,
            path_edit_x,
            path_y,
            path_edit_w,
            button_h,
            1,
        );
        MoveWindow(
            state.browse_button,
            path_edit_x + path_edit_w + 8,
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

        // msctls_statusbar32 auto-positions itself at the bottom when WM_SIZE is sent.
        // We also recompute the pane layout for the current width and DPI.
        if state.status != 0 {
            // Send WM_SIZE to the status bar so it repositions itself.
            SendMessageW(state.status, WM_SIZE, 0, 0);
            // Recompute pane right-edge x-coordinates for the current DPI.
            let dpi = GetDpiForWindow(hwnd);
            let dpi = if dpi == 0 { 96 } else { dpi };
            let parts = compute_status_parts(width, dpi);
            SendMessageW(state.status, SB_SETPARTS, 5, parts.as_ptr() as Lparam);
        }
    });
}

pub(super) unsafe fn start_scan_from_controls(hwnd: Hwnd) {
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
        state.status_idle = false;
        state.last_scan_bytes = 0;
        state.last_scan_elapsed_ms = 0;
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
    if controls.0 != 0 {
        set_status_pane(controls.0, PANE_FILES, "0 files");
        set_status_pane(controls.0, PANE_FOLDERS, "0 folders");
        set_status_pane(controls.0, PANE_ERRORS, "0 errors");
        set_status_pane(controls.0, PANE_ELAPSED, "0:00");
        set_status_pane(controls.0, PANE_THROUGHPUT, "0.0 MB/s");
    }
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
        // Mark status idle so throughput pane resets to "-- MB/s" immediately (UI-SPEC).
        state.status_idle = true;
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
                let file_count = scan.nodes.iter().filter(|n| !n.is_dir).count() as u64;
                let folder_count = scan.nodes.iter().filter(|n| n.is_dir).count() as u64;
                let error_count = scan.errors.len() as u64;
                let root_size = scan.nodes.first().map(|node| node.size).unwrap_or(0);
                state.current_scan = Some(Arc::new(scan));
                state.expanded.clear();
                state.expanded.insert(0);
                let _ = render_list(state);
                (
                    controls,
                    Some((
                        file_count,
                        folder_count,
                        error_count,
                        elapsed,
                        canceled,
                        node_count,
                        root_size,
                    )),
                    None::<String>,
                )
            }
            Err(message) => (controls, None, Some(message)),
        }
    });

    if let Some((controls, scan_info, error_msg)) = deferred {
        // Win32 calls OUTSIDE the mutex.
        EnableWindow(controls.1, 1);
        EnableWindow(controls.2, 1);
        EnableWindow(controls.3, 1);
        EnableWindow(controls.4, 1);
        EnableWindow(controls.5, 0);
        if let Some((files, folders, errors, elapsed, was_canceled, node_count, root_size)) =
            scan_info
        {
            let status = controls.0;
            if status != 0 {
                // Count and elapsed panes FREEZE at final values (UI-SPEC §"Status bar / completed scan").
                set_status_pane(status, PANE_FILES, &format_status_files(files, false));
                set_status_pane(status, PANE_FOLDERS, &format_status_folders(folders, false));
                set_status_pane(status, PANE_ERRORS, &format_status_errors(errors, false));
                set_status_pane(status, PANE_ELAPSED, &format_status_elapsed(elapsed, false));
                // Throughput resets to "-- MB/s" immediately on completion/cancel (UI-SPEC).
                set_status_pane(status, PANE_THROUGHPUT, "-- MB/s");
            }
            // Also update the legacy status for the title bar / error log.
            let _ = (was_canceled, node_count, root_size);
        } else if error_msg.is_none() {
            // Scan failed path — show idle markers.
            let status = controls.0;
            if status != 0 {
                set_status_pane(status, PANE_FILES, "-- files");
                set_status_pane(status, PANE_FOLDERS, "-- folders");
                set_status_pane(status, PANE_ERRORS, "-- errors");
                set_status_pane(status, PANE_ELAPSED, "--:--");
                set_status_pane(status, PANE_THROUGHPUT, "-- MB/s");
            }
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
    // Also capture bytes and elapsed for the throughput formula.
    let status_info = with_state_mut(|state| {
        if !state.scanning {
            return None;
        }
        let bytes = if let Some(scan) = partial_result {
            let root_size = scan.nodes.first().map(|n| n.size).unwrap_or(0);
            state.current_scan = Some(Arc::new(scan));
            let _ = render_list(state);
            root_size
        } else {
            state
                .current_scan
                .as_ref()
                .and_then(|s| s.nodes.first())
                .map(|n| n.size)
                .unwrap_or(0)
        };
        state.last_scan_bytes = bytes;
        state.last_scan_elapsed_ms = elapsed_ms;
        let files = state
            .current_scan
            .as_ref()
            .map(|s| s.nodes.iter().filter(|n| !n.is_dir).count() as u64)
            .unwrap_or(0);
        let folders = state
            .current_scan
            .as_ref()
            .map(|s| s.nodes.iter().filter(|n| n.is_dir).count() as u64)
            .unwrap_or(node_count as u64);
        let errors = state
            .current_scan
            .as_ref()
            .map(|s| s.errors.len() as u64)
            .unwrap_or(0);
        Some((state.status, files, folders, errors, bytes, elapsed_ms))
    })
    .flatten();

    // Win32 calls OUTSIDE the mutex — safe from deadlock.
    if let Some((status, files, folders, errors, bytes, elapsed)) = status_info
        && status != 0
    {
        set_status_pane(status, PANE_FILES, &format_status_files(files, false));
        set_status_pane(status, PANE_FOLDERS, &format_status_folders(folders, false));
        set_status_pane(status, PANE_ERRORS, &format_status_errors(errors, false));
        set_status_pane(status, PANE_ELAPSED, &format_status_elapsed(elapsed, false));
        set_status_pane(
            status,
            PANE_THROUGHPUT,
            &format_status_throughput(bytes, elapsed, false),
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
    let title = crate::io::wide("Select a directory to scan");
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
                        crate::io::wide("open").as_ptr(),
                        crate::io::wide(&path_clone).as_ptr(),
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

fn loword_signed(value: Lparam) -> i32 {
    (value as u32 & 0xffff) as i16 as i32
}

fn hiword_signed(value: Lparam) -> i32 {
    ((value as u32 >> 16) & 0xffff) as i16 as i32
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

unsafe fn get_window_text(hwnd: Hwnd) -> String {
    let len = GetWindowTextLengthW(hwnd).max(0);
    let mut buffer = vec![0u16; len as usize + 1];
    let read = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
    String::from_utf16_lossy(&buffer[..read.max(0) as usize])
}

unsafe fn set_window_text(hwnd: Hwnd, text: &str) {
    let text = crate::io::wide(text);
    SetWindowTextW(hwnd, text.as_ptr());
}

unsafe fn show_error(hwnd: Hwnd, message: &str) {
    let title = crate::io::wide(APP_NAME);
    let message = crate::io::wide(message);
    MessageBoxW(hwnd, message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
}

// ---------------------------------------------------------------------------
// Drive picker helpers (Plan 02-03, Pattern 4)
// ---------------------------------------------------------------------------

/// Filters the `GetLogicalDrives` bitmask using a caller-supplied drive-type probe.
///
/// Returns letters ('A'..='Z') for every bit that is set in `mask` whose drive type
/// (returned by the `drive_type` closure) is NOT `DRIVE_UNKNOWN` or `DRIVE_NO_ROOT_DIR`.
///
/// Pure-Rust; no Win32 calls. The closure abstraction makes the function unit-testable
/// without hitting the OS (tests supply a mock closure).
fn pure_filter_drive_letters(mask: u32, drive_type: impl Fn(char) -> Uint) -> Vec<char> {
    ('A'..='Z')
        .enumerate()
        .filter_map(|(bit, letter)| {
            if (mask >> bit) & 1 == 0 {
                return None;
            }
            let dt = drive_type(letter);
            if dt == DRIVE_UNKNOWN || dt == DRIVE_NO_ROOT_DIR {
                return None;
            }
            Some(letter)
        })
        .collect()
}

/// Formats a drive picker entry string per UI-SPEC copywriting contract.
///
/// - If `label` is `Some` and non-empty, returns `"X: <label>"`.
/// - Otherwise falls back to the drive-type name.
fn format_drive_entry(letter: char, dt: Uint, label: Option<&str>) -> String {
    let fallback = match dt {
        DRIVE_FIXED => "Local Disk",
        DRIVE_REMOVABLE => "Removable",
        DRIVE_CDROM => "CD/DVD",
        DRIVE_REMOTE => "Network",
        DRIVE_RAMDISK => "RAM Disk",
        _ => "Disk",
    };
    let display_label = match label {
        Some(s) if !s.is_empty() => s,
        _ => fallback,
    };
    format!("{letter}: {display_label}")
}

/// Populates the drive picker with entries for every enumerable drive.
///
/// Reads `GetLogicalDrives`, filters via `pure_filter_drive_letters` + `GetDriveTypeW`,
/// fetches each volume label via `GetVolumeInformationW`, formats via `format_drive_entry`,
/// and inserts via `CBEM_INSERTITEMW`.
///
/// `initial_path` is used to pre-select the matching drive letter (falls back to C: or first).
unsafe fn populate_drive_picker(picker: Hwnd, initial_path: &str) {
    let mask = GetLogicalDrives();
    let letters = pure_filter_drive_letters(mask, |letter| {
        let root: Vec<u16> = format!("{letter}:\\")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        GetDriveTypeW(root.as_ptr())
    });

    // Determine the initial drive letter from the path (first char if alpha).
    let initial_letter = initial_path
        .chars()
        .next()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase());

    let mut sel_index: i32 = 0;
    for (index, &letter) in letters.iter().enumerate() {
        let root: Vec<u16> = format!("{letter}:\\")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let dt = GetDriveTypeW(root.as_ptr());

        // Try to read the volume label.
        let mut name_buf = [0u16; 256];
        let label_ok = GetVolumeInformationW(
            root.as_ptr(),
            name_buf.as_mut_ptr(),
            256,
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
            0,
        );
        let label: Option<String> = if label_ok != 0 {
            let len = name_buf.iter().position(|&c| c == 0).unwrap_or(0);
            if len > 0 {
                Some(String::from_utf16_lossy(&name_buf[..len]).to_string())
            } else {
                None
            }
        } else {
            None
        };

        let entry = format_drive_entry(letter, dt, label.as_deref());
        let mut entry_wide: Vec<u16> = entry.encode_utf16().chain(Some(0)).collect();

        let mut item = ComboBoxExItemW {
            mask: CBEIF_TEXT,
            iItem: -1,
            pszText: entry_wide.as_mut_ptr(),
            cchTextMax: entry_wide.len() as i32,
            iImage: 0,
            iSelectedImage: 0,
            iOverlay: 0,
            iIndent: 0,
            lParam: 0,
        };
        SendMessageW(
            picker,
            CBEM_INSERTITEMW as Uint,
            0,
            &mut item as *mut _ as Lparam,
        );

        // Track which index to pre-select.
        if initial_letter == Some(letter) {
            sel_index = index as i32;
        }
    }

    // If no match found and letters is non-empty, prefer C: if present, else 0.
    let no_match = initial_letter.is_none() || !letters.contains(&initial_letter.unwrap_or('_'));
    if no_match && let Some(c_pos) = letters.iter().position(|&l| l == 'C') {
        sel_index = c_pos as i32;
    }

    if !letters.is_empty() {
        SendMessageW(picker, CB_SETCURSEL as Uint, sel_index as Wparam, 0);
    }
}

/// Handles drive picker CBN_SELCHANGE: reads the selected letter and sets the path edit to `X:\`.
unsafe fn handle_drive_picker_change(hwnd: Hwnd) {
    let (picker, path_edit) = match with_state_mut(|s| (s.drive_picker, s.path_edit)) {
        Some(pair) => pair,
        None => return,
    };
    if picker == 0 || path_edit == 0 {
        return;
    }

    // Retrieve the text of the currently selected item (first char is the letter).
    let len = GetWindowTextLengthW(picker).max(0);
    let mut buf = vec![0u16; len as usize + 2];
    let read = GetWindowTextW(picker, buf.as_mut_ptr(), buf.len() as i32);
    if read < 1 {
        return;
    }
    let text = String::from_utf16_lossy(&buf[..read as usize]);
    if let Some(letter) = text.chars().next().filter(|c| c.is_ascii_alphabetic()) {
        let path_str = format!("{letter}:\\");
        let path_wide: Vec<u16> = path_str.encode_utf16().chain(Some(0)).collect();
        SetWindowTextW(path_edit, path_wide.as_ptr());
        // SHAutoComplete is already wired; it will suggest first-level folders from X:\.
        // Per UI-SPEC: do NOT auto-start a scan on drive selection.
    }
    let _ = hwnd;
}

// ---------------------------------------------------------------------------
// Unit tests for pure-Rust drive picker helpers (Plan 02-03, Task 2 behavior)
// ---------------------------------------------------------------------------

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;

    #[test]
    fn pure_filter_drive_letters_includes_cdrom() {
        // C: fixed, D: CDROM — both should be included (only UNKNOWN/NO_ROOT_DIR excluded).
        let mask = 0b0000_0000_0000_1100u32; // bits 2 and 3 = C and D
        let letters = pure_filter_drive_letters(mask, |letter| match letter {
            'C' => DRIVE_FIXED,
            'D' => DRIVE_CDROM,
            _ => DRIVE_UNKNOWN,
        });
        assert_eq!(letters, vec!['C', 'D']);
    }

    #[test]
    fn pure_filter_drive_letters_excludes_unknown() {
        let mask = 0b0000_0000_0000_0100u32; // bit 2 = C
        let letters = pure_filter_drive_letters(mask, |_| DRIVE_UNKNOWN);
        assert!(letters.is_empty(), "DRIVE_UNKNOWN should be excluded");
    }

    #[test]
    fn pure_filter_drive_letters_excludes_no_root_dir() {
        let mask = 0b0000_0000_0000_0100u32; // bit 2 = C
        let letters = pure_filter_drive_letters(mask, |_| DRIVE_NO_ROOT_DIR);
        assert!(letters.is_empty(), "DRIVE_NO_ROOT_DIR should be excluded");
    }

    #[test]
    fn format_drive_entry_uses_label() {
        let s = format_drive_entry('C', DRIVE_FIXED, Some("Windows"));
        assert_eq!(s, "C: Windows");
    }

    #[test]
    fn format_drive_entry_falls_back_to_type_name() {
        assert_eq!(format_drive_entry('C', DRIVE_FIXED, None), "C: Local Disk");
        assert_eq!(
            format_drive_entry('D', DRIVE_REMOVABLE, None),
            "D: Removable"
        );
        assert_eq!(format_drive_entry('E', DRIVE_CDROM, None), "E: CD/DVD");
        assert_eq!(format_drive_entry('Z', DRIVE_REMOTE, None), "Z: Network");
        assert_eq!(format_drive_entry('R', DRIVE_RAMDISK, None), "R: RAM Disk");
    }
}
