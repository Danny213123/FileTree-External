import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  NodeRecord,
  CompressTools,
  CompressPreset,
  CompressKind,
  CompressEvent,
  CompressJob,
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
  openPath,
  revealPath,
  fetchCompressLog,
  compressLogPath,
  compressLogCsvUrl,
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

type CompressTab = "compress" | "history";

interface CompressViewProps {
  /** Current scan root (for the empty state + nocache rescan). */
  scanPath: string;
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

export function CompressView({
  scanPath,
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
  const files = useMemo(() => {
    const out: CompressFile[] = [];
    for (const node of nodeById.values()) {
      if (node.dir || node.id < 0 || !node.path) continue;
      out.push({
        id: node.id,
        path: node.path,
        name: node.name,
        size: node.size,
        kind: classifyKind(node.extension ?? ""),
      });
    }
    return out;
  }, [nodeById]);

  // Pre-check the files passed from the table's right-click "Compress..." action.
  // Maps each requested path to its id in the current scan; paths outside the
  // scan can't be checked, so we surface a small non-blocking notice. Applied
  // once per request (parent clears `initialSelectedPaths` via onInitialApplied),
  // so manual edits afterward stick. Waits until `files` is populated.
  useEffect(() => {
    if (!initialSelectedPaths || initialSelectedPaths.length === 0) return;
    if (files.length === 0) return;
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const idByPath = new Map<string, number>();
    for (const f of files) idByPath.set(norm(f.path), f.id);
    const ids: number[] = [];
    let missing = 0;
    for (const p of initialSelectedPaths) {
      const id = idByPath.get(norm(p));
      if (id !== undefined) ids.push(id);
      else missing += 1;
    }
    if (ids.length > 0) setSelected(new Set(ids));
    setPreselectNotice(
      missing > 0
        ? `${missing} selected file${missing === 1 ? "" : "s"} ${missing === 1 ? "isn't" : "aren't"} in the current scan and couldn't be pre-selected.`
        : "",
    );
    setTab("compress");
    onInitialApplied?.();
  }, [initialSelectedPaths, files, onInitialApplied]);

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
    const runnable = selectedFiles.filter((f) => kindAvailable(f.kind));
    if (runnable.length === 0) return;

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

    const skipped = selectedFiles.length - runnable.length;
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
        // session) still passes the server's scan-root containment check.
        scanRoot: scanPath || undefined,
      });
      setJobId(id);
      void attachStream(id);
    } catch (e) {
      finalizedRef.current = true;
      setRunStatus("error");
      setRunError(e instanceof Error ? e.message : String(e));
      toast.error(`Could not start compression: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selectedFiles, kindAvailable, preset, recycleOriginals, tagFilename, attachStream, scanPath]);

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
      <div className="compress-tabs" role="tablist" aria-label="Compress / History">
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
          aria-selected={tab === "history"}
          className={`compress-tab${tab === "history" ? " active" : ""}`}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "history" ? (
        <CompressHistory />
      ) : !scanPath ? (
        <EmptyState
          icon="file-zip"
          title="No scan loaded"
          hint="Scan a folder or drive in the Explorer side bar, then return here to compress media and other files."
        />
      ) : (
      <>
      {preselectNotice && (
        <div className="compress-notice">
          <span className="ct-ico"><Icon name="info-circle" size={14} /></span>
          <span>{preselectNotice}</span>
          <button className="compress-notice-x" onClick={() => setPreselectNotice("")} title="Dismiss">×</button>
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
                  <span className={`compress-chip-status ${rf.status}`}>
                    {rf.status === "skipped" ? "no gain" : rf.status}
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

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const [r, p] = await Promise.all([fetchCompressLog(1000, signal), compressLogPath()]);
    if (signal?.aborted) return;
    setRows(r);
    setCsvPath(p);
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
                  <td title={r.codecParams}>{r.tool || "—"}</td>
                  <td className="num">{formatDuration(r.durationMs)}</td>
                  <td>
                    <span className={`compress-chip-status ${r.status === "success" ? "done" : r.status === "skipped_no_gain" ? "skipped" : "error"}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
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
