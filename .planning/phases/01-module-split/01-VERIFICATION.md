---
phase: 01-module-split
verified: 2026-05-23T07:30:00Z
status: passed
score: 6/6 must-haves verified
overrides_applied: 0
re_verification: null
gaps: []
human_verification: []
---

# Phase 1: Module Split — Verification Report

**Phase Goal:** Mechanically split `src/main.rs` (5055 lines) into modules without behavior change.
**Verified:** 2026-05-23T07:30:00Z
**Status:** PASSED
**Re-verification:** No — initial verification.

---

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `cargo build` succeeds on Windows with the new module layout (`cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/*`) | VERIFIED | `cargo build --release` exits 0; all 9 top-level modules + 8 desktop submodules compile. |
| 2 | `cargo fmt --check` and `cargo clippy -- -D warnings` both pass | VERIFIED | `cargo fmt --check` exits 0 (no output); `cargo clippy --all-targets -- -D warnings` exits 0. |
| 3 | Manual smoke test confirms `desktop`, `serve`, and `scan` modes all run with identical observable behavior to v0.1.0 | VERIFIED | 01-03-SUMMARY.md records user sign-off "approved" on 2026-05-23, covering all three modes and dependency audit. |
| 4 | No new dependencies appear in `Cargo.toml [dependencies]` | VERIFIED | `Cargo.toml [dependencies]` is empty; `cargo tree --depth 0` returns only `filetree v0.1.0`. |
| 5 | `src/main.rs` is a lean facade (~15 lines) | VERIFIED | `src/main.rs` is 17 lines: `#![cfg_attr(...)]` at line 1, 8 `mod` declarations, `fn main() { cli::run(); }`, `#[cfg(windows)] mod desktop;`. |
| 6 | All 9 existing unit tests pass, distributed across modules | VERIFIED | `cargo test` reports 9/9 pass: 2 in `io::tests`, 6 in `scan::tests`, 1 in `export::tests`. |

