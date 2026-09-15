import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CyberdropSummary, CyberdropCompression } from "./CyberdropDashboard";
afterEach(cleanup);
it("shows file states, grouped errors, active scraping, and queues", () => {
  render(<CyberdropSummary running data={{ fileStats: { completed: 8, prev_completed: 4, skipped: 4, queued: 16, failed: 0 }, scrapeErrors: { errors: [{ code: 502, msg: "Bad Gateway", count: 2 }] }, downloadErrors: { errors: [] }, scraping: [{ url: "https://example.com/item", elapsed: 2 }], scrapeQueued: 952 }} />);
  expect(screen.getByText("Total: 32")).toBeInTheDocument();
  expect(screen.getByText("Previously downloaded")).toBeInTheDocument();
  expect(screen.getByText("502 Bad Gateway")).toBeInTheDocument();
  expect(screen.getByText(/952 queued/)).toBeInTheDocument();
  expect(screen.getByText("https://example.com/item")).toBeInTheDocument();
  expect(screen.getByLabelText("Queued")).toHaveAttribute("value", "16");
});
it("shows compression worker metrics and preserves totals after stopping", () => {
  const data = { compression: { title: "Compression (config: Default)", pending: 10, compressed: 2, skipped: 1, failed: 0, total: 14, files: [{ id: 1, name: "sample.mp4", completed: 250, total: 1000, speed: 50, eta: 15 }] } };
  const view = render(<CyberdropCompression data={data} running mode="cyberdrop" bytes={v => `${v} B`} eta={v => `${v}s`} />);
  expect(screen.getByText("25.00%")).toBeInTheDocument();
  expect(screen.getByText("250 B / 1000 B")).toBeInTheDocument();
  expect(screen.getByText("50 B/s")).toBeInTheDocument();
  view.rerender(<CyberdropCompression data={data} running={false} mode="cyberdrop" bytes={String} eta={String} />);
  expect(screen.getByText(/Active: 0/)).toBeInTheDocument();
  expect(screen.getByLabelText("Pending")).toHaveAttribute("value", "10");
});
