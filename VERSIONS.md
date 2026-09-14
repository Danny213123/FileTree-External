# Versions

A one-line index of every FileTree release, newest first. For the full notes on
any of them, see [CHANGELOG.md](CHANGELOG.md).

Current version: **2.0.0** (`VERSION`, `Cargo.toml`, `src-tauri/tauri.conf.json`,
`package.json`, `frontend/package.json` — all five must agree).

| Version | Date | Summary |
| --- | --- | --- |
| 2.0.0-alpha.2 | Unreleased | Appearance editor, app-wide light-mode dialog fix, shell drag-and-drop zones, v2 refresh/search/icon fixes |
| 2.0.0-alpha.1 | Unreleased | Electron → Tauri 2 rewrite, per-scan SQLite, paged rendering, memory budgets |
| 1.14.7 | 2026-08-24 | Persist no-gain compression skips across presets and encoders |
| 1.14.6 | 2026-08-24 | Skip partial downloads; ZIP64 for files over 4 GiB |
| 1.14.5 | 2026-08-24 | Prevent renderer black screen on very large compression runs |
| 1.14.4 | 2026-08-24 | Hardware-only video compression (NVENC/QSV/AMF) |
| 1.14.3 | 2026-08-24 | Cap compression at two parallel workers |
| 1.14.2 | 2026-08-24 | Never re-compress a file already tagged `[COMPRESSED]` |
| 1.14.1 | 2026-08-24 | Remember sources that encoded without shrinking |
| 1.14.0 | 2026-08-24 | Compression workspace overhaul: Setup, Monitor, History |
| 1.13.15 | 2026-06-18 | Fix crashes on >10M-node scans and large compression jobs |
| 1.13.14 | 2026-06-15 | Large quality-of-life release across the whole app |
| 1.13.13 | 2026-06-15 | Right-click Compress works on folders and multi-selections |
| 1.13.12 | 2026-06-14 | Compress tables match the main file table; hideable toolbar |
| 1.13.11 | 2026-06-14 | Fix batches truncated by a `]` in a file path |
| 1.13.10 | 2026-06-14 | Inactivity watchdog so a hung encoder cannot block a worker |
| 1.13.9 | 2026-06-14 | Guard job orchestration so a fault cannot strand files |
| 1.13.8 | 2026-06-14 | Saved custom compression presets |
| 1.13.7 | 2026-06-13 | Preset dropdown driving always-visible options |
| 1.13.6 | 2026-06-13 | "More savings" and "Custom" video presets |
| 1.13.5 | 2026-06-13 | Restore video savings; label corrupt inputs truthfully |
| 1.13.4 | 2026-06-13 | Fix 100% video encoder failures from invalid audio arguments |
| 1.13.3 | 2026-06-13 | Minimum-size threshold to skip files too small to shrink |
| 1.13.2 | 2026-06-13 | Deep output verification before any original is touched |
| 1.13.1 | 2026-06-13 | One failing file can no longer halt a compression batch |
| 1.13.0 | 2026-06-13 | AV1, GPU encoder test, auto-tune, and a performance pass |
| 1.12.3 | 2026-06-13 | Lenient containment check for stale compression paths |
| 1.12.2 | 2026-06-12 | Effective GPU availability instead of an unreliable `-h` parse |
| 1.12.1 | 2026-06-12 | Prefer a HandBrake build that exposes a hardware encoder |
| 1.12.0 | 2026-06-12 | Parallel compression with global load balancing; GPU encoding |
| 1.11.2 | 2026-06-12 | Comprehensive compression diagnostics and debug log |
| 1.11.1 | 2026-06-12 | Assert the genuine scanned root when starting a job |
| 1.11.0 | 2026-06-12 | Compress-page context menu and In Progress tab |
| 1.10.1 | 2026-06-12 | Fix invisible Compression page buttons; scoped view |
| 1.10.0 | 2026-06-11 | Right-click Compress from the table; persistent log |
| 1.9.0 | 2026-06-11 | Compression page |
| 1.8.1 | 2026-06-10 | Fix duplicated tabs from leaked IPC listeners |
| 1.8.0 | 2026-06-04 | Chat tool cards, plan checklist, slash commands, @-mentions |
| 1.7.0 | 2026-06-03 | Fix AI response degeneration; sampling controls |
| 1.6.0 | 2026-06-03 | Cleanup assistant, snapshots, gallery, bulk rename, tags |
| 1.5.0 | 2026-06-03 | Search results as a real file table; folder thumbnails |
| 1.4.0 | 2026-06-02 | AI file-content tools, MCP client, parallel tool execution |
| 1.3.0 | 2026-06-02 | Scan/render performance pass; LTO release builds |
| 1.2.0 | 2026-06-01 | Approval-gated `run_command`; native folder drag-and-drop |
| 1.1.0 | 2026-06-01 | Duplicates Finder; terminal copy/paste; Windows packaging |
| 1.0.0 | 2026-05-31 | Multi-agent AI assistant, Configure Columns, split view |
| 0.2.0 | 2026-05-26 | React + TypeScript frontend; filesystem watch; treemap |
| 0.1.0 | 2026-05-22 | Initial native Windows disk-usage explorer |

## Keeping this current

`CHANGELOG.md` is the source of truth and holds the detail; this file is only an
index. Update both in the same change:

1. Add the entry to `CHANGELOG.md`. While a version is unreleased, add a dated
   `### YYYY-MM-DD` group under it rather than inventing a version number.
2. Add or amend the row here. An unreleased version uses `Unreleased` as its
   date and keeps one row, with its summary updated as work lands.
3. On release, date the section in `CHANGELOG.md`, fold its dated groups into
   the usual Added/Changed/Fixed headings, date the row here, and bump the
   version in all five files listed above.

The in-app viewer (**Help → What's New**) renders `CHANGELOG.md` directly, so
anything added there ships with the next build without further work.
