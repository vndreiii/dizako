/**
 * The app's failure vocabulary.
 *
 * Every user-visible failure in Dizako resolves to one `AppError` with a
 * stable `code`. That buys three things a bare `throw new Error(...)` cannot:
 *
 * - **Translatable copy.** The code selects `error.<code>.title` /
 *   `error.<code>.body` from the locale bundle, so a failure is never raw
 *   English inside a Japanese UI.
 * - **A recovery affordance.** `recovery` names the action worth offering
 *   ("pick another file", "try a smaller clip"), which is what turns a dead
 *   end into a next step.
 * - **Diagnostics.** `detail` carries the machine-facing text - stack,
 *   platform string, codec list - shown behind a disclosure rather than in
 *   the headline, and copyable in one click for a bug report.
 *
 * The codes are exhaustive by construction: `AppErrorCode` is a closed union,
 * so adding a failure path without giving it copy is a type error.
 */

export type AppErrorCode =
  // ---- image import ----
  | "image/not-an-image"
  | "image/decode-failed"
  | "image/empty-after-decode"
  | "image/no-2d-context"
  | "image/too-large"
  | "image/read-failed"
  // ---- render engine ----
  | "engine/unavailable"
  | "engine/worker-demoted"
  | "engine/render-timeout"
  // ---- export ----
  | "export/render-failed"
  | "export/encode-failed"
  | "export/write-failed"
  | "export/no-source"
  // ---- video import ----
  | "video/not-a-video"
  | "video/decode-failed"
  | "video/no-metadata"
  | "video/no-frames"
  | "video/seek-timeout"
  | "video/frame-grab-failed"
  | "video/too-long"
  // ---- video export ----
  | "video/export-unsupported"
  | "video/export-recorder-failed"
  | "video/export-no-frames"
  | "video/export-write-failed"
  | "video/export-cancelled"
  // ---- session / platform ----
  | "session/save-failed"
  | "session/corrupt"
  | "theme/matugen-unreadable"
  | "theme/matugen-invalid"
  | "update/check-failed"
  | "update/install-failed"
  | "clipboard/denied"
  | "platform/needs-app"
  // ---- catch-all ----
  | "app/crashed"
  | "app/unhandled"
  | "app/unknown";

/**
 * What the UI should offer the user next. The notification layer turns this
 * into a real button; `none` means the message is informational.
 */
export type Recovery =
  | "none"
  | "retry"
  | "pick-another-file"
  | "reload"
  | "reset-settings"
  | "open-settings"
  | "report";

export interface AppError {
  readonly isAppError: true;
  code: AppErrorCode;
  /** Machine-facing text: original message, stack, capability dumps. */
  detail?: string;
  /** Substituted into the localised body, `{name}` → `values.name`. */
  values?: Record<string, string | number>;
  recovery: Recovery;
  /** `error` blocks the task; `warning` means it continued in a lesser mode. */
  severity: "error" | "warning";
  cause?: unknown;
}

/** Recovery offered per code, so call sites never have to remember. */
const RECOVERY: Record<AppErrorCode, Recovery> = {
  "image/not-an-image": "pick-another-file",
  "image/decode-failed": "pick-another-file",
  "image/empty-after-decode": "pick-another-file",
  "image/no-2d-context": "reload",
  "image/too-large": "none",
  "image/read-failed": "retry",

  "engine/unavailable": "reload",
  "engine/worker-demoted": "none",
  "engine/render-timeout": "retry",

  "export/render-failed": "retry",
  "export/encode-failed": "retry",
  "export/write-failed": "retry",
  "export/no-source": "pick-another-file",

  "video/not-a-video": "pick-another-file",
  "video/decode-failed": "pick-another-file",
  "video/no-metadata": "pick-another-file",
  "video/no-frames": "pick-another-file",
  "video/seek-timeout": "retry",
  "video/frame-grab-failed": "retry",
  "video/too-long": "none",

  "video/export-unsupported": "none",
  "video/export-recorder-failed": "retry",
  "video/export-no-frames": "none",
  "video/export-write-failed": "retry",
  "video/export-cancelled": "none",

  "session/save-failed": "none",
  "session/corrupt": "reset-settings",
  "theme/matugen-unreadable": "open-settings",
  "theme/matugen-invalid": "open-settings",
  "update/check-failed": "none",
  "update/install-failed": "retry",
  "clipboard/denied": "none",
  "platform/needs-app": "none",

  "app/crashed": "reload",
  "app/unhandled": "report",
  "app/unknown": "report",
};

