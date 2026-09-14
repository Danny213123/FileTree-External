import { beforeEach, describe, expect, it } from "vitest";
import {
  PLUGINS,
  canOptIn,
  countOptedIn,
  getPlugin,
  isOptedIn,
  loadPluginPrefs,
  savePluginPrefs,
  setOptIn,
  type PluginPrefs,
} from "./plugins";

const KEY = "filetree_plugins";

describe("plugin registry", () => {
  it("gives every entry a unique id", () => {
    const ids = PLUGINS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("describes what it needs and what it does, so the opt-in is informed", () => {
    for (const def of PLUGINS) {
      expect(def.needs.length, `${def.id} needs`).toBeGreaterThan(0);
      expect(def.provides.length, `${def.id} provides`).toBeGreaterThan(0);
      expect(def.summary.length, `${def.id} summary`).toBeGreaterThan(0);
    }
  });

  it("blocks opting in to anything that has not shipped", () => {
    expect(canOptIn({ ...PLUGINS[0], status: "planned" })).toBe(false);
    expect(canOptIn({ ...PLUGINS[0], status: "available" })).toBe(true);
    expect(canOptIn({ ...PLUGINS[0], status: "preview" })).toBe(true);
  });

  it("looks entries up by id", () => {
    expect(getPlugin(PLUGINS[0].id)).toBe(PLUGINS[0]);
    expect(getPlugin("nope")).toBeUndefined();
  });
});

describe("opt-in preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to nothing opted in", () => {
    expect(loadPluginPrefs()).toEqual({});
    expect(countOptedIn({})).toBe(0);
  });

  it("round-trips through storage", () => {
    const prefs = setOptIn({}, "everything", true);
    savePluginPrefs(prefs);
    expect(isOptedIn(loadPluginPrefs(), "everything")).toBe(true);
  });

  it("treats opting out as off without forgetting the original date", () => {
    const on = setOptIn({}, "everything", true);
    const off = setOptIn(on, "everything", false);
    expect(isOptedIn(off, "everything")).toBe(false);
    expect(off.everything.since).toBe(on.everything.since);
  });

  it("does not mutate the prefs it is handed", () => {
    const before: PluginPrefs = {};
    setOptIn(before, "everything", true);
    expect(before).toEqual({});
  });

  it("survives corrupt or hand-edited storage", () => {
    localStorage.setItem(KEY, "not json");
    expect(loadPluginPrefs()).toEqual({});

    localStorage.setItem(KEY, JSON.stringify(["everything"]));
    expect(loadPluginPrefs()).toEqual({});

    localStorage.setItem(KEY, JSON.stringify({ everything: "yes", rclone: { enabled: true, since: 1 } }));
    expect(loadPluginPrefs()).toEqual({ rclone: { enabled: true, since: 1 } });
  });

  it("counts only registered plugins, so stale ids never inflate the badge", () => {
    const prefs = setOptIn(setOptIn({}, PLUGINS[0].id, true), "removed-last-release", true);
    expect(countOptedIn(prefs)).toBe(1);
  });

  it("keeps consent for a plugin that is temporarily pulled", () => {
    savePluginPrefs(setOptIn({}, "removed-last-release", true));
    expect(isOptedIn(loadPluginPrefs(), "removed-last-release")).toBe(true);
  });
});
