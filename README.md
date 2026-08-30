# FileTree

A low-memory Windows disk-usage explorer: point at a folder, see what's taking space, and clean it up. The v2 desktop uses Tauri 2 with one WebView2 control; Electron is no longer bundled.

**Current version:** `2.0.0` (performance release in pre-release validation)

## Features

### Disk Scanning And Navigation

- Multi-threaded recursive scanner with live progress, cancellation, refresh, and per-scan SQLite indexes under `%LOCALAPPDATA%\FileTree\v2\scans`.
- Real-time filesystem watching with incremental directory patching, so created, moved, renamed, and deleted items appear without a full rescan.
- Multi-tab workspace with VS Code-style split editor panes, draggable tabs, a shared Explorer sidebar, and persisted pane layout.
- Drive, common-folder, Recycle Bin, recent-path, and bookmark navigation.
- Back/forward/up navigation inside each tab, plus breadcrumbs and double-click drill-in.
- Hidden-file, symlink-follow, owner-collection, thread-count, and exclude-pattern scan options.
- Reparse-point/junction handling to avoid double-counting and noisy access-denied errors.

### Tables, Search, And Analysis

- Virtualized Explorer-style details table with sortable/resizable columns, multi-select, keyboard-friendly selection, and configurable visible columns.
- Rich column set including size, allocated size, counts, percent of parent, full path, folder path, type, attributes, dates, average file size, path length, directory level, and compression.
- Automatic or fixed units, decimal-place control, resettable column presets, and persistent table preferences.
- Activity-bar Search with sidebar results and a main-area file-table view. Search is case-insensitive and tokenized: plain terms combine with AND, quoted phrases stay together, `-term` excludes, `name:`, `path:`, `ext:`, and `type:` narrow a term, and `*`/`?` provide wildcards. Optional regex, size ranges, modified-date ranges, extension, and category filters run in the same paged SQLite query.
- Toolbar size, date, extension, category, and regex filters run against the paginated SQLite scan in v2, surfacing matching files and folders without loading the whole index into the renderer.
- Treemap panel plus an interactive 3D treemap modal.
- Side panels for Details, Extensions, Age Distribution, Top Files, Duplicates, Errors, Bookmarks, and AI Chat.
- Hover info cards, image/video thumbnails, cached Windows Shell thumbnails, and representative folder thumbnails in hover cards and Inspector previews.

### File Operations

- Open, reveal in Explorer, copy path/name, properties, rename, create folder, move, copy, paste, recycle, and permanent delete actions.
- Native Windows shell context menus for files and folders.
- Risk-scoped confirmations for large, many-item, cross-drive, or permanent operations.
- Undo support for reversible moves and Recycle Bin deletes.
- Native Windows drag-and-drop for files, folders, and mixed selections, including internal moves across panes, drops onto folder rows or treemap tiles, tab-bar folder opens, and drag-out to Explorer.
- Native shell move/copy behavior with Windows conflict dialogs where available, plus server fallbacks.

### Duplicate Finder

- Dedicated Duplicates workspace with its own configuration sidebar and virtualized results table.
- Multi-root duplicate scans with content verification, not just name or size comparison.
- Persistent content-hash cache in `%APPDATA%\FileTree\hash_cache.json` so repeated scans skip unchanged files.
- Composable matching criteria for Content, Size, Name, and Date, with required-rule toggles, fuzzy-name thresholds, and date tolerance.
- Path, extension, and size filters before hashing.
- Delta-scored results with Match %, per-criterion deltas, dupes-only and delta-value toggles, in-table search, sortable/resizable columns, and a Columns menu.
- Batch delete, move, copy, make-reference, reveal, ignore, and CSV export operations.

### AI Assistant

- Multi-agent assistant with an Orchestrator, read-only Search agent, and approval-gated Action agent.
- Local Ollama support plus cloud model picker entries for OpenAI and Anthropic, with machine-local API keys.
- Persistent chat sessions, Markdown replies, visible thinking blocks, multimodal image attachments, and folder attachments scoped to the attached folder.
- Two-tier approval workflow for mutating work, persistent allowlist for approved tools, and explicit approval for shell commands.
- File-management tools for scanning, listing, finding, duplicate analysis, moves, copies, Recycle Bin deletes, and path verification.
- Content tools for `read_file`, paged file reads, `grep`, `write_file`, and `edit_file` with approval-card diff previews.
- Read-only Git tools (`git_status`, `git_diff`, `git_log`), approval-gated `web_fetch` and `web_search`, persistent `remember` memory, project rules/custom instructions, and MCP tool discovery.
- Parallel read-only tool execution, parallel delegated Search agents, truncation signaling, pagination, and compact cross-turn tool memory.

### Integrated Terminal

- Integrated Windows terminal opened at the selected folder or scan root.
- Copy and paste support with Ctrl+C/Ctrl+Shift+C/Ctrl+V/Ctrl+Shift+V behavior that matches terminal expectations.
- Right-click terminal context menu with Copy and Paste.

