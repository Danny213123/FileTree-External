# Testing Patterns

**Analysis Date:** 2026-05-22

## Test Framework

**Runner:**
- Rust's built-in test harness (`cargo test`) — no external test crate
- Tests live in `src/main.rs` in a `#[cfg(test)] mod tests { ... }` block at lines 4800–5055
- No separate test files; no integration test directory (`tests/` does not exist)

**Assertion Library:**
- Standard `assert!`, `assert_eq!` macros from `std`
- No third-party assertion libraries (e.g., no `assert_matches`, no `pretty_assertions`)

**Run Commands:**
```bash
cargo test                    # Run all tests
cargo test -- --nocapture     # Show stdout/stderr during tests
cargo test <test_name>        # Run a single test by name
```

CI runs `cargo test` on `windows-latest` via `.github/workflows/ci.yml`.

## Test File Organization

**Location:**
- Co-located in `src/main.rs` — a single `mod tests` block at the bottom of the file
- Access to private functions via `use super::*;` (no need for `pub` on anything)

**Naming:**
- Test functions use `snake_case` descriptive sentences: `wildcard_supports_star_and_question`, `aggregate_nodes_sums_children_into_parent`, `active_guard_decrements_active_and_sets_done_when_empty`

**Structure:**
```
src/
└── main.rs          # Application code + mod tests { ... } at EOF (~line 4800)
```

No `tests/` directory. No `benches/`. No `examples/`.

## Test Structure

**Suite Organization:**
```rust
#[cfg(test)]
mod tests {
    use super::*;        // access all private functions

    #[test]
    fn descriptive_test_name() {
        // arrange
        // act
        // assert with assert_eq! and a message string
    }

    fn make_test_node(id: usize, parent: Option<usize>, is_dir: bool, size: u64) -> NodeRecord {
        // shared factory helper — not a test itself
    }
}
```

**Patterns:**
- Arrange-Act-Assert structure without labels or comments in simple tests
- Complex tests use inline comments to explain each phase (e.g., `// Take the snapshot`, `// Verify that the nodes lock is not held`)
- `assert_eq!` always includes a human-readable message as the third argument in non-trivial assertions:
  ```rust
  assert_eq!(nodes[0].size, 350, "parent size should equal sum of children");
  ```
- `assert!` used for boolean conditions, also with messages where needed

## Mocking

**Framework:** None — no mocking library is used (no `mockall`, no `mockito`, no `wiremock`)

**Patterns:**
- State is constructed inline using `Arc<WorkerShared>` with direct struct initialization — the real structs are used, not fakes
- Filesystem interaction in one test (`scan_path_with_progress_sends_partial_results`) uses `std::env::temp_dir()` to create a real temporary directory, writes a real file, scans it, then cleans up manually
- No HTTP mocking — the HTTP server layer (`handle_client`) has no unit tests

**What to Mock:**
- Filesystem calls that would be slow or environment-specific should use temp dirs (as shown in the existing progress test)
- When adding tests for `handle_client`, mock the `TcpStream` by implementing `Read + Write` on an in-memory buffer

**What NOT to Mock:**
- Core logic functions (`aggregate_nodes`, `wildcard_match`, `push_json_string`, etc.) — test these directly since they are pure or near-pure

## Fixtures and Factories

**Test Data:**
```rust
fn make_test_node(id: usize, parent: Option<usize>, is_dir: bool, size: u64) -> NodeRecord {
    NodeRecord {
        id,
        parent,
        name: format!("node_{id}"),
        path: format!("/test/node_{id}"),
        is_dir,
        is_link: false,
        hidden: false,
        readonly: false,
        size,
        allocated: size,
        files: if is_dir { 0 } else { 1 },
        folders: 0,
        modified_ms: 1_000_000,
        depth: if parent.is_some() { 1 } else { 0 },
        errors: 0,
        children: Vec::new(),
        extension: String::new(),
    }
}
```

`make_test_node` is the only factory in the test suite. It is a plain function (not a macro). Tests that need a tree manually set `.children` after calling the factory:
```rust
nodes[0].children = vec![1, 2];
```

