# Feature Research

**Domain:** Windows disk-usage explorer at the "Personal" tier (above free tools like WinDirStat/WizTree, below enterprise/Pro tiers that add NTFS ACL, cloud, scheduling, multi-user)
**Researched:** 2026-05-22
**Confidence:** HIGH (category synthesis; baseline drawn from existing FileTree v0.1.0 codebase plus working knowledge of the disk-usage explorer category — WinDirStat, WizTree, SpaceSniffer, TreeSize family, DaisyDisk-style competitors. No verbatim reproduction from any vendor marketing copy.)

## Framing

The "Personal" tier of a Windows disk-usage explorer is defined by what separates it from the free tools below it and the enterprise tools above it:

- **Above free** (WinDirStat / WizTree / SpaceSniffer): adds a real cleanup workflow (multi-select, Recycle-Bin-safe delete, post-action summary), saved scan history with delta comparison, richer filtering/search, polished reports, and a UI that doesn't feel like a sysadmin diagnostic tool.
- **Below Pro/Enterprise**: does NOT add NTFS ACL/permissions browser, cloud-storage scanning (OneDrive/SharePoint/S3), scheduled background scans run by Task Scheduler, email-on-completion, server/SMB inventories with quotas, or multi-machine fleet rollups.

Users at this tier are personal-PC owners and prosumers ("my SSD is full and I want to fix it safely without rebuilding my machine"). They expect: scan finishes in seconds-to-minutes, results are obvious at a glance, and they can act on what they see without leaving the app or fearing they'll nuke `C:\Windows`.

## Baseline already in v0.1.0 (do NOT re-spec)

For brevity below, I use the shorthand "[existing]" to flag a row that builds on a primitive already in the codebase. Reference points the downstream `REQUIREMENTS.md` should cite:

- Scan engine: `scan_path_with_progress()` / `worker_loop()` (`src/main.rs:272`, `:428`) — multi-threaded BFS, cancel token, 1500ms progress.
- Allocated size: `platform_allocated_size()` / `GetCompressedFileSizeW` (`src/main.rs:1683-1735`).
- Tree table + dark mode + tabs: `desktop` module (`src/main.rs:1767+`, custom GDI paint, Summary/Extensions/Top/Duplicates/Errors).
- Treemap (web only): `layoutTreemap()` (`web/app.js:489`).
- Duplicates: `exact_duplicates_json()` / `fnv1a_file()` (`src/main.rs:1242-1310`).
- Age + extension analytics: `age_stats()`, `extension_stats()` (`src/main.rs:996-1451`) — **age_stats is computed but not yet surfaced** in either UI; this is a free win.
- Delete backend: `/api/delete` route — **exists, no UX wired up** (PROJECT.md line 29, line 100).
- Export: CSV + JSON via `scan_result_to_json()` / `scan_result_to_csv()` and `/api/export.*`.

## Feature Landscape

### Table Stakes (Personal tier — users expect these)

