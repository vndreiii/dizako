import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LATER_MS, rememberUpdateChoice, updatePromptDelay } from "../src/updater";

describe("update prompt choices", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  test("Later asks again after 24 hours, including across launches", () => {
    rememberUpdateChoice("2.3.2", "later", 1_000);
    expect(updatePromptDelay("2.3.2", 1_000)).toBe(LATER_MS);
    expect(updatePromptDelay("2.3.2", 1_000 + LATER_MS - 1)).toBe(1);
    expect(updatePromptDelay("2.3.2", 1_000 + LATER_MS)).toBe(0);
  });

  test("Dismiss hides only that version", () => {
    rememberUpdateChoice("2.3.2", "dismiss");
    expect(updatePromptDelay("2.3.2")).toBeNull();
    expect(updatePromptDelay("2.3.3")).toBe(0);
  });
});
