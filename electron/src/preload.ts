import { contextBridge, ipcRenderer, webUtils } from "electron";

// Expose a safe API to the renderer that replaces window.chrome.webview.
contextBridge.exposeInMainWorld("electronAPI", {
  // Perform a mutating (POST) request against the local Rust server. The session
  // token is attached in MAIN (never exposed here), so the renderer can drive
  // destructive routes without ever holding the secret. `route` is a server path
  // like "/api/delete?path=…"; `body`, when present, is JSON-encoded.
  mutate: (route: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> =>
    ipcRenderer.invoke("mutate", route, body),

  // Encrypted secret storage (AI API keys) backed by the OS keystore via
  // Electron safeStorage in MAIN. Values never touch localStorage.
  secrets: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke("secrets:get", key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke("secrets:set", key, value),
    delete: (key: string): Promise<void> => ipcRenderer.invoke("secrets:delete", key),
  },

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

  // Clipboard: read text (fallback for terminal paste when the renderer blocks
  // the async web Clipboard API).
  clipboardReadText: (): Promise<string> =>
    ipcRenderer.invoke("clipboardReadText"),

  // Clipboard: copy files as CF_HDROP (paste in Explorer & other apps).
  copyFiles: (paths: string[]): Promise<void> =>
    ipcRenderer.invoke("copyFiles", paths),

  // Clipboard: write the selection as CF_HDROP with a drop effect — cut=true ⇒
  // MOVE (Paste relocates), cut=false ⇒ COPY. Resolves true when real CF_HDROP
  // was written (native addon present), false when it degraded to text.
  clipboardWriteFiles: (paths: string[], cut: boolean): Promise<boolean> =>
    ipcRenderer.invoke("clipboardWriteFiles", paths, cut),

  // Clipboard: read a CF_HDROP file list (+ whether it was a Cut) for
  // paste-into-folder. Resolves { paths: [], preferMove: false } when empty.
  clipboardReadFiles: (): Promise<{ paths: string[]; preferMove: boolean }> =>
    ipcRenderer.invoke("clipboardReadFiles"),

  // Move files into a folder via the Windows shell (IFileOperation). Shows the
  // real native dialogs — progress, Replace/Skip/Keep both, "source and
  // destination file names are the same", elevation — exactly like Explorer.
  moveItemsNative: (
    paths: string[],
    destination: string,
  ): Promise<{ aborted: boolean; moved: number; skipped: number; failed: number }> =>
    ipcRenderer.invoke("moveItemsNative", paths, destination),

  // Copy files into a folder via the Windows shell (IFileOperation) — same
  // guarded engine + native dialogs as moveItemsNative, for paste-copy / drag-in.
  copyItemsNative: (
    paths: string[],
    destination: string,
  ): Promise<{ aborted: boolean; moved: number; skipped: number; failed: number }> =>
    ipcRenderer.invoke("copyItemsNative", paths, destination),

  // Best-effort restore of a recycled item to its original path (Phase 6 undo).
  // Resolves true when the item was found in the Recycle Bin and put back; false
  // when it couldn't be located (the renderer then tells the user to restore it
  // manually from the Recycle Bin). Never overwrites/deletes on failure.
  restoreFromRecycleBin: (originalPath: string): Promise<boolean> =>
    ipcRenderer.invoke("restoreFromRecycleBin", originalPath),

  // Electron 32+ no longer exposes file.path directly in the renderer.
  getPathForFile: (file: File): string =>
    webUtils.getPathForFile(file),

  // Read an image file off disk → base64 data URL (for attaching tree files as
  // vision inputs). Returns { dataUrl, mediaType } or { error }.
  readFileBase64: (filePath: string): Promise<{ dataUrl?: string; mediaType?: string; error?: string }> =>
    ipcRenderer.invoke("readFileBase64", filePath),

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
  // cancel). The renderer clears its drag UI state immediately. When `info.outcome`
  // is an external move it may rescan (a moved-out folder is gone from disk) —
  // unless `info.deferred` is true, meaning the OS is still transferring on its
  // own thread; in that case the rescan waits for `onNativeMoveSettled`. `info`
  // is omitted on the error-fallback path.
  onNativeDropEnd: (cb: (info?: { outcome: string; deleted: string[]; deferred?: boolean }) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, info?: { outcome: string; deleted: string[]; deferred?: boolean }) => cb(info);
    ipcRenderer.on("nativeDropEnd", listener);
    return () => ipcRenderer.removeListener("nativeDropEnd", listener);
  },

  // An async external MOVE finished transferring: the OS performed the copy on
  // its own thread and removed the sources reported in `info.deleted`. Fired once
  // after a `deferred` onNativeDropEnd so the initiating renderer can rescan now
  // that the move is actually complete on disk.
  onNativeMoveSettled: (cb: (info: { deleted: string[] }) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, info: { deleted: string[] }) => cb(info);
    ipcRenderer.on("nativeMoveSettled", listener);
    return () => ipcRenderer.removeListener("nativeMoveSettled", listener);
  },

  // ── Cloud LLM gateway ──────────────────────────────────────────────────────
  // Ollama is reached directly from the renderer (same-origin /api/ai-chat on the
  // Rust server). OpenAI/Anthropic need TLS + SSE, so main makes the request and
  // streams unified events back over "llmEvent" keyed by a per-request id.
  llm: {
    models: (provider: string, apiKey?: string): Promise<string[]> =>
      ipcRenderer.invoke("llmModels", provider, apiKey),
    start: (reqId: string, payload: unknown): void =>
      ipcRenderer.send("llmStart", reqId, payload),
    cancel: (reqId: string): void =>
      ipcRenderer.send("llmCancel", reqId),
    onEvent: (cb: (reqId: string, ev: unknown) => void) => {
      const listener = (_evt: Electron.IpcRendererEvent, reqId: string, ev: unknown) => cb(reqId, ev);
      ipcRenderer.on("llmEvent", listener);
      return () => ipcRenderer.removeListener("llmEvent", listener);
    },
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

  // Integrated terminal: spawn a real shell (PTY) and stream its output to
  // xterm.js in the renderer. `onData`/`onExit` return unsubscribe functions.
  terminal: {
    profiles: (): Promise<{ id: string; label: string }[]> =>
      ipcRenderer.invoke("terminalProfiles"),
    spawn: (profileId: string, cwd: string, cols: number, rows: number): Promise<{ id: number; title: string }> =>
      ipcRenderer.invoke("terminalSpawn", profileId, cwd, cols, rows),
    write: (id: number, data: string): void =>
      ipcRenderer.send("terminalWrite", id, data),
    resize: (id: number, cols: number, rows: number): void =>
      ipcRenderer.send("terminalResize", id, cols, rows),
    kill: (id: number): void =>
      ipcRenderer.send("terminalKill", id),
    onData: (cb: (id: number, data: Uint8Array) => void) => {
      const listener = (_evt: Electron.IpcRendererEvent, id: number, data: Uint8Array) => cb(id, data);
      ipcRenderer.on("terminalData", listener);
      return () => ipcRenderer.removeListener("terminalData", listener);
    },
    onExit: (cb: (id: number, code: number) => void) => {
      const listener = (_evt: Electron.IpcRendererEvent, id: number, code: number) => cb(id, code);
      ipcRenderer.on("terminalExit", listener);
      return () => ipcRenderer.removeListener("terminalExit", listener);
    },
  },
});
