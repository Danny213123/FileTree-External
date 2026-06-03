# FileTree

A standalone Windows disk-usage explorer: point at a folder, see what's taking space, and clean it up. Single `.exe`, no installer.

**Current version:** `1.5.0`

## Features

### Disk Scanning And Navigation

- Multi-threaded recursive scanner with live progress, cancellation, refresh, and a server-side scan cache.
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
- Activity-bar Search with sidebar results and a main-area file-table view; matches are case-insensitive across both name and full path.
- Toolbar filters and advanced rules that surface matching files and folders across the whole scan.
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

### Export, CLI, And Packaging

- Toolbar export to CSV or JSON for scan results and duplicate results.
- Headless CLI scan mode with JSON or CSV output.
- Embedded React frontend served by the Rust backend; the release binary includes the built renderer assets.
- Portable Electron app and installer packaging; end users do not need Node.js or Rust.
- One-step portable build script that assembles `dist-portable\FileTree\FileTree.exe` and starts it by default.
- Settings, bookmarks, open tabs, layout, columns, recent paths, and AI settings persisted under `%APPDATA%\FileTree`.

### Performance

- Release builds use link-time optimization for hot scan, hash, and JSON paths.
- Sharded low-contention scanning, bounded concurrent full-tree scans, cached analytics, cached thumbnails, and streamed duplicate JSON.
- Virtualized sidebars/tables, deferred heavy recomputes, memoized menus and filters, code-split 3D treemap, and requestAnimationFrame-buffered AI streaming.

## Build

Prerequisites: Rust stable (1.85+), Node.js 18+.

To build the portable Electron app, run this from the repo root:

```powershell
.\build-portable.bat
```

This runs the frontend build, compiles the Rust server with the fresh embedded
assets, compiles Electron, assembles the portable app, and starts it:

```powershell
.\dist-portable\FileTree\FileTree.exe
```

To rebuild without launching the app afterward:

```powershell
.\build-portable.bat -NoLaunch
```

Keep the generated `FileTree` folder together when moving it to another
machine; `FileTree.exe` expects its bundled runtime files and server binary
beside it.

Manual server-only build:

```powershell
# Build the frontend first (output goes to frontend/dist/, embedded at compile time)
cd frontend
npm install
npm run build
cd ..

# Build the binary
cargo build --release
```

The release executable is at `.\target\release\filetree.exe`.

## Run

Double-click the exe, or from a terminal:

```powershell
.\target\release\filetree.exe
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

## Notes

Not affiliated with JAM Software or TreeSize. Independent Rust implementation.
