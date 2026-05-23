---
phase: 02-settings-polish
verified: 2026-05-23T00:00:00Z
status: gaps_found
score: 4/5 must-haves verified
overrides_applied: 0
gaps:
  - truth: "User can change settings (last path, column widths, dark-mode toggle, hidden/symlink toggles, window size/position), close the app, reopen, and find every setting preserved."
    status: partial
    reason: "Column widths are not persisted. The Settings struct declares `columns: Vec<u32>`, the JSON round-trips it, and flush_pending_persist updates the window geometry — but no code path ever writes live column widths into settings.columns. The `columns()` helper in paint.rs returns hardcoded widths; there is no column-resize gesture. settings.columns is always [] (default) after load. The plan's Task 2 action for flush_pending_persist explicitly says to read column widths from the list-view control, but the implementation omits this step. All other sub-fields (last_path, dark_mode, show_hidden, follow_symlinks, window x/y/w/h) are correctly persisted and restored."
    artifacts:
      - path: "src/desktop/state.rs"
        issue: "flush_pending_persist reads window rect and clears pending_persist but does not read or update state.settings.columns"
      - path: "src/desktop/paint.rs"
        issue: "columns() function returns hardcoded widths [520, 110, 118, 88, 88, 110, 168]; no resize-gesture input path exists"
      - path: "src/settings.rs"
        issue: "columns field exists in Settings struct and JSON, but is always [] in practice — the data flow from UI to settings.columns is missing"
    missing:
      - "Implement column-resize gesture (WM_MOUSEMOVE/WM_LBUTTONUP on column header dividers, or equivalent) that updates live column widths"
      - "In flush_pending_persist, read current column widths from state and write into state.settings.columns before capturing the snapshot"
      - "In create_controls, restore column widths from settings.columns into the column rendering (or update the columns() function to consult DesktopState.settings.columns)"
---

# Phase 02: Settings & Polish Verification Report

