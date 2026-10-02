import { useEffect, useRef, useState } from "react";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../dither/worker";
import { loadWasmEngine } from "../dither/engine";
import { regionFor, coversRect, type Rect } from "../dither/region";
import { CoarseBudget, type PreviewQuality } from "../dither/budget";
import { trace } from "../perf";
import type { Settings } from "../dither/types";
import { atlasKey, buildGlyphAtlas, fontCss, type GlyphAtlas } from "../dither/glyphs";
import { codepointsFor, codepointsFromText } from "../dither/scripts";

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

export interface DitherOptions {
  /**
   * Skip the full-resolution follow-up pass.
   *
   * Set while a clip is playing. Every displayed frame is a new source, so a
   * fine pass queued for frame N is stale before it finishes and only competes
   * with frame N+1 for the worker. The coarse pass alone is what keeps playback
   * moving; the sharp pass returns the moment the playhead stops.
   */
  skipFine?: boolean;
  /** How snappy the first preview pass should be; see `PreviewQuality`. */
  quality?: PreviewQuality;
}

export interface ExportHandle {
  /** Renders the whole resident source at native resolution and encodes PNG.
   *  Resolves `"cancelled"` when a newer export supersedes this one or the
   *  pipeline cannot serve it; otherwise resolves with the encoded blob. */
  requestExport(settings: Settings): Promise<{ blob: Blob } | "cancelled">;
}

/** How long the picture must stay still before the sharpening pass starts. */
const REFINE_DELAY_MS = 150;

function watchdogMs(px: number, settings: Settings): number {
  const passes = settings.algorithmLayers.length
    ? Math.max(1, settings.algorithmLayers.filter((layer) => layer.enabled && layer.opacity > 0).length)
    : 1;
  return Math.max(8000, (px / 1e6) * 4000) * passes;
}

/**
 * Does this settings object actually use text mode?
 *
 * Checked before any rasterisation happens: building an atlas is real work and
 * must not run for the ninety-nine percent of sessions that never touch the
 * algorithm.
 */
function usesAscii(settings: Settings): boolean {
  if (settings.algorithmLayers.length === 0) return settings.algorithm === "ascii";
  return settings.algorithmLayers.some(
    (layer) => layer.enabled && layer.opacity > 0 && layer.algorithm === "ascii",
  );
}

/** The atlas the current settings ask for, memoised against its inputs. */
let cachedAtlas: { key: string; atlas: GlyphAtlas } | null = null;

function atlasFor(settings: Settings): GlyphAtlas | null {
  const codepoints =
    settings.asciiCharset === "custom"
      ? codepointsFromText(settings.asciiCustom)
      : codepointsFor(settings.asciiCharset);
  if (codepoints.length === 0) return null;

  const request = {
    codepoints,
    cellWidth: Math.max(3, Math.round(settings.asciiCellWidth)),
    cellHeight: Math.max(3, Math.round(settings.asciiCellHeight)),
    fontFamily: fontCss(settings.asciiFont, settings.asciiFontCustom),
    fontWeight: settings.asciiFontWeight,
    fontScale: settings.asciiFontScale,
    maxGlyphs: Math.round(settings.asciiMaxGlyphs),
  };
  const key = atlasKey(request);
  if (cachedAtlas?.key === key) return cachedAtlas.atlas;
  const atlas = buildGlyphAtlas(request);
  cachedAtlas = { key, atlas };
  return atlas;
}

type Stage = "coarse" | "fine";

interface Job {
  id: number;
  stage: Stage;
  settings: Settings;
  /** Where the result belongs, for a fine pass over a viewport crop. */
  region: Rect | null;
  /** Pixel count, for the watchdog budget. */
  pixels: number;
  /** Identity of the plane this job renders; late results for other
   *  sources must never touch preview state. */
  sourceTag: object;
}

