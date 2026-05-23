---
phase: 01-module-split
reviewed: 2026-05-23T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - src/main.rs
  - src/model.rs
  - src/io.rs
  - src/scan.rs
  - src/analytics.rs
  - src/export.rs
  - src/server.rs
  - src/cli.rs
  - src/diff.rs
  - src/desktop/mod.rs
  - src/desktop/state.rs
  - src/desktop/ffi.rs
  - src/desktop/theme.rs
  - src/desktop/paint.rs
  - src/desktop/shell.rs
  - src/desktop/tabs.rs
  - src/desktop/treemap.rs
findings:
  critical: 0
  blocker: 0
  warning: 6
  info: 5
  total: 11
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-05-23
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Phase 1 was a mechanical move-only refactor: the inline `mod desktop { ... }` block (and a handful of related re-exports) was extracted from a 5,055-line `src/main.rs` into eight `src/desktop/*.rs` submodules. The eight top-level modules (`model`, `io`, `scan`, `analytics`, `export`, `server`, `cli`, `diff`) were already extracted in prior commits and only required tiny housekeeping in `server.rs` / `export.rs` (replacing `crate::APP_NAME` with explicit `use crate::cli::APP_NAME` after the re-export at the old crate root was removed).

The split itself is faithful to the PATTERNS extraction map: line ranges line up, visibility uses `pub(crate)` at the top level and `pub(super)` inside `desktop/`, and the brownfield "no behavior changes" exception is upheld — every behavioral defect I found also exists at the diff base (`efca399`). I therefore have **no BLOCKER findings** that are attributable to this phase.

The WARNINGs below describe quality issues that the split makes worse or that the new module boundaries newly expose. Several are pre-existing bugs that were previously masked by single-file proximity — I am surfacing them because Phase 1 is the natural moment to either fix them or document them, and the brownfield exception explicitly permits "no behavior changes" not "no awareness of defects in the moved code". The INFO items are split-mechanics observations (dead imports, drifting placeholders, dependency cycles between sibling modules).

The submitted code compiles, preserves the documented module dependency order, keeps the 8-line `#![allow(...)]` baseline on every `desktop/*.rs` file per PATTERNS Pattern B, and correctly anchors `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` on line 1 of the new minimal `src/main.rs` (PATTERNS Pitfall 3). All seven moved unit tests are intact in their new module homes (`io.rs`, `export.rs`, `scan.rs`).

## Warnings

### WR-01: `paint_window` BitBlt of uninitialized bitmap when `with_state_mut` returns `None`

**File:** `src/desktop/paint.rs:67-102` (specifically lines 86-92)
**Issue:** `paint_window` creates `mem_dc` + `mem_bmp`, then calls `with_state_mut(|state| { fill_rect(...); draw_toolbar_background(...); draw_table(...); })`. Per `state.rs:107-115` `with_state_mut` uses `try_lock` and silently returns `None` if the lock is contended (e.g. another window-proc message is mid-handler on the same thread). When that happens, the closure is **never executed** but the `BitBlt(hdc, ..., mem_dc, ..., SRCCOPY)` call on line 92 still copies the freshly-created (uninitialized) `mem_bmp` contents to the screen. `CreateCompatibleBitmap` returns a bitmap with undefined memory; the user sees garbage pixels for one frame. This is pre-existing (`try_lock` semantics existed before the split — see `git show efca399:src/main.rs | grep try_lock`) but the Phase 1 split makes it harder to spot because `with_state_mut`, `paint_window`, and the rationale comment now live in three different files.

**Fix:** Either (a) skip BitBlt when the closure didn't run, or (b) fill the bitmap before invoking the closure. Minimal fix:

```rust
let painted = with_state_mut(|state| {
    fill_rect(mem_dc, rect, palette_bg(state));
    draw_toolbar_background(mem_dc, rect, state);
    draw_table(mem_dc, rect, state);
}).is_some();
if painted {
    BitBlt(hdc, 0, 0, width, height, mem_dc, 0, 0, SRCCOPY);
}
```

