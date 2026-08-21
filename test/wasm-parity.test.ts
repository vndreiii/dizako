/**
 * Wasm-side parity gate (WASM_PLAN §8, Gate 2/3).
 *
 * Instantiates the compiled wasm32 artifact via the pkg glue's `initSync`
 * inside plain Node and runs it against the same SHA-256 manifest the TS
 * engine was captured with. Native cargo tests prove Rust-native parity;
 * this proves the *shipped wasm binary* agrees too (simd128 flags, wasm-opt
 * passes and all).
 *
 * Requires `pnpm build:wasm` to have run — skipped when pkg is absent.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { settingsFor } from "./golden.test";

const ROOT = join(__dirname, "..");
const PKG = join(ROOT, "dither-wasm", "pkg");

const hasPkg = existsSync(join(PKG, "dither_wasm_bg.wasm"));

// Shared suite/manifest loading (kept identical to the TS golden harness).
const suite = JSON.parse(
  readFileSync(join(ROOT, "testdata", "suites", "main.json"), "utf8"),
) as { cases: Array<Record<string, unknown>> };

const manifest = JSON.parse(
  readFileSync(join(ROOT, "testdata", "golden", "ts.json"), "utf8"),
) as { hashes: Record<string, string> };

describe.skipIf(!hasPkg)("wasm engine parity", () => {
  let EngineCtor: new () => {
    set_source(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): void;
    render(stage: string, region: unknown, settings: unknown): number;
    out_ptr(): number;
  };
  let memory: WebAssembly.Memory;

  test.beforeAll(async () => {
    const glue = await import("dither-wasm");
    const wasmModule = readFileSync(join(PKG, "dither_wasm_bg.wasm"));
    const out = glue.initSync({ module: new Uint8Array(wasmModule) });
    EngineCtor = glue.Engine;
    memory = out.memory;
  });

  test("matches the TS golden manifest byte-for-byte", () => {
    const engine = new EngineCtor();
    const fixtureCache = new Map<string, { data: Uint8ClampedArray; w: number; h: number }>();
    const loadFixture = (name: string) => {
      let f = fixtureCache.get(name);
      if (!f) {
        const meta = JSON.parse(
          readFileSync(join(ROOT, "testdata", "images", `${name}.json`), "utf8"),
        ) as { width: number; height: number };
        f = {
          data: new Uint8ClampedArray(
            readFileSync(join(ROOT, "testdata", "images", `${name}.rgba`)),
          ),
          w: meta.width,
          h: meta.height,
        };
        fixtureCache.set(name, f);
      }
      return f;
    };

    let failures = 0;
    for (const c of suite.cases) {
      const fx = loadFixture(c.fixture);
      // Resident planes mirror the worker's usage; settings-only renders after.
      engine.set_source(fx.data, fx.w, fx.h);
      const settings = settingsFor(c as never);
      const len = engine.render("fine", null, settings);
      const bytes = new Uint8Array(memory.buffer, engine.out_ptr(), len);
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== manifest.hashes[c.id]) {
        failures++;
        if (failures <= 5) {
          console.error(`wasm drift ${c.id} (${c.algorithm}, ${c.fixture})`);
        }
      }
    }
    expect(failures, `${failures} wasm parity failures`).toBe(0);
    expect(suite.cases.length).toBeGreaterThan(0);
  });
});
