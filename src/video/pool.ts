/**
 * A pool of dither workers for video export.
 *
 * Frames are independent: nothing about frame 40 depends on frame 39, because
 * every pass starts from a clean error plane. That makes video export the one
 * part of Dizako that parallelises perfectly, and the difference is not
 * marginal - on an eight-core machine a clip renders in roughly a sixth of the
 * time a single worker takes.
 *
 * The pool is created for the duration of one export and torn down after, so
 * the preview's own worker keeps its resident planes and stays interactive
 * while an export runs.
 */
import type { FrameRequest, WorkerResponse } from "../dither/worker";
import { loadWasmEngine } from "../dither/engine";
import type { Settings } from "../dither/types";
import { appError } from "../errors";

/** Per-frame budget before the worker is assumed wedged. */
const FRAME_TIMEOUT_BASE_MS = 30_000;

interface Pending {
  resolve: (blob: Blob) => void;
  reject: (err: unknown) => void;
  timer: number;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  /**
   * Resolves when the worker has reported its engine ready.
   *
   * A freshly constructed worker instantiates wasm asynchronously, so a job
   * posted immediately after `new Worker` is answered with
   * "wasm engine unavailable" and the frame is lost. Every dispatch therefore
   * waits on this first - a no-op for all but the opening frames.
   */
  ready: Promise<void>;
}

/** A worker that never announces itself is not going to; use another rung. */
const READY_TIMEOUT_MS = 10_000;

/**
 * How many workers to run.
 *
 * One per core minus one, so the UI thread and the compositor still get a core
 * and the window does not freeze for the length of the export. Capped at six:
 * beyond that the wasm instances' memory (one error plane each) costs more
 * than the extra parallelism returns.
 */
export function suggestedPoolSize(): number {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4;
  return Math.max(1, Math.min(6, cores - 1));
}

export interface RenderPool {
  readonly size: number;
  /** True when no worker could be started and rendering is on the main thread. */
  readonly degraded: boolean;
  /**
   * Dithers one frame and returns it as a PNG blob.
   *
   * Takes ownership of `image`: its backing buffer is transferred to a worker
   * and must not be read again by the caller.
   */
  render(image: ImageData, settings: Settings): Promise<Blob>;
  dispose(): void;
}

