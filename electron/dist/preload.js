"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Expose a safe API to the renderer that replaces window.chrome.webview.
electron_1.contextBridge.exposeInMainWorld("electronAPI", {
    // Perform a mutating (POST) request against the local Rust server. The session
    // token is attached in MAIN (never exposed here), so the renderer can drive
    // destructive routes without ever holding the secret. `route` is a server path
    // like "/api/delete?path=…"; `body`, when present, is JSON-encoded.
    mutate: (route, body) => electron_1.ipcRenderer.invoke("mutate", route, body),
    // Encrypted secret storage (AI API keys) backed by the OS keystore via
    // Electron safeStorage in MAIN. Values never touch localStorage.
    secrets: {
        get: (key) => electron_1.ipcRenderer.invoke("secrets:get", key),
        set: (key, value) => electron_1.ipcRenderer.invoke("secrets:set", key, value),
        delete: (key) => electron_1.ipcRenderer.invoke("secrets:delete", key),
    },
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
    // Clipboard: read text (fallback for terminal paste when the renderer blocks
    // the async web Clipboard API).
    clipboardReadText: () => electron_1.ipcRenderer.invoke("clipboardReadText"),
    // Clipboard: copy files as CF_HDROP (paste in Explorer & other apps).
    copyFiles: (paths) => electron_1.ipcRenderer.invoke("copyFiles", paths),
    // Clipboard: write the selection as CF_HDROP with a drop effect — cut=true ⇒
    // MOVE (Paste relocates), cut=false ⇒ COPY. Resolves true when real CF_HDROP
    // was written (native addon present), false when it degraded to text.
    clipboardWriteFiles: (paths, cut) => electron_1.ipcRenderer.invoke("clipboardWriteFiles", paths, cut),
    // Clipboard: read a CF_HDROP file list (+ whether it was a Cut) for
    // paste-into-folder. Resolves { paths: [], preferMove: false } when empty.
    clipboardReadFiles: () => electron_1.ipcRenderer.invoke("clipboardReadFiles"),
    // Move files into a folder via the Windows shell (IFileOperation). Shows the
    // real native dialogs — progress, Replace/Skip/Keep both, "source and
    // destination file names are the same", elevation — exactly like Explorer.
    moveItemsNative: (paths, destination) => electron_1.ipcRenderer.invoke("moveItemsNative", paths, destination),
    // Copy files into a folder via the Windows shell (IFileOperation) — same
    // guarded engine + native dialogs as moveItemsNative, for paste-copy / drag-in.
    copyItemsNative: (paths, destination) => electron_1.ipcRenderer.invoke("copyItemsNative", paths, destination),
    // Best-effort restore of a recycled item to its original path (Phase 6 undo).
    // Resolves true when the item was found in the Recycle Bin and put back; false
    // when it couldn't be located (the renderer then tells the user to restore it
    // manually from the Recycle Bin). Never overwrites/deletes on failure.
    restoreFromRecycleBin: (originalPath) => electron_1.ipcRenderer.invoke("restoreFromRecycleBin", originalPath),
    // Electron 32+ no longer exposes file.path directly in the renderer.
    getPathForFile: (file) => electron_1.webUtils.getPathForFile(file),
    // Read an image file off disk → base64 data URL (for attaching tree files as
    // vision inputs). Returns { dataUrl, mediaType } or { error }.
    readFileBase64: (filePath) => electron_1.ipcRenderer.invoke("readFileBase64", filePath),
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
    // cancel). The renderer clears its drag UI state immediately. When `info.outcome`
    // is an external move it may rescan (a moved-out folder is gone from disk) —
    // unless `info.deferred` is true, meaning the OS is still transferring on its
    // own thread; in that case the rescan waits for `onNativeMoveSettled`. `info`
    // is omitted on the error-fallback path.
    onNativeDropEnd: (cb) => {
        const listener = (_evt, info) => cb(info);
        electron_1.ipcRenderer.on("nativeDropEnd", listener);
        return () => electron_1.ipcRenderer.removeListener("nativeDropEnd", listener);
    },
    // An async external MOVE finished transferring: the OS performed the copy on
    // its own thread and removed the sources reported in `info.deleted`. Fired once
    // after a `deferred` onNativeDropEnd so the initiating renderer can rescan now
    // that the move is actually complete on disk.
    onNativeMoveSettled: (cb) => {
        const listener = (_evt, info) => cb(info);
        electron_1.ipcRenderer.on("nativeMoveSettled", listener);
        return () => electron_1.ipcRenderer.removeListener("nativeMoveSettled", listener);
    },
    // ── Cloud LLM gateway ──────────────────────────────────────────────────────
    // Ollama is reached directly from the renderer (same-origin /api/ai-chat on the
    // Rust server). OpenAI/Anthropic need TLS + SSE, so main makes the request and
    // streams unified events back over "llmEvent" keyed by a per-request id.
    llm: {
        models: (provider, apiKey) => electron_1.ipcRenderer.invoke("llmModels", provider, apiKey),
        start: (reqId, payload) => electron_1.ipcRenderer.send("llmStart", reqId, payload),
        cancel: (reqId) => electron_1.ipcRenderer.send("llmCancel", reqId),
        onEvent: (cb) => {
            const listener = (_evt, reqId, ev) => cb(reqId, ev);
            electron_1.ipcRenderer.on("llmEvent", listener);
            return () => electron_1.ipcRenderer.removeListener("llmEvent", listener);
        },
    },
    // ── Agent web access (approval-gated) ──────────────────────────────────────
    // Outbound network requests run in MAIN (renderer CSP forbids them). Both are
    // bounded (size cap + timeout) and only invoked after the user approves the
    // tool call in chat.
    webFetch: (url, opts) => electron_1.ipcRenderer.invoke("web-fetch", url, opts),
    webSearch: (query) => electron_1.ipcRenderer.invoke("web-search", query),
    // ── MCP client bridge ───────────────────────────────────────────────────────
    // Minimal Model Context Protocol client (stdio / http JSON-RPC) lives in MAIN;
    // the renderer discovers (listTools) and invokes (callTool) configured servers.
    mcp: {
        listTools: (server) => electron_1.ipcRenderer.invoke("mcp:listTools", server),
        callTool: (server, name, args) => electron_1.ipcRenderer.invoke("mcp:callTool", server, name, args),
    },
    // Context menu actions dispatched from Electron main (rename, delete, etc.)
    onContextMenuAction: (cb) => {
        const listener = (_evt, action, path) => cb(action, path);
        electron_1.ipcRenderer.on("contextMenuAction", listener);
        return () => electron_1.ipcRenderer.removeListener("contextMenuAction", listener);
    },
    // Real Windows shell context menu for the given path(s) at the cursor.
    shellContextMenu: (paths, x, y) => electron_1.ipcRenderer.invoke("shellContextMenu", paths, x, y),
    // Native OS desktop notification (F9 low-space alerts). Resolves true when a
    // notification was shown (Notifications supported on this platform).
    notify: (title, body) => electron_1.ipcRenderer.invoke("notify", title, body),
    // Integrated terminal: spawn a real shell (PTY) and stream its output to
    // xterm.js in the renderer. `onData`/`onExit` return unsubscribe functions.
    terminal: {
        profiles: () => electron_1.ipcRenderer.invoke("terminalProfiles"),
        spawn: (profileId, cwd, cols, rows) => electron_1.ipcRenderer.invoke("terminalSpawn", profileId, cwd, cols, rows),
        write: (id, data) => electron_1.ipcRenderer.send("terminalWrite", id, data),
        resize: (id, cols, rows) => electron_1.ipcRenderer.send("terminalResize", id, cols, rows),
        kill: (id) => electron_1.ipcRenderer.send("terminalKill", id),
        onData: (cb) => {
            const listener = (_evt, id, data) => cb(id, data);
            electron_1.ipcRenderer.on("terminalData", listener);
            return () => electron_1.ipcRenderer.removeListener("terminalData", listener);
        },
        onExit: (cb) => {
            const listener = (_evt, id, code) => cb(id, code);
            electron_1.ipcRenderer.on("terminalExit", listener);
            return () => electron_1.ipcRenderer.removeListener("terminalExit", listener);
        },
    },
});
