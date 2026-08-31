import { describe, expect, it, vi } from "vitest";
import {
  mutationAffectsRoot,
  pathsOverlap,
  publishFilesystemMutation,
  subscribeFilesystemMutations,
} from "./fsMutations";

describe("filesystem mutation notifications", () => {
  it("matches either side of a Windows path relationship", () => {
    expect(pathsOverlap("D:\\Downloads", "d:/downloads/moved/file.mp4")).toBe(true);
    expect(pathsOverlap("D:\\Downloads\\Moved", "D:\\Downloads")).toBe(true);
    expect(pathsOverlap("D:\\Downloads", "D:\\Archive")).toBe(false);
  });

  it("notifies mounted tabs once with unique changed paths", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFilesystemMutations(listener);
    publishFilesystemMutation(["D:\\Downloads\\A", "D:\\Downloads\\A", ""], "tab-1");
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      paths: ["D:\\Downloads\\A"],
      sourceTabId: "tab-1",
    });
    expect(mutationAffectsRoot("D:\\Downloads", listener.mock.calls[0][0].paths)).toBe(true);
  });
});
