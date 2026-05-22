<!-- refreshed: 2026-05-22 -->
# Architecture

**Analysis Date:** 2026-05-22

## System Overview

```text
┌──────────────────────────────────────────────────────────────┐
│                        Entry Point                           │
│                     `src/main.rs:main()`                     │
└──────────┬───────────────────┬──────────────────────────────┘
           │                   │                    │
           ▼                   ▼                    ▼
┌──────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ desktop mode │   │   server mode    │   │   scan (CLI)    │
│ Win32 native │   │ HTTP on 127.0.0.1│   │  JSON / CSV out │
│`desktop::run`│   │ `run_server()`   │   │`run_scan_command`│
└──────┬───────┘   └────────┬─────────┘   └────────┬────────┘
       │                    │                       │
       │            ┌───────▼────────┐              │
       │            │  handle_client │              │
       │            │  HTTP router   │              │
       │            │ `src/main.rs`  │              │
       │            └───────┬────────┘              │
       │                    │                       │
       └────────────────────┼───────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                Filesystem Scan Engine                        │
│   `scan_path_with_progress()` / `worker_loop()`             │
│   Multi-threaded BFS with `Arc<WorkerShared>` + Condvar     │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│            In-Memory Node Tree  (`Vec<NodeRecord>`)          │
│          Aggregated via `aggregate_nodes()`                  │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
       JSON payload    CSV payload  HTML snapshot
  `scan_result_to_json` `scan_result_to_csv`  (client-side)
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│          Browser UI  (`web/app.js`, `web/index.html`)        │
│  Vanilla JS: tree table, treemap, extensions, duplicates     │
│  Served as static strings embedded in the binary             │
└──────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `main()` | CLI parsing, mode dispatch | `src/main.rs:119` |
| `run_desktop()` | Launches Win32 native window (Windows-only) | `src/main.rs:183` |
| `run_server()` | Binds TCP, spawns per-connection threads | `src/main.rs:241` |
| `run_scan_command()` | Headless scan with JSON/CSV output | `src/main.rs:200` |
| `scan_path_with_progress()` | Core scan orchestrator; spawns workers | `src/main.rs:272` |
| `worker_loop()` | BFS worker; pops directories from shared queue | `src/main.rs:428` |
| `scan_directory_job()` | Reads one directory; creates `NodeRecord`s | `src/main.rs:472` |
| `aggregate_nodes()` | Bottom-up rollup of size/files/folders/errors | `src/main.rs:624` |
| `handle_client()` | HTTP request parser and route dispatcher | `src/main.rs:673` |
| `scan_result_to_json()` | Serializes `ScanResult` to JSON string | `src/main.rs:996` |
| `scan_result_to_csv()` | Serializes `ScanResult` to CSV string | `src/main.rs:1149` |
| `exact_duplicates_json()` | FNV-1a hashes candidate files, groups exact dupes | `src/main.rs:1242` |
| `desktop::run()` | Win32 message loop, custom-painted list, tabs | `src/main.rs:2496` |
| `init()` (JS) | Fetches config + drives, auto-starts scan | `web/app.js:65` |
| `startScan()` (JS) | Calls `/api/scan`, feeds `ingestData()` | `web/app.js:152` |
| `renderAll()` (JS) | Dispatches all render sub-functions | `web/app.js:197` |
| `layoutTreemap()` (JS) | Recursive binary-split treemap layout | `web/app.js:489` |

## Pattern Overview

**Overall:** Monolith single-binary desktop app with two independent UIs

**Key Characteristics:**
- The entire application ships as a single Rust binary with no external runtime.
- Web assets (`web/index.html`, `web/styles.css`, `web/app.js`) are embedded at compile time via `include_str!` macros (`src/main.rs:16-18`) and served over a local TCP socket. No framework, bundler, or npm dependency exists.
- The desktop mode (`desktop` module, `src/main.rs:1767`) implements a raw Win32 window using `unsafe extern "system"` FFI calls to `User32`, `Gdi32`, `Shell32`, `Comctl32`, `Dwmapi`, and `Ole32` — no external windowing crate is used.
- The filesystem scanner runs N worker threads (default: `available_parallelism().clamp(2,32)`) communicating through `Arc<WorkerShared>` with a `Mutex<VecDeque>` + `Condvar` work queue.
- The `ScanResult` node tree is a flat `Vec<NodeRecord>` where relationships are encoded as `id`/`parent` integer indices, not pointers or `Box`. This is mirrored exactly in the browser's JS `state.nodes` array.

## Layers

**CLI / Mode Dispatch:**
- Purpose: Parse argv, choose `desktop`, `serve`, or `scan` mode
- Location: `src/main.rs:119-163`
- Contains: `main()`, `print_usage()`, `run_desktop()`, `run_server()`, `run_scan_command()`
- Depends on: scan engine, desktop module, HTTP server
- Used by: OS process entry point

**Filesystem Scan Engine:**
- Purpose: Multi-threaded BFS traversal producing a `ScanResult`
- Location: `src/main.rs:268-671`
- Contains: `scan_path_with_progress()`, `worker_loop()`, `scan_directory_job()`, `add_node()`, `aggregate_nodes()`, `WorkerShared`, `QueueState`, `ActiveGuard`
- Depends on: `std::fs`, platform helpers (`platform_allocated_size`, `is_hidden_entry`)
- Used by: HTTP server routes, CLI scan command, desktop scan thread

**HTTP Server / API Layer:**
- Purpose: Embedded TCP-based HTTP/1.1 server; serves static web assets and REST-style API
- Location: `src/main.rs:241-874`
- Contains: `run_server()`, `handle_client()`, route handlers for `/api/scan`, `/api/drives`, `/api/config`, `/api/export.csv`, `/api/export.json`, `/api/duplicates`, `/api/reveal`, `/api/open`, `/api/delete`, `/api/properties`
- Depends on: scan engine, serializers, `AppState`
- Used by: browser UI (via `fetch()`), `run_server()` entry point

**Serialization / Analytics:**
- Purpose: Convert `ScanResult` to JSON/CSV and compute analytics (extension stats, age buckets, duplicate candidates)
- Location: `src/main.rs:996-1451`
- Contains: `scan_result_to_json()`, `scan_result_to_csv()`, `extension_stats()`, `age_stats()`, `duplicate_candidates()`, `top_file_ids()`, `largest_dir_ids()`, `exact_duplicates_json()`, `fnv1a_file()`
- Depends on: `ScanResult`, `NodeRecord`
- Used by: HTTP routes, CLI scan command

**Platform Abstraction:**
- Purpose: Windows-specific filesystem attributes (hidden flag, compressed size, OS shell operations)
- Location: `src/main.rs:1683-1735`
- Contains: `is_hidden_entry()`, `platform_allocated_size()`, `windows_compressed_file_size()` (calls `Kernel32::GetCompressedFileSizeW`)
- Depends on: `std::os::windows::fs::MetadataExt`, Win32 FFI
- Used by: scan engine

**Native Desktop Module (`desktop` mod):**
- Purpose: Full Win32 custom-painted desktop window (Windows-only, `#[cfg(windows)]`)
- Location: `src/main.rs:1767-end`
- Contains: `desktop::run()`, `window_proc()`, `DesktopState`, all Win32 FFI declarations, custom list rendering with GDI double-buffering, tabs (Summary/Extensions/Top/Duplicates/Errors), treemap tile rendering, Shell context menu via `IShellFolder` / `IContextMenu` COM vtables
- Depends on: scan engine, `Arc<AtomicBool>` cancel token, `PostMessageW` for async scan completion (`WM_SCAN_DONE`, `WM_SCAN_PROGRESS`)
- Used by: `run_desktop()` on Windows

