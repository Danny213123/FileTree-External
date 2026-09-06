import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (value: T) => void;
  },
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  claimExternalPaths,
  clipboardReadFiles,
  clipboardWriteFiles,
  copyItemsNative,
  compressLogPath,
  dupeAction,
  fetchCompressLog,
  fetchFolderPreview,
  fetchServerSearch,
  fetchSubtreeFiles,
  moveItems,
  moveItemsNative,
  hardlinkPairs,
  openCompressionLog,
  releaseExternalPaths,
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

  it("loads compression history through the Tauri command", async () => {
    vi.mocked(invoke).mockResolvedValue([{ jobId: "job-1", name: "clip.mp4" }]);

    await expect(fetchCompressLog(1000)).resolves.toEqual([
      { jobId: "job-1", name: "clip.mp4" },
    ]);
    expect(invoke).toHaveBeenCalledWith("compression_log", { limit: 1000 });
  });

  it("resolves and opens app-owned compression logs through scoped commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ path: "C:\\AppData\\FileTree\\compress-log.csv" })
      .mockResolvedValueOnce(undefined);

    await expect(compressLogPath()).resolves.toBe("C:\\AppData\\FileTree\\compress-log.csv");
    await expect(openCompressionLog("history", true)).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(1, "compression_log_path", { kind: "history" });
    expect(invoke).toHaveBeenNthCalledWith(2, "compression_log_action", {
      kind: "history",
      reveal: true,
    });
  });

  it("routes protected duplicate actions and link replacements through Tauri", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ ok: true, errors: [], succeeded: ["C:\\Downloads\\copy.bin"] })
      .mockResolvedValueOnce({ ok: true, errors: [], succeeded: ["C:\\Downloads\\copy.bin"] });

    await expect(dupeAction(
      "delete",
      ["C:\\Downloads\\copy.bin"],
      {
        permanent: false,
        protectedPaths: ["C:\\Library"],
        reviewToken: "review-1",
        items: [{
          path: "C:\\Downloads\\copy.bin",
          keeper: "C:\\Library\\master.bin",
        }],
      },
    )).resolves.toEqual({
      ok: true,
      errors: [],
      succeeded: ["C:\\Downloads\\copy.bin"],
    });
    await expect(hardlinkPairs(
      [{ original: "C:\\Library\\master.bin", link: "C:\\Downloads\\copy.bin" }],
      "hardlink",
      ["C:\\Library"],
      "review-1",
    )).resolves.toEqual({
      ok: true,
      errors: [],
      succeeded: ["C:\\Downloads\\copy.bin"],
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "duplicates_action", {
      reviewToken: "review-1",
      action: "delete",
      items: [{
        path: "C:\\Downloads\\copy.bin",
        keeper: "C:\\Library\\master.bin",
      }],
      permanent: false,
      destination: null,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "duplicates_link", {
      reviewToken: "review-1",
      pairs: [{ original: "C:\\Library\\master.bin", link: "C:\\Downloads\\copy.bin" }],
      mode: "hardlink",
      permanent: false,
    });
  });

  it("forwards permanent link replacement through Tauri", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      errors: [],
      succeeded: ["C:\\Downloads\\copy.bin"],
    });

    await expect(hardlinkPairs(
      [{ original: "C:\\Library\\master.bin", link: "C:\\Downloads\\copy.bin" }],
      "symlink",
      ["C:\\Library"],
      "review-1",
      true,
    )).resolves.toEqual({
      ok: true,
      errors: [],
      succeeded: ["C:\\Downloads\\copy.bin"],
    });

    expect(invoke).toHaveBeenCalledWith("duplicates_link", {
      reviewToken: "review-1",
      pairs: [{ original: "C:\\Library\\master.bin", link: "C:\\Downloads\\copy.bin" }],
      mode: "symlink",
      permanent: true,
    });
  });

  it("preserves completed duplicate chunks when a later chunk is rejected", async () => {
    const items = Array.from({ length: 1_001 }, (_, index) => ({
      path: `C:\\Downloads\\copy-${index}.bin`,
      keeper: "C:\\Library\\master.bin",
    }));
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        ok: true,
        errors: [],
        succeeded: items.slice(0, 1_000).map((item) => item.path),
      })
      .mockRejectedValueOnce(new Error("review expired"));

    const result = await dupeAction(
      "delete",
      items.map((item) => item.path),
      { items, reviewToken: "review-1" },
    );

    expect(result.ok).toBe(false);
    expect(result.succeeded).toHaveLength(1_000);
    expect(result.errors).toEqual(["review expired"]);
    expect(result.requiresRescan).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
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
      provenance: undefined,
    });
  });

  it("uses the Windows file clipboard and native copy commands", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        paths: ["D:\\Downloads\\one.bin"],
        preferMove: false,
        provenance: "clipboard-1",
      })
      .mockResolvedValueOnce({
        aborted: false,
        moved: 1,
        skipped: 0,
        failed: 0,
      })
      .mockResolvedValueOnce("drop-1")
      .mockResolvedValueOnce(undefined);

    await expect(clipboardWriteFiles(["D:\\Downloads\\one.bin"], false)).resolves.toBe(true);
    await expect(clipboardReadFiles()).resolves.toEqual({
      paths: ["D:\\Downloads\\one.bin"],
      preferMove: false,
      provenance: "clipboard-1",
    });
    await expect(copyItemsNative(
      ["D:\\Downloads\\one.bin"],
      "E:\\Archive",
      "clipboard-1",
    )).resolves.toMatchObject({ moved: 1, failed: 0 });
    await expect(claimExternalPaths(["D:\\Downloads\\one.bin"])).resolves.toBe("drop-1");
    await expect(releaseExternalPaths("drop-1")).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(1, "clipboard_write_files", {
      paths: ["D:\\Downloads\\one.bin"],
      cut: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "clipboard_read_files");
    expect(invoke).toHaveBeenNthCalledWith(3, "native_copy_items", {
      paths: ["D:\\Downloads\\one.bin"],
      destination: "E:\\Archive",
      provenance: "clipboard-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "claim_external_paths", {
      paths: ["D:\\Downloads\\one.bin"],
    });
    expect(invoke).toHaveBeenNthCalledWith(5, "release_external_paths", {
      provenance: "drop-1",
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
      deferPaste: false,
    });
  });

  it("routes deferred shell Copy through the persistent file clipboard", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce("copy")
      .mockResolvedValueOnce(true);

    await expect(shellContextMenu(
      ["D:\\Downloads\\one.txt", "D:\\Downloads\\two.txt"],
      10,
      20,
    )).resolves.toBe("copy");

    expect(invoke).toHaveBeenNthCalledWith(1, "shell_context_menu", {
      paths: ["D:\\Downloads\\one.txt", "D:\\Downloads\\two.txt"],
      clientX: 10,
      clientY: 20,
      deferPaste: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "clipboard_write_files", {
      paths: ["D:\\Downloads\\one.txt", "D:\\Downloads\\two.txt"],
      cut: false,
    });
  });

  it("routes deferred shell Cut with the move clipboard effect", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce("CUT")
      .mockResolvedValueOnce(true);

    await expect(shellContextMenu("D:\\Downloads\\one.txt", 10, 20)).resolves.toBe("CUT");

    expect(invoke).toHaveBeenNthCalledWith(2, "clipboard_write_files", {
      paths: ["D:\\Downloads\\one.txt"],
      cut: true,
    });
  });

  it("limits cross-parent shell Copy to the item represented by the menu", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce("copy")
      .mockResolvedValueOnce(true);

    await shellContextMenu(
      ["D:\\Downloads\\one.txt", "E:\\Archive\\two.txt"],
      10,
      20,
    );

    expect(invoke).toHaveBeenNthCalledWith(1, "shell_context_menu", {
      paths: ["D:\\Downloads\\one.txt"],
      clientX: 10,
      clientY: 20,
      deferPaste: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "clipboard_write_files", {
      paths: ["D:\\Downloads\\one.txt"],
      cut: false,
    });
  });

  it("returns deferred shell Paste for contextual workspace dispatch", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("paste");

    await expect(shellContextMenu(
      "D:\\Downloads\\Destination",
      10,
      20,
      { deferPaste: true },
    )).resolves.toBe("paste");

    expect(invoke).toHaveBeenCalledWith("shell_context_menu", {
      paths: ["D:\\Downloads\\Destination"],
      clientX: 10,
      clientY: 20,
      deferPaste: true,
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
