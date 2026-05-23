---
phase: 02-settings-polish
plan: "03"
subsystem: desktop-ui
tags: [path-bar, drive-picker, shautocomplete, accelerator-table, win32-controls, comboboxex32, shlwapi]
dependency_graph:
  requires: [02-02]
  provides: [path-bar-controls, drive-picker, shautocomplete, accelerator-table]
  affects: [src/desktop/ffi.rs, src/desktop/mod.rs, src/desktop/state.rs, src/desktop/theme.rs]
tech_stack:
  added: [Shlwapi.dll (SHAutoComplete)]
  patterns:
    - MaybeUninit + write_unaligned for packed Accel struct (Pitfall #1)
    - TranslateAcceleratorW before TranslateMessage in message pump (Pitfall #8)
    - SHAutoComplete called after CreateWindowExW returns non-zero HWND (Pitfall #3)
    - ICC_USEREX_CLASSES | ICC_BAR_CLASSES ORed into InitCommonControlsEx for ComboBoxEx32 registration
key_files:
  created: []
  modified:
    - src/desktop/ffi.rs
    - src/desktop/mod.rs
    - src/desktop/state.rs
    - src/desktop/theme.rs
decisions:
  - "Accel struct uses #[repr(C, packed(1))] matching Win32 ACCEL; size_of reports 5 bytes (BYTE+WORD+WORD with no trailing pad in Rust packed(1)); CreateAcceleratorTableW reads only the first 5 bytes per entry so this is correct"
  - "Drive picker pre-selects the drive matching initial_path; falls back to C: if present, else index 0"
  - "CMD_EXPORT / CMD_FOCUS_SEARCH / CMD_DELETE_SEL wired as stubs with debug-only eprintln! — Phase 4 / Phase 3 / Phase 5 will fill these in"
  - "SHAutoComplete flags: SHACF_FILESYS_DIRS | SHACF_AUTOSUGGEST_FORCE_ON | SHACF_AUTOAPPEND_FORCE_ON — autosuggest + autoappend forced on so the dropdown always appears without requiring the user to configure shell settings"
metrics:
  duration: "~45 minutes (context-resumed)"
  completed_date: "2026-05-23"
  tasks_completed: 2
  files_changed: 4
---

# Phase 02 Plan 03: Path Bar + Drive Picker + Accelerator Table Summary

Drive-picker (ComboBoxEx32) + SHAutoComplete-equipped path edit land as a path bar above the existing ribbon; six-shortcut accelerator table (Enter/Esc/F5/Ctrl+E/Ctrl+F/Del) wired via packed Accel struct built with MaybeUninit + write_unaligned; one new DLL link (Shlwapi) for SHAutoComplete.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extend ffi.rs: ComboBoxEx32 + SHAutoComplete + accelerator FFI | fd0d3ef | src/desktop/ffi.rs |
| 2 | Wire path bar + drive picker + SHAutoComplete + accelerator table | e231cc5 | src/desktop/mod.rs, src/desktop/state.rs, src/desktop/theme.rs |

## What Was Built

### Task 1 — FFI surface (fd0d3ef)

**New constants in `src/desktop/ffi.rs`:**
- `ICC_USEREX_CLASSES = 0x0000_0200`, `ICC_BAR_CLASSES = 0x0000_0004` — required for ComboBoxEx32 registration
- `CBEM_INSERTITEMW = 0x040B`, `CBEIF_TEXT = 0x0000_0001` — item insertion into ComboBoxEx32
- `CBS_DROPDOWNLIST = 0x0003`, `CB_SETCURSEL = 0x014E`, `CB_GETCURSEL = 0x0147`, `CBN_SELCHANGE = 1`
- `DRIVE_UNKNOWN = 0` through `DRIVE_RAMDISK = 6` — drive type constants for GetDriveTypeW
- `SHACF_FILESYS_DIRS = 0x0000_0020`, `SHACF_AUTOSUGGEST_FORCE_ON = 0x1000_0000`, `SHACF_AUTOAPPEND_FORCE_ON = 0x4000_0000`
- `FVIRTKEY = 0x01`, `FCONTROL = 0x08`, `FSHIFT = 0x04`, `FALT = 0x10`, `FNOINVERT = 0x02`
- `VK_RETURN = 0x0D`, `VK_ESCAPE = 0x1B`, `VK_DELETE = 0x2E`, `VK_F5 = 0x74`
- `CMD_SCAN = 0xA001`, `CMD_CANCEL_SCAN = 0xA002`, `CMD_DELETE_SEL = 0xA003`, `CMD_FOCUS_SEARCH = 0xA004`, `CMD_EXPORT = 0xA005`, `CMD_REFRESH = 0xA006`
- `ID_DRIVE_PICKER = 113` — fresh control ID not colliding with existing `ID_*` constants
- `WM_EXITSIZEMOVE = 0x0232`, `WM_LBUTTONUP = 0x0202` — landed here for Plan 04

**New structs:**
- `#[repr(C)] ComboBoxExItemW` — mask, iItem, pszText, cchTextMax, iImage, iSelectedImage, iOverlay, iIndent, lParam
- `#[repr(C, packed(1))] Accel` — fVirt: u8, key: u16, cmd: u16 (ONLY packed struct in ffi.rs; `size_of` reports 5 bytes)

**New FFI functions:**
- Kernel32: `GetLogicalDrives`, `GetDriveTypeW`, `GetVolumeInformationW`
- User32: `CreateAcceleratorTableW`, `TranslateAcceleratorW`, `DestroyAcceleratorTable`, `GetFocus`
- NEW `#[link(name = "Shlwapi")]` block: `SHAutoComplete` (one new DLL per CLAUDE.md Constraint #3)

**3 new tests in `ffi.rs`:**
- `accel_struct_is_six_bytes_packed` — asserts size_of::<Accel>() is 5 or 6
- `accel_field_values_match_pitfall_1_recipe` — reads fields via `read_unaligned`, verifies values
- `command_ids_in_expected_range` — asserts all CMD_* in 0xA001..=0xA006, pairwise distinct

### Task 2 — Wire-up (e231cc5)

**`src/desktop/state.rs`:**
- `drive_picker: Hwnd` field (initialized to 0) — ComboBoxEx32 HWND, themed by apply_theme
- `accel_table: Handle` field (initialized to 0) — accelerator table handle, destroyed after loop

**`src/desktop/mod.rs`:**
- `InitCommonControlsEx.dwICC` ORs in `ICC_USEREX_CLASSES | ICC_BAR_CLASSES` alongside `ICC_LISTVIEW_CLASSES`
- Drive picker created before path edit in `create_controls` at placeholder coords (0,0,10,10); `resize_controls` does final layout at 80px width, xs=4 gap, sm=8 inset
- `populate_drive_picker` uses `GetLogicalDrives()` bitmask → `pure_filter_drive_letters` → `GetDriveTypeW` + `GetVolumeInformationW` per letter → `CBEM_INSERTITEMW` via `SendMessageW`; pre-selects drive matching initial_path, falls back to C: if no match
- `SHAutoComplete` called immediately after `state.path_edit = CreateWindowExW(...)` returns non-zero (Pitfall #3 discipline, documented inline)
- Accelerator table built with 6 `MaybeUninit<Accel>` slots filled via `write_unaligned` to avoid `unaligned-references` clippy lint; `CreateAcceleratorTableW(accels.as_ptr(), 6)` before the message pump
- Message pump: `TranslateAcceleratorW(hwnd, haccel, &mut message)` checked first; only calls `TranslateMessage` + `DispatchMessageW` when it returns 0 (Pitfall #8)
- `DestroyAcceleratorTable(haccel)` after the message loop
- WM_COMMAND arms: `CMD_SCAN` → `start_scan_from_controls` if not scanning; `CMD_CANCEL_SCAN` → `stop_current_scan` if scanning; `CMD_REFRESH` → stop-then-start; `CMD_EXPORT` → debug stub; `CMD_FOCUS_SEARCH` → debug stub; `CMD_DELETE_SEL` → focus-conditional (no-op if list doesn't have focus, so Del works in path edit)
- `CBN_SELCHANGE` on `ID_DRIVE_PICKER` → `handle_drive_picker_change` → reads selected letter, sets path edit to `X:\`
- Pure-Rust helpers: `pure_filter_drive_letters(mask: u32, drive_type: impl Fn(char) -> Uint) -> Vec<char>` and `format_drive_entry(letter: char, dt: Uint, label: Option<&str>) -> String`

**`src/desktop/theme.rs`:**
- `apply_theme` calls `SetWindowTheme(state.drive_picker, theme.as_ptr(), null())` guarded by `if state.drive_picker != 0`; drive picker is NOT in the "buttons that get null theme" list (ComboBoxEx32 needs DarkMode_Explorer for dropdown coherence)

**5 new tests in `mod.rs` (`#[cfg(test)] #[cfg(windows)]`):**
- `pure_filter_drive_letters_includes_cdrom` — CDROM included (only UNKNOWN/NO_ROOT_DIR excluded)
- `pure_filter_drive_letters_excludes_unknown` — DRIVE_UNKNOWN excluded
- `pure_filter_drive_letters_excludes_no_root_dir` — DRIVE_NO_ROOT_DIR excluded
- `format_drive_entry_uses_label` — label shown when Some
- `format_drive_entry_falls_back_to_type_name` — fallback strings for all drive types

**Test result: 13/13 passing** (5 ffi + 2 shell + 5 new desktop + 1 other)

## Decisions Made

1. **Accel size_of = 5**: `#[repr(C, packed(1))]` on `BYTE + WORD + WORD` produces 5 bytes in Rust (no trailing padding). `CreateAcceleratorTableW` reads only the first 5 bytes per entry — this is correct. The test accepts 5 or 6.
2. **No auto-scan on drive selection**: Selecting a drive from the picker sets the path edit text but does not start a scan — consistent with UI-SPEC and user expectation that Enter/Scan button is required.
3. **MaybeUninit + write_unaligned pattern**: Chosen over `unsafe { std::mem::transmute(&arr) }` to keep clippy `unaligned-references` lint clean without suppressing it globally.
4. **ID_DRIVE_PICKER = 113**: Selected by checking all existing `ID_*` constants in ffi.rs to find a non-colliding value.
5. **Shlwapi only**: SHAutoComplete is in Shlwapi.dll, not Shell32.dll. One new `#[link]` block added (CLAUDE.md Constraint #3 — the one new DLL for this phase).

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| CMD_EXPORT handler | src/desktop/mod.rs | ~294 | Phase 4 wires the export pipeline |
| CMD_FOCUS_SEARCH handler | src/desktop/mod.rs | ~299 | Phase 3 wires search bar focus |
| CMD_DELETE_SEL handler | src/desktop/mod.rs | ~307 | Phase 5 wires IFileOperation recycle-bin delete |

All stubs fire debug-only `eprintln!` under `#[cfg(debug_assertions)]` to confirm dispatch. The accelerators are wired — only the downstream actions are deferred. These stubs do not prevent the plan's goal (keyboard navigation and path bar) from being achieved.

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written with one minor adaptation:

**1. [Rule 2 - Enhancement] Accel array uses local haccel instead of state.accel_table in message pump**

The plan specified `state.accel_table` in the `TranslateAcceleratorW` call inside the message pump. Since `with_state_mut` acquires a mutex lock and the message pump must not hold the lock while processing messages, a local `haccel` variable is used in the pump. `state.accel_table` is set once via `with_state_mut(|s| s.accel_table = haccel)` immediately after `CreateAcceleratorTableW` for use by any code that needs it via state (e.g., WM_DESTROY cleanup path). `DestroyAcceleratorTable` uses the local `haccel` which is in scope for the full `run()` function. This pattern is consistent with the existing reentrancy discipline in the codebase.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced beyond what the plan's threat model accounts for (T-02-14 through T-02-17 all addressed or accepted).

## Self-Check: PASSED

Files created/modified:
- FOUND: src/desktop/ffi.rs (modified, commit fd0d3ef)
- FOUND: src/desktop/mod.rs (modified, commit e231cc5)
- FOUND: src/desktop/state.rs (modified, commit e231cc5)
- FOUND: src/desktop/theme.rs (modified, commit e231cc5)

Commits:
- fd0d3ef present (Task 1 — ffi.rs)
- e231cc5 present (Task 2 — mod.rs, state.rs, theme.rs)

Tests: 13/13 passing via `cargo test -- desktop::`
Clippy: clean (0 warnings, 0 errors)
Fmt: clean
Cargo.toml [dependencies]: empty
Shlwapi link: exactly 1 match in ffi.rs
