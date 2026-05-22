# FileTree

## What This Is

A standalone Windows disk-usage explorer written in Rust with a native Win32 desktop UI and an optional embedded web UI. It scans directories with a multi-threaded scanner, visualizes what's eating disk space, and lets the user find and clean up bloat. Built for personal use by the author.

## Core Value

**Point at a folder, see what's taking space, and clean it up — fast, on a single Windows machine, with no install footprint beyond a single .exe.** Scanning, visualizing, and cleanup must all feel cohesive in v1.

## Requirements

### Validated

<!-- Inferred from existing brownfield code (see .planning/codebase/). -->

- ✓ **SCAN-01**: Multi-threaded recursive directory scan with cancel + live progress — existing
- ✓ **SCAN-02**: Windows allocated-size (compressed file size) reporting — existing
- ✓ **SCAN-03**: Hidden-file, file-visibility, and symlink-follow toggles — existing
- ✓ **UI-01**: Native Win32 desktop window with custom-painted expandable tree table — existing
- ✓ **UI-02**: Size / allocated / file count / folder count / % parent / modified columns — existing
- ✓ **UI-03**: Dark mode (default) with light/dark toggle — existing
- ✓ **UI-04**: Native shell icons for folders and file types — existing
- ✓ **UI-05**: Select Directory / Scan / Stop / Refresh / Expand / Collapse controls — existing
- ✓ **VIZ-01**: Treemap visualization (web UI) — existing
- ✓ **VIZ-02**: Extensions, Top files, Duplicates, Errors tabs (desktop) — existing
- ✓ **DUP-01**: Exact-hash duplicate scan via FNV-1a, grouped by reclaimable waste — existing
- ✓ **EXPORT-01**: CLI scan with JSON or CSV output — existing
- ✓ **DELETE-01**: Server-side `/api/delete` route (backend only, no UX) — existing

### Active

<!-- v1 goal: reach rough feature parity with the TreeSize Personal tier across scan / visualize / cleanup, as an "inspired-by" implementation. -->

#### Scanning & data

- [ ] **SCAN-04**: Saved scan paths / bookmarks (drives, common folders)
- [ ] **SCAN-05**: Snapshot history — re-run a saved scan and compare to prior snapshot (size delta, new/changed/removed)
- [ ] **SCAN-06**: File-age statistics surfaced as first-class data (already computed in `age_stats()` — wire to UI)

#### Search & filtering

- [ ] **SEARCH-01**: File search across the loaded scan by name (glob + substring)
- [ ] **SEARCH-02**: Filter by size range (min/max)
- [ ] **SEARCH-03**: Filter by modified-date range and by age bucket
- [ ] **SEARCH-04**: Filter by file extension / category (images, video, archives, code, etc.)
- [ ] **SEARCH-05**: Combine filters and save a filter as a named view

#### Cleanup workflow

- [ ] **CLEAN-01**: Multi-select files/folders in the desktop tree and in the duplicates tab
- [ ] **CLEAN-02**: Safe delete with confirmation dialog (count, total bytes, sample of paths)
- [ ] **CLEAN-03**: Send-to-Recycle-Bin as default; permanent delete behind a checkbox
- [ ] **CLEAN-04**: Move-to selected folder for large/old files
- [ ] **CLEAN-05**: Post-action summary (bytes reclaimed, errors) and auto-refresh of affected subtree
- [ ] **CLEAN-06**: Undo last delete batch where possible (Recycle Bin restore hint)

#### Duplicates UX upgrade

- [ ] **DUP-02**: Inline preview of a selected duplicate group (full paths, mtimes, sizes)
- [ ] **DUP-03**: Smart selection helpers (keep newest / keep in shortest path / keep one per folder)
- [ ] **DUP-04**: Batch delete from the duplicates tab with the standard cleanup confirmation

#### Visualization

- [ ] **VIZ-03**: Native-desktop treemap panel (the existing treemap lives in the web UI only)
- [ ] **VIZ-04**: Sunburst / radial visualization as an alternate view
- [ ] **VIZ-05**: Age-colored treemap tint (old = red, recent = green) toggle

#### Exports & reports

- [ ] **EXPORT-02**: HTML report export — self-contained file with summary + top-N + treemap
- [ ] **EXPORT-03**: XLSX (Excel) export of the scan tree and key tabs
- [ ] **EXPORT-04**: Print-friendly report layout

#### Polish

