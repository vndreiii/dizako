import { describe, expect, test } from "vitest";
import { CoarseBudget, FULL_RES_BUDGET_MS, MAX_FINE_PIXELS, MIN_FINE_PIXELS, QUALITY_BUDGETS, RUNGS, isPreviewQuality, passCount } from "../src/dither/budget";
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

  test("a small area is sharpened at full size, a big one as a reduced whole", () => {
    const b = new CoarseBudget("balanced");
    // 0.0004 ms per pixel-pass (the starting guess): 800 ms buys ~2M pixels.
    const settings = stack(1);
    const viewport = { width: 1400, height: 800 };
    expect(b.planFine(settings, 14_745_600, viewport)).toEqual({ kind: "region" });
    const whole = b.planFine(settings, 14_745_600, null);
    expect(whole.kind).toBe("whole");
    if (whole.kind === "whole") {
      expect(whole.target).toBeGreaterThanOrEqual(MIN_FINE_PIXELS);
      expect(whole.target).toBeLessThan(14_745_600);
    }
  });

  test("an image that fits the budget is simply rendered whole at full size", () => {
    const b = new CoarseBudget("balanced");
    expect(b.planFine(stack(1), 1_000_000, null)).toEqual({ kind: "region" });
  });

  test("more passes, or a slower machine, shrink the sharpening target", () => {
    const b = new CoarseBudget("balanced");
    const one = b.fineTarget(stack(1));
    expect(b.fineTarget(stack(10))).toBeLessThan(one);
    expect(b.fineTarget(stack(10))).toBeGreaterThanOrEqual(MIN_FINE_PIXELS);
    for (let i = 0; i < 30; i++) b.observe(0.002 * 500_000, 500_000, 1);
    expect(b.fineTarget(stack(1))).toBeLessThan(one);
  });

  test("a fast machine and a generous quality earn full-size sharpening", () => {
    const b = new CoarseBudget("sharp");
    for (let i = 0; i < 40; i++) b.observe(0.00002 * 1_000_000, 1_000_000, 1);
    expect(b.fineTarget(stack(1))).toBe(MAX_FINE_PIXELS);
    expect(b.planFine(stack(1), 14_745_600, null)).toEqual({ kind: "region" });
  });

  test("the fine budget grows with the quality setting", () => {
    expect(QUALITY_BUDGETS.fast.fine).toBeLessThan(QUALITY_BUDGETS.balanced.fine);
    expect(QUALITY_BUDGETS.balanced.fine).toBeLessThan(QUALITY_BUDGETS.sharp.fine);
  });

  test("the sharpening target sits on a ladder, so measurement jitter does not move it", () => {
    const b = new CoarseBudget("balanced");
    const first = b.fineTarget(stack(1));
    for (let i = 0; i < 20; i++) {
      b.observe(b.pricePerPixelPass * 1_000_000 * (1 + (i % 2 ? 0.05 : -0.05)), 1_000_000, 1);
      expect(b.fineTarget(stack(1))).toBe(first);
    }
  });
});
