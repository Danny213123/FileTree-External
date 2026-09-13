import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeRead } from "./readRequest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("turns an unresponsive read into an error and permits retry", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(() => {}));
  const failed = expect(invokeRead("compression_list")).rejects.toThrow("30 seconds");
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  vi.mocked(invoke).mockResolvedValueOnce({ jobs: [] });
  await expect(invokeRead("compression_list")).resolves.toEqual({ jobs: [] });
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the timeout when a read succeeds or rejects", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockResolvedValueOnce({ items: [] });
  await expect(invokeRead("scan_page")).resolves.toEqual({ items: [] });
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Database unavailable"));
  await expect(invokeRead("scan_page")).rejects.toThrow("Database unavailable");
  expect(vi.getTimerCount()).toBe(0);
});
