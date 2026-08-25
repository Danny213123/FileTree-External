export interface ProgressSample {
  at: number;
  workBytes: number;
}

export function weightedProgress(
  totalBytes: number,
  workCompletedBytes: number,
  processedFiles: number,
  totalFiles: number,
): number {
  const ratio = totalBytes > 0
    ? workCompletedBytes / totalBytes
    : processedFiles / Math.max(1, totalFiles);
  return Math.max(0, Math.min(100, ratio * 100));
}

export function addProgressSample(
  samples: ProgressSample[],
  sample: ProgressSample,
  maxSamples = 30,
): ProgressSample[] {
  const last = samples[samples.length - 1];
  if (last && sample.at <= last.at) return samples;
  return [...samples, sample].slice(-maxSamples);
}

export function smoothedRemainingMs(
  samples: ProgressSample[],
  totalBytes: number,
  workCompletedBytes: number,
): number | null {
  if (samples.length < 3 || totalBytes <= workCompletedBytes) return null;
  let rate = 0;
  let accepted = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const elapsed = samples[index].at - samples[index - 1].at;
    const work = samples[index].workBytes - samples[index - 1].workBytes;
    if (elapsed <= 0 || work <= 0) continue;
    const instant = work / elapsed;
    rate = accepted === 0 ? instant : rate * 0.7 + instant * 0.3;
    accepted += 1;
  }
  if (accepted < 2 || rate <= 0) return null;
  return (totalBytes - workCompletedBytes) / rate;
}

export function estimateRemainingFromPercent(elapsedMs: number, percent: number): number | null {
  if (elapsedMs < 2_000 || percent < 2 || percent >= 100) return null;
  return elapsedMs * (100 - percent) / percent;
}

export function progressConfidence(processed: number, total: number): "Low" | "Medium" | "High" {
  if (processed >= 20 || processed / Math.max(1, total) >= 0.2) return "High";
  if (processed >= 5) return "Medium";
  return "Low";
}

export function activityTier(status: string, finishedAt: number, now: number): number {
  if (status === "running") return 0;
  if (finishedAt > 0 && now - finishedAt <= 15_000) return 1;
  return 2;
}

export function telemetryText(value: number | null | undefined, suffix = ""): string {
  return value == null ? "Unavailable" : `${value.toFixed(value < 10 ? 1 : 0)}${suffix}`;
}
