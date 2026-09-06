// Shared drive used/free capacity bar, used by both the Explorer side bar
// (SideBar) and the Duplicates scan-target picker (DuplicatesConfigPanel) so the
// two stay visually consistent. Warn/crit thresholds use the --warn/--danger
// theme tokens; the thicker (~8px) track and the used·free·% label live in
// global.css under .drive-cap.

import { useEffect, useMemo } from "react";
import { recordSample, forecast, formatForecast } from "../lib/driveForecast";

function fmtSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

interface DriveCapacityBarProps {
  /** Total volume capacity in bytes. <= 0 means the volume couldn't be queried
   *  (e.g. an empty optical drive) — the bar renders nothing in that case. */
  total: number;
  /** Free bytes on the volume. */
  free: number;
  /** Volume root (e.g. "C:\\"). When provided, the bar records periodic
   *  free-space samples and shows a subtle "~X days until full" forecast (#15)
   *  once the trend is clearly declining. Omit to disable the forecast. */
  root?: string;
  /** Side-bar variant: a hairline track plus the used percentage on one line,
   *  with the used/free split and the forecast moved into the tooltip. Keeps
   *  drive rows the same height as every other row in the panel. */
  compact?: boolean;
}

export function DriveCapacityBar({ total, free, root, compact = false }: DriveCapacityBarProps) {
  // Sample this drive's free space whenever the value changes (i.e. when the
  // drive list refreshes). The store throttles to one point per ~30 min so the
  // series spans real elapsed time across sessions.
  useEffect(() => {
    if (root && total > 0) recordSample(root, free, total);
  }, [root, free, total]);

  // Forecast is recomputed from the persisted samples; cheap (a handful of
  // points) and only shown when free space is clearly declining.
  const trend = useMemo(
    () => (root && total > 0 ? forecast(root, free) : null),
    [root, free, total],
  );

  if (total <= 0) return null;
  const used = Math.max(0, total - free);
  const pct = Math.min(100, (used / total) * 100);
  // 75% / 90% used → warn / crit, mirroring Explorer + TreeSize.
  const level = pct >= 90 ? "crit" : pct >= 75 ? "warn" : "";
  const fillClass = ["drive-cap-fill", level].filter(Boolean).join(" ");
  const forecastText = trend ? formatForecast(trend) : "";

  if (compact) {
    const detail = [`${fmtSize(used)} used · ${fmtSize(free)} free`, forecastText]
      .filter(Boolean)
      .join(" · ");
    return (
      <span className="drive-cap-compact" title={detail}>
        <span className="drive-cap-track">
          <span className={fillClass} style={{ width: `${pct}%`, display: "block" }} />
        </span>
        <span className={`drive-cap-pct${level ? ` ${level}` : ""}`}>{Math.round(pct)}%</span>
      </span>
    );
  }

  return (
    <div className="drive-cap">
      <div className="drive-cap-track">
        <div className={fillClass} style={{ width: `${pct}%` }} />
      </div>
      <div className="drive-cap-label">
        <span className="drive-cap-usage">{fmtSize(used)} used · {fmtSize(free)} free</span>
        <span className={`drive-cap-pct${level ? ` ${level}` : ""}`}>{Math.round(pct)}%</span>
      </div>
      {forecastText && (
        <div
          className="drive-cap-forecast"
          title={`Projected from recent free-space trend (~${fmtSize(trend!.bytesPerDay)}/day)`}
        >
          {forecastText}
        </div>
      )}
    </div>
  );
}
