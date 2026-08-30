# FileTree v2 Performance Gates

Production `2.0.0` is blocked until every gate below is recorded against a release build from `D:\FileTree`.

| Workload | Aggregate FileTree + descendant WebView2 private bytes |
| --- | ---: |
| Settled idle | 200 MiB maximum |
| 100,000-file scan | 200 MiB maximum |
| 1,000,000-file scan | 350 MiB maximum |
| 10,000,000-file scan | 500 MiB maximum |

HandBrake, ffmpeg, and ImageMagick are reported separately. Their memory must remain bounded during an eight-hour two-worker compression soak.

Run the harness against an existing process:

```powershell
.\scripts\measure-v2-memory.ps1 -ProcessId 1234 -DurationMinutes 10 -MaxMiB 200
```

Or let it launch a release build:

```powershell
.\scripts\measure-v2-memory.ps1 -LaunchPath .\target\release\FileTree.exe -DurationMinutes 10 -MaxMiB 200
```

Required release evidence also includes 100 tab open/close cycles, 50 rescans, repeated search/sort/filter and thumbnail churn, a 200,000-file compression run, eight-hour scan/compression soaks, and recovery to within 15% of the post-start baseline within five minutes of closing work.

## Current Alpha Evidence

| Build | Workload | Settled peak | Final | Result | Evidence |
| --- | --- | ---: | ---: | --- | --- |
| `2.0.0-alpha.1` bounded-startup candidate | Idle, two-minute sample after 30-second warmup | 238.4 MiB | 237.8 MiB | **Fail** | `artifacts/memory-idle-alpha1-bounded.csv` |
| `2.0.0-alpha.1` SQLite-restore candidate | Clean profile, one-minute smoke sample after 30-second warmup | 136.26 MiB | 134.42 MiB | **Pass (smoke)** | `artifacts/memory-idle-alpha1-clean-v4.csv` |

The clean-profile final sample was approximately 9.5 MiB in `FileTree.exe` and 124.9 MiB across six descendant WebView2 processes. It created only the 72 KiB v2 state database and no scan database. The older bounded-startup sample restored active scan tabs, so it remains useful diagnostic history but is not idle evidence. The earlier unbounded-manifest build peaked at 580.15 MiB during startup; the bounded 8 KiB manifest-status probe removed that spike.

The harness validates parent and child creation times because Windows can reuse a dead parent's PID for an unrelated process while stale `ParentProcessId` values still exist. It also invalidates a run if FileTree exits before the deadline instead of treating missing processes as zero memory. Production remains blocked until a release build passes the full ten-minute idle gate and every scan, soak, migration, and recovery gate above.
