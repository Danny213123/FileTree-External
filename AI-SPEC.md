# AI-SPEC: FileTree

**Project:** FileTree — Windows disk-usage explorer
**Milestone:** v1 (TreeSize-Personal-tier coverage)
**Last updated:** 2026-05-27

---

## 1b. Domain Context

**Industry Vertical:** Personal productivity / Windows desktop utilities — specifically the disk-usage analyzer and file management tool category.

**User Population:** Personal-PC owners and prosumers on Windows 10/11 who want to understand what is consuming disk space and safely remove bloat. Users include developers (dealing with `node_modules`, `.git`, build artifacts), home users (photo/video libraries, downloads), and IT-adjacent power users running the tool on someone else's machine. The tool is distributed as a single portable `.exe` — users have a high trust expectation because the tool has write/delete access to their files.

**Stakes Level:** High — the tool performs destructive file operations (delete to Recycle Bin, permanent delete, move). A wrong-path delete caused by a stale selection, a missing Recycle Bin flag, or a junction-traversal bug is unrecoverable on SSDs (TRIM prevents file recovery). The confirmation surface, the accuracy of "bytes to be deleted," and the correct behavior of Recycle Bin semantics are load-bearing trust signals.

**Output Consequence:** When the user acts on the tool's output (selects files to delete, interprets byte counts, reads scan results), they are making irreversible file system changes. Incorrect size reporting leads to wrong cleanup decisions. Incorrect delete behavior (permanent instead of Recycle Bin, wrong paths due to stale state) causes data loss. The downstream consequence of a bad output is data destruction, not just a bad user experience.

---

### What Domain Experts Evaluate Against

Domain experts in this category are experienced Windows users, power users, and developers who have used WinDirStat, TreeSize, SpaceSniffer, or Windows File Explorer as their baseline. They evaluate disk-usage tools against concrete, observable behaviors — not abstract "accuracy."

---

**Dimension: Delete safety — does it actually go to the Recycle Bin?**

Good (domain expert would accept): Deleting a file via the tool produces a visible entry in the Windows Recycle Bin with the original filename and path metadata preserved. The confirmation dialog says "Move to Recycle Bin" (not just "Delete"). The tool detects network and removable drives and warns that Recycle Bin is unavailable before proceeding. The "Permanent delete" path requires a second explicit confirmation step.

Bad (domain expert would flag): A file deleted via the tool disappears from the Recycle Bin and from disk with no recovery option. The confirmation dialog says "Delete" without clarifying Recycle Bin vs. permanent. The permanent-delete checkbox changes behavior silently without additional confirmation. Any code path that calls `std::fs::remove_dir_all` or `DeleteFileW` directly for user-initiated cleanup.

Stakes: Critical — unrecoverable data loss is the failure mode. This is the single highest-trust signal in the category.

Source: Win32 Shell API documentation: `SHFileOperationW` deletes permanently without `FOF_ALLOWUNDO`; `IFileOperation` requires `FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD` explicitly. MSRC documented 42 CVEs in 2024-2025 in the junction-redirect delete class. Existing codebase `/api/delete` uses `fs::remove_dir_all` (permanent — documented as dangerous in `.planning/codebase/CONCERNS.md`).

---

**Dimension: Size accuracy — do the numbers reflect what will actually be freed?**

Good (domain expert would accept): Selecting a set of files and clicking Delete results in the disk-free counter rising by approximately the reported "bytes to reclaim." The numbers account for NTFS compression (allocated size vs. logical size), distinguish between size-on-disk and file size, and warn when hardlinks mean deleting a file will not free its bytes. The confirmation dialog shows the total bytes selected AND a disclaimer if hardlinks are present.

Bad (domain expert would flag): "Bytes reclaimed" after a delete is consistently less than the amount shown in the confirmation dialog by more than 10%. The tool reports `winsxs`, Docker layers, or Git object packs as taking 2-5x more space than they actually occupy on disk (hardlink double-count). The tool shows "4.8 GB selected" but only 400 MB is freed because the selection contained 4 hardlinked copies of the same data.

Stakes: High — incorrect numbers destroy user trust. A tool that says "free up 10 GB" and only frees 1 GB will be uninstalled immediately.

Source: TreeSize and SpaceObServer both disable hardlink-aware scanning by default due to scan cost but expose it as an explicit toggle. NTFS allocated-size via `GetCompressedFileSizeW` is already implemented in FileTree (`platform_allocated_size()`). Hardlink double-count is documented in `.planning/research/PITFALLS.md` Pitfall 5.