**Location:**
- Defined inside `mod tests` in `src/main.rs` — not exported

## Coverage

**Requirements:** None enforced — no coverage threshold is configured in CI or `Cargo.toml`

**View Coverage:**
```bash
# Using cargo-tarpaulin (must install first)
cargo install cargo-tarpaulin
cargo tarpaulin --out Html
```
No coverage tooling is currently configured in the project.

## Test Types

**Unit Tests:**
- All existing tests are unit tests targeting private helper functions
- Functions currently covered:
  - `wildcard_match` — pattern matching logic (`wildcard_supports_star_and_question`)
  - `push_csv_field` — CSV escaping (`csv_fields_are_escaped`)
  - `epoch_ms_to_utc` — date formatting (`epoch_formats_unix_start`)
  - `aggregate_nodes` — tree aggregation (`aggregate_nodes_sums_children_into_parent`)
  - `snapshot_scan_result` — snapshot correctness and lock release (`snapshot_result_has_correct_aggregation`, `snapshot_releases_nodes_lock_before_aggregation`)
  - `ActiveGuard` (Drop impl) — concurrency state transitions (`active_guard_decrements_active_and_sets_done_when_empty`, `active_guard_does_not_set_done_when_dirs_remain`)
  - `scan_path_with_progress` — integration smoke test with real filesystem (`scan_path_with_progress_sends_partial_results`)

**Integration Tests:**
- One test (`scan_path_with_progress_sends_partial_results`) performs a real filesystem scan of a temp directory — this is the closest thing to an integration test
- No separate `tests/` crate-level integration tests exist

**E2E Tests:**
- Not used. The browser UI (`web/app.js`) has no test suite of any kind (no Jest, no Playwright, no Cypress)

## Common Patterns

**Concurrency Testing:**
```rust
// Test that a lock is released after a function returns
assert!(
    shared.nodes.try_lock().is_ok(),
    "nodes lock should be released after snapshot_scan_result returns"
);
```

**Filesystem Testing:**
```rust
// Create a real temp dir, write a file, scan it, clean up manually
let temp_dir = std::env::temp_dir().join(format!("filetree_test_{}", now_ms()));
std::fs::create_dir_all(&temp_dir).unwrap();
let file_path = temp_dir.join("test_file.txt");
std::fs::write(&file_path, "hello world").unwrap();
// ... test ...
let _ = std::fs::remove_file(&file_path);
let _ = std::fs::remove_dir(&temp_dir);
```

**Error Testing:**
No tests currently verify error paths. To add one, pattern is:
```rust
let result = scan_path(ScanOptions { root: PathBuf::from("/nonexistent"), ... });
assert!(result.is_err());
```

## Gaps and Recommendations

**Untested areas (high priority):**
- `handle_client` HTTP routing — all API routes (`/api/scan`, `/api/delete`, `/api/export.csv`, etc.)
- `split_target` / `percent_decode` — URL parsing used in every request
- `extension_stats`, `age_stats`, `duplicate_candidates`, `top_file_ids` — analytics functions
- `push_json_string` — JSON serialization (only `push_csv_field` is tested)
- `parse_bool`, `split_patterns`, `option_value`, `has_flag` — CLI argument parsing helpers
- `should_exclude` / `pattern_matches` — exclude pattern matching beyond basic wildcard
- Browser-side JavaScript — completely untested

**Recommended additions:**
1. Add `split_target` and `percent_decode` unit tests — these are pure functions with well-defined edge cases (empty query, percent-encoded Unicode, `+` as space)
2. Add `push_json_string` tests for Unicode, control characters, and backslash escaping
3. Add `should_exclude` tests for wildcard patterns and path separator normalization
4. Add `age_stats` and `duplicate_candidates` tests using `make_test_node`
5. For JavaScript: introduce Vitest (or plain Node.js `node:test`) to cover `formatBytes`, `formatDate`, `escapeHtml`, `wildcard_match` equivalents, and `compareNodes` sorting logic

---

*Testing analysis: 2026-05-22*
