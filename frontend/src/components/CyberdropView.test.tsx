import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../api/client", () => ({ openPath: vi.fn(async () => {}) }));
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "../api/client";
import { CyberdropView } from "./CyberdropView";
import type { PluginDef } from "../lib/plugins";
const api = vi.mocked(invoke);
afterEach(cleanup);
beforeEach(() => {
  localStorage.clear(); api.mockReset();
  const workspace = { folder: "C:/central", name: "URLs-A2B64", text: "https://example.com/one\n", stations: [{ id: "URLs-A2B64", label: "URLs.txt", opened: 1, edited: 1 }], revisions: ["1"], loaded: null as { id: string } | null, activeText: "", compressionMode: "off", sideload: { preset: "balanced", originalAction: "keep" } };
  let count = 0;
  api.mockImplementation(async (command, args) => {
    if (command === "cyberdrop_status") return { status: "Ready", logs: [], started: 0 };
    if (command === "cyberdrop_workspace") {
      const request = (args as { request: { action: string; text?: string; mode?: string; settings?: Record<string, string> } }).request;
      if (request.action === "mode") workspace.compressionMode = request.mode!;
      if (request.action === "sideload") workspace.sideload = { ...workspace.sideload, ...request.settings };
      if (request.action === "save") workspace.text = request.text!;
      if (request.action === "create") { workspace.name = `URLs-NEW0${++count}`; workspace.text = request.text!; workspace.stations.push({ id: workspace.name, label: "URLs.txt", opened: 2, edited: 2 }); }
      if (request.action === "stage") { workspace.loaded = { id: workspace.name }; workspace.activeText = workspace.text; }
      return structuredClone(workspace);
    }
    if (command === "cyberdrop_document") return { text: "download_folder: E:/Downloads\n", settings: { download_folder: "E:/Downloads" }, folder: "C:/central" };
    return undefined;
  });
});
const mount = async () => {
  render(<CyberdropView plugin={{} as PluginDef} />);
  await waitFor(() => expect(screen.getByLabelText("Download folder")).toHaveValue("E:/Downloads"));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Edit" })).toBeEnabled());
};
describe("Cyberdrop workstations", () => {
  it("saves and stages explicitly, and exposes the active URLs as read-only", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "Start download" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const editor = await screen.findByLabelText("Workstation editor");
    fireEvent.change(editor, { target: { value: "https://example.com/two\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Load for download" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("cyberdrop_workspace", expect.objectContaining({ request: { action: "stage", name: "URLs-A2B64" } })));
    expect(api).toHaveBeenCalledWith("cyberdrop_workspace", expect.objectContaining({ request: { action: "save", name: "URLs-A2B64", text: "https://example.com/two\n" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "View URLs.txt" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "View URLs.txt" }));
    expect(await screen.findByLabelText("URLs.txt editor")).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Start download" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("cyberdrop_start", { repo: "C:\\Tools\\CyberDropDownloader", excludePaths: [] }));
  });
  it("imports repeated filenames as separate workstations", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    const input = await screen.findByLabelText("Import URL list");
    for (let i = 1; i <= 2; i++) {
      await waitFor(() => expect(input).toBeEnabled());
      fireEvent.change(input, { target: { files: [{ name: "URLs.txt", size: 10, text: async () => "https://example.com" }] } });
      await waitFor(() => expect(screen.getByLabelText("Recent workstations")).toHaveValue(`URLs-NEW0${i}`));
    }
  });
  it("opens the central folder and persists side-load mode", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open workspace folder" }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("C:/central"));
    await waitFor(() => expect(screen.getByLabelText("Compression mode")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Compression mode"), { target: { value: "filetree" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith("cyberdrop_workspace", expect.objectContaining({ request: { action: "mode", mode: "filetree" } })));
  });
  it("edits Cyberdrop pipeline compression options through config.yml", async () => {
    await mount();
    await waitFor(() => expect(screen.getByLabelText("Compression mode")).toBeEnabled());
    expect(screen.queryByLabelText("Video codec")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Compression mode"), { target: { value: "cyberdrop" } });
    const codec = await screen.findByLabelText("Video codec");
    await waitFor(() => expect(codec).toBeEnabled());
    fireEvent.change(codec, { target: { value: "av1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("cyberdrop_document", expect.objectContaining({ action: "patch", patch: { "compression_options.video_codec": "av1" } })));
  });
  it("saves side-load compression options to the workspace", async () => {
    await mount();
    await waitFor(() => expect(screen.getByLabelText("Compression mode")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Compression mode"), { target: { value: "filetree" } });
    const preset = await screen.findByLabelText("Side-load preset");
    await waitFor(() => expect(preset).toBeEnabled());
    fireEvent.change(preset, { target: { value: "high" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith("cyberdrop_workspace", expect.objectContaining({ request: { action: "sideload", settings: { preset: "high" } } })));
    await waitFor(() => expect(screen.getByLabelText("Side-load originals")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Side-load originals"), { target: { value: "recycle" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith("cyberdrop_workspace", expect.objectContaining({ request: { action: "sideload", settings: { originalAction: "recycle" } } })));
    expect(screen.getByLabelText("Side-load preset")).toHaveValue("high");
  });
});


describe("Cyberdrop live progress and editor tabs", () => {
  it("shows live transfer metrics and separate logs", async () => {
    const existing = api.getMockImplementation()!;
    api.mockImplementation(async (command, args) => command === "cyberdrop_status" ? { status: "Running", started: 1, logs: ["log sample"], progress: { active: 1, bytes: 250, speed: 50, files: [{ description: "test.mp4", domain: "example.com", size: 1000, completed: 250, bytes_downloaded: 250, speed: 50, eta: 15, hls: false }] } } : existing(command, args));
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Monitor" }));
    expect(await screen.findByText("test.mp4")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(screen.getByText("15s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByLabelText("Cyberdrop output")).toHaveTextContent("log sample");
  });
  it("keeps multiple documents in tabs and closes independently", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await screen.findByLabelText("Workstation editor");
    fireEvent.click(screen.getByRole("button", { name: "View URLs.txt" }));
    await screen.findByLabelText("URLs.txt editor");
    expect(screen.getAllByRole("tab", { name: /URLs.txt/ })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Close URLs.txt" })[1]);
    expect(await screen.findByLabelText("Workstation editor")).toBeInTheDocument();
  });
  it("opening the workspace folder does not disable the editor", async () => {
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await screen.findByLabelText("Workstation editor");
    vi.mocked(openPath).mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Open workspace folder" }));
    expect(screen.getByLabelText("Workstation editor")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
  });
});
