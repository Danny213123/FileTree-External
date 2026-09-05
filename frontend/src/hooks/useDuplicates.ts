import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DupeCriteria,
  DupeCriterionKey,
  DupeGroupV2,
  ReprioritizeCriterion,
  ScanResult,
} from "../api/types";
import {
  cancelDupesScan,
  dupeAction,
  dupeClearIgnoreList,
  dupeIgnorePair,
  fetchDupesHash,
  fetchDupesProgress,
  hardlinkPairs,
  scanStreamUrl,
  type DupeHashFile,
} from "../api/client";
import { readNdjsonStream } from "./useScan";
import {
  cancelV2DuplicateScan,
  isTauriV2,
  runV2DuplicateScan,
  runV2Scan,
} from "../api/v2";
import { getCached, invalidate, setCached } from "../lib/scanCache";
import { confirmDialog } from "../lib/dialogs";
import { toast } from "../lib/toast";
import {
  actionableDuplicatePaths,
  annotateProtectedLocations,
  applyProtectedLocations,
  bestSourceForTarget,
  buildContentGroups,
  buildKeyedGroups,
  candidatesFromScan,
  dedupeCandidates,
  groupSignature,
  isUnder,
  normalizeForKey,
  passesFilters,
  pruneGroups,
  rebuildWithReference,
  sortGroupsByWaste,
  type CandidateMeta,
  type DupeFilters,
} from "../lib/duplicatesEngine";

export type DupeScanState = "idle" | "scanning" | "done" | "error" | "canceled";
export type DupePhase = "idle" | "aggregating" | "hashing" | "grouping" | "done";

/** Deterministic rules for choosing the one copy to keep in each group. */
export type KeepStrategy =
  | "first"
  | "newest"
  | "oldest"
  | "largest"
  | "smallest"
  | "shortestPath"
  | "longestPath"
  | "drive";

/** Uppercase drive letter of a Windows path (e.g. "C"), or "" when none. */
function driveLetterOf(p: string): string {
  const m = /^([a-zA-Z]):/.exec(p);
  return m ? m[1].toUpperCase() : "";
}

/** Pick the path to KEEP within a group per the chosen strategy. Falls back to
 *  the current reference (so a strategy never checks every copy in a group). */
function pickSurvivor(files: DupeGroupV2["files"], strategy: KeepStrategy, drive?: string): string {
  if (files.length === 0) return "";
  const current = (files.find((f) => f.ref) ?? files[0]).path;
  const protectedCopy = files
    .filter((file) => file.protected)
    .sort((a, b) => normalizeForKey(a.path).localeCompare(normalizeForKey(b.path)))[0];
  if (protectedCopy) return protectedCopy.path;
  switch (strategy) {
    case "first":
      return current;
    case "newest":
      return files.reduce((a, b) => (b.modified > a.modified ? b : a)).path;
    case "oldest":
      return files.reduce((a, b) => (b.modified < a.modified ? b : a)).path;
    case "largest":
      return files.reduce((a, b) => (b.size > a.size ? b : a)).path;
    case "smallest":
      return files.reduce((a, b) => (b.size < a.size ? b : a)).path;
    case "shortestPath":
      return files.reduce((a, b) => (b.path.length < a.path.length ? b : a)).path;
    case "longestPath":
      return files.reduce((a, b) => (b.path.length > a.path.length ? b : a)).path;
    case "drive": {
      const onDrive = files.filter((f) => driveLetterOf(f.path) === (drive ?? "").toUpperCase());
      if (onDrive.length === 0) return current; // none on the preferred drive: keep the current copy
      return onDrive.reduce((a, b) => (b.path.length < a.path.length ? b : a)).path;
    }
  }
}

export interface DupeProgress {
  scanned: number;
  hashing: number;
  hashed: number;
}

export interface UseDuplicatesArgs {
  /** Snapshots of every open tab's scan (used as a zero-cost aggregation source). */
  getScanResults: () => ScanResult[];
  threads: number;
  defaultIncludeHidden: boolean;
}

function defaultCriteria(): DupeCriteria {
  return {
    content: { enabled: true, required: true },
    size: { enabled: true, required: false },
    name: { enabled: true, required: false },
    date: { enabled: true, required: false },
    nameFuzzy: false,
    nameThreshold: 80,
    dateToleranceSec: 0,
  };
}

const DUPLICATES_PREFS_KEY = "filetree.duplicates.preferences.v2";

interface DuplicatePreferences {
  selectedPaths: string[];
  customPaths: string[];
  protectedPaths: string[];
  ignoredSignatures: string[];
  criteria: DupeCriteria;
  minSizeKb: number;
  maxSizeKb: string;
  extensions: string;
  includeHidden: boolean;
  destPath: string;
  deleteMode: "recycle" | "permanent";
  repriCriterion: ReprioritizeCriterion;
}

function loadDuplicatePreferences(): Partial<DuplicatePreferences> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DUPLICATES_PREFS_KEY) ?? "{}") as Partial<DuplicatePreferences>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function protectedPolicyKey(paths: string[]): string {
  return paths.map(normalizeForKey).sort().join("|");
}

