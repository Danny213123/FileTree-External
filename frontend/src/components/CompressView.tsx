import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  NodeRecord,
  CompressTools,
  CompressPreset,
  CompressKind,
  CompressEvent,
  CompressJob,
  CompressJobSummary,
  CompressLogRow,
} from "../api/types";
import {
  fetchCompressTools,
  installCompressTool,
  startCompressJob,
  cancelCompressJob,
  retryCompressJob,
  fetchCompressJob,
  streamCompressJob,
  listCompressJobs,
  shellContextMenu,
  openPath,
  revealPath,
  fetchCompressLog,
  compressLogPath,
  compressLogCsvUrl,
  compressDebugPath,
  compressDebugLogUrl,
} from "../api/client";
import { invalidateAll as invalidateAllScanCache } from "../lib/scanCache";
import { formatBytes } from "../utils/formatBytes";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

// Compression page (media re-encode + zip, with live jobs).
//
// Derives the compressible files from the focused pane's scan tree (nodeById),
// groups them by pipeline type (Video / Images / Other), and lets the user pick
// a quality preset + options before kicking off a backend job. The job streams
// per-file + overall progress over NDJSON (with a poll fallback), can be
// hard-cancelled and retried (resumes, skipping done files), and on completion
// rescans the tree so the [COMPRESSED] outputs appear and recycled originals
// disappear. The whole page degrades gracefully when an encoder is missing:
// zip is always available, and missing-tool types are simply skipped.

const GROUP_ROW_H = 30;
const FILE_ROW_H = 28;

const KIND_ORDER: CompressKind[] = ["video", "image", "other"];
const KIND_LABEL: Record<CompressKind, string> = {
  video: "Video",
  image: "Images",
  other: "Other",
};

const PRESETS: { id: CompressPreset; label: string }[] = [
  { id: "max", label: "Maximum savings" },
  { id: "balanced", label: "Balanced" },
  { id: "high", label: "High quality" },
];

type TypeFilter = "all" | CompressKind;
type RunStatus = "idle" | "running" | "done" | "cancelled" | "error";
type FileStatus = "pending" | "running" | "done" | "error" | "skipped";

/** A compressible file derived from the scan tree. */
interface CompressFile {
  id: number;
  path: string;
  name: string;
  size: number;
  kind: CompressKind;
}

/** Live per-file progress within a job, keyed by the server's `index`. */
interface FileProg {
  index: number;
  path: string;
  name: string;
  kind: CompressKind;
  origBytes: number;
  status: FileStatus;
  pct: number;
  newBytes: number;
  savedBytes: number;
  error?: string;
}

type Row =
  | { type: "group"; key: string; label: string; count: number; size: number }
  | { type: "file"; key: string; file: CompressFile }
  | { type: "runfile"; key: string; rf: FileProg };

type CompressTab = "compress" | "progress" | "history";

interface CompressViewProps {
  /** Current scan root (for the empty state + nocache rescan). */
  scanPath: string;
  /** The actual scanned root the file tree was built from (`data.rootPath`).
   *  This is the genuine ancestor of every file in `nodeById`, so it is the
   *  correct directory to re-assert as an allowed scan root when starting a
   *  job — unlike `scanPath`, which is the path-input/current-location value
   *  and can point somewhere that doesn't contain the selected files. */
  scannedRoot?: string;
  /** The focused pane's scan tree — the source of compressible files. */
  nodeById: Map<number, NodeRecord>;
  /** Reveal + select a node in the tree. */
  onNavigate: (id: number) => void;
  /** Refresh the focused pane's tree (used after a run completes). */
  onRescan: () => void;
  /** Paths to pre-check when opened from the table's "Compress..." action. */
  initialSelectedPaths?: string[];
  /** Called once the initial paths have been applied so the parent can clear
   *  them (keeps manual edits sticky across re-renders / view switches). */
  onInitialApplied?: () => void;
}

// Pipeline classification MUST mirror the backend `classify()` in
// src/compress_job.rs (audio folds into the HandBrake/video pipeline; svg/avif/
// heic are zipped as "other"). The app-wide isImage/isVideo thumbnail sets
// diverge from this, so we keep dedicated sets here: otherwise the encoder
// availability gating would mislabel files (e.g. let an mp3 through as zip-able
// "other" when the backend would route it to HandBrake and error).
const COMPRESS_VIDEO_EXTS = new Set([
  "mp4", "mkv", "mov", "avi", "wmv", "flv", "webm", "m4v", "mpg", "mpeg",
  "mp3", "wav", "flac", "aac", "ogg", "m4a",
]);
const COMPRESS_IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "gif",
]);

