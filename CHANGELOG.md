# Changelog

All notable changes to FileTree are documented here.

This project follows a simple `MAJOR.MINOR.PATCH` version scheme. The application version is sourced from `Cargo.toml`.

## [1.5.0] - 2026-06-03

### Added

- **Search results as a real file table**: the activity-bar Search now renders matches in the main area using the same table as the tree (sortable columns, hover thumbnails, right-click shell context menu, multi-select, double-click to open, drag-to-move) via a new flat table mode, in addition to the existing sidebar results list.
- **Folder thumbnails**: folders now show a representative thumbnail -- the largest bookmarked image/video inside the folder, or the largest image/video if none are bookmarked -- in the hover info card and the Inspector preview (folder rows keep their folder icon).

### Changed

- **Search matches name and path**: file/folder search now does a case-insensitive substring match against both the name and the full path (previously name-only), so path- and extension-oriented queries return the files you expect; the matcher is shared between the sidebar list and the main-area table.
- **Toolbar filter surfaces files**: an active Filter (or advanced rules) now lists matching files, not just folders, and is expansion-independent (it descends into every directory, capped to keep very large trees responsive), so searching for a known file no longer returns zero results.
- **Hover info on the whole name**: the thumbnail / file-info card now appears when hovering anywhere over the file/folder title, not only the icon, and no longer dismisses when the cursor moves between the icon and the name.
- **Faster hover thumbnails**: the hover delay dropped from 400 ms to 150 ms, the thumbnail is prefetched on row hover, and the backend caches generated thumbnails in memory (keyed by path + modified-time + size, bounded to 512 entries) so repeat hovers skip the Windows Shell thumbnail API.

### Fixed

- **Rename text selection vs drag**: dragging the mouse to highlight text while renaming a file or folder no longer starts the file/folder move drag, so text can be selected normally in the rename field.

---

## [1.4.0] - 2026-06-02

### Added

#### AI Assistant tools
- **`read_file`**: a read-only content tool wired to `/api/file-text` (scan-root gated, ~64 KiB server cap) with client-side line windowing (`offset`/`limit`) that returns `truncated` + `next_offset`, so the assistant can verify file types/configs/logs instead of inferring from scan metadata.
- **`grep` content search**: searches inside files by picking candidates from the scan tree (optional `dir`/`glob`/`ext` filters), reading them via `read_file`, and returning path + line + snippet matches -- bounded by file count and total bytes, with a pluggable `MatchScorer` seam for a future embeddings-backed ranker.
- **`write_file` / `edit_file`**: Tier-2 approval-gated tools that create or patch text files, each surfaced through a new diff preview in the action approval card (old vs new for edits, new content for writes).
- **Read-only `git_status` / `git_diff` / `git_log`**: run the corresponding git commands for a folder and parse the output into structured results.
- **`web_fetch` / `web_search`**: approval-gated tools implemented in the Electron main process -- a bounded HTML-to-text fetch with a timeout, plus a keyless DuckDuckGo search.
- **`remember`**: a persistent memory tool backed by a local note store the assistant reads at the start of each run.

#### AI Assistant capabilities
- **MCP client**: configure Model Context Protocol servers (minimal stdio and HTTP JSON-RPC with the initialize handshake); their tools are discovered, namespaced as `mcp__server__tool`, and registered at runtime, with read-only tools ungated and side-effecting tools approval-gated.
- **Project rules and memory**: a user-editable rules / custom-instructions field in the assistant settings is injected into the system prompts alongside the persistent memory store.
- **Parallel execution**: independent read-only tool calls within a turn run concurrently, and multiple `delegate_to_search` sub-agents issued in one orchestrator turn run in parallel; mutating and approval-gated calls remain sequential.

### Changed

