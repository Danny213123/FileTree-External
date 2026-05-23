# Phase 1: Module Split - Research

**Researched:** 2026-05-22
**Domain:** Rust 2024 mechanical refactor (single binary file → multi-module layout); Win32 FFI module boundary discipline
**Confidence:** HIGH

## Summary

Phase 1 is a pure mechanical extraction of `src/main.rs` (5055 lines, including a 3033-line inline `mod desktop` at lines 1767-4799 and a 254-line `mod tests` at lines 4800-5054) into the locked layout `cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/{mod,ffi,state,theme,paint,shell,tabs,treemap}.rs`. All decisions about layout, extraction order, commit granularity, and per-commit CI gate are locked in CONTEXT.md (D-01..D-06).

Three findings change the per-commit plan in ways the planner needs to know up front: (1) the current desktop UI has **no per-tab content panels and no native treemap** — `desktop/tabs.rs` and `desktop/treemap.rs` are mostly empty stubs in Phase 1 with only the toolbar-ribbon-tab dispatch in `tabs.rs`; (2) the existing `mod tests` block exercises only `scan` / `export` / `io` symbols and contains no desktop tests — it moves cleanly into `tests` modules colocated with the symbols under test; (3) the inline `mod desktop` reaches `super::*` but in practice only references `reveal_path` explicitly (line 2697), plus implicit reach via top-level types — meaning a clean `use crate::{model::*, scan::*, io::reveal_path};` header replaces `use super::*;` per submodule.

**Primary recommendation:** Execute the 15-commit bottom-up extraction exactly as ordered in CONTEXT D-05. Treat `desktop/tabs.rs` and `desktop/treemap.rs` as **lock-the-name placeholder files** in Phase 1 (same posture as `diff`). Every commit must pass the three-command CI gate; manual smoke test runs once at phase end as the final BLOCKING task.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Argv parsing & mode dispatch | `cli` | — | Entry point owns dispatch; calls into other modules |
| Filesystem BFS scan engine | `scan` | `io` (platform helpers), `model` (types) | Pure compute; platform-agnostic for the BFS itself |
| Win32 platform helpers (hidden, allocated size) | `io` | — | Internal `#[cfg(windows)]` gates per CONTEXT default; no `io::platform::windows` split (deferred) |
| HTTP/1.1 server + routes | `server` | `scan`, `analytics`, `export` | Owns TCP, request parsing, route dispatch; embeds `INDEX_HTML`/`APP_CSS`/`APP_JS` |
| JSON / CSV / duplicates serialization | `export` | `model` | Hand-built builders (`push_*`) + drivers (`*_to_*`) stay together |
| Analytics (extension stats, age, dup candidates, top-N) | `analytics` | `model` | Pure compute over `&[NodeRecord]`; no I/O |
| Pure data types | `model` | — | `NodeRecord`, `ScanOptions`, `ScanResult`, `ScanError`, `WorkerShared`, `QueueState`, `AppState`, `HttpRequest`, `ExtensionStat`, `AgeBucket`, `DuplicateCandidate` |
| Snapshot diff (future) | `diff` | — | Empty stub in Phase 1; filled in Phase 7 |
| Win32 window / message loop / paint / COM | `desktop/*` | `scan`, `io::reveal_path` | Windows-only `#[cfg(windows)]` at module declaration site |

[VERIFIED: src/main.rs line ranges via Grep] [CITED: CONTEXT.md D-01..D-06]

## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 (Fine desktop split):** `desktop/` is a directory with 8 files, not one monolith.

**D-02 (Target layout):**
- `desktop/mod.rs` — facade: `pub fn run()`, module declarations, top-level Win32 class registration, and `window_proc` itself as the dispatch hub. Each `WM_*` arm in `window_proc` calls into the submodule that owns that concern.
- `desktop/ffi.rs` — raw bindings only: `extern "system"` declarations, `#[link(name=...)]` blocks, type aliases (`Hwnd`, `Hdc`, `Dword`, etc.), and Win32 constants (`WM_*`, `WS_*`, `FILE_ATTRIBUTE_*`). No safe wrappers in this file. `unsafe` call sites stay in the submodule that needs them.
- `desktop/state.rs` — `DesktopState` struct, `STATE: OnceLock<Mutex<DesktopState>>`, and the `with_state_mut(|s| ...)` helper.
- `desktop/theme.rs` — `DARK_BRUSH`, `LIGHT_BRUSH`, `DARK_MODE_ATOMIC`, and all dark-mode helpers including all `palette_*` functions.
- `desktop/paint.rs` — `paint_window`, GDI double-buffering, row/header/cell rendering primitives.
- `desktop/shell.rs` — `IShellFolder` / `IContextMenu` COM vtable usage, native shell-icon retrieval, clipboard.
- `desktop/tabs.rs` — toolbar ribbon tab dispatch (see Open Questions Q1).
- `desktop/treemap.rs` — empty placeholder file in Phase 1; native treemap code lands in Phase 8.

**D-03:** Per-module + per-desktop-submodule commits (~15 commits total). Maximum bisect granularity.

**D-04:** Every individual commit passes `cargo build` + `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` (matches `.github/workflows/ci.yml` lines 21-25). Manual smoke test happens once at the end of the phase.

**D-05:** Bottom-up extraction order: `model` → `io` → `scan` → `analytics` → `export` → `server` → `cli` → `diff` stub → desktop submodules in order `state` → `ffi` → `theme` → `paint` → `shell` → `tabs` → `treemap` → `mod`.

**D-06:** Bottom-up rationale: each commit only touches code whose dependencies have already been extracted.

### Claude's Discretion

- **Visibility / `pub` policy:** Default `pub(crate)` for cross-module items, private otherwise; `pub(super)` only where needed. No bare `pub`. (See §"`pub(crate)` Visibility Matrix" below for the concrete recommendation.)
- **Rename vs move-only:** Move-only. Preserve all existing names (`scan_result_to_json`, `push_json_string`, etc.).
- **Platform `#[cfg(windows)]` boundaries:** Gate the whole `desktop` module at the `cli::run_desktop` call site. `io` contains both cross-platform and Windows-only helpers via internal `#[cfg(windows)]` rather than a `io::platform::windows` submodule.
- **`mod.rs` vs `module-name.rs` convention:** Directory form `desktop/mod.rs`. Flat form `scan.rs`, `model.rs`, etc. for single-file modules.

### Deferred Ideas (OUT OF SCOPE)

- Rename to module-qualified function names (`scan_result_to_json` → `export::json::serialize`) — deferred.
- `io::platform::windows` submodule split — deferred.
- `src/lib.rs` extraction for testability — not in scope.
- Splitting `desktop/ffi.rs` by DLL — explicitly rejected for Phase 1.

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REFAC-01 | Split `src/main.rs` into modules (`cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/*`) without behavior change; `cargo build`, `cargo fmt --check`, `cargo clippy -D warnings`, and existing smoke test all pass | This entire document. Concrete extraction map in §"Extraction Map (line-range → file)"; per-commit invariants in §"Per-Commit Green-Build Invariants"; smoke checklist in §"Smoke-Test Recipe". |

## Project Constraints (from CLAUDE.md)

- **Zero external Rust crates.** `Cargo.toml [dependencies]` stays empty. [VERIFIED: read Cargo.toml — `[dependencies]` is present and empty as of HEAD]
- **Win32 raw FFI only.** No GUI toolkit. Existing `#[link(name=...)]` blocks for `User32`, `Gdi32`, `Shell32`, `Comctl32`, `Dwmapi`, `Ole32`, `UxTheme`, `Kernel32` migrate into `desktop/ffi.rs` and `io` (Kernel32 for `GetCompressedFileSizeW`).
- **Web assets embedded via `include_str!`.** Three constants `INDEX_HTML`, `APP_CSS`, `APP_JS` at `src/main.rs:17-19` move into `server` module. [VERIFIED: src/main.rs:17-19]
- **GSD workflow enforcement.** No direct repo edits outside a GSD command — Phase 1 plans execute via `/gsd-execute-phase`.
- **Single binary crate.** No `src/lib.rs`. `publish = false`. No `pub` exports from the crate root.
- **Rustfmt + clippy defaults.** CI runs `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` on every push and PR. [VERIFIED: .github/workflows/ci.yml lines 21-25]

