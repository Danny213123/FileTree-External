# Codebase Structure

**Analysis Date:** 2026-05-22

## Directory Layout

```
FileTree/                       # Repo root
├── src/
│   └── main.rs                 # Entire Rust application (~5055 lines)
├── web/
│   ├── index.html              # Browser UI markup (144 lines)
│   ├── app.js                  # Browser UI logic — vanilla JS (821 lines)
│   └── styles.css              # Browser UI styles (983 lines)
├── .github/
│   └── workflows/
│       └── ci.yml              # GitHub Actions: fmt, clippy, test, release build
├── .planning/
│   └── codebase/               # GSD codebase map documents
├── Cargo.toml                  # Rust package manifest (no external dependencies)
├── Cargo.lock                  # Dependency lockfile
├── VERSION                     # Version string file
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── README.md
├── .gitignore
└── .gitattributes
```

## Directory Purposes

**`src/`:**
- Purpose: All Rust source code. The entire application is one file.
- Contains: `main.rs` — CLI dispatch, HTTP server, scan engine, Win32 desktop module, serializers, platform helpers
- Key files: `src/main.rs`

**`web/`:**
- Purpose: Static web assets served by the embedded HTTP server. These are **not** served from disk at runtime; they are compiled into the binary via `include_str!` macros in `src/main.rs:16-18`.
- Contains: `index.html` (shell layout), `app.js` (all client logic), `styles.css` (all styles)
- Key files: `web/app.js`, `web/index.html`, `web/styles.css`

**`.github/workflows/`:**
- Purpose: CI pipeline (GitHub Actions)
- Contains: `ci.yml` — runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cargo build --release` on `windows-latest`
- Key files: `.github/workflows/ci.yml`

**`.planning/codebase/`:**
- Purpose: GSD codebase map documents for AI-assisted planning and execution
- Generated: Yes (by GSD commands)
- Committed: Yes

## Key File Locations

**Entry Points:**
- `src/main.rs:119`: `main()` — binary entry point, CLI dispatch
- `src/main.rs:2496`: `desktop::run()` — Win32 native window entry
- `src/main.rs:241`: `run_server()` — HTTP server entry
- `web/app.js:65`: `init()` — browser UI initialization on `DOMContentLoaded`

**Configuration:**
- `Cargo.toml`: Package name (`filetree`), Rust edition (`2024`), version; no `[dependencies]`
- `Cargo.lock`: Lockfile (stdlib only, no third-party crates)
- `.github/workflows/ci.yml`: CI configuration

**Core Logic:**
- `src/main.rs:272`: `scan_path_with_progress()` — scan engine entry
- `src/main.rs:428`: `worker_loop()` — BFS worker thread body
- `src/main.rs:472`: `scan_directory_job()` — reads one directory, creates `NodeRecord`s
- `src/main.rs:624`: `aggregate_nodes()` — bottom-up size/file/folder rollup
- `src/main.rs:673`: `handle_client()` — HTTP request router (all API routes)
- `src/main.rs:996`: `scan_result_to_json()` — scan result serializer (includes analytics)
- `src/main.rs:1767`: `mod desktop` — entire Win32 native UI implementation
- `web/app.js:152`: `startScan()` — browser scan trigger
- `web/app.js:197`: `renderAll()` — browser full re-render
- `web/app.js:489`: `layoutTreemap()` — recursive binary-split treemap algorithm

**Testing:**
- No test files exist. CI runs `cargo test` but there are no `#[test]` functions in `src/main.rs`.

## Naming Conventions

**Files:**
- Rust: `snake_case` (single file: `main.rs`)
- Web assets: `lowercase` with extension (`app.js`, `index.html`, `styles.css`)
- Workflows: `kebab-case` (`ci.yml`)

**Rust functions:**
- All public and private Rust functions: `snake_case` (e.g., `scan_path_with_progress`, `aggregate_nodes`, `handle_client`)
- Win32 FFI extern functions: `PascalCase` mirroring the Windows API (e.g., `GetCompressedFileSizeW`, `CreateWindowExW`)
- Win32 constants: `UPPER_SNAKE_CASE` (e.g., `WM_SCAN_DONE`, `FILE_ATTRIBUTE_HIDDEN`)
- Win32 struct types: `PascalCase` (e.g., `WndClassW`, `DesktopState`, `GUID`)

