---
phase: 02-settings-polish
plan: "04"
subsystem: desktop-ui
tags: [statusbar, msctls_statusbar32, settings-persistence, drag-coalesce, geometry-restore, dpi-scaling]
dependency_graph:
  requires: [02-01, 02-02, 02-03]
  provides: [status-bar, save-on-mutate, geometry-restore]
  affects:
    - src/cli.rs
    - src/desktop/ffi.rs
    - src/desktop/mod.rs
    - src/desktop/paint.rs
    - src/desktop/state.rs
    - src/settings.rs
tech_stack:
  added: []
  patterns:
    - 5-pane msctls_statusbar32 with SB_SETPARTS sized at current DPI
    - SB_SETTEXTW per pane on each WM_SCAN_PROGRESS tick
    - Drag-coalesce via pending_persist flag set in WM_SIZE and flushed in WM_EXITSIZEMOVE / WM_LBUTTONUP (D-03)
    - Geometry restored from settings BEFORE CreateWindowExW (no-jank restore)
    - clamp_window_to_workarea as a pure function with injected workarea for testability
    - save-settings-outside-state-lock pattern via snapshot_for_save / save_settings_if_dirty (reentrancy discipline)
key_files:
  created: []
  modified:
    - src/cli.rs
    - src/desktop/ffi.rs
    - src/desktop/mod.rs
    - src/desktop/paint.rs
    - src/desktop/state.rs
    - src/settings.rs
decisions:
  - "Status bar idle markers: '-- files', '-- folders', '-- errors', '--:--', '-- MB/s' — uniform two-dash placeholder so pre-scan state reads as 'not measured yet'"
  - "Throughput resets to '-- MB/s' on scan completion or cancel (not frozen at final rate) — throughput is a live-only metric per UI-SPEC; final counts remain frozen in their panes"
  - "Drag-coalesce uses pending_persist boolean rather than a debounce timer — flush on WM_EXITSIZEMOVE / WM_LBUTTONUP is sufficient and avoids a timer-thread; matches D-03"
  - "Window geometry clamped to primary monitor work area at startup; SPI_GETWORKAREA fallback is 1920x1080 if the system call fails (safe minimum)"
  - "Settings save runs outside the state Mutex via snapshot_for_save() that copies needed fields, then save_settings_if_dirty() writes — prevents WM_SETTINGCHANGE-style reentrancy from deadlocking under lock"
metrics:
  duration: "~60 minutes (incl. release build + manual QA)"
  completed_date: "2026-05-23"
  tasks_completed: 3
  files_changed: 6
  tests_added: 13
checkpoints:
  - type: human-verify
    name: "13-step manual QA — settings persistence + status bar"
    verdict: approved
    verified_by: user
---

# Phase 02 Plan 04: Status Bar + Save-on-Mutate + Geometry Restore Summary

5-pane `msctls_statusbar32` lands at the bottom of the desktop window with live scan stats (files / folders / errors / elapsed / throughput MB/s); `SettingsStore` is wired to all persisted-field mutation sites (toggles, last path, window geometry) with drag-coalesce on continuous WM_SIZE events; window geometry is restored from settings BEFORE `CreateWindowExW` (no first-frame jank); 13-step manual QA approved by user.

## Tasks Completed

### Task 1 — Status-bar FFI + msctls_statusbar32 + formatter unit tests (commit `128534d`)

- Added status-bar FFI: `SBARS_SIZEGRIP`, `SB_SETPARTS`, `SB_SETTEXTW`, `SB_GETPARTS`, `SPI_GETWORKAREA`, `PANE_FILES/FOLDERS/ERRORS/ELAPSED/THROUGHPUT` constants in `src/desktop/ffi.rs`.
- Added `SystemParametersInfoW` and `GetWindowRect` to the User32 FFI block.
- Added `settings`, `pending_persist`, `last_scan_bytes`, `last_scan_elapsed_ms`, `status_idle` fields to `DesktopState`.
- Replaced the placeholder STATIC status with `msctls_statusbar32` in `create_controls`; `SB_SETPARTS` in `resize_controls` lays out the 5 panes at the current DPI.
- `apply_scan_progress` sends per-pane `SB_SETTEXTW` on each progress tick (~1.5s cadence); `finish_scan` freezes count/elapsed panes and resets throughput to `-- MB/s`.
- 13 unit tests for `format_status_files/folders/errors/elapsed/throughput` and `compute_status_parts` (covers 96dpi and 144dpi scaling).

