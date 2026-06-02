// Decode the raw Windows file-attribute bitmask (NodeRecord.attributes,
// FILE_ATTRIBUTE_*) into compact letters (table column) or full labels (Details
// pane). The scanner always carries the bitmask on Windows; we also OR in the
// legacy hidden/readonly/link bools so attributes still render for nodes from
// an older cached scan (or non-Windows) where the bitmask is 0.

export interface AttrNode {
  attributes?: number;
  hidden?: boolean;
  readonly?: boolean;
  link?: boolean;
}

const FILE_ATTRIBUTE = {
  READONLY: 0x0000_0001,
  HIDDEN: 0x0000_0002,
  SYSTEM: 0x0000_0004,
  ARCHIVE: 0x0000_0020,
  TEMPORARY: 0x0000_0100,
  SPARSE_FILE: 0x0000_0200,
  REPARSE_POINT: 0x0000_0400,
  COMPRESSED: 0x0000_0800,
  OFFLINE: 0x0000_1000,
  ENCRYPTED: 0x0000_4000,
} as const;

// Display order (most-useful first). Each entry: bit mask, one-letter tag, label.
const FLAGS: { mask: number; letter: string; label: string }[] = [
  { mask: FILE_ATTRIBUTE.HIDDEN, letter: "H", label: "Hidden" },
  { mask: FILE_ATTRIBUTE.READONLY, letter: "R", label: "Read-only" },
  { mask: FILE_ATTRIBUTE.SYSTEM, letter: "S", label: "System" },
  { mask: FILE_ATTRIBUTE.ARCHIVE, letter: "A", label: "Archive" },
  { mask: FILE_ATTRIBUTE.COMPRESSED, letter: "C", label: "Compressed" },
  { mask: FILE_ATTRIBUTE.ENCRYPTED, letter: "E", label: "Encrypted" },
  { mask: FILE_ATTRIBUTE.TEMPORARY, letter: "T", label: "Temporary" },
  { mask: FILE_ATTRIBUTE.OFFLINE, letter: "O", label: "Offline" },
  { mask: FILE_ATTRIBUTE.SPARSE_FILE, letter: "P", label: "Sparse" },
  { mask: FILE_ATTRIBUTE.REPARSE_POINT, letter: "L", label: "Reparse point / link" },
];

function effectiveMask(node: AttrNode): number {
  let mask = node.attributes ?? 0;
  if (node.readonly) mask |= FILE_ATTRIBUTE.READONLY;
  if (node.hidden) mask |= FILE_ATTRIBUTE.HIDDEN;
  if (node.link) mask |= FILE_ATTRIBUTE.REPARSE_POINT;
  return mask;
}

/** Compact letters for the Attributes column, e.g. "HSA" (or "—" when none). */
export function attributeLetters(node: AttrNode): string {
  const mask = effectiveMask(node);
  const letters = FLAGS.filter((f) => (mask & f.mask) !== 0).map((f) => f.letter).join("");
  return letters || "—";
}

/** Full attribute labels for the Details pane, e.g. ["Hidden", "System"]. */
export function attributeList(node: AttrNode): string[] {
  const mask = effectiveMask(node);
  return FLAGS.filter((f) => (mask & f.mask) !== 0).map((f) => f.label);
}