**Rust structs:**
- Domain structs: `PascalCase` (e.g., `NodeRecord`, `ScanOptions`, `WorkerShared`, `AppState`)
- Win32 repr(C) structs: match Windows API naming with `W` suffix for wide-char variants

**JavaScript:**
- Functions: `camelCase` (e.g., `startScan`, `renderRows`, `layoutTreemap`)
- State keys: `camelCase` (e.g., `state.nodeById`, `state.sortKey`, `state.showFiles`)
- DOM element refs: `camelCase` in the `els` object (e.g., `els.path`, `els.rows`, `els.treemap`)
- CSS classes: `kebab-case` (e.g., `name-cell`, `bar-track`, `item-row`, `tab-panel`)

**Directories:**
- `lowercase` (no nesting beyond `src/`, `web/`, `.github/workflows/`)

## Where to Add New Code

**New API endpoint:**
- Add a new `route.as_str()` match arm inside `handle_client()` at `src/main.rs:693`
- Follow the pattern: extract query params with `query.get("key")`, call scan/analytics logic, respond with `respond_json()` or `respond_bytes()`
- Update browser JS in `web/app.js` to call the new endpoint via `fetch()`

**New scan field on a node:**
- Add the field to `NodeRecord` at `src/main.rs:31`
- Initialize it in `scan_directory_job()` at `src/main.rs:539`
- Include it in `aggregate_nodes()` if it rolls up (`src/main.rs:624`)
- Add it to `scan_result_to_json()` at `src/main.rs:1023` (manual push_str)
- Add it to `scan_result_to_csv()` at `src/main.rs:1149` (manual push_str + header)
- Update `web/app.js` render functions that consume node data

**New analytics / summary (server mode):**
- Add a compute function alongside `extension_stats()`, `age_stats()`, `duplicate_candidates()` in `src/main.rs:1329-1451`
- Embed the result into `scan_result_to_json()` output
- Add rendering in `web/app.js` (a new tab panel or extension to existing panels)
- Add a corresponding `<section>` and tab button in `web/index.html` if a new tab is needed

**New browser UI panel:**
- Add a `<button data-tab="myname">` and `<section id="tab-myname" class="tab-panel">` in `web/index.html` inside the `<aside class="side-pane">` block
- Add a `render*()` function in `web/app.js` and call it from `renderAll()` at line 197
- Add the element reference to the `els` object at `web/app.js:29`

**New Win32 desktop feature:**
- Work inside `mod desktop` in `src/main.rs:1767`
- Add control IDs as `const ID_*: isize = N` constants
- Create the Win32 control in `create_controls()` using `CreateWindowExW`
- Handle messages in `window_proc()` match arms
- Update `DesktopState` struct and `DesktopState::new()` if new state is required

**New CLI subcommand:**
- Add a new `args[0].as_str()` match arm in `main()` at `src/main.rs:135`
- Add a `run_*()` function following the pattern of `run_scan_command()`
- Update `print_usage()` at `src/main.rs:165`

**Utilities / helpers:**
- Add free functions directly in `src/main.rs` before the `mod desktop` block (line 1767)
- Platform-conditional helpers: use `#[cfg(windows)]` / `#[cfg(not(windows))]` pairs following the pattern at `src/main.rs:1683`

## Special Directories

**`web/`:**
- Purpose: Source for the browser UI
- Generated: No (hand-written source)
- Committed: Yes
- Note: Files are **not** served from disk; they are embedded into the binary at compile time. Editing them requires `cargo build` before changes are visible.

**`.planning/`:**
- Purpose: GSD planning and codebase analysis documents
- Generated: Partially (codebase maps are auto-generated; phase plans may be human-edited)
- Committed: Yes

**`target/` (not in repo):**
- Purpose: Cargo build artifacts
- Generated: Yes
- Committed: No (in `.gitignore`)

---

*Structure analysis: 2026-05-22*
