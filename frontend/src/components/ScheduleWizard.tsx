import { useEffect, useState, useCallback } from "react";
import {
  listSchedules,
  createSchedule,
  deleteSchedule,
  type ScheduledTask,
  type ScheduleFormat,
} from "../api/client";
import {
  getAlertConfigs,
  upsertAlertConfig,
  removeAlertConfig,
  type GrowthAlertConfig,
} from "../lib/autoSnapshot";
import { Select } from "./Select";

interface ScheduleWizardProps {
  /** Active tab's scanned path, used to prefill the scan target. */
  initialPath?: string;
  onClose: () => void;
}

const FORMATS: ScheduleFormat[] = ["html", "xlsx", "xml", "csv", "json"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Pull the `--path` and `--format` values out of a task's CLI argument string
 *  for a friendly one-line summary (falls back to the raw string on no match). */
function summarizeArgs(args: string): string {
  const path = /--path\s+"([^"]*)"/.exec(args)?.[1];
  const fmt = /--format\s+(\S+)/.exec(args)?.[1];
  if (path && fmt) return `${path} → ${fmt.toUpperCase()}`;
  return args;
}

export function ScheduleWizard({ initialPath, onClose }: ScheduleWizardProps) {
  const [name, setName] = useState("Daily Scan");
  const [path, setPath] = useState(initialPath ?? "");
  const [schedule, setSchedule] = useState<"daily" | "weekly">("daily");
  const [time, setTime] = useState("02:00");
  const [day, setDay] = useState("Mon");
  const [outDir, setOutDir] = useState("");
  const [format, setFormat] = useState<ScheduleFormat>("html");

  // #40: optional "save snapshot + alert on growth" attached to the schedule.
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [alertPct, setAlertPct] = useState("10");
  const [alertGb, setAlertGb] = useState("");
  const [alertConfigs, setAlertConfigs] = useState<GrowthAlertConfig[]>([]);

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await listSchedules());
    } finally {
      setLoading(false);
    }
    setAlertConfigs(getAlertConfigs());
  }, []);

  const handleRemoveAlert = useCallback((p: string) => {
    removeAlertConfig(p);
    setAlertConfigs(getAlertConfigs());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleCreate() {
    setError(null);
    setNotice(null);
    if (!name.trim()) return setError("Enter a task name.");
    if (!path.trim()) return setError("Enter a folder to scan.");
    if (!outDir.trim()) return setError("Enter an output folder.");
    setBusy(true);
    try {
      const full = await createSchedule({
        name: name.trim(),
        path: path.trim(),
        schedule,
        time,
        day: schedule === "weekly" ? day : undefined,
        outDir: outDir.trim(),
        format,
      });
      // #40: persist the growth-alert definition for this folder alongside the
      // task. The alert is evaluated in-app against the snapshot history (see
      // the FLAG note below), not inside the headless task itself.
      if (alertEnabled) {
        const pct = Number(alertPct);
        const gb = Number(alertGb);
        upsertAlertConfig({
          path: path.trim(),
          enabled: true,
          thresholdPct: Number.isFinite(pct) && pct > 0 ? pct : 0,
          thresholdBytes: Number.isFinite(gb) && gb > 0 ? Math.round(gb * 1e9) : 0,
        });
      }
      setNotice(`Created scheduled task "${full}".`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(taskName: string) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await deleteSchedule(taskName);
      setNotice(`Deleted "${taskName}".`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="filter-dialog-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="filter-dialog sched-dialog" role="dialog" aria-modal="true" aria-label="Scheduled scans">
        <div className="fd-header">
          <span className="fd-title">Scheduled Scans</span>
        </div>

        <div className="fd-body sched-body">
          <p className="sched-hint">
            Register a Windows Scheduled Task that runs a FileTree scan and export
            on a schedule. Tasks are created under the <code>\FileTree\</code> task
            folder and run the bundled FileTree CLI in the background.
          </p>

          <div className="sched-form">
            <label className="sched-row">
              <span className="sched-label">Task name</span>
              <input className="fd-value" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Daily Scan" />
            </label>

            <label className="sched-row">
              <span className="sched-label">Folder to scan</span>
              <input className="fd-value" value={path} onChange={(e) => setPath(e.target.value)}
                placeholder="C:\\Users\\me\\Documents" />
            </label>

            <label className="sched-row">
              <span className="sched-label">Output folder</span>
              <input className="fd-value" value={outDir} onChange={(e) => setOutDir(e.target.value)}
                placeholder="C:\\Reports" />
            </label>

            <div className="sched-row">
              <span className="sched-label">Schedule</span>
              <div className="sched-inline">
                <Select
                  className="fd-select"
                  value={schedule}
                  options={[
                    { value: "daily", label: "Daily" },
                    { value: "weekly", label: "Weekly" },
                  ]}
                  aria-label="Schedule frequency"
                  onChange={setSchedule}
                />
                {schedule === "weekly" && (
                  <Select
                    className="fd-select"
                    value={day}
                    options={WEEKDAYS.map((weekday) => ({ value: weekday, label: weekday }))}
                    aria-label="Day of week"
                    onChange={setDay}
                  />
                )}
                <span className="sched-at">at</span>
                <input className="fd-value sched-time" type="time" value={time}
                  onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>

            <div className="sched-row">
              <span className="sched-label">Format</span>
              <Select
                className="fd-select"
                value={format}
                options={FORMATS.map((nextFormat) => ({
                  value: nextFormat,
                  label: nextFormat.toUpperCase(),
                }))}
                aria-label="Report format"
                onChange={setFormat}
              />
            </div>

            <div className="sched-row">
              <span className="sched-label">Growth alert</span>
              <div className="sched-inline">
                <label className="sched-check">
                  <input type="checkbox" checked={alertEnabled}
                    onChange={(e) => setAlertEnabled(e.target.checked)} />
                  Alert when this folder grows by
                </label>
                <input className="fd-value sched-thresh" type="number" min={0} step={1}
                  value={alertPct} disabled={!alertEnabled}
                  onChange={(e) => setAlertPct(e.target.value)} />
                <span className="sched-at">% or</span>
                <input className="fd-value sched-thresh" type="number" min={0} step={0.5}
                  value={alertGb} disabled={!alertEnabled} placeholder="GB"
                  onChange={(e) => setAlertGb(e.target.value)} />
                <span className="sched-at">GB</span>
              </div>
            </div>
          </div>

          {alertEnabled && (
            <p className="sched-hint">
              The growth alert is checked <strong>inside FileTree</strong> (on app start and after each
              auto-snapshot) by comparing this folder's two most recent snapshots — not by the headless
              scheduled task, which only scans and exports. So a breach is surfaced the next time the app
              is open and a new snapshot for this folder lands.
            </p>
          )}

          {alertConfigs.length > 0 && (
            <div className="sched-alert-list">
              <div className="sched-list-head"><span>Folders with a growth alert</span></div>
              {alertConfigs.map((c) => (
                <div className="sched-task" key={c.path}>
                  <div className="sched-task-main">
                    <span className="sched-task-name" title={c.path}>{c.path}</span>
                    <span className="sched-task-sub">
                      {c.thresholdPct > 0 ? `≥ ${c.thresholdPct}%` : ""}
                      {c.thresholdPct > 0 && c.thresholdBytes > 0 ? " or " : ""}
                      {c.thresholdBytes > 0 ? `≥ ${(c.thresholdBytes / 1e9).toFixed(1)} GB` : ""}
                    </span>
                  </div>
                  <button className="fd-clear sched-del" onClick={() => handleRemoveAlert(c.path)} disabled={busy}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <div className="sched-msg sched-err">{error}</div>}
          {notice && <div className="sched-msg sched-ok">{notice}</div>}

          <div className="sched-list-head">
            <span>Existing FileTree tasks</span>
            <button className="fd-cancel sched-refresh" onClick={() => void refresh()} disabled={loading || busy}>
              Refresh
            </button>
          </div>
          <div className="sched-list">
            {loading ? (
              <div className="sched-empty">Loading…</div>
            ) : tasks.length === 0 ? (
              <div className="sched-empty">No FileTree tasks scheduled yet.</div>
            ) : (
              tasks.map((t) => (
                <div className="sched-task" key={t.name}>
                  <div className="sched-task-main">
                    <span className="sched-task-name">{t.name}</span>
                    <span className="sched-task-sub" title={t.arguments}>
                      {summarizeArgs(t.arguments)}
                    </span>
                  </div>
                  <div className="sched-task-meta">
                    <span className={`sched-state sched-state-${t.state.toLowerCase()}`}>{t.state}</span>
                    {t.nextRun && <span className="sched-next" title={`Last run: ${t.lastRun || "never"}`}>
                      next: {t.nextRun}
                    </span>}
                  </div>
                  <button className="fd-clear sched-del" onClick={() => void handleDelete(t.name)} disabled={busy}>
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="fd-footer">
          <button className="fd-ok primary" onClick={() => void handleCreate()} disabled={busy}>
            {busy ? "Working…" : "Create Task"}
          </button>
          <button className="fd-cancel" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
