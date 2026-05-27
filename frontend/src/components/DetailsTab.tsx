import type { NodeRecord, ScanResult } from "../api/types";
import { formatBytes, formatCount } from "../utils/formatBytes";
import { formatDate } from "../utils/formatDate";

interface DetailsTabProps {
  data: ScanResult | null;
  selectedNode: NodeRecord | undefined;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
}

export function DetailsTab({ data, selectedNode, onOpen, onReveal, onCopyPath }: DetailsTabProps) {
  const root = data?.nodes[0];

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
              <tr><td>Size</td><td>{formatBytes(selectedNode.size)}</td></tr>
              <tr><td>Allocated</td><td>{formatBytes(selectedNode.allocated)}</td></tr>
              <tr><td>Files</td><td>{formatCount(selectedNode.files)}</td></tr>
              <tr><td>Folders</td><td>{formatCount(selectedNode.folders)}</td></tr>
              <tr><td>Modified</td><td>{formatDate(selectedNode.modified)}</td></tr>
              {selectedNode.extension && (
                <tr><td>Extension</td><td>{selectedNode.extension}</td></tr>
              )}
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
