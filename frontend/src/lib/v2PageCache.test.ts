import { describe, expect, it } from "vitest";
import { V2PageCache } from "./v2PageCache";

describe("V2PageCache", () => {
  it("retains at most sixteen pages", () => {
    const cache = new V2PageCache<number>();
    for (let i = 0; i < 20; i++) cache.set(`p${i}`, i, 128);
    expect(cache.size).toBe(16);
    expect(cache.get("p0")).toBeUndefined();
    expect(cache.get("p19")).toBe(19);
  });

  it("enforces the byte budget and clears scan prefixes", () => {
    const cache = new V2PageCache<number>();
    cache.set("a:0", 1, 9 * 1024 * 1024);
    cache.set("a:1", 2, 9 * 1024 * 1024);
    expect(cache.retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    cache.set("b:0", 3, 1024);
    cache.deletePrefix("b:");
    expect(cache.get("b:0")).toBeUndefined();
  });
});
