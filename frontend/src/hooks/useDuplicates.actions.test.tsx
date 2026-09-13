import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDuplicatesController } from "./useDuplicates";
import { dupeAction } from "../api/client";
import { runV2DuplicateScan, runV2Scan } from "../api/v2";
import type { ScanResult } from "../api/types";

vi.mock("../api/client", () => ({ dupeAction: vi.fn() }));
vi.mock("../api/v2", () => ({
  isTauriV2: () => true,
  isV2ScanUsable: vi.fn(async () => true),
  runV2Scan: vi.fn(async (options) => ({ rootPath: options.path, scanId: "test-index" })),
  cancelV2DuplicateScan: vi.fn(),
  runV2DuplicateScan: vi.fn(async () => ({
    groups: [{ files: ["keeper.bin", "copy.bin"].map((name) => ({
      name, path: `C:/fixture/${name}`, size: 4096, modified: 100,
    })), waste: 4096 }], errors: [], scanned: 2, hashing: 2, reviewToken: "test-review",
  })),
}));
vi.mock("../lib/toast", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/scanCache", () => ({ getCached: vi.fn(), invalidate: vi.fn(), setCached: vi.fn() }));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.mocked(dupeAction).mockReset(); });
afterEach(cleanup);

function scanController() {
  const hook = renderHook(() => useDuplicatesController({
    getScanResults: () => [{ rootPath: "C:/fixture", scanId: "test-index" } as ScanResult],
    threads: 2, defaultIncludeHidden: false,
  }));
  act(() => hook.result.current.addCustomPath("C:/fixture"));
  return hook;
}

it("ignores repeated Scan clicks while a run is active", async () => {
  const { result } = scanController();
  act(() => { result.current.startScan(); result.current.startScan(); });
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  expect(runV2DuplicateScan).toHaveBeenCalledTimes(1);
});

it("recovers from a native cancellation and allows a new scan", async () => {
  vi.mocked(runV2DuplicateScan).mockResolvedValueOnce({ groups: [], errors: [], scanned: 0, hashing: 0, cancelled: true, reviewToken: "" });
  const { result } = scanController();
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("canceled"));
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("done"));
});

it("does not let a stopped scan's late error stop its replacement", async () => {
  let rejectOld!: (error: Error) => void;
  vi.mocked(runV2DuplicateScan).mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
  const { result } = scanController();
  act(() => result.current.startScan());
  await waitFor(() => expect(runV2DuplicateScan).toHaveBeenCalledTimes(1));
  act(() => { result.current.stopScan(); result.current.startScan(); });
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  await act(async () => { rejectOld(new Error("Old scan failed")); });
  expect(result.current.scanState).toBe("done");
  expect(result.current.errors).toEqual([]);
});

it("refreshes the listing even when an existing index is available", async () => {
  vi.mocked(runV2Scan).mockResolvedValueOnce({ rootPath: "C:/fixture", scanId: "replacement-index" } as ScanResult);
  const { result } = scanController();
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  expect(runV2Scan).toHaveBeenCalledOnce();
  expect(vi.mocked(runV2Scan).mock.calls[0][0].nocache).toBe(true);
  expect(vi.mocked(runV2DuplicateScan).mock.calls[0][0].sources).toEqual([{ scanId: "replacement-index", targetPath: "C:/fixture" }]);
});

it("can retry after a startup failure", async () => {
  vi.mocked(runV2DuplicateScan).mockRejectedValueOnce(new Error("Scan startup failed"));
  const { result } = scanController();
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("error"));
  expect(result.current.errors).toEqual(["Scan startup failed"]);
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  expect(result.current.errors).toEqual([]);
});

it("does not send a failed drive's policy to the scan of available roots", async () => {
  vi.mocked(runV2Scan).mockResolvedValueOnce({ rootPath: "C:/fixture", scanId: "test-index" } as ScanResult);
  vi.mocked(runV2Scan).mockRejectedValueOnce(new Error("Drive is disconnected"));
  const { result } = scanController();
  act(() => result.current.addCustomPath("F:/"));
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  const [request, rules] = vi.mocked(runV2DuplicateScan).mock.calls[0];
  expect(request.sources).toEqual([{ scanId: "test-index", targetPath: "C:/fixture" }]);
  expect(rules.some((rule) => rule.path.startsWith("F:"))).toBe(false);
  expect(result.current.errors.join(" ")).toContain("Drive is disconnected");
});

it.each([false, true])("preserves results after failed deletion (uncertain=%s)", async (uncertain) => {
  const { result } = renderHook(() => useDuplicatesController({
    getScanResults: () => [{ rootPath: "C:/fixture", scanId: "test-index" } as ScanResult],
    threads: 2, defaultIncludeHidden: false,
  }));
  act(() => result.current.addCustomPath("C:/fixture"));
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  const groups = result.current.groups;
  expect(groups).toHaveLength(1);
  const path = groups[0].files.find((file) => !file.ref)!.path;
  act(() => result.current.toggleFile(path));
  expect(result.current.selectedBytes).toBe(4096);
  vi.mocked(dupeAction).mockResolvedValue({ ok: false, errors: ["Cannot resolve file path"], succeeded: [], requiresRescan: uncertain });
  await act(async () => { await result.current.deleteSelected(false); });
  expect(result.current.groups).toBe(groups);
  expect(result.current.selected.has(path)).toBe(true);
  expect(result.current.scanState).toBe("done");
});

it("removes confirmed missing files from the report without claiming deletion", async () => {
  const { result } = scanController();
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  const path = result.current.groups[0].files.find((file) => !file.ref)!.path;
  act(() => result.current.toggleFile(path));
  vi.mocked(dupeAction).mockResolvedValueOnce({ ok: true, errors: [], succeeded: [], missing: [path] });
  await act(async () => { await result.current.deleteSelected(false); });
  expect(result.current.groups).toEqual([]);
  expect(result.current.selected.size).toBe(0);
  expect(result.current.scanState).toBe("done");
});

it("removes only confirmed successful files after a partial deletion", async () => {
  vi.mocked(runV2DuplicateScan).mockResolvedValueOnce({
    groups: [{ files: ["keeper.bin", "first.bin", "second.bin"].map((name) => ({
      name, path: `C:/fixture/${name}`, size: 4096, modified: 100,
    })), waste: 8192 }], errors: [], scanned: 3, hashing: 3, reviewToken: "test-review", cancelled: false,
  });
  const { result } = renderHook(() => useDuplicatesController({
    getScanResults: () => [{ rootPath: "C:/fixture", scanId: "test-index" } as ScanResult],
    threads: 2, defaultIncludeHidden: false,
  }));
  act(() => result.current.addCustomPath("C:/fixture"));
  act(() => result.current.startScan());
  await waitFor(() => expect(result.current.scanState).toBe("done"));
  const paths = result.current.groups[0].files.filter((file) => !file.ref).map((file) => file.path);
  act(() => result.current.selectAll(paths));
  vi.mocked(dupeAction).mockResolvedValue({ ok: false, errors: ["Later batch disconnected"], succeeded: [paths[0]], requiresRescan: true });
  await act(async () => { await result.current.deleteSelected(false); });
  expect(result.current.groups).toHaveLength(1);
  expect(result.current.groups[0].files.map((file) => file.path)).toContain(paths[1]);
  expect(result.current.groups[0].files.map((file) => file.path)).not.toContain(paths[0]);
  expect([...result.current.selected]).toEqual([paths[1]]);
  expect(result.current.scanState).toBe("done");
});
