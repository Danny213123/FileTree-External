"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Expose a safe API to the renderer that replaces window.chrome.webview.
electron_1.contextBridge.exposeInMainWorld("electronAPI", {
    // Fire-and-forget: starting the drag must NOT block the renderer. Main calls
    // Electron's webContents.startDrag, which hands the drag to Chromium so the
    // renderer stays responsive — auto-scroll and internal drop-to-move
    // (onDragOver/onDrop) keep working, and a drop onto Explorer copies the file.
    startDrag: (filePaths) => {
        electron_1.ipcRenderer.send("ondragstart", filePaths);
    },
    // TEMP diagnostic: forward a renderer log line to the main-process terminal.
    diag: (message) => {
        electron_1.ipcRenderer.send("diag", message);
    },
    // Clipboard: copy file path as text.
    copyText: (text) => electron_1.ipcRenderer.invoke("copyText", text),
    // Clipboard: copy files as CF_HDROP (paste in Explorer).
    copyFiles: (paths) => electron_1.ipcRenderer.invoke("copyFiles", paths),
    // Move files into a folder via the Windows shell (IFileOperation). Shows the
    // real native dialogs — progress, Replace/Skip/Keep both, "source and
    // destination file names are the same", elevation — exactly like Explorer.
    moveItemsNative: (paths, destination) => electron_1.ipcRenderer.invoke("moveItemsNative", paths, destination),
    // Electron 32+ no longer exposes file.path directly in the renderer.
    getPathForFile: (file) => electron_1.webUtils.getPathForFile(file),
    // Register a callback for folders dropped onto the window from Explorer.
    onExternalDrop: (cb) => {
        electron_1.ipcRenderer.on("externalDrop", (_evt, paths) => cb(paths));
    },
    // During a native drag, main process polls cursor position and sends updates.
    // Use this to track where the user is hovering so tab bar can react.
    onNativeDragMove: (cb) => {
        electron_1.ipcRenderer.on("nativeDragMove", (_evt, x, y, path) => cb(x, y, path));
    },
    onNativeDragEnd: (cb) => {
        electron_1.ipcRenderer.on("nativeDragEnd", (_evt) => cb());
    },
    // A native drag-out ended with the pointer back over a FileTree window. The
    // renderer hit-tests (clientX, clientY) to find the destination folder and
    // performs the move itself. Returns an unsubscribe fn.
    onNativeDropInternal: (cb) => {
        const listener = (_evt, x, y, paths) => cb(x, y, paths);
        electron_1.ipcRenderer.on("nativeDropInternal", listener);
        return () => electron_1.ipcRenderer.removeListener("nativeDropInternal", listener);
    },
    // A native drag-out ended without an internal drop (external move/copy or
    // cancel). The renderer should just clear its drag UI state.
    onNativeDropEnd: (cb) => {
        const listener = (_evt) => cb();
        electron_1.ipcRenderer.on("nativeDropEnd", listener);
        return () => electron_1.ipcRenderer.removeListener("nativeDropEnd", listener);
    },
    // Context menu actions dispatched from Electron main (rename, delete, etc.)
    onContextMenuAction: (cb) => {
        const listener = (_evt, action, path) => cb(action, path);
        electron_1.ipcRenderer.on("contextMenuAction", listener);
        return () => electron_1.ipcRenderer.removeListener("contextMenuAction", listener);
    },
    // Real Windows shell context menu for the given path(s) at the cursor.
    shellContextMenu: (paths, x, y) => electron_1.ipcRenderer.invoke("shellContextMenu", paths, x, y),
});
