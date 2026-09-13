import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DuplicatesController } from "../hooks/useDuplicates";
import { DuplicateScanProgress } from "./DuplicateScanProgress";
afterEach(cleanup);
it("shows compact progress only while scanning", () => {
  const stopScan = vi.fn();
  const ctrl = { scanState: "scanning", phase: "hashing", criteria: { content: { enabled: true } },
    progress: { scanned: 1000, hashing: 100, hashed: 25 }, stopScan } as unknown as DuplicatesController;
  const { rerender } = render(<DuplicateScanProgress ctrl={ctrl} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  expect(screen.queryByText(/Elapsed/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(stopScan).toHaveBeenCalledOnce();
  ctrl.scanState = "done";
  rerender(<DuplicateScanProgress ctrl={ctrl} />);
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it("resets at stage changes and shows measured grouping progress", () => {
  const ctrl = { scanState: "scanning", phase: "hashing", criteria: { content: { enabled: true } },
    progress: { scanned: 1000, hashing: 100, hashed: 100, fraction: 1, stage: "hashing" }, stopScan: vi.fn() } as unknown as DuplicatesController;
  const { rerender } = render(<DuplicateScanProgress ctrl={ctrl} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  ctrl.phase = "grouping";
  ctrl.progress = { scanned: 1000, hashing: 1000, hashed: 0, fraction: 0, stage: "grouping" };
  rerender(<DuplicateScanProgress ctrl={ctrl} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  ctrl.progress = { ...ctrl.progress, hashed: 500, fraction: 0.5 };
  rerender(<DuplicateScanProgress ctrl={ctrl} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  expect(screen.getByRole("progressbar").firstElementChild).toHaveStyle({ width: "50%" });
});

it("labels review and result preparation separately with measured progress", () => {
  const ctrl = { scanState: "scanning", phase: "grouping", criteria: { content: { enabled: false } },
    progress: { scanned: 3000, hashing: 200, hashed: 50, fraction: 0.25, stage: "reviewing" }, stopScan: vi.fn() } as unknown as DuplicatesController;
  const { container, rerender } = render(<DuplicateScanProgress ctrl={ctrl} />);
  expect(screen.getByText(/Registering matches/)).toHaveTextContent("25%, 50 / 200 processed");
  expect(container.textContent).not.toContain("\uFFFD");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  expect(screen.getByText("Register")).toHaveClass("active");
  ctrl.progress = { ...ctrl.progress, stage: "finalizing", hashed: 0, fraction: 0 };
  rerender(<DuplicateScanProgress ctrl={ctrl} />);
  expect(screen.getByText(/Preparing results/)).toBeInTheDocument();
  expect(screen.getByText("Results")).toHaveClass("active");
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
});
