# Coding Conventions

**Analysis Date:** 2026-05-22

## Naming Patterns

**Files:**
- Single flat module: all Rust lives in `src/main.rs`; the Windows desktop subsystem is an inline `mod desktop { ... }` block within the same file
- Web assets use `lowercase.ext` — `web/app.js`, `web/styles.css`, `web/index.html`

**Rust Functions:**
- `snake_case` throughout — e.g., `scan_path`, `aggregate_nodes`, `push_json_string`, `epoch_ms_to_utc`
- Private helpers that generate output are named `push_*` (e.g., `push_json_string`, `push_csv_field`, `push_id_array`)
- Render-style helpers named `*_to_*` (e.g., `scan_result_to_json`, `scan_result_to_csv`)
- Boolean predicates named `is_*` / `has_*` / `should_*` (e.g., `is_hidden_entry`, `has_flag`, `should_exclude`, `should_recurse`)

**Rust Structs / Enums:**
- `PascalCase` — `NodeRecord`, `ScanOptions`, `ScanResult`, `WorkerShared`, `AppState`, `QueueState`, `ActiveGuard`
- Windows API types inside `mod desktop` use `PascalCase` aliases with short names matching Win32 conventions: `Hwnd`, `Hdc`, `Dword`, `Wparam`, `Lresult`
- Win32 constants use `UPPER_SNAKE_CASE` matching Win32 naming: `WM_CREATE`, `WS_CHILD`, `FILE_ATTRIBUTE_HIDDEN`

**Rust Variables / Parameters:**
- `snake_case` for locals; loop variables mirror field names (`id`, `node`, `child`, `error`)
- Iterator accumulator variables use short names: `left` / `right` in sort closures (not `a` / `b`)
- Generic index variables named `index` (not `i`)

**JavaScript:**
- Functions: `camelCase` — `startScan`, `ingestData`, `renderRows`, `handleRowClick`, `collectVisibleRows`
- DOM element cache: single `const els = { ... }` object with camelCase keys matching element IDs
- Global mutable state: single `const state = { ... }` object
- Render functions prefixed `render*` — `renderAll`, `renderRows`, `renderTreemap`, `renderExtensions`
- Event handler functions prefixed `handle*` — `handleRowClick`, `handleRowDblClick`, `handleContextAction`
- Format helpers prefixed `format*` — `formatBytes`, `formatCount`, `formatDate`, `formatDuration`, `formatMetric`
- HTML-building helpers suffixed `*Html` — `rowHtml`, `tileHtml`, `statHtml`, `duplicateGroupHtml`

**CSS:**
- Classes use `kebab-case` — `.name-cell`, `.bar-row`, `.item-row`, `.tab-panel`, `.context-menu`
- CSS custom properties (variables) used inline for layout: `--depth`, `--bar-width`, `--percent`, `--bar`

## Code Style

**Formatting:**
- Rust: `rustfmt` with default settings (Rust 2024 edition)
- JavaScript: no separate formatter configured (no `.prettierrc`, no `biome.json`); style is consistent with 2-space indentation, trailing commas in multi-line arrays/objects, double quotes for strings
- CI enforces `cargo fmt --check` before build — see `.github/workflows/ci.yml` line 22

**Linting:**
- Rust: `cargo clippy --all-targets -- -D warnings` (warnings are errors in CI)
- Inside `mod desktop`, several clippy lints are suppressed with module-level `#![allow(...)]` attributes because the Win32 bindings require non-idiomatic naming:
  - `clippy::manual_is_multiple_of`, `clippy::manual_range_contains`, `clippy::too_many_arguments`
  - `clippy::upper_case_acronyms`, `non_upper_case_globals`, `non_snake_case`, `unsafe_op_in_unsafe_fn`
- No ESLint or JavaScript linter is configured

## Import Organization

