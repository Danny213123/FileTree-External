# Changelog

All notable changes to FileTree are documented here.

This project follows a simple `MAJOR.MINOR.PATCH` version scheme. The application version is sourced from `Cargo.toml`.

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
