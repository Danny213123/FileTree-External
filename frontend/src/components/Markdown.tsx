import { Fragment, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";
import type { HighlightResult } from "../lib/highlight";

// Minimal Markdown renderer for assistant output. It builds React nodes directly
// so model text can never inject markup. Covers the subset LLMs actually emit:
// headings, **bold**, *italic*, `inline code`, fenced ``` code blocks (with
// lazy syntax highlighting + a Copy button), links, blockquotes, GFM tables,
// task-list checkboxes, and ordered / unordered lists.
//
// The ONE place markup is injected is the highlighted fenced-code body, which
// uses dangerouslySetInnerHTML on highlight.js output — safe because hljs always
// HTML-escapes the source text and only adds its own <span class="hljs-…"> tags.
export interface MarkdownProps {
  text: string;
  // When provided, absolute Windows paths (in plain text or a `code` span) are
  // rendered as clickable controls that call this with the detected path. Plain
  // http/https/mailto links keep working regardless of this prop.
  onPathClick?: (path: string) => void;
}

export function Markdown({ text, onPathClick }: MarkdownProps) {
  return <div className="md">{renderBlocks(text, { onPathClick })}</div>;
}

interface InlineOpts { onPathClick?: (path: string) => void }

// Absolute Windows path in free text: drive letter + ":\" + a run of path chars
// (stops at whitespace / quotes / redirection chars). A space ends the match, so
// a space-containing path in PLAIN text is only partially linkified — wrap such
// paths in `backticks` (handled separately, where the whole span is one path) to
// make the entire path clickable. Trailing sentence punctuation is trimmed off.
const RE_WIN_PATH = /[A-Za-z]:\\[^\s"'<>|?*]*/g;
const RE_PATH_TRAILING = /[)\].,;:!?'"`]+$/;
// A `code` span is treated as a single clickable path when its whole content is
// an absolute Windows path (spaces allowed — the backticks delimit it).
const RE_FULL_WIN_PATH = /^[A-Za-z]:\\[^\r\n]*$/;

const RE_FENCE = /^```/;
const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^>\s?/;
const RE_UL = /^\s*[-*+]\s+/;
const RE_OL = /^\s*\d+[.)]\s+/;
// A GFM table delimiter row: pipe-separated runs of dashes with optional `:`
// alignment markers, e.g. `| :--- | :---: | ---: |`.
const RE_TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
// A task-list item marker at the start of a list item: `[ ]`, `[x]`, or `[X]`.
const RE_TASK = /^\[([ xX])\]\s+(.*)$/;

function isStructural(line: string): boolean {
  return RE_FENCE.test(line) || RE_HEAD.test(line) || RE_QUOTE.test(line) || RE_UL.test(line) || RE_OL.test(line);
}

function renderBlocks(src: string, opts: InlineOpts = {}): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block → highlighted card with a language label + Copy button.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing fence (if present)
      out.push(<CodeBlock key={key++} code={buf.join("\n")} lang={fence[1]} />);
      continue;
    }

    // GFM table: a header row of `| a | b |` immediately followed by a
    // `| --- | --- |` delimiter row. Parsed defensively; anything that doesn't
    // match the delimiter shape falls through to normal paragraph handling.
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(
        <table key={key++} className="md-table">
          <thead>
            <tr>{header.map((c, j) => <th key={j} style={alignStyle(aligns[j])}>{renderInline(c, opts)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{header.map((_, ci) => <td key={ci} style={alignStyle(aligns[ci])}>{renderInline(r[ci] ?? "", opts)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // Heading → styled div (avoids oversized native h1 and keeps theme control)
    const h = line.match(RE_HEAD);
    if (h) {
      const lvl = h[1].length;
      out.push(<div key={key++} className={`md-h md-h${lvl}`}>{renderInline(h[2], opts)}</div>);
      i++;
      continue;
    }

    // Blockquote
    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { buf.push(lines[i].replace(RE_QUOTE, "")); i++; }
      out.push(<blockquote key={key++} className="md-quote">{renderBlocks(buf.join("\n"), opts)}</blockquote>);
      continue;
    }

    // Unordered list (with GFM task-list checkbox support)
    if (RE_UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_UL.test(lines[i])) { items.push(lines[i].replace(RE_UL, "")); i++; }
      const isTaskList = items.some((it) => RE_TASK.test(it));
      out.push(
        <ul key={key++} className={isTaskList ? "md-ul md-tasklist" : "md-ul"}>
          {items.map((it, j) => {
            const task = it.match(RE_TASK);
            if (task) {
              return (
                <li key={j} className="md-task">
                  <input type="checkbox" checked={task[1] !== " "} disabled readOnly />
                  <span>{renderInline(task[2], opts)}</span>
                </li>
              );
            }
            return <li key={j}>{renderInline(it, opts)}</li>;
          })}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (RE_OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_OL.test(lines[i])) { items.push(lines[i].replace(RE_OL, "")); i++; }
      out.push(<ol key={key++} className="md-ol">{items.map((it, j) => <li key={j}>{renderInline(it, opts)}</li>)}</ol>);
      continue;
    }

    // Blank line
    if (line.trim() === "") { i++; continue; }

    // Paragraph: consume consecutive non-blank, non-structural lines
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isStructural(lines[i])) { buf.push(lines[i]); i++; }
    out.push(<p key={key++} className="md-p">{renderInline(buf.join("\n"), opts)}</p>);
  }

  return out;
}

// Inline formatting: inline code is split out first (so its contents are never
// re-parsed), then — for the remaining text — Windows paths are linkified as the
// OUTERMOST pass (so underscores/dots inside a path can't be eaten by italic/bold
// matching), and finally bold / italic / links are matched in the leftover text.
function renderInline(text: string, opts: InlineOpts = {}): ReactNode[] {
  const out: ReactNode[] = [];
  const counter = { k: 0 };
  const push = (n: ReactNode) => out.push(<Fragment key={counter.k++}>{n}</Fragment>);

  for (const seg of text.split(/(`[^`]+`)/g)) {
    if (seg.length >= 2 && seg.startsWith("`") && seg.endsWith("`")) {
      pushCode(seg.slice(1, -1), push, opts);
    } else if (seg) {
      pushWithPaths(seg, push, opts);
    }
  }
  return out;
}

