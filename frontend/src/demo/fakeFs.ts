// Deterministic fake filesystem for the demo build. Every drive, folder and
// file here is invented; nothing is read from disk. A fixed seed and a fixed
// "now" keep screenshots identical between runs.
import type { NodeRecord } from "../api/types";

export const DEMO_NOW = Date.UTC(2026, 8, 14, 16, 30);
const DAY = 86_400_000;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

export interface DemoNode {
  id: number;
  parentId: number | null;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  files: number;
  folders: number;
  modifiedMs: number;
  createdMs: number;
  newestCreatedMs: number;
  depth: number;
  extension: string;
  children: number[];
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260915);
const between = (min: number, max: number) => Math.round(min + rand() * (max - min));
const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)];

export const nodes: DemoNode[] = [];
const byPath = new Map<string, DemoNode>();
/** Intentional duplicate copies, grouped by their original file. */
export const duplicateSets: DemoNode[][] = [];

function add(parent: DemoNode | null, name: string, isDir: boolean, size = 0, ageDays = between(1, 900)): DemoNode {
  const path = parent ? `${parent.path.replace(/\\$/, "")}\\${name}` : name;
  const modifiedMs = DEMO_NOW - ageDays * DAY - between(0, DAY);
  const dot = name.lastIndexOf(".");
  const node: DemoNode = {
    id: nodes.length, parentId: parent?.id ?? null, name, path, isDir,
    size: isDir ? 0 : size, files: 0, folders: 0,
    modifiedMs, createdMs: modifiedMs - between(0, 30) * DAY, newestCreatedMs: 0,
    depth: parent ? parent.depth + 1 : 0,
    extension: !isDir && dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
    children: [],
  };
  nodes.push(node);
  byPath.set(path.toLowerCase(), node);
  parent?.children.push(node.id);
  return node;
}
const dir = (parent: DemoNode, name: string, ageDays?: number) => add(parent, name, true, 0, ageDays);
const file = (parent: DemoNode, name: string, size: number, ageDays?: number) => add(parent, name, false, size, ageDays);
const pad = (value: number, width = 2) => String(value).padStart(width, "0");

// ── C:\ ────────────────────────────────────────────────────────────────────
const c = add(null, "C:\\", true);
const user = dir(dir(c, "Users"), "Demo");
const desktop = dir(user, "Desktop");
["Quarterly report.docx", "Budget 2026.xlsx", "Trip itinerary.pdf", "Notes.txt"].forEach((name) => file(desktop, name, between(40_000, 3_000_000), between(1, 60)));
const documents = dir(user, "Documents");
for (const folder of ["Taxes", "Receipts", "Manuals", "Letters"]) {
  const target = dir(documents, folder);
  for (let i = 1; i <= between(8, 20); i++) file(target, `${folder} ${2020 + (i % 7)} - ${pad(i)}.pdf`, between(80_000, 9 * MB));
}
const downloads = dir(user, "Downloads");
["NVIDIA-driver-581.42.exe", "HandBrake-1.9.2-x86_64-Win.exe", "python-3.13.1-amd64.exe", "Blender-4.5.zip", "dataset-sample.csv", "wallpaper-pack.zip", "VS Code setup.exe"]
  .forEach((name) => file(downloads, name, between(20 * MB, 900 * MB), between(1, 200)));
const pictures = dir(user, "Pictures");
const screenshots = dir(pictures, "Screenshots");
for (let i = 1; i <= 64; i++) file(screenshots, `Screenshot 2026-0${1 + (i % 8)}-${pad(1 + (i % 27))} ${pad(10 + (i % 12))}${pad(i % 60)}.png`, between(300_000, 4 * MB), between(1, 250));
dir(user, "Videos");
const appData = dir(dir(user, "AppData"), "Local");
for (const app of ["Google", "Microsoft", "npm-cache", "Temp", "pip"]) {
  const target = dir(appData, app);
  for (let i = 0; i < between(10, 40); i++) file(target, `cache-${i.toString(16)}.bin`, between(50_000, 60 * MB));
}
const programFiles = dir(c, "Program Files");
for (const app of ["HandBrake", "7-Zip", "Git", "NVIDIA Corporation", "PowerShell"]) {
  const target = dir(programFiles, app);
  for (let i = 0; i < between(6, 18); i++) file(target, `${app.replace(/\W/g, "").toLowerCase()}${i}.dll`, between(200_000, 90 * MB), between(30, 600));
  file(target, `${app.split(" ")[0]}.exe`, between(2 * MB, 40 * MB), between(30, 600));
}

