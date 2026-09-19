import { useState, useCallback, useMemo, useDeferredValue, useRef } from "react";
import type { NodeRecord, SortKey, Metric, Unit } from "../api/types";
import { type FilterRule, type CompiledRule, compileRules, applyCompiledRules } from "./useFilterRules";
import { attributeLetters } from "../lib/attributes";
import { fetchChildren, ScanStaleError } from "../api/client";
import { CHILD_FETCH_LIMIT } from "../lib/treeLimits";

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
  collapsedOverrides: Set<number>;
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
  scanId?: string;
  /** Load one live directory level when a watcher-created row is not present in
   *  the immutable scan database yet. This keeps refresh incremental while
   *  allowing newly-created or moved folders to expand immediately. */
  loadDirectory?: (path: string) => Promise<NodeRecord[]>;
  /** Called when the backend reports the cached scan changed (409) — the host
   *  should refetch the scan. */
  onStale?: () => void;
  /** Called when a directory holds more children than one expansion may pull,
   *  so the host can say so rather than letting rows go missing in silence. */
  onTruncated?: (info: { path: string; loaded: number }) => void;
}

// SQLite scan ids are ordinary sequential integers. Watcher-created entries are
// assigned from this reserved, exactly-representable range so lazy expansion can
// identify them without maintaining an unbounded side map or colliding with a
// future page fetched from the scan database.
const LIVE_NODE_ID_START = 9_000_000_000_000_000;
const LIVE_NODE_ID_FLOOR = 8_000_000_000_000_000;

export function isLiveNodeId(id: number): boolean {
  return id >= LIVE_NODE_ID_FLOOR && id <= LIVE_NODE_ID_START;
}

function normalizedNodePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
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
    case "lastFileCreated":
      left = a.lastFileCreated ?? 0;
      right = b.lastFileCreated ?? 0;
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
// A page cache for browsing, plus the same again reserved for rows beneath
// folders the user actively expands. Without that reserve, one wide directory
// fills the cache and every later expansion is silently admitted as zero rows.
//
// Both are sized from what a single expansion may fetch, so a folder that fits
// under the fetch limit always fits in the store too. They used to be 8,000
// each while the fetch also stopped at 8,000: a directory of that size filled
// the whole active reserve by itself, and a download folder of twelve thousand
// could never be shown whole however the user sorted it.
const MAX_CACHED_LAZY_NODES = CHILD_FETCH_LIMIT;
const MAX_ACTIVE_LAZY_NODES = CHILD_FETCH_LIMIT;
const MAX_RETAINED_LAZY_NODES = MAX_CACHED_LAZY_NODES + MAX_ACTIVE_LAZY_NODES;

