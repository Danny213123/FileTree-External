# Research Summary — FileTree v1

**Synthesized:** 2026-05-22
**Inputs:** STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md
**Confidence:** HIGH

---

## Stack Recommendation

Stay zero-Rust-dependency. Every v1 capability resolves to Win32 APIs already linked (`Ole32`, `Shell32`, `Comctl32`, `Gdi32`, `Kernel32`, `User32` — all Vista+, satisfied on Win 10/11) plus hand-rolled JSON in the existing `push_json_string` serializer style. No new `#[link(...)]` is needed and `Cargo.toml [dependencies]` remains empty.

## Table Stakes

- Multi-select in tree + duplicates + top-files tabs (precondition for any cleanup UX)
- Recycle-Bin-safe delete via `IFileOperation` with confirmation dialog (count + total bytes + top-N largest paths), post-action summary, lowest-common-ancestor subtree auto-refresh
- In-scan search by name (glob + substring, case-insensitive) + filter by size/date/extension/age, debounced ~100–150 ms
- Saved bookmarks + settings persistence under `%APPDATA%\FileTree\` (atomic write, schema version, single-instance guard)
- Native desktop treemap panel (treemap currently lives only in the web UI)
- HTML report export as a single self-contained file (inline `<style>`, `<svg>`, `<script type="application/json">` data island — never Base64)

## Watch Out For

- **Permanent-delete-by-default trap.** `SHFileOperationW` requires `FOF_ALLOWUNDO`; `IFileOperation` requires `FOFX_RECYCLEONDELETE` on Win 8+; `std::fs::remove_*` (used by existing `/api/delete`) is always permanent. Single code path through `IFileOperation::DeleteItems` with explicit flags.
- **Junction/symlink recursive-delete redirect** (MSRC published 42 CVEs in 2024 in this class). Tag every `NodeRecord` with `is_reparse_point` + `reparse_tag` at scan time; let `IFileOperation` delete reparse points without recursing.
- **TOCTOU between scan and delete.** Re-stat every path (size + mtime + file ID) before sending to `IFileOperation`; skip + report mismatches; disable cleanup UI during scans.
- **Multi-select identity drift across re-scans.** Selection MUST be keyed by stable path string, never by `Vec<NodeRecord>` index; resolve identities against the new tree on every `WM_SCAN_DONE`.
- **Win32 message-loop blocking + COM apartment mistakes.** Cleanup runs on a dedicated STA worker thread; the worker calls `PeekMessage` first to force-create its queue; all callbacks use `PostMessage` (never `SendMessage` cross-thread); LPARAM payloads are heap-allocated `Box::into_raw`.

## Key Decisions Surfaced

| Decision | Recommendation | Rationale |
|---|---|---|
| Cleanup API | **`IFileOperation` (COM)**, NOT `SHFileOperationW` | Modern documented successor, supports `IFileOperationProgressSink` for progress+cancel, handles long paths via `\\?\`, produces Explorer "Restore" undo records. Existing code already initializes STA and already uses COM vtables for `IShellFolder`/`IContextMenu` — same FFI pattern, no new infrastructure. |
| XLSX export (EXPORT-03) | **Defer to v2** | CSV + JSON + new HTML report cover spreadsheet-import / scripting / share-with-family. Hand-rolled STORED-ZIP + OOXML is ~200–300 lines with a bug surface Excel silently "Repairs"; the only sound alternative (`flate2`/`miniz_oxide` crate) violates the zero-dependency Key Decision with no commensurate value at Personal tier. |
| Existing `/api/delete` route | **REMOVE in the cleanup phase**, do not harden | No UX consumer today, uses unsafe `std::fs::remove_dir_all`, reachable by any loopback process. Hardening would duplicate the cleanup pipeline server-side with no demand signal. Move DELETE-01 from Validated → Out of Scope. |
| Module split | **Do it FIRST**, in its own phase, no feature piggyback | Every v1 feature touches the 2,000+ line `mod desktop` block plus the JSON serializer. ~1–2 days of mechanical work now vs. multi-week competing work at milestone end. |
| Settings format | **Hand-rolled JSON** with `schema_version`, atomic temp+rename, single-instance guard via named mutex | Not TOML (no existing serializer), not Registry (less portable, harder to debug). Atomic-write + version field cost ~10 lines and prevent permanent user-data loss. |
| Snapshot persistence | **Plain JSON via existing `scan_result_to_json` serializer** | Differentiator vs. Pro tools' opaque .db formats; falls out as a `filetree diff a.json b.json` CLI subcommand. Path-keyed by RELATIVE path to survive drive-letter shifts; canonicalize via `GetFullPathNameW` + lowercase compare key + `GetLongPathNameW` for 8.3 names. |

## Recommended Build Order

Four-way research consensus; deviation = roadmap risk.

1. **Phase A — Module split** (refactor, no behavior change). Mechanical; unblocks everything; runs `cargo fmt` + `cargo clippy -D warnings` + smoke test.
2. **Phase B — Settings persistence + `%APPDATA%\FileTree\` store** (atomic write, schema v1, single-instance guard). Bookmarks/snapshots/saved-views all piggyback.
3. **Phase C — Polish: path bar + status bar + keyboard shortcuts** (POLISH-01/02/03). Cheap wins; improves manual testing for D–K.
4. **Phase D — Search + filter** (SEARCH-01/02/03/04). Validates immutable-`ScanResult` + derived-`VisibleRows` pattern before cleanup needs it.
5. **Phase E — Multi-select infrastructure, no delete yet** (CLEAN-01). Selection keyed by stable path string. Status bar shows "N items selected, X bytes".
6. **Phase F — Cleanup workflow** (CLEAN-02..06) — **HIGHEST-RISK SINGLE PHASE.** `IFileOperation` on STA worker thread, `IFileOperationProgressSink`, re-stat-before-delete TOCTOU check, drive-type warning for network/removable, lowest-common-ancestor re-scan, post-action summary with errors. **REMOVES** legacy `/api/delete` route. Add unit tests for `Filter::matches`, path quoting, double-null termination, `Selection::summarize()`. Ship behind feature flag for one internal-use cycle.
7. **Phase G — Duplicates UX upgrade** (DUP-02/03/04). Reuses Phase F pipeline. Smart-keep helpers must always leave ≥1 file per group checked.
8. **Phase H — Snapshot save + bookmarks + saved views** (SCAN-04, SCAN-05 save half, SCAN-06, SEARCH-05). Path normalization is foundational here.
9. **Phase I — Snapshot diff** (SCAN-05 diff half). Two-pass HashMap algorithm keyed by relative path + `(size, mtime)` fingerprint. New Diff tab; bonus `filetree diff a.json b.json` CLI subcommand.
10. **Phase J — New visualizations** (VIZ-03/04/05). Native treemap (port `layoutTreemap` from JS to Rust+GDI), sunburst (polar partition + `BeginPath`/`AngleArc`/`EndPath`), age-tinted treemap toggle (HSL hue from mtime — the differentiator).
11. **Phase K — HTML export** (EXPORT-02, EXPORT-04). Self-contained `.html`, HTML-escaped paths, CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`. **XLSX (EXPORT-03) DEFERRED to v2.**

