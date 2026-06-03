// Tag editing popover (F4).
//
// A small floating editor anchored at the click point that adds/removes tags
// and picks a color label for a single path. Changes are applied immediately
// (each discrete add/remove/color action) through onApply so the persistent
// store and the row badge update live. Closes on Escape or an outside click.

import { useEffect, useRef, useState } from "react";
import type { TagEntry } from "../api/types";
import { Icon } from "./Icon";

export interface TagPopoverProps {
  path: string;
  x: number;
  y: number;
  entry: TagEntry | undefined;
  /** Persist the new tag set + color for `path` (full-list replace happens upstream). */
  onApply: (path: string, tags: string[], color?: string) => void;
  onClose: () => void;
}

// A compact, readable palette of label colors (VS Code / GitHub label vibes).
const SWATCHES = [
  "#e06c75", "#e5a04c", "#e6d24c", "#98c379", "#56b6c2",
  "#61afef", "#c678dd", "#ff79c6", "#888888",
];

export function TagPopover({ path, x, y, entry, onApply, onClose }: TagPopoverProps) {
  const [tags, setTags] = useState<string[]>(entry?.tags ?? []);
  const [color, setColor] = useState<string | undefined>(entry?.color);
  const [input, setInput] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey, true);
    // Defer the outside-click listener a tick so the opening click doesn't close it.
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDown, true), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.clearTimeout(t);
    };
  }, [onClose]);

  const apply = (nextTags: string[], nextColor: string | undefined) => {
    setTags(nextTags);
    setColor(nextColor);
    onApply(path, nextTags, nextColor);
  };

  const addTag = () => {
    const v = input.trim();
    if (!v) return;
    if (!tags.some((t) => t.toLowerCase() === v.toLowerCase())) apply([...tags, v], color);
    setInput("");
  };
  const removeTag = (t: string) => apply(tags.filter((x) => x !== t), color);
  const pickColor = (c: string | undefined) => apply(tags, c);

  // Clamp the popover to the viewport (≈ 250×220 box).
  const left = Math.min(x, window.innerWidth - 260);
  const top = Math.min(y, window.innerHeight - 230);

  return (
    <div ref={ref} className="tag-popover" style={{ left: Math.max(8, left), top: Math.max(8, top) }} role="dialog" aria-label="Edit tags">
      <div className="tag-pop-head">
        <Icon name="tag" size={12} />
        <span className="tag-pop-name" title={path}>{path.split(/[\\/]/).filter(Boolean).pop() || path}</span>
        <button className="tag-pop-close" title="Close" onClick={onClose}><Icon name="x" size={11} /></button>
      </div>

      <div className="tag-pop-chips">
        {tags.length === 0 && <span className="tag-pop-empty">No tags yet</span>}
        {tags.map((t) => (
          <span className="tag-chip" key={t}>
            {t}
            <button className="tag-chip-x" title="Remove" onClick={() => removeTag(t)}><Icon name="x" size={9} /></button>
          </span>
        ))}
      </div>

      <input
        className="tag-pop-input"
        value={input}
        autoFocus
        spellCheck={false}
        placeholder="Add a tag, then Enter"
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); }
        }}
      />

      <div className="tag-pop-colors">
        <button
          className={`tag-swatch tag-swatch-none${!color ? " active" : ""}`}
          title="No color"
          onClick={() => pickColor(undefined)}
        ><Icon name="x" size={10} /></button>
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={`tag-swatch${color === c ? " active" : ""}`}
            style={{ background: c }}
            title={c}
            onClick={() => pickColor(c)}
          />
        ))}
      </div>
    </div>
  );
}