**Score:** 6/6 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/model.rs` | Pure data types: NodeRecord, ScanOptions, etc. | VERIFIED | `pub(crate) struct NodeRecord` at line 17. |
| `src/io.rs` | Platform helpers, argv parsing, path/format utils | VERIFIED | `pub(crate) fn wildcard_match` at line 164; 2 tests in `#[cfg(test)] mod tests`. |
| `src/scan.rs` | Multi-threaded BFS scan engine | VERIFIED | `pub(crate) fn scan_path_with_progress` at line 20; 6 scan tests + `make_test_node` helper in `#[cfg(test)] mod tests`. |
| `src/analytics.rs` | Pure compute over `&[NodeRecord]` | VERIFIED | `pub(crate) fn exact_duplicates_json` at line 11; imports `push_json_string` from `crate::export` (forward-dep resolved). |
| `src/export.rs` | JSON/CSV serializers and push_* builders | VERIFIED | `pub(crate) fn scan_result_to_json` at line 11; `csv_fields_are_escaped` test in `#[cfg(test)] mod tests`. |
| `src/server.rs` | HTTP/1.1 server + `include_str!` web asset constants | VERIFIED | `pub(crate) fn run_server` at line 23; three `include_str!("../web/...")` constants at lines 19-21. |
| `src/cli.rs` | Argv parsing + mode dispatch | VERIFIED | `pub(crate) fn run` at line 18; `pub(crate) const APP_NAME` at line 15; `pub(crate) const APP_VERSION` at line 16. |
| `src/diff.rs` | Locked-name placeholder for Phase 7 | VERIFIED | 1-line file: `//! Snapshot diff — reserved for Phase 7.` |
| `src/main.rs` | Lean crate root: module declarations + `fn main()` | VERIFIED | 17 lines. `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` at line 1. `fn main() { cli::run(); }` at lines 12-14. |
| `src/desktop/mod.rs` | Facade + `window_proc` dispatcher + `pub(crate) fn run` | VERIFIED | `pub(crate) fn run` at line 76; 7 submodule declarations; `use crate::model::*`, `use crate::cli::APP_NAME`, `use crate::scan::scan_path_with_progress`. No `use super::*;`. |
| `src/desktop/ffi.rs` | Raw Win32 type aliases, structs, constants, extern blocks | VERIFIED | `pub(super) const WM_SCAN_DONE: Uint = WM_APP + 7` at line 138; `WM_SCAN_PROGRESS` at line 139; 9 `#[link]` blocks (7 from plan spec + Kernel32 desktop functions + second Shell32 — see note below). |
| `src/desktop/state.rs` | DesktopState, STATE OnceLock, ScanDone, ScanProgressInfo | VERIFIED | `pub(super) struct DesktopState` at line 22; `ScanDone` at line 56; `ScanProgressInfo` at line 61. |
| `src/desktop/theme.rs` | DARK_BRUSH, LIGHT_BRUSH, DARK_MODE_ATOMIC, palette_* helpers | VERIFIED | `pub(super) static DARK_MODE_ATOMIC` at line 23; 14 `palette_*` functions present. |
| `src/desktop/paint.rs` | paint_window, GDI double-buffering, format_*_ui helpers | VERIFIED | `pub(super) unsafe fn paint_window` at line 67. |
| `src/desktop/shell.rs` | enable_visual_styles, show_shell_context_menu, copy_to_clipboard | VERIFIED | `pub(super) unsafe fn show_shell_context_menu` at line 28. |
| `src/desktop/tabs.rs` | Locked-name placeholder for Phase 8 | VERIFIED | 1-line file: `// Placeholder: tab-specific render logic will be extracted here in a future phase.` |
| `src/desktop/treemap.rs` | Locked-name placeholder for Phase 8 VIZ-01 | VERIFIED | 1-line file: `// Placeholder: treemap tile rendering will be extracted here in a future phase.` |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/main.rs` | `src/cli.rs::run` | `fn main() { cli::run(); }` | VERIFIED | Line 13: `cli::run();` |
| `src/scan.rs` | `src/model.rs` + `src/io.rs` | `use crate::model::*; use crate::io::*` | VERIFIED | Lines 10 and 14: explicit `use crate::io::{...}` and `use crate::model::{...}` |
| `src/server.rs` | `src/scan.rs` + `src/export.rs` + `src/analytics.rs` | `use crate::analytics::*; use crate::export::*; use crate::scan::*` | VERIFIED | Lines 10-17: `use crate::analytics::exact_duplicates_json; use crate::export::{...}; use crate::scan::scan_path;` |
| `src/export.rs` | `src/analytics.rs` | `analytics::` calls | VERIFIED | Line 4: `use crate::analytics::{age_stats, duplicate_candidates, extension_stats, largest_dir_ids, top_file_ids};` |
| `src/analytics.rs` | `src/export.rs` | `use crate::export::push_json_string` | VERIFIED | Line 6: `use crate::export::{push_id_array, push_json_string};` — forward-dep resolved. |
| `src/main.rs` | `src/desktop/mod.rs` | `#[cfg(windows)] mod desktop;` | VERIFIED | Line 16-17 of main.rs; `cli::run_desktop` calls `crate::desktop::run(initial_path)` at cli.rs line 85. |
| `src/desktop/mod.rs` | `src/desktop/paint.rs` | `use paint::*;` → `paint_window(hwnd)` | VERIFIED | `use paint::*;` at mod.rs line 36; `paint_window(hwnd)` called at line 170. |
| `src/desktop/state.rs` | `src/desktop/mod.rs` | `Box::into_raw` → LPARAM → `Box::from_raw` for ScanDone | VERIFIED | ScanDone struct in state.rs; usage in mod.rs start_scan_from_controls and WM_SCAN_DONE handler. |
| `src/desktop/paint.rs` | `src/desktop/theme.rs` | `use super::theme::*` | VERIFIED | `use super::theme::{...}` at paint.rs lines 21+. |
| `src/desktop/shell.rs` | `src/desktop/mod.rs::wide` | `super::wide(path)` | VERIFIED | `super::wide(path)` at shell.rs line 29 (and subsequent lines). |

---

### Data-Flow Trace (Level 4)

Not applicable. This is a mechanical refactor (move-only). No new data flows were introduced; existing data flows are identical to v0.1.0. Behavioral parity confirmed by user smoke test (01-03-SUMMARY.md).

---

### Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Release build compiles | `cargo build --release` | exit 0, "Finished `release` profile" | PASS |
| Debug build compiles | `cargo build` (via clippy) | exit 0 | PASS |
| All 9 tests pass | `cargo test` | 9/9 pass, 0 failed | PASS |
| No new deps | `cargo tree --depth 0` | `filetree v0.1.0` only | PASS |
| Format clean | `cargo fmt --check` | exit 0 (no output) | PASS |
| Clippy clean | `cargo clippy --all-targets -- -D warnings` | exit 0 (no output) | PASS |

---

### Probe Execution

