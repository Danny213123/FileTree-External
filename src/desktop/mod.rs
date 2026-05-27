#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::cell::RefCell;
use std::io;
use std::net::TcpListener;
use std::path::PathBuf;
use std::ptr::null;
use std::sync::{Mutex, OnceLock};
use std::thread;

use crate::cli::APP_NAME;
pub(crate) mod ffi;
use ffi::*;

// ---------------------------------------------------------------------------
// Global state shared between the HTTP server thread and the UI thread.
// ---------------------------------------------------------------------------

/// HWND of the main window, set by the UI thread after CreateWindowExW.
static MAIN_HWND: OnceLock<Mutex<Hwnd>> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct ShellMenuRequest {
    pub(crate) path: String,
    pub(crate) screen_x: i32,
    pub(crate) screen_y: i32,
}

static SHELL_MENU_REQUEST: OnceLock<Mutex<Option<ShellMenuRequest>>> = OnceLock::new();

const WM_SHELL_CONTEXT_MENU: Uint = WM_APP + 1;

/// Called from the HTTP server thread to request a shell context menu on the UI thread.
pub(crate) fn post_shell_context_menu(path: String, screen_x: i32, screen_y: i32) {
    *SHELL_MENU_REQUEST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("shell menu lock") = Some(ShellMenuRequest {
        path,
        screen_x,
        screen_y,
    });

    if let Some(hwnd_lock) = MAIN_HWND.get() {
        let hwnd = *hwnd_lock.lock().expect("hwnd lock");
        if hwnd != 0 {
            unsafe { PostMessageW(hwnd, WM_SHELL_CONTEXT_MENU, 0, 0) };
        }
    }
}

mod theme;
use theme::*;

// ---------------------------------------------------------------------------
// Dark-mode bootstrap — called by cli.rs before desktop::run.
// ---------------------------------------------------------------------------

pub(crate) fn bootstrap_dark_mode(enabled: bool) {
    let mode = if enabled {
        theme::PREFERRED_APP_MODE_ALLOW_DARK
    } else {
        theme::PREFERRED_APP_MODE_DEFAULT
    };
    if let Some(f) = theme::uxtheme_ordinals().set_preferred_app_mode {
        unsafe { f(mode) };
    }
}

// ---------------------------------------------------------------------------
// Thread-local storage for the WebView2 controller (COM STA, single thread).
// ---------------------------------------------------------------------------

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Controller, ICoreWebView2Environment,
};