This preserves brownfield behavior on the happy path while preventing the corruption frame on contention.

---

### WR-02: `with_state_mut` silently drops user actions on lock contention

**File:** `src/desktop/state.rs:105-116`
**Issue:** Every interactive handler in `desktop/mod.rs` and `desktop/shell.rs` wraps state access in `with_state_mut(...)` and treats `None` as a no-op. For `start_scan_from_controls` (mod.rs:742-822), `expand_all_directories` (940-958), `collapse_to_root` (960-970), `toggle_path_column` (972-986), `choose_and_set_directory` (988-996), `stop_current_scan` (915-928), and the right-click menu actions (mod.rs:248-365), a `try_lock` failure silently swallows the user's click — the button "does nothing" with no log, no status update, no visual feedback. The split surfaces this by spreading the same pattern across four files (mod.rs, paint.rs, shell.rs, state.rs); previously every caller was on the same screen of code as the comment explaining the trade-off. Pre-existing.

**Fix:** The comment at state.rs:107-115 says the caller should "gracefully skip non-critical work" — but user actions are NOT non-critical work. Recommend: change `with_state_mut` to take an optional `&'static str` action label and `eprintln!` (or post a status message) when the lock is contended; or introduce a second helper `with_state_mut_blocking` that uses `.lock()` and is only safe to call from non-reentrant entry points (button-handler arms of `WM_COMMAND` are non-reentrant — Win32 dispatches commands serially on the UI thread). Both are out of scope for Phase 1 but should be a Phase-2 follow-up.

---

### WR-03: `paint.rs::fill_rect` allocates and frees a brush per call

**File:** `src/desktop/paint.rs:644-648`
**Issue:** `fill_rect` calls `CreateSolidBrush` on every invocation and `DeleteObject` immediately after. The function is called dozens of times per frame from `draw_row`, `draw_header`, `draw_name_cell`, `draw_percent_cell`, `draw_toolbar_background` (16 fill_rect calls per row × visible row count + per-cell borders). Each `CreateSolidBrush` is a GDI handle allocation. This is pre-existing — but the split into `paint.rs` makes it the obvious candidate for a brush cache colocated with `DARK_BRUSH` / `LIGHT_BRUSH` in `theme.rs`. Performance is explicitly out of v1 scope, so flagging only as a quality note: the new module boundary makes the fix easier to land in a future phase.

**Fix:** No change required in Phase 1. Future: add a small `HashMap<Dword, Hbrush>` cache in `theme.rs` keyed by RGB color and reuse brushes across the frame; brushes can be destroyed once at `WM_DESTROY` alongside `destroy_cached_icons`.

---

### WR-04: `desktop/mod.rs` uses `use crate::model::*;` wildcard import

**File:** `src/desktop/mod.rs:26`
**Issue:** `use crate::model::*;` is a wildcard import. PATTERNS Pattern B (line 314) explicitly says to replace the old `use super::*;` with **explicit** imports (`use crate::model::{NodeRecord, ScanOptions, ScanResult}`), citing CONTEXT "Established Patterns" line 87. The wildcard form pulls 11 types (`ScanOptions`, `NodeRecord`, `ScanError`, `ScanResult`, `QueueState`, `WorkerShared`, `AppState`, `HttpRequest`, `ExtensionStat`, `AgeBucket`, `DuplicateCandidate`) into the desktop namespace, of which `desktop/mod.rs` actually uses only `ScanOptions`, `ScanResult`, and `NodeRecord` (indirectly via `Arc<ScanResult>` and `scan.nodes`). The wildcard masks future accidental dependencies — e.g. someone adds `pub(crate) struct ApiToken` to `model.rs` and now `desktop/mod.rs` can reach it silently.

**Fix:** Replace line 26 with an explicit list:

```rust
use crate::model::{NodeRecord, ScanOptions, ScanResult};
```

