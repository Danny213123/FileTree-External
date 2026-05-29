"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Expose a safe API to the renderer that replaces window.chrome.webview.
electron_1.contextBridge.exposeInMainWorld("electronAPI", {
    // sendSync keeps startDrag inside the dragstart event context (required by Electron).
    startDrag: (filePath) => electron_1.ipcRenderer.sendSync("ondragstart", filePath),
    // Call after dragend to move the dragged source to the OS trash.
    deleteAfterDrag: (filePath) => electron_1.ipcRenderer.invoke("deleteAfterDrag", filePath),
    // Clipboard: copy file path as text.
    copyText: (text) => electron_1.ipcRenderer.invoke("copyText", text),
    // Clipboard: copy files as CF_HDROP (paste in Explorer).
    copyFiles: (paths) => electron_1.ipcRenderer.invoke("copyFiles", paths),
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
    // Context menu actions dispatched from Electron main (rename, delete, etc.)
    onContextMenuAction: (cb) => {
        electron_1.ipcRenderer.on("contextMenuAction", (_evt, action, path) => cb(action, path));
    },
    // Shell context menu for the given path at screen position.
    shellContextMenu: (path, x, y) => electron_1.ipcRenderer.invoke("shellContextMenu", path, x, y),
});
