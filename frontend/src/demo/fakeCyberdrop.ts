// Invented Cyberdrop DL workspace and a live-looking download run for the demo build.
const FOLDER = "C:\\Users\\Demo\\AppData\\Roaming\\FileTree Demo\\cyberdrop";
const URLS = [
  "# Aerial and travel footage",
  "https://cyberdrop.me/a/demo-aerial-reels",
  "https://cyberdrop.me/a/demo-studio-sessions",
  "https://cyberdrop.me/a/demo-street-photography",
  "https://cyberdrop.me/a/demo-timelapse-pack",
  "",
].join("\n");

const workspaceState = {
  folder: FOLDER, name: "URLs-K7Q2M", text: URLS,
  stations: [
    { id: "URLs-K7Q2M", label: "Travel footage.txt", opened: 3, edited: 3 },
    { id: "URLs-P4D9X", label: "Photo sets.txt", opened: 2, edited: 2 },
    { id: "URLs-A1B2C", label: "URLs.txt", opened: 1, edited: 1 },
  ],
  revisions: ["1757862000000000000", "1757775600000000000"],
  loaded: { id: "URLs-K7Q2M" } as { id: string } | null,
  activeText: URLS, compressionMode: "filetree",
  sideload: { preset: "balanced", originalAction: "keep" },
};

export function workspace(request: { action: string; mode?: string; settings?: Record<string, string | number | boolean>; text?: string; name?: string; label?: string }) {
  if (request.action === "mode" && request.mode) workspaceState.compressionMode = request.mode;
  if (request.action === "sideload") workspaceState.sideload = { ...workspaceState.sideload, ...request.settings };
  if (request.action === "save" && request.text != null) workspaceState.text = request.text;
  if (request.action === "stage") { workspaceState.loaded = { id: workspaceState.name }; workspaceState.activeText = workspaceState.text; }
  if (request.action === "revision") return { text: URLS };
  return structuredClone(workspaceState);
}

const settings = {
  download_folder: "D:\\Media\\Downloads\\cyberdrop-dl",
  downloads: { concurrency: 15, concurrency_per_domain: 5, attempts: 2, speed_limit: "0B" },
  deep_scrape: false, ignore_history: false,
  filters: { files: { images: true, videos: true, audio: true } },
  compression_options: { enabled: false, compress_videos: true, compress_images: true, video_backend: "handbrake", video_codec: "hevc", hevc_cq: 23 },
};

export function document() {
  return {
    text: "download_folder: D:\\Media\\Downloads\\cyberdrop-dl\ndownloads:\n  concurrency: 15\n  concurrency_per_domain: 5\n  attempts: 2\n  speed_limit: 0B\ncompression_options:\n  enabled: false\n  video_backend: handbrake\n",
    settings, lists: [], folder: FOLDER, name: "config.yml", validationError: null,
  };
}

let running = true;
const started = Math.floor(Date.now() / 1000) - 754;
const transfers = [
  ["Aerial Reels/clip_014.mp4", "cyberdrop.me", 1_240_000_000],
  ["Aerial Reels/clip_015.mp4", "cyberdrop.me", 862_000_000],
  ["Studio Sessions/photo_021.jpg", "cyberdrop.me", 6_400_000],
  ["Timelapse Pack/clip_003.mp4", "cyberdrop.me", 1_780_000_000],
  ["Street Photography/photo_009.jpg", "cyberdrop.me", 4_900_000],
] as const;

export function status() {
  const t = Date.now() / 1000;
  const files = transfers.map(([description, domain, size], index) => {
    const rate = [11, 7.5, 2.2, 13.4, 1.9][index] * 1024 ** 2;
    const completed = Math.round(((t * rate + index * size * 0.37) % size));
    return { description, domain, size, completed, bytes_downloaded: completed, speed: rate, eta: (size - completed) / rate, hls: false };
  });
  const elapsed = Math.floor(t) - started;
  return {
    status: running ? "Running" : "Stopped", started,
    logs: [
      "Cyberdrop-DL 7.4.1\n", "Using config D:\\...\\config.yml\n", "Scraping 4 URLs from Travel footage.txt\n",
      "Found 118 files in 4 albums\n", "Download started: Aerial Reels/clip_012.mp4\n", "Completed: Aerial Reels/clip_012.mp4 (1.1 GiB)\n",
      "FileTree compression queue: 8 files queued (job job-queued-0).\n", "Download started: Aerial Reels/clip_014.mp4\n",
    ],
    progress: running ? {
      files, active: files.length, bytes: 38_400_000_000 + elapsed * 36_000_000, speed: files.reduce((sum, file) => sum + file.speed, 0),
      fileStats: { completed: 64, prev_completed: 21, skipped: 6, queued: 22, failed: 3 },
      scrapeErrors: { errors: [{ code: 404, msg: "Not Found", count: 2 }] },
      downloadErrors: { errors: [{ code: 503, msg: "Service Unavailable", count: 2 }, { code: null, msg: "Checksum mismatch", count: 1 }] },
      scraping: [{ url: "https://cyberdrop.me/a/demo-timelapse-pack", elapsed: 12 }],
      scrapeQueued: 1, downloadQueued: 22,
      status: { description: "Downloading", messages: ["5 active downloads", "22 queued"] },
      compression: { title: "Compression", pending: 0, compressed: 0, skipped: 0, failed: 0, total: 0, files: [] },
    } : null,
  };
}

export function setRunning(value: boolean) { running = value; }