// ── D:\ ────────────────────────────────────────────────────────────────────
const d = add(null, "D:\\", true);
const media = dir(d, "Media");
const videos = dir(media, "Videos");
const movies = dir(videos, "Movies");
["Arrival (2016)", "Blade Runner 2049 (2017)", "Dune Part Two (2024)", "Interstellar (2014)", "Mad Max Fury Road (2015)", "Spirited Away (2001)", "The Grand Budapest Hotel (2014)", "Whiplash (2014)"].forEach((title) => {
  const folder = dir(movies, title);
  file(folder, `${title}.mkv`, between(4 * GB, 22 * GB));
  file(folder, `${title}.en.srt`, between(60_000, 140_000));
});
const shows = dir(videos, "TV Shows");
for (const [show, seasons] of [["Nature Frontiers", 3], ["City Kitchens", 2], ["Deep Space Logs", 4]] as const) {
  const showDir = dir(shows, show);
  for (let s = 1; s <= seasons; s++) {
    const season = dir(showDir, `Season ${pad(s)}`);
    for (let e = 1; e <= between(6, 10); e++) file(season, `${show} S${pad(s)}E${pad(e)}.mp4`, between(600 * MB, 2.4 * GB));
  }
}
const homeVideos = dir(videos, "Home Videos");
for (const year of [2023, 2024, 2025, 2026]) {
  const target = dir(homeVideos, String(year));
  for (let i = 1; i <= between(10, 24); i++) file(target, `VID_${year}${pad(1 + (i % 12))}${pad(1 + (i % 28))}_${pad(i, 4)}.mp4`, between(80 * MB, 3 * GB));
}
const photos = dir(media, "Photos");
const photoYears = new Map<number, DemoNode>();
for (const year of [2022, 2023, 2024, 2025]) {
  const yearDir = dir(photos, String(year));
  photoYears.set(year, yearDir);
  for (const month of ["01 January", "04 April", "07 July", "10 October", "12 December"]) {
    const monthDir = dir(yearDir, month);
    for (let i = 1; i <= between(18, 45); i++) file(monthDir, `IMG_${year}${month.slice(0, 2)}${pad(i, 4)}.jpg`, between(2.4 * MB, 9 * MB));
  }
  const raw = dir(yearDir, "RAW");
  for (let i = 1; i <= between(20, 40); i++) file(raw, `DSC${pad(year % 100)}${pad(i, 4)}.CR3`, between(22 * MB, 38 * MB));
}
const music = dir(media, "Music");
for (const artist of ["Aurora Lane", "The Night Shifts", "Kobalt Echo", "Marisol", "Paper Satellites"]) {
  const artistDir = dir(music, artist);
  for (let a = 1; a <= between(2, 4); a++) {
    const album = dir(artistDir, pick(["Northbound", "Glass Hours", "Low Tide", "Signal Fires", "Afterglow", "Late Trains"]) + ` (${2014 + a * 2})`);
    for (let t = 1; t <= between(9, 13); t++) file(album, `${pad(t)} - Track ${t}.flac`, between(22 * MB, 48 * MB));
  }
}
const cyberdrop = dir(dir(media, "Downloads"), "cyberdrop-dl");
for (const album of ["Aerial Reels", "Studio Sessions", "Street Photography", "Timelapse Pack"]) {
  const target = dir(cyberdrop, album, between(1, 20));
  for (let i = 1; i <= between(12, 30); i++) {
    const video = i % 3 === 0;
    file(target, video ? `clip_${pad(i, 3)}.mp4` : `photo_${pad(i, 3)}.jpg`, video ? between(120 * MB, 1.8 * GB) : between(1.5 * MB, 7 * MB), between(1, 20));
  }
}
const projects = dir(d, "Projects");
const filetree = dir(projects, "filetree");
for (const [folder, count, min, max, ext] of [["src", 60, 4_000, 400_000, "rs"], ["frontend\\src", 90, 2_000, 180_000, "tsx"], ["docs", 14, 3_000, 60_000, "md"]] as const) {
  let target = filetree;
  for (const part of folder.split("\\")) target = dir(target, part, between(1, 30));
  for (let i = 0; i < count; i++) file(target, `${pick(["scan", "tree", "compress", "view", "store", "search", "panel", "cache"])}_${i}.${ext}`, between(min, max), between(1, 45));
}
const nodeModules = dir(dir(filetree, "frontend"), "node_modules");
for (const pkg of ["react", "react-dom", "vite", "typescript", "esbuild", "vitest", "@tanstack", "@tauri-apps", "rollup", "jsdom"]) {
  const target = dir(nodeModules, pkg);
  for (let i = 0; i < between(10, 30); i++) file(target, `${pkg.replace(/\W/g, "")}-${i}.js`, between(8_000, pkg === "typescript" || pkg === "esbuild" ? 12 * MB : 900_000));
}
const target = dir(dir(filetree, "target"), "release");
["FileTree.exe", "filetree-cli.exe", "FileTree.pdb", "libfiletree_core.rlib", "deps.tar"].forEach((name) => file(target, name, between(40 * MB, 1.8 * GB), between(1, 10)));
for (const project of ["website", "home-lab", "ml-experiments"]) {
  const folder = dir(projects, project);
  for (let i = 0; i < between(15, 40); i++) file(folder, `${project}-${i}.${pick(["py", "ts", "json", "md", "ipynb"])}`, between(2_000, 3 * MB));
}
const datasets = dir(projects, "datasets");
["imagenet-subset.tar", "weather-2010-2025.parquet", "city-traffic.csv", "embeddings.npy"].forEach((name) => file(datasets, name, between(2 * GB, 60 * GB)));