function classifyKind(ext: string): CompressKind {
  const e = ext.toLowerCase();
  if (COMPRESS_VIDEO_EXTS.has(e)) return "video";
  if (COMPRESS_IMAGE_EXTS.has(e)) return "image";
  return "other";
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Case-insensitive, separator- and trailing-slash-normalized path key, so the
 *  selection passed from the table matches the scan tree's reconstructed paths
 *  regardless of slash direction or drive-letter casing on Windows. */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function CompressView({
  scanPath,
  scannedRoot,
  nodeById,
  onNavigate,
  onRescan,
  initialSelectedPaths,
  onInitialApplied,
}: CompressViewProps) {
  const [tab, setTab] = useState<CompressTab>("compress");
  const [tools, setTools] = useState<CompressTools | null>(null);
  const [preset, setPreset] = useState<CompressPreset>("balanced");
  const [recycleOriginals, setRecycleOriginals] = useState(true);
  const [tagFilename, setTagFilename] = useState(true);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [installing, setInstalling] = useState<"handbrake" | "image" | null>(null);
  // Non-blocking notice when some right-click-selected paths aren't in the scan.
  const [preselectNotice, setPreselectNotice] = useState("");
  // Pre-flight notice listing files dropped before a run started because they no
  // longer exist in the (refreshed) tree or are already [COMPRESSED] outputs —
  // so a re-compress over a recycled folder doesn't look like a random error.
  const [preflightNotice, setPreflightNotice] = useState("");
  // Scoped mode: when launched from the table ("Compress…" / row button), the
  // file list is restricted to just the launched selection (a set of normalized
  // file paths). null = unscoped (opened from the activity bar) → show every
  // compressible file in the scan. Cleared via the "Show all files" escape hatch.
  const [scopePaths, setScopePaths] = useState<Set<string> | null>(null);

  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [progress, setProgress] = useState<Map<number, FileProg>>(new Map());
  const [jobId, setJobId] = useState<string | null>(null);
  const [runError, setRunError] = useState("");
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const finalizedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Tool detection ─────────────────────────────────────────────────────────
  const refreshTools = useCallback(async (signal?: AbortSignal) => {
    const t = await fetchCompressTools(signal);
    if (!signal?.aborted) setTools(t);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void refreshTools(ac.signal);
    return () => ac.abort();
  }, [refreshTools]);

  // Abort the stream + stop polling on unmount.
  useEffect(() => () => {
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, []);

  // ── Source files (derived from the scan tree) ───────────────────────────────
  // In scoped mode only the launched selection's files are visible; otherwise
  // every compressible file in the scan is listed. Everything downstream
  // (counts, groups, select-all, totals) keys off this list, so scoping here is
  // enough to make the whole view reflect just the selection.
  const files = useMemo(() => {
    const out: CompressFile[] = [];
    for (const node of nodeById.values()) {
      if (node.dir || node.id < 0 || !node.path) continue;
      if (scopePaths && !scopePaths.has(normPath(node.path))) continue;
      out.push({
        id: node.id,
        path: node.path,
        name: node.name,
        size: node.size,
        kind: classifyKind(node.extension ?? ""),
      });
    }
    return out;
  }, [nodeById, scopePaths]);

  // Launch from the table ("Compress…" / row button): scope the view to just the
  // launched selection and pre-check it. The incoming paths are already concrete
  // files (WorkspaceTab BFS-expands folders to their descendants before sending),
  // so we map each to its id in the FULL scan, build the scope from the ones we
  // found, and surface a non-blocking notice for any that aren't in the scan.
  // Applied once per request — the parent clears `initialSelectedPaths` via
  // onInitialApplied, so manual edits (and the "Show all files" escape hatch)
  // stick afterward. Matches against the unscoped tree so it's idempotent.
  useEffect(() => {
    if (!initialSelectedPaths || initialSelectedPaths.length === 0) return;
    if (nodeById.size === 0) return; // wait until the tree is loaded
    const idByPath = new Map<string, number>();
    for (const node of nodeById.values()) {
      if (node.dir || node.id < 0 || !node.path) continue;
      idByPath.set(normPath(node.path), node.id);
    }
    const scope = new Set<string>();
    const ids: number[] = [];
    let missing = 0;
    for (const p of initialSelectedPaths) {
      const n = normPath(p);
      const id = idByPath.get(n);
      if (id !== undefined) {
        scope.add(n);
        ids.push(id);
      } else {
        missing += 1;
      }
    }
    // Only enter scoped mode when at least one selected file is in the scan;
    // if none matched, fall back to the full list and just show the notice.
    setScopePaths(scope.size > 0 ? scope : null);
    if (ids.length > 0) setSelected(new Set(ids));
    setPreselectNotice(
      missing > 0
        ? `${missing} selected file${missing === 1 ? "" : "s"} ${missing === 1 ? "isn't" : "aren't"} in the current scan and couldn't be included.`
        : "",
    );
    setTab("compress");
    onInitialApplied?.();
  }, [initialSelectedPaths, nodeById, onInitialApplied]);

  const counts = useMemo(() => {
    let video = 0, image = 0, other = 0;
    for (const f of files) {
      if (f.kind === "video") video++;
      else if (f.kind === "image") image++;
      else other++;
    }
    return { all: files.length, video, image, other };
  }, [files]);

  // A type's pipeline is available when its tool is present (zip is built-in).
  const kindAvailable = useCallback(
    (kind: CompressKind): boolean => {
      if (kind === "other") return true;
      if (!tools) return false;
      return kind === "video" ? tools.handbrake.found : tools.image.found;
    },
    [tools],
  );

  const filteredFiles = useMemo(
    () => (typeFilter === "all" ? files : files.filter((f) => f.kind === typeFilter)),
    [files, typeFilter],
  );

  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({
        kind,
        items: filteredFiles.filter((f) => f.kind === kind),
      })).filter((g) => g.items.length > 0),
    [filteredFiles],
  );

  const inRun = runStatus !== "idle";

  const progArr = useMemo(
    () => [...progress.values()].sort((a, b) => a.index - b.index),
    [progress],
  );

  // Overall progress: files finished / total + an aggregate percentage.
  const total = progArr.length;
  const doneCount = progArr.filter(
    (f) => f.status === "done" || f.status === "skipped" || f.status === "error",
  ).length;
  const aggregatePct = total
    ? Math.round(
        progArr.reduce(
          (s, f) =>
            s + (f.status === "done" || f.status === "skipped" || f.status === "error" ? 100 : f.pct),
          0,
        ) / total,
      )
    : 0;
  const savedTotal = progArr.reduce((s, f) => s + f.savedBytes, 0);

  const selectedFiles = useMemo(
    () => files.filter((f) => selected.has(f.id)),
    [files, selected],
  );
  const selectedBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
  const runnableSelected = useMemo(
    () => selectedFiles.filter((f) => kindAvailable(f.kind)),
    [selectedFiles, kindAvailable],
  );

  // ── List rows (virtualized) ─────────────────────────────────────────────────
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (inRun) {
      for (const kind of KIND_ORDER) {
        const items = progArr.filter((f) => f.kind === kind);
        if (!items.length) continue;
        out.push({
          type: "group",
          key: `g-${kind}`,
          label: KIND_LABEL[kind],
          count: items.length,
          size: items.reduce((s, f) => s + f.origBytes, 0),
        });
        for (const rf of items) out.push({ type: "runfile", key: `r-${rf.index}`, rf });
      }
    } else {
      for (const g of groups) {
        out.push({
          type: "group",
          key: `g-${g.kind}`,
          label: KIND_LABEL[g.kind],
          count: g.items.length,
          size: g.items.reduce((s, f) => s + f.size, 0),
        });
        for (const f of g.items) out.push({ type: "file", key: `f-${f.id}`, file: f });
      }
    }
    return out;
  }, [inRun, progArr, groups]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => (rows[i]?.type === "group" ? GROUP_ROW_H : FILE_ROW_H),
    overscan: 12,
  });

  // ── Selection helpers ───────────────────────────────────────────────────────
  const toggleFile = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((items: CompressFile[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = items.length > 0 && items.every((f) => next.has(f.id));
      if (allOn) for (const f of items) next.delete(f.id);
      else for (const f of items) next.add(f.id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(filteredFiles.map((f) => f.id)));
  }, [filteredFiles]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // ── Native shell context menu (mirrors the main table) ──────────────────────
  // Right-clicking a file row opens the same Windows shell menu the file table
  // uses. If the clicked row is part of a multi-selection, the menu acts on the
  // whole selection (scoped to the files currently visible here); otherwise just
  // the clicked row. Returned verbs (rename / delete / reveal / open-new-tab /
  // compress) are dispatched by the app-level handler in App.tsx, which rescans
  // the focused pane on a mutation — and since `files` is derived from that
  // pane's tree, this view stays in sync without any extra bookkeeping.
  const handleRowContextMenu = useCallback(
    (file: CompressFile, e: React.MouseEvent) => {
      e.preventDefault();
      const paths =
        selected.has(file.id) && selected.size > 1
          ? selectedFiles.map((f) => f.path)
          : [file.path];
      void shellContextMenu(paths, e.clientX, e.clientY);
    },
    [selected, selectedFiles],
  );

  // ── Job event handling ──────────────────────────────────────────────────────
  const finalize = useCallback(
    (status: RunStatus, savedBytes: number, done: number) => {
      if (finalizedRef.current) return;
      finalizedRef.current = true;
      setRunStatus(status);
      if (done > 0) {
        invalidateAllScanCache();
        onRescan();
      }
      if (status === "done") {
        toast.success(
          `Compression complete — saved ${formatBytes(savedBytes)} across ${done.toLocaleString()} file${done === 1 ? "" : "s"}.`,
        );
      }
    },
    [onRescan],
  );

  const handleEvent = useCallback(
    (ev: CompressEvent) => {
      switch (ev.type) {
        case "job_start":
          setRunStatus("running");
          break;
        case "file_start":
          setProgress((prev) => {
            const next = new Map(prev);
            const cur = next.get(ev.index);
            next.set(ev.index, {
              index: ev.index,
              path: ev.path,
              name: cur?.name ?? baseName(ev.path),
              kind: ev.kind,
              origBytes: ev.origBytes,
              status: "running",
              pct: 0,
              newBytes: 0,
              savedBytes: 0,
            });
            return next;
          });
          break;
        case "progress":
          setProgress((prev) => {
            const cur = prev.get(ev.index);
            if (!cur) return prev;
            const next = new Map(prev);
            next.set(ev.index, { ...cur, status: "running", pct: Math.max(0, Math.min(100, ev.pct)) });
            return next;
          });
          break;
        case "file_done":
          setProgress((prev) => {
            const cur = prev.get(ev.index);
            const next = new Map(prev);
            next.set(ev.index, {
              index: ev.index,
              path: cur?.path ?? "",
              name: cur?.name ?? baseName(cur?.path ?? ""),
              kind: cur?.kind ?? "other",
              origBytes: ev.origBytes,
              status: ev.status === "skipped_no_gain" ? "skipped" : "done",
              pct: 100,
              newBytes: ev.newBytes,
              savedBytes: ev.savedBytes,
            });
            return next;
          });
          break;
        case "error":
          setProgress((prev) => {
            const cur = prev.get(ev.index);
            const next = new Map(prev);
            next.set(ev.index, {
              index: ev.index,
              path: cur?.path ?? ev.path,
              name: cur?.name ?? baseName(ev.path),
              kind: cur?.kind ?? "other",
              origBytes: cur?.origBytes ?? 0,
              status: "error",
              pct: 100,
              newBytes: 0,
              savedBytes: 0,
              error: ev.error,
            });
            return next;
          });
          break;
        case "done":
          finalize("done", ev.savedBytes, ev.done);
          break;
      }
    },
    [finalize],
  );

  // Map a polled snapshot onto the per-file progress state (stream fallback).
  const applySnapshot = useCallback(
    (snap: CompressJob) => {
      setProgress((prev) => {
        const next = new Map(prev);
        for (const f of snap.files) {
          const cur = next.get(f.index);
          next.set(f.index, {
            index: f.index,
            path: f.path,
            name: cur?.name ?? baseName(f.path),
            kind: f.kind,
            origBytes: f.origBytes,
            status: f.status,
            pct: Math.max(0, Math.min(100, f.pct)),
            newBytes: f.newBytes,
            savedBytes: Math.max(0, f.origBytes - f.newBytes) || 0,
            error: f.error,
          });
        }
        return next;
      });
      if (snap.status !== "running") {
        const done = snap.files.filter((f) => f.status === "done" || f.status === "skipped").length;
        finalize(snap.status, snap.savedBytes, done);
      }
    },
    [finalize],
  );

  const pollJob = useCallback(
    (id: string, signal: AbortSignal) => {
      const tick = async () => {
        if (signal.aborted) return;
        const snap = await fetchCompressJob(id, signal);
        if (signal.aborted) return;
        if (!snap) {
          // Endpoint unavailable — surface a soft error and stop.
          if (!finalizedRef.current) {
            setRunStatus("error");
            setRunError("Lost connection to the compression job and could not poll its status.");
          }
          return;
        }
        applySnapshot(snap);
        if (snap.status === "running") {
          pollTimerRef.current = setTimeout(() => void tick(), 1000);
        }
      };
      void tick();
    },
    [applySnapshot],
  );

  const attachStream = useCallback(
    async (id: string) => {
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await streamCompressJob(id, handleEvent, ac.signal);
        if (ac.signal.aborted) return;
        // Stream ended without a terminal "done" event — reconcile via a poll.
        if (!finalizedRef.current) {
          const snap = await fetchCompressJob(id);
          if (snap) applySnapshot(snap);
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        // Stream errored — fall back to polling the job snapshot.
        void e;
        pollJob(id, ac.signal);
      }
    },
    [handleEvent, pollJob, applySnapshot],
  );

  // ── Run controls ────────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    const encoderRunnable = selectedFiles.filter((f) => kindAvailable(f.kind));
    if (encoderRunnable.length === 0) return;

    // Pre-flight stale-path guard: a previous run recycles originals and writes
    // `name [COMPRESSED].ext`, so a stale selection can still point at originals
    // that no longer exist, or at the [COMPRESSED] outputs themselves. Drop both
    // up front and explain it, instead of letting the backend emit a row of
    // confusing per-file "source missing" errors.
    //   - missing: the path is no longer present in the current scan tree
    //     (`nodeById`, the same source `files` is derived from).
    //   - already-compressed: the file name carries the `[COMPRESSED]` marker.
    const livePaths = new Set<string>();
    for (const node of nodeById.values()) {
      if (node.dir || node.id < 0 || !node.path) continue;
      livePaths.add(normPath(node.path));
    }
    const COMPRESSED_RE = /\[COMPRESSED\]/i;
    const missing = encoderRunnable.filter((f) => !livePaths.has(normPath(f.path)));
    const alreadyCompressed = encoderRunnable.filter(
      (f) => livePaths.has(normPath(f.path)) && COMPRESSED_RE.test(f.name),
    );
    const dropped = new Set<number>([
      ...missing.map((f) => f.id),
      ...alreadyCompressed.map((f) => f.id),
    ]);
    const runnable = encoderRunnable.filter((f) => !dropped.has(f.id));

    if (dropped.size > 0) {
      const parts: string[] = [];
      if (missing.length > 0) {
        parts.push(
          `${missing.length} no longer exist${missing.length === 1 ? "s" : ""} (recycled by a prior run?)`,
        );
      }
      if (alreadyCompressed.length > 0) {
        parts.push(
          `${alreadyCompressed.length} already-compressed output${alreadyCompressed.length === 1 ? "" : "s"}`,
        );
      }
      const sample = [...missing, ...alreadyCompressed].slice(0, 3).map((f) => f.name).join(", ");
      setPreflightNotice(
        `Skipped ${dropped.size} file${dropped.size === 1 ? "" : "s"} before starting: ${parts.join(", ")}${sample ? ` — e.g. ${sample}` : ""}.`,
      );
      // Refresh the tree so the next derived selection reflects reality.
      invalidateAllScanCache();
      onRescan();
    } else {
      setPreflightNotice("");
    }

    if (runnable.length === 0) {
      setRunStatus("idle");
      toast.info("Nothing to compress — all selected files were missing or already compressed.");
      return;
    }

    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    finalizedRef.current = false;
    setRunError("");

    const init = new Map<number, FileProg>();
    runnable.forEach((f, i) => {
      init.set(i, {
        index: i,
        path: f.path,
        name: f.name,
        kind: f.kind,
        origBytes: f.size,
        status: "pending",
        pct: 0,
        newBytes: 0,
        savedBytes: 0,
      });
    });
    setProgress(init);
    setRunStatus("running");

    const skipped = selectedFiles.length - encoderRunnable.length;
    if (skipped > 0) {
      toast.info(`Skipping ${skipped} file${skipped === 1 ? "" : "s"} whose encoder isn't installed.`);
    }

    try {
      const id = await startCompressJob({
        paths: runnable.map((f) => f.path),
        preset,
        recycleOriginals,
        tagFilename,
        // Re-assert the scan root so a cache-served tree (no /api/scan this
        // session) still passes the server's scan-root containment check. Use
        // the genuine scanned root (`data.rootPath`), which is guaranteed to be
        // the ancestor of every file in the list; `scanPath` is only the
        // path-input value and may not contain the selected files (e.g. after
        // navigating into a subfolder), which caused valid folder/file
        // selections to be rejected as "outside the scanned directories".
        scanRoot: scannedRoot || scanPath || undefined,
      });
      setJobId(id);
      void attachStream(id);
    } catch (e) {
      finalizedRef.current = true;
      setRunStatus("error");
      setRunError(e instanceof Error ? e.message : String(e));
      toast.error(`Could not start compression: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selectedFiles, kindAvailable, preset, recycleOriginals, tagFilename, attachStream, scanPath, scannedRoot, nodeById, onRescan]);

  const handleStop = useCallback(async () => {
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    finalizedRef.current = true;
    setRunStatus("cancelled");
    if (jobId) {
      const res = await cancelCompressJob(jobId);
      if (!res.ok) toast.error(res.error ?? "Could not cancel the job.");
    }
    // Some files may have completed before the stop — reflect them in the tree.
    if (progArr.some((f) => f.status === "done")) {
      invalidateAllScanCache();
      onRescan();
    }
  }, [jobId, progArr, onRescan]);

  const handleRetry = useCallback(async () => {
    if (!jobId) return;
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    finalizedRef.current = false;
    setRunError("");
    // Reset everything not already done back to pending; the backend resumes
    // skipping completed files.
    setProgress((prev) => {
      const next = new Map(prev);
      for (const [idx, f] of next) {
        if (f.status !== "done" && f.status !== "skipped") {
          next.set(idx, { ...f, status: "pending", pct: 0, newBytes: 0, savedBytes: 0, error: undefined });
        }
      }
      return next;
    });
    setRunStatus("running");
    try {
      const newId = await retryCompressJob(jobId);
      setJobId(newId);
      void attachStream(newId);
    } catch (e) {
      finalizedRef.current = true;
      setRunStatus("error");
      setRunError(e instanceof Error ? e.message : String(e));
      toast.error(`Could not restart: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [jobId, attachStream]);

  const resetRun = useCallback(() => {
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    finalizedRef.current = false;
    setRunStatus("idle");
    setProgress(new Map());
    setJobId(null);
    setRunError("");
  }, []);

  // ── Tool install ────────────────────────────────────────────────────────────
  const handleInstall = useCallback(async (tool: "handbrake" | "image") => {
    setInstalling(tool);
    try {
      const res = await installCompressTool(tool);
      if (res.ok) {
        toast.success(`Installed ${tool === "handbrake" ? "HandBrake" : "the image encoder"}.`);
        await refreshTools();
      } else if (res.downloadUrl) {
        toast.info("Opening the download page in your browser…");
        await openPath(res.downloadUrl);
      } else {
        toast.error(res.error ?? "Could not install the tool.");
      }
    } finally {
      setInstalling(null);
    }
  }, [refreshTools]);

  // Tool banner: which types are blocked by a missing encoder.
  const videoMissing = !!tools && !tools.handbrake.found && counts.video > 0;
  const imageMissing = !!tools && !tools.image.found && counts.image > 0;
  const showBanner = videoMissing || imageMissing;

  const FILTERS: { id: TypeFilter; label: string }[] = [
    { id: "all", label: `All (${counts.all.toLocaleString()})` },
    { id: "video", label: `Video (${counts.video.toLocaleString()})` },
    { id: "image", label: `Images (${counts.image.toLocaleString()})` },
    { id: "other", label: `Other (${counts.other.toLocaleString()})` },
  ];

  return (
    <div className="compress-view">
      <div className="compress-tabs" role="tablist" aria-label="Compress / In Progress / History">
        <button
          role="tab"
          aria-selected={tab === "compress"}
          className={`compress-tab${tab === "compress" ? " active" : ""}`}
          onClick={() => setTab("compress")}
        >
          Compress
        </button>
        <button
          role="tab"
          aria-selected={tab === "progress"}
          className={`compress-tab${tab === "progress" ? " active" : ""}`}
          onClick={() => setTab("progress")}
        >
          In Progress
        </button>
        <button
          role="tab"
          aria-selected={tab === "history"}
          className={`compress-tab${tab === "history" ? " active" : ""}`}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "progress" ? (
        <CompressInProgress />
      ) : tab === "history" ? (
        <CompressHistory />
      ) : !scanPath ? (
        <EmptyState
          icon="file-zip"
          title="No scan loaded"
          hint="Scan a folder or drive in the Explorer side bar, then return here to compress media and other files."
        />
      ) : (
      <>
      {scopePaths && !inRun && (
        <div className="compress-notice scoped">
          <span className="ct-ico"><Icon name="funnel" size={14} /></span>
          <span>
            Compressing <b>{files.length.toLocaleString()}</b> selected item{files.length === 1 ? "" : "s"}.
          </span>
          <button
            className="compress-scope-clear"
            onClick={() => { setScopePaths(null); setPreselectNotice(""); }}
            title="Show every compressible file in the scan instead"
          >
            Show all files
          </button>
        </div>
      )}
      {preselectNotice && (
        <div className="compress-notice">
          <span className="ct-ico"><Icon name="info-circle" size={14} /></span>
          <span>{preselectNotice}</span>
          <button className="compress-notice-x" onClick={() => setPreselectNotice("")} title="Dismiss">×</button>
        </div>
      )}
      {preflightNotice && (
        <div className="compress-notice">
          <span className="ct-ico"><Icon name="info-circle" size={14} /></span>
          <span>{preflightNotice}</span>
          <button className="compress-notice-x" onClick={() => setPreflightNotice("")} title="Dismiss">×</button>
        </div>
      )}
      {showBanner && (
        <div className="compress-tools-banner">
          <span className="ct-ico"><Icon name="warning" size={15} /></span>
          <span className="compress-tools-text">
            {videoMissing && imageMissing
              ? <>HandBrake (for <b>video</b>) and an image encoder (for <b>images</b>) aren't installed. </>
              : videoMissing
                ? <>HandBrake isn't installed, so <b>video</b> files can't be re-encoded. </>
                : <>No image encoder was found, so <b>images</b> can't be re-encoded. </>}
            Other files are still zipped losslessly.
          </span>
          <span className="compress-tools-actions">
            {videoMissing && (
              <button
                className="compress-btn"
                disabled={installing !== null}
                onClick={() => void handleInstall("handbrake")}
              >
                {installing === "handbrake" ? "Installing…" : "Install HandBrake"}
              </button>
            )}
            {imageMissing && (
              <button
                className="compress-btn"
                disabled={installing !== null}
                onClick={() => void handleInstall("image")}
              >
                {installing === "image" ? "Installing…" : "Install image encoder"}
              </button>
            )}
          </span>
        </div>
      )}

      <div className="compress-toolbar">
        <div className="compress-group" role="tablist" aria-label="Quality preset">
          <span className="compress-group-label">Preset</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={preset === p.id}
              className={`compress-chip${preset === p.id ? " active" : ""}`}
              onClick={() => setPreset(p.id)}
              disabled={inRun}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="compress-toggle">
          <input
            type="checkbox"
            checked={recycleOriginals}
            disabled={inRun}
            onChange={(e) => setRecycleOriginals(e.target.checked)}
          />
          Recycle originals
        </label>
        <label className="compress-toggle">
          <input
            type="checkbox"
            checked={tagFilename}
            disabled={inRun}
            onChange={(e) => setTagFilename(e.target.checked)}
          />
          Add [COMPRESSED] tag
        </label>

        <div className="compress-toolbar-spacer" />

        {!inRun && (
          <>
            <button className="compress-btn" onClick={selectAll} disabled={filteredFiles.length === 0}>
              Select all
            </button>
            <button className="compress-btn" onClick={clearSelection} disabled={selected.size === 0}>
              Clear
            </button>
            <button
              className="compress-btn primary"
              onClick={() => void handleStart()}
              disabled={runnableSelected.length === 0}
              title={
                runnableSelected.length === 0
                  ? "Select at least one file whose encoder is available"
                  : `Compress ${runnableSelected.length} file(s)`
              }
            >
              <Icon name="file-zip" size={13} /> Compress {runnableSelected.length > 0 ? `(${runnableSelected.length})` : ""}
            </button>
          </>
        )}
        {runStatus === "running" && (
          <button className="compress-btn danger" onClick={() => void handleStop()}>
            <Icon name="stop-fill" size={13} /> Stop
          </button>
        )}
        {(runStatus === "done" || runStatus === "cancelled" || runStatus === "error") && (
          <>
            <button className="compress-btn" onClick={resetRun}>
              <Icon name="chevron-left" size={13} /> New selection
            </button>
            <button className="compress-btn primary" onClick={() => void handleRetry()} disabled={!jobId}>
              <Icon name="arrow-repeat" size={13} /> {runStatus === "done" ? "Run again" : "Retry"}
            </button>
          </>
        )}
      </div>

      {inRun && (
        <div className="compress-overall">
          <span className="compress-overall-text">
            <b>{doneCount.toLocaleString()}</b> / {total.toLocaleString()} files
          </span>
          <div className="compress-bar" title={`${aggregatePct}%`}>
            <div className="compress-bar-fill" style={{ width: `${aggregatePct}%` }} />
          </div>
          <span className="compress-overall-text">
            {aggregatePct}% · saved <span className="compress-saved">{formatBytes(savedTotal)}</span>
          </span>
        </div>
      )}

      {!inRun && (
        <div className="compress-toolbar">
          <div className="compress-summary">
            {selected.size > 0 ? (
              <>
                <span className="compress-total">{formatBytes(selectedBytes)}</span>
                <span className="compress-total-label">selected</span>
                <span className="compress-selected">
                  {selected.size.toLocaleString()} file{selected.size === 1 ? "" : "s"}
                </span>
              </>
            ) : (
              <span className="compress-total-label">Select files to compress</span>
            )}
          </div>
          <div className="compress-toolbar-spacer" />
          <div className="compress-group" role="tablist" aria-label="Filter by type">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={typeFilter === f.id}
                className={`compress-chip${typeFilter === f.id ? " active" : ""}`}
                onClick={() => setTypeFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="compress-body" ref={setScrollEl}>
        {runStatus === "error" && runError && (
          <EmptyState icon="warning" title="Compression failed" hint={runError} error />
        )}

        {!inRun && files.length === 0 && (
          <EmptyState
            icon="file-zip"
            title="Nothing to compress"
            hint="This scan has no files. Scan a folder with media or documents to compress them here."
          />
        )}

        {!inRun && files.length > 0 && filteredFiles.length === 0 && (
          <EmptyState icon="funnel" title="No matching files" hint="No files match the current type filter." />
        )}

        {!(runStatus === "error" && runError) && rows.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              const common = {
                position: "absolute" as const,
                top: vi.start,
                left: 0,
                right: 0,
                height: vi.size,
              };

              if (row.type === "group") {
                // In selection mode the header carries a select-all checkbox for
                // its group; in run mode it's a plain label.
                const groupItems = inRun ? [] : (groups.find((g) => KIND_LABEL[g.kind] === row.label)?.items ?? []);
                const allOn = groupItems.length > 0 && groupItems.every((f) => selected.has(f.id));
                const someOn = !allOn && groupItems.some((f) => selected.has(f.id));
                return (
                  <div key={row.key} className="compress-group-row" style={common}>
                    {!inRun && (
                      <input
                        type="checkbox"
                        className="compress-check"
                        checked={allOn}
                        ref={(el) => { if (el) el.indeterminate = someOn; }}
                        onChange={() => toggleGroup(groupItems)}
                        title="Select / clear this group"
                      />
                    )}
                    <span className="compress-group-label-row">
                      {row.label}
                      <span className="compress-group-count">{row.count.toLocaleString()} file{row.count === 1 ? "" : "s"}</span>
                    </span>
                    <span className="compress-group-size">{formatBytes(row.size)}</span>
                  </div>
                );
              }

              if (row.type === "file") {
                const f = row.file;
                const isChecked = selected.has(f.id);
                const avail = kindAvailable(f.kind);
                return (
                  <div
                    key={row.key}
                    className={`compress-row${isChecked ? " on" : ""}`}
                    style={common}
                    onDoubleClick={() => onNavigate(f.id)}
                    onContextMenu={(e) => handleRowContextMenu(f, e)}
                  >
                    <input
                      type="checkbox"
                      className="compress-check"
                      checked={isChecked}
                      onChange={() => toggleFile(f.id)}
                    />
                    <span className="compress-row-name" title={f.path}>{f.name}</span>
                    {!avail && <span className="compress-chip-status skipped" title="Encoder not installed">no tool</span>}
                    <span className="compress-row-size">{formatBytes(f.size)}</span>
                  </div>
                );
              }

              // run file row
              const rf = row.rf;
              const badge = progBadge(rf);
              return (
                <div key={row.key} className="compress-row" style={common} title={rf.error || rf.path}>
                  <span className="compress-row-name" title={rf.path}>{rf.name}</span>
                  <div className="compress-row-prog">
                    <div className="compress-bar slim">
                      <div
                        className={`compress-bar-fill ${rf.status}`}
                        style={{ width: `${rf.status === "pending" ? 0 : rf.pct}%` }}
                      />
                    </div>
                  </div>
                  <span className={`compress-chip-status ${rf.status}`} title={badge.title}>
                    {badge.label}
                  </span>
                  <span className="compress-row-saved">
                    {rf.savedBytes > 0 ? `−${formatBytes(rf.savedBytes)}` : rf.status === "done" ? "—" : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  success: "Saved",
  skipped_no_gain: "No gain",
  error: "Error",
};

// Human-readable label + tooltip for each precise reason code the backend
// produces (compress_job::Reason). Used in the progress rows and History tab so
// any per-file outcome is explained rather than a bare "skipped"/"error".
const REASON_LABEL: Record<string, string> = {
  success: "Saved",
  skipped_no_gain: "Skipped — not smaller",
  error_tool_missing: "Error — tool missing",
  error_unsupported: "Error — unsupported",
  error_encoder: "Error — encoder failed",
  error_output_empty: "Error — empty output",
  error_source_missing: "Error — source missing",
  error_spawn: "Error — couldn't start",
};

const REASON_TOOLTIP: Record<string, string> = {
  success: "Output was smaller; original replaced.",
  skipped_no_gain: "The re-encoded output wasn't smaller than the original, so it was discarded and the original kept.",
  error_tool_missing: "The required encoder (HandBrake for video, ffmpeg/ImageMagick for images) isn't installed.",
  error_unsupported: "This file type has no supported compression pipeline.",
  error_encoder: "The encoder ran but exited with an error. See the debug log / stderr excerpt for details.",
  error_output_empty: "The encoder reported success but produced a missing or empty output file.",
  error_source_missing: "The source file no longer exists — it may have been recycled by a prior run.",
  error_spawn: "The encoder process could not be started.",
};

/** CSS status class for a History row, derived from the precise reason (falls
 *  back to the coarse status). */
function reasonClass(reason: string, status: string): string {
  if (reason === "success" || status === "success") return "done";
  if (reason === "skipped_no_gain" || status === "skipped_no_gain") return "skipped";
  return "error";
}

/** Badge label + tooltip for a live per-file progress row. */
function progBadge(rf: FileProg): { label: string; title: string } {
  switch (rf.status) {
    case "pending":
      return { label: "Pending", title: "Waiting to start" };
    case "running":
      return { label: `${Math.round(rf.pct)}%`, title: "Encoding…" };
    case "skipped":
      return { label: "No gain", title: REASON_TOOLTIP.skipped_no_gain };
    case "error":
      return { label: "Error", title: rf.error || REASON_TOOLTIP.error_encoder };
    case "done":
    default:
      return { label: "Done", title: REASON_TOOLTIP.success };
  }
}

/** Derive a display badge from a job summary's live/resumable/status flags. */
function jobBadge(j: CompressJobSummary): { label: string; cls: string } {
  if (j.active) return { label: "Running", cls: "running" };
  if (j.resumable) {
    if (j.status === "cancelled") return { label: "Cancelled", cls: "skipped" };
    if (j.status === "running") return { label: "Interrupted", cls: "error" };
    if (j.status === "error") return { label: "Failed", cls: "error" };
    return { label: "Incomplete", cls: "skipped" };
  }
  return { label: "Done", cls: "done" };
}

// In Progress tab: every compression job that's still running in this session or
// left unfinished on disk (interrupted by an app restart, cancelled, or errored
// with remaining work). Polls the list endpoint every 1.5s so running jobs show
// live progress and resumable jobs appear after a restart. Each job can be
// resumed (skips already-done files), cancelled, or have its output revealed.
function CompressInProgress() {
  const [jobs, setJobs] = useState<CompressJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const all = await listCompressJobs(signal);
    if (signal?.aborted) return;
    setJobs(all.filter((j) => j.active || j.resumable));
    setLoading(false);
  }, []);

  // Poll on a 1.5s cadence while mounted; abort + clear on unmount.
  useEffect(() => {
    const ac = new AbortController();
    let stopped = false;
    const tick = async () => {
      await refresh(ac.signal);
      if (stopped || ac.signal.aborted) return;
      timerRef.current = setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      stopped = true;
      ac.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [refresh]);

  const onResume = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await retryCompressJob(id);
        toast.success("Resuming job — skipping files already done.");
        await refresh();
      } catch (e) {
        toast.error(`Could not resume: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const onCancel = useCallback(
    async (id: string) => {
      setBusy(id);
      const res = await cancelCompressJob(id);
      if (!res.ok) toast.error(res.error ?? "Could not cancel the job.");
      await refresh();
      setBusy(null);
    },
    [refresh],
  );

  // Reveal a produced output in Explorer. Only live jobs expose a full snapshot,
  // so interrupted/manifest-only jobs fall back to a soft notice.
  const onReveal = useCallback(async (id: string) => {
    const snap = await fetchCompressJob(id);
    const out =
      snap?.files.find((f) => f.status === "done" && f.newBytes > 0) ??
      snap?.files.find((f) => f.path);
    if (out?.path) void revealPath(out.path);
    else toast.info("No output to reveal yet for this job.");
  }, []);

  return (
    <div className="compress-progress">
      <div className="compress-toolbar">
        <div className="compress-summary">
          {jobs.length > 0 ? (
            <>
              <span className="compress-total">{jobs.length.toLocaleString()}</span>
              <span className="compress-total-label">
                active / resumable job{jobs.length === 1 ? "" : "s"}
              </span>
            </>
          ) : (
            <span className="compress-total-label">No jobs in progress</span>
          )}
        </div>
        <div className="compress-toolbar-spacer" />
        <button className="compress-btn" onClick={() => void refresh()} disabled={loading}>
          <Icon name="arrow-repeat" size={13} /> Refresh
        </button>
      </div>

      <div className="compress-body">
        {loading && jobs.length === 0 ? (
          <EmptyState icon="clock-history" title="Loading jobs…" hint="Checking running and saved jobs." />
        ) : jobs.length === 0 ? (
          <EmptyState
            icon="file-zip"
            title="Nothing in progress"
            hint="Running jobs appear here live, and jobs interrupted by a restart show up as resumable."
          />
        ) : (
          <div className="compress-jobs">
            {jobs.map((j) => {
              const badge = jobBadge(j);
              const completed = j.done + j.errors + j.skipped;
              const pct = j.total > 0 ? Math.round((completed / j.total) * 100) : 0;
              const isBusy = busy === j.id;
              return (
                <div key={j.id} className="compress-job">
                  <div className="compress-job-head">
                    <span className={`compress-chip-status ${badge.cls}`}>{badge.label}</span>
                    <span className="compress-job-preset">{j.preset}</span>
                    <span className="compress-job-when" title={`Created ${formatTs(new Date(j.createdAt).toISOString())}`}>
                      {j.createdAt ? formatTs(new Date(j.createdAt).toISOString()) : "—"}
                    </span>
                    <div className="compress-toolbar-spacer" />
                    {j.savedBytes > 0 && (
                      <span className="compress-job-saved">saved {formatBytes(j.savedBytes)}</span>
                    )}
                  </div>
                  <div className="compress-job-prog">
                    <div className="compress-bar" title={`${pct}%`}>
                      <div
                        className={`compress-bar-fill${j.active ? "" : " skipped"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="compress-job-counts">
                      {completed.toLocaleString()} / {j.total.toLocaleString()} · {pct}%
                      {j.errors > 0 ? ` · ${j.errors.toLocaleString()} error${j.errors === 1 ? "" : "s"}` : ""}
                    </span>
                  </div>
                  <div className="compress-job-actions">
                    {j.active ? (
                      <button
                        className="compress-btn danger"
                        onClick={() => void onCancel(j.id)}
                        disabled={isBusy}
                      >
                        <Icon name="stop-fill" size={13} /> Cancel
                      </button>
                    ) : (
                      <button
                        className="compress-btn primary"
                        onClick={() => void onResume(j.id)}
                        disabled={isBusy}
                        title="Resume this job, skipping files already compressed"
                      >
                        <Icon name="arrow-repeat" size={13} /> {isBusy ? "Resuming…" : "Resume"}
                      </button>
                    )}
                    <button
                      className="compress-btn"
                      onClick={() => void onReveal(j.id)}
                      title="Show a produced output in Explorer"
                    >
                      <Icon name="folder-open" size={13} /> Reveal
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

// History tab: the persistent append-only CSV log of every compressed file,
// across all sessions. Loads the last N rows from the backend, shows running
// totals, and offers open / reveal / download of the underlying CSV file.
function CompressHistory() {
  const [rows, setRows] = useState<CompressLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [csvPath, setCsvPath] = useState("");
  const [debugPath, setDebugPath] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const [r, p, dp] = await Promise.all([
      fetchCompressLog(1000, signal),
      compressLogPath(),
      compressDebugPath(),
    ]);
    if (signal?.aborted) return;
    setRows(r);
    setCsvPath(p);
    setDebugPath(dp);
    setLoading(false);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const totals = useMemo(() => {
    let orig = 0, neu = 0, saved = 0, success = 0;
    for (const r of rows) {
      orig += r.origBytes;
      neu += r.newBytes;
      saved += r.savedBytes;
      if (r.status === "success") success += 1;
    }
    const pct = orig > 0 ? (saved / orig) * 100 : 0;
    return { orig, neu, saved, success, pct, count: rows.length };
  }, [rows]);

  // Newest first for display (the backend returns oldest→newest).
  const display = useMemo(() => [...rows].reverse(), [rows]);

  return (
    <div className="compress-history">
      <div className="compress-toolbar">
        <div className="compress-summary">
          {totals.count > 0 ? (
            <>
              <span className="compress-total">{formatBytes(totals.saved)}</span>
              <span className="compress-total-label">saved total</span>
              <span className="compress-selected">
                {totals.success.toLocaleString()} compressed · {totals.pct.toFixed(1)}%
              </span>
            </>
          ) : (
            <span className="compress-total-label">No compression history yet</span>
          )}
        </div>
        <div className="compress-toolbar-spacer" />
        <button className="compress-btn" onClick={() => void load()} disabled={loading}>
          <Icon name="arrow-repeat" size={13} /> Refresh
        </button>
        <button
          className="compress-btn"
          onClick={() => csvPath && void openPath(csvPath)}
          disabled={!csvPath || totals.count === 0}
          title="Open the CSV in its default application"
        >
          <Icon name="file-text" size={13} /> Open CSV
        </button>
        <button
          className="compress-btn"
          onClick={() => csvPath && void revealPath(csvPath)}
          disabled={!csvPath || totals.count === 0}
          title="Show the CSV in Explorer"
        >
          <Icon name="folder-open" size={13} /> Reveal in Explorer
        </button>
        <a
          className="compress-btn"
          href={compressLogCsvUrl()}
          download="filetree-compress-log.csv"
          title="Download the full CSV log"
        >
          <Icon name="arrow-up" size={13} /> Download
        </a>
        <span className="compress-toolbar-divider" aria-hidden="true" />
        <button
          className="compress-btn"
          onClick={() => debugPath && void openPath(debugPath)}
          disabled={!debugPath}
          title="Open the verbose diagnostic log (per-file command, exit code, stderr, decision + reason)"
        >
          <Icon name="file-text" size={13} /> Open debug log
        </button>
        <button
          className="compress-btn"
          onClick={() => debugPath && void revealPath(debugPath)}
          disabled={!debugPath}
          title="Show the debug log in Explorer"
        >
          <Icon name="folder-open" size={13} /> Reveal
        </button>
        <a
          className="compress-btn"
          href={compressDebugLogUrl()}
          download="filetree-compress-debug.log"
          title="Download the full verbose debug log"
        >
          <Icon name="arrow-up" size={13} /> Debug log
        </a>
      </div>

      <div className="compress-body">
        {loading && rows.length === 0 ? (
          <EmptyState icon="clock-history" title="Loading history…" hint="Reading the compression log." />
        ) : totals.count === 0 ? (
          <EmptyState
            icon="clock-history"
            title="No compression history"
            hint="Compress some files and each one will be logged here (and to compress-log.csv)."
          />
        ) : (
          <table className="compress-log-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>Preset</th>
                <th>Original → New</th>
                <th className="num">Saved</th>
                <th>Tool</th>
                <th className="num">Duration</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => (
                <tr key={`${r.ts}-${r.jobId}-${r.index}-${i}`} className={`clog-${r.status}`}>
                  <td className="clog-name" title={r.path}>{r.name || r.path}</td>
                  <td>{r.kind}</td>
                  <td>{r.preset}</td>
                  <td className="clog-sizes">
                    {formatBytes(r.origBytes)} <span className="clog-arrow">→</span>{" "}
                    {r.status === "error" ? "—" : formatBytes(r.newBytes)}
                  </td>
                  <td className="num">
                    {r.status === "success" ? `${r.pctSaved.toFixed(1)}%` : "—"}
                  </td>
                  <td title={[r.tool, r.toolVersion].filter(Boolean).join(" ") + (r.codecParams ? ` · ${r.codecParams}` : "")}>{r.tool || "—"}</td>
                  <td className="num">{formatDuration(r.durationMs)}</td>
                  <td>
                    <span
                      className={`compress-chip-status ${reasonClass(r.reason, r.status)}`}
                      title={r.error || REASON_TOOLTIP[r.reason] || REASON_TOOLTIP[r.status] || ""}
                    >
                      {REASON_LABEL[r.reason] ?? STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="clog-ts" title={r.ts}>{formatTs(r.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
