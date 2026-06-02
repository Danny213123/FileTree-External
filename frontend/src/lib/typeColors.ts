// Semantic color encoding shared by the Reports tabs (Extensions / Age / Owner)
// and the ranked lists (Top Files / Largest Folders). Colors are chosen at a
// medium lightness/saturation so each bar stays legible on BOTH the light
// (~#e8e8e8) and dark (~#2a2a2a) bar-track backgrounds without per-theme tweaks.

export type FileCategory =
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "document"
  | "executable"
  | "font"
  | "data"
  | "other";

// One distinct hue per file-type family. Kept mid-tone so white/colored fills
// read on either theme's track.
export const CATEGORY_COLOR: Record<FileCategory, string> = {
  image: "#2e9e5b",      // green
  video: "#5b6ee0",      // indigo
  audio: "#d6336c",      // pink
  archive: "#11998e",    // teal
  code: "#d99e1e",       // amber
  document: "#2b82c9",   // blue
  executable: "#e0701a", // orange
  font: "#8b3fd8",       // violet
  data: "#1ba0b3",       // cyan
  other: "#7a8696",      // slate
};

// Folder accent for the Largest Folders ranked list (echoes the folder icon's
// warm gold). Exported so both the bar fill and any folder swatch can match.
export const FOLDER_COLOR = "#e0a23a";

const EXT_CATEGORY: Record<string, FileCategory> = {};
const register = (cat: FileCategory, exts: string[]) => {
  for (const e of exts) EXT_CATEGORY[e] = cat;
};

register("image", ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "tiff", "tif", "raw", "heic", "heif", "psd", "ai"]);
register("video", ["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv", "mpg", "mpeg", "3gp", "ts"]);
register("audio", ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff", "mid", "midi"]);
register("archive", ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab", "tgz", "zst"]);
register("code", ["js", "jsx", "ts", "tsx", "py", "rb", "php", "rs", "c", "cpp", "cc", "h", "hpp", "go", "java", "cs", "kt", "swift", "html", "htm", "css", "scss", "less", "json", "xml", "yaml", "yml", "sh", "bat", "cmd", "ps1", "lua", "r"]);
register("document", ["doc", "docx", "rtf", "odt", "pdf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "txt", "md", "log", "tex", "epub"]);
register("executable", ["exe", "msi", "dll", "sys", "so", "dylib", "app", "deb", "rpm", "appimage"]);
register("font", ["ttf", "otf", "woff", "woff2", "eot", "fon"]);
register("data", ["db", "sqlite", "sqlite3", "sql", "mdb", "accdb", "parquet", "dat", "bak"]);

/** Normalize a raw extension (may include a leading dot / casing) and map it to
 *  its file-type category. Unknown / empty extensions fall back to "other". */
export function categoryForExt(ext: string | null | undefined): FileCategory {
  if (!ext) return "other";
  const key = ext.trim().toLowerCase().replace(/^\.+/, "");
  if (!key) return "other";
  return EXT_CATEGORY[key] ?? "other";
}

/** Bar color for a file extension, via its category. */
export function colorForExt(ext: string | null | undefined): string {
  return CATEGORY_COLOR[categoryForExt(ext)];
}

// Fixed new→old gradient for the analytics age buckets the backend emits
// ("7 days" … "older"), plus a neutral gray for the catch-all "unknown" bucket.
const AGE_COLOR: Record<string, string> = {
  "7 days": "#3fa45b",  // freshest — green
  "30 days": "#8fb13a", // lime
  "90 days": "#d6a429", // amber
  "1 year": "#e07b2e",  // orange
  older: "#d6493b",     // oldest — red
  unknown: "#8a94a6",   // gray
};

/** Color for an age bucket. Known backend labels map to a fixed new→old ramp;
 *  any other label falls back to an index-based green→red interpolation. */
export function ageColor(label: string, index = 0, total = 1): string {
  const fixed = AGE_COLOR[label.trim().toLowerCase()];
  if (fixed) return fixed;
  const t = total > 1 ? index / (total - 1) : 0;
  const hue = Math.round(145 - t * 137); // 145 (green) → 8 (red)
  return `hsl(${hue}, 60%, 45%)`;
}

/** Stable per-owner color from a hashed hue, so the same owner always gets the
 *  same swatch across renders/scans. Fixed saturation/lightness keep it on-theme. */
export function ownerColor(owner: string): string {
  let hash = 0;
  for (let i = 0; i < owner.length; i++) {
    hash = (hash * 31 + owner.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 52%, 50%)`;
}