function downloadReport(filename: string, type: string, text: string): void {
  const blob = new Blob([text], { type });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

export interface DuplicatesController {
  // Targets
  selectedPaths: string[];
  customPaths: string[];
  protectedPaths: string[];
  togglePath: (p: string) => void;
  addCustomPath: (p: string) => void;
  removeCustomPath: (p: string) => void;
  toggleProtectedPath: (p: string) => void;

  // Criteria
  criteria: DupeCriteria;
  setCriterion: (key: DupeCriterionKey, patch: Partial<DupeCriteria[DupeCriterionKey]>) => void;
  setNameFuzzy: (v: boolean) => void;
  setNameThreshold: (v: number) => void;
  setDateToleranceSec: (v: number) => void;

  // Filters
  minSizeKb: number;
  setMinSizeKb: (v: number) => void;
  maxSizeKb: string;
  setMaxSizeKb: (v: string) => void;
  extensions: string;
  setExtensions: (v: string) => void;
  includeHidden: boolean;
  setIncludeHidden: (v: boolean) => void;

  // Actions config
  destPath: string;
  setDestPath: (v: string) => void;
  deleteMode: "recycle" | "permanent";
  setDeleteMode: (v: "recycle" | "permanent") => void;
  repriCriterion: ReprioritizeCriterion;
  setRepriCriterion: (v: ReprioritizeCriterion) => void;

  // Scan lifecycle
  scanState: DupeScanState;
  phase: DupePhase;
  progress: DupeProgress;
  startScan: () => void;
  stopScan: () => void;

  // Results
  groups: DupeGroupV2[];
  errors: string[];
  ignoredCount: number;
  ignoredGroups: DupeGroupV2[];

  // Selection
  selected: Set<string>;
  collapsed: Set<string>;
  toggleFile: (path: string) => void;
  toggleGroup: (group: DupeGroupV2) => void;
  toggleCollapse: (key: string) => void;
  selectAll: (paths?: string[]) => void;
  unselectAll: (paths?: string[]) => void;
  invertSelection: (paths?: string[]) => void;
  keepFirst: () => void;
  /** #24 auto-pick: choose the kept survivor per group by a strategy, make it the
   *  reference, and check every other copy for removal. `drive` (e.g. "C") is
   *  required only for the "drive" strategy. */
  keepStrategy: (strategy: KeepStrategy, drive?: string) => void;

  // Group actions
  makeRef: (group: DupeGroupV2, refPath: string) => void;
  ignoreGroup: (group: DupeGroupV2) => void;
  clearIgnoreList: () => void;
  restoreIgnoredGroups: () => void;
  reprioritizeApply: () => void;

  // File actions
  actionPending: boolean;
  deleteSelected: () => Promise<void>;
  moveSelected: () => Promise<void>;
  copySelected: () => Promise<void>;
  /** #26: replace the checked duplicates with hard/symlinks to their reference. */
  linkSelected: (mode: "hardlink" | "symlink") => Promise<void>;
  exportCsv: () => void;
  exportJson: () => void;

  // Derived stats
  totalWaste: number;
  totalFiles: number;
  selectedCount: number;
  selectedBytes: number;
  selectedGroups: number;
  canScan: boolean;
}

export function useDuplicatesController(args: UseDuplicatesArgs): DuplicatesController {
  const { getScanResults, threads, defaultIncludeHidden } = args;
  const initialPreferences = useRef(loadDuplicatePreferences()).current;

  const [selectedPaths, setSelectedPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.selectedPaths) ? initialPreferences.selectedPaths : [],
  );
  const [customPaths, setCustomPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.customPaths) ? initialPreferences.customPaths : [],
  );
  const [protectedPaths, setProtectedPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.protectedPaths) ? initialPreferences.protectedPaths : [],
  );
  const [criteria, setCriteria] = useState<DupeCriteria>(() =>
    initialPreferences.criteria ?? defaultCriteria(),
  );
  const [minSizeKb, setMinSizeKb] = useState(initialPreferences.minSizeKb ?? 1);
  const [maxSizeKb, setMaxSizeKb] = useState(initialPreferences.maxSizeKb ?? "");
  const [extensions, setExtensions] = useState(initialPreferences.extensions ?? "");
  const [includeHidden, setIncludeHidden] = useState(initialPreferences.includeHidden ?? defaultIncludeHidden);
  const [destPath, setDestPath] = useState(initialPreferences.destPath ?? "");
  const [deleteMode, setDeleteMode] = useState<"recycle" | "permanent">(
    initialPreferences.deleteMode === "permanent" ? "permanent" : "recycle",
  );
  const [repriCriterion, setRepriCriterion] = useState<ReprioritizeCriterion>(
    initialPreferences.repriCriterion ?? "largest",
  );

  const [scanState, setScanState] = useState<DupeScanState>("idle");
  const [phase, setPhase] = useState<DupePhase>("idle");
  const [progress, setProgress] = useState<DupeProgress>({ scanned: 0, hashing: 0, hashed: 0 });
  const [groups, setGroups] = useState<DupeGroupV2[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [reviewToken, setReviewToken] = useState<string | null>(null);
  const [activeProtectionKey, setActiveProtectionKey] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [ignoredGroups, setIgnoredGroups] = useState<DupeGroupV2[]>([]);
  const [ignoredSignatures, setIgnoredSignatures] = useState<string[]>(() =>
    Array.isArray(initialPreferences.ignoredSignatures) ? initialPreferences.ignoredSignatures : [],
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const abortRef = useRef<AbortController | null>(null);
  // Persistent dismissed-match signatures plus current-session group payloads
  // (the latter let Restore bring rows back without another disk scan).
  const ignoredRef = useRef<Set<string>>(new Set(ignoredSignatures));
  // Live criteria mirror so post-action prune uses the current settings.
  const criteriaRef = useRef(criteria);
  useEffect(() => { criteriaRef.current = criteria; }, [criteria]);
  const repriRef = useRef(repriCriterion);
  useEffect(() => { repriRef.current = repriCriterion; }, [repriCriterion]);
  const protectedPathsRef = useRef(protectedPaths);
  useEffect(() => { protectedPathsRef.current = protectedPaths; }, [protectedPaths]);
  const contentVerifiedRef = useRef(false);
  const actionPendingRef = useRef(false);
  const beginAction = useCallback(() => {
    if (actionPendingRef.current) return false;
    actionPendingRef.current = true;
    setActionPending(true);
    return true;
  }, []);
  const endAction = useCallback(() => {
    actionPendingRef.current = false;
    setActionPending(false);
  }, []);

  useEffect(() => {
    const preferences: DuplicatePreferences = {
      selectedPaths,
      customPaths,
      protectedPaths,
      ignoredSignatures,
      criteria,
      minSizeKb,
      maxSizeKb,
      extensions,
      includeHidden,
      destPath,
      deleteMode,
      repriCriterion,
    };
    try {
      localStorage.setItem(DUPLICATES_PREFS_KEY, JSON.stringify(preferences));
    } catch {
      // Storage can be unavailable in hardened WebViews; the workflow still works.
    }
  }, [
    criteria,
    customPaths,
    deleteMode,
    destPath,
    extensions,
    includeHidden,
    ignoredSignatures,
    maxSizeKb,
    minSizeKb,
    protectedPaths,
    repriCriterion,
    selectedPaths,
  ]);
  // Poll the server hash progress while hashing so the UI shows real counts.
  useEffect(() => {
    if (phase !== "hashing" || isTauriV2()) return;
    const id = setInterval(async () => {
      const p = await fetchDupesProgress();
      setProgress((prev) => ({ scanned: prev.scanned, hashing: p.filesHashing, hashed: p.filesHashed }));
    }, 400);
    return () => clearInterval(id);
  }, [phase]);

  const togglePath = useCallback((p: string) => {
    if (actionPendingRef.current) return;
    setSelectedPaths((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }, []);
  const addCustomPath = useCallback((p: string) => {
    if (actionPendingRef.current) return;
    const v = p.trim();
    if (!v) return;
    setCustomPaths((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setSelectedPaths((prev) => (prev.includes(v) ? prev : [...prev, v]));
  }, []);
  const removeCustomPath = useCallback((p: string) => {
    if (actionPendingRef.current) return;
    setCustomPaths((prev) => prev.filter((x) => x !== p));
    setSelectedPaths((prev) => prev.filter((x) => x !== p));
    setProtectedPaths((prev) => prev.filter((x) => normalizeForKey(x) !== normalizeForKey(p)));
  }, []);
  const toggleProtectedPath = useCallback((p: string) => {
    if (actionPendingRef.current) {
      toast.warn("Wait for the current file action to finish.");
      return;
    }
    if (scanState === "scanning") {
      toast.warn("Stop the scan before changing protected locations.");
      return;
    }
    setProtectedPaths((prev) => {
      const key = normalizeForKey(p);
      return prev.some((path) => normalizeForKey(path) === key)
        ? prev.filter((path) => normalizeForKey(path) !== key)
        : [...prev, p];
    });
  }, [scanState]);

  const setCriterion = useCallback<DuplicatesController["setCriterion"]>((key, patch) => {
    setCriteria((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);
  const setNameFuzzy = useCallback((v: boolean) => setCriteria((p) => ({ ...p, nameFuzzy: v })), []);
  const setNameThreshold = useCallback((v: number) => setCriteria((p) => ({ ...p, nameThreshold: v })), []);
  const setDateToleranceSec = useCallback((v: number) => setCriteria((p) => ({ ...p, dateToleranceSec: v })), []);

  const buildFilters = useCallback((): DupeFilters => {
    const max = maxSizeKb.trim() ? Math.max(0, Number(maxSizeKb)) * 1024 : undefined;
    return {
      minSize: Math.max(0, minSizeKb) * 1024,
      maxSize: max && max > 0 ? max : undefined,
      extensions: extensions
        .split(",")
        .map((e) => e.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean),
      includeHidden,
    };
  }, [minSizeKb, maxSizeKb, extensions, includeHidden]);

  const runScan = useCallback(async () => {
    if (actionPendingRef.current) return;
    const targets = selectedPaths.filter(Boolean);
    if (targets.length === 0) {
      setScanState("error");
      setErrors(["Select one or more drives or folders to scan."]);
      return;
    }
    const scanProtectedPaths = protectedPathsRef.current.filter((path) =>
      targets.some((target) => isUnder(path, target) || isUnder(target, path)),
    );
    const scanProtectionKey = protectedPolicyKey(protectedPathsRef.current);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;

    setScanState("scanning");
    setPhase("aggregating");
    setProgress({ scanned: 0, hashing: 0, hashed: 0 });
    setGroups([]);
    setIgnoredGroups([]);
    setSelected(new Set());
    setErrors([]);
    setReviewToken(null);
    setActiveProtectionKey(null);
    contentVerifiedRef.current = false;

    const filters = buildFilters();
    const aggErrors: string[] = [];

    try {
      // 1. Aggregate candidate metadata from already-scanned tabs + caches; scan
      //    only the roots that nothing covers yet (each exactly once).
      const pool: ScanResult[] = [...getScanResults().filter((r): r is ScanResult => !!r)];
      for (const t of targets) {
        const cached = getCached(t);
        if (cached) pool.push(cached);
      }

      if (isTauriV2()) {
        if (!criteria.content.enabled) {
          throw new Error("FileTree v2 currently requires Content matching for duplicate scans.");
        }
        const sources: { scanId: string; targetPath: string }[] = [];
        for (const target of targets) {
          let source: ScanResult | undefined;
          let sourceLength = -1;
          for (const candidate of pool) {
            if (!candidate.scanId || !isUnder(target, candidate.rootPath)) continue;
            if (candidate.rootPath.length > sourceLength) {
              source = candidate;
              sourceLength = candidate.rootPath.length;
            }
          }
          if (!source) {
            try {
              source = await runV2Scan(
                { path: target, includeHidden, threads },
                (event) => setProgress((prev) => ({ ...prev, scanned: event.nodeCount })),
                signal,
              );
              pool.push(source);
            } catch (error) {
              if (error instanceof Error && error.name === "AbortError") return;
              aggErrors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
              continue;
            }
          }
          if (source.scanId) sources.push({ scanId: source.scanId, targetPath: target });
        }
        if (sources.length === 0) {
          throw new Error(aggErrors[0] || "No duplicate scan targets could be indexed.");
        }

        setPhase("hashing");
        const duplicateResult = await runV2DuplicateScan(
          {
            sources,
            minSize: filters.minSize,
            maxSize: filters.maxSize ?? null,
            extensions: filters.extensions,
            includeHidden: filters.includeHidden,
            threads,
          },
          scanProtectedPaths,
          (event) => {
            setPhase(event.phase === "indexing" ? "aggregating" : "hashing");
            setProgress({ scanned: event.scanned, hashing: event.hashing, hashed: event.hashed });
          },
          signal,
        );
        if (duplicateResult.cancelled || signal.aborted) return;
        aggErrors.push(...duplicateResult.errors.slice(0, 50));

        const byPath = new Map<string, CandidateMeta>();
        const hashGroups = duplicateResult.groups.map((group) => ({
          paths: group.files.map((file) => {
            const slash = Math.max(file.path.lastIndexOf("\\"), file.path.lastIndexOf("/"));
            const dot = file.name.lastIndexOf(".");
            byPath.set(normalizeForKey(file.path), {
              path: file.path,
              name: file.name,
              folder: slash >= 0 ? file.path.slice(0, slash) : file.path,
              size: file.size,
              modifiedMs: file.modified * 1000,
              mtimeSec: file.modified,
              ext: dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "",
              hidden: false,
            });
            return file.path;
          }),
        }));
        setPhase("grouping");
        let result = buildContentGroups(hashGroups, byPath, criteria, repriCriterion);
        setIgnoredGroups(result.filter((group) => ignoredRef.current.has(groupSignature(group))));
        result = result.filter((group) => !ignoredRef.current.has(groupSignature(group)));
        result = applyProtectedLocations(
          result,
          protectedPathsRef.current,
          criteria,
          repriCriterion,
          criteria.content.enabled,
        );
        result = sortGroupsByWaste(result);
        setGroups(result);
        setErrors(aggErrors);
        contentVerifiedRef.current = true;
        setReviewToken(duplicateResult.reviewToken || null);
        setActiveProtectionKey(scanProtectionKey);
        setScanState("done");
        setPhase("done");
        return;
      }

      let candidates: CandidateMeta[] = [];
      for (const target of targets) {
        let src = bestSourceForTarget(target, pool);
        if (!src) {
          try {
            const res = await fetch(scanStreamUrl({ path: target, includeHidden, threads }), { signal });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            // forceFull: duplicate detection must see every file, so override the
            // lazy-ingest threshold here (the result is consumed for candidate
            // metadata and not held as the persistent tree).
            const result = await readNdjsonStream(res.body.getReader(), (n) =>
              setProgress((prev) => ({ ...prev, scanned: n })),
              { forceFull: true },
            );
            setCached(target, result);
            pool.push(result);
            src = result;
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            aggErrors.push(`${target}: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
        }
        candidates.push(...candidatesFromScan(src, target));
      }

      candidates = dedupeCandidates(candidates).filter((c) => passesFilters(c, filters));
      setProgress((prev) => ({ ...prev, scanned: candidates.length }));

      const byPath = new Map<string, CandidateMeta>();
      for (const c of candidates) byPath.set(normalizeForKey(c.path), c);

      let result: DupeGroupV2[] = [];
      if (criteria.content.enabled) {
        // Only files sharing a size with another candidate can be byte-identical.
        const bySize = new Map<number, CandidateMeta[]>();
        for (const c of candidates) {
          const arr = bySize.get(c.size);
          if (arr) arr.push(c);
          else bySize.set(c.size, [c]);
        }
        const hashInput: DupeHashFile[] = [];
        for (const arr of bySize.values()) {
          if (arr.length < 2) continue;
          for (const c of arr) hashInput.push({ path: c.path, size: c.size, mtime: c.mtimeSec });
        }

        setPhase("hashing");
        setProgress((prev) => ({ ...prev, hashing: hashInput.length, hashed: 0 }));
        const hashRes = await fetchDupesHash(hashInput, true, signal);
        if (hashRes.errors.length) aggErrors.push(...hashRes.errors.slice(0, 50));

        setPhase("grouping");
        result = buildContentGroups(hashRes.groups, byPath, criteria, repriCriterion);
      } else {
        setPhase("grouping");
        const built = buildKeyedGroups(candidates, criteria, repriCriterion);
        if (built.error) aggErrors.push(built.error);
        result = built.groups;
      }

      setIgnoredGroups(result.filter((group) => ignoredRef.current.has(groupSignature(group))));
      result = result.filter((g) => !ignoredRef.current.has(groupSignature(g)));
      result = applyProtectedLocations(
        result,
        protectedPathsRef.current,
        criteria,
        repriCriterion,
        criteria.content.enabled,
      );
      result = sortGroupsByWaste(result);

      if (signal.aborted) return;
      setGroups(result);
      setErrors(aggErrors);
      contentVerifiedRef.current = criteria.content.enabled;
      setActiveProtectionKey(scanProtectionKey);
      setScanState("done");
      setPhase("done");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setErrors([...aggErrors, e instanceof Error ? e.message : String(e)]);
      setReviewToken(null);
      setActiveProtectionKey(null);
      setScanState("error");
      setPhase("idle");
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, [selectedPaths, buildFilters, getScanResults, includeHidden, threads, criteria, repriCriterion, protectedPaths]);

  const startScan = useCallback(() => { void runScan(); }, [runScan]);

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (isTauriV2()) void cancelV2DuplicateScan();
    else void cancelDupesScan();
    setReviewToken(null);
    setActiveProtectionKey(null);
    contentVerifiedRef.current = false;
    setScanState("canceled");
    setPhase("idle");
  }, []);

  // Protection is part of the native review capability. Changing it retires
  // the old result so UI markings and backend authorization cannot diverge.
  useEffect(() => {
    if (activeProtectionKey === null || activeProtectionKey === protectedPolicyKey(protectedPaths)) return;
    if (isTauriV2()) void cancelV2DuplicateScan();
    setReviewToken(null);
    setActiveProtectionKey(null);
    contentVerifiedRef.current = false;
    setGroups([]);
    setIgnoredGroups([]);
    setSelected(new Set());
    setCollapsed(new Set());
    setErrors([]);
    setScanState("idle");
    setPhase("idle");
    toast.info("Protected locations changed. Run a new scan to apply the policy.");
  }, [activeProtectionKey, protectedPaths]);

  // ── Selection ──────────────────────────────────────────────────────────────
  const allDupPaths = useMemo(
    () => actionableDuplicatePaths(groups),
    [groups],
  );
  const actionablePathSet = useMemo(() => new Set(allDupPaths), [allDupPaths]);

  // Reconcile selection after keeper/protection/group changes. This invariant is
  // also enforced again when actions run, so a stale hidden path is never used.
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((path) => actionablePathSet.has(path)));
      return next.size === prev.size ? prev : next;
    });
  }, [actionablePathSet]);
  const safeSelectedPaths = useMemo(
    () => allDupPaths.filter((path) => selected.has(path)),
    [allDupPaths, selected],
  );
  const selectedActionItems = useMemo(() => {
    const wanted = new Set(safeSelectedPaths);
    return groups.flatMap((group) => {
      const keeper = group.files.find((file) => file.ref);
      if (!keeper) return [];
      return group.files
        .filter((file) => wanted.has(file.path))
        .map((file) => ({ path: file.path, keeper: keeper.path }));
    });
  }, [groups, safeSelectedPaths]);

  const toggleFile = useCallback((path: string) => {
    if (actionPendingRef.current || !actionablePathSet.has(path)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [actionablePathSet]);
  const toggleGroup = useCallback((group: DupeGroupV2) => {
    if (actionPendingRef.current) return;
    const eligible = group.files.filter((f) => !f.ref && !f.protected).map((f) => f.path);
    setSelected((prev) => {
      const next = new Set(prev);
      const allChecked = eligible.length > 0 && eligible.every((p) => next.has(p));
      if (allChecked) eligible.forEach((p) => next.delete(p));
      else eligible.forEach((p) => next.add(p));
      return next;
    });
  }, []);
  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectAll = useCallback((paths?: string[]) => {
    if (actionPendingRef.current) return;
    const eligible = (paths ?? allDupPaths).filter((path) => actionablePathSet.has(path));
    setSelected((prev) => new Set([...prev, ...eligible]));
  }, [actionablePathSet, allDupPaths]);
  const unselectAll = useCallback((paths?: string[]) => {
    if (actionPendingRef.current) return;
    if (!paths) {
      setSelected(new Set());
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      paths.forEach((path) => next.delete(path));
      return next;
    });
  }, []);
  const invertSelection = useCallback((paths?: string[]) => {
    if (actionPendingRef.current) return;
    const eligible = (paths ?? allDupPaths).filter((path) => actionablePathSet.has(path));
    setSelected((prev) => {
      const next = new Set(prev);
      eligible.forEach((path) => {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      });
      return next;
    });
  }, [actionablePathSet, allDupPaths]);
  // #24: auto-pick — per group choose the survivor by strategy, make it the
  // reference, then check every other copy for removal. Rebuilding the reference
  // reuses the same engine path as "Make Ref" / "Re-prioritize references".
  const keepStrategy = useCallback((strategy: KeepStrategy, drive?: string) => {
    if (actionPendingRef.current) return;
    const rebuilt = annotateProtectedLocations(
      groups.map((g) =>
        rebuildWithReference(
          g,
          pickSurvivor(g.files, strategy, drive),
          criteriaRef.current,
          contentVerifiedRef.current,
        ),
      ),
      protectedPaths,
    );
    const sel = new Set<string>();
    for (const g of rebuilt) {
      for (const f of g.files) {
        if (!f.ref && !f.protected) sel.add(f.path);
      }
    }
    setGroups(sortGroupsByWaste(rebuilt));
    setSelected(sel);
  }, [groups, protectedPaths]);
  const keepFirst = useCallback(() => keepStrategy("first"), [keepStrategy]);

  // ── Group actions ───────────────────────────────────────────────────────────
  // Groups are matched by their member-set signature (not object identity): the
  // results view passes sorted/spread copies, so identity comparison would miss.
  const makeRef = useCallback((group: DupeGroupV2, refPath: string) => {
    if (actionPendingRef.current) return;
    const protectedKeeper = group.files.find((file) => file.protected && file.ref)
      ?? group.files.find((file) => file.protected);
    if (protectedKeeper && normalizeForKey(protectedKeeper.path) !== normalizeForKey(refPath)) {
      toast.warn("This group keeps its copy in a protected location. Unprotect that location to choose another keeper.");
      return;
    }
    const sig = groupSignature(group);
    setGroups((prev) => sortGroupsByWaste(prev.map((g) => {
      if (groupSignature(g) !== sig) return g;
      const rebuilt = rebuildWithReference(
        g,
        refPath,
        criteriaRef.current,
        contentVerifiedRef.current,
      );
      return annotateProtectedLocations([rebuilt], protectedPaths)[0];
    })));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(refPath);
      return next;
    });
  }, [protectedPaths]);

  const ignoreGroup = useCallback((group: DupeGroupV2) => {
    if (actionPendingRef.current) return;
    const sig = groupSignature(group);
    ignoredRef.current.add(sig);
    setIgnoredSignatures((prev) => prev.includes(sig) ? prev : [...prev, sig]);
    if (group.files.length >= 2) {
      void dupeIgnorePair(group.files[0].path, group.files[1].path).catch(() => undefined);
    }
    setIgnoredGroups((prev) =>
      prev.some((item) => groupSignature(item) === sig) ? prev : [...prev, group],
    );
    const memberPaths = new Set(group.files.map((file) => file.path));
    setSelected((prev) => new Set([...prev].filter((path) => !memberPaths.has(path))));
    setGroups((prev) => prev.filter((g) => groupSignature(g) !== sig));
  }, []);

  const restoreIgnoredGroups = useCallback(() => {
    if (actionPendingRef.current) return;
    const requiresRescan = ignoredSignatures.length > ignoredGroups.length;
    ignoredRef.current.clear();
    setIgnoredSignatures([]);
    setGroups((prev) => {
      const bySignature = new Map(prev.map((group) => [groupSignature(group), group]));
      ignoredGroups.forEach((group) => bySignature.set(groupSignature(group), group));
      return sortGroupsByWaste(
        applyProtectedLocations(
          [...bySignature.values()],
          protectedPaths,
          criteriaRef.current,
          repriRef.current,
          contentVerifiedRef.current,
        ),
      );
    });
    setIgnoredGroups([]);
    void dupeClearIgnoreList().catch(() => undefined);
    if (requiresRescan) {
      toast.info("Persistent hidden matches were restored. Run the scan again to show them.");
    }
  }, [ignoredGroups, ignoredSignatures, protectedPaths]);
  const clearIgnoreList = restoreIgnoredGroups;

  const reprioritizeApply = useCallback(() => {
    if (actionPendingRef.current) return;
    setGroups((prev) =>
      sortGroupsByWaste(
        applyProtectedLocations(
          pruneGroups(prev, new Set(), criteriaRef.current, repriRef.current, contentVerifiedRef.current),
          protectedPaths,
          criteriaRef.current,
          repriRef.current,
          contentVerifiedRef.current,
        ),
      ),
    );
  }, [protectedPaths]);

  // ── File actions ─────────────────────────────────────────────────────────────
  const invalidateAffected = useCallback((paths: string[], dest?: string) => {
    const seen = new Set<string>();
    for (const p of paths) {
      const parent = p.replace(/[/\\][^/\\]*$/, "");
      if (parent && !seen.has(parent)) { seen.add(parent); invalidate(parent); }
    }
    if (dest) invalidate(dest);
  }, []);
  const retireAmbiguousReview = useCallback((paths: string[], dest?: string) => {
    invalidateAffected(paths, dest);
    if (isTauriV2()) void cancelV2DuplicateScan();
    setReviewToken(null);
    setActiveProtectionKey(null);
    contentVerifiedRef.current = false;
    setGroups([]);
    setIgnoredGroups([]);
    setSelected(new Set());
    setCollapsed(new Set());
    setScanState("idle");
    setPhase("idle");
    toast.warn("Some file outcomes could not be confirmed. Run a new scan before continuing.");
  }, [invalidateAffected]);

  const deleteSelected = useCallback(async () => {
    const paths = safeSelectedPaths;
    if (!paths.length) return;
    const permanent = deleteMode === "permanent";
    const verb = permanent ? "permanently delete" : "send to Recycle Bin";
    const bytes = groups.reduce(
      (sum, group) => sum + group.files
        .filter((file) => paths.includes(file.path))
        .reduce((subtotal, file) => subtotal + file.size, 0),
      0,
    );
    const affectedGroups = groups.filter((group) =>
      group.files.some((file) => paths.includes(file.path)),
    ).length;
    const proceed = await confirmDialog({
      title: permanent ? "Permanently delete" : "Delete",
      message:
        `${verb} ${paths.length} file${paths.length > 1 ? "s" : ""} ` +
        `from ${affectedGroups} group${affectedGroups !== 1 ? "s" : ""} ` +
        `(${Math.max(0, bytes).toLocaleString()} bytes)?` +
        `${permanent ? "\n\nThis can\u2019t be undone." : ""}`,
      confirmLabel: permanent ? "Delete permanently" : "Move to Recycle Bin",
      danger: permanent,
    });
    if (!proceed) return;
    if (!beginAction()) return;
    let res: Awaited<ReturnType<typeof dupeAction>>;
    try {
      res = await dupeAction("delete", paths, {
        permanent,
        protectedPaths,
        items: selectedActionItems,
        reviewToken: reviewToken ?? undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      endAction();
    }
    if (res.errors.length) toast.error(`Some files could not be deleted:\n${res.errors.join("\n")}`);
    if (res.requiresRescan) {
      retireAmbiguousReview(paths);
      return;
    }
    if (!res.succeeded.length) return;
    const removed = new Set(res.succeeded.map(normalizeForKey));
    setGroups((prev) =>
      sortGroupsByWaste(applyProtectedLocations(
        pruneGroups(prev, removed, criteriaRef.current, repriRef.current, contentVerifiedRef.current),
        protectedPaths,
        criteriaRef.current,
        repriRef.current,
        contentVerifiedRef.current,
      )),
    );
    setSelected((prev) => new Set([...prev].filter((path) => !res.succeeded.includes(path))));
    invalidateAffected(res.succeeded);
  }, [safeSelectedPaths, selectedActionItems, deleteMode, groups, invalidateAffected, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const moveSelected = useCallback(async () => {
    const paths = safeSelectedPaths;
    if (!paths.length || !destPath.trim()) {
      toast.warn("Select files and set a destination folder.");
      return;
    }
    if (!beginAction()) return;
    let res: Awaited<ReturnType<typeof dupeAction>>;
    try {
      res = await dupeAction("move", paths, {
        dest: destPath.trim(),
        protectedPaths,
        items: selectedActionItems,
        reviewToken: reviewToken ?? undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      endAction();
    }
    if (res.errors.length) toast.error(`Some files could not be moved:\n${res.errors.join("\n")}`);
    if (res.requiresRescan) {
      retireAmbiguousReview(paths, destPath.trim());
      return;
    }
    if (!res.succeeded.length) return;
    const removed = new Set(res.succeeded.map(normalizeForKey));
    setGroups((prev) =>
      sortGroupsByWaste(applyProtectedLocations(
        pruneGroups(prev, removed, criteriaRef.current, repriRef.current, contentVerifiedRef.current),
        protectedPaths,
        criteriaRef.current,
        repriRef.current,
        contentVerifiedRef.current,
      )),
    );
    setSelected((prev) => new Set([...prev].filter((path) => !res.succeeded.includes(path))));
    invalidateAffected(res.succeeded, destPath.trim());
  }, [safeSelectedPaths, selectedActionItems, destPath, invalidateAffected, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const copySelected = useCallback(async () => {
    const paths = safeSelectedPaths;
    if (!paths.length || !destPath.trim()) {
      toast.warn("Select files and set a destination folder.");
      return;
    }
    if (!beginAction()) return;
    let res: Awaited<ReturnType<typeof dupeAction>>;
    try {
      res = await dupeAction("copy", paths, {
        dest: destPath.trim(),
        protectedPaths,
        items: selectedActionItems,
        reviewToken: reviewToken ?? undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      endAction();
    }
    if (res.errors.length) toast.error(`Some files could not be copied:\n${res.errors.join("\n")}`);
    if (res.requiresRescan) {
      retireAmbiguousReview(paths, destPath.trim());
      return;
    }
    if (res.succeeded.length) invalidateAffected([], destPath.trim());
  }, [safeSelectedPaths, selectedActionItems, destPath, invalidateAffected, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const linkSelected = useCallback(async (mode: "hardlink" | "symlink") => {
    const paths = safeSelectedPaths;
    if (!paths.length) return;
    // Map each checked duplicate to the reference (kept original) of its group.
    const refByDup = new Map<string, string>();
    for (const g of groups) {
      const ref = g.files.find((f) => f.ref) ?? g.files[0];
      if (!ref) continue;
      for (const f of g.files) {
        if (!f.ref && !f.protected && (f.match?.content ?? 0) >= 100 && selected.has(f.path)) {
          refByDup.set(f.path, ref.path);
        }
      }
    }
    const pairs = paths
      .filter((p) => refByDup.has(p))
      .map((p) => ({ original: refByDup.get(p)!, link: p }));
    if (pairs.length !== paths.length) {
      toast.warn("Link replacement is available only for content-hash matches. Review or clear the unverified selection first.");
      return;
    }
    const proceed = await confirmDialog({
      title: mode === "symlink" ? "Replace with symlinks" : "Replace with hard links",
      message:
        `Replace ${pairs.length} duplicate file${pairs.length > 1 ? "s" : ""} with a ` +
        `${mode === "symlink" ? "symbolic" : "hard"} link to the kept original?\n\n` +
        `This modifies files: each duplicate is sent to the Recycle Bin and replaced by a link, ` +
        `reclaiming its space while keeping the file accessible.` +
        (mode === "symlink" ? "\n\nSymlinks may require Developer Mode or elevation on Windows." : ""),
      confirmLabel: mode === "symlink" ? "Create symlinks" : "Create hard links",
      danger: true,
    });
    if (!proceed) return;
    if (!beginAction()) return;
    let res: Awaited<ReturnType<typeof hardlinkPairs>>;
    try {
      res = await hardlinkPairs(pairs, mode, protectedPaths, reviewToken ?? undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      endAction();
    }
    if (res.errors.length) toast.error(`Some links could not be created:\n${res.errors.join("\n")}`);
    if (res.requiresRescan) {
      retireAmbiguousReview(paths);
      return;
    }
    if (res.succeeded.length > 0) {
      // Linked duplicates no longer count as reclaimable — drop them from groups.
      const removed = new Set(res.succeeded.map(normalizeForKey));
      setGroups((prev) =>
        sortGroupsByWaste(applyProtectedLocations(
          pruneGroups(prev, removed, criteriaRef.current, repriRef.current, contentVerifiedRef.current),
          protectedPaths,
          criteriaRef.current,
          repriRef.current,
          contentVerifiedRef.current,
        )),
      );
      setSelected((prev) => new Set([...prev].filter((path) => !res.succeeded.includes(path))));
      invalidateAffected(res.succeeded);
      if (res.ok) toast.success(`Replaced ${pairs.length} duplicate${pairs.length > 1 ? "s" : ""} with link${pairs.length > 1 ? "s" : ""}.`);
    }
  }, [safeSelectedPaths, selected, groups, invalidateAffected, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const exportCsv = useCallback(() => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = ["Role,Protected,Verification,Name,Folder,Size,Last Modified,Match %"];
    for (const g of groups) {
      for (const f of g.files) {
        lines.push(
          [
            f.ref ? "Keeper" : "Copy",
            f.protected ? "Yes" : "No",
            (f.match?.content ?? 0) >= 100 ? "Full content hash match" : "Possible match",
            esc(f.name),
            esc(f.path.replace(/[/\\][^/\\]*$/, "")),
            String(f.size),
            f.modified > 0 ? new Date(f.modified * 1000).toISOString() : "",
            String(f.ref ? 100 : f.score ?? g.score),
          ].join(","),
        );
      }
    }
    downloadReport("filetree-duplicates.csv", "text/csv;charset=utf-8", lines.join("\n"));
  }, [groups]);

  const exportJson = useCallback(() => {
    downloadReport(
      "filetree-duplicates.json",
      "application/json",
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        criteria,
        filters: {
          minSizeBytes: Math.max(0, minSizeKb) * 1024,
          maxSizeBytes: maxSizeKb.trim() ? Math.max(0, Number(maxSizeKb)) * 1024 : null,
          extensions: extensions.split(",").map((value) => value.trim()).filter(Boolean),
          includeHidden,
        },
        protectedPaths,
        summary: {
          groups: groups.length,
          files: groups.reduce((sum, group) => sum + group.files.length, 0),
          reclaimableBytes: groups.reduce((sum, group) => sum + group.waste, 0),
        },
        groups,
      }, null, 2),
    );
  }, [criteria, extensions, groups, includeHidden, maxSizeKb, minSizeKb, protectedPaths]);

  const totalWaste = useMemo(() => groups.reduce((s, g) => s + g.waste, 0), [groups]);
  const totalFiles = useMemo(() => groups.reduce((s, g) => s + g.files.length, 0), [groups]);
  const selectedCount = safeSelectedPaths.length;
  const selectedBytes = useMemo(() => {
    const wanted = new Set(safeSelectedPaths);
    return groups.reduce(
      (sum, group) => sum + group.files
        .filter((file) => wanted.has(file.path))
        .reduce((subtotal, file) => subtotal + file.size, 0),
      0,
    );
  }, [groups, safeSelectedPaths]);
  const selectedGroups = useMemo(() => {
    const wanted = new Set(safeSelectedPaths);
    return groups.filter((group) => group.files.some((file) => wanted.has(file.path))).length;
  }, [groups, safeSelectedPaths]);
  const ignoredCount = ignoredSignatures.length;
  const canScan = selectedPaths.length > 0;

  return {
    selectedPaths, customPaths, protectedPaths,
    togglePath, addCustomPath, removeCustomPath, toggleProtectedPath,
    criteria, setCriterion, setNameFuzzy, setNameThreshold, setDateToleranceSec,
    minSizeKb, setMinSizeKb, maxSizeKb, setMaxSizeKb, extensions, setExtensions,
    includeHidden, setIncludeHidden,
    destPath, setDestPath, deleteMode, setDeleteMode, repriCriterion, setRepriCriterion,
    scanState, phase, progress, startScan, stopScan,
    groups, errors, ignoredCount, ignoredGroups,
    selected, collapsed, toggleFile, toggleGroup, toggleCollapse,
    selectAll, unselectAll, invertSelection, keepFirst, keepStrategy,
    makeRef, ignoreGroup, clearIgnoreList, restoreIgnoredGroups, reprioritizeApply,
    actionPending, deleteSelected, moveSelected, copySelected, linkSelected, exportCsv, exportJson,
    totalWaste, totalFiles, selectedCount, selectedBytes, selectedGroups, canScan,
  };
}