## Extraction Map (line-range → file)

Source-of-truth for which existing `src/main.rs` line ranges land in which new file. Line numbers are based on HEAD (5055 lines). [VERIFIED: Grep against src/main.rs]

### Top-level modules

| New file | Source lines | Contents |
|----------|--------------|----------|
| `src/model.rs` | 21-118 | `ScanOptions`, `NodeRecord`, `ScanError`, `ScanResult`, `QueueState`, `WorkerShared`, `AppState`, `HttpRequest`, `ExtensionStat`, `AgeBucket`, `DuplicateCandidate` |
| `src/io.rs` | 1497-1735 | `reveal_path`, `open_path`, `display_name`, `path_to_string`, `extension_for`, `metadata_modified_ms`, `now_ms`, `current_dir_or_dot`, `default_thread_count`, `option_value`, `has_flag`, `first_positional_arg`, `parse_bool`, `split_patterns`, `should_recurse`, `should_exclude`, `pattern_matches`, `wildcard_match`, `is_hidden_entry` (×2 cfg), `platform_allocated_size` (×2 cfg), `windows_compressed_file_size`, `epoch_ms_to_utc`, `civil_from_days` |
| `src/scan.rs` | 268-671 | `scan_path`, `scan_path_with_progress`, `snapshot_scan_result`, `ActiveGuard` + `Drop`, `worker_loop`, `scan_directory_job`, `metadata_for_entry`, `add_node`, `add_scan_error`, `aggregate_nodes` |
| `src/analytics.rs` | 1242-1451 | `exact_duplicates_json`, `fnv1a_file`, `top_file_ids`, `largest_dir_ids`, `extension_stats`, `age_stats`, `duplicate_candidates` |
| `src/export.rs` | 996-1240, 1453-1495 | `scan_result_to_json`, `scan_result_to_csv`, `app_config_json`, `drives_json`, `push_id_array`, `push_json_string`, `push_csv_field` |
| `src/server.rs` | 17-19, 241-994 | `INDEX_HTML`/`APP_CSS`/`APP_JS` constants (paths stay `../web/...` — see §"`include_str!` Path Audit"); `run_server`, `handle_client`, `read_http_request`, `respond_text`, `respond_json`, `respond_bytes`, `split_target`, `percent_decode`, `hex_value` |
| `src/cli.rs` | 15-16, 120-239 | `APP_NAME`, `APP_VERSION` constants; `run` (extracted from `main`), `print_usage`, `run_desktop`, `run_scan_command` |
| `src/diff.rs` | — | Empty stub: file-level doc comment + nothing else (or `pub(crate) fn placeholder() {}` if zero items trips clippy `dead_code` — verify during the diff-stub commit) |
| `src/main.rs` | new content | `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`, `mod cli; mod model; mod io; mod scan; mod analytics; mod export; mod server; mod diff; #[cfg(windows)] mod desktop; fn main() { cli::run() }` — roughly 15 lines |

### Desktop submodules (lines 1767-4799 are the inline `mod desktop` body)

| New file | Source lines (within mod desktop) | Contents |
|----------|-----------------------------------|----------|
| `src/desktop/state.rs` | 2379-2460, 4743-4754, 2413-2422 | `DesktopState` struct, `DesktopState::new`, `STATE: OnceLock<Mutex<DesktopState>>`, `with_state_mut<T>(...)`, plus `ScanDone` and `ScanProgressInfo` boxed-payload structs (used by both `scan` thread and `window_proc` — central enough to live here, not in `paint.rs`) |
| `src/desktop/ffi.rs` | 1785-1995, 1996-2196, 2197-2378 | All type aliases (`Bool`, `Dword`, `Hbrush`, `Hcursor`, `Hdc`, `Hfont`, `Hicon`, `Hinstance`, `Hmenu`, `Hgdobj`, `Hwnd`, `Lparam`, `Lresult`, `Uint`, `Wparam`, `Handle`, `UlongPtr`); all `#[repr(C)]` structs (`ACTCTXW`, `Rect`, `Point`, `PAINTSTRUCT`, `Msg`, `WndClassExW`, `BITMAPINFO`, `BITMAPINFOHEADER`, `GUID`, `ITEMIDLIST`, `CMINVOKECOMMANDINFO`, `IUnknownVtbl`, `IShellFolderVtbl`, `IContextMenuVtbl`); ALL `const`s (`WM_*`, `WS_*`, `CS_*`, `DT_*`, `FILE_ATTRIBUTE_*`, `BS_*`, `IDC_*`, `IDI_*`, `SHGFI_*`, `MB_*`, `LR_*`, `SW_*`, `TRANSPARENT`, `WM_APP`, `WM_SCAN_DONE = WM_APP + 7`, `WM_SCAN_PROGRESS = WM_APP + 8`, `TPM_RETURNCMD`, `COINIT_APARTMENTTHREADED`, `BM_GETCHECK`, `ID_SCAN_BUTTON`..`ID_DARK_CHECK`, `ID_MENU_*`); all eight `#[link(name="...")]  unsafe extern "system"` blocks; `IID_IShellFolder`, `IID_IContextMenu` GUIDs |
| `src/desktop/theme.rs` | 1921-1923, 3496-3552, 4542-4656 | `DARK_BRUSH`, `LIGHT_BRUSH`, `DARK_MODE_ATOMIC`, `apply_theme`, `update_column_widths`, `set_window_dark_mode`, `dark_brush`, `light_brush`, all `palette_*` functions (`palette_bg`, `palette_panel`, `palette_table`, `palette_table_alt`, `palette_header`, `palette_line`, `palette_grid`, `palette_text`, `palette_muted`, `palette_selected`, `palette_hovered`, `palette_size_bar`, `palette_percent_track`, `palette_percent_fill`), `rgb` helper if separate |
| `src/desktop/paint.rs` | 3554-4129, 4503-4519, 4756-4798 | `paint_window`, `draw_toolbar_background`, `draw_table`, `draw_header`, `draw_row`, `draw_name_cell`, `draw_percent_cell`, `fill_rect`, `draw_text`, `table_top`, `columns`, `loword_signed`, `hiword_signed`, `wide`, `format_bytes_ui`, `format_count_ui`, `format_duration_ui` (UI-only formatters used only inside desktop — keep in `paint.rs` since `paint.rs` is the dominant consumer; or split into a `desktop/format.rs` if planner prefers — flagged in Open Questions Q2) |
| `src/desktop/shell.rs` | 2462-2494, 3458-3494, 4209-4302, 4394-4428 | `enable_visual_styles`, `icon_for_node` (Shell32 `SHGetFileInfoW`), `show_shell_context_menu` (IShellFolder/IContextMenu COM dance), `copy_to_clipboard`, `show_error_in_thread`, icon-cache destruction logic |
| `src/desktop/tabs.rs` | The toolbar-tab portions of `draw_toolbar_background` (3592-3668), the tab-click portion of `handle_mouse_click` (4135-4159), the per-tab control-visibility logic in `resize_controls` (3052-3149) | See §"Open Question Q1" — this file may justify pulling tab-strip logic out of `paint.rs`/`handle_mouse_click`/`resize_controls`, OR may be deferred as an empty file with a doc comment if extracting it bloats the commit beyond pure-move |
| `src/desktop/treemap.rs` | — | Empty placeholder file in Phase 1. Native desktop treemap is VIZ-01 in Phase 8. Same posture as `diff.rs`. Include a single doc comment: `//! Native-desktop treemap rendering. Empty in Phase 1; populated in Phase 8 (VIZ-01).` |
| `src/desktop/mod.rs` | 2496-2842, plus all `WM_COMMAND` ID dispatch handlers from window_proc, plus `create_controls` (2844-2994), `create_child` (2996-3021), `resize_controls` (3023-3166), `start_scan_from_controls` (3168-3253), `finish_scan` (3255-3313), `apply_scan_progress` (3315-3344), `stop_current_scan` (3346-3359), `destroy_cached_icons` (3361-3369), `expand_all_directories` (3371-3389), `collapse_to_root` (3391-3401), `toggle_path_column` (3403-3417), `choose_and_set_directory` (3419-3427), `browse_for_directory` (3429-3456), `handle_mouse_click` (4131-4207 — minus tab portion if extracted to `tabs.rs`), `handle_right_click` (4304-4392), `handle_mouse_wheel` (4430-4440), `handle_mouse_move` (4442-4463), `handle_key` (4465-4478), `move_selection` (4480-4496), `scroll_rows` (4498-4501), `render_list` (4658-4690), `collect_rows` (4692-4719), `button_checked` (4721-4723), `get_window_text` (4725-4730), `set_window_text` (4732-4735), `show_error` (4737-4741); also the all-important `pub fn run(initial_path: PathBuf) -> io::Result<()>` |

