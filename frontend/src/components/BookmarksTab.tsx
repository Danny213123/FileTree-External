import { formatBytes } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import type { NodeRecord, Unit } from "../api/types";

interface BookmarksTabProps {
  bookmarks: string[];
  nodeById: Map<number, NodeRecord>;
  unit: Unit;
  onNavigate: (id: number) => void;
  onScanPath: (path: string) => void;
  onRemove: (path: string) => void;
}

export function BookmarksTab({
  bookmarks,
  nodeById,
  unit,
  onNavigate,
  onScanPath,
  onRemove,
}: BookmarksTabProps) {
  if (bookmarks.length === 0) {
    return (
      <div className="empty">
        No bookmarks yet — click ☆ on any folder or file in the tree to add one.
      </div>
    );
  }

  // Build a path→node lookup from the loaded scan data.
  const nodeByPath = new Map<string, NodeRecord>();
  for (const node of nodeById.values()) {
    nodeByPath.set(node.path, node);
  }

  return (
    <div className="bookmarks-tab">
      <table className="bookmarks-table">
        <thead>
          <tr>
            <th className="bm-col-name">Path</th>
            <th className="bm-col-size">Size</th>
            <th className="bm-col-date">Last Modified</th>
            <th className="bm-col-action" />
          </tr>
        </thead>
        <tbody>
          {bookmarks.map((path) => {
            const node = nodeByPath.get(path);
            return (
              <tr key={path} className="bm-row">
                <td className="bm-cell bm-name">
                  {node ? (
                    <button
                      className="bm-navigate-btn"
                      title="Navigate to this item"
                      onClick={() => onNavigate(node.id)}
                    >
                      <span className={`kind ${node.dir ? "dir" : "file"}`} />
                      <span className="bm-path">{path}</span>
                    </button>
                  ) : (
                    <button
                      className="bm-navigate-btn bm-not-loaded"
                      title="Scan this path"
                      onClick={() => onScanPath(path)}
                    >
                      <span className="kind dir" />
                      <span className="bm-path">{path}</span>
                      <span className="bm-hint">(not in current scan — click to scan)</span>
                    </button>
                  )}
                </td>
                <td className="bm-cell bm-num">
                  {node ? formatBytes(node.size, unit) : "—"}
                </td>
                <td className="bm-cell bm-num">
                  {node?.modified ? formatDate(node.modified) : "—"}
                </td>
                <td className="bm-cell bm-action">
                  <button
                    className="bm-remove-btn"
                    title="Remove bookmark"
                    onClick={() => onRemove(path)}
                  >
                    ★
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