thread_local! {
    static CONTROLLER: RefCell<Option<ICoreWebView2Controller>> = const { RefCell::new(None) };
    static SERVER_PORT: RefCell<u16> = const { RefCell::new(0) };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

pub(crate) fn run(
    initial_path: PathBuf,
    settings: crate::settings::Settings,
    settings_store: std::sync::Arc<crate::settings::SettingsStore>,
    clamped_geom: crate::settings::WindowGeometry,
) -> io::Result<()> {
    // Bind a free port and release it immediately — the server thread rebinds.
    let port: u16 = {
        let l = TcpListener::bind("127.0.0.1:0")?;
        l.local_addr()?.port()
    };

    SERVER_PORT.with(|p| *p.borrow_mut() = port);

    // Start the HTTP server background thread.
    let server_path = initial_path.clone();
    thread::spawn(move || {
        if let Err(e) = crate::server::run_server(server_path, port) {
            eprintln!("server error: {e}");
        }
    });

    unsafe { run_win32(settings, settings_store, clamped_geom, port) }
}

unsafe fn run_win32(
    settings: crate::settings::Settings,
    settings_store: std::sync::Arc<crate::settings::SettingsStore>,
    clamped_geom: crate::settings::WindowGeometry,
    port: u16,
) -> io::Result<()> {
    let com_initialized = CoInitializeEx(std::ptr::null_mut(), COINIT_APARTMENTTHREADED) >= 0;

    let h_instance = GetModuleHandleW(null());
    let class_name = crate::io::wide("FileTreeWebView2Window");

    let window_class = WndClassW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: h_instance,
        hIcon: LoadImageW(
            0,
            IDI_APPLICATION as *const u16,
            IMAGE_ICON,
            0,
            0,
            LR_SHARED,
        ) as Hicon,
        hCursor: LoadCursorW(0, IDC_ARROW as *const u16),
        hbrBackground: 0,
        lpszMenuName: null(),
        lpszClassName: class_name.as_ptr(),
    };
    RegisterClassW(&window_class);

    let title = crate::io::wide(APP_NAME);
    let hwnd = CreateWindowExW(
        0,
        class_name.as_ptr(),
        title.as_ptr(),
        WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        clamped_geom.x,
        clamped_geom.y,
        clamped_geom.w,
        clamped_geom.h,
        0,
        0,
        h_instance,
        std::ptr::null_mut(),
    );

    if hwnd == 0 {
        if com_initialized {
            CoUninitialize();
        }
        return Err(io::Error::last_os_error());
    }

    // Register HWND so the HTTP server thread can PostMessage to us.
    *MAIN_HWND
        .get_or_init(|| Mutex::new(0))
        .lock()
        .expect("hwnd lock") = hwnd;

    apply_dark_mode_to_window(hwnd, settings.dark_mode);

    // Initialize WebView2 — the callback fires on this STA thread via the COM pump.
    init_webview2(hwnd, port);

    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);

    // Standard Win32 message loop — COM async callbacks fire here.
    let mut message: Msg = std::mem::zeroed();
    while GetMessageW(&mut message, 0, 0, 0) > 0 {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    // Persist window geometry on exit.
    let mut rect: Rect = std::mem::zeroed();
    if GetWindowRect(hwnd, &mut rect) != 0 {
        let geom = crate::settings::WindowGeometry {
            x: rect.left,
            y: rect.top,
            w: rect.right - rect.left,
            h: rect.bottom - rect.top,
            unknown: Default::default(),
        };
        let mut s = settings.clone();
        s.window = geom;
        let _ = settings_store.save(&s);
    }

    if com_initialized {
        CoUninitialize();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// WebView2 initialization.
// ---------------------------------------------------------------------------

fn init_webview2(hwnd: Hwnd, port: u16) {
    use webview2_com::{
        CreateCoreWebView2ControllerCompletedHandler,
        CreateCoreWebView2EnvironmentCompletedHandler,
        Microsoft::Web::WebView2::Win32::CreateCoreWebView2EnvironmentWithOptions,
    };
    use windows::core::PCWSTR;

    let user_data_dir: Vec<u16> = {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
        let path = format!("{base}\\FileTree\\webview2");
        path.encode_utf16().chain(Some(0)).collect()
    };

    let hwnd_w = windows::Win32::Foundation::HWND(hwnd as *mut _);
    let url_w: Vec<u16> = format!("http://127.0.0.1:{port}/\0")
        .encode_utf16()
        .collect();

    let env_handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |_result, env: Option<ICoreWebView2Environment>| {
            let env = env.ok_or_else(|| windows::core::Error::from(windows::core::HRESULT(-1)))?;

            let url_clone: Vec<u16> = url_w.clone();
            let ctrl_handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
                move |_result, ctrl: Option<ICoreWebView2Controller>| {
                    let ctrl =
                        ctrl.ok_or_else(|| windows::core::Error::from(windows::core::HRESULT(-1)))?;
                    unsafe {
                        // Resize to fill client area.
                        let mut rc = windows::Win32::Foundation::RECT::default();
                        windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd_w, &mut rc)?;
                        ctrl.SetBounds(rc)?;

                        // Navigate to the local server.
                        if let Ok(wv) = ctrl.CoreWebView2() {
                            let url_pcwstr = PCWSTR(url_clone.as_ptr());
                            let _ = wv.Navigate(url_pcwstr);
                        }
                    }
                    CONTROLLER.with(|c| *c.borrow_mut() = Some(ctrl));
                    Ok(())
                },
            ));

            unsafe {
                env.CreateCoreWebView2Controller(hwnd_w, &ctrl_handler)?;
            }
            Ok(())
        },
    ));

    let ud_pcwstr = PCWSTR(user_data_dir.as_ptr());
    let empty: Vec<u16> = vec![0u16];
    let browser_pcwstr = PCWSTR(empty.as_ptr());

    unsafe {
        let _ =
            CreateCoreWebView2EnvironmentWithOptions(browser_pcwstr, ud_pcwstr, None, &env_handler);
    }
}

// ---------------------------------------------------------------------------
// Window procedure.
// ---------------------------------------------------------------------------

