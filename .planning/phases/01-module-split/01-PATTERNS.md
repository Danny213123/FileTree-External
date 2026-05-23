# Phase 1: Module Split - Pattern Map

**Mapped:** 2026-05-22
**Files analyzed:** 16 new files (8 top-level modules + 8 desktop submodules) + rewrite of `src/main.rs`
**Analogs found:** 16 / 16 (every new file's "analog" is the corresponding line range in the existing `src/main.rs`)

## Framing

This is a **move-only mechanical refactor**. There is no other Rust file in the project to mirror — `src/main.rs` is the entire crate today. Therefore the "closest analog" for every new file is literally the contiguous line range inside `src/main.rs` that contains the code being lifted. PATTERNS.md is structured as an **extraction map**: for each new file, the planner gets the source line range, the symbol inventory, the cross-module imports the file will need at the top, and the in-file stylistic analog (top-of-file imports vs. inline `mod desktop` header) to copy.

Three in-file stylistic analogs the planner should reference everywhere:

1. **Top-of-file convention** (`src/main.rs:1-19`) — `#![...]` crate attrs → grouped `use` block → `const` block → types. Every new top-level module file (`model.rs`, `io.rs`, `scan.rs`, `analytics.rs`, `export.rs`, `server.rs`, `cli.rs`) inherits this layout (minus the `#![cfg_attr(...)]` crate attr, which stays at line 1 of the new `main.rs`).
2. **Inline submodule header** (`src/main.rs:1767-1784`) — the existing `mod desktop` block opens with eight `#![allow(...)]` lines, then `use super::*;`, then targeted `std` imports. Every new `desktop/*.rs` file copies the full 8-line allow baseline (per RESEARCH §"Inline `mod desktop` `#![allow(...)]` Audit") and replaces `use super::*;` with explicit `use crate::model::*;` + `use super::ffi::*;` (per CONTEXT "Established Patterns").
3. **`pub(crate)` visibility** — no `pub` exists in the codebase today (single binary crate, no `lib.rs`). The planner adds `pub(crate)` only on cross-module items per the matrix in RESEARCH §"`pub(crate)` Visibility Matrix"; sibling-only items in `desktop/` use `pub(super)`.

## File Classification

Roles below are Rust-idiomatic for this codebase (model / io / engine / serializer / server / cli / facade / ffi-binding). Data flow describes how the file participates at runtime.

| New file | Role | Data flow | Source line range in `src/main.rs` | Match Quality |
|----------|------|-----------|-------------------------------------|---------------|
| `src/model.rs` | model (pure data types) | shared by every module | 21-118 | exact (verbatim move) |
| `src/io.rs` | utility (platform + parsing helpers) | leaf — no upstream Rust deps | 1497-1735 | exact (verbatim move) |
| `src/scan.rs` | engine (multi-thread BFS) | producer of `ScanResult` | 268-671 | exact (verbatim move) |
| `src/analytics.rs` | service (pure compute over `&[NodeRecord]`) | consumer of `ScanResult` | 1242-1451 | exact (verbatim move) |
| `src/export.rs` | serializer (JSON / CSV string builders) | consumer of `ScanResult` + `analytics` | 996-1240, 1453-1495 | exact (verbatim move) |
| `src/server.rs` | server (TCP + HTTP/1.1 router) | request-response | 17-19 (consts only), 241-994 | exact (verbatim move) |
| `src/cli.rs` | controller (argv parsing + mode dispatch) | request-response (process-level) | 15-16 (consts), 120-239 | exact (verbatim move) |
| `src/diff.rs` | placeholder (empty stub for Phase 7) | n/a in Phase 1 | — | n/a (new empty file) |
| `src/desktop/mod.rs` | facade + dispatch (window class + `window_proc`) | event-driven (Win32 message loop) | 2496-2842 + many helper ranges (see below) | exact (verbatim move) |
| `src/desktop/ffi.rs` | ffi binding (raw `extern "system"` + consts) | leaf within `desktop/` | 1785-2378 | exact (verbatim move) |
| `src/desktop/state.rs` | model (UI state struct + global `OnceLock`) | shared by every `desktop/` submodule | 2379-2460, 4743-4754 | exact (verbatim move) |
| `src/desktop/theme.rs` | service (dark-mode palette helpers) | consumer of `state` | 1921-1923, 3496-3552, 4542-4656 | exact (verbatim move) |
| `src/desktop/paint.rs` | view (GDI double-buffered paint primitives) | consumer of `state` + `theme` + `ffi` | 3554-4129, 4503-4519, 4756-4798 | exact (verbatim move) |
| `src/desktop/shell.rs` | ffi-glue (COM vtable + Shell32 calls) | consumer of `ffi` + `state` | 2462-2494, 3458-3494, 4209-4302, 4394-4428 | exact (verbatim move) |
| `src/desktop/tabs.rs` | placeholder (lock-the-name; populated Phase 8) | n/a in Phase 1 | — | n/a (new empty file) |
| `src/desktop/treemap.rs` | placeholder (lock-the-name; populated Phase 8) | n/a in Phase 1 | — | n/a (new empty file) |
| `src/main.rs` | crate root (module declarations + `fn main`) | dispatch to `cli::run()` | rewrite to ~15 lines | n/a (full rewrite, see Code Example #2 below) |

Tests (8 unit tests at `src/main.rs:4800-5054`) move with the symbol they exercise — see RESEARCH §"Tests" and the per-file Test Migration notes below.

## Pattern Assignments

### `src/model.rs` (model, shared-by-every-module)

**Source:** `src/main.rs:21-118` (verbatim block)

**Symbols extracted:** `ScanOptions`, `NodeRecord`, `ScanError`, `ScanResult`, `QueueState`, `WorkerShared`, `AppState`, `HttpRequest`, `ExtensionStat`, `AgeBucket`, `DuplicateCandidate`.

**Cross-module imports needed at the top of the file:** None. `model.rs` is a leaf — pure `std` only.

**Top-of-file `use` block (copy this exact pattern from `src/main.rs:3-13`):**
```rust
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;
```
(Trim the full main.rs `use` block down to only the names referenced inside lines 21-118 — see RESEARCH for the actual subset; the planner's task should `cargo build` after the trim.)

**Stylistic analog:** Top-of-file convention (`src/main.rs:1-19`) — `use` block → types. No `const`s in this file.

**Visibility:** Every struct + every field gets `pub(crate)` (see RESEARCH §"`pub(crate)` Visibility Matrix" → `model`).

---

### `src/io.rs` (utility, leaf)

**Source:** `src/main.rs:1497-1735` (verbatim block; Windows-only fns gated by internal `#[cfg(windows)]` per CONTEXT D Discretion)

**Symbols extracted:** `reveal_path`, `open_path`, `display_name`, `path_to_string`, `extension_for`, `metadata_modified_ms`, `now_ms`, `current_dir_or_dot`, `default_thread_count`, `option_value`, `has_flag`, `first_positional_arg`, `parse_bool`, `split_patterns`, `should_recurse`, `should_exclude`, `pattern_matches`, `wildcard_match`, `is_hidden_entry` (×2 cfg-gated), `platform_allocated_size` (×2 cfg-gated), `windows_compressed_file_size`, `epoch_ms_to_utc`, `civil_from_days`.

**Cross-module imports needed:** None on the Rust side — `io.rs` is leaf. (It does reach into Win32 via its own `#[link(name="Kernel32")]` block for `GetCompressedFileSizeW` at `src/main.rs:1683-1710`; that block moves with the file.)

**Top-of-file pattern (copy from `src/main.rs:3-13`, narrowed):**
```rust
use std::env;
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
```

**Test migration:** `wildcard_supports_star_and_question` (line 4805) and `epoch_formats_unix_start` (line 4818) move into `src/io.rs` `#[cfg(test)] mod tests`.

**Visibility:** `pub(crate)` on items called from `scan`, `server`, `desktop`, `cli`, `export` (full list in RESEARCH `io` matrix). Keep `pattern_matches`, `civil_from_days`, `windows_compressed_file_size`, `metadata_modified_ms`, `hex_value` private.

---

### `src/scan.rs` (engine, producer of `ScanResult`)

**Source:** `src/main.rs:268-671` (verbatim block)

**Symbols extracted:** `scan_path`, `scan_path_with_progress`, `snapshot_scan_result`, `ActiveGuard` + its `Drop` impl, `worker_loop`, `scan_directory_job`, `metadata_for_entry`, `add_node`, `add_scan_error`, `aggregate_nodes`.

**Cross-module imports needed at the top of the file:**
```rust
use crate::io::{
    display_name, extension_for, is_hidden_entry, now_ms, path_to_string,
    platform_allocated_size, should_exclude, should_recurse,
};
use crate::model::{NodeRecord, QueueState, ScanError, ScanOptions, ScanResult, WorkerShared};
```

**Stylistic analog for the `use` ordering:** Same as the top of `src/main.rs:1-13` — group by std module, then crate-local imports below `std`. The convention is "grouped loosely by std module" per CONVENTIONS.md line 59.

**Test migration (6 tests move here):** `make_test_node` helper (line 4823), `aggregate_nodes_sums_children_into_parent` (line 4854), `snapshot_result_has_correct_aggregation` (line 4894), `snapshot_releases_nodes_lock_before_aggregation` (line 4935), `active_guard_decrements_active_and_sets_done_when_empty` (line 4970), `active_guard_does_not_set_done_when_dirs_remain` (line 5011), `scan_path_with_progress_sends_partial_results` (line 5043).

**Visibility:** `pub(crate)` on `scan_path`, `scan_path_with_progress`; `pub(crate)` on `snapshot_scan_result`, `aggregate_nodes`, `ActiveGuard` (+ its `shared` field) for tests. Other helpers private.

---

### `src/analytics.rs` (service, pure compute)

**Source:** `src/main.rs:1242-1451` (verbatim block)

**Symbols extracted:** `exact_duplicates_json`, `fnv1a_file`, `top_file_ids`, `largest_dir_ids`, `extension_stats`, `age_stats`, `duplicate_candidates`.

**Cross-module imports needed:**
```rust
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};

use crate::export::push_json_string;
use crate::model::{AgeBucket, DuplicateCandidate, ExtensionStat, NodeRecord, ScanResult};
```

Note: `exact_duplicates_json` calls `push_json_string` (an `export` symbol) — this is the one cross-module reach upward from `analytics` into `export`. Per CONTEXT D-05 bottom-up order, `analytics` is extracted before `export`, so during the analytics-extraction commit `push_json_string` still lives in `main.rs`; the import becomes `use crate::push_json_string;` (or stays as `super::push_json_string` if main re-exports it temporarily). The cleanest path: extract `export` first if planner finds this awkward, OR keep the `use` import unresolved until commit 5 lands. RESEARCH §"Per-Commit Green-Build Invariants" already addresses this: every commit must remain green; the planner should encode it.

**Visibility:** `pub(crate)` on every public-facing fn; `fnv1a_file` stays private (only called by `exact_duplicates_json`).

---

### `src/export.rs` (serializer, consumer of model + analytics)

**Source:** `src/main.rs:996-1240` (JSON + CSV) and `src/main.rs:1453-1495` (`app_config_json`, `drives_json`) — two contiguous ranges.

**Symbols extracted:** `scan_result_to_json`, `scan_result_to_csv`, `app_config_json`, `drives_json`, `push_id_array`, `push_json_string`, `push_csv_field`.

**Cross-module imports needed:**
```rust
use std::path::PathBuf;

use crate::analytics::{
    age_stats, duplicate_candidates, extension_stats, largest_dir_ids, top_file_ids,
};
use crate::io::{epoch_ms_to_utc, path_to_string};
use crate::model::{AppState, NodeRecord, ScanError, ScanResult};
```

**Stylistic analog for the `push_*` / `*_to_*` naming:** preserve verbatim per CONVENTIONS.md lines 12-15 ("Private helpers that generate output are named `push_*`... Render-style helpers named `*_to_*`"). Builder pattern (`&mut String` first arg) per CONVENTIONS.md line 128 — already present in the source.

**Test migration:** `csv_fields_are_escaped` (line 4811) moves here.

**Visibility:** `pub(crate)` on `scan_result_to_json`, `scan_result_to_csv`, `app_config_json`, `drives_json`, `push_json_string`. `push_csv_field` is `pub(crate)` for test access. `push_id_array` private.

---

### `src/server.rs` (server, request-response)

**Source:** `src/main.rs:17-19` (three `include_str!` constants) + `src/main.rs:241-994` (the entire server block).

**Symbols extracted:** `INDEX_HTML`, `APP_CSS`, `APP_JS`; `run_server`, `handle_client`, `read_http_request`, `respond_text`, `respond_json`, `respond_bytes`, `split_target`, `percent_decode`, `hex_value`.

**Cross-module imports needed:**
```rust
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use crate::analytics::exact_duplicates_json;
use crate::cli::{APP_NAME, APP_VERSION};
use crate::export::{
    app_config_json, drives_json, push_json_string, scan_result_to_csv, scan_result_to_json,
};
use crate::io::{default_thread_count, open_path, reveal_path};
use crate::model::{AppState, HttpRequest, ScanOptions, ScanResult};
use crate::scan::scan_path;
```

Note: server extracts in commit 6 (after analytics + export). `cli::{APP_NAME, APP_VERSION}` is forward-referenced — at commit 6 these consts still live in main.rs. Planner adds the `use` once cli extracts in commit 7, OR keeps consts in `server.rs` temporarily and moves them to `cli.rs` in commit 7. CONTEXT D-05 ordering supports either; recommend: leave the consts at `main.rs:15-16` through commit 6, then move both during the cli-extraction commit (commit 7) and update `server.rs`'s import at that time.

**`include_str!` path stability:** The three constants stay as `include_str!("../web/index.html")` etc. — `src/server.rs` is at the same depth as `src/main.rs`, so the relative path resolves identically. Confirmed in RESEARCH §"`include_str!` Path Audit".

**Stylistic analog:** Top-of-file convention (`src/main.rs:1-19`) — `use` block → `const` block → fns. The three `include_str!` consts land directly after the `use` block, mirroring the existing layout.

**Visibility:** `pub(crate)` on `run_server` only. Everything else private to `server`.

---

### `src/cli.rs` (controller, process-level dispatch)

**Source:** `src/main.rs:15-16` (`APP_NAME`, `APP_VERSION`) + `src/main.rs:120-239` (`main` body, `print_usage`, `run_desktop`, `run_scan_command`).

**Symbols extracted:** `APP_NAME`, `APP_VERSION` consts; `run` (the renamed-from-`main` extracted body), `print_usage`, `run_desktop`, `run_scan_command`.

**Cross-module imports needed:**
```rust
use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process;

use crate::export::{scan_result_to_csv, scan_result_to_json};
use crate::io::{
    current_dir_or_dot, default_thread_count, first_positional_arg, has_flag, option_value,
    parse_bool, split_patterns,
};
use crate::model::ScanOptions;
use crate::scan::scan_path;
use crate::server::run_server;
```

**Visibility:** `pub(crate)` on `run`, `APP_NAME`, `APP_VERSION`. Others private.

**Pitfall to encode in the plan (per RESEARCH Pitfall 3):** The `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` attribute (currently `src/main.rs:1`) is **crate-level** (`#![...]`) — it MUST stay at line 1 of the new minimal `src/main.rs` and NOT travel with the `main` body into `cli.rs`. The planner's `cli` extraction task should explicitly verify this with a release build + double-click test.

---

### `src/diff.rs` (placeholder)

**Source:** none — new file.

**Symbols extracted:** none.

**File contents (copy verbatim):**
```rust
//! Snapshot diff. Empty in Phase 1; populated in Phase 7 (SNAP-04..07).
```

A file containing only a doc comment is valid Rust and passes both `cargo build` and `cargo clippy --all-targets -- -D warnings` (per RESEARCH Assumption A2). If clippy complains in practice, fall back to `pub(crate) fn _placeholder() {}`. The planner's commit-8 task should `cargo clippy` first and only add the placeholder fn if the empty-with-doc form fails.

---

### `src/desktop/mod.rs` (facade + dispatch hub)

**Source:** Multiple ranges within the inline `mod desktop` body. Per RESEARCH §"Extraction Map → Desktop submodules":
- `2496-2842` — `pub fn run`, `window_proc`, top-level Win32 class registration
- `2844-2994` — `create_controls`
- `2996-3021` — `create_child`
- `3023-3166` — `resize_controls`
- `3168-3253` — `start_scan_from_controls`
- `3255-3313` — `finish_scan`
- `3315-3344` — `apply_scan_progress`
- `3346-3359` — `stop_current_scan`
- `3361-3369` — `destroy_cached_icons`
- `3371-3389` — `expand_all_directories`
- `3391-3401` — `collapse_to_root`
- `3403-3417` — `toggle_path_column`
- `3419-3427` — `choose_and_set_directory`
- `3429-3456` — `browse_for_directory`
- `4131-4207` — `handle_mouse_click`
- `4304-4392` — `handle_right_click`
- `4430-4440` — `handle_mouse_wheel`
- `4442-4463` — `handle_mouse_move`
- `4465-4478` — `handle_key`
- `4480-4496` — `move_selection`
- `4498-4501` — `scroll_rows`
- `4658-4690` — `render_list`
- `4692-4719` — `collect_rows`
- `4721-4723` — `button_checked`
- `4725-4730` — `get_window_text`
- `4732-4735` — `set_window_text`
- `4737-4741` — `show_error`

**Cross-module imports needed (top of file, after submodule declarations):**
```rust
#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

mod ffi;
mod paint;
mod shell;
mod state;
mod tabs;
mod theme;
mod treemap;

use std::ffi::OsStr;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use crate::io::reveal_path;
use crate::model::{NodeRecord, ScanOptions, ScanResult};
use crate::scan::scan_path_with_progress;

use ffi::*;
use paint::{paint_window, /* table_top, loword_signed, hiword_signed, wide, ... */};
use shell::{enable_visual_styles, icon_for_node, show_shell_context_menu, copy_to_clipboard, show_error_in_thread};
use state::{DesktopState, STATE, ScanDone, ScanProgressInfo, with_state_mut};
use theme::{apply_theme, dark_brush, light_brush, DARK_MODE_ATOMIC, /* palette_* as needed */};
```

**Stylistic analog:** The existing inline `mod desktop` header at `src/main.rs:1767-1784` is the direct in-file analog. Copy the 8-line `#![allow(...)]` block verbatim. Replace `use super::*;` with the explicit `use crate::model::*;` / `use crate::scan::*;` / `use crate::io::reveal_path;` block above per CONTEXT "Established Patterns" line 87.

**`window_proc` dispatch pattern:** Per RESEARCH §"`window_proc` Dispatcher Pattern", keep verbatim — each `WM_*` arm calls a free function. Paint arms delegate to `paint::paint_window`; theme arms delegate to `theme::ctl_color`; mouse/keyboard/command/scan-message arms stay inline in `mod.rs`. No new trait, no enum-of-handlers — move-only.

**Visibility:** `pub(crate)` only on `run`. Everything else private or `pub(super)` for sibling submodules.

---

### `src/desktop/ffi.rs` (raw Win32 bindings)

**Source:** `src/main.rs:1785-2378` (one large contiguous block: type aliases → `#[repr(C)]` structs → `const`s → eight `#[link(name=...)]` `extern "system"` blocks → `IID_*` GUIDs).

**Symbols extracted:** All type aliases (`Bool`, `Dword`, `Hbrush`, `Hcursor`, `Hdc`, `Hfont`, `Hicon`, `Hinstance`, `Hmenu`, `Hgdobj`, `Hwnd`, `Lparam`, `Lresult`, `Uint`, `Wparam`, `Handle`, `UlongPtr`); all `#[repr(C)]` structs (`ACTCTXW`, `Rect`, `Point`, `PAINTSTRUCT`, `Msg`, `WndClassExW`, `BITMAPINFO`, `BITMAPINFOHEADER`, `GUID`, `ITEMIDLIST`, `CMINVOKECOMMANDINFO`, `IUnknownVtbl`, `IShellFolderVtbl`, `IContextMenuVtbl`); all consts (`WM_*` including `WM_APP`, `WM_SCAN_DONE = WM_APP + 7`, `WM_SCAN_PROGRESS = WM_APP + 8`; `WS_*`, `CS_*`, `DT_*`, `FILE_ATTRIBUTE_*`, `BS_*`, `IDC_*`, `IDI_*`, `SHGFI_*`, `MB_*`, `LR_*`, `SW_*`, `TRANSPARENT`, `TPM_RETURNCMD`, `COINIT_APARTMENTTHREADED`, `BM_GETCHECK`, `ID_SCAN_BUTTON`..`ID_DARK_CHECK`, `ID_MENU_*`); all eight `#[link(name="User32"|"Gdi32"|"Shell32"|"Comctl32"|"Dwmapi"|"Ole32"|"UxTheme"|"Kernel32")]` blocks (Kernel32 may or may not appear here — verify against the grep map; `Kernel32::GetCompressedFileSizeW` is owned by `io.rs`); `IID_IShellFolder`, `IID_IContextMenu` GUID consts.

**Cross-module imports needed:**
```rust
#![allow(dead_code)]
#![allow(non_snake_case)]
#![allow(non_upper_case_globals)]
#![allow(clippy::upper_case_acronyms)]
#![allow(clippy::too_many_arguments)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;
```

No `crate::` imports — `ffi.rs` is the leaf of the `desktop/` subtree.

**Cross-boundary message ID locality:** Per CONTEXT line 95, `WM_SCAN_DONE` and `WM_SCAN_PROGRESS` constants live HERE (not in `scan.rs`). The `scan` module never sees them — they're a Win32-namespace concern.

**Visibility:** Every item declared in this file becomes `pub(super)` (per RESEARCH Pitfall 5). The blanket-`pub(super)` policy avoids whack-a-mole on consts that sibling submodules end up using.

---

### `src/desktop/state.rs` (UI state)

**Source:** `src/main.rs:2379-2460` (`DesktopState` struct + `DesktopState::new`), `4743-4754` (`with_state_mut`), and the two boxed-payload structs `ScanDone` + `ScanProgressInfo` (currently defined inline near `start_scan_from_controls` and `finish_scan` — planner extracts the struct definitions only).

**Symbols extracted:** `DesktopState`, `DesktopState::new`, `STATE: OnceLock<Mutex<DesktopState>>`, `with_state_mut<T>(...)`, `ScanDone { result: Result<ScanResult, String>, canceled: bool }`, `ScanProgressInfo { node_count, elapsed_ms, partial_result }`.

**Cross-module imports needed:**
```rust
#![allow(dead_code)]
#![allow(non_snake_case)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::AtomicBool;

use crate::model::ScanResult;

use super::ffi::{Hbrush, Hfont, Hicon, Hmenu, Hwnd /* , whichever Hwnd children DesktopState stores */};
```

**Stylistic analog:** The `DesktopState` struct lives at `src/main.rs:2379-2411`. Move verbatim — preserve field names exactly (CONTEXT discretion: move-only, no renames).

**Rationale for putting `ScanDone`/`ScanProgressInfo` here (Q3 in RESEARCH):** Both structs cross the scan-thread → UI-thread boundary; they're transient state. `state.rs` is the natural sibling. Both are visible to `mod.rs` via `use super::state::{ScanDone, ScanProgressInfo};`.

**Visibility:** `pub(super)` on `DesktopState` (+ every field — paint and shell read them), `STATE`, `with_state_mut`, `ScanDone`, `ScanProgressInfo`.

---

### `src/desktop/theme.rs` (dark-mode + palette)

**Source:** `src/main.rs:1921-1923` (`DARK_BRUSH`, `LIGHT_BRUSH`, `DARK_MODE_ATOMIC` statics) + `3496-3552` (`apply_theme`, `update_column_widths`, `set_window_dark_mode`) + `4542-4656` (all `palette_*` functions, `dark_brush`, `light_brush`, `rgb` helper).

**Symbols extracted:** `DARK_BRUSH: OnceLock<Hbrush>`, `LIGHT_BRUSH: OnceLock<Hbrush>`, `DARK_MODE_ATOMIC: AtomicBool`, `apply_theme`, `update_column_widths`, `set_window_dark_mode`, `dark_brush()`, `light_brush()`, `palette_bg`, `palette_panel`, `palette_table`, `palette_table_alt`, `palette_header`, `palette_line`, `palette_grid`, `palette_text`, `palette_muted`, `palette_selected`, `palette_hovered`, `palette_size_bar`, `palette_percent_track`, `palette_percent_fill`, `rgb` (if present as a standalone helper).

**Cross-module imports needed:**
```rust
#![allow(dead_code)]
#![allow(non_snake_case)]
#![allow(non_upper_case_globals)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use super::ffi::*;       // Hbrush, Hwnd, Dword, CreateSolidBrush, DeleteObject, ...
use super::state::with_state_mut;
```

**Stylistic analog:** The existing `DARK_BRUSH`/`LIGHT_BRUSH` static declarations at `src/main.rs:1921-1923` use `OnceLock` + `UPPER_CASE` naming — preserved verbatim.

**Visibility:** `pub(super)` on every `palette_*` (paint.rs consumes them), `dark_brush`/`light_brush`/`apply_theme` (window_proc calls them), `DARK_MODE_ATOMIC` (window_proc reads it directly per RESEARCH `desktop::theme` row).

---

### `src/desktop/paint.rs` (GDI double-buffered rendering)

**Source:** `src/main.rs:3554-4129` (`paint_window`, `draw_toolbar_background`, `draw_table`, `draw_header`, `draw_row`, `draw_name_cell`, `draw_percent_cell`), `4503-4519` (`fill_rect`, `draw_text`, `table_top`, `columns`), `4756-4798` (`loword_signed`, `hiword_signed`, `wide`, `format_bytes_ui`, `format_count_ui`, `format_duration_ui`).

**Symbols extracted:** All of the above. Per RESEARCH Q2, the three `format_*_ui` helpers stay in `paint.rs` (not a separate `desktop/format.rs`) — they're consumed only by paint + a couple of mod.rs orchestration helpers.

**Cross-module imports needed:**
```rust
#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(non_snake_case)]
#![allow(non_upper_case_globals)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::mem::{size_of, zeroed};
use std::ptr::null;

use crate::io::epoch_ms_to_utc;
use crate::model::{NodeRecord, ScanResult};

use super::ffi::*;
use super::state::{DesktopState, with_state_mut};
use super::theme::{
    dark_brush, light_brush, palette_bg, palette_grid, palette_header, palette_hovered,
    palette_line, palette_muted, palette_panel, palette_percent_fill, palette_percent_track,
    palette_selected, palette_size_bar, palette_table, palette_table_alt, palette_text,
};
```

**Stylistic analog:** This is the canonical example for the `desktop/` submodule pattern shown in RESEARCH Code Examples line 488-510 — the planner can copy that example verbatim as the file header skeleton.

**Visibility:** `pub(super)` on `paint_window` (window_proc calls it), `table_top` (handle_mouse_click uses it), `loword_signed`/`hiword_signed`/`wide`/`fill_rect`/`draw_text` (used by shell + handlers in mod.rs), `format_bytes_ui`/`format_count_ui`/`format_duration_ui` (used by mod.rs status-text helpers).

---

### `src/desktop/shell.rs` (COM + Shell32 glue)

**Source:** `src/main.rs:2462-2494` (`enable_visual_styles` — ACTCTX manifest activation), `3458-3494` (`icon_for_node` via `SHGetFileInfoW`), `4209-4302` (`show_shell_context_menu` — IShellFolder/IContextMenu vtable dance), `4394-4428` (`copy_to_clipboard`, `show_error_in_thread`, icon-cache destruction).

**Symbols extracted:** `enable_visual_styles`, `icon_for_node`, `show_shell_context_menu`, `copy_to_clipboard`, `show_error_in_thread`, plus any icon-cache destruction helpers in the same range.

**Cross-module imports needed:**
```rust
#![allow(dead_code)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_snake_case)]
#![allow(non_upper_case_globals)]
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::{OsStr, c_void};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};

use super::ffi::*;
use super::paint::wide;     // wide(s) -> Vec<u16> helper, currently inside paint.rs per the extraction map
use super::state::with_state_mut;
```

**Stylistic analog:** The COM vtable invocation pattern in `show_shell_context_menu` (lines 4209-4302) is the canonical example for the file — copy verbatim. No safe wrappers are introduced; `unsafe` blocks stay exactly where they are.

**Visibility:** `pub(super)` on `enable_visual_styles`, `icon_for_node`, `show_shell_context_menu`, `copy_to_clipboard`, `show_error_in_thread`.

---

### `src/desktop/tabs.rs` (placeholder per RESEARCH Q1)

**Source:** none in Phase 1 — empty placeholder.

**File contents (copy verbatim):**
```rust
//! Toolbar tab strip rendering and click dispatch.
//! Empty in Phase 1; populated in Phase 8 (alongside per-tab content panels).
```

Rationale (RESEARCH Q1): the current toolbar-tab logic is three small fragments inside `draw_toolbar_background`, `handle_mouse_click`, and `resize_controls`. Extracting them in Phase 1 would inflate the commit beyond pure-move. Defer to Phase 8 when per-tab content panels make `tabs.rs` substantive.

---

### `src/desktop/treemap.rs` (placeholder per RESEARCH and CONTEXT)

**Source:** none in Phase 1 — empty placeholder.

**File contents (copy verbatim):**
```rust
//! Native-desktop treemap rendering. Empty in Phase 1; populated in Phase 8 (VIZ-01).
```

---

### `src/main.rs` (rewritten crate root)

**Source:** existing `src/main.rs:1` (the `windows_subsystem` attr stays at line 1).

**File contents after Phase 1 (copy from RESEARCH Code Examples §"Lean `src/main.rs` after Phase 1"):**
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

**Pitfall to encode (RESEARCH Pitfall 3):** the `#![cfg_attr(...)]` attribute is crate-level; it MUST be on line 1 of this file. If it accidentally moves into `cli.rs`, release builds will pop up a console window.

## Shared Patterns

### Pattern A — Top-of-file convention for top-level modules

**Source analog:** `src/main.rs:1-19`

```rust
#![cfg_attr(...)]    // crate-level only — stays in main.rs

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::env;
// ... grouped loosely by std module per CONVENTIONS.md line 59 ...

const APP_NAME: &str = "FileTree";      // const block after use block
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// types, then fns
```

**Apply to:** `model.rs`, `io.rs`, `scan.rs`, `analytics.rs`, `export.rs`, `server.rs`, `cli.rs`. Each file gets a trimmed `use` block (only the imports it actually needs), an optional `const` block, then types, then fns.

---

### Pattern B — `desktop/` submodule file header

**Source analog:** `src/main.rs:1767-1784` (the inline `mod desktop` opening)

```rust
#![allow(dead_code)]
#![allow(clippy::manual_is_multiple_of)]
#![allow(clippy::manual_range_contains)]
#![allow(clippy::too_many_arguments)]
#![allow(clippy::upper_case_acronyms)]
#![allow(non_upper_case_globals)]
#![allow(non_snake_case)]
#![allow(unsafe_op_in_unsafe_fn)]

// targeted std imports
use std::ffi::c_void;
use std::ptr::null_mut;

// crate imports (replaces `use super::*;` from the inline form)
use crate::model::NodeRecord;

// sibling-submodule imports
use super::ffi::*;
use super::state::{DesktopState, with_state_mut};
```

**Apply to:** every `desktop/*.rs` file in Phase 1. The 8-allow baseline is **mandatory** on every desktop submodule per RESEARCH Pitfall 1 and §"Inline `mod desktop` `#![allow(...)]` Audit" — start safe, tighten later. CONTEXT "Established Patterns" line 88 locks the explicit-`use crate::` pattern over `use super::*` for multi-module crates.

---

### Pattern C — `pub(crate)` visibility for cross-module items

**Source analog:** no existing precedent in the codebase (today everything is private — single file, no `pub` exports at the crate root).

**Policy (from CONTEXT Discretion + RESEARCH §"`pub(crate)` Visibility Matrix"):**
- `pub(crate)` on every item that crosses a module boundary (callers listed in the matrix in RESEARCH).
- Private on items used only inside the owning module.
- `pub(super)` on items shared only between sibling submodules in `desktop/` (do not let them escape `desktop/`).
- No bare `pub` anywhere — there is no public API (no `lib.rs`, `publish = false`).

**Apply to:** every extraction commit. The planner's per-file task should explicitly enumerate the `pub(crate)` items per the RESEARCH matrix; the executor adds them as the symbol is lifted.

---

### Pattern D — Builder pattern preservation

**Source analog:** `push_json_string(&mut output, value)` — `src/main.rs` `push_*` family (per CONVENTIONS.md line 128, "Functions that build output take `&mut String` as their first argument").

**Apply to:** `export.rs` — the `push_json_string`, `push_csv_field`, `push_id_array` helpers move verbatim with this signature. `analytics::exact_duplicates_json` calls `push_json_string` and so does `server::handle_client` (error responder). Preserve the pattern; do not refactor to return-`String` form.

---

### Pattern E — Test colocation

**Source analog:** `src/main.rs:4800-5054` — single `#[cfg(test)] mod tests` block.

**Policy:** Each `#[cfg(test)] mod tests` colocates with its target module. Move tests in the **same commit** as the symbol they exercise so every commit ends green.

**Apply to (per RESEARCH §"Tests" mapping):**
- `src/io.rs`: `wildcard_supports_star_and_question`, `epoch_formats_unix_start`
- `src/export.rs`: `csv_fields_are_escaped`
- `src/scan.rs`: `make_test_node` helper + `aggregate_nodes_sums_children_into_parent`, `snapshot_result_has_correct_aggregation`, `snapshot_releases_nodes_lock_before_aggregation`, `active_guard_decrements_active_and_sets_done_when_empty`, `active_guard_does_not_set_done_when_dirs_remain`, `scan_path_with_progress_sends_partial_results`
- No tests move into `analytics.rs`, `server.rs`, `cli.rs`, `desktop/*` — they have none today.

---

### Pattern F — Empty-file placeholder for locked module names

**Source analog:** none in the codebase today; per RESEARCH Assumption A2, an empty `.rs` file with only a doc comment is valid Rust.

**Apply to:** `src/diff.rs`, `src/desktop/tabs.rs`, `src/desktop/treemap.rs`. Each contains a single `//!` doc-comment line and nothing else. If `cargo clippy --all-targets -- -D warnings` complains on the empty form (it shouldn't), the fallback is `pub(crate) fn _placeholder() {}` (or `pub(super)` inside `desktop/`). The planner's task for each placeholder commit should `cargo clippy` first and add the fallback only if needed.

## No Analog Found

No new file in Phase 1 lacks an analog. Every "new" file is either a verbatim lift from a known line range in `src/main.rs` (14 files), or a locked-name placeholder with a single doc comment (3 files: `diff.rs`, `desktop/tabs.rs`, `desktop/treemap.rs`).

## Cross-Module Dependency Order (extraction order)

Per CONTEXT D-05 bottom-up. Each row's "depends on" column lists the modules whose `pub(crate)` items must be extracted **before** this one for that commit to compile without main.rs reach-back.

| Commit | New module | Depends on (must already be extracted) |
|--------|------------|----------------------------------------|
| 1 | `model` | (none — leaf) |
| 2 | `io` | (none — leaf; uses `std` only) |
| 3 | `scan` | `model`, `io` |
| 4 | `analytics` | `model`, `export::push_json_string` (forward dep — see analytics row above) |
| 5 | `export` | `model`, `io`, `analytics` |
| 6 | `server` | `model`, `io`, `scan`, `analytics`, `export` |
| 7 | `cli` | `model`, `io`, `scan`, `export`, `server` |
| 8 | `diff` (stub) | (none) |
| 9 | `desktop/state` | `model` |
| 10 | `desktop/ffi` | (none — leaf within `desktop/`) |
| 11 | `desktop/theme` | `desktop/ffi`, `desktop/state` |
| 12 | `desktop/paint` | `model`, `io`, `desktop/ffi`, `desktop/state`, `desktop/theme` |
| 13 | `desktop/shell` | `desktop/ffi`, `desktop/state`, `desktop/paint` (for `wide` helper) |
| 14 | `desktop/tabs` + `desktop/treemap` stubs | (none) |
| 15 | final `desktop/mod.rs` cleanup | all of `desktop/*`, plus `crate::model`, `crate::scan`, `crate::io` |

The one forward-dependency edge is **commit 4 (`analytics`) → `export::push_json_string`**, called from `exact_duplicates_json`. RESEARCH §"Per-Commit Green-Build Invariants" calls this out; the planner's commit-4 task should either:
- (a) leave the call as `crate::push_json_string` while it still lives in `main.rs` at commit 4, and update the import to `crate::export::push_json_string` in commit 5, or
- (b) swap the extraction order to do `export` before `analytics` — this works because `export`'s call into `analytics` (`scan_result_to_json` calls `top_file_ids` etc.) can route through still-in-main symbols.

Recommend (a) — it preserves the CONTEXT D-05 order verbatim and keeps the commit-4 diff small.

## Metadata

**Analog search scope:** `src/main.rs` only — this is a single-file project today.
**Files scanned:** 1 (`src/main.rs`, ~5055 lines) + 4 planning docs (CONTEXT, RESEARCH, ARCHITECTURE, CONVENTIONS).
**Pattern extraction date:** 2026-05-22

## PATTERN MAPPING COMPLETE
