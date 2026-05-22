# Stack Research — FileTree v1 (Brownfield Milestone)

**Domain:** Windows-native disk-usage explorer, Rust 2024 edition, zero-Rust-dependency, single-`.exe`
**Researched:** 2026-05-22
**Confidence:** HIGH (Win32 APIs, format specs are all authoritative and stable)

## Posture Summary

The brownfield baseline is deliberately ascetic: empty `[dependencies]`, raw Win32 FFI, hand-written HTTP/JSON/CSV/FNV-1a, GDI double-buffered custom rendering. The v1 work (Recycle Bin delete, XLSX/HTML export, sunburst, snapshot diff, settings, search/filter) **does not require any new Rust crates** when matched against capabilities already present in `std` and Win32. The single area where a dependency would have material value is DEFLATE compression for XLSX — and even there a no-crate path exists. This document is prescriptive: one chosen approach per capability, with the no-crate path always preferred and any exception explicitly justified.

## Recommended Stack — New v1 Capabilities

### Core Approaches

| Capability | Concrete API / Pattern | Confidence | Why |
|------------|------------------------|------------|-----|
| Recycle Bin delete | COM `IFileOperation` via `Ole32` (already linked) + `Shell32::SHCreateItemFromParsingName` | HIGH | Modern documented successor to `SHFileOperationW`; proper undo records for Explorer "Restore"; pairs cleanly with existing `COINIT_APARTMENTTHREADED` STA already used by the desktop module |
| Permanent delete (opt-in) | Same `IFileOperation` with `FOFX_RECYCLEONDELETE` flag omitted; or `std::fs::remove_file` / `remove_dir_all` for the cancel-path simple case | HIGH | Single code path for all destructive ops keeps confirmation/undo UX consistent |
| Move-to (CLEAN-04) | `IFileOperation::MoveItem` / `MoveItems` | HIGH | Same COM object, same STA, identical pattern to delete |
| HTML report export (EXPORT-02) | Single `String` built with existing `push_str`/`push_json_string` pattern; inline `<svg>` for treemap/sunburst; raw inline JSON `<script type="application/json">` for the data island; no `<img>` tags | HIGH | Matches existing serializer style in `scan_result_to_json`; no Base64 inflation; reuses already-existing `web/app.js` treemap layout logic (porting `layoutTreemap` to Rust string output) |
| XLSX export (EXPORT-03) | Hand-rolled ZIP container (method 0 = STORED) + hand-written OOXML SpreadsheetML strings, written through `std::io::Write` with hand-rolled CRC-32 | MEDIUM-HIGH | Excel accepts STORED entries (validated — see Sources); avoids DEFLATE implementation entirely; keeps zero-crate posture intact. File is larger than deflate output, but EXPORT-03 is a one-shot per-scan artifact, not a hot path |
| Sunburst viz (VIZ-04) | Hand-rolled polar partition: `[x0, x1, y0, y1]` per node, `Math.sqrt(y)` radial scale for equal-area rings, GDI `BeginPath`/`AngleArc`/`EndPath` for native rendering; SVG `M`/`A`/`L` path commands for HTML/web | HIGH | Pure geometry math — no library needed in any language; same algorithm as d3's `d3.partition()` + `d3.arc()`. The existing `layoutTreemap` in `web/app.js` already proves we write our own layouts |
| Snapshot diff (SCAN-05) | Two-pass HashMap algorithm: pass 1 indexes the prior snapshot by path AND by `(size, mtime)` tuple; pass 2 classifies each current node as identical/modified/moved/new and consumes from the index; remainder = deleted | HIGH | Snappdiff algorithm (cited below); maps 1:1 onto our existing flat `Vec<NodeRecord>` with index-based parent pointers; no graph library needed |
| Settings persistence (POLISH-04) | `Shell32::SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, null, &mut pwstr)` for the directory; existing hand-written JSON serializer for the file; `std::fs::write` (atomic via write-temp-then-rename) | HIGH | Authoritative resolution (not `%APPDATA%` env var which can be spoofed); JSON over TOML/registry because we already have a JSON serializer and TOML would force a new format implementation |
| File search by name (SEARCH-01) | Reuse existing `wildcard_match` helper (already present in `src/main.rs`); add substring case-insensitive matcher (one new helper) | HIGH | Glob is solved; substring is `to_lowercase().contains()` |
| Size / date / extension filters (SEARCH-02–04) | Pure predicate closures over `NodeRecord` fields already populated by the scanner | HIGH | Zero new infrastructure; all data already in `Vec<NodeRecord>` |
| Saved views (SEARCH-05) | Filter config = struct serialized through the same JSON path as POLISH-04 settings | HIGH | One settings file, multiple sections |
| Path bar autocomplete (POLISH-01) | `Kernel32::FindFirstFileW` / `FindNextFileW` (already linked) for directory enumeration; `Comctl32` `WC_COMBOBOXEX` or owner-drawn list as dropdown | HIGH | No new linkage needed |
| Keyboard shortcuts (POLISH-02) | Existing `WM_KEYDOWN` handling in `window_proc`; `Comctl32` `LoadAcceleratorsW`/`TranslateAcceleratorW` for accelerator table | HIGH | Standard Win32; no new dependency |
| Status bar (POLISH-03) | `Comctl32` `STATUSCLASSNAME` (`msctls_statusbar32`) created via `CreateWindowExW` | HIGH | Already initialized via `InitCommonControlsEx`; just adds another control |

