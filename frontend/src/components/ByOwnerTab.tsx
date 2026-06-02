import { useMemo } from "react";
import type { ScanResult } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { ownerColor } from "../lib/typeColors";

interface ByOwnerTabProps {
  data: ScanResult;
}

interface OwnerAgg {
  owner: string;
  bytes: number;
  files: number;
}

/**
 * Aggregate file bytes/counts by owner. We sum FILES only (directory sizes are
 * roll-ups of their children, so counting them would double-count). Owners are
 * present only when the scan was run with "Collect owners" enabled.
 */
export function ByOwnerTab({ data }: ByOwnerTabProps) {
  const aggs = useMemo<OwnerAgg[]>(() => {
    const byOwner = new Map<string, OwnerAgg>();
    for (const node of data.nodes) {
      if (node.dir) continue;
      const owner = node.owner?.trim();
      if (!owner) continue;
      let agg = byOwner.get(owner);
      if (!agg) { agg = { owner, bytes: 0, files: 0 }; byOwner.set(owner, agg); }
      agg.bytes += node.size;
      agg.files += 1;
    }
    return [...byOwner.values()].sort((a, b) => b.bytes - a.bytes);
  }, [data]);

  if (aggs.length === 0) {
    return (
      <div className="empty">
        No owner data in this scan. Tick <strong>Owners</strong> in the Explorer
        toolbar (it re-scans this folder) to break size down by owner.
      </div>
    );
  }

  const max = aggs.reduce((m, a) => Math.max(m, a.bytes), 1);

  return (
    <div className="bar-list">
      {aggs.map((item) => (
        <div className="bar-row" key={item.owner}>
          <header>
            <strong title={item.owner}>{item.owner}</strong>
            <span>{formatBytes(item.bytes)} · {formatCount(item.files)} files</span>
          </header>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ "--bar": `${(item.bytes / max) * 100}%`, "--bar-color": ownerColor(item.owner) } as React.CSSProperties}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
