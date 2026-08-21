import { useEffect, useRef, useState } from "react";
import type { WorkerRequest, WorkerResponse } from "../dither/worker";
import { dither } from "../dither/algorithms";
import { cropImage, regionFor, sameRect, type Rect } from "../dither/region";
import type { Settings } from "../dither/types";

export interface DitherResult {
  /** Whole image, possibly at reduced resolution. Always current. */
  coarse: ImageData | null;
  /** Scale factor the coarse pass was rendered at; 1 means full resolution. */
  coarseScale: number;
  /** Full-resolution pass covering `region`, drawn over the coarse layer. */
  fine: ImageData | null;
  region: Rect | null;
  /** No usable picture yet. */
  busy: boolean;
  /** A picture is on screen, but a sharper one is still being computed. */
  refining: boolean;
  ms: number;
  degraded: boolean;
}

/**
 * Pixel budget for the first pass.
 *
 * The point is a picture that lands fast enough to feel attached to the slider
 * being dragged. At this size even dot diffusion - easily the most expensive
 * algorithm here, since it walks the image once per rank of its class matrix -
 * comes back in well under a frame or two.
 */
const COARSE_PIXELS = 240_000;

/** Below this the full pass is quick enough that staging it would only flicker. */
const SINGLE_PASS_PIXELS = 420_000;

function watchdogMs(px: number): number {
  return Math.max(8000, (px / 1e6) * 4000);
}

