import { useEffect, useState, useCallback } from "react";
import {
  listSchedules,
  createSchedule,
  deleteSchedule,
  type ScheduledTask,
  type ScheduleFormat,
} from "../api/client";

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
                <select className="fd-select" value={schedule}
                  onChange={(e) => setSchedule(e.target.value as "daily" | "weekly")}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
                {schedule === "weekly" && (
                  <select className="fd-select" value={day} onChange={(e) => setDay(e.target.value)}>
                    {WEEKDAYS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                )}
                <span className="sched-at">at</span>
                <input className="fd-value sched-time" type="time" value={time}
                  onChange={(e) => setTime(e.target.value)} />
              </div>
            </div>

            <div className="sched-row">
              <span className="sched-label">Format</span>
              <select className="fd-select" value={format}
                onChange={(e) => setFormat(e.target.value as ScheduleFormat)}>
                {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>
          </div>

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
