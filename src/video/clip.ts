/**
 * Video import: file → seekable clip with frame-accurate reads.
 *
 * Dizako dithers `ImageData`, so a clip is only ever a *source of frames*. The
 * decode path therefore does the least it can get away with: an
 * `HTMLVideoElement` fed a blob URL, which hands the host's own demuxer and
 * decoder the job. On Linux that is GStreamer behind WebKitGTK, on Windows the
 * Media Foundation stack, on macOS AVFoundation - every container and codec the
 * machine can already play, for free.
 *
 * What that buys in reach it costs in honesty: a `<video>` element reports
 * failure as a bare `error` event with a numeric code and no detail. Every
 * await below is therefore bounded by a timeout and resolves into one of the
 * `video/*` error codes, because "the window went quiet" is the one outcome
 * that must never happen.
 */
import { appError } from "../errors";
import { trace } from "../perf";
import { readbackFrame, readbackSupported } from "./readback";
import type { FrameHandle } from "./readback.worker";

/** Same budget as still images: keeps the error plane and per-frame cost sane. */
export const MAX_FRAME_PIXELS = 4_000_000;
/** Longer than this and a frame-by-frame export stops being a good idea. */
export const MAX_DURATION_S = 20 * 60;
/** A seek that has not landed by now is a wedged decoder, not a slow one. */
const SEEK_TIMEOUT_MS = 8_000;
const METADATA_TIMEOUT_MS = 15_000;

/**
 * Stages an import passes through, so the UI can say what it is waiting on.
 *
 * The whole sequence is a couple of seconds on a large clip, which is long
 * enough that silence reads as a hang.
 */
export type ImportStage = "reading" | "metadata" | "frame" | "ready";

export interface ImportProgress {
  stage: ImportStage;
  /** 0..1, weighted by how long each stage actually takes. */
  fraction: number;
}

const STAGE_FRACTION: Record<ImportStage, number> = {
  reading: 0.05,
  metadata: 0.4,
  frame: 0.85,
  ready: 1,
};

/** Frame rate assumed until a measurement says otherwise. */
export const ASSUMED_FPS = 30;

export interface Clip {
  file: File;
  /** Blob URL owned by the clip; released by `closeClip`. */
  url: string;
  el: HTMLVideoElement;
  /** Native frame size as reported by the decoder. */
  width: number;
  height: number;
  /** Working frame size after the pixel-budget clamp. */
  frameWidth: number;
  frameHeight: number;
  durationS: number;
  /** Measured where the host allows it, otherwise `fpsAssumed`. */
  fps: number;
  /** True when fps could not be measured and a default was used. */
  fpsAssumed: boolean;
  frameCount: number;
  hasAudio: boolean;
}

function mediaErrorDetail(el: HTMLVideoElement): string {
  const err = el.error;
  if (!err) return "no MediaError on the element";
  const names: Record<number, string> = {
    1: "MEDIA_ERR_ABORTED",
    2: "MEDIA_ERR_NETWORK",
    3: "MEDIA_ERR_DECODE",
    4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
  };
  return `${names[err.code] ?? `code ${err.code}`}: ${err.message || "(no message)"}`;
}

/** Scales a frame down to the pixel budget, preserving aspect. */
function fitFrame(width: number, height: number): { width: number; height: number } {
  const total = width * height;
  if (total <= MAX_FRAME_PIXELS) return { width, height };
  const scale = Math.sqrt(MAX_FRAME_PIXELS / total);
  return {
    width: Math.max(2, Math.round(width * scale / 2) * 2),
    height: Math.max(2, Math.round(height * scale / 2) * 2),
  };
}

/**
 * Measures the real frame rate by watching consecutive presented frames.
 *
 * `requestVideoFrameCallback` reports each frame's presentation time, so two
 * callbacks are enough for an estimate and a handful gives a stable one. Hosts
 * without it (older WebKitGTK) get the assumed default: guessing 30 and saying
 * so beats blocking on a measurement that cannot be taken.
 *
 * This plays the element, so it is never part of opening a clip: starting
 * playback can take seconds on some decoders and the picture is already on
 * screen by then. The caller runs it in the background, and `cancelled` lets
 * the moment the user does anything end it early.
 */