// ── E:\ — backups, including exact copies of D:\ files ──────────────────────
const e = add(null, "E:\\", true);
const backups = dir(e, "Backups");
function copyOf(source: DemoNode, folder: DemoNode, name = source.name): void {
  const copy = file(folder, name, source.size);
  copy.modifiedMs = source.modifiedMs;
  const set = duplicateSets.find((group) => group[0] === source);
  if (set) set.push(copy); else duplicateSets.push([source, copy]);
}
const photoBackup = dir(backups, "Photos 2024 (copy)", 180);
for (const monthId of photoYears.get(2024)!.children) {
  const month = nodes[monthId];
  if (!month.isDir || month.name === "RAW") continue;
  const copyDir = dir(photoBackup, month.name, 180);
  month.children.slice(0, 14).forEach((id) => copyOf(nodes[id], copyDir));
}
const laptop = dir(backups, "Old laptop", 420);
nodes[movies.children[2]].children.slice(0, 1).forEach((id) => copyOf(nodes[id], laptop));
screenshots.children.slice(0, 12).forEach((id) => copyOf(nodes[id], laptop));
const archive = dir(e, "Archive", 700);
["2019 Taxes.zip", "Wedding photos.7z", "Old projects.zip", "Mail export.pst"].forEach((name) => file(archive, name, between(1 * GB, 40 * GB), between(400, 1200)));

// ── Aggregates ──────────────────────────────────────────────────────────────
for (let i = nodes.length - 1; i >= 0; i--) {
  const node = nodes[i];
  if (!node.isDir) { node.newestCreatedMs = node.createdMs; continue; }
  for (const id of node.children) {
    const child = nodes[id];
    node.size += child.size;
    node.files += child.isDir ? child.files : 1;
    node.folders += child.isDir ? child.folders + 1 : 0;
    node.newestCreatedMs = Math.max(node.newestCreatedMs, child.newestCreatedMs);
    node.modifiedMs = Math.max(node.modifiedMs, child.modifiedMs);
  }
}

export const DRIVES = [
  { root: "C:\\", label: "Windows", total: 1_000_204_886_016 },
  { root: "D:\\", label: "Data", total: 4_000_787_030_016 },
  { root: "E:\\", label: "Backup", total: 2_000_398_934_016 },
].map((drive) => {
  const used = byPath.get(drive.root.toLowerCase())!.size;
  const reserved = drive.root === "C:\\" ? 610 * GB : drive.root === "D:\\" ? 1_900 * GB : 1_620 * GB;
  return { ...drive, free: Math.max(0, drive.total - used - reserved) };
});

// ── Queries ─────────────────────────────────────────────────────────────────
/** Find a node by path, accepting "D:", "D:\", "d:/Media/" and other spellings. */
export function lookup(path: string): DemoNode | undefined {
  let key = path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  if (/^[a-z]:$/.test(key)) key += "\\";
  return byPath.get(key);
}
export const driveOf = (path: string) => DRIVES.find((drive) => path.toUpperCase().startsWith(drive.root[0]));

export function descendants(root: DemoNode): DemoNode[] {
  const out: DemoNode[] = [];
  const stack = [...root.children];
  while (stack.length) {
    const node = nodes[stack.pop()!];
    out.push(node);
    stack.push(...node.children);
  }
  return out;
}

const CATEGORIES: Record<string, string[]> = {
  image: ["jpg", "jpeg", "png", "cr3", "webp"], video: ["mp4", "mkv", "mov"], audio: ["flac", "mp3"],
  document: ["pdf", "docx", "xlsx", "txt", "md", "csv"], archive: ["zip", "7z", "tar"],
  code: ["rs", "tsx", "ts", "js", "py", "json", "ipynb"], executable: ["exe", "dll"],
};
export const kindOf = (node: DemoNode) => CATEGORIES.video.includes(node.extension) ? "video" : CATEGORIES.image.includes(node.extension) ? "image" : "other";

