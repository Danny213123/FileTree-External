# Phase 2: Settings & Polish - Pattern Map

**Mapped:** 2026-05-23
**Files analyzed:** 8 (3 new, 5 modified)
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Status | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|--------|------|-----------|----------------|---------------|
| `src/settings.rs` | NEW | model + serializer + store | file I/O (read/write JSON) | `src/export.rs` (writer half) + `src/io.rs` (filesystem helpers) | role-match (writer is exact; reader is greenfield) |
| `tests/single_instance.rs` | NEW | integration test | request-response (process spawn) | `src/scan.rs::tests` + `src/io.rs::tests` | role-match (no existing `tests/` dir integration test exists; closest is in-file `#[cfg(test)] mod tests`) |
| `src/cli.rs` | MODIFIED | controller (CLI dispatch) | request-response (process lifetime) | `src/cli.rs::run` itself (extend pattern) | exact (self-pattern) |
| `src/desktop/ffi.rs` | MODIFIED | FFI declarations | n/a (decl-only) | `src/desktop/ffi.rs` itself (extend pattern) | exact (self-pattern) |
| `src/desktop/state.rs` | MODIFIED | state container + dispatch | event-driven (window proc receive) | `src/desktop/state.rs` + `src/desktop/shell.rs` (validation pipeline) | exact (self-pattern for state; role-match for validation helper) |
| `src/desktop/mod.rs` | MODIFIED | window proc + controls + message pump | event-driven | `src/desktop/mod.rs::run` + `window_proc` (extend in place) | exact (self-pattern) |
| `src/desktop/paint.rs` | MODIFIED | layout reflow + formatters | request-response (WM_SIZE) | `src/desktop/paint.rs::resize_controls` + `format_*_ui` helpers | exact (self-pattern) |
| `src/desktop/shell.rs` | MODIFIED | Win32 path/shell validation helper | request-response | `src/desktop/shell.rs::show_shell_context_menu` (UTF-16 path canonicalize pattern) | role-match |

## Pattern Assignments

### `src/settings.rs` (NEW — model + serializer + store, file I/O)

**Primary analog (writer):** `src/export.rs` lines 268-282 — `push_json_string` is reused VERBATIM by the new writer per CONTEXT D-01 / "Settings struct location" decision. Settings writer follows the existing `push_*` builder convention.

**Module header pattern** (copy structure from `src/desktop/state.rs` lines 1-18):
```rust
// Settings module does NOT need the desktop module's #![allow(...)] block —
// it's pure Rust, no Win32 FFI here (the SHGetKnownFolderPath wrapper lives
// in desktop/ffi.rs and is called via a thin pub(crate) helper).

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
```

**JSON writer pattern** (copy from `src/export.rs` lines 11-90):
```rust
// CONTEXT D-01 mandates: new writer reuses push_json_string directly.
// Pattern: function takes &mut String first (builder convention),
// returns nothing. Top-level wrapper builds the outer object.

pub(crate) fn push_settings_json(output: &mut String, settings: &Settings) {
    output.push('{');
    output.push_str("\"schema_version\":");
    output.push_str(&settings.schema_version.to_string());
    output.push_str(",\"last_path\":");
    crate::export::push_json_string(output, &settings.last_path);
    output.push_str(",\"dark_mode\":");
    output.push_str(if settings.dark_mode { "true" } else { "false" });
    // ... (one field per persisted setting; SET-05 list)
    // After known fields, emit unknown_keys verbatim (D-02 round-trip):
    for (key, raw) in &settings.unknown {
        output.push(',');
        crate::export::push_json_string(output, key);
        output.push(':');
        push_raw_json_value(output, raw);
    }
    output.push('}');
}
```

**Public surface** (mirror `src/export.rs` `scan_result_to_json` / `app_config_json` `pub(crate)` visibility):
- `pub(crate) struct Settings { schema_version: u32, last_path: String, dark_mode: bool, show_hidden: bool, follow_links: bool, columns: Vec<u32>, window: WindowGeometry, unknown: BTreeMap<String, RawJsonValue> }`
- `pub(crate) enum RawJsonValue { Object(BTreeMap<String, RawJsonValue>), Array(Vec<RawJsonValue>), Str(String), Int(i64), Float(f64), Bool(bool), Null }`
- `pub(crate) struct SettingsStore { path: PathBuf }`
- `pub(crate) fn parse_settings_json(text: &str) -> Result<Settings, ParseError>`
- `pub(crate) fn push_settings_json(out: &mut String, settings: &Settings)`