// A `code` span: clickable when its whole content is an absolute Windows path
// (the model's final-answer format wraps paths in backticks), otherwise plain.
function pushCode(content: string, push: (n: ReactNode) => void, opts: InlineOpts): void {
  const asPath = content.trim();
  const onClick = opts.onPathClick;
  if (onClick && RE_FULL_WIN_PATH.test(asPath)) {
    push(
      <code
        className="md-code md-path"
        role="button"
        tabIndex={0}
        title={`Reveal ${asPath}`}
        onClick={() => onClick(asPath)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(asPath); } }}
      >{content}</code>,
    );
  } else {
    push(<code className="md-code">{content}</code>);
  }
}

// Outermost path pass over a non-code segment: pull out absolute Windows paths as
// clickable links, and hand the text BETWEEN them to the rich (bold/italic/link)
// formatter. Without a reveal handler this is just `formatRich`.
function pushWithPaths(text: string, push: (n: ReactNode) => void, opts: InlineOpts): void {
  const onClick = opts.onPathClick;
  if (!onClick) { formatRich(text, push); return; }
  RE_WIN_PATH.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_WIN_PATH.exec(text))) {
    const path = m[0].replace(RE_PATH_TRAILING, "");
    if (path.length < 3) { RE_WIN_PATH.lastIndex = m.index + m[0].length; continue; }
    if (m.index > last) formatRich(text.slice(last, m.index), push);
    push(
      <a
        className="md-path"
        role="button"
        tabIndex={0}
        title={`Reveal ${path}`}
        onClick={(e) => { e.preventDefault(); onClick(path); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(path); } }}
      >{path}</a>,
    );
    last = m.index + path.length;
    RE_WIN_PATH.lastIndex = last; // resume after the trimmed path (so trailing punctuation is emitted as text)
  }
  if (last < text.length) formatRich(text.slice(last), push);
}

// Only these URL schemes may become real, clickable links in assistant output.
// Everything else (javascript:, data:, file:, vbscript:, blob:, schemeless, …)
// is rendered as inert text so a model can't smuggle a script/navigation payload.
const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