**Web UI:**
- Purpose: Browser-based single-page app rendering scan results; communicates with the HTTP server
- Location: `web/app.js` (821 lines), `web/index.html` (144 lines), `web/styles.css`
- Contains: client-side state machine (`state` object), `startScan()`, `renderAll()`, `renderRows()`, `renderTreemap()`, `renderExtensions()`, `renderDuplicates()`, `layoutTreemap()` (recursive binary-split), `exportHtmlSnapshot()`
- Depends on: Fetch API, DOM APIs
- Used by: Any browser pointed at `http://127.0.0.1:<port>`

## Data Flow

### Server Mode — Primary Scan Request

1. Browser calls `startScan()` → `GET /api/scan?path=...&threads=8&hidden=1` (`web/app.js:166`)
2. `handle_client()` routes to `/api/scan` handler (`src/main.rs:726`)
3. `scan_path()` → `scan_path_with_progress()` spawns N worker threads (`src/main.rs:272`)
4. `worker_loop()` processes BFS queue; `scan_directory_job()` reads each directory, calls `add_node()` under lock (`src/main.rs:428-583`)
5. Main loop polls every 1500ms for progress; breaks when `queue.done == true` (`src/main.rs:347-372`)
6. `snapshot_scan_result()` aggregates via `aggregate_nodes()` then sorts children by size (`src/main.rs:386-411`)
7. `scan_result_to_json()` computes analytics (top files, extension stats, age buckets, duplicate candidates) and serializes `ScanResult` as one JSON string (`src/main.rs:996`)
8. HTTP handler writes response; browser `ingestData()` populates `state.nodes` and `state.nodeById` Map (`web/app.js:187`)
9. `renderAll()` dispatches all six render functions (`web/app.js:197`)

