import { formatCount } from "../utils/formatBytes";
import { formatDuration } from "../utils/formatDate";
import type { ScanResult } from "../api/types";
import type { ScanStatus, ScanProgress } from "../hooks/useScan";
import { Icon } from "./Icon";

interface StatusBarProps {
  scanResult: ScanResult | null;
  status: ScanStatus;
  errorMessage: string;
  progress: ScanProgress | null;
  visibleCount: number;
  scanPath?: string;
}

export function StatusBar({
  scanResult,
  status,
  errorMessage,
  progress,
  visibleCount,
  scanPath,
}: StatusBarProps) {
  let statusText = "Ready";
  if (status === "scanning") {
    statusText = progress ? `Scanning… ${formatCount(progress.nodes)} items` : "Scanning…";
  } else if (status === "cancelled") {
    statusText = "Cancelled";
  } else if (status === "error") {
    statusText = `Error: ${errorMessage}`;
  } else if (scanResult) {
    statusText = `Scanned ${formatCount(scanResult.nodeCount)} nodes in ${formatDuration(scanResult.elapsedMs)}`;
  }

  return (
    <div className="vsc-statusbar">
      <div className="sb-left">
        <span className="sb-item">
          {status === "scanning" ? (
            <span className="sb-progress"><div /></span>
          ) : (
            <Icon name="check" size={13} />
          )}
          {statusText}
        </span>
        {scanResult && scanResult.errorCount > 0 && (
          <span className="sb-item" title="Scan errors"><Icon name="warning" size={12} /> {formatCount(scanResult.errorCount)}</span>
        )}
      </div>
      <div className="sb-right">
        {scanResult && status !== "scanning" && (
          <>
            <span className="sb-item">{formatCount(visibleCount)} shown</span>
            <span className="sb-item">{scanResult.threadCount} threads</span>
          </>
        )}
        {scanPath && <span className="sb-item" title={scanPath}>{scanPath}</span>}
      </div>
    </div>
  );
}
