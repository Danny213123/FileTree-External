export interface NodeRecord {
  id: number;
  parent: number | null;
  name: string;
  path: string;
  dir: boolean;
  link: boolean;
  hidden: boolean;
  readonly: boolean;
  size: number;
  allocated: number;
  files: number;
  folders: number;
  modified: number;
  created: number;
  accessed: number;
  depth: number;
  errors: number;
  extension: string;
  children: number[];
  /** Owner account ("DOMAIN\\user"). Present only when owner collection was
   *  enabled for the scan; "" / undefined otherwise. */
  owner?: string;
  /** Raw Windows file-attribute bitmask (FILE_ATTRIBUTE_*); 0/undefined when
   *  unavailable. Decode flags with the masks in `lib/attributes.ts`. */
  attributes?: number;
  /** True when directory aggregate fields came from the scan index or a live
   *  recursive summary. False means this is an unresolved live placeholder. */
  aggregateKnown?: boolean;
}

export interface ExtensionStat {
  ext: string;
  bytes: number;
  allocated: number;
  files: number;
}

export interface AgeStat {
  label: string;
  bytes: number;
  files: number;
}

export interface DuplicateCandidate {
  name: string;
  size: number;
  waste: number;
  ids: number[];
}

export interface ScanError {
  path: string;
  message: string;
}

export interface ScanResult {
  app: string;
  version: string;
  rootPath: string;
  scannedAt: number;
  elapsedMs: number;
  threadCount: number;
  nodeCount: number;
  errorCount: number;
  nodes: NodeRecord[];
  /** True when the scan was ingested in LAZY mode: `nodes` holds only the root
   *  (and whatever directories the user has since expanded), not the whole tree.
   *  Set by `readNdjsonStream` when `nodeCount` exceeds the lazy threshold so the
   *  renderer never materializes a >10M-node tree. Absent/false for normal scans,
   *  which keep their exact full-materialization behavior. */
  lazy?: boolean;
  topFiles: number[];
  /** Node ids of the largest directories (computed server-side, capped at 100).
   *  Streamed in the scan meta line; reused by the Reports "Largest Folders" view. */
  largestDirs: number[];
  extensionStats: ExtensionStat[];
  ageStats: AgeStat[];
  duplicateCandidates: DuplicateCandidate[];
  scanErrors: ScanError[];
  /** V2 disk-backed scan identity. Present in Tauri; absent for the legacy
   * browser/server transport. Child/search requests use this instead of asking
   * the renderer to retain the complete tree. */
  scanId?: string;
}

export interface DriveEntry {
  root: string;
  label: string;
  /** Total bytes on the volume, 0 when it couldn't be queried. */
  total: number;
  /** Free bytes available to the caller, 0 when it couldn't be queried. */
  free: number;
}

export interface DriveList {
  drives: DriveEntry[];
}

export interface SpecialFolder {
  label: string;
  path: string;
}

export interface SpecialFolderList {
  folders: SpecialFolder[];
}

export interface Config {
  initialPath: string;
  defaultThreads: number;
}

export interface DuplicateGroup {
  hash: string;
  size: number;
  waste: number;
  ids: number[];
}

export interface ExactDuplicatesResult {
  groups: DuplicateGroup[];
}

export interface DupeFile {
  id: number;
  name: string;
  path: string;
  size: number;
  modified: number;
  original: boolean;
}

export interface DupeGroup {
  size: number;
  hash: string;
  waste: number;
  count: number;
  directional: boolean;
  files: DupeFile[];
}

export interface DupesResult {
  groups: DupeGroup[];
  errors: string[];
}

export interface DupeFilter {
  minSize: number;
  maxSize?: number;
  extensions: string;
  namePattern: string;
  nameExact?: boolean;
  dateFrom: number;
  dateTo: number;
  keepPathPrefix?: string;
  searchPathPrefix?: string;
}

// ── dupeguru V2 types ─────────────────────────────────────────────────────

export type DupeScanMode = "exact" | "filename" | "audio";

/** Per-file match breakdown vs the group's reference file (files[0]). Each
 *  field is a 0-100 score; the reference scores 100 on every axis. */
