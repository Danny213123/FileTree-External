---
phase: 02-settings-polish
plan: 01
subsystem: settings
tags: [json-parser, atomic-write, win32-ffi, settings, persistence, utf-16]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: src/desktop/ffi.rs base FFI structure, src/io.rs helpers, src/export.rs push_json_string
provides:
  - Hand-rolled JSON parser and writer for settings persistence (src/settings.rs)
  - Settings struct covering all SET-05 fields with round-trip fidelity
  - SettingsStore with atomic temp+rename write recipe (NTFS-safe)
  - pub(crate) wide() UTF-16 helper in src/io.rs (cross-module accessible)
  - FFI scaffolding for SHGetKnownFolderPath, MoveFileExW, FlushFileBuffers, GetDpiForWindow
  - FOLDERID_RoamingAppData GUID constant and known_folder_roaming_appdata() safe wrapper
affects: [02-02, 02-03, 02-04, settings-ui-wiring, single-instance-guard]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Atomic rename write: write to .tmp, sync_all(), MoveFileExW(MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)"
    - "Forward-compatible JSON: BTreeMap<String, RawJsonValue> unknown fields preserved on round-trip"
    - "Depth-guarded recursive descent: depth counter capped at 64 to prevent stack overflow on adversarial input"
    - "Surrogate-pair decoding: UTF-16 surrogate pairs (0xD800..0xDBFF + 0xDC00..0xDFFF) decoded per spec"
    - "pub(crate) FFI wrapper: safe Rust wrapper in desktop/ffi.rs keeps raw unsafe FFI private to desktop module"

key-files:
  created:
    - src/settings.rs
  modified:
    - src/io.rs
    - src/desktop/ffi.rs
    - src/desktop/mod.rs
    - src/desktop/paint.rs
    - src/desktop/shell.rs
    - src/desktop/theme.rs
    - src/main.rs

key-decisions:
  - "D-01: Settings persisted as hand-rolled JSON (no serde, zero new deps); writer reuses export::push_json_string for escape handling"
  - "D-02: Unknown top-level and nested JSON keys preserved via BTreeMap<String, RawJsonValue> for forward compatibility"
  - "D-03: Atomic write uses temp-file + MoveFileExW REPLACE_EXISTING|WRITE_THROUGH rename pattern; no FlushFileBuffers needed because sync_all() is sufficient"
  - "wide() relocated from desktop/mod.rs to io.rs; called via fully-qualified crate::io::wide() to keep cross-module boundary visible"
  - "pub(crate) atomic_rename() wrapper in desktop/ffi.rs isolates unsafe MoveFileExW call from settings.rs"

patterns-established:
  - "Pattern: atomic_write_settings(final_path, body) — write .tmp, sync_all(), MoveFileExW rename; on failure clean up .tmp"
  - "Pattern: load_or_default() — parse error renames broken file to settings.json.broken-<unix_ts>, returns Settings::default()"
  - "Pattern: push_raw_json_value() sibling helper emits RawJsonValue variants using push_json_string for strings"

requirements-completed: [SET-01, SET-02, SET-03, SET-05]

# Metrics
duration: 45min
completed: 2026-05-23
---

# Phase 02 Plan 01: Settings Persistence Layer Summary

**Hand-rolled JSON settings parser and writer with atomic-rename durability, APPDATA path resolution via SHGetKnownFolderPath, and full round-trip fidelity for unknown keys and UTF-16 surrogate pairs**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-05-23
- **Tasks:** 2 of 2
- **Files modified:** 8 (1 created, 7 modified)
- **Lines added net:** +1130 insertions, -36 deletions (git diff from plan start)

## Accomplishments

- Created `src/settings.rs` (990 lines) with fully-tested JSON parser, writer, `Settings` struct, `SettingsStore` with atomic write, and 12 unit tests covering all plan-specified behaviors
- Relocated `wide()` UTF-16 helper from `desktop/mod.rs` to `src/io.rs` as `pub(crate)` under `#[cfg(windows)]`; updated all 7 call sites across mod.rs, paint.rs, shell.rs, theme.rs to use `crate::io::wide(...)`
- Added Win32 FFI scaffolding to `desktop/ffi.rs`: `MoveFileExW`, `FlushFileBuffers`, `GetDpiForWindow`, `SHGetKnownFolderPath` declarations; `MOVEFILE_REPLACE_EXISTING`, `MOVEFILE_WRITE_THROUGH`, `FOLDERID_RoamingAppData` constants; `known_folder_roaming_appdata()` and `atomic_rename()` pub(crate) safe wrappers
- All 24 tests pass (12 pre-existing + 12 new settings tests); full CI quad clean: fmt, clippy -D warnings, build, test

