/**
 * Frame readback worker.
 *
 * Reading a decoded video frame into pixels is the single most expensive thing
 * the UI thread used to do per frame: `drawImage` plus `getImageData` is a
 * synchronous GPU-to-CPU copy, tens to hundreds of milliseconds at 4 MP, during
 * which nothing else on the page moves. The decoder already runs outside the
 * UI thread; this keeps the readback out of it too.
 *
 * The main thread hands over a decoded frame - a `VideoFrame` where the host
 * has WebCodecs (creating one from the element costs next to nothing), else a
 * full-size `ImageBitmap` - and this worker scales and rasterises it, sending
 * the pixels back as a transferred buffer. Scaling happens here on purpose:
 * asking the main thread to resize while it creates the bitmap measured about
 * four times slower than creating it full size.
 */
import { looksBlank } from "./blank";

/** A decoded frame in a form that can cross to a worker. */
export type FrameHandle = ImageBitmap | VideoFrame;

export interface ReadbackRequest {
  type: "readback";
  id: number;
  frame: FrameHandle;
  /** Size to scale to; the frame arrives at its native size. */
  width: number;
  height: number;
}

export type ReadbackResponse =
  | { type: "pixels"; id: number; width: number; height: number; buffer: ArrayBuffer; blank: boolean }
  | { type: "failed"; id: number; message: string };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = (e: MessageEvent<ReadbackRequest>) => {
  const req = e.data;
  if (req.type !== "readback") return;
  try {
    if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas is not available in workers here");
    if (!canvas || canvas.width !== req.width || canvas.height !== req.height) {
      canvas = new OffscreenCanvas(req.width, req.height);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) throw new Error("no 2D context in the readback worker");
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(req.frame, 0, 0, req.width, req.height);
    req.frame.close();
    const image = ctx.getImageData(0, 0, req.width, req.height);
    const message: ReadbackResponse = {
      type: "pixels",
      id: req.id,
      width: req.width,
      height: req.height,
      buffer: image.data.buffer as ArrayBuffer,
      blank: looksBlank(image.data),
    };
    (self as unknown as Worker).postMessage(message, [message.buffer]);
  } catch (err) {
    try {
      req.frame.close();
    } catch {
      // Already closed, or never valid.
    }
    const message: ReadbackResponse = { type: "failed", id: req.id, message: String((err as Error)?.message ?? err) };
    (self as unknown as Worker).postMessage(message);
  }
};
