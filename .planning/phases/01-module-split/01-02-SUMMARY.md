---
phase: 01-module-split
plan: 02
subsystem: ui
tags: [refactor, rust, win32, desktop, modules, ffi]

# Dependency graph
requires:
  - phase: 01-module-split plan 01
    provides: Top-level module extraction from src/main.rs; lean facade with inline mod desktop block intact

provides:
  - src/desktop/ directory with 8 submodule files replacing the inline mod desktop block
  - Locked Phase 8 module names: tabs.rs and treemap.rs (placeholders)
  - WM_SCAN_DONE and WM_SCAN_PROGRESS constants in ffi.rs per CONTEXT cross-boundary rule
  - ScanDone and ScanProgressInfo boxed-payload structs in state.rs

affects: [01-module-split plan 03, Phase 8 VIZ-01, Phase 8 per-tab panels]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "8-line #![allow(...)] baseline copied verbatim to every desktop submodule (RESEARCH Pitfall 1)"
    - "pub(super) blanket visibility for all cross-sibling items; only desktop::run is pub(crate)"
    - "wide() helper stays in mod.rs, accessed by submodules via super::wide()"
    - "icon_for_node placed in paint.rs (used by draw_name_cell) to avoid cross-sibling dependency inversion"
    - "Node.js used for large file line-range deletion to avoid PowerShell backtick interpolation"

key-files:
  created:
    - src/desktop/mod.rs
    - src/desktop/state.rs
    - src/desktop/ffi.rs
    - src/desktop/theme.rs
    - src/desktop/paint.rs
    - src/desktop/shell.rs
    - src/desktop/tabs.rs
    - src/desktop/treemap.rs
  modified:
    - src/main.rs

key-decisions:
  - "icon_for_node placed in paint.rs rather than shell.rs because draw_name_cell (paint.rs) calls it, avoiding cross-sibling dependency inversion"
  - "button_checked placed in paint.rs since it is consumed via use paint::* glob in mod.rs"
  - "wide() helper stays in mod.rs (not extracted to paint.rs or a dedicated util) — submodules access it via super::wide()"
  - "pub(super) vtable struct field names: pub(super) on field name only, NOT on function pointer parameter names inside fn(...) types (Rust does not allow this)"
  - "tabs.rs and treemap.rs use // comment (not //! doc comment) as single placeholder line — passes clippy with no fallback fn needed"

patterns-established:
  - "Pattern: desktop submodule file header — 8-line #![allow(...)] baseline at top of every src/desktop/*.rs file"
  - "Pattern: mod declarations in mod.rs alphabetical order after std imports"
  - "Pattern: use ffi::*; glob import in mod.rs; selective named imports from paint/shell/state/theme"

requirements-completed: [REFAC-01]

# Metrics
duration: 180min
completed: 2026-05-23
---

# Phase 01 Plan 02: Desktop Module Split Summary

**Inline `mod desktop` (~3000 lines in src/main.rs) mechanically split into 8 files under src/desktop/ with every commit passing the full CI quad (build, fmt, clippy -D warnings, tests)**

## Performance