export async function measureClipRate(
  el: HTMLVideoElement,
  cancelled: () => boolean = () => false,
): Promise<{ fps: number; assumed: boolean }> {
  type WithRvfc = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  const video = el as WithRvfc;
  const fallback = { fps: ASSUMED_FPS, assumed: true };
  if (typeof video.requestVideoFrameCallback !== "function") return fallback;

  return new Promise<{ fps: number; assumed: boolean }>((resolve) => {
    const samples: Array<{ mediaTime: number; presentedFrames: number }> = [];
    let handle = 0;
    let done = false;

    const finish = (value: { fps: number; assumed: boolean }) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      el.pause();
      resolve(value);
    };

    const estimate = () => {
      if (samples.length < 2) return fallback;
      // The fastest pair of consecutive presentations, not the overall average.
      // A decoder that cannot keep up drops frames, which stretches the media
      // time between the ones it does present: averaged over the run that read
      // a 30fps 4K clip as 6fps, and the frame count followed it down to a
      // fifth of the real length. Any two frames presented back to back give
      // the true interval, so the best pair is the honest one.
      let raw = 0;
      for (let i = 1; i < samples.length; i++) {
        const frames = samples[i]!.presentedFrames - samples[i - 1]!.presentedFrames;
        const seconds = samples[i]!.mediaTime - samples[i - 1]!.mediaTime;
        if (frames > 0 && seconds > 0) raw = Math.max(raw, frames / seconds);
      }
      if (raw <= 0) return fallback;
      // Snap to the rates real footage actually uses, so a 23.976 measurement
      // does not become 23.9761904 in the UI or drift the frame index.
      const common = [8, 10, 12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
      const snapped = common.find((c) => Math.abs(c - raw) / c < 0.04);
      return { fps: snapped ?? Math.round(raw * 100) / 100, assumed: false };
    };

    // 1.2s is enough for ~6 frames even at 5fps.
    const timer = window.setTimeout(() => finish(estimate()), 1200);

    const tick = (_now: number, meta: { mediaTime: number; presentedFrames: number }) => {
      samples.push({ mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames });
      // Eight frames settle the estimate; anything the user does ends it now.
      if (cancelled()) return finish(fallback);
      if (samples.length >= 8) return finish(estimate());
      if (!done) handle = video.requestVideoFrameCallback!(tick);
    };
    handle = video.requestVideoFrameCallback!(tick);
    // Muted playback is what makes frames present at all; autoplay policies
    // allow it and the user never hears the probe.
    el.muted = true;
    void el.play().catch(() => finish(fallback));
  });
}

/** The same clip with a different frame rate; everything derived from it follows. */
export function withRate(clip: Clip, fps: number, assumed: boolean): Clip {
  return { ...clip, fps, fpsAssumed: assumed, frameCount: Math.max(1, Math.round(clip.durationS * fps)) };
}

