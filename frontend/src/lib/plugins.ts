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

import { CyberdropView } from "../components/CyberdropView";
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
    id: "everything",
    name: "Everything",
    vendor: "voidtools",
    website: "voidtools.com",
    icon: "search",
    status: "available",
    example: true,
    summary: "Search every drive on the machine instantly, without scanning first.",
    about:
      "Everything keeps a live index of every filename on your NTFS volumes. Its panel "
      + "is a search box over that index, so you can find a file anywhere on the machine "
      + "in milliseconds — including on drives FileTree has never scanned — and open the "
      + "folder it lives in as a normal FileTree tab.",
    needs: [
      "The folder you are currently browsing, only to sort local matches first",
      "Nothing is written, and no file contents are read",
    ],
    provides: [
      "A search box that matches against every indexed drive as you type",
      "Results you can open in a FileTree tab or reveal in Explorer",
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
    example: true,
    summary: "Put a cloud remote side by side with the folder you just scanned.",
    about:
      "rclone talks to sixty-odd cloud storage providers through one interface. Its panel "
      + "lists the remotes you have already configured and puts one next to your latest "
      + "scan, so the question \"is this folder actually backed up anywhere\" has an answer "
      + "you can see rather than assume.",
    needs: [
      "The remotes in your existing rclone config — FileTree never creates or edits them",
      "The path and file list from your most recent scan, for the comparison",
      "Read-only until you start a transfer yourself from its panel",
    ],
    provides: [
      "A side-by-side view of a remote and the scanned folder",
      "A list of local files with no copy on the remote, largest first",
      "Uploads and downloads queued through the usual transfer manager",
    ],
  },
  {
    id: "restic",
    name: "restic",
    vendor: "restic project",
    website: "restic.net",
    icon: "clock-history",
    status: "planned",
    example: true,
    summary: "See which of your biggest folders no backup snapshot covers.",
    about:
      "A scan tells you what is taking up space; it does not tell you what you would lose. "
      + "Pointed at a restic repository, this panel cross-references your last scan against "
      + "the snapshots in it and ranks the folders that exist nowhere else.",
    needs: [
      "The repository location and credentials you enter in its panel",
      "Folder sizes and paths from your most recent scan",
    ],
    provides: [
      "Backup coverage for every folder in the last scan",
      "Large folders that no snapshot contains, ranked by what they would cost you",
      "Snapshot history with repository size over time",
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