#### AI Assistant accuracy
- **Cross-turn tool memory**: a compact per-turn trace (tool name, key args, result digest) is folded into the conversation so follow-up turns remember what was found and done, instead of seeing only past final answers.
- **Structured sub-agent results**: delegations now return `{ agent, report, facts: { paths, counts, notes } }` and sub-agents receive the overall task plus a prior-turn digest, rather than a bare task string and a prose-only report.
- **Truncation signaling and pagination**: `list_largest`, `find`, `list_dir`, and `list_by_extension` return `{ returned, total, truncated, next_offset }` and accept an `offset`, and the per-tool output cap was raised to 8000 chars and annotated with how much was cut and how to page for more.
- **Path-verification gate**: paths cited in a draft final answer are verified against the current scan tree, and a fabricated path forces one corrective search pass.

#### AI Assistant performance
- **Backend**: `/api/ai-models` is served from an 8-second in-memory cache (and serves the last good value on upstream errors), and the Ollama chat proxy now stops reading upstream as soon as the client disconnects, freeing the per-connection thread instead of draining Ollama for up to its 120-second timeout.
- **Frontend**: attached-folder pre-scans run in parallel and reuse the scan cache; the model list is cached client-side (30-second TTL with in-flight request sharing); a per-scan node index (by size and parent) backs `find`/`list_dir`/`list_largest`/`grep`; streaming text and thinking deltas are coalesced through a `requestAnimationFrame` buffer; and persisted chat sessions strip image data URLs and cap stored tool output.

### Fixed

- **`run_command` shell selection**: the `shell` parameter (defined in the tool schema) is now forwarded end-to-end instead of being silently dropped.
- **Tool-call robustness**: malformed JSON tool arguments are reported back to the model as an error instead of being silently replaced with `{}`, and Ollama tool-call IDs are now stable per call across streamed chunks.

---

## [1.3.0] - 2026-06-02

### Changed

#### Performance
- **Release build optimization**: added a `[profile.release]` section (`lto = true`, `codegen-units = 1`) so release builds get link-time optimization across the hot scan, hash, and JSON loops (previously absent, so release builds got no LTO).
- **Lower-contention scanning**: the per-directory scan buffer is sharded into per-worker thread-local buffers merged at finalize — removing the single `Mutex<Vec<NodeRecord>>` bottleneck while preserving the positional `id == index` / parent / children contract. File-sampling fingerprints now use lock-free `AtomicU64`/`AtomicBool` instead of per-file mutexes, content-hash cache writes happen outside the cache lock, read-dominated `AppState` fields moved from `Mutex` to `RwLock`, and a process-wide thread gate bounds concurrent full-tree scans.
- **O(1) asset serving and micro-optimizations**: embedded renderer assets are indexed into a `HashMap` once at startup instead of a per-request linear scan; `largest_by_size` uses `select_nth_unstable_by` for top-N selection; and the in-memory content-hash cache evicts oldest-first.
- **Streamed duplicate JSON**: `/api/dupes`, `/api/dupes-scan`, `/api/dupes-v2`, and `/api/dupes-hash` stream their results through a chunked writer instead of building one large in-memory string (the response schema is unchanged).
- **Frontend rendering**: the App shell is decoupled from tree churn via a new `useWorkbench` external store (`useSyncExternalStore`), so expand/scroll/filter no longer re-render the title bar, menus, or side-bar shell; the Explorer side-bar folder tree is virtualized; the heavy visible-row and `dirCache` recomputes run in a deferred, interruptible render so typing, Expand All, and sorting stay responsive on large trees; menus and filter normalization are memoized; and the 3D treemap modal is code-split out of the main bundle.

### Fixed

- **Live scan progress**: the scan loading screen advances again. `/api/scan-stream` was emitting progress events without the `type` discriminator the renderer's parser expects, so the file counter stayed at 0 for the whole scan; progress lines now carry `{ "type": "scanning", ... }`.
- **Reparse-point junctions**: scanning a folder that contains legacy Windows compatibility junctions (e.g. `Documents\My Music`, `My Pictures`, `My Videos`, which carry deny-read ACLs) no longer floods the Problems panel with `FindFirstFileExW failed: error 5`. Directory reparse points are detected (`FILE_ATTRIBUTE_REPARSE_POINT` / symlink metadata) and shown as 0-byte junctions without being recursed into, avoiding the access-denied errors and double-counting against the real Music/Pictures/Videos folders.

