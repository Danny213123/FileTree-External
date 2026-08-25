# Changelog

All notable changes to FileTree are documented here.

This project follows a simple `MAJOR.MINOR.PATCH` version scheme. The application version is sourced from `Cargo.toml`.

## [1.14.2] - 2026-08-24

### Fixed

- Compression now checks the source filename for FileTree's `[COMPRESSED]` marker before profiling settings, reserving an output, or starting HandBrake, ffmpeg, ImageMagick, or zip. The check is case-insensitive and enforced by the backend for interactive, external, queued, resumed, and API-submitted files.
- Tagged sources are preserved unchanged and recorded as **Already compressed** instead of being encoded into a second `[COMPRESSED] [COMPRESSED]` output. A parent folder containing the marker does not cause ordinary files inside it to be skipped.

## [1.14.1] - 2026-08-24

### Fixed

- Compression now remembers a source that completed a real encode without producing a smaller output. A later run with the same path, size, modified timestamp, compression settings, resolved encoder, encoder tool/version, and GPU adapter/capability profile skips the file before starting an encoder instead of repeating wasted work.
- The no-gain decision is invalidated automatically when the source, preset, codec, encoder, tool, or relevant hardware capability changes. Sources are refreshed when workers claim them, so long-queued jobs cannot use stale metadata.
- Monitor and History identify these early exits as **Previously no gain**, distinct from a no-gain result discovered by a new encode.

## [1.14.0] - 2026-08-24

### Compression workspace overhaul

- Rebuilt Compression as compact Setup, Monitor, and History workspaces. Monitor now has a run rail, sticky job controls, size-weighted segmented progress, per-file progress/stages, elapsed time, ETA, rate, encoder details, and a responsive diagnostics inspector.
- Added a paged, virtualized file table for very large jobs with persisted columns, resizable widths, search, filters, quick views, sortable fields, keyboard selection, active-file pinning, and a 15-second recently-finished group.
- Added graceful pause/resume, live 1-16 worker concurrency, pending-file prioritize/skip, selective retry, persisted queued jobs, queue reordering/removal, and additive authenticated API routes.
- Added cached NVIDIA and Windows encoder telemetry for GPU Video Encode, sessions, aggregate fps, encoder CPU/RAM/I/O, and destination free space. Unavailable counters are reported as unavailable instead of zero.
- Compression now keeps Windows awake while work is running or pausing and mirrors aggregate running, paused, and error progress in the taskbar. Stop remains immediate, removes partial outputs, preserves sources, and leaves the job resumable.
- Upgraded History with search, date/status/type/encoder filters, sorting, export and diagnostic actions, and per-file compress-again controls.

## [1.13.15] - 2026-06-18

Stability release fixing two crashes on very large workloads: a renderer black-screen on >10M-node scans, and the whole-UI blanking when starting a large compression job.

### Fixed

- **Very large scans (>10 million files/nodes) no longer crash the renderer to a black screen**: added threshold-gated lazy per-directory tree loading. Above ~1.5M nodes the renderer keeps only the root in memory and fetches each directory's children on demand from the backend's cached scan via new endpoints (`GET /api/children`, `GET /api/subtree-files`, `GET /api/search`). The Electron renderer's V8 heap limit was raised, and a non-blocking "very large scan" advisory banner appears above ~2M nodes. In lazy mode, search runs server-side, compress folder-expansion uses `/api/subtree-files`, and Reports/Gallery show a "scan a smaller subfolder" notice while the Treemap shows a "reflects only expanded folders" banner. Normal-sized scans are unchanged.
- **Starting a compression job with many files (>160) no longer blanks/freezes the entire UI**: added an app-root React error boundary with a recoverable "Something went wrong" + Reload fallback, so a render throw can no longer white-screen the whole window. The compress progress-update storm is now coalesced by batching NDJSON progress events into a single per-frame state update (terminal events still flush immediately so completion state and the single toast stay correct), and the full-scan memos no longer recompute during an active run.

## [1.13.14] - 2026-06-15

A large quality-of-life release implementing the full QoL backlog across selection/table UX, the Compress page, scanning, duplicates & cleanup, search, snapshots/reports, file operations, and app-wide polish. Frontend-led with safe, gated backend additions.

### Added

- **Selection & table UX**: live selection summary (count + total size) in the status bar; copy-selection-as-table; quick-filter chips; open in new split/tab; size heat-tint; type-to-find; range/Ctrl/Shift multi-select across tables; recent-path dropdown in the breadcrumb.
- **Compress page**: drag-and-drop to enqueue, estimated-savings preview, job queueing, per-file retry, last-used preset remembered per file type, in-place vs output-folder selection (collision-safe output naming), and a completion toast.
- **Scanning & freshness**: scan presets, exclude-pattern list, smart refresh, and freshness indicators.
- **Duplicates & cleanup**: duplicate detection with auto-pick strategies, group preview, hardlink/symlink dedupe; safe-clean cleanup mode with dry-run totals and empty-folder finder; partial Recycle Bin viewer for FileTree's own deletes with restore.
- **Search & filtering**: inline filters, regex support, search history dropdown, and cross-scan search.
- **Snapshots, reports & insights**: snapshot auto-save, growth-trend charts, folder diffs, treemap image export, change badges, and scheduled snapshot alerts.
- **File operations**: conflict dialog, pausable/resumable transfer queue, move/copy with recent destinations, batch attribute/timestamp editing, and Send-to commands.
- **App-wide polish**: full shortcuts editor (conflict-warned), activity/notification center with unread badge, tab QoL (rename, color labels, pin), and theme customization (accent presets/custom color + 90–130% UI scale).

### Changed

- Unified open and native right-click behavior, and visual tokens, across the app's tables.

### Notes / limitations

