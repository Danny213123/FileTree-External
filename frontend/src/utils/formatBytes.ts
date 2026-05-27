import type { Unit } from "../api/types";

export function formatBytes(bytes: number, unit: Unit = "auto", decimals?: number): string {
  const tb = bytes / (1024 * 1024 * 1024 * 1024);
  const gb = bytes / (1024 * 1024 * 1024);
  const mb = bytes / (1024 * 1024);
  const kb = bytes / 1024;

  const fmt = (n: number, defaultDec: number, suffix: string) => {
    const d = decimals ?? defaultDec;
    return `${n.toFixed(d)} ${suffix}`;
  };

  if (unit === "bytes") {
    return decimals != null ? `${bytes.toFixed(decimals)} B` : `${bytes.toLocaleString()} B`;
  }
  if (unit === "tb") return fmt(tb, 2, "TB");
  if (unit === "gb") return fmt(gb, 2, "GB");
  if (unit === "mb") return fmt(mb, 1, "MB");
  if (unit === "kb") return fmt(kb, 0, "KB");
  // auto
  if (tb >= 1) return fmt(tb, 2, "TB");
  if (gb >= 1) return fmt(gb, 2, "GB");
  if (mb >= 1) return fmt(mb, 1, "MB");
  if (kb >= 1) return fmt(kb, 0, "KB");
  return `${bytes} B`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}
