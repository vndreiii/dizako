import { useEffect, useRef, useState } from "react";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../dither/worker";
import { loadWasmEngine } from "../dither/engine";
import { cropImage, regionFor, sameRect, type Rect } from "../dither/region";
import type { Settings } from "../dither/types";

/** A finished pass: a ready-to-draw bitmap from the worker, or raw pixels
 *  from the main-thread fallback. `drawImage` consumes either. */
export type Layer = ImageBitmap | ImageData;

export interface DitherResult {
  /** Whole image, possibly at reduced resolution. Always current. */
  coarse: Layer | null;
  /** Scale factor the coarse pass was rendered at; 1 means full resolution. */
  coarseScale: number;
  /** Full-resolution pass covering `region`, drawn over the coarse layer. */
  fine: Layer | null;
  region: Rect | null;
  /** No usable picture yet. */
  busy: boolean;
  /** A picture is on screen, but a sharper one is still being computed. */
  refining: boolean;
  ms: number;
  /** The preferred rung failed; running somewhere slower. */
  degraded: boolean;
  /** Which rung actually rendered the last frame ("worker", "main", …). */
  backendLabel: string;
  /** True while a full-resolution export job is in flight. */
  exporting: boolean;
  /** No engine could be initialised anywhere — the preview cannot render. */
  error: string | null;
}

export interface ExportHandle {
  /** Renders the whole resident source at native resolution and encodes PNG.
   *  Resolves `"cancelled"` when a newer export supersedes this one or the
   *  pipeline cannot serve it; otherwise resolves with the encoded blob. */
  requestExport(settings: Settings): Promise<{ blob: Blob } | "cancelled">;
}

/**
 * Pixel budget for the first pass.
 *
 * The point is a picture that lands fast enough to feel attached to the slider
 * being dragged.
 */
const COARSE_PIXELS = 240_000;

/** Below this the full pass is quick enough that staging it would only flicker. */
const SINGLE_PASS_PIXELS = 420_000;

function watchdogMs(px: number): number {
  return Math.max(8000, (px / 1e6) * 4000);
}

const coarseDownscales = new WeakMap<ImageData, Map<string, ImageData>>();

/** Box-downsamples via canvas, which is far quicker than doing it in JS.
 *  Memoised per `(source, size)`: a slider drag reuses the plane instead of
 *  re-running a multi-megapixel canvas round-trip every tick. */
function downscale(src: ImageData, w: number, h: number): ImageData {
  let bySize = coarseDownscales.get(src);
  if (!bySize) {
    bySize = new Map();
    coarseDownscales.set(src, bySize);
  }
  const key = `${w}x${h}`;
  const hit = bySize.get(key);
  if (hit) return hit;

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
  const out = ctx.getImageData(0, 0, w, h);
  bySize.set(key, out);
  return out;
}

type Stage = "coarse" | "fine";

interface Job {
  id: number;
  stage: Stage;
  settings: Settings;
  /** Where the result belongs, for a fine pass over a viewport crop. */
  region: Rect | null;
  /** Source-to-input scale for a coarse pass. */
  scale: number;
  /** Pixel count, for the watchdog budget. */
  pixels: number;
  /** Identity of the plane this job renders; late results for other
   *  sources must never touch preview state. */
  sourceTag: object;
}

