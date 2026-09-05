import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DupeCriteria, DupeGroupV2 } from "../api/types";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { DuplicatesResults } from "./DuplicatesResults";

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
    protectedPaths: ["C:\\Library"],
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
    scanState: "done",
    phase: "done",
    progress: { scanned: 2, hashing: 2, hashed: 2 },
    startScan: noOp,
    stopScan: noOp,
    groups: [group],
    errors: [],
    ignoredCount: 0,
    ignoredGroups: [],
    selected: new Set(["C:\\Downloads\\report copy.txt"]),
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
    linkSelected: asyncNoOp,
    exportCsv: noOp,
    exportJson: noOp,
    totalWaste: 1024,
    totalFiles: 2,
    selectedCount: 1,
    selectedBytes: 1024,
    selectedGroups: 1,
    canScan: true,
    ...overrides,
  };
}

afterEach(cleanup);

describe("DuplicatesResults review workflow", () => {
  it("separates review controls from contextual file actions", () => {
    const ctrl = controller();
    render(<DuplicatesResults ctrl={ctrl} />);

    expect(screen.getByRole("heading", { name: "Duplicate files" })).toBeInTheDocument();
    expect(screen.getAllByText(/1 KB/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 selected")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Recycle selected" })).toBeInTheDocument();
    expect(screen.getByText("Choose files to keep")).toBeInTheDocument();
    expect(screen.queryByText("Check All")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Select visible copies/i }));
    expect(ctrl.selectAll).toHaveBeenCalledWith(["C:\\Downloads\\report copy.txt"]);
  });

  it("shows a live indeterminate state before the first scan update", () => {
    const { container } = render(<DuplicatesResults ctrl={controller({
      scanState: "scanning",
      phase: "aggregating",
      progress: { scanned: 0, hashing: 0, hashed: 0 },
      groups: [],
      selected: new Set(),
      totalWaste: 0,
      totalFiles: 0,
      selectedCount: 0,
      selectedBytes: 0,
      selectedGroups: 0,
    })} />);

    expect(screen.getByText("Starting file scan…")).toBeInTheDocument();
    expect(screen.queryByText("0 files")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Duplicate scan progress" }))
      .toHaveAttribute("aria-valuetext", "Starting scan");
    expect(container.querySelector(".df-scanning-spinner")).toBeInTheDocument();
    expect(container.querySelector(".df-progress-bar")).toHaveClass("df-progress-bar-sweep");
  });

  it("shows an explicit stopped state after cancellation", () => {
    render(<DuplicatesResults ctrl={controller({
      scanState: "canceled",
      phase: "idle",
      groups: [],
      selected: new Set(),
      totalWaste: 0,
      totalFiles: 0,
      selectedCount: 0,
      selectedBytes: 0,
      selectedGroups: 0,
    })} />);

    expect(screen.getByText("Scan stopped")).toBeInTheDocument();
    expect(screen.getByText("Scan stopped · no files changed")).toBeInTheDocument();
  });

  it("freezes keeper and selection controls while a file action is pending", () => {
    render(<DuplicatesResults ctrl={controller({
      actionPending: true,
      destPath: "C:\\Archive",
    })} />);

    expect(screen.getByRole("combobox", { name: "Link type" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Select visible copies/i })).toBeDisabled();
  });
});
