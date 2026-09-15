// Demo build only (VITE_FILETREE_DEMO=1). Replaces Tauri's IPC `invoke` so
// every FileTree command is answered from invented data and nothing on this
// machine is read or changed. Window controls (`plugin:*`) still reach Tauri
// when running inside the desktop shell; in a plain browser they are stubbed.
import * as fs from "./fakeFs";
import * as compression from "./fakeCompression";
import * as cyberdrop from "./fakeCyberdrop";

type Args = Record<string, any>;
type Handler = (args: Args) => unknown;

const USER = "C:\\Users\\Demo";
const settings: Record<string, unknown> = {
  openTabs: ["D:\\Media", "D:\\Projects", `${USER}`], activeView: "explorer",
  sidebarOpen: true, panelOpen: true, darkMode: true, lowSpaceAlerts: true, lowSpaceThreshold: 10,
  recentPaths: ["D:\\Media", "D:\\Projects", "E:\\Backups", `${USER}\\Downloads`],
};

const scanIdOf = (node: fs.DemoNode) => `demo-${node.id}`;
const rootOf = (scanId: string) => fs.nodes[Number(String(scanId).replace("demo-", ""))] ?? fs.nodes[0];
const handleOf = (node: fs.DemoNode) => ({
  scanId: scanIdOf(node), rootPath: node.path, databasePath: "", status: "done",
  nodeCount: node.files + node.folders + 1, startedAt: fs.DEMO_NOW - 3_600_000, elapsedMs: 4_210,
});
const send = (channel: unknown, message: unknown) => (channel as { onmessage?: (value: unknown) => void } | undefined)?.onmessage?.(message);
const later = <T,>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
const filesUnder = (id: number) => fs.descendants(fs.nodes[id] ?? fs.nodes[0]).filter((node) => !node.isDir);

