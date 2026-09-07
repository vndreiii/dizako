/**
 * Golden-image parity harness.
 *
 * Runs the FROZEN TS engine (legacy/dither — deleted from the runtime in
 * Stage C) over the declarative sweep and compares SHA-256 hashes of every
 * output RGBA buffer against a committed manifest. Together with
 * wasm-parity.test.ts this pins both historical and shipped engines to the
 * same bytes; a change that flips one golden byte fails CI.
 *
 * - `GOLDEN_CAPTURE=1` (re)generates `testdata/golden/ts.json` instead of
 *   asserting — only meaningful when the reference engine itself is being
 *   deliberately changed, which should never happen now it is frozen.
 * - Default mode asserts byte equality.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dither } from "../legacy/dither/algorithms";
import { DEFAULT_SETTINGS, type Settings } from "../src/dither/types";

const ROOT = join(__dirname, "..");
const CAPTURE = process.env.GOLDEN_CAPTURE === "1";
const MANIFEST = join(ROOT, "testdata", "golden", "ts.json");

interface Case {
  id: string;
  fixture: string;
  algorithm: string;
  palette: string;
  matchMode?: string;
  [key: string]: unknown;
}

const suite = JSON.parse(
  readFileSync(join(ROOT, "testdata", "suites", "main.json"), "utf8"),
) as {
  palettes: Record<string, { layers: Settings["layers"] }>;
  cases: Case[];
};

const fixtureCache = new Map<string, ImageData>();
function loadFixture(name: string): ImageData {
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

function hashImage(img: ImageData): string {
  // Hash only the RGBA bytes, independent of stride or view offset.
  return createHash("sha256").update(img.data).digest("hex");
}

describe("golden parity sweep", () => {
  const results: Record<string, string> = {};

  for (const c of suite.cases) {
    test(`${c.id} ${c.algorithm} ${c.fixture} ${c.palette}/${c.matchMode ?? "-"}`, () => {
      const out = dither(loadFixture(c.fixture), settingsFor(c));
      const h = hashImage(out);
      if (CAPTURE) {
        results[c.id] = h;
        return;
      }
      expect(h, `case ${c.id} (${c.algorithm}, ${c.fixture}) drifted`).toBe(
        manifest.hashes[c.id],
      );
    });
  }

  let manifest: { version: number; engine: string; hashes: Record<string, string> };

  test.beforeAll(() => {
    if (!CAPTURE) {
      manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
      expect(manifest.cases ?? suite.cases.length, "suite size changed — regenerate goldens").toBe(
        suite.cases.length,
      );
    }
  });

  test.afterAll(() => {
    if (CAPTURE && Object.keys(results).length > 0) {
      mkdirSync(join(ROOT, "testdata", "golden"), { recursive: true });
      writeFileSync(
        MANIFEST,
        JSON.stringify(
          {
            version: 1,
            engine: "ts",
            capturedAt: new Date().toISOString(),
            cases: suite.cases.length,
            hashes: results,
          },
          null,
          1,
        ),
      );
      console.log(`captured ${Object.keys(results).length} golden hashes`);
    }
  });
});
