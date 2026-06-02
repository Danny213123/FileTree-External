import type { NodeRecord } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { EmptyState } from "./EmptyState";
import { FileIcon } from "./FileIcon";
import { FOLDER_COLOR } from "../lib/typeColors";

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
    return (
      <EmptyState
        icon="folder"
        title="No folders to rank"
        hint="This scan didn't turn up any subfolders to list here yet."
      />
    );
  }
  // Bars are proportional to the largest folder in the list.
  const max = dirIds.reduce((m, id) => Math.max(m, nodeById.get(id)?.size ?? 0), 1);
  return (
    <div className="item-list">
      {dirIds.map((id) => {
        const node = nodeById.get(id);
        if (!node) return null;
        const pct = (node.size / max) * 100;
        return (
          <div
            className="item-row item-row-ranked"
            key={id}
            style={{ cursor: "pointer" }}
            onClick={() => onNavigate(id)}
          >
            <span className="item-rank-icon">
              <FileIcon ext="" isDir isBundle={false} />
            </span>
            <div className="item-row-content">
              <header>
                <strong title={node.path}>{node.name}</strong>
                <span>{formatBytes(node.size)}</span>
              </header>
              <small>
                {formatCount(node.files)} files · {formatCount(node.folders)} folders · {node.path}
              </small>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ "--bar": `${pct}%`, "--bar-color": FOLDER_COLOR } as React.CSSProperties}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