/** Codes that describe a degraded-but-working state rather than a dead end. */
const WARNINGS: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  "engine/worker-demoted",
  "image/too-large",
  "session/save-failed",
  "theme/matugen-unreadable",
  "theme/matugen-invalid",
  "update/check-failed",
  "clipboard/denied",
  "platform/needs-app",
  "video/export-cancelled",
]);

export function appError(
  code: AppErrorCode,
  options: {
    detail?: string;
    values?: Record<string, string | number>;
    cause?: unknown;
    recovery?: Recovery;
    severity?: "error" | "warning";
  } = {},
): AppError {
  return {
    isAppError: true,
    code,
    detail: options.detail,
    values: options.values,
    cause: options.cause,
    recovery: options.recovery ?? RECOVERY[code],
    severity: options.severity ?? (WARNINGS.has(code) ? "warning" : "error"),
  };
}

export function isAppError(value: unknown): value is AppError {
  return typeof value === "object" && value !== null && (value as AppError).isAppError === true;
}

/**
 * Coerces anything thrown into an `AppError`.
 *
 * Unknown throws are the ones that used to reach the user as
 * "[object Object]" or vanish into the console; they land on
 * `app/unknown` with the raw text kept as diagnostics.
 */
export function toAppError(value: unknown, fallback: AppErrorCode = "app/unknown"): AppError {
  if (isAppError(value)) return value;
  return appError(fallback, { detail: describeThrown(value), cause: value });
}

/** Best-effort human-readable rendering of an arbitrary throw. */
export function describeThrown(value: unknown): string {
  if (value == null) return "(no error value)";
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`;
  }
  if (value instanceof Event) {
    const target = value.target as { error?: { message?: string } } | null;
    return target?.error?.message ?? `${value.type} event`;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** One-line summary for a toast; the full text stays in `detail`. */
export function shortDetail(detail: string | undefined, max = 160): string {
  if (!detail) return "";
  const line = detail.split("\n", 1)[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Environment snapshot appended to copied diagnostics.
 *
 * A bug report without this is a guessing game: nearly every failure that
 * reaches these codes is host-specific (WebKitGTK version, missing
 * OffscreenCanvas, absent codecs).
 */
export function diagnostics(extra: Record<string, unknown> = {}): string {
  const capability = (name: string, present: boolean) => `${name}=${present ? "yes" : "no"}`;
  const lines = [
    `dizako ${__APP_VERSION__}`,
    `ua: ${typeof navigator === "undefined" ? "n/a" : navigator.userAgent}`,
    `tauri: ${typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "yes" : "no"}`,
    [
      capability("worker", typeof Worker !== "undefined"),
      capability("offscreen", typeof OffscreenCanvas !== "undefined"),
      capability("imagebitmap", typeof createImageBitmap === "function"),
      capability("mediarecorder", typeof MediaRecorder !== "undefined"),
      capability("videoframecb", typeof HTMLVideoElement !== "undefined" &&
        "requestVideoFrameCallback" in HTMLVideoElement.prototype),
      capability("webcodecs", typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== "undefined"),
    ].join(" "),
    `dpr: ${typeof window === "undefined" ? "n/a" : window.devicePixelRatio}`,
  ];
  for (const [key, value] of Object.entries(extra)) {
    lines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return lines.join("\n");
}
