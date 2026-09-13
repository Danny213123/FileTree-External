import { useState } from "react";
import { compressionPathKey, saveCompressionExclusions } from "../lib/compressionExclusions";

export function CompressionExclusions({ paths, onChange, selectedPaths, disabled, standalone = false }: {
  paths: string[]; onChange: (paths: string[]) => void; selectedPaths: string[]; disabled: boolean; standalone?: boolean;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const update = (next: string[]) => {
    try { saveCompressionExclusions(next); onChange(next); setError(""); }
    catch { setError("Could not save exclusions."); }
  };
  const add = (values: string[]) => {
    const next = new Map(paths.map((path) => [compressionPathKey(path), path]));
    for (const value of values) {
      const path = value.trim();
      if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/)/i.test(path)) {
        setError("Enter a full folder or file path."); return;
      }
      next.set(compressionPathKey(path), path);
    }
    update([...next.values()]); setInput("");
  };
  return <details open={standalone || undefined} className="compress-notice" style={{ display: "block" }}>
    <summary>Do not compress · {paths.length} saved exclusions</summary>
    <p>Excluded folders protect all files and subfolders beneath them. Saved exclusions apply to new jobs, including queued jobs. Files are not renamed.</p>
    <div style={{ display: "flex", gap: 8 }}>
      <input className="dg-input" style={{ flex: 1 }} aria-label="Folder or file to exclude" placeholder="Paste a full folder or file path" value={input} disabled={disabled} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && input.trim()) add([input]); }} />
      <button type="button" className="compress-btn" disabled={disabled || !input.trim()} onClick={() => add([input])}>Exclude path</button>
      <button type="button" className="compress-btn" disabled={disabled || !selectedPaths.length} onClick={() => add(selectedPaths)}>Exclude selected files</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {paths.map((path) => <div key={compressionPathKey(path)} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
      <span>Do not compress</span><code style={{ flex: 1, overflowWrap: "anywhere" }}>{path}</code>
      <button type="button" className="compress-btn" aria-label={`Remove exclusion ${path}`} disabled={disabled} onClick={() => update(paths.filter((entry) => entry !== path))}>Remove</button>
    </div>)}
  </details>;
}
