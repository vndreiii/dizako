import { dither } from "./algorithms";
import { cropImage } from "./region";
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

export type WorkerRequest = SourceInit | CoarseInit | RenderRequest | ExportRequest;

export interface ReadyResponse {
  type: "ready";
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

export type WorkerResponse =
  | ReadyResponse
  | ResultResponse
  | ProgressResponse
  | ExportedResponse
  | ExportPixelsResponse;

let source: ImageData | null = null;
let coarse: ImageData | null = null;

function adopt(buffer: ArrayBuffer, width: number, height: number): ImageData {
  const bytes =
    buffer instanceof Uint8ClampedArray ? buffer : new Uint8ClampedArray(buffer);
  return new ImageData(bytes, width, height);
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
  // is freshly allocated by the engine, so its buffer can move outright.
  return Promise.resolve({
    buffer: out.data.buffer as ArrayBuffer,
    width: out.width,
    height: out.height,
  });
}

async function handleRender(req: RenderRequest) {
  const t0 = performance.now();
  let input: ImageData | null = null;
  if (req.stage === "coarse") {
    input = coarse ?? source;
  } else if (req.region) {
    input = source ? cropImage(source, req.region) : null;
  } else {
    input = source;
  }
  if (!input) return;

  const out = dither(input, req.settings);
  const payload = await makePayload(out);
  post({ type: "result", id: req.id, stage: req.stage, ms: performance.now() - t0, ...payload });
}

async function handleExport(req: ExportRequest) {
  if (!source) return;
  const t0 = performance.now();
  post({ type: "progress", id: req.id, phase: "render" });
  const out = dither(source, req.settings);

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

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  switch (req.type) {
    case "setSource":
      source = adopt(req.buffer, req.width, req.height);
      break;
    case "setCoarseSource":
      coarse = adopt(req.buffer, req.width, req.height);
      break;
    case "render":
      void handleRender(req);
      break;
    case "export":
      void handleExport(req);
      break;
  }
};

// Module evaluation finishing IS readiness for message processing; the
// handshake lets the hook time out hosts where construction silently wedges.
post({ type: "ready" });