## Task Commits

Each task was committed atomically:

1. **Task 1: Relocate wide() helper to src/io.rs and add baseline FFI/constants in desktop/ffi.rs** - `5b81466` (feat)
2. **Task 2: Implement src/settings.rs (Settings, RawJsonValue, parser, writer, SettingsStore, atomic write, tests)** - `abb80b1` (feat)

**Plan metadata:** _(this commit)_ (docs: complete settings-persistence-layer plan)

## Files Created/Modified

- `src/settings.rs` (created, 990 lines) — `Settings`, `WindowGeometry`, `RawJsonValue`, `ParseError`, `SettingsStore`; `parse_settings_json`, `push_settings_json`, `push_raw_json_value`, `atomic_write_settings`; 12 unit tests
- `src/io.rs` (modified, +34 lines) — added `pub(crate) fn wide(value: &str) -> Vec<u16>` under `#[cfg(windows)]` with 3 new tests
- `src/desktop/ffi.rs` (modified, +74 lines) — added FFI decls and pub(crate) wrappers (see FFI Surface section below)
- `src/desktop/mod.rs` (modified, net -14 lines) — removed `fn wide()`, removed 2 imports, changed `mod ffi;` to `pub(crate) mod ffi;`, updated all `wide(...)` calls to `crate::io::wide(...)`
- `src/desktop/paint.rs` (modified, 2 call sites updated)
- `src/desktop/shell.rs` (modified, 9 call sites updated)
- `src/desktop/theme.rs` (modified, 2 call sites updated)
- `src/main.rs` (modified, +2 lines) — added `#[cfg(windows)] mod settings;` declaration

## FFI Surface Added (desktop/ffi.rs)

| Symbol | DLL | Visibility | Purpose |
|--------|-----|-----------|---------|
| `MoveFileExW` | Kernel32 | pub(super) | Atomic NTFS rename |
| `FlushFileBuffers` | Kernel32 | pub(super) | Flush file buffers (declared for completeness; sync_all() used instead) |
| `GetDpiForWindow` | User32 | pub(super) | DPI query for Win10 1607+ (used by plans 02-04) |
| `SHGetKnownFolderPath` | Shell32 | pub(super) | Resolve APPDATA path |
| `MOVEFILE_REPLACE_EXISTING` | — | pub(super) const | 0x0000_0001 |
| `MOVEFILE_WRITE_THROUGH` | — | pub(super) const | 0x0000_0008 |
| `FOLDERID_RoamingAppData` | — | pub(super) const GUID | {3EB685DB-65F9-4CF6-A03A-E3EF65729F3D} |
| `known_folder_roaming_appdata()` | Shell32+Ole32 | pub(crate) fn | Safe wrapper returning `io::Result<PathBuf>` |
| `atomic_rename()` | Kernel32 | pub(crate) fn | Safe wrapper around MoveFileExW with REPLACE|WRITE_THROUGH flags |

## Decisions Made

- `wide()` relocated to `src/io.rs` (not a new module): keeps zero-module-count discipline; settings.rs and any future non-desktop module can call `crate::io::wide(...)` without touching the desktop module
- `pub(crate) mod ffi;` instead of `pub(super) mod ffi;` in desktop/mod.rs: required so settings.rs (a sibling of desktop, not a child) can access the pub(crate) wrappers
- `atomic_rename()` pub(crate) wrapper pattern: keeps raw `MoveFileExW` FFI declaration private (`pub(super)`) inside the desktop module; settings.rs calls the safe wrapper instead of re-declaring FFI
- `#![allow(dead_code)]` at top of settings.rs: nothing in the Phase 02-01 binary consumes settings yet; later plans (02-02+) will wire it to DesktopState and remove the allow
- `SettingsStore::default()` named `default` per plan spec (not implementing `Default` trait) since it returns `io::Result<Self>`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Changed mod ffi from pub(super) to pub(crate) in desktop/mod.rs**
- **Found during:** Task 2 (settings.rs compilation)
- **Issue:** `settings.rs` uses `crate::desktop::ffi::known_folder_roaming_appdata()` but `mod ffi;` was `pub(super)` (private to desktop), causing E0603 compiler error
- **Fix:** Changed `mod ffi;` to `pub(crate) mod ffi;` in `src/desktop/mod.rs`
- **Files modified:** src/desktop/mod.rs
- **Verification:** Compiler error resolved; cargo build succeeds
- **Committed in:** abb80b1 (Task 2 commit)

