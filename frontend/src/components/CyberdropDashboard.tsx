type ErrorCount = { code: number | null; msg: string; count: number };
export type DashboardData = {
  fileStats?: Record<string, number>;
  scrapeErrors?: { errors: ErrorCount[]; skipped?: number; sent_to_jdownloader?: number };
  downloadErrors?: { errors: ErrorCount[] };
  scraping?: { url: string; elapsed: number | null }[];
  scrapeQueued?: number;
  downloadQueued?: number;
  status?: { description: string; messages: string[] };
  compression?: { title: string; pending: number; compressed: number; skipped: number; failed: number; total: number; files: { id: number; name: string; completed: number; total: number | null; speed: number | null; eta: number | null }[] };
};
function CountBar({ label, count, total }: { label: string; count: number; total: number }) {
  return <div className="cdl-count-row"><span>{label}</span><progress aria-label={label} max={Math.max(1, total)} value={count} /><span>{(total ? count / total * 100 : 0).toFixed(2)}%</span><strong>{count.toLocaleString()}</strong></div>;
}
function Errors({ title, errors = [] }: { title: string; errors?: ErrorCount[] }) {
  const total = errors.reduce((sum, error) => sum + error.count, 0);
  return <section className="cdl-card"><header><strong>{title}</strong><span>Total: {total.toLocaleString()}</span></header><div className="cdl-card-body">{errors.length ? errors.map((error, index) => <CountBar key={index} label={`${error.code ?? ""} ${error.msg}`.trim()} count={error.count} total={total} />) : <span className="cdl-muted">No errors</span>}</div></section>;
}
export function CyberdropSummary({ data, running }: { data?: DashboardData | null; running: boolean }) {
  const stats = data?.fileStats ?? {};
  const total = Object.values(stats).reduce((sum, count) => sum + count, 0);
  return <>
    <div className="cdl-summary-grid">
      <section className="cdl-card"><header><strong>Files</strong><span>Total: {total.toLocaleString()}</span></header><div className="cdl-card-body">{[["completed", "Completed"], ["prev_completed", "Previously downloaded"], ["skipped", "Skipped by config"], ["queued", "Queued"], ["failed", "Failed"]].map(([key, label]) => <CountBar key={key} label={label} count={stats[key] ?? 0} total={total} />)}</div></section>
      <Errors title="Scrape errors" errors={data?.scrapeErrors?.errors} />
      <Errors title="Download errors" errors={data?.downloadErrors?.errors} />
    </div>
    <section className="cdl-card"><header><strong>Scraping</strong><span>{running ? data?.scraping?.length ?? 0 : 0} active URLs · {(data?.scrapeQueued ?? 0).toLocaleString()} queued</span></header><div className="cdl-scrape-list">{running && data?.scraping?.length ? data.scraping.map((item, index) => <div key={index}><span title={item.url}>{item.url}</span><span>{item.elapsed == null ? "" : `${Math.floor(item.elapsed)}s`}</span></div>) : <span className="cdl-muted">{running ? "Waiting for URLs" : "No active scraping"}</span>}</div></section>
    {data?.status && <div className="cdl-toolbar cdl-muted">{data.status.description}{running && data.status.messages.map((message, index) => <span key={index}>{message}</span>)}</div>}
  </>;
}
export function CyberdropCompression({ data, running, mode, bytes, eta }: { data?: DashboardData | null; running: boolean; mode: string; bytes: (value: number) => string; eta: (value: number | null) => string }) {
  const value = data?.compression;
  return <section className="cdl-card"><header><strong>{value?.title || "Compression"}</strong><span>Active: {running ? value?.files.length ?? 0 : 0} · Total: {(value?.total ?? 0).toLocaleString()}</span></header>
    <div className="cdl-card-body">{mode === "filetree" && <p>Downloads are sent to the FileTree compression queue. Manage those jobs on Compress → Monitor.</p>}{mode === "off" && !value?.total && <p>Compression is off.</p>}
    {running && value?.files.map(file => <div className="cdl-compression-file" key={file.id}><strong title={file.name}>{file.name}</strong><progress aria-label={`Compression progress for ${file.name}`} max={file.total || undefined} value={file.total ? file.completed : undefined} /><span>{file.total ? `${Math.min(100, file.completed / file.total * 100).toFixed(2)}%` : "Unknown size"}</span><span>{bytes(file.completed)} / {file.total ? bytes(file.total) : "?"}</span><span>{file.speed == null ? "Estimating speed" : `${bytes(file.speed)}/s`}</span><span>{eta(file.eta)}</span></div>)}
    {(["pending", "compressed", "skipped", "failed"] as const).map(key => <CountBar key={key} label={key[0].toUpperCase() + key.slice(1)} count={value?.[key] ?? 0} total={value?.total ?? 0} />)}
    </div></section>;
}
