import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  moveItems: vi.fn(),
  renameItem: vi.fn(),
  deletePath: vi.fn(),
  restoreFromRecycleBin: vi.fn(),
  hasRecycleRestore: vi.fn(),
  fetchScan: vi.fn(),
}));
vi.mock("../api/client", () => client);
vi.mock("../api/v2", () => ({ isTauriV2: () => true, fetchV2DirectorySnapshot: vi.fn(async () => []) }));

import { clearUndo, peekUndoLabel, pushUndo, undoLast } from "./undo";

describe("desktop undo", () => {
  beforeEach(() => {
    clearUndo();
    Object.values(client).forEach((mock) => mock.mockReset());
    client.hasRecycleRestore.mockReturnValue(true);
    client.deletePath.mockResolvedValue({ ok: true });
  });

  it("undoes a copy by recycling only the copies it created", async () => {
    pushUndo({ kind: "copy", paths: ["D:\\Dest\\a.mp4", "D:\\Dest\\b.jpg"] });
    expect(peekUndoLabel()).toBe("copy of 2 items");
    expect(await undoLast()).toMatchObject({ ok: true });
    expect(client.deletePath.mock.calls).toEqual([["D:\\Dest\\a.mp4", false], ["D:\\Dest\\b.jpg", false]]);
  });

  it("restores recycled items through the desktop Recycle Bin restore", async () => {
    client.restoreFromRecycleBin.mockResolvedValue(true);
    pushUndo({ kind: "recycle", paths: ["D:\\Media\\old.txt"] });
    expect(await undoLast()).toMatchObject({ ok: true });
    expect(client.restoreFromRecycleBin).toHaveBeenCalledWith("D:\\Media\\old.txt");
  });

  it("removes an undone new folder only once it is confirmed empty", async () => {
    pushUndo({ kind: "mkdir", path: "D:\\Media\\New folder" });
    expect(await undoLast()).toMatchObject({ ok: true });
    expect(client.deletePath).toHaveBeenCalledWith("D:\\Media\\New folder", false);
  });
});
