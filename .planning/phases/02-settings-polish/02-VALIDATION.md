---
phase: 2
slug: settings-polish
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-23
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `cargo test` (Rust built-in, edition 2024) |
| **Config file** | none — already part of Cargo |
| **Quick run command** | `cargo test --lib settings::` |
| **Full suite command** | `cargo test --all-targets` |
| **Estimated runtime** | ~15 seconds (unit), ~30 seconds (full, including the single-instance integration test) |

---

## Sampling Rate

- **After every task commit:** Run `cargo test --lib settings::`
- **After every plan wave:** Run `cargo test --all-targets`
- **Before `/gsd-verify-work`:** Full suite must be green AND manual QA checklist (Win32 surface) executed
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | TBD | TBD | SET-01..05, POL-01..03 | — | See per-task below | unit / integration / manual | See per-task below | ❌ W0 | ⬜ pending |

*Populated by the planner — each PLAN.md task adds a row.*

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/single_instance.rs` — new integration test file: spawn `env!("CARGO_BIN_EXE_filetree")` twice with different paths, assert second exit code is 0 and primary received the path via WM_COPYDATA (asserted via a debug-only env-var that makes the primary write the received path to a tmp file)
- [ ] `src/settings.rs` — module with `#[cfg(test)] mod tests` block stubs for: JSON round-trip, unknown-key preservation, escape decoding (\\\", \\\\, \\n, \\t, \\uXXXX + surrogate pairs), number i64/f64 fast-path, malformed-input rejection, WM_COPYDATA payload validator (cbData cap, dwData magic, GetFullPathNameW canonical, directory-exists check)

*Existing test infrastructure (`cargo test`) covers everything else — no framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Settings round-trip across launches | SET-01..05 | Requires real %APPDATA% + real window | 1) Launch .exe, change every persisted setting (path, dark mode, hidden toggle, symlink toggle, drag two columns, resize+move window), close. 2) Inspect `%APPDATA%\FileTree\settings.json` — confirm `schema_version: 1` + every field. 3) Relaunch — confirm every setting restored. |
| Single-instance focus + path forwarding | SET-02 / D-04 | Requires two real processes + foreground steal | 1) Launch `filetree.exe C:\Windows`. 2) From a second shell, launch `filetree.exe C:\Users`. 3) Confirm: second exits 0, primary window pops to foreground, primary kicks a new scan of `C:\Users`. |
| Drive picker + folder autocomplete | POL-01 | Visual + interaction | 1) Click drive dropdown — confirm every fixed/removable drive present, no empty CD/floppy slots. 2) Type `C:\Pro` in path edit — confirm autocomplete dropdown shows `C:\Program Files`, `C:\ProgramData`. 3) Tab — confirm completion is accepted. |
| Keyboard shortcuts | POL-02 | Cross-control focus behavior | For each shortcut, confirm it fires regardless of focused control (edit, list, button): Enter → start scan; Esc → cancel scan if in flight, no-op otherwise; Del → trigger delete on selection (no-op stub Phase 2); Ctrl+F → focus search (no-op stub Phase 2); Ctrl+E → open export; F5 → refresh/rescan. |
| Status bar live stats | POL-03 | Requires real scan + visual cadence check | 1) Scan a large directory (>10k files). 2) Confirm files/folders/errors panes count up; elapsed pane ticks every 1500ms; MB/s pane shows a non-zero value during scan, then freezes at final value. 3) Before any scan, confirm throughput pane shows `--` (en-dash). |
| Atomic write crash safety | SET-04 (Pitfall #7) | Requires forcing a crash mid-write | 1) Set a breakpoint between temp-file write and `MoveFileExW`. 2) Force-kill the process. 3) Relaunch — confirm `settings.json` is intact (the previous good copy), and `settings.json.tmp` is either gone or a stale leftover that the loader ignores. |
| Forward-compat read (`schema_version > 1`) | SET-03 / D-02 | Requires a hand-edited future-version file | 1) Hand-edit `settings.json` to add a top-level key `future_only: { foo: "bar" }` and a nested unknown key inside `window`. 2) Launch, change dark mode, close. 3) Re-inspect `settings.json` — confirm `future_only` and the nested unknown key survived round-trip. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
