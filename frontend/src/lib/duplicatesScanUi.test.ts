import { describe, expect, it } from "vitest";

import { activeScanStep, hashingPercent, hashingTitle, scanStepStatus } from "./duplicatesScanUi";

describe("duplicatesScanUi", () => {
  it("maps hashing stages onto the compact scan stepper", () => {
    expect(activeScanStep("aggregating")).toBe("indexing");
    expect(activeScanStep("hashing", "fingerprinting")).toBe("fingerprinting");
    expect(activeScanStep("hashing", "sampling")).toBe("sampling");
    expect(activeScanStep("hashing")).toBe("hashing");
    expect(activeScanStep("grouping", "finalizing")).toBe("grouping");
    expect(scanStepStatus("indexing", "hashing")).toBe("done");
    expect(scanStepStatus("hashing", "hashing")).toBe("active");
    expect(scanStepStatus("grouping", "hashing")).toBe("pending");
  });

  it("keeps scan copy aligned with live progress", () => {
    expect(hashingPercent({ scanned: 10, hashing: 8, hashed: 2 })).toBe(25);
    expect(hashingTitle("aggregating", { scanned: 0, hashing: 0, hashed: 0 })).toBe("Starting file scan…");
    expect(hashingTitle("hashing", { scanned: 20, hashing: 10, hashed: 0, stage: "fingerprinting" }))
      .toBe("Fingerprinting candidates…");
  });
});