**Phase Goal:** Settings persist across launches under `%APPDATA%\FileTree\`, and the desktop shell feels finished (path bar, status bar, keyboard shortcuts) so manual testing of every later phase is ergonomic.
**Verified:** 2026-05-23
**Status:** gaps_found
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can change settings (last path, **column widths**, dark-mode toggle, hidden/symlink toggles, window size/position), close the app, reopen, and find every setting preserved. | PARTIAL | Last path: `start_scan_from_controls` writes `state.settings.last_path` and saves (mod.rs:1001). Dark mode: ID_DARK_CHECK arm writes `state.settings.dark_mode` and saves (mod.rs:348-360). Hidden/symlinks: ID_HIDDEN_CHECK and ID_FOLLOW_CHECK arms do same. Window geometry: `flush_pending_persist` captures via `GetWindowRect` (state.rs:174-188). **Column widths: `settings.columns` is declared in Settings (settings.rs:24) and JSON-serialized (settings.rs:203-210), but is always `[]` — no column-resize gesture exists and `flush_pending_persist` never populates it (state.rs:168-188).** All other sub-fields pass. |
| 2 | Launching a second instance while one is already running focuses the existing window instead of starting a duplicate process (named-mutex single-instance guard). | VERIFIED | `try_forward_or_acquire` in ffi.rs:871-925 implements `CreateMutexW("Local\\FileTree.SingleInstance.v1")`, detects `ERROR_ALREADY_EXISTS`, forwards path via `WM_COPYDATA`, calls `SetForegroundWindow`, then `process::exit(0)`. Wired in `cli.rs:145`. Integration tests pass: `second_instance_exits_quickly` and `second_instance_with_invalid_path_still_exits_zero` both green. |
| 3 | User can pick a drive from a dropdown in the path bar and type a path with folder-name autocomplete instead of editing a plain text input. | VERIFIED | `ComboBoxEx32` created in `create_controls` (mod.rs:577-596), populated via `populate_drive_picker` (mod.rs:1647+). `SHAutoComplete` called on `path_edit` HWND with `SHACF_FILESYS_DIRS | SHACF_AUTOSUGGEST_FORCE_ON | SHACF_AUTOAPPEND_FORCE_ON` flags (mod.rs:618-621). Drive picker change handled by `handle_drive_picker_change` (mod.rs:1734). All FFI constants and structs present in ffi.rs:145-193. |
| 4 | User can drive the app from the keyboard: Enter scans, Esc cancels a scan, Del initiates a delete on the current selection, Ctrl+F focuses search, Ctrl+E opens export, F5 refreshes. | VERIFIED | Accelerator table built with 6 entries (mod.rs:167-173): RETURN→CMD_SCAN, ESCAPE→CMD_CANCEL_SCAN, DELETE→CMD_DELETE_SEL, Ctrl+F→CMD_FOCUS_SEARCH, Ctrl+E→CMD_EXPORT, F5→CMD_REFRESH. `TranslateAcceleratorW` called before `TranslateMessage` (mod.rs:192). WM_COMMAND arms dispatch each command (mod.rs:285-327). Del/Ctrl+E/Ctrl+F are stubs (per plan — Phase 3/4/5 wires), but the accelerator dispatch is wired. Enter and Esc and F5 are functionally active. |
| 5 | The status bar shows live scan stats (files / folders / errors / elapsed / throughput MB/s) during and after a scan. | VERIFIED | `msctls_statusbar32` created in `create_controls` (mod.rs:726-741). `compute_status_parts` lays out 5 panes on `WM_SIZE` (mod.rs:986-988). `apply_scan_progress` writes all 5 panes on each progress tick (mod.rs:1225-1233). `finish_scan` freezes count/elapsed, resets throughput to `-- MB/s` (mod.rs:1150-1155). 13 unit tests for formatters all pass (paint.rs:817-883). |

**Score:** 4/5 truths verified (SC1 partial — column widths gap)

---

### Deferred Items

None — the column-width gap is not covered by any later milestone phase.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/settings.rs` | Settings struct, JSON parser/writer, SettingsStore, atomic write | VERIFIED | 990 lines, fully substantive; 12 unit tests pass including `atomic_write_replaces_existing`. |
| `src/desktop/ffi.rs` | Win32 FFI for mutex, WM_COPYDATA, SHAutoComplete, ComboBoxEx32, accelerators, status bar | VERIFIED | All required constants and function declarations present. |
| `src/desktop/mod.rs` | Full wiring: drive picker, SHAutoComplete, accelerator table, status bar, settings mutation sites | VERIFIED (minus column widths) | All described wiring exists; column-width restore/save is the gap. |
| `src/desktop/state.rs` | DesktopState with settings fields; snapshot_for_save; save_settings_if_dirty; flush_pending_persist | VERIFIED (flush_pending_persist incomplete) | flush_pending_persist correctly captures window geometry but never reads column widths. |
| `src/desktop/paint.rs` | Status bar formatters (format_status_files/folders/errors/elapsed/throughput) + compute_status_parts | VERIFIED | All 5 formatters implemented with unit tests. |
| `src/cli.rs` | Settings load before window creation; clamp_window_to_workarea; pass geometry to desktop::run | VERIFIED | Sequence is correct: mutex → SettingsStore::default → load_or_default → clamp → desktop::run (cli.rs:145-161). |
| `tests/single_instance.rs` | Integration test spawning two instances | VERIFIED | 2 tests, both pass. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `cli.rs::run_desktop` | `CreateWindowExW` | `clamped_geom.x/y/w/h` instead of `CW_USEDEFAULT` | WIRED | mod.rs:125-138; no `CW_USEDEFAULT` in main window creation. |
| `WM_SCAN_PROGRESS` arm | `format_status_throughput` | `apply_scan_progress` → `set_status_pane(SB_SETTEXTW)` | WIRED | mod.rs:1229-1233. |
| Dark-mode toggle | `SettingsStore::save` | `snapshot_for_save` + `save_settings_if_dirty` outside closure | WIRED | mod.rs:347-360. |
| `WM_LBUTTONUP / WM_EXITSIZEMOVE` | `flush_pending_persist` | Direct call | WIRED | mod.rs:511, 515. |
| `try_forward_or_acquire` | `cli.rs::run_desktop` | `#[cfg(windows)]` block | WIRED | cli.rs:145. |
| `WM_COPYDATA` arm | `handle_copy_data` | `window_proc` match arm | WIRED | mod.rs:518. |
| `settings.columns` (in Settings struct) | Column rendering in `paint.rs::columns()` | **MISSING** | NOT_WIRED | `columns()` returns hardcoded widths; never reads `state.settings.columns`. No column-resize gesture populates `settings.columns`. |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `status` pane (files) | `files` count | `finish_scan` / `apply_scan_progress` → `scan.nodes.iter()` | Yes | FLOWING |
| `status` pane (throughput) | `bytes` + `elapsed_ms` | `state.last_scan_bytes` populated in `apply_scan_progress` from real scan root size | Yes | FLOWING |
| Path edit initial text | `settings.last_path` | `SettingsStore::load_or_default` from `%APPDATA%\FileTree\settings.json` | Yes | FLOWING |
| Window position at launch | `settings.window.x/y/w/h` | `cli.rs::run_desktop` → `load_or_default` → `clamp_window_to_workarea` → `CreateWindowExW` | Yes | FLOWING |
| Column widths in rendering | `settings.columns` | Never read; `columns()` returns hardcoded static values | No | DISCONNECTED |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Settings JSON round-trip | `cargo test settings::` | 12/12 pass | PASS |
| Status-bar formatters | `cargo test desktop::paint::tests::` | 13/13 pass | PASS |
| Single-instance guard | `cargo test -- tests::second_instance_exits_quickly` | PASS (~2.5s) | PASS |
| Struct layout for CopyDataStruct | `cargo test ffi::tests::` | 5/5 pass | PASS |
| Full suite | `cargo test` | 55 unit + 2 integration = 57 total, 0 failed | PASS |

