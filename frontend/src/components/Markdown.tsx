import { Fragment, type ReactNode } from "react";

// Minimal, dependency-free Markdown renderer for assistant output. It builds
// React nodes directly (never dangerouslySetInnerHTML), so model text can never
// inject markup. Covers the subset LLMs actually emit: headings, **bold**,
// *italic*, `inline code`, fenced ``` code blocks, links, blockquotes, and
// ordered / unordered lists.
export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(text)}</div>;
}

const RE_FENCE = /^```/;
const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^>\s?/;
const RE_UL = /^\s*[-*+]\s+/;
const RE_OL = /^\s*\d+[.)]\s+/;

function isStructural(line: string): boolean {
  return RE_FENCE.test(line) || RE_HEAD.test(line) || RE_QUOTE.test(line) || RE_UL.test(line) || RE_OL.test(line);
}

function renderBlocks(src: string): ReactNode[] {
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
      out.push(<div key={key++} className={`md-h md-h${lvl}`}>{renderInline(h[2])}</div>);
      i++;
      continue;
    }

    // Blockquote
    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { buf.push(lines[i].replace(RE_QUOTE, "")); i++; }
      out.push(<blockquote key={key++} className="md-quote">{renderBlocks(buf.join("\n"))}</blockquote>);
      continue;
    }

    // Unordered list
    if (RE_UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_UL.test(lines[i])) { items.push(lines[i].replace(RE_UL, "")); i++; }
      out.push(<ul key={key++} className="md-ul">{items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (RE_OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_OL.test(lines[i])) { items.push(lines[i].replace(RE_OL, "")); i++; }
      out.push(<ol key={key++} className="md-ol">{items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>);
      continue;
    }

    // Blank line
    if (line.trim() === "") { i++; continue; }

    // Paragraph: consume consecutive non-blank, non-structural lines
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isStructural(lines[i])) { buf.push(lines[i]); i++; }
    out.push(<p key={key++} className="md-p">{renderInline(buf.join("\n"))}</p>);
  }

  return out;
}

// Inline formatting: inline code is split out first (so its contents are never
// re-parsed), then bold / italic / links are matched in the remaining text.
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const counter = { k: 0 };
  const push = (n: ReactNode) => out.push(<Fragment key={counter.k++}>{n}</Fragment>);

  for (const seg of text.split(/(`[^`]+`)/g)) {
    if (seg.length >= 2 && seg.startsWith("`") && seg.endsWith("`")) {
      push(<code className="md-code">{seg.slice(1, -1)}</code>);
    } else if (seg) {
      formatRich(seg, push);
    }
  }
  return out;
}

function formatRich(text: string, push: (n: ReactNode) => void): void {
  const re = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index), push);
    if (m[1]) push(<strong>{m[2]}</strong>);
    else if (m[3]) push(<em>{m[4]}</em>);
    else if (m[5]) push(<a className="md-link" href={m[6]} target="_blank" rel="noreferrer">{m[5]}</a>);
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
