// Client-side duplicate matching engine. Pure helpers shared by the
// useDuplicatesController hook: candidate aggregation from scan results,
// per-criterion delta scoring, and group construction (content-verified or
// criteria-keyed). Kept free of React so it stays easy to reason about.

import type {
  DupeCriteria,
  DupeFileV2,
  DupeGroupV2,
  DupeMatch,
  NodeRecord,
  ReprioritizeCriterion,
  ScanResult,
} from "../api/types";

/** Flat metadata for one candidate file, derived from a scan node. */
export interface CandidateMeta {
  path: string;
  name: string;
  folder: string;
  size: number;
  modifiedMs: number;
  mtimeSec: number;
  ext: string;
  hidden: boolean;
}

export interface DupeFilters {
  /** Minimum size in bytes (files smaller are excluded). */
  minSize: number;
  /** Maximum size in bytes, or undefined for no cap. */
  maxSize?: number;
  /** Lowercased extensions (no dot); empty = all. */
  extensions: string[];
  includeHidden: boolean;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

/** Folder portion of a full path (strip the trailing file/dir name). */
function folderOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx >= 0 ? path.slice(0, idx) : path;
}

/** True when `child` is `parent` or sits inside it. */
export function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p + "/");
}

/**
 * Pick, for a target folder/drive, the best already-available scan result:
 * an exact root match, else the closest ancestor (longest rootPath). Returns
 * null when nothing covers the target (the caller then scans it once).
 */
export function bestSourceForTarget(target: string, pool: ScanResult[]): ScanResult | null {
  let best: ScanResult | null = null;
  let bestLen = -1;
  const t = normalizePath(target);
  for (const r of pool) {
    if (!r?.rootPath) continue;
    const root = normalizePath(r.rootPath);
    if (t === root || t.startsWith(root + "/")) {
      if (root.length > bestLen) {
        best = r;
        bestLen = root.length;
      }
    }
  }
  return best;
}

/** Convert the file nodes of a scan result (that fall under `target`) to candidates. */
export function candidatesFromScan(result: ScanResult, target: string): CandidateMeta[] {
  const out: CandidateMeta[] = [];
  for (const node of result.nodes as NodeRecord[]) {
    if (node.dir) continue;
    if (!node.path) continue;
    if (!isUnder(node.path, target)) continue;
    out.push({
      path: node.path,
      name: node.name,
      folder: folderOf(node.path),
      size: node.size,
      modifiedMs: node.modified,
      mtimeSec: Math.floor(node.modified / 1000),
      ext: (node.extension || "").toLowerCase(),
      hidden: node.hidden,
    });
  }
  return out;
}

export function passesFilters(c: CandidateMeta, f: DupeFilters): boolean {
  if (c.size < Math.max(1, f.minSize)) return false;
  if (f.maxSize != null && c.size > f.maxSize) return false;
  if (!f.includeHidden && c.hidden) return false;
  if (f.extensions.length > 0 && !f.extensions.includes(c.ext)) return false;
  return true;
}

