import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (value: T) => void;
  },
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  clipboardReadFiles,
  clipboardWriteFiles,
  copyItemsNative,
  fetchFolderPreview,
  fetchServerSearch,
  fetchSubtreeFiles,
  moveItems,
  moveItemsNative,
  shellContextMenu,
  startCompressJob,
  streamCompressionCandidates,
} from "./client";

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

  it("routes interactive moves through Windows native file operations", async () => {
    vi.mocked(invoke).mockResolvedValue({
      aborted: false,
      moved: 2,
      skipped: 0,
      failed: 0,
    });

    await expect(moveItemsNative(
      ["D:\\Downloads\\one.bin", "D:\\Downloads\\two.bin"],
      "E:\\Archive",
    )).resolves.toEqual({
      aborted: false,
      moved: 2,
      skipped: 0,
      failed: 0,
    });

    expect(invoke).toHaveBeenCalledWith("native_move_items", {
      paths: ["D:\\Downloads\\one.bin", "D:\\Downloads\\two.bin"],
      destination: "E:\\Archive",
    });
  });

  it("uses the Windows file clipboard and native copy commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        paths: ["D:\\Downloads\\one.bin"],
        preferMove: false,
      })
      .mockResolvedValueOnce({
        aborted: false,
        moved: 1,
        skipped: 0,
        failed: 0,
      });

    await expect(clipboardWriteFiles(["D:\\Downloads\\one.bin"], false)).resolves.toBe(true);
    await expect(clipboardReadFiles()).resolves.toEqual({
      paths: ["D:\\Downloads\\one.bin"],
      preferMove: false,
    });
    await expect(copyItemsNative(
      ["D:\\Downloads\\one.bin"],
      "E:\\Archive",
    )).resolves.toMatchObject({ moved: 1, failed: 0 });

    expect(invoke).toHaveBeenNthCalledWith(1, "clipboard_write_files", {
      paths: ["D:\\Downloads\\one.bin"],
      cut: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "clipboard_read_files");
    expect(invoke).toHaveBeenNthCalledWith(3, "native_copy_items", {
      paths: ["D:\\Downloads\\one.bin"],
      destination: "E:\\Archive",
    });
  });

  it("opens the expanded Windows context menu for the complete selection", async () => {
    vi.mocked(invoke).mockResolvedValue("properties");

    await expect(shellContextMenu(
      ["D:\\Downloads\\one.txt", "D:\\Downloads\\two.txt"],
      125.4,
      240.6,
    )).resolves.toBe("properties");

    expect(invoke).toHaveBeenCalledWith("shell_context_menu", {
      paths: ["D:\\Downloads\\one.txt", "D:\\Downloads\\two.txt"],
      clientX: 125,
      clientY: 241,
    });
  });

  it("suppresses row hover styling until the native context menu closes", async () => {
    let closeMenu: ((value: string | null) => void) | undefined;
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => {
      closeMenu = resolve;
    }));

    const menu = shellContextMenu("D:\\Downloads\\one.txt", 40, 60);
    expect(document.documentElement).toHaveClass("native-context-menu-open");

    closeMenu?.("properties");
    await expect(menu).resolves.toBe("properties");
    expect(document.documentElement).not.toHaveClass("native-context-menu-open");
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
      query: { scanId: "folder-compress", directoryId: 42, offset: 0, limit: 5_000 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "scan_subtree_files", {
      query: { scanId: "folder-compress", directoryId: 42, offset: 2, limit: 5_000 },
    });
  });

  it("streams only eligible folder files through bounded channel messages", async () => {
    vi.mocked(invoke).mockImplementationOnce(async (_command, args) => {
      const channel = (args as {
        onBatch: {
          onmessage?: (batch: {
            items: Array<{ path: string; size: number }>;
            progress: {
              scanned: number;
              eligible: number;
              skippedUnavailable: number;
              skippedNoGain: number;
              skippedTooSmall: number;
            };
          }) => void;
        };
      }).onBatch;
      channel.onmessage?.({
        items: [{ path: "E:\\Media\\one.mp4", size: 10 }],
        progress: {
          scanned: 2, eligible: 1, skippedUnavailable: 0, skippedNoGain: 1, skippedTooSmall: 0,
        },
      });
      channel.onmessage?.({
        items: [{ path: "E:\\Media\\nested\\two.jpg", size: 20 }],
        progress: {
          scanned: 3, eligible: 2, skippedUnavailable: 0, skippedNoGain: 1, skippedTooSmall: 0,
        },
      });
      return {
        scanned: 3, eligible: 2, skippedUnavailable: 0, skippedNoGain: 1, skippedTooSmall: 0,
      };
    });
    const files: Array<{ path: string; size: number }> = [];

    await expect(streamCompressionCandidates({
      rootPath: "E:\\",
      scanId: "folder-stream",
      dirId: 42,
      allowVideo: true,
      allowImage: true,
      minSizeBytes: 0,
    }, (batch) => files.push(...batch))).resolves.toEqual({
      scanned: 3, eligible: 2, skippedUnavailable: 0, skippedNoGain: 1, skippedTooSmall: 0,
    });

    expect(files).toHaveLength(2);
    expect(invoke).toHaveBeenCalledWith("scan_compression_candidates_stream", {
      scanId: "folder-stream",
      directoryId: 42,
      allowVideo: true,
      allowImage: true,
      minSizeBytes: 0,
      onBatch: expect.anything(),
    });
  });

  it("loads one largest descendant for a folder hover", async () => {
    vi.mocked(invoke).mockResolvedValue({ path: "E:\\Media\\largest.mkv", size: 9_000 });

    await expect(fetchFolderPreview({ scanId: "folder-hover", dirId: 77 })).resolves.toEqual({
      path: "E:\\Media\\largest.mkv",
      size: 9_000,
    });
    expect(invoke).toHaveBeenCalledWith("scan_folder_preview", {
      scanId: "folder-hover",
      directoryId: 77,
    });
  });

  it("starts a folder job with a compact persisted-scan descriptor", async () => {
    vi.mocked(invoke).mockResolvedValue({
      jobId: "job-1",
      status: "running",
      total: 546_920,
      skippedUnavailable: 0,
      skippedIneligible: 0,
      skippedMissing: 0,
    });

    await expect(startCompressJob({
      paths: [],
      scanDirectories: [{ scanId: "scan-large", directoryId: 42 }],
      preset: "balanced",
      originalAction: "keep",
      recycleOriginals: false,
      tagFilename: true,
    })).resolves.toEqual({
      jobId: "job-1",
      status: "running",
      total: 546_920,
      skippedUnavailable: 0,
      skippedIneligible: 0,
      skippedMissing: 0,
    });

    expect(invoke).toHaveBeenCalledWith("compression_start", {
      request: expect.objectContaining({
        paths: [],
        scanDirectories: [{ scanId: "scan-large", directoryId: 42 }],
      }),
    });
  });
});
