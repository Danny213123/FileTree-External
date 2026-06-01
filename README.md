# FileTree

A standalone Windows disk-usage explorer — point at a folder, see what's taking space, and clean it up. Single `.exe`, no installer.

**Current version:** `1.0.0`

## Features

- Multi-threaded recursive directory scanner with real-time progress streaming
- React-based web UI served over a local embedded HTTP server, embedded in the binary at compile time
- Explorer-style tree table: size, allocated size, file count, folder count, percent-of-parent, modified date
- Treemap visualization and extension breakdown
- Real-time filesystem watch — tree updates within ~100ms of changes on disk
- In-tree search/filter by name, extension, or size range
- Export to CSV or JSON directly from the toolbar
- Open Location — reveals selected file in Windows Explorer
- Recycle Bin quick link in the directory picker
- Recent scan paths persisted across restarts
- Dark mode (default), hidden-file and symlink-follow toggles
- Context menu with Open, Reveal in Explorer, Move to Recycle Bin, Delete
- Duplicate file detection with FNV-1a hashing
- Native Win32 window with no external GUI toolkit

## Build

Prerequisites: Rust stable (1.85+), Node.js 18+.

To build the portable Electron app, run this from the repo root:

```powershell
.\build-portable.bat
```

This runs the frontend build, compiles the Rust server with the fresh embedded
assets, compiles Electron, and assembles the portable app at:

```powershell
.\dist-portable\FileTree\FileTree.exe
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
