import { contextBridge, ipcRenderer, webUtils } from "electron";

// Expose a safe API to the renderer that replaces window.chrome.webview.
contextBridge.exposeInMainWorld("electronAPI", {
  // Fire-and-forget: starting the drag must NOT block the renderer. Main calls
  // Electron's webContents.startDrag, which hands the drag to Chromium so the
  // renderer stays responsive — auto-scroll and internal drop-to-move
  // (onDragOver/onDrop) keep working, and a drop onto Explorer copies the file.
  startDrag: (filePaths: string | string[]): void => {
    ipcRenderer.send("ondragstart", filePaths);
  },

  // TEMP diagnostic: forward a renderer log line to the main-process terminal.
  diag: (message: string): void => {
    ipcRenderer.send("diag", message);
  },

  // Clipboard: copy file path as text.
  copyText: (text: string): Promise<void> =>
    ipcRenderer.invoke("copyText", text),

  // Clipboard: copy files as CF_HDROP (paste in Explorer).
  copyFiles: (paths: string[]): Promise<void> =>
    ipcRenderer.invoke("copyFiles", paths),

  // Move files into a folder via the Windows shell (IFileOperation). Shows the
  // real native dialogs — progress, Replace/Skip/Keep both, "source and
  // destination file names are the same", elevation — exactly like Explorer.
  moveItemsNative: (paths: string[], destination: string): Promise<{ aborted: boolean }> =>
    ipcRenderer.invoke("moveItemsNative", paths, destination),

  // Electron 32+ no longer exposes file.path directly in the renderer.
  getPathForFile: (file: File): string =>
    webUtils.getPathForFile(file),

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

  // A native drag-out ended with the pointer back over a FileTree window. The
  // renderer hit-tests (clientX, clientY) to find the destination folder and
  // performs the move itself. Returns an unsubscribe fn.
  onNativeDropInternal: (cb: (clientX: number, clientY: number, paths: string[]) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, x: number, y: number, paths: string[]) => cb(x, y, paths);
    ipcRenderer.on("nativeDropInternal", listener);
    return () => ipcRenderer.removeListener("nativeDropInternal", listener);
  },

  // A native drag-out ended without an internal drop (external move/copy or
  // cancel). The renderer should just clear its drag UI state.
  onNativeDropEnd: (cb: () => void) => {
    const listener = (_evt: Electron.IpcRendererEvent) => cb();
    ipcRenderer.on("nativeDropEnd", listener);
    return () => ipcRenderer.removeListener("nativeDropEnd", listener);
  },

  // Context menu actions dispatched from Electron main (rename, delete, etc.)
  onContextMenuAction: (cb: (action: string, path: string) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, action: string, path: string) => cb(action, path);
    ipcRenderer.on("contextMenuAction", listener);
    return () => ipcRenderer.removeListener("contextMenuAction", listener);
  },

  // Real Windows shell context menu for the given path(s) at the cursor.
  shellContextMenu: (paths: string | string[], x: number, y: number): Promise<void> =>
    ipcRenderer.invoke("shellContextMenu", paths, x, y),
});
