import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (value: T) => void;
  },
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { fetchServerSearch, fetchSubtreeFiles, moveItems } from "./client";

describe("v2 bounded client queries", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("issues one bounded SQLite page per search edit", async () => {
    vi.mocked(invoke).mockResolvedValue({
      items: [],
      total: 1_200,
      offset: 0,
      limit: 500,
      hasMore: true,
    });

    const result = await fetchServerSearch({
      rootPath: "E:\\",
      scanId: "search-regression",
      query: "summer video",
      limit: 2_000,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("scan_page", expect.objectContaining({
      query: expect.objectContaining({ limit: 500, offset: 0, search: "summer video", countTotal: false }),
    }));
    expect(result).toEqual({ matches: [], total: 1_200, capped: true });
  });

  it("routes file moves through Tauri and preserves the verified result", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      moved: ["D:\\Downloads\\source"],
      alreadyThere: [],
      conflicts: [],
      skipped: [],
      errors: [],
    });

    const result = await moveItems(
      ["D:\\Downloads\\source"],
      "D:\\Downloads\\destination",
    );

    expect(invoke).toHaveBeenCalledWith("move_items", {
      paths: ["D:\\Downloads\\source"],
      destination: "D:\\Downloads\\destination",
      conflict: null,
    });
    expect(result.ok).toBe(true);
    expect(result.moved).toEqual(["D:\\Downloads\\source"]);
  });

  it("loads folder descendants through bounded Tauri pages", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        items: [
          { path: "E:\\Media\\one.mp4", size: 10 },
          { path: "E:\\Media\\nested\\two.jpg", size: 20 },
        ],
        offset: 0,
        limit: 500,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ path: "E:\\Media\\three.zip", size: 30 }],
        offset: 2,
        limit: 500,
        hasMore: false,
      });

    const result = await fetchSubtreeFiles({
      rootPath: "E:\\",
      scanId: "folder-compress",
      dirId: 42,
    });

    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({ path: "E:\\Media\\nested\\two.jpg", size: 20 });
    expect(invoke).toHaveBeenNthCalledWith(1, "scan_subtree_files", {
      query: { scanId: "folder-compress", directoryId: 42, offset: 0, limit: 500 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "scan_subtree_files", {
      query: { scanId: "folder-compress", directoryId: 42, offset: 2, limit: 500 },
    });
  });
});