### Win32 Linkage Inventory (No New DLLs Required)

| DLL | Already linked? | New v1 use |
|-----|-----------------|------------|
| Kernel32 | Yes | `SHGetKnownFolderPath` returns paths we read via existing file APIs; `FindFirstFileW`/`FindNextFileW` for autocomplete |
| User32 | Yes | New accelerator table, new common-control children |
| Gdi32 | Yes | Sunburst path rendering (`BeginPath`/`AngleArc`/`EndPath`/`FillPath`) |
| Shell32 | Yes | `SHGetKnownFolderPath`, `SHCreateItemFromParsingName` |
| Comctl32 | Yes | Status bar, possibly `WC_COMBOBOXEX` for path autocomplete |
| Dwmapi | Yes | (no new use) |
| Ole32 | Yes | `IFileOperation` COM via existing `CoCreateInstance` pattern (already used for shell context menus) |
| UxTheme | Yes | (no new use) |

**Verdict:** zero new `#[link(name = "...")]` statements. Every new feature can be served by DLLs already pulled in by v0.1.0.

### Supporting Patterns

| Pattern | Where it lives | When to use |
|---------|----------------|-------------|
| Hand-rolled CRC-32 (polynomial `0xEDB88320`) | New `crc32_ieee()` helper alongside existing `fnv1a_file` | XLSX ZIP entry checksums; ~30-line implementation, identical structure to existing FNV-1a code |
| MS-DOS date/time packing for ZIP entries | New helper `dos_datetime(SystemTime) -> (u16, u16)` | XLSX writer; matches existing `epoch_ms_to_utc` style helper |
| Atomic file write | `std::fs::write(tmp); std::fs::rename(tmp, final)` | Settings save (avoid partial-write corruption on crash) |
| STA worker thread for `IFileOperation` | Spawn one short-lived thread, `CoInitializeEx(COINIT_APARTMENTTHREADED)` on entry, `CoUninitialize` on exit, post `WM_APP+N` back to the message loop with results | Cleanup workflow — keeps the message loop responsive (Constraint: "Cleanup operations must not block the message loop") |
| `WM_APP+N` for async completion | Already established pattern (`WM_SCAN_DONE`, `WM_SCAN_PROGRESS`) | Cleanup completion (`WM_CLEANUP_DONE`), settings async save acknowledgement |

## The XLSX Compression Decision (The Only Real Tension)

This is the only place a dependency case can be made. Captured explicitly:

**Option A (RECOMMENDED): Hand-rolled ZIP with STORED (method 0) entries**
- Implementation cost: ~200 lines (ZIP local header + central directory + EOCD writer, CRC-32, MS-DOS time, OOXML string templates)
- Output size: ~4-8× larger than deflated XLSX (XML is highly compressible)
- Excel compatibility: Verified — Excel opens STORED-method XLSX (search source: DataTables and XlsxWriter case studies)
- Constraint cost: **zero** — stays inside the zero-crate posture
- Risk: header field correctness is the only failure mode; mitigated by `cargo test` round-trip tests against Python `openpyxl` or Excel itself

