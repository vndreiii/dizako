import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeClip,
  createFrameGrabber,
  frameToTime,
  openClip,
  seekClip,
  timeToFrame,
  type Clip,
  type FrameGrabber,
  type ImportProgress,
} from "../video/clip";
import { appError } from "../errors";

/**
 * Longest side used while a clip is playing.
 *
 * Playback dithers a frame per displayed frame, so the working plane has to be
 * small enough that the whole pipeline - grab, ship, dither, upload - fits in a
 * frame budget. 640px is where that lands on a laptop, and scrubbing or pausing
 * immediately re-reads the frame at full working size, so nothing is lost
 * except while the picture is moving.
 */
const PLAYBACK_LONG_EDGE = 640;

export interface VideoClipApi {
  clip: Clip | null;
  /** Currently displayed frame index. */
  frame: number;
  /** Pixels for the current frame, or null before the first read. */
  frameImage: ImageData | null;
  playing: boolean;
  loop: boolean;
  /** A clip is being decoded and probed. */
  opening: boolean;
  /** Which stage the current import is on, or null when nothing is opening. */
  importProgress: ImportProgress | null;
  /** True while frames are read at playback resolution. */
  coarseFrames: boolean;
  open(file: File): Promise<boolean>;
  close(): void;
  goToFrame(frame: number): void;
  step(delta: number): void;
  play(): void;
  pause(): void;
  toggle(): void;
  setLoop(value: boolean): void;
  /** Range kept for export, in frames, inclusive. */
  range: { start: number; end: number };
  setRange(range: { start: number; end: number }): void;
}

function longEdgeFit(width: number, height: number, longEdge: number) {
  const longest = Math.max(width, height);
  if (longest <= longEdge) return { width, height };
  const scale = longEdge / longest;
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) };
}

/**
 * Owns one open clip and the playhead over it.
 *
 * Deliberately separate from the dither pipeline: this hook's only output is
 * "here are the pixels of the frame the user is looking at", which is exactly
 * the input the still-image path already takes. Video support therefore adds a
 * source of `ImageData` rather than a second rendering path, and everything
 * downstream - algorithms, palettes, undo, export - works on video without
 * knowing video exists.
 */
