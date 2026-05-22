# Requirements: FileTree

**Defined:** 2026-05-22
**Core Value:** Point at a folder, see what's taking space, and clean it up — fast, on a single Windows machine, with no install footprint beyond a single .exe.

## v1 Requirements

Scoped to roughly TreeSize Personal-tier coverage as an "inspired-by" implementation. Builds on the existing v0.1.0 brownfield baseline.

### Refactor (REFAC)

- [ ] **REFAC-01**: Split `src/main.rs` into modules (`cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/*`) without behavior change; `cargo build`, `cargo fmt --check`, `cargo clippy -D warnings`, and existing smoke test all pass

### Settings & persistence (SET)

- [ ] **SET-01**: Settings file at `%APPDATA%\FileTree\settings.json` resolved via `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`
- [ ] **SET-02**: Atomic write via temp-file + rename; debounced save on change
- [ ] **SET-03**: Schema versioning (`schema_version: 1`) with forward-compatible read
- [ ] **SET-04**: Single-instance guard via named mutex to prevent concurrent writes
- [ ] **SET-05**: Persisted state includes last path, column widths, dark-mode toggle, hidden/symlink toggles, window size/position

### Polish (POL)

- [ ] **POL-01**: Path bar with drive picker dropdown and folder autocomplete
- [ ] **POL-02**: Keyboard shortcuts — Enter (scan), Esc (cancel scan), Del (delete selection), Ctrl+F (focus search), Ctrl+E (export), F5 (refresh)
- [ ] **POL-03**: Status bar showing scan stats (files / folders / errors / elapsed / throughput MB/s)

### Search & filter (SRCH)

- [ ] **SRCH-01**: In-scan search by file name with glob + substring, case-insensitive, debounced ~100-150 ms
- [ ] **SRCH-02**: Filter by size range (min / max)
- [ ] **SRCH-03**: Filter by modified-date range and by age bucket (already computed in `age_stats()`)
- [ ] **SRCH-04**: Filter by file extension or category (images, video, archives, code, documents, other)
- [ ] **SRCH-05**: Combine filters and save a filter combination as a named view, persisted via SET-01

### Multi-select infrastructure (SEL)

- [ ] **SEL-01**: Multi-select in the main tree, duplicates tab, and top-files tab via click / Ctrl+click / Shift+click / Ctrl+A
- [ ] **SEL-02**: Selection keyed by stable full-path string (NOT `Vec<NodeRecord>` index); selection survives re-scan by re-resolving identities
- [ ] **SEL-03**: Status-bar selection summary — "N items selected, X bytes (Y allocated)"

### Cleanup workflow (CLEAN)