**Sizing note:** `desktop/mod.rs` is still the largest desktop file (~1500 lines) after the split, because `window_proc` + the scan-orchestration helpers + the control-creation/resize plumbing form one cohesive unit. The CONTEXT D-02 "facade" framing is met: `mod.rs` owns the message loop, window class, and dispatch; it delegates to `paint`, `shell`, `theme`, `state`. This sizing is acceptable — `mod.rs` doesn't need to be small to be a facade.

### Tests (`#[cfg(test)] mod tests`, lines 4800-5054)

Eight tests, all targeting `scan` / `export` / `io` / utility symbols. Zero tests targeting `desktop`. Move with the symbols they exercise.

| Test | Currently exercises | New home |
|------|---------------------|----------|
| `wildcard_supports_star_and_question` | `wildcard_match` | `src/io.rs` `#[cfg(test)] mod tests` |
| `csv_fields_are_escaped` | `push_csv_field` | `src/export.rs` `#[cfg(test)] mod tests` |
| `epoch_formats_unix_start` | `epoch_ms_to_utc` | `src/io.rs` `#[cfg(test)] mod tests` |
| `make_test_node` (helper) + `aggregate_nodes_sums_children_into_parent` | `aggregate_nodes`, `NodeRecord` | `src/scan.rs` `#[cfg(test)] mod tests` (helper goes with it) |
| `snapshot_result_has_correct_aggregation` | `snapshot_scan_result`, `WorkerShared` | `src/scan.rs` |
| `snapshot_releases_nodes_lock_before_aggregation` | `snapshot_scan_result` lock release | `src/scan.rs` |
| `active_guard_decrements_active_and_sets_done_when_empty` | `ActiveGuard` Drop | `src/scan.rs` |
| `active_guard_does_not_set_done_when_dirs_remain` | `ActiveGuard` Drop | `src/scan.rs` |
| `scan_path_with_progress_sends_partial_results` | `scan_path_with_progress` end-to-end | `src/scan.rs` |

`make_test_node` is shared between three tests — keep it inside the `src/scan.rs` test module since all three callers live there. [VERIFIED: src/main.rs:4800-5054]

## `pub(crate)` Visibility Matrix

Default policy from CONTEXT Discretion: `pub(crate)` for cross-module items, private otherwise. The matrix below enumerates every symbol that crosses a module boundary, based on the call-site Grep at lines 222, 269, 272, 386, 398, 758, 773, 790, 822, 829, 996, 1149, 1196, 1497, 1516, 1540, 1544, 1560, 1643, 1649, 1738, 2697, 2856, 3225, 4684-4687. Symbols not listed stay private to their module.

### `model`

All struct definitions need `pub(crate)` because they cross every boundary (scan creates them, export serializes them, server holds them, desktop displays them, analytics reads them).

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `ScanOptions` (struct + all fields) | `pub(crate)` | `cli`, `scan`, `server`, `desktop`, tests |
| `NodeRecord` (struct + all fields) | `pub(crate)` | every module |
| `ScanError` (struct + fields) | `pub(crate)` | `scan`, `export`, `server` |
| `ScanResult` (struct + all fields) | `pub(crate)` | every module |
| `QueueState` (struct + fields) | `pub(crate)` | `scan`, tests |
| `WorkerShared` (struct + fields) | `pub(crate)` | `scan`, tests (test code constructs it directly) |
| `AppState` (struct + fields) | `pub(crate)` | `server`, `export::app_config_json` |
| `HttpRequest` (struct + fields) | `pub(crate)` (or private to `server` if `read_http_request` is `pub(crate)` returning it) | `server` only — confirm during extraction |
| `ExtensionStat`, `AgeBucket`, `DuplicateCandidate` (struct + fields) | `pub(crate)` | `analytics` (constructors), `export` (consumers) |

### `io`

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `reveal_path` | `pub(crate)` | `server::handle_client` (line 822), `desktop` (line 2697) |
| `open_path` | `pub(crate)` | `server::handle_client` (line 829) |
| `display_name` | `pub(crate)` | `scan` (lines 296, 525) |
| `path_to_string` | `pub(crate)` | `scan` (lines 297, 526, 619), `export::app_config_json` (line 1196), `desktop` (line 2856) |
| `extension_for` | `pub(crate)` | `scan` (lines 317, 557) |
| `now_ms` | `pub(crate)` | `scan::scan_path_with_progress` (line 288), tests (line 5027) |
| `epoch_ms_to_utc` | `pub(crate)` | `export::scan_result_to_csv` (line 1180), `desktop::draw_row` (line 3888), tests (line 4820) |
| `wildcard_match` | `pub(crate)` | `pattern_matches` (line 1643), tests (lines 4806-4808). `pattern_matches` is itself called only by `should_exclude` — both stay in `io` together so `wildcard_match` is only `pub(crate)` for tests. |
| `should_exclude`, `should_recurse` | `pub(crate)` | `scan::scan_directory_job` |
| `default_thread_count` | `pub(crate)` | `cli::run_scan_command`, `server::run_server` |
| `current_dir_or_dot` | `pub(crate)` | `cli::main` argv parsing |
| `option_value`, `has_flag`, `first_positional_arg`, `parse_bool`, `split_patterns` | `pub(crate)` | `cli` argv helpers |
| `is_hidden_entry`, `platform_allocated_size` | `pub(crate)` | `scan::scan_directory_job` |
| `windows_compressed_file_size` | private to `io` | only `platform_allocated_size` calls it |
| `civil_from_days`, `metadata_modified_ms`, `hex_value` | private (move with their only callers) | `epoch_ms_to_utc` and `percent_decode` respectively |

### `scan`

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `scan_path` | `pub(crate)` | `cli::run_scan_command` (line 222 area), `server::handle_client` (line 753 area) |
| `scan_path_with_progress` | `pub(crate)` | `desktop::start_scan_from_controls` (line 3225), tests (line 5044) |
| `snapshot_scan_result` | `pub(crate)` for tests | tests (lines 4897, 4939); otherwise private. Mark `#[cfg_attr(not(test), allow(dead_code))]` only if clippy complains — first try plain `pub(crate)`. |
| `aggregate_nodes` | `pub(crate)` for tests | tests (line 4854); also called from `snapshot_scan_result` |
| `ActiveGuard` (struct + `shared` field) | `pub(crate)` for tests | tests construct it directly (lines 4971, 5012) |
| `worker_loop`, `scan_directory_job`, `add_node`, `add_scan_error`, `metadata_for_entry` | private to `scan` | only called by `scan_path_with_progress` chain |

### `analytics`

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `exact_duplicates_json` | `pub(crate)` | `server::handle_client` (`/api/duplicates` route) |
| `top_file_ids`, `largest_dir_ids`, `extension_stats`, `age_stats`, `duplicate_candidates` | `pub(crate)` | `export::scan_result_to_json` |
| `fnv1a_file` | private to `analytics` | only called by `exact_duplicates_json` |

