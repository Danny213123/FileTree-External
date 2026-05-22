# Architecture Research

**Domain:** Windows native disk-usage explorer (brownfield), zero-dep Rust + Win32 FFI + embedded web UI
**Researched:** 2026-05-22
**Confidence:** HIGH (grounded entirely in the existing codebase map; recommendations are evolution, not re-architecture)

---

## TL;DR

1. **Split `src/main.rs` now, in a single dedicated phase, before any v1 feature lands.** The file is ~5,055 lines and the new milestone adds ~7 substantial subsystems. Continuing as monofile guarantees rework. The split is mechanical (no behavior change), Clippy-clean, and unblocks every other phase.
2. **Promote `DesktopState` from "bag of HWNDs + last scan" to an explicit state machine** with a `view_model` layer (`VisibleRows`, `Selection`, `ActiveFilter`) that is recomputed from the immutable `ScanResult` rather than mutated in place. This is what enables multi-select, search overlays, and flicker-free post-cleanup refresh.
3. **Each new responsibility is its own module under `desktop/`**: `desktop::search`, `desktop::cleanup`, `desktop::settings`, `desktop::snapshot`, `desktop::export`. They communicate with the UI thread exclusively via the existing `PostMessageW` + `WM_APP+N` pattern that `WM_SCAN_DONE` already uses.
4. **Snapshot diffing uses the existing flat-`Vec<NodeRecord>` JSON format** as the on-disk persistence format (gzip-free, since zero-dep). Diffing is a pure function over two `ScanResult`s keyed by relative path. No external crate required.
5. **Build order:** Module split → Settings store → Search/filter → Multi-select → Cleanup workflow → Snapshot persistence → Snapshot diff → Sunburst → HTML/XLSX export. Each phase yields a usable end-to-end slice.

---

## Standard Architecture

### Current System (baseline, unchanged surface)

```
┌────────────────────────────────────────────────────────────────┐
│                         main() — CLI dispatch                  │
└─────┬────────────────────┬────────────────────┬────────────────┘
      ▼                    ▼                    ▼
┌──────────┐         ┌───────────┐         ┌─────────┐
│ desktop  │         │  serve    │         │  scan   │
│  (Win32) │         │ (HTTP/JS) │         │  (CLI)  │
└─────┬────┘         └─────┬─────┘         └────┬────┘
      └────────────────────┴──────────────────────┘
                           ▼
                ┌──────────────────────┐
                │  Scan Engine (BFS)   │
                │ workers + Condvar Q  │
                └──────────┬───────────┘
                           ▼
                ┌──────────────────────┐
                │ ScanResult           │
                │  Vec<NodeRecord>     │  ← immutable after aggregate
                └──────────────────────┘
```

### Target Architecture (after milestone v1)

```
┌────────────────────────────────────────────────────────────────────┐
│  src/main.rs                — CLI dispatch only (~150 lines)       │
└─────┬────────────────────┬────────────────────┬────────────────────┘
      ▼                    ▼                    ▼
┌──────────┐         ┌───────────┐         ┌──────────┐
│ desktop  │         │  server   │         │   cli    │
│  module  │         │  module   │         │ command  │
└─────┬────┘         └─────┬─────┘         └────┬─────┘
      └────────────────────┴──────────────────────┘
                           │
                           ▼
            ┌──────────────────────────┐
            │  scan  (engine)          │
            │   workers, queue, FNV    │
            └─────────────┬────────────┘
                          │
                          ▼
            ┌──────────────────────────┐
            │  model  (ScanResult,     │
            │   NodeRecord, ids…)      │
            └─────────────┬────────────┘
                          │
        ┌────────┬────────┼────────┬────────┐
        ▼        ▼        ▼        ▼        ▼
   ┌────────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌────────┐
   │analytics│ │export│ │diff │ │ search│ │  io   │
   │ (ext,   │ │(json,│ │     │ │       │ │ (perm,│
   │  age,   │ │ csv, │ │     │ │       │ │  win, │
   │  dupes) │ │ html,│ │     │ │       │ │ recyc)│
   │         │ │ xlsx)│ │     │ │       │ │       │
   └────────┘ └──────┘ └──────┘ └──────┘ └────────┘
                  ▲                              ▲
                  │                              │
                  └── desktop/cleanup ───────────┘
                  └── desktop/snapshot ──────────┘
                  └── desktop/settings ──────────┘
                  └── desktop/search ────────────┘
                  └── desktop/view ──────────────┘
```

### Component Responsibilities (target)