A v1 that ships without any of these will feel like "WinDirStat with a paint job," not a Personal-tier product.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Recycle-Bin-safe delete from the UI** | The whole point of finding bloat is removing it. Without UI delete, the user copies a path, alt-tabs to Explorer, and asks "why did I install this?" | MEDIUM | Backend exists (`/api/delete`); needs (a) confirmation dialog showing count + total bytes + sample paths, (b) Win32 `SHFileOperationW` with `FOF_ALLOWUNDO` for true Recycle Bin semantics (not `std::fs::remove_*`), (c) permanent-delete opt-in checkbox, (d) post-action summary, (e) auto-refresh of affected subtree. Destructive — highest blast-radius feature in v1. |
| **Multi-select in the tree and in tabs** | Selecting one file at a time to delete 200 thumbnail caches is a non-starter. Users expect Ctrl+click / Shift+click / Ctrl+A within a subtree. | MEDIUM | Custom-painted list (`desktop` mod) currently single-select. Selection model needs to extend to duplicates tab, top-files tab, and search results — same primitive. |
| **In-scan search by name** | "I know it's called `*.iso` somewhere on D:\\" — searching the already-loaded scan in-memory is far faster than re-scanning. Glob + substring at minimum. | LOW-MEDIUM | Walk in-memory `Vec<NodeRecord>`; already-written wildcard matcher exists in the codebase. UI surface: Ctrl+F box, results pane (or filter the existing tree). |
| **Filter by size / modified-date / age bucket / extension** | "Show me files >100MB modified before 2023" is the canonical cleanup query. Without it the tree is a wall of text. | MEDIUM | `age_stats()` already buckets — reuse buckets. Filtering should hide non-matching rows but keep parents (collapse-to-matches). |
| **Saved scan history + delta vs prior snapshot** | Personal-tier users re-scan the same drive monthly. They want to know what grew. "New since last scan", "deleted since last scan", "+/- bytes per folder". | MEDIUM-HIGH | Persist scan results under `%APPDATA%\FileTree\snapshots\` as the same JSON the existing serializer produces. Diff is structural: match by path, compute size delta + new/removed sets. Cheap to implement, high perceived value. |
| **Saved scan locations / bookmarks** | Users don't want to re-type `D:\Users\me\Downloads` every launch. A drive picker + recent paths list is expected. | LOW | Tiny. Persist under `%APPDATA%\FileTree\` alongside settings (POLISH-04). |
| **Native treemap in the desktop window** | A disk-usage tool without a visual map feels broken to anyone who has ever used WinDirStat. The treemap lives only in the web UI today. | MEDIUM | Port `layoutTreemap()` from JS to Rust + GDI; binary-split layout is ~80 lines. Hovering tiles should sync selection with the tree. |
| **HTML report export** | Personal users send "here's why your laptop is full" to family / IT. Self-contained HTML with treemap + top-N + summary is the format they actually share. CSV/JSON are for power users. | MEDIUM | The web UI already has `exportHtmlSnapshot()` — promote to a first-class menu entry; ensure single-file output with inline CSS/SVG. |
| **Reveal in Explorer / open / properties / copy path on every row** | Right-click on any node should land you back in Explorer or show file properties. Without it, the tool feels like a dead-end inspector. | LOW | Shell context-menu COM (`IShellFolder` / `IContextMenu`) already declared in the `desktop` mod for other use. Wire to a row context menu. |
| **Status bar with live scan stats** | Files/sec, folders scanned, errors, elapsed, throughput. Users watching a 30-second scan want to know it's making progress and roughly how long. | LOW | Counters exist in `WorkerShared`; just render. |
| **Keyboard navigation + shortcuts** | Enter to scan, Del to delete, Ctrl+F to find, Esc to cancel, F5 to refresh, arrow keys + Right/Left to expand/collapse. Mouse-only is unacceptable in a power tool. | LOW-MEDIUM | Standard `WM_KEYDOWN` handlers in `window_proc()`. |
| **Settings persistence** | Last-used path, column widths, sort, dark mode, hidden-file toggle, follow-symlinks toggle. Re-configuring on every launch is a paper cut that compounds. | LOW | Simple JSON file under `%APPDATA%\FileTree\` (POLISH-04). |
| **Path bar with autocomplete + drive picker** | The current plain text input is fine for a v0; v1 needs a drive dropdown and a path that completes as you type. | LOW-MEDIUM | Drive enum already exists (`/api/drives`). Autocomplete via `SHAutoComplete` on the edit control is one Win32 call. |
| **Group-by views in the tree (by extension, by file type, by age bucket)** | Sometimes the question is "what's eating the disk" not "what's in this folder" — a flat group-by view answers that without the user crafting filters. | MEDIUM | Same `Vec<NodeRecord>` re-bucketed; new "view mode" switcher. |
| **Pause / resume scan** (or at least responsive cancel) | A cancellable scan exists; pausing is a nice-to-have, but cancel must stay <500ms responsive on huge trees. | LOW (cancel responsiveness only) | Cancel is already wired; verify it stays snappy on 10M-file scans. Pause is true P3. |

### Differentiators (where FileTree should compete)

FileTree's Core Value is "fast, single .exe, no install footprint, cohesive scan+visualize+cleanup." Lean into that, not into adding more Pro-tier surface area.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Zero-install single .exe distribution** | No installer, no admin prompt, no service, no auto-update phone-home, no .NET runtime, no Electron 200MB. Drop it on a thumb drive and run it on someone's PC to clean their disk. Already true today; protect it by treating new dependencies as Key Decisions (per PROJECT.md). | N/A (preserve) | Document this in the README/about box; users actively pick tools for this property. |
| **Age-tinted treemap (old = red, new = green)** | Treemaps everywhere show *size*; almost none show *age*. For cleanup workflows, an at-a-glance "this whole green block is from last week, that red block hasn't been touched in 4 years" is a genuinely new affordance. `age_stats` already exists. | MEDIUM | Toggle on the treemap; HSL hue from mtime, saturation by size. Should be a one-click overlay, not a separate view. |
| **Scriptable headless CLI for scan + report** | Power users want `filetree.exe scan D:\ --json | jq ...` in PowerShell scripts. `scan` subcommand already does this — promote it: add `--top-n`, `--ext`, `--min-size`, `--older-than`, `--format html` flags. Most disk-usage tools either have no CLI or a feature-stripped one. | LOW-MEDIUM | Extend existing `run_scan_command()`. Stay read-only on the CLI side (per PROJECT.md "no CLI deletion" decision). |
| **Snapshot comparison built on plain-JSON files** | If snapshots are just JSON files on disk (the format the serializer already emits), users can diff them with `git diff`, archive them, share them. Pro tools tend to use opaque .db formats. Lean into "your data is files, not a black box." | MEDIUM | Aligns with table-stakes snapshot history; the *differentiator* is the format choice (plain JSON), not the feature itself. |
| **Cohesive find-act loop in one window** | A surprising number of disk-usage tools force a tool-switch to act (open Explorer, switch to a separate cleaner, etc.). FileTree should make "find the bloat -> select -> delete -> see the bytes reclaimed -> rescan affected subtree" feel like one motion. This is a UX bet, not a feature, but it's worth naming. | MEDIUM (cross-cutting) | Post-action summary toast + auto-refresh of affected subtree is the load-bearing detail. |
| **Smart-keep helpers in duplicates** | "Keep newest", "keep one per folder", "keep in shortest path", "keep largest", "keep oldest" — selection presets are what make a duplicates tab actually usable. Free tools usually leave this as manual checkbox-clicking. | LOW-MEDIUM | Operates on the existing duplicate groups from `exact_duplicates_json()`. UI-only addition once multi-select is in place. |
| **Treemap row-sync** | Hovering a treemap tile highlights the tree row; selecting in the tree pulses the treemap tile. Most tools split these views. Tight sync makes the visualization feel like part of the table instead of a poster. | MEDIUM | Both views read from the same `id` indices; selection is one shared field. |
| **Native dark mode that actually paints title bar + scrollbars** | DWMWA_USE_IMMERSIVE_DARK_MODE + custom-painted everything else. Already done — call it out as a quality signal in the README. | N/A (preserve) | Many "dark mode" Windows apps still leave white scrollbars / white title bar. |

### Anti-Features (explicitly NOT in v1)

| Feature | Why Requested | Why Problematic for v1 | Alternative |
|---------|---------------|------------------------|-------------|
| **Cloud-storage scanning (OneDrive / SharePoint / Google Drive / S3)** | "I want to see what's in my cloud too." | Auth flows, OAuth token storage, API quota handling, sync-placeholder vs real-file semantics — each provider is a milestone-sized scope. Categorically Pro-tier. | Out of scope per PROJECT.md. Document "scans the local filesystem only" as a positioning choice, not a gap. |
| **NTFS ACL / permissions browser / ownership reports** | Admins want to know who owns what and what's inherited. | Pulling SIDs, resolving them across AD/local, rendering inheritance trees — separate domain. Not what personal users need. | Out of scope per PROJECT.md. Show owner/group as columns at most if trivial; do not build an ACL UI. |
| **Scheduled scans via Windows Task Scheduler** | "Run this every Sunday at 2am and email me." | Requires a service or scheduled-task installer, email/SMTP config, headless-result storage, alerting rules. Pulls in installer requirements that break single-`.exe` posture. | Out of scope per PROJECT.md. Power users can wrap the CLI in their own scheduled task; we don't manage the schedule. |
| **Telemetry / "anonymous usage" / auto-update** | Vendor habit. | Phones home from a single-`.exe` personal tool — directly contradicts the trust posture. Adds dependencies (TLS, JSON, update channel). | Out of scope per PROJECT.md. State "no telemetry" in README. |
| **Installer / MSI / signed package** | "MSI installers feel professional." | Code-signing certs cost money; MSI adds a build step; uninstall registry entries; admin elevation. The whole pitch is "no install." | Single `.exe` only. Consider winget manifest later (still pulls down the single `.exe`). |
| **Built-in disk cleaner with predefined rules ("clean browser caches, temp files, hibernation, etc.")** | Personal users associate "disk cleanup" with this. | Predefined rules age badly (Chrome moves its cache, etc.), require constant maintenance, and overlap with built-in Windows Storage Sense. Massive support surface for marginal value. | Stay generic: the user finds the bloat themselves via the tree/treemap/filters and deletes it. We are an explorer, not a cleaner-with-rules. |
| **File preview pane (thumbnail / hex / text)** | "Show me the file before I delete it." | A real preview pane is a huge feature surface (codec handling, EXIF, video thumbnails). Native shell already does this via "Reveal in Explorer" + preview pane there. | Provide reveal-in-Explorer, properties, and "open with default app." Defer in-app preview to v2+. |
| **Real-time monitoring / file-system watcher** | "Show me when files appear." | `ReadDirectoryChangesW` storms on big trees, requires a long-lived watcher, complicates the data model. Disk-usage explorers are scan-based, not watch-based. | Rescan on demand; offer "rescan affected subtree" after deletes. |
| **Heatmap / per-second IO benchmarking** | "How fast is my disk?" | Different product (CrystalDiskMark territory). | Don't build it. |
| **Multi-user / team / fleet rollups / network inventory** | Enterprise habit. | Requires a server, auth, aggregation. Out of personal-tier scope. | Out of scope per PROJECT.md. |
| **Pixel-clone of TreeSize visuals** | "Make it look like TreeSize so my team recognizes it." | Trade-dress / IP risk. PROJECT.md already calls this out. | Distinct visual identity; same information architecture. |

## Per-feature user workflows and behaviors

The downstream `REQUIREMENTS.md` should treat each of these as a workflow, not a checkbox. Annotated below for the highest-blast-radius items.

### Cleanup (CLEAN-01..06) — destructive, highest risk

**User workflow:**
1. User browses tree (or duplicates tab, or search results) and selects N items via Ctrl/Shift click.
2. User presses `Del` (or right-click -> Delete).
3. Confirmation dialog appears: "Move 47 items (3.21 GB) to Recycle Bin?" with a scrollable sample of the first ~10 paths, a "Permanently delete instead" checkbox (unchecked by default), and Delete / Cancel buttons.
4. On confirm, deletion runs on a background thread (UI must remain responsive); progress shown in status bar.
5. Post-action summary: "Recycled 47 items, 3.21 GB reclaimed, 2 errors (see Errors tab)."
6. Affected subtree auto-refreshes (re-scan only the affected parent dirs, not the whole drive).
7. Undo hint: status-bar link "Restore from Recycle Bin..." opens the Recycle Bin view.

**Expected behaviors:**
- Deletion MUST default to Recycle Bin via `SHFileOperationW` with `FOF_ALLOWUNDO`. Never `std::fs::remove_*` for default path.
- Permanent delete MUST require a separate explicit checkbox per action (not a persistent setting).
- Selecting a folder deletes the whole subtree (clearly stated in the confirmation).
- `C:\Windows`, `C:\Program Files*`, `%SystemRoot%`, the scan root itself, and the directory containing `filetree.exe` should warn extra-loudly (yellow banner in the confirmation), not be forbidden.
- Deletion failures (locked files, permission denied) collected and shown; partial success is fine.
- Cancel mid-operation should stop after the current file (Recycle Bin operations are atomic per call).

### Snapshot history + delta (SCAN-05)

**User workflow:**
1. After a scan finishes, user clicks "Save snapshot." File saved as `D-Users-me_20260522-1432.json` under `%APPDATA%\FileTree\snapshots\`.
2. On next scan of the same path, a "Compare to..." dropdown shows prior snapshots of this path.
3. User picks a snapshot. A "Delta" column appears in the tree showing `+1.2 GB`, `-340 MB`, `(new)`, `(removed)` next to each row.
4. A "Changes" tab summarizes: top growers, top shrinkers, new dirs, removed dirs.

**Expected behaviors:**
- Snapshot format is the existing `scan_result_to_json()` output — no new schema.
- Matching is by path string; renames look like "removed A, added B."
- Snapshots are user-deletable from inside the app and via Explorer (they're just files).
- Comparison does not require both snapshots to use the same scan options (`hidden`, `follow_symlinks`); warn if they differ.

### Search + filter (SEARCH-01..05)

**User workflow:**
1. User presses Ctrl+F. A search bar slides down.
2. User types `*.mp4`. As they type (debounced ~150ms), the tree filters to matches; parents stay visible but collapsed-to-matches.
3. User opens "Filters" panel: sliders for size (1MB - 50GB), modified-date range, age bucket multi-select, extension multi-select.
4. User clicks "Save view" -> "Big old videos." The view appears in a sidebar; clicking it re-applies the filter to whatever scan is loaded.

**Expected behaviors:**
- Search runs on the loaded in-memory scan; no I/O.
- Glob (`*`, `?`) + substring (default if no wildcards). Case-insensitive on Windows.
- Filters compose with AND. Clearing all filters returns the full tree.
- Saved views are JSON under `%APPDATA%\FileTree\views\`.

### Duplicates UX upgrade (DUP-02..04)

**User workflow:**
1. User runs "Exact hash scan" (already exists).
2. Each group expands inline to show: full path, mtime, size, "keep" checkbox.
3. "Smart select" dropdown: Keep newest / Keep oldest / Keep shortest path / Keep one per folder / Keep largest. Sets checkboxes en-masse.
4. User reviews, clicks "Delete unchecked" -> standard cleanup confirmation -> reclaim summary.

**Expected behaviors:**
- "Keep" semantics are explicit: checked = keep, unchecked = will be deleted. Never inverted.
- The smart-select presets must leave at least one item per group checked. Refuse to delete a whole group; warn the user.
- Hash recomputation after delete is not required (we trust the in-memory state); next exact-scan re-derives.

### Visualization (VIZ-03..05)

**User workflow:**
1. User toggles between Tree, Treemap, Sunburst views (top-right button group).
2. In Treemap: hovering a tile shows tooltip + highlights the row in the tree (if tree visible in split view); clicking selects.
3. "Age tint" toggle recolors tiles by mtime gradient.

**Expected behaviors:**
- Treemap layout is deterministic for the same input (binary-split is fine; squarified is nicer but more code).
- Tiles below ~2px get clustered/hidden; aggregate "other" tile.
- Treemap repaints on selection/filter changes without re-layout (re-layout only on data change).

### Reports (EXPORT-02..04)

**User workflow:**
1. File menu -> Export -> HTML Report. Save dialog.
2. Generated file opens in default browser: title, scan path, date, scan options, summary stats, top-50 files table, top-50 folders table, treemap as inline SVG, age and extension breakdowns.
3. Single self-contained `.html` file. No external assets.

**Expected behaviors:**
- HTML must be self-contained (inline CSS, inline SVG treemap, inline base64 favicon if needed). The user emails this file.
- XLSX is the highest-complexity export — manual XLSX writing (zero-deps constraint) is non-trivial (XLSX is a zipped XML bundle). Likely a Key Decision: either accept a crate or ship CSV-only for v1 and defer XLSX.

## Feature Dependencies

```
Multi-select (CLEAN-01)
    └──required-by──> Safe delete (CLEAN-02..06)
    └──required-by──> Duplicates batch delete (DUP-04)
    └──required-by──> Smart-keep duplicates (DUP-03)

