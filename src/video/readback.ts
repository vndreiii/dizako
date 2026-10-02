import type { FrameHandle, ReadbackRequest, ReadbackResponse } from "./readback.worker";
import { appError } from "../errors";

/**
 * Main-thread side of the frame readback worker.
 *
 * The worker is created on first use and kept: spinning one up per frame would
 * cost more than the readback it saves.
 */

const TIMEOUT_MS = 15_000;

interface Waiting {
  resolve: (value: { image: ImageData; blank: boolean }) => void;
  reject: (err: unknown) => void;
  timer: number;
}

let worker: Worker | null = null;
let seq = 1;
const waiting = new Map<number, Waiting>();

/**
 * Whether this route can possibly work here. False means "use the canvas
 * route", decided up front so no frame is spent finding out.
 */
export function readbackSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./readback.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<ReadbackResponse>) => {
    const msg = e.data;
    const pending = waiting.get(msg.id);
    if (!pending) return;
    waiting.delete(msg.id);
    window.clearTimeout(pending.timer);
    if (msg.type === "failed") {
      pending.reject(appError("video/frame-grab-failed", { detail: `readback worker: ${msg.message}` }));
      return;
    }
    pending.resolve({
      image: new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height),
      blank: msg.blank,
    });
  };
  const fail = (detail: string) => {
    for (const [id, p] of waiting) {
      window.clearTimeout(p.timer);
      p.reject(appError("video/frame-grab-failed", { detail }));
      waiting.delete(id);
    }
    // A dead worker is not reused: the next call builds a fresh one.
    worker?.terminate();
    worker = null;
  };
  w.onerror = (e) => fail(e.message || "readback worker error");
  w.onmessageerror = () => fail("readback worker message could not be read");
  worker = w;
  return w;
}

/** Rasterises a decoded frame into pixels, scaled, off the main thread. Takes ownership of `frame`. */
export function readbackFrame(frame: FrameHandle, width: number, height: number): Promise<{ image: ImageData; blank: boolean }> {
  return new Promise((resolve, reject) => {
    const id = seq++;
    let w: Worker;
    try {
      w = ensureWorker();
    } catch (err) {
      frame.close();
      reject(appError("video/frame-grab-failed", { detail: `could not start the readback worker: ${String(err)}`, cause: err }));
      return;
    }
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      reject(appError("video/frame-grab-failed", { detail: `readback did not finish within ${TIMEOUT_MS}ms` }));
    }, TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    const request: ReadbackRequest = { type: "readback", id, frame, width, height };
    try {
      w.postMessage(request, [frame]);
    } catch (err) {
      waiting.delete(id);
      window.clearTimeout(timer);
      reject(appError("video/frame-grab-failed", { detail: String(err), cause: err }));
    }
  });
}

export function disposeReadback(): void {
  worker?.terminate();
  worker = null;
  for (const [id, p] of waiting) {
    window.clearTimeout(p.timer);
    p.reject(appError("video/frame-grab-failed", { detail: "readback disposed" }));
    waiting.delete(id);
  }
}
