import { looksBlank } from "../video/blank";
import { CoarseBudget, type PreviewQuality } from "./budget";
import { loadWasmEngine, type WasmBackend } from "./engine";
import type { Rect } from "./region";
import type { Settings } from "./types";

/**
 * Render-worker protocol.
 *
 * The source plane is resident: it is shipped once per load (`setSource`) and
 * afterwards jobs carry *only* settings plus geometry. That removes the
 * per-dispatch copy of the whole frame that every slider tick used to pay.
 *
 * Everything derived from it lives in the engine too: the reduced plane the
 * first preview pass runs on (built there, sized by the adaptive budget) and
 * the finished result of every pass in a stack, so touching one layer of ten
 * redoes that layer and the ones above it, not all ten.
 *
 * Results come back as `ImageBitmap`s built inside the worker, so the main
 * thread never calls `putImageData` again; hosts without OffscreenCanvas fall
 * back to a transferred RGBA buffer handled by the legacy path in the hook.
 *
 * The TS engine has been deleted from the runtime (Stage C): the Rust/wasm
 * engine is the single visual truth. If the module fails to instantiate this
 * worker reports an error response and the hook demotes; the frozen TS copy
 * under legacy/ exists only as the parity reference.
 */
export interface SourceInit {
  type: "setSource";
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

/**
 * Glyph atlas for text mode.
 *
 * Resident like the pixel planes: an atlas is tens to hundreds of kilobytes
 * and changes only when the characters, font or cell size do. Sending it with
 * every render would undo exactly the saving the resident-plane design exists
 * for.
 */
export interface GlyphInit {
  type: "setGlyphs";
  buffer: ArrayBuffer;
  count: number;
  cellWidth: number;
  cellHeight: number;
}

export interface RenderRequest {
  type: "render";
  id: number;
  stage: "coarse" | "fine";
  /** Omitted ⇒ the whole resident plane for the stage. */
  region: Rect | null;
  settings: Settings;
}

export interface ExportRequest {
  type: "export";
  id: number;
  settings: Settings;
}

/**
 * Stateless one-shot render, used by the video export pool.
 *
 * Unlike `render`, the plane travels *with* the request and replaces whatever
 * the engine was holding. That is the right trade for video: every frame is a
 * different image, so residency buys nothing, and shipping the plane in lets a
 * pool of workers dither different frames of the same clip in parallel.
 *
 * It must therefore never be sent to the worker that serves the preview - it
 * would evict the resident source out from under it.
 */
export interface FrameRequest {
  type: "renderFrame";
  id: number;
  /** The plane as pixels... */
  buffer?: ArrayBuffer;
  /** ...or as a decoded frame the worker scales and rasterises itself, which
   *  keeps the pixels off the UI thread altogether. Exactly one of the two is set. */
  frame?: ImageBitmap | VideoFrame;
  width: number;
  height: number;
  settings: Settings;
  /** `png` encodes in the worker; `pixels` transfers RGBA back for the caller. */
  encode: "png" | "pixels";
}

/** Tunes the adaptive preview budget. Safe to send at any time. */
export interface ConfigureRequest {
  type: "configure";
  quality: PreviewQuality;
}

export type WorkerRequest =
  | ConfigureRequest
  | SourceInit
  | GlyphInit
  | RenderRequest
  | ExportRequest
  | FrameRequest;

export interface ReadyResponse {
  type: "ready";
  /** Which engine actually rendered: wasm or js. */
  backend: "wasm" | "js";
}

/** Raised when no engine could be initialised on this rung at all. */
export interface ErrorResponse {
  type: "error";
  id?: number;
  message: string;
}

export interface ResultResponse {
  type: "result";
  id: number;
  stage: "coarse" | "fine";
  ms: number;
  /** Preferred delivery: a GPU-uploadable bitmap, transferred zero-copy-ish. */
  bitmap?: ImageBitmap;
  /** Legacy delivery for hosts without OffscreenCanvas/createImageBitmap. */
  buffer?: ArrayBuffer;
  width?: number;
  height?: number;
  /** Source pixels per result pixel: 1 for a full-resolution pass. */
  scale: number;
  /** Stack passes served from the cache vs actually run, for the HUD. */
  reused: number;
  computed: number;
}

export interface ProgressResponse {
  type: "progress";
  id: number;
  phase: "render" | "encode";
}

export interface ExportedResponse {
  type: "exported";
  id: number;
  blob: Blob;
  ms: number;
}

export interface ExportPixelsResponse {
  type: "exportPixels";
  id: number;
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

export interface FrameResponse {
  type: "frame";
  id: number;
  ms: number;
  /** Present when `encode: "png"` and this host has OffscreenCanvas. */
  blob?: Blob;
  /** Fallback delivery: raw RGBA for the caller to encode. */
  buffer?: ArrayBuffer;
  width?: number;
  height?: number;
}

export type WorkerResponse =
  | ReadyResponse
  | FrameResponse
  | ResultResponse
  | ProgressResponse
  | ExportedResponse
  | ExportPixelsResponse
  | ErrorResponse;

let sourceW = 0;
let sourceH = 0;
let wasm: WasmBackend | null = null;
const budget = new CoarseBudget();

/** Copies finished pixels out of wasm memory, which may move on the next call. */
function readOutput(): ImageData {
  const w = wasm!;
  const width = w.engine.out_width();
  const height = w.engine.out_height();
  const len = width * height * 4;
  return new ImageData(new Uint8ClampedArray(w.view(len)), width, height);
}

async function handleRender(req: RenderRequest) {
  if (!sourceW || !sourceH) return;
  const t0 = performance.now();

  // The Rust engine owns the plane and crops regions internally. There is no
  // other engine.
  if (!wasm) {
    post({ type: "error", id: req.id, message: "wasm engine unavailable in worker" });
    return;
  }

  let renderMs: number;
  let scale = 1;
  const sourcePixels = sourceW * sourceH;
  try {
    if (req.stage === "coarse") {
      const target = budget.choose(sourcePixels, req.settings);
      const start = performance.now();
      wasm.engine.render_coarse(target, req.settings);
      renderMs = performance.now() - start;
      const outPixels = wasm.engine.out_width() * wasm.engine.out_height();
      budget.observe(renderMs, outPixels, wasm.engine.last_computed());
      scale = sourceW / wasm.engine.out_width();
    } else {
      const start = performance.now();
      wasm.engine.render("fine", req.region, req.settings);
      renderMs = performance.now() - start;
    }
  } catch (err) {
    post({ type: "error", id: req.id, message: String((err as Error)?.message ?? err) });
    return;
  }
  void renderMs;

  const out = readOutput();
  const payload = await makePayload(out);
  const transfer = payload.bitmap ? [payload.bitmap] : payload.buffer ? [payload.buffer] : [];
  post(
    {
      type: "result",
      id: req.id,
      stage: req.stage,
      ms: performance.now() - t0,
      scale,
      reused: wasm.engine.last_reused(),
      computed: wasm.engine.last_computed(),
      ...payload,
    },
    transfer,
  );
}

async function handleExport(req: ExportRequest) {
  if (!sourceW || !sourceH) return;
  const t0 = performance.now();
  post({ type: "progress", id: req.id, phase: "render" });
  if (!wasm) {
    post({ type: "error", id: req.id, message: "wasm engine unavailable in worker" });
    return;
  }
  wasm.engine.render("fine", null, req.settings);
  const out = readOutput();

  post({ type: "progress", id: req.id, phase: "encode" });
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(out.width, out.height);
    canvas.getContext("2d")!.putImageData(out, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    post({ type: "exported", id: req.id, blob, ms: performance.now() - t0 });
    return;
  }
  // No OffscreenCanvas: send pixels back for main-thread encoding.
  post({
    type: "exportPixels",
    id: req.id,
    buffer: out.data.buffer as ArrayBuffer,
    width: out.width,
    height: out.height,
  });
}

let rasterCanvas: OffscreenCanvas | null = null;

/** Draws a decoded frame into pixels, scaled to `width` x `height`. Closes it either way. */
function rasterise(frame: ImageBitmap | VideoFrame, width: number, height: number): Uint8ClampedArray {
  try {
    if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas is not available in this worker");
    if (!rasterCanvas || rasterCanvas.width !== width || rasterCanvas.height !== height) {
      rasterCanvas = new OffscreenCanvas(width, height);
    }
    const g = rasterCanvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("no 2D context for the frame");
    g.imageSmoothingQuality = "medium";
    g.drawImage(frame, 0, 0, width, height);
    return g.getImageData(0, 0, width, height).data;
  } finally {
    frame.close();
  }
}

async function handleFrame(req: FrameRequest) {
  const t0 = performance.now();
  if (!wasm) {
    post({ type: "error", id: req.id, message: "wasm engine unavailable in worker" });
    return;
  }
  let plane: Uint8ClampedArray;
  if (req.frame) {
    try {
      plane = rasterise(req.frame, req.width, req.height);
    } catch (err) {
      post({ type: "error", id: req.id, message: `frame ${req.id}: ${String((err as Error)?.message ?? err)}` });
      return;
    }
    if (looksBlank(plane)) {
      post({ type: "error", id: req.id, message: `frame ${req.id}: the decoded frame rasterised blank` });
      return;
    }
  } else {
    plane = new Uint8ClampedArray(req.buffer ?? new ArrayBuffer(0));
  }
  if (plane.length !== req.width * req.height * 4) {
    post({
      type: "error",
      id: req.id,
      message: `frame ${req.id}: ${plane.length} bytes for ${req.width}x${req.height}`,
    });
    return;
  }
  // Replacing the source also drops every cached plane, so a frame can never
  // be composed from the previous one's passes.
  wasm.engine.set_source(plane, req.width, req.height);
  wasm.engine.render("fine", null, req.settings);
  const out = readOutput();

  if (req.encode === "png" && typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(out.width, out.height);
    const g = canvas.getContext("2d");
    if (g) {
      g.putImageData(out, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      post({ type: "frame", id: req.id, ms: performance.now() - t0, blob });
      return;
    }
  }
  post(
    {
      type: "frame",
      id: req.id,
      ms: performance.now() - t0,
      buffer: out.data.buffer as ArrayBuffer,
      width: out.width,
      height: out.height,
    },
    [out.data.buffer as ArrayBuffer],
  );
}

/** Rasterises finished pixels into whatever this host can transfer cheapest. */
async function makePayload(
  out: ImageData,
): Promise<Pick<ResultResponse, "bitmap" | "buffer" | "width" | "height">> {
  if (typeof createImageBitmap === "function") {
    try {
      // Straight from the pixels: no canvas to allocate, draw into and read.
      return { bitmap: await createImageBitmap(out) };
    } catch {
      // Some hosts accept bitmaps only from canvases; fall through.
    }
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(out.width, out.height);
      const g = canvas.getContext("2d");
      if (g) {
        g.putImageData(out, 0, 0);
        try {
          return { bitmap: await createImageBitmap(canvas) };
        } catch {
          // Legacy path below.
        }
      }
    }
  }
  // Legacy path: transfer the raw plane; the main thread uploads it. The plane
  // is freshly allocated above, so its buffer can move outright.
  return {
    buffer: out.data.buffer as ArrayBuffer,
    width: out.width,
    height: out.height,
  };
}

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  switch (req.type) {
    case "configure":
      budget.setQuality(req.quality);
      break;
    case "setSource": {
      // Empty buffer ⇒ "clear the source".
      if (req.buffer.byteLength === 0) {
        sourceW = 0;
        sourceH = 0;
        wasm?.engine.set_source(new Uint8ClampedArray(0), 0, 0);
        break;
      }
      sourceW = req.width;
      sourceH = req.height;
      // A view, not a copy: the engine copies into its own memory once.
      wasm?.engine.set_source(new Uint8ClampedArray(req.buffer), req.width, req.height);
      break;
    }
    case "setGlyphs": {
      const bytes = new Uint8Array(req.buffer);
      wasm?.engine.set_glyphs(bytes, req.count, req.cellWidth, req.cellHeight);
      break;
    }
    case "render":
      await handleRender(req);
      break;
    case "export":
      await handleExport(req);
      break;
    case "renderFrame":
      await handleFrame(req);
      break;
  }
};

void (async () => {
  // Module evaluation finishing IS readiness for message processing; the
  // handshake tells the hook which rung of the ladder we landed on, and its
  // init timeout covers hosts where even this never arrives.
  wasm = await loadWasmEngine();
  post({ type: "ready", backend: wasm ? "wasm" : "js" });
})();
