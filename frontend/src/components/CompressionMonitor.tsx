import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  CompressFilesQuery,
  CompressJobFile,
  CompressJobFilesPage,
  CompressJobSummary,
  CompressTelemetry,
} from "../api/types";
import {
  cancelCompressJob,
  copyText,
  fetchCompressJobFiles,
  fetchCompressTelemetry,
  listCompressJobs,
  openPath,
  setCompressionPresence,
  pauseCompressJob,
  prioritizeCompressFiles,
  removeQueuedCompressJob,
  reorderQueuedCompressJobs,
  resumeCompressJob,
  retryCompressFiles,
  revealPath,
  setCompressConcurrency,
  skipCompressFiles,
} from "../api/client";
import { formatBytes } from "../utils/formatBytes";
import { toast } from "../lib/toast";
import { localDelta, localRect } from "../lib/overlay";
import {
  addProgressSample,
  estimateRemainingFromPercent,
  progressConfidence,
  smoothedRemainingMs,
  telemetryText,
  weightedProgress,
  type ProgressSample,
} from "../lib/compressionMetrics";
import { Icon } from "./Icon";
import { Select } from "./Select";

const PAGE_SIZE = 250;
const PAGE_CACHE_LIMIT = 12;
const LAYOUT_KEY = "filetree.compress.monitor.v4";
const PREVIOUS_LAYOUT_KEYS = ["filetree.compress.monitor.v3", "filetree.compress.monitor.v2"];
const METRICS_OPEN_KEY = "filetree.compress.metricsOpen.v2";

type SortKey =
  | "activity" | "queue" | "name" | "size" | "progress" | "elapsed"
  | "eta" | "speed" | "savings" | "result" | "start" | "finish";

interface MonitorLayout {
  columns: string[];
  widths: Record<string, number>;
  runsWidth: number;
  runsHeight: number;
  inspectorWidth: number;
  sort: SortKey;
  direction: "asc" | "desc";
  status: string;
  kind: string;
  encoder: string;
  outcome: string;
  disposition: string;
  path: string;
  attention: boolean;
  keepAwake: boolean;
}

const DEFAULT_LAYOUT: MonitorLayout = {
  columns: ["name", "progress", "stage", "elapsed", "eta", "speed", "encoder", "sizes", "savings", "result"],
  widths: { name: 170, progress: 100, status: 110, stage: 65, elapsed: 60, eta: 60, speed: 65, encoder: 75, sizes: 100, savings: 60, result: 90 },
  runsWidth: 280,
  runsHeight: 180,
  inspectorWidth: 340,
  sort: "activity",
  direction: "asc",
  status: "",
  kind: "",
  encoder: "",
  outcome: "",
  disposition: "",
  path: "",
  attention: false,
  keepAwake: true,
};

const COLUMN_LABELS: Record<string, string> = {
  name: "File",
  progress: "Progress",
  status: "Status",
  stage: "Stage",
  elapsed: "Elapsed",
  eta: "ETA",
  speed: "Rate",
  encoder: "Encoder",
  sizes: "Original / output",
  savings: "Saved",
  result: "Result",
};

const SORT_BY_COLUMN: Record<string, SortKey> = {
  name: "name", progress: "progress", elapsed: "elapsed", eta: "eta",
  speed: "speed", status: "result", sizes: "size", savings: "savings", result: "result",
};

