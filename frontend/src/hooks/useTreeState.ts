import { useState, useCallback, useMemo } from "react";
import type { NodeRecord, SortKey, Metric, Unit } from "../api/types";
import { type FilterRule, applyRules } from "./useFilterRules";

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
}

export interface UseTreeStateReturn extends TreeState {
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
}

function compareNodes(
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
    case "attributes":
      left = [a.hidden ? "H" : "", a.readonly ? "R" : "", a.link ? "L" : ""].join("");
      right = [b.hidden ? "H" : "", b.readonly ? "R" : "", b.link ? "L" : ""].join("");
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

function collectVisibleRows(
  nodeById: Map<number, NodeRecord>,
  expanded: Set<number>,
  expandedAll: boolean,
  collapsedOverrides: Set<number>,
  cache: DirCache,
  filter: string,
  filterRules: FilterRule[],
  showFiles: boolean,
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

  // Determine which filtering mode is active.
  // Rules take precedence when any rule has a non-empty value.
  const hasActiveRules = filterRules.some((r) => r.value.trim() !== "");
  const hasSimpleFilter = !hasActiveRules && filter.length > 0;

  const passesFilter = (node: NodeRecord): boolean => {
    if (hasActiveRules) return applyRules(filterRules, node.name, node.path);
    if (hasSimpleFilter) return node.name.toLowerCase().includes(filter.toLowerCase());
    return true;
  };

  const result: NodeRecord[] = [];
  const stack: NodeRecord[] = [root];

  while (stack.length) {
    const node = stack.pop()!;
    const isBundle = node.id < 0;

    if (node.id !== 0 && !isBundle) {
      if (!showFiles && !node.dir) continue;
      if ((hasActiveRules || hasSimpleFilter) && !passesFilter(node)) {
        if (!node.dir) continue;
      }
    }
    result.push(node);

    if (!isOpen(node.id)) continue;

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
  return result;
}

export function useTreeState(): UseTreeStateReturn {
  const [nodes, setNodesState] = useState<NodeRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));
  const [expandedAll, setExpandedAll] = useState(false);
  const [collapsedOverrides, setCollapsedOverrides] = useState<Set<number>>(new Set());
  const [selectedId, setSelectedId] = useState(0);
  const [sortKey, setSortKeyState] = useState<SortKey>("size");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [filter, setFilter] = useState("");
  const [filterRules, setFilterRules] = useState<FilterRule[]>([]);
  const [metric, setMetric] = useState<Metric>("size");
  const [unit, setUnit] = useState<Unit>("auto");
  const [showFiles, setShowFiles] = useState(true);

  const nodeById = useMemo(() => {
    const m = new Map<number, NodeRecord>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // Rebuild sort+bundle cache only when data or sort changes — not on expand/filter
  const dirCache = useMemo(
    () => buildDirCache(nodeById, sortKey, sortDir),
    [nodeById, sortKey, sortDir],
  );

  const visibleRows = useMemo(
    () => collectVisibleRows(
      nodeById, expanded, expandedAll, collapsedOverrides,
      dirCache, filter, filterRules, showFiles,
    ),
    [nodeById, expanded, expandedAll, collapsedOverrides, dirCache, filter, filterRules, showFiles],
  );

  const toggleExpand = useCallback((id: number) => {
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
  }, [expandedAll]);

  // Only opens a node — never collapses it. Used by navigate-to operations.
  const ensureExpanded = useCallback((id: number) => {
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
  }, [expandedAll]);

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
        const ascendingByDefault: SortKey[] = ["name", "path", "folderPath", "type", "attributes", "pathLength"];
        setSortDir(ascendingByDefault.includes(key) ? 1 : -1);
      }
    },
    [sortKey],
  );

  const setNodes = useCallback((newNodes: NodeRecord[]) => {
    setNodesState(newNodes);
  }, []);

  const resetForNewScan = useCallback(() => {
    setExpanded(new Set([0]));
    setExpandedAll(false);
    setCollapsedOverrides(new Set());
    setSelectedId(0);
    setFilter("");
    setFilterRules([]);
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
    resetForNewScan,
    mergeNodes,
    patchDirectory,
    visibleRows,
    nodeById,
    setNodes,
  };
}
