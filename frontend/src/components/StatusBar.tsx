import { useSyncExternalStore } from "react";
import { formatCount } from "../utils/formatBytes";
import { formatDuration } from "../utils/formatDate";
import type { ScanResult } from "../api/types";
import type { ScanStatus, ProgressStore } from "../hooks/useScan";
import { subscribeUndo, undoVersion, undoDepth, peekUndoLabel } from "../lib/undo";
import { Icon } from "./Icon";

interface StatusBarProps {
  scanResult: ScanResult | null;
  status: ScanStatus;
  errorMessage: string;
  /** The focused pane's live progress store (or null when no pane is focused).
   *  Subscribed below so scan-progress ticks re-render only this bar. */
  progressStore: ProgressStore | null;
  visibleCount: number;
  scanPath?: string;
  /** Run the unified undo (the same handler Ctrl+Z runs). Renders the Undo pill. */
  onUndo?: () => void;
}

// Stable no-op subscribe / null snapshot so useSyncExternalStore can be called
// unconditionally even when there's no store yet (null focused pane).
const NOOP_SUBSCRIBE = () => () => {};
const GET_NULL = () => null;

export function StatusBar({
  scanResult,
  status,
  errorMessage,
  progressStore,
  visibleCount,
  scanPath,
  onUndo,
}: StatusBarProps) {
  const progress = useSyncExternalStore(
    progressStore?.subscribe ?? NOOP_SUBSCRIBE,
    progressStore?.get ?? GET_NULL,
  );
  // Re-render on undo-stack changes (push/pop) so the Undo pill reflects depth.
  useSyncExternalStore(subscribeUndo, undoVersion);
  const canUndo = undoDepth() > 0;
  const undoLabel = peekUndoLabel();
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
        {onUndo && canUndo && (
          <button
            className="sb-item sb-undo"
            title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)"}
            onClick={onUndo}
          >
            <Icon name="arrow-repeat" size={12} /> Undo
          </button>
        )}
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
