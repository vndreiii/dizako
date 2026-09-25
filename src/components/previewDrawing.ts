import type { Layer } from "../hooks/useDither";

/** Keep one upload per immutable pixel plane, including worker fallbacks.
 * Surfaces stay off-document; only the viewport-sized canvas is composited. */
export function createDrawableCache() {
  let pixels: ImageData | null = null;
  let canvas: HTMLCanvasElement | null = null;
  return (layer: Layer): CanvasImageSource => {
    if (typeof ImageBitmap !== "undefined" && layer instanceof ImageBitmap) return layer;
    const data = layer as ImageData;
    if (data !== pixels) {
      canvas ??= document.createElement("canvas");
      if (canvas.width !== data.width) canvas.width = data.width;
      if (canvas.height !== data.height) canvas.height = data.height;
      canvas.getContext("2d")!.putImageData(data, 0, 0);
      pixels = data;
    }
    return canvas!;
  };
}

/** Bound raster work to visible pixels even at very high magnification. */
export function drawVisible(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  x: number, y: number, width: number, height: number,
  viewWidth: number, viewHeight: number,
) {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(viewWidth, x + width);
  const bottom = Math.min(viewHeight, y + height);
  if (right <= left || bottom <= top) return;
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  ctx.drawImage(image,
    (left - x) * scaleX, (top - y) * scaleY,
    (right - left) * scaleX, (bottom - top) * scaleY,
    left, top, right - left, bottom - top);
}
