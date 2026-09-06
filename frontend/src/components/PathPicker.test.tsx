import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DriveEntry, SpecialFolder } from "../api/types";
import { PathPicker, shortenParent, splitPath } from "./PathPicker";

const browseDirectories = vi.hoisted(() => vi.fn());
vi.mock("../api/client", () => ({ browseDirectories }));

const drives: DriveEntry[] = [
  { root: "C:\\", label: "Windows", total: 1_000_000_000_000, free: 200_000_000_000 },
  { root: "D:\\", label: "Data", total: 4_000_000_000_000, free: 3_800_000_000_000 },
];
const specialFolders: SpecialFolder[] = [
  { label: "Downloads", path: "C:\\Users\\alex\\Downloads" },
];

function setup(value = "C:\\Projects\\filetree") {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <PathPicker
      value={value}
      onChange={onChange}
      onCommit={onCommit}
      drives={drives}
      specialFolders={specialFolders}
      bookmarks={["C:\\Users\\alex\\Documents\\Reports"]}
      recent={["D:\\media"]}
    />,
  );
  return { onChange, onCommit };
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Drive or folder to scan" }));
  return screen.getByRole("tree", { name: "Drives and folders" });
}

afterEach(() => {
  cleanup();
  browseDirectories.mockReset();
});

describe("splitPath", () => {
  it("keeps the separator on a bare drive parent", () => {
    expect(splitPath("C:\\Projects")).toEqual({ name: "Projects", parent: "C:\\" });
  });

  it("treats a drive root as its own label", () => {
    expect(splitPath("d:/")).toEqual({ name: "d:\\", parent: "" });
  });

  it("splits a nested path into leaf and parent", () => {
    expect(splitPath("C:\\Users\\alex\\Pictures")).toEqual({
      name: "Pictures",
      parent: "C:\\Users\\alex",
    });
  });
});

describe("shortenParent", () => {
  it("elides all but the trailing segments", () => {
    expect(shortenParent("C:\\Users\\alex\\Documents")).toBe("…\\dan\\Documents");
  });

  it("leaves short parents alone", () => {
    expect(shortenParent("C:\\Users")).toBe("C:\\Users");
  });
});

describe("PathPicker", () => {
  it("shows the target leaf with its elided parent", () => {
    setup("C:\\Users\\alex\\Documents\\Reports");
    expect(screen.getByText("Reports")).toBeInTheDocument();
    expect(screen.getByText("…\\dan\\Documents")).toBeInTheDocument();
  });

  it("prefers the volume label over the parent for a drive root", () => {
    setup("C:\\");
    expect(screen.getByText("Windows")).toBeInTheDocument();
  });

  it("groups drives, quick access, bookmarks and recent paths", () => {
    setup();
    openMenu();
    for (const group of ["Drives", "Quick access", "Bookmarks", "Recent"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
    expect(screen.getByTitle("C:\\")).toBeInTheDocument();
    expect(screen.getByTitle("C:\\Users\\alex\\Downloads")).toBeInTheDocument();
    expect(screen.getByTitle("D:\\media")).toBeInTheDocument();
  });

  it("commits the picked row and closes", () => {
    const { onChange, onCommit } = setup();
    openMenu();
    fireEvent.click(screen.getByTitle("C:\\Users\\alex\\Downloads"));
    expect(onChange).toHaveBeenCalledWith("C:\\Users\\alex\\Downloads");
    expect(onCommit).toHaveBeenCalledWith("C:\\Users\\alex\\Downloads");
    expect(screen.queryByRole("tree", { name: "Drives and folders" })).not.toBeInTheDocument();
  });

  it("expands a drive in place with its immediate subfolders", async () => {
    browseDirectories.mockResolvedValue([
      { name: "Projects", path: "C:\\Projects", hidden: false },
      { name: "Windows", path: "C:\\Windows", hidden: false },
    ]);
    setup();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Expand C: Windows" }));
    await waitFor(() => expect(screen.getByTitle("C:\\Windows")).toBeInTheDocument());
    expect(browseDirectories).toHaveBeenCalledWith("C:\\");

    // Collapsing hides the children again but keeps the fetched list cached.
    fireEvent.click(screen.getByRole("button", { name: "Collapse C: Windows" }));
    expect(screen.queryByTitle("C:\\Windows")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand C: Windows" }));
    expect(screen.getByTitle("C:\\Windows")).toBeInTheDocument();
    expect(browseDirectories).toHaveBeenCalledTimes(1);
  });

  it("surfaces a browse failure on the expanded row", async () => {
    browseDirectories.mockRejectedValue(new Error("Access is denied"));
    setup();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Expand C: Windows" }));
    await waitFor(() => expect(screen.getByText("Access is denied")).toBeInTheDocument());
  });

  it("filters the tree down to name matches", () => {
    setup();
    const tree = openMenu();
    fireEvent.change(screen.getByLabelText("Filter folders or enter a path"), {
      target: { value: "down" },
    });
    expect(within(tree).getByTitle("C:\\Users\\alex\\Downloads")).toBeInTheDocument();
    expect(within(tree).queryByTitle("C:\\")).not.toBeInTheDocument();
  });

  it("treats typed text with a separator as a path, not a filter", () => {
    const { onCommit } = setup();
    openMenu();
    const input = screen.getByLabelText("Filter folders or enter a path");
    fireEvent.change(input, { target: { value: "E:\\archive" } });
    expect(screen.getByText("Use “E:\\archive”")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("E:\\archive");
  });

  it("commits the keyboard-highlighted row on Enter", () => {
    const { onCommit } = setup();
    openMenu();
    const input = screen.getByLabelText("Filter folders or enter a path");
    // Starts on the first drive; one step down lands on the second.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("D:\\");
  });

  it("closes on Escape without committing", () => {
    const { onCommit } = setup();
    openMenu();
    fireEvent.keyDown(screen.getByLabelText("Filter folders or enter a path"), { key: "Escape" });
    expect(screen.queryByRole("tree", { name: "Drives and folders" })).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
