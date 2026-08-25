import { useState, useCallback, useMemo, useDeferredValue, useRef } from "react";
import type { NodeRecord, SortKey, Metric, Unit } from "../api/types";
import { type FilterRule, type CompiledRule, compileRules, applyCompiledRules } from "./useFilterRules";
import { attributeLetters } from "../lib/attributes";
import { fetchChildren, ScanStaleError } from "../api/client";

// ── Quick-filter chips ───────────────────────────────────────────────────────
// Toolbar toggle chips that each contribute a predicate ANDed onto the active
// filter (text box / advanced rules). They're expressed as ordinary FilterRules
// so they flow through the SAME compile + apply pipeline as everything else —
// no parallel filtering path. Multiple active chips combine with AND.
export type ChipKey = "size100mb" | "size1gb" | "videos" | "images" | "old1y";

const CHIP_VIDEO_EXTS = "mp4,mkv,mov,avi,wmv,flv,webm,m4v,mpg,mpeg,m2ts,ts";
const CHIP_IMAGE_EXTS = "jpg,jpeg,png,webp,bmp,tiff,tif,gif,heic,avif,svg";

// Build the FilterRule set for the currently-active chips. The ">1 year old"
// chip is resolved against "now" each time the chip set changes (good enough —
// a stale-by-minutes cutoff is harmless for a 365-day boundary).
function buildChipRules(chips: Set<ChipKey>): FilterRule[] {
  const rules: FilterRule[] = [];
  const push = (r: Omit<FilterRule, "id" | "join"> & { key: ChipKey }) => {
    const { key, ...rest } = r;
    rules.push({ id: `chip:${key}`, join: "and", ...rest });
  };
  if (chips.has("size100mb")) push({ key: "size100mb", field: "size", operator: "greaterThan", value: "100", sizeUnit: "mb" });
  if (chips.has("size1gb")) push({ key: "size1gb", field: "size", operator: "greaterThan", value: "1", sizeUnit: "gb" });
  // Videos/Images are extension matches; when both are on, union their sets into
  // ONE type rule so the two read as OR (a file is video OR image) rather than an
  // impossible AND (no file is both) that would empty the table.
  const mediaExts: string[] = [];
  if (chips.has("videos")) mediaExts.push(CHIP_VIDEO_EXTS);
  if (chips.has("images")) mediaExts.push(CHIP_IMAGE_EXTS);
  if (mediaExts.length > 0) push({ key: "videos", field: "type", operator: "isOneOf", value: mediaExts.join(",") });
  if (chips.has("old1y")) {
    const cutoff = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    push({ key: "old1y", field: "date", operator: "before", value: cutoff });
  }
  return rules;
}

export interface TreeState {
  expanded: Set<number>;
  expandedAll: boolean;
  selectedId: number;
  sortKey: SortKey;
  sortDir: 1 | -1;
  filter: string;
  filterRules: FilterRule[];
  metric: Metric;
  unit: Unit;
  showFiles: boolean;
  // Per-column pixel widths (columnKey → px). Lives in this per-tab hook so each
  // workspace tab AND each split-view pane keeps its OWN column widths — resizing
  // in one tab/pane never affects another. Distinct from the global Configure
  // Columns visibility/decimals. Columns with no entry fall back to ALL_COLUMNS.
  columnWidths: Partial<Record<SortKey, number>>;
}

