// Invented compression runs for the demo build. The running run advances in
// real time so the Monitor looks alive; controls mutate this in-memory state.
import type { CompressJobFile, CompressJobSummary, CompressLogRow, CompressTelemetry, CompressTools } from "../api/types";
import { DEMO_NOW, descendants, kindOf, lookup, nodes, type DemoNode } from "./fakeFs";

interface DemoJob { summary: CompressJobSummary; files: CompressJobFile[]; order: number }
const jobs = new Map<string, DemoJob>();
let seed = 7;
const next = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const media = (path: string, limit: number, kinds = ["video", "image"]) =>
  descendants(lookup(path)!).filter((node) => !node.isDir && kinds.includes(kindOf(node))).slice(0, limit);

function makeFile(node: DemoNode, index: number, status: CompressJobFile["status"], at: number): CompressJobFile {
  const kind = kindOf(node) as CompressJobFile["kind"];
  const video = kind === "video";
  const ratio = video ? 0.34 + next() * 0.32 : 0.18 + next() * 0.27;
  const done = status === "done";
  const newBytes = done ? Math.round(node.size * (1 - ratio)) : 0;
  const durationMs = video ? Math.round(node.size / (40 + next() * 60) / 1000) : Math.round(400 + next() * 1600);
  const outPath = node.path.replace(/(\.[^.]+)$/, " [COMPRESSED]$1");
  return {
    index, path: node.path, kind, status, pct: done || status === "skipped" || status === "error" ? 100 : 0,
    origBytes: node.size, newBytes, savedBytes: done ? node.size - newBytes : 0, pctSaved: done ? Math.round(ratio * 1000) / 10 : 0,
    reason: done ? "success" : status === "skipped" ? "skipped_no_gain" : status === "error" ? "error_unreadable_input" : "",
    error: status === "error" ? "The source could not be decoded (truncated download)." : undefined,
    encoder: done ? (video ? "nvenc_h265 q=26 preset=quality" : "ffmpeg libwebp q=82") : "",
    tool: video ? "handbrake" : "ffmpeg", toolVersion: video ? "1.9.2" : "7.1",
    durationMs: status === "pending" ? undefined : durationMs, disposition: done ? "recycled" : "", recycled: done,
    stage: status === "pending" ? "queued" : status === "running" ? "encoding" : "terminal",
    outputBytes: newBytes, outPath: done ? outPath : undefined,
    startedAt: status === "pending" ? undefined : at - durationMs, finishedAt: status === "pending" || status === "running" ? undefined : at,
    updatedAt: at, elapsedMs: status === "pending" ? undefined : durationMs,
  };
}

function summarize(job: DemoJob): void {
  const s = job.summary;
  const files = job.files;
  const count = (status: string) => files.filter((file) => file.status === status).length;
  const bytes = (status: string) => files.filter((file) => file.status === status).reduce((sum, file) => sum + file.origBytes, 0);
  const running = files.filter((file) => file.status === "running");
  Object.assign(s, {
    total: files.length, done: count("done"), errors: count("error"), skipped: count("skipped"),
    pending: count("pending") + running.length, savedBytes: files.reduce((sum, file) => sum + (file.savedBytes ?? 0), 0),
    totalBytes: files.reduce((sum, file) => sum + file.origBytes, 0), successfulBytes: bytes("done"), skippedBytes: bytes("skipped"),
    failedBytes: bytes("error"), activeWorkBytes: running.reduce((sum, file) => sum + file.origBytes * file.pct / 100, 0),
    activeCount: s.status === "running" ? running.length : 0,
    active: s.status === "running", resumable: ["paused", "cancelled"].includes(s.status) && count("pending") > 0,
  });
  s.workCompletedBytes = (s.successfulBytes ?? 0) + (s.skippedBytes ?? 0) + (s.failedBytes ?? 0) + (s.activeWorkBytes ?? 0);
}

