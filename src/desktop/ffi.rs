#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::slice;

pub(super) type Bool = i32;
pub(super) type Dword = u32;
pub(super) type Hbrush = isize;
pub(super) type Hcursor = isize;
pub(super) type Hdc = isize;
pub(super) type Hfont = isize;
pub(super) type Hicon = isize;
pub(super) type Hinstance = isize;
pub(super) type Hmenu = isize;
pub(super) type Hgdobj = isize;
pub(super) type Hwnd = isize;
pub(super) type Lparam = isize;
pub(super) type Lresult = isize;
pub(super) type Uint = u32;
pub(super) type Wparam = usize;
pub(super) type Handle = isize;
pub(super) type UlongPtr = usize;

#[repr(C)]
pub(super) struct ACTCTXW {
    pub(super) cbSize: Dword,
    pub(super) dwFlags: Dword,
    pub(super) lpSource: *const u16,
    pub(super) wProcessorArchitecture: u16,
    pub(super) wLangId: u16,
    pub(super) lpAssemblyDirectory: *const u16,
    pub(super) lpResourceName: *const u16,
    pub(super) lpApplicationName: *const u16,
    pub(super) hModule: Hinstance,
}

pub(super) const CS_HREDRAW: Uint = 0x0002;
pub(super) const CS_VREDRAW: Uint = 0x0001;
pub(super) const CS_DBLCLKS: Uint = 0x0008;
pub(super) const CW_USEDEFAULT: i32 = 0x80000000u32 as i32;
pub(super) const ES_AUTOHSCROLL: Dword = 0x0080;
pub(super) const FILE_ATTRIBUTE_DIRECTORY: Dword = 0x0000_0010;
pub(super) const FILE_ATTRIBUTE_NORMAL: Dword = 0x0000_0080;
pub(super) const ICC_LISTVIEW_CLASSES: Dword = 0x0000_0001;
pub(super) const IDC_ARROW: usize = 32512;
pub(super) const IDI_APPLICATION: usize = 32512;
pub(super) const DI_NORMAL: Uint = 0x0003;
pub(super) const DT_END_ELLIPSIS: Uint = 0x0000_8000;
pub(super) const DT_LEFT: Uint = 0x0000_0000;
pub(super) const DT_CENTER: Uint = 0x0000_0001;
pub(super) const DT_NOPREFIX: Uint = 0x0000_0800;
pub(super) const DT_RIGHT: Uint = 0x0000_0002;
pub(super) const DT_SINGLELINE: Uint = 0x0000_0020;
pub(super) const DT_VCENTER: Uint = 0x0000_0004;
pub(super) const IMAGE_ICON: Uint = 1;
pub(super) const LR_SHARED: Uint = 0x8000;
pub(super) const MB_ICONERROR: Uint = 0x0000_0010;
pub(super) const MB_OK: Uint = 0x0000_0000;
pub(super) const SHGFI_SMALLICON: Uint = 0x0000_0001;
pub(super) const SHGFI_ICON: Uint = 0x0000_0100;
pub(super) const SHGFI_USEFILEATTRIBUTES: Uint = 0x0000_0010;
pub(super) const SW_SHOW: i32 = 5;
pub(super) const TRANSPARENT: i32 = 1;
pub(super) const WM_APP: Uint = 0x8000;
pub(super) const WM_COMMAND: Uint = 0x0111;
pub(super) const WM_CREATE: Uint = 0x0001;
pub(super) const WM_CTLCOLOREDIT: Uint = 0x0133;
pub(super) const WM_CTLCOLORBTN: Uint = 0x0135;
pub(super) const WM_CTLCOLORSTATIC: Uint = 0x0138;
pub(super) const WM_DESTROY: Uint = 0x0002;
pub(super) const WM_KEYDOWN: Uint = 0x0100;
pub(super) const WM_LBUTTONDBLCLK: Uint = 0x0203;
pub(super) const WM_LBUTTONDOWN: Uint = 0x0201;
pub(super) const WM_MOUSEWHEEL: Uint = 0x020a;
pub(super) const WM_NOTIFY: Uint = 0x004e;
pub(super) const WM_PAINT: Uint = 0x000f;
pub(super) const WM_SETFONT: Uint = 0x0030;
pub(super) const WM_SIZE: Uint = 0x0005;
pub(super) const WS_BORDER: Dword = 0x0080_0000;
pub(super) const WS_CHILD: Dword = 0x4000_0000;
pub(super) const WS_OVERLAPPEDWINDOW: Dword = 0x00cf_0000;
pub(super) const WS_TABSTOP: Dword = 0x0001_0000;
pub(super) const WS_VISIBLE: Dword = 0x1000_0000;
pub(super) const BS_AUTOCHECKBOX: Dword = 0x0000_0003;
pub(super) const BS_PUSHBUTTON: Dword = 0x0000_0000;
pub(super) const COINIT_APARTMENTTHREADED: Dword = 0x0000_0002;
pub(super) const BM_GETCHECK: Uint = 0x00f0;
pub(super) const BM_SETCHECK: Uint = 0x00f1;
pub(super) const BST_CHECKED: Wparam = 1;
pub(super) const BIF_RETURNONLYFSDIRS: Uint = 0x0000_0001;
pub(super) const BIF_NEWDIALOGSTYLE: Uint = 0x0000_0040;
pub(super) const MAX_VISIBLE_ROWS: usize = 20_000;
pub(super) const VK_DOWN: Wparam = 0x28;
pub(super) const VK_END: Wparam = 0x23;
pub(super) const VK_HOME: Wparam = 0x24;
pub(super) const VK_NEXT: Wparam = 0x22;
pub(super) const VK_PRIOR: Wparam = 0x21;
pub(super) const VK_UP: Wparam = 0x26;