**Atomic write pattern** (RESEARCH Pattern 1, lines 192-221 — verbatim recipe):
- Open `settings.json.tmp` in same dir; write bytes; `f.sync_all()` to drop file handle; call `MoveFileExW(tmp, final, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. The `MoveFileExW` FFI declaration lives in `desktop/ffi.rs` per CONTEXT "canonical_refs / Code touch-points" decision.

**Error handling pattern** (copy from `src/io.rs` lines 12-44):
```rust
// io::Result<T> propagation up to entry points; CONTEXT D-03 mandates:
// "On failure, log to stderr in debug builds, swallow in release."
// Match the io.rs pattern of returning io::Result<()> from internal helpers.

pub(crate) fn save(&self, settings: &Settings) -> io::Result<()> {
    let mut body = String::with_capacity(512);
    push_settings_json(&mut body, settings);
    atomic_write_settings(&self.path, body.as_bytes())
}
```

**Test pattern** (copy structure from `src/export.rs` lines 301-311 and `src/io.rs` lines 281-296):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_unknown_keys() {
        // Input → parse → push → reparse → assert equality.
        // Matches the existing csv_fields_are_escaped style: small, focused, no fixtures.
    }
}
```

---

### `tests/single_instance.rs` (NEW — integration test, request-response process spawn)

**Analog:** No existing `tests/` directory file exists. Closest in-tree pattern is `src/scan.rs::tests` (line 648) which uses `scan_path_with_progress` directly. The new integration test diverges because it must spawn the actual binary.

**Pattern** (RESEARCH "Wave 0 Gaps" line 788):
```rust
// tests/single_instance.rs — first file in tests/ directory.
// Uses cargo's built-in CARGO_BIN_EXE_<bin-name> env var (set during `cargo test`).

#[cfg(windows)]
#[test]
fn second_instance_exits_quickly() {
    use std::process::Command;
    use std::time::{Duration, Instant};

    let exe = env!("CARGO_BIN_EXE_filetree");
    let mut primary = Command::new(exe).arg("desktop").spawn().expect("primary spawn");
    std::thread::sleep(Duration::from_millis(500)); // let primary acquire mutex

    let start = Instant::now();
    let status = Command::new(exe).arg("desktop").status().expect("second spawn");
    let elapsed = start.elapsed();

    assert!(status.success(), "second instance should exit 0");
    assert!(elapsed < Duration::from_secs(2), "second instance should exit quickly");

    let _ = primary.kill();
}
```

Note: This is the ONLY new test file outside `#[cfg(test)] mod tests {}` in-source. CLAUDE.md "No barrel files or re-exports" and "Single file" patterns mean unit tests stay inline; integration tests requiring binary spawn justify the `tests/` directory exception.

---

### `src/cli.rs` (MODIFIED — controller, request-response)

**Analog:** Self — extend the existing `run_desktop` dispatch.

**Existing entry-point pattern** (`src/cli.rs` lines 18-32):
```rust
pub(crate) fn run() {
    let args: Vec<String> = env::args().skip(1).collect();
    // ... arg parse ...
    if args.is_empty() {
        let result = run_desktop(current_dir_or_dot());
        if let Err(error) = result {
            eprintln!("{}: {}", APP_NAME, error);
            std::process::exit(1);
        }
        return;
    }
    // ...
}
```

**Modification (insert mutex acquire BEFORE `run_desktop`):**
```rust
// CONTEXT D-04/D-05 + RESEARCH Pattern 2: mutex acquire is the FIRST thing
// run_desktop does. serve/scan paths are unchanged.

fn run_desktop(initial_path: PathBuf) -> sio::Result<()> {
    #[cfg(windows)]
    {
        // SAFETY: try_forward_or_acquire returns Ok(mutex_handle) for primary,
        // or std::process::exit(0) from inside if this is a second instance.
        let _mutex = unsafe { crate::desktop::ffi::try_forward_or_acquire(&initial_path) }
            .map_err(|_| sio::Error::other("single-instance mutex acquire failed"))?;

        // Settings load BEFORE window creation (UI-SPEC §"Window restore order — no jank").
        let settings_store = crate::settings::SettingsStore::default()?;
        let settings = settings_store.load_or_default();

        crate::desktop::run(initial_path, settings, settings_store)
        // mutex held until process exit — _mutex drop calls CloseHandle.
    }
    // ... existing #[cfg(not(windows))] arm unchanged ...
}
```