export interface DupeMatch {
  name: number;     // filename similarity (exact => 100/0; fuzzy => Sørensen-Dice)
  size: number;     // 100 when byte length is equal
  date: number;     // 100 when modified time is within tolerance
  content: number;  // 100 when byte-identical (content criterion)
}

export interface DupeFileV2 {
  path: string;
  name: string;
  size: number;
  modified: number;   // seconds since epoch
  ref: boolean;
  /** Overall match % vs the reference (0-100). Reference is 100. */
  score?: number;
  /** Per-criterion breakdown vs the reference. */
  match?: DupeMatch;
}

export interface DupeGroupV2 {
  score: number;      // 100 for exact; 0-100 for fuzzy
  waste: number;      // bytes wasted by duplicates
  files: DupeFileV2[];
}

// ── Duplicates Finder criteria (client-side composable matching) ────────────

export type DupeCriterionKey = "name" | "size" | "date" | "content";

export interface DupeCriterionState {
  /** Criterion participates in matching and shows as a delta column. */
  enabled: boolean;
  /** A duplicate must match the reference on this criterion to stay in the group. */
  required: boolean;
}

export interface DupeCriteria {
  name: DupeCriterionState;
  size: DupeCriterionState;
  date: DupeCriterionState;
  content: DupeCriterionState;
  /** Name comparison: fuzzy (Sørensen-Dice) vs exact filename. */
  nameFuzzy: boolean;
  /** Fuzzy name similarity threshold (0-100). */
  nameThreshold: number;
  /** Date-modified tolerance in seconds (0 = exact). */
  dateToleranceSec: number;
}

export interface DupesV2Result {
  mode: DupeScanMode;
  groups: DupeGroupV2[];
  errors: string[];
  ignoredCount: number;
}

export type ReprioritizeCriterion =
  | "largest" | "smallest" | "newest" | "oldest"
  | "shortestPath" | "longestPath" | "alphaFirst" | "alphaLast";

export type SortKey =
  | "name" | "path" | "folderPath" | "type"
  | "size" | "allocated" | "files" | "folders" | "percent"
  | "attributes" | "owner"
  | "modified" | "created" | "accessed"
  | "avgFileSize" | "pathLength" | "dirLevel" | "compressionRate";
export type Metric = "size" | "allocated" | "files" | "folders";
export type Unit = "auto" | "tb" | "gb" | "mb" | "kb" | "bytes";

// ── Scan snapshots + growth diff (F2) ──────────────────────────────────────
// These mirror the NEW snapshot store in `src/snapshots.rs` (a compact
// folder→size capture under %APPDATA%\FileTree\snapshots\), reached via
// GET /api/snapshots (list, a bare array), POST /api/snapshots-save,
// GET /api/snapshots-diff?a=&b= and POST /api/snapshots-delete.

/** One saved snapshot's metadata — the exact GET /api/snapshots list element
 *  and POST /api/snapshots-save response shape (`snapshots::SnapMeta`). */
export interface SnapshotMeta {
  id: string;
  /** Unix SECONDS the snapshot was created (×1000 for a JS Date / formatDate). */
  createdAt: number;
  /** Scanned root path captured. */
  path: string;
  /** Aggregated total bytes of the scanned root at capture time. */
  total: number;
  /** Recursive file count of the scanned root at capture time. */
  fileCount: number;
}

/** An added/removed folder in a snapshot diff (`{path,size}`). */
export interface SnapshotDiffEntry {
  path: string;
  size: number;
}

/** A folder whose size changed between two snapshots (`{path,sizeA,sizeB,delta}`). */
export interface SnapshotChangedEntry {
  path: string;
  sizeA: number;
  sizeB: number;
  /** sizeB - sizeA (can be negative). */
  delta: number;
}

/** Raw GET /api/snapshots-diff response (`b` minus `a`), directories only. */
export interface SnapshotDiff {
  added: SnapshotDiffEntry[];
  removed: SnapshotDiffEntry[];
  changed: SnapshotChangedEntry[];
}

