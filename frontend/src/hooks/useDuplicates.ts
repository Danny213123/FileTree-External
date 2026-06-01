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
  scanStreamUrl,
  type DupeHashFile,
} from "../api/client";
import { readNdjsonStream } from "./useScan";
import { getCached, invalidate, setCached } from "../lib/scanCache";
import {
  bestSourceForTarget,
  buildContentGroups,
  buildKeyedGroups,
  candidatesFromScan,
  dedupeCandidates,
  groupSignature,
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

export interface DuplicatesController {
  // Targets
  selectedPaths: string[];
  customPaths: string[];
  togglePath: (p: string) => void;
  addCustomPath: (p: string) => void;
  removeCustomPath: (p: string) => void;

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

  // Selection
  selected: Set<string>;
  collapsed: Set<string>;
  toggleFile: (path: string) => void;
  toggleGroup: (group: DupeGroupV2) => void;
  toggleCollapse: (key: string) => void;
  selectAll: () => void;
  unselectAll: () => void;
  invertSelection: () => void;
  keepFirst: () => void;

  // Group actions
  makeRef: (group: DupeGroupV2, refPath: string) => void;
  ignoreGroup: (group: DupeGroupV2) => void;
  clearIgnoreList: () => void;
  reprioritizeApply: () => void;

  // File actions
  deleteSelected: () => Promise<void>;
  moveSelected: () => Promise<void>;
  copySelected: () => Promise<void>;
  exportCsv: () => void;

  // Derived stats
  totalWaste: number;
  totalFiles: number;
  selectedCount: number;
  canScan: boolean;
}

export function useDuplicatesController(args: UseDuplicatesArgs): DuplicatesController {
  const { getScanResults, threads, defaultIncludeHidden } = args;

  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [customPaths, setCustomPaths] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<DupeCriteria>(defaultCriteria);
  const [minSizeKb, setMinSizeKb] = useState(1);
  const [maxSizeKb, setMaxSizeKb] = useState("");
  const [extensions, setExtensions] = useState("");
  const [includeHidden, setIncludeHidden] = useState(defaultIncludeHidden);
  const [destPath, setDestPath] = useState("");
  const [deleteMode, setDeleteMode] = useState<"recycle" | "permanent">("recycle");
  const [repriCriterion, setRepriCriterion] = useState<ReprioritizeCriterion>("largest");

  const [scanState, setScanState] = useState<DupeScanState>("idle");
  const [phase, setPhase] = useState<DupePhase>("idle");
  const [progress, setProgress] = useState<DupeProgress>({ scanned: 0, hashing: 0, hashed: 0 });
  const [groups, setGroups] = useState<DupeGroupV2[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [ignoredCount, setIgnoredCount] = useState(0);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const abortRef = useRef<AbortController | null>(null);
  // Session ignore list: group signatures the user hid this session.
  const ignoredRef = useRef<Set<string>>(new Set());
  // Live criteria mirror so post-action prune uses the current settings.
  const criteriaRef = useRef(criteria);
  useEffect(() => { criteriaRef.current = criteria; }, [criteria]);
  const repriRef = useRef(repriCriterion);
  useEffect(() => { repriRef.current = repriCriterion; }, [repriCriterion]);

  // Poll the server hash progress while hashing so the UI shows real counts.
  useEffect(() => {
    if (phase !== "hashing") return;
    const id = setInterval(async () => {
      const p = await fetchDupesProgress();
      setProgress((prev) => ({ scanned: prev.scanned, hashing: p.filesHashing, hashed: p.filesHashed }));
    }, 400);
    return () => clearInterval(id);
  }, [phase]);

  const togglePath = useCallback((p: string) => {
    setSelectedPaths((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }, []);
  const addCustomPath = useCallback((p: string) => {
    const v = p.trim();
    if (!v) return;
    setCustomPaths((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setSelectedPaths((prev) => (prev.includes(v) ? prev : [...prev, v]));
  }, []);
  const removeCustomPath = useCallback((p: string) => {
    setCustomPaths((prev) => prev.filter((x) => x !== p));
    setSelectedPaths((prev) => prev.filter((x) => x !== p));
  }, []);

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
    const targets = selectedPaths.filter(Boolean);
    if (targets.length === 0) {
      setScanState("error");
      setErrors(["Select one or more drives or folders to scan."]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;

    setScanState("scanning");
    setPhase("aggregating");
    setProgress({ scanned: 0, hashing: 0, hashed: 0 });
    setGroups([]);
    setSelected(new Set());
    setErrors([]);

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

      let candidates: CandidateMeta[] = [];
      for (const target of targets) {
        let src = bestSourceForTarget(target, pool);
        if (!src) {
          try {
            const res = await fetch(scanStreamUrl({ path: target, includeHidden, threads }), { signal });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const result = await readNdjsonStream(res.body.getReader(), (n) =>
              setProgress((prev) => ({ ...prev, scanned: n })),
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

      result = result.filter((g) => !ignoredRef.current.has(groupSignature(g)));
      result = sortGroupsByWaste(result);

      if (signal.aborted) return;
      setGroups(result);
      setErrors(aggErrors);
      setScanState("done");
      setPhase("done");
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setErrors([...aggErrors, e instanceof Error ? e.message : String(e)]);
      setScanState("error");
      setPhase("idle");
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, [selectedPaths, buildFilters, getScanResults, includeHidden, threads, criteria, repriCriterion]);

  const startScan = useCallback(() => { void runScan(); }, [runScan]);

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    void cancelDupesScan();
    setScanState("canceled");
    setPhase("idle");
  }, []);

  // ── Selection ──────────────────────────────────────────────────────────────
  const allDupPaths = useMemo(
    () => groups.flatMap((g) => g.files.filter((f) => !f.ref).map((f) => f.path)),
    [groups],
  );

  const toggleFile = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const toggleGroup = useCallback((group: DupeGroupV2) => {
    const eligible = group.files.filter((f) => !f.ref).map((f) => f.path);
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
  const selectAll = useCallback(() => setSelected(new Set(allDupPaths)), [allDupPaths]);
  const unselectAll = useCallback(() => setSelected(new Set()), []);
  const invertSelection = useCallback(
    () => setSelected((prev) => new Set(allDupPaths.filter((p) => !prev.has(p)))),
    [allDupPaths],
  );
  const keepFirst = useCallback(() => setSelected(new Set(allDupPaths)), [allDupPaths]);

  // ── Group actions ───────────────────────────────────────────────────────────
  // Groups are matched by their member-set signature (not object identity): the
  // results view passes sorted/spread copies, so identity comparison would miss.
  const makeRef = useCallback((group: DupeGroupV2, refPath: string) => {
    const sig = groupSignature(group);
    setGroups((prev) =>
      prev.map((g) =>
        groupSignature(g) === sig
          ? rebuildWithReference(g, refPath, criteriaRef.current, criteriaRef.current.content.enabled)
          : g,
      ),
    );
  }, []);

  const ignoreGroup = useCallback((group: DupeGroupV2) => {
    const sig = groupSignature(group);
    ignoredRef.current.add(sig);
    if (group.files.length >= 2) {
      void dupeIgnorePair(group.files[0].path, group.files[1].path).then((r) => {
        if (r.count) setIgnoredCount(r.count);
      });
    }
    setIgnoredCount((c) => c + 1);
    setGroups((prev) => prev.filter((g) => groupSignature(g) !== sig));
  }, []);

  const clearIgnoreList = useCallback(() => {
    ignoredRef.current.clear();
    setIgnoredCount(0);
    void dupeClearIgnoreList();
  }, []);

  const reprioritizeApply = useCallback(() => {
    setGroups((prev) =>
      sortGroupsByWaste(
        pruneGroups(prev, new Set(), criteriaRef.current, repriRef.current, criteriaRef.current.content.enabled),
      ),
    );
  }, []);

  // ── File actions ─────────────────────────────────────────────────────────────
  const invalidateAffected = useCallback((paths: string[], dest?: string) => {
    const seen = new Set<string>();
    for (const p of paths) {
      const parent = p.replace(/[/\\][^/\\]*$/, "");
      if (parent && !seen.has(parent)) { seen.add(parent); invalidate(parent); }
    }
    if (dest) invalidate(dest);
  }, []);

  const deleteSelected = useCallback(async () => {
    const paths = [...selected];
    if (!paths.length) return;
    const verb = deleteMode === "permanent" ? "permanently delete" : "send to Recycle Bin";
    if (!window.confirm(`${verb} ${paths.length} file${paths.length > 1 ? "s" : ""}?`)) return;
    const res = await dupeAction("delete", paths, { permanent: deleteMode === "permanent" });
    if (res.errors.length) window.alert(`Some files could not be deleted:\n${res.errors.join("\n")}`);
    const removed = new Set(paths.map(normalizeForKey));
    setGroups((prev) =>
      sortGroupsByWaste(pruneGroups(prev, removed, criteriaRef.current, repriRef.current, criteriaRef.current.content.enabled)),
    );
    setSelected(new Set());
    invalidateAffected(paths);
  }, [selected, deleteMode, invalidateAffected]);

  const moveSelected = useCallback(async () => {
    const paths = [...selected];
    if (!paths.length || !destPath.trim()) {
      window.alert("Select files and set a destination folder.");
      return;
    }
    const res = await dupeAction("move", paths, { dest: destPath.trim() });
    if (res.errors.length) window.alert(`Some files could not be moved:\n${res.errors.join("\n")}`);
    const removed = new Set(paths.map(normalizeForKey));
    setGroups((prev) =>
      sortGroupsByWaste(pruneGroups(prev, removed, criteriaRef.current, repriRef.current, criteriaRef.current.content.enabled)),
    );
    setSelected(new Set());
    invalidateAffected(paths, destPath.trim());
  }, [selected, destPath, invalidateAffected]);

  const copySelected = useCallback(async () => {
    const paths = [...selected];
    if (!paths.length || !destPath.trim()) {
      window.alert("Select files and set a destination folder.");
      return;
    }
    const res = await dupeAction("copy", paths, { dest: destPath.trim() });
    if (res.errors.length) window.alert(`Some files could not be copied:\n${res.errors.join("\n")}`);
    invalidateAffected([], destPath.trim());
  }, [selected, destPath, invalidateAffected]);

  const exportCsv = useCallback(() => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = ["Role,Name,Folder,Size,Last Modified,Match %"];
    for (const g of groups) {
      for (const f of g.files) {
        lines.push(
          [
            f.ref ? "Reference" : "Duplicate",
            esc(f.name),
            esc(f.path.replace(/[/\\][^/\\]*$/, "")),
            String(f.size),
            f.modified > 0 ? new Date(f.modified * 1000).toISOString() : "",
            String(f.ref ? 100 : f.score ?? g.score),
          ].join(","),
        );
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "duplicates.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }, [groups]);

  const totalWaste = useMemo(() => groups.reduce((s, g) => s + g.waste, 0), [groups]);
  const totalFiles = useMemo(() => groups.reduce((s, g) => s + g.files.length, 0), [groups]);
  const selectedCount = selected.size;
  const canScan = selectedPaths.length > 0;

  return {
    selectedPaths, customPaths, togglePath, addCustomPath, removeCustomPath,
    criteria, setCriterion, setNameFuzzy, setNameThreshold, setDateToleranceSec,
    minSizeKb, setMinSizeKb, maxSizeKb, setMaxSizeKb, extensions, setExtensions,
    includeHidden, setIncludeHidden,
    destPath, setDestPath, deleteMode, setDeleteMode, repriCriterion, setRepriCriterion,
    scanState, phase, progress, startScan, stopScan,
    groups, errors, ignoredCount,
    selected, collapsed, toggleFile, toggleGroup, toggleCollapse,
    selectAll, unselectAll, invertSelection, keepFirst,
    makeRef, ignoreGroup, clearIgnoreList, reprioritizeApply,
    deleteSelected, moveSelected, copySelected, exportCsv,
    totalWaste, totalFiles, selectedCount, canScan,
  };
}
