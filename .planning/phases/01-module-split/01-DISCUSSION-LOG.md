# Phase 1: Module Split - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-22
**Phase:** 1-module-split
**Areas discussed:** desktop/ submodule layout, Commit granularity

---

## Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| desktop/ submodule layout | One file vs coarse vs fine split of the ~1300-line inline `mod desktop` | ✓ |
| Rename vs move-only | Pure file move vs rename to module-qualified style | |
| diff module — stub now or defer | Empty stub in Phase 1 vs create in Phase 7 | |
| Commit granularity | Atomic / per-module / two-phase / per-submodule | ✓ |

---

## desktop/ submodule layout

### Split granularity

| Option | Description | Selected |
|--------|-------------|----------|
| Single desktop/mod.rs | Move inline `mod desktop` unchanged; file stays ~1300+ lines | |
| Coarse split (3-4 files) | desktop/{mod, ffi, state, paint}.rs | |
| Fine split (6-8 files) | desktop/{mod, ffi, state, paint, shell, tabs, treemap, theme}.rs | ✓ |
| Your call — propose a layout | Claude reads code and proposes a split | |

**User's choice:** Fine split (6-8 files)

### What lives in desktop/mod.rs

| Option | Description | Selected |
|--------|-------------|----------|
| Lean facade | Only `pub fn run()`, module declarations, class registration | |
| Facade + shared types | Facade plus shared types/constants used by 2+ submodules | |
| Facade + window_proc | Facade plus `window_proc` as the dispatch hub | ✓ |

**User's choice:** Facade + window_proc dispatcher in mod.rs; each WM_* arm calls into the owning submodule.

### Globals placement

| Option | Description | Selected |
|--------|-------------|----------|
| All in state.rs | STATE, brushes, dark-mode atomic all together | |
| Split by concern | STATE + with_state_mut in state.rs; brushes + DARK_MODE_ATOMIC in theme.rs | ✓ |
| All in mod.rs | All globals at the desktop crate root, accessed via super:: | |

**User's choice:** Split by concern — theming brushes belong with dark-mode logic.

### desktop/ffi.rs scope

| Option | Description | Selected |
|--------|-------------|----------|
| Raw bindings only | `extern "system"`, type aliases, Win32 constants; unsafe stays at call sites | ✓ |
| Raw + thin safe wrappers | Raw bindings plus helpers like `wide_string` or HwndExt traits | |
| Split: ffi/ subdirectory | One file per DLL (user32.rs, gdi.rs, shell.rs, com.rs, kernel.rs) | |

**User's choice:** Raw bindings only — no safe wrappers in this file; defer DLL-level split until churn justifies it.

---

## Commit granularity

### Commit strategy

| Option | Description | Selected |
|--------|-------------|----------|
| One atomic commit | Single ~5000-line refactor commit | |
| Per top-level module | ~8 commits, one per extracted module | |
| Two-phase: non-desktop, then desktop | 2 commits total | |
| Per module + per desktop submodule | ~15 commits, finest bisect granularity | ✓ |

**User's choice:** Per top-level module + per desktop submodule (~15 commits total).
**Notes:** Maximum `git bisect` granularity is the explicit motivation.

### Per-commit invariant

| Option | Description | Selected |
|--------|-------------|----------|
| Build only | `cargo build` per commit; fmt/clippy/smoke at end | |
| Build + fmt + clippy | Matches CI gate; manual smoke at end | ✓ |
| Full gate every commit | Build + fmt + clippy + smoke per commit | |

**User's choice:** Build + fmt + clippy clean on every commit (matches `.github/workflows/ci.yml` line 22). Manual desktop/serve/scan smoke test runs once at phase end.

### Extraction order

| Option | Description | Selected |
|--------|-------------|----------|
| Bottom-up (leaves first) | model → io → scan → analytics → export → server → cli → diff → desktop/* | ✓ |
| Top-down (entry points first) | cli + server shells first, then walk into engine | |
| Planner's call | Planner picks order based on call graph | |

**User's choice:** Bottom-up — each commit only touches code whose dependencies have already been extracted.

---

## Claude's Discretion

- **Visibility / `pub` policy** — default `pub(crate)` for cross-module items, private otherwise; promote only when required.
- **Rename vs move-only** — default move-only (preserve current names) to keep diffs reviewable.
- **Platform `#[cfg(windows)]` boundaries** — internal `#[cfg(windows)]` gates inside flat `io.rs` rather than a `io::platform::windows` submodule.
- **`mod.rs` vs flat-file form** — directory + `mod.rs` for `desktop` (has submodules); flat `scan.rs`, `model.rs`, etc. for single-file modules.

## Deferred Ideas

- Renaming to module-qualified function names (e.g. `export::json::serialize`) — deferred to a post-functional polish pass.
- `io::platform::windows` submodule split — deferred until a non-Windows feature requires it.
- `src/lib.rs` extraction for testability — not in scope.
- Splitting `desktop/ffi.rs` by DLL — explicitly rejected for Phase 1.