### Removed

- The focus-ring highlight drawn over the selected editor pane when the view is split.

---

## [1.2.0] - 2026-06-01

### Added

#### AI Assistant
- **Approval-gated `run_command` tool**: the Action agent can run shell commands through a new `POST /api/run-command` endpoint, which executes via `std::process::Command` (`powershell -NoProfile -NonInteractive -Command` by default, or `cmd /C` when `shell: "cmd"`), drains stdout/stderr on background threads, enforces a 30-second default wall-clock timeout (clamped 1s–600s, killing overruns), and caps each stream at 64 KB — returning `{ ok, exit_code, stdout, stderr, truncated }`. Every command **requires explicit approval and can never be auto-approved or allowlisted** (`ALWAYS_APPROVE_TOOLS`); the exact command, captured stdout/stderr, and real exit code are shown in the approval card and in chat for verification.
- **Recycle Bin deletes**: the assistant removes files and folders to the Windows Recycle Bin via a `Microsoft.VisualBasic.FileIO.FileSystem` (`SendToRecycleBin`) PowerShell recipe, so AI-driven deletions are recoverable.

#### Drag-and-drop
- **Folder drag parity with files**: folders and mixed file+folder selections now use the native Windows shell drag (`SHDoDragDrop`). A folder can be dragged out to Explorer/the desktop as a true move (the source directory is removed via the shell `IFileOperation`), dropped onto another folder row across split panes for an internal move, and dragged to the tab bar to open it in a new tab.

### Changed

- The AI assistant treats an **attached folder as an isolated scope**: `ChatPanel` pre-scans the attached directories and builds a scoped `AgentApi` (overriding `getNodes`/`getScanResult`/`getScanPath`/`findDuplicates`) that every tool and the scan summary run against, without disturbing the open tabs.
- Folder and mixed-selection drags route through the native shell drag instead of the HTML5-only path; the tree invalidates its cache and rescans after an external folder move so it reflects the change.
- Treemap folder moves are routed through `/api/move-items` (via the shared internal-move handler), gaining the same conflict/merge handling as the tree table.

### Fixed

- **AI scope**: the assistant now scans and operates on the folder you attached rather than the focused tab's scan, so duplicate-finding and file operations target the right directory.
- **AI deletes**: deletions requested of the assistant now actually execute and report their real exit code instead of silently failing while claiming files were "moved to Recycle Bin".
- **Treemap move**: dragging a folder onto a treemap tile no longer fails with a 405 — it is routed through the whitelisted `/api/move-items` route.

### Removed

- The broken `delete_items` AI tool, which permanently hard-deleted files, swallowed failures, and falsely reported "moved to Recycle Bin" — superseded by the approval-gated `run_command` Recycle Bin recipe.

---

## [1.1.0] - 2026-06-01

### Added

#### Duplicates Finder (dupeGuru-style)
- **Dedicated Duplicates view**: a new activity-bar entry opens a duplicate-finder workspace with its own configuration side bar and a results table in the editor area, replacing the older in-tab duplicate finder.
- **Multi-root, content-verified detection**: scan one or more roots and confirm matches by actual file content, not just size or name. A new `POST /api/dupes-hash` endpoint buckets files by size, hashes collisions in parallel (FNV sample hash → full hash), and can finish with an optional byte-for-byte confirmation pass to eliminate false positives.
- **Persistent content-hash cache**: computed hashes are cached at `%APPDATA%\FileTree\hash_cache.json` and reused across scans, so repeat runs skip re-hashing unchanged files.
- **Composable match criteria**: combine Content, Size, Name, and Date rules — each independently markable as *required* — with a fuzzy-name similarity threshold and a configurable date tolerance.
- **Filters**: narrow a run by path, extension, and size before hashing.
- **Delta-scored results table**: a virtualized table shows an overall **Match %** plus per-criterion deltas, with **Dupes-only** and **Δ-values** toggles, in-table search, resizable and sortable columns, and a **Columns** menu.
- **Batch operations**: delete, move, copy, make-reference, and export selected duplicates, plus reveal-in-Explorer — all driven from the results table.

