// Opening a folder in FileTree Explorer instead of File Explorer.
//
// The companion app is a file manager; this one is a disk-usage tool. When both
// are installed, "open this folder" should land in the file manager — that is
// the whole reason the other app exists.
//
// If it is not installed, or the user turns this off, folders go to the shell's
// own handler exactly as before. Nothing here should ever be the reason a
// double-click does nothing.

import { invoke } from "@tauri-apps/api/core";
import { isTauriV2 } from "../api/v2";

const ENABLED_KEY = "filetree.folderApp.enabled";
const PATH_KEY = "filetree.folderApp.path";

/** Cached for the session: locating the exe touches the filesystem. */
let located: string | null | undefined;

export function folderAppEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) !== "0"; } catch { return true; }
}

export function setFolderAppEnabled(enabled: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0"); } catch { /* blocked */ }
}

/** A path the user set by hand wins over anything auto-detected. */
export function folderAppPath(): string {
  try { return localStorage.getItem(PATH_KEY) ?? ""; } catch { return ""; }
}

export function setFolderAppPath(path: string): void {
  try { localStorage.setItem(PATH_KEY, path); } catch { /* blocked */ }
  located = undefined;
}

/** Where the companion app is, or null when it is not installed. */
export async function findFolderApp(): Promise<string | null> {
  const configured = folderAppPath();
  if (configured) return configured;
  if (located !== undefined) return located;
  if (!isTauriV2()) { located = null; return null; }
  located = await invoke<string | null>("locate_folder_app").catch(() => null);
  return located;
}

/** Forget the cached lookup, so a freshly installed app is picked up. */
export function refreshFolderApp(): void {
  located = undefined;
}

/**
 * Try to open `path` in the companion app.
 *
 * Resolves false when this is not a folder, the app is not installed, or the
 * setting is off — the caller then falls back to the shell. A failure to launch
 * is reported, because at that point the user did ask for something specific.
 */
export interface HandlerStatus {
  /** Windows opens folders with the companion app right now. */
  enabled: boolean;
  /** Whatever holds the association instead, when it is not us. */
  conflicting: string | null;
  supported: boolean;
}

/** Whether Windows itself opens folders with the companion app. */
export async function folderHandlerStatus(): Promise<HandlerStatus> {
  const exe = (await findFolderApp()) ?? "";
  if (!isTauriV2()) return { enabled: false, conflicting: null, supported: false };
  return invoke<HandlerStatus>("folder_handler_status", { exe });
}

/**
 * Register (or unregister) the companion app as Windows' folder handler.
 *
 * Separate from {@link folderAppEnabled}, which only decides what *FileTree*
 * does when you open a folder. This one changes the machine.
 */
export async function setFolderHandler(enabled: boolean): Promise<HandlerStatus> {
  const exe = (await findFolderApp()) ?? "";
  if (!exe) throw new Error("FileTree Explorer was not found");
  return invoke<HandlerStatus>("set_folder_handler", { exe, enabled });
}

export async function openInFolderApp(path: string): Promise<boolean> {
  if (!folderAppEnabled() || !isTauriV2()) return false;
  const exe = await findFolderApp();
  if (!exe) return false;
  return invoke<boolean>("open_folder_app", { path, exe });
}