unsafe extern "system" fn window_proc(
    hwnd: Hwnd,
    msg: Uint,
    wparam: Wparam,
    lparam: Lparam,
) -> Lresult {
    match msg {
        WM_SIZE => {
            CONTROLLER.with(|c| {
                if let Some(ctrl) = c.borrow().as_ref() {
                    let hwnd_w = windows::Win32::Foundation::HWND(hwnd as *mut _);
                    let mut rc = windows::Win32::Foundation::RECT::default();
                    if windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd_w, &mut rc)
                        .is_ok()
                    {
                        let _ = ctrl.SetBounds(rc);
                    }
                }
            });
            0
        }
        WM_SHELL_CONTEXT_MENU => {
            let req = SHELL_MENU_REQUEST
                .get_or_init(|| Mutex::new(None))
                .lock()
                .expect("shell menu lock")
                .take();
            if let Some(r) = req {
                show_shell_context_menu(hwnd, &r.path, r.screen_x, r.screen_y);
            }
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        WM_COPYDATA => {
            // Second instance forwarded a path — navigate the WebView2.
            if lparam != 0 {
                let cds = &*(lparam as *const CopyDataStruct);
                if cds.dwData == FILETREE_PATH_MSG_ID && cds.cbData > 0 {
                    let char_count = cds.cbData as usize / 2;
                    let slice = std::slice::from_raw_parts(cds.lpData as *const u16, char_count);
                    let end = slice.iter().position(|&c| c == 0).unwrap_or(char_count);
                    if let Ok(path) = String::from_utf16(&slice[..end]) {
                        let port = SERVER_PORT.with(|p| *p.borrow());
                        let url_str = format!(
                            "http://127.0.0.1:{port}/?path={}\0",
                            urlencoding_encode(&path)
                        );
                        let url_w: Vec<u16> = url_str.encode_utf16().collect();
                        CONTROLLER.with(|c| {
                            if let Some(ctrl) = c.borrow().as_ref()
                                && let Ok(wv) = ctrl.CoreWebView2()
                            {
                                let _ = wv.Navigate(windows::core::PCWSTR(url_w.as_ptr()));
                            }
                        });
                    }
                }
            }
            SetForegroundWindow(hwnd);
            1
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Shows the Windows shell context menu for `path`.
/// x/y are browser CSS pixels (logical, DPI-unaware) — we ignore them and use
/// GetCursorPos instead, which always returns real screen coordinates.
/// Must be called on the UI thread (from the message loop).
unsafe fn show_shell_context_menu(hwnd: Hwnd, path: &str, _x: i32, _y: i32) {
    use std::ffi::c_void;

    // Use the actual cursor position. clientX/clientY from the browser are CSS
    // pixels which differ from physical pixels on HiDPI screens, so converting
    // them with ClientToScreen gives wrong results at any scale other than 100%.
    let mut pt = ffi::Point { x: 0, y: 0 };
    GetCursorPos(&mut pt);
    let (sx, sy) = (pt.x, pt.y);

    // Convert path to wide string.
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();

    // Parse the path into an ITEMIDLIST.
    let mut pidl: *mut ffi::ITEMIDLIST = std::ptr::null_mut();
    let mut attr_out: u32 = 0;
    let hr = SHParseDisplayName(
        wide.as_ptr(),
        std::ptr::null_mut(),
        &mut pidl,
        0,
        &mut attr_out,
    );
    if hr < 0 || pidl.is_null() {
        return;
    }

    // Bind to the parent folder, getting a child PIDL.
    let mut folder_ptr: *mut c_void = std::ptr::null_mut();
    let mut child_pidl: *const ffi::ITEMIDLIST = std::ptr::null();
    let hr2 = SHBindToParent(
        pidl,
        &ffi::IID_IShellFolder,
        &mut folder_ptr,
        &mut child_pidl,
    );
    if hr2 < 0 || folder_ptr.is_null() {
        CoTaskMemFree(pidl as *mut c_void);
        return;
    }

    let folder = folder_ptr as *mut *mut ffi::IShellFolderVtbl;

    // GetUIObjectOf needs *mut *const ITEMIDLIST.
    let mut child_arr: [*const ffi::ITEMIDLIST; 1] = [child_pidl];
    let mut ctx_ptr: *mut c_void = std::ptr::null_mut();
    let hr3 = ((**folder).GetUIObjectOf)(
        folder_ptr,
        hwnd,
        1,
        child_arr.as_mut_ptr(),
        &ffi::IID_IContextMenu,
        std::ptr::null_mut(),
        &mut ctx_ptr,
    );

    if hr3 >= 0 && !ctx_ptr.is_null() {
        let ctx = ctx_ptr as *mut *mut ffi::IContextMenuVtbl;
        let hmenu = CreatePopupMenu();
        const CMF_NORMAL: u32 = 0x0000;
        ((**ctx).QueryContextMenu)(ctx_ptr, hmenu, 0, 1, 0x7FFF, CMF_NORMAL);

        SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenu(
            hmenu,
            TPM_LEFTALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD,
            sx,
            sy,
            0,
            hwnd,
            std::ptr::null(),
        );

        if cmd > 0 {
            let ici = ffi::CMINVOKECOMMANDINFO {
                cbSize: std::mem::size_of::<ffi::CMINVOKECOMMANDINFO>() as u32,
                fMask: 0,
                hwnd,
                lpVerb: (cmd - 1) as usize as *const u8,
                lpParameters: std::ptr::null(),
                lpDirectory: std::ptr::null(),
                nShow: 1,
                dwHotKey: 0,
                hIcon: 0,
            };
            ((**ctx).InvokeCommand)(ctx_ptr, &ici);
        }

        DestroyMenu(hmenu);
        ((**ctx).Release)(ctx_ptr);
    }

    ((**folder).Release)(folder_ptr);
    CoTaskMemFree(pidl as *mut c_void);
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            other => {
                out.push('%');
                out.push_str(&format!("{other:02X}"));
            }
        }
    }
    out
}
