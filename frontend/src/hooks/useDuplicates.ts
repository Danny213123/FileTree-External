import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DupeCriteria,
  DupeCriterionKey,
  DupeGroupV2,
  DupeScopeRule,
  DupeScopeState,
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
import { toast } from "../lib/toast";
import {
  actionableDuplicatePaths,
  annotateProtectedLocations,
  applyProtectedLocations,
  bestSourceForTarget,
  buildContentGroups,
  buildGroup,
  buildKeyedGroups,
  candidatesFromScan,
  dedupeCandidates,
  groupSignature,
  isUnder,
  minimalScanTargets,
  normalizeForKey,
  passesFilters,
  pruneGroups,
  rebuildWithReference,
  scopeStateForPath,
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

/** Options collected by the unified deletion dialog. */
export interface DuplicateDeletionRequest {
  permanent: boolean;
  replaceWithLink?: "hardlink" | "symlink";
}

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
  fraction?: number | null;
  startedAt?: number;
  finishedAt?: number;
  bytesRead?: number;
  scanned: number;
  hashing: number;
  hashed: number;
  stage?: string;
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
  removedPaths: string[];
  protectedPaths: string[];
  excludedPaths: string[];
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

function scopePolicyKey(rules: DupeScopeRule[]): string {
  return rules
    .map((rule) => `${normalizeForKey(rule.path)}=${rule.state}`)
    .sort()
    .join("|");
}

function hasPath(paths: string[], path: string): boolean {
  const key = normalizeForKey(path);
  return paths.some((item) => normalizeForKey(item) === key);
}

function addPath(paths: string[], path: string): string[] {
  return hasPath(paths, path) ? paths : [...paths, path];
}

function dropPath(paths: string[], path: string): string[] {
  const key = normalizeForKey(path);
  return paths.filter((item) => normalizeForKey(item) !== key);
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
  removedPaths: string[];
  protectedPaths: string[];
  excludedPaths: string[];
  scopeRules: DupeScopeRule[];
  pathState: (p: string) => DupeScopeState;
  setPathState: (p: string, state: DupeScopeState) => void;
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
  deleteSelected: (permanentOverride?: boolean) => Promise<void>;
  moveSelected: (dest?: string) => Promise<void>;
  copySelected: (dest?: string) => Promise<void>;
  removeSelectedFromResults: () => void;
  /** #26: replace the checked duplicates with hard/symlinks to their reference. */
  linkSelected: (mode: "hardlink" | "symlink", permanent?: boolean) => Promise<void>;
  /** Recycle/permanent delete, optionally replacing each path with a link. */
  executeDeletion: (request: DuplicateDeletionRequest) => Promise<void>;
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
  const [initialPreferences] = useState(loadDuplicatePreferences);

  const [selectedPaths, setSelectedPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.selectedPaths) ? initialPreferences.selectedPaths : [],
  );
  const [customPaths, setCustomPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.customPaths) ? initialPreferences.customPaths : [],
  );
  const [removedPaths, setRemovedPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.removedPaths) ? initialPreferences.removedPaths : [],
  );
  const [protectedPaths, setProtectedPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.protectedPaths) ? initialPreferences.protectedPaths : [],
  );
  const [excludedPaths, setExcludedPaths] = useState<string[]>(() =>
    Array.isArray(initialPreferences.excludedPaths) ? initialPreferences.excludedPaths : [],
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
  const excludedPathsRef = useRef(excludedPaths);
  useEffect(() => { excludedPathsRef.current = excludedPaths; }, [excludedPaths]);
  const normalPaths = useMemo(() => {
    const references = new Set(protectedPaths.map(normalizeForKey));
    return selectedPaths.filter((path) => !references.has(normalizeForKey(path)));
  }, [protectedPaths, selectedPaths]);
  const scopeRules = useMemo<DupeScopeRule[]>(() => [
    ...normalPaths.map((path) => ({ path, state: "normal" as const })),
    ...protectedPaths.map((path) => ({ path, state: "reference" as const })),
    ...excludedPaths.map((path) => ({ path, state: "excluded" as const })),
  ], [excludedPaths, normalPaths, protectedPaths]);
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
      removedPaths,
      protectedPaths,
      excludedPaths,
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
    removedPaths,
    deleteMode,
    destPath,
    extensions,
    excludedPaths,
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
      setProgress((prev) => ({
        scanned: prev.scanned,
        hashing: p.filesHashing,
        hashed: p.filesHashed,
        stage: "hashing",
      }));
    }, 400);
    return () => clearInterval(id);
  }, [phase]);

  const pathState = useCallback((p: string): DupeScopeState => {
    if (hasPath(protectedPaths, p)) return "reference";
    if (hasPath(selectedPaths, p)) return "normal";
    return "excluded";
  }, [protectedPaths, selectedPaths]);

  const setPathState = useCallback((p: string, state: DupeScopeState) => {
    if (actionPendingRef.current) {
      toast.warn("Wait for the current file action to finish.");
      return;
    }
    if (scanState === "scanning") {
      toast.warn("Stop the scan before changing folder states.");
      return;
    }
    const path = p.trim();
    if (!path) return;
    if (state === "excluded") {
      setSelectedPaths((prev) => dropPath(prev, path));
      setProtectedPaths((prev) => dropPath(prev, path));
      setExcludedPaths((prev) => addPath(prev, path));
      return;
    }
    setSelectedPaths((prev) => addPath(prev, path));
    setExcludedPaths((prev) => dropPath(prev, path));
    setProtectedPaths((prev) =>
      state === "reference" ? addPath(prev, path) : dropPath(prev, path),
    );
  }, [scanState]);

  const togglePath = useCallback((p: string) => {
    setPathState(p, pathState(p) === "excluded" ? "normal" : "excluded");
  }, [pathState, setPathState]);

  const addCustomPath = useCallback((p: string) => {
    if (actionPendingRef.current) return;
    const v = p.trim();
    if (!v) return;
    setRemovedPaths((prev) => prev.filter((item) => !isUnder(v, item)));
    setCustomPaths((prev) => addPath(prev, v));
    setSelectedPaths((prev) => addPath(prev, v));
    setProtectedPaths((prev) => dropPath(prev, v));
    setExcludedPaths((prev) => dropPath(prev, v));
  }, []);
  const removeCustomPath = useCallback((p: string) => {
    if (actionPendingRef.current || scanState === "scanning") return;
    const outside = (item: string) => !isUnder(item, p);
    setRemovedPaths((prev) => addPath(prev.filter(outside), p));
    setCustomPaths((prev) => prev.filter(outside));
    setSelectedPaths((prev) => prev.filter(outside));
    setProtectedPaths((prev) => prev.filter(outside));
    // An exclusion prevents a removed child from inheriting an included parent.
    setExcludedPaths((prev) => addPath(prev.filter(outside), p));
  }, [scanState]);
  const toggleProtectedPath = useCallback((p: string) => {
    setPathState(p, pathState(p) === "reference" ? "normal" : "reference");
  }, [pathState, setPathState]);

  const setCriterion = useCallback<DuplicatesController["setCriterion"]>((key, patch) => {
    setCriteria((prev) => ({ ...prev, [key]: { ...prev[key], ...patch, ...(patch.enabled === false ? { required: false } : {}) } }));
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
    if (actionPendingRef.current || abortRef.current) return;
    const targets = minimalScanTargets(selectedPaths);
    if (targets.length === 0) {
      setScanState("error");
      setErrors(["Select one or more drives or folders to scan."]);
      return;
    }
    const scanScopeRules = scopeRules.filter((rule) =>
      targets.some((target) => isUnder(rule.path, target) || isUnder(target, rule.path)),
    );
    const scanProtectedPaths = scanScopeRules
      .filter((rule) => rule.state === "reference")
      .map((rule) => rule.path);
    const scanNormalPaths = scanScopeRules
      .filter((rule) => rule.state === "normal")
      .map((rule) => rule.path);
    const scanExcludedPaths = excludedPathsRef.current.filter((path) =>
      targets.some((target) => isUnder(path, target) || isUnder(target, path)),
    );
    const scanProtectionKey = scopePolicyKey(scanScopeRules);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;

    setScanState("scanning");
    setPhase("aggregating");
    setProgress({ scanned: 0, hashing: 0, hashed: 0, startedAt: Date.now() });
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
        const sources: { scanId: string; targetPath: string }[] = [];
        for (const target of targets) {
          let source: ScanResult | undefined;
          signal.throwIfAborted();
          if (!source) {
            try {
              source = await runV2Scan(
                { path: target, includeHidden, threads, nocache: true },
                (event) => { if (!signal.aborted) setProgress((prev) => ({ ...prev, scanned: event.nodeCount })); },
                signal,
              );
              signal.throwIfAborted();
              pool.push(source);
            } catch (error) {
              if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
              aggErrors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
              continue;
            }
          }
          if (source.scanId) sources.push({ scanId: source.scanId, targetPath: target });
        }
        signal.throwIfAborted();
        if (sources.length === 0) {
          throw new Error(aggErrors[0] || "No duplicate scan targets could be indexed.");
        }

        setPhase(criteria.content.enabled ? "hashing" : "grouping");
        const requiredMetadata = [criteria.name, criteria.size, criteria.date].some((item) => item.enabled && item.required);
        const metadataKey = (item: { enabled: boolean; required: boolean }) => item.enabled && (!requiredMetadata || item.required);
        const duplicateResult = await runV2DuplicateScan(
          {
            sources,
            metadataOnly: !criteria.content.enabled,
            metadataName: metadataKey(criteria.name),
            metadataSize: metadataKey(criteria.size),
            metadataDate: metadataKey(criteria.date),
            dateToleranceSec: criteria.dateToleranceSec,
            minSize: filters.minSize,
            maxSize: filters.maxSize ?? null,
            extensions: filters.extensions,
            excludedPaths: scanExcludedPaths,
            includeHidden: filters.includeHidden,
            threads,
          },
          // Failed/offline roots are not sources. Their policy must not make
          // native canonicalization abort scans of the remaining valid roots.
          scanScopeRules.filter((rule) => sources.some((source) =>
            isUnder(rule.path, source.targetPath) || isUnder(source.targetPath, rule.path))),
          (event) => {
            if (event.phase === "done" || signal.aborted) return;
            setPhase(event.phase === "indexing" ? "aggregating" : ["grouping", "reviewing", "finalizing"].includes(event.phase) ? "grouping" : "hashing");
            setProgress((prev) => ({
              ...prev,
              fraction: event.fraction,
              scanned: event.scanned,
              hashing: event.hashing,
              hashed: event.hashed,
              stage: event.phase,
              bytesRead: event.bytesRead,
            }));
          },
          signal,
        );
        signal.throwIfAborted();
        if (duplicateResult.cancelled) throw new DOMException("Scan cancelled", "AbortError");
        aggErrors.push(...duplicateResult.errors.slice(0, 50));

        setPhase("grouping");
        const nativeGroups = duplicateResult.groups;
        let result: DupeGroupV2[] = [];
        const ignoredResults: DupeGroupV2[] = [];
        setProgress((prev) => ({ ...prev, stage: "finalizing", fraction: 0, hashed: 0, hashing: nativeGroups.length }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        let lastYield = performance.now();
        for (let index = 0; index < nativeGroups.length; index++) {
          if (signal.aborted) return;
          const candidates: CandidateMeta[] = nativeGroups[index].files.map((file) => {
            const slash = Math.max(file.path.lastIndexOf("\\"), file.path.lastIndexOf("/"));
            const dot = file.name.lastIndexOf(".");
            return {
              path: file.path, name: file.name,
              folder: slash >= 0 ? file.path.slice(0, slash) : file.path,
              size: file.size, modifiedMs: file.modified * 1000, mtimeSec: file.modified,
              ext: dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "", hidden: false,
            };
          });
          // The native engine has already grouped these members.
          const built = buildGroup(candidates, criteria, repriCriterion, criteria.content.enabled);
          if (built) {
            if (ignoredRef.current.size > 0 && ignoredRef.current.has(groupSignature(built))) {
              ignoredResults.push(built);
            } else {
              result.push(applyProtectedLocations([built], scanProtectedPaths, criteria,
                repriCriterion, criteria.content.enabled, scanNormalPaths)[0]);
            }
          }
          if (performance.now() - lastYield >= 16 || index + 1 === nativeGroups.length) {
            setProgress((prev) => ({ ...prev, fraction: (index + 1) / nativeGroups.length, hashed: index + 1 }));
            await new Promise((resolve) => setTimeout(resolve, 0));
            lastYield = performance.now();
          }
        }
        setIgnoredGroups(ignoredResults);
        result = sortGroupsByWaste(result);
        setGroups(result);
        setErrors(aggErrors);
        contentVerifiedRef.current = criteria.content.enabled;
        setReviewToken(duplicateResult.reviewToken || null);
        setActiveProtectionKey(scanProtectionKey);
        setProgress((prev) => ({ ...prev, finishedAt: Date.now() }));
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

      candidates = dedupeCandidates(candidates)
        .filter((candidate) => passesFilters(candidate, filters))
        .filter((candidate) => scopeStateForPath(candidate.path, scanScopeRules) !== "excluded");
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
        scanProtectedPaths,
        criteria,
        repriCriterion,
        criteria.content.enabled,
        scanNormalPaths,
      );
      result = sortGroupsByWaste(result);

      if (signal.aborted) return;
      setGroups(result);
      setErrors(aggErrors);
      contentVerifiedRef.current = criteria.content.enabled;
      setActiveProtectionKey(scanProtectionKey);
      setProgress((prev) => ({ ...prev, finishedAt: Date.now() }));
      setScanState("done");
      setPhase("done");
    } catch (e) {
      // A stopped run may settle after a replacement run has already started.
      if (abortRef.current !== ctrl) return;
      if (signal.aborted || ((e instanceof Error || e instanceof DOMException) && e.name === "AbortError")) {
        setScanState("canceled");
        setPhase("idle");
        setProgress((prev) => ({ ...prev, finishedAt: Date.now() }));
        return;
      }
      setErrors([...aggErrors, e instanceof Error ? e.message : String(e)]);
      setReviewToken(null);
      setActiveProtectionKey(null);
      setScanState("error");
      setPhase("idle");
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, [selectedPaths, buildFilters, getScanResults, includeHidden, threads, criteria, repriCriterion, scopeRules]);

  const startScan = useCallback(() => { void runScan(); }, [runScan]);

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (isTauriV2()) void cancelV2DuplicateScan();
    else void cancelDupesScan();
    setReviewToken(null);
    setActiveProtectionKey(null);
    contentVerifiedRef.current = false;
    setProgress((prev) => ({ ...prev, finishedAt: Date.now() }));
    setScanState("canceled");
    setPhase("idle");
  }, []);

  // Folder state is part of the native review capability. Changing any rule
  // retires the old result so UI markings and backend authorization cannot diverge.
  useEffect(() => {
    const currentRules = scopeRules.filter((rule) =>
      selectedPaths.some((target) => isUnder(rule.path, target) || isUnder(target, rule.path)),
    );
    if (activeProtectionKey === null || activeProtectionKey === scopePolicyKey(currentRules)) return;
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
    toast.info("Folder states changed. Run a new scan to apply the policy.");
  }, [activeProtectionKey, scopeRules, selectedPaths]);

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
  const selectionIndex = useMemo(() => {
    const index = new Map<string, { keeper: string; size: number; group: DupeGroupV2 }>();
    for (const group of groups) {
      const keeper = group.files.find((file) => file.ref);
      if (!keeper) continue;
      for (const file of group.files) {
        if (!file.ref && !file.protected) index.set(file.path, { keeper: keeper.path, size: file.size, group });
      }
    }
    return index;
  }, [groups]);
  const safeSelectedPaths = useMemo(
    () => [...selected].filter((path) => selectionIndex.has(path)),
    [selectionIndex, selected],
  );
  const selectedActionItems = useMemo(() => safeSelectedPaths.map((path) => ({
    path, keeper: selectionIndex.get(path)!.keeper,
  })), [selectionIndex, safeSelectedPaths]);

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
      normalPaths,
    );
    const sel = new Set<string>();
    for (const g of rebuilt) {
      for (const f of g.files) {
        if (!f.ref && !f.protected) sel.add(f.path);
      }
    }
    setGroups(sortGroupsByWaste(rebuilt));
    setSelected(sel);
  }, [groups, normalPaths, protectedPaths]);
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
      return annotateProtectedLocations([rebuilt], protectedPaths, normalPaths)[0];
    })));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(refPath);
      return next;
    });
  }, [normalPaths, protectedPaths]);

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
          normalPaths,
        ),
      );
    });
    setIgnoredGroups([]);
    void dupeClearIgnoreList().catch(() => undefined);
    if (requiresRescan) {
      toast.info("Persistent hidden matches were restored. Run the scan again to show them.");
    }
  }, [ignoredGroups, ignoredSignatures, normalPaths, protectedPaths]);
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
          normalPaths,
        ),
      ),
    );
  }, [normalPaths, protectedPaths]);

  // ── File actions ─────────────────────────────────────────────────────────────
  const invalidateAffected = useCallback((paths: string[], dest?: string) => {
    const seen = new Set<string>();
    for (const p of paths) {
      const parent = p.replace(/[/\\][^/\\]*$/, "");
      if (parent && !seen.has(parent)) { seen.add(parent); invalidate(parent); }
    }
    if (dest) invalidate(dest);
  }, []);
  const retireAmbiguousReview = useCallback((paths: string[], dest?: string, confirmed: string[] = []) => {
    if (confirmed.length) {
      const removed = new Set(confirmed.map(normalizeForKey));
      const verified = contentVerifiedRef.current;
      setGroups((prev) => pruneGroups(prev, removed, criteriaRef.current, repriRef.current, verified));
      setSelected((prev) => new Set([...prev].filter((path) => !removed.has(normalizeForKey(path)))));
    }
    invalidateAffected(paths, dest);
    if (isTauriV2()) void cancelV2DuplicateScan();
    setReviewToken(null);
    setActiveProtectionKey(null);
    contentVerifiedRef.current = false;
    setScanState("done");
    setPhase("done");
    toast.warn("Some file outcomes could not be confirmed. Run a new scan before continuing.");
  }, [invalidateAffected]);

  const deleteSelected = useCallback(async (permanentOverride?: boolean) => {
    const paths = safeSelectedPaths;
    if (!paths.length) return;
    const permanent = permanentOverride ?? deleteMode === "permanent";
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
    const retired = [...res.succeeded, ...(res.missing ?? [])];
    if (res.missing?.length) toast.info(`${res.missing.length} already-missing files removed from the report.`);
    if (res.requiresRescan) {
      retireAmbiguousReview(paths, undefined, retired);
      return;
    }
    if (!retired.length) return;
    const removed = new Set(retired.map(normalizeForKey));
    setGroups((prev) =>
      sortGroupsByWaste(applyProtectedLocations(
        pruneGroups(prev, removed, criteriaRef.current, repriRef.current, contentVerifiedRef.current),
        protectedPaths,
        criteriaRef.current,
        repriRef.current,
        contentVerifiedRef.current,
        normalPaths,
      )),
    );
    setSelected((prev) => new Set([...prev].filter((path) => !removed.has(normalizeForKey(path)))));
    invalidateAffected(retired);
  }, [safeSelectedPaths, selectedActionItems, deleteMode, groups, invalidateAffected, normalPaths, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const moveSelected = useCallback(async (destOverride?: string) => {
    const paths = safeSelectedPaths;
    const dest = (destOverride ?? destPath).trim();
    if (!paths.length || !dest) {
      toast.warn("Select files and set a destination folder.");
      return;
    }
    if (!beginAction()) return;
    let res: Awaited<ReturnType<typeof dupeAction>>;
    try {
      res = await dupeAction("move", paths, {
        dest,
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
      retireAmbiguousReview(paths, dest, res.succeeded);
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
        normalPaths,
      )),
    );
    setSelected((prev) => new Set([...prev].filter((path) => !res.succeeded.includes(path))));
    invalidateAffected(res.succeeded, dest);
  }, [safeSelectedPaths, selectedActionItems, destPath, invalidateAffected, normalPaths, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const copySelected = useCallback(async (destOverride?: string) => {
    const paths = safeSelectedPaths;
    const dest = (destOverride ?? destPath).trim();
    if (!paths.length || !dest) {
      toast.warn("Select files and set a destination folder.");
      return;
    }
    if (!beginAction()) return;
    let res: Awaited<ReturnType<typeof dupeAction>>;
    try {
      res = await dupeAction("copy", paths, {
        dest,
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
      retireAmbiguousReview(paths, dest);
      return;
    }
    if (res.succeeded.length) invalidateAffected([], dest);
  }, [safeSelectedPaths, selectedActionItems, destPath, invalidateAffected, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const removeSelectedFromResults = useCallback(() => {
    if (actionPendingRef.current || safeSelectedPaths.length === 0) return;
    const removed = new Set(safeSelectedPaths.map(normalizeForKey));
    setGroups((prev) =>
      sortGroupsByWaste(applyProtectedLocations(
        pruneGroups(prev, removed, criteriaRef.current, repriRef.current, contentVerifiedRef.current),
        protectedPaths,
        criteriaRef.current,
        repriRef.current,
        contentVerifiedRef.current,
        normalPaths,
      )),
    );
    setSelected(new Set());
  }, [normalPaths, protectedPaths, safeSelectedPaths]);

  const linkSelected = useCallback(async (mode: "hardlink" | "symlink", permanent = false) => {
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
    if (!beginAction()) return;
    let res: Awaited<ReturnType<typeof hardlinkPairs>>;
    try {
      res = await hardlinkPairs(pairs, mode, protectedPaths, reviewToken ?? undefined, permanent);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      endAction();
    }
    if (res.errors.length) toast.error(`Some links could not be created:\n${res.errors.join("\n")}`);
    if (res.requiresRescan) {
      retireAmbiguousReview(paths, undefined, res.succeeded);
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
          normalPaths,
        )),
      );
      setSelected((prev) => new Set([...prev].filter((path) => !res.succeeded.includes(path))));
      invalidateAffected(res.succeeded);
      if (res.ok) toast.success(`Replaced ${pairs.length} duplicate${pairs.length > 1 ? "s" : ""} with link${pairs.length > 1 ? "s" : ""}.`);
    }
  }, [safeSelectedPaths, selected, groups, invalidateAffected, normalPaths, protectedPaths, reviewToken, retireAmbiguousReview, beginAction, endAction]);

  const executeDeletion = useCallback(async (request: DuplicateDeletionRequest) => {
    if (request.replaceWithLink) {
      await linkSelected(request.replaceWithLink, request.permanent);
      return;
    }
    await deleteSelected(request.permanent);
  }, [deleteSelected, linkSelected]);

  const exportCsv = useCallback(() => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = ["Role,Reference Folder,Verification,Name,Folder,Size,Last Modified,Match %"];
    for (const g of groups) {
      for (const f of g.files) {
        lines.push(
          [
            f.ref ? "Reference" : "Duplicate",
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
        folderStates: scopeRules,
        summary: {
          groups: groups.length,
          files: groups.reduce((sum, group) => sum + group.files.length, 0),
          reclaimableBytes: groups.reduce((sum, group) => sum + group.waste, 0),
        },
        groups,
      }, null, 2),
    );
  }, [criteria, extensions, groups, includeHidden, maxSizeKb, minSizeKb, scopeRules]);

  const totalWaste = useMemo(() => groups.reduce((s, g) => s + g.waste, 0), [groups]);
  const totalFiles = useMemo(() => groups.reduce((s, g) => s + g.files.length, 0), [groups]);
  const selectedCount = safeSelectedPaths.length;
  const selectedBytes = useMemo(() => safeSelectedPaths.reduce(
    (sum, path) => sum + selectionIndex.get(path)!.size, 0), [selectionIndex, safeSelectedPaths]);
  const selectedGroups = useMemo(() => new Set(safeSelectedPaths.map(
    (path) => selectionIndex.get(path)!.group)).size, [selectionIndex, safeSelectedPaths]);
  const ignoredCount = ignoredSignatures.length;
  const canScan = selectedPaths.length > 0;

  return {
    selectedPaths, customPaths, removedPaths, protectedPaths, excludedPaths, scopeRules,
    pathState, setPathState, togglePath, addCustomPath, removeCustomPath, toggleProtectedPath,
    criteria, setCriterion, setNameFuzzy, setNameThreshold, setDateToleranceSec,
    minSizeKb, setMinSizeKb, maxSizeKb, setMaxSizeKb, extensions, setExtensions,
    includeHidden, setIncludeHidden,
    destPath, setDestPath, deleteMode, setDeleteMode, repriCriterion, setRepriCriterion,
    scanState, phase, progress, startScan, stopScan,
    groups, errors, ignoredCount, ignoredGroups,
    selected, collapsed, toggleFile, toggleGroup, toggleCollapse,
    selectAll, unselectAll, invertSelection, keepFirst, keepStrategy,
    makeRef, ignoreGroup, clearIgnoreList, restoreIgnoredGroups, reprioritizeApply,
    actionPending, deleteSelected, moveSelected, copySelected, removeSelectedFromResults,
    linkSelected, executeDeletion, exportCsv, exportJson,
    totalWaste, totalFiles, selectedCount, selectedBytes, selectedGroups, canScan,
  };
}
