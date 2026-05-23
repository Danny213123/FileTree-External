# Phase 2: Settings & Polish - Research

**Researched:** 2026-05-23
**Domain:** Win32 native desktop persistence + UX polish (settings file I/O, single-instance, autocomplete, accelerators, status bar)
**Confidence:** HIGH (Win32 APIs are stable, documented, and all already linked by the project; the unverified surface is small and isolated)

## Summary

Phase 2 lands the persistence and polish layer on top of the Phase-1 module layout. All decisions are locked in CONTEXT.md (D-01..D-06 + Claude's-discretion defaults); the research question is **how to wire each locked decision against the existing Win32 FFI surface in `src/desktop/ffi.rs`** while honoring the hard constraint of zero new Rust crates.

The phase divides cleanly into four implementation strands that can be sequenced independently:
1. **`src/settings.rs` module** — `Settings` struct, hand-rolled JSON reader (~150-300 LOC), writer reusing `export::push_json_string`, `RawJsonValue` round-trip type, `SettingsStore` (load + atomic save).
2. **Single-instance + WM_COPYDATA** in `src/cli.rs` (mutex acquire, IPC send) and `src/desktop/state.rs` (WM_COPYDATA receive + validate).
3. **Path bar** (ComboBoxEx32 drive picker + `SHAutoComplete`-wired edit) in `src/desktop/mod.rs` create-controls / resize-controls hot path.
4. **Accelerators + status bar** — `LoadAcceleratorsW` table + `TranslateAcceleratorW` in the message pump (`src/desktop/mod.rs::run`), `msctls_statusbar32` common control replacing the current STATIC status placeholder.

**Primary recommendation:** Land strand 1 (settings module + tests) first because it is pure Rust + has unit-test coverage. Land strand 2 second because it gates everything else (must run before window creation). Land strands 3 and 4 in either order — they share no state.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Read/write `settings.json` | Settings module (`src/settings.rs`) | OS filesystem | Pure data layer; no Win32 dependency except `SHGetKnownFolderPath` for the dir resolve |
| Path resolution via `FOLDERID_RoamingAppData` | Settings module | Win32 Shell32 | Crosses into Shell32 FFI but the call is one-shot at startup; lives in `settings.rs` with FFI decl in `desktop/ffi.rs` |
| Named-mutex single-instance | CLI entry (`src/cli.rs`) | Win32 Kernel32 | Must run before `desktop::run()` enters the message loop; CLI owns process-lifetime concerns |
| WM_COPYDATA send (second instance) | CLI entry (`src/cli.rs`) | Win32 User32 | Same call site as the mutex check; second instance exits 0 without ever creating a window |
| WM_COPYDATA receive + validate | Desktop state (`src/desktop/state.rs`) | Win32 Shell32 | Existing window-proc dispatch hub; validation logic naturally lives next to the dispatcher |
| Settings load → DesktopState initial values | CLI entry (load) → desktop::run (consume) | — | Load before window creation to avoid load-then-mutate races |
| Settings save on mutation | Desktop state mutation sites | Settings module | Every `with_state_mut` call site that changes a persisted field calls the save helper |
| Drag-coalesce flush (D-03 mitigation) | Desktop paint/state (`src/desktop/paint.rs`, `state.rs`) | — | `WM_LBUTTONUP` (column drag end) and `WM_EXITSIZEMOVE` (window resize end) are message-loop concerns |
| Drive picker dropdown | Desktop create-controls | Win32 ComboBoxEx32 | Standard common control, lives where the path edit is created |
| Path autocomplete | Desktop create-controls | Win32 Shell32 (`SHAutoComplete`) | Single call after `CreateWindowExW` returns the edit HWND |
| Accelerator table dispatch | Desktop message pump (`desktop/mod.rs::run`) | Win32 User32 | One-line addition to the existing `GetMessageW` loop |
| Status bar 5-pane layout | Desktop paint (`src/desktop/paint.rs`) | Win32 Comctl32 (`msctls_statusbar32`) | Reuses existing WM_SIZE reflow plumbing |
| Status bar throughput tick | Desktop state (WM_SCAN_PROGRESS handler) | — | Existing 1500 ms tick from `scan.rs`; no new timer |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Rust std | 1.95 (edition 2024) | All app code | `[CITED: Cargo.toml]` Zero-dependency posture is a hard project constraint |
| Win32 Shell32.dll | OS-bundled (Win10+) | `SHGetKnownFolderPath`, `SHAutoComplete`, `SHParseDisplayName` | `[VERIFIED: src/desktop/ffi.rs already links Shell32]` |
| Win32 Kernel32.dll | OS-bundled (Win10+) | `CreateMutexW`, `OpenMutexW`, `MoveFileExW`, `FlushFileBuffers`, `GetLastError`, `GetLogicalDrives`, `GetDriveTypeW`, `GetFullPathNameW`, `GetFileAttributesW` | `[VERIFIED: src/desktop/ffi.rs already links Kernel32]` |
| Win32 User32.dll | OS-bundled (Win10+) | `FindWindowW`, `SendMessageW` + `WM_COPYDATA`, `SetForegroundWindow`, `AllowSetForegroundWindow`, `LoadAcceleratorsW`, `CreateAcceleratorTableW`, `TranslateAcceleratorW`, `GetWindowThreadProcessId`, `AttachThreadInput` | `[VERIFIED: src/desktop/ffi.rs already links User32]` |
| Win32 Comctl32.dll v6 | OS-bundled (Win10+) | `msctls_statusbar32`, `ComboBoxEx32` | `[VERIFIED: src/desktop/ffi.rs already links Comctl32; visual-styles manifest already enabled in desktop/mod.rs::enable_visual_styles]` |
| Win32 Ole32.dll | OS-bundled (Win10+) | `CoTaskMemFree` (free the path returned by `SHGetKnownFolderPath`) | `[VERIFIED: src/desktop/ffi.rs already links Ole32]` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `std::fs::File` + `OpenOptions` | std | Write `settings.json.tmp` | Standard temp-file write before MoveFileExW |
| `std::sync::OnceLock` | std | `STATE` singleton (already used in `desktop/state.rs`) | Settings store goes through the same dispatcher; no new singleton needed |
| `std::path::PathBuf` | std | Settings file path assembly | Compose `%APPDATA%\FileTree\settings.json` after `SHGetKnownFolderPath` |
| `std::os::windows::ffi::OsStrExt` | std | UTF-16 wide-string conversion | Already used throughout `desktop/mod.rs` via the `wide()` helper |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled JSON parser | `serde` + `serde_json` | Rejected by D-01 and PROJECT.md zero-deps constraint; would add ~150 KB to the binary |
| `SHAutoComplete` | Manual `IAutoComplete2` vtable | Rejected by Claude's-discretion default; only revisit if SHAutoComplete misbehaves on Win11 26100 |
| `msctls_statusbar32` common control | Custom-painted status bar | Common control is one line of `CreateWindowExW` + standard reflow; matches existing dark-mode treatment via `SetWindowTheme` |
| `CreateAcceleratorTableW` (in-code) | `LoadAcceleratorsW` (resource file) | In-code construction avoids the `.rc` + resource-compiler toolchain; the project has no `.rc` infrastructure today. **Recommend `CreateAcceleratorTableW`** with a hardcoded `[ACCEL; 6]` array. |
| `MoveFileExW(..., WRITE_THROUGH)` only | `FlushFileBuffers` on directory handle | See Pitfall 4 below — MOVEFILE_WRITE_THROUGH on the rename is sufficient for personal-use durability; cross-process directory-handle fsync is overkill |

**Installation:** None. All dependencies are OS-bundled Win32 DLLs already linked.

**Version verification:** Not applicable — no crate dependencies. Rust toolchain verified via `cargo --version` → `cargo 1.95.0 (f2d3ce0bd 2026-03-21)` and `rustc --version` → `rustc 1.95.0 (59807616e 2026-04-14)`. Edition 2024 supported.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Process startup (cli::run)                                     │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 1. Parse argv                                              │ │
│  │ 2. If subcommand ∈ {desktop|gui|""} → mutex_acquire()      │ │
│  │      ├─ CreateMutexW("Local\FileTree.SingleInstance.v1")   │ │
│  │      ├─ ERROR_ALREADY_EXISTS? ──┐                          │ │
│  │      │                          │                          │ │
│  │      │             ┌────────────▼────────────────┐         │ │
│  │      │             │ Second-instance forward:    │         │ │
│  │      │             │  FindWindowW(class)         │         │ │
│  │      │             │  GetWindowThreadProcessId   │         │ │
│  │      │             │  AllowSetForegroundWindow   │         │ │
│  │      │             │  SendMessageW(WM_COPYDATA)  │         │ │
│  │      │             │  SetForegroundWindow(hwnd)  │         │ │
│  │      │             │  exit 0                     │         │ │
│  │      │             └─────────────────────────────┘         │ │
│  │      └─ else → continue as primary                         │ │
│  │ 3. settings = SettingsStore::load_or_default()             │ │
│  │ 4. desktop::run(initial_path, settings)                    │ │
│  └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────┬────────────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────┐
                  │  Win32 message loop (desktop::run)  │
                  │  GetMessageW → TranslateAccelerator │
                  │              → TranslateMessage     │
                  │              → DispatchMessageW     │
                  └──────────────────┬──────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
        ▼                            ▼                            ▼
┌───────────────┐         ┌───────────────────┐        ┌───────────────────┐
│ WM_COMMAND    │         │ WM_COPYDATA       │        │ WM_SCAN_PROGRESS  │
│ (accelerator  │         │ (validate +       │        │ (1500ms tick from │
│  fires here)  │         │  start_scan)      │        │  scan.rs)         │
└───────┬───────┘         └─────────┬─────────┘        └─────────┬─────────┘
        │                           │                            │
        ▼                           ▼                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│ DesktopState mutation (with_state_mut)                               │
│  ├─ persisted field changed?  ──► SettingsStore::save(&settings)     │
│  │                                  │                                │
│  │                                  ▼                                │
│  │                       ┌──────────────────────────┐                │
│  │                       │ atomic_write_settings()  │                │
│  │                       │  1. open tmp file        │                │
│  │                       │  2. write JSON bytes     │                │
│  │                       │  3. FlushFileBuffers     │                │
│  │                       │  4. close                │                │
│  │                       │  5. MoveFileExW(         │                │
│  │                       │     tmp, final,          │                │
│  │                       │     REPLACE_EXISTING|    │                │
│  │                       │     WRITE_THROUGH)       │                │
│  │                       └──────────────────────────┘                │
│  └─ drag-style event?  ──► buffer in DesktopState.pending_settings;  │
│                            flush on WM_LBUTTONUP / WM_EXITSIZEMOVE   │
└──────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
src/
├── main.rs                          # unchanged: thin mod list + main()
├── cli.rs                           # MODIFIED: mutex acquire + WM_COPYDATA send before run_desktop
├── settings.rs                      # NEW (~400-600 LOC total)
│   # contains:
│   #   pub(crate) struct Settings { ... persisted fields ... }
│   #   pub(crate) enum RawJsonValue { Object, Array, Str, Int, Float, Bool, Null }
│   #   pub(crate) struct SettingsStore { path: PathBuf }
│   #   pub(crate) fn parse_settings_json(text: &str) -> Result<Settings, ParseError>
│   #   pub(crate) fn push_settings_json(out: &mut String, settings: &Settings)
│   #   fn parse_json_value(...)            # recursive descent
│   #   fn atomic_write_settings(...)       # temp + MoveFileExW
│   #   fn settings_dir() -> io::Result<PathBuf>   # SHGetKnownFolderPath wrapper
│   #
│   #   #[cfg(test)] mod tests { ... round-trip, unknown-keys, escapes ... }
├── desktop/
│   ├── mod.rs                       # MODIFIED: accelerator table + status bar create + WM_COPYDATA arm
│   ├── ffi.rs                       # MODIFIED: add ~25 new FFI decls (see "New FFI declarations" below)
│   ├── state.rs                     # MODIFIED: add pending_settings, save-on-mutate helper
│   ├── paint.rs                     # MODIFIED: SB_SETPARTS + SB_SETTEXTW on status bar reflow
│   ├── shell.rs                     # MODIFIED: WM_COPYDATA validation helper (GetFullPathNameW + GetFileAttributesW)
│   ├── theme.rs                     # unchanged
│   ├── tabs.rs                      # unchanged
│   └── treemap.rs                   # unchanged
```

### Pattern 1: Atomic Settings Write (D-03)

**What:** Write JSON to a `.tmp` sibling, fsync the temp file, then `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`.

**When to use:** Every `Settings` mutation outside drag-coalesce windows.

**Example:**
```rust
// Source: [CITED: learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw]
// Constants verified against Windows SDK headers.

pub(crate) const MOVEFILE_REPLACE_EXISTING: Dword = 0x0000_0001;
pub(crate) const MOVEFILE_WRITE_THROUGH:    Dword = 0x0000_0008;

#[link(name = "Kernel32")]
unsafe extern "system" {
    pub(super) fn MoveFileExW(
        lpExistingFileName: *const u16,
        lpNewFileName: *const u16,
        dwFlags: Dword,
    ) -> Bool;
    pub(super) fn FlushFileBuffers(hFile: Handle) -> Bool;
}

fn atomic_write_settings(final_path: &Path, body: &[u8]) -> io::Result<()> {
    let mut tmp_path = final_path.to_path_buf();
    let tmp_name = format!(
        "{}.tmp",
        final_path.file_name().and_then(|s| s.to_str()).unwrap_or("settings.json"),
    );
    tmp_path.set_file_name(tmp_name);

    {
        let mut f = OpenOptions::new()
            .write(true).create(true).truncate(true)
            .open(&tmp_path)?;
        f.write_all(body)?;
        f.sync_all()?;          // std equivalent: FlushFileBuffers on the file handle
    }                            // drop closes the handle before MoveFileExW

    let src = wide_path(&tmp_path);
    let dst = wide_path(final_path);
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(), dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        let _ = fs::remove_file(&tmp_path);
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
```

### Pattern 2: Single-Instance Mutex + WM_COPYDATA Forward (D-04, D-05, D-06)

**What:** First call from `cli::run` before window creation. Primary holds mutex for entire process lifetime; second instance forwards path and exits.

**When to use:** Only on `desktop`/`gui` subcommand path. `serve` and `scan` skip this entirely.

**Example:**
```rust
// Source: [CITED: learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw]
//         [CITED: learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-copydatastruct]

pub(crate) const ERROR_ALREADY_EXISTS: Dword = 183;
pub(crate) const WM_COPYDATA: Uint = 0x004A;
pub(crate) const FILETREE_PATH_MSG_ID: UlongPtr = 0x46540001;
pub(crate) const MAX_COPYDATA_BYTES: u32 = 64 * 1024;

#[repr(C)]
pub(super) struct CopyDataStruct {
    pub(super) dwData: UlongPtr,
    pub(super) cbData: Dword,
    pub(super) lpData: *const c_void,
}

#[link(name = "Kernel32")]
unsafe extern "system" {
    pub(super) fn CreateMutexW(
        lpMutexAttributes: *mut c_void,
        bInitialOwner: Bool,
        lpName: *const u16,
    ) -> Handle;
    pub(super) fn CloseHandle(hObject: Handle) -> Bool;
    pub(super) fn GetLastError() -> Dword;
}

#[link(name = "User32")]
unsafe extern "system" {
    pub(super) fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> Hwnd;
    pub(super) fn GetWindowThreadProcessId(hWnd: Hwnd, lpdwProcessId: *mut Dword) -> Dword;
    pub(super) fn AllowSetForegroundWindow(dwProcessId: Dword) -> Bool;
    pub(super) fn SetForegroundWindow(hWnd: Hwnd) -> Bool;
}

unsafe fn try_forward_or_acquire(initial_path: &Path) -> Result<Handle, ()> {
    let name = wide("Local\\FileTree.SingleInstance.v1");
    let mutex = CreateMutexW(null_mut(), 0, name.as_ptr());
    if mutex == 0 { return Err(()); }
    if GetLastError() == ERROR_ALREADY_EXISTS {
        CloseHandle(mutex);
        let class = wide("FileTreeDesktopWindow");
        let hwnd = FindWindowW(class.as_ptr(), null());
        if hwnd != 0 {
            let mut pid: Dword = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            AllowSetForegroundWindow(pid);
            let path_str = initial_path.to_string_lossy().into_owned();
            let path_u16: Vec<u16> = path_str.encode_utf16().chain(Some(0)).collect();
            let bytes = path_u16.len().saturating_mul(2);
            if bytes as u32 <= MAX_COPYDATA_BYTES {
                let cds = CopyDataStruct {
                    dwData: FILETREE_PATH_MSG_ID,
                    cbData: bytes as Dword,
                    lpData: path_u16.as_ptr() as *const c_void,
                };
                SendMessageW(hwnd, WM_COPYDATA, 0, &cds as *const _ as Lparam);
            }
            SetForegroundWindow(hwnd);
        }
        std::process::exit(0);
    }
    Ok(mutex)  // primary; hold for process lifetime
}
```

### Pattern 3: WM_COPYDATA Receive + Validate (D-06)

```rust
// Source: [CITED: learn.microsoft.com/en-us/windows/win32/dataxchg/wm-copydata]
// "If the receiving application must access the data after SendMessage returns,
//  it must copy the data into a local buffer."

WM_COPYDATA => {
    if lparam == 0 { return 0; }
    let cds = &*(lparam as *const CopyDataStruct);
    if cds.dwData != FILETREE_PATH_MSG_ID { return 0; }
    if cds.cbData == 0 || cds.cbData > MAX_COPYDATA_BYTES { return 0; }
    if cds.cbData % 2 != 0 { return 0; }

    let u16_len = (cds.cbData as usize) / 2;
    let mut buf: Vec<u16> = vec![0; u16_len];
    std::ptr::copy_nonoverlapping(cds.lpData as *const u16, buf.as_mut_ptr(), u16_len);
    if let Some(&0) = buf.last() { buf.pop(); }
    let raw = String::from_utf16_lossy(&buf);

    if let Some(canonical) = canonicalize_and_check_dir(&raw) {
        with_state_mut(|state| set_window_text(state.path_edit, &canonical));
        start_scan_from_controls(hwnd);
        SetForegroundWindow(hwnd);
    }
    return 1;
}
```

Validation helper (in `desktop/shell.rs`):
```rust
pub(crate) const INVALID_FILE_ATTRIBUTES: Dword = 0xFFFF_FFFF;
pub(crate) const FILE_ATTRIBUTE_DIRECTORY: Dword = 0x0000_0010;  // already in ffi.rs

#[link(name = "Kernel32")]
unsafe extern "system" {
    pub(super) fn GetFullPathNameW(
        lpFileName: *const u16, nBufferLength: Dword,
        lpBuffer: *mut u16, lpFilePart: *mut *mut u16,
    ) -> Dword;
    pub(super) fn GetFileAttributesW(lpFileName: *const u16) -> Dword;
}

unsafe fn canonicalize_and_check_dir(raw: &str) -> Option<String> {
    let raw_w = wide(raw);
    let needed = GetFullPathNameW(raw_w.as_ptr(), 0, null_mut(), null_mut());
    if needed == 0 { return None; }
    let mut buf = vec![0u16; needed as usize];
    let written = GetFullPathNameW(
        raw_w.as_ptr(), buf.len() as Dword,
        buf.as_mut_ptr(), null_mut(),
    );
    if written == 0 || written >= buf.len() as Dword { return None; }
    buf.truncate(written as usize);
    let attrs = GetFileAttributesW(buf.as_ptr() /* still NUL-terminated */ );
    // GetFullPathNameW returns length WITHOUT the NUL; re-NUL-terminate for attribute query
    let mut nul_term = buf.clone();
    nul_term.push(0);
    let attrs = GetFileAttributesW(nul_term.as_ptr());
    if attrs == INVALID_FILE_ATTRIBUTES { return None; }
    if attrs & FILE_ATTRIBUTE_DIRECTORY == 0 { return None; }
    Some(String::from_utf16_lossy(&buf))
}
```

### Pattern 4: ComboBoxEx32 Drive Picker (POL-01)

```rust
// Source: [CITED: learn.microsoft.com/en-us/windows/win32/controls/comboboxex-controls]
// Class name: "ComboBoxEx32"

pub(crate) const CBEM_INSERTITEMW: Uint = 0x040B;
pub(crate) const CBEIF_TEXT:       Uint = 0x00000001;
pub(crate) const CBS_DROPDOWNLIST: Dword = 0x0003;
pub(crate) const ICC_USEREX_CLASSES: Dword = 0x00000200;

pub(crate) const DRIVE_FIXED:     Uint = 3;
pub(crate) const DRIVE_REMOVABLE: Uint = 2;
pub(crate) const DRIVE_REMOTE:    Uint = 4;
pub(crate) const DRIVE_CDROM:     Uint = 5;

#[link(name = "Kernel32")]
unsafe extern "system" {
    pub(super) fn GetLogicalDrives() -> Dword;
    pub(super) fn GetDriveTypeW(lpRootPathName: *const u16) -> Uint;
}

#[repr(C)]
pub(super) struct ComboBoxExItemW {
    pub(super) mask: Uint,
    pub(super) iItem: isize,
    pub(super) pszText: *mut u16,
    pub(super) cchTextMax: i32,
    pub(super) iImage: i32,
    pub(super) iSelectedImage: i32,
    pub(super) iOverlay: i32,
    pub(super) iIndent: i32,
    pub(super) lParam: Lparam,
}
```

**Note:** `ICC_USEREX_CLASSES` must be OR'd into the existing `InitCommonControlsEx.dwICC` in `desktop/mod.rs::run` — today it only requests `ICC_LISTVIEW_CLASSES`. ComboBoxEx will not register without this. The status-bar class `msctls_statusbar32` requires `ICC_BAR_CLASSES = 0x00000004`.

### Pattern 5: SHAutoComplete on Path Edit (POL-01)

```rust
// Source: [CITED: learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-shautocomplete]
// SHAutoComplete lives in shlwapi.dll, NOT shell32.dll — add a new #[link] block.

pub(crate) const SHACF_FILESYS_DIRS:          Dword = 0x00000020;
pub(crate) const SHACF_AUTOSUGGEST_FORCE_ON:  Dword = 0x10000000;
pub(crate) const SHACF_AUTOAPPEND_FORCE_ON:   Dword = 0x40000000;

#[link(name = "Shlwapi")]
unsafe extern "system" {
    pub(super) fn SHAutoComplete(hwndEdit: Hwnd, dwFlags: Dword) -> i32;
}

// In create_controls, AFTER state.path_edit = CreateWindowExW(...):
unsafe {
    SHAutoComplete(
        state.path_edit,
        SHACF_FILESYS_DIRS | SHACF_AUTOSUGGEST_FORCE_ON | SHACF_AUTOAPPEND_FORCE_ON,
    );
}
```

**Verification note (Win11 26100):** `SHAutoComplete` is a long-standing API (XP-era) and remains documented on current MSFT Learn pages without deprecation notice. No reports of breakage on Win11 24H2/26100 found in standard searches. **Confidence: MEDIUM** — verify by manual smoke test on the dev machine. Fallback path (manual `IAutoComplete2` vtable wire-up) is captured as a deferred-only follow-up.

### Pattern 6: Accelerator Table for POL-02 Shortcuts

```rust
// Source: [CITED: learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createacceleratortablew]
//         [CITED: learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-accel]

#[repr(C)]
pub(super) struct Accel {
    pub(super) fVirt: u8,
    pub(super) padding: u8,   // ACCEL is 6 bytes — needs 1-byte align on key
    pub(super) key: u16,
    pub(super) cmd: u16,
}
// NOTE: Win32 ACCEL is #pragma pack(1). Use #[repr(C, packed)] and
// confirm field ordering matches winuser.h exactly:
//   BYTE fVirt; WORD key; WORD cmd;  (5 bytes packed, padded to 6)

pub(crate) const FVIRTKEY: u8 = 0x01;
pub(crate) const FCONTROL: u8 = 0x08;
pub(crate) const FALT:     u8 = 0x10;
pub(crate) const FSHIFT:   u8 = 0x04;
pub(crate) const FNOINVERT: u8 = 0x02;

pub(crate) const VK_RETURN: u16 = 0x0D;
pub(crate) const VK_ESCAPE: u16 = 0x1B;
pub(crate) const VK_DELETE: u16 = 0x2E;
pub(crate) const VK_F5:     u16 = 0x74;

pub(crate) const CMD_SCAN:          u16 = 0xA001;
pub(crate) const CMD_CANCEL_SCAN:   u16 = 0xA002;
pub(crate) const CMD_DELETE_SEL:    u16 = 0xA003;
pub(crate) const CMD_FOCUS_SEARCH:  u16 = 0xA004;  // no-op stub in Phase 2
pub(crate) const CMD_EXPORT:        u16 = 0xA005;
pub(crate) const CMD_REFRESH:       u16 = 0xA006;

#[link(name = "User32")]
unsafe extern "system" {
    pub(super) fn CreateAcceleratorTableW(paccel: *const Accel, cAccel: i32) -> Handle;
    pub(super) fn TranslateAcceleratorW(hWnd: Hwnd, hAccTable: Handle, lpMsg: *mut Msg) -> i32;
    pub(super) fn DestroyAcceleratorTable(hAccel: Handle) -> Bool;
}

// In desktop::run, after window creation, before the message loop:
let accels: [Accel; 6] = [
    Accel { fVirt: FVIRTKEY,           padding: 0, key: VK_RETURN, cmd: CMD_SCAN },
    Accel { fVirt: FVIRTKEY,           padding: 0, key: VK_ESCAPE, cmd: CMD_CANCEL_SCAN },
    Accel { fVirt: FVIRTKEY,           padding: 0, key: VK_DELETE, cmd: CMD_DELETE_SEL },
    Accel { fVirt: FVIRTKEY | FCONTROL, padding: 0, key: 'F' as u16, cmd: CMD_FOCUS_SEARCH },
    Accel { fVirt: FVIRTKEY | FCONTROL, padding: 0, key: 'E' as u16, cmd: CMD_EXPORT },
    Accel { fVirt: FVIRTKEY,           padding: 0, key: VK_F5,     cmd: CMD_REFRESH },
];
let haccel = CreateAcceleratorTableW(accels.as_ptr(), accels.len() as i32);

// Modified message pump:
while GetMessageW(&mut message, 0, 0, 0) > 0 {
    if TranslateAcceleratorW(hwnd, haccel, &mut message) == 0 {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}
DestroyAcceleratorTable(haccel);
```

**ACCEL struct packing — IMPORTANT:** The Win32 `ACCEL` struct is `BYTE fVirt; WORD key; WORD cmd;` = 5 bytes, packed via `#pragma pack(1)` in winuser.h. The Rust binding MUST use `#[repr(C, packed)]` and have NO padding field, or `CreateAcceleratorTableW` will read garbage. The example above shows the wrong layout (with explicit padding) for clarity — the planner must specify `#[repr(C, packed)]` and accept the `unaligned reference` lint or read fields via `read_unaligned`. `[ASSUMED]` — verify with a smoke test that each shortcut fires. **Recommendation:** use `#[repr(C, packed(1))]` and assemble the array via `ptr::write_unaligned` to avoid Rust references-to-packed warnings.

### Pattern 7: msctls_statusbar32 5-Pane Status Bar (POL-03)

```rust
// Source: [CITED: learn.microsoft.com/en-us/windows/win32/controls/status-bars]
// Class name: "msctls_statusbar32"

pub(crate) const SBARS_SIZEGRIP: Dword = 0x0100;
pub(crate) const SB_SETPARTS:    Uint  = 0x0404;
pub(crate) const SB_SETTEXTW:    Uint  = 0x040B;
pub(crate) const SB_GETPARTS:    Uint  = 0x0406;
pub(crate) const ICC_BAR_CLASSES: Dword = 0x00000004;

// Pane indices
pub(crate) const PANE_FILES:     usize = 0;
pub(crate) const PANE_FOLDERS:   usize = 1;
pub(crate) const PANE_ERRORS:    usize = 2;
pub(crate) const PANE_ELAPSED:   usize = 3;
pub(crate) const PANE_THROUGHPUT: usize = 4;

// Creation in create_controls (replace the existing STATIC status placeholder):
state.status = CreateWindowExW(
    0,
    wide("msctls_statusbar32").as_ptr(),
    null(),
    WS_CHILD | WS_VISIBLE | SBARS_SIZEGRIP,
    0, 0, 0, 0,
    hwnd,
    ID_STATUS as Hmenu,
    h_instance,
    null_mut(),
);

// On WM_SIZE, compute right-edge x-coordinates of each pane.
// Suggested widths (DPI-naive starting point, refine after smoke test):
//   files=180, folders=180, errors=140, elapsed=140, throughput=fills-to-end
fn compute_status_parts(client_width: i32) -> [i32; 5] {
    let f = 180;
    let fo = f + 180;
    let er = fo + 140;
    let el = er + 140;
    let th = client_width;    // -1 also works for "fills rest" via SB_SETPARTS
    [f, fo, er, el, th]
}

// Push parts and text:
let parts = compute_status_parts(client_width);
SendMessageW(status, SB_SETPARTS, 5, parts.as_ptr() as Lparam);
let text = wide("123,456 files");
SendMessageW(status, SB_SETTEXTW, PANE_FILES, text.as_ptr() as Lparam);
// "fills to end": pass -1 as the last entry of the parts array
```

**Note:** The status bar control auto-positions itself at the bottom of the parent window if it forwards `WM_SIZE` to `DefWindowProcW`, but the desktop window proc currently intercepts `WM_SIZE` for custom layout. Two options:
1. After the custom layout in `resize_controls`, send `WM_SIZE` to the status bar HWND explicitly with `SendMessageW(status, WM_SIZE, 0, 0)` to trigger its auto-reflow.
2. Manually `MoveWindow` the status bar to `(0, height - sb_height, width, sb_height)` after computing parts. This is what the existing code already does for the STATIC placeholder; the swap to `msctls_statusbar32` only changes the class and pane mechanics.

Recommended: option 2 (manual MoveWindow) to keep the layout logic in one place — matches the existing pattern.

### Anti-Patterns to Avoid

- **Sharing `lpData` from WM_COPYDATA outside the handler:** Pointer becomes invalid the moment `SendMessageW` returns. Always memcpy out.
- **Using `Global\\` mutex prefix:** Would block Fast User Switching / RDP. CONTEXT D-05 locks `Local\\`.
- **Writing `settings.json` directly without temp+rename:** Pitfall #7; rejected by D-03 / ROADMAP risk callout.
- **Holding `STATE` mutex across `SendMessageW` / `SetWindowTextW`:** Reentrancy deadlock; the existing `with_state_mut` uses `try_lock` for this exact reason — the same discipline applies to new code (settings-save helpers must NOT call into Win32 from inside a state-mut closure).
- **`SetForegroundWindow` without `AllowSetForegroundWindow` from the sender:** Win10/11 reject foreground-steal attempts unless the sender process has foreground rights or has granted them. The send-message-then-SetForeground pattern relies on `SendMessageW` itself granting implicit rights, but explicit `AllowSetForegroundWindow(pid)` before send is the documented belt-and-suspenders approach.
- **Calling `SHAutoComplete` before the edit HWND is created:** Returns failure silently. Always call after `CreateWindowExW` returns a non-zero HWND.
- **Treating `ACCEL` as a normal `#[repr(C)]` struct:** Wrong layout, garbage table. Must be `#[repr(C, packed)]`.
- **Forgetting `ICC_USEREX_CLASSES` and `ICC_BAR_CLASSES` in `InitCommonControlsEx`:** Class registration silently fails; `CreateWindowExW` returns 0.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| `%APPDATA%` path resolution | Hardcoded `C:\Users\%USERNAME%\AppData\Roaming` or env-var concatenation | `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` | Locked by SET-01; respects per-user redirection, Group Policy folder redirection, mounted profile shares |
| File rename atomicity | `fs::copy` + `fs::remove_file` of original | `MoveFileExW(MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH)` | NTFS guarantees rename atomicity on same volume; copy+delete is not crash-safe |
| Filesystem autocomplete UI | Custom popup window with directory enumeration | `SHAutoComplete(SHACF_FILESYS_DIRS)` | Free Explorer-like UX (case-insensitive prefix match, Tab cycling, dropdown listbox) for one line of code |
| Status bar with multiple panes | Custom-painted bar + manual hit testing | `msctls_statusbar32` common control with `SB_SETPARTS` | Standard control already themed by visual-styles manifest; supports sizing grip, DPI scaling |
| Drive enumeration with shell icons | `std::fs::read_dir("/")` + heuristics | `GetLogicalDrives` + `GetDriveTypeW` + `SHGetFileInfoW` (already used in `desktop/ffi.rs`) | OS-blessed answer; filters empty optical bays, network drops |
| Single-instance detection | Lockfile in `%APPDATA%` or port-bind probe | Named mutex `Local\FileTree.SingleInstance.v1` | OS-managed cleanup on process death; survives crashes (no stale lockfile) |
| Cross-process path forward | Command-line of second instance + polling | `WM_COPYDATA` with `COPYDATASTRUCT` | Synchronous, marshalled by OS, intended use case per MSDN |
| Keyboard shortcut routing | Per-control `WM_KEYDOWN` switch statements | `CreateAcceleratorTableW` + `TranslateAcceleratorW` in pump | Accelerator dispatches `WM_COMMAND` with the same IDs as buttons → unified router; takes precedence over edit-control default key handling |

**Key insight:** Every "polish" item in POL-01..03 has a documented Win32 common-control or shell function. Hand-rolled versions would be larger, less correct, and miss accessibility/DPI/visual-style integration the OS provides for free.

## Runtime State Inventory

**Stored data:**
- `%APPDATA%\FileTree\settings.json` — NEW file created by this phase. Phase 7 will add a sibling `snapshots/` directory under the same root.
- `%APPDATA%\FileTree\settings.json.tmp` — transient (exists only during atomic write window; cleaned up on success or on next save).
- **No existing data to migrate:** v0.1.0 persists nothing. First launch after this phase deploys writes a defaults file; no upgrade path needed beyond `schema_version: 1` (CONTEXT.md confirms legacy = treat missing as `1`).

**Live service config:**
- None. Single-process desktop app; no external services configured outside the process.

**OS-registered state:**
- **Named kernel object:** `Local\FileTree.SingleInstance.v1` mutex created at startup, released on process exit. OS auto-cleans on abnormal termination — no stale state survives a crash.
- **No Task Scheduler entries, no registry keys, no Start Menu shortcuts** — single .exe distribution per PROJECT.md.

**Secrets and env vars:**
- None — settings file contains UI state only (paths, sizes, toggles). `%APPDATA%` resolution is via Shell API, not `%APPDATA%` env var, so env-var rebinding cannot redirect the store.

**Build artifacts / installed packages:**
- None — fresh module `src/settings.rs` is the only new artifact. `cargo build --release` produces the existing single `target/release/filetree.exe`. No installed-state to migrate.

**The canonical question:** *After every file in the repo is updated, what runtime systems still have the old string cached, stored, or registered?*
**Answer:** Nothing. This is a greenfield-within-a-brownfield phase — adds new persistence, doesn't rename existing.

## Common Pitfalls

### Pitfall 1: ACCEL struct layout
**What goes wrong:** `CreateAcceleratorTableW` reads 5 packed bytes per entry (`BYTE; WORD; WORD`). A naive `#[repr(C)] struct Accel { fVirt: u8, key: u16, cmd: u16 }` is 6 bytes due to Rust's default 2-byte alignment on `u16`, shifting every field and producing a garbage table.
**Why it happens:** winuser.h uses `#pragma pack(1)` around `ACCEL`. Rust does not match C packing pragmas by default.
**How to avoid:** Use `#[repr(C, packed(1))]`. Build the array with `MaybeUninit` + `ptr::write_unaligned` to avoid Rust's "reference to packed field" lint, OR use a `[u8; 5]`-per-entry layout that you serialize manually before passing the array pointer to `CreateAcceleratorTableW`.
**Warning signs:** Shortcuts fire the wrong command, or fire nothing, or fire random commands at startup.

### Pitfall 2: WM_COPYDATA lpData lifetime
**What goes wrong:** Handler stashes `cds.lpData` pointer in a `String` via `from_raw_parts` and the string is read later — UAF when `SendMessageW` returns.
**Why it happens:** `WM_COPYDATA` is the ONE Win32 message where pointers in `LPARAM` are valid only during the synchronous call. Different rule from heap-allocated PostMessage payloads (which the project uses for WM_SCAN_DONE).
**How to avoid:** Memcpy out IMMEDIATELY in the handler. Document the rule with an inline comment.
**Warning signs:** Crashes minutes after the second instance launches; debugger shows a freed-memory read.

### Pitfall 3: SHAutoComplete called too early
**What goes wrong:** Called before edit HWND is valid (e.g., from WM_CREATE before all child controls are created). Returns failure silently; no autocomplete.
**Why it happens:** SHAutoComplete needs the edit HWND to subclass it; doesn't tolerate `hwndEdit == 0`.
**How to avoid:** Call AFTER `CreateWindowExW` for the path edit returns. Verify return is `S_OK = 0`; log/assert if non-zero.
**Warning signs:** Typing a path doesn't show a dropdown; no autocomplete suggestions appear.

### Pitfall 4: MOVEFILE_WRITE_THROUGH vs FlushFileBuffers on directory
**What goes wrong:** Belief that `MOVEFILE_WRITE_THROUGH` flushes the directory entry, when MSDN documents it as flushing the file *data* through the cache. On a sudden power loss, the directory entry update can still be lost.
**Why it happens:** The flag's name is misleading; documentation specifies it applies to the file's data, not the metadata transaction.
**How to avoid:** **For personal-use disk-explorer scope, the existing recipe is sufficient.** A `settings.json` lost to power loss falls back to defaults — non-fatal. A robust solution would `CreateFileW` on the parent directory with `FILE_FLAG_BACKUP_SEMANTICS` and call `FlushFileBuffers` on that handle after the rename. Document the limitation in code comment; don't over-engineer.
**Warning signs:** Settings reset after a hard power-off (not after a normal close).
**Confidence:** MEDIUM — [CITED: docs.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw] describes WRITE_THROUGH as "the function does not return until the file is actually moved on the disk." Interpretation re directory-entry vs data flush varies in community discussion. `[ASSUMED]` that personal-use scope tolerates the residual risk.

### Pitfall 5: JSON parser deep-recursion stack overflow
**What goes wrong:** Adversarial or buggy input with thousands of nested `{` triggers a stack overflow in a recursive-descent parser.
**Why it happens:** Each nested object adds a stack frame. Default Windows stack is 1 MB; ~1000-deep nesting can blow it on debug builds.
**How to avoid:** Track a depth counter in the parser; reject inputs deeper than a sane bound (e.g., 64 levels — settings file should never exceed 5).
**Warning signs:** App crashes with stack overflow when opening a hand-edited settings.json.

### Pitfall 6: JSON parser surrogate-pair miss
**What goes wrong:** `💩` (pile-of-poo emoji = U+1F4A9) decoded as two separate broken code units instead of one supplementary code point. Round-trip silently corrupts non-BMP characters.
**Why it happens:** A naive `\uXXXX` decoder treats each `\u` independently; UTF-16 surrogate pair encoding requires recognizing the high/low pair pattern (D800-DBFF followed by DC00-DFFF).
**How to avoid:** After decoding `\uXXXX`, if the value is in the high-surrogate range, peek the next sequence; if it's also `\uXXXX` in the low-surrogate range, combine via `((high - 0xD800) << 10) | (low - 0xDC00) + 0x10000`. The existing `push_json_string` writer in `src/export.rs` ALREADY has this gap noted in PITFALLS.md and emits ASCII-only escapes; if the writer never emits non-BMP escape sequences, the reader can refuse them as malformed — but then a hand-edited file with a pile-of-poo would fail. Recommend: implement surrogate-pair decoding for correctness.
**Warning signs:** Unicode characters in saved paths or future bookmarks come back garbled.

### Pitfall 7: Concurrent settings writes corrupt settings.json (canonical Pitfall #7)
**What goes wrong:** Two processes write concurrently; one's truncate stomps the other's bytes mid-flush.
**Why it happens:** No file locking; non-atomic write.
**How to avoid:** D-04/D-05 named-mutex single-instance guard ensures only one primary process exists. D-03 atomic temp+rename ensures even within one process, no torn write is visible. **The two mitigations are a pair — both must land in this phase.**
**Warning signs:** `settings.json` is 0 bytes after a crash; "last opened path" resets at random.

### Pitfall 8: Edit control eats Enter/Esc before accelerator fires
**What goes wrong:** User types in path edit, hits Enter — nothing happens because the edit's default WM_KEYDOWN handler swallows VK_RETURN as "insert newline" (single-line edit) or beeps.
**Why it happens:** `TranslateAcceleratorW` runs BEFORE `TranslateMessage` and `DispatchMessageW`, so the accelerator gets first crack — IF the message pump is structured correctly (`if TranslateAcceleratorW(...) == 0 { TranslateMessage; DispatchMessageW }`).
**How to avoid:** Verify the message pump structure (see Pattern 6 example). The accelerator table dispatches WM_COMMAND to the parent window, bypassing the edit control entirely. **This is the correct, idiomatic Win32 behavior** — but easy to break by accidentally calling `TranslateMessage` unconditionally.
**Warning signs:** Enter / Esc / F5 work outside the path edit but not when it has focus.

### Pitfall 9: SetForegroundWindow silently rejected on Win10/11
**What goes wrong:** Second instance sends WM_COPYDATA, calls `SetForegroundWindow(hwnd)`, but the primary window only flashes in the taskbar instead of stealing focus.
**Why it happens:** Windows restricts foreground-steal to processes with foreground rights. The second instance gets these rights briefly when the user double-clicks the .exe (foreground-input timeout window) but loses them if anything else has happened.
**How to avoid:** Two-layer defense: (1) second instance calls `AllowSetForegroundWindow(primary_pid)` BEFORE `SendMessageW`. (2) Primary's WM_COPYDATA handler ALSO calls `SetForegroundWindow(hwnd)` — by that point, the SendMessage has implicitly granted the primary foreground rights via the message dispatch contract.
**Warning signs:** "App launched twice" → taskbar flash instead of focus pop.

### Pitfall 10: schema_version > 1 silently overwritten on save
**What goes wrong:** User runs v2 build, saves settings (`schema_version: 2` + new fields). Downgrades to v1 build. v1 reads file, treats unknown keys via D-02 round-trip... but if v1 ALSO bumps `schema_version` back to `1` on save, the v2 fields might still round-trip but the version marker is now wrong.
**Why it happens:** Forgetting that `schema_version` is itself a field that must round-trip — but ALSO needs an explicit policy.
**How to avoid:** On load, if `schema_version > 1`, set an in-memory `loaded_from_future = true` flag. Do NOT call save until user explicitly changes a setting. When the user does change something, preserve the ORIGINAL `schema_version` value from the file (round-trip via the unknown-keys bucket OR via a typed field that keeps the loaded value). Document this interaction clearly in the writer.
**Warning signs:** Future-build user reports their new settings vanished after running an old build.

## Code Examples

(See Patterns 1-7 above for verified code examples. Each is sourced from MSDN with the `[CITED: ...]` URL inline.)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual `IAutoComplete2` vtable wire-up for path autocomplete | `SHAutoComplete` shim | XP era — both still work; SHAutoComplete is the canonical one-liner | Use SHAutoComplete unless a non-default behavior is needed |
| `WriteFile` + manual rename | `MoveFileExW(MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH)` | Win2000+; standard pattern | Use the Ex variant; the non-Ex `MoveFileW` fails if destination exists |
| Per-control `WM_KEYDOWN` switch for shortcuts | Accelerator tables | Win16 era; predates Win32 — both standard | Accelerator table for app-wide shortcuts; per-control WM_KEYDOWN for control-local shortcuts (e.g., list nav) |
| Custom-painted status bar | `msctls_statusbar32` | Win95+; standard | Common control for everything; custom only when you need vertical text or unusual chrome |

**Deprecated/outdated:** None applicable to Phase 2. All recommended APIs are current and supported on Win11 26100.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | SHAutoComplete works reliably on Windows 11 26100 with a standalone EDIT control | Pattern 5 | LOW — fallback to manual `IAutoComplete2` is documented; revisit during smoke test |
| A2 | MOVEFILE_WRITE_THROUGH is sufficient durability for personal-use scope (no directory-handle fsync) | Pitfall 4 | LOW — settings loss on hard power-off falls back to defaults, non-fatal |
| A3 | ACCEL packing `#[repr(C, packed(1))]` matches Win32 expectations | Pitfall 1 | MEDIUM — wrong layout produces silent shortcut failures; verify by smoke testing each of the 6 shortcuts |
| A4 | A 150-300 LOC hand-rolled JSON parser is feasible for the settings schema (numbers, strings with `\uXXXX`, objects, arrays, true/false/null) | Pattern 1 (implicit) | LOW — recursive descent for this grammar is well-trodden; ~250 LOC is the realistic landing zone |
| A5 | Coalescing column-drag (WM_MOUSEMOVE → WM_LBUTTONUP) and resize (WM_SIZING → WM_EXITSIZEMOVE) is sufficient drag-coalesce for D-03 | CONTEXT.md D-03 mitigation | LOW — these are the only continuous-stream sources in the current UI; new continuous events can be added to the same coalesce set as they arise |
| A6 | ICC_USEREX_CLASSES + ICC_BAR_CLASSES enable ComboBoxEx32 and msctls_statusbar32 respectively when OR'd into the existing InitCommonControlsEx call | Pattern 4, Pattern 7 | LOW — documented in CommCtrl.h; common pattern. Failure mode is CreateWindowExW returning 0, easy to detect at startup |
| A7 | The existing `wide()` UTF-16 helper in `desktop/mod.rs` is reachable from the new settings module via a small refactor (move to `src/io.rs` or duplicate) | implicit | LOW — trivial to factor out; the planner should land this move in an early task |

## Open Questions

1. **Should `Settings::pending_settings` (drag-buffer) live in `DesktopState` or in a separate `SettingsStore`?**
   - What we know: D-03 requires drag-coalesce for column WM_MOUSEMOVE and window WM_SIZING.
   - What's unclear: Whether the in-flight buffer is conceptually "desktop UI state" (lives in `DesktopState`) or "settings infrastructure" (lives in `SettingsStore`).
   - Recommendation: Put the buffer in `DesktopState` (a `pending_persist: bool` flag + the existing `DesktopState` fields ARE the in-flight settings). Drag-end handlers call `SettingsStore::save` with the current `DesktopState` snapshot. Keeps the settings module pure-data.

2. **Does `schema_version` get its own typed field on `Settings`, or live in the unknown-keys bucket?**
   - What we know: Top-level integer, first field, default = 1.
   - What's unclear: If treated as a typed field, the > 1 case needs special handling in load logic.
   - Recommendation: Typed field. Load logic sets `loaded_from_future: bool` if > 1; writer always emits the loaded value (NOT the binary's known max) when `loaded_from_future` is true — preserves Pitfall #10 invariant.

3. **Drive picker — should we use shell icons via `SHGetFileInfoW(SHGFI_SYSICONINDEX)` + an image list, or text-only?**
   - What we know: ComboBoxEx32 supports icons via `iImage` field of `COMBOBOXEXITEMW`.
   - What's unclear: Whether per-drive shell icons are worth the image-list complexity for Phase 2.
   - Recommendation: Text-only for Phase 2 (faster to ship, fewer FFI surfaces). Add shell icons in a follow-up polish task if/when the bar looks bare. Falls under Claude's discretion; deferrable.

4. **Status-bar pane widths — fixed pixels, DPI-scaled, or auto-fit to longest expected text?**
   - What we know: 5 panes; suggested starting widths 180/180/140/140/fill.
   - What's unclear: Whether to query `GetDpiForWindow` and scale, or leave fixed.
   - Recommendation: Use `GetDpiForWindow` (already a Win10 API) and scale: `scaled = base * dpi / 96`. Trivial to add; matches the rest of the app's DPI posture (which currently is none — but Phase 8 visualizations call out DPI explicitly so introducing the pattern now pays forward).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust toolchain | All Rust code | yes | cargo 1.95.0 / rustc 1.95.0 (verified) | — |
| Windows 10/11 | Desktop surface | yes (Windows 11 Enterprise 26100, per env header) | 10.0.26100 | — |
| Shell32.dll | SHGetKnownFolderPath, SHAutoComplete | yes (OS-bundled) | OS | — |
| Shlwapi.dll | SHAutoComplete (NEW link entry) | yes (OS-bundled) | OS | — |
| Kernel32.dll | CreateMutexW, MoveFileExW, GetLogicalDrives | yes (OS-bundled) | OS | — |
| User32.dll | FindWindowW, SendMessageW, accelerator APIs | yes (OS-bundled) | OS | — |
| Comctl32.dll v6 | ComboBoxEx32, msctls_statusbar32 | yes (visual-styles manifest already enabled) | v6 (XP+) | — |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Cargo built-in test runner (`#[cfg(test)] mod tests { #[test] fn ... }`) |
| Config file | None — cargo defaults |
| Quick run command | `cargo test --lib settings::` (after settings module lands) |
| Full suite command | `cargo test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SET-01 | Settings file resolves to `%APPDATA%\FileTree\settings.json` | unit | `cargo test --lib settings::settings_dir_resolves_under_appdata` | ❌ Wave 0 |
| SET-02 | Atomic write produces no torn file when interrupted mid-write | unit + manual | `cargo test --lib settings::atomic_write_replaces_target_intact` (positive path) + manual taskkill smoke | ❌ Wave 0 |
| SET-03 | `schema_version` round-trips; unknown keys preserved | unit | `cargo test --lib settings::unknown_keys_round_trip` | ❌ Wave 0 |
| SET-03 | Future-version file (`schema_version: 2`) loads with defaults and does NOT overwrite | unit + integration | `cargo test --lib settings::future_version_loads_defaults_no_write` | ❌ Wave 0 |
| SET-04 | Second instance does NOT acquire the mutex | integration | `cargo test --test single_instance` (spawns .exe twice via `Command::new`) | ❌ Wave 0 |
| SET-05 | All persisted fields (path, columns, dark, hidden/symlink toggles, window pos/size) survive save→load | unit | `cargo test --lib settings::all_fields_round_trip` | ❌ Wave 0 |
| POL-01 | Drive picker enumerates drives via `GetLogicalDrives` excluding empty CDROM/floppy | unit | `cargo test --lib desktop::drive_picker::filters_by_drive_type` (pure logic, mocked drive mask) | ❌ Wave 0 |
| POL-01 | Path autocomplete shows dropdown when typing | **manual-only** | (manual QA checklist) — no automated path; SHAutoComplete behavior is OS-controlled | manual |
| POL-02 | Six shortcuts fire the correct WM_COMMAND IDs | **manual-only** | (manual QA checklist) — Win32 accelerator dispatch is integration-heavy; unit tests can cover the WM_COMMAND handlers themselves | manual |
| POL-03 | Status bar shows live files/folders/errors/elapsed; throughput = bytes/elapsed_secs | unit | `cargo test --lib desktop::status_bar::throughput_formula` (pure math) | ❌ Wave 0 |
| POL-03 | Throughput pane shows "--" when no scan in flight | unit | `cargo test --lib desktop::status_bar::throughput_idle_shows_dash` | ❌ Wave 0 |

**JSON parser unit tests (within `settings::tests`):**
- `parse_empty_object`, `parse_empty_array`, `parse_basic_string`, `parse_escapes_all_seven` (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`), `parse_unicode_escape_bmp`, `parse_unicode_escape_surrogate_pair`, `parse_integer`, `parse_negative_integer`, `parse_float`, `parse_bool_true_false`, `parse_null`, `parse_nested_objects_depth_5`, `reject_trailing_comma`, `reject_unclosed_brace`, `reject_unquoted_key`, `reject_deeply_nested_depth_over_64`, `round_trip_writer_then_reader_lossless`, `unknown_keys_preserved_top_level`, `unknown_keys_preserved_nested_window_object`.

**WM_COPYDATA validation tests (pure-logic helper, no Win32 in tests):**
- `canonicalize_rejects_non_absolute`, `canonicalize_rejects_nonexistent`, `canonicalize_rejects_file_not_directory`, `validate_rejects_cbdata_over_64kb`, `validate_rejects_odd_byte_count`, `validate_rejects_wrong_dwdata`.

### Sampling Rate

- **Per task commit:** `cargo test --lib settings::` (fast subset, sub-second)
- **Per wave merge:** `cargo test` (full suite including any integration tests)
- **Phase gate:** Full suite green + `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + manual QA checklist (see below) before `/gsd-verify-work`

### Manual QA Checklist (Win32 surface — not unit-testable)

- [ ] Launch app; close it; reopen — last path, column widths, dark-mode, hidden/symlink toggles, window size/position all preserved (covers SET-05 round-trip end-to-end)
- [ ] Hard-kill via Task Manager mid-save (set window size, immediately taskkill); relaunch; settings file is intact (no 0-byte file, no parse error) — verifies atomic write (SET-02)
- [ ] Manually edit `settings.json` to add a top-level key `"future_thing": 42`; launch + close app; verify `future_thing: 42` is still present in the file (D-02 unknown-keys round-trip)
- [ ] Manually edit `settings.json` to set `"schema_version": 99`; launch app; verify defaults are loaded AND file is NOT overwritten until a setting is changed (Pitfall 10)
- [ ] Launch app; while it's running, launch again — second instance does not appear; primary window comes to foreground (SET-04 + foreground steal)
- [ ] Launch app; launch second instance with `filetree desktop --path D:\SomeOther` — primary focuses AND starts scanning D:\SomeOther (D-04 WM_COPYDATA path forward)
- [ ] Launch second instance with `--path C:\Path\That\Does\Not\Exist` — primary focuses, no error dialog, no scan starts (D-06 silent reject)
- [ ] Click drive picker dropdown — only drives with media are listed (no empty CDROM bays); selecting `C:` sets path edit to `C:\` (POL-01 drive picker)
- [ ] Click into path edit and start typing — Explorer-style autocomplete dropdown appears with matching directories (POL-01 SHAutoComplete)
- [ ] With path edit focused, press Enter → scan starts (POL-02 + Pitfall 8 verifies accelerator wins over edit's default key handling)
- [ ] During scan, press Esc → scan cancels (POL-02)
- [ ] After scan, press F5 → rescan starts (POL-02)
- [ ] Press Ctrl+E → export menu/action fires (POL-02 — wire to existing export entry)
- [ ] Press Ctrl+F → focus-search command fires (Phase 2: no-op stub; verify the command ID is dispatched, log to confirm)
- [ ] Press Del with a selection → delete-selection command fires (Phase 2: no-op stub; verify dispatch)
- [ ] Status bar shows 5 panes; during scan, files/folders/errors/elapsed update on each 1500ms WM_SCAN_PROGRESS tick; throughput pane shows MB/s; before/after a scan, throughput pane shows `--` (POL-03)
- [ ] Drag a column width → settings file is NOT written per pixel; on mouse-up, file IS written once (D-03 drag-coalesce)
- [ ] Drag window border to resize → settings file is NOT written per pixel; on WM_EXITSIZEMOVE, file IS written once (D-03 drag-coalesce)

### Wave 0 Gaps

- [ ] `src/settings.rs` — create module with `Settings`, `RawJsonValue`, parse/write, `SettingsStore`, and `#[cfg(test)] mod tests`
- [ ] `tests/single_instance.rs` — new integration test that spawns the binary twice via `std::process::Command::new(env!("CARGO_BIN_EXE_filetree"))` and asserts second instance exits 0 quickly
- [ ] `src/desktop/status_bar.rs` (or inline in `paint.rs`) — extract throughput formula and idle-pane formatting as pure-Rust testable helpers
- [ ] `src/desktop/drive_picker.rs` (or inline) — extract drive-mask-to-letters filter as a pure-Rust testable helper (takes `u32` mask + a `fn(letter) -> u32` drive-type probe so tests can stub)
- [ ] No framework install needed — cargo's built-in `#[test]` runner is already in use across `src/scan.rs`, `src/io.rs`, `src/export.rs`

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Single-user local desktop app; no auth surface |
| V3 Session Management | no | No sessions |
| V4 Access Control | no | OS-level user permissions only |
| V5 Input Validation | **yes** | WM_COPYDATA payload validation (D-06); settings JSON parser rejects malformed input; drive-letter input is OS-bounded |
| V6 Cryptography | no | No secrets, no encryption surface |
| V7 Error Handling | yes | Settings save failures swallowed in release per CONTEXT D-03 (no modal error storms); WM_COPYDATA silent reject per D-06 |
| V12 Files & Resources | **yes** | Atomic write recipe (Pitfall #7); path canonicalization (`GetFullPathNameW`) before any filesystem operation |
| V14 Configuration | yes | Settings file location pinned via Shell API (not env var) prevents redirection attacks |

### Known Threat Patterns for Win32 raw FFI + JSON IPC

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| WM_COPYDATA from any process on the desktop can target our HWND | Spoofing, Tampering | Validate `dwData` magic, cap `cbData` ≤ 64 KB, canonicalize path, require it to be an existing directory (D-06) |
| Path injection via second-instance CLI arg routed through WM_COPYDATA | Tampering | Path validation pipeline — `GetFullPathNameW` + `GetFileAttributesW` rejects non-directories, non-existent paths, and any UNC/device-path tricks land in the canonicalize step |
| Malicious / corrupted `settings.json` triggers parser crash | Denial of Service | Depth-limit parser (≤ 64 nesting); length-cap strings (e.g., 4 KB per value); reject malformed inputs cleanly with a typed `ParseError` rather than panic; on parse failure, rename file to `settings.json.broken-<ts>` per PITFALLS.md and run with defaults |
| TOCTOU on settings file (read defaults, attacker swaps file, write blows away changes) | Tampering | Single-instance mutex guarantees no concurrent process; same-process writes go through `SettingsStore` serialization. TOCTOU is not the threat model for a personal-use desktop app on a single-user machine — explicit non-goal |
| Settings file leaks sensitive info (recent path of `C:\Users\me\Documents\taxes\`) | Information Disclosure | Out of scope per CONCERNS.md note that AppData files inherit user ACLs; document `%APPDATA%\FileTree\` as containing path lists; do not store file contents, hashes, or owner info |
| Foreground-window steal abused for clickjacking | Tampering | Foreground-steal is a one-shot, user-initiated action (double-clicked the .exe); standard Windows shell behavior — not a new attack surface |

## Project Constraints (from CLAUDE.md)

These are non-negotiable directives extracted from `CLAUDE.md` and `PROJECT.md`. The planner must verify compliance and the implementer must not violate any of them:

1. **Zero new external Rust crates.** `Cargo.toml` `[dependencies]` is empty by design and STAYS empty in this phase. Any proposed crate is a Key Decision needing rationale. Phase 2 adds nothing.
2. **Native UI via raw Win32 FFI only.** No GUI toolkit (no Tauri / egui / iced). New FFI declarations go in `src/desktop/ffi.rs`.
3. **Win32 DLL link list:** User32, Gdi32, Shell32, Comctl32, Dwmapi, Ole32, UxTheme, Kernel32 — Phase 2 adds **one new DLL**: `Shlwapi` (for `SHAutoComplete`).
4. **Single standalone `.exe`** — no installer, no auto-update, no telemetry. Settings live in `%APPDATA%`, separate from the binary.
5. **Scan UI must remain responsive while workers are scanning.** Settings save must NOT block the message loop — atomic write is fast (KB-scale file) but document the constraint.
6. **Safety:** any destructive operation defaults to Recycle Bin with explicit confirmation. (Not directly Phase 2 — no destructive ops introduced.)
7. **Naming conventions** (CLAUDE.md): `snake_case`; types in `PascalCase`; `push_*` for builders; `*_to_*` for serializers; `is_*`/`has_*`/`should_*` for predicates; Win32 constants `UPPER_SNAKE_CASE` matching Win32 name. The new settings module follows: `parse_settings_json`, `push_settings_json`, `atomic_write_settings`, `settings_dir`, `is_known_settings_key`.
8. **Module-level `#![allow(...)]` for Win32 non-idiomatic naming** stays per-file in the desktop submodules (already established pattern in `desktop/ffi.rs`, `desktop/state.rs`).
9. **`unsafe extern "system"` FFI lives in `src/desktop/ffi.rs`;** call sites stay in the module that needs them.
10. **`.expect("... lock poisoned")` on Mutex locks** — mutex poisoning is treated as unrecoverable (matches existing pattern).
11. **GSD workflow enforcement:** all edits go through a GSD command (this research is itself part of the GSD plan flow — the planner will produce PLAN.md files that drive task execution).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SET-01 | Settings file at `%APPDATA%\FileTree\settings.json` resolved via `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` | Pattern 1 + Pattern 5 deps; new `settings_dir()` helper |
| SET-02 | Atomic write via temp-file + rename; debounced save on change | Pattern 1 + drag-coalesce (D-03 mitigation) covered in Architecture diagram |
| SET-03 | Schema versioning (`schema_version: 1`) with forward-compatible read | Pitfall 10 + Open Question 2 + unit test list |
| SET-04 | Single-instance guard via named mutex | Pattern 2 + Open Question (none — D-05 locked) |
| SET-05 | Persisted state includes last path, column widths, dark-mode, hidden/symlink toggles, window size/position | `Settings` struct shape implied by Pattern 1 example; all 7 fields named explicitly in Phase Boundary |
| POL-01 | Path bar with drive picker dropdown and folder autocomplete | Patterns 4 + 5; `ICC_USEREX_CLASSES` registration noted |
| POL-02 | Keyboard shortcuts (Enter/Esc/Del/Ctrl+F/Ctrl+E/F5) | Pattern 6 + Pitfall 1 (ACCEL packing) + Pitfall 8 (edit-control conflict) |
| POL-03 | Status bar with scan stats (files/folders/errors/elapsed/throughput MB/s) | Pattern 7 + reuse of existing WM_SCAN_PROGRESS 1500ms tick from `src/scan.rs` |

## Sources

### Primary (HIGH confidence)

- `learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw` — CreateMutexW + ERROR_ALREADY_EXISTS pattern
- `learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw` — MoveFileExW + MOVEFILE_REPLACE_EXISTING + MOVEFILE_WRITE_THROUGH
- `learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-copydatastruct` — COPYDATASTRUCT layout
- `learn.microsoft.com/en-us/windows/win32/dataxchg/wm-copydata` — WM_COPYDATA lifetime + receiver semantics
- `learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-shautocomplete` — SHAutoComplete + SHACF_* flags
- `learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createacceleratortablew` — CreateAcceleratorTableW + ACCEL struct
- `learn.microsoft.com/en-us/windows/win32/controls/status-bars` — msctls_statusbar32 + SB_SETPARTS / SB_SETTEXTW
- `learn.microsoft.com/en-us/windows/win32/controls/comboboxex-controls` — ComboBoxEx32 + CBEM_INSERTITEMW
- `learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath` — SHGetKnownFolderPath + FOLDERID_RoamingAppData GUID
- `learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow` — AllowSetForegroundWindow foreground-rights model
- `.planning/research/PITFALLS.md` §Pitfall #7 — atomic settings write + named-mutex pair
- `.planning/REQUIREMENTS.md` lines 16-26 — SET-01..05, POL-01..03 verbatim
- `.planning/phases/02-settings-polish/02-CONTEXT.md` — locked decisions D-01..D-06 + Claude's-discretion defaults
- `src/export.rs::push_json_string` — writer pattern the new reader must round-trip exactly
- `src/desktop/ffi.rs` — current FFI surface and constants vocabulary
- `src/desktop/state.rs::with_state_mut` — reentrancy discipline (`try_lock`) the new save helpers must honor

### Secondary (MEDIUM confidence)

- General Win32 community knowledge re: edit-control behavior with accelerators (Pitfall 8); SetForegroundWindow restrictions on Win10/11 (Pitfall 9). Not cited to a single page — well-known Win32 lore reconfirmed across MSDN docs and StackOverflow patterns.

### Tertiary (LOW confidence)

- Specific behavior of `MOVEFILE_WRITE_THROUGH` re: directory-entry vs file-data flush (Pitfall 4) — `[ASSUMED]` tolerable for personal-use scope; documented as a known gap.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every Win32 API has been used for ≥ a decade; no version-skew risk
- Architecture: HIGH — directly derived from CONTEXT.md locked decisions + existing module layout from Phase 1
- Pitfalls: HIGH for the canonical Win32 gotchas (1-3, 5-8); MEDIUM for power-loss durability nuance (4); MEDIUM for foreground-steal reliability on Win11 (9); HIGH for schema-version interactions (10)

**Research date:** 2026-05-23
**Valid until:** 2026-06-22 (30 days — Win32 surface is stable; only concern would be a major Comctl32 v6 behavior change in a Windows feature update, historically rare)

---

*Phase: 2-settings-polish*
*Research completed: 2026-05-23*
