import type { AgeStat } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { ageColor } from "../lib/typeColors";

interface AgeTabProps {
  ageStats: AgeStat[];
}

export function AgeTab({ ageStats }: AgeTabProps) {
  const max = ageStats.reduce((m, i) => Math.max(m, i.bytes), 1);

  return (
    <div className="bar-list">
      {ageStats.length === 0 && <div className="empty">No age data</div>}
      {ageStats.map((item, i) => (
        <div className="bar-row" key={item.label}>
          <header>
            <strong>{item.label}</strong>
            <span>{formatBytes(item.bytes)} · {formatCount(item.files)} files</span>
          </header>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ "--bar": `${(item.bytes / max) * 100}%`, "--bar-color": ageColor(item.label, i, ageStats.length) } as React.CSSProperties}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
