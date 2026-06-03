// Command palette (F6).
//
// A modal overlay with two modes, VS Code-style:
//   • File mode    (Ctrl+P)        — substring match over the focused tab's
//                                    nodeById via searchNodes; Enter reveals the
//                                    file/folder in the tree (onNavigateFile).
//   • Command mode (Ctrl+Shift+P)  — fuzzy filter over a curated action list
//                                    supplied by App; Enter runs the action.
//
// Typing ">" as the first character switches to command mode (and stripping it
// returns to file mode), so one palette serves both. Arrow keys move the active
// row, Enter runs it, Escape closes. The list is capped so a huge scan can't
// render thousands of rows.

import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeRecord } from "../api/types";
import { searchNodes } from "../lib/search";
import { FileIcon } from "./FileIcon";
import { Icon } from "./Icon";

export interface PaletteCommand {
  id: string;
  title: string;
  /** Right-aligned hint (keybinding or category). */
  hint?: string;
  /** Bumps the item up the list (e.g. frequently-used actions). */
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  /** "files" (Ctrl+P) starts blank; "commands" (Ctrl+Shift+P) starts with ">". */
  initialMode: "files" | "commands";
  commands: PaletteCommand[];
  /** Focused tab's node map for file-jump matching. */
  nodeById: Map<number, NodeRecord>;
  /** Reveal/select a node by id in the focused pane. */
  onNavigateFile: (id: number) => void;
  onClose: () => void;
}

const FILE_LIMIT = 200;

/** Subsequence fuzzy score: higher is better, -1 when `q` isn't a subsequence of
 *  `text`. Rewards contiguous + word-start matches so "ea" ranks "Expand All"
 *  above incidental hits. Case-insensitive; an empty query matches everything. */
function fuzzyScore(text: string, q: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  let prevWasSep = true;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === c) { found = i; break; }
    }
    if (found === -1) return -1;
    const sep = found > 0 && /[\s\-_./\\]/.test(t[found - 1]);
    if (found === ti) { streak++; score += 2 + streak; }
    else { streak = 0; score += 1; }
    if (sep || (found === 0)) score += 4; // word-start bonus
    ti = found + 1;
    prevWasSep = sep;
  }
  void prevWasSep;
  // Prefer shorter targets when scores tie (less padding around the match).
  return score - t.length * 0.02;
}

interface Row {
  key: string;
  title: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({ initialMode, commands, nodeById, onNavigateFile, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialMode === "commands" ? ">" : "");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commandMode = query.startsWith(">");
  const term = (commandMode ? query.slice(1) : query).trim();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const rows = useMemo<Row[]>(() => {
    if (commandMode) {
      const scored = commands
        .map((c) => ({ c, s: fuzzyScore(`${c.title} ${c.keywords ?? ""}`, term.toLowerCase()) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s);
      return scored.map(({ c }) => ({
        key: `c:${c.id}`,
        title: c.title,
        hint: c.hint,
        icon: <Icon name="chevron-right" size={12} />,
        run: c.run,
      }));
    }
    if (term.length < 2) return [];
    const nodes = searchNodes(nodeById, term, "size", -1, FILE_LIMIT);
    return nodes.map((n) => ({
      key: `f:${n.id}`,
      title: n.name,
      hint: n.path,
      icon: <FileIcon ext={n.extension ?? ""} isDir={n.dir} isBundle={false} />,
      run: () => onNavigateFile(n.id),
    }));
  }, [commandMode, commands, term, nodeById, onNavigateFile]);

  // Clamp the active row whenever the result set shrinks.
  useEffect(() => { setActive((a) => (rows.length === 0 ? 0 : Math.min(a, rows.length - 1))); }, [rows.length]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    const row = rows[i];
    if (!row) return;
    onClose();
    // Defer so the overlay is gone before navigation/view changes paint.
    window.setTimeout(() => row.run(), 0);
  };

  return (
    <div className="cmdk-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-row">
          <span className="cmdk-mode-ico">
            <Icon name={commandMode ? "terminal" : "search"} size={14} />
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            value={query}
            spellCheck={false}
            placeholder={commandMode ? "Type a command…" : "Go to file… (type > for commands)"}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); choose(active); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
          />
        </div>
        <div className="cmdk-list" ref={listRef}>
          {rows.length === 0 ? (
            <div className="cmdk-empty">
              {commandMode
                ? "No matching commands."
                : term.length < 2
                  ? "Type at least 2 characters to find a file."
                  : "No matching files in this scan."}
            </div>
          ) : (
            rows.map((row, i) => (
              <button
                key={row.key}
                data-row={i}
                className={`cmdk-row${i === active ? " active" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(i)}
                title={row.hint}
              >
                <span className="cmdk-row-ico">{row.icon}</span>
                <span className="cmdk-row-title">{row.title}</span>
                {row.hint && <span className="cmdk-row-hint">{row.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
