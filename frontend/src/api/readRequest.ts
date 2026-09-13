import { invoke } from "@tauri-apps/api/core";

/** Bound read-only requests so a stalled backend cannot leave loading permanent.
 * Never use for mutations: a timeout does not cancel native work. */
export async function invokeRead<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke<T>(command, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${command}: FileTree did not respond within 30 seconds. Retry, or restart FileTree if other views are also stuck.`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
