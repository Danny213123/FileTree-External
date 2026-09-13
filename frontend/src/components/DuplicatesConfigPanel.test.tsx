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

/**
 * The dropdowns are the app's own `Select`, not a native one, so they are
 * driven the way a user does: open the trigger, then click an option out of
 * the portalled listbox.
 */
function pick(trigger: HTMLElement, option: string) {
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: option }));
}

afterEach(cleanup);
beforeEach(() => {
  browseDirectories.mockReset();
  browseDirectories.mockResolvedValue([]);
});

describe("DuplicatesConfigPanel directory list", () => {
  it("shows and allows removal of a saved disconnected drive", () => {
    const ctrl = controller();
    ctrl.value.selectedPaths = [...ctrl.value.selectedPaths, "F:\\"];
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    expect(screen.getByText("Saved scan target (not listed among connected drives)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove F:\\ from scan" }));
    expect(ctrl.value.removeCustomPath).toHaveBeenCalledWith("F:\\");
  });
  it("shows a failed scan's reason beside an enabled retry button", () => {
    const ctrl = controller();
    ctrl.value.scanState = "error";
    ctrl.value.errors = ["Scan index no longer exists: old-index"];
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Scan index no longer exists");
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(ctrl.value.startScan).toHaveBeenCalledOnce();
  });
  it("removes selected drives and custom folders from the scan", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    for (const path of ctrl.value.selectedPaths) {
      fireEvent.click(screen.getByRole("button", { name: `Remove ${path} from scan` }));
      expect(ctrl.value.removeCustomPath).toHaveBeenCalledWith(path);
    }
  });

  it("allows removing an excluded drive", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    const remove = screen.getByRole("button", { name: `Remove ${drives[1].root} from scan` });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(ctrl.value.removeCustomPath).toHaveBeenCalledWith(drives[1].root);
  });

  it("hides removed drives and offers them in the add menu", () => {
    const ctrl = controller();
    ctrl.value.removedPaths = [drives[1].root];
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    expect(screen.queryByRole("combobox", { name: `State for ${drives[1].root}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a known folder" }));
    fireEvent.click(screen.getByRole("button", { name: drives[1].root }));
    expect(ctrl.value.addCustomPath).toHaveBeenCalledWith(drives[1].root);
  });

  it("locks removal while a scan is running", () => {
    const ctrl = controller();
    ctrl.value.scanState = "scanning";
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    for (const path of ctrl.value.selectedPaths) {
      expect(screen.getByRole("button", { name: `Remove ${path} from scan` })).toBeDisabled();
    }
  });

  it("lists folders with Normal, Reference, and Excluded states", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);

    expect(screen.getByRole("combobox", { name: "State for C:\\" })).toHaveAttribute("data-value", "normal");
    expect(screen.getByRole("combobox", { name: "State for D:\\" })).toHaveAttribute("data-value", "excluded");
    expect(screen.getByRole("combobox", { name: "State for C:\\Library" })).toHaveAttribute("data-value", "reference");

    pick(screen.getByRole("combobox", { name: "State for D:\\" }), "Reference");
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
    expect(child).toHaveAttribute("data-value", "normal");
    expect(screen.getByRole("combobox", { name: "State for C:\\Temp" })).toHaveAttribute("data-value", "normal");

    pick(child, "Excluded");
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

  it("lets users disable Contents directly", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Options" }));
    const contents = screen.getByRole("checkbox", { name: "Use Contents" });
    expect(contents).toBeEnabled();
    fireEvent.click(contents);
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("content", { enabled: false, required: false });
  });

  it("shows exactly Content and Metadata scan types", () => {
    const ctrl = controller();
    ctrl.value.criteria = { ...ctrl.value.criteria, content: { enabled: false, required: false } };
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Scan type" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("option", { name: /^Content$/ }));
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("content", { enabled: true, required: true });
  });

  it("maps the scan type onto the required match criteria", () => {
    const ctrl = controller();
    render(<DuplicatesConfigPanel ctrl={ctrl.value} drives={drives} specialFolders={[]} />);

    const scanType = screen.getByRole("combobox", { name: "Scan type" });
    expect(scanType).toHaveAttribute("data-value", "contents");

    pick(scanType, "Metadata");
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("content", { enabled: false, required: false });
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("name", { enabled: true, required: true });
    expect(ctrl.value.setCriterion).toHaveBeenCalledWith("size", { enabled: true, required: true });
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
