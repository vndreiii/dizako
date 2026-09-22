/** Signed GitHub Releases updates for Windows and Linux AppImage. */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke, isTauri } from "@tauri-apps/api/core";

const CHOICE_KEY = "dizako-update-choice.v1";
export const LATER_MS = 24 * 60 * 60 * 1000;

interface UpdateChoice {
  version: string;
  dismissed?: boolean;
  laterUntil?: number;
}

/** A dismissed version stays hidden; Later is offered again after 24 hours. */
export function updatePromptDelay(version: string, now = Date.now()): number | null {
  try {
    const choice = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "null") as UpdateChoice | null;
    if (choice?.version !== version) return 0;
    if (choice.dismissed) return null;
    return Math.max(0, (choice.laterUntil ?? 0) - now);
  } catch {
    return 0;
  }
}

export function rememberUpdateChoice(version: string, choice: "later" | "dismiss", now = Date.now()) {
  try {
    localStorage.setItem(
      CHOICE_KEY,
      JSON.stringify({ version, ...(choice === "later" ? { laterUntil: now + LATER_MS } : { dismissed: true }) }),
    );
  } catch (err) {
    console.warn("[dizako] could not save update choice", err);
  }
}

/** Checking never downloads or installs an update. */
export async function checkForUpdates(): Promise<Update | null> {
  if (!isTauri()) return null;
  // A Linux deb/rpm installation cannot be updated with an AppImage package.
  if (!(await invoke<boolean>("supports_autoupdate"))) return null;
  return check();
}

export async function installUpdate(update: Update, onStatus: (status: "downloading" | "restarting") => void) {
  onStatus("downloading");
  await update.downloadAndInstall();
  onStatus("restarting");
  await relaunch();
}
