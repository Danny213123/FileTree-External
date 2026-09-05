import type { AppSettings } from "../api/client";

export const SESSION_SHADOW_KEY = "filetree_session_shadow_v2";

interface SessionShadow {
  savedAt: number;
  settings: AppSettings;
}

export function writeSessionShadow(settings: AppSettings): void {
  try {
    const savedAt = settings.sessionSavedAt ?? Date.now();
    localStorage.setItem(
      SESSION_SHADOW_KEY,
      JSON.stringify({ savedAt, settings } satisfies SessionShadow),
    );
  } catch {
    // Storage can be disabled or full. SQLite remains the primary store.
  }
}

export function readSessionShadow(): AppSettings | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_SHADOW_KEY) ?? "null") as
      | Partial<SessionShadow>
      | null;
    if (!parsed || typeof parsed.savedAt !== "number" || !parsed.settings || typeof parsed.settings !== "object") {
      return null;
    }
    return {
      ...parsed.settings,
      sessionSavedAt: parsed.settings.sessionSavedAt ?? parsed.savedAt,
    };
  } catch {
    return null;
  }
}

/** Prefer the synchronous close/crash shadow only when it is newer than the
 * durable backend snapshot. Both documents are complete settings snapshots. */
export function newestSessionSettings(
  persisted: AppSettings,
  shadow: AppSettings | null = readSessionShadow(),
): AppSettings {
  if (!shadow) return persisted;
  return (shadow.sessionSavedAt ?? 0) > (persisted.sessionSavedAt ?? 0)
    ? shadow
    : persisted;
}
