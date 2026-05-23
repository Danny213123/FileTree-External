# Phase 1: Module Split - Context

**Gathered:** 2026-05-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Split the single-file `src/main.rs` (~5055 lines plus an inline `mod desktop` of ~1300+ lines) into the locked module layout `cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/*` without changing any observable behavior. No new features, no behavior change, no new dependencies. v0.1.0 desktop / serve / scan modes must all behave identically after the split. This is the brownfield refactor exception called out in ROADMAP.md — it intentionally ships zero user-visible change and exists to unblock every later phase.

</domain>

<decisions>
## Implementation Decisions

### desktop/ submodule layout

- **D-01:** Fine split — `desktop/` becomes a directory with 8 files, not one big `desktop/mod.rs`. The inline `mod desktop` block is broken up along its natural seams.
- **D-02:** Target layout:
  - `desktop/mod.rs` — facade: `pub fn run()`, module declarations, top-level Win32 class registration, and `window_proc` itself as the dispatch hub. Each `WM_*` arm in `window_proc` calls into the submodule that owns that concern.
  - `desktop/ffi.rs` — raw bindings only: `extern "system"` declarations, `#[link(name=...)]` blocks, type aliases (`Hwnd`, `Hdc`, `Dword`, etc.), and Win32 constants (`WM_*`, `WS_*`, `FILE_ATTRIBUTE_*`). No safe wrappers in this file. `unsafe` call sites stay in the submodule that needs them.
  - `desktop/state.rs` — `DesktopState` struct, `STATE: OnceLock<Mutex<DesktopState>>`, and the `with_state_mut(|s| ...)` helper.
  - `desktop/theme.rs` — `DARK_BRUSH`, `LIGHT_BRUSH`, `DARK_MODE_ATOMIC`, and all dark-mode helpers. Theming brushes live with the dark-mode logic, not in `state.rs`.
  - `desktop/paint.rs` — `paint_window`, GDI double-buffering, row/tab rendering primitives.
  - `desktop/shell.rs` — `IShellFolder` / `IContextMenu` COM vtable usage, native shell-icon retrieval.
  - `desktop/tabs.rs` — Summary / Extensions / Top files / Duplicates / Errors tab rendering.
  - `desktop/treemap.rs` — treemap tile layout and tile rendering.

### Commit granularity & per-commit gate

- **D-03:** Per-module + per-desktop-submodule commits (~15 commits total). One commit per top-level module extracted, then one commit per `desktop/{ffi,state,theme,paint,shell,tabs,treemap}.rs` extraction. Maximum bisect granularity is the explicit goal — if a later phase finds a regression introduced by the split, `git bisect` lands on the specific submodule that broke it.
- **D-04:** Every individual commit must pass `cargo build`, `cargo fmt --check`, and `cargo clippy --all-targets -- -D warnings` (matches the CI gate from `.github/workflows/ci.yml:22`). Manual desktop/serve/scan smoke test happens once at the end of the phase, not per-commit.
- **D-05:** Extraction order is bottom-up (leaves first), then up the dependency chain:
  1. `model` (NodeRecord, ScanOptions, ScanResult, ScanError) — pure data, no dependencies on other modules
  2. `io` (platform helpers: `is_hidden_entry`, `platform_allocated_size`, `windows_compressed_file_size`)
  3. `scan` (worker_loop, scan_directory_job, aggregate_nodes, WorkerShared, QueueState)
  4. `analytics` (extension_stats, age_stats, duplicate_candidates, top_file_ids, largest_dir_ids, fnv1a_file)
  5. `export` (scan_result_to_json, scan_result_to_csv, exact_duplicates_json, push_json_string, push_csv_field)
  6. `server` (run_server, handle_client, AppState, respond_* helpers)
  7. `cli` (main argv parsing, print_usage, run_scan_command, run_server entry, run_desktop entry)
  8. `diff` — empty stub committed in Phase 1 to lock the module name; real implementation lands in Phase 7
  9. `desktop` extracted in 8 sub-commits in this order: `state.rs`, `ffi.rs`, `theme.rs`, `paint.rs`, `shell.rs`, `tabs.rs`, `treemap.rs`, then `mod.rs` becomes the lean facade + `window_proc` dispatcher
- **D-06:** Rationale for bottom-up: each commit only touches code whose dependencies have already been extracted, so the diff per commit stays small and `cargo build` stays green throughout. Top-down would force entry-point modules to reach back into still-inline code, inflating every commit.

### Claude's Discretion

- **Visibility / `pub` policy** — not explicitly decided. Default to `pub(crate)` for items used across modules and private otherwise; promote to `pub(super)` or selective `pub` only where required. No `pub` on items that don't cross module boundaries.
- **Rename vs move-only** — not explicitly decided. Default to move-only (preserve names like `scan_result_to_json`) to keep the diff reviewable. Renames to module-qualified form (e.g. `export::json::serialize`) can wait for a follow-up cleanup once the split is green.
- **Platform `#[cfg(windows)]` boundaries** — not explicitly decided. Default to gating the whole `desktop` module at the `cli::run_desktop` call site (matches current behavior) and keep `io` containing both cross-platform and Windows-only helpers via internal `#[cfg(windows)]` rather than a `io::platform::windows` submodule. Revisit if a non-Windows build breaks.
- **`mod.rs` vs `module-name.rs` convention** — Rust 2024 allows either. Use the directory form `desktop/mod.rs` for `desktop` (since it has submodules) and prefer the flat form `scan.rs`, `model.rs`, etc. for single-file modules. Promote to a directory if a module ever grows submodules.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & success criteria
- `.planning/ROADMAP.md` §"Phase 1: Module Split" — locked module list (`cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/*`), success criteria (`cargo build` + `cargo fmt --check` + `cargo clippy -- -D warnings` clean; smoke parity with v0.1.0; no new deps).
- `.planning/REQUIREMENTS.md` — REFAC-01 is the sole requirement mapped to this phase.

