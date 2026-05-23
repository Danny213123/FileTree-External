---
phase: 1
slug: module-split
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-22
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for the brownfield Module Split refactor. The job of every gate here is to prove the move-only extraction kept v0.1.0 behavior intact, commit-by-commit.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `cargo test` (Rust built-in test runner — already in place) |
| **Config file** | none — `Cargo.toml` carries no test config; existing `#[cfg(test)] mod tests` blocks live inline in `src/main.rs:4800-5054` |
| **Quick run command** | `cargo build && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` |
| **Full suite command** | same as quick (single-crate, no integration suite) |
| **Estimated runtime** | ~30–60 s clean build, ~5–15 s incremental |

---

## Sampling Rate

- **After every task commit:** Run `cargo build && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` — this matches the CI gate at `.github/workflows/ci.yml:22` exactly. CONTEXT D-04 makes this mandatory per commit so `git bisect` lands on a green commit every time.
- **After every plan wave:** Same command (no separate full suite).
- **Before `/gsd-verify-work`:** Quick command green AND the manual smoke-test checklist below has been executed.
- **Max feedback latency:** ~60 s.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-MM-NN | each module extraction | per CONTEXT D-05 | REFAC-01 | — | move-only: existing behavior preserved | unit + build + lint | `cargo build && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` | ✅ (inline tests already in src/main.rs:4800-5054 — moved with their code per RESEARCH Q3) | ⬜ pending |
| 01-FF-smoke | final smoke task | last | REFAC-01 | — | desktop / serve / scan v0.1.0 parity | manual | see Manual-Only Verifications below | ✅ | ⬜ pending |

*Plans/task IDs will be filled in by the planner; one row per extraction commit plus one for the smoke task. Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements.*

- The 8 existing `#[cfg(test)] mod tests` cases (6 in scan, 1 in export, 2 in io per RESEARCH) redistribute into the extracted modules and continue to run via `cargo test`. No new test scaffolding, no new dependencies, no new fixtures.
- No framework install needed. Rust 2024 toolchain + `rustfmt` + `clippy` (already required by CI) cover everything.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Desktop mode launches and renders identically to v0.1.0 | REFAC-01 (Success Criterion 3) | Native Win32 window — no automated UI harness in scope; visual + interactive parity is the goal | `cargo run --release` (no args → desktop). Verify: window opens, dark/light theme correct, scan a small folder (e.g. `C:\Windows\Logs`), confirm tree populates with sizes, treemap renders in browser tab, Errors/Extensions/Top/Duplicates tabs all populate, right-click context menu invokes Shell, scan can be cancelled mid-flight. |
| `serve` mode parity with v0.1.0 | REFAC-01 (Success Criterion 3) | HTTP + browser UI; smoke is fastest via real request | `cargo run --release -- serve --port 7878` then load `http://127.0.0.1:7878`, run a scan on `C:\Windows\Logs`, confirm tree + treemap + extensions tab + exports (CSV + JSON) all work, `/api/duplicates` runs without error. |
| `scan` CLI mode JSON/CSV parity with v0.1.0 | REFAC-01 (Success Criterion 3) | Output-format parity — diff against pre-refactor baseline | Before phase: `cargo run --release -- scan C:\Windows\Logs --format json > /tmp/pre.json` (run on v0.1.0 tag or before extraction starts). After phase: same command → `/tmp/post.json`. Verify `diff` shows only volatile fields (timestamps, scan duration). Repeat for `--format csv`. |
| No new dependencies | REFAC-01 (Success Criterion 4) | Static contract check | `git diff v0.1.0..HEAD -- Cargo.toml Cargo.lock` shows no new entries under `[dependencies]` and `Cargo.lock` has no new packages beyond `filetree 0.1.0` itself. |

---

## Validation Sign-Off

- [ ] All tasks have automated verify (`cargo build && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`) — applied per commit per CONTEXT D-04.
- [ ] Sampling continuity: every commit gates on the full quick command; no 3-task gap is possible because each task IS a commit.
- [ ] Wave 0 covers all MISSING references (n/a — no missing infra).
- [ ] No watch-mode flags (none used).
- [ ] Feedback latency < 60 s.
- [ ] `nyquist_compliant: true` set in frontmatter once planner wires task IDs.

**Approval:** pending