/** One saved snapshot's full on-disk JSON (GET /api/snapshots-get?id=). The
 *  `dirs` map is absolute-dir-path → size (bytes); used by the Explorer "what
 *  changed since last snapshot" badges (#39) to diff against the live tree. */
export interface SnapshotData extends SnapshotMeta {
  dirs: Record<string, number>;
}

// The types below are a CLIENT-SIDE view model the diff views render. The
// client (`fetchSnapshotDiff`) adapts the raw `SnapshotDiff` buckets above into
// these rows + summary: `added`/`removed` map straight through and `changed`
// splits into "grown"/"shrunk" by the sign of its delta.
export type DiffStatus = "added" | "removed" | "grown" | "shrunk";

/** One per-folder delta between two snapshots. */
export interface DiffRow {
  path: string;
  name: string;
  status: DiffStatus;
  oldSize: number;
  newSize: number;
  /** newSize - oldSize (can be negative). */
  delta: number;
  dir: boolean;
}

export interface DiffSummary {
  added: number;
  removed: number;
  grown: number;
  shrunk: number;
  /** Net byte change (newTotal - oldTotal). */
  netDelta: number;
  oldTotal: number;
  newTotal: number;
  /** Number of changed rows shown. */
  rowCount: number;
  /** True when any diff bucket hit the server cap (1000). */
  capped: boolean;
}

export interface DiffResult {
  a: SnapshotMeta;
  b: SnapshotMeta;
  summary: DiffSummary;
  rows: DiffRow[];
}

// ── Disk Cleanup / Reclaim Space assistant (roadmap #1) ────────────────────

/** One reclaimable file/folder inside a cleanup category. */
export interface CleanupItem {
  path: string;
  /** Bytes reclaimed by removing this item. */
  size: number;
  /** Unix SECONDS last-modified (0 when unknown); ×1000 for a JS Date. */
  modified: number;
}

/** A bucket of reclaimable space (temp, caches, build artifacts, …). */
export interface CleanupCategory {
  id: string;
  label: string;
  description: string;
  /** Aggregate bytes reclaimable across this category's items. */
  total: number;
  /** Number of items in the category. */
  count: number;
  items: CleanupItem[];
}

export interface CleanupScanResult {
  categories: CleanupCategory[];
}

// ── Bulk rename (F3) ───────────────────────────────────────────────────────
import type { FilterRule } from "../hooks/useFilterRules";

/** One rename in a bulk-rename batch: move `from` (absolute path) to `to`
 *  (absolute path, same parent). */
export interface BulkRenameOp {
  from: string;
  to: string;
}

/** Per-op outcome echoed back by POST /api/bulk-rename. */
export interface BulkRenameResultItem {
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}

export interface BulkRenameResponse {
  results: BulkRenameResultItem[];
}

// ── Tags & color labels (F4) ───────────────────────────────────────────────

/** One tagged path: its labels plus an optional color (hex string). Mirrors the
 *  GET /api/tags `items` entry shape exactly. */
export interface TagEntry {
  path: string;
  tags: string[];
  /** Optional hex color (e.g. "#e06c75") shown as the row dot. */
  color?: string;
}

// ── Smart folders (F7) ──────────────────────────────────────────────────────

/** A saved query: free-text search and/or advanced filter rules. */
export interface SmartFolderQuery {
  text?: string;
  rules?: FilterRule[];
}

/** A named, persisted search/filter the user can re-apply with one click. */
export interface SmartFolder {
  id: string;
  name: string;
  query: SmartFolderQuery;
}

// ── Archive (zip) + checksums (F5) ─────────────────────────────────────────
// Mirror `src/archive.rs` + the server.rs handlers. Note both compress and
// extract return HTTP 200 even on failure, carrying `ok:false` + an `error`.

/** POST /api/compress response (`{ok, dest, error?}`). */
export interface CompressResult {
  ok: boolean;
  dest: string;
  error?: string;
}

/** POST /api/extract response (`{ok, error?}`). */
export interface ExtractResult {
  ok: boolean;
  error?: string;
}