## Research Flags for Downstream `gsd-research-phase`

- **Phase F (Cleanup): HIGH research need.** `IFileOperationProgressSink` Rust FFI vtable shape (we provide, not consume — different from existing consumer FFI), parent-window cooperation with the shell progress dialog, cancel responsiveness on 50k-item batches, unit-test surface for path quoting / double-null termination.
- **Phase H/I (Snapshots + diff): MEDIUM.** Path normalization edge cases (case + 8.3 + `\\?\` + UNC vs drive-letter + junction-resolved-or-not), snapshot compact-mode size threshold.
- **Phase K (HTML export): MEDIUM.** XSS surface for filenames containing `<script>`, exact CSP wording, single-file size cap for very large scans.
- **Standard patterns (skip research):** Phases A, B, C, D, E, G, J.

## Confidence

**Overall: HIGH.** STACK and ARCHITECTURE = HIGH (Microsoft Learn primary sources; recommendations evolve proven brownfield patterns). FEATURES = HIGH (category synthesis well-established; PROJECT.md enumerates every Active requirement). PITFALLS = HIGH for destructive ops (verified against Microsoft Learn + MSRC June 2025 RedirectionGuard), MEDIUM for snapshot/settings/scan-correctness.

**Gaps to address during planning/execution:**

- `IFileOperationProgressSink` Rust FFI vtable shape — spike in Phase F before full implementation.
- Cancel-responsiveness budget on 50k-item delete — empirical measurement in Phase F.
- Snapshot compact-mode threshold — tuning question in Phase H.
- Test infrastructure — Phase F should make explicit the unit-test work that ARCHITECTURE risk #8 calls for.
