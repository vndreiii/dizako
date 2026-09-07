/**
 * External donation page opened by the topbar Donate button.
 */
export const DONATE_URL = "https://ko-fi.com/vndreiii";

/**
 * Try to open the donation page in the system browser.
 * Returns false when both Tauri opener and window.open fail — callers
 * should show the in-app donate dialog with a copy-URL fallback.
 */
export async function openDonatePage(): Promise<boolean> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(DONATE_URL);
    return true;
  } catch {
    // Fall through to window.open (dev / non-Tauri).
  }
  try {
    const w = window.open(DONATE_URL, "_blank", "noopener,noreferrer");
    return w != null;
  } catch {
    return false;
  }
}