/** GET /api/checksum response: `{algo, hash}` on success, `{error}` on failure. */
export interface ChecksumResult {
  algo: string;
  hash: string;
  error?: string;
}

// ── Compression page (media re-encode + zip, with live jobs) ────────────────
// Mirrors the backend compress-job layer (built in parallel against the same
// contract). A job re-encodes video (HandBrake) + images (ffmpeg/ImageMagick)
// and lossless-zips other files through quality presets, streaming per-file and
// overall progress over NDJSON, then tags + recycles the originals. Every type
// here matches the POST /api/compress-jobs* + GET /api/compress-tools contract.

/** Quality preset. Labels: max → "Maximum savings", more → "More savings",
 *  balanced → "Balanced", high → "High quality", custom → "Custom" (video
 *  resolution cap + quality level chosen by the user). */
export type CompressPreset = "max" | "more" | "balanced" | "high" | "custom";

/** Detection state of one external compression tool. */
export interface CompressToolInfo {
  found: boolean;
  version?: string;
  path?: string;
}

/** The image encoder additionally reports which backend was detected. */
export interface CompressImageToolInfo extends CompressToolInfo {
  kind: "ffmpeg" | "imagemagick" | null;
}

/** Hardware-encoder capabilities parsed from HandBrake's encoder list. Each
 *  flag is true only when that encoder is actually usable on this machine. */
export interface CompressCaps {
  x265: boolean;
  nvencH264: boolean;
  nvencH265: boolean;
  nvencAv1?: boolean;
  qsvH264: boolean;
  qsvH265: boolean;
  qsvAv1?: boolean;
  vceH264: boolean;
  vceH265: boolean;
  vceAv1?: boolean;
  /** Any hardware video encoder is available (per HandBrake's `-h` parse). */
  anyGpu: boolean;
}

/** Effective hardware-encoder availability: HandBrake `-h` token OR a matching
 *  physical GPU adapter present. This is what the UI gates on (an empty `-h`
 *  parse is treated as "unknown", not "no GPU"). `*Assumed` means availability
 *  rests only on the adapter probe and hasn't been confirmed by a real encode. */
export interface CompressAvailable {
  nvenc: boolean;
  qsv: boolean;
  vce: boolean;
  anyGpu: boolean;
  nvencAssumed: boolean;
  qsvAssumed: boolean;
  vceAssumed: boolean;
}

/** GPU vendors inferred from the available HandBrake encoders (i.e. which
 *  hardware encoders HandBrake can actually USE on this machine). */
export interface CompressGpuVendors {
  nvidia: boolean;
  intel: boolean;
  amd: boolean;
}

/** Physical GPU adapters present on the machine, probed independently of
 *  HandBrake. Lets the UI distinguish "no GPU" from "GPU present but HandBrake
 *  can't use it". Absent on older servers. */
export interface CompressGpuHardware {
  nvidia: boolean;
  intel: boolean;
  amd: boolean;
  /** Human-readable adapter names (e.g. "AMD Radeon(TM) Graphics"). */
  names: string[];
}

/** GET /api/compress-tools — which encoders are available. Zip is built-in so
 *  it is always `found`. `caps`/`gpu`/`gpuHardware` are absent on older servers. */
export interface CompressTools {
  handbrake: CompressToolInfo;
  image: CompressImageToolInfo;
  zip: { found: true };
  caps?: CompressCaps;
  /** Effective availability combining `-h` caps with the physical-GPU probe. */
  available?: CompressAvailable;
  gpu?: CompressGpuVendors;
  gpuHardware?: CompressGpuHardware;
  /** Whether `HandBrakeCLI -h` produced parseable output (false ⇒ caps unknown). */
  handbrakeHParseOk?: boolean;
  /** Raw encoder-relevant lines from `HandBrakeCLI -h`, as ground-truth evidence. */
  handbrakeEncodersRaw?: string;
}

/** POST /api/compress-tools/install response. */
export interface CompressInstallResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** When in-app install isn't available, a one-click official download URL. */
  downloadUrl?: string;
}

/** The kind of pipeline a file runs through (drives the type grouping/labels). */
export type CompressKind = "video" | "image" | "other";