**2. [Rule 1 - Bug] Added pub(crate) atomic_rename() wrapper to avoid re-declaring FFI in settings.rs**
- **Found during:** Task 2 (settings.rs atomic write implementation)
- **Issue:** `MOVEFILE_REPLACE_EXISTING`, `MOVEFILE_WRITE_THROUGH`, and `MoveFileExW` were `pub(super)` — inaccessible from settings.rs. Plan's action prose said "call crate::desktop::ffi::MoveFileExW via pub(crate) wrappers" but no wrapper existed yet
- **Fix:** Added `pub(crate) fn atomic_rename(tmp_path: *const u16, final_path: *const u16) -> io::Result<()>` in ffi.rs that calls `MoveFileExW` internally; settings.rs calls `crate::desktop::ffi::atomic_rename()` instead of raw FFI
- **Files modified:** src/desktop/ffi.rs
- **Verification:** atomic_write_replaces_existing test passes; cargo clippy clean
- **Committed in:** abb80b1 (Task 2 commit)

**3. [Rule 1 - Bug] Fixed clippy lint: assert_eq!(x, true) → assert!(x) and result.is_err()**
- **Found during:** Task 2 (cargo clippy --all-targets -- -D warnings run)
- **Issue:** `assert_eq!(result.is_err(), true)` triggered `bool-assert-comparison` clippy lint; `matches!(result, Err(_))` triggered `redundant_pattern_matching` lint; both are errors under -D warnings
- **Fix:** Changed to `assert!(result.is_err())`
- **Files modified:** src/settings.rs
- **Verification:** cargo clippy clean
- **Committed in:** abb80b1 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking module visibility, 1 missing FFI wrapper, 1 clippy lint)
**Impact on plan:** All three deviations were correctness requirements. No scope creep; plan objective fully delivered.

## Issues Encountered

- Initial file edits went to the main repo instead of the worktree due to absolute path construction from the wrong CWD. Resolved by copying modified files to the worktree path and reverting the main repo with `git checkout --`. Subsequent work used worktree-relative paths exclusively.
- `cargo fmt` required after initial settings.rs write due to line-length and trailing whitespace differences. Ran `cargo fmt` to auto-fix, re-ran `cargo fmt --check` to confirm clean.

## Known Stubs

None — `src/settings.rs` is a fully functional persistence layer. `SettingsStore::default()` and `load_or_default()` are complete. The `#![allow(dead_code)]` attribute exists because nothing in the binary calls the settings API yet; that wiring lands in plans 02-02 through 02-04.

## Threat Flags

No new network endpoints, auth paths, or schema changes introduced. `src/settings.rs` writes only to `%APPDATA%\FileTree\settings.json` (per-user ACL). Threat mitigations T-02-01 through T-02-03 from the plan's threat model are implemented:
- T-02-01 (DoS via deep JSON): depth counter capped at 64 (`MAX_DEPTH = 64` constant)
- T-02-02 (surrogate pairs): `0xD800..=0xDBFF` high-surrogate detection with `0xDC00..=0xDFFF` low-surrogate peek
- T-02-03 (corrupt file): `load_or_default()` renames broken file to `settings.json.broken-<unix_ts>` and returns defaults

## Next Phase Readiness

- Plans 02-02 and 02-03 can `use crate::settings::{Settings, SettingsStore};` and call `SettingsStore::default()?` and `store.load_or_default()` immediately
- Plan 02-04 can call `store.save(&settings)` from any desktop mutation site; atomic durability is guaranteed on NTFS
- `GetDpiForWindow` FFI is declared and ready for DPI-aware path/status bar rendering in later plans
- Remove `#![allow(dead_code)]` from settings.rs once Plan 02-02 wires `SettingsStore` into `DesktopState`

---
*Phase: 02-settings-polish*
*Completed: 2026-05-23*
