// Demo build only (VITE_FILETREE_DEMO=1). Every FileTree command is answered
// from invented data, so nothing on this machine is read or changed. In the
// desktop shell, tauriCore.ts routes app commands here; in a plain browser,
// installDemo() provides a stand-in for Tauri's IPC and stubs window controls.
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
/** A folder named by a scan-relative directory id (0 is the scan's root). */
const dirOf = (scanId: string, directoryId: number) => { const root = rootOf(scanId); return fs.nodes[fs.decodeId(directoryId, root)] ?? root; };
const filesUnder = (dir: fs.DemoNode) => fs.descendants(dir).filter((node) => !node.isDir);

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
  // Enough bookmarks to show the sidebar behaving at the size real ones reach.
  bookmarks_get: () => fs.nodes.filter((node) => node.isDir && node.depth === 2).slice(0, 52).map((node) => node.path),
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
    const root = scanId ? rootOf(scanId) : undefined;
    return node ? node.children.map((id) => fs.toRecord(fs.nodes[id], root)) : [];
  },
  fs_watch_start: () => 1,
  memory_stats: () => ({ workingSetBytes: 212e6, privateBytes: 184e6, managedBudgetBytes: 512e6, scanIndexBytes: 38e6, activeScans: 0, retainedScanHandles: 3 }),
  scan_subtree_files: ({ query }) => {
    const files = filesUnder(dirOf(query.scanId, query.directoryId)).map((node) => ({ path: node.path, size: node.size }));
    const items = files.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 5_000));
    return { items, offset: query.offset ?? 0, limit: query.limit ?? 5_000, hasMore: (query.offset ?? 0) + items.length < files.length };
  },
  scan_folder_preview: ({ scanId, directoryId }) => {
    const best = filesUnder(dirOf(scanId, directoryId)).filter((node) => fs.kindOf(node) !== "other").sort((a, b) => b.size - a.size)[0];
    return best ? { path: best.path, size: best.size } : null;
  },
  scan_compression_candidates_stream: ({ scanId, directoryId, allowVideo, allowImage, minSizeBytes, onBatch }) => {
    const all = filesUnder(dirOf(scanId, directoryId));
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
  rename_path: ({ path, newName }) => `${String(path).replace(/[\\/][^\\/]*$/, "")}\\${newName}`,
  delete_paths: ({ paths }) => ({ deleted: paths ?? [], failed: [] }),
  create_folder: () => null,
  restore_recycled: ({ paths }) => paths ?? [],
  ollama_models: () => ["llama3.1:8b", "qwen2.5:14b", "llava:13b"],
  ollama_chat: ({ onLine }) => {
    const reply = "Your largest folder is D:\\Media\\Videos at 263.7 GB — mostly the Movies and TV Shows folders. Compressing them with the Balanced preset would likely save 90–130 GB.";
    const words = reply.split(" ");
    return new Promise<null>((resolve) => {
      let index = 0;
      const timer = setInterval(() => {
        if (index < words.length) { send(onLine, JSON.stringify({ message: { content: (index ? " " : "") + words[index++] } })); return; }
        clearInterval(timer);
        send(onLine, JSON.stringify({ done: true }));
        send(onLine, "");
        resolve(null);
      }, 40);
    });
  },
  ollama_cancel: () => null,
  duplicates_action: (args) => ({ ok: true, errors: [], succeeded: args.paths ?? args.request?.paths ?? [] }),
  duplicates_link: (args) => ({ ok: true, errors: [], succeeded: args.paths ?? args.request?.paths ?? [] }),

  compression_tools: () => compression.TOOLS,
  compression_list: () => compression.listJobs(),
  compression_files: ({ id, query }) => compression.jobFiles(id, query ?? {}),
  compression_telemetry: () => compression.telemetry(),
  compression_subscribe: () => new Promise(() => {}),
  compression_control: ({ action, request }) => compression.control(action, request ?? {}),
  compression_start: ({ request }) => compression.startJob({
    ...request,
    scanDirectories: (request?.scanDirectories ?? []).map((dir: { scanId: string; directoryId: number }) => ({ directoryId: dirOf(dir.scanId, dir.directoryId).id })),
  }),
  compression_log: ({ limit }) => compression.historyLog(limit ?? 500),
  compression_log_path: ({ kind }) => ({ path: `${USER}\\AppData\\Roaming\\FileTree\\${kind === "debug" ? "compress-debug.log" : "compress-log.csv"}` }),

  cyberdrop_workspace: ({ request }) => cyberdrop.workspace(request ?? { action: "init" }),
  cyberdrop_document: () => cyberdrop.document(),
  cyberdrop_status: () => cyberdrop.status(),
  cyberdrop_start: () => { cyberdrop.setRunning(true); return null; },
  cyberdrop_stop: () => { cyberdrop.setRunning(false); return null; },

  // No Everything install in the demo: answer from the invented file tree.
  everything_status: () => ({ es: "C:\\Program Files\\Everything\\es.exe", http: false, ready: true }),
  everything_search: ({ query, limit }) => {
    const needle = String(query ?? "").trim().toLowerCase();
    const matches = fs.nodes.filter((node) => node.name.toLowerCase().includes(needle));
    const results = matches.slice(0, Math.min(Number(limit) || 200, 500)).map((node) => ({
      name: node.name,
      path: node.path,
      size: node.isDir ? null : node.size,
      modified: Math.floor(node.modifiedMs / 1000),
      isDir: node.isDir,
    }));
    return { results, total: matches.length, source: "es" };
  },

  // Invented ffprobe output, ranked the way the real panel ranks it.
  media_probe: ({ limit }) => {
    const sources = fs.nodes.filter((node) => !node.isDir && node.extension === "mp4").slice(0, Math.min(Number(limit) || 100, 40));
    const files = sources.map((node, index) => {
      const duration = 600 + index * 37;
      const bitrate = Math.round((node.size * 8) / duration);
      const height = [2160, 1080, 720][index % 3];
      const target = { 2160: 18_000_000, 1080: 6_000_000, 720: 3_000_000 }[height]!;
      const savings = bitrate > target ? Math.round(node.size * (1 - target / bitrate)) : 0;
      return {
        path: node.path, name: node.name, size: node.size, duration, bitrate,
        videoCodec: index % 4 === 0 ? "hevc" : "h264", audioCodec: "aac",
        width: Math.round((height * 16) / 9), height, targetBitrate: target, savings, error: null,
      };
    }).sort((a, b) => b.savings - a.savings || b.size - a.size);
    return {
      files, probed: files.length, found: files.length,
      reclaimable: files.reduce((total, file) => total + file.savings, 0),
      ffprobe: "C:\\Users\\Demo\\AppData\\Roaming\\FileTree\\tools\\ffprobe.exe",
    };
  },

  // Invented rclone remotes and restic snapshots: no tool is run in the demo.
  rclone_remotes: () => ({ remotes: [{ name: "gdrive", kind: "drive" }, { name: "backup", kind: "s3" }], rclone: "C:\\Tools\\rclone\\rclone.exe" }),
  rclone_about: () => ({ total: 2_199_023_255_552, used: 1_462_463_299_584, free: 736_559_955_968 }),
  rclone_list: ({ path }) => (String(path ?? "") ? [
    { Path: "clip_014.mp4", Name: "clip_014.mp4", Size: 1_288_490_188, IsDir: false },
    { Path: "clip_015.mp4", Name: "clip_015.mp4", Size: 862_000_640, IsDir: false },
  ] : [
    { Path: "Media", Name: "Media", Size: -1, IsDir: true },
    { Path: "Projects", Name: "Projects", Size: -1, IsDir: true },
    { Path: "notes.txt", Name: "notes.txt", Size: 4_096, IsDir: false },
  ]),
  rclone_coverage: () => ({
    localFiles: 918, remoteFiles: 902, missingCount: 16, missingBytes: 42_949_672_960,
    missing: [
      { relative: "Videos/Movies/Dune Part Two (2024).mkv", path: "Videos/Movies/Dune Part Two (2024).mkv", size: 18_854_930_432, differs: false },
      { relative: "Videos/Home Videos/summer-2025.mp4", path: "Videos/Home Videos/summer-2025.mp4", size: 12_884_901_888, differs: true },
      { relative: "Photos/2024/12 December/IMG_2024120001.jpg", path: "Photos/2024/12 December/IMG_2024120001.jpg", size: 9_328_128, differs: false },
    ],
  }),
  restic_snapshots: () => ({
    restic: "C:\\Tools\\restic\\restic.exe",
    snapshots: [
      { id: "a1b2c3d4", time: "2026-09-14T02:00:00Z", hostname: "workstation", paths: ["D:\\Media"], tags: ["nightly"] },
      { id: "99887766", time: "2026-09-07T02:00:00Z", hostname: "workstation", paths: ["D:\\Media", "D:\\Projects"], tags: [] },
    ],
  }),
  restic_stats: () => ({ total_size: 402_653_184_000, total_file_count: 121_402, snapshots_count: 2 }),
  restic_coverage: ({ folder }) => {
    const covered = String(folder ?? "").toLowerCase().startsWith("d:\\media");
    return {
      covered,
      snapshots: covered ? [{ id: "a1b2c3d4", time: "2026-09-14T02:00:00Z", hostname: "workstation", paths: ["D:\\Media"], tags: ["nightly"] }] : [],
      latest: covered ? "2026-09-14T02:00:00Z" : null,
      total: 2,
    };
  },

  // The demo never reaches the network: invented albums for the search panel.
  bunkr_search: ({ query, per, page }) => {
    const size = Math.min(Number(per) || 20, 12);
    const term = String(query ?? "demo").trim() || "demo";
    return {
      albums: Array.from({ length: size }, (_, index) => ({
        title: `${term} · demo album ${index + 1 + (Number(page ?? 1) - 1) * size}`,
        url: `https://example.invalid/a/demo${index + 1}`,
        files: 4 + ((index * 7) % 40),
        thumbnail: null,
      })),
      page: Number(page ?? 1),
      pages: 3,
      url: "https://example.invalid/?search=demo",
    };
  },

  terminal_profiles: () => [{ id: "powershell", label: "PowerShell" }],
  terminal_spawn: () => ({ id: 1, title: "PowerShell" }),
  file_icons: ({ extensions }) => Object.fromEntries((extensions ?? []).map((extension: string) => [extension, null])),
  // No shell to ask in the demo, so the places list keeps the bundled glyphs.
  path_icon: () => null,
  file_thumbnail: ({ path }) => thumbnail(String(path)),
};

