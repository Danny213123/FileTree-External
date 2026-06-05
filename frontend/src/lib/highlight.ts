// Lazy, curated syntax highlighter for assistant code blocks.
//
// This module is loaded ONLY via a dynamic import() from Markdown.tsx, so
// highlight.js (the core engine + a small, explicit language set) lands in its
// OWN code-split chunk that downloads the first time a fenced code block is
// rendered — never on the initial app load. We use `highlight.js/lib/core`
// (which registers NO languages by default) plus a hand-picked language list to
// keep that chunk small instead of pulling the full ~190-language bundle.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import powershell from "highlight.js/lib/languages/powershell";
import diff from "highlight.js/lib/languages/diff";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import plaintext from "highlight.js/lib/languages/plaintext";

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("powershell", powershell);
  hljs.registerLanguage("diff", diff);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("plaintext", plaintext);
}

// Normalize the fence label to one of the registered language names. Most of
// these are also built-in highlight.js aliases, but normalizing up front means
// labels like `tsx`/`jsx`/`sh`/`html` always resolve to a curated language
// (and unknown labels fall through to a plain <pre>).
const LANG_ALIASES: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", py3: "python",
  rs: "rust",
  ps: "powershell", ps1: "powershell", pwsh: "powershell",
  html: "xml", htm: "xml", xhtml: "xml", svg: "xml",
  patch: "diff",
  text: "plaintext", txt: "plaintext",
};

export interface HighlightResult {
  /** Escaped HTML with hljs token spans — safe to inject (hljs escapes input). */
  html: string;
  /** The resolved highlight.js language name. */
  language: string;
}

// Highlight `code` for the given fence `lang`. Returns escaped HTML (hljs always
// HTML-escapes the source, only wrapping it in its own <span class="hljs-…">
// tags) plus the resolved language, or null when the language is unknown — in
// which case the caller renders a plain <pre> fallback.
export function highlightCode(code: string, lang: string): HighlightResult | null {
  ensureRegistered();
  const raw = (lang || "").toLowerCase().trim();
  if (!raw) return null;
  const name = LANG_ALIASES[raw] ?? raw;
  if (!hljs.getLanguage(name)) return null;
  try {
    const res = hljs.highlight(code, { language: name, ignoreIllegals: true });
    return { html: res.value, language: res.language || name };
  } catch {
    return null;
  }
}
