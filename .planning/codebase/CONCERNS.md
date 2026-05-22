# Codebase Concerns

**Analysis Date:** 2026-05-22

---

## Security Considerations

**No path validation on `/api/scan`, `/api/delete`, `/api/open`, `/api/reveal`, `/api/properties`:**
- Risk: Any HTTP client (browser tab, localhost attack, proxied request) can pass an arbitrary filesystem path as the `path` query parameter. In serve mode (`filetree serve`) there is no authentication, no CORS header, and no check that the requested path falls within the originally configured `initial_path`. An attacker with local access or who can cause the browser to make requests to `127.0.0.1:7878` can scan, open, or permanently delete any path the process user can reach.
- Files: `src/main.rs` lines 726–874 (`handle_client` route handlers)
- Current mitigation: Server binds to `127.0.0.1` only. Delete confirms with `confirm()` in the browser UI, but that check is entirely client-side.
- Recommendations: Validate that the resolved canonical path starts with `state.initial_path` before acting. Add a random token to URLs generated at startup; reject requests without it. This is critical before any multi-user or exposed network use.

**PowerShell command injection in `/api/properties`:**
- Risk: The path string is interpolated into a PowerShell script using only `replace("'", "''")` as sanitisation (`src/main.rs` lines 860–864). A path containing special PowerShell characters outside of single-quote context (e.g. backtick sequences, dollar signs in double-quote-adjacent fragments) can escape into arbitrary command execution.
- Files: `src/main.rs` lines 856–870
- Current mitigation: Single-quote escaping only.
- Recommendations: Avoid string interpolation entirely. Use the Win32 `SHObjectProperties` API directly (already used in the desktop path via COM), or pass the path as a separate argument rather than embedding it in the script string.

**Symlink cycle with `follow_links=true` can cause unbounded recursion:**
- Risk: When `follow_links` is enabled, a symlink that points to an ancestor directory creates an infinite directory loop. The scanner has no visited-path set or depth cap in this mode; it will continue enqueuing directories until the node `Vec` exhausts available memory or the OS returns errors.
- Files: `src/main.rs` lines 585–592 (`metadata_for_entry`), lines 563–582 (`scan_directory_job` enqueue logic)
- Current mitigation: `follow_links` defaults to `false`. A `max_depth` option exists but is not wired to the desktop UI (`src/main.rs` line 3195 always passes `None`).
- Recommendations: Maintain a `BTreeSet<PathBuf>` of canonical real paths visited during the walk; skip any directory whose canonical path is already in the set when `follow_links=true`.

---

## Tech Debt

**Entire application in one 5055-line file:**
- Issue: `src/main.rs` contains the HTTP server, filesystem scanner, JSON/CSV serialisers, Win32 desktop UI (2000+ lines of raw Win32 FFI), CLI entry points, and tests, all in a single file.
- Files: `src/main.rs`
- Impact: Difficult to navigate; unrelated concerns are entangled; adding features requires understanding the entire file. Clippy `allow` attributes at the module level suppress warnings globally for the desktop submodule, hiding potential issues in non-desktop code too.
- Fix approach: Split into modules: `scan.rs`, `server.rs`, `export.rs`, `desktop/mod.rs`. The `#[cfg(windows)] mod desktop` block is already logically separate and is the right starting point.

**Hand-rolled HTTP/1.1 parser with no request body or header limit:**
- Issue: `read_http_request` (`src/main.rs` lines 876–902) reads only the first line and then drains headers line by line with no maximum byte cap. A malformed or deliberately large request (no `\r\n\r\n` terminator) will block the handler thread indefinitely.
- Files: `src/main.rs` lines 876–902
- Impact: One hung connection permanently occupies a thread. Under the unbounded `thread::spawn` server model, many such connections exhaust thread limits.
- Fix approach: Add a byte counter; return `400` and close the connection if headers exceed a reasonable cap (e.g. 16 KB).

**`run_server` spawns one thread per connection with no limit:**
- Issue: `run_server` calls `thread::spawn` for every accepted TCP connection (`src/main.rs` lines 251–263). There is no connection queue depth limit, no thread pool, and no maximum concurrent connection count.
- Files: `src/main.rs` lines 241–266
- Impact: A burst of concurrent scan requests (or a misbehaving browser retrying rapidly) can exhaust OS thread limits. Each scan itself spawns up to 32 additional worker threads.
- Fix approach: Use a bounded thread pool (e.g. `rayon` or a manual semaphore) to cap total concurrent HTTP handler threads. Alternatively, block new scans while one is in flight via the existing `last_scan` mutex.

