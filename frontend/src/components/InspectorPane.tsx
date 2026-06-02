import { useEffect, useState } from "react";
import type { NodeRecord, ScanResult, Unit } from "../api/types";
import { fetchFileText } from "../api/client";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { DetailsTab } from "./DetailsTab";
import { FileIcon } from "./FileIcon";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "tif", "tiff", "avif", "heic", "ico"]);
const VIDEO_EXTS = new Set(["mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv"]);
// Extensions we'll attempt a text preview for. The server still sniffs for NUL
// bytes and caps the read, so this list just avoids fetching obvious binaries.
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "json5", "jsonc",
  "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties",
  "html", "htm", "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rb", "php", "go", "rs", "c", "h", "cpp", "hpp", "cc", "cs", "java",
  "kt", "swift", "sh", "bash", "zsh", "bat", "cmd", "ps1", "sql", "r", "lua",
  "pl", "vim", "diff", "patch", "gitignore", "dockerfile", "makefile",
]);

function isImage(ext: string) { return IMAGE_EXTS.has(ext); }
function isVideo(ext: string) { return VIDEO_EXTS.has(ext); }

interface InspectorPaneProps {
  width: number;
  node: NodeRecord | undefined;
  data: ScanResult | null;
  nodeById: Map<number, NodeRecord>;
  unit: Unit;
  showPreview: boolean;
  showDetails: boolean;
  onClosePreview: () => void;
  onCloseDetails: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
}

// Right-side, toggleable inspector that mirrors the Explorer "Preview" and
// "Details" panes. Both sections are independently toggleable and driven by the
// focused tab's currently-selected tree node (updates live as selection moves).
export function InspectorPane({
  width, node, data, nodeById, unit,
  showPreview, showDetails, onClosePreview, onCloseDetails,
  onOpen, onReveal, onCopyPath,
}: InspectorPaneProps) {
  return (
    <div className="inspector-pane" style={{ width, flex: `0 0 ${width}px` }}>
      {showPreview && (
        <section className="inspector-section inspector-preview">
          <div className="inspector-section-head">
            <span>Preview</span>
            <button className="inspector-x" title="Hide preview (Alt+P)" onClick={onClosePreview} aria-label="Hide preview">
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="inspector-section-body">
            <PreviewBody node={node} unit={unit} />
          </div>
        </section>
      )}

      {showDetails && (
        <section className="inspector-section inspector-details">
          <div className="inspector-section-head">
            <span>Details</span>
            <button className="inspector-x" title="Hide details (Alt+Shift+P)" onClick={onCloseDetails} aria-label="Hide details">
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="inspector-section-body">
            <DetailsTab
              data={data}
              selectedNode={node}
              nodeById={nodeById}
              onOpen={onOpen}
              onReveal={onReveal}
              onCopyPath={onCopyPath}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function PreviewBody({ node, unit }: { node: NodeRecord | undefined; unit: Unit }) {
  if (!node) {
    return (
      <EmptyState
        compact
        icon="image"
        title="Nothing selected"
        hint="Select a file or folder to preview it here."
      />
    );
  }
  if (node.dir) return <FolderPreview node={node} unit={unit} />;

  const ext = (node.extension ?? "").toLowerCase();
  if (isImage(ext) || isVideo(ext)) return <MediaPreview node={node} unit={unit} />;
  if (TEXT_EXTS.has(ext) || ext === "") return <TextPreview node={node} unit={unit} />;
  return <IconPreview node={node} unit={unit} />;
}

function FileMeta({ node, unit }: { node: NodeRecord; unit: Unit }) {
  const ext = (node.extension ?? "").toLowerCase();
  return (
    <div className="preview-meta">
      <div className="preview-meta-name" title={node.path}>{node.name}</div>
      <div className="preview-meta-sub">
        {node.dir ? "Folder" : (ext ? `.${ext}` : "File")} · {formatBytes(node.size, unit)}
        {node.dir && <> · {formatCount(node.files)} files</>}
      </div>
    </div>
  );
}

function MediaPreview({ node, unit }: { node: NodeRecord; unit: Unit }) {
  const [error, setError] = useState(false);
  useEffect(() => { setError(false); }, [node.path]);
  if (error) return <IconPreview node={node} unit={unit} />;
  return (
    <div className="preview-block">
      <div className="preview-media">
        <img
          src={`/api/thumbnail?path=${encodeURIComponent(node.path)}`}
          alt={node.name}
          onError={() => setError(true)}
        />
      </div>
      <FileMeta node={node} unit={unit} />
    </div>
  );
}

type TextState =
  | { kind: "loading" }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "fallback" };

function TextPreview({ node, unit }: { node: NodeRecord; unit: Unit }) {
  const [state, setState] = useState<TextState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    fetchFileText(node.path, ctrl.signal)
      .then((res) => {
        if (cancelled) return;
        if (res.binary || res.text == null) setState({ kind: "fallback" });
        else setState({ kind: "text", text: res.text, truncated: !!res.truncated });
      })
      .catch(() => { if (!cancelled) setState({ kind: "fallback" }); });
    return () => { cancelled = true; ctrl.abort(); };
  }, [node.path]);

  if (state.kind === "loading") return <div className="inspector-empty">Loading preview…</div>;
  if (state.kind === "fallback") return <IconPreview node={node} unit={unit} />;
  return (
    <div className="preview-block">
      <pre className="preview-text">{state.text || "(empty file)"}</pre>
      {state.truncated && <div className="preview-note">Preview truncated to the first 64 KB.</div>}
      <FileMeta node={node} unit={unit} />
    </div>
  );
}

function IconPreview({ node, unit }: { node: NodeRecord; unit: Unit }) {
  const ext = (node.extension ?? "").toLowerCase();
  return (
    <div className="preview-block preview-iconly">
      <div className="preview-icon-big">
        <FileIcon ext={ext} isDir={false} isBundle={false} />
      </div>
      <FileMeta node={node} unit={unit} />
    </div>
  );
}

function FolderPreview({ node, unit }: { node: NodeRecord; unit: Unit }) {
  return (
    <div className="preview-block preview-iconly">
      <div className="preview-icon-big">
        <Icon name="folder" size={40} />
      </div>
      <FileMeta node={node} unit={unit} />
    </div>
  );
}
