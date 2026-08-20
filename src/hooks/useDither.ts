import { useEffect, useRef, useState } from "react";
import type { WorkerRequest, WorkerResponse } from "../dither/worker";
import { dither } from "../dither/algorithms";
import type { Settings } from "../dither/types";

interface DitherResult {
  image: ImageData | null;
  busy: boolean;
  /** Duration of the last completed run, in milliseconds. */
  ms: number;
  /** True once the worker has failed and we are running on the main thread. */
  degraded: boolean;
}

/** How long to wait for a worker reply before declaring it broken. */
function watchdogMs(src: ImageData): number {
  const megapixels = (src.width * src.height) / 1e6;
  return Math.max(8000, megapixels * 4000);
}

/**
 * Runs the dither pipeline in a worker, re-running whenever the source or
 * settings change. Requests are coalesced: while one run is in flight the
 * latest pending settings replace any earlier queued run, so dragging a
 * slider never builds a backlog.
 *
 * Module workers are not reliably available everywhere the app runs — under
 * Tauri the WebKitGTK webview serves the bundle from a custom protocol, and
 * worker construction or `import.meta.url` chunk resolution can fail there.
 * A failure used to leave the preview blank forever, so the hook now watches
 * for a dead worker and transparently falls back to dithering on the main
 * thread. Slower on big images, but it always produces a picture.
 */
export function useDither(source: ImageData | null, settings: Settings): DitherResult {
  const workerRef = useRef<Worker | null>(null);
  const brokenRef = useRef(false);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<{ source: ImageData; settings: Settings } | null>(null);
  const lastRequestRef = useRef<{ source: ImageData; settings: Settings } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const [image, setImage] = useState<ImageData | null>(null);
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState(0);
  const [degraded, setDegraded] = useState(false);

  // Keep the dispatch logic reachable from callbacks without re-creating the
  // worker on every render.
  const runRef = useRef<(src: ImageData, cfg: Settings) => void>(() => {});

  function clearWatchdog() {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }

  function finish(result: ImageData, took: number) {
    clearWatchdog();
    setImage(result);
    setMs(took);
    inFlightRef.current = false;

    const next = pendingRef.current;
    pendingRef.current = null;
    if (next) runRef.current(next.source, next.settings);
    else setBusy(false);
  }

  /** Synchronous path used when no usable worker exists. */
  function runOnMainThread(src: ImageData, cfg: Settings) {
    inFlightRef.current = true;
    setBusy(true);
    // Defer a tick so React can paint the busy state before we block.
    window.setTimeout(() => {
      const t0 = performance.now();
      const out = dither(src, cfg);
      finish(out, performance.now() - t0);
    }, 0);
  }

  function demote(reason: string) {
    if (brokenRef.current) return;
    brokenRef.current = true;
    setDegraded(true);
    console.warn(`[dizako] dither worker unavailable (${reason}); using main thread.`);
    workerRef.current?.terminate();
    workerRef.current = null;
    clearWatchdog();
    inFlightRef.current = false;

    // Re-run whatever was outstanding so the preview is never left empty.
    const retry = pendingRef.current ?? lastRequestRef.current;
    pendingRef.current = null;
    if (retry) runOnMainThread(retry.source, retry.settings);
    else setBusy(false);
  }

  useEffect(() => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("../dither/worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      demote(String(err));
      return;
    }
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { width, height, buffer, ms: took } = e.data;
      finish(new ImageData(new Uint8ClampedArray(buffer), width, height), took);
    };
    worker.onerror = (e) => demote(e.message || "worker error");
    worker.onmessageerror = () => demote("message deserialisation failed");

    return () => {
      clearWatchdog();
      worker.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  runRef.current = (src: ImageData, cfg: Settings) => {
    lastRequestRef.current = { source: src, settings: cfg };

    const worker = workerRef.current;
    if (brokenRef.current || !worker) {
      runOnMainThread(src, cfg);
      return;
    }

    inFlightRef.current = true;
    setBusy(true);

    // Copy the source: the buffer is transferred and thus neutered, and the
    // original must survive for the next run.
    const copy = new Uint8ClampedArray(src.data);
    const req: WorkerRequest = {
      id: 0,
      width: src.width,
      height: src.height,
      buffer: copy.buffer as ArrayBuffer,
      settings: cfg,
    };

    try {
      worker.postMessage(req, [req.buffer]);
    } catch (err) {
      demote(String(err));
      return;
    }

    // A worker that never replies is the failure mode that used to leave the
    // preview permanently blank, so time it out rather than waiting forever.
    clearWatchdog();
    timerRef.current = window.setTimeout(() => demote("timed out"), watchdogMs(src));
  };

  useEffect(() => {
    if (!source) {
      setImage(null);
      lastRequestRef.current = null;
      return;
    }
    if (inFlightRef.current) pendingRef.current = { source, settings };
    else runRef.current(source, settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, settings]);

  return { image, busy, ms, degraded };
}