---

**Dimension: Shell integration completeness — does right-click work the way Explorer does?**

Good (domain expert would accept): Right-clicking any file or folder row in the tree shows a context menu with at minimum: Open, Open with, Reveal in Explorer, Copy path, Properties, Delete. Selecting "Open" launches the file in its default application. "Reveal in Explorer" opens Explorer with the item highlighted (not just the parent folder). "Copy path" puts the full path on the clipboard as text. "Properties" shows the Windows shell Properties dialog.

Bad (domain expert would flag): Right-click shows a minimal custom menu that lacks "Open with" or "Send to." "Reveal in Explorer" opens the parent folder without selecting the item. There is no "Copy path." Properties shows a custom dialog instead of the Windows shell dialog. No way to act on a file without leaving the tool.

Stakes: High — this is the table-stakes feature that separates a disk-analysis tool from a dead-end viewer. WinDirStat, SpaceSniffer, and TreeSize all surface shell context menus. A tool without this forces a frustrating tool-switch for every file action.

Source: Competitive analysis of WinDirStat (right-click → Explorer Here, Delete), SpaceSniffer (full shell context menu delegation via `IContextMenu`), TreeSize Professional (full shell context menu + file operations dialog). Microsoft Learn: `ShellExecuteW` verbs (open, explore, properties), `SHOpenFolderAndSelectItems` for reveal-and-highlight, `IShellFolder::GetUIObjectOf` + `IContextMenu` for full shell menu delegation.

---

**Dimension: Selection correctness across refresh — does the tool act on the right files?**

Good (domain expert would accept): A user selects 50 files, triggers a refresh (or an auto-refresh fires after a delete), and the selection still refers to the same 50 physical files (matched by stable path identity, not vector index). Files that no longer exist after refresh are silently dropped from the selection with a count shown to the user ("12 of 50 items no longer found"). The confirmation dialog before delete shows full verbatim paths for the top-N largest items so the user can verify.

Bad (domain expert would flag): After any refresh, a delete operation acts on whatever happens to be at the previously-selected vector indices — potentially different files. The confirmation dialog shows only "Delete 50 files (3.2 GB)" with no paths visible. A user can click Delete immediately after a refresh without realizing the selection has silently shifted.

Stakes: Critical — this is a wrong-path delete bug. Selecting files A, B, C and having the tool delete X, Y, Z because the index-based selection shifted is unrecoverable data loss.

Source: Architecture constraint documented in `.planning/codebase/ARCHITECTURE.md`: `Vec<NodeRecord>` with `id: usize` as vector position; indices are unstable across scans. `.planning/research/PITFALLS.md` Pitfall 9: "A delete after a refresh removes files the user didn't select." REQUIREMENTS.md SEL-02 specifies selection keyed by stable full-path string.

---

**Dimension: Competitive file-operation parity — does the tool complete the find-act loop?**

Good (domain expert would accept): A user who finds a 4 GB file they want to delete can: (1) select it in the tree, (2) press Del or right-click → Delete, (3) confirm in a dialog that shows the exact path and size, (4) see a post-action summary with bytes reclaimed, and (5) see the tree update to reflect the deletion — all without leaving the app or switching to Explorer. This entire flow takes under 15 seconds.

Bad (domain expert would flag): After identifying a large file, the user must copy the path, open Explorer, navigate to the path, locate the file, and delete it there. The tool then requires a full re-scan to reflect the change. There is no multi-select. There is no confirmation dialog. The user cannot see what was reclaimed after the operation.

Stakes: High — this is the product's core value proposition ("point at it, clean it up"). A tool that identifies bloat but cannot remove it is a sophisticated replacement for `du -sh`. All three reference tools (WinDirStat, SpaceSniffer, TreeSize) close this loop to varying degrees.

Source: FileTree `.planning/PROJECT.md` Core Value: "Point at a folder, see what's taking space, and clean it up — fast." Feature research `.planning/research/FEATURES.md`: "A surprising number of disk-usage tools force a tool-switch to act." REQUIREMENTS.md CLEAN-01..10 covers the full pipeline.

---

### Known Failure Modes in This Domain

**1. Recycle Bin bypass via wrong Win32 API choice.** `std::fs::remove_dir_all`, `DeleteFileW`, and `SHFileOperationW` without `FOF_ALLOWUNDO` all permanently delete files. The existing `/api/delete` route uses `fs::remove_dir_all` — wiring this to the UI is a catastrophic failure mode. The only safe path is `IFileOperation` with `FOFX_RECYCLEONDELETE | FOFX_ADDUNDORECORD`.

