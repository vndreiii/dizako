/**
 * Opt-in timeline tracing.
 *
 * Off by default and then costs one boolean test per call. Switch it on from the
 * console with `localStorage.setItem("dizako-trace", "1")` and reload, and every
 * mark is logged with its time since page start - enough to see where the time
 * between "file chosen" and "picture on screen" actually went, which is the
 * question a profiler on one thread cannot answer when the work is spread across
 * a worker and a decoder.
 */
let enabled = false;
try {
  enabled = typeof localStorage !== "undefined" && localStorage.getItem("dizako-trace") === "1";
} catch {
  enabled = false;
}

export function trace(label: string, detail?: Record<string, unknown>): void {
  if (!enabled) return;
  const at = Math.round(performance.now());
  console.info(`[trace] +${at}ms ${label}${detail ? " " + JSON.stringify(detail) : ""}`);
}
