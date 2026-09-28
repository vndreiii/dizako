/**
 * Video export orchestration.
 *
 * Reading frames is strictly serial - there is one decoder and one playhead -
 * while dithering them is embarrassingly parallel. So the loop below reads
 * ahead: it seeks, grabs, hands the plane straight to the pool without waiting
 * for it, and only blocks when enough frames are already in flight. The decoder
 * and the cores are then both busy for the whole job instead of taking turns.
 *
 * A frame that fails does not fail the export. One bad seek in the middle of a
 * 900-frame clip should cost that frame, not the forty minutes of work around
 * it, so failures are collected, the gap is filled from the nearest neighbour
 * that did render to keep the timing honest, and the caller is told exactly
 * which indices were substituted.
 */
import type { Settings } from "../dither/types";
import { appError } from "../errors";
import { createFrameGrabber, frameToTime, seekClip, type Clip } from "./clip";
import { captureToVideo, suggestBitrate, type ContainerId } from "./encode";
import { createRenderPool } from "./pool";

export interface ExportPhaseProgress {
  phase: "render" | "mux";
  done: number;
  total: number;
  /** 0..1 over the whole job, both phases weighted by their real cost. */
  fraction: number;
  /** Seconds remaining, or null before there is enough data to guess. */
  etaS: number | null;
}

export interface VideoExportRequest {
  clip: Clip;
  settings: Settings;
  /** Inclusive frame range. */
  startFrame: number;
  endFrame: number;
  /** Multiplier on the clip's working frame size, 0.25 .. 1. */
  scale: number;
  container: ContainerId;
  mimeType?: string;
  bitrate?: number;
  onProgress?: (progress: ExportPhaseProgress) => void;
  shouldCancel?: () => boolean;
  /** Called per failed frame; the export continues. */
  onFrameError?: (index: number, error: unknown) => void;
}

export interface VideoExportResult {
  container: ContainerId;
  /** Present for mp4/webm. */
  blob?: Blob;
  /** Present for the PNG sequence, in frame order. */
  frames?: Blob[];
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Frames that failed and were substituted with their predecessor. */
  substituted: number[];
  /** True when no worker could be started and rendering was single-threaded. */
  degraded: boolean;
  poolSize: number;
  renderMs: number;
}

/** Muxing is realtime, so its share of the bar is its real share of the wait. */
function weights(frameCount: number, fps: number, container: ContainerId) {
  if (container === "png-sequence") return { render: 1, mux: 0 };
  const muxSeconds = frameCount / fps;
  // Rendering a frame is assumed ~4x slower than realtime as a starting guess;
  // the bar corrects itself from measured throughput after a few frames.
  const renderSeconds = muxSeconds * 4;
  const total = renderSeconds + muxSeconds;
  return { render: renderSeconds / total, mux: muxSeconds / total };
}

export function estimatedMemoryBytes(frameCount: number, width: number, height: number): number {
  // Dithered PNG of a few colours compresses hard; 0.22 bytes/pixel is the
  // conservative end of what the engine's own output actually measures at.
  return Math.round(frameCount * width * height * 0.22);
}

/** Frame size after the export scale, kept even for codec friendliness. */
export function exportFrameSize(clip: Clip, scale: number): { width: number; height: number } {
  const w = Math.max(2, Math.round((clip.frameWidth * scale) / 2) * 2);
  const h = Math.max(2, Math.round((clip.frameHeight * scale) / 2) * 2);
  return { width: w, height: h };
}