/** Per-file status in a polled job snapshot. */
export type CompressFileStatus =
  | "pending" | "running" | "done" | "error" | "skipped";

/** One file's progress within a job (GET /api/compress-jobs/<id> `files` row). */
export interface CompressJobFile {
  index: number;
  path: string;
  kind: CompressKind;
  status: CompressFileStatus;
  /** 0..100 encode progress. */
  pct: number;
  origBytes: number;
  newBytes: number;
  error?: string;
  /** Precise outcome code (e.g. `success`, `skipped_no_gain`, `skipped_too_small`,
   *  `error_encoder`, `error_unreadable_input`, `error_tool_missing`,
   *  `gpu_fallback`). Empty until terminal. */
  reason?: string;
  /** The genuine hardware encoder + codec params used (e.g. `nvenc_h265 q=26
   *  preset=quality`). Empty until the file terminates. */
  encoder?: string;
  /** origBytes - newBytes (never negative). */
  savedBytes?: number;
  /** Percentage of the original size saved (0..100). */
  pctSaved?: number;
  /** Wall-clock time spent on this file, in milliseconds. */
  durationMs?: number;
  /** True only when the original was sent to the Recycle Bin. */
  recycled?: boolean;
  /** What actually happened to the original after a verified compress:
   *  `recycled`, `deleted`, or `kept`. Empty until terminal / for non-success. */
  disposition?: string;
  stage?: "queued" | "waiting_gpu" | "encoding" | "verifying" | "finalizing" | "terminal";
  fps?: number | null;
  processingRate?: number | null;
  outputBytes?: number;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  attempt?: number;
  tool?: string;
  toolVersion?: string;
  command?: string;
  stderr?: string;
  outPath?: string;
  elapsedMs?: number;
  queuePosition?: number | null;
}

/** Overall job status from the poll-fallback endpoint. */
export type CompressJobStatus =
  | "queued" | "running" | "pausing" | "paused"
  | "done" | "cancelled" | "error";

/** GET /api/compress-jobs/<id> — full job snapshot (poll fallback). */
export interface CompressJob {
  id: string;
  status: CompressJobStatus;
  total: number;
  savedBytes: number;
  preset?: CompressPreset;
  totalBytes?: number;
  workCompletedBytes?: number;
  successfulBytes?: number;
  skippedBytes?: number;
  failedBytes?: number;
  activeWorkBytes?: number;
  activeCount?: number;
  activeElapsedMs?: number;
  concurrency?: number;
  encoder?: string;
  codec?: string;
  useGpu?: boolean;
  originalAction?: OriginalAction;
  outputDir?: string;
  queueRank?: number;
  stageCounts?: Record<string, number>;
  files: CompressJobFile[];
}

/** One row from `GET /api/compress-jobs` — a compact summary of every job,
 *  merging live in-memory jobs with persisted manifests (interrupted/resumable
 *  jobs from a previous session). Powers the Compress page "In Progress" tab. */
export interface CompressJobSummary {
  id: string;
  status: CompressJobStatus;
  preset: CompressPreset;
  total: number;
  done: number;
  errors: number;
  skipped: number;
  /** Subset of `errors`: outputs rejected by the deep-verify gate (original
   *  preserved). Present so the UI totals visibly sum to `total`. */
  verifyFailed?: number;
  pending: number;
  savedBytes: number;
  totalBytes?: number;
  workCompletedBytes?: number;
  successfulBytes?: number;
  skippedBytes?: number;
  failedBytes?: number;
  activeWorkBytes?: number;
  activeCount?: number;
  activeElapsedMs?: number;
  concurrency?: number;
  encoder?: string;
  codec?: string;
  useGpu?: boolean;
  originalAction?: OriginalAction;
  outputDir?: string;
  queueRank?: number;
  /** Epoch ms the job was created (parsed from its id). */
  createdAt: number;
  /** Epoch ms of the last manifest write (last progress). */
  updatedAt: number;
  /** Currently encoding in this server process. */
  active: boolean;
  /** Has remaining (non-done) work and isn't actively running. */
  resumable: boolean;
}

