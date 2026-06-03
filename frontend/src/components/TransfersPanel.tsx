// Transfer manager panel (F10).
//
// A small, dismissible panel anchored above the status bar that surfaces the
// move/copy operations tracked in lib/transfers. Native shell moves/copies show
// their own granular OS progress dialog, so each queue entry reports coarse
// status (running → done/error) and the panel header shows an overall
// "N running" indicator with a spinner. The panel hides itself when the queue is
// empty so it never occupies space at rest.

import { useTransfers, dismissTransfer, clearFinishedTransfers, type TransferItem } from "../lib/transfers";
import { Icon } from "./Icon";

function statusIcon(t: TransferItem) {
  if (t.status === "running") return <span className="xfer-spinner" aria-label="running" />;
  if (t.status === "error") return <Icon name="warning" size={13} />;
  return <Icon name="check" size={13} />;
}

export function TransfersPanel() {
  const items = useTransfers();
  if (items.length === 0) return null;

  const running = items.filter((t) => t.status === "running").length;
  const failed = items.filter((t) => t.status === "error").length;

  return (
    <div className="xfer-panel" role="status" aria-live="polite">
      <div className="xfer-head">
        <Icon name="arrow-repeat" size={13} />
        <span className="xfer-title">
          {running > 0
            ? `Transferring — ${running} running`
            : failed > 0
              ? `Transfers — ${failed} failed`
              : "Transfers complete"}
        </span>
        <span className="spacer" />
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
            {t.status !== "running" && (
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
