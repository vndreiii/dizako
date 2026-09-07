/**
 * External donation page opened by the topbar Donate button.
 *
 * Replace with your real link, e.g.:
 * - https://ko-fi.com/yourname
 * - https://github.com/sponsors/yourname
 * - https://paypal.me/yourname
 * - https://buymeacoffee.com/yourname
 */
export const DONATE_URL = "https://ko-fi.com/vndreiii";

/** Open the donation URL in the system browser (Tauri) or a new tab (web). */
export async function openDonatePage(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(DONATE_URL);
  } catch {
    window.open(DONATE_URL, "_blank", "noopener,noreferrer");
  }
}
