import type { ExtensionStat } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";

interface ExtensionsTabProps {
  extensionStats: ExtensionStat[];
}

export function ExtensionsTab({ extensionStats }: ExtensionsTabProps) {
  const max = extensionStats.reduce((m, i) => Math.max(m, i.bytes), 1);

  return (
    <div className="bar-list">
      {extensionStats.length === 0 && <div className="empty">No extension data</div>}
      {extensionStats.map((item) => (
        <div className="bar-row" key={item.ext}>
          <header>
            <strong>{item.ext || "(no ext)"}</strong>
            <span>{formatBytes(item.bytes)} · {formatCount(item.files)} files</span>
          </header>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{ "--bar": `${(item.bytes / max) * 100}%` } as React.CSSProperties}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