---

### Probe Execution

Step 7c: SKIPPED — no probe scripts found in `scripts/*/tests/probe-*.sh`. The phase does not declare probes in PLAN frontmatter.

---

### CI Quad Results

| Command | Result |
|---------|--------|
| `cargo fmt --check` | PASS (no output) |
| `cargo clippy --all-targets -- -D warnings` | PASS (0 warnings, 0 errors) |
| `cargo build --release` | PASS |
| `cargo test` | PASS (55 unit + 2 integration = 57 tests, 0 failed, 0 ignored) |

---

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| SET-01 | Settings file at `%APPDATA%\FileTree\settings.json` via `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` | SATISFIED | `known_folder_roaming_appdata()` in ffi.rs:931; `SettingsStore::default()` in settings.rs:121. |
| SET-02 | Atomic write via temp-file + rename; debounced save on change | SATISFIED | `atomic_write_settings` (settings.rs:746-776) uses `.tmp` + `MoveFileExW(REPLACE|WRITE_THROUGH)`. Drag-coalesce via `pending_persist` (state.rs:69-71). |
| SET-03 | Schema versioning (`schema_version: 1`) with forward-compatible read | SATISFIED | `schema_version: 1` emitted first (settings.rs:180-182). Unknown keys preserved in `BTreeMap<String, RawJsonValue>` (settings.rs:28, 379). `loaded_from_future` flag prevents overwrite of v2+ files (settings.rs:31, 330). |
| SET-04 | Single-instance guard via named mutex to prevent concurrent writes | SATISFIED | `CreateMutexW("Local\\FileTree.SingleInstance.v1")` in ffi.rs:875; integration tests pass. |
| SET-05 | Persisted state includes last path, column widths, dark-mode toggle, hidden/symlink toggles, window size/position | PARTIAL | Last path, dark-mode, show_hidden, follow_symlinks, window geometry all persist correctly. **Column widths: declared in Settings struct and JSON schema but never populated from the UI — always `[]`.** |
| POL-01 | Path bar with drive picker dropdown and folder autocomplete | SATISFIED | `ComboBoxEx32` at mod.rs:577; `SHAutoComplete` at mod.rs:618. |
| POL-02 | Keyboard shortcuts — Enter (scan), Esc (cancel), Del (delete stub), Ctrl+F (search stub), Ctrl+E (export stub), F5 (refresh) | SATISFIED | 6-entry accelerator table (mod.rs:167-173); TranslateAcceleratorW before TranslateMessage (mod.rs:192). Active shortcuts (Enter, Esc, F5) are functional. Del/Ctrl+F/Ctrl+E are wired stubs per plan. |
| POL-03 | Status bar showing scan stats (files / folders / errors / elapsed / throughput MB/s) | SATISFIED | `msctls_statusbar32` created; 5-pane layout; live updates on WM_SCAN_PROGRESS; idle/freeze behavior per UI-SPEC. |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/settings.rs` | 1 | `#![allow(dead_code)]` | Info | Carried over from Plan 01 when settings was unwired. Now wired in production paths — attribute can be removed. No blocker. |
| `src/desktop/state.rs` | 168 | `flush_pending_persist` never reads column widths | Blocker | `settings.columns` always remains `[]`; SC1 / SET-05 column-width persistence is unimplemented. |
| `src/desktop/paint.rs` | 659 | `columns()` returns hardcoded widths, ignores `settings.columns` | Blocker | Even if `settings.columns` were populated, the renderer does not read it back. |

