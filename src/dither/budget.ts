import type { Settings } from "./types";

/**
 * How big the first preview pass should be.
 *
 * The goal is a picture that lands while the slider is still under the
 * finger, whatever is being rendered. Cost scales with pixels and with how
 * many passes of a stack have to run, and the per-pixel price varies by an
 * order of magnitude between algorithms - so rather than guess, this watches
 * what renders actually cost and picks the largest plane that still fits.
 *
 * Sizes come from a short ladder rather than a continuous range. Every size
 * has its own downscaled plane and its own per-pass result cache, so jittering
 * between neighbouring sizes would throw both away on every tick; a ladder
 * with hysteresis settles on one rung and stays there.
 */

/** Pixel counts the preview may render at, smallest first. */
export const RUNGS = [60_000, 110_000, 190_000, 300_000, 460_000] as const;

/**
 * How snappy the preview should be, traded against how sharp the first pass is.
 *
 * `full` is how long the whole image may take and still be rendered in one go,
 * skipping the reduced pass entirely; `coarse` is what a reduced pass should
 * cost. "Fast" keeps the picture moving under the finger on slow machines at
 * the price of a smaller first pass; "sharp" waits longer for a bigger one.
 */
export type PreviewQuality = "fast" | "balanced" | "sharp";

export const QUALITY_BUDGETS: Record<PreviewQuality, { full: number; coarse: number; fine: number }> = {
  // `fine` is how long the sharpening pass may take. The worker cannot be
  // interrupted mid-pass, so this is also the longest a slider move can have to
  // wait behind one.
  fast: { full: 80, coarse: 50, fine: 350 },
  balanced: { full: 140, coarse: 90, fine: 800 },
  sharp: { full: 260, coarse: 170, fine: 2500 },
};

/** The sharpening pass is never planned below this many pixels. */
export const MIN_FINE_PIXELS = 600_000;
export const MAX_FINE_PIXELS = 16_000_000;

/**
 * Sizes a sharpening pass may take, ~1.5x apart. Like the first-pass ladder, the
 * point of a ladder is that equal requests are identical: a size picked from a
 * continuous estimate would shift by a few percent with every measurement, and
 * each shift is a new reduced plane and a full recompute for nothing visible.
 */
const FINE_LADDER = [600_000, 900_000, 1_400_000, 2_100_000, 3_100_000, 4_700_000, 7_000_000, 10_500_000, 16_000_000];

function onFineLadder(px: number): number {
  let best = FINE_LADDER[0]!;
  for (const step of FINE_LADDER) if (step <= px) best = step;
  return best;
}

export const FULL_RES_BUDGET_MS = QUALITY_BUDGETS.balanced.full;
export const COARSE_BUDGET_MS = QUALITY_BUDGETS.balanced.coarse;

export function isPreviewQuality(value: unknown): value is PreviewQuality {
  return value === "fast" || value === "balanced" || value === "sharp";
}

/** Conservative starting price, ms per pixel per pass, before anything is measured. */
const INITIAL_COST = 0.0004;
/** Blend factor for new measurements. */
const SMOOTHING = 0.45;
/** Step down above this multiple of budget, up below this one - the dead band. */
const DOWN_AT = 1.4;
const UP_AT = 0.85;

/** Passes a render of these settings will run at most. */
export function passCount(settings: Pick<Settings, "algorithmLayers">): number {
  const layers = settings.algorithmLayers;
  if (layers.length === 0) return 1;
  const live = layers.filter((layer) => layer.enabled && layer.opacity > 0).length;
  return Math.max(1, live);
}

export class CoarseBudget {
  private cost = INITIAL_COST;
  private rung = 2;
  private limits = QUALITY_BUDGETS.balanced;

  constructor(quality: PreviewQuality = "balanced") {
    this.limits = QUALITY_BUDGETS[quality];
  }

  setQuality(quality: PreviewQuality): void {
    this.limits = QUALITY_BUDGETS[quality];
  }

  /**
   * Records what a render took.
   *
   * `passesRun` is how many passes actually executed - cached passes are free
   * and would make the engine look faster than it is - so a fully cached
   * render carries no information and is ignored.
   */
  observe(ms: number, pixels: number, passesRun: number): void {
    if (passesRun <= 0 || pixels <= 0 || !Number.isFinite(ms) || ms <= 0) return;
    const measured = ms / (pixels * passesRun);
    this.cost = this.cost * (1 - SMOOTHING) + measured * SMOOTHING;
  }

  /** Estimated cost of a worst-case render (every pass recomputed). */
  estimate(pixels: number, settings: Pick<Settings, "algorithmLayers">): number {
    return this.cost * pixels * passCount(settings);
  }

  /**
   * Pixel target for the next first pass. At or above the source's own pixel
   * count it means "render the lot" and no reduced pass is needed at all.
   */
  choose(sourcePixels: number, settings: Pick<Settings, "algorithmLayers">): number {
    if (this.estimate(sourcePixels, settings) <= this.limits.full) return sourcePixels;

    while (this.rung > 0 && this.estimate(RUNGS[this.rung]!, settings) > this.limits.coarse * DOWN_AT) {
      this.rung--;
    }
    while (
      this.rung < RUNGS.length - 1 &&
      this.estimate(RUNGS[this.rung + 1]!, settings) < this.limits.coarse * UP_AT
    ) {
      this.rung++;
    }
    return Math.min(RUNGS[this.rung]!, sourcePixels);
  }

  /**
   * The most pixels a sharpening pass should render, given what renders have
   * been costing: the largest plane that still finishes inside the quality's
   * `fine` budget. A fast machine earns a bigger one.
   */
  fineTarget(settings: Pick<Settings, "algorithmLayers">): number {
    const passes = passCount(settings);
    const px = this.limits.fine / (this.cost * passes);
    return onFineLadder(Math.min(MAX_FINE_PIXELS, Math.max(MIN_FINE_PIXELS, px)));
  }

  /**
   * What the sharpening pass for `region` (null = the whole image) should be.
   *
   * - `region`: the area fits the budget, so it is rendered at full size - this
   *   is what zooming in lands on, since a viewport is small.
   * - `whole`: the area is too big to render at full size in good time (a 5K
   *   image fitted to the window), so the whole image is rendered at the
   *   largest size that does fit. Zoomed out that far, the extra pixels of a
   *   full-size pass could not be seen anyway; they would only be waited for.
   */
  planFine(
    settings: Pick<Settings, "algorithmLayers">,
    sourcePixels: number,
    region: { width: number; height: number } | null,
  ): { kind: "region" } | { kind: "whole"; target: number } {
    const area = region ? region.width * region.height : sourcePixels;
    const limit = this.fineTarget(settings);
    if (area <= limit) return { kind: "region" };
    return { kind: "whole", target: Math.min(limit, sourcePixels) };
  }

  get pricePerPixelPass(): number {
    return this.cost;
  }
}