### Project-wide constraints
- `.planning/PROJECT.md` §Constraints + §"Key Decisions" — zero new Rust crates (`Cargo.toml [dependencies]` empty), single-`.exe` distribution, Win32 raw FFI only (no toolkit), web assets stay `include_str!`-embedded.
- `CLAUDE.md` — codebase rules and the GSD workflow enforcement notice.

### Codebase intel (refreshed 2026-05-22)
- `.planning/codebase/ARCHITECTURE.md` — component table mapping every function to its current line range in `src/main.rs`; primary reference for "where does X live today" lookups during extraction.
- `.planning/codebase/STRUCTURE.md` — current file layout (will be invalidated by this phase; regenerate at phase end).
- `.planning/codebase/CONVENTIONS.md` — naming patterns (`snake_case`, `push_*` for builders, `*_to_*` for serializers, `is_*`/`has_*`/`should_*` for predicates) that must be preserved through the move-only extractions.
- `.planning/codebase/STACK.md` — confirms zero-dependency Rust 2024 posture and Win32 DLL link list.

### CI gate
- `.github/workflows/ci.yml` line 22 — the exact `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` invocation each commit must satisfy.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Everything is reusable as-is — this is a move-only refactor. No function bodies are being rewritten.
- `ARCHITECTURE.md`'s component table is the extraction map: each row's `File` column line range identifies the contiguous block to lift into the new module.

### Established Patterns
- **Single-file flat module today.** All `use` declarations at the top, then types, then functions. The new module files preserve this internal ordering.
- **`mod desktop` already uses `use super::*;`** plus targeted `std` imports — the closest existing analog for how the new sibling modules should import their dependencies (prefer explicit `use crate::model::NodeRecord;` over `super::*` in the new files; `super::*` is a one-file convention that does not scale to a multi-module crate).
- **Module-level `#![allow(...)]` clippy escape hatches in `mod desktop`** for the Win32 non-idiomatic naming — these allows must travel with the desktop submodules (apply per-file in `ffi.rs`, `state.rs`, etc., not globally on the desktop crate root, so the surface stays narrow).
- **`push_*` builder pattern** (`push_json_string`, `push_csv_field`) — these stay in `export` along with the `*_to_*` consumers that drive them.

### Integration Points
- `src/main.rs` shrinks to a thin `mod` declaration list plus the `main()` entry. `main()` itself delegates to `cli::run()`.
- `src/lib.rs` is NOT introduced — this stays a single binary crate (`publish = false`, no `pub` exports), matching the existing posture.
- `include_str!("../web/index.html")` paths are referenced from `server` after extraction. The relative path stays `../web/...` because the `web/` directory is at the workspace root regardless of which source file the macro lives in.
- Cancel tokens (`Arc<AtomicBool>`) and progress message types (`WM_SCAN_PROGRESS`, `WM_SCAN_DONE` = `WM_APP+7`) cross the `desktop` ↔ `scan` boundary; they need a home that both can see. Put the message-ID constants in `desktop/ffi.rs` (desktop owns the Win32 namespace) and keep the `AtomicBool` cancel-token type as plain `std::sync::atomic::AtomicBool` (no wrapper needed) passed via `Arc`.

</code_context>

<specifics>
## Specific Ideas

- Per-commit gate must match the CI gate exactly (not weaker). The user wants `git bisect` over the split to land on a compiling, clippy-clean, fmt-clean commit every time.
- The 8-file desktop layout maps 1:1 to the sections labelled in `ARCHITECTURE.md`'s "Native Desktop Module" entry — FFI declarations, `DesktopState`, custom list rendering with GDI double-buffering, tabs, treemap tile rendering, Shell context menu via COM. Use those section labels as the file boundaries.
- `diff` is intentionally created in Phase 1 as an empty stub (`pub fn placeholder() {}` or similar) so the module name is locked. Phase 7 fills it in. This avoids a Phase-7 restructure of `src/lib.rs` semantics.

</specifics>

<deferred>
## Deferred Ideas

- **Rename to module-qualified function names** (e.g. `scan_result_to_json` → `export::json::serialize`) — explicitly deferred. Captured under Claude's Discretion as "move-only by default"; revisit as a Phase-8-or-later polish pass once all functional phases are green.
- **`io::platform::windows` submodule split** — deferred. Internal `#[cfg(windows)]` gates inside a flat `io.rs` are sufficient until a non-Windows feature actually lands.
- **`src/lib.rs` extraction for testability** — not in scope. Stays a single binary crate.
- **Splitting `desktop/ffi.rs` by DLL** (`ffi/user32.rs`, `ffi/gdi.rs`, etc.) — explicitly rejected for Phase 1. Revisit only if a later phase causes heavy FFI churn.

</deferred>

---

*Phase: 1-module-split*
*Context gathered: 2026-05-22*