| Component | Owns | Typical Implementation |
|-----------|------|------------------------|
| `main` | argv parsing, mode dispatch | thin `match args[0]` shim |
| `cli` | headless `scan` subcommand | calls `scan::run` + `export::json/csv` |
| `server` | HTTP/1.1 server + routes | per-connection thread, current routes preserved |
| `desktop::app` | message loop, window class, paint dispatch | current `desktop::run` body, slimmed |
| `desktop::view` | row layout, columns, paint helpers | `VisibleRows`, sort, indentation, double-buffer |
| `desktop::search` | search bar, filter pipeline | text + size + mtime + ext predicate composed into `Filter` |
| `desktop::cleanup` | multi-select model, confirm dialog, `SHFileOperationW` invocation, post-action refresh | new module |
| `desktop::settings` | load/save `%APPDATA%\FileTree\settings.json` | hand-rolled JSON; same pattern as serializers |
| `desktop::snapshot` | persist `ScanResult` to `%APPDATA%\FileTree\snapshots\<id>.json`, list, diff | new module |
| `desktop::export` | HTML report + XLSX writer | XLSX = ZIP of XML; ZIP/STORE method (no compression) is ~200 lines hand-rolled |
| `scan` | worker threads, BFS queue, aggregation | current `scan_path_with_progress` family |
| `model` | `NodeRecord`, `ScanResult`, `NodeId`, `path_index` | shared by every other module |
| `analytics` | `extension_stats`, `age_stats`, `top_files`, `duplicate_candidates`, exact-hash | current code, lifted |
| `export` | `scan_result_to_json`, `_csv`, `_html`, `_xlsx` | builder-pattern `push_*` helpers |
| `diff` | `SnapshotDiff::compute(&ScanResult, &ScanResult)` | pure function, keyed by relative path |
| `io::windows` | `platform_allocated_size`, `is_hidden_entry`, `SHFileOperationW`, `SHGetKnownFolderPath` | replaces current scattered `#[cfg(windows)]` blocks |

---

## Recommended Project Structure

```
src/
├── main.rs                  # ~150 lines: argv → dispatch
├── cli.rs                   # run_scan_command
├── server/
│   ├── mod.rs               # run_server, AppState
│   ├── http.rs              # read_http_request, respond_*
│   └── routes.rs            # handle_client + all /api/* routes
├── scan/
│   ├── mod.rs               # scan_path_with_progress
│   ├── worker.rs            # worker_loop, scan_directory_job, add_node
│   ├── aggregate.rs         # aggregate_nodes, snapshot_scan_result
│   └── options.rs           # ScanOptions, ScanError
├── model.rs                 # NodeRecord, ScanResult, NodeId helpers
├── analytics/
│   ├── mod.rs
│   ├── extensions.rs        # extension_stats
│   ├── age.rs               # age_stats
│   ├── top.rs               # top_file_ids, largest_dir_ids
│   └── duplicates.rs        # duplicate_candidates, exact_duplicates_json, fnv1a_file
├── export/
│   ├── mod.rs
│   ├── json.rs              # scan_result_to_json, push_json_string
│   ├── csv.rs               # scan_result_to_csv, push_csv_field
│   ├── html.rs              # NEW: self-contained HTML report
│   └── xlsx.rs              # NEW: minimal ZIP-of-XML writer
├── diff.rs                  # NEW: SnapshotDiff (pure function)
├── io/
│   ├── mod.rs
│   └── windows.rs           # platform_allocated_size, is_hidden_entry, SHFileOperationW
└── desktop/
    ├── mod.rs               # #[cfg(windows)] run(), window class, message loop
    ├── ffi.rs               # all `extern "system"`, repr(C) structs, constants
    ├── state.rs             # DesktopState, with_state_mut, STATE, DARK_*
    ├── paint.rs             # paint_window, GDI double-buffer, row/column rendering
    ├── view.rs              # VisibleRows, refresh_visible_rows, sort, expand/collapse
    ├── controls.rs          # create_controls, ID_* constants, tab buttons
    ├── search.rs            # NEW: SearchBar, Filter, predicate composition
    ├── cleanup.rs           # NEW: Selection, confirm dialog, SHFileOperationW, refresh
    ├── settings.rs          # NEW: load/save settings.json, column widths, last path
    ├── snapshot.rs          # NEW: list/save/load snapshots, invoke diff
    ├── export.rs            # NEW: file-save dialog, dispatch to export::html / export::xlsx
    └── menu.rs              # context menu, IShellFolder / IContextMenu COM glue
```

### Structure Rationale

- **`desktop/` is its own folder, not one file.** The current 2,000+ line `mod desktop` block is the single biggest readability tax in the codebase. Splitting it into ~10 files of ~200-400 lines each is the highest-leverage refactor in the entire milestone — every subsequent v1 feature lands cleaner.
- **`model.rs` is shared by everyone** so `analytics`, `export`, `diff`, and `desktop` can depend on the same `NodeRecord` without cycles.
- **`io::windows` consolidates Win32 filesystem calls** that today are sprinkled across `src/main.rs:1683-1735` plus ad-hoc COM in the desktop module. New cleanup code (`SHFileOperationW`) goes here, not in the desktop module — so it stays testable on its own and reusable from the CLI later.
- **`export/` collapses serializers into one home.** Adding HTML and XLSX next to the existing JSON/CSV is a smaller cognitive jump than scattering them.
- **`diff.rs` is one file at the top level.** It's pure data-in/data-out and doesn't belong inside `desktop/` even though only the desktop UI consumes it today — the CLI may want a `filetree diff a.json b.json` subcommand later.
- **`Cargo.toml` stays zero-dep.** Nothing in this split requires a crate. (The XLSX writer is the only borderline call — see XLSX section below.)

