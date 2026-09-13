import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DupeCriteria, DupeGroupV2 } from "../api/types";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { DuplicatesView } from "./DuplicatesView";

vi.mock("../api/client", () => ({
  openPath: vi.fn(),
  revealPath: vi.fn(),
}));

const criteria: DupeCriteria = {
  content: { enabled: true, required: true },
  size: { enabled: true, required: false },
  name: { enabled: true, required: false },
  date: { enabled: true, required: false },
  nameFuzzy: false,
  nameThreshold: 80,
  dateToleranceSec: 0,
};

const group: DupeGroupV2 = {
  score: 100,
  waste: 1024,
  files: [
    {
      path: "C:\\Library\\report.txt",
      name: "report.txt",
      size: 1024,
      modified: 100,
      ref: true,
      protected: true,
      score: 100,
      match: { name: 100, size: 100, date: 100, content: 100 },
    },
    {
      path: "C:\\Downloads\\report copy.txt",
      name: "report copy.txt",
      size: 1024,
      modified: 200,
      ref: false,
      score: 100,
      match: { name: 0, size: 100, date: 0, content: 100 },
    },
  ],
};

function controller(overrides: Partial<DuplicatesController> = {}): DuplicatesController {
  const noOp = vi.fn();
  const asyncNoOp = vi.fn(async () => undefined);
  return {
    selectedPaths: ["C:\\"],
    customPaths: [],
    removedPaths: [],
    protectedPaths: ["C:\\Library"],
    excludedPaths: [],
    scopeRules: [
      { path: "C:\\", state: "normal" },
      { path: "C:\\Library", state: "reference" },
    ],
    pathState: (path) => path === "C:\\Library" ? "reference" : "normal",
    setPathState: noOp,
    togglePath: noOp,
    addCustomPath: noOp,
    removeCustomPath: noOp,
    toggleProtectedPath: noOp,
    criteria,
    setCriterion: noOp,
    setNameFuzzy: noOp,
    setNameThreshold: noOp,
    setDateToleranceSec: noOp,
    minSizeKb: 1,
    setMinSizeKb: noOp,
    maxSizeKb: "",
    setMaxSizeKb: noOp,
    extensions: "",
    setExtensions: noOp,
    includeHidden: false,
    setIncludeHidden: noOp,
    destPath: "",
    setDestPath: noOp,
    deleteMode: "recycle",
    setDeleteMode: noOp,
    repriCriterion: "largest",
    setRepriCriterion: noOp,
    scanState: "idle",
    phase: "idle",
    progress: { scanned: 0, hashing: 0, hashed: 0 },
    startScan: noOp,
    stopScan: noOp,
    groups: [],
    errors: [],
    ignoredCount: 0,
    ignoredGroups: [],
    selected: new Set(),
    collapsed: new Set(),
    toggleFile: noOp,
    toggleGroup: noOp,
    toggleCollapse: noOp,
    selectAll: noOp,
    unselectAll: noOp,
    invertSelection: noOp,
    keepFirst: noOp,
    keepStrategy: noOp,
    makeRef: noOp,
    ignoreGroup: noOp,
    clearIgnoreList: noOp,
    restoreIgnoredGroups: noOp,
    reprioritizeApply: noOp,
    actionPending: false,
    deleteSelected: asyncNoOp,
    moveSelected: asyncNoOp,
    copySelected: asyncNoOp,
    removeSelectedFromResults: noOp,
    linkSelected: asyncNoOp,
    executeDeletion: asyncNoOp,
    exportCsv: noOp,
    exportJson: noOp,
    totalWaste: 0,
    totalFiles: 0,
    selectedCount: 0,
    selectedBytes: 0,
    selectedGroups: 0,
    canScan: true,
    ...overrides,
  };
}

afterEach(cleanup);

describe("DuplicatesView", () => {
  it("starts on Directories and moves to Results after a completed scan", () => {
    const first = controller({ scanState: "scanning", phase: "aggregating" });
    const { rerender } = render(
      <DuplicatesView ctrl={first} drives={[{ root: "C:\\", label: "System", total: 1, free: 1 }]} specialFolders={[]} />,
    );

    expect(screen.getByRole("tab", { name: "Directories" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    rerender(
      <DuplicatesView
        ctrl={controller({
          scanState: "done",
          phase: "done",
          groups: [group],
          totalWaste: 1024,
          totalFiles: 2,
          selected: new Set(["C:\\Downloads\\report copy.txt"]),
          selectedCount: 1,
          selectedBytes: 1024,
          selectedGroups: 1,
        })}
        drives={[{ root: "C:\\", label: "System", total: 1, free: 1 }]}
        specialFolders={[]}
      />,
    );

    expect(screen.getByRole("tab", { name: /Results/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Delete Marked…" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Directories" }));
    expect(screen.getByRole("tab", { name: "Directories" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Scan" })).toBeInTheDocument();
  });
});
