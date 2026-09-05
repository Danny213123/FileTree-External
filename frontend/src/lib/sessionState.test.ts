import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_SHADOW_KEY,
  newestSessionSettings,
  readSessionShadow,
  writeSessionShadow,
} from "./sessionState";

describe("session close shadow", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips the complete latest session", () => {
    const settings = {
      sessionSavedAt: 20,
      openTabs: ["C:\\Users", "D:\\Media"],
      focusedGroupIndex: 1,
      sidebarWidth: 312,
      terminalHeight: 280,
      tabState: [{ metric: "allocated", columnWidths: { name: 420 } }],
    };

    writeSessionShadow(settings);

    expect(readSessionShadow()).toEqual(settings);
  });

  it("prefers a newer close shadow over an older durable save", () => {
    const durable = { sessionSavedAt: 10, openTabs: ["C:\\Old"] };
    const shadow = { sessionSavedAt: 11, openTabs: ["C:\\Latest"] };

    expect(newestSessionSettings(durable, shadow)).toEqual(shadow);
    expect(newestSessionSettings(shadow, durable)).toEqual(shadow);
  });

  it("ignores malformed shadow data", () => {
    localStorage.setItem(SESSION_SHADOW_KEY, "{not-json");
    expect(readSessionShadow()).toBeNull();
  });
});
