import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
    removeSelectedFromResults: noOp,
    linkSelected: asyncNoOp,
    executeDeletion: asyncNoOp,
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

// jsdom reports a zero-sized scroll container, which makes the row virtualizer
// render nothing. Give every element a viewport so table rows are assertable.
beforeAll(() => {
  for (const [prop, value] of [["offsetWidth", 1200], ["offsetHeight", 600]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value });
  }
});

describe("DuplicatesResults review workflow", () => {
  it("drives every file action from one toolbar and status line", () => {
    const ctrl = controller();
    render(<DuplicatesResults ctrl={ctrl} />);

    expect(screen.getByRole("checkbox", { name: "Dupes Only" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Delta Values" })).toBeInTheDocument();
    expect(screen.getByText(/1 \/ 1 \(.*\) duplicate marked/)).toBeInTheDocument();
    expect(screen.getByText("1 group")).toBeInTheDocument();
    expect(screen.queryByText("Storage cleanup")).not.toBeInTheDocument();
    expect(screen.queryByText(/Δ/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Actions/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Mark All/i }));
    expect(ctrl.selectAll).toHaveBeenCalledWith(["C:\\Downloads\\report copy.txt"]);

    vi.mocked(ctrl.removeSelectedFromResults).mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Actions/i }));
    fireEvent.click(screen.getByRole("button", { name: /Remove Marked from Results/i }));
    expect(ctrl.removeSelectedFromResults).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByRole("treegrid", { name: "Duplicate files" }), {
      key: "Delete",
      ctrlKey: true,
    });
    expect(screen.getByRole("dialog", { name: "Deletion options" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Delete permanently" })).toHaveAttribute("aria-checked", "true");
  });

  it("leads each group with its reference row and can hide references", () => {
    const ctrl = controller();
    const { container } = render(<DuplicatesResults ctrl={ctrl} />);

    expect(container.querySelectorAll(".dg-row-leader")).toHaveLength(1);
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    expect(screen.getByText("report copy.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Dupes Only" }));
    expect(container.querySelectorAll(".dg-row-leader")).toHaveLength(0);
    expect(screen.queryByText("report.txt")).not.toBeInTheDocument();
    expect(screen.getByText("report copy.txt")).toBeInTheDocument();
  });

  it("compares the selected row with its reference in the Details pane", () => {
    render(<DuplicatesResults ctrl={controller()} />);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Select a row to compare it with its reference.")).toBeInTheDocument();

    fireEvent.click(screen.getByText("report copy.txt"));
    const details = screen.getByRole("region", { name: "File details" });
    expect(within(details).getByRole("columnheader", { name: "Reference" })).toBeInTheDocument();
    expect(within(details).getByRole("rowheader", { name: "Content verified" })).toBeInTheDocument();
    expect(within(details).getByText("C:\\Downloads")).toBeInTheDocument();
    expect(within(details).getByText("C:\\Library")).toBeInTheDocument();
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

  it("keeps the progress bar moving while the first hashing stage is pending", () => {
    const { container } = render(<DuplicatesResults ctrl={controller({
      scanState: "scanning",
      phase: "hashing",
      progress: { scanned: 20, hashing: 10, hashed: 0, stage: "fingerprinting" },
      groups: [],
      selected: new Set(),
      selectedCount: 0,
      selectedBytes: 0,
      selectedGroups: 0,
    })} />);

    expect(screen.getByText("Fingerprinting candidates…")).toBeInTheDocument();
    expect(screen.getByText("10 candidates · 0%")).toBeInTheDocument();
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
    expect(screen.getByText("Scan stopped — no files changed")).toBeInTheDocument();
  });

  it("freezes file actions while an action is pending", () => {
    render(<DuplicatesResults ctrl={controller({ actionPending: true })} />);

    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Actions/i }));
    expect(screen.getByRole("button", { name: /Move Marked to…/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Mark All/i })).toBeDisabled();
  });

  it("opens deletion options and submits a recycle request", () => {
    const ctrl = controller();
    render(<DuplicatesResults ctrl={ctrl} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Marked…" }));
    expect(screen.getByRole("dialog", { name: "Deletion options" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move to Recycle Bin" }));
    expect(ctrl.executeDeletion).toHaveBeenCalledWith({ permanent: false });
  });
});

it("does not revisit every source group when a checkbox changes in All groups", () => {
  const readFiles = vi.fn(() => group.files);
  const source = { ...group, get files() { return readFiles(); } };
  const groups = [source];
  const ctrl = controller({ groups, selected: new Set() });
  const { rerender } = render(<DuplicatesResults ctrl={ctrl} />);
  readFiles.mockClear();
  rerender(<DuplicatesResults ctrl={{ ...ctrl, selected: new Set([group.files[1].path]), selectedCount: 1 }} />);
  expect(readFiles).not.toHaveBeenCalled();
});
