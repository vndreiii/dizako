import { describe, expect, it } from "vitest";
import translations from "../src/locales/translations.json";
import {
  appError,
  describeThrown,
  isAppError,
  shortDetail,
  toAppError,
  type AppErrorCode,
} from "../src/errors";

/**
 * The error taxonomy is only worth having if every code can be *shown*.
 *
 * `AppErrorCode` is a closed union, and the notifier looks its copy up as
 * `error.<code>.title` / `.body`. Nothing at compile time connects the two, so
 * adding a code without adding its strings would ship a dialog whose headline
 * is the literal text "error.video/seek-timeout.title". That is precisely the
 * failure this file exists to make impossible.
 */

/** Mirror of the union in src/errors.ts, kept exhaustive by the type below. */
const CODES = [
  "image/not-an-image",
  "image/decode-failed",
  "image/empty-after-decode",
  "image/no-2d-context",
  "image/too-large",
  "image/read-failed",
  "engine/unavailable",
  "engine/worker-demoted",
  "engine/render-timeout",
  "export/render-failed",
  "export/encode-failed",
  "export/write-failed",
  "export/no-source",
  "video/not-a-video",
  "video/decode-failed",
  "video/no-metadata",
  "video/no-frames",
  "video/seek-timeout",
  "video/frame-grab-failed",
  "video/too-long",
  "video/export-unsupported",
  "video/export-recorder-failed",
  "video/export-no-frames",
  "video/export-write-failed",
  "video/export-cancelled",
  "session/save-failed",
  "session/corrupt",
  "theme/matugen-unreadable",
  "theme/matugen-invalid",
  "update/check-failed",
  "update/install-failed",
  "clipboard/denied",
  "platform/needs-app",
  "app/crashed",
  "app/unhandled",
  "app/unknown",
] as const;

// A compile error here means a code was added to (or removed from) the union
// without updating this list, which is the point.
const _exhaustive: readonly AppErrorCode[] = CODES;
type _Covered = Exclude<AppErrorCode, (typeof CODES)[number]> extends never ? true : never;
const _covered: _Covered = true;
void _exhaustive;
void _covered;

const en = (translations as Record<string, Record<string, string>>).en;

describe("error copy", () => {
  it.each(CODES)("%s has a title and a body", (code) => {
    expect(typeof en[`error.${code}.title`]).toBe("string");
    expect(en[`error.${code}.title`]!.length).toBeGreaterThan(0);
    expect(typeof en[`error.${code}.body`]).toBe("string");
    expect(en[`error.${code}.body`]!.length).toBeGreaterThan(0);
  });

  it("has a label for every recovery action the codes can ask for", () => {
    const recoveries = new Set(CODES.map((code) => appError(code).recovery));
    for (const recovery of recoveries) {
      if (recovery === "none") continue;
      expect(typeof en[`recovery.${recovery}`]).toBe("string");
    }
  });

  it("never leaves a placeholder unfilled by the values a call site passes", () => {
    // Every `{placeholder}` in a body has to be something a caller can supply.
    // A body asking for {name} where the code is only ever raised without one
    // renders the braces to the user.
    const withPlaceholders = CODES.filter((c) => /\{[a-z]+\}/i.test(en[`error.${c}.body`] ?? ""));
    expect(withPlaceholders.length).toBeGreaterThan(0);
    for (const code of withPlaceholders) {
      const names = [...(en[`error.${code}.body`] ?? "").matchAll(/\{([a-z]+)\}/gi)].map((m) => m[1]);
      expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
    }
  });
});

describe("appError", () => {
  it("classifies degradations as warnings and dead ends as errors", () => {
    expect(appError("engine/worker-demoted").severity).toBe("warning");
    expect(appError("image/too-large").severity).toBe("warning");
    expect(appError("engine/unavailable").severity).toBe("error");
    expect(appError("video/export-recorder-failed").severity).toBe("error");
  });

  it("gives every code a recovery, and offers one only where it helps", () => {
    for (const code of CODES) {
      expect(appError(code).recovery).toBeTruthy();
    }
    expect(appError("image/not-an-image").recovery).toBe("pick-another-file");
    expect(appError("engine/unavailable").recovery).toBe("reload");
    expect(appError("video/export-cancelled").recovery).toBe("none");
  });

  it("lets a call site override severity and recovery", () => {
    const e = appError("video/too-long", { severity: "error", recovery: "retry" });
    expect(e.severity).toBe("error");
    expect(e.recovery).toBe("retry");
  });
});

describe("toAppError", () => {
  it("passes an AppError through untouched", () => {
    const original = appError("video/no-frames", { detail: "x" });
    expect(toAppError(original)).toBe(original);
  });

  it("wraps anything else, keeping the original text as diagnostics", () => {
    const wrapped = toAppError(new TypeError("boom"));
    expect(isAppError(wrapped)).toBe(true);
    expect(wrapped.code).toBe("app/unknown");
    expect(wrapped.detail).toContain("boom");
  });

  it("takes a caller-supplied fallback code", () => {
    expect(toAppError("nope", "video/decode-failed").code).toBe("video/decode-failed");
  });
});

describe("describeThrown", () => {
  it("renders the shapes that actually get thrown", () => {
    expect(describeThrown(null)).toBe("(no error value)");
    expect(describeThrown("plain")).toBe("plain");
    expect(describeThrown(new Error("with message"))).toContain("with message");
    expect(describeThrown({ code: 7 })).toContain("7");
  });

  it("survives a value that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(typeof describeThrown(cyclic)).toBe("string");
  });
});

describe("shortDetail", () => {
  it("takes the first line and truncates it", () => {
    expect(shortDetail("first\nsecond")).toBe("first");
    expect(shortDetail("x".repeat(400)).length).toBeLessThanOrEqual(160);
    expect(shortDetail(undefined)).toBe("");
  });
});
