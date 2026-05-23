# Phase 2: Settings & Polish — Discussion Log

**Date:** 2026-05-23
**Mode:** discuss (default)
**Reference only — not consumed by downstream agents.**

## Areas presented

1. Settings JSON parser approach
2. Single-instance behavior
3. Path bar autocomplete implementation
4. Keyboard shortcut routing

## Areas selected by user

- Settings JSON parser approach
- Single-instance behavior

(Areas 3 and 4 → Claude's Discretion in CONTEXT.md.)

---

## Area 1: Settings JSON parser approach

### Q1 — On-disk format
Options:
- Hand-roll JSON reader **(selected)**
- Line-oriented key=value
- TOML-ish minimal

User selected **hand-roll JSON reader**. Rationale stored as D-01: consistency with every other JSON the app already emits; Phase 3 (saved views) and Phase 7 (snapshot index) will need the parser anyway.

### Q2 — Forward-compat read of unknown keys / newer schema_version
Options:
- Preserve unknown keys round-trip **(selected)**
- Drop unknown keys silently
- Refuse newer schema_version

User selected **preserve round-trip**. Stored as D-02. Parser captures unknown keys per-level into a side-bucket; writer emits them back after known fields.

### Q3 — Save trigger
Options:
- Debounced 500 ms after last change
- Save only on window close + significant events
- Save immediately on every change **(selected)**

User selected **immediate save**. Stored as D-03. Claude flagged risk of continuous drag-stream events hammering the disk; CONTEXT.md adds a Claude's-discretion mitigation to coalesce drag-style continuous events (WM_LBUTTONUP / WM_EXITSIZEMOVE flush) without re-litigating the philosophy.

---

## Area 2: Single-instance behavior

### Q1 — Second-instance launch behavior
Options:
- Focus existing window + forward CLI path **(selected)**
- Focus existing window, ignore CLI args
- Silent exit (block only)

User selected **focus + forward**. Stored as D-04. Mechanism: OpenMutexW → FindWindowW by class → AllowSetForegroundWindow + SendMessageW(WM_COPYDATA) → SetForegroundWindow → exit 0.

### Q2 — Mutex scope and payload trust
Options:
- Per-user Local\\ mutex + validate path absolute + exists **(selected)**
- Per-machine Global\\ mutex + same validation
- Per-user; pass payload through unchanged

User selected **Local\\ + validate**. Stored as D-05 (mutex name `Local\FileTree.SingleInstance.v1`) and D-06 (receiver validates `dwData` discriminator, bounds-checks `cbData`, canonicalizes via `GetFullPathNameW`, requires directory; silent drop on failure).

---

## Claude's Discretion (not asked)

Captured in CONTEXT.md "Claude's Discretion" section:
- Path bar autocomplete → `IAutoComplete2` via `SHAutoComplete(SHACF_FILESYS_DIRS | SHACF_AUTOSUGGEST_FORCE_ON)`; drive picker is a separate ComboBoxEx32.
- Keyboard shortcuts → Win32 accelerator table dispatched as `WM_COMMAND` IDs; Ctrl+F is a no-op stub until Phase 3.
- Status-bar cadence → reuse existing 1500 ms `WM_SCAN_PROGRESS` tick; 5-pane `msctls_statusbar32`.
- New `src/settings.rs` module for the Settings struct + parser + atomic writer.
- `schema_version: 1` first field; missing → treated as 1; `> 1` → load defaults but DO NOT overwrite the file.
- Atomic write recipe: temp file in same dir, fsync, `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`.

## Deferred ideas

- Saved views, bookmarks, snapshot index (Phases 3, 7 — fit through D-02 unknown-key round-trip).
- Custom autocomplete dropdown (only if `SHAutoComplete` misbehaves on Win11 26100).
- Settings UI / Preferences dialog (post-v1 polish).
- Rolling-window throughput smoothing (YAGNI; revisit if jittery).

## Scope creep deflected

None — user stayed inside Phase 2 boundary throughout.
