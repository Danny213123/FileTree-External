import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  MediaInsightView, formatBitrate, formatDuration, formatResolution, formatSize, resetProbeSession,
} from "./MediaInsightView";
import type { PluginDef } from "../lib/plugins";

const wasteful = {
  path: "D:\\Media\\big.mp4", name: "big.mp4", size: 3_221_225_472, duration: 3600, bitrate: 40_000_000,
  videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, targetBitrate: 6_000_000,
  savings: 2_738_041_651, error: null,
};
const lean = { ...wasteful, path: "D:\\Media\\small.mp4", name: "small.mp4", bitrate: 4_000_000, savings: 0 };
const probe = { files: [wasteful, lean], probed: 2, found: 9, reclaimable: wasteful.savings, ffprobe: "C:\\ffprobe.exe" };

beforeEach(() => {
  localStorage.clear();
  resetProbeSession();
  invoke.mockReset();
  invoke.mockResolvedValue(probe);
});
afterEach(cleanup);

async function runProbe() {
  render(<MediaInsightView plugin={{} as PluginDef} />);
  fireEvent.change(screen.getByLabelText("Folder to probe"), { target: { value: "D:\\Media" } });
  fireEvent.click(screen.getByRole("button", { name: "Probe media" }));
  await waitFor(() => expect(screen.getByText("big.mp4")).toBeInTheDocument());
}

describe("formatting", () => {
  it("shows bitrate in Mbit/s and marks an unknown one", () => {
    expect(formatBitrate(40_000_000)).toBe("40.0 Mb/s");
    expect(formatBitrate(null)).toBe("—");
  });

  it("shows length as h:mm:ss only when there are hours", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(null)).toBe("—");
  });

  it("names familiar resolutions and falls back to the raw size", () => {
    expect(formatResolution(wasteful)).toBe("1080p");
    expect(formatResolution({ ...wasteful, width: 1600, height: 900 })).toBe("1600×900");
    expect(formatResolution({ ...wasteful, width: null, height: null })).toBe("—");
  });

  it("formats sizes", () => {
    expect(formatSize(3_221_225_472)).toBe("3.0 GiB");
  });
});

describe("MediaInsightView", () => {
  it("probes the folder and reports what is reclaimable", async () => {
    await runProbe();
    expect(invoke).toHaveBeenCalledWith("media_probe", { folder: "D:\\Media", limit: 100, exe: "" });
    expect(screen.getByText(/Probed 2 of 9 media files/)).toBeInTheDocument();
    expect(screen.getByText("40.0 Mb/s")).toBeInTheDocument();
  });

  it("pre-selects only the files worth re-encoding", async () => {
    await runProbe();
    expect(screen.getByLabelText("big.mp4")).toBeChecked();
    expect(screen.getByLabelText("small.mp4")).not.toBeChecked();
    expect(screen.getByText(/1 selected/)).toBeInTheDocument();
  });

  it("queues the ticked files with the chosen preset", async () => {
    await runProbe();
    fireEvent.change(screen.getByLabelText("Compression preset"), { target: { value: "max" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Compress" }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("compression_start", {
      request: { paths: [wasteful.path], preset: "max" },
    }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Queued 1 file"));
  });

  it("reports a refused queue instead of claiming success", async () => {
    await runProbe();
    invoke.mockRejectedValueOnce("D:\\Media\\big.mp4 is not part of a scan");
    fireEvent.click(screen.getByRole("button", { name: "Send to Compress" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not part of a scan"));
  });

  it("explains a missing ffprobe", async () => {
    invoke.mockRejectedValue("ffprobe was not found. Install ffmpeg…");
    render(<MediaInsightView plugin={{} as PluginDef} />);
    fireEvent.change(screen.getByLabelText("Folder to probe"), { target: { value: "D:\\Media" } });
    fireEvent.click(screen.getByRole("button", { name: "Probe media" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ffprobe was not found"));
  });
});