/** Loads a file into a seekable clip, or throws a `video/*` AppError. */
export async function openClip(file: File, onProgress?: (p: ImportProgress) => void): Promise<Clip> {
  const report = (stage: ImportStage) => onProgress?.({ stage, fraction: STAGE_FRACTION[stage] });
  report("reading");
  if (file.size === 0) {
    throw appError("video/decode-failed", { detail: `${file.name} is zero bytes`, values: { name: file.name } });
  }

  const url = URL.createObjectURL(file);
  const el = document.createElement("video");
  /**
   * `metadata`, never `auto`, and this is load-bearing.
   *
   * WebKitGTK is the engine the desktop build runs on. Given a blob: URL and
   * `preload="auto"` it pulls the whole clip into a buffering GStreamer
   * pipeline that then cannot service a seek at all: the first
   * `currentTime = x` fails with MEDIA_ERR_DECODE, or simply never fires
   * `seeked` and trips the eight-second budget. Import died on its very first
   * seek, every time, on every clip.
   *
   * With `metadata` the same blob URL seeks fine - frame zero, forwards and
   * backwards, on 1080p and 4K alike. Chromium is happy either way, which is
   * exactly why this is worth a comment: it looks like a pointless
   * pessimisation until you run it on WebKit.
   *
   * There is no buffering cost to pay here either. The bytes are already in
   * memory behind the blob; `auto` was only ever asking the engine to copy
   * them into a second pipeline.
   */
  el.preload = "metadata";
  el.muted = true;
  el.playsInline = true;
  /**
   * `crossOrigin` is deliberately NOT set, and that is also load-bearing.
   *
   * It used to be `"anonymous"`, on the theory that `drawImage` needs it to be
   * allowed to read the frame back. That was wrong in both directions: a blob:
   * URL is same-origin by construction, so there is no CORS to negotiate, and
   * setting the attribute makes WebKitGTK treat the load as CORS-enabled, fail
   * its own check, and hand back a surface that paints *nothing*.
   *
   * The failure is silent - `drawImage` does not throw and `getImageData` does
   * not raise a SecurityError, the pixels are simply all zero. The symptom is
   * a clip that imports perfectly, reports the right size, duration and frame
   * rate, and shows an empty canvas. Measured on the same 4K frame: with the
   * attribute every sampled pixel came back transparent; without it, 774
   * distinct colours.
   */
  el.src = url;

  const cleanup = () => {
    el.removeAttribute("src");
    el.load();
    URL.revokeObjectURL(url);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () =>
          reject(
            appError("video/no-metadata", {
              detail: `no loadedmetadata within ${METADATA_TIMEOUT_MS}ms for ${file.name} (${file.type || "unknown type"})`,
              values: { name: file.name },
            }),
          ),
        METADATA_TIMEOUT_MS,
      );
      const ok = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const bad = () => {
        window.clearTimeout(timer);
        reject(
          appError("video/decode-failed", {
            detail: `${file.name} (${file.type || "unknown type"}): ${mediaErrorDetail(el)}`,
            values: { name: file.name },
          }),
        );
      };
      el.addEventListener("loadedmetadata", ok, { once: true });
      el.addEventListener("error", bad, { once: true });
    });
    report("metadata");

    const width = el.videoWidth;
    const height = el.videoHeight;
    if (!width || !height) {
      throw appError("video/no-frames", {
        detail: `decoder reported ${width}×${height} - the file has no usable video track`,
        values: { name: file.name },
      });
    }

    const durationS = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    if (durationS === 0) {
      throw appError("video/no-metadata", {
        detail: `duration reported as ${el.duration} (live or unseekable stream)`,
        values: { name: file.name },
      });
    }
    if (durationS > MAX_DURATION_S) {
      throw appError("video/too-long", {
        values: { name: file.name, minutes: Math.round(durationS / 60), limit: MAX_DURATION_S / 60 },
        detail: `${durationS.toFixed(1)}s exceeds the ${MAX_DURATION_S}s import limit`,
      });
    }

    report("frame");

    const frame = fitFrame(width, height);
    report("ready");
    return {
      file,
      url,
      el,
      width,
      height,
      frameWidth: frame.width,
      frameHeight: frame.height,
      durationS,
      // Refined in the background once the clip is on screen; see `measureClipRate`.
      fps: ASSUMED_FPS,
      fpsAssumed: true,
      frameCount: Math.max(1, Math.round(durationS * ASSUMED_FPS)),
      // Not authoritative on every host, so only ever used to explain that
      // exported video carries no sound.
      hasAudio: detectAudio(el),
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function detectAudio(el: HTMLVideoElement): boolean {
  const withTracks = el as HTMLVideoElement & {
    audioTracks?: { length: number };
    webkitAudioDecodedByteCount?: number;
    mozHasAudio?: boolean;
  };
  if (withTracks.audioTracks) return withTracks.audioTracks.length > 0;
  if (typeof withTracks.mozHasAudio === "boolean") return withTracks.mozHasAudio;
  if (typeof withTracks.webkitAudioDecodedByteCount === "number") {
    return withTracks.webkitAudioDecodedByteCount > 0;
  }
  return false;
}

export function closeClip(clip: Clip) {
  try {
    clip.el.pause();
  } catch {
    // Pausing a torn-down element throws on some hosts; the revoke below is
    // what actually frees the memory.
  }
  clip.el.removeAttribute("src");
  clip.el.load();
  URL.revokeObjectURL(clip.url);
}

export function frameToTime(clip: Clip, frame: number): number {
  // Half a frame into the interval: landing exactly on a boundary is where
  // decoders disagree about which side of it you asked for.
  const t = (frame + 0.5) / clip.fps;
  return Math.min(Math.max(0, t), Math.max(0, clip.durationS - 1e-4));
}

export function timeToFrame(clip: Clip, seconds: number): number {
  return Math.min(clip.frameCount - 1, Math.max(0, Math.floor(seconds * clip.fps)));
}

/**
 * Seeks and waits for the decoder to actually present that position.
 *
 * Note what this deliberately does *not* do: wait on
 * `requestVideoFrameCallback` for a presented frame. That callback never fires
 * on a paused element here, so the wait would time out on every single seek -
 * measured at eight seeks out of eight - and an export that seeks once per
 * frame would spend its entire budget in a timeout it can never satisfy.
 * `seeked` plus `readyState` is sufficient: with the canvas able to read
 * decoded frames at all, immediate grabs came back complete eight times out of
 * eight.
 *
 * `seeked` alone is not enough on WebKit: it can fire while `readyState` is
 * still below HAVE_CURRENT_DATA, and drawing then yields the previous frame -
 * which looks like an off-by-one in the timeline rather than a decode race.
 */
export async function seekClip(clip: Clip, seconds: number): Promise<void> {
  const el = clip.el;
  const target = Math.min(Math.max(0, seconds), Math.max(0, clip.durationS - 1e-4));
  if (Math.abs(el.currentTime - target) < 1e-4 && el.readyState >= 2) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("error", onError);
      if (err) reject(err);
      else resolve();
    };
    const onSeeked = () => {
      trace("seek:seeked", { readyState: el.readyState });
      if (el.readyState >= 2) return finish();
      // Data has not arrived yet; wait for it rather than drawing a stale frame.
      el.addEventListener("loadeddata", () => finish(), { once: true });
    };
    const onError = () =>
      finish(
        appError("video/frame-grab-failed", {
          detail: `seek to ${target.toFixed(3)}s failed: ${mediaErrorDetail(el)}`,
        }),
      );
    const timer = window.setTimeout(
      () =>
        finish(
          appError("video/seek-timeout", {
            detail: `seek to ${target.toFixed(3)}s did not complete within ${SEEK_TIMEOUT_MS}ms (readyState ${el.readyState})`,
            values: { time: target.toFixed(2) },
          }),
        ),
      SEEK_TIMEOUT_MS,
    );
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("error", onError);
    trace("seek:start", { target });
    el.currentTime = target;
  });
}

