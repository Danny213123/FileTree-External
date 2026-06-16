import type { NodeRecord, SortKey } from "../api/types";
import { compareNodes } from "../hooks/useTreeState";

/**
 * Shared search matcher used by both the activity-bar Search list and the
 * main-area results table. Case-insensitive substring match over BOTH the node
 * name AND its full path (so extension / folder-path queries hit), skipping
 * aggregated bundle nodes (id < 0). Matches are sorted by the active table
 * sort and capped at `limit`.
 *
 * Returns [] for queries shorter than 2 characters (after trim).
 */
export function searchNodes(
  nodeById: Map<number, NodeRecord>,
  query: string,
  sortKey: SortKey,
  sortDir: 1 | -1,
  limit: number,
): NodeRecord[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const matches: NodeRecord[] = [];
  for (const node of nodeById.values()) {
    if (node.id < 0) continue; // skip aggregated bundle nodes
    if (node.name.toLowerCase().includes(q) || (node.path && node.path.toLowerCase().includes(q))) {
      matches.push(node);
    }
  }
  matches.sort((a, b) => compareNodes(a, b, sortKey, sortDir));
  return matches.slice(0, limit);
}

// ── Inline search filters + regex toggle (#31) ───────────────────────────────
// Lightweight predicates layered ON TOP of the existing name/path match. The
// filters are combined with AND; an unset field is ignored. Everything is
// frontend-only and reuses the live node map (no backend involvement).

/** A coarse file-type bucket the type filter can target (besides a raw ext). */
export type FileCategory =
  | "any" | "folder" | "image" | "video" | "audio"
  | "document" | "archive" | "code" | "executable";

/** Extension sets backing each category (lower-case, no leading dot). */
const CATEGORY_EXTS: Record<Exclude<FileCategory, "any" | "folder">, ReadonlySet<string>> = {
  image: new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "tif", "tiff", "svg", "heic", "heif", "ico", "raw", "cr2", "nef", "arw", "dng"]),
  video: new Set(["mp4", "mkv", "mov", "avi", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts", "m2ts", "3gp"]),
  audio: new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff", "alac", "opus", "mid"]),
  document: new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "odp", "md", "csv", "epub", "pages"]),
  archive: new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab", "tgz", "zst", "lz"]),
  code: new Set(["js", "ts", "jsx", "tsx", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "html", "css", "json", "xml", "yaml", "yml", "sh", "sql", "swift", "kt", "lua", "vue"]),
  executable: new Set(["exe", "msi", "dll", "bat", "cmd", "com", "ps1", "app", "sys", "scr"]),
};

export const FILE_CATEGORIES: { value: FileCategory; label: string }[] = [
  { value: "any", label: "Any type" },
  { value: "folder", label: "Folders" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "document", label: "Documents" },
  { value: "archive", label: "Archives" },
  { value: "code", label: "Code" },
  { value: "executable", label: "Executables" },
];

/** Modified-age presets (millisecond windows back from "now"). */
export type AgePreset = "any" | "24h" | "7d" | "30d" | "90d" | "365d" | "older1y";
export const AGE_PRESETS: { value: AgePreset; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "24h", label: "Past 24 hours" },
  { value: "7d", label: "Past 7 days" },
  { value: "30d", label: "Past 30 days" },
  { value: "90d", label: "Past 90 days" },
  { value: "365d", label: "Past year" },
  { value: "older1y", label: "Older than a year" },
];

/** The full filter set the Search view collects. All fields optional/neutral. */
export interface SearchFilters {
  /** Use the query as a JS RegExp over the node NAME instead of substring. */
  regex: boolean;
  /** Minimum / maximum size in BYTES (undefined = unbounded). */
  minSize?: number;
  maxSize?: number;
  /** Modified after / before, epoch MILLISECONDS (undefined = unbounded). */
  modifiedAfter?: number;
  modifiedBefore?: number;
  /** Relative modified-age preset; combined (AND) with the after/before range. */
  agePreset: AgePreset;
  /** Free-form extension filter, comma/space separated (e.g. "jpg, png"). */
  ext: string;
  /** Coarse type bucket. */
  category: FileCategory;
}

export const EMPTY_FILTERS: SearchFilters = {
  regex: false,
  agePreset: "any",
  ext: "",
  category: "any",
};

/** True when any narrowing filter (besides regex/the query) is active. */
export function filtersActive(f: SearchFilters): boolean {
  return (
    f.minSize != null || f.maxSize != null ||
    f.modifiedAfter != null || f.modifiedBefore != null ||
    f.agePreset !== "any" || f.ext.trim() !== "" || f.category !== "any"
  );
}

