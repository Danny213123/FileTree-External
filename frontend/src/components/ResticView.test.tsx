import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { ResticView } from "./ResticView";
import type { PluginDef } from "../lib/plugins";

const snapshot = { id: "a1b2c3d4", time: "2026-09-14T02:00:00Z", hostname: "workstation", paths: ["D:\\Media"], tags: ["nightly"] };
const answers: Record<string, unknown> = {
  restic_snapshots: { snapshots: [snapshot] },
  restic_stats: { total_size: 1024 ** 3, total_file_count: 1200 },
  restic_coverage: { covered: true, snapshots: [snapshot], latest: snapshot.time, total: 1 },
};

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation((command: string) => Promise.resolve(answers[command]));
});
afterEach(cleanup);

async function openRepo() {
  render(<ResticView plugin={{} as PluginDef} />);
  fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "E:\\restic" } });
  fireEvent.change(screen.getByLabelText("Repository password"), { target: { value: "hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
  await waitFor(() => expect(screen.getByText("a1b2c3d4")).toBeInTheDocument());
}

describe("ResticView", () => {
  it("lists snapshots and what the repository costs", async () => {
    await openRepo();
    expect(invoke).toHaveBeenCalledWith("restic_snapshots", { exe: "", repo: "E:\\restic", password: "hunter2" });
    expect(screen.getByText("D:\\Media")).toBeInTheDocument();
    expect(screen.getByText("nightly")).toBeInTheDocument();
    expect(screen.getByText(/1.0 GiB/)).toBeInTheDocument();
  });

  it("never writes the password to storage", async () => {
    await openRepo();
    expect(JSON.stringify(localStorage)).not.toContain("hunter2");
    expect(JSON.parse(localStorage.getItem("filetree.restic.settings") ?? "{}")).toMatchObject({ repo: "E:\\restic" });
  });

  it("answers whether a folder is covered", async () => {
    await openRepo();
    fireEvent.change(screen.getByLabelText("Folder to check"), { target: { value: "D:\\Media\\Videos" } });
    fireEvent.click(screen.getByRole("button", { name: "Is this folder backed up?" }));
    await waitFor(() => expect(screen.getByText(/Covered by 1 snapshot/)).toBeInTheDocument());
  });

  it("says when nothing covers the folder", async () => {
    invoke.mockImplementation((command: string) =>
      Promise.resolve(command === "restic_coverage"
        ? { covered: false, snapshots: [], latest: null, total: 1 }
        : answers[command]));
    await openRepo();
    fireEvent.change(screen.getByLabelText("Folder to check"), { target: { value: "C:\\Windows" } });
    fireEvent.click(screen.getByRole("button", { name: "Is this folder backed up?" }));
    await waitFor(() => expect(screen.getByText(/No snapshot covers this folder/)).toBeInTheDocument());
  });

  it("shows restic's own complaint about a bad password", async () => {
    invoke.mockRejectedValue("wrong password or no key found");
    render(<ResticView plugin={{} as PluginDef} />);
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "E:\\restic" } });
    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("wrong password"));
  });
});
