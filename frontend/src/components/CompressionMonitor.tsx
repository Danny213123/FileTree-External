import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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

const PAGE_SIZE = 250;
const PAGE_CACHE_LIMIT = 12;
const LAYOUT_KEY = "filetree.compress.monitor.v2";

type SortKey =
  | "activity" | "queue" | "name" | "size" | "progress" | "elapsed"
  | "eta" | "speed" | "savings" | "result" | "start" | "finish";

interface MonitorLayout {
  columns: string[];
  widths: Record<string, number>;
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
  columns: ["name", "progress", "stage", "sizes", "result"],
  widths: { name: 360, progress: 200, stage: 110, elapsed: 86, eta: 86, speed: 100, encoder: 160, sizes: 180, savings: 92, result: 170 },
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
  speed: "speed", sizes: "size", savings: "savings", result: "result",
};

function loadLayout(): MonitorLayout {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Partial<MonitorLayout>;
    return {
      ...DEFAULT_LAYOUT,
      ...value,
      columns: Array.isArray(value.columns) ? value.columns.filter((key) => key in COLUMN_LABELS) : DEFAULT_LAYOUT.columns,
      widths: { ...DEFAULT_LAYOUT.widths, ...(value.widths ?? {}) },
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
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(true);
  const [busy, setBusy] = useState("");
  const [workerInput, setWorkerInput] = useState(2);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  const resizeColumn = (key: string, event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = layout.widths[key] ?? DEFAULT_LAYOUT.widths[key] ?? 100;
    const onMove = (move: PointerEvent) => {
      const width = Math.max(58, Math.min(560, startWidth + move.clientX - startX));
      setLayout((current) => ({ ...current, widths: { ...current.widths, [key]: width } }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const renderCell = (file: CompressJobFile, key: string) => {
    const eta = fileEta(file);
    switch (key) {
      case "name": return <span className="cm-file-name" title={file.path}>{fileName(file.path)}</span>;
      case "progress": return (
        <div className="cm-file-progress">
          <span className={`cm-file-progress-fill stage-${stageLabel(file)}`} style={{ width: `${file.pct}%` }} />
          <span>{fmtPct(file.pct)}</span>
        </div>
      );
      case "stage": return <span className={`cm-stage ${file.status}`}>{stageLabel(file)}</span>;
      case "elapsed": return fmtDuration(file.elapsedMs ?? file.durationMs);
      case "eta": return eta == null ? (file.status === "running" ? "Calculating" : "--") : fmtDuration(eta);
      case "speed": return file.fps != null ? `${file.fps.toFixed(1)} fps` : fmtRate(file.processingRate);
      case "encoder": return <span title={file.encoder}>{file.encoder || "--"}</span>;
      case "sizes": return `${formatBytes(file.origBytes)} / ${file.newBytes ? formatBytes(file.newBytes) : "--"}`;
      case "savings": return file.savedBytes ? formatBytes(file.savedBytes) : "--";
      case "result": {
        const result = file.reason === "skipped_prior_no_gain"
          ? "Previously no gain"
          : file.reason === "skipped_already_compressed"
            ? "Already compressed"
            : file.reason === "skipped_incomplete"
              ? "Incomplete download"
              : file.reason || file.status;
        return <span className={`cm-result ${file.status}`} title={file.error}>{result}</span>;
      }
      default: return null;
    }
  };

  return (
    <div className="compression-monitor compression-monitor-v2">
      <aside className="cm-runs" aria-label="Compression runs">
        <div className="cm-runs-head">
          <strong>Runs</strong>
          <button className="icon-button" title="Refresh runs" onClick={() => void refreshJobs()}><Icon name="refresh" size={14} /></button>
        </div>
        <div className="cm-run-list">
          {jobs.map((job) => {
            const complete = job.done + job.skipped + job.errors;
            const percent = job.totalBytes ? (job.workCompletedBytes ?? 0) / job.totalBytes * 100 : complete / Math.max(1, job.total) * 100;
            return (
              <button key={job.id} className={`cm-run ${job.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(job.id)}>
                <span className={`cm-status-dot ${statusTone(job.status)}`} />
                <span className="cm-run-main">
                  <span><strong>{job.preset}</strong><em>{new Date(job.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</em></span>
                  <span className="cm-run-progress"><i style={{ width: `${percent}%` }} /></span>
                  <span><small>{job.status}</small><small>{complete.toLocaleString()} / {job.total.toLocaleString()}</small></span>
                </span>
                {job.status === "queued" && (() => {
                  const queueIndex = queuedIds.indexOf(job.id);
                  return (
                    <span className="cm-run-queue-actions">
                      <span role="button" tabIndex={0} aria-label="Move queued run earlier" className={queueIndex <= 0 ? "disabled" : ""} onClick={(event) => {
                        event.stopPropagation();
                        moveQueuedRun(job.id, -1);
                      }} onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        moveQueuedRun(job.id, -1);
                      }}><Icon name="caret-up" size={10} /></span>
                      <span role="button" tabIndex={0} aria-label="Move queued run later" className={queueIndex >= queuedIds.length - 1 ? "disabled" : ""} onClick={(event) => {
                        event.stopPropagation();
                        moveQueuedRun(job.id, 1);
                      }} onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        moveQueuedRun(job.id, 1);
                      }}><Icon name="caret-down" size={10} /></span>
                      <span role="button" tabIndex={0} aria-label="Remove queued run" onClick={(event) => {
                        event.stopPropagation();
                        void mutate("remove", () => removeQueuedCompressJob(job.id));
                      }} onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        void mutate("remove", () => removeQueuedCompressJob(job.id));
                      }}><Icon name="x" size={11} /></span>
                    </span>
                  );
                })()}
              </button>
            );
          })}
          {jobsLoading && !jobs.length && <div className="cm-empty">Loading runs...</div>}
          {!jobsLoading && !!jobsError && !jobs.length && <div className="cm-empty">Could not load runs</div>}
          {!jobsLoading && !jobsError && !jobs.length && <div className="cm-empty">No compression runs</div>}
        </div>
      </aside>

      <section className="cm-detail">
        {!selectedJob ? <div className="cm-empty centered">{jobsLoading ? "Loading compression runs..." : "Select a run to inspect it"}</div> : <>
          <header className="cm-job-header cm-job-header-v2">
            <div className="cm-job-title">
              <span className={`cm-status-pill ${statusTone(selectedJob.status)}`}>{selectedJob.status}</span>
              <strong>{selectedJob.preset}</strong>
              <span>{selectedJob.codec?.toUpperCase() ?? "H.264"} · {selectedJob.encoder ?? "Auto"}</span>
              <span title={selectedJob.outputDir || "Outputs are written beside each original"}>{selectedJob.outputDir || "In place"}</span>
              <span>Originals: {selectedJob.originalAction ?? "recycle"}</span>
            </div>
            <div className="cm-job-controls">
              <label className="cm-concurrency" title="Live worker limit; reductions apply after active files finish">
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
              </label>
              {selectedJob.status === "running" && <button className="compress-btn" title="Pause the queue after active files finish safely" disabled={!!busy} onClick={() => void mutate("pause", () => pauseCompressJob(selectedJob.id))}><Icon name="pause-fill" size={13} /> Pause queue</button>}
              {["paused", "pausing", "queued"].includes(selectedJob.status) && <button className="compress-btn" title={selectedJob.status === "pausing" ? "Cancel the pending pause and keep running" : "Resume this run"} disabled={!!busy} onClick={() => void mutate("resume", () => resumeCompressJob(selectedJob.id))}><Icon name="play-fill" size={13} /> {selectedJob.status === "pausing" ? "Keep running" : "Resume"}</button>}
              {["running", "pausing", "paused"].includes(selectedJob.status) && <button className="compress-btn danger" title="Stop immediately and remove partial outputs" disabled={!!busy} onClick={() => {
                if (window.confirm("Stop this run now? Active encoders will be terminated and partial outputs removed. The run remains resumable.")) {
                  void mutate("stop", () => cancelCompressJob(selectedJob.id));
                }
              }}><Icon name="stop-fill" size={13} /> Stop</button>}
            </div>
            <div className="cm-progress-summary">
              <div className="cm-overall-track" title="Size-weighted overall progress">
                <span className="success" style={segmentStyle(selectedJob.successfulBytes)} />
                <span className="active" style={segmentStyle(selectedJob.activeWorkBytes)} />
                <span className="skipped" style={segmentStyle(selectedJob.skippedBytes)} />
                <span className="failed" style={segmentStyle(selectedJob.failedBytes)} />
              </div>
              <strong>{fmtPct(bytePct)}</strong>
              <span>{processed.toLocaleString()} / {selectedJob.total.toLocaleString()} processed</span>
              <span>{selectedJob.activeCount ?? 0} active</span>
              <span>{formatBytes(selectedJob.savedBytes)} saved</span>
            </div>
            {isLowSpace && <div className="cm-warning"><Icon name="warning" size={13} /> Destination space is low. FileTree will keep the run intact and will not delete or skip work automatically.</div>}
          </header>

          <details
            className="cm-metrics-panel"
            open={metricsOpen}
            onToggle={(event) => setMetricsOpen(event.currentTarget.open)}
          >
            <summary className="cm-metrics-summary">
              <span>Run metrics</span>
              <label onClick={(event) => event.stopPropagation()}>
                <input type="checkbox" checked={layout.keepAwake} onChange={(event) => setLayout((current) => ({ ...current, keepAwake: event.target.checked }))} />
                Keep PC awake
              </label>
            </summary>
            <div className="cm-job-facts">
              <span><small>Active time</small>{fmtDuration(selectedJob.activeElapsedMs)}</span>
              <span><small>ETA</small>{overallEta == null ? "Calculating" : fmtDuration(overallEta)}</span>
              <span><small>Expected finish</small>{expectedFinish(overallEta)}</span>
              <span><small>Confidence</small>{confidence}</span>
            </div>
            <div className="cm-telemetry" aria-label="Compression telemetry">
              <Telemetry label="GPU encode" value={telemetryText(telemetry?.gpuVideoEncodePct, "%")} />
              <Telemetry label="Sessions" value={telemetryText(telemetry?.encoderSessions)} />
              <Telemetry label="Aggregate" value={telemetryText(telemetry?.aggregateFps, " fps")} />
              <Telemetry label="Pipeline CPU" value={telemetryText(telemetry?.encoderCpuPct, "%")} />
              <Telemetry label="RAM" value={telemetry?.ramBytes == null ? "Unavailable" : formatBytes(telemetry.ramBytes)} />
              <Telemetry label="Read" value={fmtRate(telemetry?.readBytesPerSec)} />
              <Telemetry label="Write" value={fmtRate(telemetry?.writeBytesPerSec)} />
              <Telemetry label="Free space" value={telemetry?.destinationFreeBytes == null ? "Unavailable" : formatBytes(telemetry.destinationFreeBytes)} warn={isLowSpace} />
            </div>
          </details>

          <div className="cm-toolbar">
            <div className="cm-search"><Icon name="search" size={13} /><input aria-label="Search files" placeholder="Search files, paths, outcomes..." value={searchInput} onChange={(event) => setSearchInput(event.target.value)} /></div>
            <div className="cm-quick-views">
              {(["all", "active", "queued", "completed", "attention"] as const).map((view) => <button key={view} className={(view === "attention" ? layout.attention : view === "active" ? layout.status === "running" : view === "queued" ? layout.status === "pending" : view === "completed" ? layout.status === "done,skipped,error" : !layout.status && !layout.attention) ? "selected" : ""} onClick={() => setQuickView(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}
            </div>
            <select title="File type" value={layout.kind} onChange={(event) => setLayout((current) => ({ ...current, kind: event.target.value }))}><option value="">All types</option><option value="video">Video</option><option value="image">Images</option><option value="other">Other</option></select>
            <select title="Original disposition" value={layout.disposition} onChange={(event) => setLayout((current) => ({ ...current, disposition: event.target.value }))}><option value="">Any disposition</option><option value="recycled">Recycled</option><option value="deleted">Deleted</option><option value="kept">Kept</option></select>
            <select title="Sort files" value={layout.sort} onChange={(event) => setLayout((current) => ({ ...current, sort: event.target.value as SortKey }))}>
              <option value="activity">Activity</option><option value="queue">Queue position</option><option value="name">Name</option><option value="size">Size</option><option value="progress">Progress</option><option value="elapsed">Elapsed</option><option value="eta">ETA</option><option value="speed">Speed</option><option value="savings">Savings</option><option value="result">Result</option><option value="start">Start time</option><option value="finish">Finish time</option>
            </select>
            <button className="icon-button" title={`Sort ${layout.direction === "asc" ? "descending" : "ascending"}`} onClick={() => setLayout((current) => ({ ...current, direction: current.direction === "asc" ? "desc" : "asc" }))}><Icon name="arrow-up" size={13} className={layout.direction === "desc" ? "flip-y" : ""} /></button>
            <div className="cm-columns-wrap">
              <button className="icon-button" title="Choose columns" onClick={() => setColumnsOpen((open) => !open)}><Icon name="columns" size={13} /></button>
              {columnsOpen && <div className="cm-columns-menu">{Object.entries(COLUMN_LABELS).map(([key, label]) => <label key={key}><input type="checkbox" checked={layout.columns.includes(key)} onChange={(event) => setLayout((current) => ({ ...current, columns: event.target.checked ? [...current.columns, key] : current.columns.filter((item) => item !== key) }))} /> {label}</label>)}</div>}
            </div>
          </div>

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
                {layout.columns.map((key) => <button key={key} className="cm-column-head" onClick={() => {
                  const sort = SORT_BY_COLUMN[key];
                  if (!sort) return;
                  setLayout((current) => ({ ...current, sort, direction: current.sort === sort && current.direction === "asc" ? "desc" : "asc" }));
                }}>{COLUMN_LABELS[key]}{layout.sort === SORT_BY_COLUMN[key] && <Icon name="caret-up" size={8} className={layout.direction === "desc" ? "flip-y" : ""} />}<span className="cm-resizer" onPointerDown={(event) => resizeColumn(key, event)} /></button>)}
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
              <footer className="cm-table-footer">{(pageMeta?.totalMatches ?? 0).toLocaleString()} matching · {(pageMeta?.total ?? 0).toLocaleString()} files · Active files and files finished in the last 15 seconds stay pinned</footer>
            </div>

            {inspected && <aside className="cm-inspector">
              <div className="cm-inspector-head"><strong title={inspected.path}>{fileName(inspected.path)}</strong><button className="icon-button" title="Close inspector" onClick={() => setInspected(null)}><Icon name="x" size={13} /></button></div>
              <InspectorField label="Source" value={inspected.path} />
              <InspectorField label="Output" value={inspected.outPath || "Not created"} />
              <div className="cm-inspector-actions">
                <button title="Open source" onClick={() => void openPath(inspected.path)}><Icon name="folder-open" size={12} /> Open</button>
                <button title="Reveal source" onClick={() => void revealPath(inspected.path)}><Icon name="search" size={12} /> Reveal</button>
                <button title="Copy source path" onClick={() => void copyText(inspected.path)}><Icon name="copy" size={12} /> Copy</button>
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
              <InspectorCode label="Command" value={inspected.command || "No external command recorded"} />
              <InspectorCode label="stderr" value={inspected.stderr || "No stderr recorded"} />
            </aside>}
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
