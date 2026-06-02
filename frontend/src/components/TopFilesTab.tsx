import type { NodeRecord } from "../api/types";
import { formatBytes } from "../utils/formatBytes";
import { EmptyState } from "./EmptyState";
import { FileIcon } from "./FileIcon";
import { colorForExt } from "../lib/typeColors";

interface TopFilesTabProps {
  topFileIds: number[];
  nodeById: Map<number, NodeRecord>;
  onNavigate: (id: number) => void;
}

export function TopFilesTab({ topFileIds, nodeById, onNavigate }: TopFilesTabProps) {
  if (topFileIds.length === 0) {
    return (
      <EmptyState
        icon="bar-chart"
        title="No files to rank"
        hint="This scan didn't turn up any files to list here yet."
      />
    );
  }
  // Scale every bar to the largest file in the list so the ranking reads as a
  // proportion of the biggest item (not the whole scan).
  const max = topFileIds.reduce((m, id) => Math.max(m, nodeById.get(id)?.size ?? 0), 1);
  return (
    <div className="item-list">
      {topFileIds.map((id) => {
        const node = nodeById.get(id);
        if (!node) return null;
        const pct = (node.size / max) * 100;
        const color = colorForExt(node.extension);
        return (
          <div
            className="item-row item-row-ranked"
            key={id}
            style={{ cursor: "pointer" }}
            onClick={() => onNavigate(id)}
          >
            <span className="item-rank-icon">
              <FileIcon ext={node.extension ?? ""} isDir={false} isBundle={false} />
            </span>
            <div className="item-row-content">
              <header>
                <strong title={node.path}>{node.name}</strong>
                <span>{formatBytes(node.size)}</span>
              </header>
              <small>{node.path}</small>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ "--bar": `${pct}%`, "--bar-color": color } as React.CSSProperties}
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