function addJob(id: string, status: CompressJobSummary["status"], preset: CompressJobSummary["preset"], sources: DemoNode[], progress: number, createdAt: number, extras: Partial<Record<"errors" | "skipped", number>> = {}): void {
  const doneCount = Math.round(sources.length * progress);
  const files = sources.map((node, index) => {
    let fileStatus: CompressJobFile["status"] = index < doneCount ? "done" : "pending";
    if (index < doneCount && index % 11 === 5 && extras.skipped) fileStatus = "skipped";
    if (index < doneCount && index % 17 === 9 && extras.errors) fileStatus = "error";
    return makeFile(node, index, fileStatus, createdAt + (index + 1) * 90_000);
  });
  if (status === "running") files.filter((file) => file.status === "pending").slice(0, 2).forEach((file, i) => Object.assign(file, { status: "running", stage: "encoding", pct: 37 + i * 34, fps: 88 + i * 21, startedAt: Date.now() - 60_000 }));
  const job: DemoJob = {
    order: jobs.size, files,
    summary: {
      id, status, preset, total: 0, done: 0, errors: 0, skipped: 0, pending: 0, savedBytes: 0,
      concurrency: 2, encoder: "nvenc", codec: "h265", useGpu: true, originalAction: "recycle",
      queueRank: status === "queued" ? jobs.size : undefined, createdAt, updatedAt: createdAt + files.length * 60_000,
      activeElapsedMs: Math.round(files.length * progress * 80_000), active: false, resumable: false,
    },
  };
  summarize(job);
  jobs.set(id, job);
}

const hour = 3_600_000;
addJob("job-home-videos", "running", "balanced", media("D:\\Media\\Videos\\Home Videos", 60, ["video"]), 0.42, DEMO_NOW - 2 * hour);
["Aerial Reels", "Studio Sessions", "Timelapse Pack"].forEach((album, i) => addJob(`job-queued-${i}`, "queued", "balanced", media(`D:\\Media\\Downloads\\cyberdrop-dl\\${album}`, 40), 0, DEMO_NOW - (80 - i * 5) * 60_000));
addJob("job-nature", "paused", "more", media("D:\\Media\\Videos\\TV Shows\\Nature Frontiers", 40, ["video"]), 0.55, DEMO_NOW - 5 * hour);
addJob("job-photos-2023", "done", "high", media("D:\\Media\\Photos\\2023", 160, ["image"]), 1, DEMO_NOW - 26 * hour, { skipped: 1 });
addJob("job-movies", "done", "balanced", media("D:\\Media\\Videos\\Movies", 20, ["video"]), 1, DEMO_NOW - 50 * hour, { errors: 1 });
addJob("job-photos-2022", "cancelled", "max", media("D:\\Media\\Photos\\2022", 140, ["image"]), 0.36, DEMO_NOW - 74 * hour);

let lastTick = Date.now();
/** Advance running files so the Monitor shows live progress. */
function tick(): void {
  const now = Date.now();
  const elapsed = (now - lastTick) / 1000;
  lastTick = now;
  for (const job of jobs.values()) {
    if (job.summary.status !== "running") continue;
    for (const file of job.files.filter((item) => item.status === "running")) {
      file.pct = Math.min(100, file.pct + elapsed * 1.6);
      file.fps = Math.round(80 + Math.random() * 40);
      file.updatedAt = now;
      if (file.pct >= 100) {
        Object.assign(file, makeFile(nodes.find((node) => node.path === file.path)!, file.index, "done", now));
        const pending = job.files.find((item) => item.status === "pending");
        if (pending) Object.assign(pending, { status: "running", stage: "encoding", pct: 0, fps: 90, startedAt: now });
      }
    }
    if (!job.files.some((item) => item.status === "running" || item.status === "pending")) job.summary.status = "done";
    job.summary.updatedAt = now;
    summarize(job);
  }
}

export function listJobs(): { jobs: CompressJobSummary[] } {
  tick();
  return { jobs: [...jobs.values()].sort((a, b) => b.summary.createdAt - a.summary.createdAt).map((job) => ({ ...job.summary })) };
}

