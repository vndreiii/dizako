import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeClip,
  createFrameGrabber,
  frameToTime,
  measureClipRate,
  openClip,
  seekClip,
  timeToFrame,
  withRate,
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
  /**
   * Measures the real frame rate if only a guess is known, and resolves to the
   * clip as it is afterwards. Safe to call repeatedly; concurrent calls share one run.
   */
  refineRate(): Promise<Clip | null>;
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
  /** Newest frame read wins; an older one finishing late must not paint. */
  const sharpSeq = useRef(0);
  const frameRef = useRef(0);
  const rangeRef = useRef({ start: 0, end: 0 });
  /** The running background rate measurement, if any. */
  const rateTask = useRef<Promise<Clip | null> | null>(null);
  /** The clip that task is measuring, so a stale one is never mistaken for current. */
  const rateFor = useRef<Clip | null>(null);
  const rateCancel = useRef(false);
  const rateTimer = useRef<number | undefined>(undefined);
  const playingRef = useRef(false);
  const loopRef = useRef(loop);
  const onErrorRef = useRef(onError);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern for native callbacks
  onErrorRef.current = onError;
  // eslint-disable-next-line react-hooks/refs -- see above
  loopRef.current = loop;
  // eslint-disable-next-line react-hooks/refs -- see above
  frameRef.current = frame;
  // eslint-disable-next-line react-hooks/refs -- see above
  rangeRef.current = range;

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
    window.clearTimeout(rateTimer.current);
    rateCancel.current = true;
    sharpSeq.current++;
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

  /**
   * Reads the frame under the playhead at full working resolution.
   *
   * The pixels are read off the UI thread (see `createFrameGrabber`), so this
   * is asynchronous; a newer read supersedes an older one still in flight.
   */
  const readSharpFrame = useCallback(async () => {
    const current = clipRef.current;
    const grabber = fullGrabber.current;
    if (!current || !grabber) return;
    const token = ++sharpSeq.current;
    try {
      const image = await grabber.grabAsync(current.el);
      if (token !== sharpSeq.current || clipRef.current !== current) return;
      setFrameImage(image);
      setCoarseFrames(false);
    } catch (err) {
      if (token === sharpSeq.current) onErrorRef.current(err);
    }
  }, []);

  /**
   * Runs `action` once any background rate measurement has stood down.
   *
   * The measurement plays the element, so a transport action issued during it
   * would fight it for the playhead. Cancelling is immediate from the user's
   * side - the measurement ends at its next frame - and the action follows.
   */
  const afterRate = useCallback((action: () => void) => {
    const task = rateTask.current;
    if (!task) {
      action();
      return;
    }
    rateCancel.current = true;
    void task.then(action, action);
  }, []);

  const refineRate = useCallback((): Promise<Clip | null> => {
    const current = clipRef.current;
    if (rateTask.current && rateFor.current === current) return rateTask.current;
    if (!current || !current.fpsAssumed || playingRef.current) return Promise.resolve(current);

    rateCancel.current = false;
    rateFor.current = current;
    const task = (async (): Promise<Clip | null> => {
      try {
        const { fps, assumed } = await measureClipRate(current.el, () => rateCancel.current || clipRef.current !== current);
        if (clipRef.current !== current) return clipRef.current;
        if (fps === current.fps && assumed === current.fpsAssumed) {
          await seekClip(current, frameToTime(current, frameRef.current)).catch(() => {});
          return current;
        }
        const next = withRate(current, fps, assumed);
        clipRef.current = next;
        setClip(next);

        // The frame count moved with the rate; carry the playhead and the kept
        // range across by position rather than by index.
        const at = (i: number) => (i >= current.frameCount - 1 ? next.frameCount - 1 : Math.round((i * next.frameCount) / current.frameCount));
        const frame = Math.min(next.frameCount - 1, at(frameRef.current));
        setFrame(frame);
        setRange({ start: at(rangeRef.current.start), end: Math.max(at(rangeRef.current.end), at(rangeRef.current.start)) });
        // The measurement left the element wherever playback got to.
        await seekClip(next, frameToTime(next, frame)).catch(() => {});
        return next;
      } finally {
        if (rateFor.current === current) {
          rateTask.current = null;
          rateFor.current = null;
        }
      }
    })();
    rateTask.current = task;
    return task;
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
        await readSharpFrame();

        // The real frame rate is found in the background, once the picture is
        // up and the user has had a moment to do something else first.
        window.clearTimeout(rateTimer.current);
        rateTimer.current = window.setTimeout(() => void refineRate(), 900);
        return true;
      } catch (err) {
        onErrorRef.current(err);
        return false;
      } finally {
        setOpening(false);
        setImportProgress(null);
      }
    },
    [readSharpFrame, refineRate, teardown],
  );

  const goToFrame = useCallback(
    (target: number) => {
      const current = clipRef.current;
      if (!current) return;
      const next = Math.max(0, Math.min(current.frameCount - 1, Math.round(target)));
      setFrame(next);
      const token = ++seekSeq.current;
      afterRate(() => {
        // The measurement may have changed the clip (and so the frame's time).
        const active = clipRef.current;
        if (!active || token !== seekSeq.current) return;
        void seekClip(active, frameToTime(active, Math.min(next, active.frameCount - 1)))
          .then(() => {
            // A scrub fires faster than seeks complete; only the newest one may
            // paint, or the preview walks backwards behind the handle.
            if (token !== seekSeq.current || playingRef.current) return;
            void readSharpFrame();
          })
          .catch((err) => {
            if (token === seekSeq.current) onErrorRef.current(err);
          });
      });
    },
    [afterRate, readSharpFrame],
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
    void readSharpFrame();
  }, [readSharpFrame, stopLoops]);

  const play = useCallback(() => {
    const current = clipRef.current;
    if (!current) return;
    const grabber = playGrabber.current;
    if (!grabber) return;

    playingRef.current = true;
    setPlaying(true);
    setCoarseFrames(true);
    // Whatever sharp read is in flight is for a frame about to be left behind.
    sharpSeq.current++;

    /** A frame is being read off-thread; decoded frames meanwhile are skipped
     *  rather than queued, so the picture stays current instead of lagging. */
    let reading = false;

    const onFrame = () => {
      const active = clipRef.current;
      if (!active || !playingRef.current) return;
      if (!reading) {
        reading = true;
        grabber
          .grabAsync(active.el)
          .then((image) => {
            reading = false;
            if (!playingRef.current || clipRef.current !== active) return;
            setFrameImage(image);
            setFrame(timeToFrame(active, active.el.currentTime));
          })
          .catch((err) => {
            reading = false;
            if (!playingRef.current) return;
            playingRef.current = false;
            setPlaying(false);
            active.el.pause();
            onErrorRef.current(err);
          });
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

    // A measurement still running owns the element until it stands down.
    afterRate(() => {
      if (!playingRef.current) return;
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
    });
  }, [afterRate, pause]);

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
      refineRate,
    }),
    [
      clip, frame, frameImage, playing, loop, opening, importProgress, coarseFrames,
      open, close, goToFrame, step, play, pause, toggle, range, refineRate,
    ],
  );
}
