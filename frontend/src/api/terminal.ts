import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauriV2 } from "./v2";

export interface TerminalProfile {
  id: string;
  label: string;
}

export interface TerminalAPI {
  profiles: () => Promise<TerminalProfile[]>;
  spawn: (profileId: string, cwd: string, cols: number, rows: number) => Promise<{ id: number; title: string }>;
  write: (id: number, data: string) => void;
  resize: (id: number, cols: number, rows: number) => void;
  kill: (id: number) => void;
  onData: (callback: (id: number, data: Uint8Array) => void) => () => void;
  onExit: (callback: (id: number, code: number) => void) => () => void;
}

interface TauriTerminalEvent {
  kind: "data" | "exit";
  id: number;
  data?: number[];
  code?: number;
}

const dataListeners = new Set<(id: number, data: Uint8Array) => void>();
const exitListeners = new Set<(id: number, code: number) => void>();
// A Channel must stay reachable for as long as its native terminal session.
const liveChannels = new Map<number, Channel<TauriTerminalEvent>>();
const MAX_STARTUP_EVENT_BYTES = 1024 * 1024;

function deliverTerminalEvent(event: TauriTerminalEvent): void {
  if (event.kind === "data") {
    const bytes = Uint8Array.from(event.data ?? []);
    for (const listener of dataListeners) listener(event.id, bytes);
    return;
  }
  liveChannels.delete(event.id);
  for (const listener of exitListeners) listener(event.id, event.code ?? -1);
}

function reportTerminalError(action: string, error: unknown): void {
  console.warn(`Terminal ${action} failed`, error);
}

const tauriTerminalAPI: TerminalAPI = {
  profiles: () => invoke<TerminalProfile[]>("terminal_profiles"),
  spawn: async (profileId, cwd, cols, rows) => {
    const onEvent = new Channel<TauriTerminalEvent>();
    const startupEvents: TauriTerminalEvent[] = [];
    let startupBytes = 0;
    let ready = false;
    onEvent.onmessage = (event) => {
      if (!ready) {
        const eventBytes = event.kind === "data" ? (event.data?.length ?? 0) : 0;
        if (startupBytes + eventBytes <= MAX_STARTUP_EVENT_BYTES) {
          startupEvents.push(event);
          startupBytes += eventBytes;
        }
        return;
      }
      deliverTerminalEvent(event);
    };
    const result = await invoke<{ id: number; title: string }>("terminal_spawn", {
      profileId,
      cwd,
      cols,
      rows,
      onEvent,
    });
    liveChannels.set(result.id, onEvent);
    // Let TerminalPanel's spawn continuation associate the native id with its
    // xterm before the shell's first prompt bytes are delivered.
    window.setTimeout(() => {
      ready = true;
      for (const event of startupEvents) deliverTerminalEvent(event);
      startupEvents.length = 0;
    }, 0);
    return result;
  },
  write: (id, data) => {
    void invoke("terminal_write", { id, data }).catch((error) => reportTerminalError("write", error));
  },
  resize: (id, cols, rows) => {
    void invoke("terminal_resize", { id, cols, rows }).catch((error) => reportTerminalError("resize", error));
  },
  kill: (id) => {
    void invoke("terminal_kill", { id }).catch((error) => reportTerminalError("stop", error));
  },
  onData: (callback) => {
    dataListeners.add(callback);
    return () => dataListeners.delete(callback);
  },
  onExit: (callback) => {
    exitListeners.add(callback);
    return () => exitListeners.delete(callback);
  },
};

export function getTerminalAPI(): TerminalAPI | null {
  const electron = (window as unknown as { electronAPI?: { terminal?: TerminalAPI } }).electronAPI?.terminal;
  if (electron) return electron;
  return isTauriV2() ? tauriTerminalAPI : null;
}
