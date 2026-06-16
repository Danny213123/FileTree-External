// Transfer manager panel (F10).
//
// A small, dismissible panel anchored above the status bar that surfaces the
// move/copy operations tracked in lib/transfers. Native shell moves/copies show
// their own granular OS progress dialog, so each queue entry reports coarse
// status (running → done/error) and the panel header shows an overall
// "N running" indicator with a spinner. The panel hides itself when the queue is
// empty so it never occupies space at rest.

import {
  useTransfers,
  useTransfersPaused,
  dismissTransfer,
  clearFinishedTransfers,
  pauseTransfers,
  resumeTransfers,
  type TransferItem,
} from "../lib/transfers";
import { Icon } from "./Icon";

function statusIcon(t: TransferItem) {
  if (t.status === "running") return <span className="xfer-spinner" aria-label="running" />;
  if (t.status === "queued") return <Icon name="clock-history" size={13} />;
  if (t.status === "error") return <Icon name="warning" size={13} />;
  return <Icon name="check" size={13} />;
}

export function TransfersPanel() {
  const items = useTransfers();
  const paused = useTransfersPaused();
  // Keep the panel mounted while paused so the Resume control stays reachable.
  if (items.length === 0 && !paused) return null;

  const running = items.filter((t) => t.status === "running").length;
  const queued = items.filter((t) => t.status === "queued").length;
  const failed = items.filter((t) => t.status === "error").length;

  // Pause/resume gates the QUEUE only — an in-flight native shell transfer keeps
  // running (the OS owns its progress dialog; there is no mid-file pause hook).
  const title = paused
    ? queued > 0
      ? `Paused — ${queued} waiting`
      : "Paused"
    : running > 0
      ? `Transferring — ${running} running${queued > 0 ? `, ${queued} queued` : ""}`
      : queued > 0
        ? `${queued} queued`
        : failed > 0
          ? `Transfers — ${failed} failed`
          : "Transfers complete";

  return (
    <div className="xfer-panel" role="status" aria-live="polite">
      <div className="xfer-head">
        <Icon name="arrow-repeat" size={13} />
        <span className="xfer-title">{title}</span>
        <span className="spacer" />
        {paused ? (
          <button
            className="xfer-clear"
            title="Resume queued transfers"
            onClick={resumeTransfers}
          >
            Resume
          </button>
        ) : (
          <button
            className="xfer-clear"
            title="Pause the queue (an in-flight transfer keeps running)"
            onClick={pauseTransfers}
          >
            Pause
          </button>
        )}
        <button className="xfer-clear" title="Clear finished" onClick={clearFinishedTransfers}>
          Clear
        </button>
      </div>
      <div className="xfer-list">
        {items.map((t) => (
          <div key={t.id} className={`xfer-item xfer-${t.status}`}>
            <span className="xfer-ico">{statusIcon(t)}</span>
            <span className="xfer-kind">{t.kind === "move" ? "Move" : "Copy"}</span>
            <span className="xfer-label" title={t.error || t.label}>
              {t.status === "error" ? `${t.label} — ${t.error}` : t.label}
            </span>
            <span className="spacer" />
            {(t.status === "done" || t.status === "error") && (
              <button className="xfer-dismiss" title="Dismiss" onClick={() => dismissTransfer(t.id)}>
                <Icon name="x" size={11} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
