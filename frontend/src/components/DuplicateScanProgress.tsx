import type { DuplicatesController } from "../hooks/useDuplicates";
import { activeScanStep, DUPLICATE_SCAN_STEPS, hashingTitle, scanStepStatus } from "../lib/duplicatesScanUi";

export function DuplicateScanProgress({ ctrl }: { ctrl: DuplicatesController }) {
  if (ctrl.scanState !== "scanning") return null;
  const active = activeScanStep(ctrl.phase, ctrl.progress.stage);
  const fraction = ctrl.progress.fraction ?? (ctrl.phase === "hashing" && ctrl.progress.hashing > 0 ? ctrl.progress.hashed / ctrl.progress.hashing : null);
  const percent = Math.floor(Math.max(0, Math.min(1, fraction ?? 0)) * 100);
  const percentLabel = percent === 0 && (ctrl.progress.bytesRead ?? 0) > 0 ? "<1%" : `${percent}%`;
  const determinate = fraction != null;
  const description = ctrl.phase === "hashing" && ctrl.progress.hashing > 0
    ? `${ctrl.progress.hashing.toLocaleString()} candidates, ${percentLabel}`
    : ctrl.phase === "grouping" && determinate ? `${percentLabel}, ${ctrl.progress.hashed.toLocaleString()} / ${((ctrl.progress.stage === "finalizing" || ctrl.progress.stage === "reviewing") ? ctrl.progress.hashing : ctrl.progress.scanned).toLocaleString()} processed`
    : ctrl.progress.scanned > 0 ? `${ctrl.progress.scanned.toLocaleString()} indexed` : "starting";
  return <div className="dg-scan" role="status" aria-live="polite">
    <div className="dg-scan-steps">{DUPLICATE_SCAN_STEPS.filter(step => ctrl.criteria.content.enabled || step.id === "indexing" || step.id === "grouping" || step.id === "reviewing" || step.id === "finalizing").map(step =>
      <span key={step.id} className={`dg-scan-step ${scanStepStatus(step.id, active)}`}>{step.label}</span>
    )}</div>
    <div className="dg-scan-line">
      <span className="dg-scan-text">{hashingTitle(ctrl.phase, ctrl.progress)} · {description}</span>
      <div className="df-progress-track dg-scan-track" role="progressbar" aria-label="Duplicate scan progress"
        aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
        aria-valuetext={ctrl.phase === "hashing" && ctrl.progress.hashing > 0 ? `${percentLabel} of ${ctrl.progress.hashing} candidates processed` : ctrl.phase === "grouping" ? `${percentLabel} grouped` : `${percentLabel}; ${ctrl.progress.scanned} items indexed`}>
        <div key={active} className={`df-progress-bar ${determinate ? "df-progress-bar-determinate" : "df-progress-bar-sweep"}`}
          style={determinate ? {width: `${percent}%`} : undefined} />
      </div>
    </div>
    <button type="button" className="dg-btn dg-btn-danger" onClick={ctrl.stopScan}>Stop</button>
  </div>;
}