/**
 * How decoded frames get from the video element to pixels.
 *
 * - `frame`: a `VideoFrame` is made from the element (it references the
 *   decoded frame rather than copying it, so it is close to free) and
 *   transferred to a worker, which does all the conversion and scaling. The UI
 *   thread's share is effectively nothing. Needs WebCodecs.
 * - `bitmap`: an `ImageBitmap` at the frame's native size, scaled in a worker.
 *   Cheaper than the synchronous route, but the bitmap itself still costs the
 *   UI thread a conversion.
 * - `canvas`: draw and `getImageData` on the calling thread. Works everywhere
 *   and blocks for as long as the readback takes.
 *
 * Each step down is taken the first time the one above fails or paints a blank
 * frame, and is permanent for the session: a route that painted nothing once
 * will paint nothing again, and every later frame must not pay to rediscover it.
 */
export type GrabRoute = "frame" | "bitmap" | "canvas";

/**
 * Whether the worker routes have been shown to work on this engine.
 *
 * They are only proven on Chromium (Chrome, Edge and the WebView2 the Windows
 * build runs on). On WebKitGTK - the Linux desktop build - both of them exist
 * and both paint a blank frame: `new VideoFrame(video)` is blank, and
 * `createImageBitmap(video)` blocks the UI thread for over a second at 4K
 * before it, too, comes back blank. Falling through to the canvas route after
 * discovering that cost one 4K import about five seconds of frozen window,
 * all of it spent on routes that could not work. So the routes are chosen by
 * engine up front rather than by failing.
 */
