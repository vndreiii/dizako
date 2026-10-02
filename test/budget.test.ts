import { describe, expect, test } from "vitest";
import { CoarseBudget, FULL_RES_BUDGET_MS, QUALITY_BUDGETS, RUNGS, isPreviewQuality, passCount } from "../src/dither/budget";
import { makeAlgorithmLayer, type Settings } from "../src/dither/types";

const stack = (n: number): Pick<Settings, "algorithmLayers"> => ({
  algorithmLayers: Array.from({ length: n }, () => makeAlgorithmLayer("bayer")),
});

describe("preview resolution budget", () => {
  test("counts only the passes that will actually run", () => {
    expect(passCount({ algorithmLayers: [] })).toBe(1);
    const s = stack(4);
    s.algorithmLayers[1]!.enabled = false;
    s.algorithmLayers[2]!.opacity = 0;
    expect(passCount(s)).toBe(2);
  });

  test("a small image renders whole instead of staging", () => {
    const b = new CoarseBudget();
    expect(b.choose(200_000, stack(1))).toBe(200_000);
  });

  test("a large image gets a reduced first pass from the ladder", () => {
    const b = new CoarseBudget();
    const target = b.choose(8_000_000, stack(1));
    expect(RUNGS as readonly number[]).toContain(target);
  });

  test("measured slowness walks the target down, measured speed walks it up", () => {
    const b = new CoarseBudget();
    const settings = stack(10);
    const start = b.choose(8_000_000, stack(1));
    // Ten passes at 0.002 ms per pixel-pass is far over budget at any rung.
    for (let i = 0; i < 12; i++) b.observe(0.002 * start * 10, start, 10);
    const slow = b.choose(8_000_000, settings);
    expect(slow).toBeLessThan(start);
    expect(slow).toBe(RUNGS[0]);

    for (let i = 0; i < 40; i++) b.observe(0.00002 * slow, slow, 1);
    const fast = b.choose(8_000_000, stack(1));
    expect(fast).toBeGreaterThan(slow);
  });

  test("fully cached renders carry no timing information", () => {
    const b = new CoarseBudget();
    const before = b.pricePerPixelPass;
    b.observe(0.1, 100_000, 0);
    expect(b.pricePerPixelPass).toBe(before);
  });

  test("the choice is stable under small noise (hysteresis)", () => {
    const b = new CoarseBudget();
    const settings = stack(2);
    const first = b.choose(8_000_000, settings);
    for (let i = 0; i < 20; i++) {
      const jitter = 1 + (i % 2 ? 0.08 : -0.08);
      b.observe(b.pricePerPixelPass * first * 2 * jitter, first, 2);
      expect(b.choose(8_000_000, settings)).toBe(first);
    }
    expect(FULL_RES_BUDGET_MS).toBeGreaterThan(0);
  });

  test("quality trades first-pass size for responsiveness", () => {
    const settings = stack(4);
    const pick = (quality: "fast" | "balanced" | "sharp") => {
      const b = new CoarseBudget(quality);
      // Same measured machine for all three: 0.00008 ms per pixel-pass.
      for (let i = 0; i < 30; i++) b.observe(0.00008 * 100_000 * 4, 100_000, 4);
      return b.choose(8_000_000, settings);
    };
    expect(pick("fast")).toBeLessThanOrEqual(pick("balanced"));
    expect(pick("balanced")).toBeLessThanOrEqual(pick("sharp"));
    expect(pick("fast")).toBeLessThan(pick("sharp"));
    expect(QUALITY_BUDGETS.fast.coarse).toBeLessThan(QUALITY_BUDGETS.sharp.coarse);
  });

  test("a quality can be changed on a live budget", () => {
    const b = new CoarseBudget("sharp");
    for (let i = 0; i < 30; i++) b.observe(0.00008 * 100_000 * 4, 100_000, 4);
    const sharp = b.choose(8_000_000, stack(4));
    b.setQuality("fast");
    expect(b.choose(8_000_000, stack(4))).toBeLessThan(sharp);
  });

  test("only the three known qualities validate", () => {
    expect(["fast", "balanced", "sharp"].every(isPreviewQuality)).toBe(true);
    expect(isPreviewQuality("ultra")).toBe(false);
    expect(isPreviewQuality(undefined)).toBe(false);
  });
});
