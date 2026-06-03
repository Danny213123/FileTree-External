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
  topFiles: number[];
  /** Node ids of the largest directories (computed server-side, capped at 100).
   *  Streamed in the scan meta line; reused by the Reports "Largest Folders" view. */
  largestDirs: number[];
  extensionStats: ExtensionStat[];
  ageStats: AgeStat[];
  duplicateCandidates: DuplicateCandidate[];
  scanErrors: ScanError[];
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
