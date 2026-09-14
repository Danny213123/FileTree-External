import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DENSITY,
  ROW_HEIGHTS,
  applyMetrics,
  applyReduceMotion,
  loadDensity,
  loadThemeMode,
  resolveDark,
  rowHeightFor,
  saveDensity,
  saveThemeMode,
} from "./appearance";

/** Point matchMedia at a fixed OS preference. */
function stubSystemDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: dark && query.includes("dark"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.motion;
});

describe("row metrics", () => {
  it("maps each density to its own row height", () => {
    expect(rowHeightFor("compact", 12)).toBe(ROW_HEIGHTS.compact);
    expect(rowHeightFor("normal", 12)).toBe(ROW_HEIGHTS.normal);
    expect(rowHeightFor("relaxed", 12)).toBe(ROW_HEIGHTS.relaxed);
  });

  it("keeps the pre-pref 23px layout as the default", () => {
    expect(rowHeightFor(DEFAULT_DENSITY, 12)).toBe(23);
  });

  it("raises a short row to fit larger text rather than clipping it", () => {
    // Compact is 19px, which cannot hold 16px text with its descenders.
    expect(rowHeightFor("compact", 16)).toBeGreaterThan(ROW_HEIGHTS.compact);
    expect(rowHeightFor("compact", 16)).toBe(23);
  });

  it("clamps a text size from outside the supported range", () => {
    expect(rowHeightFor("normal", 999)).toBe(23);
    expect(rowHeightFor("normal", Number.NaN)).toBe(23);
  });

  it("publishes both metrics as CSS variables", () => {
    applyMetrics("relaxed", 14);
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--row-h")).toBe("28px");
    expect(style.getPropertyValue("--ui-font-size")).toBe("14px");
  });
});

describe("theme mode", () => {
  it("reports no stored mode on a fresh install", () => {
    // Null is what makes the session `darkMode` fallback kick in on upgrade.
    expect(loadThemeMode()).toBeNull();
  });

  it("round-trips a stored mode", () => {
    saveThemeMode("system");
    expect(loadThemeMode()).toBe("system");
  });

  it("ignores a stored value that is not a mode", () => {
    localStorage.setItem("filetree_theme_mode", "sepia");
    expect(loadThemeMode()).toBeNull();
  });

  it("pins light and dark regardless of the OS", () => {
    stubSystemDark(true);
    expect(resolveDark("light")).toBe(false);
    expect(resolveDark("dark")).toBe(true);
  });

  it("follows the OS for system", () => {
    stubSystemDark(true);
    expect(resolveDark("system")).toBe(true);
    stubSystemDark(false);
    expect(resolveDark("system")).toBe(false);
  });

  it("falls back to light when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveDark("system")).toBe(false);
  });
});

describe("density persistence", () => {
  it("round-trips a density", () => {
    saveDensity("compact");
    expect(loadDensity()).toBe("compact");
  });

  it("falls back to the default for an unrecognized value", () => {
    localStorage.setItem("filetree_row_density", "roomy");
    expect(loadDensity()).toBe(DEFAULT_DENSITY);
  });
});

describe("reduce motion", () => {
  it("toggles the attribute the stylesheet matches", () => {
    applyReduceMotion(true);
    expect(document.documentElement.dataset.motion).toBe("reduce");
    applyReduceMotion(false);
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });
});
