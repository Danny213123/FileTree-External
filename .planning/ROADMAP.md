# Roadmap: FileTree v1

**Created:** 2026-05-22
**Mode:** Vertical MVP (each phase ships a usable end-to-end slice; Phase 1 is the documented refactor exception)
**Granularity:** standard
**Core Value:** Point at a folder, see what's taking space, and clean it up — fast, on a single Windows machine, with no install footprint beyond a single .exe.

This roadmap reaches rough TreeSize Personal-tier coverage atop the existing v0.1.0 brownfield baseline (working scan engine, native Win32 desktop, web UI with treemap, duplicates/extensions/errors tabs, CSV/JSON export, and an unsafe `/api/delete`). Phases derive from the four-way research consensus build order; deviation = roadmap risk.

## Phases

- [ ] **Phase 1: Module Split** — Refactor `src/main.rs` into modules without behavior change; unblocks every later phase.
- [ ] **Phase 2: Settings & Polish** — `%APPDATA%\FileTree\` settings store plus path bar, status bar, and keyboard shortcuts.
- [ ] **Phase 3: Search & Filter** — Live in-scan filtering by name / size / date / extension / category with saved named views.
- [ ] **Phase 4: Multi-Select Infrastructure** — Path-keyed selection across tree, duplicates, and top-files tabs (no delete yet).
- [ ] **Phase 5: Cleanup Workflow + Hardened API** — `IFileOperation` Recycle-Bin delete with full safety pipeline; rebuilds `/api/delete` on the same plumbing. HIGHEST-RISK PHASE.
- [ ] **Phase 6: Duplicates UX Upgrade** — Inline detail, smart-keep helpers, and batch delete through the standard cleanup pipeline.
- [ ] **Phase 7: Snapshots & Diff** — Save snapshots to `%APPDATA%`, list/rename/delete, bookmarks for pinned paths, two-snapshot diff with desktop Diff tab and `filetree diff` CLI subcommand.
- [ ] **Phase 8: Visualizations & Reports** — Native desktop treemap, sunburst, age-tinted treemap, self-contained HTML report (with print layout), and hand-rolled XLSX export.

## Phase Details

### Phase 1: Module Split
**Goal**: Split `src/main.rs` into a maintainable module layout so every subsequent phase can land cleanly.
**Mode:** mvp
**Depends on**: Nothing (foundational refactor)
**Requirements**: REFAC-01
**Success Criteria** (what must be TRUE):
  1. `cargo build` succeeds on Windows with the new module layout (`cli`, `server`, `scan`, `model`, `analytics`, `export`, `diff`, `io`, `desktop/*`).
  2. `cargo fmt --check` and `cargo clippy -- -D warnings` both pass.
  3. Manual smoke test confirms `desktop`, `serve`, and `scan` modes all run with identical observable behavior to v0.1.0 (same scan output, same desktop UI, same web UI, same CSV/JSON export).
  4. No new dependencies appear in `Cargo.toml` `[dependencies]`.
**Brownfield refactor exception**: This phase intentionally delivers no new user-visible features. Per ARCHITECTURE.md, the split is mechanical, runs in its own phase with no feature piggyback, and unblocks every later phase. The "vertical MVP" success criterion here is "the existing vertical slice still works end-to-end after the split."
**Plans:** 3 plans
Plans:
- [x] 01-01-PLAN.md — Extract 8 top-level modules (model, io, scan, analytics, export, server, cli, diff) bottom-up per CONTEXT D-05; each commit passes the four-command CI quad
- [ ] 01-02-PLAN.md — Split the inline `mod desktop` block into 8 files under `src/desktop/` (state, ffi, theme, paint, shell, tabs+treemap placeholders, finalized mod.rs facade); each commit passes the CI quad
- [ ] 01-03-PLAN.md — Final BLOCKING manual smoke checkpoint verifying scan / serve / desktop mode parity with v0.1.0 + zero-new-deps audit

### Phase 2: Settings & Polish
**Goal**: Settings persist across launches under `%APPDATA%\FileTree\`, and the desktop shell feels finished (path bar, status bar, keyboard shortcuts) so manual testing of every later phase is ergonomic.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: SET-01, SET-02, SET-03, SET-04, SET-05, POL-01, POL-02, POL-03
**Success Criteria** (what must be TRUE):
  1. User can change settings (last path, column widths, dark-mode toggle, hidden/symlink toggles, window size/position), close the app, reopen, and find every setting preserved.
  2. Launching a second instance while one is already running focuses the existing window instead of starting a duplicate process (named-mutex single-instance guard).
  3. User can pick a drive from a dropdown in the path bar and type a path with folder-name autocomplete instead of editing a plain text input.
  4. User can drive the app from the keyboard: Enter scans, Esc cancels a scan, Del initiates a delete on the current selection, Ctrl+F focuses search, Ctrl+E opens export, F5 refreshes.
  5. The status bar shows live scan stats (files / folders / errors / elapsed / throughput MB/s) during and after a scan.
**Risk callouts**: Atomic temp-file + rename writes are mandatory (Pitfall #7); a half-written `settings.json` from a crash or concurrent write would wipe user state. Settings file includes `schema_version: 1` from day one.
**Plans**: TBD
**UI hint**: yes

### Phase 3: Search & Filter
**Goal**: User can narrow a loaded scan to what matters by name / size / date / extension / category combinations, save useful combinations as named views, and watch results update live without re-scanning.
**Mode:** mvp
**Depends on**: Phase 1, Phase 2 (saved views persist via the SET-01 settings store)
**Requirements**: SRCH-01, SRCH-02, SRCH-03, SRCH-04, SRCH-05
**Success Criteria** (what must be TRUE):
  1. User can type a name search (glob or substring, case-insensitive) and see the tree narrow within ~150 ms of the last keystroke.
  2. User can set min/max size, modified-date range or age bucket, and an extension/category multi-select; all active filters compose and the result updates live.
  3. User can save the current filter combination as a named view, reapply it from a menu later, and find it preserved across app restarts.
  4. The underlying scan data is not mutated when filters change (verifiable: clearing all filters restores the full tree without re-scanning).
**Risk callouts**: This phase validates the immutable-`ScanResult` + derived-`VisibleRows` pattern (Pattern 1 in ARCHITECTURE.md) before cleanup needs it. Filter UI must use discrete controls, not a hand-rolled query DSL (Pitfall: Anti-Pattern 6).
**Plans**: TBD
**UI hint**: yes

### Phase 4: Multi-Select Infrastructure
**Goal**: User can build a multi-item selection across the tree, duplicates tab, and top-files tab and trust that the selection means what it shows — even across re-scans — with no destructive action yet.
**Mode:** mvp
**Depends on**: Phase 1, Phase 3 (selection works on the filtered view)
**Requirements**: SEL-01, SEL-02, SEL-03
**Success Criteria** (what must be TRUE):
  1. User can multi-select in the main tree, duplicates tab, and top-files tab via click, Ctrl+click, Shift+click, and Ctrl+A; selected rows are visibly highlighted.
  2. The status bar shows a live selection summary (e.g. "12 items selected, 4.2 GB (4.5 GB allocated)").
  3. After a re-scan, items whose paths still exist remain selected; items whose paths are gone are silently dropped and a hint shows "N of M items remain selected" (selection keyed by stable full-path string, NOT `Vec<NodeRecord>` index).
**Risk callouts**: Selection MUST be keyed by stable path string, never by `usize` ID — index-keyed selection is the wrong-path bug delivered through multi-select (Pitfall #9). This phase ships read-only so the identity model can be exercised before any destructive op uses it.
**Plans**: TBD
**UI hint**: yes

### Phase 5: Cleanup Workflow + Hardened API
**Goal**: User can safely delete or move selected files and folders via a Recycle-Bin-default `IFileOperation` pipeline with mandatory confirmation, TOCTOU re-stat, reparse-point safety, post-action summary, and lowest-common-ancestor subtree refresh — and the `/api/delete` HTTP route is rebuilt to use the same pipeline so it is no longer a permanent-delete trap. HIGHEST-RISK SINGLE PHASE.
**Mode:** mvp
**Depends on**: Phase 1, Phase 2 (settings + drive type), Phase 4 (selection model)
**Requirements**: CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04, CLEAN-05, CLEAN-06, CLEAN-07, CLEAN-08, CLEAN-09, CLEAN-10, API-01, API-02, API-03
**Success Criteria** (what must be TRUE):
  1. User can delete a multi-item selection via Del or a Delete button: a mandatory confirmation dialog shows the count, total bytes, top-N largest paths verbatim, and a drive-type warning for network/removable/system drives; default is Recycle Bin, permanent delete is an explicit per-action checkbox.
  2. Deleted items are recoverable from the Windows Recycle Bin (verified by deleting a small file via the UI and opening Recycle Bin in Explorer with original name and path metadata intact); a junction created with `mklink /J test C:\Windows` inside a test folder is deleted as a single reparse node without touching `C:\Windows`.
  3. After cleanup completes, a post-action summary shows bytes reclaimed, files affected, per-path errors in a scrollable list with "Copy to clipboard" and "Open Recycle Bin" links; the affected subtree refreshes from the lowest common ancestor without flicker; cleanup UI is disabled while a scan is in progress and scans cannot start while cleanup is in flight.
  4. User can move a selection to a target folder via the same safety pipeline (`IFileOperation::MoveItems`, same confirmation, same drive-type warning).
  5. `curl http://127.0.0.1:7878/api/delete?path=C:\Windows\System32` returns an error and does not act; deleting via `/api/delete` requires first calling `/api/cleanup/confirm` to obtain a server-side token, validates paths live under the last-scan root, and routes through the same `IFileOperation` pipeline (defaults to Recycle Bin, requires explicit `permanent=true` to bypass).
**Risk callouts**: Pitfalls #1 (permanent-delete-by-default trap), #2 (junction traversal — MSRC 42 CVEs in 2024), #3 (TOCTOU), #4 (long paths >260 chars), #8 (UI thread blocking + COM apartment) all converge here. Unit tests required: `Filter::matches`, path quoting, double-null termination, `Selection::summarize()`, settings JSON round-trip. Ship behind a feature flag for one internal-use cycle before flipping default-on. Spike `IFileOperationProgressSink` Rust FFI vtable shape before full implementation.
**Plans**: TBD
**UI hint**: yes

### Phase 6: Duplicates UX Upgrade
**Goal**: User can investigate a duplicate group inline, use smart-keep helpers to safely select redundant copies, and batch-delete them through the standard cleanup confirmation pipeline.
**Mode:** mvp
**Depends on**: Phase 5 (reuses CLEAN-* pipeline)
**Requirements**: DUP-01, DUP-02, DUP-03
**Success Criteria** (what must be TRUE):
  1. User can click a duplicate group and see an inline detail view listing every full path, modified time, size, and parent folder for files in that group.
  2. User can apply smart-selection helpers ("keep newest", "keep in shortest path", "keep one per folder"); each helper always leaves at least one file per group unchecked, verified across groups with tied mtimes (deterministic tiebreak).
  3. User can batch-delete the current duplicate selection and see the standard Recycle-Bin confirmation dialog from Phase 5 — same drive-type warning, same post-action summary, same subtree refresh.
**Risk callouts**: Smart-keep helpers must never leave a duplicate group with zero unchecked files (would orphan the data). Hardlinks reported as duplicates: deleting all hardlinks to a file frees its bytes; deleting all-but-one frees nothing — surface this in the summary if/when hardlink awareness lands.
**Plans**: TBD
**UI hint**: yes

### Phase 7: Snapshots & Diff
**Goal**: User can save the current scan as a named snapshot, manage saved snapshots and bookmarked paths from menus, and diff any two snapshots to see what was added, removed, grown, shrunk, or unchanged — both in a desktop Diff tab and as a `filetree diff` CLI subcommand.
**Mode:** mvp
**Depends on**: Phase 1, Phase 2 (settings store for bookmarks + snapshot index)
**Requirements**: SNAP-01, SNAP-02, SNAP-03, SNAP-04, SNAP-05, SNAP-06, SNAP-07
**Success Criteria** (what must be TRUE):
  1. User can save the current scan as a snapshot to `%APPDATA%\FileTree\snapshots\<name>.json` and later list, rename, or delete saved snapshots from a Snapshots menu.
  2. User can pin frequently-scanned paths (drives, common folders) as bookmarks, see them in a bookmarks UI, and pick one to start a new scan; bookmarks survive app restarts.
  3. User can pick two snapshots and open a Diff tab showing five categories — added, removed, grown, shrunk, unchanged — with totals and per-row deltas; identical re-scans of the same root (mixed case, trailing slash, drive-letter shift) produce a near-zero-noise diff (path normalization via `GetFullPathNameW` + lowercase compare key + `GetLongPathNameW` + relative-to-root keying).
  4. User can run `filetree diff a.json b.json` from the CLI and get the same diff emitted as JSON.
**Risk callouts**: Path normalization is foundational (Pitfall #6). Snapshot files can be hundreds of MB for big scans; document the size budget and consider a "compact snapshot" mode in execution if profiling shows it's needed.
**Plans**: TBD
**UI hint**: yes

### Phase 8: Visualizations & Reports
**Goal**: User can see disk usage in three native visualizations (treemap, sunburst, age-tinted treemap) and export a scan as a self-contained HTML report (with print layout) or a multi-sheet XLSX workbook.
**Mode:** mvp
**Depends on**: Phase 1 (module layout for `desktop::paint`, `export::html`, `export::xlsx`); benefits from Phase 5/7 being final so reports reflect the final feature set.
**Requirements**: VIZ-01, VIZ-02, VIZ-03, EXP-01, EXP-02, EXP-03
**Success Criteria** (what must be TRUE):
  1. User can open a native-desktop treemap panel (no web UI required) that renders without flicker via GDI double-buffering and updates when the underlying scan or filter changes.
  2. User can toggle a sunburst / radial view as an alternate visualization and an age-tinted treemap mode where hue maps to mtime (recent = green, old = red) — the headline differentiator.
  3. User can export the current scan as a single self-contained `.html` file with inline `<style>`, inline `<svg>` treemap, and a `<script type="application/json">` data island; opening it in a browser shows the report with all paths HTML-escaped (a test file named `<script>alert(1)</script>.txt` does NOT execute), CSP locked to `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`, and a print-friendly layout via CSS `@media print`.
  4. User can export the current scan as an `.xlsx` workbook with scan-tree, Extensions, Top Files, and Duplicates sheets; the file opens cleanly in Excel 2019, Excel 365, and Excel Online with no "Repaired" warning (hand-rolled STORED-ZIP + OOXML SpreadsheetML, CRC-32 + DOS-time helpers in-house, accepted scope-cost trade).
**Risk callouts**: XLSX is the largest "new code" surface; Excel silently "Repairs" malformed OOXML. User has explicitly accepted the hand-rolled scope cost over adding a crate. HTML report XSS surface for filenames containing `<script>` must be tested. Visualizations: query `GetDpiForWindow` and scale, don't hard-code pixels.
**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Module Split | 0/3 | Planned | - |
| 2. Settings & Polish | 0/0 | Not started | - |
| 3. Search & Filter | 0/0 | Not started | - |
| 4. Multi-Select Infrastructure | 0/0 | Not started | - |
| 5. Cleanup Workflow + Hardened API | 0/0 | Not started | - |
| 6. Duplicates UX Upgrade | 0/0 | Not started | - |
| 7. Snapshots & Diff | 0/0 | Not started | - |
| 8. Visualizations & Reports | 0/0 | Not started | - |

## Coverage

All 46 v1 requirements from REQUIREMENTS.md are mapped to exactly one phase. No orphans; no duplicates. (REQUIREMENTS.md header text claims "48 total" but the enumerated v1 list contains 46 items: REFAC=1, SET=5, POL=3, SRCH=5, SEL=3, CLEAN=10, DUP=3, VIZ=3, SNAP=7, EXP=3, API=3. The header count will be corrected during the next requirements update.)

| Phase | Requirements | Count |
|-------|--------------|-------|
| 1 | REFAC-01 | 1 |
| 2 | SET-01..05, POL-01..03 | 8 |
| 3 | SRCH-01..05 | 5 |
| 4 | SEL-01..03 | 3 |
| 5 | CLEAN-01..10, API-01..03 | 13 |
| 6 | DUP-01..03 | 3 |
| 7 | SNAP-01..07 | 7 |
| 8 | VIZ-01..03, EXP-01..03 | 6 |
| **Total** | | **46** |

## Cross-Phase Constraints

These constraints apply across all phases and override anything in PROJECT.md only if PROJECT.md is silent:

- **Zero new Rust crates.** `Cargo.toml` `[dependencies]` stays empty. Any proposed crate is a Key Decision logged in PROJECT.md.
- **Single-file `.exe` distribution.** No installer, no auto-update, no telemetry.
- **Destructive ops default to Recycle Bin.** Permanent delete is opt-in per action, never via a setting.
- **Cleanup, exports, snapshot save/diff all run on background threads.** Never block the UI message loop. `PostMessage` (not `SendMessage`) for cross-thread results; LPARAM payloads are heap-allocated `Box::into_raw`.
- **Selection state is keyed by full-path string, not by `usize` index.** Indices change between scans; paths survive.
- **No `std::fs::remove_*` for user-facing destructive ops.** Single code path through `IFileOperation` with explicit flags.

---
*Roadmap created: 2026-05-22*
*Last updated: 2026-05-22 (Phase 1 plans created)*
