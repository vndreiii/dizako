/**
 * Auto-update from GitHub Releases (Windows and Linux AppImage only).
 *
 * Uses Tauri minisign (free) — not Authenticode / Apple notarization.
 * SmartScreen / Gatekeeper warnings on first install are expected without
 * paid OS certificates.
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Check GitHub latest.json; if newer, download, install, and relaunch. */
export async function checkAndInstallUpdates(
  onStatus?: (msg: string) => void,
): Promise<void> {
  if (!isTauri()) return;

  try {
    // The runtime knows whether this Linux process came from an AppImage.
    // A build-time platform flag cannot distinguish it from a deb/rpm install.
    if (!(await invoke<boolean>("supports_autoupdate"))) return;
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
