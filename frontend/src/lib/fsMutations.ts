export interface FilesystemMutation {
  paths: string[];
  sourceTabId: string;
  sequence: number;
}

type MutationListener = (mutation: FilesystemMutation) => void;

const listeners = new Set<MutationListener>();
let sequence = 0;

function normalizePath(path: string): string {
  const normalized = path.trim().replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
  return normalized || path.trim().toLowerCase();
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}

export function mutationAffectsRoot(rootPath: string, changedPaths: string[]): boolean {
  return changedPaths.some((path) => pathsOverlap(rootPath, path));
}

export function publishFilesystemMutation(paths: string[], sourceTabId: string): void {
  const unique = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
  if (unique.length === 0) return;
  const mutation: FilesystemMutation = { paths: unique, sourceTabId, sequence: ++sequence };
  for (const listener of listeners) listener(mutation);
}

export function subscribeFilesystemMutations(listener: MutationListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
