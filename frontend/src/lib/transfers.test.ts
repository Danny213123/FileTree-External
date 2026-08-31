import { describe, expect, it, vi } from "vitest";
import { enqueueTransfer, transferDedupeKey } from "./transfers";

describe("transfer deduplication", () => {
  it("coalesces the same cross-pane move into one worker", async () => {
    const worker = vi.fn(async () => ({ ok: true }));
    const key = transferDedupeKey("move", ["E:\\New folder (6)"], "E:\\ArgentinaCasting");

    const first = enqueueTransfer("move", "first", 1, worker, key);
    const duplicate = enqueueTransfer("move", "duplicate", 1, worker, key);

    expect(duplicate).toBe(first);
    await expect(first).resolves.toEqual({ ok: true });
    expect(worker).toHaveBeenCalledTimes(1);
  });
});