pub(super) const WM_ERASEBKGND: Uint = 0x0014;
pub(super) const WM_RBUTTONDOWN: Uint = 0x0204;
pub(super) const WM_RBUTTONUP: Uint = 0x0205;
pub(super) const WM_MOUSEMOVE: Uint = 0x0200;
pub(super) const CF_UNICODETEXT: Uint = 13;
pub(super) const GMEM_MOVEABLE: Uint = 0x0002;
pub(super) const MF_STRING: Uint = 0x0000_0000;
pub(super) const MF_SEPARATOR: Uint = 0x0000_0800;
pub(super) const TPM_LEFTALIGN: Uint = 0x0000;
pub(super) const TPM_RIGHTBUTTON: Uint = 0x0002;
pub(super) const SRCCOPY: Dword = 0x00CC0020;

pub(super) const ID_PATH_EDIT: isize = 101;
pub(super) const ID_SCAN_BUTTON: isize = 102;
pub(super) const ID_REFRESH_BUTTON: isize = 103;
pub(super) const ID_HIDDEN_CHECK: isize = 104;
pub(super) const ID_FILES_CHECK: isize = 105;
pub(super) const ID_FOLLOW_CHECK: isize = 106;
pub(super) const ID_BROWSE_BUTTON: isize = 107;
pub(super) const ID_STOP_BUTTON: isize = 108;
pub(super) const ID_EXPAND_BUTTON: isize = 109;
pub(super) const ID_COLLAPSE_BUTTON: isize = 110;
pub(super) const ID_COLUMNS_BUTTON: isize = 111;
pub(super) const ID_DARK_CHECK: isize = 112;
pub(super) const ID_STATUS: isize = 201;

pub(super) const ID_MENU_OPEN: isize = 3001;
pub(super) const ID_MENU_REVEAL: isize = 3002;
pub(super) const ID_MENU_COPY_PATH: isize = 3003;
pub(super) const ID_MENU_DELETE: isize = 3004;
pub(super) const ID_MENU_PROPERTIES: isize = 3005;

pub(super) const WM_SCAN_DONE: Uint = WM_APP + 7;
pub(super) const WM_SCAN_PROGRESS: Uint = WM_APP + 8;

pub(super) const MOVEFILE_REPLACE_EXISTING: Dword = 0x0000_0001;
pub(super) const MOVEFILE_WRITE_THROUGH: Dword = 0x0000_0008;

// Single-instance mutex + WM_COPYDATA constants (Plan 02-02)
pub(super) const WM_COPYDATA: Uint = 0x004A;
pub(super) const ERROR_ALREADY_EXISTS: Dword = 183;
/// Magic discriminator for WM_COPYDATA path-forward messages: "FT" + msg id 1.
/// Any other dwData value is silently rejected per D-06.2.
pub(crate) const FILETREE_PATH_MSG_ID: UlongPtr = 0x4654_0001;
/// Maximum accepted cbData for WM_COPYDATA payloads — DoS sanity ceiling per D-06.1.
pub(crate) const MAX_COPYDATA_BYTES: u32 = 64 * 1024;
pub(super) const INVALID_FILE_ATTRIBUTES: Dword = 0xFFFF_FFFF;
/// SYNCHRONIZE access right — used with OpenMutexW so the second instance can
/// detect an existing mutex without taking ownership.
pub(super) const SYNCHRONIZE: Dword = 0x0010_0000;

