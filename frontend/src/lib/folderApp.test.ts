import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../api/v2", () => ({ isTauriV2: () => true }));

import {
  folderAppEnabled, openInFolderApp, refreshFolderApp, setFolderAppEnabled, setFolderAppPath,
} from "./folderApp";

beforeEach(() => {
  localStorage.clear();
  refreshFolderApp();
  invoke.mockReset();
});

describe("folderApp", () => {
  it("is on unless turned off", () => {
    expect(folderAppEnabled()).toBe(true);
    setFolderAppEnabled(false);
    expect(folderAppEnabled()).toBe(false);
  });

  it("does nothing when the setting is off", async () => {
    setFolderAppEnabled(false);
    expect(await openInFolderApp("D:\\Media")).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("locates the app once and reuses it", async () => {
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "locate_folder_app" ? "C:\\App\\FileTreeExplorer.exe" : true));
    expect(await openInFolderApp("D:\\Media")).toBe(true);
    expect(await openInFolderApp("D:\\Projects")).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === "locate_folder_app")).toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith("open_folder_app", {
      path: "D:\\Projects", exe: "C:\\App\\FileTreeExplorer.exe",
    });
  });

  it("falls back when the app is not installed", async () => {
    invoke.mockResolvedValue(null);
    expect(await openInFolderApp("D:\\Media")).toBe(false);
    expect(invoke.mock.calls.some(([command]) => command === "open_folder_app")).toBe(false);
  });

  it("prefers a path the user set by hand", async () => {
    setFolderAppPath("E:\\Tools\\FileTreeExplorer.exe");
    invoke.mockResolvedValue(true);
    await openInFolderApp("D:\\Media");
    expect(invoke).toHaveBeenCalledWith("open_folder_app", {
      path: "D:\\Media", exe: "E:\\Tools\\FileTreeExplorer.exe",
    });
    expect(invoke.mock.calls.some(([command]) => command === "locate_folder_app")).toBe(false);
  });

  it("reports false for something that is not a folder", async () => {
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "locate_folder_app" ? "C:\\App\\FileTreeExplorer.exe" : false));
    expect(await openInFolderApp("D:\\Media\\clip.mp4")).toBe(false);
  });
});