**Desktop UI exclude-patterns field is wired up in the web UI but silently dropped in the native UI:**
- Issue: `start_scan_from_controls` in the desktop module always passes `exclude_patterns: Vec::new()` (`src/main.rs` line 3194), ignoring the exclude text field that exists in the web UI. The desktop path has no corresponding UI control for exclusions.
- Files: `src/main.rs` lines 3190–3197
- Impact: Users of the native desktop window cannot exclude directories; they are unaware the option is a no-op.
- Fix approach: Add an exclude text control to the native window layout and wire it into `ScanOptions`.

**`scan_result_to_json` builds the entire JSON response by manual string concatenation:**
- Issue: Every field of every node is appended character-by-character or with `push_str`. For a scan of 1 million nodes the resulting string can reach hundreds of megabytes and is constructed entirely in memory before writing (`src/main.rs` lines 996–1147).
- Files: `src/main.rs` lines 996–1147
- Impact: Double memory usage (once in `Vec<NodeRecord>`, once in the JSON string); long pause before the first byte reaches the browser.
- Fix approach: Stream JSON directly to the `TcpStream` using chunked transfer encoding, or introduce a lightweight JSON serialisation library (e.g. `serde_json`) and stream via a `Write` adapter.

**`fnv1a_file` reads duplicate-candidate files with no size cap:**
- Issue: The exact-duplicate hashing function (`src/main.rs` lines 1312–1327) reads each file entirely into a 1 MB rolling buffer. A 50 GB file that is a duplicate candidate will be read in full on the request thread, blocking the HTTP response for minutes.
- Files: `src/main.rs` lines 1242–1327
- Impact: Long UI stall; no way to cancel mid-hash.
- Fix approach: Hash only the first and last N bytes for large files as a pre-filter, or run hashing on a background thread with the existing cancel-flag mechanism.

---

## Performance Bottlenecks

**`snapshot_scan_result` clones the entire node vector while holding the lock:**
- Problem: Called both from the progress callback loop (every 1.5 s) and on scan completion, it clones `Vec<NodeRecord>` under the `nodes` mutex (`src/main.rs` lines 394–395). For large scans (millions of nodes) each clone is a multi-hundred-millisecond pause that also blocks all worker threads from inserting new nodes.
- Files: `src/main.rs` lines 386–411
- Cause: The aggregation step (`aggregate_nodes`) mutates the node list, which forces a clone to avoid corrupting in-progress scan data.
- Improvement path: Separate raw scan nodes from aggregated results; aggregate only once at completion. Remove progress snapshots or make them lightweight (send counts only, not full node clones).

**`renderRows` in the browser reconstructs full DOM from scratch on every interaction:**
- Problem: Every click, expand, sort, or filter calls `renderRows`, which rebuilds the entire `els.rows.innerHTML` string for up to 5,000 rows (`web/app.js` lines 270–284).
- Files: `web/app.js` lines 270–310
- Cause: No virtual DOM, no incremental update, no row recycling.
- Improvement path: Keep a stable DOM and update only changed rows, or use a virtual-scroll approach that renders only the visible viewport.

**`makeVisibilityPredicate` uses recursive memoised traversal on every render:**
- Problem: Each call to `renderRows` creates a fresh memo `Map` and recomputes visibility for every node in the tree (`web/app.js` lines 312–326). With deep trees and active filters this is O(n) per render.
- Files: `web/app.js` lines 312–335
- Cause: The memoised predicate is not cached between renders; only within a single render call.
- Improvement path: Invalidate and rebuild the visibility index only when the filter string or tree structure changes, not on every sort or selection change.

---

## Fragile Areas

**Global mutable `STATE` accessed via `OnceLock<Mutex<DesktopState>>`:**
- Files: `src/main.rs` line 1920 (`static STATE: OnceLock<Mutex<DesktopState>>`)
- Why fragile: All Win32 message handlers access state through a single global mutex. A panic inside any `with_state_mut` closure will poison the mutex, making the application permanently unresponsive without any user-visible error.
- Safe modification: Always use `with_state_mut`; never lock `STATE` directly. Ensure closures passed to `with_state_mut` cannot panic (avoid indexing, unwrap, etc.).
- Test coverage: No tests cover the desktop state; Win32 code is entirely untested.

**`add_node` holds the `nodes` mutex while updating the parent's children list:**
- Files: `src/main.rs` lines 594–605
- Why fragile: Every worker thread calls `add_node` for every file system entry. All threads contend on the single `nodes` mutex. As the node vector grows, the mutex hold time increases linearly. On very large scans this becomes the primary bottleneck and causes workers to serialise.
- Safe modification: Batch child-ID insertions per directory within `scan_directory_job` and flush them in a single lock acquisition after processing all entries in that directory.
- Test coverage: Covered only indirectly through `scan_path_with_progress` integration test.