- **Duration:** ~180 min
- **Started:** 2026-05-23T03:00:00Z
- **Completed:** 2026-05-23T06:55:45Z
- **Tasks:** 8
- **Files modified:** 9 (src/main.rs + 8 new src/desktop/* files)

## Accomplishments

- Replaced the inline `#[cfg(windows)] mod desktop { ... }` block in src/main.rs with `#[cfg(windows)] mod desktop;` (directory-form module)
- Created src/desktop/ with exactly 8 files: mod.rs, state.rs, ffi.rs, theme.rs, paint.rs, shell.rs, tabs.rs, treemap.rs
- WM_SCAN_DONE = WM_APP+7 and WM_SCAN_PROGRESS = WM_APP+8 placed in ffi.rs per CONTEXT cross-boundary rule
- ScanDone and ScanProgressInfo boxed-payload structs placed in state.rs per RESEARCH Q3
- Locked Phase 8 module names (tabs.rs, treemap.rs) established as single-line placeholders
- Release build (`cargo build --release`) passes as final canary

## Task Commits

Each task was committed atomically:

1. **Task 1: Hoist mod desktop block into src/desktop/mod.rs** - `340cb0e` (refactor)
2. **Task 2: Extract desktop/state submodule** - `ab071a3` (refactor)
3. **Task 3: Extract desktop/ffi submodule** - `bff9a5b` (refactor)
4. **Task 4: Extract desktop/theme submodule** - `71f8244` (refactor)
5. **Task 5: Extract desktop/paint submodule** - `10dd0d6` (refactor)
6. **Task 6: Extract desktop/shell submodule** - `44a379b` (refactor)
7. **Task 7: Add placeholder tabs.rs and treemap.rs + mod declarations** - `8633559` (refactor)
8. **Task 8: Final mod.rs cleanup pass** - no new commit needed (mod.rs already correct after Task 7)

## Verification Checks

- `src/desktop/` contains exactly 8 files: mod.rs, ffi.rs, state.rs, theme.rs, paint.rs, shell.rs, tabs.rs, treemap.rs
- `src/desktop/mod.rs` line count: **1273 lines** (expected ~1500; within range — scanner orchestration + window_proc dispatcher + control plumbing)
- `src/desktop/tabs.rs` line count: **1 line** (single comment placeholder)
- `src/desktop/treemap.rs` line count: **1 line** (single comment placeholder)
- `WM_SCAN_DONE` defined at ffi.rs line 138: `pub(super) const WM_SCAN_DONE: Uint = WM_APP + 7;`
- `WM_SCAN_PROGRESS` defined at ffi.rs line 139: `pub(super) const WM_SCAN_PROGRESS: Uint = WM_APP + 8;`
- `ScanDone` struct defined at state.rs line 56
- `ScanProgressInfo` struct defined at state.rs line 61
- `cargo build --release` exits 0 (release canary passes)
- `cargo test` 9/9 tests pass

## Files Created/Modified

- `src/main.rs` - inline mod desktop block replaced with `#[cfg(windows)] mod desktop;`
- `src/desktop/mod.rs` - facade: module declarations + pub(crate) fn run + window_proc + scan/event orchestration (1273 lines)
- `src/desktop/state.rs` - DesktopState, STATE OnceLock, with_state_mut, ScanDone, ScanProgressInfo
- `src/desktop/ffi.rs` - all Win32 type aliases, #[repr(C)] structs, constants, 7 extern "system" blocks, GUIDs (~590 lines)
- `src/desktop/theme.rs` - DARK_BRUSH, LIGHT_BRUSH, DARK_MODE_ATOMIC, apply_theme, 14 palette_* helpers (~193 lines)
- `src/desktop/paint.rs` - paint_window, GDI double-buffering, draw_* helpers, format_*_ui, wide, icon_for_node (~720 lines)
- `src/desktop/shell.rs` - show_shell_context_menu, handle_right_click, copy_to_clipboard, show_error_in_thread (~252 lines)
- `src/desktop/tabs.rs` - 1-line placeholder for Phase 8 per-tab panels
- `src/desktop/treemap.rs` - 1-line placeholder for Phase 8 VIZ-01 native treemap

## Decisions Made

- **icon_for_node in paint.rs not shell.rs**: draw_name_cell (paint.rs) calls icon_for_node; placing it in shell.rs would create a paint→shell cross-sibling dependency inversion. Placing it in paint.rs is the natural home.
- **button_checked in paint.rs**: consumed via `use paint::*` glob in mod.rs; paint is its only consumer.
- **wide() stays in mod.rs**: accessed by all submodules via `super::wide()`. No duplication needed.
- **pub(super) on vtable fields only**: Rust does not allow `pub(super)` on function pointer parameter names inside `fn(...)` types — only on the struct field name itself.
- **placeholder file format**: `// comment` (not `//!` doc comment) passes clippy without needing a fallback `_placeholder()` fn.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed pub(super) from vtable function pointer parameter names**
- **Found during:** Task 3 (ffi.rs extraction)
- **Issue:** Plan said to add `pub(super)` to all items, but Rust does not allow visibility qualifiers on parameter names inside `fn(this: *mut c_void, ...)` types in struct fields. Compiler error: `error: expected identifier, found keyword 'pub'`
- **Fix:** Applied `pub(super)` to struct field names only (e.g., `pub(super) QueryInterface: unsafe extern "system" fn(...)`), not to parameter names inside the fn type
- **Files modified:** src/desktop/ffi.rs (IUnknownVtbl, IShellFolderVtbl, IContextMenuVtbl)
- **Committed in:** bff9a5b (Task 3 commit)

**2. [Rule 1 - Bug] Removed unused Ordering import from theme.rs**
- **Found during:** Task 4 (theme.rs extraction)
- **Issue:** `Ordering` imported but DARK_MODE_ATOMIC.store() calls remain in mod.rs; clippy -D warnings triggered
- **Fix:** Changed `use std::sync::atomic::{AtomicBool, Ordering};` to `use std::sync::atomic::AtomicBool;`
- **Files modified:** src/desktop/theme.rs
- **Committed in:** 71f8244 (Task 4 commit)

**3. [Rule 1 - Bug] Removed unused OnceLock import from mod.rs after theme extraction**
- **Found during:** Task 4 (theme.rs extraction)
- **Issue:** After DARK_BRUSH/LIGHT_BRUSH statics moved to theme.rs, OnceLock was unused in mod.rs
- **Fix:** Changed `use std::sync::{Mutex, OnceLock};` to `use std::sync::Mutex;`
- **Files modified:** src/desktop/mod.rs
- **Committed in:** 71f8244 (Task 4 commit)

**4. [Rule 3 - Blocking] Recovered mod.rs from PowerShell backtick interpolation corruption**
- **Found during:** Task 5 (paint.rs extraction)
- **Issue:** PowerShell heredoc with backtick escapes (`\`r\`n`) was interpolated by bash, collapsing the 1500-line file to a single line with literal `\r\n` text
- **Fix:** `git checkout src/desktop/mod.rs` to restore, then used Node.js for all subsequent large file line-range deletions
- **Files modified:** src/desktop/mod.rs (restored)
- **Impact:** No code lost; node.js approach used reliably for remainder of plan

**5. [Rule 1 - Bug] Re-added lost handle_mouse_click function signature**
- **Found during:** Task 5 (paint.rs extraction)
- **Issue:** After Node.js line deletion of paint functions from mod.rs, the signature `unsafe fn handle_mouse_click(hwnd: Hwnd, lparam: Lparam, double_click: bool) {` was absent but function body remained, causing parse error
- **Fix:** Used Edit tool to re-add the missing signature before the function body
- **Files modified:** src/desktop/mod.rs
- **Committed in:** 10dd0d6 (Task 5 commit)

**6. [Rule 1 - Bug] Removed unused Rect import from shell.rs**
- **Found during:** Task 6 (shell.rs extraction)
- **Issue:** Rect imported from ffi in shell.rs but never used; clippy -D warnings triggered
- **Fix:** Removed Rect from ffi import list in shell.rs
- **Files modified:** src/desktop/shell.rs
- **Committed in:** 44a379b (Task 6 commit)

**7. [Rule 1 - Bug] Removed unused c_void import from mod.rs after shell extraction**
- **Found during:** Task 6 (shell.rs extraction)
- **Issue:** After COM vtable functions moved to shell.rs, `c_void` was unused in mod.rs
- **Fix:** Changed `use std::ffi::{OsStr, c_void};` to `use std::ffi::OsStr;`
- **Files modified:** src/desktop/mod.rs
- **Committed in:** 44a379b (Task 6 commit)

---

**Total deviations:** 7 auto-fixed (5 Rule 1 bugs, 1 Rule 1 import cleanup, 1 Rule 3 blocking)
**Impact on plan:** All auto-fixes required for CI quad to pass. No scope creep. Behavior unchanged — pure mechanical relocation.

## Issues Encountered

- PowerShell backtick interpolation corrupted mod.rs during Task 5 line deletion. Resolved by using Node.js `node -e "..."` for all subsequent large file operations. This is a tooling constraint on Windows bash environments.

## Known Stubs

- `src/desktop/tabs.rs` — single comment line. Tab rendering logic stays in mod.rs/paint.rs for Phase 1 per RESEARCH Q1. Will be populated in Phase 8.
- `src/desktop/treemap.rs` — single comment line. Native treemap rendering deferred to Phase 8 (VIZ-01). Currently implemented only in web/app.js.
- `shell.rs::destroy_icons_on_shutdown` — empty stub body (icon cache not yet implemented). Pre-existing condition from original inline mod desktop.

## Next Phase Readiness

Phase 1 mechanical extraction is complete. Plan 03 verifies behavioral parity via the manual smoke checklist.

The 8-file `src/desktop/` layout is locked. Future phases (Phase 8 VIZ-01, per-tab panels) have named homes (treemap.rs, tabs.rs) ready to receive content without renaming.

---
*Phase: 01-module-split*
*Completed: 2026-05-23*

## Self-Check: PASSED

Files verified:
- FOUND: src/desktop/mod.rs
- FOUND: src/desktop/state.rs
- FOUND: src/desktop/ffi.rs
- FOUND: src/desktop/theme.rs
- FOUND: src/desktop/paint.rs
- FOUND: src/desktop/shell.rs
- FOUND: src/desktop/tabs.rs
- FOUND: src/desktop/treemap.rs

Commits verified:
- FOUND: 340cb0e (hoist)
- FOUND: ab071a3 (state)
- FOUND: bff9a5b (ffi)
- FOUND: 71f8244 (theme)
- FOUND: 10dd0d6 (paint)
- FOUND: 44a379b (shell)
- FOUND: 8633559 (tabs+treemap placeholders)
