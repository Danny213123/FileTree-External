import {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  shell,
  Menu,
  screen,
} from "electron";
import * as path from "path";
import * as net from "net";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";

// ── Native drag-out addon ─────────────────────────────────────────────────────
// Runs the Windows shell drag itself (SHDoDragDrop, synchronously on this UI
// thread) so we learn the real OS drop effect. It classifies the drop:
//   * "external-move" — dropped on another app with MOVE; the source was
//                       deleted in native code (true move).
//   * "external-copy" — dropped on another app (copy/none); source preserved.
//   * "internal"      — dropped back on a FileTree window; native returns the
//                       drop point so the renderer can perform the move itself
//                       (Chromium can't complete its own drop while the UI
//                       thread is busy in the modal drag loop).
//   * "cancel"        — Esc; nothing happens.
// If the addon can't load we fall back to Electron's copy-only startDrag.
type NativeDragResult = { outcome: string; dropX: number; dropY: number; deleted: string[] };
type NativeMoveResult = { aborted: boolean };
type NativeContextMenuResult = { verb: string };
let nativeDragFiles: ((paths: string[]) => NativeDragResult) | null = null;
let nativeMoveItems:
  | ((sources: string[], dest: string, ownerHwnd: number) => Promise<NativeMoveResult>)
  | null = null;
let nativeContextMenu:
  | ((paths: string[], ownerHwnd: number) => NativeContextMenuResult)
  | null = null;

// Integrated-terminal PTY exports from the same Rust addon (ConPTY-backed).
type PtyChunk = { data: Buffer; exit: number | null };
let ptySpawn: ((program: string, args: string[], cwd: string, cols: number, rows: number) => number) | null = null;
let ptyRead: ((id: number) => PtyChunk) | null = null;
let ptyWrite: ((id: number, data: Buffer) => void) | null = null;
let ptyResize: ((id: number, cols: number, rows: number) => void) | null = null;
let ptyKill: ((id: number) => void) | null = null;
try {
  const addon = require(path.join(__dirname, "filetree_drag.node")) as {
    dragFiles?: (paths: string[]) => NativeDragResult;
    moveItemsNative?: (sources: string[], dest: string, ownerHwnd: number) => Promise<NativeMoveResult>;
    showContextMenuNative?: (paths: string[], ownerHwnd: number) => NativeContextMenuResult;
    ptySpawn?: (program: string, args: string[], cwd: string, cols: number, rows: number) => number;
    ptyRead?: (id: number) => PtyChunk;
    ptyWrite?: (id: number, data: Buffer) => void;
    ptyResize?: (id: number, cols: number, rows: number) => void;
    ptyKill?: (id: number) => void;
  };
  nativeDragFiles = typeof addon.dragFiles === "function" ? addon.dragFiles : null;
  nativeMoveItems = typeof addon.moveItemsNative === "function" ? addon.moveItemsNative : null;
  nativeContextMenu = typeof addon.showContextMenuNative === "function" ? addon.showContextMenuNative : null;
  ptySpawn = typeof addon.ptySpawn === "function" ? addon.ptySpawn : null;
  ptyRead = typeof addon.ptyRead === "function" ? addon.ptyRead : null;
  ptyWrite = typeof addon.ptyWrite === "function" ? addon.ptyWrite : null;
  ptyResize = typeof addon.ptyResize === "function" ? addon.ptyResize : null;
  ptyKill = typeof addon.ptyKill === "function" ? addon.ptyKill : null;
  if (!nativeDragFiles) console.warn("[electron] native drag addon missing dragFiles export");
  if (!nativeMoveItems) console.warn("[electron] native drag addon missing moveItemsNative export");
  if (!nativeContextMenu) console.warn("[electron] native drag addon missing showContextMenuNative export");
  if (!ptySpawn) console.warn("[electron] native addon missing pty exports; terminal disabled");
} catch (e) {
  console.warn("[electron] native drag addon unavailable; drag-out will copy:", e);
  nativeDragFiles = null;
  nativeMoveItems = null;
  nativeContextMenu = null;
  ptySpawn = ptyRead = ptyWrite = ptyResize = ptyKill = null;
}

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

// ── Broken-pipe safety ────────────────────────────────────────────────────────
// A closed *peer* pipe must never crash the app. When the read end of a stream
// we write to has already gone away (our own stdout/stderr when launched
// detached, the Rust server's stdout on shutdown, or an aborted socket), Node
// raises EPIPE/ECONNRESET/EOF — sometimes synchronously from inside a "data"
// handler. Left unhandled this pops Electron's fatal "A JavaScript error
// occurred in the main process" dialog. These codes are the benign counterpart
// of the Rust side's "connection aborted (os error 10053)" log, so we swallow
// only them and let every other error surface as before.
const BENIGN_PIPE_CODES = ["EPIPE", "ECONNRESET", "EOF"];
function isBenignPipeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return !!code && BENIGN_PIPE_CODES.includes(code);
}