**Error handling:** Match the existing `eprintln!("{}: {}", APP_NAME, error); std::process::exit(1);` pattern (`cli.rs` lines 28-29, 58-60). Settings load failures fall back to defaults silently per CONTEXT D-03 — NEVER surface to the CLI entry point.

---

### `src/desktop/ffi.rs` (MODIFIED — FFI declarations)

**Analog:** Self — extend the existing `#[link]` blocks. CLAUDE.md anchor: "`unsafe extern "system"` FFI declarations live in `desktop/ffi.rs` (post-Phase-1 layout). Call sites stay in the module that needs the API; the FFI block is declaration-only."

**Existing `#[link]` block pattern** (`src/desktop/ffi.rs` lines 274-289):
```rust
#[link(name = "Kernel32")]
unsafe extern "system" {
    pub(super) fn GetModuleHandleW(lpModuleName: *const u16) -> Hinstance;
    pub(super) fn GlobalAlloc(uFlags: Uint, dwBytes: usize) -> isize;
    // ... existing entries ...
}
```

**Modification (extend Kernel32 block, add new Shlwapi block):**
```rust
// Add to existing Kernel32 block:
pub(super) fn CreateMutexW(
    lpMutexAttributes: *mut c_void,
    bInitialOwner: Bool,
    lpName: *const u16,
) -> Handle;
pub(super) fn OpenMutexW(dwDesiredAccess: Dword, bInheritHandle: Bool, lpName: *const u16) -> Handle;
pub(super) fn CloseHandle(hObject: Handle) -> Bool;
pub(super) fn GetLastError() -> Dword;
pub(super) fn MoveFileExW(lpExistingFileName: *const u16, lpNewFileName: *const u16, dwFlags: Dword) -> Bool;
pub(super) fn GetLogicalDrives() -> Dword;
pub(super) fn GetDriveTypeW(lpRootPathName: *const u16) -> Uint;
pub(super) fn GetFullPathNameW(lpFileName: *const u16, nBufferLength: Dword, lpBuffer: *mut u16, lpFilePart: *mut *mut u16) -> Dword;
pub(super) fn GetFileAttributesW(lpFileName: *const u16) -> Dword;
pub(super) fn GetVolumeInformationW(/* ... */) -> Bool;

// Add to existing User32 block:
pub(super) fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> Hwnd;
pub(super) fn GetWindowThreadProcessId(hWnd: Hwnd, lpdwProcessId: *mut Dword) -> Dword;
pub(super) fn AllowSetForegroundWindow(dwProcessId: Dword) -> Bool;
pub(super) fn SetForegroundWindow(hWnd: Hwnd) -> Bool;
pub(super) fn CreateAcceleratorTableW(paccel: *const Accel, cAccel: i32) -> Handle;
pub(super) fn TranslateAcceleratorW(hWnd: Hwnd, hAccTable: Handle, lpMsg: *mut Msg) -> i32;
pub(super) fn DestroyAcceleratorTable(hAccel: Handle) -> Bool;
pub(super) fn GetDpiForWindow(hwnd: Hwnd) -> Uint;
pub(super) fn GetFocus() -> Hwnd;

// Add to existing Shell32 block:
pub(super) fn SHGetKnownFolderPath(rfid: *const GUID, dwFlags: Dword, hToken: Handle, ppszPath: *mut *mut u16) -> i32;

// NEW DLL link (CLAUDE.md Constraint #3 — only new DLL this phase):
#[link(name = "Shlwapi")]
unsafe extern "system" {
    pub(super) fn SHAutoComplete(hwndEdit: Hwnd, dwFlags: Dword) -> i32;
}
```

