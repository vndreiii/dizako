import { DEFAULT_SETTINGS, type Settings } from "./dither/types";
import type { Mode, ThemeSource } from "./theme/theme";

/**
 * Session persistence.
 *
 * localStorage is used deliberately over Tauri's AppConfig directory: it works
 * identically in browser mode and inside the WebView (whose profile persists
 * under the OS data dir), needs no permissions, and loads synchronously so
 * there is no restore flash. One versioned key holds everything that used to
 * reset on every launch.
 */
const KEY = "dizako-session.v1";

export interface Appearance {
  mode: Mode;
  themeSource: ThemeSource;
  seed: string;
  /** How many steps one wheel notch applies to any slider (1..10). */
  wheelStep?: number;
}

interface StoredSession {
  version: 1;
  settings: Partial<Settings>;
  appearance: Partial<Appearance>;
}

export function loadSession(): {
  settings: Settings | null;
  appearance: Appearance | null;
} {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { settings: null, appearance: null };
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed.version !== 1) return { settings: null, appearance: null };
    // Merge over defaults so sessions saved by older versions still load and
    // newly added settings fall back rather than arriving undefined.
    const settings = parsed.settings
      ? ({ ...DEFAULT_SETTINGS, ...parsed.settings } as Settings)
      : null;
    const appearance =
      parsed.appearance && (parsed.appearance.mode || parsed.appearance.seed)
        ? (parsed.appearance as Appearance)
        : null;
    return { settings, appearance };
  } catch {
    return { settings: null, appearance: null };
  }
}

export function saveSession(settings: Settings, appearance: Appearance): void {
  try {
    const payload: StoredSession = {
      version: 1,
      settings,
      appearance,
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Could not persist session", err);
  }
}
