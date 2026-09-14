// What's New — renders the repository CHANGELOG.md inside the app.
//
// The markdown is imported as raw text and bundled, so the viewer ships with
// the build and needs no backend route or network access. CHANGELOG.md stays
// the single source of truth: anything written there appears here.

import { useEffect, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import changelogMarkdown from "../../../CHANGELOG.md?raw";

/** Releases rendered before the reader asks for the rest. The full file is ~45
 *  sections of dense notes, which is both slow to render and not what someone
 *  opening "What's New" is looking for. */
const INITIAL_RELEASES = 5;

/**
 * Split the changelog into its level-2 release sections, dropping the file's
 * preamble (the dialog has its own header) and the `---` rules used as visual
 * separators between some older entries.
 */
export function splitReleases(markdown: string): string[] {
  return markdown
    .replace(/\r\n/g, "\n")
    .split(/\n(?=## )/)
    .slice(1)
    .map((section) => section.replace(/\n+---\s*$/, "").trim())
    .filter(Boolean);
}

interface ChangelogDialogProps {
  /** Running app version, shown in the header. Empty until the backend reports it. */
  version: string;
  onClose: () => void;
}

export function ChangelogDialog({ version, onClose }: ChangelogDialogProps) {
  const [showAll, setShowAll] = useState(false);
  const releases = useMemo(() => splitReleases(changelogMarkdown), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const shown = showAll ? releases : releases.slice(0, INITIAL_RELEASES);
  const hidden = releases.length - shown.length;

  return (
    <div className="filter-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="changelog-dialog" role="dialog" aria-modal="true" aria-label="What's New">
        <div className="fd-header">
          <span className="fd-title">What&rsquo;s New</span>
          {version && <span className="changelog-version">v{version}</span>}
          <button className="fd-close" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="changelog-body">
          <Markdown text={shown.join("\n\n")} />
          {hidden > 0 && (
            <button className="changelog-more" onClick={() => setShowAll(true)}>
              Show {hidden} older release{hidden === 1 ? "" : "s"}
            </button>
          )}
        </div>
        <div className="fd-footer">
          <button className="fd-ok primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
