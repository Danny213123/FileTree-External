import { formatCount } from "../utils/formatBytes";
import { formatDuration } from "../utils/formatDate";
import type { ScanResult } from "../api/types";
import type { ScanStatus, ScanProgress } from "../hooks/useScan";

interface StatusBarProps {
  scanResult: ScanResult | null;
  status: ScanStatus;
  errorMessage: string;
  progress: ScanProgress | null;
  visibleCount: number;
}

export function StatusBar({
  scanResult,
  status,
  errorMessage,
  progress,
  visibleCount,
}: StatusBarProps) {
  let statusText = "";
  if (status === "scanning") {
    statusText = progress
      ? `Scanning… ${formatCount(progress.nodes)} items found`
      : "Scanning…";
  } else if (status === "cancelled") {
    statusText = "Cancelled";
  } else if (status === "error") {
    statusText = `Error: ${errorMessage}`;
  } else if (scanResult) {
    statusText = `Scanned ${formatCount(scanResult.nodeCount)} nodes in ${formatDuration(scanResult.elapsedMs)}`;
    if (scanResult.errorCount > 0)
      statusText += ` · ${formatCount(scanResult.errorCount)} errors`;
  }

  return (
    <div className="statusbar">
      <span>{statusText}</span>
      {scanResult && status !== "scanning" && (
        <span>
          {formatCount(visibleCount)} items shown · {scanResult.threadCount} threads
        </span>
      )}
      {status === "scanning" && (
        <div className="status-progress-bar">
          <div className="status-progress-fill" />
        </div>
      )}
    </div>
  );
}