/** Single source of truth for folder and synthetic file-bundle twisties. */
export function isNodeOpen(
  id: number,
  expanded: ReadonlySet<number>,
  expandedAll: boolean,
  collapsedOverrides: ReadonlySet<number>,
): boolean {
  return expandedAll ? !collapsedOverrides.has(id) : expanded.has(id);
}

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
    if (
      !(filtering && !isBundle && node.dir)
      && !isNodeOpen(node.id, expanded, expandedAll, collapsedOverrides)
    ) continue;

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
  const patchDirectoryRef = useRef<(changedPath: string, newNodes: NodeRecord[]) => void>(() => {});
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [expandedAll, setExpandedAll] = useState(false);
  const expandedAllRef = useRef(expandedAll);
  expandedAllRef.current = expandedAll;
  const [collapsedOverrides, setCollapsedOverrides] = useState<Set<number>>(new Set());
  const collapsedOverridesRef = useRef(collapsedOverrides);
  collapsedOverridesRef.current = collapsedOverrides;
  const [selectedId, setSelectedId] = useState(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [sortKey, setSortKeyState] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  // Read by `ensureChildren`, which is a stable callback: a wide directory is
  // fetched in the order the user is looking at, so the rows that arrive are
  // the ones at the top of their list rather than the biggest by default.
  const sortKeyRef = useRef(sortKey);
  sortKeyRef.current = sortKey;
  const sortDirRef = useRef(sortDir);
  sortDirRef.current = sortDir;
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
    const directory = nodesRef.current.find((node) => node.id === dirId && node.dir);
    if (!directory) return;
    if (loadingDirsRef.current.has(dirId)) return;
    if (loadedDirsRef.current.has(dirId)) {
      // A previous fetch may have completed while the bounded node store had no
      // room left, or a watcher patch may have preserved the directory id while
      // replacing its unloaded stub. A non-empty aggregate with no retained
      // child ids is not actually loaded; clear the stale guard and retry.
      const expectsChildren = directory.files > 0 || directory.folders > 0;
      if (directory.children.length > 0 || !expectsChildren) return;
      const nextLoaded = new Set(loadedDirsRef.current);
      nextLoaded.delete(dirId);
      loadedDirsRef.current = nextLoaded;
      setLoadedDirs(nextLoaded);
    }
    loadingDirsRef.current.add(dirId);
    const requestRoot = lz.rootPath;
    const requestScannedAt = lz.scannedAt;

    // A shallow watcher refresh can discover a directory after the immutable
    // SQLite scan was built. Its reserved id cannot be paged from that database,
    // so read exactly one live filesystem level and graft it into the tree. Any
    // nested directories stay lazy and follow this same path when opened.
    if (isLiveNodeId(dirId) && directory.path && lz.loadDirectory) {
      const requestPath = directory.path;
      void lz.loadDirectory(requestPath)
        .then((snapshot) => {
          const current = lazyRef.current;
          if (!current?.enabled
            || current.rootPath !== requestRoot
            || current.scannedAt !== requestScannedAt) return;
          if (snapshot.length > 0) patchDirectoryRef.current(requestPath, snapshot);
          setLoadedDirs((prev) => {
            if (prev.has(dirId)) return prev;
            const next = new Set(prev);
            next.add(dirId);
            loadedDirsRef.current = next;
            return next;
          });
        })
        .catch((err: unknown) => {
          console.warn("live ensureChildren failed for dir", requestPath, err);
        })
        .finally(() => {
          loadingDirsRef.current.delete(dirId);
        });
      return;
    }

    void fetchChildren({
      rootPath: lz.rootPath,
      scanId: lz.scanId,
      dirId,
      scannedAt: lz.scannedAt,
      sort: sortKeyRef.current,
      dir: sortDirRef.current === 1 ? "asc" : "desc",
      onTruncated: (loaded) => {
        lazyRef.current?.onTruncated?.({ path: directory.path, loaded });
      },
    })
      .then((fetched) => {
        const current = lazyRef.current;
        if (!current?.enabled
          || current.rootPath !== requestRoot
          || current.scannedAt !== requestScannedAt) return;
        setNodesState((prev) => {
          let retained = prev;
          const incomingIds = new Set(fetched.map((node) => node.id));
          const required = Math.max(0, retained.length + fetched.length - MAX_RETAINED_LAZY_NODES);
          if (required > 0) {
            const protectedIds = new Set<number>([0, dirId, selectedIdRef.current, ...expandedRef.current]);
            const byId = new Map(retained.map((node) => [node.id, node]));
            if (expandedAllRef.current) {
              for (const node of retained) {
                if (
                  node.dir
                  && isNodeOpen(
                    node.id,
                    expandedRef.current,
                    true,
                    collapsedOverridesRef.current,
                  )
                ) protectedIds.add(node.id);
              }
            }
            for (const id of [...protectedIds]) {
              let current = byId.get(id);
              while (current?.parent != null) {
                protectedIds.add(current.parent);
                current = byId.get(current.parent);
              }
            }
            const removedParents = new Set<number>();
            let removed = 0;
            retained = retained.filter((node) => {
              if (removed >= required || protectedIds.has(node.id) || incomingIds.has(node.id)) return true;
              const parentOpen = node.parent != null && isNodeOpen(
                node.parent,
                expandedRef.current,
                expandedAllRef.current,
                collapsedOverridesRef.current,
              );
              if (node.parent != null && !parentOpen) {
                removedParents.add(node.parent);
                removed++;
                return false;
              }
              return true;
            });
            if (removedParents.size > 0) {
              const nextLoaded = new Set(loadedDirsRef.current);
              for (const parent of removedParents) nextLoaded.delete(parent);
              loadedDirsRef.current = nextLoaded;
              setTimeout(() => setLoadedDirs(new Set(nextLoaded)), 0);
            }
          }
          const capacity = Math.max(0, MAX_RETAINED_LAZY_NODES - retained.length);
          const boundedFetched = fetched.slice(0, capacity);
          const byId = new Map<number, NodeRecord>();
          for (const n of retained) byId.set(n.id, n);
          const dir = byId.get(dirId);
          if (!dir) return retained;
          // Watcher-created rows use reserved live ids. The same path can later
          // arrive from SQLite under its stable database id, so id-only merging
          // produces two visible rows. Treat a normalized Windows path as the
          // child identity and also repair duplicate references already present.
          //
          // Scoped to this directory's own children, deliberately. Searching the
          // whole tree by path adopts whatever else happens to share the key —
          // and paths are not reliably unique here, because a file whose parent
          // row is missing from the query's join is reported under a bare
          // filename. Two same-named files in different folders would then make
          // one directory claim the other's row. Within a single directory the
          // key cannot collide at all: a folder cannot hold two entries of the
          // same name.
          const retainedPathIds = new Map<string, number>();
          for (const node of retained) {
            if (!node.path || node.parent !== dirId) continue;
            const key = normalizedNodePath(node.path);
            if (!retainedPathIds.has(key)) retainedPathIds.set(key, node.id);
          }
          const existingIds = new Set<number>();
          const existingChildPaths = new Map<string, number>();
          const childIds: number[] = [];
          for (const childId of dir.children) {
            const child = byId.get(childId);
            const key = child?.path ? normalizedNodePath(child.path) : "";
            if (key && existingChildPaths.has(key)) continue;
            childIds.push(childId);
            existingIds.add(childId);
            if (key) existingChildPaths.set(key, childId);
          }
          const added: NodeRecord[] = [];
          for (const n of boundedFetched) {
            if (byId.has(n.id)) continue; // already present (re-entrancy guard)
            const pathKey = n.path ? normalizedNodePath(n.path) : "";
            const matchingPathId = pathKey
              ? (existingChildPaths.get(pathKey) ?? retainedPathIds.get(pathKey))
              : undefined;
            if (matchingPathId !== undefined) {
              if (!existingIds.has(matchingPathId)) {
                childIds.push(matchingPathId);
                existingIds.add(matchingPathId);
                existingChildPaths.set(pathKey, matchingPathId);
              }
              continue;
            }
            added.push({ ...n, children: n.children ?? [] });
            if (!existingIds.has(n.id)) {
              childIds.push(n.id);
              existingIds.add(n.id);
              if (pathKey) existingChildPaths.set(pathKey, n.id);
            }
          }
          const childrenChanged = childIds.length !== dir.children.length
            || childIds.some((id, index) => id !== dir.children[index]);
          if (added.length === 0 && !childrenChanged) return retained;
          const next = retained.map((x) => (x.id === dirId ? { ...x, children: childIds } : x));
          next.push(...added);
          return next;
        });
        setLoadedDirs((prev) => {
          if (prev.has(dirId)) return prev;
          const next = new Set(prev);
          next.add(dirId);
          loadedDirsRef.current = next;
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
    if (expandedAll) {
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
      for (const n of prevNodes) if (n.path) oldByPath.set(normalizedNodePath(n.path), n);
      const targetNode = oldByPath.get(normalizedNodePath(changedPath));
      if (!targetNode) return prevNodes; // not in tree, ignore

      // Matching an incoming entry against the *whole* tree by path is not safe:
      // a match here keeps the matched node's entire subtree (see below), so one
      // duplicate key grafts a foreign folder's contents under this one. Paths
      // are not reliably unique — a file whose parent row is missing from the
      // scan query's join is reported under a bare filename — so match only
      // against this directory's own children, where a name cannot repeat.
      const oldById = new Map<number, NodeRecord>();
      for (const n of prevNodes) oldById.set(n.id, n);
      const oldChildByPath = new Map<string, NodeRecord>();
      for (const childId of targetNode.children) {
        const child = oldById.get(childId);
        if (child?.path) oldChildByPath.set(normalizedNodePath(child.path), child);
      }

      const miniById = new Map<number, NodeRecord>();
      for (const n of newNodes) miniById.set(n.id, n);
      const miniRoot = miniById.get(0);
      if (!miniRoot) return prevNodes;

      const usedIds = new Set(prevNodes.map((node) => node.id));
      let nextLiveId = LIVE_NODE_ID_START;
      const allocateLiveId = (): number => {
        while (usedIds.has(nextLiveId) && nextLiveId >= LIVE_NODE_ID_FLOOR) nextLiveId--;
        if (nextLiveId < LIVE_NODE_ID_FLOOR) throw new Error("Live node id range exhausted");
        const id = nextLiveId--;
        usedIds.add(id);
        return id;
      };

      // Immediate subfolders preserve their old tree (descendants + aggregate
      // sizes). Existing files also preserve their ids while taking fresh live
      // metadata, so watcher patches cannot invalidate selection between a
      // pointer-down and the resulting open/context-menu action.
      const preservedDirPaths: string[] = [];
      const refreshedPreservedDirs = new Map<string, NodeRecord>();
      const addedNodes: NodeRecord[] = [];
      const rootChildIds: number[] = [];

      for (const childId of miniRoot.children) {
        const child = miniById.get(childId);
        if (!child) continue;
        const old = child.path ? oldChildByPath.get(normalizedNodePath(child.path)) : undefined;
        if (child.dir && old && old.dir) {
          // Existing subfolder: keep its old subtree (id, size, descendants).
          preservedDirPaths.push(normalizedNodePath(old.path));
          if (child.aggregateKnown === true) {
            refreshedPreservedDirs.set(normalizedNodePath(old.path), child);
          }
          rootChildIds.push(old.id);
        } else if (!child.dir && old && !old.dir) {
          addedNodes.push({
            ...child,
            id: old.id,
            parent: targetNode.id,
            depth: targetNode.depth + 1,
            children: [],
          });
          rootChildIds.push(old.id);
        } else {
          // A brand-new entry or one whose file/folder type changed gets a live
          // id. A new folder remains an unknown lazy stub until first expansion,
          // so drop the shallow depth-limit error it would otherwise carry.
          const newId = allocateLiveId();
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
      const changedPathNorm = normalizedNodePath(changedPath);
      // O(1) membership instead of O(preservedDirPaths) per node: a path is
      // "under preserved" iff itself or one of its ancestor dirs is preserved.
      const preservedSet = new Set(preservedDirPaths);
      const underPreserved = (p: string) => {
        if (preservedSet.has(p)) return true;
        let cur = p;
        for (;;) {
          const i = cur.lastIndexOf("\\");
          if (i <= 0) return false;
          cur = cur.slice(0, i);
          if (preservedSet.has(cur)) return true;
        }
      };
      const kept = prevNodes.filter((n) => {
        if (n.id === targetNode.id) return false; // replaced by newRoot
        const p = normalizedNodePath(n.path);
        const underChanged = p.startsWith(changedPathNorm + "\\");
        if (!underChanged) return true;
        return underPreserved(p);
      }).map((n) => {
        const refreshed = refreshedPreservedDirs.get(normalizedNodePath(n.path));
        if (!refreshed) return n;
        return {
          ...n,
          size: refreshed.size,
          allocated: refreshed.allocated,
          files: refreshed.files,
          folders: refreshed.folders,
          errors: refreshed.errors,
          modified: Math.max(n.modified, refreshed.modified),
          aggregateKnown: true,
        };
      });

      const merged = [...kept, newRoot, ...addedNodes];
      const byId = new Map<number, NodeRecord>();
      for (const n of merged) byId.set(n.id, n);

      // Re-aggregate size/counts and newest modified time from changedPath up
      // to the root. We start AT
      // changedPath (not its parent): the shallow scan undercounts it because the
      // subfolder stubs reported 0. A file node carries files=1; a dir carries
      // its subtree totals — so summing children is correct and convention-safe.
      let cur: NodeRecord | null | undefined = byId.get(targetNode.id);
      while (cur) {
        let size = 0, allocated = 0, files = 0, folders = 0, errors = 0;
        let modified = cur.modified;
        // Only files date a folder's last addition, so a directory contributes
        // whatever it already rolled up rather than its own creation date.
        let lastFileCreated = 0;
        for (const cid of cur.children) {
          const child = byId.get(cid);
          if (!child) continue;
          size += child.size; allocated += child.allocated;
          files += child.files;
          folders += child.folders + (child.dir ? 1 : 0);
          errors += child.errors;
          modified = Math.max(modified, child.modified);
          const added = child.dir ? (child.lastFileCreated ?? 0) : (child.created ?? 0);
          lastFileCreated = Math.max(lastFileCreated, added);
        }
        // update in-place (safe since we own these objects from the spread)
        (cur as NodeRecord).size = size;
        (cur as NodeRecord).allocated = allocated;
        (cur as NodeRecord).files = files;
        (cur as NodeRecord).folders = folders;
        (cur as NodeRecord).errors = errors;
        (cur as NodeRecord).modified = modified;
        (cur as NodeRecord).lastFileCreated = lastFileCreated;
        cur = cur.parent != null ? byId.get(cur.parent) : null;
      }

      return merged;
    });
  }, []);

  patchDirectoryRef.current = patchDirectory;

  return {
    expanded,
    expandedAll,
    collapsedOverrides,
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