**Option B: Hand-rolled ZIP + hand-rolled DEFLATE encoder**
- Implementation cost: ~600-1000 lines for a correct DEFLATE encoder (Huffman tables, LZ77 windowing, block boundaries). RFC 1951 is implementable but is the single largest piece of net-new code in v1.
- Output size: matches what Excel itself writes
- Risk: bug surface area is much larger than every other v1 item combined; not commensurate with the value of a smaller export file

**Option C (REJECTED): Add `flate2` or `miniz_oxide` crate**
- Implementation cost: ~zero
- Output size: matches Excel
- Constraint cost: **violates** the "zero external Rust crates" Key Decision, which is explicitly called out in PROJECT.md Constraints
- Pragmatic case: would add ~80-150 KB to the `.exe`, transitive `cc` build-tooling concerns for `miniz_oxide`, but is the only third-party dependency with a clear value proposition in v1
- **Verdict for v1:** Do not add. The Personal-tier scope does not justify breaking the seven-line Key Decision row "Keep zero-dependency Rust posture." If end-user reports of "XLSX file too large" arrive in v2, revisit with the DEFLATE-encoder vs. crate trade-off then.

**Recommendation:** Ship Option A in v1. Document the size trade-off in the XLSX export UI ("XLSX export uses uncompressed storage — files are larger than typical XLSX. Open in Excel and re-save to compress.").

## HTML Report Bundle Strategy

The web UI's existing `exportHtmlSnapshot()` (`web/app.js`) already produces a self-contained snapshot. The v1 native-side HTML export (EXPORT-02) should:

1. **Inline everything as text** — `<style>...</style>` (re-emit a stripped version of the existing CSS), `<script>...</script>` with the rendered data as a `const data = {...}` literal, and `<svg>...</svg>` for charts.
2. **Never Base64 anything** — vectors are inline SVG; there are no raster assets in the report by design. (Sources cited: Base64 SVG is a 33% size penalty for zero benefit; raw inline SVG renders fastest in cross-browser stress tests.)
3. **Reuse the in-binary web assets** as the template — `include_str!("../web/index.html")` already exists; the exporter substitutes the data island and strips the `<script src="/app.js">` reference in favor of inlined JS.
4. **Single file output** with a `.html` extension that opens via double-click on any Windows machine without a network round trip.

This is a string-building exercise that fits the existing serializer style. No new pattern needed.

## Sunburst Implementation Sketch

```text
fn sunburst_layout(root: &NodeRecord, nodes: &[NodeRecord]) -> Vec<Arc>
where
    struct Arc { node_id: usize, x0: f64, x1: f64, y0: f64, y1: f64, depth: u32 }
```

1. Recursive descent: each node receives `[x0, x1]` slice of `[0, 2π]` proportional to its size relative to siblings.
2. Each node receives `[y0, y1] = [depth * R/max_depth, (depth+1) * R/max_depth]`.
3. Apply `y = sqrt(y_raw / R_max) * R_max` to equalize ring areas (optional toggle — TreeSize-style sunbursts often use linear; offer both).
4. Render: GDI desktop calls `BeginPath`, then `MoveToEx` + `AngleArc` + `LineTo` to trace the annular segment, then `EndPath` + `FillPath`/`StrokePath`. HTML uses the equivalent `M`/`A`/`L` SVG path commands.

The math is well-documented and reproducible from the d3-hierarchy references cited in Sources. No external code needed.

## Snapshot Diff Implementation Sketch

```text
fn diff_scans(old: &ScanResult, new: &ScanResult) -> ScanDiff
where
    struct ScanDiff {
        identical: Vec<usize>,            // node ids in `new`
        modified: Vec<(usize, usize)>,    // (old_id, new_id) — same path, different size/mtime
        moved: Vec<(usize, usize)>,       // (old_id, new_id) — same (size, mtime) fingerprint, different path
        added: Vec<usize>,                // node ids in `new` not present in `old`
        removed: Vec<usize>,              // node ids in `old` not present in `new`
        total_delta_bytes: i64,
    }
```

1. Build two `HashMap<String, usize>` indexes over `old`: `by_path` and `by_fingerprint` where fingerprint = `(size, mtime_epoch_seconds)`.
2. Walk `new`; for each node: try `by_path` first (identical or modified), then `by_fingerprint` (moved), else added.
3. Remove from the indexes as you go; whatever remains in `by_path` after the walk is `removed`.
4. Aggregate `total_delta_bytes = sum(new.size) - sum(old.size)`.