The `#![allow(dead_code)]` at the top of mod.rs (line 1) suppresses Rust's unused-import warning, which is why this slipped through; tightening the import is independent of removing the allow.

---

### WR-05: `paint.rs` and `shell.rs` use `use super::ffi::*` / `use super::theme::*` wildcards

**File:** `src/desktop/paint.rs:12-19`, `src/desktop/shell.rs:15-23`, `src/desktop/theme.rs:16-18` (via direct import — not the offender), `src/desktop/mod.rs:32` (`use ffi::*;`), `src/desktop/mod.rs:36` (`use paint::*;`)
**Issue:** Same root cause as WR-04, applied to `ffi` and `paint`. The `ffi` module exports ~80 type aliases, ~90 const, and ~50 `extern "system"` fn declarations, all `pub(super)`. `use ffi::*;` in mod.rs (line 32) and `use super::ffi::*;` references in submodules pull every symbol into scope, defeating the goal of the split (knowing which submodule depends on which Win32 surface). PATTERNS Pitfall 5 (line 344) explicitly allows blanket `pub(super)` on every ffi item but says nothing about wildcard *imports* — those defeat the readability benefit of the per-file boundary. Pre-existing equivalent: the old `mod desktop` had access to all Win32 symbols by virtue of being a single block, so there was no improvement to lose.

**Fix:** No change required to ship Phase 1. Future: convert each `use super::ffi::*;` to an explicit list (it will be 20-40 names per file but `cargo check` will tell you exactly which). The cleanup is a natural Phase-2 task that gives the split its full readability dividend.

---

### WR-06: `desktop/tabs.rs` and `desktop/treemap.rs` placeholder doc comments do not match PATTERNS-prescribed text

**File:** `src/desktop/tabs.rs:1`, `src/desktop/treemap.rs:1`
**Issue:** PATTERNS Pattern F (line 611-615) prescribes a specific doc comment for each placeholder:

- `tabs.rs`: `"//! Toolbar tab strip rendering and click dispatch.\n//! Empty in Phase 1; populated in Phase 8 (alongside per-tab content panels)."`
- `treemap.rs`: `"//! Native-desktop treemap rendering. Empty in Phase 1; populated in Phase 8 (VIZ-01)."`

The actual files contain:

- `tabs.rs:1`: `"// Placeholder: tab-specific render logic will be extracted here in a future phase."`
- `treemap.rs:1`: `"// Placeholder: treemap tile rendering will be extracted here in a future phase."`

Both use `//` (line comment) instead of `//!` (inner doc comment), and neither cites the target phase. PATTERNS also notes (line 240) that `//!` is the form validated against `cargo clippy --all-targets -- -D warnings`. The `//` form happens to also pass clippy because the files contain no items, but it is a deviation from the agreed pattern and loses the future-phase reference for grep-driven phase planning.

**Fix:** Replace each placeholder file with the exact text from PATTERNS Pattern F:

```rust
// src/desktop/tabs.rs
//! Toolbar tab strip rendering and click dispatch.
//! Empty in Phase 1; populated in Phase 8 (alongside per-tab content panels).
```

```rust
// src/desktop/treemap.rs
//! Native-desktop treemap rendering. Empty in Phase 1; populated in Phase 8 (VIZ-01).
```

Also update `src/diff.rs:1` from `"//! Snapshot diff — reserved for Phase 7."` to PATTERNS-prescribed `"//! Snapshot diff. Empty in Phase 1; populated in Phase 7 (SNAP-04..07)."` for consistency.

---

## Info

### IN-01: `desktop/shell.rs::destroy_icons_on_shutdown` is dead code

**File:** `src/desktop/shell.rs:249`
**Issue:** `pub(super) unsafe fn destroy_icons_on_shutdown(_hwnd: Hwnd) {}` — empty body, unused. `#![allow(dead_code)]` at line 1 suppresses the warning. The actual icon destruction logic lives in `desktop/mod.rs:930-938` (`destroy_cached_icons`). This dead stub is a leftover from the split.

