import { formatBytes } from "../utils/formatBytes";
import type { DupePhase } from "../hooks/useDuplicates";
import type { DupeProgress } from "../hooks/useDuplicates";

export type DuplicateScanStep =
  | "indexing"
  | "fingerprinting"
  | "sampling"
  | "hashing"
  | "grouping"
  | "reviewing"
  | "finalizing";

export const DUPLICATE_SCAN_STEPS: { id: DuplicateScanStep; label: string }[] = [
  { id: "indexing", label: "Index" },
  { id: "fingerprinting", label: "Fingerprint" },
  { id: "sampling", label: "Sample" },
  { id: "hashing", label: "Hash" },
  { id: "grouping", label: "Group" },
  { id: "reviewing", label: "Register" },
  { id: "finalizing", label: "Results" },
];

export function hashingPercent(progress: DupeProgress): number {
  if (progress.fraction != null) return Math.floor(Math.max(0, Math.min(1, progress.fraction)) * 100);
  return progress.hashing > 0
    ? Math.min(100, Math.floor((progress.hashed / progress.hashing) * 100))
    : 0;
}

export function activeScanStep(phase: DupePhase, stage?: string): DuplicateScanStep {
  if (stage === "reviewing" || stage === "finalizing") return stage;
  if (phase === "grouping") return "grouping";
  if (phase === "hashing") {
    if (stage === "fingerprinting") return "fingerprinting";
    if (stage === "sampling") return "sampling";
    return "hashing";
  }
  return "indexing";
}

export function scanStepStatus(
  step: DuplicateScanStep,
  active: DuplicateScanStep,
): "done" | "active" | "pending" {
  const order = DUPLICATE_SCAN_STEPS.map((item) => item.id);
  const stepIndex = order.indexOf(step);
  const activeIndex = order.indexOf(active);
  if (stepIndex < activeIndex) return "done";
  if (stepIndex === activeIndex) return "active";
  return "pending";
}

export function hashingTitle(phase: DupePhase, progress: DupeProgress): string {
  if (progress.stage === "reviewing") return "Registering matches...";
  if (progress.stage === "finalizing") return "Preparing results...";  if (phase === "grouping") return "Grouping matches…";
  if (progress.stage === "fingerprinting") return "Fingerprinting candidates…";
  if (progress.stage === "sampling") return "Sampling likely matches…";
  if (phase === "hashing") {
    return progress.bytesRead ? `Hashing contents… ${formatBytes(progress.bytesRead, "auto")} read` : progress.hashing > 0 ? "Hashing candidate files…" : "Preparing candidate hashes…";
  }
  return progress.scanned > 0 ? "Collecting files…" : "Starting file scan…";
}

export function hashingDeterminate(phase: DupePhase, progress: DupeProgress): boolean {
  return progress.fraction != null || (phase === "hashing" && progress.hashing > 0 && progress.hashed > 0);
}

/** Phase-weighted estimate; unknown work stays put rather than simulating progress. */
export function overallScanPercent(phase: DupePhase, progress: DupeProgress, metadata: boolean, done: boolean): number {
  if (done) return 100;
  const fraction = Math.max(0, Math.min(1, progress.fraction ?? (progress.hashing ? progress.hashed / progress.hashing : 0)));
  if (progress.stage === "done") return 99;
  if (phase === "aggregating") return 20 * fraction;
  if (phase === "grouping") return metadata ? 20 + 79 * fraction : 99;
  if (phase === "hashing") return 20 + 78 * fraction;
  return 0;
}

export function scanDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  if (rounded < 3600) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  return `${Math.floor(rounded / 3600)}h ${Math.floor((rounded % 3600) / 60)}m`;
}

export function scanEta(elapsed: number, percent: number, stale: boolean): string {
  if (percent >= 100) return "Complete";
  if (elapsed < 5 || percent < 1 || stale) return "Estimating…";
  return `~${scanDuration(elapsed * (100 - percent) / percent)} remaining`;
}
