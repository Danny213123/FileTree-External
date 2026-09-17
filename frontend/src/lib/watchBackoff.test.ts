import { describe, expect, it } from "vitest";

import { WATCH_BACKOFF_MAX_MS, WATCH_DEBOUNCE_MS, nextWatchDelay } from "./watchBackoff";

describe("nextWatchDelay", () => {
  it("stays responsive for an isolated change", () => {
    expect(nextWatchDelay(WATCH_DEBOUNCE_MS, 10_000)).toBe(WATCH_DEBOUNCE_MS);
  });

  it("widens while the churn keeps coming", () => {
    let delay = WATCH_DEBOUNCE_MS;
    const widened: number[] = [];
    for (let flush = 0; flush < 6; flush += 1) {
      // Each flush lands one window after the last: a folder being rewritten.
      delay = nextWatchDelay(delay, delay);
      widened.push(delay);
    }
    expect(widened).toEqual([120, 240, 480, 960, 1920, WATCH_BACKOFF_MAX_MS]);
  });

  it("never waits longer than the ceiling", () => {
    expect(nextWatchDelay(WATCH_BACKOFF_MAX_MS, 0)).toBe(WATCH_BACKOFF_MAX_MS);
    expect(nextWatchDelay(WATCH_BACKOFF_MAX_MS * 10, 0)).toBe(WATCH_BACKOFF_MAX_MS);
  });

  it("snaps back as soon as the churn stops", () => {
    // Widened to a second, then three windows of quiet.
    expect(nextWatchDelay(1_000, 3_500)).toBe(WATCH_DEBOUNCE_MS);
  });

  it("treats a delay below the floor as the floor", () => {
    expect(nextWatchDelay(0, 0)).toBe(WATCH_DEBOUNCE_MS * 2);
  });
});