export interface CompressJobFilesPage {
  id: string;
  offset: number;
  limit: number;
  total: number;
  totalMatches: number;
  items: CompressJobFile[];
  facets: Record<string, Record<string, number>>;
}

export interface CompressFilesQuery {
  offset?: number;
  limit?: number;
  search?: string;
  status?: string;
  type?: string;
  encoder?: string;
  outcome?: string;
  disposition?: string;
  path?: string;
  attention?: boolean;
  sort?: string;
  direction?: "asc" | "desc";
}

export interface CompressTelemetry {
  sampledAt: number;
  gpuVideoEncodePct: number | null;
  encoderSessions: number | null;
  aggregateFps: number | null;
  encoderCpuPct: number | null;
  ramBytes: number | null;
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
  destinationFreeBytes: number | null;
  gpuMemoryUsedBytes: number | null;
  gpuMemoryTotalBytes: number | null;
}

/** Video encoder selection. `x264` remains accepted only for old saved data and
 *  is normalized to hardware-only `auto` by current clients and servers. */
export type CompressEncoder = "auto" | "x264" | "nvenc" | "qsv" | "vce";

/** Target video codec. */
export type CompressCodec = "h264" | "h265" | "av1";

/** What to do with each ORIGINAL after its compressed replacement passes the
 *  deep-verify gate. `recycle` (default) is recoverable; `delete` is permanent
 *  (irreversible); `keep` leaves the original beside the new file. */
export type OriginalAction = "recycle" | "delete" | "keep";

/** Body for POST /api/compress-jobs. */
export interface CompressJobRequest {
  paths: string[];
  preset: CompressPreset;
  /** Tri-state disposition of the original after a verified compress. */
  originalAction: OriginalAction;
  /** @deprecated Back-compat only; the server derives this from originalAction.
   *  Sent so an older server still honors the recoverable-vs-destroy intent. */
  recycleOriginals: boolean;
  tagFilename: boolean;
  /** Worker concurrency (parallel files), clamped to 1-2. 0 / omitted ⇒ 2. */
  concurrency?: number;
  /** Hardware video encoder selection (default `auto`; no software fallback). */
  encoder?: CompressEncoder;
  /** Compatibility field. Current servers force this true. */
  useGpu?: boolean;
  /** Minimum original size in bytes to attempt compression; smaller files are
   *  skipped untouched (`skipped_too_small`). 0 / omitted ⇒ no minimum. */
  minSizeBytes?: number;
  /** Target video codec (default `h264`). */
  codec?: CompressCodec;
  /** Deflate level for the zip pipeline (0..9). -1 / omitted ⇒ server default. */
  zipLevel?: number;
  /** Custom-preset video resolution cap (px height). 0 ⇒ original (no cap).
   *  Only consulted when `preset === "custom"`. */
  customMaxHeight?: number;
  /** Custom-preset video quality (RF base, 16..40; lower = better). 0 / omitted
   *  ⇒ backend default (26). Only consulted when `preset === "custom"`. */
  customQuality?: number;
  /** "Output to folder" destination directory. When set, every compressed copy
   *  is written into this single folder (collision-safe naming) and the
   *  originals are always left untouched. Empty / omitted ⇒ in-place (outputs
   *  beside each original, originals disposed per `originalAction`). */
  outputDir?: string;
  /** Scan root the selected files belong to. Sent so the server can (re-)register
   *  it as an allowed read root before validating the source paths — covers the
   *  case where the tree was served from the renderer's cache and the current
   *  server session never saw a `/api/scan` for that directory. The server still
   *  verifies the directory exists and that every source path is genuinely
   *  underneath a registered root, so this never widens access beyond what the
   *  user actually scanned. */
  scanRoot?: string;
  /** Persist without starting; the backend queue survives restarts. */
  queued?: boolean;
}

