import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { RcloneView, formatSize } from "./RcloneView";
import type { PluginDef } from "../lib/plugins";

const answers: Record<string, unknown> = {
  rclone_remotes: { remotes: [{ name: "gdrive", kind: "drive" }, { name: "backup", kind: "s3" }] },
  rclone_about: { total: 1024 ** 4, used: 512 * 1024 ** 3, free: 512 * 1024 ** 3 },
  rclone_list: [
    { Path: "Media", Name: "Media", Size: -1, IsDir: true },
    { Path: "notes.txt", Name: "notes.txt", Size: 4096, IsDir: false },
  ],
  rclone_coverage: {
    localFiles: 10, remoteFiles: 8, missingCount: 2, missingBytes: 3072,
    missing: [
      { relative: "big.iso", path: "big.iso", size: 2048, differs: false },
      { relative: "notes.txt", path: "notes.txt", size: 1024, differs: true },
    ],
  },
};

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation((command: string) => Promise.resolve(answers[command]));
});
afterEach(cleanup);

it("formats sizes and marks an unknown one", () => {
  expect(formatSize(4096)).toBe("4.0 KiB");
  expect(formatSize(-1)).toBe("—");
  expect(formatSize(undefined)).toBe("—");
});

describe("RcloneView", () => {
  it("lists the configured remotes on open", async () => {
    render(<RcloneView plugin={{} as PluginDef} />);
    await waitFor(() => expect(screen.getByText("gdrive")).toBeInTheDocument());
    expect(screen.getByText("s3")).toBeInTheDocument();
    expect(screen.getByText(/2 remotes configured/)).toBeInTheDocument();
  });

  it("opens a remote, showing its listing and quota", async () => {
    render(<RcloneView plugin={{} as PluginDef} />);
    await waitFor(() => expect(screen.getByText("gdrive")).toBeInTheDocument());
    fireEvent.click(screen.getByText("gdrive"));
    await waitFor(() => expect(screen.getByText("Media/")).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("rclone_list", { exe: "", remote: "gdrive", path: "" });
    expect(screen.getByText(/512.0 GiB used of 1.0 TiB/)).toBeInTheDocument();
  });

  it("says plainly when a backend reports no quota", async () => {
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "rclone_about" ? { unsupported: true, reason: "not supported" } : answers[command]));
    render(<RcloneView plugin={{} as PluginDef} />);
    await waitFor(() => expect(screen.getByText("gdrive")).toBeInTheDocument());
    fireEvent.click(screen.getByText("gdrive"));
    await waitFor(() => expect(screen.getByText(/does not report quota/)).toBeInTheDocument());
  });

  it("reports which local files the remote does not have", async () => {
    render(<RcloneView plugin={{} as PluginDef} />);
    await waitFor(() => expect(screen.getByText("gdrive")).toBeInTheDocument());
    fireEvent.click(screen.getByText("gdrive"));
    await waitFor(() => expect(screen.getByText("Media/")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Local folder to compare"), { target: { value: "D:\\Media" } });
    fireEvent.click(screen.getByRole("button", { name: "Is it on this remote?" }));
    await waitFor(() => expect(screen.getByText(/2 of 10 files missing/)).toBeInTheDocument());
    expect(screen.getByText("big.iso")).toBeInTheDocument();
    expect(screen.getByText("different size")).toBeInTheDocument();
  });

  it("surfaces an rclone failure", async () => {
    invoke.mockRejectedValue("rclone was not found");
    render(<RcloneView plugin={{} as PluginDef} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not found"));
  });
});
