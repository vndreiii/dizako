import { dither } from "./algorithms";
import type { Settings } from "./types";

export interface WorkerRequest {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  settings: Settings;
}

export interface WorkerResponse {
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  ms: number;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, width, height, buffer, settings } = e.data;
  const t0 = performance.now();

  const input = new ImageData(new Uint8ClampedArray(buffer), width, height);
  const out = dither(input, settings);
  const ms = performance.now() - t0;

  const payload: WorkerResponse = {
    id,
    width: out.width,
    height: out.height,
    buffer: out.data.buffer as ArrayBuffer,
    ms,
  };
  // Transfer the pixel buffer rather than structured-cloning it; at 4 bytes
  // per pixel a large image would otherwise be copied on every slider tick.
  (self as unknown as Worker).postMessage(payload, [payload.buffer]);
};