No `TBD`, `FIXME`, or `XXX` markers found in any phase-modified file.

---

### Human Verification Required

The following items require the native desktop app to run on Windows and cannot be verified statically. The 02-04-SUMMARY records that a 13-step manual QA was completed and approved by the user. The items below note what was verified interactively and what could not have been verified (column widths):

1. **Status bar live update cadence**
   **Test:** Scan a directory with >10k files; watch panes update at ~1.5s intervals.
   **Expected:** Files/folders/errors count up; elapsed ticks; MB/s shows a non-zero value; on completion throughput resets to `-- MB/s`.
   **Why human:** Requires a real running scan; verified per 02-04-SUMMARY Task 3.

2. **Column-width persistence (CURRENTLY UNIMPLEMENTED)**
   **Test:** Drag a column header divider to resize a column, close the app, reopen.
   **Expected:** The column should be the same width as before close.
   **Why human (and why it would fail):** Column dragging is not implemented. This behavior cannot be verified until the column-resize gesture and settings.columns wiring are added.

3. **Single-instance path forwarding**
   **Test:** Launch primary with `C:\Windows`, then from another shell launch with `C:\Users`. Verify primary window pops to front and starts a new scan of `C:\Users`.
   **Why human:** Requires two real processes with a visible window; automated test covers exit-code only, not the visual foreground pop.

---

### Gaps Summary

**One blocker gap:** Column-width persistence is declared in the roadmap success criterion and the SET-05 requirement but is not implemented. The `settings.columns` field exists in the data model and JSON schema but the data flow is entirely missing:

1. There is no column-resize gesture (no `WM_NOTIFY` / `HDN_TRACK` handling; `columns()` in paint.rs returns hardcoded widths).
2. `flush_pending_persist` captures window geometry but never reads column widths into `state.settings.columns`.
3. `create_controls` / the column renderer never reads `settings.columns` back even if it were populated.

The column-width sub-criterion was listed in the manual QA script ("drag two columns") but the step would have no visible effect — dragging on the column header area does not resize columns in the current codebase, so the QA result for this specific sub-item is not meaningful evidence.

All other elements of Phase 2 are substantively implemented, tested, and the CI quad passes cleanly.

**Root cause:** The plan's Task 2 action prose says to "update `state.settings.columns` from the current list-view column widths" and notes "if none exists, document and add a small reader." The implementation omits both the reader and the write-back, delivering the geometry-restore path but not the column-width path.

---

_Verified: 2026-05-23_
_Verifier: Claude (gsd-verifier)_
