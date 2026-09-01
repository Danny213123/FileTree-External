import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage?: (value: unknown) => void }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (value: T) => void;

    constructor() {
      mocks.channels.push(this as { onmessage?: (value: unknown) => void });
    }
  },
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { getTerminalAPI } from "./terminal";

describe("Tauri terminal bridge", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    vi.mocked(invoke).mockReset();
    mocks.channels.length = 0;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("loads profiles from the desktop backend", async () => {
    vi.mocked(invoke).mockResolvedValue([{ id: "powershell", label: "PowerShell" }]);

    await expect(getTerminalAPI()?.profiles()).resolves.toEqual([
      { id: "powershell", label: "PowerShell" },
    ]);
    expect(invoke).toHaveBeenCalledWith("terminal_profiles");
  });

  it("streams output and routes terminal controls", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "terminal_spawn") return { id: 7, title: "PowerShell" };
      return undefined;
    });
    const api = getTerminalAPI();
    expect(api).not.toBeNull();
    const onData = vi.fn();
    const onExit = vi.fn();
    const offData = api!.onData(onData);
    const offExit = api!.onExit(onExit);

    await expect(api!.spawn("powershell", "E:\\", 120, 30)).resolves.toEqual({
      id: 7,
      title: "PowerShell",
    });
    const channel = mocks.channels[mocks.channels.length - 1];
    expect(channel).toBeDefined();
    channel?.onmessage?.({ kind: "data", id: 7, data: [80, 83, 62, 32] });
    channel?.onmessage?.({ kind: "exit", id: 7, code: 0 });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(onData).toHaveBeenCalledWith(7, Uint8Array.from([80, 83, 62, 32]));
    expect(onExit).toHaveBeenCalledWith(7, 0);

    api!.write(7, "dir\r");
    api!.resize(7, 100, 25);
    api!.kill(7);
    expect(invoke).toHaveBeenCalledWith("terminal_write", { id: 7, data: "dir\r" });
    expect(invoke).toHaveBeenCalledWith("terminal_resize", { id: 7, cols: 100, rows: 25 });
    expect(invoke).toHaveBeenCalledWith("terminal_kill", { id: 7 });

    offData();
    offExit();
  });
});