function safeLinkHref(raw: string): string | null {
  // Strip whitespace + control chars first so obfuscated schemes like
  // "java\tscript:" or "  javascript:" can't slip past the allowlist.
  const cleaned = raw.trim().replace(/[\u0000-\u001F\u007F]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!scheme) return null; // schemeless/relative → don't navigate the app frame
  return SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase()) ? cleaned : null;
}

function formatRich(text: string, push: (n: ReactNode) => void): void {
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index), push);
    if (m[1]) push(<strong>{m[2]}</strong>);
    else if (m[3]) push(<em>{m[4]}</em>);
    else if (m[5]) {
      const href = safeLinkHref(m[6]);
      // Allowed schemes open in a new context (never the app frame), with
      // noopener/noreferrer so the target can't reach back via window.opener.
      // Disallowed schemes degrade to the plain link text.
      if (href) push(<a className="md-link" href={href} target="_blank" rel="noopener noreferrer">{m[5]}</a>);
      else pushText(m[5], push);
    }
    last = re.lastIndex;
  }
  if (last < text.length) pushText(text.slice(last), push);
}

// Preserve hard line breaks inside a paragraph.
function pushText(text: string, push: (n: ReactNode) => void): void {
  const parts = text.split("\n");
  parts.forEach((p, idx) => {
    if (idx > 0) push(<br />);
    if (p) push(p);
  });
}

// ── Fenced code block ────────────────────────────────────────
// A header bar (language label + Copy button) over a <pre>. Highlighting is
// applied lazily: the block renders as plain text immediately, then swaps in
// highlight.js token markup once the (code-split) highlighter chunk loads — so
// an unknown/unsupported language or a load failure simply stays plain.
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [hl, setHl] = useState<HighlightResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHl(null);
    if (!code.trim()) return;
    void import("../lib/highlight")
      .then((m) => { if (!cancelled) setHl(m.highlightCode(code, lang)); })
      .catch(() => { /* highlighting is best-effort; plain text already shown */ });
    return () => { cancelled = true; };
  }, [code, lang]);

  const copy = useCallback(() => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  }, [code]);

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar">
        <span className="md-codeblock-lang">{displayLang(lang, hl?.language)}</span>
        <button type="button" className="md-codeblock-copy" onClick={copy} title="Copy code">
          <Icon name={copied ? "check" : "duplicates"} size={11} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="md-pre">
        {hl
          ? <code className="hljs" dangerouslySetInnerHTML={{ __html: hl.html }} />
          : <code>{code}</code>}
      </pre>
    </div>
  );
}

// Friendly label for a fence language token (falls back to the resolved
// highlight.js language, then the raw token, then "Code").
const LANG_LABELS: Record<string, string> = {
  bash: "Bash", sh: "Bash", shell: "Bash", zsh: "Bash", console: "Bash",
  json: "JSON", js: "JavaScript", javascript: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
  python: "Python", py: "Python", rust: "Rust", rs: "Rust",
  powershell: "PowerShell", ps1: "PowerShell", pwsh: "PowerShell", ps: "PowerShell",
  diff: "Diff", patch: "Diff", html: "HTML", xml: "XML", css: "CSS",
  plaintext: "Text", text: "Text", txt: "Text",
};
function displayLang(raw: string, resolved?: string): string {
  const r = (raw || "").toLowerCase().trim();
  if (LANG_LABELS[r]) return LANG_LABELS[r];
  if (r) return r;
  if (resolved && LANG_LABELS[resolved]) return LANG_LABELS[resolved];
  return "Code";
}

// ── GFM table helpers ────────────────────────────────────────
// Split a `| a | b |` row into trimmed cell strings, dropping the empty edges
// produced by leading / trailing pipes. A `\|` escapes a literal pipe.
function splitTableRow(line: string): string[] {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
  return cells;
}

type CellAlign = "left" | "center" | "right" | "";
function cellAlign(delim: string): CellAlign {
  const left = delim.startsWith(":");
  const right = delim.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}
function alignStyle(align: CellAlign): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined;
}