interface InFlight {
  job: Job;
  /** Locally rebuilt inputs so a demoted fallback can run without the worker. */
  input: ImageData;
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
 * Pixel planes live in the worker: sources are shipped once per load and jobs
 * carry settings only, so slider ticks move kilobytes instead of megabytes.
 *
 * Requests coalesce: while one is in flight the latest pending settings
 * replace any earlier queued run, so a drag never builds a backlog.
 *
 * Module workers are not reliably available everywhere the app runs - under
 * Tauri the WebKitGTK webview serves the bundle from a custom protocol, and
 * worker construction or chunk resolution can fail there. A failure used to
 * leave the preview blank forever, so the hook watches construction, the init
 * handshake and each job, and transparently falls back to the main thread.
 */
export function useDither(
  source: ImageData | null,
  settings: Settings,
  viewport: Rect | null,
): DitherResult & ExportHandle {
  const workerRef = useRef<Worker | null>(null);
  const brokenRef = useRef(false);
  const readyRef = useRef(false);
  const inflightRef = useRef<InFlight | null>(null);
  const queuedRef = useRef<Job | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const nextId = useRef(1);
  const strikesRef = useRef(0);

  // What the worker currently holds, so sources ship exactly once.
  const sentSource = useRef<ImageData | null>(null);
  const sentCoarse = useRef<ImageData | null>(null);

  // Local mirrors for the demoted fallback path.
  const localSource = useRef<ImageData | null>(null);
  const localCoarse = useRef<ImageData | null>(null);

  // Identity of the plane the preview layers were rendered from. When it
  // changes, every on-screen layer is stale by definition - drawing an old
  // frame at the new image's aspect is exactly the "stretched old picture"
  // bug - so they are dropped up front and the stage shows its loading state
  // until fresh pixels arrive.
  const layerSourceRef = useRef<ImageData | null>(null);

  // Retired bitmaps awaiting collection; kept a few generations before close
  // so React never repaints a closed surface.
  const retired = useRef<ImageBitmap[]>([]);

  const [coarse, setCoarse] = useState<Layer | null>(null);
  const [coarseScale, setCoarseScale] = useState(1);
  const [fine, setFine] = useState<Layer | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const [refining, setRefining] = useState(false);
  const [ms, setMs] = useState(0);
  const [degraded, setDegraded] = useState(false);
  const [backendLabel, setBackendLabel] = useState("worker");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dispatchRef = useRef<(job: Job) => void>(() => {});
  // The latest-ref pattern: callbacks below must read current props without
  // re-subscribing effects on every render.
  // eslint-disable-next-line react-hooks/refs -- assignment happens during render by design
  const latest = useRef({ source, settings, viewport });
  // eslint-disable-next-line react-hooks/refs -- see above
  latest.current = { source, settings, viewport };

  function clearWatchdog() {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }

  function retireBitmap(b: ImageBitmap | null | undefined) {
    if (!b) return;
    retired.current.push(b);
    while (retired.current.length > 3) {
      retired.current.shift()?.close();
    }
  }

  /** Builds the full-resolution follow-up for whatever is on screen. */
  function fineJobFor(src: ImageData, cfg: Settings, view: Rect | null): Job | null {
    const r = regionFor(view, src.width, src.height, cfg);
    // A fine pass over the whole image is only worth queuing when the coarse
    // one actually lost detail.
    if (!r && src.width * src.height <= SINGLE_PASS_PIXELS) return null;
    const w = r ? r.width : src.width;
    const h = r ? r.height : src.height;
    return {
      id: nextId.current++,
      stage: "fine",
      settings: cfg,
      region: r,
      scale: 1,
      pixels: w * h,
      sourceTag: src,
    };
  }

  /** Ensures the worker holds the current planes; returns the coarse plane
   *  (or null when the image fits the single-pass budget). */
  function syncPlanes(src: ImageData): ImageData | null {
    let plane: ImageData | null = null;
    const total = src.width * src.height;
    if (total > SINGLE_PASS_PIXELS) {
      const scale = Math.sqrt(COARSE_PIXELS / total);
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      plane = downscale(src, w, h);
    }

    const worker = workerRef.current;
    if (worker && !brokenRef.current) {
      if (sentSource.current !== src) {
        const copy = new Uint8ClampedArray(src.data);
        worker.postMessage(
          { type: "setSource", buffer: copy.buffer as ArrayBuffer, width: src.width, height: src.height },
          [copy.buffer as ArrayBuffer],
        );
        sentSource.current = src;
      }
      if (sentCoarse.current !== plane) {
        const copy = plane
          ? new Uint8ClampedArray(plane.data)
          : new Uint8ClampedArray(0); // explicit clear: previous image's plane must go
        worker.postMessage(
          { type: "setCoarseSource", buffer: copy.buffer as ArrayBuffer, width: plane?.width ?? 0, height: plane?.height ?? 0 },
          [copy.buffer as ArrayBuffer],
        );
        sentCoarse.current = plane;
      }
    }
    localSource.current = src;
    localCoarse.current = plane;
    return plane;
  }

  function coarseJobFor(src: ImageData, cfg: Settings): { job: Job; input: ImageData } {
    const total = src.width * src.height;
    if (total <= SINGLE_PASS_PIXELS) {
      return {
        job: { id: nextId.current++, stage: "coarse", settings: cfg, region: null, scale: 1, pixels: total, sourceTag: src },
        input: src,
      };
    }
    const scale = Math.sqrt(COARSE_PIXELS / total);
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const plane = downscale(src, w, h);
    return {
      job: {
        id: nextId.current++,
        stage: "coarse",
        settings: cfg,
        region: null,
        scale: src.width / w,
        pixels: w * h,
        sourceTag: src,
      },
      input: plane,
    };
  }

  function inputFor(job: Job): ImageData | null {
    if (job.stage === "coarse") {
      return localCoarse.current ?? localSource.current;
    }
    const src = localSource.current;
    if (!src) return null;
    return job.region ? cropImage(src, job.region) : src;
  }

  function settle(job: Job, result: Layer, took: number) {
    clearWatchdog();
    strikesRef.current = 0;
    setMs(took);
    if (job.stage === "coarse") {
      setCoarse((prev) => {
        retireBitmap(prev instanceof ImageBitmap ? prev : null);
        return result;
      });
      setFine((prev) => {
        if (prev instanceof ImageBitmap) retireBitmap(prev);
        return null;
      });
      setCoarseScale(job.scale);
      setRegion(null);
      setBusy(false);
    } else {
      setFine((prev) => {
        retireBitmap(prev instanceof ImageBitmap ? prev : null);
        return result;
      });
      setRegion(job.region);
    }
    inflightRef.current = null;

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

  function runOnMainThread(inflight: InFlight) {
    inflightRef.current = inflight;
    window.setTimeout(() => {
      if (inflightRef.current?.job.id !== inflight.job.id) return;
      void renderMainAsync(inflight);
    }, 0);
  }

  /** Main-thread render via initSync — the last rung under the worker.
   *  `inflight.input` is already the exact plane (cropped if needed), so the
   *  stateless fallback uploads it whole and renders without a region. */
  async function renderMainAsync(inflight: InFlight) {
    const t0 = performance.now();
    try {
      const w = await loadWasmEngine();
      if (!w) throw new Error("wasm unavailable on main thread");
      const img = inflight.input;
      w.engine.set_source(
        new Uint8ClampedArray(img.data),
        img.width,
        img.height,
      );
      const len = w.engine.render(inflight.job.stage, null, inflight.job.settings);
      const bytes = w.view(len);
      const out = new ImageData(new Uint8ClampedArray(bytes), img.width, img.height);
      if (inflightRef.current?.job.id !== inflight.job.id) return;
      setError(null);
      settle(inflight.job, out, performance.now() - t0);
      return;
    } catch (err) {
      // No engine anywhere. Surface it; there is no third engine to fall
      // back to by design (one visual truth).
      console.error("[dizako] no dither engine could be initialised:", err);
      inflightRef.current = null;
      clearWatchdog();
      setBusy(false);
      setRefining(false);
      setError(String((err as Error)?.message ?? err));
    }
  }

  /** Watchdog fired without a reply. Demotion is permanent and costly, so
   *  first try re-kicking the current job - a wedged host stays wedged and
   *  demotes on the second strike; a merely slow frame recovers silently. */
  function watchdogStrike() {
    const inflight = inflightRef.current;
    if (!inflight || brokenRef.current || !workerRef.current) {
      demote("timed out");
      return;
    }
    strikesRef.current += 1;
    if (strikesRef.current >= 2) {
      demote(`timed out twice (${inflight.job.stage})`);
      return;
    }
    console.warn("[dizako] render timed out; re-kicking worker.");
    syncPlanes(latest.current.source!);
    dispatchRef.current(inflight.job);
  }

  function demote(reason: string) {
    if (brokenRef.current) return;
    brokenRef.current = true;
    setDegraded(true);
    console.warn(`[dizako] dither worker unavailable (${reason}); using main thread.`);
    workerRef.current?.terminate();
    workerRef.current = null;
    clearWatchdog();

    const retry = queuedRef.current;
    const inflight = inflightRef.current;
    queuedRef.current = null;
    inflightRef.current = null;
    if (inflight || retry) {
      if (retry) setBusy(true);
      if (inflight) runOnMainThread(inflight);
      else if (retry) {
        const input = inputFor(retry);
        if (input) runOnMainThread({ job: retry, input });
        else setBusy(false);
      }
    } else {
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
    readyRef.current = false;

    // If the module never evaluates (blocked asset, wedged host), fall back
    // instead of waiting on a job watchdog that can never start.
    const initTimer = window.setTimeout(() => demote("init timed out"), 4000);

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "ready") {
        readyRef.current = true;
        window.clearTimeout(initTimer);
        setBackendLabel(`worker · ${msg.backend}`);
        return;
      }
      if (msg.type === "error") {
        window.clearTimeout(initTimer);
        // The worker has no engine at all; demote to the main-thread rung.
        demote(msg.message || "no engine in worker");
        return;
      }
      if (msg.type === "result") {
        const inflight = inflightRef.current;
        // A reply for a job we have already moved past is stale; dropping it
        // keeps a slow coarse pass from overwriting a newer fine one - and a
        // reply computed from the PREVIOUS image must never reach the screen.
        if (!inflight || inflight.job.id !== msg.id) return;
        if (latest.current.source && inflight.job.sourceTag !== latest.current.source) return;
        if (msg.bitmap) {
          settle(inflight.job, msg.bitmap, msg.ms);
        } else if (msg.buffer && msg.width && msg.height) {
          const img = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
          settle(inflight.job, img, msg.ms);
        }
        return;
      }
    };
    worker.onerror = (e) => demote(e.message || "worker error");
    worker.onmessageerror = () => demote("message deserialisation failed");

    return () => {
      window.clearTimeout(initTimer);
      clearWatchdog();
      worker.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebound every render on purpose: dispatch always reads the newest
  // closure over refs, while the effect subscriptions stay stable.
  // eslint-disable-next-line react-hooks/refs -- intentional render-time binding
  dispatchRef.current = (job: Job) => {
    const worker = workerRef.current;
    if (brokenRef.current || !worker) {
      const input = inputFor(job);
      if (!input) return;
      runOnMainThread({ job, input });
      return;
    }

    inflightRef.current = { job, input: localSource.current! };

    const req: WorkerRequest = {
      type: "render",
      id: job.id,
      stage: job.stage,
      region: job.region,
      settings: job.settings,
    };

    try {
      worker.postMessage(req);
    } catch (err) {
      demote(String(err));
      return;
    }

    clearWatchdog();
    timerRef.current = window.setTimeout(watchdogStrike, watchdogMs(job.pixels));
  };

  /** Source or settings changed: restart from the coarse pass. */
  useEffect(() => {
    if (!source) {
      setCoarse(null);
      setFine(null);
      setRegion(null);
      setBusy(false);
      setRefining(false);
      inflightRef.current = null;
      queuedRef.current = null;
      sentSource.current = null;
      sentCoarse.current = null;
      localSource.current = null;
      localCoarse.current = null;
      layerSourceRef.current = null;
      return;
    }
    if (layerSourceRef.current !== source) {
      layerSourceRef.current = source;
      setCoarse(null);
      setFine(null);
      setRegion(null);
      setCoarseScale(1);
    }
    syncPlanes(source);
    const { job } = coarseJobFor(source, settings);
    setBusy(true);
    setRefining(true);
    if (inflightRef.current) queuedRef.current = job;
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
      if (inflightRef.current) queuedRef.current = job;
      else dispatchRef.current(job);
    }, 160);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, source, busy]);

  /**
   * Full-resolution export through the same pipeline, off the main thread.
   *
   * Preview and export share the engine and the job shape now, so the class
   * of bugs where the exported PNG disagreed with the preview closes
   * structurally rather than by vigilance.
   *
   * One export at a time: starting another resolves the running one as
   * cancelled; its eventual worker reply is dropped by the id check.
   */
  const exportSeq = useRef(0);
  const activeExport = useRef<{ id: number; resolve: (v: { blob: Blob } | "cancelled") => void } | null>(null);

  const finishExport = (id: number, value: { blob: Blob } | "cancelled") => {
    const active = activeExport.current;
    if (!active || active.id !== id) return;
    activeExport.current = null;
    setExporting(false);
    active.resolve(value);
  };

  const requestExport = (cfg: Settings): Promise<{ blob: Blob } | "cancelled"> => {
    if (activeExport.current) finishExport(activeExport.current.id, "cancelled");

    const id = ++exportSeq.current;
    setExporting(true);
    return new Promise((resolve) => {
      activeExport.current = { id, resolve };

      const worker = workerRef.current;
      if (brokenRef.current || !worker) {
        const src = localSource.current;
        if (!src) {
          finishExport(id, "cancelled");
          return;
        }
        window.setTimeout(async () => {
          if (!activeExport.current || activeExport.current.id !== id) return;
          try {
            const w = await loadWasmEngine();
            if (!w) throw new Error("wasm unavailable on main thread");
            w.engine.set_source(new Uint8ClampedArray(src.data), src.width, src.height);
            const len = w.engine.render("fine", null, cfg);
            const bytes = w.view(len);
            const outImg = new ImageData(new Uint8ClampedArray(bytes), src.width, src.height);
            const canvas = document.createElement("canvas");
            canvas.width = outImg.width;
            canvas.height = outImg.height;
            canvas.getContext("2d")!.putImageData(outImg, 0, 0);
            canvas.toBlob((blob) => {
              if (!blob) finishExport(id, "cancelled");
              else finishExport(id, { blob });
            }, "image/png");
          } catch (err) {
            console.error("[dizako] export failed:", err);
            finishExport(id, "cancelled");
          }
        }, 0);
        return;
      }

      const onMessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === "progress") return;
        if (
          (msg.type === "exported" || msg.type === "exportPixels") &&
          msg.id === id
        ) {
          worker.removeEventListener("message", onMessage);
          if (!activeExport.current || activeExport.current.id !== id) return;
          if (msg.type === "exported") {
            finishExport(id, { blob: msg.blob });
          } else {
            // Host without OffscreenCanvas: encode on the main thread.
            const img = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext("2d")!.putImageData(img, 0, 0);
            canvas.toBlob((blob) => {
              if (blob) finishExport(id, { blob });
              else finishExport(id, "cancelled");
            }, "image/png");
          }
        }
      };
      worker.addEventListener("message", onMessage);

      try {
        worker.postMessage({ type: "export", id, settings: cfg } satisfies WorkerRequest);
      } catch (err) {
        worker.removeEventListener("message", onMessage);
        demote(String(err));
        finishExport(id, "cancelled");
      }
    });
  };

  return {
    coarse,
    coarseScale,
    fine,
    region,
    busy,
    refining,
    ms,
    degraded,
    backendLabel,
    exporting,
    error,
    requestExport,
  };
}