/** A compiled name matcher: `test(name, path)` plus an `invalid` flag set when a
 *  regex query failed to compile (callers show a subtle invalid state). */
export interface NameMatcher {
  test: (name: string, path: string) => boolean;
  invalid: boolean;
}

export function compileNameMatcher(query: string, regex: boolean): NameMatcher {
  const q = query.trim();
  if (regex) {
    try {
      const re = new RegExp(q, "i");
      return { test: (name) => re.test(name), invalid: false };
    } catch {
      // Invalid pattern: match nothing, flag so the UI can hint at it.
      return { test: () => false, invalid: true };
    }
  }
  const lower = q.toLowerCase();
  return {
    test: (name, path) => name.toLowerCase().includes(lower) || (!!path && path.toLowerCase().includes(lower)),
    invalid: false,
  };
}

function parseExtList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((e) => e.trim().replace(/^[.*]+/, "").toLowerCase())
    .filter(Boolean);
}

function agePresetCutoff(preset: AgePreset, now: number): { after?: number; before?: number } {
  const DAY = 24 * 60 * 60 * 1000;
  switch (preset) {
    case "24h": return { after: now - DAY };
    case "7d": return { after: now - 7 * DAY };
    case "30d": return { after: now - 30 * DAY };
    case "90d": return { after: now - 90 * DAY };
    case "365d": return { after: now - 365 * DAY };
    case "older1y": return { before: now - 365 * DAY };
    default: return {};
  }
}

function categoryMatches(node: NodeRecord, category: FileCategory): boolean {
  if (category === "any") return true;
  if (category === "folder") return node.dir;
  if (node.dir) return false;
  const set = CATEGORY_EXTS[category];
  const ext = (node.extension || "").replace(/^\./, "").toLowerCase();
  return set.has(ext);
}

/** A single node-level predicate compiled from the size/date/type filters.
 *  Node modified time is in SECONDS (mirrors the scan), converted to ms here. */
export function makeFilterPredicate(filters: SearchFilters, now = Date.now()): (node: NodeRecord) => boolean {
  const exts = parseExtList(filters.ext);
  const ageCut = agePresetCutoff(filters.agePreset, now);
  const after = Math.max(filters.modifiedAfter ?? 0, ageCut.after ?? 0) || undefined;
  const before = (() => {
    const a = filters.modifiedBefore;
    const b = ageCut.before;
    if (a != null && b != null) return Math.min(a, b);
    return a ?? b;
  })();

  return (node: NodeRecord): boolean => {
    if (filters.minSize != null && node.size < filters.minSize) return false;
    if (filters.maxSize != null && node.size > filters.maxSize) return false;
    if (after != null || before != null) {
      const modMs = (node.modified || 0) * 1000;
      if (after != null && modMs < after) return false;
      if (before != null && modMs > before) return false;
    }
    if (!categoryMatches(node, filters.category)) return false;
    if (exts.length > 0) {
      if (node.dir) return false;
      const ext = (node.extension || "").replace(/^\./, "").toLowerCase();
      if (!exts.includes(ext)) return false;
    }
    return true;
  };
}

/**
 * Advanced variant of {@link searchNodes}: the name match honors a regex toggle
 * and the results are additionally narrowed by size/date/type predicates
 * (combined with AND). Returns [] for queries < 2 chars UNLESS the query is
 * empty but filters are active (lets a pure size/type filter list results).
 */
export function searchNodesAdvanced(
  nodeById: Map<number, NodeRecord>,
  query: string,
  filters: SearchFilters,
  sortKey: SortKey,
  sortDir: 1 | -1,
  limit: number,
): NodeRecord[] {
  const q = query.trim();
  const hasFilters = filtersActive(filters);
  // Need either a 2+ char query or at least one active narrowing filter.
  if (q.length < 2 && !hasFilters) return [];

  const matcher = compileNameMatcher(query, filters.regex);
  if (matcher.invalid) return [];
  const predicate = makeFilterPredicate(filters);
  // When there's no usable query, match every node by name and rely on filters.
  const nameMatchAll = q.length < 2;

  const matches: NodeRecord[] = [];
  for (const node of nodeById.values()) {
    if (node.id < 0) continue;
    if (!nameMatchAll && !matcher.test(node.name, node.path || "")) continue;
    if (!predicate(node)) continue;
    matches.push(node);
  }
  matches.sort((a, b) => compareNodes(a, b, sortKey, sortDir));
  return matches.slice(0, limit);
}
