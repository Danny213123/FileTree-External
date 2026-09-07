// Drive / folder picker used by every side-bar view (Explorer, Compress,
// Duplicates). The trigger reads as one row of the side bar; the popup is a
// browsable tree so a target can be reached without ever typing a path:
// drives, quick-access folders, bookmarks and recent scans are roots, and any
// row can be expanded in place with immediate subfolders from the backend.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { browseDirectories, type BrowseDirectoryEntry } from "../api/client";
import type { DriveEntry, SpecialFolder } from "../api/types";
import { localRect, localViewport } from "../lib/overlay";
import { Icon, type IconName } from "./Icon";

/** Subfolders rendered per expansion before the list is truncated. */
const CHILDREN_SHOWN = 400;
/** Popup never renders narrower than this, however narrow the side bar is. */
const MIN_MENU_W = 300;
const MAX_MENU_H = 420;
/** Gap kept between the popup and the anchor / viewport edges. */
const GAP = 4;

/** Case- and separator-insensitive identity for a path, so `c:/x` === `C:\X\`. */
function keyOf(path: string): string {
  return path.replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
}

function isDriveRoot(path: string): boolean {
  return /^[a-z]:[\\/]?$/i.test(path.trim());
}

/** Splits a path into the label shown in bold and its muted parent. */
export function splitPath(path: string): { name: string; parent: string } {
  const trimmed = path.trim();
  if (!trimmed) return { name: "", parent: "" };
  if (isDriveRoot(trimmed)) return { name: trimmed.replace(/[\\/]+$/, "\\"), parent: "" };
  const parts = trimmed.replace(/[\\/]+$/, "").split(/[\\/]/);
  const name = parts.pop() ?? trimmed;
  const parent = parts.join("\\");
  // A bare drive letter only reads as a path with its separator.
  return { name, parent: /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent };
}

/**
 * Shortens a parent path to its last few segments. Eliding in CSS would have to
 * cut the informative tail, or reorder the punctuation with `direction: rtl`,
 * so it is done here instead.
 */
export function shortenParent(parent: string, keep = 2): string {
  const parts = parent.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return parent;
  return `…\\${parts.slice(-keep).join("\\")}`;
}