**2. Junction/symlink traversal deleting unrelated parts of the disk.** A recursive delete through a folder junction (e.g., `%LOCALAPPDATA%\Temp\Cache` → symlinked to `C:\Users\Documents`) can wipe the target. MSRC documented 42 CVEs in this class in 2024-2025. The fix: tag `NodeRecord` with `is_reparse_point` at scan time; on delete, use `IFileOperation::DeleteItems` which the shell handles correctly, never `remove_dir_all`.

**3. Hardlink double-counting inflating size estimates.** On developer machines with Git worktrees, Docker layer caches, or `winsxs`, hardlinked files are counted once per name. Selecting and deleting 4 hardlinked copies of a 1.2 GB pack file frees 1.2 GB once, not 4.8 GB. Users see "freed 400 MB of the promised 4.8 GB" and lose trust in every number the tool shows.

**4. Stale selection indexes causing wrong-path deletes after any tree refresh.** If selection is stored as `Vec<usize>` indices into `Vec<NodeRecord>` and the tree is rebuilt (full rescan, subtree refresh, or sort), the indices point to different files. This is the category's most severe latent bug pattern — silent data loss with no error message.

---

### Regulatory / Compliance Context

None identified for this deployment context. FileTree is a personal-use, single-machine Windows desktop tool with no network component, no user data collection, no PII storage, and no regulated-industry use cases. The closest relevant concern is:

- **Windows security model:** The tool must never run as SYSTEM or in an elevated context beyond what the user explicitly authorized. All file operations execute under the current user's ACL constraints. The `/api/delete` HTTP endpoint is a potential privilege-escalation vector if the server port is exposed beyond loopback — documented in `.planning/codebase/CONCERNS.md` and `.planning/research/PITFALLS.md` Security Mistakes table.

---

### Domain Expert Roles for Evaluation

| Role | Responsibility in Eval |
|------|----------------------|
| Power Windows user (developer or IT-adjacent) | Reference dataset labeling — what counts as "correct" Recycle Bin behavior, shell context menu completeness, acceptable size accuracy. Primary rubric calibration. |
| Developer familiar with Win32 Shell APIs | Edge case review — junction handling, hardlink counting, long-path behavior, TOCTOU re-stat correctness. Review the "Looks Done But Isn't" checklist in PITFALLS.md. |
| Senior project engineer / product owner | Phase 5 cleanup pipeline sign-off — confirm delete safety criteria before any cleanup UI is exposed to users. Production sampling after Phase 5 ships. |

If no external evaluators are available: the project author fulfills all three roles. The "Looks Done But Isn't" checklist in `.planning/research/PITFALLS.md` (21 items) serves as the self-evaluation rubric for the cleanup pipeline.

---

### Research Sources

- [SHFileOperationW — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shfileoperationw) — permanent delete without FOF_ALLOWUNDO
- [IFileOperation — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ifileoperationprogresssink) — FOFX_RECYCLEONDELETE requirement
- [Handling Shell Data Transfer Scenarios — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/shell/datascenarios) — CF_HDROP, CFSTR_SHELLIDLIST, OLE clipboard
- [Shell Clipboard Formats — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard) — CF_HDROP construction, OleSetClipboard
- [OleSetClipboard — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-olesetclipboard)
- [SHDoDragDrop — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shdodragdrop) — preferred drag source API (Vista+)
- [DoDragDrop — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-dodragdrop)
- [IDropTarget — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/oleidl/nn-oleidl-idroptarget)
- [RegisterDragDrop — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-registerdragdrop)
- [Transferring Shell Objects with Drag-and-Drop and Clipboard — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/shell/dragdrop)
- [TreeSize Professional Features — JAM Software](https://www.jam-software.com/treesize/features.shtml)
- [WebView2 Native File Drag & Drop Issue #3618 — MicrosoftEdge/WebView2Feedback](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3618)
- [ICoreWebView2CompositionController3 — Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2compositioncontroller3)
- [Notes on NTFS — TreeSize](https://manuals.jam-software.com/treesize/EN/notesonntfs.html) — hardlink/reparse-point handling
- Full gap analysis and Win32 API reference: `.planning/research/SHELL-OPS-GAP-ANALYSIS.md`
- Existing domain research: `.planning/research/PITFALLS.md`, `.planning/research/FEATURES.md`

---

*Section 1b authored: 2026-05-27*
