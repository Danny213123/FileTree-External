import { useEffect, useState } from "react";
import type { NodeRecord, ScanResult } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";
import { attributeList } from "../lib/attributes";
import { fetchOwner } from "../api/client";

interface DetailsTabProps {
  data: ScanResult | null;
  selectedNode: NodeRecord | undefined;
  /** Used to compute "% of parent" from the selected node's parent size. */
  nodeById?: Map<number, NodeRecord>;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
}

function attributesOf(node: NodeRecord): string {
  const list = attributeList(node);
  return list.length ? list.join(", ") : "—";
}

export function DetailsTab({ data, selectedNode, nodeById, onOpen, onReveal, onCopyPath }: DetailsTabProps) {
  const root = data?.nodes[0];

  const parent = selectedNode?.parent != null ? nodeById?.get(selectedNode.parent) : undefined;
  const percentOfParent = selectedNode && parent && parent.size > 0
    ? (selectedNode.size / parent.size) * 100
    : null;

  // Owner comes from the scan when owner collection was enabled; otherwise we
  // resolve it on demand for just this one selected path (cheap single call).
  const [lazyOwner, setLazyOwner] = useState<string>("");
  useEffect(() => {
    setLazyOwner("");
    if (!selectedNode || selectedNode.id < 0 || !selectedNode.path) return;
    if (selectedNode.owner) return; // already have it from the scan
    const ctrl = new AbortController();
    let cancelled = false;
    fetchOwner(selectedNode.path, ctrl.signal)
      .then((owner) => { if (!cancelled) setLazyOwner(owner); })
      .catch(() => {});
    return () => { cancelled = true; ctrl.abort(); };
  }, [selectedNode?.id, selectedNode?.path, selectedNode?.owner]);
  const ownerText = selectedNode?.owner || lazyOwner;

  return (
    <div className="details-tab">
      {/* Scan summary */}
      <section className="details-section">
        <div className="details-section-title">Scan Summary</div>
        {root ? (
          <table className="details-table">
            <tbody>
              <tr><td>Path</td><td>{root.path}</td></tr>
              <tr><td>Size</td><td>{formatBytes(root.size)}</td></tr>
              <tr><td>Allocated</td><td>{formatBytes(root.allocated)}</td></tr>
              <tr><td>Files</td><td>{formatCount(root.files)}</td></tr>
              <tr><td>Folders</td><td>{formatCount(root.folders)}</td></tr>
              {data?.elapsedMs != null && (
                <tr><td>Scan time</td><td>{(data.elapsedMs / 1000).toFixed(1)} s</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <div className="empty">No scan loaded</div>
        )}
      </section>

      {/* Selected item */}
      {selectedNode && (
        <section className="details-section">
          <div className="details-section-title">
            <span className={`kind ${selectedNode.dir ? "dir" : "file"}`} />
            <span title={selectedNode.path}>{selectedNode.name}</span>
          </div>
          <table className="details-table">
            <tbody>
              <tr><td>Path</td><td className="detail-path">{selectedNode.path}</td></tr>
              <tr><td>Type</td><td>{selectedNode.dir ? "Folder" : (selectedNode.extension ? `.${selectedNode.extension}` : "File")}</td></tr>
              <tr><td>Size</td><td>{formatBytes(selectedNode.size)}</td></tr>
              <tr><td>On disk</td><td>{formatBytes(selectedNode.allocated)}</td></tr>
              {selectedNode.dir && <tr><td>Files</td><td>{formatCount(selectedNode.files)}</td></tr>}
              {selectedNode.dir && <tr><td>Folders</td><td>{formatCount(selectedNode.folders)}</td></tr>}
              {percentOfParent != null && (
                <tr><td>% of parent</td><td>{percentOfParent.toFixed(1)}%</td></tr>
              )}
              <tr><td>Modified</td><td>{formatDate(selectedNode.modified)}</td></tr>
              {selectedNode.created > 0 && <tr><td>Created</td><td>{formatDate(selectedNode.created)}</td></tr>}
              {selectedNode.accessed > 0 && <tr><td>Accessed</td><td>{formatDate(selectedNode.accessed)}</td></tr>}
              <tr><td>Attributes</td><td>{attributesOf(selectedNode)}</td></tr>
              <tr><td>Owner</td><td className="detail-path">{ownerText || "—"}</td></tr>
            </tbody>
          </table>
          <div className="details-actions">
            <button onClick={onOpen}>Open</button>
            <button onClick={onReveal}>Reveal in Explorer</button>
            <button onClick={onCopyPath}>Copy Path</button>
          </div>
        </section>
      )}
    </div>
  );
}
