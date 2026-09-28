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

/** Same budget as still images: keeps the error plane and per-frame cost sane. */
export const MAX_FRAME_PIXELS = 4_000_000;
/** Longer than this and a frame-by-frame export stops being a good idea. */
export const MAX_DURATION_S = 20 * 60;
/** A seek that has not landed by now is a wedged decoder, not a slow one. */
const SEEK_TIMEOUT_MS = 8_000;
const METADATA_TIMEOUT_MS = 15_000;

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
 * Measures the real frame rate by watching two consecutive presented frames.
 *
 * `requestVideoFrameCallback` reports each frame's presentation time, so two
 * callbacks are enough for an estimate and a handful gives a stable one. Hosts
 * without it (older WebKitGTK) get the assumed default: guessing 30 and saying
 * so beats blocking import on a measurement that cannot be taken.
 */
async function measureFps(el: HTMLVideoElement): Promise<{ fps: number; assumed: boolean }> {
  type WithRvfc = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  const video = el as WithRvfc;
  if (typeof video.requestVideoFrameCallback !== "function") return { fps: 30, assumed: true };

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

    // 1.2s is enough for ~6 frames even at 5fps, and short enough that import
    // does not feel like it stalled.
    const timer = window.setTimeout(() => {
      if (samples.length < 2) return finish({ fps: 30, assumed: true });
      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      const frames = last.presentedFrames - first.presentedFrames;
      const seconds = last.mediaTime - first.mediaTime;
      if (frames <= 0 || seconds <= 0) return finish({ fps: 30, assumed: true });
      const raw = frames / seconds;
      // Snap to the rates real footage actually uses, so a 23.976 measurement
      // does not become 23.9761904 in the UI or drift the frame index.
      const common = [8, 10, 12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
      const snapped = common.find((c) => Math.abs(c - raw) / c < 0.04);
      return finish({ fps: snapped ?? Math.round(raw * 100) / 100, assumed: false });
    }, 1200);

    const tick = (_now: number, meta: { mediaTime: number; presentedFrames: number }) => {
      samples.push({ mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames });
      if (!done) handle = video.requestVideoFrameCallback!(tick);
    };
    handle = video.requestVideoFrameCallback!(tick);
    // Muted playback is what makes frames present at all; autoplay policies
    // allow it and the user never hears the probe.
    el.muted = true;
    void el.play().catch(() => finish({ fps: 30, assumed: true }));
  });
}

/** Loads a file into a seekable clip, or throws a `video/*` AppError. */
export async function openClip(file: File): Promise<Clip> {
  if (file.size === 0) {
    throw appError("video/decode-failed", { detail: `${file.name} is zero bytes`, values: { name: file.name } });
  }

  const url = URL.createObjectURL(file);
  const el = document.createElement("video");
  el.preload = "auto";
  el.muted = true;
  el.playsInline = true;
  // Required for `drawImage` to be allowed to read the frame back out; a blob
  // URL is same-origin anyway, but WebKit is stricter than the spec here.
  el.crossOrigin = "anonymous";
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

    const { fps, assumed } = await measureFps(el);
    el.currentTime = 0;

    const frame = fitFrame(width, height);
    return {
      file,
      url,
      el,
      width,
      height,
      frameWidth: frame.width,
      frameHeight: frame.height,
      durationS,
      fps,
      fpsAssumed: assumed,
      frameCount: Math.max(1, Math.round(durationS * fps)),
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
    el.currentTime = target;
  });
}

/**
 * Reusable scratch canvas for frame reads.
 *
 * One canvas per grabber rather than per call: allocating a multi-megapixel
 * canvas 1500 times during an export is most of the cost of the export.
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

  return {
    width,
    height,
    /** Reads whatever the element is currently presenting. */
    grab(el: HTMLVideoElement): ImageData {
      try {
        ctx.drawImage(el, 0, 0, width, height);
      } catch (err) {
        throw appError("video/frame-grab-failed", {
          detail: `drawImage from the video element threw: ${String(err)}`,
          cause: err,
        });
      }
      return ctx.getImageData(0, 0, width, height);
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
