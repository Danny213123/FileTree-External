import {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  shell,
  Menu,
} from "electron";
import * as path from "path";
import * as net from "net";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";

let serverProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;

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

  serverProcess.stdout?.on("data", (d) => process.stdout.write(d));
  serverProcess.stderr?.on("data", (d) => process.stderr.write(d));

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

// Drag file(s) out to Explorer / desktop.
// The renderer sends this when document.drag fires with clientX/Y = 0 (cursor left window).
// Official Electron pattern: https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop
ipcMain.on("ondragstart", (event, arg: string | string[]) => {
  const filePath = Array.isArray(arg) ? arg[0] : arg;
  if (!filePath || !fs.existsSync(filePath)) { event.returnValue = "none"; return; }
  const repoRoot = path.join(app.getAppPath(), "..");
  const iconPath = path.join(repoRoot, "assets", "drag-icon.png");
  console.log("[electron] ondragstart file=", filePath, "icon=", iconPath);
  event.sender.startDrag({ file: filePath, icon: iconPath });
  // Wait for the OS to complete the drop, then check if the file was moved by the OS.
  // Explorer native-move removes the source; copy leaves it intact.
  setTimeout(() => {
    const moved = !fs.existsSync(filePath);
    console.log("[electron] drag completed, filePath=", filePath, "moved=", moved);
    event.returnValue = moved ? "moved" : "copy";
  }, 200);
});

// Called by renderer after dragend — deletes source file for always-move behavior.
ipcMain.handle("deleteAfterDrag", async (_event, filePath: string) => {
  if (!filePath) return { ok: false };
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
    console.log("[electron] deleteAfterDrag deleted:", filePath);
    return { ok: true };
  } catch (e) {
    console.log("[electron] deleteAfterDrag failed:", e);
    return { ok: false, error: String(e) };
  }
});

// Copy text to clipboard.
ipcMain.handle("copyText", (_event, text: string) => {
  clipboard.writeText(text);
});

// Copy files as a file drop (CF_HDROP equivalent — paste in Explorer).
ipcMain.handle("copyFiles", (_event, paths: string[]) => {
  // Electron clipboard doesn't expose CF_HDROP directly on Windows.
  // Best available: write the path list as text so Ctrl+V in Explorer opens them.
  // For true CF_HDROP in future, use a native node addon.
  clipboard.writeText(paths.join("\n"));
});

// Shell context menu — invoke the real Windows Explorer context menu via PowerShell.
ipcMain.handle("shellContextMenu", (event, _path: string, _x: number, _y: number) => {
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
  const win2 = BrowserWindow.fromWebContents(event.sender);
  const isDir = (() => { try { return fs.statSync(_path).isDirectory(); } catch { return false; } })();

  const items: Electron.MenuItemConstructorOptions[] = [];

  if (isDir) {
    items.push({ label: "Open", click: () => shell.openPath(_path) });
    items.push({ label: "Open in new tab", click: () => win2?.webContents.send("externalDrop", [_path]) });
    items.push({ label: "Open in Terminal", click: () => spawn("cmd.exe", ["/k", `cd /d "${_path}"`], { detached: true, stdio: "ignore" }) });
  } else {
    items.push({ label: "Open", click: () => shell.openPath(_path) });
    items.push({ label: "Open with...", click: () => shell.openPath(_path) });
  }

  items.push({ type: "separator" });
  items.push({ label: "Show in Explorer", click: () => shell.showItemInFolder(_path) });
  items.push({ type: "separator" });
  items.push({ label: "Copy as path", click: () => clipboard.writeText(_path) });
  items.push({ label: "Copy name", click: () => clipboard.writeText(path.basename(_path)) });
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
      spawn("powershell.exe", ["-WindowStyle", "Hidden", "-Command", ps2], { detached: true, stdio: "ignore" });
    },
  });

  const menu = Menu.buildFromTemplate(items);
  if (win2) menu.popup({ window: win2, x: Math.round(_x), y: Math.round(_y) });
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
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
