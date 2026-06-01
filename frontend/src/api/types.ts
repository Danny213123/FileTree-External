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
  extensionStats: ExtensionStat[];
  ageStats: AgeStat[];
  duplicateCandidates: DuplicateCandidate[];
  scanErrors: ScanError[];
}

export interface DriveEntry {
  root: string;
  label: string;
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

export interface DupeFileV2 {
  path: string;
  name: string;
  size: number;
  modified: number;   // seconds since epoch
  ref: boolean;
}

export interface DupeGroupV2 {
  score: number;      // 100 for exact; 0-100 for fuzzy
  waste: number;      // bytes wasted by duplicates
  files: DupeFileV2[];
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
