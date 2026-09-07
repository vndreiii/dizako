/**
 * Auto-update from GitHub Releases (Windows + macOS only).
 *
 * Uses Tauri minisign (free) — not Authenticode / Apple notarization.
 * SmartScreen / Gatekeeper warnings on first install are expected without
 * paid OS certificates.
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

function supportsUpdater(): boolean {
  // Set by `@tauri-apps/cli` during `tauri build` / `tauri dev`.
  const platform = import.meta.env.TAURI_ENV_PLATFORM as string | undefined;
  return platform === "windows" || platform === "macos";
}

/** Check GitHub latest.json; if newer, download, install, and relaunch. */
export async function checkAndInstallUpdates(
  onStatus?: (msg: string) => void,
): Promise<void> {
  if (!supportsUpdater()) return;
  if (!("__TAURI_INTERNALS__" in window)) return;

  try {
    const update = await check();
    if (!update) return;

    onStatus?.(`Updating to ${update.version}…`);
    await update.downloadAndInstall();
    onStatus?.("Restarting…");
    await relaunch();
  } catch (err) {
    console.warn("[dizako] update check failed", err);
  }
}
