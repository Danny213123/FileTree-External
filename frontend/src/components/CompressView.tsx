import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  NodeRecord,
  CompressTools,
  CompressPreset,
  CompressKind,
  CompressEvent,
  CompressJob,
  CompressJobFile,
  CompressJobRequest,
  CompressJobSummary,
  CompressLogRow,
  CompressEncoder,
  CompressCodec,
  OriginalAction,
} from "../api/types";
import {
  fetchCompressTools,
  installCompressTool,
  compressPreflight,
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
  testGpuEncoder,
  autotuneCompress,
  notify,
  type GpuTestResult,
  type AutotuneResult,
} from "../api/client";
import { invalidateAll as invalidateAllScanCache } from "../lib/scanCache";
import { formatBytes } from "../utils/formatBytes";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { CompressionMonitor } from "./CompressionMonitor";

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
  { id: "more", label: "More savings" },
  { id: "balanced", label: "Balanced" },
  { id: "high", label: "High quality" },
  { id: "custom", label: "Custom" },
];

/** Canonical video resolution-cap (px height; 0 ⇒ original) + quality (RF base)
 *  for each NAMED preset, mirroring the backend. Selecting a named preset writes
 *  these into the always-visible Resolution/Quality controls so they visibly
 *  move, while the values still round-trip via the preset id on the job. */
const PRESET_VALUES: Record<Exclude<CompressPreset, "custom">, { height: number; quality: number }> = {
  max: { height: 480, quality: 30 },
  more: { height: 720, quality: 27 },
  balanced: { height: 1080, quality: 24 },
  high: { height: 0, quality: 20 },
};

/** Resolution-cap options for the Custom preset. 0 ⇒ original (no downscale). */
const CUSTOM_HEIGHT_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Original" },
  { value: 1440, label: "1440p" },
  { value: 1080, label: "1080p" },
  { value: 720, label: "720p" },
  { value: 480, label: "480p" },
];
const CUSTOM_HEIGHTS = CUSTOM_HEIGHT_OPTIONS.map((o) => o.value);
const CUSTOM_QUALITY_MIN = 16;
const CUSTOM_QUALITY_MAX = 40;

// Tri-state disposition of the original after its compressed replacement passes
// the deep-verify gate. Recycle is recoverable (default); Delete is permanent
// (irreversible — flagged with a danger style); Keep leaves the original.
const ORIGINAL_ACTIONS: { id: OriginalAction; label: string; title: string }[] = [
  { id: "recycle", label: "Recycle Bin", title: "Send each original to the Recycle Bin after its compressed copy is verified (recoverable)." },
  { id: "delete", label: "Delete permanently", title: "Permanently delete each original after its compressed copy is verified. This cannot be undone." },
  { id: "keep", label: "Keep originals", title: "Leave every original in place; the new [COMPRESSED] file is created alongside it." },
];

/** Per-file disposition badge text + tooltip, keyed by the server's
 *  `disposition` string. */
const DISPOSITION_LABEL: Record<string, { label: string; title: string }> = {
  recycled: { label: "Recycled", title: "Original sent to the Recycle Bin (recoverable)." },
  deleted: { label: "Deleted", title: "Original permanently deleted." },
  kept: { label: "Kept", title: "Original left in place alongside the new file." },
};

// ── Performance settings (Section D: persist-settings) ──────────────────────
// User-tunable encoder/throughput knobs threaded into the job request. Persisted
// in localStorage; hardware-derived defaults are applied from /api/compress-tools
// the first time (encoder=auto, GPU on when any HW encoder is detected). The
// encoder picker is capability-gated so unavailable encoders can't be selected.

const PERF_KEY = "filetree.compress.perf";

interface CompressPerfSettings {
  /** 0 ⇒ let the server pick a hardware default (logical cores, lane-capped). */
  concurrency: number;
  encoder: CompressEncoder;
  useGpu: boolean;
  codec: CompressCodec;
  /** -1 ⇒ server default Deflate level; otherwise 0..9. */
  zipLevel: number;
  /** Minimum original size in bytes to attempt compression; smaller files are
   *  skipped untouched. 0 ⇒ no minimum (compress all). */
  minSizeBytes: number;
  /** Custom-preset video resolution cap (px height). One of {0,480,720,1080,
   *  1440}; 0 ⇒ original (no cap). Only used when preset === "custom". */
  customMaxHeight: number;
  /** Custom-preset video quality (RF base, 16..40; lower = better/larger).
   *  Only used when preset === "custom". */
  customQuality: number;
  /** Last-selected preset id, persisted so reopening restores the choice. May be
   *  a built-in id (max|more|balanced|high|custom) OR a saved-preset id of the
   *  form `user:<id>`; widened to string to carry saved presets. */
  preset: string;
  /** Whether the always-visible Options section (resolution/quality/codec/
   *  encoder) is expanded. Persisted so the choice sticks across sessions. */
  showOptions: boolean;
  /** Hide the encoder-missing warning banner (persisted dismissal). */
  bannerDismissed: boolean;
  /** Hide the preset dropdown + options row (persisted). */
  hidePresets: boolean;
  /** Last-used preset id remembered SEPARATELY per file kind (#20). Layered on
   *  top of `preset`: when a selection is dominated by one kind, the remembered
   *  preset for that kind is applied; whenever the user changes the preset it is
   *  recorded for the current selection's dominant kind. Values are the same id
   *  space as `preset` (built-in or `user:*`). Absent entries fall back to
   *  `preset`. */
  presetByKind: Partial<Record<CompressKind, string>>;
}

const DEFAULT_PERF: CompressPerfSettings = {
  concurrency: 0,
  encoder: "auto",
  useGpu: true,
  codec: "h264",
  zipLevel: -1,
  minSizeBytes: 0,
  customMaxHeight: 1080,
  customQuality: 26,
  preset: "balanced",
  showOptions: true,
  bannerDismissed: false,
  hidePresets: false,
  presetByKind: {},
};

/** Discrete stops for the minimum-size slider (bytes). Finer at the low end
 *  where it matters most (tiny clips / thumbnails), coarser past 10 MB. */
const MIN_SIZE_STOPS: number[] = [
  0,
  256 * 1024,
  512 * 1024,
  1024 * 1024,
  2 * 1024 * 1024,
  5 * 1024 * 1024,
  10 * 1024 * 1024,
  25 * 1024 * 1024,
  50 * 1024 * 1024,
  100 * 1024 * 1024,
];

/** Human label for a min-size stop value (bytes). 0 ⇒ "No minimum". */
function minSizeLabel(bytes: number): string {
  if (bytes <= 0) return "No minimum";
  return `Skip files under ${formatBytes(bytes)}`;
}

/** Snap an arbitrary byte count to the nearest defined stop (so a persisted
 *  custom value still maps onto the slider). */
