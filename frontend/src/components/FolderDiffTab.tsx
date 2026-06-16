import { useCallback, useMemo, useState } from "react";
import type { DiffResult, DiffRow, DiffStatus, NodeRecord, ScanResult } from "../api/types";
import { DiffView } from "./CompareTab";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";

// Ad-hoc "compare two folders" diff (#37). Pick folder A and folder B by path
// and see what was added / removed / grew / shrank between them, WITHOUT first
// saving snapshots. The diff is computed entirely client-side from the current
// scan tree (`nodeById`) by comparing each folder's descendants keyed on their
// path RELATIVE to that folder, then rendered with the shared DiffView from the
// Compare tab.
//
// FLAG (scope): both folders must be within the CURRENT scan. We do NOT scan a
// path on demand here — if a typed path isn't in the loaded tree we surface a
// clear message telling the user to scan a common ancestor first. (Reusing the
// streaming scan API per side would be possible but is intentionally out of
// scope for this self-contained, no-network diff.)

const ROW_CAP = 2000;

interface FolderDiffTabProps {
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  onNavigate: (id: number) => void;
}

/** Strip a folder prefix from a descendant path → its relative remainder. */
function relativePath(folderPath: string, fullPath: string): string {
  const rest = fullPath.slice(folderPath.length);
  return rest.replace(/^[\\/]+/, "");
}

interface Entry {
  rel: string;     // original-cased relative path (for display)
  abs: string;     // absolute path (for reveal-in-tree)
  size: number;
  dir: boolean;
}

/** Build relativePathKey(lowercased) → entry for every descendant of `folder`. */
function buildEntryMap(folder: NodeRecord, nodeById: Map<number, NodeRecord>): Map<string, Entry> {
  const map = new Map<string, Entry>();
  const stack = [...folder.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id == null) continue;
    const node = nodeById.get(id);
    if (!node || !node.path) continue;
    const rel = relativePath(folder.path, node.path);
    if (rel) map.set(rel.toLowerCase(), { rel, abs: node.path, size: node.size, dir: node.dir });
    if (node.children.length) stack.push(...node.children);
  }
  return map;
}

export function FolderDiffTab({ data, nodeById, onNavigate }: FolderDiffTabProps) {
  const rootPath = data?.rootPath ?? "";
  const [pathA, setPathA] = useState(rootPath);
  const [pathB, setPathB] = useState("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState("");

  // Lowercased absolute path → node id, so a typed/pasted folder path resolves
  // to a node in the loaded scan (and so a diff row can reveal in the tree).
  const pathToId = useMemo(() => {
    const m = new Map<string, number>();
    for (const node of nodeById.values()) if (node.path) m.set(node.path.toLowerCase(), node.id);
    return m;
  }, [nodeById]);

  const resolveFolder = useCallback((raw: string): NodeRecord | null | "notfound" | "notdir" => {
    const p = raw.trim().replace(/[\\/]+$/, "");
    if (!p) return null;
    const id = pathToId.get(p.toLowerCase());
    if (id == null) return "notfound";
    const node = nodeById.get(id);
    if (!node) return "notfound";
    if (!node.dir) return "notdir";
    return node;
  }, [pathToId, nodeById]);

  const handleCompare = useCallback(() => {
    setError("");
    setDiff(null);
    const a = resolveFolder(pathA);
    const b = resolveFolder(pathB);
    if (a === null || b === null) { setError("Enter two folder paths to compare."); return; }
    if (a === "notfound" || b === "notfound") {
      setError("Both folders must be inside the current scan. Scan a common parent folder, then compare.");
      return;
    }
    if (a === "notdir" || b === "notdir") { setError("Both paths must be folders, not files."); return; }
    if (a.id === b.id) { setError("Pick two different folders."); return; }

    const mapA = buildEntryMap(a, nodeById);
    const mapB = buildEntryMap(b, nodeById);

    const rows: DiffRow[] = [];
    let added = 0, removed = 0, grown = 0, shrunk = 0;
    for (const [key, eb] of mapB) {
      const ea = mapA.get(key);
      if (!ea) {
        added++;
        rows.push({ path: eb.abs, name: eb.rel, status: "added", oldSize: 0, newSize: eb.size, delta: eb.size, dir: eb.dir });
      } else if (ea.size !== eb.size) {
        const delta = eb.size - ea.size;
        const status: DiffStatus = delta >= 0 ? "grown" : "shrunk";
        if (delta >= 0) grown++; else shrunk++;
        rows.push({ path: eb.abs, name: eb.rel, status, oldSize: ea.size, newSize: eb.size, delta, dir: eb.dir });
      }
    }
    for (const [key, ea] of mapA) {
      if (!mapB.has(key)) {
        removed++;
        rows.push({ path: ea.abs, name: ea.rel, status: "removed", oldSize: ea.size, newSize: 0, delta: -ea.size, dir: ea.dir });
      }
    }

    rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    const rowCount = rows.length;
    const capped = rowCount > ROW_CAP;
    const shown = capped ? rows.slice(0, ROW_CAP) : rows;

    setDiff({
      // DiffView only reads `summary` + `rows`; the a/b metas are synthetic here.
      a: { id: "A", createdAt: 0, path: a.path, total: a.size, fileCount: a.files },
      b: { id: "B", createdAt: 0, path: b.path, total: b.size, fileCount: b.files },
      rows: shown,
      summary: {
        added, removed, grown, shrunk,
        oldTotal: a.size, newTotal: b.size, netDelta: b.size - a.size,
        rowCount, capped,
      },
    });
  }, [pathA, pathB, resolveFolder, nodeById]);

  const revealRow = useCallback((row: DiffRow) => {
    const id = pathToId.get(row.path.toLowerCase());
    if (id != null) onNavigate(id);
  }, [pathToId, onNavigate]);

  return (
    <div className="compare-tab">
      <div className="compare-controls">
        <div className="compare-pick folder-diff-pick">
          <label>
            <span>Folder A (base)</span>
            <input
              className="snap-input"
              value={pathA}
              onChange={(e) => setPathA(e.target.value)}
              placeholder={rootPath || "C:\\path\\to\\folder"}
              spellCheck={false}
            />
          </label>
          <Icon name="chevron-right" size={14} className="compare-arrow" />
          <label>
            <span>Folder B (compare to)</span>
            <input
              className="snap-input"
              value={pathB}
              onChange={(e) => setPathB(e.target.value)}
              placeholder="C:\\path\\to\\other\\folder"
              spellCheck={false}
            />
          </label>
          <button className="compare-btn primary" onClick={handleCompare} disabled={!pathA.trim() || !pathB.trim()}>
            Compare
          </button>
        </div>
        <p className="folder-diff-hint">
          Compares two folders directly — no snapshots needed. Both folders must be inside the current scan
          (paths are matched against the loaded tree).
        </p>
      </div>

      {error && <div className="compare-error">{error}</div>}

      {diff && <DiffView diff={diff} onRevealRow={revealRow} canReveal={(p) => pathToId.has(p.toLowerCase())} />}

      {!diff && !error && (
        <EmptyState
          icon="bar-chart"
          title="Compare two folders"
          hint="Enter two folder paths from the current scan, then press Compare to see what was added, removed, grew or shrank between them."
        />
      )}
    </div>
  );
}
