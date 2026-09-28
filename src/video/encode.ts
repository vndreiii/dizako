/**
 * Video export: dithered frames → a file on disk.
 *
 * ## Why two phases
 *
 * Dithering is nowhere near realtime at export resolution, and `MediaRecorder`
 * timestamps what it is given by wall clock. Feeding it frames as they finish
 * would therefore stretch a 10-second clip into however long the render took.
 *
 * So export renders first and muxes second:
 *
 * 1. **Render.** Every frame in range is grabbed, dithered through the same
 *    worker the preview uses, and kept as a PNG blob. PNG is the right
 *    intermediate here for a reason specific to this app: a dithered frame has
 *    a handful of distinct colours, so it compresses to a fraction of its raw
 *    size and a whole clip fits in memory where raw RGBA would not.
 * 2. **Capture.** The blobs are decoded back and pushed into a canvas capture
 *    stream on a clock, at exactly the source frame rate. Wall clock and media
 *    time then agree, so the output runs at the right speed.
 *
 * The PNG sequence format falls out of phase 1 for free, which is what makes
 * it a real fallback rather than an apology: it is available on every host,
 * including ones with no `MediaRecorder` at all.
 *
 * ## Why not WebCodecs
 *
 * `VideoEncoder` would remove the capture-stream dance, but it is absent or
 * flag-gated in the WebKitGTK builds Dizako ships against, and reaching it
 * would still leave a muxer to write. `MediaRecorder` delegates both to the
 * host's media stack - GStreamer, Media Foundation, AVFoundation - which is
 * also why MP4 output is available at all on WebKit.
 */
import { appError } from "../errors";

export type ContainerId = "mp4" | "webm" | "png-sequence";

export interface EncoderOption {
  id: ContainerId;
  /** `MediaRecorder` mime type; absent for the PNG sequence. */
  mimeType?: string;
  extension: string;
  available: boolean;
  /** Why it is unavailable, for the dialog and for diagnostics. */
  reason?: string;
}

const MP4_CANDIDATES = [
  // High → Main → Baseline: ask for the best the host will admit to.
  "video/mp4;codecs=avc1.640028",
  "video/mp4;codecs=avc1.4d002a",
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=h264",
  "video/mp4",
];

const WEBM_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm;codecs=av01",
  "video/webm",
];

function firstSupported(candidates: string[]): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // isTypeSupported itself throws on a few older builds; treat as a no.
    }
  }
  return null;
}

/** What this host can actually write, decided once and reported honestly. */
export function probeEncoders(): EncoderOption[] {
  const hasRecorder = typeof MediaRecorder !== "undefined";
  const hasCapture =
    typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";

  const blocked = !hasRecorder
    ? "MediaRecorder is not implemented on this host"
    : !hasCapture
      ? "HTMLCanvasElement.captureStream is not implemented on this host"
      : null;

  const mp4 = blocked ? null : firstSupported(MP4_CANDIDATES);
  const webm = blocked ? null : firstSupported(WEBM_CANDIDATES);

  return [
    {
      id: "mp4",
      mimeType: mp4 ?? undefined,
      extension: "mp4",
      available: Boolean(mp4),
      reason: blocked ?? (mp4 ? undefined : "no H.264/MP4 recording profile is supported here"),
    },
    {
      id: "webm",
      mimeType: webm ?? undefined,
      extension: "webm",
      available: Boolean(webm),
      reason: blocked ?? (webm ? undefined : "no VP8/VP9/WebM recording profile is supported here"),
    },
    // Always available: it is just the render phase's output written out.
    { id: "png-sequence", extension: "png", available: true },
  ];
}

/** The best real video container, or null when only the sequence is possible. */
export function bestVideoEncoder(options: EncoderOption[] = probeEncoders()): EncoderOption | null {
  return options.find((o) => o.id === "mp4" && o.available) ?? options.find((o) => o.id === "webm" && o.available) ?? null;
}

/**
 * Bitrate for a given frame size and rate.
 *
 * Dithered footage is pathological for a motion estimator: every flat area is
 * high-frequency noise that changes completely between frames. At the rates
 * normal video uses the result is a smear where the dither pattern should be,
 * so the budget here is deliberately generous - roughly 0.25 bits per pixel
 * per frame - and still clamped to something a disk will accept.
 */
export function suggestBitrate(width: number, height: number, fps: number): number {
  const raw = width * height * fps * 0.25;
  return Math.round(Math.min(Math.max(raw, 2_000_000), 90_000_000));
}