#### Terminal
- **Copy and paste in the integrated terminal**: Ctrl+C copies the current selection (and still sends ^C/SIGINT when nothing is selected), Ctrl+Shift+C always copies, and Ctrl+V / Ctrl+Shift+V paste the clipboard into the shell.
- **Right-click context menu** on a terminal with Copy (shown only when there is a selection) and Paste.
- Clipboard access uses the renderer's async Clipboard API with an Electron IPC bridge fallback (`copyText` / `clipboardReadText`), failing gracefully when the clipboard is unavailable.

#### Packaging
- **One-step Windows distributables** via `electron-builder` (`npm run package` in `electron/`): a portable `.exe` and an NSIS installer. The Rust backend (`filetree.exe`) is bundled as an app resource and the main process resolves it from `process.resourcesPath` when packaged, so end users need no Node, Rust, or build scripts installed.

### Changed

- The mutating Duplicates routes (`POST /api/dupes-hash`, `/api/dupes-action`, `/api/dupes-make-ref`, `/api/dupes-cancel`, and `DELETE /api/dupes-ignore`) are now correctly whitelisted by the request router instead of being rejected as GET-only.
- Rebuilt and re-embedded the frontend bundle (`frontend/dist`) so the shipped UI matches the current source.

### Fixed

- Duplicate actions now invalidate both the server-side scan cache and the content-hash cache for the affected paths, so results no longer reference files that were just moved or deleted.
- Name-column resizing in the tree table no longer jumps or fights the surrounding columns.

### Removed

- The old, unmounted `DuplicateFinder.tsx` component, superseded by the dedicated Duplicates view (`DuplicatesConfigPanel` + `DuplicatesResults`, backed by the `useDuplicates` hook and `duplicatesEngine`).

---

## [1.0.0] - 2026-05-31

### Added

#### AI Assistant (multi-agent)
- **Explicit multi-agent system**: an Orchestrator coordinates two specialized sub-agents — a read-only **Search** agent that investigates the scan and a mutating **Action** agent that performs file operations.
- **Two-tier approval workflow**: a Tier-1 plan-approval card gates handing work to the Action agent, and a Tier-2 action card gates each individual mutating operation — replacing the previous in-chat verbal confirmations.
- **Persistent per-tool allowlist**: a Cursor-style "Always allow" option remembers approved tools (machine-local) so they run without a card on later calls, alongside a **Skip** option that cleanly declines a single step; allowlisted tools are managed from the assistant's settings dialog.
- **Persistent chat history**: assistant conversations are saved as sessions and can be restored from the title bar.
- Model picker spanning local Ollama and cloud providers (OpenAI, Anthropic) with machine-local API keys.
- Markdown rendering of assistant replies.
- Visible "thinking" indicators with collapsible reasoning blocks.
- Multimodal image input to attach pictures as context for a question.

#### Configure Columns
- **TreeSize-style Configure Columns menu**, reachable from the per-pane editor toolbar ("Columns") and from the title-bar **View** menu — both share the same control.
- Expanded column set grouped into **Common**, **Date and time**, and **Extended**: Full Path, Folder Path, Type, Attributes, Creation/Last Accessed/Last Modified dates, Avg. File Size, Path Length, Dir Level, and Compression.
- **Decimal-places** control (0–5) and an **Automatic Units** toggle.
- **Reset Columns** restores the default details list.
- Owner, Author, File Version, Description, and Permissions are listed but disabled, pending scanner support.

#### Split view
- **VS Code-style split editor panes**: multiple resizable editor groups, each with its own tab bar.
- A single shared left **Explorer** side bar across all panes, driven by the focused pane's active tab.
- Drag tabs to reorder within a group or move them across editor groups; a **Split editor right** button on the tab strip opens a new pane.
- Per-editor-group **toolbar hide/show** toggle on the tab strip.

### Changed

