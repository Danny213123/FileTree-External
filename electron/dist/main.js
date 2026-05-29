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
// Drag file(s) out to Explorer / desktop.
// The renderer sends this when document.drag fires with clientX/Y = 0 (cursor left window).
// Official Electron pattern: https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop
electron_1.ipcMain.on("ondragstart", (event, arg) => {
    const filePath = Array.isArray(arg) ? arg[0] : arg;
    if (!filePath || !fs.existsSync(filePath)) {
        event.returnValue = "none";
        return;
    }
    const repoRoot = path.join(electron_1.app.getAppPath(), "..");
    const iconPath = path.join(repoRoot, "assets", "drag-icon.png");
    console.log("[electron] ondragstart file=", filePath, "icon=", iconPath);
    event.sender.startDrag({ file: filePath, icon: iconPath });
    console.log("[electron] drag initiated");
    event.returnValue = null; // unblock renderer — move detection handled via dragend IPC
});
// Called by renderer after dragend — deletes source file for always-move behavior.
electron_1.ipcMain.handle("deleteAfterDrag", async (_event, filePath) => {
    if (!filePath)
        return { ok: false };
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
        }
        else {
            fs.unlinkSync(filePath);
        }
        console.log("[electron] deleteAfterDrag deleted:", filePath);
        return { ok: true };
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
// Shell context menu — invoke the real Windows Explorer context menu via PowerShell.
electron_1.ipcMain.handle("shellContextMenu", (event, _path, _x, _y) => {
    // Use PowerShell to show the real Windows Shell context menu at the cursor position.
    // This gives the identical menu as right-clicking in Explorer (Open, Cut, Copy,
    // Send to, Properties, virus scanner extensions, etc.)
    const escaped = _path.replace(/'/g, "''");
    const ps = `
$path = '${escaped}'
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace((Split-Path $path))
$item = $folder.ParseName((Split-Path $path -Leaf))
$item.InvokeVerb()
`;
    // PowerShell ShowShellContextMenu approach using UIAutomation / SendMessage
    // The cleanest cross-process approach: use a small C# snippet via powershell -Command
    const psScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ShellMenu {
    [DllImport("shell32.dll")] static extern int SHParseDisplayName(
        [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr bindCtx,
        out IntPtr pidl, uint sfgaoIn, out uint sfgaoOut);
    [DllImport("shell32.dll")] static extern int SHBindToParent(
        IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr ppidlLast);
    [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr res, int init);

    static Guid IID_IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");

    public static void Show(string path, int x, int y) {
        CoInitializeEx(IntPtr.Zero, 0);
        IntPtr pidl; uint attr;
        if (SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attr) != 0) return;
        IntPtr folderPtr, childPidl;
        if (SHBindToParent(pidl, ref IID_IShellFolder, out folderPtr, out childPidl) != 0) return;
        // Minimal: just open the item for now
        System.Diagnostics.Process.Start("explorer.exe", "/select,\\"" + path + "\\"");
    }
}
'@
[ShellMenu]::Show('${escaped}', ${Math.round(_x)}, ${Math.round(_y)})
`.trim();
    // Simpler reliable approach: use the Rust server's existing shell context menu endpoint
    // by sending an HTTP request to it (the server still has the Win32 implementation).
    // But the desktop module is gone. Fall back to a rich Electron menu that mirrors TreeSize.
    const win2 = electron_1.BrowserWindow.fromWebContents(event.sender);
    const isDir = (() => { try {
        return fs.statSync(_path).isDirectory();
    }
    catch {
        return false;
    } })();
    const items = [];
    if (isDir) {
        items.push({ label: "Open", click: () => electron_1.shell.openPath(_path) });
        items.push({ label: "Open in new tab", click: () => win2?.webContents.send("externalDrop", [_path]) });
        items.push({ label: "Open in Terminal", click: () => (0, child_process_1.spawn)("cmd.exe", ["/k", `cd /d "${_path}"`], { detached: true, stdio: "ignore" }) });
    }
    else {
        items.push({ label: "Open", click: () => electron_1.shell.openPath(_path) });
        items.push({ label: "Open with...", click: () => electron_1.shell.openPath(_path) });
    }
    items.push({ type: "separator" });
    items.push({ label: "Show in Explorer", click: () => electron_1.shell.showItemInFolder(_path) });
    items.push({ type: "separator" });
    items.push({ label: "Copy as path", click: () => electron_1.clipboard.writeText(_path) });
    items.push({ label: "Copy name", click: () => electron_1.clipboard.writeText(path.basename(_path)) });
    items.push({ type: "separator" });
    items.push({
        label: "Rename...",
        click: () => win2?.webContents.send("contextMenuAction", "rename", _path),
    });
    items.push({
        label: "Delete",
        click: () => win2?.webContents.send("contextMenuAction", "delete", _path),
    });
    items.push({ type: "separator" });
    items.push({
        label: "Properties",
        click: () => {
            const ps2 = `(New-Object -ComObject Shell.Application).Namespace('${escaped.replace(/\\[^\\]*$/, "")}').ParseName('${path.basename(_path).replace(/'/g, "''")}').InvokeVerb('Properties')`;
            (0, child_process_1.spawn)("powershell.exe", ["-WindowStyle", "Hidden", "-Command", ps2], { detached: true, stdio: "ignore" });
        },
    });
    const menu = electron_1.Menu.buildFromTemplate(items);
    if (win2)
        menu.popup({ window: win2, x: Math.round(_x), y: Math.round(_y) });
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