---

## Architectural Patterns

### Pattern 1: Immutable `ScanResult` + Derived ViewModel

**What:** `ScanResult` is constructed once by the scan engine, aggregated once, then never mutated. All filtering, sorting, multi-select, and search produce derived state — never mutate the source.

**When to use:** Every desktop subsystem that reads scan data.

**Trade-offs:**
- ✓ Cleanup refresh is trivial: re-scan affected subtree, swap `ScanResult` atomically, recompute `VisibleRows` from scratch — no diff-merging, no stale indices.
- ✓ Snapshot diff is a pure function over two `ScanResult`s.
- ✗ Re-derivation cost on every interaction; mitigated by caching `VisibleRows` and only recomputing when filter/sort/expand changes.

**Example shape:**
```rust
// model.rs
pub struct ScanResult { pub nodes: Vec<NodeRecord>, pub roots: Vec<NodeId>, .. }

// desktop/view.rs
pub struct VisibleRows {
    pub ids: Vec<NodeId>,        // in display order, after filter + sort + expand
    pub depths: Vec<u16>,
    pub filter_signature: u64,   // hash of (sort_key, filter, expanded_set)
}

// recompute only when signature changes
pub fn refresh_visible_rows(state: &mut DesktopState) {
    let sig = compute_signature(&state);
    if state.visible.filter_signature == sig { return; }
    state.visible = build_visible_rows(&state.current_scan, &state.filter, &state.expanded);
    state.visible.filter_signature = sig;
}
```

### Pattern 2: UI-Thread Single-Owner + `PostMessageW` for Async Results

**What:** All `DesktopState` mutation happens on the Win32 UI thread inside `window_proc`. Background threads (scan, exact-hash, snapshot save, cleanup) never touch state directly — they `PostMessageW` a custom `WM_APP+N` message with a `Box<T>` payload, and `window_proc` unpacks it.

**When to use:** Every new background operation in the desktop module.

**Trade-offs:**
- ✓ No additional locking on `DesktopState`; the existing `Mutex<DesktopState>` becomes effectively single-threaded (the lock still exists for `with_state_mut` re-entrancy safety, but never contended in practice).
- ✓ Matches the proven `WM_SCAN_DONE` / `WM_SCAN_PROGRESS` pattern already in the code.
- ✗ Requires defining a `WM_APP+N` constant and a `Box<T>` payload type per operation. Cheap.

**Example shape:**
```rust
// New message codes (continue the existing series from WM_SCAN_DONE)
const WM_CLEANUP_DONE:    UINT = WM_APP + 10;
const WM_SNAPSHOT_LOADED: UINT = WM_APP + 11;
const WM_DIFF_READY:      UINT = WM_APP + 12;
const WM_EXPORT_DONE:     UINT = WM_APP + 13;

// Background thread
thread::spawn(move || {
    let outcome = cleanup::run(selection, options); // calls SHFileOperationW
    let boxed = Box::into_raw(Box::new(outcome));
    unsafe { PostMessageW(hwnd, WM_CLEANUP_DONE, 0, boxed as LPARAM); }
});

// UI thread
WM_CLEANUP_DONE => {
    let outcome: Box<CleanupOutcome> = unsafe { Box::from_raw(lparam as *mut _) };
    with_state_mut(|s| cleanup::apply_outcome(s, *outcome));
    // triggers partial re-scan or in-place tree pruning
}
```

### Pattern 3: Filter Pipeline as Composable Predicates

**What:** Search/filter is one `Filter` struct holding text glob + size range + mtime range + extension set. `Filter::matches(&NodeRecord) -> bool` is the single chokepoint. Filtering is applied during `refresh_visible_rows`, not against the underlying tree.

**When to use:** All search and saved-view features.

**Trade-offs:**
- ✓ Search-as-you-type works without rebuilding tree state.
- ✓ Saved views = serialized `Filter`.
- ✓ Filter is reusable for CLI (`filetree scan ... --filter ...`).
- ✗ Linear scan per filter change. For 1M nodes, ~20-50 ms — acceptable for typing; debounce input by 100 ms.