function nearestMinSizeStopIndex(bytes: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < MIN_SIZE_STOPS.length; i++) {
    const d = Math.abs(MIN_SIZE_STOPS[i] - bytes);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

function loadPerf(): CompressPerfSettings {
  try {
    const raw = localStorage.getItem(PERF_KEY);
    if (!raw) return { ...DEFAULT_PERF };
    const p = JSON.parse(raw) as Partial<CompressPerfSettings>;
    return {
      concurrency: typeof p.concurrency === "number" && p.concurrency >= 0 ? Math.min(64, Math.floor(p.concurrency)) : 0,
      encoder: (["auto", "x264", "nvenc", "qsv", "vce"] as const).includes(p.encoder as CompressEncoder)
        ? (p.encoder as CompressEncoder)
        : "auto",
      useGpu: typeof p.useGpu === "boolean" ? p.useGpu : true,
      codec: p.codec === "h265" || p.codec === "av1" ? p.codec : "h264",
      zipLevel: typeof p.zipLevel === "number" && p.zipLevel >= -1 && p.zipLevel <= 9 ? Math.floor(p.zipLevel) : -1,
      minSizeBytes: typeof p.minSizeBytes === "number" && p.minSizeBytes >= 0 ? Math.floor(p.minSizeBytes) : 0,
      customMaxHeight:
        typeof p.customMaxHeight === "number" && CUSTOM_HEIGHTS.includes(Math.floor(p.customMaxHeight))
          ? Math.floor(p.customMaxHeight)
          : 1080,
      customQuality:
        typeof p.customQuality === "number"
          ? Math.min(CUSTOM_QUALITY_MAX, Math.max(CUSTOM_QUALITY_MIN, Math.floor(p.customQuality)))
          : 26,
      preset: (() => {
        const id = typeof p.preset === "string" ? p.preset : "";
        if ((["max", "more", "balanced", "high", "custom"] as const).includes(id as CompressPreset)) return id;
        // A saved-preset reference is only valid if that preset still exists;
        // otherwise fall back to "custom" (its values may already be in perf).
        if (id.startsWith("user:")) {
          return loadUserPresets().some((u) => u.id === id) ? id : "custom";
        }
        return "balanced";
      })(),
      showOptions: typeof p.showOptions === "boolean" ? p.showOptions : true,
      bannerDismissed: typeof p.bannerDismissed === "boolean" ? p.bannerDismissed : false,
      hidePresets: typeof p.hidePresets === "boolean" ? p.hidePresets : false,
      presetByKind: (() => {
        const raw = p.presetByKind;
        if (!raw || typeof raw !== "object") return {};
        const out: Partial<Record<CompressKind, string>> = {};
        for (const k of ["video", "image", "other"] as const) {
          const v = (raw as Record<string, unknown>)[k];
          if (typeof v === "string" && v) out[k] = v;
        }
        return out;
      })(),
    };
  } catch {
    return { ...DEFAULT_PERF };
  }
}

function savePerf(p: CompressPerfSettings): void {
  try { localStorage.setItem(PERF_KEY, JSON.stringify(p)); } catch { /* ignore quota / private mode */ }
}

// ── Saved custom presets ────────────────────────────────────────────────────
// Named bundles of {resolution cap, quality, codec, encoder} the user can save,
// rename, overwrite, and delete. They appear in the preset dropdown and, when
// selected, apply all four fields. On a job they resolve to the backend's
// existing `custom` preset (no backend change). Persisted in localStorage.

const USER_PRESETS_KEY = "filetree.compress.userPresets";

interface SavedPreset {
  id: string;
  name: string;
  customMaxHeight: number;
  customQuality: number;
  codec: CompressCodec;
  encoder: CompressEncoder;
}

/** Built-in NAMED presets resolve straight through to the backend; "custom" and
 *  any `user:*` saved preset resolve to backend `preset=custom`. */
function isBuiltinNamed(id: string): id is Exclude<CompressPreset, "custom"> {
  return id === "max" || id === "more" || id === "balanced" || id === "high";
}

/** Map a UI selection id to the value SENT to the backend. */
function toBackendPreset(id: string): CompressPreset {
  return isBuiltinNamed(id) ? id : "custom";
}

/** Generate a unique saved-preset id. */
function newUserPresetId(): string {
  return `user:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Load + validate saved presets, dropping any malformed entries. */
function loadUserPresets(): SavedPreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: SavedPreset[] = [];
    for (const e of arr) {
      if (!e || typeof e !== "object") continue;
      const id = (e as { id?: unknown }).id;
      const name = (e as { name?: unknown }).name;
      const height = (e as { customMaxHeight?: unknown }).customMaxHeight;
      const quality = (e as { customQuality?: unknown }).customQuality;
      const codec = (e as { codec?: unknown }).codec;
      const encoder = (e as { encoder?: unknown }).encoder;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof name !== "string" || name.trim().length === 0) continue;
      if (typeof height !== "number" || !CUSTOM_HEIGHTS.includes(Math.floor(height))) continue;
      if (typeof quality !== "number") continue;
      if (codec !== "h264" && codec !== "h265" && codec !== "av1") continue;
      if (!(["auto", "x264", "nvenc", "qsv", "vce"] as const).includes(encoder as CompressEncoder)) continue;
      out.push({
        id,
        name,
        customMaxHeight: Math.floor(height),
        customQuality: Math.min(CUSTOM_QUALITY_MAX, Math.max(CUSTOM_QUALITY_MIN, Math.floor(quality))),
        codec: codec as CompressCodec,
        encoder: encoder as CompressEncoder,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function saveUserPresets(list: SavedPreset[]): void {
  try { localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(list)); } catch { /* ignore quota / private mode */ }
}

/** Short human summary of a saved preset's four fields, e.g. "1080p · RF 24 · h264 · auto". */
function describeSavedPreset(sp: SavedPreset): string {
  const res = sp.customMaxHeight === 0 ? "Original" : `${sp.customMaxHeight}p`;
  return `${res} · RF ${sp.customQuality} · ${sp.codec} · ${sp.encoder}`;
}

interface PresetManagerDialogProps {
  presets: SavedPreset[];
  selectedId: string;
  currentSummary: string;
  onClose: () => void;
  onSaveCurrentAs: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onOverwrite: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Modal manager for saved custom presets: save-current-as, rename, overwrite
 *  with current values, and delete. Plain React state, no extra deps. */
function PresetManagerDialog({
  presets,
  selectedId,
  currentSummary,
  onClose,
  onSaveCurrentAs,
  onRename,
  onOverwrite,
  onDelete,
}: PresetManagerDialogProps) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const submitNew = () => {
    const t = newName.trim();
    if (!t) return;
    onSaveCurrentAs(t);
    setNewName("");
  };

  const commitRename = (id: string) => {
    const t = editName.trim();
    if (t) onRename(id, t);
    setEditingId(null);
    setEditName("");
  };

  return (
    <div className="compress-preset-overlay" role="presentation" onClick={onClose}>
      <div
        className="compress-preset-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Manage custom presets"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="compress-preset-dialog-head">
          <span className="compress-preset-dialog-title">Manage presets</span>
          <button className="compress-btn" onClick={onClose} aria-label="Close">Close</button>
        </div>

        <div className="compress-preset-save-row">
          <input
            className="compress-preset-input"
            type="text"
            placeholder="Save current as…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitNew(); }}
            aria-label="New preset name"
          />
          <button className="compress-btn primary" onClick={submitNew} disabled={!newName.trim()}>
            Save
          </button>
        </div>
        <div className="compress-preset-current-hint">Current: {currentSummary}</div>

        {presets.length === 0 ? (
          <div className="compress-preset-empty">No saved presets yet.</div>
        ) : (
          <ul className="compress-preset-list">
            {presets.map((sp) => (
              <li key={sp.id} className={`compress-preset-row${sp.id === selectedId ? " active" : ""}`}>
                {editingId === sp.id ? (
                  <input
                    className="compress-preset-input"
                    type="text"
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(sp.id);
                      else if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                    }}
                    onBlur={() => commitRename(sp.id)}
                    aria-label="Preset name"
                  />
                ) : (
                  <div className="compress-preset-meta">
                    <span className="compress-preset-name">{sp.name}</span>
                    <span className="compress-preset-desc">{describeSavedPreset(sp)}</span>
                  </div>
                )}
                <div className="compress-preset-actions">
                  {editingId === sp.id ? (
                    <button className="compress-btn" onClick={() => commitRename(sp.id)}>Done</button>
                  ) : (
                    <>
                      <button
                        className="compress-btn"
                        onClick={() => { setEditingId(sp.id); setEditName(sp.name); }}
                      >
                        Rename
                      </button>
                      <button
                        className="compress-btn"
                        onClick={() => onOverwrite(sp.id)}
                        title="Replace this preset's values with the current settings"
                      >
                        Update
                      </button>
                      <button className="compress-btn danger" onClick={() => onDelete(sp.id)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const ENCODER_OPTIONS: { id: CompressEncoder; label: string }[] = [
  { id: "auto", label: "Auto (best available)" },
  { id: "x264", label: "x264 (CPU)" },
  { id: "nvenc", label: "NVENC (NVIDIA)" },
  { id: "qsv", label: "QSV (Intel)" },
  { id: "vce", label: "AMF/VCE (AMD)" },
];

/** Whether a hardware encoder can be offered for the chosen codec. Gated on
 *  EFFECTIVE availability (HandBrake `-h` token OR a matching physical adapter),
 *  NOT just the `-h` parse — some builds omit the tokens from redirected help
 *  even though the encoder works, so an empty parse must not disable the GPU. */
function encoderAvailable(id: CompressEncoder, tools: CompressTools | null, _codec: CompressCodec): boolean {
  if (id === "auto" || id === "x264") return true;
  const av = tools?.available;
  if (av) {
    switch (id) {
      case "nvenc": return av.nvenc;
      case "qsv": return av.qsv;
      case "vce": return av.vce;
      default: return false;
    }
  }
  // Fallback for older servers that don't send `available`: use `-h` caps.
  const caps = tools?.caps;
  if (!caps) return false;
  switch (id) {
    case "nvenc": return caps.nvencH264 || caps.nvencH265;
    case "qsv": return caps.qsvH264 || caps.qsvH265;
    case "vce": return caps.vceH264 || caps.vceH265;
    default: return false;
  }
}

/** Effective "any GPU encoder available" — adapter-aware, with a graceful
 *  fallback to the `-h` caps for older servers. Drives the GPU toggle + default. */
function anyGpuAvailable(tools: CompressTools | null): boolean {
  if (!tools) return false;
  if (tools.available) return tools.available.anyGpu;
  return !!tools.caps?.anyGpu;
}

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
  /** Precise outcome code from the server (e.g. `error_verify_failed`). */
  reason?: string;
  /** True only when the original was recycled. */
  recycled?: boolean;
  /** What happened to the original: `recycled` | `deleted` | `kept` | "". */
  disposition?: string;
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

// Apply one per-file NDJSON event to a progress-Map draft in place. Used by the
// batched flush so all buffered events fold into a single Map clone + re-render.
// Mirrors the per-event semantics of the original `setProgress` switch exactly;
// only handles the batchable per-file events (job-level `done`/`job_start` are
// handled directly in `handleEvent`).
function applyProgressEvent(next: Map<number, FileProg>, ev: CompressEvent): void {
  switch (ev.type) {
    case "file_start": {
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
      break;
    }
    case "progress": {
      const cur = next.get(ev.index);
      if (!cur) break;
      next.set(ev.index, { ...cur, status: "running", pct: Math.max(0, Math.min(100, ev.pct)) });
      break;
    }
    case "file_done": {
      const cur = next.get(ev.index);
      next.set(ev.index, {
        index: ev.index,
        path: cur?.path ?? "",
        name: cur?.name ?? baseName(cur?.path ?? ""),
        kind: cur?.kind ?? "other",
        origBytes: ev.origBytes,
        status: ev.status === "skipped" || ev.status === "skipped_no_gain" ? "skipped" : "done",
        pct: 100,
        newBytes: ev.newBytes,
        savedBytes: ev.savedBytes,
        recycled: ev.recycled,
        disposition: ev.disposition,
        reason: ev.reason ?? cur?.reason,
      });
      break;
    }
    case "error": {
      const cur = next.get(ev.index);
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
        reason: ev.reason,
      });
      break;
    }
  }
}

/** Case-insensitive, separator- and trailing-slash-normalized path key, so the
 *  selection passed from the table matches the scan tree's reconstructed paths
 *  regardless of slash direction or drive-letter casing on Windows. */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// ── Pre-run savings estimate (#17) ───────────────────────────────────────────
// `compressPreflight` only classifies present/missing/cloud-only paths — it
// returns no size estimate — so this is a deliberately ROUGH frontend heuristic:
// an expected output-size RATIO per file from its kind + the active codec and
// quality (lower RF = bigger output) + resolution cap (downscaling shrinks
// video a lot). Clearly labeled "Est." in the UI; never a promise.

/** Expected output/original size ratio for one video, from codec + RF quality +
 *  resolution cap. Built from coarse real-world re-encode ratios, not measured. */
function videoRatio(codec: CompressCodec, quality: number, maxHeight: number): number {
  // Codec base ratio at the "balanced" RF (~24) with no downscale.
  const base = codec === "av1" ? 0.30 : codec === "h265" ? 0.38 : 0.55;
  // Quality: each RF step away from 24 scales the output ~6% (lower RF = larger).
  const q = Math.max(0.35, Math.min(1.6, 1 + (24 - quality) * 0.06));
  // Resolution cap: downscaling to a lower height removes a lot of data. 0 = no
  // cap. These multipliers assume most source video is ~1080p+.
  const res =
    maxHeight === 0 ? 1
    : maxHeight >= 1440 ? 0.95
    : maxHeight >= 1080 ? 0.8
    : maxHeight >= 720 ? 0.55
    : 0.4; // 480p
  return Math.max(0.12, Math.min(1.0, base * q * res));
}

/** Expected output/original ratio for one image at the given quality (RF reused
 *  as a JPEG-ish quality proxy). */
function imageRatio(quality: number): number {
  const q = Math.max(0.4, Math.min(1.3, 1 + (24 - quality) * 0.04));
  return Math.max(0.25, Math.min(1.0, 0.6 * q));
}

const ESTIMATE_ALREADY_COMPRESSED_EXTS = new Set([
  "zip", "7z", "rar", "gz", "bz2", "xz", "jpg", "jpeg", "png", "mp4", "mkv",
  "webm", "webp", "avif", "heic", "docx", "xlsx", "pptx", "pdf",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

interface SavingsEstimate {
  origBytes: number;
  estBytes: number;
  savedBytes: number;
  pctSaved: number;
}

/** Heuristic expected output size + savings for a set of files under the active
 *  codec/quality/resolution. "other" (zip) files that are already in an
 *  entropy-coded container are assumed not to shrink. */
function estimateSavings(
  files: CompressFile[],
  codec: CompressCodec,
  quality: number,
  maxHeight: number,
): SavingsEstimate {
  let orig = 0;
  let est = 0;
  for (const f of files) {
    orig += f.size;
    let ratio: number;
    if (f.kind === "video") ratio = videoRatio(codec, quality, maxHeight);
    else if (f.kind === "image") ratio = imageRatio(quality);
    else ratio = ESTIMATE_ALREADY_COMPRESSED_EXTS.has(extOf(f.name)) ? 0.98 : 0.65;
    est += f.size * ratio;
  }
  const estBytes = Math.min(orig, Math.round(est));
  const savedBytes = Math.max(0, orig - estBytes);
  return { origBytes: orig, estBytes, savedBytes, pctSaved: orig > 0 ? (savedBytes / orig) * 100 : 0 };
}

/** The kind that dominates a selection by file count (#20). Ties resolve in
 *  KIND_ORDER (video → image → other). Returns null for an empty selection. */
function dominantKind(files: CompressFile[]): CompressKind | null {
  if (files.length === 0) return null;
  const tally: Record<CompressKind, number> = { video: 0, image: 0, other: 0 };
  for (const f of files) tally[f.kind] += 1;
  let best: CompressKind = "other";
  let bestN = -1;
  for (const k of KIND_ORDER) {
    if (tally[k] > bestN) { bestN = tally[k]; best = k; }
  }
  return best;
}

/** One frontend-queued selection (#18): captured files + a frozen snapshot of
 *  the request fields so it starts identically to when it was enqueued, even if
 *  the user changes settings while the active job runs. */
interface QueuedBatch {
  id: string;
  files: CompressFile[];
  request: Omit<CompressJobRequest, "paths">;
  /** External (dropped, out-of-scan) paths exempt from the stale-tree guard. */
  externalPaths: Set<string>;
}

export function CompressView({
  scanPath,
  scannedRoot,
  nodeById,
  onRescan,
  initialSelectedPaths,
  onInitialApplied,
}: CompressViewProps) {
  const [tab, setTab] = useState<CompressTab>("compress");
  const [tools, setTools] = useState<CompressTools | null>(null);
  const [selectedId, setSelectedId] = useState<string>(() => loadPerf().preset);
  const [userPresets, setUserPresets] = useState<SavedPreset[]>(loadUserPresets);
  const [managerOpen, setManagerOpen] = useState(false);
  // The value SENT to the backend: built-in named passes through, Custom and any
  // saved (`user:*`) preset resolve to backend `preset=custom`.
  const backendPreset: CompressPreset = toBackendPreset(selectedId);
  const [originalAction, setOriginalAction] = useState<OriginalAction>("recycle");
  const [tagFilename, setTagFilename] = useState(true);
  const [perf, setPerf] = useState<CompressPerfSettings>(() => loadPerf());
  const [showPerf, setShowPerf] = useState(false);
  // Apply hardware-derived defaults once, only when the user hasn't saved any
  // preferences yet: turn GPU off when no hardware encoder was detected.
  const perfDefaultedRef = useRef(false);
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
  // Files dragged in from Explorer / the app that are NOT in the current scan
  // tree (#16). They carry synthetic negative ids (distinct from real node ids
  // and from the `< 0` sentinels skipped when deriving `files`) and are merged
  // into the source list. Their normalized paths are tracked so the start-time
  // stale-tree guard (which keys off `nodeById`) doesn't drop them as missing.
  const [extraFiles, setExtraFiles] = useState<CompressFile[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const extraIdRef = useRef(-1000);

  // Output destination (#21). "inplace" = the historical behavior (output beside
  // each original; originals disposed per `originalAction`). "folder" writes
  // every compressed copy into `outputDir`, leaving originals untouched.
  const [outputMode, setOutputMode] = useState<"inplace" | "folder">("inplace");
  const [outputDir, setOutputDir] = useState("");

  // Frontend job queue (#18). The backend already runs jobs concurrently, but a
  // queue lets the user line up several selections without babysitting: while a
  // job runs in THIS view, "Compress" enqueues; each batch auto-starts when the
  // active run reaches a terminal state.
  const [queue, setQueue] = useState<QueuedBatch[]>([]);
  // The dominant kind last auto-applied to the preset, so #20 only re-applies a
  // remembered preset when the dominant kind actually changes (never fighting a
  // manual choice the user makes while keeping the same selection).
  const lastDominantRef = useRef<CompressKind | null>(null);
  // Live mirror of the current selection's files, read inside `selectPreset` so
  // it can record the chosen preset for the selection's dominant kind (#20)
  // without depending on the (later-derived) memo.
  const selectedFilesRef = useRef<CompressFile[]>([]);
  // Epoch ms the active run started, for the "notify only if it ran a while" gate.
  const runStartRef = useRef<number>(0);
  // Synchronous promise guard: React state does not commit quickly enough to
  // stop a double-click (or two mounted panes) from issuing duplicate creates.
  const startAttemptRef = useRef<Promise<boolean> | null>(null);

  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<Map<number, FileProg>>(new Map());
  const [jobId, setJobId] = useState<string | null>(null);
  const [runError, setRunError] = useState("");
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const finalizedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Coalesce the per-file progress storm: large jobs (>160 files, 2-8 parallel
  // encoders) emit NDJSON `progress` lines faster than React can re-render. We
  // buffer non-terminal per-file events here and flush them all in a single Map
  // clone + re-render on the next animation frame, instead of cloning the whole
  // Map per event. Terminal job events (`done`/cancel/finalize) flush this
  // buffer synchronously first so the final per-file state and the single
  // completion toast are always correct.
  const pendingEventsRef = useRef<CompressEvent[]>([]);
  const flushRafRef = useRef<number | null>(null);

  // GPU test / auto-tune (definitive HW-encode probes on a tiny clip).
  const [gpuTest, setGpuTest] = useState<GpuTestResult | null>(null);
  const [autotune, setAutotune] = useState<AutotuneResult | null>(null);
  const [probing, setProbing] = useState<"" | "test" | "tune">("");
  const [diagCopied, setDiagCopied] = useState(false);

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

  // Merge + persist a perf-settings change.
  const updatePerf = useCallback((patch: Partial<CompressPerfSettings>) => {
    setPerf((prev) => {
      const next = { ...prev, ...patch };
      savePerf(next);
      return next;
    });
  }, []);

  // Remember a preset id as the last-used for one file kind (#20), merging into
  // the existing per-kind map and persisting.
  const recordPresetForKind = useCallback((kind: CompressKind, id: string) => {
    setPerf((prev) => {
      if (prev.presetByKind[kind] === id) return prev;
      const next = { ...prev, presetByKind: { ...prev.presetByKind, [kind]: id } };
      savePerf(next);
      return next;
    });
  }, []);

  // Select a preset AND persist it so reopening the app restores the choice.
  // A NAMED preset also writes its canonical video values into the always-visible
  // Resolution/Quality controls so they visibly move; "custom" keeps the current
  // shown values (which the user is editing directly). Also records the choice as
  // the last-used preset for the current selection's dominant kind (#20).
  const selectPreset = useCallback((id: string) => {
    const dom = dominantKind(selectedFilesRef.current);
    if (dom) recordPresetForKind(dom, id);
    setSelectedId(id);
    if (isBuiltinNamed(id)) {
      const v = PRESET_VALUES[id];
      updatePerf({ preset: id, customMaxHeight: v.height, customQuality: v.quality });
    } else if (id.startsWith("user:")) {
      const sp = loadUserPresets().find((u) => u.id === id);
      if (sp) {
        updatePerf({
          preset: id,
          customMaxHeight: sp.customMaxHeight,
          customQuality: sp.customQuality,
          codec: sp.codec,
          encoder: sp.encoder,
        });
      } else {
        // Referenced preset vanished — fall back to Custom, keeping shown values.
        setSelectedId("custom");
        updatePerf({ preset: "custom" });
      }
    } else {
      // "custom" — keep the current shown values, just persist the selection.
      updatePerf({ preset: "custom" });
    }
  }, [updatePerf, recordPresetForKind]);

  // Manually editing resolution OR quality switches to the Custom preset (the
  // job then encodes with the shown values) and persists the change.
  const changeResolution = useCallback((height: number) => {
    setSelectedId("custom");
    updatePerf({ preset: "custom", customMaxHeight: height });
  }, [updatePerf]);

  const changeQuality = useCallback((quality: number) => {
    setSelectedId("custom");
    updatePerf({ preset: "custom", customQuality: quality });
  }, [updatePerf]);

  // Codec/encoder are orthogonal for built-in presets (they don't switch the
  // selection), matching prior behavior — but when a SAVED preset is active they
  // are part of the saved bundle, so editing them defects to Custom.
  const changeCodec = useCallback((codec: CompressCodec) => {
    updatePerf({ codec });
    setSelectedId((prev) => {
      if (prev.startsWith("user:")) {
        updatePerf({ preset: "custom" });
        return "custom";
      }
      return prev;
    });
  }, [updatePerf]);

  const changeEncoder = useCallback((encoder: CompressEncoder) => {
    updatePerf({ encoder });
    setSelectedId((prev) => {
      if (prev.startsWith("user:")) {
        updatePerf({ preset: "custom" });
        return "custom";
      }
      return prev;
    });
  }, [updatePerf]);

  // ── Saved-preset management ────────────────────────────────────────────────
  const persistUserPresets = useCallback((next: SavedPreset[]) => {
    setUserPresets(next);
    saveUserPresets(next);
  }, []);

  // Create a saved preset from the CURRENT four fields, persist, and select it.
  const saveCurrentAsPreset = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const sp: SavedPreset = {
      id: newUserPresetId(),
      name: trimmed,
      customMaxHeight: perf.customMaxHeight,
      customQuality: perf.customQuality,
      codec: perf.codec,
      encoder: perf.encoder,
    };
    const next = [...userPresets, sp];
    persistUserPresets(next);
    setSelectedId(sp.id);
    updatePerf({ preset: sp.id });
  }, [perf, userPresets, persistUserPresets, updatePerf]);

  const renamePreset = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persistUserPresets(userPresets.map((u) => (u.id === id ? { ...u, name: trimmed } : u)));
  }, [userPresets, persistUserPresets]);

  // Overwrite a saved preset's four fields with the CURRENT values.
  const overwritePreset = useCallback((id: string) => {
    persistUserPresets(
      userPresets.map((u) =>
        u.id === id
          ? {
              ...u,
              customMaxHeight: perf.customMaxHeight,
              customQuality: perf.customQuality,
              codec: perf.codec,
              encoder: perf.encoder,
            }
          : u,
      ),
    );
  }, [perf, userPresets, persistUserPresets]);

  const deletePreset = useCallback((id: string) => {
    persistUserPresets(userPresets.filter((u) => u.id !== id));
    // Deleting the active preset falls back to Custom (its values stay in perf).
    setSelectedId((prev) => {
      if (prev === id) {
        updatePerf({ preset: "custom" });
        return "custom";
      }
      return prev;
    });
  }, [userPresets, persistUserPresets, updatePerf]);

  // Display name for the current selection (built-in label, saved name, Custom).
  const selectedPresetName = useMemo(() => {
    const builtin = PRESETS.find((p) => p.id === selectedId);
    if (builtin) return builtin.label;
    const saved = userPresets.find((u) => u.id === selectedId);
    if (saved) return saved.name;
    return "Custom";
  }, [selectedId, userPresets]);

  // Definitive GPU-encoder test: a real HW encode of a tiny generated clip.
  const onTestGpu = useCallback(async () => {
    setProbing("test");
    setGpuTest(null);
    try {
      const res = await testGpuEncoder(perf.encoder, perf.codec);
      setGpuTest(res);
    } finally {
      setProbing("");
    }
  }, [perf.encoder, perf.codec]);

  // Auto-tune: sample-encode CPU vs GPU and apply the faster recommendation.
  const onAutotune = useCallback(async () => {
    setProbing("tune");
    setAutotune(null);
    try {
      const res = await autotuneCompress(perf.codec);
      setAutotune(res);
      if (res.ok && res.recommendedEncoder) {
        updatePerf({
          encoder: res.recommendedEncoder as CompressEncoder,
          useGpu: res.recommendedUseGpu ?? perf.useGpu,
        });
      }
    } finally {
      setProbing("");
    }
  }, [perf.codec, perf.useGpu, updatePerf]);

  // Copy a plain-text diagnostics bundle (HandBrake path/version, `-h` evidence,
  // GPU adapter info, current encoder/codec settings, and the latest GPU
  // test / auto-tune outcomes) to the clipboard so it can be pasted into a bug
  // report. Best-effort: clipboard may be unavailable in some contexts.
  const onCopyDiagnostics = useCallback(async () => {
    const lines: string[] = [];
    lines.push(`FileTree compress diagnostics — ${new Date().toISOString()}`);
    if (tools) {
      const hb = tools.handbrake;
      lines.push(`HandBrake: ${hb.found ? (hb.path || "(on PATH)") : "NOT FOUND"}${hb.version ? ` v${hb.version}` : ""}`);
      lines.push(`HandBrake -h parse: ${tools.handbrakeHParseOk === false ? "no output (caps unknown)" : "ok"}`);
      if (tools.image) {
        lines.push(`Image tool: ${tools.image.found ? (tools.image.path || "(on PATH)") : "NOT FOUND"}${tools.image.kind ? ` [${tools.image.kind}]` : ""}${tools.image.version ? ` v${tools.image.version}` : ""}`);
      }
      const tokens = tools.caps
        ? [
            (tools.caps.nvencH264 || tools.caps.nvencH265 || tools.caps.nvencAv1) && "nvenc",
            (tools.caps.qsvH264 || tools.caps.qsvH265 || tools.caps.qsvAv1) && "qsv",
            (tools.caps.vceH264 || tools.caps.vceH265 || tools.caps.vceAv1) && "vce",
          ].filter(Boolean).join(", ") || "none"
        : "unknown";
      lines.push(`-h GPU tokens: ${tokens}`);
      lines.push(
        `Effective GPU encoders: ${
          anyGpuAvailable(tools)
            ? [
                tools.available?.nvenc && `NVENC${tools.available?.nvencAssumed ? "*" : ""}`,
                tools.available?.qsv && `QSV${tools.available?.qsvAssumed ? "*" : ""}`,
                tools.available?.vce && `VCE${tools.available?.vceAssumed ? "*" : ""}`,
              ].filter(Boolean).join(", ") || "available"
            : "none"
        } (* = assumed from adapter)`,
      );
      if (tools.caps) {
        lines.push(
          `Codec caps: x265=${!!tools.caps.x265} nvencH265=${!!tools.caps.nvencH265} qsvH265=${!!tools.caps.qsvH265} vceH265=${!!tools.caps.vceH265} nvencAv1=${!!tools.caps.nvencAv1} qsvAv1=${!!tools.caps.qsvAv1} vceAv1=${!!tools.caps.vceAv1}`,
        );
      }
      if (tools.gpuHardware?.names?.length) {
        lines.push(`GPU adapter(s): ${tools.gpuHardware.names.join(", ")}`);
      }
    } else {
      lines.push("Tools: not detected yet");
    }
    lines.push(`Settings: encoder=${perf.encoder} codec=${perf.codec} useGpu=${perf.useGpu} concurrency=${perf.concurrency} zipLevel=${perf.zipLevel} minSizeBytes=${perf.minSizeBytes} preset=${selectedPresetName} resolution=${perf.customMaxHeight === 0 ? "original" : `${perf.customMaxHeight}p`} quality=${perf.customQuality}`);
    if (gpuTest) {
      lines.push(
        `GPU test: ${
          gpuTest.ok
            ? gpuTest.success
              ? `OK ${gpuTest.encoder} in ${gpuTest.ms} ms (${gpuTest.outBytes ?? 0} bytes)`
              : `FAILED ${gpuTest.encoder ?? "?"}${gpuTest.exitCode != null ? ` exit ${gpuTest.exitCode}` : ""} ${gpuTest.stderr ?? ""}`
            : `error ${gpuTest.error ?? "unknown"}`
        }`,
      );
    }
    if (autotune) {
      lines.push(
        `Auto-tune: ${
          autotune.ok
            ? `CPU ${autotune.cpu?.success ? `${autotune.cpu.ms} ms` : "failed"}, GPU ${autotune.gpu ? (autotune.gpu.success ? `${autotune.gpu.ms} ms` : "failed") : "n/a"} → ${autotune.recommendedEncoder}${autotune.recommendedUseGpu ? " (GPU)" : " (CPU)"}`
            : `failed ${autotune.error ?? "unknown"}`
        }`,
      );
    }
    if (tools?.handbrakeEncodersRaw) {
      lines.push("HandBrake encoder list (raw):");
      lines.push(tools.handbrakeEncodersRaw);
    }
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setDiagCopied(true);
      window.setTimeout(() => setDiagCopied(false), 2000);
    } catch {
      // Fallback: a hidden textarea + execCommand for non-secure contexts.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setDiagCopied(true);
        window.setTimeout(() => setDiagCopied(false), 2000);
      } catch {
        // give up silently
      }
    }
  }, [tools, perf, selectedPresetName, gpuTest, autotune]);

  // Hardware-derived default: if no perf prefs were ever saved and NO GPU is
  // effectively available (no `-h` token AND no physical adapter), default GPU
  // off so Auto stays on CPU x264. When an adapter is present we leave GPU on
  // even if `-h` didn't list an encoder — the encode will try GPU and surface a
  // loud fallback if it can't.
  useEffect(() => {
    if (perfDefaultedRef.current || !tools) return;
    perfDefaultedRef.current = true;
    if (localStorage.getItem(PERF_KEY)) return; // user has explicit prefs
    if (!anyGpuAvailable(tools)) setPerf((p) => ({ ...p, useGpu: false }));
  }, [tools]);

  // Abort the stream + stop polling + cancel any pending progress flush on
  // unmount.
  useEffect(() => () => {
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (flushRafRef.current !== null) cancelAnimationFrame(flushRafRef.current);
  }, []);

  const inRun = runStatus !== "idle";

  // ── Source files (derived from the scan tree) ───────────────────────────────
  // In scoped mode only the launched selection's files are visible; otherwise
  // every compressible file in the scan is listed. Everything downstream
  // (counts, groups, select-all, totals) keys off this list, so scoping here is
  // enough to make the whole view reflect just the selection.
  //
  // Gated on `inRun`: while a job is running the view renders from `progArr`,
  // not from these scan-derived lists, and `nodeById` can change underneath us
  // (lazy tree loading). Re-scanning the whole selection on every progress
  // flush is exactly the main-thread saturation that blanks large jobs, so we
  // freeze the last idle value (held in a ref) for the duration of the run and
  // recompute fresh once it returns to idle.
  const idleFilesRef = useRef<CompressFile[]>([]);
  const files = useMemo(() => {
    if (inRun) return idleFilesRef.current;
    const out: CompressFile[] = [];
    const seen = new Set<string>();
    for (const node of nodeById.values()) {
      if (node.dir || node.id < 0 || !node.path) continue;
      if (scopePaths && !scopePaths.has(normPath(node.path))) continue;
      seen.add(normPath(node.path));
      out.push({
        id: node.id,
        path: node.path,
        name: node.name,
        size: node.size,
        kind: classifyKind(node.extension ?? ""),
      });
    }
    // Merge dragged-in external files (#16), skipping any that the scan tree now
    // covers (so a dropped file that's actually inside the scan doesn't double).
    for (const ef of extraFiles) {
      const key = normPath(ef.path);
      if (seen.has(key)) continue;
      if (scopePaths && !scopePaths.has(key)) continue;
      seen.add(key);
      out.push(ef);
    }
    return out;
  }, [nodeById, scopePaths, extraFiles, inRun]);
  idleFilesRef.current = files;

  // Normalized paths of dragged-in external files, used to exempt them from the
  // start-time stale-tree guard (which only knows about `nodeById`).
  const externalPathSet = useMemo(
    () => new Set(extraFiles.map((f) => normPath(f.path))),
    [extraFiles],
  );

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

  // Both derived from `files` and only consumed by the idle selection view, so
  // they inherit the same `inRun` freeze (skip recompute while a run is active).
  const idleFilteredRef = useRef<CompressFile[]>([]);
  const filteredFiles = useMemo(() => {
    if (inRun) return idleFilteredRef.current;
    return typeFilter === "all" ? files : files.filter((f) => f.kind === typeFilter);
  }, [files, typeFilter, inRun]);
  idleFilteredRef.current = filteredFiles;

  const idleGroupsRef = useRef<{ kind: CompressKind; items: CompressFile[] }[]>([]);
  const groups = useMemo(() => {
    if (inRun) return idleGroupsRef.current;
    return KIND_ORDER.map((kind) => ({
      kind,
      items: filteredFiles.filter((f) => f.kind === kind),
    })).filter((g) => g.items.length > 0);
  }, [filteredFiles, inRun]);
  idleGroupsRef.current = groups;

  const progArr = useMemo(
    () => [...progress.values()].sort((a, b) => a.index - b.index),
    [progress],
  );

  // Overall progress: files finished / total + an aggregate percentage.
  const total = progArr.length;
  const processedCount = progArr.filter(
    (f) => f.status === "done" || f.status === "skipped" || f.status === "error",
  ).length;
  const savedCount = progArr.filter((f) => f.status === "done").length;
  const skippedCount = progArr.filter((f) => f.status === "skipped").length;
  const failedCount = progArr.filter((f) => f.status === "error").length;
  const activeCount = progArr.filter((f) => f.status === "running").length;
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
  selectedFilesRef.current = selectedFiles;
  const selectedBytes = selectedFiles.reduce((s, f) => s + f.size, 0);
  const runnableSelected = useMemo(
    () => selectedFiles.filter((f) => kindAvailable(f.kind)),
    [selectedFiles, kindAvailable],
  );

  // #17 pre-run savings estimate for the runnable selection, under the active
  // codec/quality/resolution. Heuristic only (see `estimateSavings`).
  const savingsEstimate = useMemo(
    () => estimateSavings(runnableSelected, perf.codec, perf.customQuality, perf.customMaxHeight),
    [runnableSelected, perf.codec, perf.customQuality, perf.customMaxHeight],
  );

  // #20: when the selection's dominant kind changes (and we're not mid-run),
  // apply the remembered preset for that kind, if any. Guarded by a ref so it
  // only fires on a genuine kind change — never overriding a manual pick the
  // user makes while keeping the same selection.
  useEffect(() => {
    if (runStatus !== "idle") return;
    const dom = dominantKind(selectedFiles);
    if (!dom) { lastDominantRef.current = null; return; }
    if (lastDominantRef.current === dom) return;
    lastDominantRef.current = dom;
    const remembered = perf.presetByKind[dom];
    if (remembered && remembered !== selectedId) selectPreset(remembered);
  }, [selectedFiles, runStatus, perf.presetByKind, selectedId, selectPreset]);

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

  // ── Drag-and-drop onto the Compress page (#16) ──────────────────────────────
  // Accepts files/folders dropped from Explorer or elsewhere in the app and adds
  // them to the current selection. Paths already in the scan tree are matched to
  // their node ids (folders expand to descendant files via the same BFS the
  // right-click "Compress…" uses); paths OUTSIDE the scan are added as external
  // files using the dropped path + size directly. Dropped folders that aren't in
  // the scan can't be enumerated from the renderer, so they're surfaced in a
  // notice rather than silently dropped.
  const addDroppedEntries = useCallback(
    (entries: { path: string; isDir: boolean; size: number }[]) => {
      if (entries.length === 0) return;
      const idByPath = new Map<string, NodeRecord>();
      for (const node of nodeById.values()) {
        if (node.id < 0 || !node.path) continue;
        idByPath.set(normPath(node.path), node);
      }

      const idsToSelect: number[] = [];
      const newExtras: CompressFile[] = [];
      const newScopeKeys: string[] = [];
      const knownExtra = new Set(extraFiles.map((f) => normPath(f.path)));
      let unscannedFolders = 0;

      const pushExtra = (path: string, size: number) => {
        const key = normPath(path);
        if (knownExtra.has(key)) return;
        knownExtra.add(key);
        const id = extraIdRef.current--;
        newExtras.push({
          id,
          path,
          name: baseName(path),
          size,
          kind: classifyKind(extOf(baseName(path))),
        });
        idsToSelect.push(id);
        newScopeKeys.push(key);
      };

      for (const entry of entries) {
        const node = idByPath.get(normPath(entry.path));
        if (node) {
          if (!node.dir) {
            idsToSelect.push(node.id);
            newScopeKeys.push(normPath(node.path));
          } else {
            // Folder in the scan: BFS to its descendant files.
            const queue = [node.id];
            for (let qi = 0; qi < queue.length; qi++) {
              const cur = nodeById.get(queue[qi]);
              if (!cur) continue;
              if (!cur.dir) {
                if (cur.id >= 0 && cur.path) {
                  idsToSelect.push(cur.id);
                  newScopeKeys.push(normPath(cur.path));
                }
                continue;
              }
              for (const childId of cur.children) queue.push(childId);
            }
          }
          continue;
        }
        // Not in the scan tree.
        if (entry.isDir) {
          unscannedFolders += 1;
          continue;
        }
        pushExtra(entry.path, entry.size);
      }

      if (newExtras.length > 0) setExtraFiles((prev) => [...prev, ...newExtras]);
      if (idsToSelect.length > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of idsToSelect) next.add(id);
          return next;
        });
      }
      // When the view is scoped to a launched selection, widen the scope so the
      // dropped items actually appear (otherwise the `files` filter hides them).
      if (newScopeKeys.length > 0) {
        setScopePaths((prev) => {
          if (prev === null) return prev; // unscoped already shows everything
          const next = new Set(prev);
          for (const k of newScopeKeys) next.add(k);
          return next;
        });
      }

      const added = idsToSelect.length + newExtras.length;
      if (added > 0) {
        const ext = newExtras.length > 0 ? ` (${newExtras.length} from outside the scan)` : "";
        setPreselectNotice(`Added ${added.toLocaleString()} file${added === 1 ? "" : "s"} from the drop${ext}.`);
      } else if (unscannedFolders > 0) {
        setPreselectNotice(
          `Dropped folder${unscannedFolders === 1 ? "" : "s"} aren't in the current scan, so their contents couldn't be expanded — scan the folder first, or drop individual files.`,
        );
      }
    },
    [nodeById, extraFiles],
  );

  // Read dropped items synchronously (DataTransfer entries are invalidated once
  // the event handler returns), resolving each to an absolute path via the
  // Electron `getPathForFile` bridge and a directory flag via the entries API.
  const onZoneDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setDragActive(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const getPathForFile = (window as unknown as { electronAPI?: { getPathForFile?: (f: File) => string } })
        .electronAPI?.getPathForFile;
      const entries: { path: string; isDir: boolean; size: number }[] = [];
      const items = dt.items ? Array.from(dt.items) : [];
      const fileList = dt.files ? Array.from(dt.files) : [];
      const count = Math.max(items.length, fileList.length);
      for (let i = 0; i < count; i++) {
        const item = items[i];
        const file = item?.getAsFile?.() ?? fileList[i] ?? null;
        if (!file) continue;
        let path = "";
        try { path = getPathForFile?.(file) || (file as unknown as { path?: string }).path || ""; }
        catch { path = (file as unknown as { path?: string }).path || ""; }
        if (!path) continue;
        // A directory entry reports isDirectory via the entries API; fall back to
        // the heuristic that Explorer folders arrive as a 0-byte, type-less File.
        let isDir = false;
        const entry = item?.webkitGetAsEntry?.();
        if (entry) isDir = entry.isDirectory;
        else isDir = file.size === 0 && file.type === "";
        entries.push({ path, isDir, size: file.size });
      }
      addDroppedEntries(entries);
    },
    [addDroppedEntries],
  );

  const onZoneDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  const onZoneDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onZoneDragLeave = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

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
  // Apply every buffered per-file event in a single Map clone + re-render. Safe
  // to call synchronously (terminal events do, so the final state is correct).
  const flushPending = useCallback(() => {
    if (flushRafRef.current !== null) {
      cancelAnimationFrame(flushRafRef.current);
      flushRafRef.current = null;
    }
    const buf = pendingEventsRef.current;
    if (buf.length === 0) return;
    pendingEventsRef.current = [];
    setProgress((prev) => {
      const next = new Map(prev);
      for (const ev of buf) applyProgressEvent(next, ev);
      return next;
    });
  }, []);

  // Schedule a flush on the next animation frame (coalesces a burst of events
  // into one re-render). No-op if a frame is already pending.
  const scheduleFlush = useCallback(() => {
    if (flushRafRef.current !== null) return;
    flushRafRef.current = requestAnimationFrame(() => {
      flushRafRef.current = null;
      flushPending();
    });
  }, [flushPending]);

  // Drop any buffered events without applying them (used when the progress state
  // is being reset to a fresh job, so stale events never land on the new state).
  const cancelPendingFlush = useCallback(() => {
    if (flushRafRef.current !== null) {
      cancelAnimationFrame(flushRafRef.current);
      flushRafRef.current = null;
    }
    pendingEventsRef.current = [];
  }, []);

  const finalize = useCallback(
    (status: RunStatus, savedBytes: number, done: number) => {
      if (finalizedRef.current) return;
      // Apply any buffered per-file events synchronously before reconciling, so
      // the final per-file state and completion summary reflect every event.
      flushPending();
      finalizedRef.current = true;
      setRunStatus(status);
      if (done > 0) {
        invalidateAllScanCache();
        onRescan();
      }
      // Completion toast + OS notification (#23). Summarize the run in-app, and
      // for a job that ran a while (~20s+) OR finished while the window is in the
      // background, also fire a native OS notification (reusing the same
      // `notify` bridge the low-space alerts use). `finalizedRef` already
      // guards against duplicate calls, so each terminal job notifies once.
      const fileWord = done === 1 ? "file" : "files";
      let toastMsg = "";
      if (status === "done") {
        toastMsg = `Compressed ${done.toLocaleString()} ${fileWord} · saved ${formatBytes(savedBytes)}`;
        toast.success(toastMsg);
      } else if (status === "cancelled") {
        toastMsg = `Compression cancelled — ${done.toLocaleString()} ${fileWord} done · saved ${formatBytes(savedBytes)}`;
        toast.info(toastMsg);
      } else if (status === "error") {
        toastMsg = `Compression finished with errors — ${done.toLocaleString()} ${fileWord} done · saved ${formatBytes(savedBytes)}`;
        toast.error(toastMsg);
      }
      if (toastMsg) {
        const elapsedMs = runStartRef.current > 0 ? Date.now() - runStartRef.current : 0;
        const unfocused = typeof document !== "undefined" && !document.hasFocus();
        if (elapsedMs >= 20_000 || unfocused) {
          void notify("FileTree — compression", toastMsg);
        }
      }
      // Defensive reconciliation: on a true completion (not a user cancel, which
      // legitimately leaves files pending for Retry), any row still pending/
      // running never received a terminal outcome from the backend. Rather than
      // leave a perpetual spinner, surface it as not-processed so the run reads
      // honestly and the user can Retry.
      if (status !== "cancelled") {
        setProgress((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [idx, f] of next) {
            if (f.status === "pending" || f.status === "running") {
              next.set(idx, {
                ...f,
                status: "error",
                pct: 100,
                error: f.error ?? "Not processed — the run finished before this file was reached. Use Retry to resume.",
              });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    },
    [onRescan, flushPending],
  );

  const handleEvent = useCallback(
    (ev: CompressEvent) => {
      switch (ev.type) {
        case "job_start":
          setRunStatus("running");
          break;
        // Per-file events arrive in a storm on large jobs; buffer them and flush
        // on the next animation frame so a burst folds into one re-render.
        case "file_start":
        case "progress":
        case "file_done":
        case "error":
          pendingEventsRef.current.push(ev);
          scheduleFlush();
          break;
        case "done":
          // Terminal: finalize() flushes the pending buffer synchronously first.
          finalize("done", ev.savedBytes, ev.done);
          break;
      }
    },
    [finalize, scheduleFlush],
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
            reason: f.reason,
            recycled: f.recycled,
            disposition: f.disposition,
          });
        }
        return next;
      });
      if (["done", "cancelled", "error"].includes(snap.status)) {
        const done = snap.files.filter((f) => f.status === "done" || f.status === "skipped").length;
        finalize(snap.status as RunStatus, snap.savedBytes, done);
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

  // Freeze the current request fields (everything but `paths`) so a started OR
  // queued (#18) job runs with exactly these settings even if the user changes
  // controls afterward. "Output to folder" (#21) forces the original to Keep and
  // adds `outputDir`; the backend independently enforces both.
  const buildRequestBase = useCallback((): Omit<CompressJobRequest, "paths"> => {
    const useFolder = outputMode === "folder" && outputDir.trim().length > 0;
    return {
      preset: backendPreset,
      originalAction: useFolder ? "keep" : originalAction,
      // Back-compat for an older server: Recycle => true, else false.
      recycleOriginals: useFolder ? false : originalAction === "recycle",
      tagFilename,
      concurrency: perf.concurrency,
      encoder: perf.encoder,
      useGpu: perf.useGpu,
      codec: perf.codec,
      zipLevel: perf.zipLevel,
      minSizeBytes: perf.minSizeBytes,
      ...(backendPreset === "custom"
        ? { customMaxHeight: perf.customMaxHeight, customQuality: perf.customQuality }
        : {}),
      scanRoot: scannedRoot || scanPath || undefined,
      ...(useFolder ? { outputDir: outputDir.trim() } : {}),
    };
  }, [backendPreset, originalAction, tagFilename, perf, scannedRoot, scanPath, outputMode, outputDir]);

  // Start a job for an already-encoder-runnable file list + a frozen request.
  // Runs the stale-tree + backend pre-flight guards (exempting dragged-in
  // external files, which are legitimately outside the scan tree), wires up the
  // progress map + stream, and returns whether a job actually started. Shared by
  // the interactive Compress button and the queue runner (#18).
  const runFiles = useCallback(
    async (
      candidate: CompressFile[],
      requestBase: Omit<CompressJobRequest, "paths">,
      exemptExternal: Set<string>,
    ): Promise<boolean> => {
      if (startAttemptRef.current) return startAttemptRef.current;
      const attempt = (async (): Promise<boolean> => {
      if (candidate.length === 0) return false;

      // Stale-path guard: drop selections that no longer exist in the scan tree
      // or that point at a prior run's [COMPRESSED] output. Dragged-in external
      // files (#16) are exempt — they're knowingly outside the scan and are
      // validated by the backend pre-flight below instead.
      const livePaths = new Set<string>();
      for (const node of nodeById.values()) {
        if (node.dir || node.id < 0 || !node.path) continue;
        livePaths.add(normPath(node.path));
      }
      const COMPRESSED_RE = /\[COMPRESSED\]/i;
      const missing = candidate.filter(
        (f) => !exemptExternal.has(normPath(f.path)) && !livePaths.has(normPath(f.path)),
      );
      const alreadyCompressed = candidate.filter(
        (f) => livePaths.has(normPath(f.path)) && COMPRESSED_RE.test(f.name),
      );
      const dropped = new Set<number>([
        ...missing.map((f) => f.id),
        ...alreadyCompressed.map((f) => f.id),
      ]);
      const runnable = candidate.filter((f) => !dropped.has(f.id));

      if (dropped.size > 0) {
        const parts: string[] = [];
        if (missing.length > 0) {
          parts.push(`${missing.length} no longer exist${missing.length === 1 ? "s" : ""} (recycled by a prior run?)`);
        }
        if (alreadyCompressed.length > 0) {
          parts.push(`${alreadyCompressed.length} already-compressed output${alreadyCompressed.length === 1 ? "" : "s"}`);
        }
        const sample = [...missing, ...alreadyCompressed].slice(0, 3).map((f) => f.name).join(", ");
        setPreflightNotice(
          `Skipped ${dropped.size} file${dropped.size === 1 ? "" : "s"} before starting: ${parts.join(", ")}${sample ? ` — e.g. ${sample}` : ""}.`,
        );
        invalidateAllScanCache();
        onRescan();
      } else {
        setPreflightNotice("");
      }

      if (runnable.length === 0) {
        setRunStatus("idle");
        toast.info("Nothing to compress — all selected files were missing or already compressed.");
        return false;
      }

      // Authoritative backend pre-flight (on-disk existence + cloud placeholders).
      const pf = await compressPreflight(runnable.map((f) => f.path));
      const badSet = new Set([...pf.missing, ...pf.placeholder].map((p) => normPath(p)));
      const liveRunnable = badSet.size ? runnable.filter((f) => !badSet.has(normPath(f.path))) : runnable;
      if (badSet.size > 0) {
        const bits: string[] = [];
        if (pf.missing.length > 0) bits.push(`${pf.missing.length} no longer present`);
        if (pf.placeholder.length > 0) bits.push(`${pf.placeholder.length} cloud-only (not downloaded)`);
        toast.info(`Pre-flight skipped ${badSet.size} file${badSet.size === 1 ? "" : "s"}: ${bits.join(", ")}.`);
      }
      if (liveRunnable.length === 0) {
        setRunStatus("idle");
        toast.info("Nothing to compress — all selected files are missing or cloud-only.");
        return false;
      }

      abortRef.current?.abort();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      cancelPendingFlush();
      finalizedRef.current = false;
      setRunError("");

      const init = new Map<number, FileProg>();
      liveRunnable.forEach((f, i) => {
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
      runStartRef.current = Date.now();

      try {
        const id = await startCompressJob({ ...requestBase, paths: liveRunnable.map((f) => f.path) });
        setJobId(id);
        setTab("progress");
        void attachStream(id);
        return true;
      } catch (e) {
        finalizedRef.current = true;
        setRunStatus("error");
        setRunError(e instanceof Error ? e.message : String(e));
        toast.error(`Could not start compression: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      })();
      startAttemptRef.current = attempt;
      setStarting(true);
      const clearAttempt = () => {
        if (startAttemptRef.current === attempt) startAttemptRef.current = null;
        setStarting(false);
      };
      void attempt.then(clearAttempt, clearAttempt);
      return attempt;
    },
    [nodeById, attachStream, onRescan, cancelPendingFlush],
  );

  const handleStart = useCallback(async () => {
    const encoderRunnable = selectedFiles.filter((f) => kindAvailable(f.kind));
    if (encoderRunnable.length === 0) return;
    const skipped = selectedFiles.length - encoderRunnable.length;
    if (skipped > 0) {
      toast.info(`Skipping ${skipped} file${skipped === 1 ? "" : "s"} whose encoder isn't installed.`);
    }
    await runFiles(encoderRunnable, buildRequestBase(), externalPathSet);
  }, [selectedFiles, kindAvailable, runFiles, buildRequestBase, externalPathSet]);

  // ── Job queue (#18) ─────────────────────────────────────────────────────────
  // Enqueue the current selection as a frozen batch to auto-start when the
  // active run finishes. Each batch snapshots its files + request so later
  // control changes don't alter it.
  const handleEnqueue = useCallback(async () => {
    const encoderRunnable = selectedFiles.filter((f) => kindAvailable(f.kind));
    if (encoderRunnable.length === 0) return;
    try {
      const id = await startCompressJob({
        ...buildRequestBase(),
        paths: encoderRunnable.map((file) => file.path),
        queued: true,
      });
      setJobId(id);
      setSelected(new Set());
      setTab("progress");
      toast.info(`Queued ${encoderRunnable.length} file${encoderRunnable.length === 1 ? "" : "s"}. The batch is persisted and will survive a restart.`);
    } catch (error) {
      toast.error(`Could not queue compression: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [selectedFiles, kindAvailable, buildRequestBase, externalPathSet]);

  // Kick off the queue manually when idle (the auto-runner only fires after a
  // terminal state; this starts the first batch so the rest then chain).
  const startQueue = useCallback(() => {
    if (queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runFiles(next.files, next.request, next.externalPaths);
  }, [queue, runFiles]);

  // Auto-start the next queued batch once the active run reaches a terminal
  // state. Stays idle when nothing has run yet (queue only fills while a job is
  // running) and never double-starts: the popped batch is removed before launch,
  // and `runFiles` flips the status back to "running".
  useEffect(() => {
    if (queue.length === 0) return;
    if (runStatus === "running" || runStatus === "idle") return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void runFiles(next.files, next.request, next.externalPaths);
  }, [runStatus, queue, runFiles]);

  // ── Per-file re-compress from History (#19) ─────────────────────────────────
  // Start a fresh single-file job for `path`, using the current settings (or an
  // explicit built-in preset override). Confirms the source still exists first.
  // The new job appears in the In Progress tab (kept independent of the active
  // run-view state so it works regardless of what the Compress tab is showing).
  const compressAgain = useCallback(
    async (path: string, presetOverride?: string) => {
      if (!path) return;
      const norm = normPath(path);
      const pf = await compressPreflight([path]);
      if (pf.missing.some((p) => normPath(p) === norm)) {
        toast.error(`Can't re-compress — source no longer exists: ${baseName(path)}`);
        return;
      }
      if (pf.placeholder.some((p) => normPath(p) === norm)) {
        toast.error(`Can't re-compress — source is cloud-only (not downloaded): ${baseName(path)}`);
        return;
      }
      const base = buildRequestBase();
      const req: Omit<CompressJobRequest, "paths"> = presetOverride
        ? { ...base, preset: toBackendPreset(presetOverride) }
        : base;
      // The file may be outside the current scan root; register its own parent
      // as the scan root so the backend's containment check passes.
      const parent = path.replace(/[\\/]+[^\\/]+$/, "");
      try {
        const id = await startCompressJob({ ...req, paths: [path], scanRoot: parent || req.scanRoot });
        setJobId(id);
        setTab("progress");
        const presetName = presetOverride
          ? (PRESETS.find((p) => p.id === presetOverride)?.label ?? "Custom")
          : selectedPresetName;
        toast.success(`Re-compressing ${baseName(path)} (${presetName}) — see the In Progress tab.`);
      } catch (e) {
        toast.error(`Could not start re-compress: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [buildRequestBase, selectedPresetName],
  );

  const handleStop = useCallback(async () => {
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    // Apply whatever progress had buffered so the stopped run shows accurately.
    flushPending();
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
  }, [jobId, progArr, onRescan, flushPending]);

  const handleRetry = useCallback(async () => {
    if (!jobId) return;
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    // Drop buffered events from the prior attempt before resetting state.
    cancelPendingFlush();
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
  }, [jobId, attachStream, cancelPendingFlush]);

  const resetRun = useCallback(() => {
    abortRef.current?.abort();
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    cancelPendingFlush();
    finalizedRef.current = false;
    setRunStatus("idle");
    setProgress(new Map());
    setJobId(null);
    setRunError("");
  }, [cancelPendingFlush]);

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
      <div className="compress-tabs" role="tablist" aria-label="Setup / Monitor / History">
        <button
          role="tab"
          aria-selected={tab === "compress"}
          className={`compress-tab${tab === "compress" ? " active" : ""}`}
          onClick={() => setTab("compress")}
        >
          Setup
        </button>
        <button
          role="tab"
          aria-selected={tab === "progress"}
          className={`compress-tab${tab === "progress" ? " active" : ""}`}
          onClick={() => setTab("progress")}
        >
          Monitor
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
        <CompressionMonitor focusJobId={jobId} />
      ) : tab === "history" ? (
        <CompressHistory onCompressAgain={compressAgain} />
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
      {queue.length > 0 && (
        <div className="compress-notice queue">
          <span className="ct-ico"><Icon name="clock-history" size={14} /></span>
          <span>
            <b>{queue.length}</b> batch{queue.length === 1 ? "" : "es"} queued
            {" "}({queue.reduce((s, b) => s + b.files.length, 0).toLocaleString()} files)
            {inRun ? " — the next starts when the current job finishes." : " — see the In Progress tab."}
          </span>
          <button
            className="compress-notice-x"
            onClick={() => setQueue([])}
            title="Clear the queue"
          >
            ×
          </button>
        </div>
      )}
      {showBanner && !perf.bannerDismissed && (
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
          <button
            className="compress-notice-x"
            onClick={() => updatePerf({ bannerDismissed: true })}
            title="Hide this warning"
          >
            ×
          </button>
        </div>
      )}

      <div className="compress-toolbar">
        {!perf.hidePresets && (
        <div className="compress-group" aria-label="Quality preset">
          <span className="compress-group-label">Preset</span>
          <select
            className="compress-custom-select"
            aria-label="Quality preset"
            value={selectedId}
            onChange={(e) => selectPreset(e.target.value)}
            disabled={inRun}
          >
            <optgroup label="Presets">
              {PRESETS.filter((p) => p.id !== "custom").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            {userPresets.length > 0 && (
              <optgroup label="Saved">
                {userPresets.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </optgroup>
            )}
            <option value="custom">Custom</option>
          </select>
          <button
            className="compress-btn"
            onClick={() => setManagerOpen(true)}
            disabled={inRun}
            title="Save, rename, overwrite, or delete custom presets"
          >
            Manage presets
          </button>
          <button
            className={`compress-btn${perf.showOptions ? " active" : ""}`}
            onClick={() => updatePerf({ showOptions: !perf.showOptions })}
            disabled={inRun}
            aria-expanded={perf.showOptions}
            title="Resolution, quality, codec, and encoder"
          >
            {perf.showOptions ? "Hide options" : "Show options"}
          </button>
        </div>
        )}
        <div
          className="compress-group"
          role="radiogroup"
          aria-label="What to do with each original after a verified compress"
        >
          <span className="compress-group-label">Original</span>
          {ORIGINAL_ACTIONS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={originalAction === a.id}
              className={`compress-chip${originalAction === a.id ? " active" : ""}${
                a.id === "delete" ? " danger" : ""
              }`}
              onClick={() => setOriginalAction(a.id)}
              disabled={inRun}
              title={a.title}
            >
              {a.label}
            </button>
          ))}
        </div>
        <label className="compress-toggle">
          <input
            type="checkbox"
            checked={tagFilename}
            disabled={inRun}
            onChange={(e) => setTagFilename(e.target.checked)}
          />
          Add [COMPRESSED] tag
        </label>
        <div
          className="compress-group"
          role="radiogroup"
          aria-label="Where to write compressed outputs"
        >
          <span className="compress-group-label">Output</span>
          <button
            role="radio"
            aria-checked={outputMode === "inplace"}
            className={`compress-chip${outputMode === "inplace" ? " active" : ""}`}
            onClick={() => setOutputMode("inplace")}
            disabled={inRun}
            title="Write each compressed file beside its original, then dispose of the original per the Original setting."
          >
            In place
          </button>
          <button
            role="radio"
            aria-checked={outputMode === "folder"}
            className={`compress-chip${outputMode === "folder" ? " active" : ""}`}
            onClick={() => setOutputMode("folder")}
            disabled={inRun}
            title="Write every compressed copy into a chosen folder, leaving originals untouched."
          >
            Output to folder
          </button>
          {outputMode === "folder" && (
            <input
              type="text"
              className="compress-output-dir"
              value={outputDir}
              disabled={inRun}
              placeholder="Destination folder (e.g. D:\Compressed)"
              onChange={(e) => setOutputDir(e.target.value)}
              title="Absolute path of the folder to write compressed copies into. Originals are left untouched; name collisions get a numbered suffix."
              spellCheck={false}
            />
          )}
        </div>
        <button
          className={`compress-btn${showPerf ? " active" : ""}`}
          onClick={() => setShowPerf((v) => !v)}
          disabled={inRun}
          aria-expanded={showPerf}
          title="Encoder, GPU, concurrency, and zip settings"
        >
          <Icon name="tools" size={13} /> Performance
        </button>

        <div className="compress-toolbar-spacer" />

        {!inRun && (
          <>
            {runnableSelected.length > 0 && (
              <span
                className="compress-estimate"
                title="Rough heuristic from each file's type and the active codec/quality/resolution — not a measurement. Actual results vary."
              >
                Est. ~{formatBytes(savingsEstimate.savedBytes)} saved ({savingsEstimate.pctSaved.toFixed(0)}%)
              </span>
            )}
            <button className="compress-btn" onClick={selectAll} disabled={filteredFiles.length === 0}>
              Select all
            </button>
            <button className="compress-btn" onClick={clearSelection} disabled={selected.size === 0}>
              Clear
            </button>
            {runnableSelected.length > 0 && (
              <button
                className="compress-btn"
                onClick={handleEnqueue}
                disabled={outputMode === "folder" && !outputDir.trim()}
                title="Stash this selection as a queued batch and clear it so you can pick the next. Queued batches run one after another."
              >
                <Icon name="file-zip" size={13} /> Add to queue
              </button>
            )}
            {runnableSelected.length === 0 && queue.length > 0 ? (
              <button
                className="compress-btn primary"
                onClick={startQueue}
                disabled={starting}
                title={`Start the ${queue.length} queued batch${queue.length === 1 ? "" : "es"}`}
              >
                <Icon name="file-zip" size={13} /> {starting ? "Starting…" : `Start queue (${queue.length})`}
              </button>
            ) : (
              <button
                className="compress-btn primary"
                onClick={() => void handleStart()}
                disabled={starting || runnableSelected.length === 0 || (outputMode === "folder" && !outputDir.trim())}
                title={
                  runnableSelected.length === 0
                    ? "Select at least one file whose encoder is available"
                    : outputMode === "folder" && !outputDir.trim()
                      ? "Enter a destination folder, or switch Output back to In place"
                      : `Compress ${runnableSelected.length} file(s)`
                }
              >
                <Icon name="file-zip" size={13} /> {starting ? "Starting…" : `Compress ${runnableSelected.length > 0 ? `(${runnableSelected.length})` : ""}`}
              </button>
            )}
          </>
        )}
        {runStatus === "running" && (
          <>
            <button
              className="compress-btn"
              onClick={handleEnqueue}
              disabled={runnableSelected.length === 0 || (outputMode === "folder" && !outputDir.trim())}
              title={
                runnableSelected.length === 0
                  ? "Select files to queue"
                  : `Queue ${runnableSelected.length} file(s) to start after the current job`
              }
            >
              <Icon name="file-zip" size={13} /> Add to queue {runnableSelected.length > 0 ? `(${runnableSelected.length})` : ""}
            </button>
            <button className="compress-btn danger" onClick={() => void handleStop()}>
              <Icon name="stop-fill" size={13} /> Stop
            </button>
          </>
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

      {!perf.hidePresets && perf.showOptions && (
        <div className="compress-options" aria-label="Compression options">
          <div className="compress-perf-field">
            <label htmlFor="cv-resolution">Resolution</label>
            <select
              id="cv-resolution"
              value={perf.customMaxHeight}
              onChange={(e) => changeResolution(Number(e.target.value))}
              disabled={inRun}
            >
              {CUSTOM_HEIGHT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="compress-perf-field compress-perf-field-wide">
            <label htmlFor="cv-quality">
              Quality <span className="compress-custom-value">{perf.customQuality}</span>
            </label>
            <input
              id="cv-quality"
              type="range"
              className="compress-custom-range"
              min={CUSTOM_QUALITY_MIN}
              max={CUSTOM_QUALITY_MAX}
              step={1}
              value={perf.customQuality}
              onChange={(e) => changeQuality(Number(e.target.value))}
              disabled={inRun}
            />
            <span className="compress-perf-hint">lower = better quality, larger file</span>
          </div>
          <div className="compress-perf-field">
            <label htmlFor="cv-encoder">Video encoder</label>
            <select
              id="cv-encoder"
              value={perf.encoder}
              disabled={inRun}
              onChange={(e) => changeEncoder(e.target.value as CompressEncoder)}
            >
              {ENCODER_OPTIONS.map((o) => {
                const avail = encoderAvailable(o.id, tools, perf.codec);
                return (
                  <option key={o.id} value={o.id} disabled={!avail}>
                    {o.label}{!avail ? " — unavailable" : ""}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="compress-perf-field">
            <label htmlFor="cv-codec">Codec</label>
            <select
              id="cv-codec"
              value={perf.codec}
              disabled={inRun}
              onChange={(e) => changeCodec(e.target.value as CompressCodec)}
            >
              <option value="h264">H.264 (compatible)</option>
              <option value="h265" disabled={!!tools && !tools.caps?.x265 && !tools.caps?.nvencH265 && !tools.caps?.qsvH265 && !tools.caps?.vceH265}>
                H.265 (smaller)
              </option>
              {/* AV1: hardware AV1 needs a recent GPU (gated on the -h AV1 caps);
                  CPU SVT-AV1 is always available as a (slow) fallback, so the
                  option is never disabled, but the label flags HW availability. */}
              <option value="av1">
                AV1 (smallest{tools && (tools.caps?.nvencAv1 || tools.caps?.qsvAv1 || tools.caps?.vceAv1) ? ", GPU-capable" : ", CPU only"})
              </option>
            </select>
          </div>
        </div>
      )}

      {managerOpen && (
        <PresetManagerDialog
          presets={userPresets}
          selectedId={selectedId}
          currentSummary={`${perf.customMaxHeight === 0 ? "Original" : `${perf.customMaxHeight}p`} · RF ${perf.customQuality} · ${perf.codec} · ${perf.encoder}`}
          onClose={() => setManagerOpen(false)}
          onSaveCurrentAs={saveCurrentAsPreset}
          onRename={renamePreset}
          onOverwrite={overwritePreset}
          onDelete={deletePreset}
        />
      )}

      {showPerf && !inRun && (
        <div className="compress-perf-panel">
          <label className="compress-toggle">
            <input
              type="checkbox"
              checked={perf.hidePresets}
              onChange={(e) => updatePerf({ hidePresets: e.target.checked })}
            />
            Hide preset controls
          </label>
          <label className="compress-toggle">
            <input
              type="checkbox"
              checked={perf.bannerDismissed}
              onChange={(e) => updatePerf({ bannerDismissed: e.target.checked })}
            />
            Hide encoder-missing warning
          </label>
          <label className="compress-toggle">
            <input
              type="checkbox"
              checked={perf.useGpu}
              disabled={!anyGpuAvailable(tools)}
              onChange={(e) => updatePerf({ useGpu: e.target.checked })}
            />
            Use GPU when available
            {tools && !anyGpuAvailable(tools) && <span className="compress-perf-hint"> (no GPU detected)</span>}
            {tools && anyGpuAvailable(tools) && !tools.caps?.anyGpu && (
              <span className="compress-perf-hint"> (via adapter — verified on first run)</span>
            )}
          </label>
          <div className="compress-perf-field">
            <label htmlFor="cv-concurrency">Parallel files</label>
            <input
              id="cv-concurrency"
              type="number"
              min={0}
              max={64}
              value={perf.concurrency}
              onChange={(e) => updatePerf({ concurrency: Math.max(0, Math.min(64, Math.floor(Number(e.target.value) || 0))) })}
            />
            <span className="compress-perf-hint">0 = auto</span>
          </div>
          <div className="compress-perf-field">
            <label htmlFor="cv-zip">Zip level</label>
            <input
              id="cv-zip"
              type="number"
              min={-1}
              max={9}
              value={perf.zipLevel}
              onChange={(e) => updatePerf({ zipLevel: Math.max(-1, Math.min(9, Math.floor(Number(e.target.value) || -1))) })}
            />
            <span className="compress-perf-hint">-1 = default, 0-9</span>
          </div>
          <div className="compress-perf-field compress-perf-field-wide">
            <label htmlFor="cv-minsize">Minimum size</label>
            <input
              id="cv-minsize"
              type="range"
              min={0}
              max={MIN_SIZE_STOPS.length - 1}
              step={1}
              value={nearestMinSizeStopIndex(perf.minSizeBytes)}
              onChange={(e) => {
                const idx = Math.max(0, Math.min(MIN_SIZE_STOPS.length - 1, Math.floor(Number(e.target.value) || 0)));
                updatePerf({ minSizeBytes: MIN_SIZE_STOPS[idx] });
              }}
            />
            <span className="compress-perf-hint">{minSizeLabel(perf.minSizeBytes)}</span>
          </div>
          {tools?.handbrake.found && (
            <div className="compress-perf-diag">
              <div className="compress-perf-hint" title={tools.handbrake.path || undefined}>
                HandBrake: <code>{tools.handbrake.path || "(on PATH)"}</code>
                {tools.handbrake.version ? ` v${tools.handbrake.version}` : ""}
              </div>
              {/* Effective availability (adapter-aware), with how it was derived. */}
              <div className="compress-perf-hint">
                GPU encoders:{" "}
                {anyGpuAvailable(tools)
                  ? [
                      tools.available?.nvenc && `NVENC${tools.available?.nvencAssumed ? "*" : ""}`,
                      tools.available?.qsv && `QSV${tools.available?.qsvAssumed ? "*" : ""}`,
                      tools.available?.vce && `VCE${tools.available?.vceAssumed ? "*" : ""}`,
                    ]
                      .filter(Boolean)
                      .join(", ") || "available"
                  : "none"}
                {(tools.available?.nvencAssumed || tools.available?.qsvAssumed || tools.available?.vceAssumed) && (
                  <span> — * assumed from GPU adapter, verified on first encode</span>
                )}
              </div>
              {/* Ground-truth evidence: did `-h` parse, what did it report. */}
              <div className="compress-perf-hint">
                HandBrake <code>-h</code> parse: {tools.handbrakeHParseOk === false ? "no output (caps unknown)" : "ok"}
                {tools.caps && (
                  <>
                    {" "}· tokens:{" "}
                    {[
                      (tools.caps.nvencH264 || tools.caps.nvencH265 || tools.caps.nvencAv1) && "nvenc",
                      (tools.caps.qsvH264 || tools.caps.qsvH265 || tools.caps.qsvAv1) && "qsv",
                      (tools.caps.vceH264 || tools.caps.vceH265 || tools.caps.vceAv1) && "vce",
                    ]
                      .filter(Boolean)
                      .join(", ") || "none"}
                  </>
                )}
              </div>
              {tools.gpuHardware && tools.gpuHardware.names.length > 0 && (
                <div className="compress-perf-hint">GPU adapter(s): {tools.gpuHardware.names.join(", ")}</div>
              )}
              {/* Definitive checks: actually run the encoder(s) on a tiny clip. */}
              <div className="compress-perf-actions">
                <button
                  type="button"
                  className="compress-btn"
                  onClick={() => void onTestGpu()}
                  disabled={probing !== ""}
                  title="Run the resolved GPU encoder on a tiny generated clip to confirm it really encodes"
                >
                  {probing === "test" ? "Testing…" : "Test GPU encoder"}
                </button>
                <button
                  type="button"
                  className="compress-btn"
                  onClick={() => void onAutotune()}
                  disabled={probing !== ""}
                  title="Sample-encode CPU vs GPU and pick the faster encoder"
                >
                  {probing === "tune" ? "Tuning…" : "Auto-tune CPU vs GPU"}
                </button>
                <button
                  type="button"
                  className="compress-btn"
                  onClick={() => void onCopyDiagnostics()}
                  title="Copy HandBrake path/version, -h evidence, adapter info, and recent probe results to the clipboard"
                >
                  {diagCopied ? "Copied!" : "Copy diagnostics"}
                </button>
              </div>
              {gpuTest && (
                <div className={gpuTest.ok && gpuTest.success ? "compress-perf-note" : "compress-perf-warn"}>
                  {gpuTest.ok
                    ? gpuTest.success
                      ? `GPU encode OK: ${gpuTest.encoder} in ${gpuTest.ms} ms (${formatBytes(gpuTest.outBytes ?? 0)}).`
                      : `GPU encode FAILED: ${gpuTest.encoder ?? "?"}${gpuTest.exitCode != null ? ` (exit ${gpuTest.exitCode})` : ""}. ${gpuTest.stderr ?? ""}`
                    : `Could not test: ${gpuTest.error ?? "unknown error"}`}
                </div>
              )}
              {autotune && (
                <div className="compress-perf-note">
                  {autotune.ok
                    ? `Auto-tune: CPU ${autotune.cpu?.success ? `${autotune.cpu.ms} ms` : "failed"}` +
                      `, GPU ${autotune.gpu ? (autotune.gpu.success ? `${autotune.gpu.ms} ms` : "failed") : "n/a"}` +
                      ` → using ${autotune.recommendedEncoder}${autotune.recommendedUseGpu ? " (GPU)" : " (CPU)"}.`
                    : `Auto-tune failed: ${autotune.error ?? "unknown error"}`}
                </div>
              )}
              {tools.handbrakeEncodersRaw && (
                <details className="compress-perf-evidence">
                  <summary className="compress-perf-hint">HandBrake encoder list (raw)</summary>
                  <pre className="compress-perf-raw">{tools.handbrakeEncodersRaw}</pre>
                </details>
              )}
              {/* Adapter present but `-h` empty: GPU will still be attempted; a
                  failure surfaces loudly as a gpu_fallback outcome with the error. */}
              {!tools.caps?.anyGpu && anyGpuAvailable(tools) && (
                <div className="compress-perf-note">
                  A GPU adapter is present but HandBrake&apos;s <code>-h</code> didn&apos;t list a hardware
                  encoder. FileTree will still try the GPU encoder; if it fails, the file shows a
                  <b> GPU→CPU fallback</b> with HandBrake&apos;s exact error. NVENC activity appears under
                  Task Manager → Performance → GPU → <b>Video Encode</b>.
                </div>
              )}
              {/* No GPU adapter at all and no -h encoder: genuinely CPU-only. */}
              {!anyGpuAvailable(tools) && (
                <div className="compress-perf-warn">
                  No GPU encoder or adapter detected, so encoding will use the CPU. If you have a
                  GPU-capable HandBrakeCLI elsewhere, point <code>FILETREE_HANDBRAKE</code> at it (or drop
                  it into the app&apos;s tools folder) and reopen this panel.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {inRun && (
        <div className="compress-overall">
          <span className="compress-overall-text">
            <b>{processedCount.toLocaleString()}</b> / {total.toLocaleString()} processed
          </span>
          <div className="compress-bar" title={`${aggregatePct}%`}>
            <div className="compress-bar-fill" style={{ width: `${aggregatePct}%` }} />
          </div>
          <span className="compress-overall-text">
            {aggregatePct}% · {activeCount.toLocaleString()} active · {savedCount.toLocaleString()} saved ·{" "}
            {skippedCount.toLocaleString()} skipped · {failedCount.toLocaleString()} failed ·{" "}
            <span className="compress-saved">{formatBytes(savedTotal)}</span>
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

      <div
        className={`compress-body${dragActive ? " drag-active" : ""}`}
        ref={setScrollEl}
        onDragEnter={onZoneDragEnter}
        onDragOver={onZoneDragOver}
        onDragLeave={onZoneDragLeave}
        onDrop={onZoneDrop}
      >
        {dragActive && (
          <div className="compress-dnd-overlay" aria-hidden="true">
            <div className="compress-dnd-card">
              <Icon name="file-zip" size={22} />
              <span>Drop files to add them to the selection</span>
            </div>
          </div>
        )}
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
                    onDoubleClick={() => void openPath(f.path)}
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
                  {rf.status === "done" && rf.disposition && DISPOSITION_LABEL[rf.disposition] && (
                    <span
                      className={`compress-chip-status disposition ${rf.disposition}`}
                      title={DISPOSITION_LABEL[rf.disposition].title}
                    >
                      {DISPOSITION_LABEL[rf.disposition].label}
                    </span>
                  )}
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
  skipped_prior_no_gain: "Previously no gain",
  skipped_too_small: "Too small",
  error: "Error",
};

// Human-readable label + tooltip for each precise reason code the backend
// produces (compress_job::Reason). Used in the progress rows and History tab so
// any per-file outcome is explained rather than a bare "skipped"/"error".
const REASON_LABEL: Record<string, string> = {
  success: "Saved",
  skipped_no_gain: "Skipped — not smaller",
  skipped_prior_no_gain: "Skipped — unchanged since prior no-gain result",
  skipped_too_small: "Skipped — too small",
  error_tool_missing: "Error — tool missing",
  error_unsupported: "Error — unsupported",
  error_encoder: "Error — encoder failed",
  error_unreadable_input: "Error — corrupt input",
  error_output_empty: "Error — empty output",
  error_source_missing: "Error — source missing",
  error_cloud_placeholder: "Skipped — cloud-only file",
  error_spawn: "Error — couldn't start",
  error_internal: "Error — internal",
  error_verify_failed: "Verify failed",
  gpu_fallback: "Saved — GPU→CPU fallback",
};

const REASON_TOOLTIP: Record<string, string> = {
  success: "Output was smaller; original replaced.",
  skipped_no_gain: "The re-encoded output wasn't smaller than the original, so it was discarded and the original kept.",
  skipped_prior_no_gain: "The source and compression profile are unchanged since a prior encode produced no savings, so no encoder was started.",
  skipped_too_small: "The original was below the minimum-size threshold, so it was left untouched without attempting to compress (too small to meaningfully shrink — e.g. a video with too few frames).",
  error_tool_missing: "The required encoder (HandBrake for video, ffmpeg/ImageMagick for images) isn't installed.",
  error_unsupported: "This file type has no supported compression pipeline.",
  error_encoder: "The encoder ran but exited with an error. See the debug log / stderr excerpt for details.",
  error_unreadable_input: "The source video is corrupt or incomplete — HandBrake found no readable title (e.g. \"moov atom not found\" / \"no title found\"). This is usually a partial or failed download; the original was left untouched. Re-download the file rather than retrying.",
  error_output_empty: "The encoder reported success but produced a missing or empty output file.",
  error_source_missing: "The source file no longer exists — it may have been recycled by a prior run.",
  error_cloud_placeholder: "The source is a cloud-only placeholder (OneDrive/Files On-Demand) that isn't downloaded locally. It was skipped to avoid forcing a large download — set it to \"Always keep on this device\" and retry.",
  error_spawn: "The encoder process could not be started.",
  error_internal: "An unexpected internal error occurred while processing this file (a caught worker error). The rest of the batch was unaffected; retry to re-run this file.",
  error_verify_failed: "The compressed output failed integrity verification (re-decode / CRC check), so it was discarded and the ORIGINAL was preserved untouched. Nothing was removed; retry to re-compress this file.",
  gpu_fallback: "The GPU encoder failed, so the file was re-encoded on the CPU. The file still compressed; see the error/stderr for the exact GPU failure (driver/session/codec).",
};

/** CSS status class for a History row, derived from the precise reason (falls
 *  back to the coarse status). */
function reasonClass(reason: string, status: string): string {
  if (reason === "success" || reason === "gpu_fallback" || status === "success") return "done";
  if (reason.startsWith("skipped_") || status === "skipped" || status === "skipped_no_gain")
    return "skipped";
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
      if (rf.reason === "skipped_too_small") {
        return { label: "Too small", title: REASON_TOOLTIP.skipped_too_small };
      }
      if (rf.reason === "skipped_prior_no_gain") {
        return { label: "Previously no gain", title: REASON_TOOLTIP.skipped_prior_no_gain };
      }
      return { label: "No gain", title: REASON_TOOLTIP.skipped_no_gain };
    case "error":
      if (rf.reason && REASON_LABEL[rf.reason]) {
        return { label: REASON_LABEL[rf.reason], title: rf.error || REASON_TOOLTIP[rf.reason] || "" };
      }
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

type FileOutcome = "passed" | "failed" | "skipped" | "pending";

/** Classify a per-file snapshot row into a coarse outcome for badges + filters. */
function outcomeOf(f: CompressJobFile): FileOutcome {
  if (f.status === "done") return "passed";
  if (f.status === "error") return "failed";
  if (f.status === "skipped") return "skipped";
  return "pending"; // pending / running
}

const OUTCOME_FILTERS: { id: "all" | FileOutcome; label: string }[] = [
  { id: "all", label: "All" },
  { id: "passed", label: "Passed" },
  { id: "failed", label: "Failed" },
  { id: "skipped", label: "Skipped" },
];

const FILE_DETAIL_ROW_H = 30;

/** The on-disk target to act on for a compress row: prefer the produced output
 *  (still present after a run), fall back to the original source path. */
function rowTarget(path: string | undefined, outPath?: string): string {
  return outPath && outPath.length > 0 ? outPath : path ?? "";
}

/** Open a compress row's file in its default app (output if present, else source). */
function openRow(path: string | undefined, outPath?: string): void {
  const t = rowTarget(path, outPath);
  if (t) void openPath(t);
}

/** Native OS context menu for one or more compress rows. */
function rowContextMenu(e: React.MouseEvent, paths: string[]): void {
  e.preventDefault();
  const targets = paths.filter((p) => p && p.length > 0);
  if (targets.length) void shellContextMenu(targets, e.clientX, e.clientY);
}

/** Lightweight row selection (single / ctrl-toggle / shift-range) over an ordered
 *  key list, so the compress tables select and right-click like the main table. */
function useRowSelection<K>() {
  const [sel, setSel] = useState<Set<K>>(new Set());
  const anchorRef = useRef<K | null>(null);
  const onRowClick = useCallback((key: K, index: number, order: K[], e: React.MouseEvent) => {
    setSel((prev) => {
      const next = new Set<K>(prev);
      if (e.shiftKey && anchorRef.current != null) {
        const a = order.indexOf(anchorRef.current);
        if (a >= 0) {
          next.clear();
          const [lo, hi] = a < index ? [a, index] : [index, a];
          for (let i = lo; i <= hi; i++) next.add(order[i]);
          return next;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
        anchorRef.current = key;
        return next;
      }
      next.clear();
      next.add(key);
      anchorRef.current = key;
      return next;
    });
  }, []);
  return { sel, setSel, onRowClick };
}

/** Per-file detail table shown inside an expanded run row. Virtualizes when a
 *  run has many files; lets the user filter by outcome (passed/failed/skipped). */
function JobFileTable({ files, loading }: { files: CompressJobFile[] | undefined; loading: boolean }) {
  const [filter, setFilter] = useState<"all" | FileOutcome>("all");
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { sel, onRowClick } = useRowSelection<number>();

  const rows = useMemo(() => {
    const all = files ?? [];
    return filter === "all" ? all : all.filter((f) => outcomeOf(f) === filter);
  }, [files, filter]);

  const order = useMemo(() => rows.map((f) => f.index), [rows]);
  const rowMenu = useCallback(
    (e: React.MouseEvent, f: CompressJobFile) => {
      const targets = sel.has(f.index) && sel.size > 1
        ? rows.filter((r) => sel.has(r.index)).map((r) => rowTarget(r.path))
        : [rowTarget(f.path)];
      rowContextMenu(e, targets);
    },
    [sel, rows],
  );

  const counts = useMemo(() => {
    const c = { passed: 0, failed: 0, skipped: 0, pending: 0 };
    for (const f of files ?? []) c[outcomeOf(f)] += 1;
    return c;
  }, [files]);

  // Disposition + verify-failed tallies for the reconciled summary line (so the
  // user can see exactly how many originals were recycled/deleted/kept and that
  // every file is accounted for).
  const dispo = useMemo(() => {
    const d = { recycled: 0, deleted: 0, kept: 0, verifyFailed: 0 };
    for (const f of files ?? []) {
      if (f.disposition === "recycled") d.recycled += 1;
      else if (f.disposition === "deleted") d.deleted += 1;
      else if (f.disposition === "kept") d.kept += 1;
      if (f.reason === "error_verify_failed") d.verifyFailed += 1;
    }
    return d;
  }, [files]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => FILE_DETAIL_ROW_H,
    overscan: 10,
  });

  if (loading && (!files || files.length === 0)) {
    return <div className="compress-jobfiles-empty">Loading file details…</div>;
  }
  if (!files || files.length === 0) {
    return <div className="compress-jobfiles-empty">No per-file detail available for this run.</div>;
  }

  return (
    <div className="compress-jobfiles">
      <div className="compress-jobfiles-filter" role="tablist" aria-label="Filter files by outcome">
        {OUTCOME_FILTERS.map((o) => {
          const n = o.id === "all" ? files.length : counts[o.id as FileOutcome];
          return (
            <button
              key={o.id}
              role="tab"
              aria-selected={filter === o.id}
              className={`compress-chip${filter === o.id ? " active" : ""}`}
              onClick={() => setFilter(o.id)}
            >
              {o.label} ({n.toLocaleString()})
            </button>
          );
        })}
      </div>
      <div className="compress-jobfiles-reconcile">
        <span title="Every input file lands in exactly one bucket; these sum to the total.">
          {counts.passed.toLocaleString()} done · {counts.skipped.toLocaleString()} skipped ·{" "}
          {dispo.verifyFailed.toLocaleString()} verify-failed ·{" "}
          {Math.max(0, counts.failed - dispo.verifyFailed).toLocaleString()} error ·{" "}
          {counts.pending.toLocaleString()} pending / {files.length.toLocaleString()} files
        </span>
        <span className="compress-reconcile-dispo" title="What happened to the originals.">
          {dispo.recycled.toLocaleString()} recycled · {dispo.deleted.toLocaleString()} deleted ·{" "}
          {dispo.kept.toLocaleString()} kept
        </span>
      </div>
      <div className="compress-jobfiles-head">
        <span className="cjf-name">File</span>
        <span className="cjf-kind">Kind</span>
        <span className="cjf-outcome">Outcome</span>
        <span className="cjf-enc">Encoder</span>
        <span className="cjf-sizes">Original → New</span>
        <span className="cjf-saved num">Saved</span>
        <span className="cjf-rate num">Speed</span>
        <span className="cjf-dur num">Duration</span>
      </div>
      <div className="compress-jobfiles-body" ref={setScrollEl}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const f = rows[vi.index];
            if (!f) return null;
            const oc = outcomeOf(f);
            const saved = f.savedBytes ?? Math.max(0, f.origBytes - f.newBytes);
            const pctSaved = f.pctSaved ?? (f.origBytes > 0 ? (saved / f.origBytes) * 100 : 0);
            const dur = f.durationMs ?? 0;
            // MB/s = bytes processed (original) over wall-clock seconds.
            const mbps = dur > 0 ? f.origBytes / (dur / 1000) / (1024 * 1024) : 0;
            const reason = f.reason || "";
            const isFallback = reason === "gpu_fallback";
            const badgeLabel =
              oc === "passed" ? (isFallback ? "GPU→CPU" : "Passed")
              : oc === "failed" ? (REASON_LABEL[reason] ?? "Failed")
              : oc === "skipped" ? (REASON_LABEL[reason] ?? "Skipped")
              : f.status === "running" ? `${Math.round(f.pct)}%` : "Pending";
            // A GPU→CPU fallback still passed, but flag it amber to draw the eye.
            const badgeCls =
              oc === "passed" ? (isFallback ? "skipped" : "done")
              : oc === "failed" ? "error" : oc === "skipped" ? "skipped" : "running";
            const encoderText = (f.encoder || "").split(" ")[0] || "—";
            const title = f.error || REASON_TOOLTIP[reason] || f.encoder || f.path;
            return (
              <div
                key={f.index}
                className={`compress-jobfile-row${sel.has(f.index) ? " selected" : ""}`}
                style={{ position: "absolute", top: vi.start, left: 0, right: 0, height: vi.size }}
                title={title}
                onClick={(e) => onRowClick(f.index, vi.index, order, e)}
                onDoubleClick={() => openRow(f.path)}
                onContextMenu={(e) => rowMenu(e, f)}
              >
                <span className="cjf-name" title={f.path}>{baseName(f.path)}</span>
                <span className="cjf-kind">{f.kind}</span>
                <span className="cjf-outcome">
                  <span className={`compress-chip-status ${badgeCls}`} title={title}>{badgeLabel}</span>
                  {oc === "passed" && f.disposition && DISPOSITION_LABEL[f.disposition] && (
                    <span
                      className={`compress-chip-status disposition ${f.disposition}`}
                      title={DISPOSITION_LABEL[f.disposition].title}
                    >
                      {DISPOSITION_LABEL[f.disposition].label}
                    </span>
                  )}
                </span>
                <span className="cjf-enc" title={f.encoder || undefined}>{encoderText}</span>
                <span className="cjf-sizes">
                  {formatBytes(f.origBytes)} <span className="clog-arrow">→</span>{" "}
                  {oc === "failed" ? "—" : formatBytes(f.newBytes)}
                </span>
                <span className="cjf-saved num">
                  {oc === "passed" && saved > 0 ? `−${formatBytes(saved)} (${pctSaved.toFixed(0)}%)` : "—"}
                </span>
                <span className="cjf-rate num">{mbps > 0 ? `${mbps.toFixed(1)} MB/s` : "—"}</span>
                <span className="cjf-dur num">{formatDuration(dur)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// In Progress tab: a table of every compression job — running in this session,
// completed, or left unfinished on disk (interrupted by a restart, cancelled, or
// errored). Polls the list endpoint every 1.5s so running jobs show live
// progress and resumable jobs appear after a restart. Each row expands to a
// lazy-loaded, virtualized per-file outcome table; active rows refresh live and
// loaded detail is cached across collapse. Jobs can be resumed, cancelled, or
// have their output revealed.
export function CompressInProgress({
  queue,
  onRemoveQueued,
}: {
  queue: QueuedBatch[];
  onRemoveQueued: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<CompressJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Map<string, CompressJobFile[]>>(new Map());
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped on user actions (resume/cancel) to restart the poll loop at the fast
  // cadence immediately rather than waiting out the idle interval.
  const [pollKick, setPollKick] = useState(0);
  // Read the live expanded set inside the poll loop without re-subscribing it.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    setDetailLoading((prev) => new Set(prev).add(id));
    const snap = await fetchCompressJob(id, signal);
    if (signal?.aborted) return;
    setDetails((prev) => {
      const n = new Map(prev);
      n.set(id, snap?.files ?? []);
      return n;
    });
    setDetailLoading((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  }, []);

  // Returns whether any job is currently active, so the poll loop can back off
  // when there's nothing live to track.
  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const all = await listCompressJobs(signal);
    if (signal?.aborted) return false;
    // Show every run, newest first (running + completed + interrupted).
    setJobs([...all].sort((a, b) => b.createdAt - a.createdAt));
    setLoading(false);
    // Keep expanded ACTIVE jobs' detail live.
    let anyActive = false;
    for (const j of all) {
      if (j.active) {
        anyActive = true;
        if (expandedRef.current.has(j.id)) void loadDetail(j.id, signal);
      }
    }
    return anyActive;
  }, [loadDetail]);

  // Poll while mounted, but adaptively: a tight 1.5s cadence only while a job is
  // active, backing off to 8s when everything is idle (the list only changes
  // then on a user action, which refreshes directly). Avoids a perpetual 1.5s
  // request loop on a quiescent tab.
  useEffect(() => {
    const ac = new AbortController();
    let stopped = false;
    const ACTIVE_MS = 1500;
    const IDLE_MS = 8000;
    const tick = async () => {
      const anyActive = await refresh(ac.signal);
      if (stopped || ac.signal.aborted) return;
      timerRef.current = setTimeout(() => void tick(), anyActive ? ACTIVE_MS : IDLE_MS);
    };
    void tick();
    return () => {
      stopped = true;
      ac.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [refresh, pollKick]);

  const toggleExpand = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const n = new Set(prev);
        if (n.has(id)) {
          n.delete(id); // collapse — keep cached detail for instant re-open
        } else {
          n.add(id);
        }
        return n;
      });
      // Lazy-load on first expand (cached detail is reused without a refetch).
      if (!expanded.has(id) && !details.has(id)) void loadDetail(id);
    },
    [expanded, details, loadDetail],
  );

  const onResume = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await retryCompressJob(id);
        toast.success("Resuming job — skipping files already done.");
        await refresh();
        setPollKick((k) => k + 1); // resume live (fast-cadence) tracking now
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

  // Reveal a produced output in Explorer. Uses cached detail when available,
  // else fetches the snapshot; manifest-only jobs fall back to a soft notice.
  // Resolve a job's representative produced output (falls back to a source path).
  const jobOutputTarget = useCallback(
    async (id: string): Promise<string | null> => {
      const files = details.get(id) ?? (await fetchCompressJob(id))?.files;
      const out =
        files?.find((f) => f.status === "done" && f.newBytes > 0) ??
        files?.find((f) => f.path);
      return out ? rowTarget(out.path) : null;
    },
    [details],
  );

  const onReveal = useCallback(
    async (id: string) => {
      const t = await jobOutputTarget(id);
      if (t) void revealPath(t);
      else toast.info("No output to reveal yet for this job.");
    },
    [jobOutputTarget],
  );

  const onOpenJob = useCallback(
    async (id: string) => {
      const t = await jobOutputTarget(id);
      if (t) void openPath(t);
      else toast.info("No output to open yet for this job.");
    },
    [jobOutputTarget],
  );

  const onJobMenu = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.preventDefault();
      const x = e.clientX;
      const y = e.clientY;
      void jobOutputTarget(id).then((t) => {
        if (t) void shellContextMenu([t], x, y);
      });
    },
    [jobOutputTarget],
  );

  return (
    <div className="compress-progress">
      <div className="compress-toolbar">
        <div className="compress-summary">
          {jobs.length > 0 ? (
            <>
              <span className="compress-total">{jobs.length.toLocaleString()}</span>
              <span className="compress-total-label">run{jobs.length === 1 ? "" : "s"}</span>
            </>
          ) : (
            <span className="compress-total-label">No jobs yet</span>
          )}
        </div>
        <div className="compress-toolbar-spacer" />
        <button className="compress-btn" onClick={() => void refresh()} disabled={loading}>
          <Icon name="arrow-repeat" size={13} /> Refresh
        </button>
      </div>

      {queue.length > 0 && (
        <div className="compress-queue-list" aria-label="Queued batches (frontend)">
          <div className="compress-queue-head">
            Queued (starts after the running job) — {queue.length} batch{queue.length === 1 ? "" : "es"}
          </div>
          {queue.map((b, i) => (
            <div key={b.id} className="compress-queue-row">
              <span className="compress-chip-status skipped">#{i + 1} queued</span>
              <span className="compress-run-preset">{b.request.preset}</span>
              <span className="compress-queue-count">{b.files.length.toLocaleString()} file{b.files.length === 1 ? "" : "s"}</span>
              {b.request.outputDir ? (
                <span className="compress-queue-dest" title={b.request.outputDir}>→ {b.request.outputDir}</span>
              ) : (
                <span className="compress-queue-dest">in place</span>
              )}
              <button className="compress-btn" onClick={() => onRemoveQueued(b.id)} title="Remove this batch from the queue">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="compress-body">
        {loading && jobs.length === 0 ? (
          <EmptyState icon="clock-history" title="Loading jobs…" hint="Checking running and saved jobs." />
        ) : jobs.length === 0 ? (
          <EmptyState
            icon="file-zip"
            title="Nothing here yet"
            hint="Running jobs appear here live, completed runs stay listed, and jobs interrupted by a restart show up as resumable."
          />
        ) : (
          <table className="compress-runs-table">
            <thead>
              <tr>
                <th className="cr-toggle" aria-label="Expand" />
                <th>Status</th>
                <th>Preset</th>
                <th>Created</th>
                <th className="cr-prog">Progress</th>
                <th className="num">Saved</th>
                <th className="cr-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const badge = jobBadge(j);
                const completed = j.done + j.errors + j.skipped;
                const failed = Math.max(0, j.errors - (j.verifyFailed ?? 0));
                const pct = j.total > 0 ? Math.round((completed / j.total) * 100) : 0;
                const isBusy = busy === j.id;
                const isOpen = expanded.has(j.id);
                return (
                  <Fragment key={j.id}>
                    <tr
                      className={`compress-run-row${isOpen ? " open" : ""}`}
                      onClick={() => toggleExpand(j.id)}
                      onDoubleClick={() => void onOpenJob(j.id)}
                      onContextMenu={(e) => onJobMenu(e, j.id)}
                    >
                      <td className="cr-toggle">
                        <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
                      </td>
                      <td>
                        <span className={`compress-chip-status ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="compress-run-preset">{j.preset}</td>
                      <td className="compress-run-when" title={j.updatedAt ? `Updated ${formatTs(new Date(j.updatedAt).toISOString())}` : undefined}>
                        {j.createdAt ? formatTs(new Date(j.createdAt).toISOString()) : "—"}
                      </td>
                      <td className="cr-prog">
                        <div className="compress-run-prog">
                          <div className="compress-bar" title={`${pct}%`}>
                            <div
                              className={`compress-bar-fill${j.active ? "" : badge.cls === "done" ? " done" : " skipped"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span
                            className="compress-run-counts"
                            title={`${completed} processed · ${j.done} saved · ${j.skipped} skipped · ${(j.verifyFailed ?? 0)} verify-failed · ${failed} failed / ${j.total} files`}
                          >
                            {completed.toLocaleString()} processed · {j.done.toLocaleString()} saved · {j.skipped.toLocaleString()} skipped
                            {(j.verifyFailed ?? 0) > 0 ? ` · ${(j.verifyFailed ?? 0).toLocaleString()} verify-fail` : ""}
                            {failed > 0 ? ` · ${failed.toLocaleString()} failed` : ""}
                          </span>
                        </div>
                      </td>
                      <td className="num compress-run-saved">{j.savedBytes > 0 ? formatBytes(j.savedBytes) : "—"}</td>
                      <td className="cr-actions" onClick={(e) => e.stopPropagation()}>
                        {j.active ? (
                          <button className="compress-btn danger" onClick={() => void onCancel(j.id)} disabled={isBusy}>
                            <Icon name="stop-fill" size={12} /> Cancel
                          </button>
                        ) : j.resumable ? (
                          <button
                            className="compress-btn primary"
                            onClick={() => void onResume(j.id)}
                            disabled={isBusy}
                            title="Resume this job, skipping files already compressed"
                          >
                            <Icon name="arrow-repeat" size={12} /> {isBusy ? "Resuming…" : "Resume"}
                          </button>
                        ) : null}
                        <button className="compress-btn" onClick={() => void onReveal(j.id)} title="Show a produced output in Explorer">
                          <Icon name="folder-open" size={12} /> Reveal
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="compress-run-detail-row">
                        <td colSpan={7}>
                          <JobFileTable files={details.get(j.id)} loading={detailLoading.has(j.id)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
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
function CompressHistory({
  onCompressAgain,
}: {
  onCompressAgain: (path: string, presetOverride?: string) => void;
}) {
  const [rows, setRows] = useState<CompressLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [csvPath, setCsvPath] = useState("");
  const [debugPath, setDebugPath] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [historyStatus, setHistoryStatus] = useState("");
  const [historyKind, setHistoryKind] = useState("");
  const [historyEncoder, setHistoryEncoder] = useState("");
  const [historyDate, setHistoryDate] = useState("all");
  const [historySort, setHistorySort] = useState<"name" | "kind" | "preset" | "size" | "saved" | "tool" | "duration" | "status" | "when">("when");
  const [historyDirection, setHistoryDirection] = useState<"asc" | "desc">("desc");

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

  const display = useMemo(() => {
    const needle = historySearch.trim().toLowerCase();
    const cutoff = historyDate === "today" ? Date.now() - 86_400_000
      : historyDate === "7d" ? Date.now() - 7 * 86_400_000
      : historyDate === "30d" ? Date.now() - 30 * 86_400_000 : 0;
    const next = rows.filter((row) => {
      const skipped = row.status === "skipped_no_gain" || row.reason.startsWith("skipped_");
      const statusMatch = !historyStatus
        || (historyStatus === "skipped" ? skipped : row.status === historyStatus);
      return statusMatch
        && (!historyKind || row.kind === historyKind)
        && (!historyEncoder || `${row.tool} ${row.codecParams}`.toLowerCase().includes(historyEncoder.toLowerCase()))
        && (!cutoff || new Date(row.ts).getTime() >= cutoff)
        && (!needle || `${row.name} ${row.path} ${row.outPath} ${row.reason} ${row.error}`.toLowerCase().includes(needle));
    });
    next.sort((a, b) => {
      const av: string | number = historySort === "name" ? (a.name || a.path).toLowerCase()
        : historySort === "kind" ? a.kind
        : historySort === "preset" ? a.preset
        : historySort === "size" ? a.origBytes
        : historySort === "saved" ? a.savedBytes
        : historySort === "tool" ? `${a.tool} ${a.codecParams}`
        : historySort === "duration" ? a.durationMs
        : historySort === "status" ? a.reason || a.status
        : new Date(a.ts).getTime();
      const bv: string | number = historySort === "name" ? (b.name || b.path).toLowerCase()
        : historySort === "kind" ? b.kind
        : historySort === "preset" ? b.preset
        : historySort === "size" ? b.origBytes
        : historySort === "saved" ? b.savedBytes
        : historySort === "tool" ? `${b.tool} ${b.codecParams}`
        : historySort === "duration" ? b.durationMs
        : historySort === "status" ? b.reason || b.status
        : new Date(b.ts).getTime();
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return historyDirection === "asc" ? cmp : -cmp;
    });
    return next;
  }, [rows, historySearch, historyStatus, historyKind, historyEncoder, historyDate, historySort, historyDirection]);

  const totals = useMemo(() => {
    let orig = 0, neu = 0, saved = 0, success = 0;
    for (const r of display) {
      orig += r.origBytes;
      neu += r.newBytes;
      saved += r.savedBytes;
      if (r.status === "success") success += 1;
    }
    const pct = orig > 0 ? (saved / orig) * 100 : 0;
    return { orig, neu, saved, success, pct, count: rows.length };
  }, [display]);

  const sortHistory = (key: typeof historySort) => {
    if (historySort === key) setHistoryDirection((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setHistorySort(key);
      setHistoryDirection(key === "when" ? "desc" : "asc");
    }
  };

  // Virtualize the row body so a full 1000-row log stays responsive.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 29,
    overscan: 16,
  });

  const { sel, onRowClick } = useRowSelection<number>();
  const order = useMemo(() => display.map((_, i) => i), [display]);
  const rowMenu = useCallback(
    (e: React.MouseEvent, idx: number, r: CompressLogRow) => {
      const targets = sel.has(idx) && sel.size > 1
        ? [...sel].sort((a, b) => a - b).map((i) => rowTarget(display[i]?.path, display[i]?.outPath))
        : [rowTarget(r.path, r.outPath)];
      rowContextMenu(e, targets);
    },
    [sel, display],
  );

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

      <div className="compress-history-filters">
        <div className="cm-search">
          <Icon name="search" size={13} />
          <input aria-label="Search compression history" placeholder="Search files, paths, outcomes..." value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} />
        </div>
        <select aria-label="History date" value={historyDate} onChange={(event) => setHistoryDate(event.target.value)}>
          <option value="all">All dates</option><option value="today">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
        </select>
        <select aria-label="History status" value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value)}>
          <option value="">All statuses</option><option value="success">Successful</option><option value="skipped">Skipped</option><option value="error">Failed</option>
        </select>
        <select aria-label="History type" value={historyKind} onChange={(event) => setHistoryKind(event.target.value)}>
          <option value="">All types</option><option value="video">Video</option><option value="image">Images</option><option value="other">Other</option>
        </select>
        <input className="compress-history-encoder" aria-label="Filter encoder" placeholder="Encoder / tool" value={historyEncoder} onChange={(event) => setHistoryEncoder(event.target.value)} />
        <span>{display.length.toLocaleString()} matching</span>
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
          <div className="compress-log-vtable">
            <div className="compress-log-vhead">
              <button className="clog-name" onClick={() => sortHistory("name")}>File</button>
              <button onClick={() => sortHistory("kind")}>Kind</button>
              <button onClick={() => sortHistory("preset")}>Preset</button>
              <button onClick={() => sortHistory("size")}>Original → New</button>
              <button className="num" onClick={() => sortHistory("saved")}>Saved</button>
              <button onClick={() => sortHistory("tool")}>Tool</button>
              <button className="num" onClick={() => sortHistory("duration")}>Duration</button>
              <button onClick={() => sortHistory("status")}>Status</button>
              <button className="clog-ts" onClick={() => sortHistory("when")}>When {historySort === "when" ? (historyDirection === "desc" ? "v" : "^") : ""}</button>
              <span className="clog-act">Action</span>
            </div>
            <div className="compress-log-vbody" ref={setScrollEl}>
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const r = display[vi.index];
                  if (!r) return null;
                  return (
                    <div
                      key={`${r.ts}-${r.jobId}-${r.index}-${vi.index}`}
                      className={`compress-log-vrow clog-${r.status}${sel.has(vi.index) ? " selected" : ""}`}
                      style={{ position: "absolute", top: vi.start, left: 0, right: 0, height: vi.size }}
                      onClick={(e) => onRowClick(vi.index, vi.index, order, e)}
                      onDoubleClick={() => openRow(r.path, r.outPath)}
                      onContextMenu={(e) => rowMenu(e, vi.index, r)}
                    >
                      <span className="clog-name" title={r.path}>{r.name || r.path}</span>
                      <span>{r.kind}</span>
                      <span>{r.preset}</span>
                      <span className="clog-sizes">
                        {formatBytes(r.origBytes)} <span className="clog-arrow">→</span>{" "}
                        {r.status === "error" ? "—" : formatBytes(r.newBytes)}
                      </span>
                      <span className="num">{r.status === "success" ? `${r.pctSaved.toFixed(1)}%` : "—"}</span>
                      <span title={[r.tool, r.toolVersion].filter(Boolean).join(" ") + (r.codecParams ? ` · ${r.codecParams}` : "")}>{r.tool || "—"}</span>
                      <span className="num">{formatDuration(r.durationMs)}</span>
                      <span>
                        <span
                          className={`compress-chip-status ${reasonClass(r.reason, r.status)}`}
                          title={r.error || REASON_TOOLTIP[r.reason] || REASON_TOOLTIP[r.status] || ""}
                        >
                          {REASON_LABEL[r.reason] ?? STATUS_LABEL[r.status] ?? r.status}
                        </span>
                      </span>
                      <span className="clog-ts" title={r.ts}>{formatTs(r.ts)}</span>
                      <span className="clog-act" onClick={(e) => e.stopPropagation()}>
                        <select
                          className="clog-again"
                          value=""
                          title="Re-compress this file (current preset, or pick one)"
                          onChange={(e) => {
                            const v = e.target.value;
                            e.currentTarget.value = "";
                            if (!v) return;
                            onCompressAgain(r.path, v === "current" ? undefined : v);
                          }}
                        >
                          <option value="">Compress again…</option>
                          <option value="current">Current preset</option>
                          {PRESETS.filter((p) => p.id !== "custom").map((p) => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </select>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