export async function exportVideo(request: VideoExportRequest): Promise<VideoExportResult> {
  const { clip, settings, container } = request;
  const start = Math.max(0, Math.min(request.startFrame, clip.frameCount - 1));
  const end = Math.max(start, Math.min(request.endFrame, clip.frameCount - 1));
  const total = end - start + 1;
  const { width, height } = exportFrameSize(clip, request.scale);
  const share = weights(total, clip.fps, container);

  const cancelled = () => request.shouldCancel?.() === true;
  const bail = () => appError("video/export-cancelled", { detail: "cancelled by the user" });

  const grabber = createFrameGrabber(width, height);
  const pool = createRenderPool();
  const rendered: Array<Blob | null> = new Array(total).fill(null);
  const substituted: number[] = [];
  const inFlight = new Set<Promise<void>>();
  // Two beyond the pool so the decoder is never the thing waiting.
  const maxInFlight = pool.size + 2;
  const renderStart = performance.now();
  let done = 0;

  const report = (phase: "render" | "mux", phaseDone: number, phaseTotal: number) => {
    const local = phaseTotal === 0 ? 1 : phaseDone / phaseTotal;
    const fraction = phase === "render" ? local * share.render : share.render + local * share.mux;
    const elapsed = (performance.now() - renderStart) / 1000;
    const etaS = fraction > 0.02 ? Math.max(0, elapsed / fraction - elapsed) : null;
    request.onProgress?.({ phase, done: phaseDone, total: phaseTotal, fraction, etaS });
  };

  try {
    for (let i = 0; i < total; i++) {
      if (cancelled()) throw bail();

      const frameIndex = start + i;
      let plane: ImageData;
      try {
        await seekClip(clip, frameToTime(clip, frameIndex));
        plane = grabber.grab(clip.el);
      } catch (err) {
        request.onFrameError?.(frameIndex, err);
        substituted.push(frameIndex);
        // The slot stays null and is filled from a neighbour below, which keeps
        // the output's duration right where a dropped frame would shorten it.
        done++;
        report("render", done, total);
        continue;
      }

      const slot = i;
      const job = pool
        .render(plane, settings)
        .then((blob) => {
          rendered[slot] = blob;
        })
        .catch((err) => {
          request.onFrameError?.(start + slot, err);
          substituted.push(start + slot);
          // Left null on purpose. Renders finish out of order, so the previous
          // slot may not exist yet; the gap is filled from the nearest
          // *finished* neighbour once every job has settled.
        })
        .finally(() => {
          done++;
          report("render", done, total);
        });

      const tracked = job.finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
      if (inFlight.size >= maxInFlight) await Promise.race(inFlight);
    }

    await Promise.all(inFlight);
    if (cancelled()) throw bail();

    if (!rendered.some((b) => b !== null)) {
      throw appError("video/export-no-frames", {
        detail: `all ${total} frames failed to render or decode`,
        values: { count: total },
      });
    }

    // Fill every gap from its nearest finished neighbour, preferring the frame
    // before it. Repeating a neighbour keeps the output's duration and timing
    // exactly right, which a dropped frame would not; a leading gap falls
    // forward to the first frame that did render.
    const frames: Blob[] = new Array(total);
    let carry: Blob | null = null;
    for (let i = 0; i < total; i++) {
      const b = rendered[i];
      if (b) carry = b;
      if (carry) frames[i] = carry;
    }
    let backfill: Blob | null = null;
    for (let i = total - 1; i >= 0; i--) {
      if (frames[i]) backfill = frames[i]!;
      else if (backfill) frames[i] = backfill;
    }
    const renderMs = performance.now() - renderStart;

    if (container === "png-sequence") {
      report("render", total, total);
      return {
        container,
        frames,
        width,
        height,
        fps: clip.fps,
        frameCount: total,
        substituted,
        degraded: pool.degraded,
        poolSize: pool.size,
        renderMs,
      };
    }

    const mimeType = request.mimeType;
    if (!mimeType) {
      throw appError("video/export-unsupported", {
        detail: `no recorder mime type was resolved for container "${container}"`,
      });
    }

    const blob = await captureToVideo(frames, {
      width,
      height,
      fps: clip.fps,
      mimeType,
      bitsPerSecond: request.bitrate ?? suggestBitrate(width, height, clip.fps),
      onProgress: (f) => report("mux", Math.round(f * total), total),
      shouldCancel: request.shouldCancel,
    });

    return {
      container,
      blob,
      width,
      height,
      fps: clip.fps,
      frameCount: total,
      substituted,
      degraded: pool.degraded,
      poolSize: pool.size,
      renderMs,
    };
  } finally {
    pool.dispose();
    grabber.dispose();
  }
}
