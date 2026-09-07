/**
 * Golden-image parity harness (optional legacy TS engine).
 *
 * The historical TS dither lived under `legacy/dither` and is gitignored —
 * it is not part of the shipped app (wasm is). When that tree is present
 * locally, this suite still asserts it against `testdata/golden/ts.json`.
 * On CI / clean checkouts the suite is skipped; `wasm-parity.test.ts` and
 * the native cargo tests remain the required gates.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ROOT, loadFixture, settingsFor, suite } from "./harness";

const CAPTURE = process.env.GOLDEN_CAPTURE === "1";
const MANIFEST = join(ROOT, "testdata", "golden", "ts.json");
const LEGACY_ENTRY = join(ROOT, "legacy", "dither", "algorithms.ts");
const hasLegacy = existsSync(LEGACY_ENTRY);

function hashImage(img: ImageData): string {
  return createHash("sha256").update(img.data).digest("hex");
}

describe.skipIf(!hasLegacy)("golden parity sweep (legacy TS)", () => {
  const results: Record<string, string> = {};
  let dither: (img: ImageData, settings: ReturnType<typeof settingsFor>) => ImageData;

  let manifest: { version: number; engine: string; hashes: Record<string, string> };

  test.beforeAll(async () => {
    const mod = await import("../legacy/dither/algorithms");
    dither = mod.dither;
    if (!CAPTURE) {
      manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
      expect(manifest.cases ?? suite.cases.length, "suite size changed — regenerate goldens").toBe(
        suite.cases.length,
      );
    }
  });

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
