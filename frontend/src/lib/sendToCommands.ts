// User-defined "Send to" commands (#44).
//
// A localStorage-backed list of user-editable shell commands that run against
// the current selection. Each command is a template where the selected paths
// are substituted before it runs via the existing (approval-gated) run-command
// API. The list is intentionally EMPTY by default and only ever holds entries
// the user explicitly added — nothing here runs without the user creating it
// and clicking Run, so there is no implicit/bundled command surface.
//
// Template placeholders (substituted with double-quoted, space-joined paths):
//   {paths}  → every selected path, each quoted        e.g. "a.txt" "b.txt"
//   {path}   → the first selected path, quoted
//   {dir}    → the parent directory of the first path, quoted

const STORAGE_KEY = "filetree.sendToCommands";
const MAX_ENTRIES = 50;

export interface SendToCommand {
  id: string;
  name: string;
  /** Shell template with {paths}/{path}/{dir} placeholders. */
  template: string;
}

export function getSendToCommands(): SendToCommand[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is SendToCommand =>
        c && typeof c.id === "string" && typeof c.name === "string" && typeof c.template === "string",
    );
  } catch {
    return [];
  }
}

function save(list: SendToCommand[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    /* ignore */
  }
}

export function addSendToCommand(name: string, template: string): SendToCommand[] {
  const entry: SendToCommand = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    template: template.trim(),
  };
  const next = [...getSendToCommands(), entry];
  save(next);
  return next;
}

export function removeSendToCommand(id: string): SendToCommand[] {
  const next = getSendToCommands().filter((c) => c.id !== id);
  save(next);
  return next;
}

function quote(p: string): string {
  // Wrap in double quotes; strip any embedded double quotes so a path can never
  // break out of the argument (defense-in-depth — the run-command API is itself
  // approval-gated and these are user-authored templates).
  return `"${p.replace(/"/g, "")}"`;
}

function parentDir(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

/** Substitute the selection into a command template. */
export function expandTemplate(template: string, paths: string[]): string {
  const all = paths.map(quote).join(" ");
  const first = paths[0] ?? "";
  return template
    .replace(/\{paths\}/g, all)
    .replace(/\{path\}/g, quote(first))
    .replace(/\{dir\}/g, quote(parentDir(first)));
}