Storage for prior snapshots: serialize `ScanResult` to JSON (existing serializer) under `%APPDATA%\FileTree\snapshots\<sanitized-path>-<timestamp>.json`. Retention policy: keep last N (configurable; default 10).

## Settings Schema Sketch

`%APPDATA%\FileTree\settings.json`:

```text
{
  "version": 1,
  "last_path": "C:\\Users\\dan",
  "dark_mode": true,
  "follow_symlinks": false,
  "show_hidden": true,
  "column_widths": { "name": 320, "size": 100, ... },
  "saved_views": [
    { "name": "Big videos", "min_size": 104857600, "extensions": ["mp4", "mkv"] }
  ],
  "bookmarks": [
    { "label": "Downloads", "path": "C:\\Users\\dan\\Downloads" }
  ]
}
```

Read at startup (silently fall back to defaults on parse failure or missing file). Write debounced (e.g., 2 seconds after last change) and atomically.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| `IFileOperation` (COM) | `SHFileOperationW` (legacy flat API) | Fall back only if the cleanup happens on an MTA worker thread that cannot be made STA. In our app the cleanup runs on a dedicated STA thread, so this fallback is not needed |
| Hand-rolled ZIP method 0 (STORED) for XLSX | Hand-rolled ZIP + hand-rolled DEFLATE (method 8) | Only if user feedback indicates XLSX file size is a problem and engineering bandwidth exists for a correct DEFLATE encoder |
| Hand-rolled ZIP + STORED | `flate2` / `miniz_oxide` crate | Only if XLSX file size becomes a blocker AND the team explicitly accepts breaking the zero-dependency Key Decision. Out of scope for v1 |
| JSON for settings | TOML | Only if we adopt TOML elsewhere; we currently have no TOML serializer and writing one for settings alone is wasteful |
| JSON for settings | Windows Registry (`HKCU\Software\FileTree`) | Only for per-machine system policy; settings.json is more portable and easier to debug |
| `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` | `std::env::var("APPDATA")` | Never preferred — env vars can be unset or spoofed; small wrapper around the Win32 call is trivial |
| Inline `<svg>` in HTML report | Canvas-rendered PNG → Base64 `<img>` | Only if a chart becomes too DOM-heavy for inline SVG (10000+ paths). Our report sizes are small enough that inline SVG always wins |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `SHFileOperationW` for new code | Officially superseded by `IFileOperation` per Microsoft docs; less accurate error reporting; double-null-terminated string footgun | `IFileOperation::DeleteItems` with `FOFX_RECYCLEONDELETE \| FOFX_ADDUNDORECORD` |
| `std::env::var("APPDATA")` | Environment can be spoofed or absent; Rust's own `env::home_dir` issue tracker explicitly flags this | `Shell32::SHGetKnownFolderPath(FOLDERID_RoamingAppData, ...)` |
| Base64-encoded SVG in HTML report | 33% size penalty; SVG is text and inlines natively | Raw `<svg>...</svg>` inline in the HTML report |
| Third-party Rust XLSX/ZIP/DEFLATE crates in v1 | Breaks the explicit zero-dependency Key Decision; the alternative (STORED ZIP) is acceptable to Excel | Hand-rolled ZIP method 0 + hand-rolled OOXML strings |
| ZIP64 for XLSX | Our XLSX files will never exceed 4 GB or 65535 entries (one workbook, one or two worksheets, optional shared strings) | Regular ZIP with 4-byte size fields |
| MTA COM (`COINIT_MULTITHREADED`) for cleanup | `IFileOperation` is STA-only per Microsoft docs | The desktop's existing STA `COINIT_APARTMENTTHREADED`, plus a dedicated STA worker thread per cleanup batch |
| Recursive `scan_directory_job` re-scan after delete | Wasteful — we know exactly what was deleted | Mutate the in-memory `Vec<NodeRecord>` in place: decrement parents' `size`/`files`/`folders`/`allocated`, remove the deleted nodes, re-aggregate the affected subtree only |

## Stack Patterns by Variant

**If user requests permanent delete:**
- Use the same `IFileOperation` object, omit the `FOFX_RECYCLEONDELETE` flag, set `FOF_NOCONFIRMATION` and a custom confirmation dialog beforehand
- This unifies the destructive-action UX into one code path

**If a v1.x adds image thumbnails to the HTML report:**
- Embed via Base64 `<img src="data:image/png;base64,...">` is the only single-file option
- Cap at 64 KB per image; reject larger
- This is the *only* place Base64 makes sense

