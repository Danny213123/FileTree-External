import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { installDemo } from "./install";

installDemo();

const query = (scanId: string, parentId: number | null, limit = 50) => ({
  query: {
    scanId, parentId, offset: 0, limit, search: "", sort: "size", direction: "desc", directoriesOnly: false,
    filesOnly: false, regex: false, minSize: null, maxSize: null, modifiedAfter: null, modifiedBefore: null, ext: "", category: "",
  },
});
type Page = { items: { id: number; name: string; size: number }[]; total: number };

describe("demo build IPC", () => {
  it("scans invented folders and pages their children largest first", async () => {
    const handle = await invoke<{ scanId: string; nodeCount: number }>("scan_find", { rootPath: "D:\\Media" });
    expect(handle.nodeCount).toBeGreaterThan(1_000);
    const root = await invoke<Page>("scan_page", query(handle.scanId, null, 1));
    expect(root.items[0].name).toBe("Media");
    const children = await invoke<Page>("scan_page", query(handle.scanId, root.items[0].id));
    expect(children.items.map((item) => item.name)).toEqual(expect.arrayContaining(["Videos", "Photos", "Music"]));
    const sizes = children.items.map((item) => item.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it("returns a subfolder scan's root without a parent so the tree can render it", async () => {
    const handle = await invoke<{ scanId: string }>("scan_find", { rootPath: "C:\\Program Files" });
    const root = await invoke<{ items: { id: number; name: string; parentId: number | null; depth: number }[] }>("scan_page", query(handle.scanId, null, 1));
    expect(root.items[0]).toMatchObject({ id: 0, name: "Program Files", parentId: null, depth: 0 });
    const children = await invoke<{ items: { parentId: number | null; depth: number }[] }>("scan_page", query(handle.scanId, 0));
    expect(children.items.length).toBeGreaterThan(0);
    expect(children.items.every((item) => item.parentId === 0 && item.depth === 1)).toBe(true);
  });

  it("scans a drive or folder however its path is spelled", async () => {
    for (const rootPath of ["D:", "D:\\", "d:/Media/", "E:"]) {
      const handle = await invoke<{ nodeCount: number } | null>("scan_find", { rootPath });
      expect(handle?.nodeCount, rootPath).toBeGreaterThan(10);
    }
  });

  it("answers compression, Cyberdrop and unknown commands from demo data", async () => {
    const { jobs } = await invoke<{ jobs: { status: string }[] }>("compression_list");
    expect(new Set(jobs.map((job) => job.status))).toEqual(new Set(["running", "queued", "paused", "done", "cancelled"]));
    expect((await invoke<{ status: string }>("cyberdrop_status")).status).toBe("Running");
    expect(await invoke("not_a_real_command")).toBeNull();
  });

  it("finds the planted duplicate copies", async () => {
    const result = await invoke<{ groups: { files: unknown[] }[] }>("duplicates_scan", { onProgress: { onmessage: () => {} } });
    expect(result.groups.length).toBeGreaterThan(20);
    expect(result.groups.every((group) => group.files.length >= 2)).toBe(true);
  });
});
