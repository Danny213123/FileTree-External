import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DupeCriteria, DupeScopeRule, DupeScopeState } from "../api/types";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { DuplicatesConfigPanel } from "./DuplicatesConfigPanel";

const browseDirectories = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({ browseDirectories }));

const criteria: DupeCriteria = {
  content: { enabled: true, required: true },
  size: { enabled: true, required: false },
  name: { enabled: true, required: false },
  date: { enabled: true, required: false },
  nameFuzzy: false,
  nameThreshold: 80,
  dateToleranceSec: 0,
};

function controller() {
  const states = new Map<string, DupeScopeState>([
    ["C:\\", "normal"],
    ["D:\\", "excluded"],
    ["C:\\Library", "reference"],
  ]);
  // The tree resolves each row through the inherited scope rules, so the mock
  // has to expose the same states as rules rather than only as exact lookups.
  const scopeRules: DupeScopeRule[] = [...states].map(([path, state]) => ({ path, state }));
  const noOp = vi.fn();
  return {
    value: {
      selectedPaths: ["C:\\", "C:\\Library"],
      customPaths: ["C:\\Library"],
      scopeRules,
      pathState: (path: string) => states.get(path) ?? "excluded",
      setPathState: vi.fn(),
      addCustomPath: vi.fn(),
      removeCustomPath: vi.fn(),
      scanState: "idle",
      phase: "idle",
      progress: { scanned: 0, hashing: 0, hashed: 0 },
      actionPending: false,
      criteria,
      setCriterion: vi.fn(),
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
      repriCriterion: "largest",
      setRepriCriterion: noOp,
      groups: [],
      reprioritizeApply: noOp,
      ignoredCount: 0,
      restoreIgnoredGroups: noOp,
      canScan: true,
      startScan: noOp,
      stopScan: noOp,
    } as unknown as DuplicatesController,
  };
}

const drives = [
  { root: "C:\\", label: "System", total: 1_000, free: 500 },
  { root: "D:\\", label: "Archive", total: 2_000, free: 1_000 },
];

afterEach(cleanup);
beforeEach(() => {
  browseDirectories.mockReset();
  browseDirectories.mockResolvedValue([]);
});

describe("DuplicatesConfigPanel directory list", () => {
  it("lists folders with Normal, Reference, and Excluded states", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);

    expect(screen.getByRole("combobox", { name: "State for C:\\" })).toHaveValue("normal");
    expect(screen.getByRole("combobox", { name: "State for D:\\" })).toHaveValue("excluded");
    expect(screen.getByRole("combobox", { name: "State for C:\\Library" })).toHaveValue("reference");

    fireEvent.change(screen.getByRole("combobox", { name: "State for D:\\" }), {
      target: { value: "reference" },
    });
    expect(ctrl.value.setPathState).toHaveBeenCalledWith("D:\\", "reference");
  });

  it("expands a drive into subfolders that inherit its state", async () => {
    browseDirectories.mockResolvedValue([
      { name: "Games", path: "C:\\Games", hidden: false },
      { name: "Temp", path: "C:\\Temp", hidden: false },
    ]);
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand C:\\" }));
    await waitFor(() => expect(browseDirectories).toHaveBeenCalledWith("C:\\"));

    // C:\ is Normal, so an unconfigured subfolder shows Normal too.
    const child = await screen.findByRole("combobox", { name: "State for C:\\Games" });
    expect(child).toHaveValue("normal");
    expect(screen.getByRole("combobox", { name: "State for C:\\Temp" })).toHaveValue("normal");

    fireEvent.change(child, { target: { value: "excluded" } });
    expect(ctrl.value.setPathState).toHaveBeenCalledWith("C:\\Games", "excluded");

    fireEvent.click(screen.getByRole("button", { name: "Collapse C:\\" }));
    expect(screen.queryByRole("combobox", { name: "State for C:\\Games" })).not.toBeInTheDocument();
  });

  it("reports a folder that cannot be read", async () => {
    browseDirectories.mockRejectedValue(new Error("Access is denied"));
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={[drives[1]]} specialFolders={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand D:\\" }));
    expect(await screen.findByText("Access is denied")).toBeInTheDocument();
  });

  it("adds a folder from the typed path", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Folder path to add" }), {
      target: { value: "D:\\Photos" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(ctrl.value.addCustomPath).toHaveBeenCalledWith("D:\\Photos");
  });

  it("maps the scan type onto the required match criteria", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);

    const scanType = screen.getByRole("combobox", { name: "Scan type:" });
    expect(scanType).toHaveValue("contents");

    fireEvent.change(scanType, { target: { value: "contents-name" } });
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("name", { enabled: true, required: true });
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("date", { enabled: true, required: false });
  });

  it("keeps match criteria and filters behind More Options", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);

    expect(screen.queryByRole("checkbox", { name: "Require Size" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More Options" }));
    expect(screen.getByRole("checkbox", { name: "Use Size" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Require Size" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include hidden and system files" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Require Size" }));
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("size", { required: true });
  });

  it("shows staged scan progress next to the Stop button", () => {
    const ctrl = controller();
    ctrl.value.scanState = "scanning";
    ctrl.value.phase = "hashing";
    ctrl.value.progress = { scanned: 20, hashing: 10, hashed: 0, stage: "fingerprinting" };
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={[drives[0]]} specialFolders={[]} />);

    expect(screen.getByText(/Fingerprinting candidates…/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Duplicate scan progress" }))
      .toHaveAttribute("aria-valuetext", "0% of 10 candidates processed");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan" })).not.toBeInTheDocument();
  });
});
