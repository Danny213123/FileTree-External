import { Fragment, type ReactNode } from "react";

// Minimal, dependency-free Markdown renderer for assistant output. It builds
// React nodes directly (never dangerouslySetInnerHTML), so model text can never
// inject markup. Covers the subset LLMs actually emit: headings, **bold**,
// *italic*, `inline code`, fenced ``` code blocks, links, blockquotes, and
// ordered / unordered lists.
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

    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // consume closing fence (if present)
      out.push(<pre key={key++} className="md-pre"><code>{buf.join("\n")}</code></pre>);
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

    // Unordered list
    if (RE_UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_UL.test(lines[i])) { items.push(lines[i].replace(RE_UL, "")); i++; }
      out.push(<ul key={key++} className="md-ul">{items.map((it, j) => <li key={j}>{renderInline(it, opts)}</li>)}</ul>);
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