export function createRenderPool(size = suggestedPoolSize()): RenderPool {
  const slots: Slot[] = [];
  const pending = new Map<number, Pending>();
  const queue: Array<() => void> = [];
  let seq = 1;
  let disposed = false;

  for (let i = 0; i < size; i++) {
    try {
      const worker = new Worker(new URL("../dither/worker.ts", import.meta.url), { type: "module" });
      let announceReady: () => void = () => {};
      let announceDead: (err: unknown) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        announceReady = resolve;
        announceDead = reject;
      });
      const readyTimer = window.setTimeout(
        () => announceDead(appError("engine/unavailable", { detail: `render worker silent for ${READY_TIMEOUT_MS}ms` })),
        READY_TIMEOUT_MS,
      );
      const slot: Slot = { worker, busy: false, ready };
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          window.clearTimeout(readyTimer);
          announceReady();
          return;
        }
        if (msg.type === "frame") {
          slot.busy = false;
          const waiting = pending.get(msg.id);
          if (waiting) {
            pending.delete(msg.id);
            window.clearTimeout(waiting.timer);
            if (msg.blob) waiting.resolve(msg.blob);
            else if (msg.buffer && msg.width && msg.height) {
              // Host without OffscreenCanvas: encode on the main thread.
              encodeOnMainThread(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height)).then(
                waiting.resolve,
                waiting.reject,
              );
            } else {
              waiting.reject(appError("export/encode-failed", { detail: `frame ${msg.id} came back empty` }));
            }
          }
          queue.shift()?.();
          return;
        }
        if (msg.type === "error") {
          // An error with no job id is an init failure, not a frame failure.
          if (msg.id === undefined) {
            window.clearTimeout(readyTimer);
            announceDead(appError("engine/unavailable", { detail: msg.message }));
            return;
          }
          slot.busy = false;
          const waiting = msg.id !== undefined ? pending.get(msg.id) : undefined;
          if (waiting && msg.id !== undefined) {
            pending.delete(msg.id);
            window.clearTimeout(waiting.timer);
            waiting.reject(appError("export/render-failed", { detail: msg.message }));
          }
          queue.shift()?.();
        }
      };
      worker.onerror = (e) => {
        slot.busy = false;
        window.clearTimeout(readyTimer);
        announceDead(appError("engine/unavailable", { detail: e.message || "render worker error" }));
        failAll(appError("export/render-failed", { detail: e.message || "render worker error" }));
      };
      // Nothing else awaits `ready`; without this a rejection before the first
      // dispatch is an unhandled rejection rather than a fallback.
      ready.catch(() => {});
      slots.push(slot);
    } catch {
      // Construction failing for the first worker means it will fail for all
      // of them; stop asking and let the main-thread path take over.
      break;
    }
  }

  function failAll(err: unknown) {
    for (const [id, waiting] of pending) {
      window.clearTimeout(waiting.timer);
      waiting.reject(err);
      pending.delete(id);
    }
    queue.length = 0;
  }

  async function encodeOnMainThread(image: ImageData): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw appError("image/no-2d-context", { detail: "no context for PNG encoding" });
    ctx.putImageData(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(appError("export/encode-failed", { detail: "canvas.toBlob returned null" }));
      }, "image/png");
    });
  }

  /** Single-threaded last rung: identical pixels, one frame at a time. */
  async function renderOnMainThread(image: ImageData, settings: Settings): Promise<Blob> {
    const wasm = await loadWasmEngine();
    if (!wasm) {
      throw appError("engine/unavailable", { detail: "wasm engine unavailable on the main thread" });
    }
    wasm.engine.set_source(new Uint8ClampedArray(image.data), image.width, image.height);
    wasm.engine.set_coarse(new Uint8ClampedArray(0), 0, 0);
    const len = wasm.engine.render("fine", null, settings);
    const out = new ImageData(new Uint8ClampedArray(wasm.view(len)), image.width, image.height);
    return encodeOnMainThread(out);
  }

  return {
    size: slots.length || 1,
    degraded: slots.length === 0,

    render(image, settings) {
      if (disposed) return Promise.reject(appError("video/export-cancelled", { detail: "pool disposed" }));
      if (slots.length === 0) return renderOnMainThread(image, settings);

      const dispatch = async (slot: Slot): Promise<Blob> => {
        slot.busy = true;
        try {
          await slot.ready;
        } catch {
          // This worker never came up. The frame is still owed an answer, so
          // it goes to the main-thread engine rather than being lost.
          slot.busy = false;
          queue.shift()?.();
          return renderOnMainThread(image, settings);
        }
        const id = seq++;
        const request: FrameRequest = {
          type: "renderFrame",
          id,
          buffer: image.data.buffer as ArrayBuffer,
          width: image.width,
          height: image.height,
          settings,
          encode: "png",
        };
        return new Promise<Blob>((resolve, reject) => {
          // Scaled by frame size: a 4K frame through a twelve-tap kernel is
          // legitimately slow, and a fixed budget would abort a healthy job.
          const budget = FRAME_TIMEOUT_BASE_MS + (image.width * image.height) / 40_000;
          const timer = window.setTimeout(() => {
            pending.delete(id);
            slot.busy = false;
            reject(
              appError("engine/render-timeout", {
                detail: `frame render did not return within ${Math.round(budget)}ms`,
              }),
            );
            queue.shift()?.();
          }, budget);
          pending.set(id, { resolve, reject, timer });
          try {
            slot.worker.postMessage(request, [request.buffer]);
          } catch (err) {
            pending.delete(id);
            window.clearTimeout(timer);
            slot.busy = false;
            reject(appError("export/render-failed", { detail: String(err), cause: err }));
          }
        });
      };

      const free = slots.find((s) => !s.busy);
      if (free) return dispatch(free);

      // All busy: wait for whichever finishes first.
      return new Promise<Blob>((resolve, reject) => {
        queue.push(() => {
          const slot = slots.find((s) => !s.busy);
          if (!slot) {
            // Should not happen - the queue is only drained on completion -
            // but re-queueing is strictly better than dropping the frame.
            queue.push(() => void dispatch(slots[0]!).then(resolve, reject));
            return;
          }
          dispatch(slot).then(resolve, reject);
        });
      });
    },

    dispose() {
      disposed = true;
      failAll(appError("video/export-cancelled", { detail: "pool disposed" }));
      for (const slot of slots) slot.worker.terminate();
      slots.length = 0;
    },
  };
}