**If snapshot count grows large (>50 saved):**
- Retention policy in settings (LRU eviction); per-path snapshot directory; consider compressing snapshot JSON files (deferred — same DEFLATE question; for now, store uncompressed since they're text JSON and `.json` files compress well on NTFS-compressed volumes anyway)

**If the existing single `src/main.rs` becomes unwieldy mid-milestone:**
- Split into `src/main.rs` + `src/scan.rs` + `src/server.rs` + `src/desktop/mod.rs` + `src/desktop/sunburst.rs` etc. The file is already ~5055 lines; v1 will add 1500-2500 more. Split is a refactor task, not a stack decision — but flag it for an early phase

## Version Compatibility

| Component | Requires | Notes |
|-----------|----------|-------|
| `IFileOperation` | Windows Vista+ | Trivially satisfied (Windows 10/11 target) |
| `FOFX_RECYCLEONDELETE` flag | Windows 8+ | Trivially satisfied |
| `FOLDERID_RoamingAppData` | Windows Vista+ | Trivially satisfied |
| `SHGetKnownFolderPath` | Windows Vista+ | Trivially satisfied |
| Rust 1.85+ edition 2024 | (current) | Existing baseline — no change |
| OOXML SpreadsheetML | ECMA-376 / ISO 29500, Edition 1 (Transitional) | Stable since 2008; Excel 2007+ reads it |
| ZIP method 0 (STORED) | APPNOTE.TXT 1.0+ | Universal; not a compatibility concern |
| DWM dark titlebar (existing) | Windows 10 1809+ | Existing baseline |

## Confidence Per Recommendation

| Recommendation | Confidence | Basis |
|----------------|------------|-------|
| `IFileOperation` for Recycle Bin | HIGH | Microsoft Learn primary source; widely deployed pattern; explicit STA constraint matches our desktop module |
| `SHGetKnownFolderPath` for `%APPDATA%` | HIGH | Microsoft Learn primary source; Rust issue tracker corroboration |
| Hand-rolled ZIP STORED for XLSX | MEDIUM-HIGH | PKWARE APPNOTE.TXT primary source; Excel-accepts-STORED is confirmed by multiple practitioner sources but warrants a round-trip test before locking it in |
| Hand-rolled OOXML SpreadsheetML | HIGH | Official ECMA-376 spec; minimum-viable-XLSX walkthrough corroborates four required parts |
| Sunburst polar partition + sqrt scaling | HIGH | d3-hierarchy and d3-arc documentation; pure math, language-agnostic |
| Snappdiff two-pass HashMap algorithm | HIGH | Cited working Rust implementation; matches our existing flat-Vec node model |
| Inline SVG (not Base64) for HTML reports | HIGH | Multiple cross-browser performance studies; SVG is text |
| Reject `flate2` / `miniz_oxide` crate | HIGH | Direct application of the documented Key Decision in PROJECT.md |
| `WM_APP+N` async cleanup completion | HIGH | Already-proven pattern in the existing `desktop` module |

## Implementation Notes

- **CRC-32 polynomial** for the ZIP writer: `0xEDB88320` (reversed IEEE 802.3). Implement as a 256-entry lookup table computed at runtime (LazyLock) or as a `const fn` table — either is fine; the existing `fnv1a_file` follows the simple-loop style and the CRC-32 implementation should match.
- **DOS time/date format** for ZIP entries: time = `(hour << 11) | (minute << 5) | (second / 2)`; date = `((year - 1980) << 9) | (month << 5) | day`. Two-second precision is fine for our use case.
- **`IFileOperation` Rust FFI**: declare the COM interface using the same `#[repr(C)]` vtable pattern already used in `mod desktop` for `IShellFolder` and `IContextMenu`. No `windows-rs` or `winapi` crate needed.
- **OOXML namespace declarations**: hardcode the four required XML namespaces (`spreadsheetml/2006/main`, `package/2006/relationships`, `officeDocument/2006/relationships`, `package/2006/content-types`) as `const &str` constants alongside the existing `INDEX_HTML` etc.
- **Settings async save**: rather than write on every change, set a dirty flag + `SetTimer` with 2000 ms; on `WM_TIMER`, write + clear flag. Keeps disk I/O off the hot UI path without spawning a thread.
- **Sunburst hover/click**: hit-testing in polar space is `atan2(y - cy, x - cx)` for angle, `sqrt((x-cx)^2 + (y-cy)^2)` for radius, then bisect against the arc list sorted by `(depth, x0)`.

## Installation

No new dependencies. `Cargo.toml` `[dependencies]` remains empty. All work is `src/` and `web/` changes.

```bash
# No package changes
cargo build --release
```

## Sources

### Win32 / COM
- [Microsoft Learn — IFileOperation (shobjidl_core.h)](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ifileoperation) — primary source for delete/move/copy COM interface (HIGH confidence)
- [Microsoft Learn — SHFileOperationW (shellapi.h)](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shfileoperationw) — confirms deprecation in favor of IFileOperation (HIGH confidence)
- [Microsoft Learn — SHGetKnownFolderPath](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/UI/Shell/fn.SHGetKnownFolderPath.html) — primary source for `%APPDATA%` resolution (HIGH confidence)
- [Microsoft Learn — FOLDERID_RoamingAppData constant](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/UI/Shell/constant.FOLDERID_RoamingAppData.html) — GUID for `SHGetKnownFolderPath` (HIGH confidence)
- [rust-lang/rust#28940 — env::home_dir should use SHGetKnownFolderPath](https://github.com/rust-lang/rust/issues/28940) — corroborates `%APPDATA%` env var unreliability (HIGH confidence)

### ZIP / OOXML / XLSX
- [PKWARE APPNOTE.TXT 6.3.10 — .ZIP File Format Specification](https://pkware.cachefly.net/webdocs/APPNOTE/APPNOTE-6.3.10.TXT) — authoritative ZIP container spec (HIGH confidence)
- [Office Open XML — Anatomy of an OOXML SpreadsheetML File](http://officeopenxml.com/anatomyofOOXML-xlsx.php) — minimal four-part XLSX structure (HIGH confidence)
- [Microsoft Learn — Structure of a SpreadsheetML document](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document) — primary source for workbook/worksheet/relationships XML (HIGH confidence)
- [Brendan Long — The minimum viable XLSX reader](https://www.brendanlong.com/the-minimum-viable-xlsx-reader.html) — corroboration of minimal parts (MEDIUM confidence; third-party but consistent with spec)
- [DataTables forum — XLSX export uses STORE method](https://datatables.net/forums/discussion/73001/no-compression-when-exporting-to-excel) — empirical evidence Excel accepts STORED-method XLSX (MEDIUM confidence; multiple corroborating threads)
- [SheetJS/sheetjs#220 — Created XLSX compression](https://github.com/SheetJS/sheetjs/issues/220) — additional corroboration of STORED vs DEFLATE behavior (MEDIUM confidence)

### Sunburst Geometry
- [d3js.org — d3-hierarchy documentation](https://d3js.org/d3-hierarchy) — partition layout, polar coordinates (HIGH confidence)
- [Observable — Zoomable sunburst (D3 reference implementation)](https://observablehq.com/@d3/zoomable-sunburst) — canonical algorithm reference (HIGH confidence)
- [ncoughlin.com — D3 Sunburst Chart](https://ncoughlin.com/posts/d3-sunburst) — explanation of `[x0, x1, y0, y1]` and `Math.sqrt` radial scaling (MEDIUM-HIGH confidence)

### HTML Bundle Strategy
- [Cloud Four — Which SVG technique performs best?](https://cloudfour.com/thinks/svg-icon-stress-test/) — cross-browser performance: inline SVG wins (HIGH confidence)
- [CSS-Tricks — Probably Don't Base64 SVG](https://css-tricks.com/probably-dont-base64-svg/) — corroborates Base64 penalty for text formats (MEDIUM-HIGH confidence)
- [DebugBear — Avoid Large Base64 data URLs in HTML and CSS](https://www.debugbear.com/blog/base64-data-urls-html-css) — 33% size penalty quantified (MEDIUM-HIGH confidence)

### Snapshot Diff
- [jotaen.net — snappdiff: CLI tool to diff directory snapshots](https://www.jotaen.net/iE3XC/snapdiff-compare-directory-trees-on-CLI/) — two-pass HashMap algorithm reference; same data model as ours (HIGH confidence)

---
*Stack research for: FileTree v1 (Windows disk-usage explorer, brownfield milestone)*
*Researched: 2026-05-22*