**Example shape:**
```rust
pub struct Filter {
    pub text:      Option<Pattern>,       // glob or substring
    pub size:      Option<(u64, u64)>,
    pub modified:  Option<(SystemTime, SystemTime)>,
    pub exts:      Option<HashSet<String>>,
}
impl Filter {
    pub fn is_empty(&self) -> bool { ... }
    pub fn matches(&self, n: &NodeRecord) -> bool {
        self.text.as_ref().map_or(true, |p| p.matches(&n.name))
            && self.size.map_or(true, |(lo,hi)| n.size >= lo && n.size <= hi)
            && self.modified.map_or(true, |(lo,hi)| n.modified.map_or(false,|m| m>=lo && m<=hi))
            && self.exts.as_ref().map_or(true, |s| n.ext().map_or(false, |e| s.contains(e)))
    }
}
```

### Pattern 4: Snapshot = Persisted `ScanResult`, Diff = Pure Function

**What:** A snapshot is the existing `scan_result_to_json()` output written to `%APPDATA%\FileTree\snapshots\<scan_id>\<timestamp>.json`. Diff is a pure function over two `ScanResult`s, keyed by **path relative to root** (not by `NodeId`, which is per-scan).

**When to use:** SCAN-05 (snapshot history) and SCAN-04 (saved scans).

**Trade-offs:**
- ✓ Reuses the serializer that already exists — no new format to maintain.
- ✓ Diff is testable in isolation (CLI `filetree diff a.json b.json` falls out for free).
- ✓ No external crate (no gzip, no DB).
- ✗ Snapshot files are large (hundreds of MB for big scans). Mitigation: store only the top-N or rolled-up-above-threshold nodes; offer a "compact snapshot" mode.

**Example shape:**
```rust
// diff.rs
pub struct SnapshotDiff {
    pub added:    Vec<DiffEntry>,
    pub removed:  Vec<DiffEntry>,
    pub changed:  Vec<DiffChange>,   // size delta
    pub total_delta_bytes: i64,
}
pub fn compute(prev: &ScanResult, curr: &ScanResult) -> SnapshotDiff {
    let prev_map: HashMap<&str, &NodeRecord> = prev.nodes.iter()
        .map(|n| (n.relative_path.as_str(), n)).collect();
    // ... single pass over curr.nodes, plus residual pass for `removed`
}
```

### Pattern 5: Flicker-Free Refresh via Atomic ViewModel Swap

**What:** Post-cleanup tree refresh follows: (1) re-scan affected subtree on background thread → (2) build a new `ScanResult` with the subtree replaced → (3) build new `VisibleRows` → (4) on UI thread, swap both atomically inside one `with_state_mut`, then **one** `InvalidateRect(hwnd, NULL, FALSE)` (note `FALSE` to skip background erase). GDI double-buffer (`CreateCompatibleDC` + `BitBlt`) already in `paint_window` prevents tearing.

**When to use:** Cleanup completion, snapshot reload, search clear.

**Trade-offs:**
- ✓ One repaint, no intermediate states visible to the user.
- ✓ Selection survives refresh if selected paths still exist (resolve by path string, not `NodeId`).
- ✗ Re-scan of large subtrees can take seconds; show a "Refreshing…" overlay (a separate `WM_PAINT` flag).

---

## Data Flow

### Cleanup Workflow (the headline destructive flow)

```
User selects rows (Shift+Click / Ctrl+Click / Ctrl+A in filter)
    │
    ▼
desktop::cleanup::Selection { ids: Vec<NodeId>, paths: Vec<PathBuf>,
                              total_bytes: u64, file_count, dir_count }
    │  (Del key or "Delete" button)
    ▼
desktop::cleanup::show_confirm_dialog()
    ├── Count + total bytes
    ├── Up to 10 sample paths
    ├── [x] Send to Recycle Bin (default)
    ├── [ ] Permanently delete
    └── [Cancel] [Delete]
    │
    ▼ (user confirms)
thread::spawn(move || {
    let op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: double_null_terminated(&paths),
        fFlags: FOF_NOCONFIRMATION | FOF_NOERRORUI
              | (if recycle { FOF_ALLOWUNDO } else { 0 }),
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    let outcome = CleanupOutcome {
        bytes_reclaimed_estimate,
        succeeded_paths,        // derived by checking existence
        failed_paths,           // (path, error_str)
        cancelled: op.fAnyOperationsAborted,
    };
    PostMessageW(hwnd, WM_CLEANUP_DONE, 0, Box::into_raw(Box::new(outcome)));
})
    │
    ▼  (back on UI thread)
WM_CLEANUP_DONE handler:
    1. Show modal summary ("Reclaimed 4.2 GB, 2 errors. View errors?")
    2. For each successful path: enqueue parent_path into refresh_set
    3. spawn background re-scan of the **lowest common ancestor** of refresh_set
       (avoids N small re-scans; one re-scan covers all of them)
    4. On re-scan complete → WM_SCAN_DONE handler → swap subtree in ScanResult →
       rebuild VisibleRows → single InvalidateRect.
    5. Selection cleared (paths no longer exist).
```