function thumbnail(path: string): string | null {
  const node = fs.lookup(path);
  if (!node || node.isDir || fs.kindOf(node) === "other") return null;
  let hash = 0;
  for (const char of node.path) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const play = fs.kindOf(node) === "video" ? `<circle cx="240" cy="160" r="38" fill="rgba(0,0,0,.45)"/><path d="M228 140v40l32-20z" fill="#fff"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,28%)"/></linearGradient></defs><rect width="480" height="320" fill="url(#g)"/><circle cx="${120 + (Math.abs(hash) % 240)}" cy="96" r="34" fill="hsl(${(hue + 180) % 360},90%,85%)"/><path d="M0 320 L0 230 L120 150 L210 220 L320 130 L480 240 L480 320Z" fill="hsl(${(hue + 30) % 360},45%,18%)"/>${play}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const handlers: Record<string, Handler> = {
  app_version: () => ({ version: "2.0.0" }),
  app_config: () => ({ initialPath: "D:\\Media", defaultThreads: 8 }),
  app_settings_get: () => structuredClone(settings),
  app_settings_set: ({ settings: next }) => { Object.assign(settings, next); return null; },
  drives: () => ({ drives: fs.DRIVES }),
  special_folders: () => ({ folders: ["Desktop", "Documents", "Downloads", "Pictures", "Videos"].map((label) => ({ label, path: `${USER}\\${label}` })) }),
  volume_info: ({ path }) => {
    const drive = fs.driveOf(String(path)) ?? fs.DRIVES[1];
    return { path, filesystem: "NTFS", totalBytes: drive.total, freeBytes: drive.free, bytesPerCluster: 4096 };
  },
  bookmarks_get: () => ["D:\\Media\\Photos", "D:\\Projects\\filetree", "E:\\Backups"],
  browse_directories: ({ path }) => (fs.lookup(String(path))?.children ?? []).map((id) => fs.nodes[id])
    .filter((node) => node.isDir).map((node) => ({ name: node.name, path: node.path, hidden: false })),

  scan_find: ({ rootPath }) => { const node = fs.lookup(String(rootPath)); return node?.isDir ? handleOf(node) : null; },
  scan_start: ({ request, onProgress }) => {
    const node = fs.lookup(String(request?.root ?? ""));
    if (!node?.isDir) throw new Error(`The demo has no folder at ${request?.root}`);
    const handle = handleOf(node);
    setTimeout(() => send(onProgress, { scanId: handle.scanId, stage: "walking", nodeCount: Math.round(handle.nodeCount / 2), elapsedMs: 1_900 }), 250);
    setTimeout(() => send(onProgress, { scanId: handle.scanId, stage: "done", nodeCount: handle.nodeCount, elapsedMs: handle.elapsedMs }), 700);
    return handle;
  },
  scan_status: ({ scanId }) => handleOf(rootOf(scanId)),
  scan_page: ({ query }) => fs.page(rootOf(query.scanId), query),
  directory_snapshot: ({ path, scanId }) => {
    const node = fs.lookup(String(path));
    const depth = scanId ? rootOf(scanId).depth : 0;
    return node ? node.children.map((id) => fs.toRecord(fs.nodes[id], depth)) : [];
  },
  fs_watch_start: () => 1,
  memory_stats: () => ({ workingSetBytes: 212e6, privateBytes: 184e6, managedBudgetBytes: 512e6, scanIndexBytes: 38e6, activeScans: 0, retainedScanHandles: 3 }),
  scan_subtree_files: ({ query }) => {
    const files = filesUnder(query.directoryId).map((node) => ({ path: node.path, size: node.size }));
    const items = files.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 5_000));
    return { items, offset: query.offset ?? 0, limit: query.limit ?? 5_000, hasMore: (query.offset ?? 0) + items.length < files.length };
  },
  scan_folder_preview: ({ directoryId }) => {
    const best = filesUnder(directoryId).filter((node) => fs.kindOf(node) !== "other").sort((a, b) => b.size - a.size)[0];
    return best ? { path: best.path, size: best.size } : null;
  },
  scan_compression_candidates_stream: ({ directoryId, allowVideo, allowImage, minSizeBytes, onBatch }) => {
    const all = filesUnder(directoryId);
    const typed = all.filter((node) => (allowVideo && fs.kindOf(node) === "video") || (allowImage && fs.kindOf(node) === "image"));
    const eligible = typed.filter((node) => node.size >= (minSizeBytes ?? 0));
    const progress = { scanned: all.length, eligible: eligible.length, skippedUnavailable: all.length - typed.length, skippedNoGain: 0, skippedTooSmall: typed.length - eligible.length };
    send(onBatch, { items: eligible.map((node) => ({ path: node.path, size: node.size })), progress });
    return progress;
  },

  duplicates_scan: ({ onProgress }) => {
    const groups = fs.duplicateSets.map((set) => ({
      files: set.map((node) => ({ path: node.path, name: node.name, size: node.size, modified: Math.floor(node.modifiedMs / 1000) })),
      waste: set[0].size * (set.length - 1),
    }));
    const scanned = 4_812;
    send(onProgress, { phase: "hashing", scanned, hashing: groups.length * 2, hashed: groups.length, fraction: 0.5, startedAt: Date.now() });
    return later(900, () => {
      send(onProgress, { phase: "done", scanned, hashing: groups.length * 2, hashed: groups.length * 2, fraction: 1 });
      return { groups, errors: [], scanned, hashing: groups.length * 2, cancelled: false, reviewToken: "demo-review" };
    });
  },
  duplicates_action: (args) => ({ ok: true, errors: [], succeeded: args.paths ?? args.request?.paths ?? [] }),
  duplicates_link: (args) => ({ ok: true, errors: [], succeeded: args.paths ?? args.request?.paths ?? [] }),

  compression_tools: () => compression.TOOLS,
  compression_list: () => compression.listJobs(),
  compression_files: ({ id, query }) => compression.jobFiles(id, query ?? {}),
  compression_telemetry: () => compression.telemetry(),
  compression_subscribe: () => new Promise(() => {}),
  compression_control: ({ action, request }) => compression.control(action, request ?? {}),
  compression_start: ({ request }) => compression.startJob(request ?? {}),
  compression_log: ({ limit }) => compression.historyLog(limit ?? 500),
  compression_log_path: ({ kind }) => ({ path: `${USER}\\AppData\\Roaming\\FileTree\\${kind === "debug" ? "compress-debug.log" : "compress-log.csv"}` }),

  cyberdrop_workspace: ({ request }) => cyberdrop.workspace(request ?? { action: "init" }),
  cyberdrop_document: () => cyberdrop.document(),
  cyberdrop_status: () => cyberdrop.status(),
  cyberdrop_start: () => { cyberdrop.setRunning(true); return null; },
  cyberdrop_stop: () => { cyberdrop.setRunning(false); return null; },

  terminal_profiles: () => [{ id: "powershell", label: "PowerShell" }],
  terminal_spawn: () => ({ id: 1, title: "PowerShell" }),
  file_icons: ({ extensions }) => Object.fromEntries((extensions ?? []).map((extension: string) => [extension, null])),
  file_thumbnail: ({ path }) => thumbnail(String(path)),
};

/** Browser-only answers for Tauri's window/event plugins. */
function pluginFallback(cmd: string): unknown {
  if (cmd === "plugin:event|listen") return Math.floor(Math.random() * 1e9);
  if (cmd.startsWith("plugin:window|is_")) return false;
  return null;
}

export function installDemo(): void {
  try {
    if (!localStorage.getItem("filetree_plugins")) localStorage.setItem("filetree_plugins", JSON.stringify({ cyberdrop: { enabled: true, since: fs.DEMO_NOW } }));
  } catch { /* storage blocked: the Cyberdrop tab just starts opted out */ }
  const w = window as unknown as Record<string, any>;
  const internals = (w.__TAURI_INTERNALS__ ??= {});
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
  const native = typeof internals.invoke === "function" ? internals.invoke.bind(internals) : null;
  if (typeof internals.transformCallback !== "function") {
    const callbacks = new Map<number, (data: unknown) => void>();
    let nextId = 1;
    internals.transformCallback = (callback: (data: unknown) => void, once = false) => {
      const id = nextId++;
      callbacks.set(id, (data) => { if (once) callbacks.delete(id); callback?.(data); });
      return id;
    };
    internals.unregisterCallback = (id: number) => callbacks.delete(id);
    internals.runCallback = (id: number, data: unknown) => callbacks.get(id)?.(data);
    internals.callbacks = callbacks;
  }
  internals.metadata ??= { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } };
  internals.convertFileSrc ??= (path: string) => path;
  internals.invoke = async (cmd: string, args: Args = {}, options?: unknown) => {
    if (cmd.startsWith("plugin:")) return native ? native(cmd, args, options) : pluginFallback(cmd);
    const handler = handlers[cmd];
    return handler ? handler(args) : null;
  };
  document.title = "FileTree Demo";
}
