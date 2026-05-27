import type { NodeRecord } from "../api/types";
import { formatBytes } from "../utils/formatBytes";

interface TopFilesTabProps {
  topFileIds: number[];
  nodeById: Map<number, NodeRecord>;
  onNavigate: (id: number) => void;
}

export function TopFilesTab({ topFileIds, nodeById, onNavigate }: TopFilesTabProps) {
  if (topFileIds.length === 0) {
    return <div className="empty">No files</div>;
  }
  return (
    <div className="item-list">
      {topFileIds.map((id) => {
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
            <small>{node.path}</small>
          </div>
        );
      })}
    </div>
  );
}