**Constant declarations** (extend existing `pub(super) const` block, lines 43-139):
```rust
// Match existing UPPER_SNAKE_CASE naming exactly matching Win32 headers.
pub(super) const ERROR_ALREADY_EXISTS: Dword = 183;
pub(super) const WM_COPYDATA: Uint = 0x004A;
pub(super) const WM_EXITSIZEMOVE: Uint = 0x0232;
pub(super) const WM_LBUTTONUP: Uint = 0x0202;
pub(super) const FILETREE_PATH_MSG_ID: UlongPtr = 0x46540001;
pub(super) const MAX_COPYDATA_BYTES: u32 = 64 * 1024;
pub(super) const MOVEFILE_REPLACE_EXISTING: Dword = 0x0000_0001;
pub(super) const MOVEFILE_WRITE_THROUGH: Dword = 0x0000_0008;
pub(super) const SHACF_FILESYS_DIRS: Dword = 0x00000020;
pub(super) const SHACF_AUTOSUGGEST_FORCE_ON: Dword = 0x10000000;
pub(super) const SHACF_AUTOAPPEND_FORCE_ON: Dword = 0x40000000;
pub(super) const FVIRTKEY: u8 = 0x01;
pub(super) const FCONTROL: u8 = 0x08;
pub(super) const VK_RETURN: u16 = 0x0D;
pub(super) const VK_ESCAPE: u16 = 0x1B;
pub(super) const VK_DELETE: u16 = 0x2E;
pub(super) const VK_F5: u16 = 0x74;
pub(super) const ICC_USEREX_CLASSES: Dword = 0x0000_0200;
pub(super) const ICC_BAR_CLASSES: Dword = 0x0000_0004;
pub(super) const SBARS_SIZEGRIP: Dword = 0x0100;
pub(super) const SB_SETPARTS: Uint = 0x0404;
pub(super) const SB_SETTEXTW: Uint = 0x040B;
// ... command IDs (matches existing ID_* naming, lines 118-136):
pub(super) const CMD_SCAN: u16 = 0xA001;
pub(super) const CMD_CANCEL_SCAN: u16 = 0xA002;
pub(super) const CMD_DELETE_SEL: u16 = 0xA003;
pub(super) const CMD_FOCUS_SEARCH: u16 = 0xA004;
pub(super) const CMD_EXPORT: u16 = 0xA005;
pub(super) const CMD_REFRESH: u16 = 0xA006;
```

**Struct layout pattern** (copy from existing `#[repr(C)]` blocks, lines 30-217):
```rust
#[repr(C)]
pub(super) struct CopyDataStruct {
    pub(super) dwData: UlongPtr,
    pub(super) cbData: Dword,
    pub(super) lpData: *const c_void,
}

#[repr(C)]
pub(super) struct ComboBoxExItemW { /* ... fields from RESEARCH Pattern 4 ... */ }

// CRITICAL: ACCEL needs #[repr(C, packed(1))] per RESEARCH Pitfall #1.
// Diverges from all other structs in this file (which use #[repr(C)]).
// Document the divergence inline.
#[repr(C, packed(1))]
pub(super) struct Accel {
    pub(super) fVirt: u8,
    pub(super) key: u16,
    pub(super) cmd: u16,
}

// GUID const for FOLDERID_RoamingAppData — use existing GUID struct (line 437).
pub(super) const FOLDERID_RoamingAppData: GUID = GUID {
    Data1: 0x3EB685DB, Data2: 0x65F9, Data3: 0x4CF6,
    Data4: [0xA0, 0x3A, 0xE3, 0xEF, 0x65, 0x72, 0x9F, 0x3D],
};
```

---

### `src/desktop/state.rs` (MODIFIED — state container, event-driven)

**Analog:** Self — extend `DesktopState` and add WM_COPYDATA handler.

**Existing `DesktopState` struct** (`src/desktop/state.rs` lines 22-54) gets new persisted-tracking fields:
```rust
// Add to DesktopState:
pub(super) drive_picker: Hwnd,           // POL-01 ComboBoxEx32
pub(super) settings_store: Option<Arc<crate::settings::SettingsStore>>,
pub(super) pending_persist: bool,        // D-03 drag-coalesce flag
pub(super) loaded_from_future: bool,     // Pitfall #10 — schema_version > 1
pub(super) accel_table: Handle,          // POL-02 — destroyed on WM_DESTROY
```

**Existing `with_state_mut` reentrancy pattern** (lines 105-116) is the model for ALL new mutation sites:
```rust
// CRITICAL: try_lock instead of lock — settings save MUST NOT call Win32 APIs
// from inside the closure (would risk reentrant SendMessageW → window_proc →
// with_state_mut deadlock). Pattern: extract data, drop lock, then save.

pub(super) fn save_settings_if_dirty(snapshot: SettingsSnapshot) {
    // No state lock held here — caller already released it.
    if let Some(store) = snapshot.store {
        if let Err(error) = store.save(&snapshot.settings) {
            #[cfg(debug_assertions)]
            eprintln!("settings save failed: {error}");
            #[cfg(not(debug_assertions))]
            let _ = error;
        }
    }
}
```