- Transfer pause/resume is between files (in-flight native moves/copies can't be paused mid-file); Send-to "mail" can't auto-attach (zip-then-attach workflow); incremental scanning uses a pragmatic smart-refresh; Recycle Bin viewer is scoped to FileTree's own deletes; shortcut conflicts are warned (not blocked); tab crash-restore collapses to a single pane on the localStorage fallback path; font scaling uses body `zoom`.

## [1.13.13] - 2026-06-15

Lets you compress whole folders (and multi-selections of them) from the table's right-click menu. Frontend-only.

### Fixed

- **Right-click "Compress..." now works on folders and multi-selections**: selecting one or more folders (or a mix of folders and files) and choosing Compress opened the Compress page with nothing pre-checked, because the context-menu handler discarded directory paths instead of expanding them. `handleCompressFromContext` now walks each selected folder's descendants via the active pane's scan tree (BFS, files only, deduped and order-stable) and pre-checks every contained compressible file, mirroring the per-row zip button. Paths outside the current scan are still surfaced via the existing "not in scan" notice.

## [1.13.12] - 2026-06-14

Overhauls the Compress page so its tables look and behave like the main file table, and lets you hide the parts of the toolbar you don't need. Frontend-only.

### Added

- **Working right-click and double-click on every Compress table**: the file picker, the In Progress runs + per-file detail tables, and the History log now all support double-click to open a file in its default app (preferring the produced output, falling back to the source) and a native OS right-click menu. The History and per-file detail tables also gained lightweight single / Ctrl / Shift row selection, so a right-click can target the whole multi-selection.
- **Hide the encoder-missing warning**: the amber "No image/video encoder was found" banner now has an "×" to dismiss it. It can be restored from a new **Hide encoder-missing warning** checkbox in the **Performance** panel. The choice persists.
- **Hide the preset controls**: a new **Hide preset controls** checkbox in the **Performance** panel collapses the Preset dropdown, **Manage presets**, the options toggle, and the Resolution/Quality/Codec options row for a cleaner toolbar. The choice persists, and the active preset still applies to jobs.

### Changed

- **Compress tables match the main file table**: the picker, runs, per-file detail, and History tables now share the main table's visual tokens (24px sticky headers, `var(--hover)` row hover, `var(--selected)` selection, `var(--border)` separators, tabular-nums numeric cells) while keeping their existing columns.

### Fixed

- **Compress page double-click now opens files**: the file picker previously jumped to the tree on double-click instead of opening the file; it now opens it, consistent with the rest of the app.

## [1.13.11] - 2026-06-14

Fixes the actual cause of a compression batch "finishing" almost immediately having processed only a handful of files (e.g. "saved 0 bytes over 0 files"): file paths containing a `]` truncated the job's file list at job-creation time. Also pins the build version in the title bar.

### Fixed

- **Bracketed file paths no longer silently truncate a batch (the real "only ~N of M files ran" bug)**: the server parsed the `paths` array of every batch request with a hand-rolled scanner that ended the array at the first literal `]` byte. JSON does not escape `]` inside string values, so the moment any selected file's path or name contained a `]` — extremely common: a `[COMPRESSED]` tag from a prior run, `clip [1].mp4`, `Show [S01E01].mkv` — the list was cut off there and every file from that point on was dropped before the job was even created. A 117-file selection with a bracketed name near the front became a ~7-file job (all the leading files), which then "finished" with nothing useful done while the rest appeared stuck "pending" in the UI. `extract_json_str_array` now uses the real JSON parser, so brackets, escapes, and unicode in paths are handled correctly. This fixes all eight batch endpoints that share it (compress, move, delete, copy, duplicates, etc.).
- **No more perpetual "pending" spinners after a run completes**: when a finished (non-cancelled) run leaves any row without a terminal outcome, the UI now marks it as not-processed (with a Retry hint) instead of spinning forever.

### Added

- **Version in the title bar**: the title now reads `<tab> — FileTree v<version>`, sourced from the running binary, so a stale build is identifiable at a glance. New read-only `GET /api/version` endpoint.
- **Regression tests** proving the `paths` parser keeps every entry when paths contain `]`/`[`, escaped quotes/backslashes, and non-ASCII names, and that a large (117-entry) bracketed list round-trips completely.

## [1.13.10] - 2026-06-14

Fixes the real cause of a compression job stalling part-way through a batch of bad inputs: a hung encoder child could permanently block its worker. Backend-only.

### Fixed

- **A hung encoder no longer removes its worker from the pool (the real "stops after ~N files" stall)**: each video/image file runs its encoder as a child process whose completion is polled in a loop. If an encoder (HandBrake/ffmpeg) got stuck on a pathological or corrupt input — spinning forever instead of exiting — that poll loop spun forever too, permanently tying up the worker. After roughly `concurrency` such files every worker was blocked, the pool stopped pulling new files, and because `run_job` was itself blocked joining the stuck workers it never reached the reconcile/finalize tail (so the v1.13.9 orchestration guard could not help) — the rest of the batch was left "pending" indefinitely. `run_child` now runs a per-file **inactivity watchdog**: a child that produces no output for longer than the limit (default 10 minutes, override via `FILETREE_ENCODE_INACTIVITY_MS`) is killed and recorded as a terminal non-success encode, so the worker is freed and moves on. A legitimately-progressing encode emits output continuously and is never affected. Only an explicit user cancel still stops the run early.
- **A panic while recording a file's outcome can no longer kill a worker**: the per-file pipeline was panic-isolated, but the `Err`-arm that records a caught panic (CSV row, manifest write, event emit) ran outside that `catch_unwind`. A panic there — and the same in the reconcile/force-finalize sweeps — would unwind the worker (or the finalize pass) and strand the remaining files. Outcome-recording now goes through a panic-proof recorder that, as a last resort, still forces the file to a terminal `error`, so no per-file outcome can remove a worker or abandon the batch.

### Added

- **Regression tests**: a worker-pool batch with more panicking files than workers proves the pool drains completely; a `run_child` test with a genuinely silent long-running child proves the inactivity watchdog kills it promptly and reports a terminal failure (rather than blocking for the full sleep); and a `run_job` test proves a worker survives a panic raised *while recording* a file's outcome and still processes the files scheduled after it.

## [1.13.9] - 2026-06-14

Hardens the compression job runner so a fault can never end the job early and strand files as "pending". Backend-only.

### Fixed

- **A compression job can no longer terminate early and leave files stuck "pending"**: the per-file pipeline was already panic-isolated (a single bad file is recorded as an error and the worker pool continues), but `run_job` itself — the orchestration around the worker pool: encoder detection at startup, the schedule build, and the reconcile/finalize tail — ran on a bare thread with no panic protection. A panic anywhere in that orchestration would kill the job thread silently: the remaining files were left in `pending`/`running` forever, the job was never marked finished, and no terminal `done` event was emitted (the job appeared to "end early" with most files never attempted). `spawn_job` now wraps the runner in a top-level guard that, on any orchestration panic, force-finalizes the job — reconciling every non-terminal file to a terminal internal error (a user cancel still legitimately leaves files pending for resume), recomputing the tallies, persisting the manifest, emitting the terminal event, and marking the job finished — so no fault in the runner can ever abandon the batch. Cancellation behavior is unchanged: only an explicit user cancel stops the run early.

### Added

- **Regression tests** driving the real `run_job`/`spawn_job` end-to-end (previously only a hand-rolled mirror of the worker loop was tested): a mixed batch with failing inputs scheduled first proves every file reaches a terminal state with none left pending; a batch with files that panic mid-pipeline proves the per-file `catch_unwind` records them as `error_internal` while the rest of the batch completes; and an orchestration-panic case proves the new `spawn_job` guard still finalizes the job with nothing left pending.

## [1.13.8] - 2026-06-14

Lets you save your own named compression presets. Frontend-only — saved presets resolve to the backend's existing `custom` preset (resolution + quality), available since v1.13.6.

### Added

- **Saved custom presets**: save the current {resolution cap, quality, codec, encoder} as a named preset, then pick it again later from the **Preset** dropdown to re-apply all four fields at once. Saved presets appear under a **Saved** group in the dropdown (built-ins under **Presets**, plus **Custom**). A new **Manage presets** button opens a dialog to save-current-as, rename, overwrite-with-current, and delete presets; deleting the active preset falls back to **Custom**. Selecting a saved preset (or **Custom**) runs the job as backend `preset=custom` with the chosen resolution/quality. Saved presets and the last-selected preset persist across sessions in the browser.

## [1.13.7] - 2026-06-13

Redesigns the Compress page controls so presets drive a set of always-visible options, and squares the page's styling to match the rest of the app. Frontend-only — the `custom` preset (resolution + quality) already exists in the backend as of v1.13.6.

### Changed

- **Preset is now a dropdown that drives always-visible controls**: the preset chip row is replaced by a labeled **Preset** `<select>` at the top of the toolbar. The **Resolution** cap and **Quality** slider are always visible (no longer gated behind the "Custom" preset) in a new collapsible **Options** section directly beneath the dropdown. Picking a named preset writes its canonical video values into the controls so they visibly move (Maximum savings → 480p / RF30, More savings → 720p / RF27, Balanced → 1080p / RF24, High quality → Original / RF20); manually changing the resolution or quality switches the preset to **Custom** and encodes with the shown values. A **Show options / Hide options** toggle (persisted across sessions) collapses the section.
- **Codec + Video encoder moved into the Options section**: both selects are pulled out of the Performance panel and made always-visible alongside resolution/quality, keeping their capability gating. They are orthogonal to the preset — changing them does not switch the preset to Custom. GPU toggle, parallel files, zip level, minimum size, and diagnostics remain in the Performance panel.
- **Compress page styling now matches the rest of the app**: every corner on the Compress page is squared (chips, buttons, selects, badges, progress bars, panels, job cards, log containers, and range sliders). The Compress / In Progress / History tab bar is restyled to the app's standard tab look (square filled active highlight with an inset accent underline and a square hover background), with thin flush vertical dividers between tabs.

## [1.13.6] - 2026-06-13

Adds two new compression presets between the existing ones: a fixed **More savings** step and a fully **Custom** preset for video.

### Added

- **"More savings" preset**: a fixed in-between step that sits between Balanced (1080p / RF24) and Maximum savings (480p / RF30). Video is capped at 720p and encoded at RF 27 (CPU) / CQ 29 (GPU) using the x264 `medium` / SVT-AV1 speed `8` encoder presets. Images shrink a bit more than Balanced (ffmpeg `q:v 9` @ long-edge 1600; ImageMagick `quality 72` @ ~2.56 MP area cap).
- **"Custom" preset (video)**: exposes a video **resolution cap** (Original / 1440p / 1080p / 720p / 480p; default 1080p) and a **quality** slider (RF base 16–40, default 26; lower = better quality, larger file). GPU encoders add the usual +2 quality offset. The chosen values — and the last-selected preset itself — are persisted across sessions in the browser, so reopening the app restores your choice. Images under Custom reuse Balanced behavior (the Custom controls are video-only). Custom settings round-trip through the job manifest so a resumed job keeps the same encoding.



Restores the video compression savings that the v1.13.x audio change removed, and tells genuinely corrupt/incomplete downloads apart from real encoder failures.

### Fixed

- **Videos compress (save bytes) again**: across the v1.13.x window the only behavioral change to the video pipeline was audio handling. Pre-v1.13.0 the encoder re-encoded audio to 160 kbps AAC (`-E av_aac -B 160`), and those audio savings are what tipped an already-compressed video net-smaller once the hardware video encoder left the video stream roughly size-neutral. v1.13.0 switched to `-E copy` (audio passthrough), removing the savings so files finished as **"no gain" (0 bytes saved)** and the output was discarded. The audio arguments are now back to the proven `-E av_aac -B 160` re-encode (still valid — `-B` is only invalid alongside `-E copy`, the separate v1.13.4 crash fix). All other v1.13.4 behavior is unchanged: `--optimize` only for MP4-family outputs, CPU-only `--encopts threads=N`, downscale only when needed, the minimal-arg retry, and up-front encoder-token validation.
- **Corrupt/incomplete videos are labeled truthfully**: a source that fails HandBrake's scan phase (no readable title — e.g. `moov atom not found` / `unrecognized file type` / `0 valid title(s)` / `No title found`, typically a partial or failed download) is now reported as the new `error_unreadable_input` outcome ("video is corrupt or incomplete — no readable title") instead of a generic "encoder failed". The original is left untouched (an encode failure already keeps it), and the badge/tooltip explain that re-downloading — not retrying — is the fix.

### Changed

- **Portable build is now self-purging (no stale binaries/assets)**: `scripts/build-portable.ps1` (via `build-portable.bat`) removes `frontend/dist`, `electron/dist`, and the entire `dist-portable/` output before rebuilding, and always runs `cargo clean -p filetree` so the server binary and its embedded UI are rebuilt from current source. A new `-Clean` switch additionally runs a full `cargo clean` (recompiles all dependencies) for a maximally fresh build. `-SkipInstall`/`-NoLaunch` and the abort-on-any-failure flow are preserved.

## [1.13.4] - 2026-06-13

A fix for a regression that made **every video fail** to compress (`error_encoder`, "encoder exited with code 2"), plus hardening so a bad encoder argument can never again wipe a whole batch.

### Fixed

- **100% video encoder failures (invalid HandBrake audio arguments)**: the v1.13.0 audio settings combined `-E copy` (audio passthrough) with a global `-B 160` (forced audio bitrate) — an invalid combination HandBrake rejects at job setup, so every video exited non-zero. This was masked until the v1.13.1 pool-halt fix let batches run to completion and exposed it as a wholesale failure. The audio arguments are now the valid passthrough form (`-E copy --audio-fallback av_aac --audio-copy-mask aac,ac3,eac3,mp3`) with **no `-B` alongside `copy`** — still passing through already-compact lossy tracks (AAC/AC3/E-AC3/MP3) and re-encoding the rest to AAC.
- **`--optimize` only on MP4-family outputs**: HandBrake's `--optimize` (faststart) is an MP4/M4V/MOV-only flag; it is now gated on the output extension so MKV/WebM/AVI outputs (whose muxers reject it) never receive it.
- **Encoder failures now show the real reason**: the per-file error (In Progress detail and the `compress-log.csv` `error` column) includes a trimmed tail of HandBrake's stderr, not just a bare exit code. Failing files are also written to `compress-debug.log` even when verbose logging is off (subject to the existing rotation cap).

### Changed

- **A bad argument can no longer wipe a whole batch (hardening)**: if an encode exits non-zero, it is retried **once** with a minimal, guaranteed-valid argument set (input/output/encoder/quality/preset, plus a downscale only when one is requested — no audio/optimize/encopts flags) before being reported as an error. Any future argument-compatibility drift now degrades to a plain encode instead of a hard failure.
- **Up-front encoder validation**: the chosen software encoder token (`x265`, `svt_av1`) is validated against the installed HandBrake build's capabilities and downgraded to the always-present `x264` when unsupported, instead of spawning a doomed encode. Hardware (GPU) encoder attempts are unchanged — they may still be tried "assumed" from a detected adapter, and a genuine runtime GPU failure is still caught by the existing GPU→CPU fallback, which now also validates its CPU target.

## [1.13.3] - 2026-06-13

A minimum-size threshold so files too small to meaningfully compress (especially videos with too few frames) are skipped instead of wastefully re-encoded.

### Added

- **Minimum-size threshold ("Skip files under X")**: a new range slider in the compression Performance panel lets you set a minimum original size below which files are skipped untouched — no probe, no encoder, no output written. Size is the proxy for "too small / too few frames", where a re-encode is unlikely to shrink the file (and risks growing it). The slider has discrete stops (No minimum, 256 KB, 512 KB, 1/2/5/10/25/50/100 MB), defaults to *No minimum* (compress all), and is remembered across sessions alongside the other performance settings.
- **`skipped_too_small` outcome**: files below the threshold are recorded as a terminal *skipped* outcome with a new "Too small" badge + tooltip in the live progress rows, the per-file detail table, and History. They flow into the same skipped bucket as no-gain skips, so the post-job count still reconciles to the input count. The threshold (`minSizeBytes`) is carried in the job request and persisted in the job manifest (resume-safe).

## [1.13.2] - 2026-06-13

A post-compression safety workflow so a good original is never removed behind a corrupt compressed output, plus an explicit choice of what happens to each original and a guarantee that every input file is accounted for in the final counts.

### Added

- **Deep output verification (hard gate before any original is touched)**: a successful encoder exit and a smaller file are no longer treated as proof the output is intact. After the size check, each compressed output is now re-verified before the original is disposed of — video/audio by a full ffmpeg re-decode (`ffmpeg -v error -xerror -i <out> -f null -`; any non-zero exit or stderr fails), falling back to a HandBrake `--scan` title check when ffmpeg is absent, with a duration sanity-check against the original; images by an ImageMagick `identify -regard-warnings` (or ffmpeg) decode confirming the dimensions match; and zip archives by opening the produced file and reading every entry to validate its CRC32. On failure the bad output is deleted, the **original is left untouched**, and the file is recorded as the new resumable `error_verify_failed` outcome (with its own badge + tooltip).
- **Recycle / Delete-permanently / Keep choice for originals**: the single "Recycle originals" checkbox is replaced by a three-way control. *Recycle Bin* (default) sends each verified original to the Recycle Bin (recoverable); *Delete permanently* removes it with no Recycle Bin step (irreversible — flagged with a warning style and only ever run after verification passes); *Keep originals* leaves every original in place beside the new `[COMPRESSED]` file. The request carries a new `originalAction` (with `recycleOriginals` kept for back-compat); older manifests/clients map `recycleOriginals` true→Recycle, false→Keep.
- **Per-file disposition + reconciled totals in the UI**: each finished file now shows what happened to its original (Recycled / Deleted / Kept) and the run detail surfaces aggregate counts that visibly sum to the total — done / skipped / verify-failed / error / pending out of N files, plus "N recycled, N deleted, N kept".

### Changed

- **Final job counts reconcile to the input count**: the `done` event and job summaries now include `skipped` and a `verifyFailed` tally (a subset of errors), and the worker logs a loud `[reconcile] COUNT MISMATCH` to the debug log if `done + skipped + error` ever fails to equal the total — building on the 1.13.1 post-join reconcile so post-job count always equals pre-job count.

## [1.13.1] - 2026-06-13

A reliability fix for the parallel compression pool: a single bad file could take the whole batch down (user saw 116 files stall at 39, with 77 left "pending" and a false "done").

### Fixed

- **One failing file can no longer halt the whole compression batch**: the worker pool shared several `Mutex`es accessed via `.lock().expect(...)`. A panic in one file's pipeline poisoned a shared lock, so every other worker's next lock panicked too — cascading until the entire pool died and the run finalized with most files left `pending` and a misleading `done`. Each file's processing is now wrapped in `catch_unwind`: a panic is logged, recorded as a per-file `error_internal` outcome, counted, and the worker continues. All shared compression/gate locks are now poison-tolerant (recover the guard instead of propagating), so one panic can never cascade.
- **Actual panic trigger — non-UTF-8 encoder stderr**: `encoder_error_message` (run on *every* non-zero HandBrake exit, i.e. the whole "0 valid titles / unrecognized file type" wave) and the GPU-fallback stderr helper sliced the stderr tail by raw byte offset (`&s[s.len()-N..]`). When that offset landed mid-codepoint — common, since HandBrake stderr carries localized text and accented file names — the slice panicked, which was the lock-poisoning trigger. Both now snap to a UTF-8 char boundary (`safe_tail`) and never panic.
- **No more false "done" with abandoned files**: after the pool joins, any file left non-terminal (`pending`/`running`) is reconciled to a per-file `error_internal` and the job status becomes `error` (resumable via Retry) instead of `done`, so the In Progress tab always shows a real outcome for every file.
- **Audio files no longer routed to HandBrake**: `classify` folded audio (`mp3/wav/flac/aac/ogg/m4a`) into the video pipeline, so an audio-only file hit HandBrake and failed with "no title found". Audio is now treated as `Other` — already-compact audio is recorded as a clean no-gain skip and only genuinely compressible audio (e.g. WAV) is losslessly zipped — with no external tool required. (Latent for the all-video batch above, but the same error family.)

## [1.13.0] - 2026-06-13

A backlog of quality, performance, correctness, security, and observability follow-ups surfaced while shipping 1.12.0–1.12.3. No regressions; each item is an independent improvement.

### Added

- **AV1 codec option**: the Compress Performance panel now offers AV1 alongside H.264/H.265. Hardware AV1 (NVENC/QSV/VCE AV1) is used only when HandBrake's `-h` actually reports the AV1 token — a mere GPU adapter no longer implies AV1 support, since only recent GPUs encode it — otherwise the CPU SVT-AV1 encoder (with a numeric speed preset) is used. The label flags whether HW AV1 is available.
- **"Test GPU encoder" action**: a definitive hardware-encode check that actually runs the resolved GPU encoder on a tiny, pure-Rust-generated YUV4MPEG2 clip (no bundled binary asset, decoded by HandBrake's libav) and reports success/time/size or HandBrake's exact error — beyond the `-h`/adapter inference.
- **"Auto-tune CPU vs GPU" action**: sample-encodes the CPU software encoder and the best available GPU encoder on the tiny clip, then applies the faster one that succeeded (preferring GPU on a tie). Backed by `POST /api/compress-tools/test-gpu` and `/api/compress-tools/autotune` (token-gated).
- **"Copy diagnostics" button** in the Performance panel: copies a plain-text bundle (HandBrake path/version, `-h` parse status + GPU tokens, effective encoder availability, GPU adapter names, current encoder/codec/concurrency/zip settings, and the latest GPU-test / auto-tune outcomes plus the raw encoder list) to the clipboard for bug reports, with an `execCommand` fallback for non-secure contexts.

### Changed

- **HandBrake audio passthrough**: audio was always re-encoded to AAC @160k; tracks already in a compact lossy codec (AAC/AC3/E-AC3/MP3) are now copied through (`-E copy` with an AAC fallback + copy mask), avoiding needless re-encode work and a generational quality loss. Non-compact audio (lossless PCM/FLAC/TrueHD/DTS-HD, etc.) still falls back to AAC.
- **Pre-skip extended to media**: the "don't bother encoding" heuristic (previously zip-only) now also skips images already in an efficient codec (AVIF/HEIC/WebP under 2 MiB) or any image under 32 KiB, and any video under 1 MiB — recorded as a no-gain skip without spawning an encoder. Deliberately conservative so a genuinely compressible file is never skipped.
- **Thumbnail generation uses a persistent STA worker pool + true LRU**: Windows Shell thumbnails need a COM STA, but the server spawned (and `CoInitializeEx`/joined) a fresh thread per cache miss. A small pool of long-lived STA threads — each initializing COM once — now services generations off a shared channel. The server-side thumbnail cache also switched from arbitrary-entry eviction to true LRU (each entry tracks a "last used" tick bumped on hit), so a burst of misses can't evict a still-hot thumbnail.
- **Scan finalize parallelizes the per-directory children sort**: assembling a scan result sorts every directory's children (size desc, then case-insensitive name), the dominant finalize cost on wide trees because each comparison lowercases a name. That pass is now computed across scoped worker threads (shared immutable reads, sequential write-back) for large trees, falling back to inline work below a threshold / on a single core.
- **`scan_cache` is read-mostly**: the recent-scan cache moved from a `Mutex` to an `RwLock`, with LRU recency tracked atomically so a lookup (`get_fresh`/`get_any`) records its access under a shared read guard. Concurrent scan/dupe/compress cache hits no longer serialize behind one another; only inserts and invalidations take the exclusive write guard.
- **In Progress tab backs off when idle**: the run list polled every 1.5s unconditionally; it now polls at 1.5s only while a job is active and backs off to 8s when everything is idle (resuming/cancelling a job restarts fast polling immediately).
- **Compression CSV history is size-capped**: the append-only `compress-log.csv` is now compacted in place (header + most recent 5000 rows, atomic temp+rename) once it crosses ~8 MB, mirroring the existing 5 MB rotation of the debug log, so a long-running install's history can't grow without bound. The History tab only ever renders a recent window, so no visible data is lost.
- **Orphaned v1 hash cache removed**: the duplicate-scan cache migrated to `hash_cache_v2.json` in 1.12.x; the now-unused legacy `hash_cache.json` is deleted once at startup (best-effort).
- **Tool detection is cached (`GET /api/compress-tools`)**: detection shells out to `HandBrakeCLI -h`, `ffmpeg -version`, `where`, and a PowerShell GPU probe — previously recomputed on every poll, with the chosen HandBrake binary probed two-to-three times per request. Results are now served from a short-lived (15 s) cache, and the cold path runs `HandBrakeCLI -h` only once (caps + raw encoder list parsed from the same output). A detect/install attempt (`POST /api/compress-tools/install`) busts the cache so a freshly dropped binary is reflected immediately.

### Fixed

- **Long-path (>260) and UNC/network selections resolve for compression**: path containment now retries `canonicalize` with a Windows extended-length verbatim prefix (`\\?\` for a drive path, `\\?\UNC\` for a share) when the plain attempt fails, so deep or remote selections no longer silently fail the compress check. Both the registered roots and the requested paths go through the same helper, so the verbatim forms compare like-for-like.
- **Cloud-only placeholder files are detected and skipped gracefully**: a OneDrive/Files-On-Demand file whose data isn't downloaded locally (offline / recall-on-access attributes) is no longer fed to an encoder — which would force a possibly huge hydration download or stall offline. It's recorded as a distinct `error_cloud_placeholder` outcome with an actionable "Always keep on this device" hint. (A likely contributor to the earlier unresolvable-path reports.)
- **Resume re-validates tools first**: resuming an interrupted job now re-checks that the encoders its remaining files need are still installed and returns a clear `409` ("HandBrake/ffmpeg required …") instead of resuming and erroring every remaining file.

### Added

- **Pre-flight existence probe before starting a job**: the Compress page now confirms the selection on-disk via a lightweight backend probe (`POST /api/compress-preflight`) — the in-memory tree it previously consulted can itself be stale — and skips/flags missing or cloud-only files up front rather than surfacing them only per-file mid-run.

### Security

- **Compressing a folder no longer widens content-read access**: the compress routes used to register a selection's directories into the shared `scan_roots`, which also gates the content-read routes (preview/thumbnail/owner). A dedicated `compress_roots` allowlist now backs compress/zip containment (accepted under `scan_roots` ∪ `compress_roots`), while preview/thumbnail/owner reads continue to consult `scan_roots` alone. Compress access therefore never grants read access.
- **`common_ancestor_dir` no longer registers a bare drive root**: for disjoint same-drive selections the only shared prefix is the drive itself (`C:\`); registering it would have granted compress access to the whole drive. Such a bare root is now rejected and per-path parent registration covers the real selection directories instead.

## [1.12.3] - 2026-06-13

### Fixed

- **Compression no longer fails with a misleading "a source path is outside the scanned directories" (403)**: the `POST /api/compress-jobs` containment pre-check rejected the entire request whenever any single submitted path failed to canonicalize — typically a stale/missing descendant produced by expanding a folder from the renderer's in-memory cache (a file recycled or renamed since the last scan). The check is now lenient: a path is only rejected when it canonicalizes successfully AND resolves outside every directory the user referenced (the genuine security case). A missing/stale path is allowed through and recorded per-file by the worker as `error_source_missing` — so valid files in the selection still compress and the stale one simply shows a "source missing" outcome in the In Progress tab. The genuine security guard (rejecting a path that resolves to a location the user never referenced) is preserved.

### Changed

- **Resilient scan-root registration on the token-gated compress routes**: both `POST /api/compress-jobs` and the F5 zip route (`POST /api/compress`) now register each submitted path's own directory (the path itself if it is a directory, else its parent) as an allowed root, in addition to the existing `scanRoot` and common-ancestor registration. This covers disjoint/multi-drive selections (where there is no common ancestor) and cache-served trees this server session never scanned. Registration only ever records real on-disk directories the caller demonstrably referenced, so it does not widen access. The `[authz]` debug log now distinguishes a "missing/unresolvable" source (allowed, handled per-file) from a "resolved-but-outside" source (rejected).

## [1.12.2] - 2026-06-12

### Fixed

- **GPU video encoding no longer blocked by HandBrake's unreliable `-h` parse**: capability detection runs `HandBrakeCLI -h` and scans the help text for `nvenc_*`/`qsv_*`/`vce_*` tokens, but some HandBrake builds omit those tokens from redirected (non-console) help even though the hardware encoders work — so detection reported "no GPU", the UI disabled the GPU controls, and every file fell back to CPU `x264`. GPU availability is now gated on **effective** availability: a vendor's encoder is offered when EITHER the `-h` token is present OR the matching physical GPU adapter is detected (via the independent `Win32_VideoController` probe). An empty `-h` parse is treated as "unknown", not "absent". The encoder selector now emits the hardware `-e` token (e.g. `nvenc_h265`) when a matching adapter is present or the user explicitly picked NVENC/QSV/VCE, instead of silently choosing `x264`.
- **Silent CPU fallback is now loud and diagnosable**: when a GPU encode fails, the file is still re-encoded on the CPU (no lost work), but the outcome is recorded as a distinct `gpu_fallback` reason carrying HandBrake's actual stderr (driver/session/codec error) and exit code — surfaced in the In Progress tab (an amber "GPU→CPU" badge), the CSV history, and the debug log. This directly answers "VRAM rose but nothing encoded".

### Changed

- **Hardened HandBrake capability probe**: `HandBrakeCLI -h` now runs with its working directory set to the binary's own folder (so a build that loads sibling DLLs/initializes hardware relative to its install behaves like a normal launch), records whether the help actually parsed, and additionally recognizes AV1 hardware tokens (`nvenc_av1`/`qsv_av1`/`vce_av1`).
- **Performance panel evidence**: the Compress page now shows the resolved HandBrake path + version, the effective GPU encoders available (with a `*` marking ones assumed from the adapter and verified on first run), the `-h` parse status and the raw encoder list (expandable), the physical GPU adapter name(s), and the actual encoder used per file. Includes a hint that NVENC activity shows under Task Manager → Performance → GPU → "Video Encode".
- **`GET /api/compress-tools`** gained `available` (effective per-vendor availability + `*Assumed` flags), `handbrakeHParseOk`, `handbrakeEncodersRaw`, and AV1 capability flags; the per-file job snapshot gained the genuine `encoder` used. (The client also now forwards the `caps`/`gpu`/`gpuHardware` fields it had previously been dropping.)

## [1.12.1] - 2026-06-12

### Fixed

- **GPU encoding lost to the wrong HandBrake binary**: video compression could silently run on the CPU when a hardware-capable HandBrakeCLI existed on the machine but FileTree resolved a different/older one (or none of the few previously-searched locations). HandBrake discovery now (1) honors a `FILETREE_HANDBRAKE` environment override pointing at an exact HandBrakeCLI (or its folder), (2) searches more locations — the app tools dir, 64-bit and 32-bit Program Files, `ProgramW6432`, and per-user `LOCALAPPDATA\Programs` — and (3) when several HandBrake builds are present, **prefers one that actually exposes a hardware encoder** (NVENC/QSV/VCE) so the GPU path isn't dropped in favor of a HW-less build found first.

### Added

- **GPU/HandBrake diagnostics, end to end**: the job-start debug log now records which exact HandBrakeCLI was chosen (with every candidate it considered and that candidate's detected encoder caps) and dumps the raw encoder tokens that *this* build reports — the ground truth for "why didn't the GPU kick in". When GPU is requested but the resolved binary exposes no hardware encoder, an explicit warning is logged instead of a silent CPU fallback. The Performance panel on the Compress page now shows the resolved HandBrake path + version, the detected hardware encoders, and — when a physical GPU is present but HandBrake can't use it — an actionable hint to set `FILETREE_HANDBRAKE` (or drop a GPU-capable HandBrakeCLI in the tools folder). The actual per-file command line (`-e <encoder>`) and final encoder used remain captured in the debug log and the CSV history.

## [1.12.0] - 2026-06-12

### Added

- **Parallel compression with global load balancing**: a compression job now encodes multiple files at once via a bounded worker pool (scheduled largest-first), instead of one-at-a-time. A new global gate caps total concurrent encoders across all jobs and splits them into separate workload lanes (video CPU, GPU sessions, image, zip), so simultaneous jobs no longer oversubscribe the machine and a queue of large videos no longer blocks quick image/zip work. Cancelling a job now kills every active encoder child.
- **Hardware-accelerated video (GPU) through HandBrake**: FileTree detects available hardware encoders (NVIDIA NVENC, Intel QSV, AMD AMF/VCE for H.264/H.265) from HandBrake and the inferred GPU vendor, exposed on `GET /api/compress-tools`. A new **Performance** panel on the Compress page lets you pick the encoder (Auto / x264 / NVENC / QSV / AMF-VCE), codec (H.264/H.265), GPU on/off, parallel-file count, and zip level — capability-gated so unavailable encoders can't be chosen, with hardware-derived defaults. **Auto** picks the best available GPU encoder and falls back to CPU x264 per file on a GPU failure (logged). Settings persist across sessions.
- **Zip throughput**: the Deflate level is configurable, and already-compressed inputs (e.g. media, archives) are stored instead of wastefully re-compressed. A pre-skip heuristic avoids spawning encoders for inputs unlikely to shrink.
- **In Progress tab overhaul**: the run cards became a table (status, preset, created, progress, saved, actions) covering running, completed, and interrupted runs. Each row expands to a lazy-loaded, virtualized per-file outcome table — outcome badge, original→new size, saved bytes + %, throughput (MB/s), duration, and reason/error — with an outcome filter (passed/failed/skipped). Active runs refresh live; loaded detail is cached on collapse.
- **Per-file throughput + enriched outcomes**: the job manifest, the `/api/compress-jobs/<id>` snapshot, and the debug log now record each file's precise reason, saved bytes/percent, duration, and MB/s/fps, so even interrupted or restored runs show exact outcomes.

### Changed

- **Faster duplicate hashing**: the content hash used by the Duplicates finder switched from byte-serial FNV-1a to an 8-bytes-per-step FxHash-style hash, markedly speeding up full-file hashing of large candidates. The on-disk hash cache moved to `hash_cache_v2.json` (the old cache is retired automatically).
- **Bounded thumbnail generation**: a global limit caps how many Windows Shell thumbnails are generated at once, so fast-scrolling a folder of fresh images can't spawn an unbounded number of worker threads.
- **Lower renderer memory**: the client scan cache is now byte-capped (~256 MB) with least-recently-used eviction, so holding several large scans no longer pins unbounded heap.

---

## [1.11.2] - 2026-06-12

### Added

- **Comprehensive compression diagnostics**: every per-file compression outcome is now explainable. The pipeline captures the encoder's exit code and a tail of its stderr, and classifies each result with a precise reason code (`success`, `skipped_no_gain`, `error_tool_missing`, `error_encoder`, `error_output_empty`, `error_source_missing`, `error_spawn`).
- **Verbose debug log**: a new append-only, size-capped log at `%APPDATA%\FileTree\compress-debug.log` records, per file, the tool + full command line, exit code, stderr tail, decision + reason, original/output sizes, duration, and recycle/tag results, plus job start/end and authorization-rejection lines. Gated by `FILETREE_COMPRESS_DEBUG` (on by default). New endpoints `GET /api/compress-debug.log` and `GET /api/compress-debug/path`, with Open / Reveal buttons in the History tab.
- **Richer compression CSV**: the per-file CSV log gained trailing columns `reason`, `exit_code`, `tool_version`, `command`, and `stderr_excerpt`.
- **Reason badges in the UI**: progress rows and the History tab now show human-readable status badges with tooltips (e.g. "Skipped - output not smaller", "Error - HandBrake not installed", "Error - source missing (recycled?)").

### Fixed

- **Compression rejected as "outside the scanned directories"**: the token-gated compress endpoint now registers the common-ancestor directory of the submitted files before validating, so legitimate folder/file selections are no longer rejected when the tree was served from cache or after a restart. Rejections now return a diagnostic message naming the offending path and are logged with the registered roots.
- **Confusing re-compress path errors**: starting a job now drops paths that no longer exist (e.g. originals recycled by a prior run) or are already `[COMPRESSED]` outputs, refreshes the tree, and shows a pre-flight notice instead of failing opaquely.

---

## [1.11.1] - 2026-06-12

### Fixed

- **"compression failed: a source path is outside the scanned directories" when compressing a folder/selection**: the Compression page started jobs with the path-input value (`scanPath`) as the asserted scan root, which can point somewhere that doesn't actually contain the selected files (for example after navigating into a subfolder), so a cache-served or post-restart session re-registered the wrong directory and the server rejected valid source paths. The page now asserts the genuine scanned root (`data.rootPath`), which is guaranteed to be the ancestor of every file in the list. The containment guard is unchanged -- it still only ever registers a real on-disk directory the user actually scanned, and paths genuinely outside a scanned root are still rejected.

---

## [1.11.0] - 2026-06-12

### Added

- **Right-click context menu on Compress page file rows**: file rows in the Compression page now open the native Windows shell context menu (reusing the same integration as the main file table). It is multi-selection aware -- right-clicking a row that's part of the current selection acts on the whole selection, otherwise just the clicked row.
- **"In Progress" tab on the Compression page**: a new tab listing running compressions with live progress, plus interrupted/resumable jobs (including ones orphaned by an app restart), each with Resume / Cancel / Reveal actions. Backed by a rewritten `GET /api/compress-jobs` list endpoint that merges the live in-memory job registry with persisted job manifests under `%APPDATA%\FileTree\jobs\`.

---

## [1.10.1] - 2026-06-12

### Fixed

- **Invisible Compression page buttons**: the Start / Select all / Clear / Stop toolbar buttons on the Compression page were rendered invisible by a CSS class-name collision with the new per-row "Compress" button (both used `.compress-btn`, whose hover-revealed `opacity: 0` leaked onto the page buttons). The row button now uses a dedicated `.row-compress-btn` class, so the page's controls are reliably visible again.

### Changed

- **Scoped Compression view**: launching the Compression page from the table (the row "Compress" button or right-click "Compress…") now scopes the file list to only the launched selection -- with a "Compressing N selected items" header and a "Show all files" escape hatch -- instead of listing the whole scan and merely pre-checking the selection. Opening the page from the activity bar still shows every compressible file in the scan.

---

## [1.10.0] - 2026-06-11

### Added

- **Right-click "Compress…" from the table**: selecting one or more files and choosing "Compress…" from the context menu opens the Compression page pre-loaded with exactly those files, ready to encode.
- **Quick "Compress" row button**: a hover action on every file/folder/[X files] row, sitting next to "Add tags" and "Add bookmark". Folders expand to their contained files and multi-selections load all selected files into the Compression page in one click.
- **Persistent compression log**: every compressed file is appended to a CSV at `%APPDATA%\FileTree\compress-log.csv` (timestamp, original/compressed sizes, bytes saved, compression %, ratio, tool, codec parameters, duration, status, and more). A new **History** tab in the Compression page renders the log with Open CSV / Reveal / Download actions, backed by `GET /api/compress-log.csv`, `GET /api/compress-log?limit=N`, and `GET /api/compress-log/path`.

### Fixed

- **"compression failed: a source path is outside the scanned directories"**: the compress request now sends and re-registers the active `scanRoot` (only when it is a real existing directory), so sessions whose tree was served from the renderer cache -- or that started after a server restart -- validate selected files correctly. The scan-root containment guard is unchanged: paths genuinely outside a scanned directory are still rejected.

---

## [1.9.0] - 2026-06-11

### Added

- **Compression page**: a dedicated activity-bar view to shrink videos, images, and other files.
- **Smart re-encoding**: re-encodes video/audio via HandBrake and images via ffmpeg/ImageMagick, and losslessly zips other file types, with quality presets (Maximum savings / Balanced / High quality).
- **Job queue with live progress**: per-file and overall progress, plus hard-cancel of a running job and restart/resume that skips already-completed files.
- **Safe, verified outputs**: outputs are tagged `[COMPRESSED]` in the filename and metadata, and originals are sent to the Recycle Bin only after real size savings are verified -- files that would not shrink are skipped.
- **Tool detection**: hybrid detection with an in-app status banner and a download/install prompt when HandBrake or the image encoder is missing (zip is always available).

---

## [1.8.1] - 2026-06-10

### Fixed

- **Right-click "Open in new tab" opening many tabs at once**: after switching, opening, or closing tabs, the context-menu action could spawn multiple tabs at once because of leaked/duplicated `externalDrop` IPC listeners. The context-menu action now uses the dedicated action channel and its IPC listeners are properly unsubscribed.
- **Related IPC listener leaks**: native drag listeners (`drag-move`/`drag-end`) and tab-bar drag listeners that accumulated on tab changes are now cleaned up.

---

## [1.8.0] - 2026-06-04

### Added

- **Expandable tool-call cards**: each tool call renders as a card with an icon, a human-readable title, its arguments, and its result.
- **Live steps / plan checklist**: a running checklist with per-step pending, running, done, and error states.
- **Path-specific live activity**: per-path status with an elapsed timer, plus "Thought for Ns" reasoning timing that auto-collapses when finished.
- **Syntax-highlighted code blocks**: lazy-loaded `highlight.js` with language labels and a per-block Copy button, plus GitHub-flavored Markdown tables and task lists.
- **Slash commands** in the composer: `/new`, `/clear`, `/model`, `/scan`, `/stop`, `/help`, and `/approve-all`.
- **@-mentions** of files and folders from the tree to add context or scope work to a folder.
- **Composer keyboard shortcuts**: Esc to stop, Up to edit the last message, arrow/Enter/Tab to navigate popups, and Ctrl+Enter to send.
- **Context / token usage meter**, post-turn follow-up suggestions, and continue-after-stop.
- **Clearer tool approvals**: Allow once / Always allow / Reject, with an affected-paths list and an improved diff preview.
- **Chat-aware command palette** entries, plus session rename and pin.

---

## [1.7.0] - 2026-06-03

### Fixed

- **AI chat response degeneration**: repetition/degeneration loops on disk-usage queries are fixed end-to-end -- explicit decoding controls (`temperature`, `top_p`, repeat penalty, `num_ctx`, `num_predict`/`max_tokens`) are now sent across Ollama, OpenAI, and Anthropic; the guard-nudge self-correction spiral that fed the model its own repetition is stopped; and a streaming repetition/degeneration guard with a stall timeout aborts a derailing run and retries it once at a low temperature.
- **Summarization notice**: fixed a latent bug where the "couldn't compress earlier messages" notice never fired when older history could not be summarized.

### Added

- **Configurable sampling / decoding settings** for the AI chat, wired through every provider (Ollama, OpenAI, Anthropic).
- **Regenerate last turn**, plus per-message **Copy** and **Edit-and-resend**.
- **Clickable Windows paths** in assistant replies -- reveal the file in the tree or open it in Explorer.
- **Cloud tool reliability**: tool-argument errors are propagated back to the model, and mutating tools validate their required fields before running.
- **Automatic retry with backoff** for rate-limited or unavailable cloud requests, with an optional fallback model.
- **Sharper orchestration**: more accurate delegation handoff (verified paths sorted by size), prompt hardening (stale-hint framing and final-answer formatting), a unified conversation window with token budgeting and summarization progress UX, model capability (tools/vision) badges in the model picker, and a per-turn debug bundle.

---

## [1.6.0] - 2026-06-03

### Added

- **Disk Cleanup / Reclaim Space assistant**: a dedicated view that categorizes reclaimable space (caches, temp files, logs, recycle bin, large and stale items) and frees it by moving the selected entries to the Windows Recycle Bin rather than hard-deleting them.
- **Scan snapshots and historical diff**: save a scan as a named snapshot and compare any two saved snapshots to see what was added, removed, grew, or shrank between them.
- **Media Gallery view**: a virtualized thumbnail grid that renders the images and videos in the current scan, staying responsive on very large folders.
- **Bulk / batch rename**: rename many files at once with a live preview, supporting regex find/replace, tokens, and sequential numbering before any change is written to disk.
- **Tags and color labels**: attach persistent, filterable tags and color labels to files and folders, retained across sessions.
- **Command palette**: a Ctrl+P quick file jump and a Ctrl+Shift+P command launcher for keyboard-driven navigation and actions.
- **Saved searches / Smart Folders**: persist a search query as a reusable Smart Folder that re-runs on demand.
- **Archive actions**: compress selections to a `.zip`, extract archives, and compute SHA-256 checksums directly from the file table.
- **Low-space monitor**: a background monitor that raises native desktop alerts when a drive runs low on free space.
- **File-operation transfer manager with unified Undo**: a transfer manager that tracks copy/move/delete operations with progress, alongside a single unified Undo across file operations.

### Fixed

- **Cleanup date units**: the Disk Cleanup age thresholds now use the correct date units, so stale-item buckets are computed accurately.
- **Low-space drive source**: the low-space monitor reads free-space from `/api/drives`, so its alerts reflect the actual mounted drives.

---

## [1.5.0] - 2026-06-03

### Added

- **Search results as a real file table**: the activity-bar Search now renders matches in the main area using the same table as the tree (sortable columns, hover thumbnails, right-click shell context menu, multi-select, double-click to open, drag-to-move) via a new flat table mode, in addition to the existing sidebar results list.
- **Folder thumbnails**: folders now show a representative thumbnail -- the largest bookmarked image/video inside the folder, or the largest image/video if none are bookmarked -- in the hover info card and the Inspector preview (folder rows keep their folder icon).

### Changed

- **Search matches name and path**: file/folder search now does a case-insensitive substring match against both the name and the full path (previously name-only), so path- and extension-oriented queries return the files you expect; the matcher is shared between the sidebar list and the main-area table.
- **Toolbar filter surfaces files**: an active Filter (or advanced rules) now lists matching files, not just folders, and is expansion-independent (it descends into every directory, capped to keep very large trees responsive), so searching for a known file no longer returns zero results.
- **Hover info on the whole name**: the thumbnail / file-info card now appears when hovering anywhere over the file/folder title, not only the icon, and no longer dismisses when the cursor moves between the icon and the name.
- **Faster hover thumbnails**: the hover delay dropped from 400 ms to 150 ms, the thumbnail is prefetched on row hover, and the backend caches generated thumbnails in memory (keyed by path + modified-time + size, bounded to 512 entries) so repeat hovers skip the Windows Shell thumbnail API.

### Fixed

- **Rename text selection vs drag**: dragging the mouse to highlight text while renaming a file or folder no longer starts the file/folder move drag, so text can be selected normally in the rename field.

---

## [1.4.0] - 2026-06-02

### Added

#### AI Assistant tools
- **`read_file`**: a read-only content tool wired to `/api/file-text` (scan-root gated, ~64 KiB server cap) with client-side line windowing (`offset`/`limit`) that returns `truncated` + `next_offset`, so the assistant can verify file types/configs/logs instead of inferring from scan metadata.
- **`grep` content search**: searches inside files by picking candidates from the scan tree (optional `dir`/`glob`/`ext` filters), reading them via `read_file`, and returning path + line + snippet matches -- bounded by file count and total bytes, with a pluggable `MatchScorer` seam for a future embeddings-backed ranker.
- **`write_file` / `edit_file`**: Tier-2 approval-gated tools that create or patch text files, each surfaced through a new diff preview in the action approval card (old vs new for edits, new content for writes).
- **Read-only `git_status` / `git_diff` / `git_log`**: run the corresponding git commands for a folder and parse the output into structured results.
- **`web_fetch` / `web_search`**: approval-gated tools implemented in the Electron main process -- a bounded HTML-to-text fetch with a timeout, plus a keyless DuckDuckGo search.
- **`remember`**: a persistent memory tool backed by a local note store the assistant reads at the start of each run.

#### AI Assistant capabilities
- **MCP client**: configure Model Context Protocol servers (minimal stdio and HTTP JSON-RPC with the initialize handshake); their tools are discovered, namespaced as `mcp__server__tool`, and registered at runtime, with read-only tools ungated and side-effecting tools approval-gated.
- **Project rules and memory**: a user-editable rules / custom-instructions field in the assistant settings is injected into the system prompts alongside the persistent memory store.
- **Parallel execution**: independent read-only tool calls within a turn run concurrently, and multiple `delegate_to_search` sub-agents issued in one orchestrator turn run in parallel; mutating and approval-gated calls remain sequential.

### Changed

#### AI Assistant accuracy
- **Cross-turn tool memory**: a compact per-turn trace (tool name, key args, result digest) is folded into the conversation so follow-up turns remember what was found and done, instead of seeing only past final answers.
- **Structured sub-agent results**: delegations now return `{ agent, report, facts: { paths, counts, notes } }` and sub-agents receive the overall task plus a prior-turn digest, rather than a bare task string and a prose-only report.
- **Truncation signaling and pagination**: `list_largest`, `find`, `list_dir`, and `list_by_extension` return `{ returned, total, truncated, next_offset }` and accept an `offset`, and the per-tool output cap was raised to 8000 chars and annotated with how much was cut and how to page for more.
- **Path-verification gate**: paths cited in a draft final answer are verified against the current scan tree, and a fabricated path forces one corrective search pass.

#### AI Assistant performance
- **Backend**: `/api/ai-models` is served from an 8-second in-memory cache (and serves the last good value on upstream errors), and the Ollama chat proxy now stops reading upstream as soon as the client disconnects, freeing the per-connection thread instead of draining Ollama for up to its 120-second timeout.
- **Frontend**: attached-folder pre-scans run in parallel and reuse the scan cache; the model list is cached client-side (30-second TTL with in-flight request sharing); a per-scan node index (by size and parent) backs `find`/`list_dir`/`list_largest`/`grep`; streaming text and thinking deltas are coalesced through a `requestAnimationFrame` buffer; and persisted chat sessions strip image data URLs and cap stored tool output.

### Fixed

- **`run_command` shell selection**: the `shell` parameter (defined in the tool schema) is now forwarded end-to-end instead of being silently dropped.
- **Tool-call robustness**: malformed JSON tool arguments are reported back to the model as an error instead of being silently replaced with `{}`, and Ollama tool-call IDs are now stable per call across streamed chunks.

---

## [1.3.0] - 2026-06-02

### Changed

#### Performance
- **Release build optimization**: added a `[profile.release]` section (`lto = true`, `codegen-units = 1`) so release builds get link-time optimization across the hot scan, hash, and JSON loops (previously absent, so release builds got no LTO).
- **Lower-contention scanning**: the per-directory scan buffer is sharded into per-worker thread-local buffers merged at finalize — removing the single `Mutex<Vec<NodeRecord>>` bottleneck while preserving the positional `id == index` / parent / children contract. File-sampling fingerprints now use lock-free `AtomicU64`/`AtomicBool` instead of per-file mutexes, content-hash cache writes happen outside the cache lock, read-dominated `AppState` fields moved from `Mutex` to `RwLock`, and a process-wide thread gate bounds concurrent full-tree scans.
- **O(1) asset serving and micro-optimizations**: embedded renderer assets are indexed into a `HashMap` once at startup instead of a per-request linear scan; `largest_by_size` uses `select_nth_unstable_by` for top-N selection; and the in-memory content-hash cache evicts oldest-first.
- **Streamed duplicate JSON**: `/api/dupes`, `/api/dupes-scan`, `/api/dupes-v2`, and `/api/dupes-hash` stream their results through a chunked writer instead of building one large in-memory string (the response schema is unchanged).
- **Frontend rendering**: the App shell is decoupled from tree churn via a new `useWorkbench` external store (`useSyncExternalStore`), so expand/scroll/filter no longer re-render the title bar, menus, or side-bar shell; the Explorer side-bar folder tree is virtualized; the heavy visible-row and `dirCache` recomputes run in a deferred, interruptible render so typing, Expand All, and sorting stay responsive on large trees; menus and filter normalization are memoized; and the 3D treemap modal is code-split out of the main bundle.

### Fixed

- **Live scan progress**: the scan loading screen advances again. `/api/scan-stream` was emitting progress events without the `type` discriminator the renderer's parser expects, so the file counter stayed at 0 for the whole scan; progress lines now carry `{ "type": "scanning", ... }`.
- **Reparse-point junctions**: scanning a folder that contains legacy Windows compatibility junctions (e.g. `Documents\My Music`, `My Pictures`, `My Videos`, which carry deny-read ACLs) no longer floods the Problems panel with `FindFirstFileExW failed: error 5`. Directory reparse points are detected (`FILE_ATTRIBUTE_REPARSE_POINT` / symlink metadata) and shown as 0-byte junctions without being recursed into, avoiding the access-denied errors and double-counting against the real Music/Pictures/Videos folders.

### Removed

- The focus-ring highlight drawn over the selected editor pane when the view is split.

---

## [1.2.0] - 2026-06-01

### Added

#### AI Assistant
- **Approval-gated `run_command` tool**: the Action agent can run shell commands through a new `POST /api/run-command` endpoint, which executes via `std::process::Command` (`powershell -NoProfile -NonInteractive -Command` by default, or `cmd /C` when `shell: "cmd"`), drains stdout/stderr on background threads, enforces a 30-second default wall-clock timeout (clamped 1s–600s, killing overruns), and caps each stream at 64 KB — returning `{ ok, exit_code, stdout, stderr, truncated }`. Every command **requires explicit approval and can never be auto-approved or allowlisted** (`ALWAYS_APPROVE_TOOLS`); the exact command, captured stdout/stderr, and real exit code are shown in the approval card and in chat for verification.
- **Recycle Bin deletes**: the assistant removes files and folders to the Windows Recycle Bin via a `Microsoft.VisualBasic.FileIO.FileSystem` (`SendToRecycleBin`) PowerShell recipe, so AI-driven deletions are recoverable.

#### Drag-and-drop
- **Folder drag parity with files**: folders and mixed file+folder selections now use the native Windows shell drag (`SHDoDragDrop`). A folder can be dragged out to Explorer/the desktop as a true move (the source directory is removed via the shell `IFileOperation`), dropped onto another folder row across split panes for an internal move, and dragged to the tab bar to open it in a new tab.

### Changed

- The AI assistant treats an **attached folder as an isolated scope**: `ChatPanel` pre-scans the attached directories and builds a scoped `AgentApi` (overriding `getNodes`/`getScanResult`/`getScanPath`/`findDuplicates`) that every tool and the scan summary run against, without disturbing the open tabs.
- Folder and mixed-selection drags route through the native shell drag instead of the HTML5-only path; the tree invalidates its cache and rescans after an external folder move so it reflects the change.
- Treemap folder moves are routed through `/api/move-items` (via the shared internal-move handler), gaining the same conflict/merge handling as the tree table.

### Fixed

- **AI scope**: the assistant now scans and operates on the folder you attached rather than the focused tab's scan, so duplicate-finding and file operations target the right directory.
- **AI deletes**: deletions requested of the assistant now actually execute and report their real exit code instead of silently failing while claiming files were "moved to Recycle Bin".
- **Treemap move**: dragging a folder onto a treemap tile no longer fails with a 405 — it is routed through the whitelisted `/api/move-items` route.

### Removed

- The broken `delete_items` AI tool, which permanently hard-deleted files, swallowed failures, and falsely reported "moved to Recycle Bin" — superseded by the approval-gated `run_command` Recycle Bin recipe.

---

## [1.1.0] - 2026-06-01

### Added

#### Duplicates Finder (dupeGuru-style)
- **Dedicated Duplicates view**: a new activity-bar entry opens a duplicate-finder workspace with its own configuration side bar and a results table in the editor area, replacing the older in-tab duplicate finder.
- **Multi-root, content-verified detection**: scan one or more roots and confirm matches by actual file content, not just size or name. A new `POST /api/dupes-hash` endpoint buckets files by size, hashes collisions in parallel (FNV sample hash → full hash), and can finish with an optional byte-for-byte confirmation pass to eliminate false positives.
- **Persistent content-hash cache**: computed hashes are cached at `%APPDATA%\FileTree\hash_cache.json` and reused across scans, so repeat runs skip re-hashing unchanged files.
- **Composable match criteria**: combine Content, Size, Name, and Date rules — each independently markable as *required* — with a fuzzy-name similarity threshold and a configurable date tolerance.
- **Filters**: narrow a run by path, extension, and size before hashing.
- **Delta-scored results table**: a virtualized table shows an overall **Match %** plus per-criterion deltas, with **Dupes-only** and **Δ-values** toggles, in-table search, resizable and sortable columns, and a **Columns** menu.
- **Batch operations**: delete, move, copy, make-reference, and export selected duplicates, plus reveal-in-Explorer — all driven from the results table.

#### Terminal
- **Copy and paste in the integrated terminal**: Ctrl+C copies the current selection (and still sends ^C/SIGINT when nothing is selected), Ctrl+Shift+C always copies, and Ctrl+V / Ctrl+Shift+V paste the clipboard into the shell.
- **Right-click context menu** on a terminal with Copy (shown only when there is a selection) and Paste.
- Clipboard access uses the renderer's async Clipboard API with an Electron IPC bridge fallback (`copyText` / `clipboardReadText`), failing gracefully when the clipboard is unavailable.

#### Packaging
- **One-step Windows distributables** via `electron-builder` (`npm run package` in `electron/`): a portable `.exe` and an NSIS installer. The Rust backend (`filetree.exe`) is bundled as an app resource and the main process resolves it from `process.resourcesPath` when packaged, so end users need no Node, Rust, or build scripts installed.

### Changed

- The mutating Duplicates routes (`POST /api/dupes-hash`, `/api/dupes-action`, `/api/dupes-make-ref`, `/api/dupes-cancel`, and `DELETE /api/dupes-ignore`) are now correctly whitelisted by the request router instead of being rejected as GET-only.
- Rebuilt and re-embedded the frontend bundle (`frontend/dist`) so the shipped UI matches the current source.

### Fixed

- Duplicate actions now invalidate both the server-side scan cache and the content-hash cache for the affected paths, so results no longer reference files that were just moved or deleted.
- Name-column resizing in the tree table no longer jumps or fights the surrounding columns.

### Removed

- The old, unmounted `DuplicateFinder.tsx` component, superseded by the dedicated Duplicates view (`DuplicatesConfigPanel` + `DuplicatesResults`, backed by the `useDuplicates` hook and `duplicatesEngine`).

---

## [1.0.0] - 2026-05-31

### Added

#### AI Assistant (multi-agent)
- **Explicit multi-agent system**: an Orchestrator coordinates two specialized sub-agents — a read-only **Search** agent that investigates the scan and a mutating **Action** agent that performs file operations.
- **Two-tier approval workflow**: a Tier-1 plan-approval card gates handing work to the Action agent, and a Tier-2 action card gates each individual mutating operation — replacing the previous in-chat verbal confirmations.
- **Persistent per-tool allowlist**: a Cursor-style "Always allow" option remembers approved tools (machine-local) so they run without a card on later calls, alongside a **Skip** option that cleanly declines a single step; allowlisted tools are managed from the assistant's settings dialog.
- **Persistent chat history**: assistant conversations are saved as sessions and can be restored from the title bar.
- Model picker spanning local Ollama and cloud providers (OpenAI, Anthropic) with machine-local API keys.
- Markdown rendering of assistant replies.
- Visible "thinking" indicators with collapsible reasoning blocks.
- Multimodal image input to attach pictures as context for a question.

#### Configure Columns
- **TreeSize-style Configure Columns menu**, reachable from the per-pane editor toolbar ("Columns") and from the title-bar **View** menu — both share the same control.
- Expanded column set grouped into **Common**, **Date and time**, and **Extended**: Full Path, Folder Path, Type, Attributes, Creation/Last Accessed/Last Modified dates, Avg. File Size, Path Length, Dir Level, and Compression.
- **Decimal-places** control (0–5) and an **Automatic Units** toggle.
- **Reset Columns** restores the default details list.
- Owner, Author, File Version, Description, and Permissions are listed but disabled, pending scanner support.

#### Split view
- **VS Code-style split editor panes**: multiple resizable editor groups, each with its own tab bar.
- A single shared left **Explorer** side bar across all panes, driven by the focused pane's active tab.
- Drag tabs to reorder within a group or move them across editor groups; a **Split editor right** button on the tab strip opens a new pane.
- Per-editor-group **toolbar hide/show** toggle on the tab strip.

### Changed

- Removed the redundant AI chat icon from the activity bar; the assistant is now toggled from the title bar.
- View preferences (visible columns, decimal places) and the split-pane layout now persist across sessions (`visibleColumns`, `decimals`, and `paneGroups` in settings).
- Rebuilt and re-embedded the frontend bundle (`frontend/dist`) so the shipped UI matches the current source.

### Fixed

#### AI Assistant
- The assistant no longer fabricates file names or sizes: requests that need real data now force a read-only Search investigation so replies reflect the actual scan.
- Fixed the assistant quitting early or returning a blank turn — real findings gathered mid-run are returned if the model stalls, a notice is shown when the step budget is exhausted, and the Orchestrator is nudged once to follow through on an action request after Search locates the files.
- Transient process notices (retries, forced steps, step-limit, empty-response, and guard nudges) are now cleared when a turn ends, leaving the final answer, the step timeline, and any genuine errors.

#### Stability
- The Electron main process no longer crashes with a fatal error dialog on benign broken-pipe errors (EPIPE/ECONNRESET/EOF) from its own stdout/stderr or from the Rust server's pipes during shutdown.
- The tree table header and rows now render from a single dynamic column-grid template, fixing header/row misalignment at narrow widths or with non-default column counts.

---

## [0.2.0] - 2026-05-26

### Added

#### Web UI (React + TypeScript frontend)
- Complete rewrite of the browser UI in React + TypeScript (Vite + TSC build), replacing the original vanilla JS `web/` surface.
- Multi-tab workspace: open multiple directories simultaneously, each scanning independently in parallel.
- **Real-time filesystem watch**: backend streams `ReadDirectoryChangesW` events over SSE (`/api/fs-events`); new files and folders appear in the tree within ~100 ms of being created, moved, or deleted — no manual refresh needed.
- **Incremental directory patching**: watch-triggered updates rescan only the changed directory (`maxDepth=1`, ~50 ms) and graft results into the live tree without blanking the view.
- **Smart refresh**: manual Refresh on an already-scanned path preserves expanded folder state.
- Treemap visualization (recursive binary-split layout) in bottom-panel and right-panel modes; drag-resize handle.
- Interactive 3D treemap modal.
- Ribbon toolbar with Scan, Stop, Refresh, metric/unit selectors, expand controls, hidden-file toggle, symlink toggle, and New Folder.
- Path bar with drive picker and special-folder shortcuts (Desktop, Documents, Downloads, Pictures, Videos).
- Tab strip side panel: Details, Extensions, Age Distribution, Top Files, Duplicates, Errors, Bookmarks, AI Chat.
- **Details tab**: size, allocated, file/folder counts, last modified, path, extension, open/reveal/copy-path actions.
- **Extensions tab**: breakdown by file extension with size bars.
- **Age tab**: file age bucket histogram (< 1 week through > 2 years).
- **Top Files tab**: largest files in the scan with navigate-to action.
- **Duplicates tab**: candidate duplicate groups and exact-match finder.
- **Bookmarks tab**: pin paths for fast navigation; persisted via `/api/bookmarks`.
- **AI Chat tab**: embedded Ollama chat against the current scan tree with model picker and streaming responses.
- **Duplicate Finder**: full-featured dedupe workflow with filter controls, mode selection, and batch delete/move/copy actions.
- Filter dialog with multi-rule include/exclude patterns applied to the tree table in real time.
- Column visibility controls (Size, Allocated, File Count, % of Parent, Last Modified, Path).
- Sort by any column, ascending or descending.
- Shell context menu integration via right-click (Windows Explorer context menu at cursor).
- Ctrl+click on a directory row opens it in a new tab.
- Double-click to expand/collapse directories or open files.
- Client-side scan result cache with per-path TTL; bypassed for watch-triggered rescans.
- Dark mode follows system setting; togglable from the ribbon.

#### Backend
- **`/api/fs-events`**: SSE endpoint using `ReadDirectoryChangesW` with overlapped I/O and 500 ms keep-alive pings. Falls back to 1-second mtime polling on non-Windows.
- **`/api/scan` (sync)**: non-streaming scan endpoint for shallow/incremental rescans; `nocache=1` param bypasses the 5-minute server-side cache.
- **`/api/scan-stream`**: NDJSON streaming endpoint (replaces the original `/api/scan`).
- **`/api/watch`**: POST-based mtime batch check for polling-based watch.
- **`/api/duplicates` / `/api/dupes-scan` / `/api/dupes-v2`**: exact and fuzzy duplicate detection with FNV-1a hashing, filter params, and grouping.
- **`/api/dupes-action`**: batch delete/move/copy on duplicate groups.
- **`/api/special-folders`**: returns OS shell known-folder paths.
- **`/api/bookmarks`**: GET/POST bookmark list persisted to `%APPDATA%\FileTree\bookmarks.json`.
- **`/api/settings`**: GET/POST JSON settings store (`%APPDATA%\FileTree\settings.json`) — dark mode, threads, sort, open tabs, last path.
- **`/api/mkdir`**: create a new directory.
- **`/api/move`**: rename or move a file or directory.
- **`/api/shell-context-menu`**: invoke the Windows Shell context menu at screen coordinates.
- **`/api/ai-models`** / **`/api/ai-chat`**: proxy to a local Ollama instance for AI chat with streaming.
- **`/api/dupes-progress`**: real-time progress for long-running duplicate scans.
- Server-side 5-minute scan result cache with path-keyed invalidation on destructive operations.
- WebView2 embedding: the React frontend is hosted in a `WebView2` control inside the native Win32 window.

#### Native Desktop (Win32)
- Source decomposed into `src/desktop/` sub-modules: `mod.rs`, `ffi.rs`, `paint.rs`, `theme.rs`, `tabs.rs`, `state.rs`, `shell.rs`, `icons.rs`.
- Custom tab strip (`FileTreeTabStrip` window class) with keyboard/click switching and `ActiveTab` enum.
- Owner-drawn menu bar with theme-matched colors for dark and light palettes.
- Custom status footer bar (`msctls_statusbar32`) with formatted scan stats.
- Path bar (`ComboBoxEx32` + `SHAutoComplete`) for path history and filesystem autocomplete.
- Drive picker combo box.
- Single-instance enforcement via named mutex + `WM_COPYDATA` re-focus.
- Per-HWND dark mode; pre-window bootstrap eliminates first-paint flash.
- Persistent window geometry restore from settings.
- Bootstrap Icons 1.11.3 TTF embedded as a binary asset and loaded via `AddFontMemResourceEx`.
- DPI-aware primitives and accent-color luminance helpers for theming.

#### Source Refactors
- `src/main.rs` decomposed into focused modules: `model`, `scan`, `server`, `export`, `analytics`, `io`, `cli`, `settings`, `dupes`.
- `src/dupes.rs`: exact and fuzzy duplicate engine.
- `src/settings.rs`: atomic JSON settings store with typed `SettingsStore`.
- `src/analytics.rs`: extension stats, age buckets, top-N files, largest-dir ranking.

### Removed

- `web/` (vanilla JS / HTML / CSS single-file UI) — replaced by the React frontend in `frontend/`.

### Fixed

- Manual Refresh no longer collapses expanded folders.
- Watch-triggered refresh no longer overwrites newly detected files with stale full-tree data.
- `reconstructChildren` applied to shallow-rescan results before grafting into the tree.
- Ancestor size and file-count recalculation in `patchDirectory` corrected (was double-counting files).
- Server-side scan cache bypassed for watch-triggered incremental rescans.
- `maxdepth` query parameter accepted in both lowercase and camelCase forms.

---

## [0.1.0] - 2026-05-22

### Added

- Native Windows desktop disk-usage explorer.
- Threaded recursive scanner with live progress updates.
- Tree-style size table with folder/file counts, allocated size, percent-of-parent bars, and modified dates.
- Directory picker, refresh, stop scan, expand/collapse, path column, hidden-file, file visibility, symlink, and dark-mode controls.
- Shell icons for folders and file types.
- JSON and CSV CLI scan exports.
- Root Git project layout for `Danny213123/FileTree`.