### Compression Workspace

- Compact Setup, Monitor, and History workspaces for mixed video, image, and archive batches.
- Hardware-only HandBrake video encoding with automatic NVENC, Quick Sync, or AMD selection, NVDEC/QSV hardware decoding where supported, audio passthrough, codec/quality presets, and a throughput-oriented maximum of two parallel workers. Video never falls back to a software encoder; hardware failures preserve the source.
- Size-weighted overall progress plus per-file stages, progress, elapsed time, ETA, speed, encoder, sizes, savings, disposition, and result.
- Master-detail monitoring with a run rail, cached hardware/process telemetry, virtualized 200,000-file-scale tables, active/recent pinning, search, filters, sorting, persisted columns, and a diagnostics inspector.
- Graceful pause/resume, immediate resumable stop, pending-file prioritize/skip, selective retry, and persisted queued batches that survive restarts.
- Deep output verification before any original is recycled or deleted, partial-output cleanup on stop, low-space/stall warnings, and source-preserving failure behavior.
- Durable no-gain fingerprints skip unchanged files before an encoder starts; changed sources, presets, codecs, encoders, tools, or capabilities automatically trigger a fresh attempt.
- In-place or separate-folder output, recoverable Recycle Bin handling by default, optional permanent delete or keep-original modes, and `[COMPRESSED]` tagging with backend preflight that prevents tagged outputs from being re-encoded.
- Searchable/filterable compression history with CSV export, detailed command/stderr diagnostics, and per-file compress-again controls.
- Windows keep-awake and taskbar progress integration while compression is active, with automatic release while paused or idle.

### Export, CLI, And Packaging

- Toolbar export to CSV or JSON for scan results and duplicate results.
- Headless CLI scan mode with JSON or CSV output.
- Tauri 2 desktop shell with one WebView2 control, typed commands, bounded progress channels, and an embedded React frontend; no localhost desktop server or preload bridge.
- Reusable `filetree-core`, standalone `filetree` CLI, and `filetree-desktop` Tauri crates in one Cargo workspace.
- Portable Tauri app and NSIS installer packaging; end users do not need Node.js or Rust.
- One-step portable build script that assembles `dist-portable\FileTree\FileTree.exe` and starts it by default.
- v2 scan indexes, settings, compression state, and migration catalog persisted under `%LOCALAPPDATA%\FileTree\v2`; v1 data remains untouched during copy-on-write migration.

### Performance

- Release builds use link-time optimization for hot scan, hash, and JSON paths.
- Scanner output crosses an 8,192-row bounded channel into 10,000-row SQLite transactions; tree/search pages are capped at 500 rows and compression pages at 250.
- The renderer retains at most sixteen tree pages (8,000 rows / 16 MiB), with 16 MiB thumbnail and 4 MiB icon budgets; inactive tabs release rows, watchers, treemaps, and page-cache entries.
- Scan indexes are capped at 10 GiB with protected active/pinned scans and least-recently-used eviction. SQLite uses file-backed temporary work, disabled mmap, and an 8 MiB cache per connection.
- Completed compression jobs are evicted from the live registry after their terminal event; the two-worker scheduler and source-preserving hardware-only encoder policy remain intact.

## Build

Prerequisites: Rust stable (1.85+), Node.js 18+.

To build the portable Tauri app, run this from the repo root:

```powershell
.\build-portable.bat
```

This builds the embedded frontend, Tauri desktop/NSIS installer, and standalone
CLI, assembles the portable folder, and starts it:

```powershell
.\dist-portable\FileTree\FileTree.exe
```

To rebuild without launching the app afterward:

```powershell
.\build-portable.bat -NoLaunch
```

`FileTree.exe` uses the WebView2 runtime included with current Windows 10/11
systems. `filetree-cli.exe` provides headless scan and opt-in `serve` workflows.

Manual server-only build:

```powershell
# Build the frontend first (output goes to frontend/dist/, embedded at compile time)
cd frontend
npm install
npm run build
cd ..

# Build the CLI and Tauri desktop
cargo build --release -p filetree-cli
npm run build
```

The desktop executable is at `.\target\release\FileTree.exe`; the CLI is at
`.\target\release\filetree.exe`.

## Run

Double-click the exe, or from a terminal:

```powershell
.\target\release\FileTree.exe
```

Optional CLI modes:

```powershell
# Headless scan — write JSON or CSV report
.\target\release\filetree.exe scan D:\Data --format json --out scan.json
.\target\release\filetree.exe scan D:\Data --format csv --out scan.csv

# Serve the web UI only (no native window)
.\target\release\filetree.exe serve --port 7878
```

## Development

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Frontend hot-reload during development:

```powershell
cd frontend && npm run dev
```

Then open the URL printed by Vite (the Rust server must also be running on port 7878).

## License

FileTree is licensed under the PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE).

## Notes

Not affiliated with JAM Software or TreeSize. Independent Rust implementation.