- [ ] **POLISH-01**: Path bar with autocomplete and drive picker (replace plain text input)
- [ ] **POLISH-02**: Keyboard shortcuts (Enter to scan, Del to delete, Ctrl+F to search, Esc to cancel)
- [ ] **POLISH-03**: Status bar showing scan stats (files/folders/errors/elapsed/throughput)
- [ ] **POLISH-04**: Settings persistence (last path, column widths, dark mode, toggles) under `%APPDATA%\FileTree\`

### Out of Scope

- **Cross-platform native desktop (macOS / Linux GUI)** — Win32 is the chosen surface and the existing code uses raw Win32 FFI throughout. Server + CLI modes remain cross-platform.
- **Cloud-storage scanning (OneDrive / SharePoint / S3 / etc.)** — TreeSize Professional territory; not Personal tier.
- **NTFS permissions browser / ACL reports** — Professional tier.
- **Scheduled background scans (Windows Task Scheduler integration)** — defer to v2; v1 covers saved/manual re-scans.
- **Command-line deletion / scripting beyond current `scan` subcommand** — risky, not needed for personal use.
- **Pixel-perfect cloning of TreeSize visuals, icons, or copy** — IP / trade-dress risk. We match information architecture and workflows only.
- **Multi-user / team / network deployment** — personal/internal use only.
- **Telemetry, auto-update, installer** — single-`.exe` distribution stays the default.
- **Adding third-party Rust crates without explicit decision** — current codebase is zero-dependency by design; adding any crate is a Key Decision.

## Context

- **Brownfield baseline.** The app already ships a working v0.1.0 with native Win32 desktop, web UI, scan engine, treemap, duplicates, extensions/age/top-files analytics, dark mode, CSV/JSON export, and HTTP API. See `.planning/codebase/` for the full map.
- **Inspiration source.** The author wants TreeSize Personal–tier coverage. The existing `README.md` already states FileTree is "not affiliated with JAM Software or TreeSize. It is an independent Rust implementation inspired by disk-usage explorer workflows." We keep that posture — match capabilities and workflows, not visuals.
- **Two UIs today.** Native Win32 desktop (`desktop` mod) and a browser UI served by an embedded HTTP server on `127.0.0.1`. v1 invests in the desktop surface; web UI stays as-is unless a feature requires both.
- **Existing useful primitives.** `/api/delete` exists with no UX wired up. `age_stats()` and `extension_stats()` are computed but only partially surfaced. The cleanup workflow can build on these rather than re-deriving them.
- **Single-file Rust.** The entire backend is one `src/main.rs`. New code follows the existing patterns rather than introducing modules-for-modules'-sake — but the file is getting large and may need module splitting before/during this milestone.

## Constraints

- **Tech stack**: Rust edition 2024, zero external Rust crates — `Cargo.toml` `[dependencies]` is empty by design. Any new dependency is a Key Decision with rationale.
- **Tech stack**: Native UI via raw Win32 FFI (`User32`, `Gdi32`, `Shell32`, `Comctl32`, `Dwmapi`, `Ole32`, `UxTheme`, `Kernel32`). No GUI toolkit (no Tauri / egui / iced).
- **Tech stack**: Web assets embedded at compile time via `include_str!`. No bundler, no npm. Frontend stays vanilla JS / HTML / CSS.
- **Platform**: Windows 10/11 for the desktop surface. `serve` and `scan` modes stay cross-platform.
- **Distribution**: Single standalone `.exe`, no installer, no auto-update, no telemetry.
- **Performance**: Scan UI must remain responsive while workers are scanning (progress already streams every 1500 ms — preserve that). Cleanup operations must not block the message loop.
- **Safety**: Any destructive operation defaults to the Recycle Bin and requires an explicit confirmation dialog. Permanent delete is opt-in per action.
- **IP**: "Inspired-by" only. No copying of TreeSize icons, color schemes, exact copy strings, or screenshots. Distinct visual identity.
- **Budget**: Personal-time project; v1 is sequenced so something shippable lands at every phase boundary.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Treat TreeSize as "inspired-by," not a visual clone | Reduce IP / trade-dress risk; allow our own visual identity | — Pending |
| Scope v1 to TreeSize Personal tier (skip Professional features) | Keeps scope finite; Professional features (NTFS ACL, cloud, scheduling) are large standalone milestones | — Pending |
| Windows-only for desktop surface; server + CLI stay portable | Existing code already invested in raw Win32 FFI; rewriting in a toolkit is out of scope | — Pending |
| Native Win32 desktop is the primary v1 surface | Author preference; web UI stays as a secondary view | — Pending |
| Personal / internal-use distribution for v1 | Lowers IP and branding pressure; no installer / signing / store work needed | — Pending |
| Cleanup defaults to Recycle Bin, permanent delete is opt-in | Disk-usage tools that delete files are high-blast-radius; safe default is non-negotiable | — Pending |
| Keep zero-dependency Rust posture | Established pattern; adding crates inflates binary and surface area | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-22 after initialization*
