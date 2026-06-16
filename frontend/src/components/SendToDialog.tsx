// "Send to → Run command" manager + runner (#44).
//
// Lists the user's saved Send-to commands, lets them add/remove entries, and
// runs one against the current selection via the approval-gated run-command
// API. Commands are user-authored only (see lib/sendToCommands) and a preview
// of the exact command line (with the selection substituted) is shown before
// it runs, so there are no surprises.

import { useState } from "react";
import { Icon } from "./Icon";
import {
  getSendToCommands,
  addSendToCommand,
  removeSendToCommand,
  expandTemplate,
  type SendToCommand,
} from "../lib/sendToCommands";
import type { RunCommandResult } from "../api/client";

interface SendToDialogProps {
  paths: string[];
  onRunCommand: (command: string) => Promise<RunCommandResult>;
  onClose: () => void;
}

export function SendToDialog({ paths, onRunCommand, onClose }: SendToDialogProps) {
  const [commands, setCommands] = useState<SendToCommand[]>(() => getSendToCommands());
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const add = () => {
    if (!name.trim() || !template.trim()) return;
    setCommands(addSendToCommand(name, template));
    setName("");
    setTemplate("");
    setAdding(false);
  };

  const run = async (cmd: SendToCommand) => {
    if (runningId) return;
    const expanded = expandTemplate(cmd.template, paths);
    setRunningId(cmd.id);
    setStatus(`Running “${cmd.name}”…`);
    try {
      const res = await onRunCommand(expanded);
      if (res.ok && (res.exit_code === 0 || res.exit_code == null)) {
        setStatus(`“${cmd.name}” finished.`);
      } else {
        setStatus(`“${cmd.name}” exited ${res.exit_code ?? "?"}${res.error ? `: ${res.error}` : ""}.`);
      }
    } catch (e) {
      setStatus(`“${cmd.name}” failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="filter-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="prompt-dialog sendto-dialog" role="dialog" aria-modal="true" aria-label="Send to: run command">
        <div className="fd-header">
          <span className="fd-title">Send to → Run command</span>
        </div>
        <div className="cd-body">
          <p className="cd-msg">
            Run a saved command against the {paths.length} selected {paths.length === 1 ? "item" : "items"}.
            Use <code>{"{paths}"}</code>, <code>{"{path}"}</code> or <code>{"{dir}"}</code> in a template;
            the selection is substituted (quoted) before it runs.
          </p>

          {commands.length === 0 && !adding && (
            <p className="sendto-empty">No commands yet. Add one to get started.</p>
          )}

          <ul className="sendto-list">
            {commands.map((c) => (
              <li key={c.id} className="sendto-item">
                <div className="sendto-info">
                  <span className="sendto-name">{c.name}</span>
                  <span className="sendto-template" title={c.template}>{c.template}</span>
                  <span className="sendto-preview" title={expandTemplate(c.template, paths)}>
                    {expandTemplate(c.template, paths)}
                  </span>
                </div>
                <button className="fd-ok" disabled={runningId !== null || paths.length === 0} onClick={() => void run(c)}>
                  {runningId === c.id ? "Running…" : "Run"}
                </button>
                <button
                  className="sendto-remove"
                  title="Remove command"
                  onClick={() => setCommands(removeSendToCommand(c.id))}
                >
                  <Icon name="x" size={11} />
                </button>
              </li>
            ))}
          </ul>

          {adding ? (
            <div className="sendto-add">
              <input
                className="prompt-input"
                placeholder="Name (e.g. Open in VS Code)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="prompt-input"
                placeholder={"Command template, e.g. code {paths}"}
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
              />
              <div className="sendto-add-actions">
                <button className="fd-ok primary" onClick={add} disabled={!name.trim() || !template.trim()}>Save</button>
                <button className="fd-cancel" onClick={() => { setAdding(false); setName(""); setTemplate(""); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="sendto-add-btn" onClick={() => setAdding(true)}>
              <Icon name="folder-plus" size={13} /> Add command…
            </button>
          )}

          {status && <span className="sendto-status">{status}</span>}
        </div>
        <div className="fd-footer">
          <button className="fd-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
