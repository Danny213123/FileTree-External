---
phase: 02-settings-polish
plan: 02
subsystem: single-instance-guard
tags: [single-instance, wm-copydata, win32-ffi, ipc, mutex, path-validation]

# Dependency graph
requires:
  - phase: 02-settings-polish
    plan: 01
    provides: src/desktop/ffi.rs base FFI structure, src/io.rs wide() helper, src/desktop/mod.rs base window proc
provides:
  - Single-instance guard via Local\FileTree.SingleInstance.v1 named mutex (SET-04)
  - WM_COPYDATA path-forward IPC: second instance forwards CLI --path to primary and exits 0
  - try_forward_or_acquire() pub(crate) function in src/desktop/ffi.rs
  - handle_copy_data() pub(crate) function in src/desktop/state.rs (full D-06 validation pipeline)
  - canonicalize_and_check_dir() pub(crate) in src/desktop/shell.rs (GetFullPathNameW + GetFileAttributesW)
  - WM_COPYDATA arm in window_proc dispatching to handle_copy_data
  - Integration test in tests/single_instance.rs (two tests, both green on Windows)
affects: [settings-ui-wiring, single-instance-guard]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-instance guard: CreateMutexW(Local\\FileTree.SingleInstance.v1); on ERROR_ALREADY_EXISTS forward path via WM_COPYDATA then exit 0"
    - "WM_COPYDATA memcpy-out discipline: all lpData reads before any function call (Pitfall #2)"
    - "D-06 validation chain: magic discriminator 0x46540001 + 64KB cap + even byte count + GetFullPathNameW + GetFileAttributesW"
    - "AllowSetForegroundWindow(pid) + SendMessageW implicit grant + SetForegroundWindow belt-and-suspenders (Pitfall #9)"
    - "try_lock() reentrancy discipline: path_edit HWND extracted inside state lock, Win32 calls outside"

key-files:
  created:
    - tests/single_instance.rs
  modified:
    - src/desktop/ffi.rs
    - src/desktop/state.rs
    - src/desktop/shell.rs
    - src/desktop/mod.rs
    - src/cli.rs

key-decisions:
  - "Mutex name Local\\FileTree.SingleInstance.v1: per-user per-session scope; .v1 suffix allows future protocol versioning without conflict"
  - "WM_COPYDATA magic 0x46540001 (FT + msg-id 1): future message types can coexist by using different dwData values"
  - "try_forward_or_acquire returns Ok(handle) for primary; never returns for second instance (calls exit 0 internally)"
  - "handle_copy_data is a safe fn with internal unsafe blocks — caller (window_proc) is already unsafe"
  - "start_scan_from_controls promoted to pub(super) so state.rs can dispatch to it from handle_copy_data"

requirements-completed: [SET-04]

# Metrics
duration: 25min
completed: 2026-05-23
---

# Phase 02 Plan 02: Single-Instance Guard + WM_COPYDATA Path-Forward Summary

**Named-mutex single-instance guard with WM_COPYDATA path-forward IPC: second `filetree desktop` launch focuses the primary window, forwards the --path argument for scan, and exits 0; invalid payloads silently dropped with validation per D-06**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-05-23
- **Tasks:** 2 of 2
- **Files modified:** 5 (1 created, 5 modified)
- **Tests added:** 7 (2 FFI layout/constant tests, 3 shell canonicalization tests, 2 integration tests)

## Accomplishments

- Added 25 new FFI declarations and constants to `src/desktop/ffi.rs`: `CreateMutexW`, `OpenMutexW`, `CloseHandle`, `GetLastError`, `GetFullPathNameW`, `GetFileAttributesW` (Kernel32); `FindWindowW`, `GetWindowThreadProcessId`, `AllowSetForegroundWindow`, `SetForegroundWindow` (User32); plus `WM_COPYDATA`, `ERROR_ALREADY_EXISTS`, `FILETREE_PATH_MSG_ID` (0x46540001), `MAX_COPYDATA_BYTES` (65536), `INVALID_FILE_ATTRIBUTES`, `SYNCHRONIZE` constants
- Added `CopyDataStruct` repr(C) struct with inline Pitfall #2 lifetime documentation
- Implemented `try_forward_or_acquire()` — primary returns Ok(mutex_handle); second instance does AllowSetForegroundWindow + SendMessageW(WM_COPYDATA) + SetForegroundWindow + exit 0
- Wired mutex acquire in `src/cli.rs::run_desktop` via `#[cfg(windows)]` block before `desktop::run()` — serve and scan subcommands unaffected
- Implemented `handle_copy_data()` in `src/desktop/state.rs` with full D-06 validation: magic discriminator check, 64KB size cap, UTF-16 alignment check, memcpy-out before any function call, `canonicalize_and_check_dir` validation, SetWindowTextW + start_scan_from_controls dispatch
- Implemented `canonicalize_and_check_dir()` in `src/desktop/shell.rs` using two-call GetFullPathNameW pattern (query length, fill buffer) followed by GetFileAttributesW directory check
- Added `WM_COPYDATA => handle_copy_data(hwnd, lparam)` arm to `window_proc` in `src/desktop/mod.rs`
- Created `tests/single_instance.rs` with two integration tests that spawn the actual binary twice — both pass on Windows in < 2.5 seconds total

