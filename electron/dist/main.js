"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const net = __importStar(require("net"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
let serverProcess = null;
let mainWindow = null;
// ── Port helpers ─────────────────────────────────────────────────────────────
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            srv.close(() => resolve(addr.port));
        });
        srv.on("error", reject);
    });
}
// Wait until the Rust server accepts connections on `port`.
function waitForServer(port, timeoutMs = 10000) {
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
                }
                else {
                    setTimeout(attempt, 100);
                }
            });
        };
        attempt();
    });
}
// ── Server launch ─────────────────────────────────────────────────────────────
async function startRustServer(port) {
    // Find the server binary next to the Electron app, or in the repo root.
    // app.getAppPath() = .../FileTree/electron  (where package.json lives)
    const repoRoot = path.join(electron_1.app.getAppPath(), "..");
    const candidates = [
        path.join(repoRoot, "target", "release", "filetree.exe"), // dev build
        path.join(repoRoot, "filetree-server.exe"), // packaged
        path.join(electron_1.app.getAppPath(), "filetree-server.exe"), // bundled next to electron/
    ];
    let serverBin = candidates.find((p) => fs.existsSync(p));
    if (!serverBin) {
        throw new Error(`Could not find filetree server binary. Tried:\n${candidates.join("\n")}`);
    }
    serverProcess = (0, child_process_1.spawn)(serverBin, ["serve", "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout?.on("data", (d) => process.stdout.write(d));
    serverProcess.stderr?.on("data", (d) => process.stderr.write(d));
    serverProcess.on("exit", (code) => {
        console.log(`[electron] Server exited with code ${code}`);
    });
    await waitForServer(port);
    console.log(`[electron] Rust server ready on port ${port}`);
}
// ── Window ────────────────────────────────────────────────────────────────────
function createWindow(port) {
    mainWindow = new electron_1.BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 640,
        minHeight: 400,
        title: "FileTree",
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
            }
            catch { /* ignore malformed URLs */ }
        }
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}
// ── IPC handlers ──────────────────────────────────────────────────────────────
function createUniqueNewFolder(targetPath) {
    const baseDir = (() => {
        try {
            return fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
        }
        catch {
            return path.dirname(targetPath);
        }
    })();
    for (let i = 1; i < 1000; i += 1) {
        const name = i === 1 ? "New Folder" : `New Folder (${i})`;
        const candidate = path.join(baseDir, name);
        if (!fs.existsSync(candidate)) {
            fs.mkdirSync(candidate);
            electron_1.shell.showItemInFolder(candidate);
            return candidate;
        }
    }
    throw new Error(`Could not find an available New Folder name in ${baseDir}`);
}
function handleFileTreeContextAction(win, filePath, action) {
    switch (action) {
        case "new-folder":
            try {
                createUniqueNewFolder(filePath);
            }
            catch (error) {
                win?.webContents.send("contextMenuAction", "error", String(error));
            }
            break;
        case "open-new-tab":
            win?.webContents.send("externalDrop", [filePath]);
            break;
        case "show-in-explorer":
            electron_1.shell.showItemInFolder(filePath);
            break;
        case "copy-path":
            electron_1.clipboard.writeText(filePath);
            break;
        case "copy-name":
            electron_1.clipboard.writeText(path.basename(filePath));
            break;
        default:
            break;
    }
}
function showFallbackContextMenu(win, filePath, x, y) {
    const isDir = (() => { try {
        return fs.statSync(filePath).isDirectory();
    }
    catch {
        return false;
    } })();
    const escaped = filePath.replace(/'/g, "''");
    const fileTreeSubmenu = [
        { label: "Open in new tab", enabled: isDir, click: () => win?.webContents.send("externalDrop", [filePath]) },
        { label: "Show in Explorer", click: () => electron_1.shell.showItemInFolder(filePath) },
        { type: "separator" },
        { label: "Copy full path", click: () => electron_1.clipboard.writeText(filePath) },
        { label: "Copy name", click: () => electron_1.clipboard.writeText(path.basename(filePath)) },
    ];
    const items = [
        { label: "FILETREE", submenu: fileTreeSubmenu },
        {
            label: "New Folder",
            accelerator: "Ctrl+N",
            click: () => {
                try {
                    const createdPath = createUniqueNewFolder(filePath);
                    win?.webContents.send("contextMenuAction", "refresh", createdPath);
                }
                catch (error) {
                    win?.webContents.send("contextMenuAction", "error", String(error));
                }
            },
        },
        { type: "separator" },
    ];
    if (isDir) {
        items.push({ label: "Open", click: () => electron_1.shell.openPath(filePath) });
        items.push({ label: "Open in Terminal", click: () => (0, child_process_1.spawn)("cmd.exe", ["/k", `cd /d "${filePath}"`], { detached: true, stdio: "ignore" }) });
    }
    else {
        items.push({ label: "Open", click: () => electron_1.shell.openPath(filePath) });
        items.push({ label: "Open with...", click: () => (0, child_process_1.spawn)("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", filePath], { detached: true, stdio: "ignore" }) });
    }
    items.push({ type: "separator" });
    items.push({ label: "Show in Explorer", click: () => electron_1.shell.showItemInFolder(filePath) });
    items.push({ type: "separator" });
    items.push({ label: "Copy as path", click: () => electron_1.clipboard.writeText(filePath) });
    items.push({ label: "Copy name", click: () => electron_1.clipboard.writeText(path.basename(filePath)) });
    items.push({ type: "separator" });
    items.push({ label: "Rename...", click: () => win?.webContents.send("contextMenuAction", "rename", filePath) });
    items.push({ label: "Delete", click: () => win?.webContents.send("contextMenuAction", "delete", filePath) });
    items.push({ type: "separator" });
    items.push({
        label: "Properties",
        click: () => {
            const ps = `(New-Object -ComObject Shell.Application).Namespace('${escaped.replace(/\\[^\\]*$/, "")}').ParseName('${path.basename(filePath).replace(/'/g, "''")}').InvokeVerb('Properties')`;
            (0, child_process_1.spawn)("powershell.exe", ["-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore" });
        },
    });
    const menu = electron_1.Menu.buildFromTemplate(items);
    menu.popup({ window: win ?? undefined, x, y });
}
function showHybridShellContextMenu(win, filePath, x, y) {
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
    const child = (0, child_process_1.spawn)("powershell.exe", [
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
// Drag file(s) out to Explorer / desktop.
// The renderer sends this when document.drag fires with clientX/Y = 0 (cursor left window).
// Official Electron pattern: https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop
electron_1.ipcMain.on("ondragstart", (event, arg) => {
    const filePaths = (Array.isArray(arg) ? arg : [arg]).filter((filePath) => filePath && fs.existsSync(filePath));
    if (filePaths.length === 0) {
        event.returnValue = { ok: false, status: "missing" };
        return;
    }
    try {
        const repoRoot = path.join(electron_1.app.getAppPath(), "..");
        const iconPath = path.join(repoRoot, "assets", "drag-icon.png");
        console.log("[electron] ondragstart files=", filePaths, "icon=", iconPath);
        event.sender.startDrag({ file: filePaths[0], files: filePaths, icon: iconPath });
        event.returnValue = { ok: true, status: "started" };
    }
    catch (e) {
        console.log("[electron] startDrag failed:", e);
        event.returnValue = { ok: false, status: "error", error: String(e) };
    }
});
// Called by renderer after dragend; move the source to the OS trash for move-like drag-out.
electron_1.ipcMain.handle("deleteAfterDrag", async (_event, filePath) => {
    if (!filePath)
        return { ok: false };
    try {
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) {
            return { ok: true, status: "already-gone" };
        }
        await electron_1.shell.trashItem(resolvedPath);
        console.log("[electron] deleteAfterDrag trashed:", resolvedPath);
        return { ok: true, status: "trashed" };
    }
    catch (e) {
        console.log("[electron] deleteAfterDrag failed:", e);
        return { ok: false, error: String(e) };
    }
});
// Copy text to clipboard.
electron_1.ipcMain.handle("copyText", (_event, text) => {
    electron_1.clipboard.writeText(text);
});
// Copy files as a file drop (CF_HDROP equivalent — paste in Explorer).
electron_1.ipcMain.handle("copyFiles", (_event, paths) => {
    // Electron clipboard doesn't expose CF_HDROP directly on Windows.
    // Best available: write the path list as text so Ctrl+V in Explorer opens them.
    // For true CF_HDROP in future, use a native node addon.
    electron_1.clipboard.writeText(paths.join("\n"));
});
// Shell context menu shown from the renderer. Keep this path in-process so item
// clicks reliably dispatch back to FileTree.
electron_1.ipcMain.handle("shellContextMenu", (event, _path, _x, _y) => {
    const win = electron_1.BrowserWindow.fromWebContents(event.sender);
    showFallbackContextMenu(win, _path, Math.round(_x), Math.round(_y));
});
// ── App lifecycle ─────────────────────────────────────────────────────────────
electron_1.app.whenReady().then(async () => {
    try {
        const port = await getFreePort();
        await startRustServer(port);
        createWindow(port);
    }
    catch (err) {
        console.error("[electron] Fatal startup error:", err);
        electron_1.app.quit();
    }
});
electron_1.app.on("window-all-closed", () => {
    electron_1.app.quit();
});
electron_1.app.on("before-quit", () => {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
});