interface InFlight {
  job: Job;
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
  options: DitherOptions = {},
): DitherResult & ExportHandle {
  const skipFine = options.skipFine === true;
  const quality = options.quality ?? "balanced";
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
  const sentGlyphs = useRef<string>("");

  // Local mirrors for the demoted fallback path.
  const localSource = useRef<ImageData | null>(null);
  /** What the main-thread engine holds, so the fallback also ships it once. */
  const mainLoaded = useRef<ImageData | null>(null);
  const mainBudget = useRef(new CoarseBudget());
  /** Source-to-result scale of the plane currently on screen as `coarse`.
   *  1 means the first pass already was full resolution. */
  const coarseScaleRef = useRef(1);
  const refineTimer = useRef<number | undefined>(undefined);
  /**
   * What the last reduced-whole refinement answered, with the size limit the
   * engine applied, so a request for an area over that limit is not made
   * again: the engine would only plan the same reduced image.
   */
  const wholeServed = useRef<{ source: ImageData; settings: Settings; limit: number } | null>(null);

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
  const latest = useRef({ source, settings, viewport, skipFine, quality });
  // eslint-disable-next-line react-hooks/refs -- see above
  latest.current = { source, settings, viewport, skipFine, quality };

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
    if (latest.current.skipFine) return null;
    // A follow-up is only worth queuing when the first pass actually lost
    // detail: if it ran at full resolution there is nothing sharper to show.
    if (coarseScaleRef.current <= 1.001) return null;
    const r = regionFor(view, src.width, src.height, cfg);
    const w = r ? r.width : src.width;
    const h = r ? r.height : src.height;
    const served = wholeServed.current;
    if (served && served.source === src && served.settings === cfg && w * h > served.limit) return null;
    return {
      id: nextId.current++,
      stage: "fine",
      settings: cfg,
      region: r,
      pixels: w * h,
      sourceTag: src,
    };
  }

  /**
   * Ships the glyph atlas when text mode needs one and it has changed.
   *
   * Keyed on the atlas identity rather than the settings object, so the
   * hundreds of kilobytes only move when the characters, font or cell size
   * actually differ - not on every slider tick that happens to touch an
   * unrelated control.
   */
  function syncGlyphs(cfg: Settings) {
    if (!usesAscii(cfg)) return;
    const atlas = atlasFor(cfg);
    if (!atlas || atlas.count === 0) return;
    const key = `${atlas.cellWidth}x${atlas.cellHeight}:${atlas.count}:${atlas.chars.join("")}`;
    if (sentGlyphs.current === key) return;

    const worker = workerRef.current;
    if (worker && !brokenRef.current) {
      const copy = new Uint8Array(atlas.bitmaps);
      worker.postMessage(
        {
          type: "setGlyphs",
          buffer: copy.buffer as ArrayBuffer,
          count: atlas.count,
          cellWidth: atlas.cellWidth,
          cellHeight: atlas.cellHeight,
        },
        [copy.buffer as ArrayBuffer],
      );
    }
    // The main-thread rung shares one engine instance, so it needs the atlas
    // too - and it is the rung that runs when the worker is unavailable.
    void loadWasmEngine().then((w) => {
      w?.engine.set_glyphs(atlas.bitmaps, atlas.count, atlas.cellWidth, atlas.cellHeight);
    });
    sentGlyphs.current = key;
  }

  /** Ensures the worker holds the current source. */
  function syncPlanes(src: ImageData) {
    const worker = workerRef.current;
    if (worker && !brokenRef.current && sentSource.current !== src) {
      trace("source:copy", { px: src.width * src.height });
      const copy = new Uint8ClampedArray(src.data);
      worker.postMessage(
        { type: "setSource", buffer: copy.buffer as ArrayBuffer, width: src.width, height: src.height },
        [copy.buffer as ArrayBuffer],
      );
      trace("source:posted");
      sentSource.current = src;
    }
    localSource.current = src;
  }

  /** The first pass. The worker (or the engine, in the fallback) decides its
   *  resolution from what renders have been costing, so the job carries none. */
  function coarseJobFor(src: ImageData, cfg: Settings): Job {
    return {
      id: nextId.current++,
      stage: "coarse",
      settings: cfg,
      region: null,
      pixels: src.width * src.height,
      sourceTag: src,
    };
  }

  function settle(job: Job, result: Layer, took: number, scale = 1, whole = false, fineLimit?: number) {
    trace(`settle:${job.stage}`, { workerMs: Math.round(took), scale: Number(scale.toFixed(2)), whole, region: job.region ? `${job.region.width}x${job.region.height}` : "all" });
    clearWatchdog();
    strikesRef.current = 0;
    setMs(took);
    // A refinement the engine answered with the whole image at a reduced size
    // is, for display, a sharper first pass rather than a patch over one.
    if (whole) {
      const src = latest.current.source;
      wholeServed.current = src && fineLimit ? { source: src, settings: job.settings, limit: fineLimit } : null;
    }
    if (job.stage === "coarse" || whole) {
      setCoarse((prev) => {
        retireBitmap(prev instanceof ImageBitmap ? prev : null);
        return result;
      });
      setFine((prev) => {
        if (prev instanceof ImageBitmap) retireBitmap(prev);
        return null;
      });
      coarseScaleRef.current = scale;
      setCoarseScale(scale);
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
      // A refinement queued while the one before it ran may now be redundant:
      // the answer that just arrived already covers it.
      const served = wholeServed.current;
      const redundant =
        queued.stage === "fine" &&
        served !== null &&
        served.source === queued.sourceTag &&
        served.settings === queued.settings &&
        queued.pixels > served.limit;
      if (!redundant) {
        dispatchRef.current(queued);
        return;
      }
    }

    if (job.stage === "coarse") {
      const { source: src, settings: cfg, viewport: view } = latest.current;
      const next = src ? fineJobFor(src, cfg, view) : null;
      if (next) {
        // Not at once: a drag pauses for a beat between ticks, and the worker
        // cannot be interrupted, so a refinement started in that beat makes
        // the next tick wait for it. A short delay lets the drag carry on.
        setRefining(true);
        window.clearTimeout(refineTimer.current);
        refineTimer.current = window.setTimeout(() => {
          if (inflightRef.current || queuedRef.current) return;
          const again = latest.current.source ? fineJobFor(latest.current.source, latest.current.settings, latest.current.viewport) : null;
          if (again && again.sourceTag === latest.current.source) dispatchRef.current(again);
          else setRefining(false);
        }, REFINE_DELAY_MS);
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

  /** Main-thread render - the last rung under the worker. It drives the same
   *  engine the worker does, with the same resident source, so the result is
   *  identical and only the thread differs. */
  async function renderMainAsync(inflight: InFlight) {
    const t0 = performance.now();
    try {
      const w = await loadWasmEngine();
      if (!w) throw new Error("wasm unavailable on main thread");
      const src = localSource.current;
      if (!src) return;
      if (mainLoaded.current !== src) {
        w.engine.set_source(new Uint8ClampedArray(src.data), src.width, src.height);
        mainLoaded.current = src;
      }
      const { job } = inflight;
      let scale = 1;
      let whole = false;
      let fineLimit: number | undefined;
      const budget = mainBudget.current;
      const sourcePixels = src.width * src.height;
      const start = performance.now();
      if (job.stage === "coarse") {
        w.engine.render_coarse(budget.choose(sourcePixels, job.settings), job.settings);
        scale = src.width / w.engine.out_width();
      } else {
        const plan = budget.planFine(job.settings, sourcePixels, job.region);
        fineLimit = budget.fineTarget(job.settings);
        if (plan.kind === "whole") {
          w.engine.render_coarse(plan.target, job.settings);
          scale = src.width / w.engine.out_width();
          whole = true;
        } else {
          w.engine.render("fine", job.region, job.settings);
        }
      }
      budget.observe(performance.now() - start, w.engine.out_width() * w.engine.out_height(), w.engine.last_computed());
      const width = w.engine.out_width();
      const height = w.engine.out_height();
      const out = new ImageData(new Uint8ClampedArray(w.view(width * height * 4)), width, height);
      if (inflightRef.current?.job.id !== job.id) return;
      setError(null);
      settle(job, out, performance.now() - t0, scale, whole, fineLimit);
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
      else if (retry) runOnMainThread({ job: retry });
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
        worker.postMessage({ type: "configure", quality: latest.current.quality } satisfies WorkerRequest);
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
          settle(inflight.job, msg.bitmap, msg.ms, msg.scale, msg.whole, msg.fineLimit);
        } else if (msg.buffer && msg.width && msg.height) {
          const img = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
          settle(inflight.job, img, msg.ms, msg.scale, msg.whole, msg.fineLimit);
        }
        return;
      }
    };
    worker.onerror = (e) => demote(e.message || "worker error");
    worker.onmessageerror = () => demote("message deserialisation failed");

    return () => {
      window.clearTimeout(initTimer);
      window.clearTimeout(refineTimer.current);
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
      if (!localSource.current) return;
      runOnMainThread({ job });
      return;
    }

    inflightRef.current = { job };

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
    timerRef.current = window.setTimeout(watchdogStrike, watchdogMs(job.pixels, job.settings));
  };

  // The preview quality is a setting, not a render input: it retunes how big
  // the first pass is from the next render on and never invalidates one.
  useEffect(() => {
    mainBudget.current.setQuality(quality);
    workerRef.current?.postMessage({ type: "configure", quality } satisfies WorkerRequest);
  }, [quality]);

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
      localSource.current = null;
      mainLoaded.current = null;
      coarseScaleRef.current = 1;
      layerSourceRef.current = null;
      return;
    }
    // Only a *geometry* change makes the on-screen layers unusable: drawing a
    // previous frame at a new aspect ratio is the "stretched old picture" bug,
    // while a same-size predecessor is a perfectly good thing to leave up for
    // the few milliseconds until its replacement lands. That distinction is
    // what lets video play without blanking the stage between every frame.
    const previous = layerSourceRef.current;
    if (previous !== source) {
      layerSourceRef.current = source;
      if (!previous || previous.width !== source.width || previous.height !== source.height) {
        setCoarse(null);
        setFine(null);
        setRegion(null);
        setCoarseScale(1);
        coarseScaleRef.current = 1;
      }
    }
    syncGlyphs(settings);
    syncPlanes(source);
    const job = coarseJobFor(source, settings);
    window.clearTimeout(refineTimer.current);
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
    if (!source || busy || skipFine) return;
    const next = regionFor(viewport, source.width, source.height, settings);
    // A finished full-image pass already covers every zoom level. Re-running
    // the whole algorithm stack just to navigate that result wastes work.
    if (fine && coversRect(region, next)) return;
    const running = inflightRef.current?.job;
    if (running?.stage === "fine" && running.sourceTag === source &&
      running.settings === settings && coversRect(running.region, next)) return;

    const t = window.setTimeout(() => {
      const job = fineJobFor(source, settings, viewport);
      if (!job) return;
      setRefining(true);
      if (inflightRef.current) queuedRef.current = job;
      else dispatchRef.current(job);
    }, 160);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, source, settings, busy, fine, region, skipFine]);

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
            if (mainLoaded.current !== src) {
              w.engine.set_source(new Uint8ClampedArray(src.data), src.width, src.height);
              mainLoaded.current = src;
            }
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
