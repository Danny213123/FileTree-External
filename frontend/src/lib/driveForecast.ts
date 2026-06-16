// Disk-space forecast (#15).
//
// Persists periodic free-space samples per drive in localStorage and, once
// there are >=2 samples spanning enough time, linear-extrapolates the trend to
// 0 free to estimate "~X days until full". The estimate is hidden when free
// space is flat/growing or there aren't enough samples — it never guesses from
// a single point. Everything is best-effort and never throws (a corrupt /
// unavailable store degrades to "no forecast").

interface Sample {
  /** Epoch milliseconds. */
  t: number;
  /** Free bytes at that time. */
  free: number;
}

const STORE_KEY = "filetree.driveSamples.v1";
// Don't record a fresh sample more often than this (per drive) — keeps the
// series sparse so it spans real elapsed time rather than a render burst.
const MIN_SAMPLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
// Need at least this much elapsed time across samples before extrapolating, so
// a noisy short window can't produce a wild estimate.
const MIN_SPAN_MS = 60 * 60 * 1000; // 1 hour
const MAX_SAMPLES_PER_DRIVE = 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normRoot(root: string): string {
  return root.replace(/[\\/]+$/, "").toUpperCase();
}

function readStore(): Record<string, Sample[]> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, Sample[]>;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, Sample[]>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* quota / unavailable — ignore */
  }
}

/**
 * Record a free-space sample for a drive. Throttled to one sample per
 * {@link MIN_SAMPLE_INTERVAL_MS} per drive so the series tracks real elapsed
 * time. Safe to call on every drive-list refresh.
 */
export function recordSample(root: string, free: number, total: number): void {
  if (!root || !(free >= 0) || !(total > 0)) return;
  const key = normRoot(root);
  const store = readStore();
  const samples = store[key] ?? [];
  const now = Date.now();
  const last = samples[samples.length - 1];
  if (last && now - last.t < MIN_SAMPLE_INTERVAL_MS) {
    // Within the throttle window — refresh the latest free value in place so
    // the most recent reading is accurate without growing the series.
    last.free = free;
  } else {
    samples.push({ t: now, free });
  }
  if (samples.length > MAX_SAMPLES_PER_DRIVE) {
    samples.splice(0, samples.length - MAX_SAMPLES_PER_DRIVE);
  }
  store[key] = samples;
  writeStore(store);
}

export interface DriveForecast {
  /** Whole days until the drive is projected to hit 0 free. */
  days: number;
  /** Bytes/day the drive is losing (positive = shrinking free space). */
  bytesPerDay: number;
}

/**
 * Linear-extrapolate the recent free-space trend to 0 free. Returns null when
 * there aren't enough samples, the samples don't span enough time, or free
 * space is flat/growing (nothing to forecast).
 */
export function forecast(root: string, currentFree: number): DriveForecast | null {
  const key = normRoot(root);
  const samples = readStore()[key];
  if (!samples || samples.length < 2) return null;

  const first = samples[0];
  const lastT = samples[samples.length - 1].t;
  if (lastT - first.t < MIN_SPAN_MS) return null;

  // Least-squares slope of free (bytes) vs time (ms). Negative slope ⇒ free
  // space declining. Use t relative to the first sample to keep magnitudes sane.
  const n = samples.length;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (const s of samples) {
    const x = s.t - first.t;
    const y = s.free;
    sumX += x; sumY += y; sumXX += x * x; sumXY += x * y;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slopePerMs = (n * sumXY - sumX * sumY) / denom; // bytes per ms

  if (slopePerMs >= 0) return null; // free space flat or growing — no forecast
  const bytesPerDay = -slopePerMs * MS_PER_DAY;
  if (bytesPerDay <= 0) return null;

  const days = currentFree / bytesPerDay;
  if (!isFinite(days) || days <= 0 || days > 100000) return null;
  return { days: Math.round(days), bytesPerDay };
}

/** Format a forecast as a short, human caption (e.g. "~12 days until full"). */
export function formatForecast(f: DriveForecast): string {
  if (f.days >= 730) return `~${Math.round(f.days / 365)} yr until full`;
  if (f.days >= 60) return `~${Math.round(f.days / 30)} mo until full`;
  return `~${f.days} day${f.days === 1 ? "" : "s"} until full`;
}
