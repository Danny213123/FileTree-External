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

// ── Scan snapshots + growth diff (roadmap #5) ──────────────────────────────

/** One saved snapshot's metadata (also the manifest entry shape). */
export interface SnapshotMeta {
  id: string;
  rootPath: string;
  /** Epoch ms the underlying scan was taken. */
  scannedAt: number;
  /** Epoch ms the snapshot was saved. */
  savedAt: number;
  label: string;
  nodeCount: number;
  /** Aggregated total bytes of the scanned root at capture time. */
  totalSize: number;
}

export interface SnapshotList {
  snapshots: SnapshotMeta[];
}

export type DiffStatus = "added" | "removed" | "grown" | "shrunk";

/** One per-path delta between two snapshots (or snapshot vs current scan). */
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
  /** Net byte change across all paths. */
  netDelta: number;
  oldTotal: number;
  newTotal: number;
  /** Total number of changed rows before the display cap. */
  rowCount: number;
  /** True when `rows` was truncated to the server cap. */
  capped: boolean;
}

export interface DiffResult {
  a: SnapshotMeta;
  b: SnapshotMeta;
  summary: DiffSummary;
  rows: DiffRow[];
}
