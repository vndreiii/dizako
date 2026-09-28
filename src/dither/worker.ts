import { loadWasmEngine, type WasmBackend } from "./engine";
import type { Rect } from "./region";
import type { Settings } from "./types";

/**
 * Render-worker protocol.
 *
 * Pixel planes are resident: the source and its downscaled companion are
 * shipped once per load (`setSource` / `setCoarseSource`) and afterwards jobs
 * carry *only* settings plus geometry. That removes the per-dispatch copy of
 * the whole frame that every slider tick used to pay.
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

export interface CoarseInit {
  type: "setCoarseSource";
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
  buffer: ArrayBuffer;
  width: number;
  height: number;
  settings: Settings;
  /** `png` encodes in the worker; `pixels` transfers RGBA back for the caller. */
  encode: "png" | "pixels";
}

export type WorkerRequest =
  | SourceInit
  | CoarseInit
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

let source: ImageData | null = null;
let coarse: ImageData | null = null;
let wasm: WasmBackend | null = null;

function adopt(buffer: ArrayBuffer, width: number, height: number): ImageData | null {
  // Empty buffer ⇒ "clear this plane" (e.g. switching to an image that fits
  // the single-pass budget, which has no coarse downscale at all). Without
  // this the engine would keep dithering the previous image's plane.
  if (buffer.byteLength === 0) return null;
  const bytes =
    buffer instanceof Uint8ClampedArray ? buffer : new Uint8ClampedArray(buffer);
  return new ImageData(bytes, width, height);
}

/** Dims a render of `stage`/`region` produces, given resident planes. */
function dimsFor(stage: "coarse" | "fine", region: Rect | null): { w: number; h: number } | null {
  if (stage === "coarse") {
    const plane = coarse ?? source;
    return plane ? { w: plane.width, h: plane.height } : null;
  }
  if (region) return { w: region.width, h: region.height };
  return source ? { w: source.width, h: source.height } : null;
}

async function handleRender(req: RenderRequest) {
  const t0 = performance.now();
  const dims = dimsFor(req.stage, req.region);
  if (!dims) return;

  // The Rust engine owns copies of the planes (shipped once per change
  // below) and crops regions internally. There is no other engine.
  if (!wasm) {
    post({ type: "error", id: req.id, message: "wasm engine unavailable in worker" });
    return;
  }
  const len = wasm.engine.render(req.stage, req.region, req.settings);
  const bytes = wasm.view(len);
  const out = new ImageData(new Uint8ClampedArray(bytes), dims.w, dims.h);

  const payload = await makePayload(out);
  const transfer = payload.bitmap ? [payload.bitmap] : payload.buffer ? [payload.buffer] : [];
  post({ type: "result", id: req.id, stage: req.stage, ms: performance.now() - t0, ...payload }, transfer);
}

async function handleExport(req: ExportRequest) {
  if (!source) return;
  const t0 = performance.now();
  post({ type: "progress", id: req.id, phase: "render" });
  if (!wasm) {
    post({ type: "error", id: req.id, message: "wasm engine unavailable in worker" });
    return;
  }
  const len = wasm.engine.render("fine", null, req.settings);
  const bytes = wasm.view(len);
  const out = new ImageData(new Uint8ClampedArray(bytes), source.width, source.height);

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

async function handleFrame(req: FrameRequest) {
  const t0 = performance.now();
  if (!wasm) {
    post({ type: "error", id: req.id, message: "wasm engine unavailable in worker" });
    return;
  }
  const plane = new Uint8ClampedArray(req.buffer);
  if (plane.length !== req.width * req.height * 4) {
    post({
      type: "error",
      id: req.id,
      message: `frame ${req.id}: ${plane.length} bytes for ${req.width}x${req.height}`,
    });
    return;
  }
  wasm.engine.set_source(plane, req.width, req.height);
  // A one-shot render has no coarse companion; clearing it keeps a stale plane
  // from a previous job out of the stack.
  wasm.engine.set_coarse(new Uint8ClampedArray(0), 0, 0);
  const len = wasm.engine.render("fine", null, req.settings);
  const out = new ImageData(new Uint8ClampedArray(wasm.view(len)), req.width, req.height);

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
function makePayload(
  out: ImageData,
): Promise<Pick<ResultResponse, "bitmap" | "buffer" | "width" | "height">> {
  if (
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  ) {
    const canvas = new OffscreenCanvas(out.width, out.height);
    const g = canvas.getContext("2d");
    if (g) {
      g.putImageData(out, 0, 0);
      return createImageBitmap(canvas).then((bitmap) => ({ bitmap }));
    }
  }
  // Legacy path: transfer the raw plane; the main thread uploads it. The plane
  // is freshly allocated above, so its buffer can move outright.
  return Promise.resolve({
    buffer: out.data.buffer as ArrayBuffer,
    width: out.width,
    height: out.height,
  });
}

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  switch (req.type) {
    case "setSource": {
      source = adopt(req.buffer, req.width, req.height);
      if (source) {
        wasm?.engine.set_source(new Uint8ClampedArray(source.data), source.width, source.height);
      }
      break;
    }
    case "setCoarseSource": {
      coarse = adopt(req.buffer, req.width, req.height);
      const c = coarse;
      wasm?.engine.set_coarse(c ? new Uint8ClampedArray(c.data) : new Uint8ClampedArray(0), c?.width ?? 0, c?.height ?? 0);
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