export interface UseTreeStateReturn extends TreeState {
  setColumnWidth: (key: SortKey, width: number) => void;
  /** Replace ALL per-tab column widths at once (per-folder restore, #5). */
  setColumnWidthsAll: (widths: Partial<Record<SortKey, number>>) => void;
  /** Set sort key AND direction directly (no toggle) — per-folder restore (#5). */
  setSort: (key: SortKey, dir: 1 | -1) => void;
  toggleExpand: (id: number) => void;
  ensureExpanded: (id: number) => void;
  expandToLevel: (level: number) => void;
  setSelectedId: (id: number) => void;
  setSortKey: (key: SortKey) => void;
  setMetric: (m: Metric) => void;
  setUnit: (u: Unit) => void;
  setFilter: (f: string) => void;
  setFilterRules: (rules: FilterRule[]) => void;
  setShowFiles: (v: boolean) => void;
  /** Active quick-filter chips (toolbar toggles). */
  chips: Set<ChipKey>;
  /** Toggle a quick-filter chip on/off. */
  toggleChip: (key: ChipKey) => void;
  resetForNewScan: () => void;
  // Merge new nodes into the tree, preserving expansion/selection state by path.
  // Used by smart-refresh so the tree doesn't blank during a background rescan.
  mergeNodes: (nodes: NodeRecord[]) => void;
  // Graft a shallow rescan of one directory into the existing tree.
  // Faster than mergeNodes for watch-triggered updates (no full rescan needed).
  patchDirectory: (changedPath: string, newNodes: NodeRecord[]) => void;
  visibleRows: NodeRecord[];
  nodeById: Map<number, NodeRecord>;
  setNodes: (nodes: NodeRecord[]) => void;
  /** LAZY mode: fetch (if not already loaded) the children of directory `dirId`
   *  from the backend's cached scan and merge them into the partial tree. A
   *  no-op in full mode or for already-loaded / bundle dirs. Returns when the
   *  merge is committed (or immediately for a no-op). Errors are swallowed
   *  (logged); a stale-scan 409 invokes the configured `onStale` callback. */
  ensureChildren: (dirId: number) => void;
  /** Set of directory ids whose children have been loaded in lazy mode. Empty
   *  in full mode. Drives "is this folder still loading?" UI affordances. */
  loadedDirs: Set<number>;
}

/** Lazy-mode configuration handed to {@link useTreeState}. When `enabled`, the
 *  hook serves children incrementally from the backend's cached scan rather than
 *  assuming the whole tree is in `nodes`. */
export interface LazyOptions {
  enabled: boolean;
  rootPath: string;
  scannedAt: number;
  /** Called when the backend reports the cached scan changed (409) — the host
   *  should refetch the scan. */
  onStale?: () => void;
}

export function compareNodes(
  a: NodeRecord,
  b: NodeRecord,
  key: SortKey,
  dir: 1 | -1,
): number {
  let left: number | string;
  let right: number | string;
  switch (key) {
    case "name":
      left = a.name.toLowerCase();
      right = b.name.toLowerCase();
      break;
    case "path":
      left = a.path.toLowerCase();
      right = b.path.toLowerCase();
      break;
    case "folderPath":
      left = a.path.toLowerCase().replace(/[^/\\]*$/, "");
      right = b.path.toLowerCase().replace(/[^/\\]*$/, "");
      break;
    case "type":
      left = a.dir ? "" : (a.extension.toLowerCase());
      right = b.dir ? "" : (b.extension.toLowerCase());
      break;
    case "allocated":
      left = a.allocated;
      right = b.allocated;
      break;
    case "files":
      left = a.files;
      right = b.files;
      break;
    case "folders":
      left = a.folders;
      right = b.folders;
      break;
    case "modified":
      left = a.modified;
      right = b.modified;
      break;
    case "created":
      left = a.created ?? 0;
      right = b.created ?? 0;
      break;
    case "accessed":
      left = a.accessed ?? 0;
      right = b.accessed ?? 0;
      break;
    case "avgFileSize":
      left = a.files > 0 ? a.size / a.files : 0;
      right = b.files > 0 ? b.size / b.files : 0;
      break;
    case "pathLength":
      left = a.path.length;
      right = b.path.length;
      break;
    case "dirLevel":
      left = a.depth;
      right = b.depth;
      break;
    case "compressionRate":
      left = a.size > 0 && a.allocated < a.size ? 1 - a.allocated / a.size : 0;
      right = b.size > 0 && b.allocated < b.size ? 1 - b.allocated / b.size : 0;
      break;
    case "owner":
      left = (a.owner ?? "").toLowerCase();
      right = (b.owner ?? "").toLowerCase();
      break;
    case "attributes":
      left = attributeLetters(a);
      right = attributeLetters(b);
      break;
    case "percent":
    case "size":
    default:
      left = a.size;
      right = b.size;
  }
  if (left < right) return -dir;
  if (left > right) return dir;
  return 0;
}