**Fix:** Delete the function. If it was preserved on purpose as a future API placeholder, add a `//! TODO` comment explaining what it will do; otherwise removing it tightens the public surface.

---

### IN-02: `desktop/mod.rs::create_controls` sets `state.list = 0` but `list: Hwnd` field is never used

**File:** `src/desktop/mod.rs:543`, `src/desktop/state.rs:38`
**Issue:** `state.list = 0;` is set in `create_controls` and never read or written elsewhere; the `pub(super) list: Hwnd` field in `DesktopState` (state.rs:38) is initialized to 0 in `DesktopState::new` and never touched again. Pre-existing dead field carried over verbatim from the original `mod desktop` (which is move-only correct), but Phase 1 is the natural moment to drop unused state fields rather than carry them into the split.

**Fix:** Remove the `list` field from `DesktopState` and the `state.list = 0;` line in `create_controls`. No behavior change.

---

### IN-03: `desktop/state.rs` imports `Hicon` but only uses it as a field type, no direct calls

**File:** `src/desktop/state.rs:18`
**Issue:** `use super::ffi::{Hfont, Hicon, Hwnd};` — all three are used as field types only (`pub(super) icon_cache: HashMap<String, Hicon>` etc.). Not a defect; verifying that the explicit import strategy (correctly preferred over the wildcard form flagged in WR-04 / WR-05) is being followed in this file.

**Fix:** No change required. Mentioned only to contrast with WR-04 / WR-05 — `state.rs` got the explicit pattern right; `mod.rs` and `paint.rs` did not.

---

### IN-04: Sibling-module cycle between `cli` and `server`

**File:** `src/cli.rs:13`, `src/server.rs:11`
**Issue:** `cli` imports `crate::server::run_server` (cli.rs:13); `server` imports `crate::cli::APP_NAME` (server.rs:11). This is a logical cycle between sibling top-level modules. Rust handles this fine — the cycle is between data and function, not types, and the compiler resolves cross-module names at the crate level. But it creates a future hazard: if `server.rs` ever needs to call back into anything `cli`-shaped (e.g. for a `--help` route), the cycle deepens. The clean fix is to lift `APP_NAME` and `APP_VERSION` into `src/main.rs` or a new tiny `src/meta.rs` module that both `cli` and `server` import, breaking the dependency arrow. Pre-existing per PATTERNS line 190 which explicitly forecast this.

**Fix:** No change required for Phase 1. Future: introduce `src/meta.rs` containing only `pub(crate) const APP_NAME` and `pub(crate) const APP_VERSION`, and update `cli.rs` / `server.rs` / `export.rs` / `desktop/mod.rs` to import from `crate::meta`.

---

### IN-05: Mojibake in retained translation-of-comment characters

**File:** `src/desktop/mod.rs:393` ("Must NOT acquire the STATE mutex here Ã¢â‚¬â€ this message..."), `src/desktop/mod.rs:788` ("Win32 calls OUTSIDE the mutex Ã¢â‚¬â€ safe from deadlock."), `src/desktop/mod.rs:902` (same)
**Issue:** Three comments contain `Ã¢â‚¬â€` — the UTF-8 byte sequence `E2 80 94` (em dash, `—`) decoded as Windows-1252 then re-encoded as UTF-8. This is mojibake from a text-editor round-trip during the move. The original source at the diff base uses a real em dash (verifiable via `git show efca399:src/main.rs | grep -n "Must NOT acquire"`). The comments are still legible but render as garbage in non-UTF-8 viewers and are inconsistent with the rest of the codebase.

**Fix:** Replace all three `Ã¢â‚¬â€` occurrences with `—` (em dash, U+2014) or with `--` (ASCII) if the project prefers ASCII-only comments. `.gitattributes` line-ending normalization is unlikely to be the cause; check the editor's "Reopen with encoding" setting before re-saving.

---

_Reviewed: 2026-05-23_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