**`percent_decode` silently falls back to the raw byte on malformed `%`-sequences:**
- Files: `src/main.rs` lines 957–985
- Why fragile: If a path contains a literal `%` not followed by two hex digits, the percent-sign byte is passed through unchanged. This can produce incorrect paths that silently refer to different filesystem locations.
- Safe modification: Return a `Result` and respond with `400 Bad Request` on malformed encoding.
- Test coverage: No unit tests for `percent_decode`.

---

## Known Bugs

**Browser "Cancel" button does not stop the server-side scan:**
- Symptoms: Clicking Cancel calls `state.scanController.abort()` which cancels the fetch, setting status to "Cancelled locally". However, the server-side scan thread continues running until completion; the result is stored in `last_scan` and silently discarded. On large volumes this wastes minutes of CPU and IO.
- Files: `web/app.js` lines 85–89; `src/main.rs` lines 726–768 (no cancel signal sent to server)
- Trigger: Click Scan on a large path, then Cancel before it finishes.
- Workaround: None. The scan will complete server-side regardless.

**`/api/delete` accepts `DELETE` of any path with no confirmation on the server:**
- Symptoms: The only guard is a `confirm()` dialog in JavaScript (`web/app.js` line 442). A direct `curl` or browser navigation to `/api/delete?path=C:\` (without the JS dialog) will immediately call `fs::remove_dir_all`.
- Files: `src/main.rs` lines 832–851; `web/app.js` lines 441–459
- Trigger: Issue a raw GET request to the delete endpoint.
- Workaround: Use serve mode only on trusted machines. Do not expose port 7878 on network interfaces.

---

## Test Coverage Gaps

**Desktop module (`mod desktop`) has zero tests:**
- What's not tested: The entire Win32 UI layer — window creation, paint routines, row rendering, scan-start/finish flow, context menus, keyboard navigation.
- Files: `src/main.rs` lines 1767–4940
- Risk: Regressions in drawing or layout code are invisible to CI.
- Priority: Medium — UI bugs are caught manually, but refactors risk silent breakage.

**`percent_decode`, `wildcard_match`, `should_exclude`, `pattern_matches` have no unit tests:**
- What's not tested: URL decoding edge cases; glob patterns with multiple wildcards; exclude pattern matching against paths with backslashes vs forward slashes.
- Files: `src/main.rs` lines 957–985, 1631–1681
- Risk: Broken exclusion filtering or incorrect path decoding are undetected until manual testing.
- Priority: High — these are pure functions that are straightforward to unit test.

**No tests for JSON or CSV serialisation correctness:**
- What's not tested: `scan_result_to_json`, `scan_result_to_csv`, `push_json_string` with special characters (quotes, backslashes, control chars), `push_csv_field` with embedded commas and newlines.
- Files: `src/main.rs` lines 996–1192, 1464–1495
- Risk: Malformed output silently breaks the browser UI or export files.
- Priority: High — the hand-rolled serialisers are non-trivial and lack a library's test suite.

**No tests for the HTTP layer (`handle_client`, `split_target`, `read_http_request`):**
- What's not tested: Request routing; malformed HTTP lines; large header attacks; percent-encoded query parameters.
- Files: `src/main.rs` lines 673–902
- Risk: Server-side regressions in routing or parsing are undetected.
- Priority: Medium.

---

## Scaling Limits

**In-memory node store:**
- Current capacity: All scanned nodes are held in a single `Vec<NodeRecord>` in memory. Each `NodeRecord` contains two `String` fields (name, path) and a `Vec<usize>` (children). A scan of a 10-million-node volume can consume 3–5 GB of RAM before the JSON response is serialised (which doubles peak usage).
- Limit: Constrained by available RAM. No streaming, no on-disk index.
- Scaling path: Introduce a SQLite-backed or memory-mapped node store; stream JSON output with chunked HTTP encoding.

---

## Dependencies at Risk

**Zero external crate dependencies:**
- Risk: All HTTP parsing, JSON serialisation, CSV generation, URL percent-decoding, wildcard matching, and Win32 FFI bindings are hand-rolled. Each is a potential source of correctness bugs that established crates (`serde`, `hyper`/`axum`, `windows-rs`) handle with extensive test coverage.
- Impact: Every extension to the server or serialisation layer requires reimplementing already-solved problems.
- Migration plan: Add `serde`/`serde_json` for serialisation; consider `windows` or `windows-sys` crate to replace the manual FFI block (400+ lines of raw `extern "system"` declarations).

---

*Concerns audit: 2026-05-22*
