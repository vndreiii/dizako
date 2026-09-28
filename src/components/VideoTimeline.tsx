import { useCallback, useRef } from "react";
import { IconButton } from "./primitives";
import { IconFilmExport, IconFrameNext, IconFramePrev, IconLoop, IconPause, IconPlay } from "./Icons";
import { useI18n } from "../i18n";
import type { Clip } from "../video/clip";

interface Props {
  clip: Clip;
  frame: number;
  playing: boolean;
  loop: boolean;
  range: { start: number; end: number };
  /** True while an export is running; the transport is read-only then. */
  locked: boolean;
  onFrame: (frame: number) => void;
  onStep: (delta: number) => void;
  onToggle: () => void;
  onLoop: (value: boolean) => void;
  onRange: (range: { start: number; end: number }) => void;
  onExport: () => void;
}

function timecode(seconds: number, fps: number): string {
  const whole = Math.max(0, seconds);
  const m = Math.floor(whole / 60);
  const s = Math.floor(whole % 60);
  const f = Math.floor((whole % 1) * fps);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(2, "0")}`;
}

/**
 * Transport for an open clip.
 *
 * The scrub track doubles as the export range picker: the two handles under it
 * set in and out points, and the filled span between them is what an export
 * will cover. Keeping range and playhead on one track means the thing you are
 * about to export is the thing you were just looking at, rather than a pair of
 * numbers in a dialog that may or may not match.
 */
export function VideoTimeline({
  clip,
  frame,
  playing,
  loop,
  range,
  locked,
  onFrame,
  onStep,
  onToggle,
  onLoop,
  onRange,
  onExport,
}: Props) {
  const { t } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"playhead" | "start" | "end" | null>(null);

  const last = clip.frameCount - 1;
  const pct = (value: number) => (last <= 0 ? 0 : (value / last) * 100);

  const frameAt = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(last, Math.round(ratio * last)));
    },
    [last],
  );

  const applyDrag = useCallback(
    (clientX: number) => {
      const target = frameAt(clientX);
      switch (dragRef.current) {
        case "playhead":
          onFrame(target);
          return;
        case "start":
          // Keep at least one frame between the handles, or the export range
          // becomes empty and the dialog has nothing to offer.
          onRange({ start: Math.min(target, range.end - 1 < 0 ? 0 : range.end), end: range.end });
          return;
        case "end":
          onRange({ start: range.start, end: Math.max(target, range.start) });
          return;
        default:
      }
    },
    [frameAt, onFrame, onRange, range.end, range.start],
  );

  /** Takes the kind at event time; a handler factory would run in render. */
  const beginDrag = useCallback(
    (kind: "playhead" | "start" | "end", e: React.PointerEvent) => {
      if (locked) return;
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = kind;
      applyDrag(e.clientX);
    },
    [applyDrag, locked],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragRef.current) applyDrag(e.clientX);
    },
    [applyDrag],
  );

  const rangeFrames = Math.max(0, range.end - range.start) + 1;

  return (
    <div className={`timeline ${locked ? "is-locked" : ""}`} aria-label={t("timeline.label")}>
      <div className="timeline__transport">
        <IconButton label={playing ? t("timeline.pause") : t("timeline.play")} onClick={onToggle} disabled={locked}>
          {playing ? <IconPause /> : <IconPlay />}
        </IconButton>
        <IconButton label={t("timeline.prevFrame")} onClick={() => onStep(-1)} disabled={locked}>
          <IconFramePrev />
        </IconButton>
        <IconButton label={t("timeline.nextFrame")} onClick={() => onStep(1)} disabled={locked}>
          <IconFrameNext />
        </IconButton>
        <IconButton label={t("timeline.loop")} selected={loop} onClick={() => onLoop(!loop)} disabled={locked}>
          <IconLoop />
        </IconButton>
      </div>

      <div
        ref={trackRef}
        className="timeline__track"
        role="slider"
        tabIndex={locked ? -1 : 0}
        aria-label={t("timeline.frame")}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={frame}
        aria-valuetext={`${frame + 1} / ${clip.frameCount}`}
        onPointerDown={(e) => beginDrag("playhead", e)}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={(e) => {
          if (locked) return;
          const jump = e.shiftKey ? Math.max(1, Math.round(clip.fps)) : 1;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onStep(-jump);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            onStep(jump);
          } else if (e.key === "Home") {
            e.preventDefault();
            onFrame(0);
          } else if (e.key === "End") {
            e.preventDefault();
            onFrame(last);
          }
        }}
      >
        <span className="timeline__rail" />
        <span
          className="timeline__selection"
          style={{ left: `${pct(range.start)}%`, width: `${Math.max(0, pct(range.end) - pct(range.start))}%` }}
        />
        <span className="timeline__playhead" style={{ left: `${pct(frame)}%` }} />
        <span
          className="timeline__handle timeline__handle--start"
          style={{ left: `${pct(range.start)}%` }}
          role="presentation"
          onPointerDown={(e) => beginDrag("start", e)}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onLostPointerCapture={endDrag}
        />
        <span
          className="timeline__handle timeline__handle--end"
          style={{ left: `${pct(range.end)}%` }}
          role="presentation"
          onPointerDown={(e) => beginDrag("end", e)}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onLostPointerCapture={endDrag}
        />
      </div>

      <div className="timeline__meta">
        <span className="timeline__time">{timecode(frame / clip.fps, clip.fps)}</span>
        <span className="timeline__sep">/</span>
        <span className="timeline__time timeline__time--total">{timecode(clip.durationS, clip.fps)}</span>
        <span className="timeline__chip" title={clip.fpsAssumed ? t("timeline.fpsAssumed") : undefined}>
          {clip.fps.toFixed(clip.fps % 1 === 0 ? 0 : 2)} fps{clip.fpsAssumed ? "?" : ""}
        </span>
        <span className="timeline__chip">
          {t("timeline.selection").replace("{count}", String(rangeFrames))}
        </span>
      </div>

      <IconButton label={t("timeline.exportVideo")} variant="tonal" onClick={onExport} disabled={locked}>
        <IconFilmExport />
      </IconButton>
    </div>
  );
}