### `export`

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `scan_result_to_json` | `pub(crate)` | `cli::run_scan_command` (line 223), `server::handle_client` (lines 758, 790) |
| `scan_result_to_csv` | `pub(crate)` | `cli::run_scan_command` (line 222), `server::handle_client` (line 773) |
| `app_config_json` | `pub(crate)` | `server::handle_client` (`/api/config` route) |
| `drives_json` | `pub(crate)` | `server::handle_client` (`/api/drives` route) |
| `push_json_string` | `pub(crate)` | `server::handle_client` error responder (CONVENTIONS.md line 75-81), `analytics::exact_duplicates_json` (internal) |
| `push_csv_field` | `pub(crate)` for tests | tests (line 4814); otherwise internal to `export` |
| `push_id_array` | private to `export` | only `scan_result_to_json` calls it |

### `server`

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `run_server` | `pub(crate)` | `cli::main` dispatch |
| `INDEX_HTML`, `APP_CSS`, `APP_JS` | private to `server` | only `handle_client` reads them |
| `handle_client`, `read_http_request`, `respond_*`, `split_target`, `percent_decode`, `hex_value` | private to `server` | internal |

### `cli`

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `run` (the extracted body of `main`) | `pub(crate)` | `main.rs::main()` calls `cli::run()` |
| `APP_NAME`, `APP_VERSION` | `pub(crate)` | desktop window title, server startup message |
| `print_usage`, `run_desktop`, `run_scan_command` | private to `cli` | internal dispatch |

### `desktop` (the public surface to the rest of the crate)

| Symbol | Visibility | Consumed by |
|--------|-----------|-------------|
| `desktop::run(PathBuf) -> io::Result<()>` | `pub(crate)` | `cli::run_desktop` (gated `#[cfg(windows)]`) |
| Everything else | `pub(super)` or private per submodule | internal to `desktop/*` |

### `desktop` submodule cross-boundary symbols (inside `desktop/`)

These need `pub(super)` so sibling submodules in `desktop/` can use them, but should NOT escape `desktop/`. The recommendation: top-line item-by-item per file, but bias toward `pub(super)` for shared helpers and `pub(in crate::desktop)` only if a planner finds an item needs to skip levels (unlikely given the flat submodule layout).

| Submodule | Items exposed as `pub(super)` |
|-----------|------------------------------|
| `desktop::ffi` | Every type alias and const that other submodules reference (effectively almost everything in the file) — easiest to just `pub(super)` the lot |
| `desktop::state` | `DesktopState` and all its fields (paint reads them, shell reads them); `STATE`; `with_state_mut`; `ScanDone`; `ScanProgressInfo` |
| `desktop::theme` | `DARK_MODE_ATOMIC` (window_proc reads it directly), `dark_brush`, `light_brush`, all `palette_*` (paint.rs consumes them), `apply_theme` (called from window_proc) |
| `desktop::paint` | `paint_window` (window_proc calls it), `table_top` (handle_mouse_click uses it), `loword_signed`/`hiword_signed`/`wide`/`fill_rect`/`draw_text` (used by shell + handlers), `format_bytes_ui`/`format_count_ui`/`format_duration_ui` (used by mod.rs status text and apply_scan_progress) |
| `desktop::shell` | `enable_visual_styles`, `icon_for_node`, `show_shell_context_menu`, `copy_to_clipboard`, `show_error_in_thread` |

[CITED: CONTEXT.md Discretion item "Visibility / `pub` policy"]

## Cross-Boundary Types: `scan` ↔ `desktop`

The scan ↔ desktop boundary is the trickiest interaction in the codebase because it crosses thread boundaries via a Win32 message post. [VERIFIED: src/main.rs:2399, 3225-3252, 4894 cancel-token call sites; 1911-1912 WM_SCAN_* constants]

