// Album search panel: query the public index, pick what you want, and hand the
// album links to cyberdrop-dl as a URL list.
//
// The list is the product here — a search is only useful if the albums you tick
// end up somewhere cyberdrop-dl reads, so the panel writes either a .txt file or
// a named URL workstation in the Cyberdrop plugin's workspace.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { downloadText } from "../lib/exportRows";
import type { PluginPanelProps } from "../lib/plugins";

type Album = { title: string; url: string; files: number | null; thumbnail: string | null };
type SearchPage = { albums: Album[]; page: number; pages: number; url: string };

const MODES = [["broad", "Broad"], ["strict", "Strict"], ["fuzzy", "Fuzzy"], ["substring", "Substring"], ["whole", "Whole word"]] as const;
const SORTS = [["latest", "Latest"], ["oldest", "Oldest"], ["files", "Most files"]] as const;
const SIZES = [20, 40, 60, 100] as const;
const OPTIONS_KEY = "filetree.bunkr.options";

type Options = { query: string; mode: string; per: number; sort: string };
const defaults: Options = { query: "", mode: "broad", per: 20, sort: "latest" };

function storedOptions(): Options {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Options>) : {};
    return {
      query: typeof saved.query === "string" ? saved.query : defaults.query,
      mode: MODES.some(([id]) => id === saved.mode) ? saved.mode! : defaults.mode,
      per: SIZES.some((size) => size === saved.per) ? saved.per! : defaults.per,
      sort: SORTS.some(([id]) => id === saved.sort) ? saved.sort! : defaults.sort,
    };
  } catch { return defaults; }
}

// Kept in the module so leaving the Plugins page does not throw away results
// that cost a request to fetch.
let session: { results: SearchPage | null; selected: string[] } = { results: null, selected: [] };

/** One URL per line: what cyberdrop-dl reads from a URL list. */
export function urlList(albums: Album[], selected: Set<string>): string {
  const picked = albums.filter((album) => selected.has(album.url));
  return `${(picked.length ? picked : albums).map((album) => album.url).join("\n")}\n`;
}

/** A filename that says what the list is without inventing detail. */
export function listName(query: string): string {
  const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `bunkr-${slug || "search"}.txt`;
}

export function BunkrView(_props: PluginPanelProps) {
  const [options, setOptions] = useState<Options>(storedOptions);
  const [results, setResults] = useState<SearchPage | null>(() => session.results);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(session.selected));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const albums = results?.albums ?? [];
  const repo = localStorage.getItem("filetree.cyberdrop.repo") || "";

  useEffect(() => { session = { results, selected: [...selected] }; }, [results, selected]);
  useEffect(() => {
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)); } catch { /* storage full or blocked */ }
  }, [options]);

  const search = (page: number) => {
    if (!options.query.trim()) { input.current?.focus(); return; }
    setBusy(true); setError(""); setMessage("");
    invoke<SearchPage>("bunkr_search", { ...options, query: options.query.trim(), page })
      .then((value) => {
        setResults(value);
        setSelected(new Set());
        if (!value.albums.length) setMessage("No albums matched. A broader mode may find more.");
      })
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  const toggle = (url: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (!next.delete(url)) next.add(url);
    return next;
  });

  const count = selected.size || albums.length;

  const saveList = () => {
    downloadText(listName(options.query), urlList(albums, selected), "text/plain;charset=utf-8");
    setMessage(`Saved ${listName(options.query)} with ${count} album ${count === 1 ? "link" : "links"}.`);
  };

  const sendToCyberdrop = () => {
    setBusy(true); setError(""); setMessage("");
    invoke("cyberdrop_workspace", {
      repo,
      request: { action: "create", text: urlList(albums, selected), label: listName(options.query) },
    })
      .then(() => setMessage(`Added ${listName(options.query)} to Cyberdrop. Open its Edit tab, then Load for download.`))
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(false));
  };

  return <div className="bkr-view">
    <form className="cdl-toolbar" onSubmit={(event) => { event.preventDefault(); search(1); }}>
      <input
        ref={input}
        className="bkr-query"
        aria-label="Search albums"
        placeholder="Album title to search for"
        value={options.query}
        onChange={(event) => setOptions({ ...options, query: event.target.value })}
      />
      <label>Match<select aria-label="Match mode" value={options.mode} onChange={(event) => setOptions({ ...options, mode: event.target.value })}>
        {MODES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <label>Per page<select aria-label="Results per page" value={options.per} onChange={(event) => setOptions({ ...options, per: Number(event.target.value) })}>
        {SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
      </select></label>
      <label>Sort<select aria-label="Sort order" value={options.sort} onChange={(event) => setOptions({ ...options, sort: event.target.value })}>
        {SORTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>
      <button type="submit" disabled={busy || !options.query.trim()}>{busy ? "Searching…" : "Search"}</button>
    </form>

    {error && <div className="cdl-message error" role="alert">{error}</div>}
    {message && <div className="cdl-message" role="status">{message}</div>}

    {results && <div className="cdl-toolbar bkr-actions">
      <span><strong>{albums.length}</strong> album{albums.length === 1 ? "" : "s"} · page {results.page} of {results.pages}</span>
      <button disabled={!albums.length} onClick={() => setSelected(selected.size === albums.length ? new Set() : new Set(albums.map((album) => album.url)))}>
        {selected.size === albums.length && albums.length > 0 ? "Clear selection" : "Select all"}
      </button>
      <span className="cdl-muted">{selected.size ? `${selected.size} selected` : "Nothing selected — every album is used"}</span>
      <span className="spacer" />
      <button disabled={busy || results.page <= 1} onClick={() => search(results.page - 1)}>Previous</button>
      <button disabled={busy || results.page >= results.pages} onClick={() => search(results.page + 1)}>Next</button>
      <button disabled={!albums.length} onClick={saveList}>Save .txt</button>
      <button disabled={busy || !albums.length || !repo} title={repo ? undefined : "Connect the Cyberdrop plugin to an installation first"} onClick={sendToCyberdrop}>Send to Cyberdrop</button>
    </div>}

    {albums.length > 0 && <ul className="bkr-results">
      {albums.map((album) => <li key={album.url} className={selected.has(album.url) ? "selected" : ""}>
        <label>
          <input type="checkbox" aria-label={album.title || album.url} checked={selected.has(album.url)} onChange={() => toggle(album.url)} />
          {album.thumbnail
            ? <img className="bkr-thumb" src={album.thumbnail} alt="" loading="lazy" />
            : <span className="bkr-thumb empty" aria-hidden="true" />}
          <span className="bkr-title">{album.title || album.url}</span>
          <span className="bkr-files">{album.files == null ? "" : `${album.files} file${album.files === 1 ? "" : "s"}`}</span>
          <span className="bkr-url" title={album.url}>{album.url}</span>
        </label>
      </li>)}
    </ul>}

    {!results && !busy && <div className="cdl-empty">
      Search the public album index, tick what you want, and save the links as a .txt
      list — or send them straight to the Cyberdrop plugin as a URL workstation.
    </div>}
  </div>;
}