### Desktop Mode — Scan Flow

1. `desktop::run()` registers Win32 class, creates HWND, starts message loop (`src/main.rs:2496`)
2. `start_scan_from_controls()` spawns background thread calling `scan_path_with_progress()` with cancel `AtomicBool`
3. Progress thread posts `WM_SCAN_PROGRESS` messages to HWND every 1500ms
4. On completion the scan thread posts `WM_SCAN_DONE` (custom `WM_APP+7`) with boxed `ScanDone` in LPARAM
5. `window_proc()` handles `WM_SCAN_DONE`: unpacks result into `DesktopState.current_scan`, calls `refresh_visible_rows()`, `InvalidateRect()` (`src/main.rs:2576`)
6. `WM_PAINT` → `paint_window()` uses GDI double-buffering (`CreateCompatibleDC` / `BitBlt`) to custom-render all rows and tab panels

### Exact Duplicate Scan (On-Demand)

1. Browser clicks "Exact hash scan" → `runExactDuplicateScan()` calls `GET /api/duplicates?minSize=N` (`web/app.js:620`)
2. `exact_duplicates_json()` groups files by size, FNV-1a hashes each candidate file in 1MB chunks (`src/main.rs:1242-1310`)
3. Groups sorted by reclaimable waste, truncated to 100
4. Browser `renderDuplicates()` displays results with path buttons

**State Management:**
- **Server mode:** `Arc<AppState>` holds `initial_path` and `Mutex<Option<Arc<ScanResult>>>` for the last scan. The last scan is reused by `/api/export.*` and `/api/duplicates` without re-scanning.
- **Desktop mode:** Single `OnceLock<Mutex<DesktopState>>` global (`STATE`) holds all Win32 HWNDs and scan state. Dark-mode flag is also a global `AtomicBool` (`DARK_MODE_ATOMIC`).
- **Browser:** Plain JS `state` object (module-level) — not reactive; mutations trigger explicit `render*()` calls.

## Key Abstractions

**`NodeRecord`:**
- Purpose: Represents one file or directory in the scan tree
- Examples: `src/main.rs:31-49`
- Pattern: Flat struct; tree relationships are `id: usize` / `parent: Option<usize>` indices into the same `Vec<NodeRecord>`. Children are cached as `Vec<usize>`.

**`ScanOptions`:**
- Purpose: Input parameters for a scan (root path, thread count, hidden/links/excludes/max-depth)
- Examples: `src/main.rs:21-28`
- Pattern: Value type cloned into `WorkerShared`; shared immutably by all scan workers.

**`WorkerShared`:**
- Purpose: Data shared across scan worker threads under locks
- Examples: `src/main.rs:75-82`
- Pattern: `Arc<WorkerShared>` cloned per thread; `Mutex<Vec<NodeRecord>>` for node accumulation, `Mutex<QueueState>` + `Condvar` for the BFS work queue, `Arc<AtomicBool>` cancel flag.

**`AppState`:**
- Purpose: HTTP server per-connection shared state (server mode only)
- Examples: `src/main.rs:85-88`
- Pattern: `Arc<AppState>` cloned per connection thread.

**`DesktopState`:**
- Purpose: All mutable state for the Win32 native window
- Examples: `src/main.rs:2379-2411`
- Pattern: Stored in `OnceLock<Mutex<DesktopState>>`. The helper `with_state_mut(|state| ...)` acquires the lock for each mutation.

## Entry Points

**`main()` (binary entry):**
- Location: `src/main.rs:119`
- Triggers: OS process start
- Responsibilities: Parse argv, dispatch to `run_desktop()`, `run_server()`, or `run_scan_command()`

**`desktop::run()` (Win32 desktop):**
- Location: `src/main.rs:2496`
- Triggers: `main()` with no args or `desktop` / `gui` subcommand on Windows
- Responsibilities: Register window class, create HWND, enter Win32 message loop

