import { contextBridge, ipcRenderer } from "electron";

// Expose a safe API to the renderer that replaces window.chrome.webview.
contextBridge.exposeInMainWorld("electronAPI", {
  // sendSync keeps startDrag inside the dragstart event context (required by Electron).
  startDrag: (filePath: string): { ok: boolean; status: string; error?: string } =>
    ipcRenderer.sendSync("ondragstart", filePath),

  // Call after dragend to move the dragged source to the OS trash.
  deleteAfterDrag: (filePath: string): Promise<{ ok: boolean; status?: string; error?: string }> =>
    ipcRenderer.invoke("deleteAfterDrag", filePath),

  // Clipboard: copy file path as text.
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke("copyText", text),

  // Clipboard: copy files as CF_HDROP (paste in Explorer).
  copyFiles: (paths: string[]): Promise<void> =>
    ipcRenderer.invoke("copyFiles", paths),

  // Register a callback for folders dropped onto the window from Explorer.
  onExternalDrop: (cb: (paths: string[]) => void) => {
    ipcRenderer.on("externalDrop", (_evt, paths: string[]) => cb(paths));
  },

  // During a native drag, main process polls cursor position and sends updates.
  // Use this to track where the user is hovering so tab bar can react.
  onNativeDragMove: (cb: (x: number, y: number, path: string) => void) => {
    ipcRenderer.on("nativeDragMove", (_evt, x: number, y: number, path: string) => cb(x, y, path));
  },
  onNativeDragEnd: (cb: () => void) => {
    ipcRenderer.on("nativeDragEnd", (_evt) => cb());
  },

  // Context menu actions dispatched from Electron main (rename, delete, etc.)
  onContextMenuAction: (cb: (action: string, path: string) => void) => {
    ipcRenderer.on("contextMenuAction", (_evt, action: string, path: string) => cb(action, path));
  },

  // Shell context menu for the given path at screen position.
  shellContextMenu: (path: string, x: number, y: number): Promise<void> =>
    ipcRenderer.invoke("shellContextMenu", path, x, y),
});