## Task Commits

1. **Task 1: Extend desktop/ffi.rs with single-instance + WM_COPYDATA + path-validation FFI surface** - `ca0aaab` (feat)
2. **Task 2: Wire mutex acquire in cli.rs, WM_COPYDATA handler in state.rs/shell.rs/mod.rs, integration test** - `df45f2b` (feat)

## Files Created/Modified

- `src/desktop/ffi.rs` (modified, +162 lines) — new FFI decls, constants, `CopyDataStruct`, `try_forward_or_acquire()`, 2 layout/constant tests
- `src/desktop/state.rs` (modified, +75 lines) — updated imports, `handle_copy_data()` with full D-06 validation pipeline
- `src/desktop/shell.rs` (modified, +95 lines) — updated imports, `canonicalize_and_check_dir()`, 3 unit tests
- `src/desktop/mod.rs` (modified, +3 lines) — `WM_COPYDATA` arm, `pub(super)` on `start_scan_from_controls`, `handle_copy_data` in use statement
- `src/cli.rs` (modified, +15 lines) — mutex acquire before `desktop::run()` with error mapping
- `tests/single_instance.rs` (created, 90 lines) — 2 integration tests with process spawn + timeout assertion

## FFI Surface Added (desktop/ffi.rs)

| Symbol | DLL | Visibility | Purpose |
|--------|-----|-----------|---------|
| `CreateMutexW` | Kernel32 | pub(super) | Named mutex creation |
| `OpenMutexW` | Kernel32 | pub(super) | Probe for existing mutex |
| `CloseHandle` | Kernel32 | pub(super) | Release mutex (second instance) |
| `GetLastError` | Kernel32 | pub(super) | Detect ERROR_ALREADY_EXISTS |
| `GetFullPathNameW` | Kernel32 | pub(super) | Path canonicalization (D-06.3) |
| `GetFileAttributesW` | Kernel32 | pub(super) | Directory existence check (D-06.3) |
| `FindWindowW` | User32 | pub(super) | Locate primary window by class |
| `GetWindowThreadProcessId` | User32 | pub(super) | Get primary PID for foreground rights |
| `AllowSetForegroundWindow` | User32 | pub(super) | Grant foreground rights (Pitfall #9) |
| `SetForegroundWindow` | User32 | pub(super) | Pop primary window to front |
| `WM_COPYDATA` | — | pub(super) const | 0x004A |
| `ERROR_ALREADY_EXISTS` | — | pub(super) const | 183 |
| `FILETREE_PATH_MSG_ID` | — | pub(crate) const | 0x46540001 |
| `MAX_COPYDATA_BYTES` | — | pub(crate) const | 65536 (64 KB) |
| `INVALID_FILE_ATTRIBUTES` | — | pub(super) const | 0xFFFFFFFF |
| `SYNCHRONIZE` | — | pub(super) const | 0x00100000 |
| `CopyDataStruct` | — | pub(crate) struct | Win32 COPYDATASTRUCT layout |
| `try_forward_or_acquire()` | Kernel32+User32 | pub(crate) fn | Single-instance acquire / second-instance forward |

## WM_COPYDATA Validation Steps (D-06)

In order, in `handle_copy_data()`:

1. `lparam == 0` check — null COPYDATASTRUCT pointer rejected (no-op return 0)
2. Memcpy all COPYDATASTRUCT fields out to local variables BEFORE any function call (Pitfall #2 — lpData lifetime)
3. `dwData != FILETREE_PATH_MSG_ID` — wrong magic rejected (return 0)
4. `cbData == 0 || cbData > MAX_COPYDATA_BYTES` — DoS size cap: 64 KB ceiling (D-06.1)
5. `cbData % 2 != 0` — odd byte count rejected (must be UTF-16 pairs)
6. `ptr::copy_nonoverlapping` into local `Vec<u16>` — lpData never accessed again after this point
7. `canonicalize_and_check_dir()`: GetFullPathNameW → must return non-zero, non-truncated; GetFileAttributesW → must not be INVALID_FILE_ATTRIBUTES, must have FILE_ATTRIBUTE_DIRECTORY bit set (D-06.3)
8. On validation failure: silent drop — no scan started, no error dialog; SetForegroundWindow still called (D-06.4)

## Integration Test Summary

| Test | What | Expected | Result |
|------|------|----------|--------|
| `second_instance_exits_quickly` | Spawn primary, spawn second, check exit status + timing | exit 0, elapsed < 2s | PASS (~2.5s total for both) |
| `second_instance_with_invalid_path_still_exits_zero` | Spawn primary, spawn second with Z:\\NoSuchPath..., check exit | exit 0, elapsed < 2s | PASS |

Both tests use `env!("CARGO_BIN_EXE_filetree")` for binary location, spawn the primary with 500ms settle time, and kill the primary in cleanup.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed CopyDataStruct layout test assertion**
- **Found during:** Task 1 (cargo test run)
- **Issue:** Test assertion `size_of::<UlongPtr>() + size_of::<u32>() + size_of::<usize>()` = 8+4+8 = 20, but actual struct size on x86_64 is 24 (natural alignment adds 4-byte pad between cbData and lpData)
- **Fix:** Rewrote test to assert `size_of::<CopyDataStruct>() == 24` (x86_64) with `#[cfg(target_pointer_width)]` gates for portability; added separate `offset_of!` assertions for each field
- **Files modified:** src/desktop/ffi.rs
- **Verification:** Test passes; struct layout matches Win32 COPYDATASTRUCT

**2. [Rule 3 - Blocking] Promoted start_scan_from_controls to pub(super)**
- **Found during:** Task 2 (compiler error E0603)
- **Issue:** `handle_copy_data` in `state.rs` calls `super::start_scan_from_controls(hwnd)`, but the function was private (`unsafe fn`) — inaccessible from `state.rs` (a submodule of `desktop`)
- **Fix:** Changed `unsafe fn start_scan_from_controls` to `pub(super) unsafe fn start_scan_from_controls` in `mod.rs`
- **Files modified:** src/desktop/mod.rs
- **Verification:** Compiler error resolved; cargo build succeeds

**3. [Rule 1 - Bug] Added unsafe block around start_scan_from_controls call in handle_copy_data**
- **Found during:** Task 2 (clippy E0133 error)
- **Issue:** `handle_copy_data` is a safe fn but calls `super::start_scan_from_controls(hwnd)` which is `unsafe fn` — requires an `unsafe` block
- **Fix:** Wrapped the call in `unsafe { super::start_scan_from_controls(hwnd) }` with SAFETY comment
- **Files modified:** src/desktop/state.rs
- **Verification:** cargo clippy --all-targets -- -D warnings clean

**4. [Rule 3 - Blocking] Fixed cargo fmt formatting differences**
- **Found during:** Task 2 (cargo fmt --check)
- **Issue:** Line-length formatting in cli.rs, shell.rs, state.rs, and tests/single_instance.rs differed from rustfmt style
- **Fix:** Ran `cargo fmt` to auto-apply canonical formatting
- **Files modified:** src/cli.rs, src/desktop/shell.rs, src/desktop/state.rs, tests/single_instance.rs

**Total deviations:** 4 auto-fixed (1 logic bug in test, 2 compile errors, 1 formatting). No architectural changes needed.

## Threat Mitigations Applied

| Threat ID | Status |
|-----------|--------|
| T-02-07 (Spoofing — wrong dwData) | Mitigated: FILETREE_PATH_MSG_ID check in handle_copy_data step 3 |
| T-02-08 (Tampering — oversized cbData) | Mitigated: MAX_COPYDATA_BYTES=65536 cap + even-byte check in steps 4-5 |
| T-02-09 (Tampering — path injection) | Mitigated: GetFullPathNameW canonicalization + GetFileAttributesW directory check in step 7 |
| T-02-11 (DoS — UAF on lpData) | Mitigated: ptr::copy_nonoverlapping before any function call in step 6 |

## Known Stubs

None — all functionality is fully wired. The single-instance guard is active for every `desktop`/`gui` invocation.

## Threat Flags

No new network endpoints, auth paths, or schema changes introduced. `handle_copy_data` validates all incoming data from the desktop session before acting. No new attack surface beyond what the plan's threat model already analyzed.

## Self-Check

Checking created/modified files exist and commits are present:
- `src/desktop/ffi.rs`: FOUND
- `src/desktop/state.rs`: FOUND
- `src/desktop/shell.rs`: FOUND
- `src/desktop/mod.rs`: FOUND
- `src/cli.rs`: FOUND
- `tests/single_instance.rs`: FOUND
- Commit ca0aaab (Task 1): FOUND
- Commit df45f2b (Task 2): FOUND

## Self-Check: PASSED

---
*Phase: 02-settings-polish*
*Completed: 2026-05-23*
