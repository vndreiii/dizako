/**
 * Shared golden-suite helpers (settings + fixtures).
 *
 * Kept free of engine imports so wasm-parity can load without the
 * deleted-from-runtime legacy TS dither tree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../src/dither/types";

const ROOT = join(__dirname, "..");

export interface Case {
  id: string;
  fixture: string;
  algorithm: string;
  palette: string;
  matchMode?: string;
  [key: string]: unknown;
}

export const suite = JSON.parse(
  readFileSync(join(ROOT, "testdata", "suites", "main.json"), "utf8"),
) as {
  palettes: Record<string, { layers: Settings["layers"] }>;
  cases: Case[];
};

const fixtureCache = new Map<string, ImageData>();

export function loadFixture(name: string): ImageData {
  let img = fixtureCache.get(name);
  if (!img) {
    const meta = JSON.parse(
      readFileSync(join(ROOT, "testdata", "images", `${name}.json`), "utf8"),
    ) as { width: number; height: number };
    const bytes = readFileSync(join(ROOT, "testdata", "images", `${name}.rgba`));
    img = new ImageData(new Uint8ClampedArray(bytes), meta.width, meta.height);
    fixtureCache.set(name, img);
  }
  return img;
}

/** Applies a sweep case on top of the shipped defaults. */
export function settingsFor(c: Case): Settings {
  return {
    ...DEFAULT_SETTINGS,
    algorithm: c.algorithm as Settings["algorithm"],
    layers: suite.palettes[c.palette].layers,
    matchMode: (c.matchMode ?? DEFAULT_SETTINGS.matchMode) as Settings["matchMode"],
    ...clean({
      tonalBias: c.tonalBias,
      strength: c.strength,
      serpentine: c.serpentine,
      jitter: c.jitter,
      errorClamp: c.errorClamp,
      bayerSize: c.bayerSize,
      cellSize: c.cellSize,
      screenAngle: c.screenAngle,
      noiseScale: c.noiseScale,
      threshold: c.threshold,
      noiseAmount: c.noiseAmount,
      riemersmaQueue: c.riemersmaQueue,
      riemersmaDecay: c.riemersmaDecay,
      dotClassSize: c.dotClassSize,
      ominoDirection: c.ominoDirection,
      ominoErrorStrength: c.ominoErrorStrength,
      ominoAcross: c.ominoAcross,
      ominoAside: c.ominoAside,
      ominoPhase: c.ominoPhase,
      ominoColorCount: c.ominoColorCount,
      blur: c.blur,
      sharpen: c.sharpen,
      grayscale: c.grayscale,
      invert: c.invert,
    }),
  };
}

function clean<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export { ROOT };