**Rust (`src/main.rs`):**
- All `use` declarations are at the top of the file, before any `fn` or `struct` definitions
- Standard library only — no third-party crates (confirmed: `[dependencies]` in `Cargo.toml` is empty)
- Grouped loosely by std module: `collections` → `env` → `fs` / `io` → `net` → `path` → `process` → `sync` → `thread` → `time`
- Inside `mod desktop`, a `use super::*;` wildcard is followed by targeted `std` imports

**JavaScript (`web/app.js`):**
- No ES module imports — plain browser script loaded via `<script src="/app.js">` at bottom of `web/index.html`
- All state, element references, and helpers are in module scope (no bundler, no imports)

## Error Handling

**Rust:**
- Top-level entry points return `io::Result<()>` and pattern-match with `if let Err(error)`, then `eprintln!` + `std::process::exit(1)`
- Internal functions propagate errors with `?` operator throughout
- Mutex locks always use `.expect("... lock poisoned")` — panicking on poisoned locks is intentional (the app treats this as an unrecoverable state)
- Scan errors (e.g., unreadable directories) are collected non-fatally into `Vec<ScanError>` via `add_scan_error()` and surfaced in the API response — they do not abort the scan
- HTTP route handlers return `io::Result<()>` and send HTTP 400 responses for bad inputs rather than panicking:
  ```rust
  Err(error) => {
      let mut body = String::from("{\"error\":");
      push_json_string(&mut body, &error.to_string());
      body.push('}');
      respond_json(&mut stream, 400, "Bad request", &body)
  }
  ```

**JavaScript:**
- `async/await` with `try/catch` for all `fetch` calls
- `AbortError` is explicitly filtered out (cancel is not treated as failure):
  ```js
  if (error.name !== "AbortError") {
      setStatus("Scan failed");
      alert(cleanError(error.message || String(error)));
  }
  ```
- `getJson()` helper throws on non-ok responses; callers wrap in `try/catch`
- User-facing errors shown via `alert()` for destructive actions (delete), `setStatus()` for informational failures

## Logging

**Rust:**
- No logging framework — `eprintln!` for errors and `println!` for informational server output only
- Server logs: `eprintln!("request failed: {error}")` and `eprintln!("connection failed: {error}")` in `run_server`
- No structured logging, no log levels

**JavaScript:**
- No logging framework — status updates go to `els.status` (the `#statusText` DOM element) via `setStatus()`
- No `console.log` calls in production code

## Comments

**When to Comment:**
- Used sparingly; comments explain non-obvious invariants, not what code does
- Inline comments document threading constraints and lock ordering:
  ```rust
  // Clone nodes and errors while holding their locks, then drop locks
  // immediately so worker threads are not blocked during aggregation.
  ```
- Test comments explain what the assertion is verifying when it is not self-evident

**Doc Comments:**
- No `///` doc comments anywhere — this is a single-binary application, not a library

## Function Design

**Size:**
- Business-logic functions are generally small (under 30 lines); the HTTP router `handle_client` is long by necessity (one `match` arm per route)
- Helper functions are extracted for reuse: `push_json_string`, `push_csv_field`, `push_id_array`, `percent_decode`, `wildcard_match`

**Parameters:**
- Rust functions take the minimum needed; shared state is passed as `&Arc<WorkerShared>` or `&AppState` (never as globals)
- Functions that build output take `&mut String` as their first argument (builder pattern): `push_json_string(&mut output, value)`

**Return Values:**
- Pure string-building functions return `String`
- Fallible filesystem functions return `io::Result<T>`
- Predicate helpers return `bool`
- No use of `unwrap()` outside of tests — production code uses `?`, `.expect()`, or explicit `match`

## Module Design

**Rust:**
- Single file (`src/main.rs`, ~5055 lines); the Windows desktop UI is isolated in a `#[cfg(windows)] mod desktop { ... }` inline module
- No `pub` exports — everything is crate-internal (binary crate, `publish = false`)
- No barrel files or re-exports

**JavaScript:**
- Single file (`web/app.js`, ~822 lines) with no module system
- Logically grouped by concern: state/DOM init → event binding → scan/data → render functions → utilities

---

*Convention analysis: 2026-05-22*
