import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  activityTier,
  addProgressSample,
  estimateRemainingFromPercent,
  progressConfidence,
  smoothedRemainingMs,
  telemetryText,
  weightedProgress,
} from "./compressionMetrics";

describe("compression progress metrics", () => {
  it("prefers size-weighted progress and falls back to file counts", () => {
    expect(weightedProgress(1_000, 250, 9, 10)).toBe(25);
    expect(weightedProgress(0, 0, 9, 10)).toBe(90);
  });

  it("smooths a rolling byte rate and waits for enough samples", () => {
    const sparse = [{ at: 0, workBytes: 0 }, { at: 1_000, workBytes: 100 }];
    expect(smoothedRemainingMs(sparse, 1_000, 100)).toBeNull();
    const samples = addProgressSample(sparse, { at: 2_000, workBytes: 220 });
    const eta = smoothedRemainingMs(samples, 1_000, 220);
    expect(eta).not.toBeNull();
    expect(eta!).toBeGreaterThan(6_000);
    expect(eta!).toBeLessThan(8_000);
  });

  it("estimates per-file ETA and labels confidence conservatively", () => {
    expect(estimateRemainingFromPercent(20_000, 25)).toBe(60_000);
    expect(estimateRemainingFromPercent(1_000, 25)).toBeNull();
    expect(progressConfidence(2, 100)).toBe("Low");
    expect(progressConfidence(7, 100)).toBe("Medium");
    expect(progressConfidence(20, 100)).toBe("High");
  });

  it("pins active files, then files completed in the recent window", () => {
    const now = 100_000;
    expect(activityTier("running", 0, now)).toBe(0);
    expect(activityTier("done", now - 15_000, now)).toBe(1);
    expect(activityTier("done", now - 15_001, now)).toBe(2);
  });
});

describe("telemetry rendering", () => {
  it("renders unavailable counters honestly", () => {
    function Metric({ value }: { value: number | null }) {
      return <span>{telemetryText(value, "%")}</span>;
    }
    render(<Metric value={null} />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
});
