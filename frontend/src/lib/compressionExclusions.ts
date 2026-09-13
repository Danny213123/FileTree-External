const KEY = "filetree.compression.exclusions.v1";
export const compressionPathKey = (path: string) => path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function loadCompressionExclusions(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" && !!path.trim()) : [];
  } catch { return []; }
}
export function saveCompressionExclusions(paths: string[]): void {
  localStorage.setItem(KEY, JSON.stringify(paths));
  window.dispatchEvent(new Event("compression-exclusions-changed"));
}
export function isCompressionExcluded(path: string, exclusions: string[]): boolean {
  const key = compressionPathKey(path);
  return exclusions.some((rule) => {
    const root = compressionPathKey(rule);
    return !!root && (key === root || key.startsWith(`${root}/`));
  });
}