**Save-on-mutate pattern** for every persisted-field mutation site (e.g., dark-mode toggle in `desktop/mod.rs` line 236):
```rust
// Existing pattern (mod.rs:237-247):
ID_DARK_CHECK => {
    let status_text = with_state_mut(|state| {
        state.dark_mode = button_checked(state.dark_check);
        DARK_MODE_ATOMIC.store(state.dark_mode, Ordering::Relaxed);
        apply_theme(state);
        render_list(state)
    }).flatten();
    // NEW: extract a save snapshot inside the same closure, save AFTER drop.
    let snapshot = with_state_mut(|state| state.snapshot_for_save()).flatten();
    if let Some(snap) = snapshot { save_settings_if_dirty(snap); }
    if let Some(text) = status_text { /* ... existing ... */ }
}
```

**WM_COPYDATA handler pattern** (RESEARCH Pattern 3 lines 304-323 — verbatim recipe). Place as a new arm in `desktop/mod.rs::window_proc` matching the existing `WM_SCAN_DONE` arm style (mod.rs lines 374-380):
```rust
// Existing arm pattern this matches:
WM_SCAN_DONE => {
    if lparam != 0 {
        let payload = Box::from_raw(lparam as *mut ScanDone);
        finish_scan(hwnd, payload.result, payload.canceled);
    }
    0
}

// New arm:
WM_COPYDATA => handle_copy_data(hwnd, lparam),
```

The handler body lives in `desktop/state.rs` (per CONTEXT canonical_refs: "WM_COPYDATA handler lands here") and MUST memcpy out immediately per Pitfall #2.

---

### `src/desktop/mod.rs` (MODIFIED — window proc + controls + message pump)

**Analog:** Self — extend `run()`, `window_proc()`, `create_controls()`, message pump.

**`InitCommonControlsEx` extension** (`src/desktop/mod.rs` line 80-84):
```rust
// Existing:
let controls = InitCommonControlsEx {
    dwSize: size_of::<InitCommonControlsEx>() as Dword,
    dwICC: ICC_LISTVIEW_CLASSES,
};
// Modified per RESEARCH Pattern 4/7:
dwICC: ICC_LISTVIEW_CLASSES | ICC_USEREX_CLASSES | ICC_BAR_CLASSES,
```

