// Shared drive used/free capacity bar, used by both the Explorer side bar
// (SideBar) and the Duplicates scan-target picker (DuplicatesConfigPanel) so the
// two stay visually consistent. Warn/crit thresholds use the --warn/--danger
// theme tokens; the thicker (~8px) track and the used·free·% label live in
// global.css under .drive-cap.

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
}

export function DriveCapacityBar({ total, free }: DriveCapacityBarProps) {
  if (total <= 0) return null;
  const used = Math.max(0, total - free);
  const pct = Math.min(100, (used / total) * 100);
  // 75% / 90% used → warn / crit, mirroring Explorer + TreeSize.
  const level = pct >= 90 ? "crit" : pct >= 75 ? "warn" : "";
  const fillClass = ["drive-cap-fill", level].filter(Boolean).join(" ");
  return (
    <div className="drive-cap">
      <div className="drive-cap-track">
        <div className={fillClass} style={{ width: `${pct}%` }} />
      </div>
      <div className="drive-cap-label">
        <span className="drive-cap-usage">{fmtSize(used)} used · {fmtSize(free)} free</span>
        <span className={`drive-cap-pct${level ? ` ${level}` : ""}`}>{Math.round(pct)}%</span>
      </div>
    </div>
  );
}