/** Box-downsamples via canvas, which is far quicker than doing it in JS. */
function downscale(src: ImageData, w: number, h: number): ImageData {
  const from = document.createElement("canvas");
  from.width = src.width;
  from.height = src.height;
  from.getContext("2d")!.putImageData(src, 0, 0);

  const to = document.createElement("canvas");
  to.width = w;
  to.height = h;
  const ctx = to.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(from, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

type Stage = "coarse" | "fine";

interface Job {
  id: number;
  stage: Stage;
  input: ImageData;
  settings: Settings;
  /** Where the result belongs, for a fine pass. */
  region: Rect | null;
  /** Source-to-input scale for a coarse pass. */
  scale: number;
}

/**
 * Renders the preview in two stages.
 *
 * A dither pass costs roughly one unit of work per pixel, so at full
 * resolution the heavier algorithms take long enough that dragging a slider
 * stops feeling connected to what is on screen. So the whole image is
 * dithered small first and shown immediately, and only then is the part you
 * are actually looking at re-rendered at full resolution on top of it.
 *
 * Zoomed in, that second pass covers the viewport rather than the image - the
 * pixels scrolled off screen would be thrown away, and on a large image they
 * are the overwhelming majority of the work.
 *
 * Requests coalesce: while one is in flight the latest pending settings
 * replace any earlier queued run, so a slider drag never builds a backlog.
 *
 * Module workers are not reliably available everywhere the app runs - under
 * Tauri the WebKitGTK webview serves the bundle from a custom protocol, and
 * worker construction or `import.meta.url` chunk resolution can fail there.
 * A failure used to leave the preview blank forever, so the hook watches for a
 * dead worker and transparently falls back to the main thread.
 */
export function useDither(
  source: ImageData | null,
  settings: Settings,
  viewport: Rect | null,
): DitherResult {
  const workerRef = useRef<Worker | null>(null);
  const brokenRef = useRef(false);
  const jobRef = useRef<Job | null>(null);
  const queuedRef = useRef<Job | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const nextId = useRef(1);

  const [coarse, setCoarse] = useState<ImageData | null>(null);
  const [coarseScale, setCoarseScale] = useState(1);
  const [fine, setFine] = useState<ImageData | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [ms, setMs] = useState(0);
  const [degraded, setDegraded] = useState(false);

  const dispatchRef = useRef<(job: Job) => void>(() => {});
  // Read inside callbacks that must not re-subscribe on every change.
  const latest = useRef({ source, settings, viewport });
  latest.current = { source, settings, viewport };

  function clearWatchdog() {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }

  /** Builds the full-resolution follow-up for whatever is on screen. */
  function fineJobFor(src: ImageData, cfg: Settings, view: Rect | null): Job | null {
    const r = regionFor(view, src.width, src.height, cfg);
    // A fine pass over the whole image is only worth queuing when the coarse
    // one actually lost detail.
    if (!r && src.width * src.height <= SINGLE_PASS_PIXELS) return null;
    return {
      id: nextId.current++,
      stage: "fine",
      input: r ? cropImage(src, r) : src,
      settings: cfg,
      region: r,
      scale: 1,
    };
  }

  function coarseJobFor(src: ImageData, cfg: Settings): Job {
    const total = src.width * src.height;
    if (total <= SINGLE_PASS_PIXELS) {
      return { id: nextId.current++, stage: "coarse", input: src, settings: cfg, region: null, scale: 1 };
    }
    const scale = Math.sqrt(COARSE_PIXELS / total);
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    return {
      id: nextId.current++,
      stage: "coarse",
      input: downscale(src, w, h),
      settings: cfg,
      region: null,
      scale: src.width / w,
    };
  }

  function settle(job: Job, result: ImageData, took: number) {
    clearWatchdog();
    setMs(took);
    if (job.stage === "coarse") {
      setCoarse(result);
      setCoarseScale(job.scale);
      // The coarse layer covers the whole image, so anything sharper that was
      // drawn over it belongs to the previous settings and has to go.
      setFine(null);
      setRegion(null);
      setBusy(false);
    } else {
      setFine(result);
      setRegion(job.region);
    }
    jobRef.current = null;

    const queued = queuedRef.current;
    queuedRef.current = null;
    if (queued) {
      dispatchRef.current(queued);
      return;
    }

    if (job.stage === "coarse") {
      const { source: src, settings: cfg, viewport: view } = latest.current;
      const next = src ? fineJobFor(src, cfg, view) : null;
      if (next) {
        setRefining(true);
        dispatchRef.current(next);
        return;
      }
    }
    setRefining(false);
  }

  function runOnMainThread(job: Job) {
    jobRef.current = job;
    window.setTimeout(() => {
      if (jobRef.current?.id !== job.id) return;
      const t0 = performance.now();
      const out = dither(job.input, job.settings);
      settle(job, out, performance.now() - t0);
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

    const retry = queuedRef.current ?? jobRef.current;
    queuedRef.current = null;
    jobRef.current = null;
    if (retry) runOnMainThread(retry);
    else {
      setBusy(false);
      setRefining(false);
    }
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
      const { id, width, height, buffer, ms: took } = e.data;
      const job = jobRef.current;
      // A reply for a job we have already moved past is stale; dropping it
      // keeps a slow coarse pass from overwriting a newer fine one.
      if (!job || job.id !== id) return;
      settle(job, new ImageData(new Uint8ClampedArray(buffer), width, height), took);
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

  dispatchRef.current = (job: Job) => {
    const worker = workerRef.current;
    if (brokenRef.current || !worker) {
      runOnMainThread(job);
      return;
    }

    jobRef.current = job;

    // Copy the pixels: the buffer is transferred and thus neutered, and the
    // source has to survive for the next run.
    const copy = new Uint8ClampedArray(job.input.data);
    const req: WorkerRequest = {
      id: job.id,
      width: job.input.width,
      height: job.input.height,
      buffer: copy.buffer as ArrayBuffer,
      settings: job.settings,
    };

    try {
      worker.postMessage(req, [req.buffer]);
    } catch (err) {
      demote(String(err));
      return;
    }

    clearWatchdog();
    timerRef.current = window.setTimeout(
      () => demote("timed out"),
      watchdogMs(job.input.width * job.input.height),
    );
  };

  /** Source or settings changed: restart from the coarse pass. */
  useEffect(() => {
    if (!source) {
      setCoarse(null);
      setFine(null);
      setRegion(null);
      setBusy(false);
      setRefining(false);
      jobRef.current = null;
      queuedRef.current = null;
      return;
    }
    const job = coarseJobFor(source, settings);
    setBusy(true);
    setRefining(true);
    if (jobRef.current) queuedRef.current = job;
    else dispatchRef.current(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, settings]);

  /**
   * Panning or zooming does not change the picture, only which part of it is
   * worth rendering sharply - so re-run the fine pass alone.
   */
  useEffect(() => {
    if (!source || busy) return;
    const next = regionFor(viewport, source.width, source.height, settings);
    if (sameRect(next, region)) return;

    const t = window.setTimeout(() => {
      const job = fineJobFor(source, settings, viewport);
      if (!job) return;
      setRefining(true);
      if (jobRef.current) queuedRef.current = job;
      else dispatchRef.current(job);
    }, 160);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, source, busy]);

  return { coarse, coarseScale, fine, region, busy, refining, ms, degraded };
}