**Message pump modification** (lines 142-146 — exact recipe per RESEARCH Pitfall #8):
```rust
// Existing:
while GetMessageW(&mut message, 0, 0, 0) > 0 {
    TranslateMessage(&message);
    DispatchMessageW(&message);
}

// Modified (accelerator wins over edit-control default key handling):
while GetMessageW(&mut message, 0, 0, 0) > 0 {
    if TranslateAcceleratorW(hwnd, haccel, &mut message) == 0 {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}
DestroyAcceleratorTable(haccel);
```

**`create_controls` extension pattern** (lines 418-568 — child control creation):

The existing pattern uses a `create_child` helper for STATIC/EDIT/BUTTON classes (lines 570-595). For ComboBoxEx32 and msctls_statusbar32, the existing helper is sufficient because they're class-name-driven; the new classes (`"ComboBoxEx32"`, `"msctls_statusbar32"`) just pass through. The STATIC status placeholder (lines 534-542) is REPLACED with the msctls_statusbar32 creation; `apply_theme` (theme.rs lines 48-81) is EXTENDED to call `SetWindowTheme` on the new picker and status bar HWNDs.

**`window_proc` new arms** (extend the existing `match msg` at lines 162-414):
```rust
// Add arms following the existing pattern style (one arm per message, terse handler call):
WM_COPYDATA => state::handle_copy_data(hwnd, lparam),
WM_LBUTTONUP => { paint::flush_pending_persist(hwnd); 0 }      // D-03 drag-end
WM_EXITSIZEMOVE => { paint::flush_pending_persist(hwnd); 0 }   // D-03 resize-end
```

**`WM_COMMAND` new arms** (extend the existing match at lines 222-366):
```rust
// Follow the existing pattern: ID_BROWSE_BUTTON => choose_and_set_directory(hwnd),
CMD_SCAN as isize => start_scan_from_controls(hwnd),
CMD_CANCEL_SCAN as isize => stop_current_scan(),  // existing fn at mod.rs:915
CMD_REFRESH as isize => start_scan_from_controls(hwnd),
CMD_EXPORT as isize => { /* wire to existing export entry (not yet present in mod.rs WM_COMMAND — needs to be added) */ }
CMD_FOCUS_SEARCH as isize => { /* Phase 2: no-op stub per UI-SPEC */ }
CMD_DELETE_SEL as isize => {
    // UI-SPEC: focus-conditional. Only fire when list has focus.
    if unsafe { GetFocus() } == with_state_mut(|s| s.list).unwrap_or(0) {
        // Phase 2: no-op stub. Phase 5 wires IFileOperation.
    }
}
```

---

### `src/desktop/paint.rs` (MODIFIED — layout reflow + formatters)

**Analog:** Self — extend `resize_controls` and add formatters next to existing `format_*_ui` helpers (lines 675-712).

**Existing formatter pattern** (`src/desktop/paint.rs` lines 675-712) shows the convention: `pub(super) fn format_*_ui(value: T) -> String`, no allocations beyond the returned String, no DPI awareness.

**New formatters** follow the same style:
```rust
// Add next to format_count_ui / format_duration_ui / format_bytes_ui:

pub(super) fn format_status_files(count: u64, idle: bool) -> String {
    if idle { return "-- files".to_string(); }
    if count == 1 { "1 file".to_string() } else { format!("{} files", format_count_ui(count)) }
}

pub(super) fn format_status_folders(count: u64, idle: bool) -> String { /* same shape */ }
pub(super) fn format_status_errors(count: u64, idle: bool) -> String { /* same shape */ }

pub(super) fn format_status_elapsed(ms: u128, idle: bool) -> String {
    if idle { return "--:--".to_string(); }
    let total_s = ms / 1000;
    let h = total_s / 3600;
    let m = (total_s % 3600) / 60;
    let s = total_s % 60;
    if h == 0 { format!("{m}:{s:02}") } else { format!("{h}:{m:02}:{s:02}") }
}

pub(super) fn format_status_throughput(bytes: u64, elapsed_ms: u128, idle: bool) -> String {
    if idle { return "-- MB/s".to_string(); }
    if elapsed_ms == 0 { return "0.0 MB/s".to_string(); }
    let mb_per_sec = (bytes as f64 / (1024.0 * 1024.0)) / (elapsed_ms as f64 / 1000.0);
    if mb_per_sec > 0.0 && mb_per_sec < 0.1 { return "<0.1 MB/s".to_string(); }
    format!("{mb_per_sec:.1} MB/s")
}
```

**Layout reflow pattern** (extend `resize_controls`, mod.rs:597-708 — note: this function currently lives in `desktop/mod.rs`, NOT `desktop/paint.rs`. Phase 2 keeps it in `mod.rs` since that's where existing reflow lives, OR moves it to paint.rs per CONTEXT "5-pane status bar lives at the bottom... reuse the existing reflow plumbing in `desktop/paint.rs`". Verify before planning.):
```rust
// Existing reflow pattern (mod.rs:616-624):
MoveWindow(state.path_edit, margin, path_y, path_w, button_h, 1);
MoveWindow(state.browse_button, margin + path_w + 8, path_y, browse_w, button_h, 1);

// New reflow follows same shape:
let dpi = GetDpiForWindow(hwnd).max(96);
let scale = |v: i32| (v * dpi as i32) / 96;
let sb_height = scale(24);
MoveWindow(state.drive_picker, scale(8), path_bar_y, scale(80), scale(32), 1);
MoveWindow(state.path_edit, scale(92), path_bar_y, width - scale(108), scale(32), 1);
MoveWindow(state.status, 0, height - sb_height, width, sb_height, 1);
let parts = compute_status_parts(width, dpi);
SendMessageW(state.status, SB_SETPARTS, 5, parts.as_ptr() as Lparam);
```

**Status text update pattern** (copy from `apply_scan_progress` mod.rs:884-913):
```rust
// Existing single-line status pattern (mod.rs:904-911):
set_window_text(status, &format!("Scanning... {} nodes | {} elapsed", ...));

// New per-pane pattern (5 SendMessageW calls instead of 1 SetWindowTextW):
let files_text = wide(&format_status_files(node_count as u64, false));
SendMessageW(status, SB_SETTEXTW, PANE_FILES, files_text.as_ptr() as Lparam);
// ... repeat for folders/errors/elapsed/throughput ...
```

The `set_window_text` helper at mod.rs:1260-1263 STILL applies for the path edit; for status bar panes, use `SendMessageW(SB_SETTEXTW)` directly with `wide()`-encoded strings.

---

### `src/desktop/shell.rs` (MODIFIED — Win32 path/shell validation helper)

**Analog:** Self — `show_shell_context_menu` (lines 28-60+) demonstrates the UTF-16 path canonicalization pattern that the new WM_COPYDATA validator needs.

**Path canonicalization pattern** (copy from `shell.rs::show_shell_context_menu` lines 28-32):
```rust
// Existing pattern: build wide path, pass to Win32, check return.
let wide_path = super::wide(path);
let hr = SHParseDisplayName(wide_path.as_ptr(), null_mut(), &mut pidl, 0, null_mut());
if hr < 0 || pidl.is_null() { return false; }
```

**New `canonicalize_and_check_dir` helper** (RESEARCH Pattern 3 lines 340-359, verbatim recipe). Lives in `desktop/shell.rs` next to existing path-handling code:
```rust
// Pattern matches show_shell_context_menu: wide path, two-call sizing
// (query needed buffer length, allocate, call again), null/error checks
// returning Option<String> (NOT bool — caller needs the canonical path).

pub(super) unsafe fn canonicalize_and_check_dir(raw: &str) -> Option<String> {
    let raw_w = super::wide(raw);
    let needed = GetFullPathNameW(raw_w.as_ptr(), 0, null_mut(), null_mut());
    if needed == 0 { return None; }
    let mut buf = vec![0u16; needed as usize];
    let written = GetFullPathNameW(raw_w.as_ptr(), buf.len() as Dword, buf.as_mut_ptr(), null_mut());
    if written == 0 || written >= buf.len() as Dword { return None; }
    buf.truncate(written as usize);
    let mut nul_term = buf.clone();
    nul_term.push(0);
    let attrs = GetFileAttributesW(nul_term.as_ptr());
    if attrs == INVALID_FILE_ATTRIBUTES { return None; }
    if attrs & FILE_ATTRIBUTE_DIRECTORY == 0 { return None; }
    Some(String::from_utf16_lossy(&buf))
}
```

---

## Shared Patterns

### Pattern: UTF-16 wide-string conversion
**Source:** `src/desktop/mod.rs` lines 1271-1273
**Apply to:** ALL new Win32 string-passing code in settings.rs, ffi.rs callers, cli.rs mutex code.
```rust
fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}
```
**Note:** RESEARCH Assumption A7 calls out that this helper may need to move from `desktop/mod.rs` to `src/io.rs` so settings.rs can reuse it. Planner should land that refactor in an early task. Until moved, settings.rs duplicates it (zero-deps constraint forbids importing through a non-pub helper, and copy-paste is trivial).

### Pattern: Mutex reentrancy discipline (try_lock, not lock)
**Source:** `src/desktop/state.rs` lines 105-116 (`with_state_mut` doc comment)
**Apply to:** EVERY new mutation site in `desktop/state.rs` (settings save sites, drag-coalesce flush, WM_COPYDATA dispatch).
```rust
// Rust's std::Mutex is NOT reentrant — lock() on the same thread would
// deadlock permanently. try_lock() returns Err (WouldBlock) for reentrant
// calls, allowing the reentrant handler to gracefully skip non-critical
// work. Win32 APIs (SetWindowTextW, EnableWindow, SendMessageW) can
// reenter the window proc, so all state-mut helpers must use try_lock.
```
**Save-pattern rule:** Settings save MUST happen OUTSIDE the `with_state_mut` closure. Extract a snapshot inside, drop the lock, then call `store.save(&snapshot)`.

### Pattern: Error handling (silent in release, eprintln in debug)
**Source:** CONTEXT D-03 + existing `src/cli.rs` lines 28-29 (top-level fatal) and `src/scan.rs` lines 99/142 (`.expect("... lock poisoned")`)
**Apply to:** ALL settings I/O failures, ALL WM_COPYDATA validation failures.
```rust
// Three-tier error handling matches existing project conventions:
// 1. Mutex poisoning → .expect("... lock poisoned") (treat as unrecoverable, panic).
// 2. Settings I/O failure → silent in release, eprintln! in debug. NEVER MessageBoxW.
// 3. Top-level CLI fatal → eprintln!("{}: {}", APP_NAME, error); std::process::exit(1);

#[cfg(debug_assertions)]
eprintln!("settings save failed: {error}");
#[cfg(not(debug_assertions))]
let _ = error;
```

### Pattern: Builder functions take `&mut String` first
**Source:** `src/export.rs` lines 257-282 (`push_id_array`, `push_json_string`, `push_csv_field`)
**Apply to:** `push_settings_json`, `push_raw_json_value`, and any other new serializer in `settings.rs`.
```rust
pub(crate) fn push_settings_json(output: &mut String, settings: &Settings) { /* ... */ }
```

### Pattern: PostMessageW for cross-thread payload delivery (lifetime via Box)
**Source:** `src/desktop/mod.rs` lines 797-820 (scan thread → window proc via `Box::into_raw`)
**Apply to:** None directly in Phase 2 — WM_COPYDATA is SYNCHRONOUS (caller's lpData lives only for the SendMessageW call, per RESEARCH Pitfall #2). This is the inverse pattern and serves as a contrast reference: PostMessageW + Box::into_raw → Box::from_raw inside the handler is for ASYNC delivery from worker threads (existing WM_SCAN_DONE/WM_SCAN_PROGRESS); WM_COPYDATA requires memcpy because it's synchronous.

### Pattern: Module-level `#![allow(...)]` for Win32 non-idiomatic naming
**Source:** `src/desktop/ffi.rs` lines 1-8, `src/desktop/state.rs` lines 1-8, `src/desktop/mod.rs` lines 1-8
**Apply to:** No new files need it (settings.rs is pure Rust). All MODIFIED desktop files keep their existing allow-list — no additions needed.

### Pattern: `#[cfg(test)] mod tests {}` inline tests
**Source:** `src/export.rs` lines 301-311, `src/io.rs` lines 281-296, `src/scan.rs` line 511+
**Apply to:** ALL settings.rs unit tests (parser, writer, round-trip, unknown-keys, surrogate pairs). Use cargo's built-in `#[test]` runner. The integration test in `tests/single_instance.rs` is the ONE exception (justification: must spawn the binary, requires `CARGO_BIN_EXE_filetree` env var).

---

## No Analog Found

All Phase 2 files have at least a role-match analog. The settings JSON **parser** (recursive descent reader, ~150-300 LOC) has no codebase analog because the existing project only emits JSON (via `push_json_string`), never consumes it. The parser is greenfield; planner should follow RESEARCH Pattern 1 and the Pitfall #5/#6 guidance (depth limit ≤ 64, surrogate-pair decoding) rather than searching for an in-tree pattern.

| Element | Role | Reason | Substitute |
|---------|------|--------|-----------|
| JSON parser (recursive descent) | reader/parser | No JSON consumer exists in-tree | Follow RESEARCH Pattern 1 + Pitfalls #5/#6; standard recursive-descent grammar |
| `RawJsonValue` enum + round-trip writer for unknown values | data type | No existing union/sum-type for opaque JSON | Greenfield; small enum, derive nothing (zero-deps) |
| ACCEL `#[repr(C, packed(1))]` struct | FFI struct | All existing `#[repr(C)]` structs in ffi.rs are naturally-aligned; this is the first packed struct | Follow RESEARCH Pitfall #1 explicitly — document the divergence inline |
| Drive-letter enumeration helper (`GetLogicalDrives` + per-drive `GetDriveTypeW` filter) | utility | `src/export.rs::drives_json` (lines 218-255) enumerates roots but does NOT filter by `GetDriveTypeW` | Extend or borrow from `drives_json`; new helper lives in `desktop/` (Win32-only) |

## Metadata

**Analog search scope:** All `src/**/*.rs` files (single-binary project, no `lib.rs`)
**Files scanned:** 12 (`src/main.rs`, `cli.rs`, `model.rs`, `io.rs`, `scan.rs`, `export.rs`, `analytics.rs`, `server.rs`, `diff.rs`, `desktop/{mod,ffi,state,paint,theme,shell,tabs,treemap}.rs`)
**Pattern extraction date:** 2026-05-23
**Project constraint compliance:** Zero new Rust crates required by any pattern listed above. One new DLL (`Shlwapi`) per RESEARCH Constraint #3. All naming follows CLAUDE.md conventions (`snake_case`, `push_*`, `is_*`, `PascalCase`, `UPPER_SNAKE_CASE` for Win32).
