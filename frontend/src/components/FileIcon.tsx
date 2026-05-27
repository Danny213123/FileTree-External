import { useState } from "react";

// Module-level: tracks extensions whose shell icon fetch failed.
// Persists across virtualizer component recreation so all rows for the same
// extension consistently show the same badge fallback (never a mix of icon+badge).
const ICON_FAILED = new Set<string>();

// Fallback badge colors used when the shell icon fails or is still loading.
const EXT_COLOR: Record<string, string> = {
  exe: "#e06820", msi: "#5b7fe0", dll: "#a05020", sys: "#a05020",
  bat: "#8b4513", cmd: "#8b4513", ps1: "#5b3fa0", sh: "#5b7060",
  zip: "#5b8080", rar: "#5b8080", "7z": "#5b8080",
  tar: "#8b5e3c", gz: "#8b5e3c", bz2: "#8b5e3c", xz: "#8b5e3c",
  doc: "#2b5eb0", docx: "#2b5eb0", rtf: "#2b5eb0", odt: "#2b5eb0",
  xls: "#217346", xlsx: "#217346", csv: "#217346",
  ppt: "#c55a11", pptx: "#c55a11",
  pdf: "#c0392b",
  jpg: "#2e8b57", jpeg: "#2e8b57", png: "#2e8b57", gif: "#2e8b57",
  webp: "#2e8b57", bmp: "#2e8b57", svg: "#2e8b57", ico: "#2e8b57",
  tiff: "#2e8b57", tif: "#2e8b57", raw: "#2e8b57", heic: "#2e8b57",
  mp4: "#7030a0", mkv: "#7030a0", mov: "#7030a0", avi: "#7030a0",
  wmv: "#7030a0", webm: "#7030a0", m4v: "#7030a0",
  mp3: "#c2185b", wav: "#c2185b", flac: "#c2185b", aac: "#c2185b",
  ogg: "#c2185b", m4a: "#c2185b",
  js: "#c8a000", jsx: "#c8a000", ts: "#235a9e", tsx: "#235a9e",
  py: "#2980b9", rb: "#cc342d", php: "#6c5eb5",
  rs: "#de4f00", c: "#3a5f8a", cpp: "#3a5f8a", go: "#00acd7",
  html: "#e34c26", htm: "#e34c26", xml: "#f0803c",
  json: "#b07c37", yaml: "#b07c37", yml: "#b07c37",
  md: "#607080", txt: "#708090", log: "#607080",
  db: "#1a7870", sqlite: "#1a7870", sql: "#1a7870",
  ttf: "#8b5cf6", otf: "#8b5cf6", woff: "#8b5cf6", woff2: "#8b5cf6",
  psd: "#31a8ff", ai: "#ff7c00", drawio: "#f08705",
  ini: "#607080", cfg: "#607080", env: "#3d7a3d",
};

function badgeLabel(ext: string): string {
  const up = ext.toUpperCase();
  return up.length <= 4 ? up : up.slice(0, 4);
}

interface FileIconProps {
  ext: string;
  isDir: boolean;
  isBundle: boolean;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
}

export function FileIcon({ ext, isDir, isBundle, onMouseEnter, onMouseLeave }: FileIconProps) {
  const lext = ext.toLowerCase();
  // Initialize from ICON_FAILED so all instances for the same extension agree,
  // but still use useState so a fresh app load can retry after a transient failure.
  const [imgFailed, setImgFailed] = useState(() => ICON_FAILED.has(lext));

  if (isBundle) {
    return <span className="kind kind-bundle">≡</span>;
  }

  if (isDir) {
    return (
      <span
        className="kind kind-dir"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />
    );
  }

  // Try to load the real Windows shell icon; fall back to colored badge on error
  if (lext && !imgFailed) {
    return (
      <span
        className="kind"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <img
          className="kind-shell-icon"
          src={`/api/file-icon?ext=${encodeURIComponent(lext)}`}
          width={16}
          height={16}
          alt=""
          draggable={false}
          onError={() => { ICON_FAILED.add(lext); setImgFailed(true); }}
        />
      </span>
    );
  }

  // Fallback badge (used on non-Windows serve mode or if icon fetch failed)
  const color = EXT_COLOR[lext] ?? "#708090";
  const label = lext ? badgeLabel(lext) : "···";
  return (
    <span
      className="kind kind-file-badge"
      style={{ "--badge-color": color } as React.CSSProperties}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {label}
    </span>
  );
}
