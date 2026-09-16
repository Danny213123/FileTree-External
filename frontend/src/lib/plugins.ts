// Registry of approved plugins plus the opt-in preferences that gate them.
//
// A plugin is a third-party tool that runs *on top of* FileTree rather than
// being woven into an existing view: once enabled it owns its own tab on the
// Plugins page and renders whatever it likes there. FileTree hands it context
// (the current folder, the last scan) and stays out of the way.
//
// Plugins are strictly opt-in. An entry appearing in PLUGINS only means
// FileTree knows how to host that tool, never that it is running — code acting
// on a plugin must check `isOptedIn` first.
//
// Adding one is a data change: append a PluginDef below and the Plugins page
// picks up the catalog card and the tab automatically.

import { BunkrView } from "../components/BunkrView";
import { CyberdropView } from "../components/CyberdropView";
import { EverythingView } from "../components/EverythingView";
import { MediaInsightView } from "../components/MediaInsightView";
import { RcloneView } from "../components/RcloneView";
import { ResticView } from "../components/ResticView";
import type { ComponentType } from "react";
import type { IconName } from "../components/Icon";

const STORAGE_KEY = "filetree_plugins";

/**
 * How far along a plugin is.
 *
 * - `available` — shipped; can be turned on now.
 * - `preview`   — shipped, but its panel may still change.
 * - `planned`   — announced only. Listed so it is discoverable, but opting in
 *                 is blocked until the plugin lands.
 */
export type PluginStatus = "available" | "preview" | "planned";

export const STATUS_LABELS: Record<PluginStatus, string> = {
  available: "Available",
  preview: "Preview",
  planned: "Coming soon",
};

/** What a plugin's own UI is handed when its tab renders. */
export interface PluginPanelProps {
  plugin: PluginDef;
}

export interface PluginDef {
  id: string;
  name: string;
  /** Who publishes the tool, shown under the name. */
  vendor: string;
  icon: IconName;
  status: PluginStatus;
  /** One line for the catalog card. */
  summary: string;
  /** The longer pitch on the plugin's own tab. */
  about: string;
  /** What FileTree hands the plugin. Shown before opting in. */
  needs: string[];
  /** What the plugin gives you once it is running. */
  provides: string[];
  website?: string;
  /**
   * The plugin's own UI. Once opted in this replaces the description and owns
   * the whole tab body. Wrap heavy panels in `React.lazy` so they stay out of
   * the main bundle.
   */
  panel?: ComponentType<PluginPanelProps>;
  /**
   * Seed entries that exist only to demonstrate the opt-in flow. Delete the
   * flag (and the entry, if it never ships) once a real plugin lands.
   */
  example?: boolean;
}

/**
 * The approved catalog.
 *
 * Cyberdrop ships a native-backed panel. The remaining example entries
 * demonstrate integrations that have not been implemented yet.
 */