function loadLayout(): MonitorLayout {
  try {
    const current = localStorage.getItem(LAYOUT_KEY);
    const previous = PREVIOUS_LAYOUT_KEYS
      .map((key) => localStorage.getItem(key))
      .find((value) => value != null);
    const value = JSON.parse(current ?? previous ?? "{}") as Partial<MonitorLayout>;
    const columns = current && Array.isArray(value.columns)
      ? value.columns.filter((key) => key in COLUMN_LABELS)
      : DEFAULT_LAYOUT.columns;
    return {
      ...DEFAULT_LAYOUT,
      ...value,
      columns: columns.length ? Array.from(new Set(columns)) : DEFAULT_LAYOUT.columns,
      widths: { ...DEFAULT_LAYOUT.widths, ...(current ? value.widths ?? {} : {}) },
      runsWidth: typeof value.runsWidth === "number" ? Math.max(220, Math.min(480, value.runsWidth)) : DEFAULT_LAYOUT.runsWidth,
      runsHeight: typeof value.runsHeight === "number" ? Math.max(120, Math.min(320, value.runsHeight)) : DEFAULT_LAYOUT.runsHeight,
      inspectorWidth: typeof value.inspectorWidth === "number" ? Math.max(280, Math.min(560, value.inspectorWidth)) : DEFAULT_LAYOUT.inspectorWidth,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function fmtDuration(ms?: number | null): string {
  if (!ms || ms < 0) return "--";
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtRate(value?: number | null): string {
  return value == null ? "--" : `${formatBytes(value)}/s`;
}

function fmtPct(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(value < 10 ? 1 : 0)}%`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function stageLabel(file: CompressJobFile): string {
  if (file.stage === "waiting_gpu") return "Waiting for GPU";
  if (file.stage) return file.stage === "terminal" ? file.status : file.stage;
  return file.status === "pending" ? "queued" : file.status;
}

function outcomeLabel(file: CompressJobFile): string {
  if (file.reason === "skipped_prior_no_gain") return "Previously no gain";
  if (file.reason === "skipped_already_compressed") return "Already compressed";
  if (file.reason === "skipped_incomplete") return "Incomplete download";
  return file.reason || file.status;
}

function fileEta(file: CompressJobFile): number | null {
  const elapsed = file.elapsedMs ?? file.durationMs ?? 0;
  return file.status === "running" ? estimateRemainingFromPercent(elapsed, file.pct) : null;
}

function expectedFinish(eta: number | null): string {
  if (eta == null || !Number.isFinite(eta)) return "Calculating";
  return new Date(Date.now() + eta).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function statusTone(status: string): string {
  if (status === "error" || status === "cancelled") return "bad";
  if (status === "paused" || status === "pausing" || status === "queued") return "warn";
  if (status === "done") return "good";
  return "active";
}

interface Props {
  focusJobId?: string | null;
}

export function CompressionMonitor({ focusJobId }: Props) {
  const [jobs, setJobs] = useState<CompressJobSummary[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState("");
  const [selectedId, setSelectedId] = useState(() => focusJobId ?? localStorage.getItem("filetree.compress.selectedJob") ?? "");
  const [layout, setLayout] = useState<MonitorLayout>(loadLayout);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [pageMeta, setPageMeta] = useState<CompressJobFilesPage | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [inspected, setInspected] = useState<CompressJobFile | null>(null);
  const [telemetry, setTelemetry] = useState<CompressTelemetry | null>(null);
  const [openMenu, setOpenMenu] = useState<"details" | "filters" | "sort" | "columns" | null>(null);
  const [metricsOpen, setMetricsOpen] = useState(() => localStorage.getItem(METRICS_OPEN_KEY) !== "0");
  const [busy, setBusy] = useState("");
  const [workerInput, setWorkerInput] = useState(2);
  const [stackedLayout, setStackedLayout] = useState(() => window.innerWidth <= 840);
  const monitorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const pageCache = useRef(new Map<number, CompressJobFile[]>());
  const pageLru = useRef<number[]>([]);
  const queryKeyRef = useRef("");
  const [progressSamples, setProgressSamples] = useState<ProgressSample[]>([]);
  const progressSampleJob = useRef("");
  const jobsRefreshInFlight = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  useEffect(() => {
    localStorage.setItem(METRICS_OPEN_KEY, metricsOpen ? "1" : "0");
  }, [metricsOpen]);

  useEffect(() => {
    const element = monitorRef.current;
    const update = () => setStackedLayout((element?.getBoundingClientRect().width || window.innerWidth) <= 840);
    update();
    if (typeof ResizeObserver !== "undefined" && element) {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".cm-popover-anchor")) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    if (focusJobId) setSelectedId(focusJobId);
  }, [focusJobId]);

  useEffect(() => {
    if (selectedId) localStorage.setItem("filetree.compress.selectedJob", selectedId);
  }, [selectedId]);

  const refreshJobs = useCallback(async () => {
    if (jobsRefreshInFlight.current) return;
    jobsRefreshInFlight.current = true;
    try {
      const next = await listCompressJobs();
      setJobs(next);
      setJobsError("");
      setSelectedId((current) => {
        if (current && next.some((job) => job.id === current)) return current;
        return next[0]?.id ?? "";
      });
    } catch (error) {
      setJobsError(error instanceof Error ? error.message : String(error));
    } finally {
      jobsRefreshInFlight.current = false;
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshJobs();
    const timer = window.setInterval(() => void refreshJobs(), 1_000);
    return () => window.clearInterval(timer);
  }, [refreshJobs]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId],
  );
  const liveRun = !!selectedJob && ["running", "pausing", "paused", "queued"].includes(selectedJob.status);
  const telemetryAvailable = !!telemetry && [
    telemetry.gpuVideoEncodePct,
    telemetry.encoderSessions,
    telemetry.aggregateFps,
    telemetry.encoderCpuPct,
    telemetry.ramBytes,
    telemetry.readBytesPerSec,
    telemetry.writeBytesPerSec,
    telemetry.destinationFreeBytes,
  ].some((value) => value != null);
  const filterCount = Number(Boolean(layout.kind)) + Number(Boolean(layout.disposition));

  useEffect(() => {
    setWorkerInput(selectedJob?.concurrency ?? 2);
  }, [selectedJob?.id, selectedJob?.concurrency]);

  useEffect(() => {
    if (!selectedJob) return;
    if (progressSampleJob.current !== selectedJob.id) {
      progressSampleJob.current = selectedJob.id;
      setProgressSamples([{ at: Date.now(), workBytes: selectedJob.workCompletedBytes ?? 0 }]);
      return;
    }
    setProgressSamples((samples) => addProgressSample(samples, {
      at: Date.now(), workBytes: selectedJob.workCompletedBytes ?? 0,
    }));
  }, [selectedJob?.id, selectedJob?.workCompletedBytes]);

  const query = useMemo<CompressFilesQuery>(() => ({
    search,
    status: layout.status,
    type: layout.kind,
    encoder: layout.encoder,
    outcome: layout.outcome,
    disposition: layout.disposition,
    path: layout.path,
    attention: layout.attention,
    sort: layout.sort,
    direction: layout.direction,
  }), [search, layout.status, layout.kind, layout.encoder, layout.outcome, layout.disposition, layout.path, layout.attention, layout.sort, layout.direction]);

  const queryKey = useMemo(() => `${selectedId}|${JSON.stringify(query)}`, [selectedId, query]);

  const loadPage = useCallback(async (offset: number, refresh = false) => {
    if (!selectedId) return;
    const normalized = Math.floor(offset / PAGE_SIZE) * PAGE_SIZE;
    if (!refresh && pageCache.current.has(normalized)) return;
    const requestKey = queryKeyRef.current;
    const page = await fetchCompressJobFiles(selectedId, { ...query, offset: normalized, limit: PAGE_SIZE });
    if (!page || queryKeyRef.current !== requestKey) return;
    pageCache.current.set(normalized, page.items);
    pageLru.current = [...pageLru.current.filter((value) => value !== normalized), normalized];
    while (pageLru.current.length > PAGE_CACHE_LIMIT) {
      const evicted = pageLru.current.shift();
      if (evicted !== undefined) pageCache.current.delete(evicted);
    }
    setPageMeta(page);
    setCacheVersion((value) => value + 1);
  }, [query, selectedId]);

  useEffect(() => {
    queryKeyRef.current = queryKey;
    pageCache.current.clear();
    pageLru.current = [];
    setPageMeta(null);
    setSelectedFiles(new Set());
    setInspected(null);
    scrollRef.current?.scrollTo?.({ top: 0 });
    void loadPage(0, true);
  }, [queryKey, loadPage]);

  useEffect(() => {
    if (!selectedId) {
      setTelemetry(null);
      return;
    }
    let stopped = false;
    let timer: number | null = null;
    const active = !!selectedJob && ["running", "pausing"].includes(selectedJob.status);
    const tick = async () => {
      const next = await fetchCompressTelemetry(selectedId);
      if (stopped) return;
      setTelemetry(next);
      if (active) await loadPage(0, true);
      if (stopped) return;
      // Schedule only after the previous probe has finished. The native probe
      // launches system utilities and may take longer than one interval; a
      // setInterval here used to pile up probes and starve control commands.
      timer = window.setTimeout(() => void tick(), active ? 2_000 : 5_000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [selectedId, selectedJob?.status, loadPage]);

  const rowVirtualizer = useVirtualizer({
    count: pageMeta?.totalMatches ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 14,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    const offsets = new Set(virtualRows.map((row) => Math.floor(row.index / PAGE_SIZE) * PAGE_SIZE));
    offsets.forEach((offset) => void loadPage(offset));
  }, [virtualRows.map((row) => row.index).join(","), loadPage]);

  const fileAt = useCallback((index: number) => {
    const offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
    return pageCache.current.get(offset)?.[index - offset] ?? null;
  }, [cacheVersion]);

  const presenceActive = layout.keepAwake
    && jobs.some((job) => ["running", "pausing"].includes(job.status));
  const presenceStatus = selectedJob?.status ?? "idle";
  const presenceProgress = (selectedJob?.totalBytes ?? 0) > 0
    ? (selectedJob?.workCompletedBytes ?? 0) / (selectedJob?.totalBytes ?? 1)
    : 0;

  useEffect(() => {
    void setCompressionPresence({
      enabled: layout.keepAwake,
      active: presenceActive,
      status: presenceStatus,
      progress: presenceProgress,
    });
  }, [layout.keepAwake, presenceActive, presenceStatus, presenceProgress]);

  useEffect(() => {
    return () => {
      void setCompressionPresence({ enabled: false, active: false, status: "idle", progress: 0 });
    };
  }, []);

  const processed = selectedJob ? selectedJob.done + selectedJob.skipped + selectedJob.errors : 0;
  const bytePct = selectedJob
    ? weightedProgress(selectedJob.totalBytes ?? 0, selectedJob.workCompletedBytes ?? 0, processed, selectedJob.total)
    : 0;
  const overallEta = selectedJob
    ? smoothedRemainingMs(progressSamples, selectedJob.totalBytes ?? 0, selectedJob.workCompletedBytes ?? 0)
    : null;
  const confidence = overallEta == null
    ? "Calculating"
    : selectedJob ? progressConfidence(processed, selectedJob.total) : "Low";
  const isLowSpace = !!selectedJob && telemetry?.destinationFreeBytes != null
    && telemetry.destinationFreeBytes < Math.max(10 * 1024 ** 3, (selectedJob.totalBytes ?? 0) - (selectedJob.workCompletedBytes ?? 0));

  const totalBytes = Math.max(1, selectedJob?.totalBytes ?? 0);
  const segmentStyle = (bytes = 0): CSSProperties => ({ width: `${Math.min(100, bytes / totalBytes * 100)}%` });
  const gridTemplate = useMemo(
    () => `34px ${layout.columns.map((key) => `${layout.widths[key] ?? DEFAULT_LAYOUT.widths[key] ?? 100}px`).join(" ")}`,
    [layout.columns, layout.widths],
  );

  const mutate = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const result = await action();
      if (
        result
        && typeof result === "object"
        && "ok" in result
        && (result as { ok?: boolean }).ok === false
      ) {
        const message = "error" in result && typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error
          : `${label} failed`;
        throw new Error(message);
      }
      await refreshJobs();
      await loadPage(0, true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  };

  const commitWorkers = () => {
    if (!selectedJob) return;
    const value = Math.max(1, Math.min(2, Math.floor(workerInput || 1)));
    setWorkerInput(value);
    if (value !== (selectedJob.concurrency ?? 2)) {
      void mutate("workers", () => setCompressConcurrency(selectedJob.id, value));
    }
  };

  const queuedIds = jobs.filter((job) => job.status === "queued").map((job) => job.id);
  const moveQueuedRun = (id: string, delta: -1 | 1) => {
    const index = queuedIds.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= queuedIds.length) return;
    const next = [...queuedIds];
    [next[index], next[target]] = [next[target], next[index]];
    void mutate("reorder", () => reorderQueuedCompressJobs(next));
  };

  const selectedRows = useMemo(() => {
    const rows: CompressJobFile[] = [];
    pageCache.current.forEach((page) => page.forEach((file) => {
      if (selectedFiles.has(file.index)) rows.push(file);
    }));
    return rows;
  }, [selectedFiles, cacheVersion]);
  const pendingSelected = selectedRows.filter((file) => file.status === "pending");
  const retrySelected = selectedRows.filter((file) => file.status === "error" || file.status === "skipped");

  const setQuickView = (view: "active" | "queued" | "completed" | "attention" | "all") => {
    setLayout((current) => ({
      ...current,
      status: view === "active"
        ? "running"
        : view === "queued"
          ? "pending"
          : view === "completed"
            ? "done,skipped,error"
            : "",
      attention: view === "attention",
      sort: view === "active" ? "activity" : current.sort,
      direction: view === "active" ? "asc" : current.direction,
    }));
  };

  const beginPointerResize = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    cursor: "col-resize" | "row-resize",
    applyDelta: (deltaX: number, deltaY: number) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    const handlePointerMove = (move: PointerEvent) => {
      // Screen-space drag distance, converted to the units the pane sizes are
      // written in — otherwise the divider outruns the cursor under UI scale.
      applyDelta(localDelta(move.clientX - startX), localDelta(move.clientY - startY));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, []);

  // Compared against pane widths, so measured in those same units.
  const runsWidthMax = () => {
    const width = monitorRef.current ? localRect(monitorRef.current).width : 0;
    return width > 0 ? Math.max(220, Math.min(480, width - 460)) : 480;
  };
  const inspectorWidthMax = () => {
    const width = monitorRef.current ? localRect(monitorRef.current).width : 0;
    return width > 0 ? Math.max(280, Math.min(560, width - 360)) : 560;
  };
  const resizeRuns = (event: ReactPointerEvent<HTMLElement>) => {
    const start = stackedLayout ? layout.runsHeight : layout.runsWidth;
    beginPointerResize(event, stackedLayout ? "row-resize" : "col-resize", (deltaX, deltaY) => {
      setLayout((current) => stackedLayout
        ? { ...current, runsHeight: Math.max(120, Math.min(320, start + deltaY)) }
        : { ...current, runsWidth: Math.max(220, Math.min(runsWidthMax(), start + deltaX)) });
    });
  };
  const resizeInspector = (event: ReactPointerEvent<HTMLElement>) => {
    const start = layout.inspectorWidth;
    beginPointerResize(event, "col-resize", (deltaX) => {
      setLayout((current) => ({
        ...current,
        inspectorWidth: Math.max(280, Math.min(inspectorWidthMax(), start - deltaX)),
      }));
    });
  };
  const resizePaneByKeyboard = (
    pane: "runs" | "inspector",
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    const step = event.shiftKey ? 32 : 12;
    let delta = 0;
    if (pane === "runs" && stackedLayout) {
      if (event.key === "ArrowUp") delta = -step;
      if (event.key === "ArrowDown") delta = step;
    } else if (pane === "runs") {
      if (event.key === "ArrowLeft") delta = -step;
      if (event.key === "ArrowRight") delta = step;
    } else {
      if (event.key === "ArrowLeft") delta = step;
      if (event.key === "ArrowRight") delta = -step;
    }
    const isBoundaryKey = event.key === "Home" || event.key === "End";
    if (!delta && !isBoundaryKey) return;
    event.preventDefault();
    setLayout((current) => {
      if (pane === "inspector") {
        const width = event.key === "Home"
          ? 280
          : event.key === "End"
            ? inspectorWidthMax()
            : current.inspectorWidth + delta;
        return { ...current, inspectorWidth: Math.max(280, Math.min(inspectorWidthMax(), width)) };
      }
      if (stackedLayout) {
        const height = event.key === "Home" ? 120 : event.key === "End" ? 320 : current.runsHeight + delta;
        return { ...current, runsHeight: Math.max(120, Math.min(320, height)) };
      }
      const width = event.key === "Home" ? 220 : event.key === "End" ? runsWidthMax() : current.runsWidth + delta;
      return { ...current, runsWidth: Math.max(220, Math.min(runsWidthMax(), width)) };
    });
  };
  const resizeColumn = (key: string, event: ReactPointerEvent<HTMLElement>) => {
    const startWidth = layout.widths[key] ?? DEFAULT_LAYOUT.widths[key] ?? 100;
    beginPointerResize(event, "col-resize", (deltaX) => {
      const width = Math.max(58, Math.min(560, startWidth + deltaX));
      setLayout((current) => ({ ...current, widths: { ...current.widths, [key]: width } }));
    });
  };
  const resizeColumnByKeyboard = (key: string, event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 32 : 12;
    const currentWidth = layout.widths[key] ?? DEFAULT_LAYOUT.widths[key] ?? 100;
    const width = event.key === "Home"
      ? 58
      : event.key === "End"
        ? 560
        : event.key === "ArrowLeft"
          ? currentWidth - step
          : event.key === "ArrowRight"
            ? currentWidth + step
            : null;
    if (width == null) return;
    event.preventDefault();
    event.stopPropagation();
    setLayout((current) => ({
      ...current,
      widths: { ...current.widths, [key]: Math.max(58, Math.min(560, width)) },
    }));
  };

  const renderCell = (file: CompressJobFile, key: string) => {
    const eta = fileEta(file);
    switch (key) {
      case "name": return <span className="cm-file-name" title={file.path}>{fileName(file.path)}</span>;
      case "progress": return (
        <div
          className="cm-file-progress"
          role="progressbar"
          aria-label={`${fileName(file.path)} progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(file.pct)}
          aria-valuetext={`${fmtPct(file.pct)}, ${stageLabel(file)}`}
        >
          <span className="cm-file-progress-track" aria-hidden="true">
            <span className={`cm-file-progress-fill status-${file.status} stage-${file.stage ?? "unknown"}`} style={{ width: `${file.pct}%` }} />
          </span>
          <span className="cm-file-progress-label">{fmtPct(file.pct)}</span>
        </div>
      );
      case "stage": return <span className={`cm-stage ${file.status}`}>{stageLabel(file)}</span>;
      case "status": {
        const terminal = ["done", "error", "skipped", "cancelled"].includes(file.status)
          || file.stage === "terminal";
        const label = terminal ? outcomeLabel(file) : stageLabel(file);
        return <span className={`cm-result ${file.status}`} title={file.error || label}>{label}</span>;
      }
      case "elapsed": return fmtDuration(file.elapsedMs ?? file.durationMs);
      case "eta": return eta == null ? (file.status === "running" ? "Calculating" : "--") : fmtDuration(eta);
      case "speed": return file.fps != null ? `${file.fps.toFixed(1)} fps` : fmtRate(file.processingRate);
      case "encoder": return <span title={file.encoder}>{file.encoder || "--"}</span>;
      case "sizes": return `${formatBytes(file.origBytes)} / ${file.newBytes ? formatBytes(file.newBytes) : "--"}`;
      case "savings": return file.savedBytes ? formatBytes(file.savedBytes) : "--";
      case "result": {
        const result = outcomeLabel(file);
        return <span className={`cm-result ${file.status}`} title={file.error}>{result}</span>;
      }
      default: return null;
    }
  };

  return (
    <div
      ref={monitorRef}
      className={`compression-monitor compression-monitor-v2${stackedLayout ? " cm-stacked" : ""}`}
      style={{
        "--cm-runs-width": `${layout.runsWidth}px`,
        "--cm-runs-height": `${layout.runsHeight}px`,
        "--cm-inspector-width": `${layout.inspectorWidth}px`,
      } as CSSProperties}
    >
      <aside id="compression-runs" className="cm-runs" aria-label="Compression runs">
        <div className="cm-runs-head">
          <strong>Runs</strong>
          <button type="button" className="icon-button" aria-label="Refresh runs" title="Refresh runs" onClick={() => void refreshJobs()}><Icon name="refresh" size={14} /></button>
        </div>
        <div className="cm-run-list">
          {jobs.map((job) => {
            const complete = job.done + job.skipped + job.errors;
            const percent = job.totalBytes ? (job.workCompletedBytes ?? 0) / job.totalBytes * 100 : complete / Math.max(1, job.total) * 100;
            return (
              <div key={job.id} className={`cm-run ${job.id === selectedId ? "selected" : ""}`}>
                <button
                  type="button"
                  className="cm-run-select"
                  aria-pressed={job.id === selectedId}
                  onClick={() => setSelectedId(job.id)}
                >
                  <span className={`cm-status-dot ${statusTone(job.status)}`} aria-hidden="true" />
                  <span className="cm-run-main">
                    <span><strong>{job.preset}</strong><em>{new Date(job.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</em></span>
                    <span className="cm-run-progress"><i className={`status-${job.status}`} style={{ width: `${percent}%` }} /></span>
                    <span><small>{job.status}</small><small>{complete.toLocaleString()} / {job.total.toLocaleString()}</small></span>
                  </span>
                </button>
                {job.status === "queued" && (() => {
                  const queueIndex = queuedIds.indexOf(job.id);
                  return (
                    <span className="cm-run-queue-actions">
                      <button type="button" aria-label="Move queued run earlier" disabled={queueIndex <= 0 || !!busy} onClick={() => moveQueuedRun(job.id, -1)}><Icon name="caret-up" size={10} /></button>
                      <button type="button" aria-label="Move queued run later" disabled={queueIndex >= queuedIds.length - 1 || !!busy} onClick={() => moveQueuedRun(job.id, 1)}><Icon name="caret-down" size={10} /></button>
                      <button type="button" aria-label="Remove queued run" disabled={!!busy} onClick={() => void mutate("remove", () => removeQueuedCompressJob(job.id))}><Icon name="x" size={11} /></button>
                    </span>
                  );
                })()}
              </div>
            );
          })}
          {jobsLoading && !jobs.length && <div className="cm-empty">Loading runs...</div>}
          {!jobsLoading && !!jobsError && !jobs.length && <div className="cm-empty">Could not load runs</div>}
          {!jobsLoading && !jobsError && !jobs.length && <div className="cm-empty">No compression runs</div>}
        </div>
      </aside>

      <div
        className="cm-pane-resizer cm-runs-resizer"
        role="separator"
        tabIndex={0}
        aria-label="Resize compression runs pane"
        aria-controls="compression-runs compression-details"
        aria-orientation={stackedLayout ? "horizontal" : "vertical"}
        aria-valuemin={stackedLayout ? 120 : 220}
        aria-valuemax={stackedLayout ? 320 : 480}
        aria-valuenow={stackedLayout ? layout.runsHeight : layout.runsWidth}
        title="Drag to resize; double-click to reset"
        onPointerDown={resizeRuns}
        onKeyDown={(event) => resizePaneByKeyboard("runs", event)}
        onDoubleClick={() => setLayout((current) => ({
          ...current,
          runsWidth: DEFAULT_LAYOUT.runsWidth,
          runsHeight: DEFAULT_LAYOUT.runsHeight,
        }))}
      />

      <section id="compression-details" className="cm-detail">
        {!selectedJob ? <div className="cm-empty centered">{jobsLoading ? "Loading compression runs..." : "Select a run to inspect it"}</div> : <>
          <header className={`cm-job-header cm-job-header-v2 tone-${statusTone(selectedJob.status)}`}>
            <div className="cm-job-title">
              <span className={`cm-status-pill ${statusTone(selectedJob.status)}`}>{selectedJob.status}</span>
              <strong>{selectedJob.preset}</strong>
            </div>
            <div className="cm-job-controls">
              {liveRun && <label className="cm-concurrency" title="Live worker limit; reductions apply after active files finish">
                Workers
                <input
                  type="number"
                  min={1}
                  max={2}
                  value={workerInput}
                  onChange={(event) => setWorkerInput(Number(event.target.value))}
                  onBlur={commitWorkers}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </label>}
              {selectedJob.status === "running" && <button type="button" className="compress-btn cm-control-icon" aria-label="Pause queue" title="Pause the queue after active files finish safely" disabled={!!busy} onClick={() => void mutate("pause", () => pauseCompressJob(selectedJob.id))}><Icon name="pause-fill" size={14} /></button>}
              {["paused", "queued"].includes(selectedJob.status) && <button type="button" className="compress-btn primary cm-control-icon" aria-label="Resume run" title="Resume this run" disabled={!!busy} onClick={() => void mutate("resume", () => resumeCompressJob(selectedJob.id))}><Icon name="play-fill" size={14} /></button>}
              {selectedJob.status === "pausing" && <button type="button" className="compress-btn primary" title="Cancel the pending pause and keep running" disabled={!!busy} onClick={() => void mutate("resume", () => resumeCompressJob(selectedJob.id))}><Icon name="play-fill" size={13} /> Keep running</button>}
              {["running", "pausing", "paused"].includes(selectedJob.status) && <button type="button" className="compress-btn danger" title="Stop immediately and remove partial outputs" disabled={!!busy} onClick={() => {
                if (window.confirm("Stop this run now? Active encoders will be terminated and partial outputs removed. The run remains resumable.")) {
                  void mutate("stop", () => cancelCompressJob(selectedJob.id));
                }
              }}><Icon name="stop-fill" size={13} /> Stop</button>}
              <div className="cm-popover-anchor">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Run details"
                  aria-expanded={openMenu === "details"}
                  aria-controls="compression-run-details"
                  title="Run details"
                  onClick={() => setOpenMenu((current) => current === "details" ? null : "details")}
                >
                  <Icon name="three-dots" size={15} />
                </button>
                {openMenu === "details" && <div id="compression-run-details" className="cm-popover cm-run-details" role="group" aria-label="Run details">
                  <span><small>Codec</small>{selectedJob.codec?.toUpperCase() ?? "H.264"}</span>
                  <span><small>Encoder</small>{selectedJob.encoder ?? "Auto"}</span>
                  <span><small>Output</small><b title={selectedJob.outputDir || "Outputs are written beside each original"}>{selectedJob.outputDir || "Beside originals"}</b></span>
                  <span><small>Originals</small>{selectedJob.originalAction ?? "recycle"}</span>
                </div>}
              </div>
            </div>
            <div className="cm-progress-summary">
              <div
                className="cm-overall-track"
                role="progressbar"
                aria-label="Overall compression progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(bytePct)}
                aria-valuetext={`${fmtPct(bytePct)}; ${selectedJob.done} completed, ${selectedJob.skipped} skipped, ${selectedJob.errors} failed`}
                title="Size-weighted overall progress"
              >
                <span className="success" style={segmentStyle(selectedJob.successfulBytes)} />
                <span className="active" style={segmentStyle(selectedJob.activeWorkBytes)} />
                <span className="skipped" style={segmentStyle(selectedJob.skippedBytes)} />
                <span className="failed" style={segmentStyle(selectedJob.failedBytes)} />
              </div>
              {liveRun && <strong>{fmtPct(bytePct)}</strong>}
              <span>{processed.toLocaleString()} / {selectedJob.total.toLocaleString()} files</span>
              {(selectedJob.activeCount ?? 0) > 0 && <span>{selectedJob.activeCount} active</span>}
              {selectedJob.savedBytes > 0 && <span>{formatBytes(selectedJob.savedBytes)} saved</span>}
            </div>
            {isLowSpace && <div className="cm-warning"><Icon name="warning" size={13} /> Destination space is low. FileTree will keep the run intact and will not delete or skip work automatically.</div>}
          </header>

          <details
            className="cm-metrics-panel"
            open={metricsOpen}
            onToggle={(event) => setMetricsOpen(event.currentTarget.open)}
          >
            <summary className="cm-metrics-summary">
              <span>Metrics</span>
              <Icon name="caret-up" size={9} className={metricsOpen ? "" : "flip-y"} />
            </summary>
            <div className="cm-job-facts">
              <span><small>Active time</small>{fmtDuration(selectedJob.activeElapsedMs)}</span>
              {liveRun ? <>
                <span><small>ETA</small>{overallEta == null ? "Calculating" : fmtDuration(overallEta)}</span>
                <span><small>Finish</small>{expectedFinish(overallEta)}</span>
                <span><small>Confidence</small>{confidence}</span>
              </> : <>
                <span><small>Finished</small>{new Date(selectedJob.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                <span><small>Files</small>{processed.toLocaleString()}</span>
                <span><small>Saved</small>{formatBytes(selectedJob.savedBytes)}</span>
              </>}
            </div>
            {liveRun && <label className="cm-keep-awake">
              <input type="checkbox" checked={layout.keepAwake} onChange={(event) => setLayout((current) => ({ ...current, keepAwake: event.target.checked }))} />
              Keep PC awake
            </label>}
            <div className={`cm-telemetry${telemetryAvailable ? "" : " unavailable"}`} aria-label="Compression telemetry">
              <Telemetry label="GPU encode" value={telemetryText(telemetry?.gpuVideoEncodePct, "%")} />
              <Telemetry label="Sessions" value={telemetryText(telemetry?.encoderSessions)} />
              <Telemetry label="Aggregate" value={telemetryText(telemetry?.aggregateFps, " fps")} />
              <Telemetry label="Pipeline CPU" value={telemetryText(telemetry?.encoderCpuPct, "%")} />
              <Telemetry label="RAM" value={telemetry?.ramBytes == null ? "Unavailable" : formatBytes(telemetry.ramBytes)} />
              <Telemetry label="Read" value={telemetry?.readBytesPerSec == null ? "Unavailable" : fmtRate(telemetry.readBytesPerSec)} />
              <Telemetry label="Write" value={telemetry?.writeBytesPerSec == null ? "Unavailable" : fmtRate(telemetry.writeBytesPerSec)} />
              <Telemetry label="Free space" value={telemetry?.destinationFreeBytes == null ? "Unavailable" : formatBytes(telemetry.destinationFreeBytes)} warn={isLowSpace} />
            </div>
            {!telemetryAvailable && <div className="cm-telemetry-empty">
              {liveRun ? "Waiting for the first telemetry sample…" : "Telemetry was not recorded for this completed run."}
            </div>}
          </details>

          <div className="cm-toolbar">
            <div className="cm-search"><Icon name="search" size={13} /><input aria-label="Search files" placeholder="Search files…" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} /></div>
            <div className="cm-quick-views">
              {(["all", "active", "queued", "completed", "attention"] as const).map((view) => {
                const selected = view === "attention"
                  ? layout.attention
                  : view === "active"
                    ? layout.status === "running"
                    : view === "queued"
                      ? layout.status === "pending"
                      : view === "completed"
                        ? layout.status === "done,skipped,error"
                        : !layout.status && !layout.attention;
                return <button type="button" key={view} className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => setQuickView(view)}>{view[0].toUpperCase() + view.slice(1)}</button>;
              })}
            </div>
            <div className="cm-toolbar-icons">
              <div className="cm-popover-anchor">
                <button
                  type="button"
                  className={`icon-button${filterCount ? " selected" : ""}`}
                  aria-label={`Filters${filterCount ? `, ${filterCount} active` : ""}`}
                  aria-expanded={openMenu === "filters"}
                  aria-controls="compression-filter-menu"
                  title="Filters"
                  onClick={() => setOpenMenu((current) => current === "filters" ? null : "filters")}
                >
                  <Icon name={filterCount ? "funnel-fill" : "funnel"} size={14} />
                  {filterCount > 0 && <span className="cm-icon-badge">{filterCount}</span>}
                </button>
                {openMenu === "filters" && <div id="compression-filter-menu" className="cm-popover cm-filter-menu" role="group" aria-label="File filters">
                  <label>Type<Select
                    aria-label="Filter by file type"
                    value={layout.kind}
                    options={[
                      { value: "", label: "All types" },
                      { value: "video", label: "Video" },
                      { value: "image", label: "Images" },
                      { value: "other", label: "Other" },
                    ]}
                    onChange={(kind) => setLayout((current) => ({ ...current, kind }))}
                  /></label>
                  <label>Original<Select
                    aria-label="Filter by original disposition"
                    value={layout.disposition}
                    options={[
                      { value: "", label: "Any disposition" },
                      { value: "recycled", label: "Recycled" },
                      { value: "deleted", label: "Deleted" },
                      { value: "kept", label: "Kept" },
                    ]}
                    onChange={(disposition) => setLayout((current) => ({ ...current, disposition }))}
                  /></label>
                  {filterCount > 0 && <button type="button" className="cm-menu-reset" onClick={() => setLayout((current) => ({ ...current, kind: "", disposition: "" }))}>Clear filters</button>}
                </div>}
              </div>
              <div className="cm-popover-anchor">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Sort by ${layout.sort}, ${layout.direction === "asc" ? "ascending" : "descending"}`}
                  aria-expanded={openMenu === "sort"}
                  aria-controls="compression-sort-menu"
                  title="Sort"
                  onClick={() => setOpenMenu((current) => current === "sort" ? null : "sort")}
                >
                  <Icon name="arrow-up" size={14} className={layout.direction === "desc" ? "flip-y" : ""} />
                </button>
                {openMenu === "sort" && <div id="compression-sort-menu" className="cm-popover cm-sort-menu" role="group" aria-label="Sort files">
                  <label>Sort by<Select
                    aria-label="Sort files"
                    value={layout.sort}
                    options={[
                      { value: "activity", label: "Activity" },
                      { value: "queue", label: "Queue position" },
                      { value: "name", label: "Name" },
                      { value: "size", label: "Size" },
                      { value: "progress", label: "Progress" },
                      { value: "elapsed", label: "Elapsed" },
                      { value: "eta", label: "ETA" },
                      { value: "speed", label: "Speed" },
                      { value: "savings", label: "Savings" },
                      { value: "result", label: "Result" },
                      { value: "start", label: "Start time" },
                      { value: "finish", label: "Finish time" },
                    ]}
                    onChange={(sort) => setLayout((current) => ({ ...current, sort }))}
                  /></label>
                  <button type="button" className="cm-sort-direction" onClick={() => setLayout((current) => ({ ...current, direction: current.direction === "asc" ? "desc" : "asc" }))}>
                    <Icon name="arrow-up" size={13} className={layout.direction === "desc" ? "flip-y" : ""} />
                    {layout.direction === "asc" ? "Ascending" : "Descending"}
                  </button>
                </div>}
              </div>
              <div className="cm-columns-wrap cm-popover-anchor">
              <button type="button" className="icon-button cm-labeled-tool" aria-label="Choose columns" aria-expanded={openMenu === "columns"} aria-controls="compression-columns-menu" title="Choose columns" onClick={() => setOpenMenu((current) => current === "columns" ? null : "columns")}><Icon name="columns" size={14} /><span>Columns</span></button>
              {openMenu === "columns" && <div id="compression-columns-menu" className="cm-columns-menu cm-popover" role="group" aria-label="Visible columns">
                {Object.entries(COLUMN_LABELS).map(([key, label]) => {
                  const checked = layout.columns.includes(key);
                  return <label key={key}><input type="checkbox" checked={checked} disabled={checked && layout.columns.length === 1} onChange={(event) => setLayout((current) => ({ ...current, columns: event.target.checked ? [...current.columns, key] : current.columns.filter((item) => item !== key) }))} /> {label}</label>;
                })}
                <button type="button" className="cm-menu-reset" onClick={() => setLayout((current) => ({ ...current, columns: [...DEFAULT_LAYOUT.columns], widths: { ...DEFAULT_LAYOUT.widths } }))}>Reset columns</button>
              </div>}
              </div>
            </div>
          </div>
          {filterCount > 0 && <div className="cm-active-filters" aria-label="Active filters">
            {layout.kind && <button type="button" onClick={() => setLayout((current) => ({ ...current, kind: "" }))}>{layout.kind}<Icon name="x" size={10} /></button>}
            {layout.disposition && <button type="button" onClick={() => setLayout((current) => ({ ...current, disposition: "" }))}>{layout.disposition}<Icon name="x" size={10} /></button>}
          </div>}

          {!!selectedFiles.size && <div className="cm-selection-actions">
            <strong>{selectedFiles.size.toLocaleString()} selected</strong>
            <button disabled={!pendingSelected.length || !!busy} onClick={() => void mutate("prioritize", () => prioritizeCompressFiles(selectedJob.id, pendingSelected.map((file) => file.index)))}><Icon name="arrow-up" size={12} /> Prioritize</button>
            <button disabled={!pendingSelected.length || !!busy} onClick={() => void mutate("skip", () => skipCompressFiles(selectedJob.id, pendingSelected.map((file) => file.index)))}><Icon name="x" size={12} /> Skip pending</button>
            <button disabled={!retrySelected.length || !!busy} onClick={() => void mutate("retry", async () => { const id = await retryCompressFiles(selectedJob.id, retrySelected.map((file) => file.index)); setSelectedId(id); })}><Icon name="arrow-repeat" size={12} /> Retry selected</button>
            <button onClick={() => setSelectedFiles(new Set())}>Clear</button>
          </div>}

          <div className={`cm-workarea ${inspected ? "with-inspector" : ""}`}>
            <div className="cm-table-shell">
              <div className="cm-table-head" style={{ gridTemplateColumns: gridTemplate }}>
                <span className="cm-check-cell"><input type="checkbox" aria-label="Select loaded files" checked={selectedRows.length > 0 && selectedRows.length === Array.from(pageCache.current.values()).flat().length} onChange={(event) => {
                  const next = new Set<number>();
                  if (event.target.checked) pageCache.current.forEach((page) => page.forEach((file) => next.add(file.index)));
                  setSelectedFiles(next);
                }} /></span>
                {layout.columns.map((key) => {
                  const sort = SORT_BY_COLUMN[key];
                  const sorted = layout.sort === sort;
                  const width = layout.widths[key] ?? DEFAULT_LAYOUT.widths[key] ?? 100;
                  return (
                    <div
                      key={key}
                      className="cm-column-head"
                      role="columnheader"
                      aria-sort={sorted ? (layout.direction === "asc" ? "ascending" : "descending") : undefined}
                    >
                      <button
                        type="button"
                        className="cm-column-sort"
                        disabled={!sort}
                        aria-label={sort ? `Sort by ${COLUMN_LABELS[key]}` : undefined}
                        onClick={() => {
                          if (!sort) return;
                          setLayout((current) => ({
                            ...current,
                            sort,
                            direction: current.sort === sort && current.direction === "asc" ? "desc" : "asc",
                          }));
                        }}
                      >
                        <span>{COLUMN_LABELS[key]}</span>
                        {sorted && <Icon name="caret-up" size={8} className={layout.direction === "desc" ? "flip-y" : ""} />}
                      </button>
                      <span
                        className="cm-resizer"
                        role="separator"
                        tabIndex={0}
                        aria-label={`Resize ${COLUMN_LABELS[key]} column`}
                        aria-orientation="vertical"
                        aria-valuemin={58}
                        aria-valuemax={560}
                        aria-valuenow={width}
                        title="Drag to resize; double-click to reset"
                        onPointerDown={(event) => resizeColumn(key, event)}
                        onKeyDown={(event) => resizeColumnByKeyboard(key, event)}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          setLayout((current) => ({
                            ...current,
                            widths: {
                              ...current.widths,
                              [key]: DEFAULT_LAYOUT.widths[key] ?? 100,
                            },
                          }));
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div ref={scrollRef} className="cm-table-scroll" tabIndex={0} onKeyDown={(event) => {
                if (!inspected || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
                event.preventDefault();
                const target = Math.max(0, Math.min((pageMeta?.totalMatches ?? 1) - 1, inspected.index + (event.key === "ArrowDown" ? 1 : -1)));
                const file = fileAt(target);
                if (file) setInspected(file);
                rowVirtualizer.scrollToIndex(target, { align: "auto" });
              }}>
                <div className="cm-table-body" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                  {virtualRows.map((row) => {
                    const file = fileAt(row.index);
                    return <div key={row.key} className={`cm-table-row ${file && selectedFiles.has(file.index) ? "selected" : ""} ${file?.status ?? "loading"}`} style={{ transform: `translateY(${row.start}px)`, gridTemplateColumns: gridTemplate }} onClick={() => file && setInspected(file)}>
                      {file ? <>
                        <span className="cm-check-cell"><input type="checkbox" aria-label={`Select ${fileName(file.path)}`} checked={selectedFiles.has(file.index)} onChange={(event) => {
                          event.stopPropagation();
                          setSelectedFiles((current) => { const next = new Set(current); event.target.checked ? next.add(file.index) : next.delete(file.index); return next; });
                        }} /></span>
                        {layout.columns.map((key) => <span key={key} className={`cm-cell cell-${key}`}>{renderCell(file, key)}</span>)}
                      </> : <span className="cm-row-loading">Loading...</span>}
                    </div>;
                  })}
                </div>
              </div>
              <footer className="cm-table-footer">
                {(pageMeta?.totalMatches ?? 0).toLocaleString()} matching · {(pageMeta?.total ?? 0).toLocaleString()} files
                <span className="cm-footer-info" title="Active files and files finished in the last 15 seconds stay pinned">
                  <Icon name="info-circle" size={12} />
                </span>
              </footer>
            </div>

            {inspected && <>
              <div
                className="cm-pane-resizer cm-inspector-resizer"
                role="separator"
                tabIndex={0}
                aria-label="Resize file inspector"
                aria-controls="compression-inspector"
                aria-orientation="vertical"
                aria-valuemin={280}
                aria-valuemax={560}
                aria-valuenow={layout.inspectorWidth}
                title="Drag to resize; double-click to reset"
                onPointerDown={resizeInspector}
                onKeyDown={(event) => resizePaneByKeyboard("inspector", event)}
                onDoubleClick={() => setLayout((current) => ({ ...current, inspectorWidth: DEFAULT_LAYOUT.inspectorWidth }))}
              />
              <aside id="compression-inspector" className="cm-inspector" aria-label="File details">
              <div className="cm-inspector-head"><strong title={inspected.path}>{fileName(inspected.path)}</strong><button type="button" className="icon-button" aria-label="Close inspector" title="Close inspector" onClick={() => setInspected(null)}><Icon name="x" size={13} /></button></div>
              <InspectorField label="Source" value={inspected.path} />
              <InspectorField label="Output" value={inspected.outPath || "Not created"} />
              <div className="cm-inspector-actions">
                <button aria-label="Open source" title="Open source" onClick={() => void openPath(inspected.path)}><Icon name="folder-open" size={13} /></button>
                <button title="Reveal source" onClick={() => void revealPath(inspected.path)}><Icon name="search" size={12} /> Reveal</button>
                <button aria-label="Copy source path" title="Copy source path" onClick={() => void copyText(inspected.path)}><Icon name="copy" size={13} /></button>
              </div>
              <div className="cm-inspector-grid">
                <InspectorField label="Status" value={`${stageLabel(inspected)} · ${fmtPct(inspected.pct)}`} />
                <InspectorField label="Tool" value={[inspected.tool, inspected.toolVersion].filter(Boolean).join(" ") || "Unavailable"} />
                <InspectorField label="Encoder" value={inspected.encoder || "Unavailable"} />
                <InspectorField label="Attempt" value={String(inspected.attempt ?? 0)} />
                <InspectorField label="Started" value={inspected.startedAt ? new Date(inspected.startedAt).toLocaleString() : "Not started"} />
                <InspectorField label="Finished" value={inspected.finishedAt ? new Date(inspected.finishedAt).toLocaleString() : "Not finished"} />
                <InspectorField label="Elapsed" value={fmtDuration(inspected.elapsedMs ?? inspected.durationMs)} />
                <InspectorField label="Disposition" value={inspected.disposition || "Pending"} />
              </div>
              <InspectorField label="Result" value={inspected.reason || inspected.status} />
              {inspected.error && <InspectorField label="Error" value={inspected.error} danger />}
              {(inspected.command || inspected.stderr) && <details className="cm-inspector-diagnostics">
                <summary>Diagnostics</summary>
                {inspected.command && <InspectorCode label="Command" value={inspected.command} />}
                {inspected.stderr && <InspectorCode label="stderr" value={inspected.stderr} />}
              </details>}
              </aside>
            </>}
          </div>
        </>}
      </section>
    </div>
  );
}

function Telemetry({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return <span className={warn ? "warn" : ""}><small>{label}</small><strong>{value}</strong></span>;
}

function InspectorField({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return <div className={`cm-inspector-field ${danger ? "danger" : ""}`}><small>{label}</small><span title={value}>{value}</span></div>;
}

function InspectorCode({ label, value }: { label: string; value: string }) {
  return <div className="cm-inspector-code"><small>{label}</small><pre>{value}</pre></div>;
}