export interface PageQuery {
  directoryPaths?: string[]; parentId: number | null; offset: number; limit: number;
  search: string; sort: string; direction: "asc" | "desc"; directoriesOnly: boolean; filesOnly: boolean;
  regex: boolean; minSize: number | null; maxSize: number | null; modifiedAfter: number | null;
  modifiedBefore: number | null; ext: string; category: string;
}

/** A scan's rows are relative to its root, as in FileTree's scan index: the
 *  root is id 0 with no parent and depth 0; every other id is offset by one. */
export type ScanRoot = { id: number; depth: number };
export const encodeId = (id: number, root: ScanRoot) => id === root.id ? 0 : id + 1;
export const decodeId = (id: number, root: ScanRoot) => id === 0 ? root.id : id - 1;

export function toItem(node: DemoNode, root: ScanRoot) {
  const rootDepth = root.depth;
  return {
    id: encodeId(node.id, root),
    parentId: node.id === root.id || node.parentId == null ? null : encodeId(node.parentId, root),
    name: node.name, path: node.path, isDir: node.isDir,
    isLink: false, hidden: false, readonly: false, size: node.size, allocated: node.isDir ? node.size : Math.ceil(node.size / 4096) * 4096,
    files: node.files, folders: node.folders, modifiedMs: node.modifiedMs, createdMs: node.createdMs,
    accessedMs: node.modifiedMs, depth: node.depth - rootDepth, errors: 0, extension: node.extension,
    owner: "", attributes: node.isDir ? 16 : 32, newestCreatedMs: node.newestCreatedMs,
  };
}

export function toRecord(node: DemoNode, root: ScanRoot = { id: -1, depth: 0 }): NodeRecord {
  const item = toItem(node, root);
  return {
    id: item.id, parent: item.parentId, name: item.name, path: item.path, dir: item.isDir, link: false,
    hidden: false, readonly: false, size: item.size, allocated: item.allocated, files: item.files,
    folders: item.folders, modified: item.modifiedMs, created: item.createdMs, accessed: item.accessedMs,
    depth: item.depth, errors: 0, extension: item.extension, children: [], owner: "", attributes: item.attributes,
    aggregateKnown: true, lastFileCreated: item.newestCreatedMs,
  };
}

const SORT_FIELD: Record<string, (node: DemoNode) => number | string> = {
  name: (node) => node.name.toLowerCase(), type: (node) => node.extension, extension: (node) => node.extension,
  modified: (node) => node.modifiedMs, created: (node) => node.createdMs, accessed: (node) => node.modifiedMs,
  lastFileCreated: (node) => node.newestCreatedMs, files: (node) => node.files, folders: (node) => node.folders,
};

export function page(root: DemoNode, query: PageQuery) {
  const filtered = !!(query.search || query.directoriesOnly || query.filesOnly || query.ext || query.category
    || query.minSize != null || query.maxSize != null || query.modifiedAfter != null || query.modifiedBefore != null);
  let rows: DemoNode[];
  if (query.directoryPaths?.length) rows = query.directoryPaths.map(lookup).filter((node): node is DemoNode => !!node);
  else if (query.parentId == null) rows = filtered ? descendants(root) : [root];
  else rows = (nodes[decodeId(query.parentId, root)]?.children ?? []).map((id) => nodes[id]);
  let matcher: (name: string) => boolean = () => true;
  if (query.search) {
    const needle = query.search.toLowerCase();
    try { const pattern = query.regex ? new RegExp(query.search, "i") : null; matcher = pattern ? (name) => pattern.test(name) : (name) => name.toLowerCase().includes(needle); }
    catch { matcher = () => false; }
  }
  const exts = query.ext.split(/[,; ]+/).map((ext) => ext.replace(/^\./, "").toLowerCase()).filter(Boolean);
  rows = rows.filter((node) => matcher(node.name)
    && (!query.directoriesOnly || node.isDir) && (!query.filesOnly || !node.isDir)
    && (!exts.length || exts.includes(node.extension))
    && (!query.category || query.category === "any" || (query.category === "folder" ? node.isDir : (CATEGORIES[query.category] ?? []).includes(node.extension)))
    && (query.minSize == null || node.size >= query.minSize) && (query.maxSize == null || node.size <= query.maxSize)
    && (query.modifiedAfter == null || node.modifiedMs >= query.modifiedAfter) && (query.modifiedBefore == null || node.modifiedMs <= query.modifiedBefore));
  const field = SORT_FIELD[query.sort] ?? ((node: DemoNode) => node.size);
  const sign = query.direction === "asc" ? 1 : -1;
  rows.sort((a, b) => { const x = field(a), y = field(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * sign; });
  const items = rows.slice(query.offset, query.offset + query.limit).map((node) => toItem(node, root));
  return { items, total: rows.length, offset: query.offset, limit: query.limit, hasMore: query.offset + items.length < rows.length };
}