**`run_server()` (HTTP server):**
- Location: `src/main.rs:241`
- Triggers: `main()` with `serve` subcommand
- Responsibilities: Bind `127.0.0.1:<port>`, accept connections, spawn per-connection threads

**`init()` (browser JS):**
- Location: `web/app.js:65`
- Triggers: `DOMContentLoaded` event
- Responsibilities: Fetch `/api/config` and `/api/drives`, populate path input, auto-start scan if path is set

## Architectural Constraints

- **Threading model:** Scan engine uses N OS threads (configurable, clamped 1-64) sharing `Arc<WorkerShared>` with mutex-guarded state. The HTTP server spawns one thread per TCP connection. The Win32 desktop uses a single UI thread (Win32 STA / `COINIT_APARTMENTTHREADED`) plus a dedicated scan background thread per scan.
- **Global state:** Two `OnceLock` globals in the `desktop` module: `STATE: OnceLock<Mutex<DesktopState>>` and `DARK_BRUSH` / `LIGHT_BRUSH` (`src/main.rs:1920-1923`). Also `DARK_MODE_ATOMIC: AtomicBool`. No globals in server/scan modes.
- **Circular imports:** None — single-file codebase (`src/main.rs`), `desktop` is an inline submodule using `super::*`.
- **No external crates:** `[dependencies]` in `Cargo.toml` is empty. All JSON serialization, HTTP parsing, wildcard matching, FNV-1a hashing, and Win32 FFI are hand-written.
- **Windows-only desktop:** `run_desktop()` returns `Err(Unsupported)` on non-Windows. Server and CLI modes are cross-platform.
- **Assets embedded at compile time:** `include_str!("../web/index.html")` etc. (`src/main.rs:16-18`). Changing web assets requires recompiling.

## Anti-Patterns

### JSON serialized with manual string building

**What happens:** `scan_result_to_json()` constructs the entire JSON payload by `push_str` into a `String` with hand-written escape logic (`push_json_string`) rather than using a serialization library (`src/main.rs:996-1147`).
**Why it's wrong here:** Any new field added to `NodeRecord` requires manual updates to both the serializer and the CSV writer. The escape function (`push_json_string`) does not handle surrogate pairs or uncommon Unicode correctly. The CSV writer has a similar bespoke implementation (`src/main.rs:1149-1192`).
**Do this instead:** If adding fields or output formats, add them to the existing hand-built serializers following the exact same pattern already established — do not mix in a third-party serde dependency without updating `Cargo.toml`.

### Scan blocks the HTTP response thread

**What happens:** The `/api/scan` route calls `scan_path()` synchronously inside the per-connection thread (`src/main.rs:753`). The HTTP connection stays open until the scan finishes; there is no streaming or cancellation from the browser side (only client-side `AbortController` which drops the connection, but the server scan continues).
**Why it's wrong:** Long-running scans block the connection thread. A second browser tab calling `/api/scan` simultaneously will run two concurrent scans.
**Do this instead:** Accept this constraint when reading the code — it is by design for simplicity. Do not add cancellation to the server path without also wiring up the `cancel: Arc<AtomicBool>` in the server-side scan call.

## Error Handling

**Strategy:** `io::Result<()>` / `io::Result<ScanResult>` propagated via `?` to the top-level `main()`. HTTP handler converts errors to JSON `{"error":"..."}` with a 400 status. Scan errors (permission denied, etc.) are collected as `Vec<ScanError>` inside `WorkerShared` and included in the response rather than aborting the scan.

**Patterns:**
- Scan errors: `add_scan_error()` records path + message and increments the parent node's `errors` counter (`src/main.rs:607-622`)
- HTTP errors: `respond_text()` / `respond_json()` with appropriate status codes (`src/main.rs:904-944`)
- Desktop errors: `MessageBoxW` alert on fatal failure; scan errors shown in the Errors tab
- Top-level fatal: `eprintln!` + `std::process::exit(1)` in `main()`

## Cross-Cutting Concerns

**Logging:** None beyond `eprintln!` for request failures and server startup message. No structured logging library.
**Validation:** Input paths are validated by `Path::new(&path).exists()` at scan start (`src/main.rs:280`). Query parameters are parsed with `.parse::<T>().ok()` — invalid values silently fall back to defaults.
**Authentication:** None. The HTTP server binds only to `127.0.0.1` (loopback). There is no auth on any API endpoint.

---

*Architecture analysis: 2026-05-22*