**Key invariants:**
- The actual delete happens off the UI thread; the message loop stays responsive.
- **Confirmation dialog is mandatory** (project constraint). Cannot be suppressed by a setting in v1.
- The Win32 `SHFileOperationW` API already provides its own progress dialog when given many files; do not suppress it with `FOF_SILENT`.
- "Restore from Recycle Bin" is **not** a custom undo. It's a one-line hint in the summary dialog ("Items were sent to the Recycle Bin. Open Recycle Bin to restore.") — CLEAN-06 in PROJECT.md is intentionally minimal.

### Search-Filter Overlay (no flicker, no tree rebuild)

```
User types in search box
    │  (WM_COMMAND from edit control, debounced 100 ms via SetTimer)
    ▼
desktop::search::parse(input) → Filter
    │
    ▼
with_state_mut(|s| {
    s.filter = new_filter;
    s.expanded = expand_to_show_matches(&s.current_scan, &s.filter);
                 // auto-expand ancestors of matches
    refresh_visible_rows(s);   // ← only this recomputes; ScanResult untouched
});
InvalidateRect(rows_hwnd, NULL, FALSE);
```

**No tree rebuild. No re-scan. No allocation of a new node store.** The `Vec<NodeRecord>` stays. Only `VisibleRows.ids` changes.

### Snapshot Diff Flow

```
User: "Compare to previous snapshot…"
    │
    ▼
desktop::snapshot::list_for_root(root_path)
    → Vec<SnapshotMeta { id, timestamp, path }>
    │
    ▼
User picks one
    │
    ▼
thread::spawn(move || {
    let prev = snapshot::load(path)?;        // parse the saved JSON
    let curr = current_scan.clone();
    let d = diff::compute(&prev, &curr);
    PostMessageW(hwnd, WM_DIFF_READY, 0, Box::into_raw(Box::new(d)));
})
    │
    ▼  (UI thread)
WM_DIFF_READY handler:
    state.active_view = View::Diff(diff);
    refresh_visible_rows(state);
    InvalidateRect(...);
```

The Diff view is a **new tab panel** alongside Summary/Extensions/Top/Duplicates/Errors — fits the existing tab pattern in `paint_window`.

### Settings Persistence

```
Load: desktop::app::create() →
    settings::load() reads %APPDATA%\FileTree\settings.json (via SHGetKnownFolderPath)
    Apply to: last_path, dark_mode, column_widths[], show_hidden, follow_links, sort_key

Save: any setting change →
    settings::mark_dirty()
    on WM_TIMER (every 5 s) or WM_DESTROY → settings::flush()
    debounced write to avoid hammering disk on column-drag.
```

Format: hand-built JSON, same pattern as `scan_result_to_json`. ~50 lines.

### State Management Topology (target)

```
ScanResult (immutable, Arc-shared)                ← scan engine produces, swapped atomically
       ▲
       │ read-only
       │
DesktopState (single-threaded after the lock)
   ├─ current_scan: Option<Arc<ScanResult>>
   ├─ filter:       Filter                        ← search.rs writes
   ├─ selection:    Selection                     ← cleanup.rs reads/writes
   ├─ expanded:     HashSet<NodeId>
   ├─ sort_key:     SortKey
   ├─ active_view:  View::Tree | View::Diff(_) | View::Snapshot(_)
   ├─ visible:      VisibleRows                   ← derived; view.rs rebuilds
   └─ settings:     Settings                      ← settings.rs persists
```

---

## Build Order (Roadmap-Ready)

Each phase delivers a usable, demoable slice on its own. Order is dictated by **enabling dependencies**, not feature priority.

### Phase A — Module split (no behavior change)
**Why first:** Adds zero features but unblocks everything else. Doing it after v1 features land means refactoring code with active feature work, which is strictly worse.
**Scope:** Move code per the target structure. Run `cargo fmt` + `cargo clippy -D warnings` + `cargo test` (such as it is) + manual smoke test of desktop / serve / scan modes.
**Risk:** Low. Mechanical refactor. The biggest gotcha is the `mod desktop` block's existing module-level `#![allow(...)]` attributes — they must follow the desktop module into `desktop/mod.rs`.
**Deliverable:** Same binary, organized files. CI green.

