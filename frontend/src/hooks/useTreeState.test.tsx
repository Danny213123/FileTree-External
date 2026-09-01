import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { NodeRecord } from "../api/types";
import { useTreeState, type LazyOptions } from "./useTreeState";

function node(overrides: Partial<NodeRecord>): NodeRecord {
  return {
    id: 0,
    parent: null,
    name: "E:\\",
    path: "E:\\",
    dir: true,
    link: false,
    hidden: false,
    readonly: false,
    size: 0,
    allocated: 0,
    files: 0,
    folders: 0,
    modified: 0,
    created: 0,
    accessed: 0,
    depth: 0,
    errors: 0,
    extension: "",
    children: [],
    ...overrides,
  };
}

describe("useTreeState watcher patches", () => {
  it("loads a newly discovered lazy directory from the live filesystem", async () => {
    const loadDirectory = vi.fn(async (path: string) => [
      node({ id: 0, path, name: "New folder", children: [1] }),
      node({
        id: 1,
        parent: 0,
        path: `${path}\\clip.mp4`,
        name: "clip.mp4",
        dir: false,
        files: 1,
        size: 1024,
        allocated: 4096,
        depth: 1,
        extension: "mp4",
      }),
    ]);
    const lazy: LazyOptions = {
      enabled: true,
      rootPath: "E:\\",
      scannedAt: 1,
      scanId: "scan-1",
      loadDirectory,
    };
    const { result } = renderHook(() => useTreeState(lazy));

    act(() => result.current.setNodes([node({ children: [] })]));
    act(() => result.current.patchDirectory("e:/", [
      node({ path: "e:\\", name: "e:\\", children: [1] }),
      node({ id: 1, parent: 0, path: "e:\\New folder", name: "New folder", depth: 1 }),
    ]));

    await waitFor(() => {
      expect(Array.from(result.current.nodeById.values()).some((item) => item.path.toLowerCase() === "e:\\new folder")).toBe(true);
    });
    const liveDirectory = Array.from(result.current.nodeById.values())
      .find((item) => item.path.toLowerCase() === "e:\\new folder");
    expect(liveDirectory).toBeDefined();

    act(() => result.current.toggleExpand(liveDirectory!.id));
    await waitFor(() => {
      expect(loadDirectory).toHaveBeenCalledWith("e:\\New folder");
      expect(Array.from(result.current.nodeById.values()).some((item) => item.name === "clip.mp4")).toBe(true);
      expect(result.current.loadedDirs.has(liveDirectory!.id)).toBe(true);
    });
  });

  it("matches existing Windows paths case-insensitively and preserves their subtree", async () => {
    const lazy: LazyOptions = {
      enabled: true,
      rootPath: "E:\\",
      scannedAt: 1,
      scanId: "scan-1",
    };
    const { result } = renderHook(() => useTreeState(lazy));
    const existingDirectory = node({
      id: 7,
      parent: 0,
      name: "Media",
      path: "E:\\Media",
      depth: 1,
      size: 2048,
      files: 1,
      children: [8],
    });
    const existingFile = node({
      id: 8,
      parent: 7,
      name: "kept.mp4",
      path: "E:\\Media\\kept.mp4",
      dir: false,
      depth: 2,
      size: 2048,
      files: 1,
      extension: "mp4",
    });
    act(() => result.current.setNodes([
      node({ children: [7], size: 2048, files: 1, folders: 1 }),
      existingDirectory,
      existingFile,
    ]));
    act(() => result.current.patchDirectory("e:/", [
      node({ path: "e:\\", name: "e:\\", children: [1] }),
      node({ id: 1, parent: 0, path: "e:\\media", name: "media", depth: 1 }),
    ]));

    await waitFor(() => {
      expect(result.current.nodeById.get(7)?.children).toEqual([8]);
      expect(result.current.nodeById.get(8)?.name).toBe("kept.mp4");
    });
  });

  it("propagates watcher-created folder aggregates to the visible root", async () => {
    const lazy: LazyOptions = {
      enabled: true,
      rootPath: "E:\\",
      scannedAt: 1,
      scanId: "scan-1",
    };
    const { result } = renderHook(() => useTreeState(lazy));
    act(() => result.current.setNodes([node({ children: [] })]));

    act(() => result.current.patchDirectory("E:\\", [
      node({ children: [1] }),
      node({
        id: 1,
        parent: 0,
        path: "E:\\Moved folder",
        name: "Moved folder",
        dir: true,
        depth: 1,
        size: 6144,
        allocated: 8192,
        files: 2,
        folders: 1,
      }),
    ]));

    await waitFor(() => {
      expect(result.current.nodeById.get(0)?.size).toBe(6144);
      expect(result.current.nodeById.get(0)?.files).toBe(2);
      expect(result.current.nodeById.get(0)?.folders).toBe(2);
    });
  });
});