- Removed the redundant AI chat icon from the activity bar; the assistant is now toggled from the title bar.
- View preferences (visible columns, decimal places) and the split-pane layout now persist across sessions (`visibleColumns`, `decimals`, and `paneGroups` in settings).
- Rebuilt and re-embedded the frontend bundle (`frontend/dist`) so the shipped UI matches the current source.

### Fixed

#### AI Assistant
- The assistant no longer fabricates file names or sizes: requests that need real data now force a read-only Search investigation so replies reflect the actual scan.
- Fixed the assistant quitting early or returning a blank turn — real findings gathered mid-run are returned if the model stalls, a notice is shown when the step budget is exhausted, and the Orchestrator is nudged once to follow through on an action request after Search locates the files.
- Transient process notices (retries, forced steps, step-limit, empty-response, and guard nudges) are now cleared when a turn ends, leaving the final answer, the step timeline, and any genuine errors.

#### Stability
- The Electron main process no longer crashes with a fatal error dialog on benign broken-pipe errors (EPIPE/ECONNRESET/EOF) from its own stdout/stderr or from the Rust server's pipes during shutdown.
- The tree table header and rows now render from a single dynamic column-grid template, fixing header/row misalignment at narrow widths or with non-default column counts.

---

## [0.2.0] - 2026-05-26

### Added

#### Web UI (React + TypeScript frontend)
- Complete rewrite of the browser UI in React + TypeScript (Vite + TSC build), replacing the original vanilla JS `web/` surface.
- Multi-tab workspace: open multiple directories simultaneously, each scanning independently in parallel.
- **Real-time filesystem watch**: backend streams `ReadDirectoryChangesW` events over SSE (`/api/fs-events`); new files and folders appear in the tree within ~100 ms of being created, moved, or deleted — no manual refresh needed.
- **Incremental directory patching**: watch-triggered updates rescan only the changed directory (`maxDepth=1`, ~50 ms) and graft results into the live tree without blanking the view.
- **Smart refresh**: manual Refresh on an already-scanned path preserves expanded folder state.
- Treemap visualization (recursive binary-split layout) in bottom-panel and right-panel modes; drag-resize handle.
- Interactive 3D treemap modal.
- Ribbon toolbar with Scan, Stop, Refresh, metric/unit selectors, expand controls, hidden-file toggle, symlink toggle, and New Folder.
- Path bar with drive picker and special-folder shortcuts (Desktop, Documents, Downloads, Pictures, Videos).
- Tab strip side panel: Details, Extensions, Age Distribution, Top Files, Duplicates, Errors, Bookmarks, AI Chat.
- **Details tab**: size, allocated, file/folder counts, last modified, path, extension, open/reveal/copy-path actions.
- **Extensions tab**: breakdown by file extension with size bars.
- **Age tab**: file age bucket histogram (< 1 week through > 2 years).
- **Top Files tab**: largest files in the scan with navigate-to action.
- **Duplicates tab**: candidate duplicate groups and exact-match finder.
- **Bookmarks tab**: pin paths for fast navigation; persisted via `/api/bookmarks`.
- **AI Chat tab**: embedded Ollama chat against the current scan tree with model picker and streaming responses.
- **Duplicate Finder**: full-featured dedupe workflow with filter controls, mode selection, and batch delete/move/copy actions.
- Filter dialog with multi-rule include/exclude patterns applied to the tree table in real time.
- Column visibility controls (Size, Allocated, File Count, % of Parent, Last Modified, Path).
- Sort by any column, ascending or descending.
- Shell context menu integration via right-click (Windows Explorer context menu at cursor).
- Ctrl+click on a directory row opens it in a new tab.
- Double-click to expand/collapse directories or open files.
- Client-side scan result cache with per-path TTL; bypassed for watch-triggered rescans.
- Dark mode follows system setting; togglable from the ribbon.