// NDJSON stream events from GET /api/compress-jobs/stream?id=<jobId>, one JSON
// object per line. The `type` discriminates the union.
export interface CompressJobStartEvent {
  type: "job_start";
  jobId: string;
  total: number;
}
export interface CompressFileStartEvent {
  type: "file_start";
  index: number;
  path: string;
  kind: CompressKind;
  origBytes: number;
}
export interface CompressProgressEvent {
  type: "progress";
  index: number;
  /** 0..100. */
  pct: number;
  stage?: string;
  fps?: number | null;
  updatedAt?: number;
}
export interface CompressStageEvent {
  type: "stage";
  index: number;
  stage: string;
  updatedAt: number;
}
export interface CompressJobStateEvent {
  type: "job_state";
  jobId: string;
  status: CompressJobStatus;
}
export interface CompressFileDoneEvent {
  type: "file_done";
  index: number;
  outPath: string;
  origBytes: number;
  newBytes: number;
  savedBytes: number;
  recycled: boolean;
  /** What happened to the original: `recycled` | `deleted` | `kept` | "". */
  disposition?: string;
  /** Precise outcome code (e.g. `success`, `skipped_no_gain`, `skipped_too_small`,
   *  `gpu_fallback`). Distinguishes skip variants for the live badge. */
  reason?: string;
  /** Coarse outcome: `done` for a successful compress, `skipped` for any skip.
   *  (`skipped_no_gain` retained for back-compat with older servers.) */
  status: "done" | "skipped" | "skipped_no_gain";
}
export interface CompressErrorEvent {
  type: "error";
  index: number;
  path: string;
  error: string;
  /** Precise outcome code (e.g. `error_verify_failed`, `error_encoder`). */
  reason?: string;
}
export interface CompressDoneEvent {
  type: "done";
  jobId: string;
  done: number;
  errors: number;
  /** Files that produced no gain (output discarded, original kept). */
  skipped?: number;
  /** Subset of `errors` rejected by the deep-verify gate (original preserved). */
  verifyFailed?: number;
  /** Total files in the job, so the UI can confirm post == pre. */
  total?: number;
  savedBytes: number;
}

/** Discriminated union of every NDJSON line a compress job streams. */
export type CompressEvent =
  | CompressJobStartEvent
  | CompressFileStartEvent
  | CompressProgressEvent
  | CompressStageEvent
  | CompressJobStateEvent
  | CompressFileDoneEvent
  | CompressErrorEvent
  | CompressDoneEvent;

/** One row of the persistent compress CSV log
 *  (`%APPDATA%\FileTree\compress-log.csv`), as returned by
 *  `GET /api/compress-log?limit=N`. One row per terminal file outcome. */
export interface CompressLogRow {
  /** ISO-8601 UTC timestamp the row was written. */
  ts: string;
  jobId: string;
  index: number;
  path: string;
  name: string;
  kind: CompressKind;
  preset: CompressPreset;
  /** "success" | "skipped_no_gain" | "error". */
  status: "success" | "skipped_no_gain" | "error";
  origBytes: number;
  newBytes: number;
  savedBytes: number;
  /** Percentage of the original size saved (0..100). */
  pctSaved: number;
  /** New/original size ratio. */
  ratio: number;
  /** "handbrake" | "ffmpeg" | "imagemagick" | "zip" | "". */
  tool: string;
  /** Human-readable codec/quality parameters used. */
  codecParams: string;
  durationMs: number;
  outPath: string;
  recycled: boolean;
  error: string;
  /** Precise outcome code. One of: `success`, `skipped_no_gain`, `skipped_too_small`,
   *  `error_tool_missing`, `error_unsupported`, `error_encoder`,
   *  `error_unreadable_input`, `error_output_empty`, `error_source_missing`,
   *  `error_cloud_placeholder`, `error_spawn`, `error_internal`, `gpu_fallback`.
   *  Falls back to `status` for rows written before the diagnostics columns existed. */
  reason: string;
  /** Encoder process exit code, or `null` when no process ran / none produced. */
  exitCode: number | null;
  /** Detected version string of the tool used (`built-in` for zip). */
  toolVersion: string;
  /** Full command line that was spawned (empty when no tool ran). */
  command: string;
  /** Bounded tail of the encoder's stderr (empty on success / no tool). */
  stderrExcerpt: string;
}
