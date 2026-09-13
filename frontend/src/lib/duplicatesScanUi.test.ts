import { describe, expect, it } from "vitest";

import { overallScanPercent, scanEta, activeScanStep, hashingPercent, hashingTitle, scanStepStatus } from "./duplicatesScanUi";

describe("duplicatesScanUi", () => {
  it("maps hashing stages onto the compact scan stepper", () => {
    expect(activeScanStep("aggregating")).toBe("indexing");
    expect(activeScanStep("hashing", "fingerprinting")).toBe("fingerprinting");
    expect(activeScanStep("hashing", "sampling")).toBe("sampling");
    expect(activeScanStep("hashing")).toBe("hashing");
    expect(activeScanStep("grouping", "finalizing")).toBe("finalizing");
    expect(activeScanStep("grouping", "reviewing")).toBe("reviewing");
    expect(scanStepStatus("indexing", "hashing")).toBe("done");
    expect(scanStepStatus("hashing", "hashing")).toBe("active");
    expect(scanStepStatus("grouping", "hashing")).toBe("pending");
  });

  it("shows reads even before the first candidate finishes", () => {
    const title = hashingTitle("hashing", { scanned: 2085039, hashing: 2085039, hashed: 0, bytesRead: 1048576 });
    expect(title).toContain("read");
    expect(title).not.toBe("Hashing candidate files…");
  });

  it("keeps scan copy aligned with live progress", () => {
    expect(hashingPercent({ scanned: 10, hashing: 8, hashed: 2 })).toBe(25);
    expect(hashingTitle("aggregating", { scanned: 0, hashing: 0, hashed: 0 })).toBe("Starting file scan…");
    expect(hashingTitle("hashing", { scanned: 20, hashing: 10, hashed: 0, stage: "fingerprinting" }))
      .toBe("Fingerprinting candidates…");
  });
});

describe("overall progress and ETA", () => {
  it("maps measured indexing and grouping progress without completing early", () => {
    const progress = { scanned: 100, hashing: 0, hashed: 0, fraction: 0.5 };
    expect(overallScanPercent("aggregating", progress, true, false)).toBe(10);
    expect(overallScanPercent("grouping", progress, true, false)).toBe(59.5);
    expect(overallScanPercent("grouping", { ...progress, fraction: 1 }, true, false)).toBe(99);
    expect(overallScanPercent("done", progress, true, true)).toBe(100);
  });
  it("withholds ETA until measured progress exists and when progress goes stale", () => {
    expect(scanEta(2, 10, false)).toBe("Estimating…");
    expect(scanEta(20, 0, false)).toBe("Estimating…");
    expect(scanEta(20, 50, false)).toBe("~20s remaining");
    expect(scanEta(20, 50, true)).toBe("Estimating…");
  });
});