export const PLUGINS: PluginDef[] = [
  {
    id: "cyberdrop", name: "Cyberdrop DL", vendor: "Cyberdrop-DL", icon: "arrow-repeat", status: "available",
    summary: "Download URL lists with Cyberdrop, with setup, live monitoring and an integrated editor.",
    about: "Use your local Cyberdrop installation from FileTree. Setup and Edit share one config.yml; keep separate named URL lists and monitor downloads without a separate terminal.",
    needs: ["Your local Cyberdrop installation and Python environment", "Read/write access to its FileTree configuration and URL list library", "Network and destination folder access when you start a download"],
    provides: ["Setup, Monitor and Edit tabs", "Shared config.yml and saved URL lists", "Start/Stop controls and live CLI output"],
    panel: CyberdropView,
  },
  {
    id: "bunkr", name: "Bunkr Album Search", vendor: "balbums.st", website: "balbums.st", icon: "search", status: "preview",
    summary: "Search the public Bunkr album index and turn the results into a URL list.",
    about: "Searches the balbums.st index for album titles and shows what it finds, with the file count each album reports. Tick the albums you want and the panel writes their links as a .txt URL list, or adds them straight to the Cyberdrop plugin's workspace as a named workstation.",
    needs: ["Network access to the album index when you press Search", "The Cyberdrop plugin's installation folder, only to add a URL list to its workspace"],
    provides: ["Album search with the index's own match modes, sorting and page size", "Album links, titles and file counts you can pick from", "A .txt URL list, or a workstation handed to Cyberdrop"],
    panel: BunkrView,
  },
  {
    id: "everything",
    name: "Everything",
    vendor: "voidtools",
    website: "voidtools.com",
    icon: "search",
    status: "available",
    panel: EverythingView,
    summary: "Search every drive on the machine instantly, without scanning first.",
    about:
      "Everything keeps a live index of every filename on your NTFS volumes. Its panel "
      + "is a search box over that index, so you can find a file anywhere on the machine "
      + "in milliseconds — including on drives FileTree has never scanned — and open the "
      + "folder it lives in as a normal FileTree tab.",
    needs: [
      "Everything's own \"ES\" command-line tool, or its built-in HTTP server",
      "Nothing is written, and no file contents are read",
    ],
    provides: [
      "A search box that matches against every indexed drive as you type",
      "Results you can open or reveal in Explorer",
      "Coverage of drives that have never been scanned",
    ],
  },
  {
    id: "rclone",
    name: "rclone",
    vendor: "rclone project",
    website: "rclone.org",
    icon: "arrow-repeat",
    status: "available",
    panel: RcloneView,
    summary: "Put a cloud remote side by side with the folder you just scanned.",
    about:
      "rclone talks to sixty-odd cloud storage providers through one interface. Its panel "
      + "lists the remotes you have already configured and puts one next to your latest "
      + "scan, so the question \"is this folder actually backed up anywhere\" has an answer "
      + "you can see rather than assume.",
    needs: [
      "The remotes in your existing rclone config — FileTree never creates or edits them",
      "Read access to the local folder you ask it to compare",
      "Nothing is written: no copy, sync or delete is run from the panel",
    ],
    provides: [
      "Your remotes with what each one holds and its quota",
      "A browsable listing of any remote folder",
      "Local files with no copy on the remote, largest first",
    ],
  },
  {
    id: "media", name: "Media Insight", vendor: "FFmpeg project", website: "ffmpeg.org", icon: "bar-chart", status: "available",
    summary: "Read what your video actually is, and rank what a re-encode would save.",
    about: "A scan shows a 12 GB file; it does not show that the file is a 1080p clip at 40 Mbit/s that would look the same at a third of the size. This reads the biggest media in a folder with ffprobe and ranks it by the bytes a re-encode would plausibly save at a sane bitrate for the resolution, then hands your selection to the compression queue.",
    needs: ["ffprobe, from the same ffmpeg the compression workspace uses", "Read access to the folder you point it at; files are read, never modified"],
    provides: ["Codec, resolution, length and bitrate per file", "Files ranked by the bytes a re-encode would save", "A selection sent straight to Compress → Monitor"],
    panel: MediaInsightView,
  },
  {
    id: "restic",
    name: "restic",
    vendor: "restic project",
    website: "restic.net",
    icon: "clock-history",
    status: "available",
    panel: ResticView,
    summary: "See which of your biggest folders no backup snapshot covers.",
    about:
      "A scan tells you what is taking up space; it does not tell you what you would lose. "
      + "Pointed at a restic repository, this panel cross-references your last scan against "
      + "the snapshots in it and ranks the folders that exist nowhere else.",
    needs: [
      "The repository location and its password, which is kept only while the panel is open",
      "The folder path you ask it about",
      "Nothing is written: no backup, forget or prune is run from the panel",
    ],
    provides: [
      "Every snapshot in the repository with its paths, host and tags",
      "What the repository itself occupies",
      "A straight answer to whether a folder is covered, and by which snapshots",
    ],
  },
];

export function getPlugin(id: string): PluginDef | undefined {
  return PLUGINS.find((d) => d.id === id);
}

/** Planned entries are listed for discovery but cannot be turned on. */
export function canOptIn(def: PluginDef): boolean {
  return def.status !== "planned";
}

export interface PluginPref {
  enabled: boolean;
  /** When the user opted in, so the tab can say since when. */
  since: number;
}

export type PluginPrefs = Record<string, PluginPref>;

function isPref(v: unknown): v is PluginPref {
  return typeof v === "object" && v !== null
    && typeof (v as PluginPref).enabled === "boolean"
    && typeof (v as PluginPref).since === "number";
}

/**
 * Read the saved opt-ins.
 *
 * Entries for ids that are not in the registry are kept as-is: a plugin pulled
 * for a release should not silently lose the user's consent when it comes back.
 */
export function loadPluginPrefs(): PluginPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: PluginPrefs = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPref(value)) out[id] = { enabled: value.enabled, since: value.since };
    }
    return out;
  } catch {
    return {};
  }
}

export function savePluginPrefs(prefs: PluginPrefs): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage full or blocked */ }
}

export function isOptedIn(prefs: PluginPrefs, id: string): boolean {
  return prefs[id]?.enabled === true;
}

/** Returns a new prefs object; opting out keeps the record so `since` survives a re-enable. */
export function setOptIn(prefs: PluginPrefs, id: string, enabled: boolean): PluginPrefs {
  const since = enabled ? (prefs[id]?.since ?? Date.now()) : (prefs[id]?.since ?? 0);
  return { ...prefs, [id]: { enabled, since } };
}

/** How many catalog entries are on. Ignores leftovers for unregistered ids. */
export function countOptedIn(prefs: PluginPrefs): number {
  return PLUGINS.reduce((n, def) => n + (isOptedIn(prefs, def.id) ? 1 : 0), 0);
}
