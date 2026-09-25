import { afterEach, describe, expect, it, vi } from "vitest";
import { createDrawableCache, drawVisible } from "../src/components/previewDrawing";
import { coversRect } from "../src/dither/region";

afterEach(() => vi.unstubAllGlobals());

describe("preview pixel uploads", () => {
  it("uploads an unchanged plane only once across repeated navigation frames", () => {
    const putImageData = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ putImageData }) };
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal("document", { createElement });
    const drawable = createDrawableCache();
    const first = new ImageData(new Uint8ClampedArray(16), 2, 2);
    for (let frame = 0; frame < 120; frame++) expect(drawable(first)).toBe(canvas);
    expect(putImageData).toHaveBeenCalledTimes(1);
    // A new dither result of the same dimensions must still replace the pixels.
    const replacement = new ImageData(new Uint8ClampedArray(16).fill(255), 2, 2);
    drawable(replacement);
    expect(putImageData).toHaveBeenCalledTimes(2);
    expect(putImageData).toHaveBeenLastCalledWith(replacement, 0, 0);
    expect(createElement).toHaveBeenCalledTimes(1);
  });

  it("draws worker bitmaps without uploading pixels or creating a canvas", () => {
    class Bitmap { width = 2; height = 2; }
    vi.stubGlobal("ImageBitmap", Bitmap);
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    const bitmap = new Bitmap() as ImageBitmap;
    expect(createDrawableCache()(bitmap)).toBe(bitmap);
    expect(createElement).not.toHaveBeenCalled();
  });
});

describe("visible drawing", () => {
  it("clips magnified images to the viewport without shifting source coordinates", () => {
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    const image = { width: 4096, height: 2048 } as HTMLCanvasElement;
    drawVisible(ctx, image, -3200, -1600, 131072, 65536, 800, 600);
    expect(drawImage).toHaveBeenCalledWith(image, 100, 50, 25, 18.75, 0, 0, 800, 600);
  });

  it("skips offscreen images and preserves the full source when fitted", () => {
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    const image = { width: 4096, height: 2048 } as HTMLCanvasElement;
    drawVisible(ctx, image, 900, 0, 400, 200, 800, 600);
    expect(drawImage).not.toHaveBeenCalled();
    drawVisible(ctx, image, 200, 200, 400, 200, 800, 600);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 4096, 2048, 200, 200, 400, 200);
  });
});

describe("fine-pass reuse", () => {
  const tile = { x: 100, y: 100, width: 300, height: 200 };
  it("reuses a full-image render at every zoom level", () => {
    expect(coversRect(null, tile)).toBe(true);
    expect(coversRect(null, null)).toBe(true);
  });
  it("reuses a crop only while it covers all the requested pixels", () => {
    expect(coversRect(tile, tile)).toBe(true);
    expect(coversRect(tile, { x: 150, y: 150, width: 50, height: 50 })).toBe(true);
    expect(coversRect(tile, { ...tile, x: 101 })).toBe(false);
    expect(coversRect(tile, { ...tile, y: 99 })).toBe(false);
    expect(coversRect(tile, null)).toBe(false);
  });
});