// Log a stream "error" unless it is a benign broken-pipe (then ignore it).
function handleStreamError(label: string, err: NodeJS.ErrnoException): void {
  if (isBenignPipeError(err)) return;
  console.error(`[electron] ${label} stream error:`, err);
}

// Our own stdout/stderr can have their read end closed; guard against the
// resulting async EPIPE so a logging write never becomes fatal.
process.stdout.on("error", (err: NodeJS.ErrnoException) => handleStreamError("stdout", err));
process.stderr.on("error", (err: NodeJS.ErrnoException) => handleStreamError("stderr", err));

// Last-resort guard for a synchronously-thrown broken pipe that escapes the
// handlers above. Kept deliberately narrow: only the benign pipe codes are
// ignored, so real bugs still surface in the logs.
process.on("uncaughtException", (err) => {
  if (isBenignPipeError(err)) return; // benign broken pipe from server stdout/socket — ignore
  console.error(err);
});

// ── Port helpers ─────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on("error", reject);
  });
}

// Wait until the Rust server accepts connections on `port`.
function waitForServer(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.on("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error("Server did not start in time"));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
}

// ── Server launch ─────────────────────────────────────────────────────────────

async function startRustServer(port: number): Promise<void> {
  // Find the server binary next to the Electron app, or in the repo root.
  // app.getAppPath() = .../FileTree/electron  (where package.json lives)
  const repoRoot = path.join(app.getAppPath(), "..");
  const candidates = [
    path.join(repoRoot, "target", "release", "filetree.exe"),   // dev build
    path.join(repoRoot, "filetree-server.exe"),                  // packaged
    path.join(app.getAppPath(), "filetree-server.exe"),          // bundled next to electron/
  ];

  let serverBin = candidates.find((p) => fs.existsSync(p));
  if (!serverBin) {
    throw new Error(
      `Could not find filetree server binary. Tried:\n${candidates.join("\n")}`
    );
  }

  serverProcess = spawn(serverBin, ["serve", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Forward the server's logs to ours. The destination (our stdout/stderr) may
  // have a closed read end, making write() throw EPIPE synchronously — which is
  // exactly the crash we are fixing — so only write while it's still open and
  // swallow benign broken-pipe errors instead of letting them go fatal.
  const forwardLog = (dest: NodeJS.WriteStream, chunk: Buffer) => {
    try {
      if (dest.writable && !dest.destroyed) dest.write(chunk);
    } catch (err) {
      if (!isBenignPipeError(err)) throw err;
    }
  };
  serverProcess.stdout?.on("data", (d) => forwardLog(process.stdout, d));
  serverProcess.stderr?.on("data", (d) => forwardLog(process.stderr, d));
  // The server's pipes can also emit their own 'error' on teardown; don't crash.
  serverProcess.stdout?.on("error", (err: NodeJS.ErrnoException) => handleStreamError("server stdout", err));
  serverProcess.stderr?.on("error", (err: NodeJS.ErrnoException) => handleStreamError("server stderr", err));

  serverProcess.on("exit", (code) => {
    console.log(`[electron] Server exited with code ${code}`);
  });

  await waitForServer(port);
  console.log(`[electron] Rust server ready on port ${port}`);
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: "FileTree",
    backgroundColor: "#1e1e1e",
    // Frameless VS Code-style chrome: hide the OS title bar but keep the native
    // Windows caption buttons (min/max/close) as an overlay on the right. The
    // custom TitleBar fills the rest of the bar (menus) and is the drag region.
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#181818",
      symbolColor: "#cccccc",
      height: 35,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading from localhost.
      webSecurity: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // When a folder/file is dropped onto the Electron window from Explorer,
  // Chromium fires "will-navigate" with a file:// URL. Intercept it and
  // forward the path to the renderer instead of navigating away.
  mainWindow.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (url.startsWith("file://")) {
      try {
        const filePath = decodeURIComponent(new URL(url).pathname).replace(/^\//, "");
        // Normalize Windows path (remove leading slash before drive letter)
        const p = filePath.replace(/\//g, "\\");
        mainWindow?.webContents.send("externalDrop", [p]);
      } catch { /* ignore malformed URLs */ }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function createUniqueNewFolder(targetPath: string): string {
  const baseDir = (() => {
    try {
      return fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
    } catch {
      return path.dirname(targetPath);
    }
  })();

  for (let i = 1; i < 1000; i += 1) {
    const name = i === 1 ? "New Folder" : `New Folder (${i})`;
    const candidate = path.join(baseDir, name);
    if (!fs.existsSync(candidate)) {
      fs.mkdirSync(candidate);
      shell.showItemInFolder(candidate);
      return candidate;
    }
  }

  throw new Error(`Could not find an available New Folder name in ${baseDir}`);
}

function handleFileTreeContextAction(win: BrowserWindow | null, filePath: string, action: string): void {
  switch (action) {
    case "new-folder":
      try {
        createUniqueNewFolder(filePath);
      } catch (error) {
        win?.webContents.send("contextMenuAction", "error", String(error));
      }
      break;
    case "open-new-tab":
      win?.webContents.send("externalDrop", [filePath]);
      break;
    case "show-in-explorer":
      shell.showItemInFolder(filePath);
      break;
    case "copy-path":
      clipboard.writeText(filePath);
      break;
    case "copy-name":
      clipboard.writeText(path.basename(filePath));
      break;
    default:
      break;
  }
}

function showFallbackContextMenu(win: BrowserWindow | null, filePath: string, x: number, y: number): void {
  const isDir = (() => { try { return fs.statSync(filePath).isDirectory(); } catch { return false; } })();
  const escaped = filePath.replace(/'/g, "''");

  const fileTreeSubmenu: Electron.MenuItemConstructorOptions[] = [
    { label: "Open in new tab", enabled: isDir, click: () => win?.webContents.send("externalDrop", [filePath]) },
    { label: "Show in Explorer", click: () => shell.showItemInFolder(filePath) },
    { type: "separator" },
    { label: "Copy full path", click: () => clipboard.writeText(filePath) },
    { label: "Copy name", click: () => clipboard.writeText(path.basename(filePath)) },
  ];

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "FILETREE", submenu: fileTreeSubmenu },
    {
      label: "New Folder",
      accelerator: "Ctrl+N",
      click: () => {
        try {
          const createdPath = createUniqueNewFolder(filePath);
          win?.webContents.send("contextMenuAction", "refresh", createdPath);
        } catch (error) {
          win?.webContents.send("contextMenuAction", "error", String(error));
        }
      },
    },
    { type: "separator" },
  ];

  if (isDir) {
    items.push({ label: "Open", click: () => shell.openPath(filePath) });
    items.push({ label: "Open in Terminal", click: () => spawn("cmd.exe", ["/k", `cd /d "${filePath}"`], { detached: true, stdio: "ignore" }) });
  } else {
    items.push({ label: "Open", click: () => shell.openPath(filePath) });
    items.push({ label: "Open with...", click: () => spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", filePath], { detached: true, stdio: "ignore" }) });
  }

  items.push({ type: "separator" });
  items.push({ label: "Show in Explorer", click: () => shell.showItemInFolder(filePath) });
  items.push({ type: "separator" });
  items.push({ label: "Copy as path", click: () => clipboard.writeText(filePath) });
  items.push({ label: "Copy name", click: () => clipboard.writeText(path.basename(filePath)) });
  items.push({ type: "separator" });
  items.push({ label: "Rename...", click: () => win?.webContents.send("contextMenuAction", "rename", filePath) });
  items.push({ label: "Delete", click: () => win?.webContents.send("contextMenuAction", "delete", filePath) });
  items.push({ type: "separator" });
  items.push({
    label: "Properties",
    click: () => {
      const ps = `(New-Object -ComObject Shell.Application).Namespace('${escaped.replace(/\\[^\\]*$/, "")}').ParseName('${path.basename(filePath).replace(/'/g, "''")}').InvokeVerb('Properties')`;
      spawn("powershell.exe", ["-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore" });
    },
  });

  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window: win ?? undefined, x, y });
}

function showHybridShellContextMenu(win: BrowserWindow | null, filePath: string, x: number, y: number): void {
  const encodedPath = Buffer.from(filePath, "utf16le").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class HybridShellMenu {
  const uint COINIT_APARTMENTTHREADED = 0x2;
  const uint CMF_NORMAL = 0x00000000;
  const uint CMF_EXPLORE = 0x00000004;
  const uint MF_STRING = 0x00000000;
  const uint MF_GRAYED = 0x00000001;
  const uint MF_BYPOSITION = 0x00000400;
  const uint MF_SEPARATOR = 0x00000800;
  const uint MF_POPUP = 0x00000010;
  const uint TPM_RIGHTBUTTON = 0x00000002;
  const uint TPM_RETURNCMD = 0x00000100;
  const int SW_SHOWNORMAL = 1;

  const uint FT_NEW_FOLDER = 10;
  const uint FT_OPEN_TAB = 11;
  const uint FT_REVEAL = 12;
  const uint FT_COPY_PATH = 13;
  const uint FT_COPY_NAME = 14;
  const uint SHELL_FIRST = 1000;

  static Guid IID_IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
  static Guid IID_IContextMenu = new Guid("000214E4-0000-0000-C000-000000000046");

  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr pv);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHParseDisplayName(string pszName, IntPtr pbc, out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);
  [DllImport("shell32.dll")]
  static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);
  [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
  [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr hMenu);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool InsertMenu(IntPtr hMenu, uint uPosition, uint uFlags, UIntPtr uIDNewItem, string lpNewItem);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool AppendMenu(IntPtr hMenu, uint uFlags, UIntPtr uIDNewItem, string lpNewItem);
  [DllImport("user32.dll")] static extern int TrackPopupMenuEx(IntPtr hmenu, uint fuFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214E6-0000-0000-C000-000000000046")]
  interface IShellFolder {
    [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string pszDisplayName, ref uint pchEaten, out IntPtr ppidl, ref uint pdwAttributes);
    [PreserveSig] int EnumObjects(IntPtr hwnd, int grfFlags, out IntPtr ppenumIDList);
    [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
    [PreserveSig] int CreateViewObject(IntPtr hwndOwner, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetAttributesOf(uint cidl, IntPtr[] apidl, ref uint rgfInOut);
    [PreserveSig] int GetUIObjectOf(IntPtr hwndOwner, uint cidl, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex=1)] IntPtr[] apidl, ref Guid riid, IntPtr rgfReserved, out IntPtr ppv);
    [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint uFlags, out IntPtr pName);
    [PreserveSig] int SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string pszName, uint uFlags, out IntPtr ppidlOut);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214E4-0000-0000-C000-000000000046")]
  interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
    [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFO pici);
    [PreserveSig] int GetCommandString(UIntPtr idcmd, uint uflags, IntPtr reserved, IntPtr commandstring, int cch);
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  struct CMINVOKECOMMANDINFO {
    public int cbSize;
    public int fMask;
    public IntPtr hwnd;
    public IntPtr lpVerb;
    public IntPtr lpParameters;
    public IntPtr lpDirectory;
    public int nShow;
    public int dwHotKey;
    public IntPtr hIcon;
  }

  public static string Show(string path, int x, int y) {
    CoInitializeEx(IntPtr.Zero, COINIT_APARTMENTTHREADED);
    IntPtr pidl = IntPtr.Zero;
    IntPtr folderPtr = IntPtr.Zero;
    IntPtr contextMenuPtr = IntPtr.Zero;
    IntPtr menu = IntPtr.Zero;
    IntPtr fileTreeSubmenu = IntPtr.Zero;
    try {
      uint attrs;
      int hr = SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attrs);
      if (hr != 0 || pidl == IntPtr.Zero) return "";

      IntPtr childPidl;
      hr = SHBindToParent(pidl, ref IID_IShellFolder, out folderPtr, out childPidl);
      if (hr != 0 || folderPtr == IntPtr.Zero || childPidl == IntPtr.Zero) return "";

      IShellFolder folder = (IShellFolder)Marshal.GetTypedObjectForIUnknown(folderPtr, typeof(IShellFolder));
      IntPtr[] childPidls = new IntPtr[] { childPidl };
      hr = folder.GetUIObjectOf(IntPtr.Zero, 1, childPidls, ref IID_IContextMenu, IntPtr.Zero, out contextMenuPtr);
      if (hr != 0 || contextMenuPtr == IntPtr.Zero) return "";

      IContextMenu contextMenu = (IContextMenu)Marshal.GetTypedObjectForIUnknown(contextMenuPtr, typeof(IContextMenu));
      menu = CreatePopupMenu();
      fileTreeSubmenu = CreatePopupMenu();
      bool isDir = System.IO.Directory.Exists(path);

      AppendMenu(fileTreeSubmenu, isDir ? MF_STRING : (MF_STRING | MF_GRAYED), new UIntPtr(FT_OPEN_TAB), "Open in new tab");
      AppendMenu(fileTreeSubmenu, MF_STRING, new UIntPtr(FT_REVEAL), "Show in Explorer");
      AppendMenu(fileTreeSubmenu, MF_SEPARATOR, UIntPtr.Zero, null);
      AppendMenu(fileTreeSubmenu, MF_STRING, new UIntPtr(FT_COPY_PATH), "Copy full path");
      AppendMenu(fileTreeSubmenu, MF_STRING, new UIntPtr(FT_COPY_NAME), "Copy name");

      uint index = 0;
      InsertMenu(menu, index++, MF_BYPOSITION | MF_POPUP, new UIntPtr((ulong)fileTreeSubmenu.ToInt64()), "FILETREE");
      InsertMenu(menu, index++, MF_BYPOSITION | MF_STRING, new UIntPtr(FT_NEW_FOLDER), "New Folder\\tCtrl+N");
      InsertMenu(menu, index++, MF_BYPOSITION | MF_SEPARATOR, UIntPtr.Zero, null);

      contextMenu.QueryContextMenu(menu, index, SHELL_FIRST, 0x7FFF, CMF_NORMAL | CMF_EXPLORE);

      int selected = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, GetForegroundWindow(), IntPtr.Zero);
      if (selected == 0) return "";
      if (selected == FT_NEW_FOLDER) return "new-folder";
      if (selected == FT_OPEN_TAB) return isDir ? "open-new-tab" : "";
      if (selected == FT_REVEAL) return "show-in-explorer";
      if (selected == FT_COPY_PATH) return "copy-path";
      if (selected == FT_COPY_NAME) return "copy-name";
      if (selected >= SHELL_FIRST) {
        CMINVOKECOMMANDINFO invoke = new CMINVOKECOMMANDINFO();
        invoke.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFO));
        invoke.hwnd = GetForegroundWindow();
        invoke.lpVerb = new IntPtr(selected - SHELL_FIRST);
        invoke.nShow = SW_SHOWNORMAL;
        contextMenu.InvokeCommand(ref invoke);
      }
      return "";
    } finally {
      if (contextMenuPtr != IntPtr.Zero) Marshal.Release(contextMenuPtr);
      if (folderPtr != IntPtr.Zero) Marshal.Release(folderPtr);
      if (menu != IntPtr.Zero) DestroyMenu(menu);
      if (pidl != IntPtr.Zero) CoTaskMemFree(pidl);
      CoUninitialize();
    }
  }
}
'@
$action = [HybridShellMenu]::Show($path, ${Math.round(x)}, ${Math.round(y)})
if ($action) { [Console]::Out.WriteLine("FILETREE_ACTION:" + $action) }
`.trim();

  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-Sta",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    encodedCommand,
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", (error) => {
    console.warn("[electron] hybrid shell menu failed to start:", error);
    showFallbackContextMenu(win, filePath, x, y);
  });
  child.on("close", (code) => {
    if (code !== 0) {
      console.warn("[electron] hybrid shell menu failed:", stderr.trim());
      showFallbackContextMenu(win, filePath, x, y);
      return;
    }

    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("FILETREE_ACTION:")) {
        handleFileTreeContextAction(win, filePath, line.slice("FILETREE_ACTION:".length).trim());
      }
    }
  });
}

// Drag file(s) out. Fired from the renderer's dragstart. The native addon runs
// the shell drag on this thread (blocking for the drag's duration) and tells us
// where/how it ended. Chromium keeps firing dragover on the page during the
// drag (so highlight + auto-scroll work); we just complete the drop here.
// TEMP diagnostic: print renderer-forwarded log lines to the terminal.
ipcMain.on("diag", (_event, message: string) => {
  console.log("[renderer]", message);
});

// ── Cloud LLM gateway (OpenAI / Anthropic) ───────────────────────────────────
// Ollama is reached directly from the renderer via the Rust server. Cloud
// providers need TLS + SSE, which Node's global fetch handles here in main. We
// translate the renderer's provider-agnostic message format to each provider's
// schema and stream a single unified event protocol back over "llmEvent".
type LlmRole = "system" | "user" | "assistant" | "tool";
interface LlmToolCall { id: string; name: string; args: Record<string, unknown>; }
interface LlmImage { dataUrl: string; mediaType: string; }
interface LlmMessage { role: LlmRole; content: string; toolCalls?: LlmToolCall[]; toolCallId?: string; toolName?: string; images?: LlmImage[]; }
interface LlmToolDef { type: "function"; function: { name: string; description: string; parameters: unknown }; }
type LlmEvent =
  | { type: "text"; value: string }
  | { type: "thinking"; value: string }
  | { type: "tool_calls"; value: LlmToolCall[] }
  | { type: "done" }
  | { type: "error"; value: string };
interface LlmPayload { provider: string; model: string; apiKey?: string; messages: LlmMessage[]; tools?: LlmToolDef[]; }

const llmAbort = new Map<string, AbortController>();

ipcMain.on("llmCancel", (_event, reqId: string) => {
  llmAbort.get(reqId)?.abort();
  llmAbort.delete(reqId);
});

ipcMain.on("llmStart", (event, reqId: string, payload: LlmPayload) => {
  const controller = new AbortController();
  llmAbort.set(reqId, controller);
  const emit = (ev: LlmEvent) => { try { event.sender.send("llmEvent", reqId, ev); } catch { /* window gone */ } };
  runCloudStream(payload, controller.signal, emit)
    .catch((e: unknown) => emit({ type: "error", value: (e as Error)?.message || String(e) }))
    .finally(() => llmAbort.delete(reqId));
});

ipcMain.handle("llmModels", async (_event, provider: string) => {
  if (provider === "openai") return ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o3-mini"];
  if (provider === "anthropic") return ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest"];
  return [];
});

async function runCloudStream(payload: LlmPayload, signal: AbortSignal, emit: (ev: LlmEvent) => void): Promise<void> {
  if (payload.provider === "openai") return streamOpenAi(payload, signal, emit);
  if (payload.provider === "anthropic") return streamAnthropic(payload, signal, emit);
  emit({ type: "error", value: `Unsupported provider ${payload.provider}` });
}

async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) yield line;
  }
  if (buf) yield buf;
}

function parseArgs(s: string): Record<string, unknown> {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
function shorten(s: string): string { return s.length > 200 ? s.slice(0, 200) + "…" : s; }
function randId(): string { return `call_${Math.random().toString(36).slice(2, 10)}`; }

async function streamOpenAi(payload: LlmPayload, signal: AbortSignal, emit: (ev: LlmEvent) => void): Promise<void> {
  const body = {
    model: payload.model,
    messages: toOpenAiMessages(payload.messages),
    stream: true,
    ...(payload.tools?.length ? { tools: payload.tools, tool_choice: "auto" as const } : {}),
  };
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${payload.apiKey ?? ""}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    emit({ type: "error", value: `OpenAI request failed: ${(e as Error).message}` });
    return;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    emit({ type: "error", value: `OpenAI HTTP ${res.status}: ${shorten(t)}` });
    return;
  }
  const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
  try {
    for await (const line of sseLines(res)) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (data === "[DONE]") break;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) emit({ type: "text", value: delta.content });
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          const cur = toolAcc[idx] ?? (toolAcc[idx] = { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    emit({ type: "error", value: (e as Error).message });
    return;
  }
  const calls: LlmToolCall[] = Object.values(toolAcc)
    .filter((c) => c.name)
    .map((c) => ({ id: c.id || randId(), name: c.name, args: parseArgs(c.args) }));
  if (calls.length) emit({ type: "tool_calls", value: calls });
  emit({ type: "done" });
}

async function streamAnthropic(payload: LlmPayload, signal: AbortSignal, emit: (ev: LlmEvent) => void): Promise<void> {
  const { system, messages } = toAnthropicMessages(payload.messages);
  const body = {
    model: payload.model,
    max_tokens: 2048,
    stream: true,
    ...(system ? { system } : {}),
    messages,
    ...(payload.tools?.length
      ? { tools: payload.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })) }
      : {}),
  };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": payload.apiKey ?? "", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    emit({ type: "error", value: `Anthropic request failed: ${(e as Error).message}` });
    return;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    emit({ type: "error", value: `Anthropic HTTP ${res.status}: ${shorten(t)}` });
    return;
  }
  const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};
  const calls: LlmToolCall[] = [];
  try {
    for await (const line of sseLines(res)) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (!data) continue;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (json.type === "content_block_start") {
        const idx: number = json.index ?? 0;
        const cb = json.content_block ?? {};
        blocks[idx] = { type: cb.type, id: cb.id, name: cb.name, json: "" };
      } else if (json.type === "content_block_delta") {
        const idx: number = json.index ?? 0;
        const d = json.delta ?? {};
        if (d.type === "text_delta" && d.text) emit({ type: "text", value: d.text });
        else if (d.type === "thinking_delta" && d.thinking) emit({ type: "thinking", value: d.thinking });
        else if (d.type === "input_json_delta" && d.partial_json != null) { const b = blocks[idx]; if (b) b.json += d.partial_json; }
      } else if (json.type === "content_block_stop") {
        const idx: number = json.index ?? 0;
        const b = blocks[idx];
        if (b && b.type === "tool_use" && b.name) calls.push({ id: b.id || randId(), name: b.name, args: parseArgs(b.json || "{}") });
      } else if (json.type === "error") {
        emit({ type: "error", value: json.error?.message || "Anthropic stream error" });
        return;
      }
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    emit({ type: "error", value: (e as Error).message });
    return;
  }
  if (calls.length) emit({ type: "tool_calls", value: calls });
  emit({ type: "done" });
}

function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function toOpenAiMessages(messages: LlmMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "user" && m.images?.length) {
      const parts: any[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const im of m.images) parts.push({ type: "image_url", image_url: { url: im.dataUrl } });
      return { role: "user", content: parts };
    }
    return { role: m.role, content: m.content };
  });
}

function toAnthropicMessages(messages: LlmMessage[]): { system: string; messages: any[] } {
  let system = "";
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") { system += (system ? "\n" : "") + m.content; continue; }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last._toolGroup) last.content.push(block);
      else out.push({ role: "user", content: [block], _toolGroup: true });
      continue;
    }
    if (m.role === "assistant") {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.toolCalls?.length) for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: " " }] });
      continue;
    }
    if (m.images?.length) {
      const content: any[] = [];
      for (const im of m.images) content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: base64Of(im.dataUrl) } });
      if (m.content) content.push({ type: "text", text: m.content });
      out.push({ role: "user", content });
      continue;
    }
    out.push({ role: "user", content: m.content });
  }
  for (const o of out) delete o._toolGroup;
  return { system, messages: out };
}

ipcMain.on("ondragstart", (event, arg: string | string[]) => {
  const filePaths = (Array.isArray(arg) ? arg : [arg]).filter((filePath) => filePath && fs.existsSync(filePath));
  if (filePaths.length === 0) return;
  const win = BrowserWindow.fromWebContents(event.sender);

  if (nativeDragFiles) {
    try {
      const result = nativeDragFiles(filePaths);
      console.log("[electron] native drag outcome=", result.outcome, "drop=", result.dropX, result.dropY, "deleted=", result.deleted);
      if (result.outcome === "internal" && win) {
        // dropX/dropY are physical screen pixels — convert to the renderer's
        // CSS pixel space (DIP relative to the web content origin) so it can
        // hit-test which folder row received the drop.
        const dip = screen.screenToDipPoint({ x: result.dropX, y: result.dropY });
        const bounds = win.getContentBounds();
        const clientX = dip.x - bounds.x;
        const clientY = dip.y - bounds.y;
        console.log("[electron] internal drop convert: phys=", result.dropX, result.dropY,
          "dip=", dip.x, dip.y, "contentBounds=", bounds, "client=", clientX, clientY);
        win.webContents.send("nativeDropInternal", clientX, clientY, filePaths);
      } else {
        win?.webContents.send("nativeDropEnd");
      }
      return;
    } catch (e) {
      console.error("[electron] native drag failed, falling back to copy:", e);
      win?.webContents.send("nativeDropEnd");
      // fall through to the copy-only path below
    }
  }

  // Fallback: Electron's startDrag — copy-only (it can't report a drop effect,
  // so deleting the source afterward would risk losing data on a cancel).
  try {
    const repoRoot = path.join(app.getAppPath(), "..");
    const iconPath = path.join(repoRoot, "assets", "drag-icon.png");
    event.sender.startDrag({ file: filePaths[0], files: filePaths, icon: iconPath });
  } catch (e) {
    console.log("[electron] startDrag failed:", e);
  }
});

// Copy text to clipboard.
ipcMain.handle("copyText", (_event, text: string) => {
  clipboard.writeText(text);
});

// Read a file off disk and return a base64 data URL so attached image *paths*
// (dragged from the file tree) can be sent to vision-capable models. Capped so
// we never blow up the IPC channel / model request with a giant payload.
ipcMain.handle("readFileBase64", async (_event, filePath: string) => {
  try {
    const MAX = 12 * 1024 * 1024; // 12 MB
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { error: "not a file" };
    if (stat.size > MAX) return { error: "file too large (max 12 MB)" };
    const buf = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mediaType =
      ext === ".png" ? "image/png" :
      ext === ".gif" ? "image/gif" :
      ext === ".webp" ? "image/webp" :
      ext === ".bmp" ? "image/bmp" :
      "image/jpeg";
    return { dataUrl: `data:${mediaType};base64,${buf.toString("base64")}`, mediaType };
  } catch (e) {
    return { error: (e as Error).message };
  }
});

// Move files into a folder with the Windows shell file-operation engine
// (IFileOperation), so the user sees the real native dialogs: progress,
// "Replace / Skip / Keep both", "the source and destination file names are the
// same", and elevation prompts. Runs synchronously on this UI thread — the
// modal Windows dialog is the UI while it runs; the renderer rescans after.
ipcMain.handle("moveItemsNative", (event, paths: string[], destination: string) => {
  const sources = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (sources.length === 0 || !destination) return { aborted: false };
  if (!nativeMoveItems) throw new Error("native move addon unavailable");
  const win = BrowserWindow.fromWebContents(event.sender);
  try { win?.focus(); } catch { /* ignore */ }
  // Pass our top-level window handle so the shell parents its dialogs to
  // FileTree. The addon runs the operation on a background thread, so this
  // returns a Promise and the main thread / UI stays responsive throughout.
  let ownerHwnd = 0;
  try {
    const buf = win?.getNativeWindowHandle();
    if (buf && buf.length >= 8) ownerHwnd = Number(buf.readBigUInt64LE(0));
    else if (buf && buf.length >= 4) ownerHwnd = buf.readUInt32LE(0);
  } catch { /* 0 → addon falls back to the foreground window */ }
  return nativeMoveItems(sources, destination, ownerHwnd);
});

// Copy files as a file drop (CF_HDROP equivalent — paste in Explorer).
ipcMain.handle("copyFiles", (_event, paths: string[]) => {
  // Electron clipboard doesn't expose CF_HDROP directly on Windows.
  // Best available: write the path list as text so Ctrl+V in Explorer opens them.
  // For true CF_HDROP in future, use a native node addon.
  clipboard.writeText(paths.join("\n"));
});

// Shell context menu shown from the renderer. Prefer the native addon, which
// hosts the *real* Windows shell menu (`IContextMenu`) — identical to what
// Explorer/TreeSize show, including third-party extensions (CrowdStrike, Git,
// Visual Studio, "Send to", Properties, …). It runs on a background thread so
// the UI never freezes while the menu is open or a verb is invoked. The shell
// can't drive FileTree's own actions, so a few verbs come back for us to handle.
ipcMain.handle("shellContextMenu", async (event, paths: string[] | string, x: number, y: number) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (list.length === 0) return;

  if (nativeContextMenu) {
    let ownerHwnd = 0;
    try {
      const buf = win?.getNativeWindowHandle();
      if (buf && buf.length >= 8) ownerHwnd = Number(buf.readBigUInt64LE(0));
      else if (buf && buf.length >= 4) ownerHwnd = buf.readUInt32LE(0);
    } catch { /* 0 → addon falls back to the foreground window */ }
    try {
      // Synchronous + modal: blocks the main thread only while the menu is open,
      // so a verb's dialog (Properties, Open with) lives on the app's STA.
      const { verb } = nativeContextMenu(list, ownerHwnd);
      switch (verb) {
        // Shell "rename" is a no-op outside Explorer, so drive FileTree's inline rename.
        case "rename":
          win?.webContents.send("contextMenuAction", "rename", list[0]);
          break;
        case "new-folder":
          handleFileTreeContextAction(win, list[0], "new-folder");
          break;
        case "open-new-tab":
          handleFileTreeContextAction(win, list[0], "open-new-tab");
          break;
        // "" → the shell already performed the command (Open, Cut, Copy, Delete,
        // Properties, Send to, third-party verbs); the fs watcher reflects any
        // disk change, so there is nothing more to do here.
        default:
          break;
      }
      return;
    } catch (e) {
      console.warn("[electron] native shell context menu failed; using fallback:", e);
    }
  }

  showFallbackContextMenu(win, list[0], Math.round(x), Math.round(y));
});

// ── Integrated terminal ───────────────────────────────────────────────────────
// Launch profiles (VS Code style). PowerShell is the default; the rest are
// offered only when detected on this machine. The renderer picks a profile id
// and we map it to the program + args the PTY addon spawns.
interface TermProfile { id: string; label: string; program: string; args: string[]; }

function findOnPath(exe: string): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function detectTerminalProfiles(): TermProfile[] {
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const sys32 = path.join(sysRoot, "System32");
  const profiles: TermProfile[] = [];

  const ps = path.join(sys32, "WindowsPowerShell", "v1.0", "powershell.exe");
  profiles.push({ id: "powershell", label: "PowerShell", program: fs.existsSync(ps) ? ps : "powershell.exe", args: ["-NoLogo"] });

  const pwsh = findOnPath("pwsh.exe");
  if (pwsh) profiles.push({ id: "pwsh", label: "PowerShell 7", program: pwsh, args: ["-NoLogo"] });

  const cmd = path.join(sys32, "cmd.exe");
  profiles.push({ id: "cmd", label: "Command Prompt", program: fs.existsSync(cmd) ? cmd : "cmd.exe", args: [] });

  const gitBash = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ].find((p) => fs.existsSync(p));
  if (gitBash) profiles.push({ id: "git-bash", label: "Git Bash", program: gitBash, args: ["-i", "-l"] });

  const wsl = path.join(sys32, "wsl.exe");
  if (fs.existsSync(wsl)) profiles.push({ id: "wsl", label: "WSL", program: wsl, args: [] });

  return profiles;
}

// Output pump: the addon buffers pty output; we drain every live session on a
// short timer and forward it to the renderer's xterm.js. Runs only while at
// least one terminal is open.
const livePtys = new Set<number>();
let ptyPump: NodeJS.Timeout | null = null;

function startPtyPump(): void {
  if (ptyPump || !ptyRead) return;
  ptyPump = setInterval(() => {
    if (!ptyRead) return;
    const win = mainWindow;
    for (const id of [...livePtys]) {
      let chunk: PtyChunk;
      try {
        chunk = ptyRead(id);
      } catch {
        livePtys.delete(id);
        continue;
      }
      if (chunk.data && chunk.data.length > 0) {
        win?.webContents.send("terminalData", id, chunk.data);
      }
      if (chunk.exit !== null && chunk.exit !== undefined) {
        livePtys.delete(id);
        win?.webContents.send("terminalExit", id, chunk.exit);
      }
    }
    if (livePtys.size === 0 && ptyPump) {
      clearInterval(ptyPump);
      ptyPump = null;
    }
  }, 16);
}

function killAllPtys(): void {
  if (ptyKill) for (const id of livePtys) { try { ptyKill(id); } catch { /* ignore */ } }
  livePtys.clear();
  if (ptyPump) { clearInterval(ptyPump); ptyPump = null; }
}

ipcMain.handle("terminalProfiles", () =>
  detectTerminalProfiles().map(({ id, label }) => ({ id, label }))
);

ipcMain.handle("terminalSpawn", (_event, profileId: string, cwd: string, cols: number, rows: number) => {
  if (!ptySpawn) throw new Error("terminal backend unavailable");
  const profiles = detectTerminalProfiles();
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const id = ptySpawn(
    profile.program,
    profile.args,
    cwd || "",
    Math.max(1, Math.floor(cols) || 80),
    Math.max(1, Math.floor(rows) || 24),
  );
  livePtys.add(id);
  startPtyPump();
  return { id, title: profile.label };
});

ipcMain.on("terminalWrite", (_event, id: number, data: string) => {
  try { ptyWrite?.(id, Buffer.from(data, "utf8")); } catch { /* session gone */ }
});
ipcMain.on("terminalResize", (_event, id: number, cols: number, rows: number) => {
  try { ptyResize?.(id, Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows))); } catch { /* session gone */ }
});
ipcMain.on("terminalKill", (_event, id: number) => {
  try { ptyKill?.(id); } catch { /* session gone */ }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    const port = await getFreePort();
    await startRustServer(port);
    createWindow(port);
  } catch (err) {
    console.error("[electron] Fatal startup error:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  killAllPtys();
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
