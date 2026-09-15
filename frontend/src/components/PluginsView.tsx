// Plugins page: the catalog of approved plugins and the opt-in switch for each.
//
// The tab strip mirrors Duplicates and Compress — a catalog tab first, then one
// tab per plugin. A plugin's tab shows the pitch and the opt-in button while it
// is off; once it is on, the plugin's own panel takes over the tab body and
// FileTree keeps only a thin header above it.
//
// Both the strip and the catalog grid are driven by the PLUGINS registry, so
// shipping a new plugin needs no change here.

import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import {
  PLUGINS,
  STATUS_LABELS,
  canOptIn,
  countOptedIn,
  isOptedIn,
  loadPluginPrefs,
  savePluginPrefs,
  setOptIn,
  type PluginDef,
  type PluginPrefs,
} from "../lib/plugins";

const CATALOG_TAB = "catalog";

type ToggleFn = (id: string, enabled: boolean) => void;

export function PluginsView() {
  const [prefs, setPrefs] = useState<PluginPrefs>(loadPluginPrefs);
  const [tab, setTab] = useState<string>(CATALOG_TAB);

  const toggle = useCallback<ToggleFn>((id, enabled) => {
    const apply = () => setPrefs((prev) => {
      const next = setOptIn(prev, id, enabled);
      savePluginPrefs(next);
      return next;
    });
    if (id === "cyberdrop" && enabled) {
      void invoke("cyberdrop_workspace", { repo: localStorage.getItem("filetree.cyberdrop.repo") || "C:\\Tools\\CyberDropDownloader", request: { action: "init" } })
        .then(apply).catch(error => { apply(); toast.error(String(error)); });
    } else apply();
  }, []);

  const active = PLUGINS.find((d) => d.id === tab) ?? null;

  return (
    <div className="plg-view">
      <div className="plg-tabstrip" role="tablist" aria-label="Plugins">
        <button
          type="button"
          role="tab"
          aria-selected={tab === CATALOG_TAB}
          className={`plg-tab${tab === CATALOG_TAB ? " active" : ""}`}
          onClick={() => setTab(CATALOG_TAB)}
        >
          Catalog
          {PLUGINS.length > 0 && (
            <span className="plg-tab-badge">{countOptedIn(prefs)}/{PLUGINS.length}</span>
          )}
        </button>
        {PLUGINS.map((def) => (
          <button
            key={def.id}
            type="button"
            role="tab"
            aria-selected={tab === def.id}
            className={`plg-tab${tab === def.id ? " active" : ""}`}
            onClick={() => setTab(def.id)}
          >
            <span
              className={`plg-dot${isOptedIn(prefs, def.id) ? " on" : ""}`}
              title={isOptedIn(prefs, def.id) ? "Enabled" : "Not enabled"}
            />
            {def.name}
          </button>
        ))}
      </div>

      {active
        ? <PluginTab def={active} prefs={prefs} onToggle={toggle} />
        : (
          <div className="plg-body" role="tabpanel">
            <Catalog prefs={prefs} onToggle={toggle} onOpen={setTab} />
          </div>
        )}
    </div>
  );
}

/** Status chip. Being enabled outranks the shipping status. */
function StatusPill({ def, optedIn }: { def: PluginDef; optedIn: boolean }) {
  if (optedIn) return <span className="plg-pill on">Enabled</span>;
  return <span className={`plg-pill ${def.status}`}>{STATUS_LABELS[def.status]}</span>;
}

function OptInButton({
  def, optedIn, onToggle, wide,
}: { def: PluginDef; optedIn: boolean; onToggle: ToggleFn; wide?: boolean }) {
  const usable = canOptIn(def);
  const label = optedIn ? "Opt out" : usable ? "Opt in" : "Not available yet";
  return (
    <button
      type="button"
      className={`plg-btn${!optedIn && usable ? " primary" : ""}${wide ? " wide" : ""}`}
      disabled={!usable}
      title={usable ? undefined : `${def.name} has not shipped yet`}
      onClick={() => onToggle(def.id, !optedIn)}
    >
      {optedIn && <Icon name="check" size={13} />}
      {label}
    </button>
  );
}