export function useVideoClip(onError: (error: unknown) => void): VideoClipApi {
  const [clip, setClip] = useState<Clip | null>(null);
  const [frame, setFrame] = useState(0);
  const [frameImage, setFrameImage] = useState<ImageData | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [opening, setOpening] = useState(false);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [coarseFrames, setCoarseFrames] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 0 });

  const clipRef = useRef<Clip | null>(null);
  const fullGrabber = useRef<FrameGrabber | null>(null);
  const playGrabber = useRef<FrameGrabber | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const rvfcRef = useRef<number | undefined>(undefined);
  /** Detaches the current `ended` handler; re-created on each play. */
  const endedListener = useRef<(() => void) | null>(null);
  const seekSeq = useRef(0);
  const playingRef = useRef(false);
  const loopRef = useRef(loop);
  const onErrorRef = useRef(onError);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern for native callbacks
  onErrorRef.current = onError;
  // eslint-disable-next-line react-hooks/refs -- see above
  loopRef.current = loop;

  const stopLoops = useCallback(() => {
    endedListener.current?.();
    if (rafRef.current !== undefined) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    const el = clipRef.current?.el as (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }) | undefined;
    if (rvfcRef.current !== undefined && el?.cancelVideoFrameCallback) {
      el.cancelVideoFrameCallback(rvfcRef.current);
      rvfcRef.current = undefined;
    }
  }, []);

  const teardown = useCallback(() => {
    stopLoops();
    fullGrabber.current?.dispose();
    playGrabber.current?.dispose();
    fullGrabber.current = null;
    playGrabber.current = null;
    if (clipRef.current) closeClip(clipRef.current);
    clipRef.current = null;
    playingRef.current = false;
  }, [stopLoops]);

  useEffect(() => teardown, [teardown]);

  const close = useCallback(() => {
    teardown();
    setClip(null);
    setFrameImage(null);
    setFrame(0);
    setPlaying(false);
    setCoarseFrames(false);
    setRange({ start: 0, end: 0 });
  }, [teardown]);

  /** Reads the frame under the playhead at full working resolution. */
  const readSharpFrame = useCallback(() => {
    const current = clipRef.current;
    const grabber = fullGrabber.current;
    if (!current || !grabber) return;
    try {
      setFrameImage(grabber.grab(current.el));
      setCoarseFrames(false);
    } catch (err) {
      onErrorRef.current(err);
    }
  }, []);

  const open = useCallback(
    async (file: File): Promise<boolean> => {
      setOpening(true);
      setImportProgress({ stage: "reading", fraction: 0.05 });
      try {
        const next = await openClip(file, setImportProgress);
        teardown();
        clipRef.current = next;
        fullGrabber.current = createFrameGrabber(next.frameWidth, next.frameHeight);
        const play = longEdgeFit(next.frameWidth, next.frameHeight, PLAYBACK_LONG_EDGE);
        playGrabber.current = createFrameGrabber(play.width, play.height);
        next.el.loop = false;

        await seekClip(next, frameToTime(next, 0));
        setClip(next);
        setFrame(0);
        setRange({ start: 0, end: next.frameCount - 1 });
        setPlaying(false);
        readSharpFrame();
        return true;
      } catch (err) {
        onErrorRef.current(err);
        return false;
      } finally {
        setOpening(false);
        setImportProgress(null);
      }
    },
    [readSharpFrame, teardown],
  );

  const goToFrame = useCallback(
    (target: number) => {
      const current = clipRef.current;
      if (!current) return;
      const next = Math.max(0, Math.min(current.frameCount - 1, Math.round(target)));
      setFrame(next);
      const token = ++seekSeq.current;
      void seekClip(current, frameToTime(current, next))
        .then(() => {
          // A scrub fires faster than seeks complete; only the newest one may
          // paint, or the preview walks backwards behind the handle.
          if (token !== seekSeq.current || playingRef.current) return;
          readSharpFrame();
        })
        .catch((err) => {
          if (token === seekSeq.current) onErrorRef.current(err);
        });
    },
    [readSharpFrame],
  );

  const step = useCallback(
    (delta: number) => {
      const current = clipRef.current;
      if (!current) return;
      if (playingRef.current) {
        playingRef.current = false;
        current.el.pause();
        setPlaying(false);
      }
      goToFrame(frame + delta);
    },
    [frame, goToFrame],
  );

  const pause = useCallback(() => {
    const current = clipRef.current;
    if (!current) return;
    playingRef.current = false;
    stopLoops();
    current.el.pause();
    setPlaying(false);
    // Land on a sharp frame the moment motion stops - that is when the user
    // starts judging the dither.
    setFrame(timeToFrame(current, current.el.currentTime));
    readSharpFrame();
  }, [readSharpFrame, stopLoops]);

  const play = useCallback(() => {
    const current = clipRef.current;
    if (!current) return;
    const grabber = playGrabber.current;
    if (!grabber) return;

    playingRef.current = true;
    setPlaying(true);
    setCoarseFrames(true);

    const onFrame = () => {
      const active = clipRef.current;
      if (!active || !playingRef.current) return;
      try {
        setFrameImage(grabber.grab(active.el));
        setFrame(timeToFrame(active, active.el.currentTime));
      } catch (err) {
        playingRef.current = false;
        setPlaying(false);
        active.el.pause();
        onErrorRef.current(err);
        return;
      }
      schedule();
    };

    type WithRvfc = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const schedule = () => {
      const el = clipRef.current?.el as WithRvfc | undefined;
      if (!el) return;
      // `requestVideoFrameCallback` fires once per *decoded* frame, so the
      // dither runs exactly as often as there is something new to dither.
      // rAF is the fallback and over-samples on low-fps footage; harmless.
      if (typeof el.requestVideoFrameCallback === "function") {
        rvfcRef.current = el.requestVideoFrameCallback(onFrame);
      } else {
        rafRef.current = requestAnimationFrame(onFrame);
      }
    };

    // Not `once`: a looping clip ends repeatedly, and a one-shot listener meant
    // the loop worked exactly one time and then stopped.
    const onEnded = () => {
      if (!playingRef.current) return;
      if (loopRef.current) {
        current.el.currentTime = 0;
        void current.el.play().catch(() => pause());
        return;
      }
      pause();
    };
    endedListener.current?.();
    current.el.addEventListener("ended", onEnded);
    endedListener.current = () => {
      current.el.removeEventListener("ended", onEnded);
      endedListener.current = null;
    };

    void current.el.play().then(schedule, (err) => {
      playingRef.current = false;
      setPlaying(false);
      onErrorRef.current(
        appError("video/decode-failed", {
          detail: `play() was rejected: ${String(err)}`,
          values: { name: current.file.name },
          cause: err,
        }),
      );
    });
  }, [pause]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  /**
   * Memoised because App derives callbacks from this object.
   *
   * A new literal per render changed its identity on every displayed frame,
   * which re-created `load`, `exportPng` and friends sixty times a second and
   * re-subscribed the window-level drag-and-drop and keyboard listeners with
   * them. The object is the hook's public surface; it should change when its
   * contents do and not otherwise.
   */
  return useMemo(
    () => ({
      clip,
      frame,
      frameImage,
      playing,
      loop,
      opening,
      importProgress,
      coarseFrames,
      open,
      close,
      goToFrame,
      step,
      play,
      pause,
      toggle,
      setLoop,
      range,
      setRange,
    }),
    [
      clip, frame, frameImage, playing, loop, opening, importProgress, coarseFrames,
      open, close, goToFrame, step, play, pause, toggle, range,
    ],
  );
}
