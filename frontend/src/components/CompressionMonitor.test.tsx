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
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
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
    await screen.findByText("Metrics");
    api.fetchCompressJobFiles.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Completed" }));

    await waitFor(() => {
      expect(api.fetchCompressJobFiles).toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({ status: "done,skipped,error" }),
      );
    });
  });

  it("shows the operational columns while keeping advanced filters disclosed", async () => {
    render(<CompressionMonitor focusJobId={job.id} />);
    await screen.findByText("Metrics");

    expect(screen.queryByRole("combobox", { name: "Filter by file type" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause queue" })).toBeInTheDocument();
    expect(screen.queryByText("Pause queue")).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "File", "Progress", "Stage", "Elapsed", "ETA", "Rate",
      "Encoder", "Original / output", "Saved", "Result",
    ]);
    expect(screen.getByRole("button", { name: "Choose columns" })).toHaveTextContent("Columns");
    expect(screen.queryByText("nvenc")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("combobox", { name: "Filter by file type" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run details" }));
    expect(screen.getByText("nvenc")).toBeInTheDocument();
  });

  it("hides live-only controls but preserves the completed run telemetry structure", async () => {
    api.listCompressJobs.mockResolvedValue([{
      ...job,
      status: "done",
      done: 2,
      pending: 0,
      workCompletedBytes: 200,
      activeWorkBytes: 0,
      activeCount: 0,
      active: false,
    }]);

    const { container } = render(<CompressionMonitor focusJobId={job.id} />);
    const metrics = await screen.findByText("Metrics");

    expect(screen.queryByRole("spinbutton", { name: "Workers" })).not.toBeInTheDocument();
    expect(container.querySelector(".cm-job-header")).toHaveClass("tone-good");
    expect(screen.getByRole("progressbar", { name: "Overall compression progress" }))
      .toHaveAttribute("aria-valuetext", "100%; 2 completed, 0 skipped, 0 failed");
    expect(metrics.closest("details")).toHaveAttribute("open");
    const telemetry = screen.getByLabelText("Compression telemetry");
    for (const label of ["GPU encode", "Sessions", "Aggregate", "Pipeline CPU", "RAM", "Read", "Write", "Free space"]) {
      expect(telemetry).toHaveTextContent(label);
    }
    expect(screen.getByText("Telemetry was not recorded for this completed run.")).toBeInTheDocument();
  });

  it("supports keyboard resizing and persists pane and column widths", async () => {
    render(<CompressionMonitor focusJobId={job.id} />);

    const runsResize = await screen.findByRole("separator", { name: "Resize compression runs pane" });
    fireEvent.keyDown(runsResize, { key: "ArrowRight" });
    await waitFor(() => expect(runsResize).toHaveAttribute("aria-valuenow", "292"));

    const fileColumnResize = screen.getByRole("separator", { name: "Resize File column" });
    fireEvent.keyDown(fileColumnResize, { key: "ArrowRight" });
    await waitFor(() => expect(fileColumnResize).toHaveAttribute("aria-valuenow", "182"));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("filetree.compress.monitor.v4") ?? "{}") as {
        runsWidth?: number;
        widths?: Record<string, number>;
      };
      expect(saved.runsWidth).toBe(292);
      expect(saved.widths?.name).toBe(182);
    });
  });
});
