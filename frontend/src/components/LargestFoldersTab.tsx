import type { NodeRecord } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";

interface LargestFoldersTabProps {
  // Node ids of the largest directories (ScanResult.largestDirs), computed
  // server-side and capped. Mirrors TopFilesTab but for folders, so clicking a
  // row reveals/selects that directory in the tree.
  dirIds: number[];
  nodeById: Map<number, NodeRecord>;
  onNavigate: (id: number) => void;
}

export function LargestFoldersTab({ dirIds, nodeById, onNavigate }: LargestFoldersTabProps) {
  if (dirIds.length === 0) {
    return <div className="empty">No folders</div>;
  }
  return (
    <div className="item-list">
      {dirIds.map((id) => {
        const node = nodeById.get(id);
        if (!node) return null;
        return (
          <div
            className="item-row"
            key={id}
            style={{ cursor: "pointer" }}
            onClick={() => onNavigate(id)}
          >
            <header>
              <strong title={node.path}>{node.name}</strong>
              <span>{formatBytes(node.size)}</span>
            </header>
            <small>
              {formatCount(node.files)} files · {formatCount(node.folders)} folders · {node.path}
            </small>
          </div>
        );
      })}
    </div>
  );
}