function makeBundleNode(parentId: number, depth: number, files: NodeRecord[]): NodeRecord {
  let size = 0, allocated = 0, modified = 0;
  const children: number[] = new Array(files.length);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    size += f.size;
    allocated += f.allocated;
    if (f.modified > modified) modified = f.modified;
    children[i] = f.id;
  }
  return {
    id: -(parentId + 1),
    parent: parentId,
    name: `[${files.length} Files]`,
    path: "",
    dir: false,
    link: false,
    hidden: false,
    readonly: false,
    size,
    allocated,
    files: files.length,
    folders: 0,
    modified,
    created: 0,
    accessed: 0,
    depth,
    errors: 0,
    extension: "",
    children,
  };
}

// Precomputed per-directory data, rebuilt only when nodes or sort changes.
interface DirCache {
  // sorted dir children (no bundles) — sort order baked in
  sortedDirs: Map<number, NodeRecord[]>;
  // bundle node for each dir that has file children (null if none)
  bundles: Map<number, NodeRecord>;
  // sorted file nodes for expanded bundles
  sortedFiles: Map<number, NodeRecord[]>;
}

function buildDirCache(
  nodeById: Map<number, NodeRecord>,
  sortKey: SortKey,
  sortDir: 1 | -1,
): DirCache {
  const sortedDirs = new Map<number, NodeRecord[]>();
  const bundles = new Map<number, NodeRecord>();
  const sortedFiles = new Map<number, NodeRecord[]>();

  for (const node of nodeById.values()) {
    if (!node.dir) continue;
    const dirs: NodeRecord[] = [];
    const files: NodeRecord[] = [];
    for (const cid of node.children) {
      const child = nodeById.get(cid);
      if (!child) continue;
      if (child.dir) dirs.push(child);
      else files.push(child);
    }
    dirs.sort((a, b) => compareNodes(a, b, sortKey, sortDir));
    sortedDirs.set(node.id, dirs);
    if (files.length > 0) {
      files.sort((a, b) => compareNodes(a, b, sortKey, sortDir));
      bundles.set(node.id, makeBundleNode(node.id, node.depth + 1, files));
      sortedFiles.set(node.id, files);
    }
  }
  return { sortedDirs, bundles, sortedFiles };
}

// Cap on rows surfaced while a filter/rule set is active. Filtering descends
// into every directory (ignoring expand state) and lists matching files inline,
// so without a bound a huge tree could materialise hundreds of thousands of rows
// — the very freeze the bundle system avoids in the normal (unfiltered) view.
const FILTER_ROW_CAP = 5000;