function Catalog({
  prefs, onToggle, onOpen,
}: { prefs: PluginPrefs; onToggle: ToggleFn; onOpen: (id: string) => void }) {
  if (PLUGINS.length === 0) {
    return (
      <div className="plg-empty">
        <Icon name="tools" size={30} />
        <h2>No plugins yet</h2>
        <p>Approved plugins will be listed here, each one off until you opt in.</p>
      </div>
    );
  }

  return (
    <div className="plg-catalog">
      <header className="plg-intro">
        <h1>Plugins</h1>
        <p>
          Third-party tools that run on top of FileTree. Each one gets its own tab
          here once you turn it on, and stays out of the rest of the app. Everything
          is off by default, and opting back out takes effect immediately.
        </p>
      </header>

      {PLUGINS.some((d) => d.example) && (
        <p className="plg-note">
          <Icon name="info-circle" size={13} />
          <span>
            No plugin has shipped yet. The entries below are approved candidates,
            listed so the opt-in flow is visible before the first one lands.
          </span>
        </p>
      )}

      <div className="plg-grid">
        {PLUGINS.map((def) => {
          const optedIn = isOptedIn(prefs, def.id);
          return (
            <article key={def.id} className={`plg-card${optedIn ? " on" : ""}`}>
              <div className="plg-card-head">
                <span className="plg-glyph"><Icon name={def.icon} size={17} /></span>
                <div className="plg-ident">
                  <h3>{def.name}</h3>
                  <span className="plg-vendor">{def.vendor}</span>
                </div>
                <StatusPill def={def} optedIn={optedIn} />
              </div>
              <p className="plg-summary">{def.summary}</p>
              <div className="plg-card-foot">
                <OptInButton def={def} optedIn={optedIn} onToggle={onToggle} />
                <button type="button" className="plg-btn ghost" onClick={() => onOpen(def.id)}>
                  {optedIn ? "Open" : "Details"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PluginHero({
  def, optedIn, onToggle, compact,
}: { def: PluginDef; optedIn: boolean; onToggle: ToggleFn; compact?: boolean }) {
  return (
    <header className={`plg-hero${compact ? " compact" : ""}`}>
      <span className="plg-glyph lg"><Icon name={def.icon} size={compact ? 17 : 24} /></span>
      <div className="plg-ident">
        {compact ? <h2>{def.name}</h2> : <h1>{def.name}</h1>}
        <span className="plg-vendor">
          {def.vendor}{def.website ? ` · ${def.website}` : ""}
          {def.example && <span className="plg-tag">Example listing</span>}
        </span>
      </div>
      <StatusPill def={def} optedIn={optedIn} />
      <OptInButton def={def} optedIn={optedIn} onToggle={onToggle} wide />
    </header>
  );
}

function PluginTab({
  def, prefs, onToggle,
}: { def: PluginDef; prefs: PluginPrefs; onToggle: ToggleFn }) {
  const optedIn = isOptedIn(prefs, def.id);

  // Off: FileTree's own description of the plugin, scrolling like any other page.
  if (!optedIn) {
    return (
      <div className="plg-body" role="tabpanel">
        <article className="plg-detail">
          <PluginHero def={def} optedIn={false} onToggle={onToggle} />
          <p className="plg-about">{def.about}</p>

          <section className="plg-section">
            <h2>What it needs from FileTree</h2>
            <ul className="plg-list">
              {def.needs.map((line) => <li key={line}><Icon name="check" size={12} />{line}</li>)}
            </ul>
          </section>

          <section className="plg-section">
            <h2>What it does</h2>
            <ul className="plg-list">
              {def.provides.map((line) => <li key={line}><Icon name="check" size={12} />{line}</li>)}
            </ul>
          </section>

          <p className="plg-foot">
            {canOptIn(def)
              ? `Opting in gives ${def.name} this tab to draw in. It does not install anything, and it changes nothing elsewhere in FileTree.`
              : `${def.name} is on the roadmap. This tab will let you opt in once it ships.`}
          </p>
        </article>
      </div>
    );
  }

  // On: the plugin owns the tab body. FileTree keeps only the header strip so
  // there is always somewhere to opt back out from.
  const Panel = def.panel;
  return (
    <div className="plg-hosted" role="tabpanel">
      <PluginHero def={def} optedIn onToggle={onToggle} compact />
      <div className="plg-surface">
        {Panel ? <Panel plugin={def} /> : <PluginSurfacePlaceholder def={def} />}
      </div>
    </div>
  );
}

/**
 * Stand-in for a plugin that has no panel yet. Occupies the space the real UI
 * would, so the layout is honest about who owns this area without pretending
 * the plugin does anything.
 */
function PluginSurfacePlaceholder({ def }: { def: PluginDef }) {
  return (
    <div className="plg-placeholder">
      <Icon name={def.icon} size={26} />
      <h3>{def.name} draws here</h3>
      <p>
        An enabled plugin owns this whole area and renders its own interface in it.
        {def.example && " This is an example listing, so there is no interface to load."}
      </p>
      <ul className="plg-placeholder-list">
        {def.provides.map((line) => <li key={line}>{line}</li>)}
      </ul>
    </div>
  );
}
