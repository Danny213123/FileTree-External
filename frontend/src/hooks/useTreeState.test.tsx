import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeRecord } from "../api/types";
import { useTreeState, type LazyOptions } from "./useTreeState";

const { fetchChildrenMock } = vi.hoisted(() => ({ fetchChildrenMock: vi.fn() }));

vi.mock("../api/client", () => ({
  fetchChildren: fetchChildrenMock,
  ScanStaleError: class ScanStaleError extends Error {},
}));

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
  beforeEach(() => fetchChildrenMock.mockReset());

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

  it("preserves an existing file id and selection across watcher metadata updates", async () => {
    const lazy: LazyOptions = {
      enabled: true,
      rootPath: "E:\\",
      scannedAt: 1,
      scanId: "scan-1",
    };
    const { result } = renderHook(() => useTreeState(lazy));
    act(() => result.current.setNodes([
      node({ children: [12], size: 1_024, files: 1 }),
      node({
        id: 12,
        parent: 0,
        path: "E:\\notes.txt",
        name: "notes.txt",
        dir: false,
        depth: 1,
        size: 1_024,
        allocated: 4_096,
        files: 1,
        extension: "txt",
      }),
    ]));
    act(() => result.current.setSelectedId(12));

    act(() => result.current.patchDirectory("e:/", [
      node({ path: "e:\\", name: "e:\\", children: [1] }),
      node({
        id: 1,
        parent: 0,
        path: "e:\\NOTES.txt",
        name: "NOTES.txt",
        dir: false,
        depth: 1,
        size: 2_048,
        allocated: 4_096,
        files: 1,
        extension: "txt",
      }),
    ]));

    await waitFor(() => {
      expect(result.current.nodeById.get(12)?.size).toBe(2_048);
      expect(result.current.nodeById.get(12)?.name).toBe("NOTES.txt");
      expect(result.current.nodeById.get(0)?.children).toEqual([12]);
      expect(result.current.selectedId).toBe(12);
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
    const oldModified = new Date("2025-01-24T12:00:00Z").getTime();
    const newModified = new Date("2026-08-31T12:00:00Z").getTime();
    act(() => result.current.setNodes([node({ children: [], modified: oldModified })]));

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
        modified: newModified,
      }),
    ]));

    await waitFor(() => {
      expect(result.current.nodeById.get(0)?.size).toBe(6144);
      expect(result.current.nodeById.get(0)?.files).toBe(2);
      expect(result.current.nodeById.get(0)?.folders).toBe(2);
      expect(result.current.nodeById.get(0)?.modified).toBe(newModified);
    });
  });

  it("repairs an unresolved live folder from a cached aggregate", async () => {
    const lazy: LazyOptions = {
      enabled: true,
      rootPath: "E:\\",
      scannedAt: 1,
      scanId: "scan-1",
    };
    const { result } = renderHook(() => useTreeState(lazy));
    act(() => result.current.setNodes([
      node({ children: [7] }),
      node({
        id: 7,
        parent: 0,
        name: "Downloads",
        path: "E:\\Downloads",
        depth: 1,
      }),
    ]));

    act(() => result.current.patchDirectory("E:\\", [
      node({ children: [1] }),
      node({
        id: 1,
        parent: 0,
        name: "Downloads",
        path: "E:\\Downloads",
        depth: 1,
        size: 5_000,
        allocated: 8_192,
        files: 12,
        folders: 3,
        aggregateKnown: true,
      }),
    ]));

    await waitFor(() => {
      expect(result.current.nodeById.get(7)?.size).toBe(5_000);
      expect(result.current.nodeById.get(7)?.files).toBe(12);
      expect(result.current.nodeById.get(0)?.size).toBe(5_000);
    });
  });

  it("retries a non-empty folder whose loaded child rows are missing", async () => {
    const loadDirectory = vi.fn()
      .mockResolvedValueOnce([
        node({ path: "E:\\Media", name: "Media", children: [] }),
      ])
      .mockResolvedValueOnce([
        node({ path: "E:\\Media", name: "Media", children: [1], files: 1, size: 1024 }),
        node({
          id: 1,
          parent: 0,
          path: "E:\\Media\\clip.mp4",
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
    act(() => result.current.patchDirectory("E:\\", [
      node({ children: [1] }),
      node({ id: 1, parent: 0, path: "E:\\Media", name: "Media", depth: 1 }),
    ]));
    const liveDirectory = await waitFor(() => {
      const found = Array.from(result.current.nodeById.values())
        .find((item) => item.path === "E:\\Media");
      expect(found).toBeDefined();
      return found!;
    });

    act(() => result.current.ensureChildren(liveDirectory.id));
    await waitFor(() => expect(result.current.loadedDirs.has(liveDirectory.id)).toBe(true));

    // A parent refresh restores the aggregate but has no retained child rows,
    // matching the stale loaded-marker state that made the chevron open empty.
    act(() => result.current.patchDirectory("E:\\", [
      node({ children: [1] }),
      node({
        id: 1,
        parent: 0,
        path: "E:\\Media",
        name: "Media",
        depth: 1,
        files: 1,
        size: 1024,
        aggregateKnown: true,
      }),
    ]));
    await waitFor(() => {
      expect(result.current.nodeById.get(liveDirectory.id)?.files).toBe(1);
      expect(result.current.nodeById.get(liveDirectory.id)?.children).toEqual([]);
    });

    act(() => result.current.ensureChildren(liveDirectory.id));
    await waitFor(() => {
      expect(loadDirectory).toHaveBeenCalledTimes(2);
      expect(Array.from(result.current.nodeById.values()).some((item) => item.name === "clip.mp4")).toBe(true);
    });
  });

  it("does not duplicate a watcher row when SQLite returns the same path under another id", async () => {
    const liveId = 9_000_000_000_000_000;
    fetchChildrenMock.mockResolvedValueOnce([
      node({
        id: 42,
        parent: 7,
        name: "Melu Morinaga",
        path: "E:\\Downloads\\Melu Morinaga",
        depth: 2,
        size: 4_200,
        files: 27,
        folders: 2,
      }),
    ]);
    const lazy: LazyOptions = {
      enabled: true,
      rootPath: "E:\\",
      scannedAt: 1,
      scanId: "scan-1",
    };
    const { result } = renderHook(() => useTreeState(lazy));
    act(() => result.current.setNodes([
      node({ children: [7] }),
      node({
        id: 7,
        parent: 0,
        name: "Downloads",
        path: "E:\\Downloads",
        depth: 1,
        children: [liveId],
        size: 1_900,
        files: 24,
        folders: 3,
      }),
      node({
        id: liveId,
        parent: 7,
        name: "Melu Morinaga",
        path: "e:\\downloads\\Melu Morinaga\\",
        depth: 2,
        size: 1_900,
        files: 24,
        folders: 2,
      }),
    ]));

    act(() => result.current.ensureChildren(7));
    await waitFor(() => expect(result.current.loadedDirs.has(7)).toBe(true));

    const matches = Array.from(result.current.nodeById.values())
      .filter((item) => item.path.replace(/[\\/]+$/, "").toLowerCase() === "e:\\downloads\\melu morinaga");
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(liveId);
    expect(result.current.nodeById.get(7)?.children).toEqual([liveId]);
  });
});