/** Answers one app command from demo data; unknown commands resolve to null. */
export function handleDemoCommand(cmd: string, args: Args = {}): unknown {
  const handler = handlers[cmd];
  return handler ? handler(args) : null;
}

/** Browser-only answers for Tauri's window/event plugins. */
function pluginFallback(cmd: string): unknown {
  if (cmd === "plugin:event|listen") return Math.floor(Math.random() * 1e9);
  if (cmd.startsWith("plugin:window|is_")) return false;
  return null;
}

export function installDemo(): void {
  try {
    if (!localStorage.getItem("filetree_plugins")) localStorage.setItem("filetree_plugins", JSON.stringify({ cyberdrop: { enabled: true, since: fs.DEMO_NOW } }));
    // Cyberdrop only connects once an installation folder is known.
    if (!localStorage.getItem("filetree.cyberdrop.repo")) localStorage.setItem("filetree.cyberdrop.repo", "C:\\Tools\\CyberDropDownloader");
  } catch { /* storage blocked: the Cyberdrop tab just starts opted out */ }
  const w = window as unknown as Record<string, any>;
  // Inside the desktop shell Tauri's IPC is present and read-only; leave it be.
  if (!w.__TAURI_INTERNALS__) {
    const callbacks = new Map<number, (data: unknown) => void>();
    let nextId = 1;
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (data: unknown) => void, once = false) => {
        const id = nextId++;
        callbacks.set(id, (data) => { if (once) callbacks.delete(id); callback?.(data); });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
      callbacks,
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      convertFileSrc: (path: string) => path,
      invoke: async (cmd: string, args: Args = {}) => cmd.startsWith("plugin:") ? pluginFallback(cmd) : handleDemoCommand(cmd, args),
    };
  }
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
  document.title = "FileTree Demo";
}