Safe delete (CLEAN-02..06)
    └──required-by──> Post-action summary + auto-refresh (CLEAN-05)
    └──depends-on──> Win32 SHFileOperationW (not std::fs::remove_*)

Search + filter (SEARCH-01..05)
    └──enhances──> Cleanup (selecting all matches -> delete is the killer workflow)
    └──depends-on──> In-memory NodeRecord traversal (existing)

Snapshot history (SCAN-05)
    └──depends-on──> Saved bookmarks (SCAN-04, to know which paths are "yours")
    └──depends-on──> Existing scan_result_to_json serializer (no new format)

Native treemap (VIZ-03)
    └──enhances──> Row-sync differentiator
    └──enhances──> Age-tinted treemap (VIZ-05)
    └──depends-on──> age_stats (already computed)

HTML report (EXPORT-02)
    └──depends-on──> Native treemap layout OR reuses web treemap export

Path bar autocomplete (POLISH-01)
    └──enhances──> Saved bookmarks (SCAN-04)

Settings persistence (POLISH-04)
    └──required-by──> Saved bookmarks (SCAN-04)
    └──required-by──> Snapshot history (SCAN-05)
    └──required-by──> Saved filter views (SEARCH-05)

Smart-keep duplicates (DUP-03) ──conflicts──> Whole-group delete
    (Must always leave >=1 file per group checked)