function formatFree(drive: DriveEntry): string {
  if (drive.total <= 0) return "";
  const size = (n: number) => {
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(0)} GB`;
    return `${(n / 1e6).toFixed(0)} MB`;
  };
  return `${size(drive.free)} free`;
}

/** A root offered by the popup before the user drills into anything. */
interface RootEntry {
  path: string;
  label: string;
  detail: string;
  icon: IconName;
  /** Roots are grouped under these headings, in this order. */
  group: "Drives" | "Quick access" | "Bookmarks" | "Recent";
  /** Fraction of the volume in use — renders a hairline meter when present. */
  used?: number;
}

type ChildList =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: BrowseDirectoryEntry[] };

/** One rendered line: a pickable folder, a group heading, or a status note. */
type Row =
  | {
      type: "dir";
      key: string;
      path: string;
      label: string;
      detail: string;
      icon: IconName;
      depth: number;
      used?: number;
    }
  | { type: "group"; key: string; label: string }
  | { type: "note"; key: string; depth: number; text: string; tone?: "error" };

export interface PathPickerProps {
  /** Currently targeted path. Empty renders the placeholder. */
  value: string;
  /** Fired when a different path is chosen (typed or picked). */
  onChange: (path: string) => void;
  /** Fired when the user picks a row or presses Enter — run the action here. */
  onCommit?: (path: string) => void;
  drives: DriveEntry[];
  specialFolders: SpecialFolder[];
  bookmarks?: string[];
  recent?: string[];
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}

export function PathPicker({
  value,
  onChange,
  onCommit,
  drives,
  specialFolders,
  bookmarks = [],
  recent = [],
  disabled = false,
  placeholder = "Choose a drive or folder…",
  ariaLabel = "Drive or folder to scan",
}: PathPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Survives a collapse so re-expanding a branch doesn't re-hit the filesystem.
  const [childLists, setChildLists] = useState<Map<string, ChildList>>(new Map());
  // Paths already sent to the backend, so re-expanding never re-fetches.
  const requestedRef = useRef<Set<string>>(new Set());

  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const roots = useMemo<RootEntry[]>(() => {
    const out: RootEntry[] = drives.map((drive) => ({
      path: drive.root,
      label: drive.label
        ? `${drive.root.replace(/[\\/]+$/, "")} ${drive.label}`
        : drive.root,
      detail: formatFree(drive),
      icon: "hdd",
      group: "Drives",
      used: drive.total > 0 ? (drive.total - drive.free) / drive.total : undefined,
    }));
    for (const folder of specialFolders) {
      out.push({
        path: folder.path,
        label: folder.label,
        detail: "",
        icon: "folder",
        group: "Quick access",
      });
    }
    const seen = new Set(out.map((entry) => keyOf(entry.path)));
    for (const path of bookmarks) {
      if (seen.has(keyOf(path))) continue;
      seen.add(keyOf(path));
      const { name, parent } = splitPath(path);
      out.push({
        path,
        label: name,
        detail: shortenParent(parent),
        icon: "star-fill",
        group: "Bookmarks",
      });
    }
    for (const path of recent) {
      if (seen.has(keyOf(path))) continue;
      seen.add(keyOf(path));
      const { name, parent } = splitPath(path);
      out.push({
        path,
        label: name,
        detail: shortenParent(parent),
        icon: "clock-history",
        group: "Recent",
      });
    }
    return out;
  }, [bookmarks, drives, recent, specialFolders]);

  const loadChildren = useCallback(async (path: string) => {
    const key = keyOf(path);
    setChildLists((prev) => new Map(prev).set(key, { status: "loading" }));
    try {
      const entries = await browseDirectories(path);
      setChildLists((prev) => new Map(prev).set(key, { status: "ready", entries }));
    } catch (error) {
      setChildLists((prev) => new Map(prev).set(key, {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const toggleExpand = useCallback((path: string) => {
    const key = keyOf(path);
    const opening = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(key); else next.delete(key);
      return next;
    });
    if (opening && !requestedRef.current.has(key)) {
      requestedRef.current.add(key);
      void loadChildren(path);
    }
  }, [expanded, loadChildren]);

  // The typed text is treated as a path (not a filter) as soon as it carries a
  // separator or a drive colon, so pasting `D:\media` still works.
  const query = filter.trim();
  const typedIsPath = query.length > 0 && /[\\/]|^[a-z]:$/i.test(query);
  const filtering = query.length > 0 && !typedIsPath;

  const rows = useMemo<Row[]>(() => {
    const needle = query.toLowerCase();
    const out: Row[] = [];

    // While filtering, the tree flattens into a single list: nesting is noise
    // when the user is narrowing by name.
    if (filtering) {
      const matches = roots.filter(
        (root) =>
          root.label.toLowerCase().includes(needle) ||
          root.path.toLowerCase().includes(needle),
      );
      for (const list of childLists.values()) {
        if (list.status !== "ready") continue;
        for (const entry of list.entries) {
          if (!entry.name.toLowerCase().includes(needle)) continue;
          if (matches.some((match) => keyOf(match.path) === keyOf(entry.path))) continue;
          const { parent } = splitPath(entry.path);
          matches.push({
            path: entry.path,
            label: entry.name,
            detail: shortenParent(parent),
            icon: "folder",
            group: "Quick access",
          });
        }
      }
      for (const match of matches.slice(0, 60)) {
        out.push({
          type: "dir",
          key: keyOf(match.path),
          path: match.path,
          label: match.label,
          detail: match.detail,
          icon: match.icon,
          depth: 0,
          used: match.used,
        });
      }
      if (out.length === 0) {
        out.push({ type: "note", key: "no-match", depth: 0, text: "No matching folder" });
      }
      return out;
    }

    const walk = (path: string, depth: number) => {
      const key = keyOf(path);
      if (!expanded.has(key)) return;
      const list = childLists.get(key);
      if (!list || list.status === "loading") {
        out.push({ type: "note", key: `${key}|loading`, depth, text: "Reading folder…" });
        return;
      }
      if (list.status === "error") {
        out.push({ type: "note", key: `${key}|error`, depth, text: list.message, tone: "error" });
        return;
      }
      if (list.entries.length === 0) {
        out.push({ type: "note", key: `${key}|empty`, depth, text: "No subfolders" });
        return;
      }
      for (const entry of list.entries.slice(0, CHILDREN_SHOWN)) {
        out.push({
          type: "dir",
          key: keyOf(entry.path),
          path: entry.path,
          label: entry.name,
          detail: "",
          icon: "folder",
          depth,
        });
        walk(entry.path, depth + 1);
      }
      if (list.entries.length > CHILDREN_SHOWN) {
        const hidden = list.entries.length - CHILDREN_SHOWN;
        out.push({
          type: "note",
          key: `${key}|more`,
          depth,
          text: `${hidden.toLocaleString()} more folders not shown — type to filter`,
        });
      }
    };

    let group: RootEntry["group"] | null = null;
    for (const root of roots) {
      if (root.group !== group) {
        group = root.group;
        out.push({ type: "group", key: `group|${group}`, label: group });
      }
      out.push({
        type: "dir",
        key: keyOf(root.path),
        path: root.path,
        label: root.label,
        detail: root.detail,
        icon: root.icon,
        depth: 0,
        used: root.used,
      });
      walk(root.path, 1);
    }
    return out;
  }, [childLists, expanded, filtering, query, roots]);

  // Index of every pickable row, for keyboard traversal.
  const pickable = useMemo(
    () => rows.flatMap((row, index) => (row.type === "dir" ? [index] : [])),
    [rows],
  );

  const commit = useCallback((path: string) => {
    const next = path.trim();
    if (!next) return;
    onChange(next);
    setOpen(false);
    setFilter("");
    onCommit?.(next);
  }, [onChange, onCommit]);

  // ── Popup placement ──────────────────────────────────────────────────────
  // Anchored under the trigger, matched to its width, flipped above when the
  // bottom of the viewport is closer than the menu is tall.
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      // Local (zoom-relative) space, so the result can be used as an inline
      // length under the UI-scale zoom on <body>. See lib/overlay.ts.
      const rect = localRect(anchor);
      const view = localViewport();
      const width = Math.max(rect.width, MIN_MENU_W);
      const below = view.height - rect.bottom - GAP * 2;
      const above = rect.top - GAP * 2;
      const flip = below < Math.min(MAX_MENU_H, 240) && above > below;
      const maxHeight = Math.max(160, Math.min(MAX_MENU_H, flip ? above : below));
      setPos({
        top: flip ? Math.max(GAP, rect.top - maxHeight - GAP) : rect.bottom + GAP,
        left: Math.max(GAP, Math.min(rect.left, view.width - width - GAP)),
        width,
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Dismiss on outside click. Escape is handled on the popup itself so it wins
  // over any dialog-level handler while the menu has focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
      setFilter("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Reset the highlight whenever the visible set changes, and keep it in view.
  useEffect(() => { setActiveIndex(pickable[0] ?? -1); }, [pickable]);
  useEffect(() => {
    if (activeIndex < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`);
    // Optional chained: scrollIntoView is absent under jsdom, and keeping the
    // highlight visible is a nicety rather than a requirement.
    row?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const moveActive = (delta: number) => {
    if (pickable.length === 0) return;
    const current = pickable.indexOf(activeIndex);
    const next = current < 0
      ? (delta > 0 ? 0 : pickable.length - 1)
      : (current + delta + pickable.length) % pickable.length;
    setActiveIndex(pickable[next]);
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const active = activeIndex >= 0 ? rows[activeIndex] : undefined;
    switch (event.key) {
      case "Escape":
        setOpen(false);
        setFilter("");
        anchorRef.current?.focus();
        break;
      case "ArrowDown": moveActive(1); break;
      case "ArrowUp": moveActive(-1); break;
      case "ArrowRight":
        if (active?.type === "dir" && !expanded.has(active.key)) toggleExpand(active.path);
        else return;
        break;
      case "ArrowLeft":
        if (active?.type === "dir" && expanded.has(active.key)) toggleExpand(active.path);
        else return;
        break;
      case "Enter":
        if (typedIsPath) commit(query);
        else if (active?.type === "dir") commit(active.path);
        else return;
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const { name, parent } = splitPath(value);
  const onDriveRoot = isDriveRoot(value);
  const driveLabel = onDriveRoot
    ? drives.find((drive) => keyOf(drive.root) === keyOf(value))?.label
    : undefined;

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className={`sb-picker${open ? " open" : ""}${value ? "" : " empty"}`}
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={value || placeholder}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name={onDriveRoot ? "hdd" : "folder"} size={13} />
        <span className="sb-picker-text">
          {value ? (
            <>
              <span className="sb-picker-name">{name}</span>
              {(driveLabel || parent) && (
                <span className="sb-picker-parent">{driveLabel || shortenParent(parent)}</span>
              )}
            </>
          ) : (
            <span className="sb-picker-name placeholder">{placeholder}</span>
          )}
        </span>
        <Icon name="chevron-down" size={9} className={open ? "flip-y" : undefined} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="sb-picker-menu"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
          onKeyDown={onMenuKeyDown}
        >
          <div className="sb-picker-search">
            <Icon name="search" size={12} />
            <input
              ref={inputRef}
              type="text"
              spellCheck={false}
              value={filter}
              placeholder="Filter folders, or paste a path…"
              aria-label="Filter folders or enter a path"
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter && (
              <button
                type="button"
                className="sb-picker-clear"
                aria-label="Clear filter"
                onClick={() => setFilter("")}
              >
                <Icon name="x" size={10} />
              </button>
            )}
          </div>

          {typedIsPath && (
            <button type="button" className="sb-picker-use" onClick={() => commit(query)}>
              <Icon name="folder-open" size={13} />
              <span className="sb-picker-use-text">Use “{query}”</span>
              <kbd>Enter</kbd>
            </button>
          )}

          <div className="sb-picker-list" role="tree" aria-label="Drives and folders" ref={listRef}>
            {rows.map((row, index) => {
              if (row.type === "group") {
                return <div key={row.key} className="sb-picker-group">{row.label}</div>;
              }
              if (row.type === "note") {
                return (
                  <div
                    key={row.key}
                    className={`sb-picker-note${row.tone === "error" ? " error" : ""}`}
                    style={{ paddingLeft: 10 + row.depth * 14 }}
                  >
                    {row.text}
                  </div>
                );
              }
              const isOpen = expanded.has(row.key);
              const isCurrent = keyOf(row.path) === keyOf(value);
              return (
                <div
                  key={row.key}
                  data-row-index={index}
                  role="treeitem"
                  aria-selected={isCurrent}
                  aria-expanded={isOpen}
                  className={[
                    "sb-picker-row",
                    index === activeIndex ? "active" : "",
                    isCurrent ? "current" : "",
                  ].filter(Boolean).join(" ")}
                  title={row.path}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => commit(row.path)}
                >
                  <span className="sb-picker-indent" style={{ width: row.depth * 14 }} aria-hidden="true" />
                  <button
                    type="button"
                    className="sb-picker-twisty"
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${row.label}`}
                    onClick={(event) => { event.stopPropagation(); toggleExpand(row.path); }}
                  >
                    <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={9} />
                  </button>
                  <Icon name={row.icon} size={13} />
                  <span className="sb-picker-label">{row.label}</span>
                  {row.used !== undefined && (
                    <span className="sb-picker-meter" aria-hidden="true">
                      <span
                        className={`sb-picker-meter-fill${row.used > 0.9 ? " crit" : row.used > 0.75 ? " warn" : ""}`}
                        style={{ width: `${Math.round(row.used * 100)}%` }}
                      />
                    </span>
                  )}
                  {row.detail && <span className="sb-picker-detail">{row.detail}</span>}
                  {isCurrent && <Icon name="check" size={11} />}
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