No probe scripts defined or applicable to this phase. The phase validation relied on the CI quad commands plus the human smoke test checkpoint (Plan 03, Task 2). Both are verified above.

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| REFAC-01 | 01-01-PLAN.md, 01-02-PLAN.md, 01-03-PLAN.md | Split `src/main.rs` into modules (`cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/*`) without behavior change; `cargo build`, `cargo fmt --check`, `cargo clippy -D warnings`, and existing smoke test all pass | SATISFIED | All 9 modules present; `src/desktop/` has 8 files; CI quad passes; smoke test user-approved. |

No orphaned requirements: REQUIREMENTS.md maps only REFAC-01 to Phase 1, which is fully covered.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | No TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers found in any `src/` file | — | — |

Note on ffi.rs link block count: The plan's acceptance criteria stated "7 `#[link]` blocks (User32, Gdi32, Shell32, Comctl32, Dwmapi, Ole32, UxTheme); NOT 8 (Kernel32 stays in src/io.rs)." The actual ffi.rs has 9 blocks — it includes a Kernel32 block for desktop-specific functions (GlobalAlloc, GetModuleHandleW, CreateActCtxW, ActivateActCtx, GetDiskFreeSpaceExW) and a second Shell32 block. These are not duplications of the io.rs Kernel32 block (which contains only GetCompressedFileSizeW). This is a plan-annotation error (the plan underestimated the original inline desktop block's link counts), not a behavioral regression. The CI quad passes, confirming no linking issues.

---

### Human Verification Required

None. All must-haves are verifiable programmatically or were covered by the user-approved smoke test documented in 01-03-SUMMARY.md.

---

### Gaps Summary

No gaps. All six roadmap success criteria are verified. The CI quad (cargo build --release, cargo fmt --check, cargo clippy --all-targets -- -D warnings, cargo test) passes on the current HEAD. All 17 required source artifacts exist with substantive, wired implementations. REFAC-01 is satisfied.

---

## Structural Verification Detail

### src/main.rs Final Form (17 lines)

```
Line 1:  #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
Line 3:  mod analytics;
Line 4:  mod cli;
Line 5:  mod diff;
Line 6:  mod export;
Line 7:  mod io;
Line 8:  mod model;
Line 9:  mod scan;
Line 10: mod server;
Line 12: fn main() {
Line 13:     cli::run();
Line 14: }
Line 16: #[cfg(windows)]
Line 17: mod desktop;
```

- `windows_subsystem` attribute at line 1 (Pitfall 3 — confirmed).
- `fn main()` delegates entirely to `cli::run()` (confirmed).
- Inline `mod desktop { ... }` block replaced by directory-form `#[cfg(windows)] mod desktop;` (confirmed).

### src/desktop/ Directory (8 files)

| File | Lines (approx) | Role |
|------|---------------|------|
| mod.rs | 1273 | Facade: pub(crate) fn run, window_proc, scan orchestration, event handlers |
| ffi.rs | ~600+ | All Win32 type aliases, #[repr(C)] structs, constants, extern blocks |
| state.rs | ~70 | DesktopState, STATE OnceLock, with_state_mut, ScanDone, ScanProgressInfo |
| theme.rs | ~193 | DARK_BRUSH, LIGHT_BRUSH, DARK_MODE_ATOMIC, apply_theme, 14 palette_* helpers |
| paint.rs | ~720 | paint_window, GDI double-buffering, draw_* helpers, format_*_ui, icon_for_node |
| shell.rs | ~252 | show_shell_context_menu, copy_to_clipboard, show_error_in_thread |
| tabs.rs | 1 | Placeholder for Phase 8 |
| treemap.rs | 1 | Placeholder for Phase 8 VIZ-01 |

### Visibility Invariant

Only one `pub(crate)` symbol in all of `src/desktop/`: `desktop::run` in `src/desktop/mod.rs` line 76. All cross-sibling items are `pub(super)`. No `use super::*;` wildcards anywhere in `src/desktop/`.

### Test Distribution (9 total)

| Module | Tests |
|--------|-------|
| `io::tests` | `wildcard_supports_star_and_question`, `epoch_formats_unix_start` (2) |
| `scan::tests` | `aggregate_nodes_sums_children_into_parent`, `snapshot_result_has_correct_aggregation`, `snapshot_releases_nodes_lock_before_aggregation`, `active_guard_decrements_active_and_sets_done_when_empty`, `active_guard_does_not_set_done_when_dirs_remain`, `scan_path_with_progress_sends_partial_results` (6) |
| `export::tests` | `csv_fields_are_escaped` (1) |

---

_Verified: 2026-05-23T07:30:00Z_
_Verifier: Claude (gsd-verifier)_
