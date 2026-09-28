import { useI18n } from "../i18n";
import { IconMovie } from "./Icons";
import type { ImportProgress } from "../video/clip";

interface Props {
  fileName: string;
  progress: ImportProgress | null;
}

/**
 * Placeholder shown while a clip is being opened.
 *
 * Deliberately shaped like the interface it is about to become - a stage, a
 * HUD, a transport with a scrub track - rather than a spinner in an empty
 * room. Opening a large clip takes a couple of seconds of decoder work that
 * cannot be made instant, so the honest thing is to show where it has got to
 * and what the result will look like.
 *
 * Every element here is inert. The transport in particular is a mock: giving
 * the user a scrub track that silently ignores them would be worse than
 * showing none at all, so it reads as a placeholder and says so.
 */
export function ImportSkeleton({ fileName, progress }: Props) {
  const { t } = useI18n();
  const stage = progress?.stage ?? "reading";
  const fraction = progress?.fraction ?? 0.05;

  return (
    <div className="preview import-skeleton" role="status" aria-live="polite" aria-busy="true">
      <div className="preview__frame">
        <div className="preview__stage is-empty import-skeleton__stage">
          <div className="import-skeleton__plate">
            <span className="import-skeleton__glyph" aria-hidden="true">
              <IconMovie />
            </span>
            <p className="import-skeleton__name">{fileName}</p>
            <p className="import-skeleton__stage-label">{t(`import.${stage}`)}</p>

            <div
              className="import-skeleton__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              aria-label={t("import.title")}
            >
              <span style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>

            {/* The four stages, so the wait has visible structure rather than
                a bar creeping across an unexplained gap. */}
            <ol className="import-skeleton__steps">
              {(["metadata", "rate", "frame"] as const).map((step) => {
                const order = ["reading", "metadata", "rate", "frame", "ready"];
                const done = order.indexOf(stage) > order.indexOf(step);
                const active = stage === step;
                return (
                  <li key={step} className={done ? "is-done" : active ? "is-active" : ""}>
                    <span className="import-skeleton__pip" aria-hidden="true" />
                    {t(`import.${step}`)}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {/* A mock HUD in the real one's position, so the layout does not jump
            when the picture arrives. */}
        <div className="preview__hud import-skeleton__hud" aria-hidden="true">
          <span className="import-skeleton__ghost" style={{ width: "150px" }} />
          <span className="import-skeleton__ghost" style={{ width: "44px" }} />
          <span className="import-skeleton__ghost" style={{ width: "96px" }} />
        </div>
      </div>

      <div className="timeline import-skeleton__timeline" aria-hidden="true">
        <div className="timeline__transport">
          <span className="import-skeleton__ghost import-skeleton__ghost--round" />
          <span className="import-skeleton__ghost import-skeleton__ghost--round" />
          <span className="import-skeleton__ghost import-skeleton__ghost--round" />
          <span className="import-skeleton__ghost import-skeleton__ghost--round" />
        </div>
        <div className="timeline__track">
          <span className="timeline__rail" />
          <span className="import-skeleton__scan" />
        </div>
        <div className="timeline__meta">
          <span className="import-skeleton__ghost" style={{ width: "72px" }} />
          <span className="import-skeleton__ghost" style={{ width: "54px" }} />
        </div>
        <span className="import-skeleton__ghost import-skeleton__ghost--round" />
      </div>
    </div>
  );
}
