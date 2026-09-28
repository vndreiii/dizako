import { useMemo, useState } from "react";
import { Button, Segmented, Slider, Switch } from "./primitives";
import { IconClose, IconFilmExport } from "./Icons";
import { useI18n } from "../i18n";
import type { Clip } from "../video/clip";
import { suggestBitrate, type ContainerId, type EncoderOption } from "../video/encode";
import { estimatedMemoryBytes, exportFrameSize, type ExportPhaseProgress } from "../video/export";

export interface VideoExportConfig {
  container: ContainerId;
  mimeType?: string;
  scale: number;
  bitrate: number;
  startFrame: number;
  endFrame: number;
  /** Render the whole clip rather than the timeline selection. */
  wholeClip: boolean;
}

interface Props {
  clip: Clip;
  encoders: EncoderOption[];
  range: { start: number; end: number };
  progress: ExportPhaseProgress | null;
  /** Non-fatal frame failures reported so far. */
  frameErrors: number;
  onStart: (config: VideoExportConfig) => void;
  onCancel: () => void;
  onClose: () => void;
}

/** Memory ceiling above which the render phase is refused rather than risked. */
const MEMORY_HARD_LIMIT = 3.5 * 1024 * 1024 * 1024;
const MEMORY_WARN_LIMIT = 1.2 * 1024 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * Export configuration and progress in one surface.
 *
 * The estimates are the point of this dialog. Frame-by-frame dithering of a
 * clip is the most expensive thing Dizako can be asked to do, and the failure
 * everybody hits once is starting a job that cannot finish - too many frames at
 * too high a resolution to hold. So the numbers that decide that (frames,
 * working set, and the host's real encoder list) are on screen *before* the
 * button, and the button itself is withheld when the working set cannot fit.
 */
export function VideoExportDialog({
  clip,
  encoders,
  range,
  progress,
  frameErrors,
  onStart,
  onCancel,
  onClose,
}: Props) {
  const { t } = useI18n();
  const available = encoders.filter((e) => e.available);
  const [container, setContainer] = useState<ContainerId>(() => available[0]?.id ?? "png-sequence");
  const [scale, setScale] = useState(1);
  const [wholeClip, setWholeClip] = useState(false);
  const [quality, setQuality] = useState(1);

  const selected = encoders.find((e) => e.id === container) ?? encoders[encoders.length - 1]!;
  const startFrame = wholeClip ? 0 : range.start;
  const endFrame = wholeClip ? clip.frameCount - 1 : range.end;
  const frameCount = Math.max(1, endFrame - startFrame + 1);
  const size = exportFrameSize(clip, scale);

  const working = useMemo(
    () => estimatedMemoryBytes(frameCount, size.width, size.height),
    [frameCount, size.width, size.height],
  );
  const baseBitrate = suggestBitrate(size.width, size.height, clip.fps);
  const bitrate = Math.round(baseBitrate * quality);
  const videoBytes = container === "png-sequence" ? working : Math.round((bitrate / 8) * (frameCount / clip.fps));

  const tooBig = working > MEMORY_HARD_LIMIT;
  const heavy = !tooBig && working > MEMORY_WARN_LIMIT;
  const running = progress !== null;
  // Starting a job in a format this host cannot write would only produce an
  // error dialog a second later; the reason is already on screen under the
  // picker, so withhold the button instead.
  const blocked = tooBig || !selected.available;

  const start = () =>
    onStart({
      container,
      mimeType: selected.mimeType,
      scale,
      bitrate,
      startFrame,
      endFrame,
      wholeClip,
    });

  return (
    <div className="sheet-scrim" onPointerDown={running ? undefined : onClose}>
      <div
        className="sheet sheet--export"
        role="dialog"
        aria-modal="true"
        aria-label={t("videoExport.title")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sheet__header">
          <h2 className="sheet__title">{t("videoExport.title")}</h2>
          {!running && (
            <button className="sheet__close" onClick={onClose} aria-label={t("dialog.close")} type="button">
              <IconClose />
            </button>
          )}
        </header>

        {running ? (
          <div className="export-progress">
            <p className="export-progress__phase">
              {progress.phase === "render"
                ? t("videoExport.phaseRender").replace("{done}", String(progress.done)).replace("{total}", String(progress.total))
                : t("videoExport.phaseMux")}
            </p>
            <div
              className="export-progress__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.fraction * 100)}
            >
              <span style={{ width: `${Math.min(100, progress.fraction * 100).toFixed(1)}%` }} />
            </div>
            <p className="export-progress__meta">
              {Math.round(progress.fraction * 100)}%
              {progress.etaS !== null && ` · ${t("videoExport.eta").replace("{time}", formatDuration(progress.etaS))}`}
              {frameErrors > 0 && ` · ${t("videoExport.frameErrors").replace("{count}", String(frameErrors))}`}
            </p>
            <p className="export-progress__note">{t("videoExport.keepOpen")}</p>
            <footer className="sheet__foot">
              <Button variant="outlined" onClick={onCancel}>
                {t("videoExport.cancel")}
              </Button>
            </footer>
          </div>
        ) : (
          <>
            <section className="sheet__section">
              <h3 className="sheet__section-title">{t("videoExport.format")}</h3>
              <Segmented
                ariaLabel={t("videoExport.format")}
                value={container}
                onChange={setContainer}
                options={encoders.map((e) => ({
                  value: e.id,
                  label: t(`videoExport.container.${e.id}`) + (e.available ? "" : ` · ${t("videoExport.unavailable")}`),
                }))}
              />
              <p className="sheet__hint">
                {selected.available
                  ? t(`videoExport.containerHint.${selected.id}`)
                  : (selected.reason ?? t("videoExport.unavailable"))}
              </p>
              {!available.some((e) => e.id === "mp4") && (
                <p className="sheet__hint sheet__hint--warn">{t("videoExport.noMp4")}</p>
              )}
            </section>

            <section className="sheet__section">
              <h3 className="sheet__section-title">{t("videoExport.range")}</h3>
              <Switch
                label={t("videoExport.wholeClip")}
                description={t("videoExport.wholeClipHint")}
                checked={wholeClip}
                onChange={setWholeClip}
              />
              <dl className="export-facts">
                <div>
                  <dt>{t("videoExport.frames")}</dt>
                  <dd>{frameCount}</dd>
                </div>
                <div>
                  <dt>{t("videoExport.duration")}</dt>
                  <dd>{formatDuration(frameCount / clip.fps)}</dd>
                </div>
                <div>
                  <dt>{t("videoExport.resolution")}</dt>
                  <dd>
                    {size.width}×{size.height}
                  </dd>
                </div>
                <div>
                  <dt>{t("videoExport.workingSet")}</dt>
                  <dd className={tooBig ? "is-error" : heavy ? "is-warn" : undefined}>{formatBytes(working)}</dd>
                </div>
                <div>
                  <dt>{t("videoExport.estimatedFile")}</dt>
                  <dd>{formatBytes(videoBytes)}</dd>
                </div>
              </dl>
            </section>

            <section className="sheet__section">
              <h3 className="sheet__section-title">{t("videoExport.quality")}</h3>
              <Slider
                label={t("videoExport.scale")}
                value={Math.round(scale * 100)}
                min={25}
                max={100}
                step={5}
                display={`${Math.round(scale * 100)}%`}
                onChange={(v) => setScale(v / 100)}
              />
              {container !== "png-sequence" && (
                <Slider
                  label={t("videoExport.bitrate")}
                  value={Math.round(quality * 100)}
                  min={40}
                  max={200}
                  step={10}
                  display={`${(bitrate / 1_000_000).toFixed(1)} Mbps`}
                  onChange={(v) => setQuality(v / 100)}
                />
              )}
              <p className="sheet__hint">{t("videoExport.bitrateHint")}</p>
            </section>

            {tooBig && <p className="sheet__hint sheet__hint--error">{t("videoExport.tooBig")}</p>}
            {heavy && <p className="sheet__hint sheet__hint--warn">{t("videoExport.heavy")}</p>}
            {clip.hasAudio && <p className="sheet__hint">{t("videoExport.noAudio")}</p>}

            <footer className="sheet__foot">
              <Button variant="outlined" onClick={onClose}>
                {t("videoExport.close")}
              </Button>
              <Button variant="filled" icon={<IconFilmExport />} disabled={blocked} onClick={start}>
                {t("videoExport.start")}
              </Button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