function collectVisibleRows(
  nodeById: Map<number, NodeRecord>,
  expanded: Set<number>,
  expandedAll: boolean,
  collapsedOverrides: Set<number>,
  cache: DirCache,
  filter: string,
  compiledRules: CompiledRule[],
  showFiles: boolean,
  chipRules: CompiledRule[],
): NodeRecord[] {
  const root = nodeById.get(0);
  if (!root) return [];

  // File bundles (negative ids) are always opt-in via `expanded`, even under
  // Expand All — auto-opening them would materialise every file in the folder as
  // its own row (the ~700k-row freeze). Real folders honour Expand All.
  const isOpen = (id: number) => {
    if (id < 0) return expanded.has(id);
    return expandedAll ? !collapsedOverrides.has(id) : expanded.has(id);
  };

  // Determine which filtering mode is active. Rules take precedence when any
  // rule is active; compiledRules already holds ONLY the active rules (their
  // RegExps precompiled once), so a non-empty list means rule-mode is on.
  const hasActiveRules = compiledRules.length > 0;
  // The simple text filter and the advanced rule set are mutually exclusive
  // (rules win) — but the quick-filter chips AND on top of EITHER, so a chip can
  // narrow a text-filtered or rule-filtered view rather than fighting it.
  const hasChips = chipRules.length > 0;
  const hasSimpleFilter = !hasActiveRules && filter.length > 0;
  // A filter or rule set is active. When so, the walk surfaces matching FILES
  // inline (the bundle system is bypassed) and treats every directory as open,
  // so deep matches show like a real filter rather than only matching folders.
  const filtering = hasSimpleFilter || hasActiveRules || hasChips;
  // Normalize the simple-filter needle ONCE per recompute instead of calling
  // filter.toLowerCase() for every node in passesFilter (the per-row hot path).
  const filterLower = hasSimpleFilter ? filter.toLowerCase() : "";

  const passesFilter = (node: NodeRecord): boolean => {
    if (hasActiveRules && !applyCompiledRules(compiledRules, node)) return false;
    if (hasSimpleFilter && !node.name.toLowerCase().includes(filterLower)) return false;
    if (hasChips && !applyCompiledRules(chipRules, node)) return false;
    return true;
  };

  const result: NodeRecord[] = [];
  const stack: NodeRecord[] = [root];

  while (stack.length) {
    // Filtering descends into every directory (below), so bound the total rows
    // to avoid the large-tree freeze the bundle system normally guards against.
    if (filtering && result.length >= FILTER_ROW_CAP) break;

    const node = stack.pop()!;
    const isBundle = node.id < 0;

    if (node.id !== 0 && !isBundle) {
      if (!showFiles && !node.dir) continue;
      if (filtering && !passesFilter(node)) {
        if (!node.dir) continue;
      }
    }
    result.push(node);

    // While filtering, treat real directories as open so matches inside
    // collapsed folders still surface; otherwise honor the expand/collapse state.
    if (!(filtering && !isBundle && node.dir) && !isOpen(node.id)) continue;

    if (isBundle) {
      // Expanded bundle: look up pre-sorted file list from parent dir's cache
      // node.parent is the real dir that owns these files
      const parentId = node.parent ?? -1;
      const files = cache.sortedFiles.get(parentId);
      if (files) {
        for (let i = files.length - 1; i >= 0; i--) {
          stack.push({ ...files[i], depth: node.depth + 1 });
        }
      }
    } else {
      const dirs = cache.sortedDirs.get(node.id) ?? [];
      if (filtering) {
        // Surface this directory's matching files inline (depth+1) — the bundle
        // system is bypassed so individual matches are visible — then queue every
        // subdirectory so the walk keeps descending the whole subtree.
        const files = cache.sortedFiles.get(node.id);
        if (files) {
          for (const f of files) {
            if (result.length >= FILTER_ROW_CAP) break;
            if (passesFilter(f)) result.push({ ...f, depth: node.depth + 1 });
          }
        }
        for (let i = dirs.length - 1; i >= 0; i--) {
          stack.push(dirs[i]);
        }
      } else {
        const bundle = (!filter && showFiles) ? cache.bundles.get(node.id) : undefined;

        // Push in reverse so first item ends up on top of stack
        if (bundle) {
          // Interleave bundle with dirs using cached sort order
          // Build display list: dirs + optional bundle, already sorted dirs
          // Bundle participates in sort — find its insertion point
          let bundleInserted = false;
          for (let i = dirs.length - 1; i >= 0; i--) {
            if (!bundleInserted && compareNodes(bundle, dirs[i], "size", -1) > 0) {
              stack.push(bundle);
              bundleInserted = true;
            }
            stack.push(dirs[i]);
          }
          if (!bundleInserted) stack.push(bundle);
        } else {
          for (let i = dirs.length - 1; i >= 0; i--) {
            stack.push(dirs[i]);
          }
        }
      }
    }
  }
  return result;
}

