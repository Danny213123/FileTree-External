import { useState, useCallback } from "react";
import type { DuplicateCandidate, DuplicateGroup } from "../api/types";
import { fetchExactDuplicates } from "../api/client";
import { formatBytes, formatCount } from "../utils/formatBytes";

interface DuplicatesTabProps {
  candidates: DuplicateCandidate[];
  exactGroups: DuplicateGroup[] | null;
  scanPath: string;
  nodeById: Map<number, { path: string }>;
  onNavigate: (id: number) => void;
}

export function DuplicatesTab({
  candidates,
  exactGroups,
  scanPath,
  nodeById,
  onNavigate,
}: DuplicatesTabProps) {
  const [minSize, setMinSize] = useState(1024 * 1024);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(exactGroups);
  const [error, setError] = useState("");

  const runExact = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchExactDuplicates(scanPath);
      setGroups(result.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [scanPath]);

  const filtered = candidates.filter((c) => c.size >= minSize);

  return (
    <>
      <div className="dup-tools">
        <label>
          Min size (bytes):
          <input
            type="number"
            value={minSize}
            min={0}
            onChange={(e) => setMinSize(Number(e.target.value))}
          />
        </label>
        <button onClick={runExact} disabled={loading || !scanPath}>
          {loading ? "Scanning…" : "Find Exact Duplicates"}
        </button>
        {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
      </div>

      {groups ? (
        <div className="item-list">
          {groups.length === 0 && <div className="empty">No exact duplicates found</div>}
          {groups.map((g) => (
            <div className="item-row" key={g.hash}>
              <header>
                <strong>
                  {formatCount(g.ids.length)} copies · {formatBytes(g.size)} each
                </strong>
                <span>Waste: {formatBytes(g.waste)}</span>
              </header>
              <div className="paths">
                {g.ids.map((id) => {
                  const node = nodeById.get(id);
                  return (
                    <button key={id} onClick={() => onNavigate(id)}>
                      {node?.path ?? `#${id}`}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="item-list">
          {filtered.length === 0 && <div className="empty">No duplicate candidates</div>}
          {filtered.map((c) => (
            <div className="item-row" key={c.name + c.size}>
              <header>
                <strong>{c.name}</strong>
                <span>
                  {formatCount(c.ids.length)} copies · {formatBytes(c.size)} · waste {formatBytes(c.waste)}
                </span>
              </header>
              <div className="paths">
                {c.ids.map((id) => {
                  const node = nodeById.get(id);
                  return (
                    <button key={id} onClick={() => onNavigate(id)}>
                      {node?.path ?? `#${id}`}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
