import { memo } from "react";
import { useI18n } from "../i18n";
import { DEFAULT_SETTINGS, type Settings } from "../dither/types";
import { Button, Segmented, Slider, Switch } from "./primitives";
import { IconReset } from "./Icons";

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  sourceSize: { width: number; height: number } | null;
}

const TONE_KEYS = ["exposure", "brightness", "contrast", "gamma"] as const;

const COLOUR_KEYS = ["saturation", "hueShift", "temperature", "tint"] as const;

const FILTER_KEYS = ["blur", "sharpen", "grayscale", "invert"] as const;

function resetOf(keys: readonly (keyof Settings)[]): Partial<Settings> {
  const p: Record<string, unknown> = {};
  for (const k of keys) p[k] = DEFAULT_SETTINGS[k];
  return p as Partial<Settings>;
}

function AdjustPanelImpl({ settings, patch, sourceSize }: Props) {
  const { t } = useI18n();
  const scaled = sourceSize
    ? {
        width: Math.max(1, Math.round(sourceSize.width / settings.pixelScale)),
        height: Math.max(1, Math.round(sourceSize.height / settings.pixelScale)),
      }
    : null;

  return (
    <div className="panel">
      <header className="panel__header">
        <h2 className="panel__title">{t("adjust.title")}</h2>
        <Button
          variant="text"
          icon={<IconReset />}
          onClick={() =>
            patch({
              ...resetOf(TONE_KEYS),
              ...resetOf(COLOUR_KEYS),
              ...resetOf(FILTER_KEYS),
              pixelScale: DEFAULT_SETTINGS.pixelScale,
            })
          }
        >
          {t("common.reset")}
        </Button>
      </header>

      <div className="panel__scroll">
        <section className="panel__section">
          <h3 className="panel__section-title">{t("adjust.resolution")}</h3>
          <div className="field">
            <span className="field__label">{t("adjust.pixelScale")}</span>
            <Segmented
              ariaLabel={t("adjust.pixelScaleAria")}
              value={String(settings.pixelScale)}
              onChange={(v) => patch({ pixelScale: Number(v) })}
              options={[
                { value: "1", label: "1:1" },
                { value: "2", label: "½" },
                { value: "4", label: "¼" },
                { value: "8", label: "⅛" },
              ]}
            />
          </div>
          {scaled && (
            <p className="panel__note">
              {settings.pixelScale > 1
                ? t("adjust.ditheringAt")
                    .replace("{w}", String(scaled.width))
                    .replace("{h}", String(scaled.height)) + ` - ${t("adjust.coarserHint")}.`
                : t("adjust.ditheringAt")
                    .replace("{w}", String(scaled.width))
                    .replace("{h}", String(scaled.height))}
            </p>
          )}
        </section>

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">{t("adjust.tone")}</h3>
            <Button variant="text" onClick={() => patch(resetOf(TONE_KEYS))}>
              {t("common.reset")}
            </Button>
          </div>
          <Slider
            label={t("adjust.exposure")}
            value={Math.round(settings.exposure * 20)}
            min={-60}
            max={60}
            display={`${settings.exposure > 0 ? "+" : ""}${settings.exposure.toFixed(2)} EV`}
            onChange={(v) => patch({ exposure: v / 20 })}
          />
          <Slider
            label={t("adjust.brightness")}
            value={settings.brightness}
            min={-100}
            max={100}
            onChange={(v) => patch({ brightness: v })}
          />
          <Slider
            label={t("adjust.contrast")}
            value={settings.contrast}
            min={-100}
            max={100}
            onChange={(v) => patch({ contrast: v })}
          />
          <Slider
            label={t("adjust.gamma")}
            value={Math.round(settings.gamma * 100)}
            min={10}
            max={300}
            display={settings.gamma.toFixed(2)}
            onChange={(v) => patch({ gamma: v / 100 })}
          />
          <p className="panel__note">{t("adjust.toneNote")}</p>
        </section>

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">{t("adjust.colour")}</h3>
            <Button variant="text" onClick={() => patch(resetOf(COLOUR_KEYS))}>
              {t("common.reset")}
            </Button>
          </div>
          <Slider
            label={t("adjust.saturation")}
            value={settings.saturation}
            min={-100}
            max={100}
            onChange={(v) => patch({ saturation: v })}
          />
          <Slider
            label={t("adjust.hueShift")}
            value={settings.hueShift}
            min={-180}
            max={180}
            display={`${settings.hueShift}°`}
            onChange={(v) => patch({ hueShift: v })}
          />
          <Slider
            label={t("adjust.temperature")}
            value={settings.temperature}
            min={-100}
            max={100}
            display={
              settings.temperature === 0
                ? t("adjust.neutral")
                : settings.temperature > 0
                  ? t("adjust.warm").replace("{n}", String(settings.temperature))
                  : t("adjust.cool").replace("{n}", String(-settings.temperature))
            }
            onChange={(v) => patch({ temperature: v })}
          />
          <Slider
            label={t("adjust.tint")}
            value={settings.tint}
            min={-100}
            max={100}
            display={
              settings.tint === 0
                ? t("adjust.neutral")
                : settings.tint > 0
                  ? t("adjust.green").replace("{n}", String(settings.tint))
                  : t("adjust.magenta").replace("{n}", String(-settings.tint))
            }
            onChange={(v) => patch({ tint: v })}
          />
        </section>

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">{t("adjust.filters")}</h3>
            <Button variant="text" onClick={() => patch(resetOf(FILTER_KEYS))}>
              {t("common.reset")}
            </Button>
          </div>
          <Slider
            label={t("adjust.blur")}
            value={settings.blur}
            min={0}
            max={12}
            display={settings.blur === 0 ? t("common.off") : `${settings.blur} px`}
            onChange={(v) => patch({ blur: v })}
          />
          <Slider
            label={t("adjust.sharpen")}
            value={Math.round(settings.sharpen * 100)}
            min={0}
            max={300}
            display={
              settings.sharpen === 0 ? t("common.off") : `${Math.round(settings.sharpen * 100)}%`
            }
            onChange={(v) => patch({ sharpen: v / 100 })}
          />
          <p className="panel__note">{t("adjust.filterNote")}</p>
          <Switch
            label={t("adjust.grayscale")}
            description={t("adjust.grayscaleDesc")}
            checked={settings.grayscale}
            onChange={(v) => patch({ grayscale: v })}
          />
          <Switch
            label={t("adjust.invert")}
            description={t("adjust.invertDesc")}
            checked={settings.invert}
            onChange={(v) => patch({ invert: v })}
          />
        </section>
      </div>
    </div>
  );
}

export const AdjustPanel = memo(AdjustPanelImpl);
