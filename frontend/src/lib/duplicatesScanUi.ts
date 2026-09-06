import type { DupePhase } from "../hooks/useDuplicates";
import type { DupeProgress } from "../hooks/useDuplicates";

export type DuplicateScanStep =
  | "indexing"
  | "fingerprinting"
  | "sampling"
  | "hashing"
  | "grouping";

export const DUPLICATE_SCAN_STEPS: { id: DuplicateScanStep; label: string }[] = [
  { id: "indexing", label: "Index" },
  { id: "fingerprinting", label: "Fingerprint" },
  { id: "sampling", label: "Sample" },
  { id: "hashing", label: "Hash" },
  { id: "grouping", label: "Group" },
];

export function hashingPercent(progress: DupeProgress): number {
  return progress.hashing > 0
    ? Math.min(100, Math.floor((progress.hashed / progress.hashing) * 100))
    : 0;
}

export function activeScanStep(phase: DupePhase, stage?: string): DuplicateScanStep {
  if (phase === "grouping" || stage === "finalizing") return "grouping";
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
  if (phase === "grouping") return "Grouping matches…";
  if (progress.stage === "fingerprinting") return "Fingerprinting candidates…";
  if (progress.stage === "sampling") return "Sampling likely matches…";
  if (progress.stage === "finalizing") return "Finalizing candidate groups…";
  if (phase === "hashing") {
    return progress.hashing > 0 ? "Hashing candidate files…" : "Preparing candidate hashes…";
  }
  return progress.scanned > 0 ? "Collecting files…" : "Starting file scan…";
}

export function hashingDeterminate(phase: DupePhase, progress: DupeProgress): boolean {
  return phase === "hashing" && progress.hashing > 0 && progress.hashed > 0;
}