pub(super) const FOLDERID_RoamingAppData: GUID = GUID {
    Data1: 0x3EB685DB,
    Data2: 0x65F9,
    Data3: 0x4CF6,
    Data4: [0xA0, 0x3A, 0xE3, 0xEF, 0x65, 0x72, 0x9F, 0x3D],
};

#[repr(C)]
pub(super) struct Point {
    pub(super) x: i32,
    pub(super) y: i32,
}

#[repr(C)]
pub(super) struct InitCommonControlsEx {
    pub(super) dwSize: Dword,
    pub(super) dwICC: Dword,
}

#[repr(C)]
pub(super) struct Msg {
    pub(super) hwnd: Hwnd,
    pub(super) message: Uint,
    pub(super) wParam: Wparam,
    pub(super) lParam: Lparam,
    pub(super) time: Dword,
    pub(super) pt_x: i32,
    pub(super) pt_y: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct Rect {
    pub(super) left: i32,
    pub(super) top: i32,
    pub(super) right: i32,
    pub(super) bottom: i32,
}

#[repr(C)]
pub(super) struct WndClassW {
    pub(super) style: Uint,
    pub(super) lpfnWndProc:
        Option<unsafe extern "system" fn(Hwnd, Uint, Wparam, Lparam) -> Lresult>,
    pub(super) cbClsExtra: i32,
    pub(super) cbWndExtra: i32,
    pub(super) hInstance: Hinstance,
    pub(super) hIcon: Hicon,
    pub(super) hCursor: Hcursor,
    pub(super) hbrBackground: Hbrush,
    pub(super) lpszMenuName: *const u16,
    pub(super) lpszClassName: *const u16,
}

#[repr(C)]
pub(super) struct BrowseInfoW {
    pub(super) hwndOwner: Hwnd,
    pub(super) pidlRoot: *mut c_void,
    pub(super) pszDisplayName: *mut u16,
    pub(super) lpszTitle: *const u16,
    pub(super) ulFlags: Uint,
    pub(super) lpfn: Option<unsafe extern "system" fn(Hwnd, Uint, Lparam, Lparam) -> i32>,
    pub(super) lParam: Lparam,
    pub(super) iImage: i32,
}

#[repr(C)]
pub(super) struct ShFileInfoW {
    pub(super) hIcon: Hicon,
    pub(super) iIcon: i32,
    pub(super) dwAttributes: Dword,
    pub(super) szDisplayName: [u16; 260],
    pub(super) szTypeName: [u16; 80],
}

#[repr(C)]
pub(super) struct PaintStruct {
    pub(super) hdc: Hdc,
    pub(super) fErase: Bool,
    pub(super) rcPaint: Rect,
    pub(super) fRestore: Bool,
    pub(super) fIncUpdate: Bool,
    pub(super) rgbReserved: [u8; 32],
}

#[link(name = "Comctl32")]
unsafe extern "system" {
    pub(super) fn InitCommonControlsEx(picce: *const InitCommonControlsEx) -> Bool;
}

#[link(name = "Dwmapi")]
unsafe extern "system" {
    pub(super) fn DwmSetWindowAttribute(
        hwnd: Hwnd,
        dwAttribute: Dword,
        pvAttribute: *const c_void,
        cbAttribute: Dword,
    ) -> i32;
}

#[link(name = "Gdi32")]
unsafe extern "system" {
    pub(super) fn CreateFontW(
        cHeight: i32,
        cWidth: i32,
        cEscapement: i32,
        cOrientation: i32,
        cWeight: i32,
        bItalic: Dword,
        bUnderline: Dword,
        bStrikeOut: Dword,
        iCharSet: Dword,
        iOutPrecision: Dword,
        iClipPrecision: Dword,
        iQuality: Dword,
        iPitchAndFamily: Dword,
        pszFaceName: *const u16,
    ) -> Hfont;
    pub(super) fn CreateSolidBrush(color: Dword) -> Hbrush;
    pub(super) fn DeleteObject(ho: Hgdobj) -> Bool;
    pub(super) fn SelectObject(hdc: Hdc, h: Hgdobj) -> Hgdobj;
    pub(super) fn SetBkColor(hdc: Hdc, color: Dword) -> Dword;
    pub(super) fn SetBkMode(hdc: Hdc, mode: i32) -> i32;
    pub(super) fn SetTextColor(hdc: Hdc, color: Dword) -> Dword;
    pub(super) fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
    pub(super) fn CreateCompatibleBitmap(hdc: Hdc, cx: i32, cy: i32) -> Hgdobj;
    pub(super) fn DeleteDC(hdc: Hdc) -> Bool;
    pub(super) fn BitBlt(
        hdcDest: Hdc,
        xDest: i32,
        yDest: i32,
        w: i32,
        h: i32,
        hdcSrc: Hdc,
        xSrc: i32,
        ySrc: i32,
        rop: Dword,
    ) -> Bool;
}

#[link(name = "Kernel32")]
unsafe extern "system" {
    pub(super) fn GetModuleHandleW(lpModuleName: *const u16) -> Hinstance;
    pub(super) fn GlobalAlloc(uFlags: Uint, dwBytes: usize) -> isize;
    pub(super) fn GlobalLock(hMem: isize) -> *mut c_void;
    pub(super) fn GlobalUnlock(hMem: isize) -> Bool;
    pub(super) fn GlobalFree(hMem: isize) -> isize;
    pub(super) fn GetDiskFreeSpaceExW(
        lpDirectoryName: *const u16,
        lpFreeBytesAvailableToCaller: *mut u64,
        lpTotalNumberOfBytes: *mut u64,
        lpTotalNumberOfFreeBytes: *mut u64,
    ) -> Bool;
    pub(super) fn CreateActCtxW(pActCtx: *const ACTCTXW) -> Handle;
    pub(super) fn ActivateActCtx(hActCtx: Handle, lpCookie: *mut UlongPtr) -> Bool;
    pub(super) fn MoveFileExW(
        lpExistingFileName: *const u16,
        lpNewFileName: *const u16,
        dwFlags: Dword,
    ) -> Bool;
    pub(super) fn FlushFileBuffers(hFile: Handle) -> Bool;
    // Single-instance mutex API (Plan 02-02, Pattern 2)
    pub(super) fn CreateMutexW(
        lpMutexAttributes: *mut c_void,
        bInitialOwner: Bool,
        lpName: *const u16,
    ) -> Handle;
    pub(super) fn OpenMutexW(
        dwDesiredAccess: Dword,
        bInheritHandle: Bool,
        lpName: *const u16,
    ) -> Handle;
    pub(super) fn CloseHandle(hObject: Handle) -> Bool;
    pub(super) fn GetLastError() -> Dword;
    // Path canonicalization for WM_COPYDATA payload validation (D-06.3)
    pub(super) fn GetFullPathNameW(
        lpFileName: *const u16,
        nBufferLength: Dword,
        lpBuffer: *mut u16,
        lpFilePart: *mut *mut u16,
    ) -> Dword;
    pub(super) fn GetFileAttributesW(lpFileName: *const u16) -> Dword;
}

#[link(name = "Ole32")]
unsafe extern "system" {
    pub(super) fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: Dword) -> i32;
    pub(super) fn CoTaskMemFree(pv: *mut c_void);
    pub(super) fn CoUninitialize();
}

