import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({ openPath: vi.fn(), revealPath: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../api/client", () => client);

import { EverythingView, formatSize, parentOf, resetSearchSession } from "./EverythingView";
import type { PluginDef } from "../lib/plugins";

const hit = { name: "holiday.mp4", path: "D:\\Media\\Videos\\holiday.mp4", size: 1_048_576, modified: 1_655_526_400, isDir: false };

function answer(command: string) {
  if (command === "everything_status") return Promise.resolve({ es: "C:\\Everything\\es.exe", http: false, ready: true });
  return Promise.resolve({ results: [hit], total: 1, source: "es" });
}

// Real timers throughout: the panel debounces typing, and waitFor cannot make
// progress while the clock is frozen.
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  localStorage.clear();
  resetSearchSession();
  invoke.mockReset();
  client.openPath.mockReset();
  client.revealPath.mockReset();
  client.openPath.mockResolvedValue(undefined);
  client.revealPath.mockResolvedValue(undefined);
  invoke.mockImplementation(answer);
});
afterEach(cleanup);

async function type(text: string) {
  fireEvent.change(screen.getByLabelText("Search every drive"), { target: { value: text } });
  await settle();
}

describe("helpers", () => {
  it("formats sizes and blanks a folder", () => {
    expect(formatSize(1_048_576)).toBe("1.0 MiB");
    expect(formatSize(null)).toBe("");
  });

  it("takes the parent folder, keeping a drive root intact", () => {
    expect(parentOf("D:\\Media\\a.mp4")).toBe("D:\\Media");
    expect(parentOf("D:\\a.mp4")).toBe("D:\\");
  });
});

describe("EverythingView", () => {
  it("waits for a pause in typing before searching once", async () => {
    render(<EverythingView plugin={{} as PluginDef} />);
    fireEvent.change(screen.getByLabelText("Search every drive"), { target: { value: "hol" } });
    fireEvent.change(screen.getByLabelText("Search every drive"), { target: { value: "holi" } });
    await settle();
    const searches = invoke.mock.calls.filter(([command]) => command === "everything_search");
    expect(searches).toHaveLength(1);
    expect(searches[0][1]).toMatchObject({ query: "holi", limit: 200, prefer: "auto" });
  });

  it("lists a hit with its folder, size and date", async () => {
    render(<EverythingView plugin={{} as PluginDef} />);
    await type("holiday");
    await waitFor(() => expect(screen.getByText("holiday.mp4")).toBeInTheDocument());
    expect(screen.getByText("D:\\Media\\Videos")).toBeInTheDocument();
    expect(screen.getByText("1.0 MiB")).toBeInTheDocument();
  });

  it("opens a hit on double click and reveals it from its button", async () => {
    render(<EverythingView plugin={{} as PluginDef} />);
    await type("holiday");
    await waitFor(() => expect(screen.getByText("holiday.mp4")).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByText("holiday.mp4"));
    expect(client.openPath).toHaveBeenCalledWith(hit.path);
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(client.revealPath).toHaveBeenCalledWith(hit.path);
  });

  it("explains itself when Everything cannot be reached", async () => {
    invoke.mockImplementation((command: string) =>
      command === "everything_status"
        ? Promise.resolve({ es: null, http: false, ready: false })
        : Promise.reject("Everything was not reachable"));
    render(<EverythingView plugin={{} as PluginDef} />);
    await waitFor(() => expect(screen.getByText(/HTTP server/)).toBeInTheDocument());
    await type("holiday");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not reachable"));
  });

  it("clears the results when the box is emptied", async () => {
    render(<EverythingView plugin={{} as PluginDef} />);
    await type("holiday");
    await waitFor(() => expect(screen.getByText("holiday.mp4")).toBeInTheDocument());
    await type("");
    expect(screen.queryByText("holiday.mp4")).not.toBeInTheDocument();
  });
});
