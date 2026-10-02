/**
 * Engine API behaviour through the shipped wasm binary: the engine-side coarse
 * plane, the per-pass cache, and the stackable algorithms that the golden
 * sweep does not cover. Skipped when `pnpm build:wasm` has not run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ROOT } from "./harness";
import { DEFAULT_SETTINGS, makeAlgorithmLayer, type AlgorithmId, type Settings } from "../src/dither/types";
import type { WasmEngine } from "../src/dither/engine";

const PKG = join(ROOT, "dither-wasm", "pkg");
const hasPkg = existsSync(join(PKG, "dither_wasm_bg.wasm"));

interface Glue {
  initSync(arg: { module: Uint8Array }): { memory: WebAssembly.Memory };
  Engine: new () => WasmEngine & { set_glyphs(b: Uint8Array, n: number, w: number, h: number): void };
}

function photo(w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = (x * 255) / w;
      out[i + 1] = (y * 255) / h;
      out[i + 2] = ((x ^ y) * 7) & 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

function stackOf(kinds: AlgorithmId[]): Settings {
  return { ...DEFAULT_SETTINGS, algorithmLayers: kinds.map((k) => makeAlgorithmLayer(k)) };
}

describe.skipIf(!hasPkg)("wasm engine API", () => {
  let glue: Glue;
  let memory: WebAssembly.Memory;

  const read = (engine: WasmEngine, len: number) =>
    new Uint8Array(memory.buffer, engine.out_ptr(), len).slice();

  test("setup", async () => {
    glue = (await import("dither-wasm")) as unknown as Glue;
    memory = glue.initSync({ module: new Uint8Array(readFileSync(join(PKG, "dither_wasm_bg.wasm"))) }).memory;
  });

  test("render_coarse builds its own reduced plane and reports its size", () => {
    const engine = new glue.Engine();
    engine.set_source(photo(800, 600), 800, 600);
    const len = engine.render_coarse(120_000, DEFAULT_SETTINGS);
    const w = engine.out_width();
    const h = engine.out_height();
    expect(len).toBe(w * h * 4);
    expect(w * h).toBeGreaterThan(110_000);
    expect(w * h).toBeLessThan(130_000);
    expect(Math.abs(w / h - 800 / 600)).toBeLessThan(0.02);

    // At or above the source's own size it renders the source.
    engine.render_coarse(10_000_000, DEFAULT_SETTINGS);
    expect([engine.out_width(), engine.out_height()]).toEqual([800, 600]);
  });

  test("a fine region render matches the same pixels cut from a full render for ordered dithers", () => {
    const engine = new glue.Engine();
    engine.set_source(photo(160, 120), 160, 120);
    const settings = { ...DEFAULT_SETTINGS, algorithm: "threshold" as const };
    const full = read(engine, engine.render("fine", null, settings));
    const len = engine.render("fine", { x: 8, y: 4, width: 32, height: 16 }, settings);
    const crop = read(engine, len);
    expect([engine.out_width(), engine.out_height()]).toEqual([32, 16]);
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 32; col++) {
        const a = ((4 + row) * 160 + 8 + col) * 4;
        const b = (row * 32 + col) * 4;
        expect(Array.from(crop.subarray(b, b + 4))).toEqual(Array.from(full.subarray(a, a + 4)));
      }
    }
  });

  test("ten mixed layers render, and an edit on top reuses the nine below", () => {
    const engine = new glue.Engine();
    engine.set_source(photo(120, 90), 120, 90);
    const kinds: AlgorithmId[] = [
      "floyd-steinberg", "ascii", "omino", "bayer", "riemersma",
      "dot-diffusion", "ostromoukhov", "jpeg-sort", "dot-grid", "atkinson",
    ];
    // A small atlas so the text layer has glyphs to choose from.
    const cw = 4, ch = 6, count = 10;
    const atlas = new Uint8Array(cw * ch * count);
    for (let g = 0; g < count; g++) for (let i = 0; i < cw * ch; i++) atlas[g * cw * ch + i] = (i * 5 + g) % 10 < g ? 255 : 0;
    engine.set_glyphs(atlas, count, cw, ch);

    const settings = stackOf(kinds);
    const len = engine.render("fine", null, settings);
    expect(len).toBe(120 * 90 * 4);
    expect([engine.last_reused(), engine.last_computed()]).toEqual([0, 10]);
    const first = read(engine, len);

    engine.render("fine", null, settings);
    expect([engine.last_reused(), engine.last_computed()]).toEqual([10, 0]);

    const edited = structuredClone(settings);
    // Passes after the first see an already-posterised image, so the edit has
    // to be one that restructures it rather than re-quantises it.
    edited.algorithmLayers[9]!.algorithm = "dot-grid";
    edited.algorithmLayers[9]!.params = { cellSize: 5 };
    edited.algorithmLayers[9]!.opacity = 0.5;
    const second = read(engine, engine.render("fine", null, edited));
    expect([engine.last_reused(), engine.last_computed()]).toEqual([9, 1]);
    expect(second).not.toEqual(first);

    // Cached or not, the pixels are the pixels.
    const fresh = new glue.Engine();
    fresh.set_source(photo(120, 90), 120, 90);
    fresh.set_glyphs(atlas, count, cw, ch);
    expect(read(fresh, fresh.render("fine", null, edited))).toEqual(second);
  });

  test("the coarse and fine passes keep separate caches", () => {
    const engine = new glue.Engine();
    engine.set_source(photo(400, 300), 400, 300);
    const settings = stackOf(["bayer", "halftone", "dot-grid", "floyd-steinberg"]);
    engine.render_coarse(30_000, settings);
    engine.render("fine", { x: 0, y: 0, width: 200, height: 150 }, settings);
    engine.render_coarse(30_000, settings);
    expect([engine.last_reused(), engine.last_computed()]).toEqual([4, 0]);
  });

  test("dot-grid honours cell size and shape through the settings wire format", () => {
    const engine = new glue.Engine();
    engine.set_source(photo(96, 96), 96, 96);
    const base: Settings = { ...DEFAULT_SETTINGS, algorithm: "dot-grid", cellSize: 8, dotCutoff: 0 };
    const a = read(engine, engine.render("fine", null, base));
    const b = read(engine, engine.render("fine", null, { ...base, cellSize: 12 }));
    const c = read(engine, engine.render("fine", null, { ...base, dotShape: "circle" }));
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });
});
