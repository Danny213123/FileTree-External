import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompressJobFilesPage, CompressJobSummary } from "../api/types";
import { CompressionMonitor } from "./CompressionMonitor";

const api = vi.hoisted(() => ({
  cancelCompressJob: vi.fn(),
  copyText: vi.fn(),
  fetchCompressJobFiles: vi.fn(),
  fetchCompressTelemetry: vi.fn(),
  listCompressJobs: vi.fn(),
  openPath: vi.fn(),
  pauseCompressJob: vi.fn(),
  prioritizeCompressFiles: vi.fn(),
  removeQueuedCompressJob: vi.fn(),
  reorderQueuedCompressJobs: vi.fn(),
  resumeCompressJob: vi.fn(),
  retryCompressFiles: vi.fn(),
  revealPath: vi.fn(),
  setCompressionPresence: vi.fn(),
  setCompressConcurrency: vi.fn(),
  skipCompressFiles: vi.fn(),
}));

vi.mock("../api/client", () => api);

const job: CompressJobSummary = {
  id: "job-1",
  status: "running",
  preset: "balanced",
  total: 2,
  done: 0,
  errors: 0,
  skipped: 0,
  pending: 2,
  savedBytes: 0,
  totalBytes: 200,
  workCompletedBytes: 20,
  successfulBytes: 0,
  skippedBytes: 0,
  failedBytes: 0,
  activeWorkBytes: 20,
  activeCount: 1,
  activeElapsedMs: 1_000,
  concurrency: 2,
  encoder: "nvenc",
  codec: "h264",
  originalAction: "recycle",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  active: true,
  resumable: false,
};

const emptyPage: CompressJobFilesPage = {
  id: job.id,
  offset: 0,
  limit: 250,
  total: 2,
  totalMatches: 0,
  items: [],
  facets: {},
};

describe("CompressionMonitor controls", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(api).forEach((mock) => mock.mockReset());
    api.listCompressJobs.mockResolvedValue([job]);
    api.fetchCompressJobFiles.mockResolvedValue(emptyPage);
    api.fetchCompressTelemetry.mockResolvedValue(null);
    api.setCompressionPresence.mockResolvedValue(undefined);
    api.setCompressConcurrency.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("commits the worker limit on blur instead of every keystroke", async () => {
    render(<CompressionMonitor focusJobId={job.id} />);
    const workers = await screen.findByRole("spinbutton", { name: "Workers" });

    fireEvent.change(workers, { target: { value: "1" } });
    expect(api.setCompressConcurrency).not.toHaveBeenCalled();

    fireEvent.blur(workers);
    await waitFor(() => {
      expect(api.setCompressConcurrency).toHaveBeenCalledWith(job.id, 1);
    });
  });

  it("includes skipped and failed files in the Completed quick view", async () => {
    render(<CompressionMonitor focusJobId={job.id} />);
    await screen.findByText("Run metrics");
    api.fetchCompressJobFiles.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Completed" }));

    await waitFor(() => {
      expect(api.fetchCompressJobFiles).toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({ status: "done,skipped,error" }),
      );
    });
  });
});