export function useTreeState(lazy?: LazyOptions): UseTreeStateReturn {
  const [nodes, setNodesState] = useState<NodeRecord[]>([]);
  const nodesRef = useRef<NodeRecord[]>(nodes);
  nodesRef.current = nodes;
  // ── Lazy-load bookkeeping ──────────────────────────────────────────────────
  // `loadedDirs` (state) drives UI; `loadedDirsRef`/`loadingDirsRef` are the
  // synchronous guards so concurrent expand bursts don't double-fetch a dir.
  // `lazyRef` mirrors the current lazy config for the stable ensureChildren cb.
  const [loadedDirs, setLoadedDirs] = useState<Set<number>>(new Set());
  const loadedDirsRef = useRef<Set<number>>(loadedDirs);
  loadedDirsRef.current = loadedDirs;
  const loadingDirsRef = useRef<Set<number>>(new Set());
  const lazyRef = useRef<LazyOptions | undefined>(lazy);
  lazyRef.current = lazy;
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const [expandedAll, setExpandedAll] = useState(false);
  const [collapsedOverrides, setCollapsedOverrides] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState(0);
  const [sortKey, setSortKeyState] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [filter, setFilter] = useState("");
  const [filterRules, setFilterRules] = useState<FilterRule[]>([]);
  const [chips, setChips] = useState<Set<ChipKey>>(new Set());
  const [metric, setMetric] = useState<Metric>("size");
  const [unit, setUnit] = useState<Unit>("auto");
  const [showFiles, setShowFiles] = useState(true);
  const [columnWidths, setColumnWidths] = useState<Partial<Record<SortKey, number>>>({});

  const setColumnWidth = useCallback((key: SortKey, width: number) => {
    setColumnWidths((prev) => (prev[key] === width ? prev : { ...prev, [key]: width }));
  }, []);

  // Replace the whole width map (per-folder restore). A fresh object so a memo
  // keyed on columnWidths recomputes.
  const setColumnWidthsAll = useCallback((widths: Partial<Record<SortKey, number>>) => {
    setColumnWidths({ ...(widths ?? {}) });
  }, []);

  // Apply a saved key+dir together (no toggle), unlike setSortKey which flips
  // the direction when the key is unchanged.
  const setSort = useCallback((key: SortKey, dir: 1 | -1) => {
    setSortKeyState(key);
    setSortDir(dir);
  }, []);

  const nodeById = useMemo(() => {
    const m = new Map<number, NodeRecord>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // ── Concurrent responsiveness (non-blocking heavy recomputes) ──────────────
  // The two expensive derivations below — buildDirCache (sorts every directory's
  // children) and collectVisibleRows (walks the whole open tree) — used to run
  // synchronously on every filter keystroke, "Expand All", sort change, etc.,
  // blocking typing/clicks on large trees. They now consume DEFERRED copies of
  // the *interaction* inputs (filter, expansion, sort, show-files) via
  // useDeferredValue: React commits the urgent render first (the filter box,
  // twisties and selection update instantly off the non-deferred state) and
  // recomputes the rows in a low-priority render it can interrupt, so a burst of
  // keystrokes coalesces to the latest value instead of blocking on each.
  //
  // Correctness / convergence: useDeferredValue always settles on the LATEST
  // value (it never drops the final update), and inputs that change together in
  // one update defer together (same urgent cycle), so visibleRows steps from one
  // CONSISTENT snapshot to the next and ends exactly where the synchronous
  // version would — identical functions, identical args, identical row order.
  // nodeById is deliberately NOT deferred: it stays urgent so the returned map
  // and the rows never skew, and scan / merge / patchDirectory (which mutate
  // nodeById) keep their exact prior synchronous behavior.
  const dFilter = useDeferredValue(filter);
  const dExpanded = useDeferredValue(expanded);
  const dExpandedAll = useDeferredValue(expandedAll);
  const dCollapsedOverrides = useDeferredValue(collapsedOverrides);
  const dShowFiles = useDeferredValue(showFiles);
  const dSortKey = useDeferredValue(sortKey);
  const dSortDir = useDeferredValue(sortDir);

  // Rebuild sort+bundle cache only when data or (deferred) sort changes — not on
  // expand/filter. Keyed on the urgent nodeById so it stays in lockstep with the
  // returned map; the deferred sort keeps a sort switch from blocking input.
  const dirCache = useMemo(
    () => buildDirCache(nodeById, dSortKey, dSortDir),
    [nodeById, dSortKey, dSortDir],
  );

  // Precompile filter rules (regex/glob → cached, ReDoS-guarded RegExp) ONCE per
  // rule-set change, not per visible row. Compilation stays URGENT (so the
  // ReDoS guard runs immediately on edit); only its consumption by the row walk
  // is deferred so applying a rule to a large tree doesn't block.
  const compiledRules = useMemo(() => compileRules(filterRules), [filterRules]);
  const dCompiledRules = useDeferredValue(compiledRules);

  // Quick-filter chips compile through the SAME rule engine, then defer their
  // consumption by the row walk (like the advanced rules) so toggling a chip on
  // a large tree never blocks the click.
  const compiledChipRules = useMemo(() => compileRules(buildChipRules(chips)), [chips]);
  const dCompiledChipRules = useDeferredValue(compiledChipRules);

  const visibleRows = useMemo(
    () => collectVisibleRows(
      nodeById, dExpanded, dExpandedAll, dCollapsedOverrides,
      dirCache, dFilter, dCompiledRules, dShowFiles, dCompiledChipRules,
    ),
    [nodeById, dExpanded, dExpandedAll, dCollapsedOverrides, dirCache, dFilter, dCompiledRules, dShowFiles, dCompiledChipRules],
  );

  const toggleChip = useCallback((key: ChipKey) => {
    setChips((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // LAZY mode: fetch + merge a directory's children on demand. No-op in full
  // mode (the whole tree is already in `nodes`) or for bundle/loaded dirs.
  const ensureChildren = useCallback((dirId: number) => {
    const lz = lazyRef.current;
    if (!lz?.enabled || dirId < 0) return;
    // The scan-result effect sets the root and requests its children in separate
    // renders. Do not start a request until the target directory is committed;
    // the root preload effect will retry as soon as it appears.
    if (!nodesRef.current.some((node) => node.id === dirId && node.dir)) return;
    if (loadedDirsRef.current.has(dirId) || loadingDirsRef.current.has(dirId)) return;
    loadingDirsRef.current.add(dirId);
    const requestRoot = lz.rootPath;
    const requestScannedAt = lz.scannedAt;
    void fetchChildren({ rootPath: lz.rootPath, dirId, scannedAt: lz.scannedAt })
      .then((fetched) => {
        const current = lazyRef.current;
        if (!current?.enabled
          || current.rootPath !== requestRoot
          || current.scannedAt !== requestScannedAt) return;
        setNodesState((prev) => {
          const byId = new Map<number, NodeRecord>();
          for (const n of prev) byId.set(n.id, n);
          const dir = byId.get(dirId);
          if (!dir) return prev;
          const existing = new Set(dir.children);
          const childIds = [...dir.children];
          const added: NodeRecord[] = [];
          for (const n of fetched) {
            if (byId.has(n.id)) continue; // already present (re-entrancy guard)
            added.push({ ...n, children: n.children ?? [] });
            if (!existing.has(n.id)) { childIds.push(n.id); existing.add(n.id); }
          }
          if (added.length === 0 && childIds.length === dir.children.length) return prev;
          const next = prev.map((x) => (x.id === dirId ? { ...x, children: childIds } : x));
          next.push(...added);
          return next;
        });
        setLoadedDirs((prev) => {
          if (prev.has(dirId)) return prev;
          const next = new Set(prev);
          next.add(dirId);
          return next;
        });
      })
      .catch((err: unknown) => {
        if (err instanceof ScanStaleError) {
          lazyRef.current?.onStale?.();
        } else {
          console.warn("ensureChildren failed for dir", dirId, err);
        }
      })
      .finally(() => {
        loadingDirsRef.current.delete(dirId);
      });
  }, []);

  const toggleExpand = useCallback((id: number) => {
    // LAZY: opening a real directory pulls its children if not yet loaded. Safe
    // to call unconditionally — ensureChildren no-ops in full mode / when loaded.
    if (id >= 0) ensureChildren(id);
    if (expandedAll && id >= 0) {
      setCollapsedOverrides((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); // re-open a manually-collapsed node
        else next.add(id);                 // collapse it
        return next;
      });
    } else {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
  }, [expandedAll, ensureChildren]);

  // Only opens a node — never collapses it. Used by navigate-to operations.
  const ensureExpanded = useCallback((id: number) => {
    if (id >= 0) ensureChildren(id);
    if (expandedAll) {
      setCollapsedOverrides((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } else {
      setExpanded((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  }, [expandedAll, ensureChildren]);

  const expandToLevel = useCallback((level: number) => {
    if (level === Infinity) {
      setExpandedAll(true);
      setCollapsedOverrides(new Set());
    } else {
      setExpandedAll(false);
      setCollapsedOverrides(new Set());
      const next = new Set<number>();
      for (const node of nodeById.values()) {
        if (node.dir && node.children.length > 0 && node.depth < level) {
          next.add(node.id);
        }
      }
      setExpanded(next);
    }
  }, [nodeById]);

  const setSortKey = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((d) => (d === 1 ? -1 : 1));
      } else {
        setSortKeyState(key);
        const ascendingByDefault: SortKey[] = ["name", "path", "folderPath", "type", "attributes", "owner", "pathLength"];
        setSortDir(ascendingByDefault.includes(key) ? 1 : -1);
      }
    },
    [sortKey],
  );

  const setNodes = useCallback((newNodes: NodeRecord[]) => {
    setNodesState(newNodes);
    // A fresh node set (new scan / lazy root) invalidates lazy-load bookkeeping.
    loadingDirsRef.current = new Set();
    loadedDirsRef.current = new Set();
    setLoadedDirs(new Set());
  }, []);

  const resetForNewScan = useCallback(() => {
    setExpanded(new Set([0]));
    setExpandedAll(false);
    setCollapsedOverrides(new Set());
    setSelectedId(0);
    setFilter("");
    setFilterRules([]);
    setChips(new Set());
    loadingDirsRef.current = new Set();
    loadedDirsRef.current = new Set();
    setLoadedDirs(new Set());
  }, []);

  // Replace nodes while preserving expansion/selection by path.
  const mergeNodes = useCallback((newNodes: NodeRecord[]) => {
    setNodesState((prevNodes) => {
      // Build O(1) lookup maps for both old and new trees
      const oldById = new Map<number, NodeRecord>();
      for (const n of prevNodes) oldById.set(n.id, n);

      const newPathToId = new Map<string, number>();
      for (const n of newNodes) {
        if (n.path) newPathToId.set(n.path, n.id);
      }

      // Bundle nodes have negative IDs (-(parentId+1)) and path="" — they are
      // not in prevNodes/newNodes so we remap them via their parent's path.
      const remapId = (oldId: number): number | undefined => {
        if (oldId === 0) return 0;
        const oldNode = oldById.get(oldId);
        if (oldNode?.path) return newPathToId.get(oldNode.path);
        if (oldId < 0) {
          // Bundle node: derive parent ID and remap to new bundle ID
          const oldParentId = -oldId - 1;
          const oldParent = oldById.get(oldParentId);
          if (oldParent?.path) {
            const newParentId = newPathToId.get(oldParent.path);
            if (newParentId !== undefined) return -(newParentId + 1);
          }
        }
        return undefined;
      };

      setTimeout(() => {
        setExpanded((prevExpanded) => {
          const next = new Set<number>();
          next.add(0); // root always open
          for (const oldId of prevExpanded) {
            const newId = remapId(oldId);
            if (newId !== undefined) next.add(newId);
          }
          return next;
        });
        setSelectedId((prevSelected) => {
          return remapId(prevSelected) ?? 0;
        });
        setCollapsedOverrides((prevOverrides) => {
          if (prevOverrides.size === 0) return prevOverrides;
          const next = new Set<number>();
          for (const oldId of prevOverrides) {
            const newId = remapId(oldId);
            if (newId !== undefined) next.add(newId);
          }
          return next;
        });
      }, 0);

      return newNodes;
    });
  }, []);

  // Graft a shallow rescan of one directory into the existing full tree.
  // newNodes is a mini ScanResult rooted at changedPath (depth-limited scan).
  // We replace only the children of that directory in the full tree and
  // recalculate ancestor sizes/counts up to the root.
  const patchDirectory = useCallback((changedPath: string, newNodes: NodeRecord[]) => {
    setNodesState((prevNodes) => {
      // The patch is a maxDepth=1 (shallow) re-scan of changedPath: it lists the
      // directory's immediate children, but every SUBFOLDER comes back as a
      // depth-limited stub (size 0, no children, a spurious "depth limit reached"
      // error). We must NOT let those stubs clobber the real subtrees we already
      // hold — only the file children and the *set* of immediate entries are
      // authoritative. So we keep existing subfolders' subtrees untouched and
      // re-aggregate changedPath from its real children.
      const oldByPath = new Map<string, NodeRecord>();
      for (const n of prevNodes) if (n.path) oldByPath.set(n.path, n);
      const targetNode = oldByPath.get(changedPath);
      if (!targetNode) return prevNodes; // not in tree, ignore

      const miniById = new Map<number, NodeRecord>();
      for (const n of newNodes) miniById.set(n.id, n);
      const miniRoot = miniById.get(0);
      if (!miniRoot) return prevNodes;

      let maxId = 0;
      for (const n of prevNodes) if (n.id > maxId) maxId = n.id;

      // Immediate subfolders we preserve from the old tree (keep descendants +
      // aggregate sizes); files and brand-new folders spliced in with fresh ids.
      const preservedDirPaths: string[] = [];
      const addedNodes: NodeRecord[] = [];
      const rootChildIds: number[] = [];

      for (const childId of miniRoot.children) {
        const child = miniById.get(childId);
        if (!child) continue;
        const old = child.path ? oldByPath.get(child.path) : undefined;
        if (child.dir && old && old.dir) {
          // Existing subfolder: keep its old subtree (id, size, descendants).
          preservedDirPaths.push(old.path.toLowerCase());
          rootChildIds.push(old.id);
        } else {
          // New/changed file, or a brand-new folder: take the fresh node. A new
          // folder's real contents stay unknown (0) until the next full scan, so
          // drop the shallow depth-limit error it would otherwise carry.
          const newId = ++maxId;
          addedNodes.push({
            ...child,
            id: newId,
            parent: targetNode.id,
            depth: targetNode.depth + 1,
            children: [],
            errors: child.dir ? 0 : child.errors,
          });
          rootChildIds.push(newId);
        }
      }

      // Rebuild changedPath from the fresh scan (fresh mtime/name) but keep its
      // identity and point it at the resolved child set.
      const newRoot: NodeRecord = {
        ...miniRoot,
        id: targetNode.id,
        parent: targetNode.parent,
        path: targetNode.path,
        depth: targetNode.depth,
        children: rootChildIds,
      };

      // Keep every old node except changedPath itself and the old descendants
      // that are NOT under a preserved subfolder (old file children + entries
      // that disappeared). Preserved subfolders + descendants are retained as-is.
      const changedPathNorm = changedPath.toLowerCase();
      // O(1) membership instead of O(preservedDirPaths) per node: a path is
      // "under preserved" iff itself or one of its ancestor dirs is preserved.
      const preservedSet = new Set(preservedDirPaths);
      const underPreserved = (p: string) => {
        if (preservedSet.has(p)) return true;
        let cur = p;
        for (;;) {
          const i = Math.max(cur.lastIndexOf("\\"), cur.lastIndexOf("/"));
          if (i <= 0) return false;
          cur = cur.slice(0, i);
          if (preservedSet.has(cur)) return true;
        }
      };
      const kept = prevNodes.filter((n) => {
        if (n.id === targetNode.id) return false; // replaced by newRoot
        const p = n.path.toLowerCase();
        const underChanged = p.startsWith(changedPathNorm + "\\") || p.startsWith(changedPathNorm + "/");
        if (!underChanged) return true;
        return underPreserved(p);
      });

      const merged = [...kept, newRoot, ...addedNodes];
      const byId = new Map<number, NodeRecord>();
      for (const n of merged) byId.set(n.id, n);

      // Re-aggregate size/counts from changedPath up to the root. We start AT
      // changedPath (not its parent): the shallow scan undercounts it because the
      // subfolder stubs reported 0. A file node carries files=1; a dir carries
      // its subtree totals — so summing children is correct and convention-safe.
      let cur: NodeRecord | null | undefined = byId.get(targetNode.id);
      while (cur) {
        let size = 0, allocated = 0, files = 0, folders = 0, errors = 0;
        for (const cid of cur.children) {
          const child = byId.get(cid);
          if (!child) continue;
          size += child.size; allocated += child.allocated;
          files += child.files;
          folders += child.folders + (child.dir ? 1 : 0);
          errors += child.errors;
        }
        // update in-place (safe since we own these objects from the spread)
        (cur as NodeRecord).size = size;
        (cur as NodeRecord).allocated = allocated;
        (cur as NodeRecord).files = files;
        (cur as NodeRecord).folders = folders;
        (cur as NodeRecord).errors = errors;
        cur = cur.parent != null ? byId.get(cur.parent) : null;
      }

      return merged;
    });
  }, []);

  return {
    expanded,
    expandedAll,
    selectedId,
    sortKey,
    sortDir,
    filter,
    filterRules,
    metric,
    unit,
    showFiles,
    columnWidths,
    setColumnWidth,
    setColumnWidthsAll,
    setSort,
    toggleExpand,
    ensureExpanded,
    expandToLevel,
    setSelectedId,
    setSortKey,
    setMetric,
    setUnit,
    setFilter,
    setFilterRules,
    setShowFiles,
    chips,
    toggleChip,
    resetForNewScan,
    mergeNodes,
    patchDirectory,
    visibleRows,
    nodeById,
    setNodes,
    ensureChildren,
    loadedDirs,
  };
}