- [ ] **CLEAN-01**: Delete selected items via `IFileOperation` on a dedicated STA worker thread; never `std::fs::remove_*`
- [ ] **CLEAN-02**: Defaults to Recycle Bin (`FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD`); permanent-delete is an explicit per-action checkbox
- [ ] **CLEAN-03**: Confirmation dialog before any delete shows count, total bytes, the top-N largest paths verbatim, and the drive type (warns for network / removable / system drives)
- [ ] **CLEAN-04**: Re-stat each path (size, mtime, file ID) immediately before deletion; skip + report mismatches (TOCTOU guard)
- [ ] **CLEAN-05**: Long-path support via `\\?\` prefixed paths fed to `SHCreateItemFromParsingName`
- [ ] **CLEAN-06**: Junction / symlink / reparse-point safety — delete the link node, never recurse through it; `NodeRecord` tags reparse points at scan time
- [ ] **CLEAN-07**: Move-selected-to target folder (uses `IFileOperation::MoveItems` with the same safety pipeline)
- [ ] **CLEAN-08**: Post-action summary panel — bytes reclaimed, files affected, errors, with "Open Recycle Bin" link for undo
- [ ] **CLEAN-09**: Lowest-common-ancestor subtree auto-refresh after successful cleanup (no full re-scan); no flicker
- [ ] **CLEAN-10**: Cleanup UI disabled during active scans; scan cannot start while cleanup is in flight

### Duplicates UX upgrade (DUP)

- [ ] **DUP-01**: Inline detail view of a selected duplicate group — full paths, modified times, sizes, parent folders
- [ ] **DUP-02**: Smart-selection helpers — keep newest / keep in shortest path / keep one per folder; helpers always leave ≥1 file per group unchecked
- [ ] **DUP-03**: Batch delete from the duplicates tab uses the standard CLEAN-* pipeline (same confirmation, same Recycle Bin default)

### Visualization (VIZ)

- [ ] **VIZ-01**: Native-desktop treemap panel (port `layoutTreemap` from web JS to Rust + GDI with double-buffering)
- [ ] **VIZ-02**: Sunburst / radial visualization as an alternate view, rendered via GDI `BeginPath` / `AngleArc` / `EndPath`
- [ ] **VIZ-03**: Age-tinted treemap toggle — HSL hue derived from mtime (recent = green, old = red) — the headline differentiator

### Snapshot history & diff (SNAP)

- [ ] **SNAP-01**: Save current scan as a snapshot to `%APPDATA%\FileTree\snapshots\<name>.json` using existing `scan_result_to_json` serializer
- [ ] **SNAP-02**: List, rename, and delete saved snapshots from a Snapshots menu
- [ ] **SNAP-03**: Bookmarks — pin frequently-scanned paths (drives, common folders), persisted via SET-01
- [ ] **SNAP-04**: Diff two snapshots — two-pass HashMap keyed by relative path + `(size, mtime)` fingerprint; surface added / removed / grown / shrunk / unchanged
- [ ] **SNAP-05**: Diff tab in desktop UI showing the five categories above with totals and per-row delta
- [ ] **SNAP-06**: Path normalization — `GetFullPathNameW` + lowercase compare key + `GetLongPathNameW` for 8.3 names; relative-to-root keying so drive-letter shifts don't break diffs
- [ ] **SNAP-07**: `filetree diff a.json b.json` CLI subcommand emits the same diff as JSON

### Exports & reports (EXP)

- [ ] **EXP-01**: HTML report export — single self-contained file with inline `<style>`, inline `<svg>` treemap, `<script type="application/json">` data island; HTML-escaped paths; CSP locked to `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`
- [ ] **EXP-02**: XLSX (Excel) export — hand-rolled STORED-ZIP + OOXML SpreadsheetML strings; covers scan tree + Extensions + Top Files + Duplicates sheets; CRC-32 + DOS-time helpers in-house
- [ ] **EXP-03**: Print-friendly report layout in the HTML export (CSS `@media print`)

### Hardened `/api/delete` (API)

- [ ] **API-01**: Rebuild `/api/delete` to call the same `IFileOperation` pipeline as CLEAN-*; defaults to Recycle Bin, requires explicit `permanent=true` query param to bypass
- [ ] **API-02**: `/api/delete` validates paths against the last-scan root before accepting (no arbitrary loopback delete)
- [ ] **API-03**: Server-side confirmation token required — client must call `/api/cleanup/confirm` first and pass returned token to `/api/delete`

## v2 Requirements

Acknowledged but not in current roadmap.

### Scheduling (SCHED)

- **SCHED-01**: Windows Task Scheduler integration for unattended scans
- **SCHED-02**: Snapshot rotation policy (keep last N, prune older)

### Advanced cleanup (CLEAN-v2)

- **CLEAN-V2-01**: True in-app undo (track deleted-to paths, restore via `IFileOperation::MoveItems`)
- **CLEAN-V2-02**: Archive-instead-of-delete (zip selected to a single archive then send original to Recycle Bin)

### Visualization (VIZ-v2)

- **VIZ-V2-01**: Direct2D anti-aliased rendering for treemap and sunburst
- **VIZ-V2-02**: Animated transitions between treemap zoom levels

## Out of Scope

Explicitly excluded.

| Feature | Reason |
|---------|--------|
| Cross-platform native desktop (macOS / Linux GUI) | Existing desktop is raw Win32 FFI throughout; a toolkit rewrite is its own milestone. Server + CLI modes remain cross-platform. |
| Cloud-storage scanning (OneDrive content, SharePoint, S3) | TreeSize Professional territory; not Personal tier. |
| NTFS permissions / ACL browser | Professional tier. |
| Pixel-perfect cloning of TreeSize visuals / icons / copy | IP and trade-dress risk. We match information architecture and workflows only. |
| Multi-user, team, or networked deployment | Personal / internal use only. |
| Telemetry, auto-update, signed installer | Single-`.exe` distribution stays the default. |
| Adding third-party Rust crates beyond what v1 explicitly requires | Zero-dependency posture is a Key Decision. Any new crate is its own Key Decision with rationale. |
| GUI toolkit migration (Tauri / egui / iced) | Existing Win32 investment is substantial; not a v1 goal. |
| Web UI feature parity with desktop for v1 features | v1 invests in the desktop surface; web UI stays as-is unless a feature requires both. |

## Traceability

Empty initially. Populated by the roadmapper during phase mapping.

| Requirement | Phase | Status |
|-------------|-------|--------|
| REFAC-01 | TBD | Pending |
| SET-01 .. SET-05 | TBD | Pending |
| POL-01 .. POL-03 | TBD | Pending |
| SRCH-01 .. SRCH-05 | TBD | Pending |
| SEL-01 .. SEL-03 | TBD | Pending |
| CLEAN-01 .. CLEAN-10 | TBD | Pending |
| DUP-01 .. DUP-03 | TBD | Pending |
| VIZ-01 .. VIZ-03 | TBD | Pending |
| SNAP-01 .. SNAP-07 | TBD | Pending |
| EXP-01 .. EXP-03 | TBD | Pending |
| API-01 .. API-03 | TBD | Pending |

**Coverage:**
- v1 requirements: 48 total
- Mapped to phases: 0 (pending roadmapper)
- Unmapped: 48 ⚠️ (resolved after roadmap creation)

---
*Requirements defined: 2026-05-22*
*Last updated: 2026-05-22 after initial definition*
