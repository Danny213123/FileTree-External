// Shared "risk-scoped" confirmation gate (Phase 4).
//
// Philosophy: balanced friction. Frequent, low-risk, recoverable operations
// must stay frictionless (NO prompt) — e.g. an ordinary same-drive move, or a
// small delete that goes to the Recycle Bin. We prompt ONLY for the genuinely
// risky cases:
//
//   • permanent (non-recyclable) delete            — irreversible
//   • cross-drive move                             — copy + delete originals
//   • large batches  (> LARGE_BYTES total)         — slow / heavy, easy to misfire
//   • many items     (> MANY_ITEMS)                — easy to misfire
//
// Overwrite/replace already has its own explicit dialog (the conflict prompt /
// the native Windows collision dialog), so it is not re-confirmed here.
//
// `confirmRisky` returns true to proceed. When the operation isn't risky it
// returns true WITHOUT prompting.

/** Tunable risk thresholds. Centralized so the policy is easy to find + adjust. */
export const RISK_THRESHOLDS = {
  /** Batches with MORE than this many items are treated as risky. */
  MANY_ITEMS: 50,
  /** Batches whose total size EXCEEDS this (in bytes) are risky. Default ~1 GB. */
  LARGE_BYTES: 1024 * 1024 * 1024,
} as const;

export type RiskKind = "delete" | "move" | "copy";

export interface RiskInput {
  kind: RiskKind;
  /** Delete only: a permanent (non-Recycle-Bin) delete. */
  permanent?: boolean;
  /** Move only: the move crosses drives/volumes (copy-then-delete originals). */
  crossDrive?: boolean;
  /** Number of top-level items in the batch. */
  itemCount: number;
  /** Best-effort total size of the batch in bytes (0/undefined if unknown). */
  totalBytes?: number;
  /** Item names, used only to make the prompt friendlier. */
  names?: string[];
}

/**
 * Decide whether `input` is risky enough to confirm, and if so prompt the user.
 * Returns true to proceed (either not risky, or the user confirmed).
 */
export function confirmRisky(input: RiskInput): boolean {
  if (input.itemCount <= 0) return true;
  if (!isRisky(input)) return true; // frictionless path
  return window.confirm(buildMessage(input));
}

/** True when the operation trips any risk rule. Exposed for callers that want
 *  to branch without prompting (e.g. logging/telemetry). */
export function isRisky(input: RiskInput): boolean {
  const many = input.itemCount > RISK_THRESHOLDS.MANY_ITEMS;
  const large = (input.totalBytes ?? 0) > RISK_THRESHOLDS.LARGE_BYTES;
  if (input.kind === "delete" && input.permanent) return true;
  if (input.kind === "move" && input.crossDrive) return true;
  // Copy is additive (never removes the source), so crossing drives isn't itself
  // risky — only a large/many batch is worth confirming.
  return many || large;
}

/** The Windows drive/volume key for a path: "C:" for a drive letter,
 *  "\\server\share" for a UNC root, or "" when it can't be determined. */
export function driveOf(path: string): string {
  const letter = /^([a-zA-Z]):/.exec(path);
  if (letter) return `${letter[1].toUpperCase()}:`;
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(path);
  if (unc) return unc[0].toLowerCase();
  return "";
}

/** True when any source lives on a different drive/volume than `destination`. */
export function isCrossDrive(sources: string[], destination: string): boolean {
  const dest = driveOf(destination);
  if (!dest) return false;
  return sources.some((source) => {
    const drive = driveOf(source);
    return drive !== "" && drive !== dest;
  });
}

function buildMessage(input: RiskInput): string {
  const subject = describeSubject(input);
  if (input.kind === "delete") {
    if (input.permanent) {
      return `Permanently delete ${subject}?\n\nThis CANNOT be undone — the items will NOT go to the Recycle Bin.`;
    }
    return `Move ${subject} to the Recycle Bin?`;
  }
  if (input.kind === "copy") {
    return `Copy ${subject}?`;
  }
  // move
  if (input.crossDrive) {
    return `Move ${subject} to another drive?\n\nThe items are copied to the new drive and the originals are then removed.`;
  }
  return `Move ${subject}?`;
}

function describeSubject(input: RiskInput): string {
  const { itemCount, names } = input;
  const noun =
    itemCount === 1
      ? names && names[0]
        ? `"${names[0]}"`
        : "1 item"
      : `${itemCount} items`;
  const size = formatBytes(input.totalBytes ?? 0);
  return size ? `${noun} (${size})` : noun;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`;
}