### Task 2 — Wire settings-store mutation sites + geometry restore + drag-coalesce (commits `96edd4e`, `58c794e`)

- `desktop::run()` now accepts `Settings`, `SettingsStore`, and clamped `WindowGeometry`; `cli.rs` loads / clamps / passes them in.
- `CreateWindowExW` uses saved geometry instead of `CW_USEDEFAULT` — restore happens before the first frame paints (no-jank restore).
- `create_controls` restores checkbox states (hidden/symlinks/dark) and `last_path` from settings on startup.
- Dark / hidden / follow toggles save settings immediately, outside the state lock.
- `start_scan_from_controls` commits `last_path` to settings on each scan.
- `WM_SIZE` sets `pending_persist=true`; `WM_LBUTTONUP` and `WM_EXITSIZEMOVE` flush pending via `flush_pending_persist()`; `WM_DESTROY` flushes pending before `PostQuitMessage` (D-03 drag-coalesce).
- `clamp_window_to_workarea()` is a pure function with injected work area (testable); `primary_workarea()` reads `SPI_GETWORKAREA` and falls back to `1920x1080` on failure.
- `Rect`, `SPI_GETWORKAREA`, `SystemParametersInfoW` promoted to `pub(crate)` for `cli.rs` use.
- `save_settings_if_dirty()` and `snapshot_for_save()` enforce reentrancy discipline (save outside the state lock).
- `fix(02-04)`: renamed `error` → `_error` in `load_or_default` to silence an unused-variable warning when `cfg(debug_assertions)` is off.

### Task 3 — Manual QA checkpoint (human-verify, approved)

Built the release binary inside the worktree; presented the 13-step QA script to the user covering:

- Status-bar basics (idle markers, 5 panes visible)
- Scan progress (live updates ~1.5s, freeze on completion, throughput reset)
- Cancel + idle reset
- Settings persistence — toggles (hidden / symlinks / dark mode) across restart
- Settings persistence — last path across restart
- Window geometry restore (size + position across restart)
- Edge case: off-screen geometry clamping
- No-crash baseline (full scan → expand/collapse → tab switch → close)

User verdict: **approved**.

## Files Changed

| File | Lines Δ | What changed |
|------|---------|--------------|
| `src/desktop/ffi.rs` | +28 / +14 | Status-bar constants, `SystemParametersInfoW`, `GetWindowRect`, visibility promotions |
| `src/desktop/mod.rs` | +191 / +125 | msctls_statusbar32 wiring, 5-pane layout, progress dispatch, geometry-restore CreateWindowExW, drag-coalesce hooks |
| `src/desktop/paint.rs` | +179 | 13 formatter unit tests for status-bar text + DPI part layout |
| `src/desktop/state.rs` | +21 / +94 | New status / persistence fields; clamp / save / snapshot helpers |
| `src/cli.rs` | +125 | Load settings → clamp geometry → pass into `desktop::run()`; primary_workarea fallback |
| `src/settings.rs` | +2 / -2 | Release-mode warning silence in `load_or_default` |

## Validation

- `cargo fmt --check` — clean
- `cargo clippy --all-targets -- -D warnings` — clean
- `cargo build --release` — succeeds; binary at `target/release/filetree.exe`
- `cargo test` — all tests pass (13 new status-bar formatter tests + prior suite)
- 13-step manual QA — approved by user

## Requirements Delivered

- **SET-01** Settings persist across launches (toggles, last path, window geometry)
- **SET-02** Atomic temp+rename writes survive crash mid-write (covered by 02-01 + drag-coalesce here)
- **SET-03** schema_version=1 baseline preserved (settings.json round-trips cleanly)
- **SET-04** Geometry clamped to visible work area on restore
- **SET-05** All persisted-field types covered (bool toggles, string path, rect geometry)
- **POL-03** Status bar shows live scan stats during and after a scan

## Carry-Outs

- None. Plan is fully complete; phase verification is the next gate.

## Pitfalls Encountered + Recovered

- None during implementation. Drag-coalesce + save-outside-lock recipe from RESEARCH.md applied cleanly; geometry-restore-before-CreateWindowExW ordering avoided a known first-frame jank pitfall.
