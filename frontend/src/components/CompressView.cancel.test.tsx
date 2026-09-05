import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NodeRecord } from "../api/types";
import { CompressView } from "./CompressView";

const api = vi.hoisted(() => ({
  cancelCompressJob: vi.fn(),
  compressPreflight: vi.fn(),
  fetchCompressJobFiles: vi.fn(),
  fetchCompressLog: vi.fn(),
  fetchCompressTools: vi.fn(),
  installCompressTool: vi.fn(),
  listCompressJobs: vi.fn(),
  notify: vi.fn(),
  openCompressionLog: vi.fn(),
  openPath: vi.fn(),
  retryCompressJob: vi.fn(),
  revealPath: vi.fn(),
  shellContextMenu: vi.fn(),
  startCompressJob: vi.fn(),
  streamCompressJob: vi.fn(),
  streamCompressionCandidates: vi.fn(),
  testGpuEncoder: vi.fn(),
}));

vi.mock("../api/client", () => api);
vi.mock("./CompressionMonitor", () => ({
  CompressionMonitor: () => <div data-testid="compression-monitor" />,
}));

const file: NodeRecord = {
  id: 1,
  parent: null,
  name: "source.txt",
  path: "C:\\scan\\source.txt",
  dir: false,
  link: false,
  hidden: false,
  readonly: false,
  size: 64 * 1024,
  allocated: 64 * 1024,
  files: 1,
  folders: 0,
  modified: 0,
  created: 0,
  accessed: 0,
  depth: 0,
  errors: 0,
  extension: "txt",
  children: [],
};

describe("CompressView cancellation", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(api).forEach((mock) => mock.mockReset());
    api.fetchCompressTools.mockResolvedValue({
      handbrake: { found: false },
      image: { found: false, kind: null },
      zip: { found: true },
    });
    api.compressPreflight.mockResolvedValue({ ok: 1, missing: [], placeholder: [] });
    api.startCompressJob.mockResolvedValue({
      jobId: "job-1",
      status: "running",
      total: 1,
      skippedUnavailable: 0,
      skippedIneligible: 0,
      skippedMissing: 0,
    });
    api.streamCompressJob.mockImplementation(
      (_id: string, _onEvent: unknown, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
  });

  afterEach(cleanup);

  it("keeps new-run controls locked until native cancellation settles", async () => {
    let settleCancel!: (value: { ok: boolean }) => void;
    api.cancelCompressJob.mockReturnValue(
      new Promise<{ ok: boolean }>((resolve) => {
        settleCancel = resolve;
      }),
    );
    render(
      <CompressView
        scanPath="C:\\scan"
        scannedRoot="C:\\scan"
        nodeById={new Map([[file.id, file]])}
        initialSelectedFiles={[{ path: file.path, size: file.size }]}
        onInitialApplied={() => {}}
        onRescan={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Compress (1)" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Setup" }));
    const stop = await screen.findByRole("button", { name: "Stop" });
    fireEvent.click(stop);

    expect(await screen.findByRole("button", { name: "Stopping…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "New selection" })).not.toBeInTheDocument();

    settleCancel({ ok: true });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New selection" })).toBeInTheDocument();
    });
    expect(api.cancelCompressJob).toHaveBeenCalledWith("job-1");
  });
});