/** Dedupe candidates by normalized path (overlapping targets/sources). */
export function dedupeCandidates(list: CandidateMeta[]): CandidateMeta[] {
  const seen = new Set<string>();
  const out: CandidateMeta[] = [];
  for (const c of list) {
    const key = normalizePath(c.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ── Filename similarity (Sørensen-Dice over word tokens) ────────────────────

function words(name: string): string[] {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem
    .replace(/[-_()[\]{}]/g, " ")
    .replace(/['.,]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Sørensen-Dice token overlap, 0-100. Mirrors the Rust unweighted dice_score. */
export function diceSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const w of wa) countA.set(w, (countA.get(w) ?? 0) + 1);
  for (const w of wb) countB.set(w, (countB.get(w) ?? 0) + 1);
  let intersection = 0;
  for (const [w, ca] of countA) intersection += Math.min(ca, countB.get(w) ?? 0);
  const total = wa.length + wb.length;
  return total === 0 ? 0 : Math.min(100, Math.round((2 * intersection * 100) / total));
}

function nameScore(a: string, b: string, fuzzy: boolean): number {
  if (a.toLowerCase() === b.toLowerCase()) return 100;
  return fuzzy ? diceSimilarity(a, b) : 0;
}

function sizeScore(a: number, b: number): number {
  if (a === b) return 100;
  const max = Math.max(a, b);
  if (max === 0) return 100;
  return Math.round((Math.min(a, b) / max) * 100);
}

function dateScore(aSec: number, bSec: number, toleranceSec: number): number {
  const diff = Math.abs(aSec - bSec);
  if (diff <= toleranceSec) return 100;
  const days = diff / 86400;
  return Math.max(0, Math.round(100 - days)); // soft decay: ~1% per day
}

// ── Reference selection + scoring ───────────────────────────────────────────

function referenceIndex(files: CandidateMeta[], crit: ReprioritizeCriterion): number {
  let best = 0;
  for (let i = 1; i < files.length; i++) {
    if (preferAsReference(files[i], files[best], crit)) best = i;
  }
  return best;
}

function preferAsReference(a: CandidateMeta, b: CandidateMeta, crit: ReprioritizeCriterion): boolean {
  switch (crit) {
    case "largest": return a.size > b.size;
    case "smallest": return a.size < b.size;
    case "newest": return a.mtimeSec > b.mtimeSec;
    case "oldest": return a.mtimeSec < b.mtimeSec;
    case "shortestPath": return a.path.length < b.path.length;
    case "longestPath": return a.path.length > b.path.length;
    case "alphaFirst": return a.name.toLowerCase() < b.name.toLowerCase();
    case "alphaLast": return a.name.toLowerCase() > b.name.toLowerCase();
    default: return false;
  }
}

function matchVsRef(file: CandidateMeta, ref: CandidateMeta, criteria: DupeCriteria, contentEqual: boolean): DupeMatch {
  return {
    name: nameScore(ref.name, file.name, criteria.nameFuzzy),
    size: sizeScore(ref.size, file.size),
    date: dateScore(ref.mtimeSec, file.mtimeSec, criteria.dateToleranceSec),
    content: contentEqual ? 100 : 0,
  };
}

/** Overall match % = mean of enabled criteria scores. */
function overallScore(m: DupeMatch, criteria: DupeCriteria): number {
  const parts: number[] = [];
  if (criteria.name.enabled) parts.push(m.name);
  if (criteria.size.enabled) parts.push(m.size);
  if (criteria.date.enabled) parts.push(m.date);
  if (criteria.content.enabled) parts.push(m.content);
  if (parts.length === 0) return 100;
  return Math.round(parts.reduce((s, v) => s + v, 0) / parts.length);
}

/** A required criterion must be fully satisfied for a duplicate to stay. */
function satisfiesRequired(m: DupeMatch, criteria: DupeCriteria): boolean {
  if (criteria.name.required) {
    const need = criteria.nameFuzzy ? criteria.nameThreshold : 100;
    if (m.name < need) return false;
  }
  if (criteria.size.required && m.size < 100) return false;
  if (criteria.date.required && m.date < 100) return false;
  if (criteria.content.required && m.content < 100) return false;
  return true;
}

function buildGroup(
  members: CandidateMeta[],
  criteria: DupeCriteria,
  repri: ReprioritizeCriterion,
  contentVerified: boolean,
): DupeGroupV2 | null {
  if (members.length < 2) return null;
  const refIdx = referenceIndex(members, repri);
  const ref = members[refIdx];

  const ordered: CandidateMeta[] = [ref, ...members.filter((_, i) => i !== refIdx)];
  const kept: DupeFileV2[] = [];
  // Reference first.
  kept.push(toFile(ref, true, { name: 100, size: 100, date: 100, content: contentVerified ? 100 : 0 }, 100));

  for (let i = 1; i < ordered.length; i++) {
    const m = matchVsRef(ordered[i], ref, criteria, contentVerified);
    if (!satisfiesRequired(m, criteria)) continue;
    kept.push(toFile(ordered[i], false, m, overallScore(m, criteria)));
  }
  if (kept.length < 2) return null;

  const waste = kept.slice(1).reduce((s, f) => s + f.size, 0);
  const score = Math.min(...kept.slice(1).map((f) => f.score ?? 0));
  return { files: kept, waste, score };
}

function toFile(c: CandidateMeta, ref: boolean, match: DupeMatch, score: number): DupeFileV2 {
  return {
    path: c.path,
    name: c.name,
    size: c.size,
    modified: c.mtimeSec,
    ref,
    score,
    match,
  };
}

// ── Group builders ──────────────────────────────────────────────────────────

/**
 * Build content-verified groups from server hash results. Each input group is
 * a set of byte-identical paths; we attach metadata, pick a reference, score
 * deltas, and apply non-content required filters.
 */
export function buildContentGroups(
  hashGroups: { paths: string[] }[],
  byPath: Map<string, CandidateMeta>,
  criteria: DupeCriteria,
  repri: ReprioritizeCriterion,
): DupeGroupV2[] {
  const out: DupeGroupV2[] = [];
  for (const hg of hashGroups) {
    const members = hg.paths
      .map((p) => byPath.get(normalizePath(p)))
      .filter((c): c is CandidateMeta => !!c);
    const group = buildGroup(members, criteria, repri, true);
    if (group) out.push(group);
  }
  return out;
}

/**
 * Build groups keyed by the enabled exact criteria (content off). Files sharing
 * the same key tuple (size / lowercased name / date bucket) group together.
 */
export function buildKeyedGroups(
  candidates: CandidateMeta[],
  criteria: DupeCriteria,
  repri: ReprioritizeCriterion,
): { groups: DupeGroupV2[]; error?: string } {
  // Prefer the required criteria as the grouping key; if none are required,
  // fall back to all enabled (non-content) criteria.
  const useRequired =
    criteria.name.required || criteria.size.required || criteria.date.required;
  const keyName = useRequired ? criteria.name.required : criteria.name.enabled;
  const keySize = useRequired ? criteria.size.required : criteria.size.enabled;
  const keyDate = useRequired ? criteria.date.required : criteria.date.enabled;

  if (!keyName && !keySize && !keyDate) {
    return { groups: [], error: "Enable Name, Size, or Date (or turn Content on) to match." };
  }

  const tol = Math.max(1, criteria.dateToleranceSec);
  const buckets = new Map<string, CandidateMeta[]>();
  for (const c of candidates) {
    const parts: string[] = [];
    if (keySize) parts.push("s" + c.size);
    if (keyName) parts.push("n" + c.name.toLowerCase());
    if (keyDate) parts.push("d" + Math.round(c.mtimeSec / tol));
    const key = parts.join("\u0000");
    const arr = buckets.get(key);
    if (arr) arr.push(c);
    else buckets.set(key, [c]);
  }

  const out: DupeGroupV2[] = [];
  for (const members of buckets.values()) {
    const group = buildGroup(members, criteria, repri, false);
    if (group) out.push(group);
  }
  return { groups: out };
}

/**
 * Force `refPath` to be the reference of an existing group and recompute every
 * survivor's delta scores against it (used by the "Make Ref" row action). All
 * members are kept — required-criteria pruning already happened at build time.
 */
export function rebuildWithReference(
  group: DupeGroupV2,
  refPath: string,
  criteria: DupeCriteria,
  contentVerified: boolean,
): DupeGroupV2 {
  const members = group.files.map(dupeFileToCandidate);
  const key = normalizePath(refPath);
  const refIdx = members.findIndex((m) => normalizePath(m.path) === key);
  if (refIdx < 0) return group;
  const ref = members[refIdx];
  const kept: DupeFileV2[] = [
    toFile(ref, true, { name: 100, size: 100, date: 100, content: contentVerified ? 100 : 0 }, 100),
  ];
  for (let i = 0; i < members.length; i++) {
    if (i === refIdx) continue;
    const m = matchVsRef(members[i], ref, criteria, contentVerified);
    kept.push(toFile(members[i], false, m, overallScore(m, criteria)));
  }
  const waste = kept.slice(1).reduce((s, f) => s + f.size, 0);
  const score = kept.length > 1 ? Math.min(...kept.slice(1).map((f) => f.score ?? 0)) : 100;
  return { files: kept, waste, score };
}

/** Sort groups by wasted bytes descending (most impactful first). */
export function sortGroupsByWaste(groups: DupeGroupV2[]): DupeGroupV2[] {
  return [...groups].sort((a, b) => b.waste - a.waste);
}

/** Stable signature of a group's member set, used for the session ignore list. */
export function groupSignature(group: DupeGroupV2): string {
  return group.files
    .map((f) => normalizePath(f.path))
    .sort()
    .join("|");
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Reconstruct candidate metadata from an already-grouped file. */
export function dupeFileToCandidate(f: DupeFileV2): CandidateMeta {
  return {
    path: f.path,
    name: f.name,
    folder: folderOf(f.path),
    size: f.size,
    modifiedMs: f.modified * 1000,
    mtimeSec: f.modified,
    ext: extOf(f.name),
    hidden: false,
  };
}

/**
 * Remove acted-on paths (deleted/moved) from groups in place of a full rescan,
 * re-selecting references and recomputing deltas for the survivors. Groups that
 * fall below two members are dropped.
 */
export function pruneGroups(
  groups: DupeGroupV2[],
  removed: Set<string>,
  criteria: DupeCriteria,
  repri: ReprioritizeCriterion,
  contentVerified: boolean,
): DupeGroupV2[] {
  const out: DupeGroupV2[] = [];
  for (const g of groups) {
    const remaining = g.files.filter((f) => !removed.has(normalizePath(f.path)));
    if (remaining.length < 2) continue;
    const rebuilt = buildGroup(remaining.map(dupeFileToCandidate), criteria, repri, contentVerified);
    if (rebuilt) out.push(rebuilt);
  }
  return out;
}

/** Normalize a path the same way the engine keys candidates (for selection sets). */
export function normalizeForKey(p: string): string {
  return normalizePath(p);
}
