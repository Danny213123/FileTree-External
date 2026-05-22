# FileTree

FileTree is a standalone Windows disk-usage explorer written in Rust. It scans directories with a native threaded scanner and opens a native desktop UI by default.

## Run

```powershell
cargo run -- desktop --path D:\FileTree
```

Or run the built executable directly:

```powershell
.\target\release\filetree.exe desktop --path D:\Data
```

## CLI Reports

```powershell
.\target\debug\filetree.exe scan D:\Data --format json --out scan.json
.\target\debug\filetree.exe scan D:\Data --format csv --out scan.csv
```

## Current Features

- Threaded recursive scans.
- Native Win32 desktop window.
- Explorer-style expandable tree table.
- Size, allocated size, file count, folder count, percent-of-parent, and modified date columns.
- Windows allocated-size support through `GetCompressedFileSizeW`.
- Real-time scan progress: the table fills in while worker threads are still scanning.
- Select Directory, Scan, Stop, Refresh, Expand, Collapse, and Path Column controls.
- Dark mode by default, with a Dark toggle.
- Native shell icons for folders and file types.
- Hidden-file, file visibility, and symlink-follow toggles.
- CSV and JSON CLI exports.

## Notes

This project is not affiliated with JAM Software or TreeSize. It is an independent Rust implementation inspired by disk-usage explorer workflows.