### Phase B — Settings persistence (POLISH-04)
**Why second:** Every later phase wants to persist *something* (last path, column widths, recent snapshots, saved filters). Establish the store first; piggyback the rest.
**Scope:** `desktop/settings.rs` + `%APPDATA%\FileTree\` directory creation + last-path / dark-mode / column-widths / toggles round-trip.
**Deliverable:** Open the app, change settings, close, reopen — settings stick.

### Phase C — Path bar + status bar + keyboard shortcuts (POLISH-01/02/03)
**Why now:** Cheap wins, no architectural dependencies, makes the app dramatically more usable for the rest of the milestone's manual testing.
**Scope:** New controls in `desktop/controls.rs`; keyboard shortcuts in `window_proc` `WM_KEYDOWN` / accelerator table.

### Phase D — Search + filter (SEARCH-01 through SEARCH-04)
**Why now:** Pure derived-state work — no destructive ops, no new background threads, only `VisibleRows` recomputation. Validates Pattern 1 (immutable ScanResult + derived view) before cleanup needs it.
**Scope:** `desktop/search.rs` + `Filter` + search bar control + filter-bar panel + debounced recompute.
**Deliverable:** Type "*.log size:>100MB age:>1y" → tree filters live.

### Phase E — Multi-select (CLEAN-01)
**Why now:** Read-only feature; lets you exercise selection semantics without the destructive risk.
**Scope:** Shift+Click / Ctrl+Click / Ctrl+A in `desktop/view.rs`; `Selection` model in `desktop/cleanup.rs` (selection only, no deletion yet).
**Deliverable:** Visible highlighting + status bar shows "12 items selected, 4.2 GB".

### Phase F — Cleanup workflow (CLEAN-02 through CLEAN-06)
**Why now:** Selection (E) + filter (D) + path resolution (B) all exist. Background-thread pattern is proven by the existing scan flow.
**Scope:** `desktop/cleanup.rs`, confirm dialog, `SHFileOperationW` wrapper in `io/windows.rs`, post-action partial re-scan, summary dialog.
**Risk:** Highest of the milestone. Mitigations: (1) recycle-bin default, (2) mandatory confirm, (3) ship behind a feature flag for one internal-use cycle, (4) **add unit tests for** `Selection::summarize()`, path quoting, and double-null termination — the test gap in the current codebase makes this a higher-risk feature than it would be in a tested codebase.

### Phase G — Duplicates UX upgrade (DUP-02/03/04)
**Why now:** Reuses the cleanup confirm + `SHFileOperationW` from F. Adds smart-selection helpers on top of existing `exact_duplicates_json`.

### Phase H — Snapshot save + saved-scans bookmarks (SCAN-04, SCAN-05 save half)
**Why now:** Settings store (B) exists. JSON serializer already produces the on-disk format.
**Scope:** `desktop/snapshot.rs` save + list; "Saved scans" panel in settings; auto-snapshot-on-scan-complete option.

### Phase I — Snapshot diff (SCAN-05 diff half, SCAN-06)
**Why now:** Snapshots exist (H), immutable-ScanResult pattern is established.
**Scope:** `diff.rs` (pure function) + Diff tab in the desktop UI + CLI subcommand `filetree diff a.json b.json`.

### Phase J — Sunburst visualization (VIZ-03, VIZ-04, VIZ-05)
**Why now:** Late because it's pure rendering — no upstream features depend on it. Treemap exists in web UI as a reference algorithm; port to GDI in `desktop/paint.rs`.

### Phase K — HTML / XLSX export (EXPORT-02, EXPORT-03, EXPORT-04)
**Why last:** Largest "new code" surface that depends on **everything else being final** (so the export reflects the final feature set). XLSX is a ZIP-of-XML; STORE-method (no DEFLATE) ZIP is ~150 lines of hand-rolled code. HTML report inlines the existing treemap JS.
**Risk:** XLSX is the only place in the milestone where adding a crate (`zip` or `simple_excel_writer`) is genuinely worth considering — flag as a Key Decision for the phase plan.

### Build-order rationale at a glance

| Phase | Depends on | Enables |
|-------|-----------|---------|
| A Split | — | everything |
| B Settings | A | C, D, F, H |
| C Polish | A, B | manual test ergonomics for D-K |
| D Search | A, B | E, F (selection works on filtered view) |
| E Multi-select | A, D | F, G |
| F Cleanup | A, B, E | G |
| G Dup UX | A, F | — |
| H Snapshot save | A, B | I, K |
| I Snapshot diff | A, H | K |
| J Sunburst | A | K |
| K Export | A, F, I, J | (milestone close) |

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Skipping the module split "for now"
**What people do:** Add v1 features into the existing `src/main.rs`, planning to split "after the milestone."
**Why it's wrong:** Each new feature touches `mod desktop` (+200-500 lines), the JSON serializer (+50), and a new `/api/*` route or `WM_*` handler. By the end of v1 the file is ~8,000 lines and the split becomes a multi-week project competing with bug-fix work. The split done first is ~1-2 days of mechanical work.
**Do this instead:** Phase A. No exceptions.

### Anti-Pattern 2: Mutating `ScanResult` in place after cleanup
**What people do:** "Cleanup deleted these 12 nodes, let me just remove them from `state.current_scan.nodes` and patch sizes upward."
**Why it's wrong:** Aggregated sizes, top-N caches, extension stats, age stats, duplicate candidates are all derived from the *full* tree state at aggregation time. Patching is correct in theory and wrong in practice — every analytics struct silently becomes stale. The flat `Vec<NodeRecord>` with `parent` indices makes node removal extra fragile because IDs are dense.
**Do this instead:** Re-scan the lowest common ancestor of all affected paths and atomically swap the subtree (or, for small deletes, re-scan the affected parents only — pick the threshold empirically).

### Anti-Pattern 3: Doing destructive ops on the UI thread
**What people do:** "It's just a delete, call `SHFileOperationW` directly from `WM_COMMAND`."
**Why it's wrong:** `SHFileOperationW` blocks for the duration of the operation, displays its own progress dialog driven by COM, and on large deletes pumps a nested message loop that **can re-enter `window_proc`** while `DesktopState` is locked. That deadlocks the app.
**Do this instead:** Spawn a background thread, `PostMessageW(WM_CLEANUP_DONE)` on completion, never hold the `STATE` mutex across a Win32 call that can pump messages.

### Anti-Pattern 4: Storing `NodeId` across scans
**What people do:** Save "selected node IDs" in settings to restore selection after re-scan.
**Why it's wrong:** `NodeId` is a `Vec<NodeRecord>` index. It changes between scans (and within a scan after re-aggregation of a subtree). Restoring by ID points at arbitrary nodes.
**Do this instead:** Persist by relative path string. Resolve to current `NodeId` on use.

### Anti-Pattern 5: Storing snapshots as binary / custom format
**What people do:** "JSON is too big, let me invent a compact binary format."
**Why it's wrong:** Doubles the surface area (read + write code), breaks the `filetree diff a.json b.json` CLI ergonomics, and zero-dep means no battle-tested deserializer.
**Do this instead:** Use the existing JSON. For size: offer a "compact snapshot" mode that elides nodes below a size threshold (e.g., only nodes ≥ 1 MB and all directories). 90% of the diff value with 10% of the bytes.

### Anti-Pattern 6: Inventing a query language for search
**What people do:** Build a parser for `size:>1G AND ext:log OR name:*backup*`.
**Why it's wrong:** Zero-dep, hand-rolled parsers are bug nurseries. Users of a personal-tier disk explorer don't want to learn syntax.
**Do this instead:** Discrete UI controls (text glob field + size-range spinners + mtime date pickers + extension multi-select). The `Filter` struct is the "AST" — built from the UI, not parsed from text.

### Anti-Pattern 7: Adding a "background save" for settings on every keystroke
**What people do:** Write settings.json on every column resize event.
**Why it's wrong:** Column drag fires hundreds of `WM_*` events per second. You'll burn out the SSD and slow down dragging.
**Do this instead:** Mark dirty; flush on `WM_TIMER` (5 s) and `WM_DESTROY`. Same pattern modern editors use for window-state persistence.

---

## Scaling Considerations

This is a personal-use desktop app, so "scale" means **scan-size scale**, not user scale.

| Scan size | What breaks first | Architectural response |
|-----------|-------------------|------------------------|
| ≤ 100k nodes | Nothing | Status quo works |
| 100k - 1M nodes | `renderRows` (web UI) DOM rebuilds (existing concern), `scan_result_to_json` peak memory | New features in desktop side-step the web UI; for desktop, the `VisibleRows` cache (Pattern 1) is what matters |
| 1M - 10M nodes | Snapshot file size (hundreds of MB JSON); `Vec<NodeRecord>` clone in `snapshot_scan_result` (existing concern in CONCERNS.md) | Offer "compact snapshot" mode; defer the clone-during-aggregation fix to a follow-up milestone (it's an existing issue, not introduced by v1) |
| 10M+ nodes | RAM exhaustion (3-5 GB documented in CONCERNS.md) | Out of scope for v1; documented in PITFALLS |

### v1 Scaling Priorities

1. **VisibleRows caching with signature-based invalidation.** Search must be interactive at 1M nodes. Without caching, each keystroke is an O(n) tree walk + sort = ~100 ms = laggy.
2. **Snapshot compact mode.** Without it, "saved snapshots" is unusable on system-drive scans.
3. **Partial re-scan after cleanup.** Re-scanning C:\ after deleting a folder is not acceptable. Scan only the lowest common ancestor of affected paths.

---

## Integration Points

### External Services / OS APIs

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| `SHFileOperationW` (Shell32) | `extern "system"`, double-null-terminated `pFrom`, called on a background thread | Already imported (`Shell32` is in the existing FFI list); pumps its own message loop — do NOT hold the `STATE` mutex across the call |
| `SHGetKnownFolderPath` (Shell32) | One-shot at startup, `FOLDERID_RoamingAppData`, build `%APPDATA%\FileTree\` | Cleaner than `env::var("APPDATA")`; handles roaming profiles correctly |
| `IShellFolder` / `IContextMenu` (COM) | Already in use for context menu (`src/main.rs:1767+` desktop block) | Keep existing implementation; refactor only file location, not code |
| File-save dialog (`IFileSaveDialog`) | New COM use for HTML/XLSX export destination picker | Use `CoCreateInstance(CLSID_FileSaveDialog)`; same pattern as existing COM glue |

### Internal Module Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `desktop` ↔ `scan` | direct function calls (`scan::run_with_progress`) | already the pattern |
| `desktop` ↔ `analytics` | direct, on-demand | desktop calls `analytics::extension_stats(&scan_result)` |
| `desktop` ↔ `export` | direct (UI thread) for small exports, background-thread + `WM_EXPORT_DONE` for XLSX | XLSX of 1M nodes can take seconds |
| `desktop` ↔ `diff` | background thread + `WM_DIFF_READY` | diff over 1M nodes is ~100-500 ms |
| `desktop::cleanup` ↔ `io::windows` | direct call on background thread | the only module that calls `SHFileOperationW` |
| `server` ↔ `scan` / `analytics` / `export` | unchanged | server keeps current behavior |
| `cli` ↔ `scan` / `export` / `diff` | new `filetree diff a.json b.json` subcommand becomes possible | bonus from `diff.rs` being a pure function |

---

## Architectural Risks

1. **The module split itself.** Moving 5,000 lines without breaking the `#[cfg(windows)]` boundary or the Clippy allow attributes is the riskiest single piece of work in the milestone. Mitigation: do it in one PR, gate with CI, no feature work piggybacked.
2. **`Mutex<DesktopState>` poisoning under cleanup errors.** A panic inside the cleanup-result handler (e.g., indexing into a stale `NodeId`) poisons the lock and bricks the window. Mitigation: cleanup handler must use `get` / `match` exhaustively, never `[idx]` / `unwrap`. Add a `with_state_mut_or_log` variant for handlers that returns instead of panicking.
3. **`SHFileOperationW` nested message pump.** Documented above. Single biggest source of "weird hang" bugs in Win32 file-manager-style apps. Mitigation: hard rule — never call `SHFileOperationW` from the UI thread, never inside `with_state_mut`.
4. **Snapshot file growth.** A naive snapshot of `C:\` can be 500 MB JSON. Mitigation: compact mode + cap retained snapshots per saved-scan (e.g., last 10).
5. **`Vec<NodeRecord>` peak memory during aggregation** (pre-existing in CONCERNS.md). Cleanup re-scans of large subtrees re-hit this. Mitigation: scope cleanup re-scans tightly; for cleanup re-scan, do not re-aggregate the whole tree — only re-aggregate the affected subtree and patch the rollup deltas upward (this is acceptable because the operation is bounded: the affected ancestors are a single path from subtree to root).
6. **Selection survival across re-scan.** Path-based resolution can fail if the user deleted a folder that contained sibling files that *should* still be selected. Mitigation: silently drop unresolvable selections; show a "9 of 12 items remain selected" hint.
7. **Adding a crate for XLSX is tempting.** Stay disciplined per the PROJECT.md zero-dep rule, OR raise an explicit Key Decision for the export phase. Either is fine; sliding into "well, just this one crate" is not.
8. **CI runs `cargo test` but there are no tests** (per STRUCTURE.md). The cleanup phase must add unit tests for at least: path quoting / null termination, `Filter::matches`, `SnapshotDiff::compute`, settings JSON round-trip. This is the lowest-cost insurance against destructive-op regressions.

---

## Confidence Notes

- **HIGH** on: module split layout, build order, cleanup data flow, `PostMessageW` pattern (matches existing `WM_SCAN_DONE`), immutable-ScanResult pattern (matches existing `Arc<ScanResult>` in `AppState`), Filter / Diff being pure functions.
- **MEDIUM** on: snapshot compact-mode threshold (1 MB is a guess; tune in implementation), XLSX as ZIP-of-XML being ~150 lines hand-rolled (could be 300; depends on which Excel features the spec demands).
- **LOW (flag)** on: how aggressively `SHFileOperationW`'s built-in progress dialog cooperates with the app's parent window — this needs a small spike in Phase F before the full implementation.

---

## Sources

- `C:/Users/dannguan/FileTree/.planning/PROJECT.md` (validated + active requirements, constraints, key decisions)
- `C:/Users/dannguan/FileTree/.planning/codebase/ARCHITECTURE.md` (current system map, component table, data flows)
- `C:/Users/dannguan/FileTree/.planning/codebase/STRUCTURE.md` (file layout, "where to add new code" recipes)
- `C:/Users/dannguan/FileTree/.planning/codebase/CONVENTIONS.md` (naming, error handling, module design)
- `C:/Users/dannguan/FileTree/.planning/codebase/CONCERNS.md` (existing tech debt, fragility, scaling limits — informs risk section)

---

*Architecture research for: FileTree v1 (TreeSize-Personal-tier features atop existing Win32 / Rust monofile)*
*Researched: 2026-05-22*