| Item | Type | Owner module | Used by |
|------|------|--------------|---------|
| `cancel: Arc<AtomicBool>` | Plain `std::sync::atomic::AtomicBool` wrapped in `Arc` | Constructed in `desktop::mod.rs::start_scan_from_controls` (line 3219-area); stored in `DesktopState::current_cancel`; passed by value to `scan::scan_path_with_progress` | `scan::scan_path_with_progress` reads it on every BFS iteration via `cancel.load(Ordering::Relaxed)`; `desktop::stop_current_scan` (line 3346) sets it true. No wrapper type needed — plain `Arc<AtomicBool>`. CONTEXT confirms this. |
| `WM_SCAN_DONE = WM_APP + 7` | `Uint` const | `desktop/ffi.rs` (CONTEXT-locked: "Put the message-ID constants in `desktop/ffi.rs` — desktop owns the Win32 namespace") | `desktop/mod.rs::window_proc` matches on it; `desktop/mod.rs::start_scan_from_controls` posts it |
| `WM_SCAN_PROGRESS = WM_APP + 8` | `Uint` const | `desktop/ffi.rs` | Same as `WM_SCAN_DONE` |
| `ScanDone { result: Result<ScanResult, String>, canceled: bool }` | Struct, heap-allocated, sent via `Box::into_raw` → LPARAM → `Box::from_raw` | `desktop/state.rs` (recommended) — keeps both the constructor (in `mod.rs::start_scan_from_controls`) and the consumer (`window_proc::WM_SCAN_DONE` arm) able to see it via sibling `use super::state::ScanDone;` | `desktop/mod.rs` only (constructed inside `start_scan_from_controls`'s spawned thread; consumed in `window_proc`) |
| `ScanProgressInfo { node_count, elapsed_ms, partial_result }` | Same pattern as `ScanDone` | `desktop/state.rs` (recommended) | Same as `ScanDone` |
| `ScanResult` | From `model` | `model.rs` | Crosses `scan` → `desktop` boundary via the `ScanDone` payload |

**Conclusion:** No new types are needed at the `scan` ↔ `desktop` boundary. `scan` exports `scan_path_with_progress` taking `Arc<AtomicBool>`; `desktop` owns the message-ID constants and the boxed-payload struct definitions. The `Box::into_raw` / `Box::from_raw` round-trip stays entirely inside `desktop` because it's a Win32 pattern.

## `include_str!` Path Audit

The three web-asset constants currently sit at `src/main.rs:17-19`:

```rust
const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_CSS: &str = include_str!("../web/styles.css");
const APP_JS: &str = include_str!("../web/app.js");
```

After moving into `src/server.rs`, the relative path `../web/...` resolves from the directory containing the source file. `src/server.rs` and `src/main.rs` share the same parent directory (`src/`), so `../web/` resolves to the same `web/` directory in both cases. **No path adjustment needed.** [VERIFIED: include_str! is resolved relative to the source file per the Rust Reference; both `src/main.rs` and `src/server.rs` are at depth 1 under the crate root]

If a future submodule like `desktop/foo.rs` needed `include_str!` for a manifest, the depth would change and the path would become `../../web/...` — but Phase 1 doesn't do this. The existing manifest in `enable_visual_styles` (line 2462-2493) is a string literal, not an `include_str!`.

CONTEXT confirms this: "include_str!(\"../web/index.html\") paths are referenced from `server` after extraction. The relative path stays `../web/...` because the `web/` directory is at the workspace root regardless of which source file the macro lives in."

## Inline `mod desktop` `#![allow(...)]` Audit

Current allows (lines 1769-1776):
```rust
#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]
```

CONTEXT's "Established Patterns" section locks this as per-file, not crate-root: "these allows must travel with the desktop submodules (apply per-file in `ffi.rs`, `state.rs`, etc., not globally on the desktop crate root, so the surface stays narrow)."

**Minimal per-file allow list** (based on what each file actually contains):

| File | Required `#![allow(...)]` | Rationale |
|------|---------------------------|-----------|
| `desktop/mod.rs` | `dead_code`, `unsafe_op_in_unsafe_fn`, `non_snake_case` (for `window_proc` param names like `hwnd`/`wparam`/`lparam` — actually snake_case, may not be needed), `clippy::too_many_arguments` (for `create_child`, `draw_row`) | Contains `window_proc` and orchestration helpers with many `unsafe` blocks and ~7-arg helper fns. |
| `desktop/ffi.rs` | `dead_code`, `non_snake_case`, `non_upper_case_globals`, `clippy::upper_case_acronyms`, `clippy::too_many_arguments` | Win32 PascalCase field names (`cbSize`, `dwFlags`, `lpSource`), UPPER_CASE constants that look like locals to clippy, FFI fn pointers with 7+ params. |
| `desktop/state.rs` | `dead_code` (for fields like `bold_font` if not read in `state.rs` itself), `non_snake_case` (none expected actually) | DesktopState has many fields. |
| `desktop/theme.rs` | `dead_code`, `non_upper_case_globals` (for `DARK_BRUSH`, `LIGHT_BRUSH` `OnceLock` statics — these are `UPPER_CASE` so OK; only needed if any `Hbrush` literal const trips it), `unsafe_op_in_unsafe_fn` | `apply_theme` uses unsafe Win32 calls. |
| `desktop/paint.rs` | `dead_code`, `clippy::manual_is_multiple_of`, `clippy::manual_range_contains`, `clippy::too_many_arguments`, `unsafe_op_in_unsafe_fn`, `non_snake_case` | All GDI paint code; `draw_row`/`draw_name_cell`/`draw_percent_cell` have many args. |
| `desktop/shell.rs` | `dead_code`, `unsafe_op_in_unsafe_fn`, `non_snake_case`, `clippy::upper_case_acronyms` | COM vtable calls, GUID consts. |
| `desktop/tabs.rs` | (none until populated) | Empty/near-empty file. |
| `desktop/treemap.rs` | (none until populated) | Empty file. |

**Recommended planner approach:** Start by **copying the existing 8-line allow list to every desktop submodule** as the safe baseline. Once `cargo clippy --all-targets -- -D warnings` is green for the phase-end smoke commit, the planner OR a future cleanup commit can trim the per-file allow lists down to what each file actually needs. This avoids whack-a-mole during the extraction.

**Risk surface:** If `non_snake_case` is forgotten on `ffi.rs`, fields like `cbSize`/`dwFlags`/`lpSource` will fail clippy. If `non_upper_case_globals` is forgotten somewhere with `const IID_IShellFolder: GUID = ...`, it fails. The full-baseline-copy approach defaults to safe.

## Per-Commit Green-Build Invariants

For each commit in the D-05 bottom-up order, identify which symbols `main.rs` (and other not-yet-extracted code) still need to reach into the freshly-moved code. Because the order is bottom-up, the rule is simple: **after each extraction, `main.rs` adds `use crate::<module>::*;` (or selective imports) at the top to keep the old call sites compiling.**

| Commit # | Extract | New `use` in remaining `main.rs` | Risk |
|----------|---------|----------------------------------|------|
| 1 | `model` | `use crate::model::*;` (or explicit list) | None — all types are leaves |
| 2 | `io` | Add `use crate::io::{reveal_path, open_path, display_name, path_to_string, extension_for, now_ms, epoch_ms_to_utc, wildcard_match, should_exclude, should_recurse, current_dir_or_dot, default_thread_count, option_value, has_flag, first_positional_arg, parse_bool, split_patterns, is_hidden_entry, platform_allocated_size};` | Long import list but mechanical. `pattern_matches` stays inside `io` because only `should_exclude` calls it. |
| 3 | `scan` | Add `use crate::scan::{scan_path, scan_path_with_progress};` | Tests in `mod tests` reference `aggregate_nodes`, `snapshot_scan_result`, `ActiveGuard`, `WorkerShared`, `QueueState`, `ScanOptions` — the tests should move with `scan` in this same commit (see §"Tests" above), or they break. **Recommendation: move scan's tests in commit 3 along with the code.** |
| 4 | `analytics` | Add `use crate::analytics::{extension_stats, age_stats, duplicate_candidates, top_file_ids, largest_dir_ids, exact_duplicates_json};` | Note: `scan_result_to_json` (still in main.rs at this commit) calls every `analytics::*` function. |
| 5 | `export` | Add `use crate::export::{scan_result_to_json, scan_result_to_csv, app_config_json, drives_json, push_json_string};` | `handle_client` (still in main.rs at this commit) constructs error JSON with `push_json_string`. Move `push_csv_field` test with `export`. |
| 6 | `server` | Add `use crate::server::run_server;` | This is the big one: `handle_client` (700+ lines, ~30 routes) and the three `include_str!` constants move. After this commit `main.rs` only contains `cli`/`desktop`/`main`. |
| 7 | `cli` | `main.rs` becomes ~15 lines: `mod` declarations + `fn main() { cli::run() }`. `main.rs::main` body moves to `cli::run`. | Verify `windows_subsystem` attribute stays at the crate root (top of `main.rs`), not in `cli.rs`. |
| 8 | `diff` (empty stub) | `mod diff;` added to `main.rs` | Trivially green. Verify a fully-empty `src/diff.rs` passes `cargo build` (it should — empty file is valid Rust). If `clippy` complains, add a `//! Placeholder for Phase 7 (snapshot diff).` doc comment. |
| 9 | `desktop/state.rs` | Inside `desktop/mod.rs` (post-fold), add `mod state; use state::*;`. The body that was in the inline mod stays in the inline mod for now; only `DesktopState`, `STATE`, `ScanDone`, `ScanProgressInfo`, `with_state_mut` move. | Each of these is referenced from `window_proc`, `start_scan_from_controls`, `finish_scan`, etc. — they all gain a `use state::*;` already at the top of `desktop/mod.rs`. |
| 10 | `desktop/ffi.rs` | Add `mod ffi; use ffi::*;` to `desktop/mod.rs`. | Largest single move within desktop (~600 lines). All `unsafe extern` blocks plus all constants. Heavy clippy allow list per §"Inline mod desktop `#![allow(...)]` Audit" above. |
| 11 | `desktop/theme.rs` | Add `mod theme; use theme::*;` to `desktop/mod.rs`. | `palette_*` and theme statics. |
| 12 | `desktop/paint.rs` | Add `mod paint; use paint::*;` | Large move (~600 lines). `paint_window`, `draw_*`, plus the formatters (`format_bytes_ui` etc.) used by mod.rs. |
| 13 | `desktop/shell.rs` | Add `mod shell; use shell::*;` | COM vtable calls — heaviest unsafe surface in the project. |
| 14 | `desktop/tabs.rs` + `desktop/treemap.rs` | Add `mod tabs; mod treemap;` to `desktop/mod.rs`. Optionally `pub(super) fn handle_tab_click(...) -> Option<usize>;` if Q1 resolves toward extracting the click-strip logic. | Empty / near-empty files. Lock the names. |
| 15 | Final cleanup commit | `desktop/mod.rs` becomes the lean facade + `window_proc` dispatcher per CONTEXT D-02. Any remaining helper functions that obviously belong to a submodule get moved (e.g., if `paint.rs` was incomplete in commit 12, trailing helpers go here). | Should be tiny. Use this commit to also remove the temporary blanket `#![allow(...)]` baselines from any submodule that demonstrably doesn't need them, per the recommendation in §"Inline mod desktop `#![allow(...)]` Audit". |

**Invariant the planner must encode:** Every commit ends with the three CI commands green (`cargo build && cargo fmt --check && cargo clippy --all-targets -- -D warnings`). The Plan should embed this as a `verification` block on each task — see the "Per-task validation" section below.

## `window_proc` Dispatcher Pattern (Q7 from focus areas)

CONTEXT D-02 says `window_proc` stays in `desktop/mod.rs` as the dispatch hub. The current `match msg { ... }` arms inside `window_proc` directly call helper functions defined elsewhere in the inline module (`paint_window`, `handle_mouse_click`, `start_scan_from_controls`, `finish_scan`, etc.).

**Minimal-churn recommendation:** Keep the existing pattern verbatim. Each `WM_*` arm calls a free function that lives in the relevant submodule. Submodule fns are `pub(super)`. No trait, no dispatcher struct, no enum-of-handlers indirection.

Concrete shape after the split:

```rust
// desktop/mod.rs
unsafe extern "system" fn window_proc(hwnd: Hwnd, msg: Uint, wparam: Wparam, lparam: Lparam) -> Lresult {
    match msg {
        WM_PAINT => { paint::paint_window(hwnd); 0 }
        WM_LBUTTONDOWN => { handle_mouse_click(hwnd, lparam, false); 0 }   // stays in mod.rs
        WM_RBUTTONUP => { handle_right_click(hwnd, loword_signed(lparam), hiword_signed(lparam)); 0 }
        WM_COMMAND => { /* ID dispatch — stays in mod.rs */ ... }
        WM_SCAN_DONE => { /* Box::from_raw + finish_scan — stays in mod.rs */ ... }
        WM_SCAN_PROGRESS => { /* same pattern */ ... }
        WM_CTLCOLOREDIT | WM_CTLCOLORSTATIC | WM_CTLCOLORBTN => { theme::ctl_color(...) }
        ...
    }
}
```

Why not a trait? A trait adds dispatch indirection and a vtable that doesn't exist in the Win32 model. Why not an enum-of-handlers? Adds a new abstraction layer for zero benefit on a move-only refactor. **Phase 1 ships zero new abstractions — it only relocates existing free functions.**

The CONTEXT D-02 phrasing "calls into the submodule that owns that concern" is best read as: paint → `paint::paint_window`, theme → `theme::ctl_color` (a small new helper to encapsulate the `WM_CTLCOLOR*` arm), but mouse/keyboard handlers stay in `desktop/mod.rs` because they're the dispatch hub itself. This matches CONTEXT's emphasis on "facade".

## Smoke-Test Recipe (Q8 from focus areas)

This is the final BLOCKING task of the phase. The planner should encode it as a single task that runs after every extraction commit is merged.

### Pre-flight

```bash
git status                                       # clean
cargo fmt --check                                 # exits 0
cargo clippy --all-targets -- -D warnings         # exits 0
cargo build --release                             # exits 0
cargo test                                        # all 8 existing tests pass
```

### Mode 1: `scan` (cross-platform CLI)

Pick a stable, mid-sized target. `C:\Windows\Logs` is a reasonable default — typically 50-500 MB, several thousand files, includes some access-denied subfolders to exercise `ScanError` handling.

Baseline once before refactor:
```bash
cargo build --release        # on v0.1.0 / HEAD before Phase 1
.\target\release\filetree.exe scan C:\Windows\Logs --format json --out baseline.json
.\target\release\filetree.exe scan C:\Windows\Logs --format csv  --out baseline.csv
```

After Phase 1 completion:
```bash
cargo build --release
.\target\release\filetree.exe scan C:\Windows\Logs --format json --out after.json
.\target\release\filetree.exe scan C:\Windows\Logs --format csv  --out after.csv
```

Comparison checks:
- `(Get-Item baseline.json).Length` ≈ `(Get-Item after.json).Length` (within a few bytes — `scanned_at_ms` and `elapsed_ms` differ legitimately)
- Top-10 directories by size match: extract via `node.is_dir && node.parent == None`-rooted sort, compare paths + sizes
- File count and folder count match exactly (no nondeterminism here — same filesystem, same `include_hidden` defaults)
- `errors` array length matches exactly

### Mode 2: `serve` (HTTP server, cross-platform)

```bash
.\target\release\filetree.exe serve --path C:\Windows\Logs --port 7878
```

In another shell:
```bash
curl -s http://127.0.0.1:7878/api/config       # {"version":"0.1.0","initialPath":"C:\\Windows\\Logs"}
curl -s http://127.0.0.1:7878/api/drives       # array of drive entries on Windows
curl -s "http://127.0.0.1:7878/api/scan?path=C:\Windows\Logs&threads=4" > scan-api.json
# Spot-check scan-api.json has nodes, errors, root_path, scanned_at_ms, elapsed_ms, thread_count
curl -s "http://127.0.0.1:7878/api/export.csv" > export-api.csv
diff after.csv export-api.csv                  # should be near-identical (allow timestamp drift)
```

Open `http://127.0.0.1:7878/` in a browser. Verify: tree renders, treemap renders, Extensions / Top / Duplicates / Errors tabs render, "Exact hash scan" button works.

### Mode 3: `desktop` (Win32 native, Windows-only)

```bash
.\target\release\filetree.exe desktop --path C:\Windows\Logs
```

Manual checks (visual):
- Window opens with toolbar tabs (File / Home / Scan / View / Options / Help), path bar pre-filled with `C:\Windows\Logs`
- "Scan" button triggers scan; status bar updates with progress every ~1.5s
- Tree populates with sortable columns: Name, Size, Allocated, Files, Folders, %, Modified
- Twist arrows expand/collapse directories
- "Stop" cancels an in-flight scan (status returns to idle within ~1.5s)
- Dark-mode toggle flips palette across all controls
- Right-click on a row shows the shell context menu (Windows Explorer behavior — Open, Properties, etc.)
- Double-click on a directory expands it; double-click on a file invokes `ShellExecuteW open`
- Window resize re-flows controls; treemap (if added in browser only — not desktop in v0.1.0) is not part of this check

**Exit criteria for the BLOCKING task:** All three modes match v0.1.0 behavior. If any difference is observed, the offending commit is found via `git bisect` (which is why D-03's per-commit green-build rule matters).

## Common Pitfalls

### Pitfall 1: Forgetting `non_snake_case` allow on `ffi.rs`

**What goes wrong:** Win32 struct fields like `cbSize`, `dwFlags`, `hModule` fail `cargo clippy -D warnings` with `non_snake_case` lint.
**Why it happens:** The crate root doesn't have `#![allow(non_snake_case)]`. The inline `mod desktop` does. After extraction, each submodule needs its own.
**How to avoid:** Apply the **full baseline 8-line allow list** to every desktop submodule on its first extraction commit. Tighten later.
**Warning signs:** First desktop submodule commit fails clippy with dozens of `non_snake_case`/`non_upper_case_globals` warnings.

### Pitfall 2: Test helpers left orphaned

**What goes wrong:** `make_test_node` (line 4823, used by 3 tests) is currently shared between tests in the same `mod tests`. If two of those tests move to `scan.rs::tests` and one moves to `export.rs::tests`, the helper is duplicated or lost.
**Why it happens:** Test groupings in the original file are by topic, not by target module.
**How to avoid:** Audit upfront — all three callers of `make_test_node` test `scan` symbols (`aggregate_nodes`, `snapshot_scan_result`). All move to `scan.rs::tests`. Helper goes with them. No duplication.
**Warning signs:** `cargo test` reports `cannot find function make_test_node in this scope`.

### Pitfall 3: `windows_subsystem` attribute left in wrong file

**What goes wrong:** `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` is a *crate-level* attribute (the `#!` prefix). If accidentally moved into `cli.rs` as part of the `main` extraction, it becomes a module-level attribute and silently does nothing — release builds will pop up a console window.
**Why it happens:** Easy to swing the whole top of `main.rs` into `cli.rs` during the cli extraction.
**How to avoid:** This attribute MUST stay at line 1 of the new minimal `src/main.rs`. Verify by running `cargo build --release` and double-clicking the produced `.exe` — no console window should appear.
**Warning signs:** A black console window appears alongside the native window in release builds.

### Pitfall 4: `include_str!` paths break

**What goes wrong:** Moving `INDEX_HTML`/`APP_CSS`/`APP_JS` into `desktop/foo.rs` (hypothetically) breaks the relative path because the file is now two levels deep.
**Why it happens:** `include_str!` is resolved relative to the source file, not the crate root.
**How to avoid:** Constants live in `server.rs` (one level deep, same as `main.rs`) — path stays `../web/...`. Already confirmed in CONTEXT and §"`include_str!` Path Audit" above.
**Warning signs:** `cargo build` fails with `error: couldn't read 'src/desktop/../web/index.html'`.

### Pitfall 5: Forgetting `pub(super)` on a sibling-used const in `ffi.rs`

**What goes wrong:** `desktop/paint.rs` uses `DT_LEFT` (a const in `desktop/ffi.rs`); `desktop/shell.rs` uses `TPM_RETURNCMD`. If these aren't `pub(super)`, sibling submodules can't see them.
**Why it happens:** Original inline `mod desktop` had no visibility annotations because everything was already in scope.
**How to avoid:** Default rule: every item declared at the top of `desktop/ffi.rs` becomes `pub(super)`. There's no harm — the module is already private to the crate via `mod ffi;` (not `pub mod ffi`).
**Warning signs:** First post-`ffi.rs`-extraction commit fails with `error[E0603]: constant DT_LEFT is private`.

### Pitfall 6: Mid-extraction, `main.rs` reaches forward into not-yet-extracted code

**What goes wrong:** After commit 3 (`scan` extracted), if `main.rs::handle_client` calls a function the planner *thought* was extracted but actually wasn't, the commit fails to build.
**Why it happens:** The mental model of "what's where" drifts across 15 commits.
**How to avoid:** Bottom-up order (CONTEXT D-05) makes this almost impossible: at every commit, the extracted module only depends on already-extracted modules. The reverse (still-in-main reaching into extracted code) is fine — just add `use crate::scan::*;` (or selective imports) at the top of `main.rs` in the same commit.
**Warning signs:** A commit fails `cargo build` with E0432 `unresolved import` or E0425 `cannot find function ... in this scope`.

### Pitfall 7: `mod desktop` `#![allow(dead_code)]` masks a real bug

**What goes wrong:** After narrowing per-file `allow` lists, some functions become genuinely dead but `dead_code` was removed — clippy fails.
**Why it happens:** The blanket allow hid real dead code, and "real" Phase 1 is move-only so removing dead code is out of scope.
**How to avoid:** Keep `#![allow(dead_code)]` on every desktop submodule throughout Phase 1. A follow-up cleanup phase can tighten it. CONTEXT defers all renames/cleanups; this falls under the same posture.
**Warning signs:** Per-file allow trimming fails clippy on a function used only via vtable indirection or dynamic dispatch.

## Code Examples

### Pattern: `desktop` submodule file header

```rust
// src/desktop/paint.rs
#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ptr::null;

use crate::model::{NodeRecord, ScanResult};

use super::ffi::*;          // Hwnd, Hdc, Dword, PAINTSTRUCT, BeginPaint, EndPaint, ...
use super::state::{DesktopState, with_state_mut};
use super::theme::{palette_table, palette_text, dark_brush, light_brush};

pub(super) unsafe fn paint_window(hwnd: Hwnd) {
    // ... existing body verbatim ...
}
```

This matches CONTEXT's "Established Patterns" guidance: explicit `use crate::model::NodeRecord;` rather than `use super::*;` once we have multiple sibling modules.

### Pattern: Lean `src/main.rs` after Phase 1

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analytics;
mod cli;
mod diff;
mod export;
mod io;
mod model;
mod scan;
mod server;

#[cfg(windows)]
mod desktop;

fn main() {
    cli::run();
}
```

`cli::run()` returns `()` and does the `eprintln!` + `std::process::exit(1)` itself, matching the existing `main` behavior at lines 120-164.

### Pattern: Empty `src/diff.rs` and `src/desktop/treemap.rs`

```rust
// src/diff.rs
//! Snapshot diff. Empty in Phase 1; populated in Phase 7 (SNAP-04..07).
```

```rust
// src/desktop/treemap.rs
//! Native-desktop treemap rendering. Empty in Phase 1; populated in Phase 8 (VIZ-01).
```

A file containing only doc comments is valid Rust and produces no clippy warnings. [VERIFIED: standard Rust behavior]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `cargo test` (built-in) — no external test framework |
| Config file | none (Cargo defaults) |
| Quick run command | `cargo test --lib` (fast; runs the 8 unit tests in `mod tests`) |
| Full suite command | `cargo test` (same as quick — no integration test crate exists) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| REFAC-01 | Build succeeds with new module layout | build | `cargo build --release` | n/a (build step) |
| REFAC-01 | Format check passes | lint | `cargo fmt --check` | n/a (rustfmt) |
| REFAC-01 | Clippy passes with `-D warnings` | lint | `cargo clippy --all-targets -- -D warnings` | n/a (clippy) |
| REFAC-01 | All 8 existing tests pass after relocation | unit | `cargo test` | ✅ existing |
| REFAC-01 | No new dependencies in `Cargo.toml` | manual | `Get-Content Cargo.toml | Select-String '^\['` and verify `[dependencies]` section is empty (or via `cargo tree --depth 0` — should list only `filetree v0.1.0`) | n/a (file inspection) |
| REFAC-01 | Smoke parity for `scan` mode | smoke | See §"Smoke-Test Recipe" Mode 1 | manual |
| REFAC-01 | Smoke parity for `serve` mode | smoke | See §"Smoke-Test Recipe" Mode 2 | manual |
| REFAC-01 | Smoke parity for `desktop` mode | smoke | See §"Smoke-Test Recipe" Mode 3 | manual (Windows-only, visual) |

### Sampling Rate

- **Per task commit:** `cargo build && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` — all four must be green.
- **Per wave merge:** Same four-command gate; this matches CI exactly.
- **Phase gate:** Full smoke-test recipe (Modes 1-3) green before `/gsd-verify-work`.

### Wave 0 Gaps

- [x] None — existing test infrastructure (`mod tests` with 8 tests + `cargo test`) covers all phase requirements for the automated portion.
- Test framework install: none required (`cargo test` is built-in).
- Helper functions for test setup (`make_test_node`): already exist; move with `scan` extraction commit.
- No new test files needed — existing tests redistribute to `scan.rs::tests`, `export.rs::tests`, `io.rs::tests` per §"Tests" mapping above.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `desktop/tabs.rs` and `desktop/treemap.rs` can ship as empty placeholders in Phase 1 because the current desktop UI has no per-tab content panels and no native treemap. | Extraction Map, Open Q1 | If the user wants `desktop/tabs.rs` to contain the toolbar-tab dispatch (extracted from `draw_toolbar_background` + `handle_mouse_click` + `resize_controls`), the file becomes ~150 lines instead of 1 line. Either is defensible. Verified by Grep — no `tab_panel` / `render_summary_tab` / per-tab content code exists. [VERIFIED via Grep] |
| A2 | An empty `.rs` file (no items, just a doc comment) passes `cargo build` and `cargo clippy -- -D warnings`. | Code Examples | If `clippy` complains on empty modules, add `pub(crate) fn _placeholder() {}` in both `diff.rs` and `desktop/treemap.rs`. [ASSUMED — empty Rust files are valid per the Reference, but clippy has occasionally flagged unused modules. Easy to fix if it trips.] |
| A3 | `pattern_matches` stays inside `io` (private) because `should_exclude` is its only caller. | pub(crate) Visibility Matrix | Verified by Grep — only `should_exclude` (line 1631) calls `pattern_matches` (line 1639). [VERIFIED] |
| A4 | `format_bytes_ui`, `format_count_ui`, `format_duration_ui` belong inside `desktop` (probably `paint.rs`) because they're not used outside `desktop`. | Extraction Map → paint.rs row | Verified by Grep — `format_bytes_ui` is called only from `apply_scan_progress`, `draw_row`, `draw_name_cell`, `collect_rows` (all desktop); `format_count_ui` likewise; `format_duration_ui` is defined but the only callers are inside desktop. Splitting into `desktop/format.rs` is an Open Question (Q2). [VERIFIED] |

## Open Questions (RESOLVED)

1. **Q1: Should `desktop/tabs.rs` extract the toolbar-tab logic from `paint.rs` / `handle_mouse_click` / `resize_controls`, or stay an empty placeholder?**
   - What we know: Current "tabs" are the File/Home/Scan/View/Options/Help ribbon strip. Rendering is in `draw_toolbar_background` (within paint), click detection is in `handle_mouse_click` (lines 4135-4159), per-tab control-visibility logic is in `resize_controls` (lines 3052-3149). All three reference `state.active_tab`.
   - What's unclear: Whether the planner should extract a `tabs::draw_tab_strip(...)` + `tabs::handle_tab_click(...) -> Option<usize>` + `tabs::layout_for_tab(state)` trio in Phase 1, or defer to Phase 8 when real per-tab content panels arrive.
   - **RESOLVED:** Defer. Extract these in Phase 8 alongside VIZ-01 work, where per-tab content panels make `tabs.rs` substantive. Phase 1 ships `desktop/tabs.rs` as a doc-comment-only placeholder. Rationale: pulling 3 short fragments across 3 files into a new module without a coherent reason is the kind of "rename-style cleanup" CONTEXT defers. The placeholder still locks the module name. Plan 02 Task 7 implements this.

2. **Q2: Should `format_bytes_ui` / `format_count_ui` / `format_duration_ui` live in `desktop/paint.rs` or `desktop/format.rs`?**
   - What we know: Three small functions, ~10 lines each, used only inside `desktop` (verified). They format `u64`/`u128` into human strings for display in the GDI-painted UI.
   - What's unclear: Whether they justify their own file or ride along inside `paint.rs`.
   - **RESOLVED:** Inside `paint.rs`. Move-only refactor — these functions live next to the only consumers (`draw_row`, `draw_name_cell`, `apply_scan_progress`, `collect_rows`, `render_list`). A future Phase 2 (status bar) might also call them — at that point split into `desktop/format.rs`. Plan 02 Task 5 implements this.

3. **Q3: `ScanDone` and `ScanProgressInfo` — `desktop/state.rs` or `desktop/mod.rs`?**
   - What we know: Both are heap-allocated payloads passed through `WM_SCAN_DONE`/`WM_SCAN_PROGRESS` `LPARAM`. Constructed in `start_scan_from_controls` (will live in `desktop/mod.rs`), consumed in `window_proc` (also `desktop/mod.rs`).
   - What's unclear: Whether to put them in `state.rs` (logical home — they're transient state across thread boundaries) or `mod.rs` (only consumer).
   - **RESOLVED:** `desktop/state.rs`. It's the natural sibling. If a future phase has the progress thread post additional message types, they all collect in one place. Tiny risk; tiny upside; both compile identically. Plan 02 Task 2 implements this.

## Sources

### Primary (HIGH confidence — verified via direct file read or grep against this codebase)

- `src/main.rs` (5055 lines) — full line-range grep and targeted reads at lines 1-200, 1767-1923, 2197-2495, 2570-2842, 3590-3739, 4130-4210, 4800-5054
- `Cargo.toml` — verified `[dependencies]` is empty
- `.github/workflows/ci.yml` — verified the three-command CI gate at lines 21-25 (plus `cargo test` at 27-28 and `cargo build --release` at 30-31, which are the smoke-test prerequisites)
- `.planning/phases/01-module-split/01-CONTEXT.md` — locked decisions D-01..D-06 and Discretion items
- `.planning/REQUIREMENTS.md` — REFAC-01 verbatim
- `.planning/ROADMAP.md` — Phase 1 goal, success criteria, brownfield refactor exception
- `.planning/codebase/ARCHITECTURE.md` — component table with line ranges (this was the primary input map)
- `.planning/codebase/CONVENTIONS.md` — naming patterns to preserve
- `CLAUDE.md` — project constraints

### Secondary (MEDIUM confidence — standard Rust knowledge applied to this codebase)

- Rust `include_str!` resolves relative to the containing source file — standard `std` macro behavior; applied to confirm `../web/...` paths still work after moving constants to `server.rs`.
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` semantics — standard cargo behavior; the CI file uses the canonical invocations.
- Edition 2024 module convention allows either `module.rs` or `module/mod.rs` for directory-form modules; CONTEXT Discretion locks the choice.

### Tertiary (LOW confidence — none)

None.

## Metadata

**Confidence breakdown:**
- Extraction map (which lines → which file): HIGH — every entry backed by Grep against the actual `src/main.rs`.
- `pub(crate)` visibility matrix: HIGH — every cross-boundary call verified at the line cited.
- `include_str!` path stability: HIGH — verified by standard Rust semantics + file depth check.
- Desktop `#![allow(...)]` per-file recommendations: MEDIUM — based on inspection of which symbols land in which file; planner should validate by running `cargo clippy` after each desktop submodule commit and adjusting.
- Empty-file behavior (`diff.rs`, `treemap.rs`): MEDIUM — assumed safe per Rust Reference; trivially verifiable during commit 8.
- Smoke-test recipe specifics: HIGH for the commands; MEDIUM for "Top-10 dirs by size match" — the planner may want to script this comparison rather than eyeball it.

**Research date:** 2026-05-22
**Valid until:** 2026-06-22 (30 days — codebase is stable; refactor target won't shift)

## RESEARCH COMPLETE

**Phase:** 1 — Module Split
**Confidence:** HIGH

### Key Findings

- The 15-commit bottom-up extraction order in CONTEXT D-05 is bisectable as stated; no commit forces `main.rs` to reach into not-yet-extracted code. Each commit only requires adding `use crate::<extracted>::*;` to remaining `main.rs`.
- `desktop/tabs.rs` and `desktop/treemap.rs` are **lock-the-name placeholder files** in Phase 1 — the current desktop UI has no per-tab content panels and no native treemap. Treating them as substantive files would require extracting toolbar-tab dispatch fragments across three existing files, which contradicts the move-only posture.
- The 8 existing unit tests in `mod tests` (lines 4800-5054) all target `scan` / `export` / `io` symbols. They redistribute cleanly: 6 → `scan.rs::tests`, 1 → `export.rs::tests`, 2 → `io.rs::tests`. Move them in the same commit as their target module to keep every commit green.
- `include_str!("../web/...")` paths in `server.rs` work without modification because `src/server.rs` is at the same depth as `src/main.rs`.
- Cross-boundary `scan` ↔ `desktop`: `cancel: Arc<AtomicBool>` needs no wrapper; `WM_SCAN_DONE`/`WM_SCAN_PROGRESS` constants live in `desktop/ffi.rs`; `ScanDone`/`ScanProgressInfo` boxed payloads live in `desktop/state.rs` (recommended).
- Each desktop submodule should start with the **full 8-line `#![allow(...)]` baseline copied from the current inline `mod desktop`**, then trim later if desired. Per-file allow trimming is itself out of Phase 1 scope.

### File Created

`C:\Users\dannguan\FileTree\.planning\phases\01-module-split\01-RESEARCH.md`

### Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Extraction map (line → file) | HIGH | Every entry grep-verified against current `src/main.rs` |
| Visibility matrix | HIGH | Every `pub(crate)` recommendation backed by a verified call site |
| Per-commit invariants | HIGH | Bottom-up order makes mid-refactor green-build mechanical |
| Test relocation | HIGH | All 8 tests inspected; helper `make_test_node` shares one target module |
| Desktop submodule allow lists | MEDIUM | Conservative baseline recommended; planner validates per commit |
| Smoke-test recipe | HIGH (commands) / MEDIUM (diff scripting) | Commands canonical; equivalence checks likely need a small PS comparison script |

### Open Questions

- Q1: `desktop/tabs.rs` — empty placeholder vs. extract toolbar-tab fragments. Recommendation: empty placeholder (defer to Phase 8).
- Q2: `format_bytes_ui`/`format_count_ui`/`format_duration_ui` — in `paint.rs` or own `format.rs`. Recommendation: `paint.rs`.
- Q3: `ScanDone`/`ScanProgressInfo` — in `state.rs` or `mod.rs`. Recommendation: `state.rs`.

### Ready for Planning

Research complete. Planner can now decompose Phase 1 into ~15 commit-sized tasks following the D-05 bottom-up order, each with the four-command verification gate (`cargo build && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`), terminating in a single BLOCKING smoke-test task covering all three modes.
