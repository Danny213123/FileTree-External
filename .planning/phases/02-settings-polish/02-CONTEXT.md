# Phase 2: Settings & Polish — Context

**Gathered:** 2026-05-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Make user settings round-trip across launches via `%APPDATA%\FileTree\settings.json` (atomic temp+rename, named-mutex single-instance guard, `schema_version: 1` with forward-compatible read), and finish the desktop shell so later phases are ergonomic to manually test: a path bar with drive picker + folder autocomplete, the six keyboard shortcuts listed in POL-02 (Enter / Esc / Del / Ctrl+F / Ctrl+E / F5), and a status bar showing live scan stats (files / folders / errors / elapsed / throughput MB/s).

Persisted state covers: last path, column widths, dark-mode toggle, hidden/symlink toggles, window size/position. Requirements SET-01..05 and POL-01..03 are locked by ROADMAP.md and REQUIREMENTS.md — this phase clarifies HOW to implement them, not WHETHER to add capabilities. Anything beyond that list (saved views, bookmarks, snapshot index) belongs to Phases 3 and 7, which will reuse SET-01's store.

</domain>

<decisions>
## Implementation Decisions

### Settings file: format & parser

- **D-01:** On-disk format stays JSON. Hand-roll a minimal JSON reader (~150–300 LOC) supporting objects, arrays, strings (with `\"`, `\\`, `\n`, `\t`, `\uXXXX` escapes), numbers (i64 + f64), booleans, and null. Rationale: every other user-facing file the app produces is JSON (export.json, /api/scan, Phase 7 snapshots); a second format would split the surface and force a parser anyway when Phase 3 adds saved views and Phase 7 adds the snapshot index. The existing `export::push_json_string` builder is the model for the writer half — the reader is the missing complement.
- **D-02:** Forward-compatible read = **preserve unknown keys round-trip**. The parser captures any top-level key not in the `Settings` struct into a side-bucket (e.g. `unknown: BTreeMap<String, RawJsonValue>`), and the writer emits those keys back verbatim after the known fields. This matches SET-03's "forward-compatible read" literally: a future v2 schema that adds keys can be opened by a v1 build and re-saved without nuking the v2-only state. Also applies to unknown keys inside nested objects (`window`, `columns`) — capture per-level.
- **D-03:** Save trigger = **save immediately on every change**. Each mutation of `Settings` goes through a single helper that performs the atomic temp+rename (Pitfall #7) before returning. No debounce, no SetTimer infra. Risk: continuous drag-style events (column-width WM_MOUSEMOVE, window-resize WM_SIZING) would write per-pixel. **Mitigation under Claude's discretion:** coalesce *only* drag-style continuous events by buffering the in-memory `Settings` during the drag and writing once on the drag-end message (WM_LBUTTONUP for column drag, WM_EXITSIZEMOVE for window resize). Discrete events (dark-mode toggle, hidden-files toggle, path commit) still write immediately.

### Single-instance behavior

- **D-04:** Second instance **focuses the existing window AND forwards the CLI path** via WM_COPYDATA. Sequence: try `OpenMutexW(Local\FileTree.SingleInstance.v1)`; on success (mutex already held), `FindWindowW` by class name to get the existing HWND, call `AllowSetForegroundWindow(target_pid)` from the second instance and `SetForegroundWindow(hwnd)` after sending, then `SendMessageW(hwnd, WM_COPYDATA, ...)` with the path payload, then exit 0. The primary's `WM_COPYDATA` handler validates and dispatches the path to a normal scan-start.
- **D-05:** Mutex scope = `Local\FileTree.SingleInstance.v1` — per-user, per-session. Global\\ scope is rejected (would block Fast User Switching / RDP second user from running their own copy). The `.v1` suffix lets a future incompatible single-instance protocol coexist by bumping the suffix.
- **D-06:** WM_COPYDATA payload trust = validate, don't pass through. The receiver:
  1. Bounds-checks `cbData` against a hard ceiling (≤ 64 KB — paths are < MAX_PATH×2 normally, this is just DoS sanity).
  2. Treats the payload as a UTF-16 string (`dwData == FILETREE_PATH_MSG_ID = 0x46540001`); rejects any other `dwData`.
  3. Canonicalizes via `GetFullPathNameW`; requires the result to be absolute and to exist as a directory (`GetFileAttributesW` + `FILE_ATTRIBUTE_DIRECTORY`).
  4. Silently drops the payload (just focus, no scan) if validation fails. Don't surface an error dialog — this is a normal "user ran the .exe with a stale path" case.

### Claude's Discretion

User opted not to discuss these; defaults below. Planner / researcher may revisit if a default proves unworkable.

- **Path bar autocomplete implementation (POL-01).** Default to Shell's `IAutoComplete2` wired up via `SHAutoComplete(hwndEdit, SHACF_FILESYS_DIRS | SHACF_AUTOSUGGEST_FORCE_ON)`. Minimum new FFI surface, gets native Explorer-like behavior (case-insensitive prefix match, listbox dropdown, Tab completion) for free. **Drive picker** = separate `ComboBoxEx32` to the left of the edit; populated from `GetLogicalDrives` + `GetDriveTypeW` to skip empty CD/floppy slots. Selecting a drive sets the edit to `X:\` and triggers autocomplete from there. Falls back to a hand-rolled popup ONLY if `SHAutoComplete` is observed to misbehave on Windows 11 26100.
- **Keyboard shortcut routing (POL-02).** Default to a Win32 accelerator table: `LoadAcceleratorsW` once at startup, `TranslateAcceleratorW` in the main message loop pump before `DispatchMessageW`. Single table declared once; each accelerator dispatches a `WM_COMMAND` ID handled by the existing `desktop/state.rs` command router. Ctrl+F maps to `CMD_FOCUS_SEARCH` — handler is a no-op stub in Phase 2 (the search control doesn't exist until Phase 3); Phase 3 fills in the focus call. Ctrl+E maps to the existing export entry. Esc → cancel scan (only when a scan is in flight, else no-op). Del → delete selection (no-op stub in Phase 2; Phase 5 wires the cleanup pipeline).
- **Status-bar throughput cadence (POL-03).** Reuse the existing 1500 ms `WM_SCAN_PROGRESS` post from `scan_path_with_progress` — no new timer. Status bar is a `msctls_statusbar32` common control with 5 panes (files / folders / errors / elapsed / MB/s). Throughput = `bytes_so_far / elapsed_secs`, computed on each WM_SCAN_PROGRESS tick (rolling-window smoothing rejected as YAGNI for personal use; revisit if the value looks jittery in practice).
- **Settings struct location.** New module `src/settings.rs` (sibling to `model`, `io`, `scan`). Owns: `Settings` struct, `SettingsStore` (file path resolution + atomic write + load), the hand-rolled JSON reader, and the `RawJsonValue` round-trip type. The writer side delegates to existing `export::push_json_string` to stay DRY. The single-instance mutex code lives in `src/cli.rs` (it runs before window creation); WM_COPYDATA receive logic lives in `desktop/state.rs` next to the existing window proc dispatch.
- **`schema_version: 1` placement.** Top-level integer key, first field emitted. Reader treats missing as `1` (legacy upgrade path is trivial since v0.1.0 didn't persist anything); treats `> 1` as "future version, load defaults but DO NOT overwrite the file until the user changes a setting" (no data loss on accidental downgrade).
- **Atomic write recipe.** Write to `settings.json.tmp` in the same directory (ensures same-volume rename), `fsync` the temp file, `MoveFileExW(tmp, final, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`. On failure, log to stderr in debug builds, swallow in release (a failed settings save must NEVER crash the app or surface a modal — POL-03's status bar can show a transient warning if needed, but that's polish-of-the-polish).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & success criteria
- `.planning/ROADMAP.md` §"Phase 2: Settings & Polish" — five success criteria, risk callout that atomic temp+rename is mandatory (Pitfall #7), `schema_version: 1` from day one.
- `.planning/REQUIREMENTS.md` lines 16–26 — SET-01..05 and POL-01..03, including the API names already locked: `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`, named mutex, atomic temp-file + rename, debounced/immediate save (D-03 picks immediate), schema versioning.

### Project-wide constraints
- `.planning/PROJECT.md` §Constraints — zero new Rust crates (`Cargo.toml [dependencies]` stays empty), single-`.exe` distribution, Win32 raw FFI only.
- `CLAUDE.md` — codebase rules, naming conventions (`snake_case`, `push_*` builders, `*_to_*` serializers), and the GSD workflow enforcement notice.

### Prior phase context
- `.planning/phases/01-module-split/01-CONTEXT.md` — locked module layout this phase builds on (`cli`, `desktop/state.rs`, `desktop/ffi.rs` as the destinations for new code).

### Codebase intel (still valid post-Phase-1)
- `.planning/codebase/ARCHITECTURE.md` — component table; primary "where does X live today" reference. Note: line numbers were captured pre-split; use it as a topological guide, then grep the post-split files.
- `.planning/codebase/STACK.md` — confirms zero-dependency Rust 2024 posture; Win32 DLL link list (User32, Gdi32, Shell32, Comctl32, Dwmapi, Ole32, UxTheme, Kernel32) — Phase 2 adds nothing new at the DLL level.
- `.planning/codebase/CONVENTIONS.md` — naming patterns that apply to the new `settings` module and the WM_COPYDATA handler.

### Code touch-points (post-split)
- `src/export.rs` — `push_json_string` writer pattern that the new settings writer reuses; reference for escape handling that the new reader must round-trip exactly.
- `src/desktop/state.rs` — `DesktopState`, `STATE: OnceLock<Mutex<DesktopState>>`, `with_state_mut`. Settings load on startup feeds initial `DesktopState`; every mutation site here calls the new save helper. WM_COPYDATA handler lands here.
- `src/desktop/ffi.rs` — new Win32 FFI lands here: `SHGetKnownFolderPath` + `FOLDERID_RoamingAppData`, `CreateMutexW` / `OpenMutexW` + `ERROR_ALREADY_EXISTS`, `FindWindowW`, `SendMessageW` + `WM_COPYDATA` + `COPYDATASTRUCT`, `SetForegroundWindow` / `AllowSetForegroundWindow`, `IAutoComplete2` vtable + `SHAutoComplete` + `SHACF_*`, `LoadAcceleratorsW` / `TranslateAcceleratorW` / `ACCEL` struct, `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING` + `MOVEFILE_WRITE_THROUGH`, status-bar common-control APIs (`SB_SETPARTS`, `SB_SETTEXTW`).
- `src/cli.rs` — single-instance mutex check happens here, before `run_desktop()` enters the window loop.
- `src/scan.rs` — existing `WM_SCAN_PROGRESS` post point; POL-03 status bar consumes it unchanged.

### Anti-pattern reference
- ROADMAP.md "Risk callouts" for Phase 2 cites Pitfall #7 (half-written settings.json from a crash or concurrent write). The atomic recipe in D-03 + the named-mutex guard in D-04/D-05 are the structural mitigation pair.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/export.rs` `push_json_string(&mut String, &str)` — handles JSON string escape rules. The new settings *writer* calls this directly. The new *reader* must accept everything this writer can produce (round-trip property).
- `src/desktop/state.rs` `STATE: OnceLock<Mutex<DesktopState>>` + `with_state_mut(|s| ...)` — every settings mutation already funnels through this for thread safety; D-03's "save on every change" piggybacks on `with_state_mut` by calling the save helper inside the closure return.
- `src/scan.rs` `WM_SCAN_PROGRESS` tick (1500 ms cadence with `bytes_so_far`, `files`, `folders`, `errors`, `elapsed_ms`) — POL-03 status bar consumes these payload fields directly; nothing new on the scan side.
- Existing dark-mode toggle path through `DARK_MODE_ATOMIC` — settings load just sets this atomic from the persisted bool before window creation, no special migration logic needed.

### Established Patterns
- **`snake_case` everywhere, `PascalCase` for types, `push_*` for builders, `*_to_*` for serializers, `is_*`/`has_*`/`should_*` for predicates** (CONVENTIONS.md). The new `settings` module follows this — e.g. `push_settings_json`, `parse_settings_json`, `is_known_settings_key`.
- **Win32 constants as `UPPER_SNAKE_CASE` matching the Win32 name** — `WM_COPYDATA`, `MOVEFILE_WRITE_THROUGH`, `SHACF_FILESYS_DIRS`, `FOLDERID_RoamingAppData`. Don't anglicize.
- **`unsafe extern "system"` FFI declarations live in `desktop/ffi.rs`** (post-Phase-1 layout). Call sites stay in the module that needs the API; the FFI block is declaration-only.
- **`io::Result<T>` propagation up to entry points; `.expect("... lock poisoned")` on Mutex locks** (mutex poisoning is treated as unrecoverable).
- **Builder functions take `&mut String` first** (`push_*` pattern). Settings serialize follows: `push_settings_json(&mut out, &settings)`.

### Integration Points
- `cli.rs::run_desktop` (or `run()` dispatch) — first call must be the mutex acquire. On `ERROR_ALREADY_EXISTS`, forward the path arg via WM_COPYDATA and exit; otherwise proceed.
- `cli.rs::run_server` and `cli.rs::run_scan_command` — single-instance guard does NOT apply to these (multiple `serve` instances on different ports are legitimate, and CLI scans should compose freely in scripts). Mutex acquire is desktop-only.
- `desktop/mod.rs::window_proc` dispatch hub — new `WM_COPYDATA` arm routes to the WM_COPYDATA handler in `desktop/state.rs`. New `WM_TIMER` arm is NOT needed (no debounce). New `WM_LBUTTONUP` / `WM_EXITSIZEMOVE` arms route to the drag-coalesce flush from D-03's mitigation.
- Settings load happens once in `cli.rs` before `desktop::run()` and is passed in as the initial `DesktopState` snapshot — avoids load-then-mutate race on first launch.
- The 5-pane status bar (`msctls_statusbar32`) lives at the bottom of the main window and reflows on WM_SIZE; reuse the existing reflow plumbing in `desktop/paint.rs` rather than introducing a separate layout pass.

</code_context>

<specifics>
## Specific Ideas

- The named mutex name MUST embed a version suffix (`Local\FileTree.SingleInstance.v1`) so that a hypothetical Phase-7-or-later protocol change can bump to `.v2` and silently coexist with an older running build during update.
- The WM_COPYDATA `dwData` discriminator should be a magic 32-bit constant (`0x46540001` = "FT" + msg id 1) so future message types over WM_COPYDATA can coexist (e.g. snapshot-open). Reject any unknown `dwData` silently.
- Drag-coalesce flush (D-03 mitigation) only applies to events that produce a continuous stream of mutations. Discrete toggles (dark mode, hidden files, symlink follow) write immediately — there is no drag to coalesce.
- Status-bar throughput pane shows `--` (en-dash) when no scan is in flight, not stale numbers from the last scan. Avoids the "is it actually running?" ambiguity.
- POL-02 keyboard shortcuts must NOT consume the keystroke when an edit control has focus AND the shortcut would conflict with the edit's own binding — e.g. Ctrl+F in a future find-in-edit context. The accelerator table handles this correctly when the dispatch ID is wired to a command handler that checks focus before acting; document this in the handler comments.

</specifics>

<deferred>
## Deferred Ideas

- **Saved filter views, bookmarks, snapshot index** — these all persist via SET-01 per ROADMAP.md (Phases 3, 7). Phase 2 only ships the schema slots for SET-05's named fields; the unknown-keys round-trip in D-02 means future phases can add their keys without re-touching the parser.
- **Coalesced/debounced save** — explicitly rejected in D-03 (user picked immediate). Drag-end flush is the only batching. Revisit only if real-world profiling shows disk pressure.
- **Custom autocomplete dropdown** — only land it if `SHAutoComplete` is observed to misbehave on Windows 11 26100.
- **Settings UI / Preferences dialog** — out of scope. Settings change via existing widgets (toggles in toolbar, column drag, window resize); no dedicated dialog this phase. Could be a polish task post-v1.
- **Rolling-window throughput smoothing** — YAGNI for now; revisit if the value looks jittery in practice.
- **Telemetry of any kind** — explicitly out per PROJECT.md.

</deferred>

---

*Phase: 2-settings-polish*
*Context gathered: 2026-05-23*