export function jobFiles(id: string, query: { offset?: number; limit?: number; search?: string; status?: string; type?: string; sort?: string; direction?: string }) {
  tick();
  const job = jobs.get(id);
  if (!job) return null;
  const statuses = query.status ? query.status.split(",") : [];
  let rows = job.files.filter((file) => (!statuses.length || statuses.includes(file.status))
    && (!query.type || file.kind === query.type) && (!query.search || file.path.toLowerCase().includes(query.search.toLowerCase())));
  const rank = (file: CompressJobFile) => ({ running: 0, pending: 2, error: 1 } as Record<string, number>)[file.status] ?? 1;
  const sign = query.direction === "asc" ? 1 : -1;
  rows = [...rows].sort((a, b) => query.sort === "size" ? (a.origBytes - b.origBytes) * sign
    : query.sort === "name" ? a.path.localeCompare(b.path) * sign
    : rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 250;
  const facet = (key: "status" | "kind") => job.files.reduce<Record<string, number>>((out, file) => { out[file[key]] = (out[file[key]] ?? 0) + 1; return out; }, {});
  return { id, offset, limit, total: job.files.length, totalMatches: rows.length, items: rows.slice(offset, offset + limit), facets: { status: facet("status"), type: facet("kind") } };
}

export function telemetry(): CompressTelemetry {
  const wobble = Math.sin(Date.now() / 3000);
  return {
    sampledAt: Date.now(), gpuVideoEncodePct: Math.round(76 + wobble * 8), encoderSessions: 2, aggregateFps: Math.round(188 + wobble * 22),
    encoderCpuPct: Math.round(13 + wobble * 3), ramBytes: 1.3 * 1024 ** 3, readBytesPerSec: Math.round((142 + wobble * 18) * 1024 ** 2),
    writeBytesPerSec: Math.round((58 + wobble * 9) * 1024 ** 2), destinationFreeBytes: 1.62 * 1024 ** 4,
    gpuMemoryUsedBytes: 3.2 * 1024 ** 3, gpuMemoryTotalBytes: 16 * 1024 ** 3,
  };
}

export function control(action: string, request: { id?: string; ids?: string[]; concurrency?: number }) {
  const job = request.id ? jobs.get(request.id) : undefined;
  const set = (status: CompressJobSummary["status"]) => { if (job) { job.summary.status = status; summarize(job); } };
  if (action === "pause" && job) set(job.summary.status === "running" || job.summary.status === "queued" ? "paused" : job.summary.status);
  else if ((action === "resume" || action === "retry") && job) set("running");
  else if (action === "cancel" && job) set("cancelled");
  else if (action === "queue-remove" && request.id) jobs.delete(request.id);
  else if (action === "concurrency" && job) job.summary.concurrency = request.concurrency ?? 2;
  else if (action === "queue-reorder") request.ids?.forEach((id, index) => { const queued = jobs.get(id); if (queued) queued.summary.queueRank = index; });
  return { ok: true, status: job?.summary.status, jobId: request.id };
}

export function startJob(request: { paths?: string[]; scanDirectories?: { directoryId: number }[]; preset?: CompressJobSummary["preset"]; queued?: boolean }) {
  const sources = [
    ...(request.paths ?? []).map(lookup).filter((node): node is DemoNode => !!node && !node.isDir),
    ...(request.scanDirectories ?? []).flatMap(({ directoryId }) => descendants(nodes[directoryId]).filter((node) => !node.isDir && kindOf(node) !== "other")),
  ];
  const id = `job-new-${jobs.size}`;
  addJob(id, request.queued ? "queued" : "running", request.preset ?? "balanced", sources, 0, Date.now());
  return { jobId: id, status: request.queued ? "queued" : "running", total: sources.length, skippedUnavailable: 0, skippedIneligible: 0, skippedMissing: 0 };
}

export function historyLog(limit: number): CompressLogRow[] {
  const rows: CompressLogRow[] = [];
  for (const job of jobs.values()) {
    for (const file of job.files) {
      if (!["done", "skipped", "error"].includes(file.status)) continue;
      rows.push({
        ts: new Date(file.finishedAt ?? DEMO_NOW).toISOString(), jobId: job.summary.id, index: file.index, path: file.path,
        name: file.path.split("\\").pop() ?? file.path, kind: file.kind, preset: job.summary.preset,
        status: file.status === "done" ? "success" : file.status === "skipped" ? "skipped_no_gain" : "error",
        origBytes: file.origBytes, newBytes: file.newBytes, savedBytes: file.savedBytes ?? 0, pctSaved: file.pctSaved ?? 0,
        ratio: file.origBytes ? file.newBytes / file.origBytes : 0, tool: file.tool ?? "", codecParams: file.encoder ?? "",
        durationMs: file.durationMs ?? 0, outPath: file.outPath ?? "", recycled: !!file.recycled, error: file.error ?? "",
        reason: file.reason ?? "", exitCode: file.status === "error" ? 3 : 0, toolVersion: file.toolVersion ?? "", command: "", stderrExcerpt: "",
      });
    }
  }
  return rows.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limit);
}

export const TOOLS: CompressTools = {
  handbrake: { found: true, version: "1.9.2", path: "C:\\Program Files\\HandBrake\\HandBrakeCLI.exe" },
  image: { found: true, version: "7.1", path: "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe", kind: "ffmpeg" },
  zip: { found: true },
  caps: { x265: true, nvencH264: true, nvencH265: true, nvencAv1: true, qsvH264: false, qsvH265: false, vceH264: false, vceH265: false, anyGpu: true },
  available: { nvenc: true, qsv: false, vce: false, anyGpu: true, nvencAssumed: false, qsvAssumed: false, vceAssumed: false },
  gpu: { nvidia: true, intel: false, amd: false },
  gpuHardware: { nvidia: true, intel: false, amd: false, names: ["NVIDIA GeForce RTX 4080"] },
  handbrakeHParseOk: true,
};
