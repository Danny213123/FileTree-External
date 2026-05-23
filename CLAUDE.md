<!-- GSD:project-start source:PROJECT.md -->
## Project

**FileTree**

A standalone Windows disk-usage explorer written in Rust with a native Win32 desktop UI and an optional embedded web UI. It scans directories with a multi-threaded scanner, visualizes what's eating disk space, and lets the user find and clean up bloat. Built for personal use by the author.

**Core Value:** **Point at a folder, see what's taking space, and clean it up — fast, on a single Windows machine, with no install footprint beyond a single .exe.** Scanning, visualizing, and cleanup must all feel cohesive in v1.

### Constraints

- **Tech stack**: Rust edition 2024, zero external Rust crates — `Cargo.toml` `[dependencies]` is empty by design. Any new dependency is a Key Decision with rationale.
- **Tech stack**: Native UI via raw Win32 FFI (`User32`, `Gdi32`, `Shell32`, `Comctl32`, `Dwmapi`, `Ole32`, `UxTheme`, `Kernel32`). No GUI toolkit (no Tauri / egui / iced).
- **Tech stack**: Web assets embedded at compile time via `include_str!`. No bundler, no npm. Frontend stays vanilla JS / HTML / CSS.
- **Platform**: Windows 10/11 for the desktop surface. `serve` and `scan` modes stay cross-platform.
- **Distribution**: Single standalone `.exe`, no installer, no auto-update, no telemetry.
- **Performance**: Scan UI must remain responsive while workers are scanning (progress already streams every 1500 ms — preserve that). Cleanup operations must not block the message loop.
- **Safety**: Any destructive operation defaults to the Recycle Bin and requires an explicit confirmation dialog. Permanent delete is opt-in per action.
- **IP**: "Inspired-by" only. No copying of TreeSize icons, color schemes, exact copy strings, or screenshots. Distinct visual identity.
- **Budget**: Personal-time project; v1 is sequenced so something shippable lands at every phase boundary.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- Rust (edition 2024) - All backend logic, HTTP server, filesystem scanning, and Windows desktop GUI (`src/main.rs`)
- HTML5 - UI markup (`web/index.html`)
- CSS3 - Styling (`web/styles.css`)
- Vanilla JavaScript (ES2020+) - Frontend UI logic, tree rendering, treemap, export (`web/app.js`)
## Runtime
- Native binary (no runtime VM) — compiled to a standalone `.exe` for Windows
- Web assets embedded at compile time via `include_str!` macros in `src/main.rs` (lines 17–19)
- Cargo (Rust toolchain, managed by `dtolnay/rust-toolchain@stable` in CI)
- Lockfile: `Cargo.lock` present and committed (version 4 format)
## Frameworks
- No external Rust crates — zero dependencies declared in `Cargo.toml` `[dependencies]` section
- Custom HTTP/1.1 server built on `std::net::TcpListener` / `TcpStream` — no web framework (Actix, Axum, etc.)
- Custom Win32 desktop GUI via raw FFI `extern "system"` bindings — no GUI toolkit (Tauri, egui, etc.)
- No JavaScript framework — plain DOM APIs with `fetch`, `AbortController`, `navigator.clipboard`
- No bundler (Webpack, Vite, etc.) — assets served as static strings embedded in the binary
- Cargo's built-in test runner (`cargo test`)
- `cargo build --release` — single-step native build, output in `target/release/`
- No build scripts or `build.rs`
## Key Dependencies
- None — `Cargo.lock` lists only the `filetree 0.1.0` package itself with no transitive dependencies
- Windows system DLLs linked statically via `#[link(name = "...")]`:
## Configuration
- No `.env` files detected
- No external configuration files at runtime — all defaults are hardcoded (e.g., default port `7878`, default thread count from `std::thread::available_parallelism`)
- `Cargo.toml` — package manifest (`src/main.rs` is the sole source file)
- `Cargo.lock` — dependency lockfile
- `.gitattributes` — line ending normalization
- `.gitignore` — excludes `/target`, `*.exe`, `*.log`, `*.pdb`
- `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` — release builds suppress the console window
## Platform Requirements
- Rust stable toolchain (edition 2024 requires Rust 1.85+)
- Windows OS required for the native desktop mode; `serve` and `scan` CLI modes compile and run on any OS
- `rustfmt` and `clippy` components required (installed by CI)
- Windows 10/11 (Win32 APIs: DWM, Shell, Common Controls v6)
- No installer or packaging tooling configured — distributes as a single `.exe`
- Deployment target: standalone Windows executable
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- Single flat module: all Rust lives in `src/main.rs`; the Windows desktop subsystem is an inline `mod desktop { ... }` block within the same file
- Web assets use `lowercase.ext` — `web/app.js`, `web/styles.css`, `web/index.html`
- `snake_case` throughout — e.g., `scan_path`, `aggregate_nodes`, `push_json_string`, `epoch_ms_to_utc`
- Private helpers that generate output are named `push_*` (e.g., `push_json_string`, `push_csv_field`, `push_id_array`)
- Render-style helpers named `*_to_*` (e.g., `scan_result_to_json`, `scan_result_to_csv`)
- Boolean predicates named `is_*` / `has_*` / `should_*` (e.g., `is_hidden_entry`, `has_flag`, `should_exclude`, `should_recurse`)
- `PascalCase` — `NodeRecord`, `ScanOptions`, `ScanResult`, `WorkerShared`, `AppState`, `QueueState`, `ActiveGuard`
- Windows API types inside `mod desktop` use `PascalCase` aliases with short names matching Win32 conventions: `Hwnd`, `Hdc`, `Dword`, `Wparam`, `Lresult`
- Win32 constants use `UPPER_SNAKE_CASE` matching Win32 naming: `WM_CREATE`, `WS_CHILD`, `FILE_ATTRIBUTE_HIDDEN`
- `snake_case` for locals; loop variables mirror field names (`id`, `node`, `child`, `error`)
- Iterator accumulator variables use short names: `left` / `right` in sort closures (not `a` / `b`)
- Generic index variables named `index` (not `i`)
- Functions: `camelCase` — `startScan`, `ingestData`, `renderRows`, `handleRowClick`, `collectVisibleRows`
- DOM element cache: single `const els = { ... }` object with camelCase keys matching element IDs
- Global mutable state: single `const state = { ... }` object
- Render functions prefixed `render*` — `renderAll`, `renderRows`, `renderTreemap`, `renderExtensions`
- Event handler functions prefixed `handle*` — `handleRowClick`, `handleRowDblClick`, `handleContextAction`
- Format helpers prefixed `format*` — `formatBytes`, `formatCount`, `formatDate`, `formatDuration`, `formatMetric`
- HTML-building helpers suffixed `*Html` — `rowHtml`, `tileHtml`, `statHtml`, `duplicateGroupHtml`
- Classes use `kebab-case` — `.name-cell`, `.bar-row`, `.item-row`, `.tab-panel`, `.context-menu`
- CSS custom properties (variables) used inline for layout: `--depth`, `--bar-width`, `--percent`, `--bar`
## Code Style
- Rust: `rustfmt` with default settings (Rust 2024 edition)
- JavaScript: no separate formatter configured (no `.prettierrc`, no `biome.json`); style is consistent with 2-space indentation, trailing commas in multi-line arrays/objects, double quotes for strings
- CI enforces `cargo fmt --check` before build — see `.github/workflows/ci.yml` line 22
- Rust: `cargo clippy --all-targets -- -D warnings` (warnings are errors in CI)
- Inside `mod desktop`, several clippy lints are suppressed with module-level `#![allow(...)]` attributes because the Win32 bindings require non-idiomatic naming:
- No ESLint or JavaScript linter is configured
## Import Organization
- All `use` declarations are at the top of the file, before any `fn` or `struct` definitions
- Standard library only — no third-party crates (confirmed: `[dependencies]` in `Cargo.toml` is empty)
- Grouped loosely by std module: `collections` → `env` → `fs` / `io` → `net` → `path` → `process` → `sync` → `thread` → `time`
- Inside `mod desktop`, a `use super::*;` wildcard is followed by targeted `std` imports
- No ES module imports — plain browser script loaded via `<script src="/app.js">` at bottom of `web/index.html`
- All state, element references, and helpers are in module scope (no bundler, no imports)
## Error Handling
- Top-level entry points return `io::Result<()>` and pattern-match with `if let Err(error)`, then `eprintln!` + `std::process::exit(1)`
- Internal functions propagate errors with `?` operator throughout
- Mutex locks always use `.expect("... lock poisoned")` — panicking on poisoned locks is intentional (the app treats this as an unrecoverable state)
- Scan errors (e.g., unreadable directories) are collected non-fatally into `Vec<ScanError>` via `add_scan_error()` and surfaced in the API response — they do not abort the scan
- HTTP route handlers return `io::Result<()>` and send HTTP 400 responses for bad inputs rather than panicking:
- `async/await` with `try/catch` for all `fetch` calls
- `AbortError` is explicitly filtered out (cancel is not treated as failure):
- `getJson()` helper throws on non-ok responses; callers wrap in `try/catch`
- User-facing errors shown via `alert()` for destructive actions (delete), `setStatus()` for informational failures
## Logging
- No logging framework — `eprintln!` for errors and `println!` for informational server output only
- Server logs: `eprintln!("request failed: {error}")` and `eprintln!("connection failed: {error}")` in `run_server`
- No structured logging, no log levels
- No logging framework — status updates go to `els.status` (the `#statusText` DOM element) via `setStatus()`
- No `console.log` calls in production code
## Comments
- Used sparingly; comments explain non-obvious invariants, not what code does
- Inline comments document threading constraints and lock ordering:
- Test comments explain what the assertion is verifying when it is not self-evident
- No `///` doc comments anywhere — this is a single-binary application, not a library
## Function Design
- Business-logic functions are generally small (under 30 lines); the HTTP router `handle_client` is long by necessity (one `match` arm per route)
- Helper functions are extracted for reuse: `push_json_string`, `push_csv_field`, `push_id_array`, `percent_decode`, `wildcard_match`
- Rust functions take the minimum needed; shared state is passed as `&Arc<WorkerShared>` or `&AppState` (never as globals)
- Functions that build output take `&mut String` as their first argument (builder pattern): `push_json_string(&mut output, value)`
- Pure string-building functions return `String`
- Fallible filesystem functions return `io::Result<T>`
- Predicate helpers return `bool`
- No use of `unwrap()` outside of tests — production code uses `?`, `.expect()`, or explicit `match`
## Module Design
- Single file (`src/main.rs`, ~5055 lines); the Windows desktop UI is isolated in a `#[cfg(windows)] mod desktop { ... }` inline module
- No `pub` exports — everything is crate-internal (binary crate, `publish = false`)
- No barrel files or re-exports
- Single file (`web/app.js`, ~822 lines) with no module system
- Logically grouped by concern: state/DOM init → event binding → scan/data → render functions → utilities
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## System Overview
```text
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
- The entire application ships as a single Rust binary with no external runtime.
- Web assets (`web/index.html`, `web/styles.css`, `web/app.js`) are embedded at compile time via `include_str!` macros (`src/main.rs:16-18`) and served over a local TCP socket. No framework, bundler, or npm dependency exists.
- The desktop mode (`desktop` module, `src/main.rs:1767`) implements a raw Win32 window using `unsafe extern "system"` FFI calls to `User32`, `Gdi32`, `Shell32`, `Comctl32`, `Dwmapi`, and `Ole32` — no external windowing crate is used.
- The filesystem scanner runs N worker threads (default: `available_parallelism().clamp(2,32)`) communicating through `Arc<WorkerShared>` with a `Mutex<VecDeque>` + `Condvar` work queue.
- The `ScanResult` node tree is a flat `Vec<NodeRecord>` where relationships are encoded as `id`/`parent` integer indices, not pointers or `Box`. This is mirrored exactly in the browser's JS `state.nodes` array.
## Layers
- Purpose: Parse argv, choose `desktop`, `serve`, or `scan` mode
- Location: `src/main.rs:119-163`
- Contains: `main()`, `print_usage()`, `run_desktop()`, `run_server()`, `run_scan_command()`
- Depends on: scan engine, desktop module, HTTP server
- Used by: OS process entry point
- Purpose: Multi-threaded BFS traversal producing a `ScanResult`
- Location: `src/main.rs:268-671`
- Contains: `scan_path_with_progress()`, `worker_loop()`, `scan_directory_job()`, `add_node()`, `aggregate_nodes()`, `WorkerShared`, `QueueState`, `ActiveGuard`
- Depends on: `std::fs`, platform helpers (`platform_allocated_size`, `is_hidden_entry`)
- Used by: HTTP server routes, CLI scan command, desktop scan thread
- Purpose: Embedded TCP-based HTTP/1.1 server; serves static web assets and REST-style API
- Location: `src/main.rs:241-874`
- Contains: `run_server()`, `handle_client()`, route handlers for `/api/scan`, `/api/drives`, `/api/config`, `/api/export.csv`, `/api/export.json`, `/api/duplicates`, `/api/reveal`, `/api/open`, `/api/delete`, `/api/properties`
- Depends on: scan engine, serializers, `AppState`
- Used by: browser UI (via `fetch()`), `run_server()` entry point
- Purpose: Convert `ScanResult` to JSON/CSV and compute analytics (extension stats, age buckets, duplicate candidates)
- Location: `src/main.rs:996-1451`
- Contains: `scan_result_to_json()`, `scan_result_to_csv()`, `extension_stats()`, `age_stats()`, `duplicate_candidates()`, `top_file_ids()`, `largest_dir_ids()`, `exact_duplicates_json()`, `fnv1a_file()`
- Depends on: `ScanResult`, `NodeRecord`
- Used by: HTTP routes, CLI scan command
- Purpose: Windows-specific filesystem attributes (hidden flag, compressed size, OS shell operations)
- Location: `src/main.rs:1683-1735`
- Contains: `is_hidden_entry()`, `platform_allocated_size()`, `windows_compressed_file_size()` (calls `Kernel32::GetCompressedFileSizeW`)
- Depends on: `std::os::windows::fs::MetadataExt`, Win32 FFI
- Used by: scan engine
- Purpose: Full Win32 custom-painted desktop window (Windows-only, `#[cfg(windows)]`)
- Location: `src/main.rs:1767-end`
- Contains: `desktop::run()`, `window_proc()`, `DesktopState`, all Win32 FFI declarations, custom list rendering with GDI double-buffering, tabs (Summary/Extensions/Top/Duplicates/Errors), treemap tile rendering, Shell context menu via `IShellFolder` / `IContextMenu` COM vtables
- Depends on: scan engine, `Arc<AtomicBool>` cancel token, `PostMessageW` for async scan completion (`WM_SCAN_DONE`, `WM_SCAN_PROGRESS`)
- Used by: `run_desktop()` on Windows
- Purpose: Browser-based single-page app rendering scan results; communicates with the HTTP server
- Location: `web/app.js` (821 lines), `web/index.html` (144 lines), `web/styles.css`
- Contains: client-side state machine (`state` object), `startScan()`, `renderAll()`, `renderRows()`, `renderTreemap()`, `renderExtensions()`, `renderDuplicates()`, `layoutTreemap()` (recursive binary-split), `exportHtmlSnapshot()`
- Depends on: Fetch API, DOM APIs
- Used by: Any browser pointed at `http://127.0.0.1:<port>`
## Data Flow
### Server Mode — Primary Scan Request
### Desktop Mode — Scan Flow
### Exact Duplicate Scan (On-Demand)
- **Server mode:** `Arc<AppState>` holds `initial_path` and `Mutex<Option<Arc<ScanResult>>>` for the last scan. The last scan is reused by `/api/export.*` and `/api/duplicates` without re-scanning.
- **Desktop mode:** Single `OnceLock<Mutex<DesktopState>>` global (`STATE`) holds all Win32 HWNDs and scan state. Dark-mode flag is also a global `AtomicBool` (`DARK_MODE_ATOMIC`).
- **Browser:** Plain JS `state` object (module-level) — not reactive; mutations trigger explicit `render*()` calls.
## Key Abstractions
- Purpose: Represents one file or directory in the scan tree
- Examples: `src/main.rs:31-49`
- Pattern: Flat struct; tree relationships are `id: usize` / `parent: Option<usize>` indices into the same `Vec<NodeRecord>`. Children are cached as `Vec<usize>`.
- Purpose: Input parameters for a scan (root path, thread count, hidden/links/excludes/max-depth)
- Examples: `src/main.rs:21-28`
- Pattern: Value type cloned into `WorkerShared`; shared immutably by all scan workers.
- Purpose: Data shared across scan worker threads under locks
- Examples: `src/main.rs:75-82`
- Pattern: `Arc<WorkerShared>` cloned per thread; `Mutex<Vec<NodeRecord>>` for node accumulation, `Mutex<QueueState>` + `Condvar` for the BFS work queue, `Arc<AtomicBool>` cancel flag.
- Purpose: HTTP server per-connection shared state (server mode only)
- Examples: `src/main.rs:85-88`
- Pattern: `Arc<AppState>` cloned per connection thread.
- Purpose: All mutable state for the Win32 native window
- Examples: `src/main.rs:2379-2411`
- Pattern: Stored in `OnceLock<Mutex<DesktopState>>`. The helper `with_state_mut(|state| ...)` acquires the lock for each mutation.
## Entry Points
- Location: `src/main.rs:119`
- Triggers: OS process start
- Responsibilities: Parse argv, dispatch to `run_desktop()`, `run_server()`, or `run_scan_command()`
- Location: `src/main.rs:2496`
- Triggers: `main()` with no args or `desktop` / `gui` subcommand on Windows
- Responsibilities: Register window class, create HWND, enter Win32 message loop
- Location: `src/main.rs:241`
- Triggers: `main()` with `serve` subcommand
- Responsibilities: Bind `127.0.0.1:<port>`, accept connections, spawn per-connection threads
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
### Scan blocks the HTTP response thread
## Error Handling
- Scan errors: `add_scan_error()` records path + message and increments the parent node's `errors` counter (`src/main.rs:607-622`)
- HTTP errors: `respond_text()` / `respond_json()` with appropriate status codes (`src/main.rs:904-944`)
- Desktop errors: `MessageBoxW` alert on fatal failure; scan errors shown in the Errors tab
- Top-level fatal: `eprintln!` + `std::process::exit(1)` in `main()`
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