#### Backend
- **`/api/fs-events`**: SSE endpoint using `ReadDirectoryChangesW` with overlapped I/O and 500 ms keep-alive pings. Falls back to 1-second mtime polling on non-Windows.
- **`/api/scan` (sync)**: non-streaming scan endpoint for shallow/incremental rescans; `nocache=1` param bypasses the 5-minute server-side cache.
- **`/api/scan-stream`**: NDJSON streaming endpoint (replaces the original `/api/scan`).
- **`/api/watch`**: POST-based mtime batch check for polling-based watch.
- **`/api/duplicates` / `/api/dupes-scan` / `/api/dupes-v2`**: exact and fuzzy duplicate detection with FNV-1a hashing, filter params, and grouping.
- **`/api/dupes-action`**: batch delete/move/copy on duplicate groups.
- **`/api/special-folders`**: returns OS shell known-folder paths.
- **`/api/bookmarks`**: GET/POST bookmark list persisted to `%APPDATA%\FileTree\bookmarks.json`.
- **`/api/settings`**: GET/POST JSON settings store (`%APPDATA%\FileTree\settings.json`) — dark mode, threads, sort, open tabs, last path.
- **`/api/mkdir`**: create a new directory.
- **`/api/move`**: rename or move a file or directory.
- **`/api/shell-context-menu`**: invoke the Windows Shell context menu at screen coordinates.
- **`/api/ai-models`** / **`/api/ai-chat`**: proxy to a local Ollama instance for AI chat with streaming.
- **`/api/dupes-progress`**: real-time progress for long-running duplicate scans.
- Server-side 5-minute scan result cache with path-keyed invalidation on destructive operations.
- WebView2 embedding: the React frontend is hosted in a `WebView2` control inside the native Win32 window.

#### Native Desktop (Win32)
- Source decomposed into `src/desktop/` sub-modules: `mod.rs`, `ffi.rs`, `paint.rs`, `theme.rs`, `tabs.rs`, `state.rs`, `shell.rs`, `icons.rs`.
- Custom tab strip (`FileTreeTabStrip` window class) with keyboard/click switching and `ActiveTab` enum.
- Owner-drawn menu bar with theme-matched colors for dark and light palettes.
- Custom status footer bar (`msctls_statusbar32`) with formatted scan stats.
- Path bar (`ComboBoxEx32` + `SHAutoComplete`) for path history and filesystem autocomplete.
- Drive picker combo box.
- Single-instance enforcement via named mutex + `WM_COPYDATA` re-focus.
- Per-HWND dark mode; pre-window bootstrap eliminates first-paint flash.
- Persistent window geometry restore from settings.
- Bootstrap Icons 1.11.3 TTF embedded as a binary asset and loaded via `AddFontMemResourceEx`.
- DPI-aware primitives and accent-color luminance helpers for theming.

#### Source Refactors
- `src/main.rs` decomposed into focused modules: `model`, `scan`, `server`, `export`, `analytics`, `io`, `cli`, `settings`, `dupes`.
- `src/dupes.rs`: exact and fuzzy duplicate engine.
- `src/settings.rs`: atomic JSON settings store with typed `SettingsStore`.
- `src/analytics.rs`: extension stats, age buckets, top-N files, largest-dir ranking.

### Removed

- `web/` (vanilla JS / HTML / CSS single-file UI) — replaced by the React frontend in `frontend/`.

### Fixed

- Manual Refresh no longer collapses expanded folders.
- Watch-triggered refresh no longer overwrites newly detected files with stale full-tree data.
- `reconstructChildren` applied to shallow-rescan results before grafting into the tree.
- Ancestor size and file-count recalculation in `patchDirectory` corrected (was double-counting files).
- Server-side scan cache bypassed for watch-triggered incremental rescans.
- `maxdepth` query parameter accepted in both lowercase and camelCase forms.

---

## [0.1.0] - 2026-05-22

### Added

- Native Windows desktop disk-usage explorer.
- Threaded recursive scanner with live progress updates.
- Tree-style size table with folder/file counts, allocated size, percent-of-parent bars, and modified dates.
- Directory picker, refresh, stop scan, expand/collapse, path column, hidden-file, file visibility, symlink, and dark-mode controls.
- Shell icons for folders and file types.
- JSON and CSV CLI scan exports.
- Root Git project layout for `Danny213123/FileTree`.