```

### Dependency notes

- **Multi-select must land before any delete UX.** Building single-select delete first wastes work; the dialog, confirmation, and post-action flow all assume N items.
- **Settings persistence is a load-bearing primitive.** Bookmarks, snapshots, and saved views all write to `%APPDATA%\FileTree\`; doing this once with a small JSON schema avoids three ad-hoc storage layers.
- **Native treemap (VIZ-03) is a precondition for the age-tint differentiator.** The age-tint feature has no value if the treemap only lives in the web UI; both surfaces eventually want it but native first.
- **Snapshot history piggybacks on existing JSON.** Do NOT design a new persistence format; use what `scan_result_to_json` already produces.

## MVP Definition

### Launch With (v1 — Personal-tier parity)

Ruthless: these are the items where missing one makes the product feel sub-Personal-tier.

- [ ] **Multi-select in tree, duplicates, top-files tabs** — precondition for everything cleanup
- [ ] **Recycle-Bin-safe delete with confirmation + post-action summary + subtree auto-refresh** — the cleanup loop is THE differentiator from free tools; `/api/delete` and Win32 `SHFileOperationW` wiring
- [ ] **In-scan search by name (glob + substring) + filter by size/date/extension** — table-stakes for cleanup queries
- [ ] **Saved bookmarks + settings persistence under %APPDATA%** — single 1-day task, enables several others
- [ ] **Native treemap panel in the desktop window** — VIZ-03; the visual map is what users expect from this category
- [ ] **HTML report export** — share/save artifact, dominant export format for personal users
- [ ] **Row context menu: Reveal in Explorer / Open / Properties / Copy path** — closes the find-act loop
- [ ] **Status bar with live scan stats + keyboard shortcuts** — POLISH-02, POLISH-03; small effort, large quality signal
- [ ] **Surface age_stats and extension_stats in the UI** — already computed, just not painted; near-free win
- [ ] **Smart-keep helpers in duplicates + batch delete** — what makes the duplicates tab actually usable

### Add After Validation (v1.x)

- [ ] **Snapshot history + delta vs prior snapshot (SCAN-05)** — high value but big enough to slip if v1 timeline pressure hits; ship after the cleanup loop is proven
- [ ] **Age-tinted treemap toggle (VIZ-05)** — differentiator; needs native treemap first
- [ ] **Saved filter views (SEARCH-05)** — only meaningful once users have used filters enough to repeat them
- [ ] **Group-by views in the tree (by extension / file type / age)** — alternate view mode
- [ ] **CLI flag expansion (`--top-n`, `--older-than`, `--format html`)** — extend `run_scan_command()`
- [ ] **Sunburst visualization (VIZ-04)** — alternate viz; add once treemap is solid
- [ ] **XLSX export (EXPORT-03)** — likely requires a Key Decision on dependencies

### Future Consideration (v2+)

- [ ] **Scheduled background scans** — needs installer/service; defer per PROJECT.md
- [ ] **Pause/resume scan** — nice-to-have; cancel responsiveness is the real requirement
- [ ] **In-app file preview pane** — large surface; use shell preview via "Reveal in Explorer" until proven necessary
- [ ] **Treemap squarified layout** — visual quality upgrade over binary-split
- [ ] **Move-to-folder action (CLEAN-04)** — currently in Active but lower priority than delete; ship if cheap, defer if not
- [ ] **Cross-platform desktop GUI** — out of scope per PROJECT.md
- [ ] **NTFS ACL, cloud, scheduling, multi-user** — Pro-tier, out of scope per PROJECT.md

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Risk | Priority |
|---------|------------|---------------------|------|----------|
| Multi-select | HIGH | MEDIUM | LOW | P1 |
| Safe delete (Recycle Bin) + confirmation + summary | HIGH | MEDIUM | **HIGH (destructive)** | P1 |
| In-scan search + filters | HIGH | MEDIUM | LOW | P1 |
| Saved bookmarks + settings persistence | MEDIUM | LOW | LOW | P1 |
| Native desktop treemap | HIGH | MEDIUM | LOW | P1 |
| Row context menu (reveal/open/properties) | MEDIUM | LOW | LOW | P1 |
| HTML report export | MEDIUM | MEDIUM | LOW | P1 |
| Status bar + keyboard shortcuts | MEDIUM | LOW | LOW | P1 |
| Surface age + extension stats in UI | MEDIUM | LOW | LOW | P1 |
| Duplicates smart-keep + batch delete | HIGH | LOW-MEDIUM | MEDIUM (destructive) | P1 |
| Snapshot history + delta | HIGH | MEDIUM-HIGH | LOW | P2 |
| Age-tinted treemap (differentiator) | MEDIUM-HIGH | MEDIUM | LOW | P2 |
| Saved filter views | MEDIUM | LOW | LOW | P2 |
| Group-by views | MEDIUM | MEDIUM | LOW | P2 |
| CLI flag expansion | LOW-MEDIUM | LOW | LOW | P2 |
| Sunburst viz | LOW | MEDIUM | LOW | P3 |
| XLSX export | LOW | HIGH (zero-dep XLSX writer) | MEDIUM (Key Decision: crate?) | P3 |
| Pause/resume scan | LOW | LOW | LOW | P3 |
| Move-to-folder | LOW | MEDIUM | MEDIUM (destructive-adjacent) | P3 |
| In-app file preview | LOW | HIGH | LOW | Defer |
| Real-time monitoring | LOW | HIGH | MEDIUM | Anti-feature |
| Cloud / ACL / Scheduled / Telemetry / Installer | N/A | N/A | N/A | Out of scope |

**Priority key:**
- P1: Must have for v1 launch (Personal-tier parity)
- P2: Add after v1 lands and is validated
- P3: Future, low priority
- Defer / Anti-feature / Out of scope: do not build

## Category Positioning (synthesized, not vendor-quoted)

| Capability shape | Free tier (WinDirStat / WizTree / SpaceSniffer) | Personal tier (FileTree v1 target) | Pro / Enterprise tier |
|------------------|-------------------------------------------------|------------------------------------|------------------------|
| Scan engine | Fast, sometimes MFT-based on NTFS | Fast multi-threaded BFS (FileTree has this) | Same + scheduled / incremental |
| Visualization | Treemap (sometimes only) | Tree + treemap + sunburst + age tint | Same + custom dashboards |
| Cleanup | Manual via Explorer or single-file delete | Multi-select, Recycle-Bin-safe delete, smart-keep duplicates, post-action summary | Same + bulk rules, archive-to-share |
| Reporting | CSV at best | HTML/CSV/JSON self-contained reports | XLSX, scheduled email, PDF, branded |
| History | None | Saved snapshots + delta diff | Same + database-backed history |
| Search/filter | Minimal | Name + size + date + age + extension, composable, saved views | Same + saved scheduled queries |
| Permissions | None | None (intentional) | NTFS ACL browser, ownership reports |
| Cloud | None | None (intentional) | OneDrive / SharePoint / S3 |
| Distribution | Installer or zipped exe | **Single .exe** (FileTree differentiator) | MSI + license activation |
| Telemetry | Usually none | None (FileTree differentiator) | Often yes |

## Sources

Synthesized from working knowledge of the disk-usage explorer category — WinDirStat, WizTree, SpaceSniffer, TreeSize family, DaisyDisk-class competitors. No vendor marketing copy reproduced. Concrete feature shapes verified against:

- `C:/Users/dannguan/FileTree/.planning/PROJECT.md` — Active requirements, Out-of-Scope list, Key Decisions, Constraints.
- `C:/Users/dannguan/FileTree/.planning/codebase/ARCHITECTURE.md` — Existing primitives (`age_stats`, `extension_stats`, `/api/delete`, treemap layout, Win32 desktop module, scan engine, COM shell handles).

---
*Feature research for: Windows disk-usage explorer, Personal tier*
*Researched: 2026-05-22*