function workerRoutesProven(): boolean {
  return typeof navigator !== "undefined" && /(Chrome|Chromium|Edg)\//.test(navigator.userAgent);
}

function initialRoute(): GrabRoute {
  if (!readbackSupported() || !workerRoutesProven()) return "canvas";
  return typeof VideoFrame !== "undefined" ? "frame" : "bitmap";
}

const routeState = { route: initialRoute() };

/** Test hook: put the route back, or force one. */
export function resetGrabRoute(route: GrabRoute = initialRoute()): void {
  routeState.route = route;
}

export function currentGrabRoute(): GrabRoute {
  return routeState.route;
}

/** Steps down one route after a failure. Returns the route now in force. */
export function demoteGrabRoute(): GrabRoute {
  routeState.route = routeState.route === "frame" ? "bitmap" : "canvas";
  return routeState.route;
}

/**
 * Reusable scratch canvas for frame reads.
 *
 * One canvas per grabber rather than per call: allocating a multi-megapixel
 * canvas 1500 times during an export is most of the cost of the export.
 *
 * Two ways to read a frame:
 *
 * - `grab` is the synchronous route: draw and `getImageData` on the calling
 *   thread. It works everywhere, and it blocks - a 4 MP frame is a GPU-to-CPU
 *   copy of tens to hundreds of milliseconds during which the window cannot
 *   repaint.
 * - `grabAsync` takes an `ImageBitmap` (asynchronous, cheap) and has a worker
 *   do the readback, so the UI thread never touches the pixels. It falls back
 *   to `grab` by itself if the host cannot, or produces a blank frame.
 */
export function createFrameGrabber(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw appError("image/no-2d-context", { detail: `could not acquire a 2D context for ${width}×${height}` });
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";

  const grab = (el: HTMLVideoElement): ImageData => {
    try {
      ctx.drawImage(el, 0, 0, width, height);
    } catch (err) {
      throw appError("video/frame-grab-failed", {
        detail: `drawImage from the video element threw: ${String(err)}`,
        cause: err,
      });
    }
    return ctx.getImageData(0, 0, width, height);
  };

  /**
   * The frame under the playhead as something a worker can take, or null when
   * this host should use the synchronous route. Creating it is the only work
   * the calling thread does.
   */
  const grabHandle = async (el: HTMLVideoElement): Promise<FrameHandle | null> => {
    for (;;) {
      const route = routeState.route;
      if (route === "canvas") return null;
      try {
        trace("grab:handle:start", { route });
        const handle = route === "frame" ? new VideoFrame(el) : await createImageBitmap(el);
        trace("grab:handle:made", { route });
        return handle;
      } catch {
        trace("grab:handle:failed", { route });
        demoteGrabRoute();
      }
    }
  };

  return {
    width,
    height,
    /** Reads whatever the element is currently presenting, on this thread. */
    grab,
    grabHandle,
    /** As `grab`, but the readback happens off the UI thread when it can. */
    async grabAsync(el: HTMLVideoElement): Promise<ImageData> {
      for (;;) {
        const handle = await grabHandle(el);
        if (!handle) return grab(el);
        try {
          const { image, blank } = await readbackFrame(handle, width, height);
          trace("grab:readback", { blank });
          if (!blank) return image;
        } catch {
          // Fall through to demotion below.
        }
        demoteGrabRoute();
      }
    },
    dispose() {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

export type FrameGrabber = ReturnType<typeof createFrameGrabber>;

/** Video MIME types and extensions worth accepting in the file picker. */
export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv", "ogg", "gif", "3gp", "wmv", "flv"];

export function looksLikeVideo(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  // Hosts routinely report an empty type for .mkv and .mov from a drag-drop,
  // so the extension is the fallback rather than an outright rejection.
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return VIDEO_EXTENSIONS.includes(ext);
}