#[link(name = "Shell32")]
unsafe extern "system" {
    pub(super) fn SHBrowseForFolderW(lpbi: *mut BrowseInfoW) -> *mut c_void;
    pub(super) fn SHGetFileInfoW(
        pszPath: *const u16,
        dwFileAttributes: Dword,
        psfi: *mut ShFileInfoW,
        cbFileInfo: Uint,
        uFlags: Uint,
    ) -> usize;
    pub(super) fn SHGetPathFromIDListW(pidl: *mut c_void, pszPath: *mut u16) -> Bool;
    pub(super) fn ShellExecuteW(
        hwnd: Hwnd,
        lpOperation: *const u16,
        lpFile: *const u16,
        lpParameters: *const u16,
        lpDirectory: *const u16,
        nShowCmd: i32,
    ) -> isize;
    pub(super) fn SHGetKnownFolderPath(
        rfid: *const GUID,
        dwFlags: Dword,
        hToken: Handle,
        ppszPath: *mut *mut u16,
    ) -> i32;
}

#[link(name = "UxTheme")]
unsafe extern "system" {
    pub(super) fn SetWindowTheme(
        hwnd: Hwnd,
        pszSubAppName: *const u16,
        pszSubIdList: *const u16,
    ) -> i32;
}

#[link(name = "User32")]
unsafe extern "system" {
    pub(super) fn BeginPaint(hWnd: Hwnd, lpPaint: *mut PaintStruct) -> Hdc;
    pub(super) fn CreateWindowExW(
        dwExStyle: Dword,
        lpClassName: *const u16,
        lpWindowName: *const u16,
        dwStyle: Dword,
        X: i32,
        Y: i32,
        nWidth: i32,
        nHeight: i32,
        hWndParent: Hwnd,
        hMenu: Hmenu,
        hInstance: Hinstance,
        lpParam: *mut c_void,
    ) -> Hwnd;
    pub(super) fn DefWindowProcW(hwnd: Hwnd, msg: Uint, wparam: Wparam, lparam: Lparam) -> Lresult;
    pub(super) fn DestroyIcon(hIcon: Hicon) -> Bool;
    pub(super) fn DrawIconEx(
        hdc: Hdc,
        xLeft: i32,
        yTop: i32,
        hIcon: Hicon,
        cxWidth: i32,
        cyWidth: i32,
        istepIfAniCur: Uint,
        hbrFlickerFreeDraw: Hbrush,
        diFlags: Uint,
    ) -> Bool;
    pub(super) fn DrawTextW(
        hdc: Hdc,
        lpchText: *const u16,
        cchText: i32,
        lprc: *mut Rect,
        format: Uint,
    ) -> i32;
    pub(super) fn EndPaint(hWnd: Hwnd, lpPaint: *const PaintStruct) -> Bool;
    pub(super) fn FillRect(hDC: Hdc, lprc: *const Rect, hbr: Hbrush) -> i32;
    pub(super) fn DispatchMessageW(lpMsg: *const Msg) -> Lresult;
    pub(super) fn EnableWindow(hwnd: Hwnd, bEnable: Bool) -> Bool;
    pub(super) fn GetClientRect(hwnd: Hwnd, lpRect: *mut Rect) -> Bool;
    pub(super) fn GetMessageW(
        lpMsg: *mut Msg,
        hWnd: Hwnd,
        wMsgFilterMin: Uint,
        wMsgFilterMax: Uint,
    ) -> Bool;
    pub(super) fn GetWindowTextLengthW(hwnd: Hwnd) -> i32;
    pub(super) fn GetWindowTextW(hwnd: Hwnd, lpString: *mut u16, nMaxCount: i32) -> i32;
    pub(super) fn InvalidateRect(hwnd: Hwnd, lpRect: *const Rect, bErase: Bool) -> Bool;
    pub(super) fn LoadImageW(
        hInst: Hinstance,
        name: *const u16,
        type_: Uint,
        cx: i32,
        cy: i32,
        fuLoad: Uint,
    ) -> isize;
    pub(super) fn LoadCursorW(hInstance: Hinstance, lpCursorName: *const u16) -> Hcursor;
    pub(super) fn MessageBoxW(
        hwnd: Hwnd,
        lpText: *const u16,
        lpCaption: *const u16,
        uType: Uint,
    ) -> i32;
    pub(super) fn MoveWindow(
        hwnd: Hwnd,
        x: i32,
        y: i32,
        nWidth: i32,
        nHeight: i32,
        repaint: Bool,
    ) -> Bool;
    pub(super) fn PostMessageW(hwnd: Hwnd, msg: Uint, wparam: Wparam, lparam: Lparam) -> Bool;
    pub(super) fn PostQuitMessage(nExitCode: i32);
    pub(super) fn RegisterClassW(lpWndClass: *const WndClassW) -> u16;
    pub(super) fn SendMessageW(hwnd: Hwnd, msg: Uint, wparam: Wparam, lparam: Lparam) -> Lresult;
    pub(super) fn SetWindowTextW(hwnd: Hwnd, lpString: *const u16) -> Bool;
    pub(super) fn ShowWindow(hwnd: Hwnd, nCmdShow: i32) -> Bool;
    pub(super) fn TranslateMessage(lpMsg: *const Msg) -> Bool;
    pub(super) fn UpdateWindow(hwnd: Hwnd) -> Bool;
    pub(super) fn CreatePopupMenu() -> Hmenu;
    pub(super) fn AppendMenuW(
        hMenu: Hmenu,
        uFlags: Uint,
        uIDNewItem: usize,
        lpNewItem: *const u16,
    ) -> Bool;
    pub(super) fn TrackPopupMenu(
        hMenu: Hmenu,
        uFlags: Uint,
        x: i32,
        y: i32,
        nReserved: i32,
        hWnd: Hwnd,
        prcRect: *const Rect,
    ) -> Bool;
    pub(super) fn DestroyMenu(hMenu: Hmenu) -> Bool;
    pub(super) fn OpenClipboard(hWndNewOwner: Hwnd) -> Bool;
    pub(super) fn CloseClipboard() -> Bool;
    pub(super) fn EmptyClipboard() -> Bool;
    pub(super) fn SetClipboardData(uFormat: Uint, hMem: isize) -> isize;
    pub(super) fn GetCursorPos(lpPoint: *mut Point) -> Bool;
    pub(super) fn ScreenToClient(hWnd: Hwnd, lpPoint: *mut Point) -> Bool;
    pub(super) fn GetDpiForWindow(hwnd: Hwnd) -> Uint;
    // Single-instance foreground + window discovery (Plan 02-02, Pattern 2)
    pub(super) fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> Hwnd;
    pub(super) fn GetWindowThreadProcessId(hWnd: Hwnd, lpdwProcessId: *mut Dword) -> Dword;
    pub(super) fn AllowSetForegroundWindow(dwProcessId: Dword) -> Bool;
    pub(super) fn SetForegroundWindow(hWnd: Hwnd) -> Bool;
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(super) struct GUID {
    pub(super) Data1: u32,
    pub(super) Data2: u16,
    pub(super) Data3: u16,
    pub(super) Data4: [u8; 8],
}

#[repr(C)]
pub(super) struct ITEMIDLIST {
    pub(super) _unused: u8,
}

#[repr(C)]
pub(super) struct CMINVOKECOMMANDINFO {
    pub(super) cbSize: u32,
    pub(super) fMask: u32,
    pub(super) hwnd: Hwnd,
    pub(super) lpVerb: *const u8,
    pub(super) lpParameters: *const u8,
    pub(super) lpDirectory: *const u8,
    pub(super) nShow: i32,
    pub(super) dwHotKey: u32,
    pub(super) hIcon: Hicon,
}

#[repr(C)]
pub(super) struct IUnknownVtbl {
    pub(super) QueryInterface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> i32,
    pub(super) AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub(super) Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
}

#[repr(C)]
pub(super) struct IShellFolderVtbl {
    pub(super) QueryInterface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> i32,
    pub(super) AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub(super) Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub(super) ParseDisplayName: unsafe extern "system" fn(
        this: *mut c_void,
        hwnd: Hwnd,
        pbc: *mut c_void,
        pszDisplayName: *const u16,
        pchEaten: *mut u32,
        ppidl: *mut *mut ITEMIDLIST,
        pdwAttributes: *mut u32,
    ) -> i32,
    pub(super) EnumObjects: unsafe extern "system" fn(
        this: *mut c_void,
        hwnd: Hwnd,
        grfFlags: u32,
        ppenumIDList: *mut *mut c_void,
    ) -> i32,
    pub(super) BindToObject: unsafe extern "system" fn(
        this: *mut c_void,
        pidl: *const ITEMIDLIST,
        pbc: *mut c_void,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> i32,
    pub(super) BindToStorage: unsafe extern "system" fn(
        this: *mut c_void,
        pidl: *const ITEMIDLIST,
        pbc: *mut c_void,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> i32,
    pub(super) CompareIDs: unsafe extern "system" fn(
        this: *mut c_void,
        lParam: Lparam,
        pidl1: *const ITEMIDLIST,
        pidl2: *const ITEMIDLIST,
    ) -> i32,
    pub(super) CreateViewObject: unsafe extern "system" fn(
        this: *mut c_void,
        hwndOwner: Hwnd,
        riid: *const GUID,
        ppv: *mut *mut c_void,
    ) -> i32,
    pub(super) GetAttributesOf: unsafe extern "system" fn(
        this: *mut c_void,
        cidl: u32,
        apidl: *mut *const ITEMIDLIST,
        rgfInOut: *mut u32,
    ) -> i32,
    pub(super) GetUIObjectOf: unsafe extern "system" fn(
        this: *mut c_void,
        hwndOwner: Hwnd,
        cidl: u32,
        apidl: *mut *const ITEMIDLIST,
        riid: *const GUID,
        rgfReserved: *mut u32,
        ppv: *mut *mut c_void,
    ) -> i32,
    pub(super) GetDisplayNameOf: unsafe extern "system" fn(
        this: *mut c_void,
        pidl: *const ITEMIDLIST,
        dwFlags: u32,
        pName: *mut c_void,
    ) -> i32,
    pub(super) SetNameOf: unsafe extern "system" fn(
        this: *mut c_void,
        hwnd: Hwnd,
        pidl: *const ITEMIDLIST,
        pszName: *const u16,
        dwFlags: u32,
        ppidlOut: *mut *mut ITEMIDLIST,
    ) -> i32,
}

#[repr(C)]
pub(super) struct IContextMenuVtbl {
    pub(super) QueryInterface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppvObject: *mut *mut c_void,
    ) -> i32,
    pub(super) AddRef: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub(super) Release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub(super) QueryContextMenu: unsafe extern "system" fn(
        this: *mut c_void,
        hmenu: Hmenu,
        indexMenu: u32,
        idCmdFirst: u32,
        idCmdLast: u32,
        uFlags: u32,
    ) -> i32,
    pub(super) InvokeCommand:
        unsafe extern "system" fn(this: *mut c_void, lpici: *const CMINVOKECOMMANDINFO) -> i32,
    pub(super) GetCommandString: unsafe extern "system" fn(
        this: *mut c_void,
        idCmd: usize,
        uType: u32,
        pwReserved: *mut u32,
        pszName: *mut u8,
        cchMax: u32,
    ) -> i32,
}

pub(super) const IID_IShellFolder: GUID = GUID {
    Data1: 0x000214E6,
    Data2: 0x0000,
    Data3: 0x0000,
    Data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

pub(super) const IID_IContextMenu: GUID = GUID {
    Data1: 0x000214E4,
    Data2: 0x0000,
    Data3: 0x0000,
    Data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

pub(super) const TPM_RETURNCMD: Uint = 0x0100;

#[link(name = "Shell32")]
unsafe extern "system" {
    pub(super) fn SHParseDisplayName(
        pszName: *const u16,
        pbc: *mut c_void,
        ppidl: *mut *mut ITEMIDLIST,
        sfgaoIn: u32,
        psfgaoOut: *mut u32,
    ) -> i32;

    pub(super) fn SHBindToParent(
        pidl: *const ITEMIDLIST,
        riid: *const GUID,
        ppv: *mut *mut c_void,
        ppidlLast: *mut *const ITEMIDLIST,
    ) -> i32;
}

/// Atomically renames `tmp_path` to `final_path` using
/// `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`.
/// Returns `Ok(())` on success, `Err(io::Error::last_os_error())` on failure.
/// Same-volume NTFS rename is atomic; callers must close the temp file handle
/// before calling this function.
pub(crate) fn atomic_rename(tmp_path: *const u16, final_path: *const u16) -> io::Result<()> {
    // SAFETY: pointers are valid for the duration of the call; the file is
    // closed before this call; MoveFileExW does not retain the pointers.
    let ok = unsafe {
        MoveFileExW(
            tmp_path,
            final_path,
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Win32 COPYDATASTRUCT — carries the path payload in WM_COPYDATA messages.
/// IMPORTANT: `lpData` is valid ONLY for the duration of the synchronous
/// `SendMessageW` call. The receiver MUST memcpy the payload into a local
/// buffer before `SendMessageW` returns (see Pitfall #2 in 02-RESEARCH.md).
#[repr(C)]
pub(crate) struct CopyDataStruct {
    /// Magic discriminator — must equal `FILETREE_PATH_MSG_ID` to be accepted.
    pub(crate) dwData: UlongPtr,
    /// Byte length of the payload (must be even; payload is UTF-16 pairs).
    pub(crate) cbData: Dword,
    /// Pointer to the UTF-16 path payload. Valid only during SendMessageW.
    pub(crate) lpData: *const c_void,
}

/// Acquires the single-instance named mutex `Local\FileTree.SingleInstance.v1`.
///
/// - **Primary instance**: returns `Ok(mutex_handle)`. Caller MUST keep the
///   returned handle alive for the process lifetime (dropping it releases the
///   mutex). The OS auto-releases it on process exit.
/// - **Second instance**: finds the primary window, requests foreground rights,
///   forwards `initial_path` via WM_COPYDATA, then calls `std::process::exit(0)`.
///   This function never returns for the second instance.
///
/// Errors are returned only when `CreateMutexW` itself fails (very rare — out
/// of kernel resources).
///
/// # Safety
/// Calls Win32 APIs. Must be called from the UI thread before the message loop.
pub(crate) unsafe fn try_forward_or_acquire(
    initial_path: &std::path::Path,
) -> Result<Handle, std::io::Error> {
    let name = crate::io::wide("Local\\FileTree.SingleInstance.v1");
    let mutex = CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr());
    if mutex == 0 {
        return Err(std::io::Error::last_os_error());
    }

    if GetLastError() == ERROR_ALREADY_EXISTS {
        // We are a second instance — the primary already holds the mutex.
        CloseHandle(mutex);

        // Locate the primary window by its registered class name.
        let class_name = crate::io::wide("FileTreeDesktopWindow");
        let hwnd = FindWindowW(class_name.as_ptr(), std::ptr::null());
        if hwnd != 0 {
            // Grant the primary process foreground rights before sending.
            // Belt-and-suspenders per Pitfall #9: AllowSetForegroundWindow
            // gives explicit rights; SendMessageW also grants implicit rights
            // via the message-dispatch contract.
            let mut pid: Dword = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            AllowSetForegroundWindow(pid); // best-effort; ignore return value

            // Forward the requested path as a UTF-16 WM_COPYDATA payload.
            // The path is NUL-terminated so the receiver can strip the NUL.
            let path_u16: Vec<u16> = initial_path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let bytes = path_u16.len().saturating_mul(2);
            if bytes as u32 <= MAX_COPYDATA_BYTES {
                let cds = CopyDataStruct {
                    dwData: FILETREE_PATH_MSG_ID,
                    cbData: bytes as Dword,
                    lpData: path_u16.as_ptr() as *const c_void,
                };
                // SendMessageW is synchronous — lpData is valid for the entire call.
                SendMessageW(hwnd, WM_COPYDATA, 0, &cds as *const _ as Lparam);
            }

            // Pop the primary window to the foreground (belt-and-suspenders #2).
            SetForegroundWindow(hwnd);
        }

        // Second instance always exits 0 — no window created, clean exit.
        std::process::exit(0);
    }

    // Primary instance — return the mutex handle. Caller holds it for the process
    // lifetime; no explicit CloseHandle needed (OS releases it on exit).
    Ok(mutex)
}

/// Resolves `%APPDATA%` (`FOLDERID_RoamingAppData`) via the Shell API.
/// Returns the path as a `PathBuf` on success, or an `io::Error` on failure.
/// This is the only correct way to resolve the AppData path; env-var
/// concatenation does not respect Group Policy folder redirection.
pub(crate) fn known_folder_roaming_appdata() -> io::Result<PathBuf> {
    let mut ptr: *mut u16 = std::ptr::null_mut();
    // SAFETY: FOLDERID_RoamingAppData is a valid GUID constant; ptr receives
    // a CoTaskMem-allocated wide string that we free via CoTaskMemFree below.
    let hr = unsafe { SHGetKnownFolderPath(&FOLDERID_RoamingAppData, 0, 0, &mut ptr) };
    if hr < 0 {
        return Err(io::Error::from_raw_os_error(hr));
    }
    // Compute length of the NUL-terminated wide string without pulling in wcslen.
    let len = unsafe {
        let mut end = ptr;
        while *end != 0 {
            end = end.add(1);
        }
        end.offset_from(ptr) as usize
    };
    let wide_slice = unsafe { slice::from_raw_parts(ptr, len) };
    let path_str = String::from_utf16_lossy(wide_slice);
    unsafe { CoTaskMemFree(ptr as *mut c_void) };
    Ok(PathBuf::from(path_str))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::{offset_of, size_of};

    /// Verifies CopyDataStruct layout matches Win32 COPYDATASTRUCT on x86_64.
    /// Win32 layout: ULONG_PTR(8) + DWORD(4) + 4-byte natural padding + PVOID(8) = 24 bytes.
    /// The padding appears because PVOID is 8-byte aligned on x86_64.
    #[test]
    fn copydatastruct_layout_matches_win32() {
        // On x86_64 Windows the struct is exactly 24 bytes due to natural alignment.
        #[cfg(target_pointer_width = "64")]
        assert_eq!(size_of::<CopyDataStruct>(), 24);
        #[cfg(target_pointer_width = "32")]
        assert_eq!(size_of::<CopyDataStruct>(), 12);

        // dwData is at offset 0.
        assert_eq!(offset_of!(CopyDataStruct, dwData), 0);
        // cbData immediately follows dwData (offset == size of UlongPtr).
        assert_eq!(offset_of!(CopyDataStruct, cbData), size_of::<UlongPtr>());
        // lpData is pointer-aligned; on x86_64 that means offset 16 (8 + 4 + 4 pad).
        #[cfg(target_pointer_width = "64")]
        assert_eq!(offset_of!(CopyDataStruct, lpData), 16);
        #[cfg(target_pointer_width = "32")]
        assert_eq!(offset_of!(CopyDataStruct, lpData), 8);
    }

    /// Verifies WM_COPYDATA and related constants match Win32 header values.
    #[test]
    fn copydata_constants_match_win32() {
        assert_eq!(WM_COPYDATA, 0x004A);
        assert_eq!(FILETREE_PATH_MSG_ID, 0x46540001);
        assert_eq!(MAX_COPYDATA_BYTES, 65536);
        assert_eq!(ERROR_ALREADY_EXISTS, 183);
        assert_eq!(INVALID_FILE_ATTRIBUTES, 0xFFFF_FFFF);
    }
}
