---
phase: 01-module-split
plan: 01
subsystem: src
tags: [refactor, modules, rust, brownfield]
dependency_graph:
  requires: []
  provides: [model.rs, io.rs, scan.rs, analytics.rs, export.rs, server.rs, cli.rs, diff.rs]
  affects: [src/main.rs]
tech_stack:
  added: []
  patterns: [bottom-up module extraction, pub(crate) visibility, test colocation]
key_files:
  created:
    - src/model.rs
    - src/io.rs
    - src/scan.rs
    - src/analytics.rs
    - src/export.rs
    - src/server.rs
    - src/cli.rs
    - src/diff.rs
  modified:
    - src/main.rs
decisions:
  - "Keep std imports in main.rs that mod desktop needs via use super::* (PathBuf, fs, HashMap, Arc, AtomicBool, Ordering, thread, Command)"
  - "Re-export APP_NAME/APP_VERSION from main.rs via pub(crate) use crate::cli::{APP_NAME, APP_VERSION} so desktop submodule can access them"
  - "analytics.rs uses crate::export::{push_json_string, push_id_array} after export extraction (forward-dep resolved in commit 5)"
  - "main.rs ends up ~27 non-desktop lines instead of ~15 due to desktop module's use super::* scope requirement"
metrics:
  duration: ~5.5 hours
  completed: "2026-05-23"
  tasks_completed: 8
  tasks_total: 8
  files_created: 8
  files_modified: 1
---

# Phase 01 Plan 01: Module Split Summary

**One-liner:** Extracted 8 top-level Rust modules (model, io, scan, analytics, export, server, cli, diff) from a 5055-line monolith src/main.rs in bottom-up dependency order, one green-build commit per module.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Extract model.rs | 4f5395e | src/model.rs (new), src/main.rs |
| 2 | Extract io.rs | 9aa43a2 | src/io.rs (new), src/main.rs |
| 3 | Extract scan.rs | 16ee24a | src/scan.rs (new), src/main.rs |
| 4 | Extract analytics.rs | b966894 | src/analytics.rs (new), src/main.rs |
| 5 | Extract export.rs | 93099fe | src/export.rs (new), src/analytics.rs, src/main.rs |
| 6 | Extract server.rs | c0ccc92 | src/server.rs (new), src/main.rs |
| 7 | Extract cli.rs | 6b9c25e | src/cli.rs (new), src/main.rs |
| 8 | Add diff.rs placeholder | efca399 | src/diff.rs (new), src/main.rs |

## Verification

All 9 tests pass after each commit:
- `io::tests::wildcard_supports_star_and_question`
- `io::tests::epoch_formats_unix_start`
- `scan::tests::aggregate_nodes_sums_children_into_parent`
- `scan::tests::snapshot_result_has_correct_aggregation`
- `scan::tests::snapshot_releases_nodes_lock_before_aggregation`
- `scan::tests::active_guard_decrements_active_and_sets_done_when_empty`
- `scan::tests::active_guard_does_not_set_done_when_dirs_remain`
- `scan::tests::scan_path_with_progress_sends_partial_results`
- `export::tests::csv_fields_are_escaped`

Full CI quad (cargo build + cargo fmt --check + cargo clippy --all-targets -- -D warnings + cargo test) passes on every commit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Pre-existing clippy::unnecessary_sort_by in analytics functions**
- **Found during:** Task 4 (analytics extraction)
- **Issue:** Two sort calls in extension_stats and duplicate_candidates used `.sort_by(|left, right| right.x.cmp(&left.x))` which clippy flags as `unnecessary_sort_by`
- **Fix:** Changed to `.sort_by_key(|stat| std::cmp::Reverse(stat.bytes))` and `.sort_by_key(|candidate| std::cmp::Reverse(candidate.waste))`
- **Files modified:** src/analytics.rs
- **Commit:** b966894 (bundled with analytics extraction)

**2. [Rule 3 - Blocking] Orphaned scan test code left in main.rs after Task 3**
- **Found during:** Task 3 cleanup
- **Issue:** A botched edit left dummy stub functions and all scan test functions as orphaned top-level code after the mod tests closing brace in main.rs
- **Fix:** Deleted the orphaned code (dummy stubs + test functions), keeping only csv_fields_are_escaped in mod tests
- **Files modified:** src/main.rs
- **Commit:** 16ee24a

**3. [Rule 1 - Bug] std::io namespace collision with mod io**
- **Found during:** Task 2 (io extraction)
- **Issue:** `mod io;` shadows `std::io` when both are declared; `use std::io::{self, ...}` fails because `io` name is already bound
- **Fix:** Used `use std::io::{self as sio, ...}` alias throughout main.rs; added explicit `use std::io;` inside mod desktop block since `use super::*` doesn't propagate the alias
- **Files modified:** src/main.rs, src/scan.rs, src/server.rs, src/cli.rs

**4. [Rule 1 - Bug] main.rs line count exceeds 15-line plan estimate**
- **Found during:** Task 7 (cli extraction)
- **Issue:** The `mod desktop` block uses `use super::*` to import types from the parent module scope. After extracting all CLI code, the desktop module still requires PathBuf, fs, HashMap, BTreeSet, Arc, AtomicBool, Ordering, Command, thread, and various crate:: items to be in main.rs scope. These cannot be removed without modifying the desktop module (which is Plan 02's scope).
- **Fix:** Kept all necessary `use` imports in main.rs for the desktop module's benefit; re-exported APP_NAME/APP_VERSION via `pub(crate) use crate::cli::{APP_NAME, APP_VERSION}`. Result: 27 non-desktop lines instead of ~15.
- **Files modified:** src/main.rs

## Known Stubs

None. This is a pure extraction refactor; no stubs were introduced.

## Threat Flags

None. No new network endpoints, auth paths, or trust boundary changes introduced. This is a pure code organization refactor.

## Self-Check: PASSED

Files created:
- src/model.rs: FOUND
- src/io.rs: FOUND
- src/scan.rs: FOUND
- src/analytics.rs: FOUND
- src/export.rs: FOUND
- src/server.rs: FOUND
- src/cli.rs: FOUND
- src/diff.rs: FOUND

Commits verified in git log:
- 4f5395e: FOUND
- 9aa43a2: FOUND
- 16ee24a: FOUND
- b966894: FOUND
- 93099fe: FOUND
- c0ccc92: FOUND
- 6b9c25e: FOUND
- efca399: FOUND