export interface CaptureOptions {
  width: number;
  height: number;
  fps: number;
  mimeType: string;
  bitsPerSecond: number;
  /** Called with 0..1 as muxing progresses. */
  onProgress?: (fraction: number) => void;
  /** Resolves truthy to abort mid-capture. */
  shouldCancel?: () => boolean;
}

/**
 * Pushes pre-rendered PNG frames into a `MediaRecorder` on a fixed clock.
 *
 * Frames are decoded a few ahead of the write head so a slow `createImageBitmap`
 * does not stall the clock and drop a frame from the output.
 */
export async function captureToVideo(frames: Blob[], options: CaptureOptions): Promise<Blob> {
  if (frames.length === 0) {
    throw appError("video/export-no-frames", { detail: "the render phase produced no frames" });
  }

  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw appError("image/no-2d-context", {
      detail: `could not acquire a 2D context for the ${options.width}×${options.height} capture surface`,
    });
  }
  ctx.imageSmoothingEnabled = false;

  // frameRate 0 means "only the frames I hand you", which is what keeps the
  // output frame-exact instead of resampled to the compositor's rate.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  if (!track) {
    throw appError("video/export-recorder-failed", { detail: "captureStream produced no video track" });
  }

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: options.mimeType,
      videoBitsPerSecond: options.bitsPerSecond,
    });
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw appError("video/export-recorder-failed", {
      detail: `MediaRecorder rejected ${options.mimeType} at ${options.bitsPerSecond} bps: ${String(err)}`,
      cause: err,
    });
  }

  const chunks: Blob[] = [];
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) =>
      reject(
        appError("video/export-recorder-failed", {
          detail: `MediaRecorder error: ${String((e as unknown as { error?: unknown }).error ?? e)}`,
        }),
      );
    recorder.onstop = () => {
      if (chunks.length === 0) {
        reject(appError("video/export-recorder-failed", { detail: "the recorder produced no data" }));
        return;
      }
      resolve(new Blob(chunks, { type: options.mimeType.split(";")[0] }));
    };
  });

  // A timeslice keeps data flowing in chunks rather than one allocation at the
  // end, which is the difference between finishing and an OOM on a long clip.
  recorder.start(1000);

  const frameMs = 1000 / options.fps;
  const decoded = new Map<number, ImageBitmap | HTMLImageElement>();
  const LOOKAHEAD = 6;

  /** Decodes a PNG blob into something drawable on any host. */
  const decode = async (index: number) => {
    if (index >= frames.length || decoded.has(index)) return;
    const blob = frames[index]!;
    if (typeof createImageBitmap === "function") {
      decoded.set(index, await createImageBitmap(blob));
      return;
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(appError("video/export-recorder-failed", { detail: `frame ${index} would not decode` }));
        img.src = url;
      });
      decoded.set(index, img);
    } finally {
      // The element keeps its own decoded copy once loaded.
      URL.revokeObjectURL(url);
    }
  };

  const release = (index: number) => {
    const image = decoded.get(index);
    if (image && typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
    decoded.delete(index);
  };

  try {
    for (let i = 0; i < Math.min(LOOKAHEAD, frames.length); i++) await decode(i);

    const started = performance.now();
    for (let i = 0; i < frames.length; i++) {
      if (options.shouldCancel?.()) throw appError("video/export-cancelled", { detail: "cancelled during capture" });

      if (!decoded.has(i)) await decode(i);
      const image = decoded.get(i)!;
      ctx.drawImage(image, 0, 0, options.width, options.height);
      track.requestFrame?.();
      release(i);
      void decode(i + LOOKAHEAD);

      options.onProgress?.((i + 1) / frames.length);

      // Hold the clock to the source rate. Sleeping to an absolute target
      // rather than by a fixed delta stops accumulated jitter from shortening
      // the output.
      const target = started + (i + 1) * frameMs;
      const wait = target - performance.now();
      if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
    }

    // One extra beat so the muxer has a duration for the last frame rather
    // than dropping it.
    await new Promise((r) => window.setTimeout(r, Math.max(120, frameMs * 2)));
    recorder.stop();
    return await finished;
  } catch (err) {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // Already torn down; nothing to salvage.
    }
    // Nobody awaits `finished` on this path, and the stop above can still make
    // it settle either way; swallow it so a cancellation is not also reported
    // as an unhandled rejection.
    finished.catch(() => {});
    throw err;
  } finally {
    for (const index of [...decoded.keys()]) release(index);
    stream.getTracks().forEach((t) => t.stop());
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Zero-pads a frame index so a written sequence sorts correctly. */
export function frameFileName(base: string, index: number, total: number): string {
  const digits = Math.max(4, String(total).length);
  return `${base}_${String(index).padStart(digits, "0")}.png`;
}
