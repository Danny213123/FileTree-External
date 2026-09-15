// Demo build only: Vite aliases "@tauri-apps/api/core" to this module (see
// vite.config.ts). Everything is the real Tauri module except `invoke`, which
// answers app commands from demo data. Tauri's own `plugin:*` calls (window
// controls, events) still reach the desktop shell. Tauri defines its IPC
// functions as read-only, so they cannot be replaced at runtime instead.
export * from "../../node_modules/@tauri-apps/api/core.js";
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "../../node_modules/@tauri-apps/api/core.js";
import { handleDemoCommand } from "./install";

export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (cmd.startsWith("plugin:")) return tauriInvoke<T>(cmd, args, options);
  return handleDemoCommand(cmd, (args ?? {}) as Record<string, unknown>) as T;
}
