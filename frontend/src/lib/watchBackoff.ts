// How long to wait before re-listing directories the watcher reported.
//
// A watcher batch costs one directory listing per changed directory, and a
// listing is the whole directory: ~37 KB of renderer allocation for a folder of
// 250 files, whether one file changed or all of them. That is fine for ordinary
// editing, and ruinous during a compression run that rewrites a folder for
// hours — the renderer's peak allocation sets its process footprint for the
// rest of the session, and Chromium never hands those pages back.
//
// So the window widens while changes keep arriving and snaps back the moment
// they stop: prompt for a file someone just saved, patient for a folder being
// churned by a background job.

/** Merges adjacent native batches without making a visible change wait. */
export const WATCH_DEBOUNCE_MS = 60;
/** Ceiling for sustained churn: still refreshes, just not many times a second. */
export const WATCH_BACKOFF_MAX_MS = 2_000;

/**
 * The delay for the next flush.
 *
 * `sinceLastFlushMs` is the gap since the previous flush; a flush landing on
 * the heels of the last one means the churn is ongoing, so the window doubles.
 * Anything quieter is treated as a fresh burst and resets to the default.
 */
export function nextWatchDelay(currentMs: number, sinceLastFlushMs: number): number {
  const current = Math.max(WATCH_DEBOUNCE_MS, Math.min(WATCH_BACKOFF_MAX_MS, currentMs));
  // Three windows of quiet is the line between "still churning" and "settled".
  const stillChurning = sinceLastFlushMs < current * 3;
  if (!stillChurning) return WATCH_DEBOUNCE_MS;
  return Math.min(WATCH_BACKOFF_MAX_MS, current * 2);
}
