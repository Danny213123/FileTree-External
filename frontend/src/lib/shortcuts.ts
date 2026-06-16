// Customizable keyboard shortcuts (#47).
//
// A small registry of rebindable commands plus a localStorage-backed binding
// map that OVERLAYS the built-in defaults. The global keydown handler in
// App.tsx normalizes each event into a "chord" string (e.g. "Ctrl+Shift+P")
// via {@link chordFromEvent}, resolves it to a command id through the live
// binding map ({@link buildChordToId}), and dispatches the matching action.
//
// Defaults are kept intact: an empty/invalid override simply falls back to the
// command's `defaultChord`. The shortcuts editor dialog records new chords with
// the SAME `chordFromEvent`, so what the user records is exactly what matches.

export interface ShortcutCommand {
  id: string;
  label: string;
  /** Built-in chord, e.g. "Ctrl+Shift+P". Used when no override is present. */
  defaultChord: string;
  /** Grouping label shown in the editor. */
  category: string;
}

// The full set of rebindable global commands. Order here is the editor's order.
// Every chord matches the output of `chordFromEvent` for its key combo so the
// reverse map and the recorder agree.
export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  { id: "palette.commands", label: "Command Palette", defaultChord: "Ctrl+Shift+P", category: "General" },
  { id: "palette.files", label: "Go to File", defaultChord: "Ctrl+P", category: "General" },
  { id: "toggle.chat", label: "Toggle AI Assistant", defaultChord: "Ctrl+Alt+B", category: "View" },
  { id: "toggle.sidebar", label: "Toggle Side Bar", defaultChord: "Ctrl+B", category: "View" },
  { id: "toggle.panel", label: "Toggle Panel", defaultChord: "Ctrl+J", category: "View" },
  { id: "tab.new", label: "New Tab", defaultChord: "Ctrl+T", category: "View" },
  { id: "toggle.terminal", label: "Toggle Terminal", defaultChord: "Ctrl+`", category: "View" },
  { id: "toggle.preview", label: "Toggle Preview Pane", defaultChord: "Alt+P", category: "View" },
  { id: "toggle.details", label: "Toggle Details Pane", defaultChord: "Alt+Shift+P", category: "View" },
  { id: "nav.back", label: "Navigate Back", defaultChord: "Alt+ArrowLeft", category: "Navigation" },
  { id: "nav.forward", label: "Navigate Forward", defaultChord: "Alt+ArrowRight", category: "Navigation" },
  { id: "nav.up", label: "Up One Level", defaultChord: "Alt+ArrowUp", category: "Navigation" },
  { id: "edit.undo", label: "Undo Last Action", defaultChord: "Ctrl+Z", category: "Edit" },
  { id: "edit.copy", label: "Copy File(s)", defaultChord: "Ctrl+C", category: "Edit" },
  { id: "edit.cut", label: "Cut File(s)", defaultChord: "Ctrl+X", category: "Edit" },
  { id: "edit.paste", label: "Paste File(s)", defaultChord: "Ctrl+V", category: "Edit" },
];

export type ShortcutBindings = Record<string, string>;

const STORAGE_KEY = "filetree_shortcut_bindings";

/** Read the persisted override map (id → chord). Never throws. */
export function loadBindings(): ShortcutBindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ShortcutBindings = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the override map. Only non-default, non-empty entries are kept. */
export function saveBindings(bindings: ShortcutBindings): void {
  try {
    const clean: ShortcutBindings = {};
    for (const cmd of SHORTCUT_COMMANDS) {
      const v = bindings[cmd.id];
      if (typeof v === "string" && v.trim() && v !== cmd.defaultChord) clean[cmd.id] = v;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* ignore */
  }
}

/** Effective chord for a command (override if valid, else its default). */
export function getChord(id: string, bindings: ShortcutBindings): string {
  const cmd = SHORTCUT_COMMANDS.find((c) => c.id === id);
  if (!cmd) return bindings[id] ?? "";
  const override = bindings[id];
  return override && override.trim() ? override : cmd.defaultChord;
}

/**
 * Reverse map: chord → command id, built from the defaults overlaid with the
 * user's overrides. When two commands collide on the same chord, the later one
 * (registry order) wins — the editor surfaces conflicts so this is rare.
 */
export function buildChordToId(bindings: ShortcutBindings): Map<string, string> {
  const map = new Map<string, string>();
  for (const cmd of SHORTCUT_COMMANDS) {
    map.set(getChord(cmd.id, bindings), cmd.id);
  }
  return map;
}

/** Command ids (other than `selfId`) currently bound to `chord`. */
export function findConflicts(chord: string, selfId: string, bindings: ShortcutBindings): string[] {
  if (!chord) return [];
  const out: string[] = [];
  for (const cmd of SHORTCUT_COMMANDS) {
    if (cmd.id === selfId) continue;
    if (getChord(cmd.id, bindings) === chord) out.push(cmd.id);
  }
  return out;
}

// Keys that are modifiers on their own — never a chord by themselves.
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"]);

/**
 * Normalize a keyboard event into a stable chord string. Modifier order is
 * always Ctrl+Alt+Shift+<key>. Returns null when only a modifier is pressed
 * (so a recorder keeps waiting for the real key). Letters are upper-cased;
 * named keys (ArrowLeft, Enter, …) pass through; the backtick is canonicalized
 * via `code` so it matches regardless of the active shift state.
 */
export function chordFromEvent(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key = e.key;
  if (e.code === "Backquote") key = "`";
  else if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  // Multi-char named keys (ArrowLeft, Enter, F2, Escape, …) stay as-is.

  parts.push(key);
  return parts.join("+");
}

/** Human-friendly display of a chord ("Alt+ArrowLeft" → "Alt+Left"). */
export function formatChord(chord: string): string {
  if (!chord) return "Unassigned";
  return chord
    .replace(/ArrowLeft/g, "Left")
    .replace(/ArrowRight/g, "Right")
    .replace(/ArrowUp/g, "Up")
    .replace(/ArrowDown/g, "Down");
}
