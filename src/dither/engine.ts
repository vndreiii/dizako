/**
 * Typed wrapper around the dither-wasm package.
 *
 * The rest of the app never imports the pkg glue directly — this module is
 * the single seam, and it degrades to `null` on any init failure so callers
 * can fall down the backend ladder instead of crashing (WASM_PLAN §6 B1).
 */
import type { Rect } from "./region";
import type { Settings } from "./types";

export interface WasmEngine {
  set_source(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): void;
  set_coarse(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): void;
  /** Pre-rasterised glyph coverage for the text algorithm. */
  set_glyphs(bitmaps: Uint8Array, count: number, cellWidth: number, cellHeight: number): void;
  render(stage: "coarse" | "fine", region: Rect | null, settings: Settings): number;
  /**
   * Renders the whole image reduced to about `targetPixels`, building and
   * keeping the reduced plane itself. Read the size back from
   * `out_width`/`out_height`; at or above the source's pixel count it simply
   * renders the source.
   */
  render_coarse(targetPixels: number, settings: Settings): number;
  out_width(): number;
  out_height(): number;
  /** Stack passes the last render reused from its cache / actually ran. */
  last_reused(): number;
  last_computed(): number;
  out_ptr(): number;
}

export interface WasmBackend {
  engine: WasmEngine;
  /** Live view factory — the memory may grow between renders. */
  view(len: number): Uint8Array;
}

let cached: Promise<WasmBackend | null> | null = null;

/** Initialises once per realm; concurrent callers share one attempt. */
export function loadWasmEngine(): Promise<WasmBackend | null> {
  if (!cached) {
    cached = (async () => {
      try {
        const glue = await import("dither-wasm");
        const out = await glue.default();
        const engine = new glue.Engine();
        return {
          engine: engine as WasmEngine,
          view(len: number) {
            return new Uint8Array(out.memory.buffer, engine.out_ptr(), len);
          },
        };
      } catch (err) {
        console.warn("[dizako] wasm engine unavailable; using JS engine.", err);
        return null;
      }
    })();
  }
  return cached;
}
