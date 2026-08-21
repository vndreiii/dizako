import { memo } from "react";
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
  const scaled = sourceSize
    ? {
        width: Math.max(1, Math.round(sourceSize.width / settings.pixelScale)),
        height: Math.max(1, Math.round(sourceSize.height / settings.pixelScale)),
      }
    : null;

  return (
    <div className="panel">
      <header className="panel__header">
        <h2 className="panel__title">Image</h2>
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
          Reset
        </Button>
      </header>

      <div className="panel__scroll">
        <section className="panel__section">
          <h3 className="panel__section-title">Resolution</h3>
          <div className="field">
            <span className="field__label">Pixel scale</span>
            <Segmented
              ariaLabel="Pixel scale"
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
              Dithering at {scaled.width}×{scaled.height}
              {settings.pixelScale > 1 && " - coarser dots, stronger retro feel."}
            </p>
          )}
        </section>

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">Tone</h3>
            <Button variant="text" onClick={() => patch(resetOf(TONE_KEYS))}>
              Reset
            </Button>
          </div>
          <Slider
            label="Exposure"
            value={Math.round(settings.exposure * 20)}
            min={-60}
            max={60}
            display={`${settings.exposure > 0 ? "+" : ""}${settings.exposure.toFixed(2)} EV`}
            onChange={(v) => patch({ exposure: v / 20 })}
          />
          <Slider
            label="Brightness"
            value={settings.brightness}
            min={-100}
            max={100}
            onChange={(v) => patch({ brightness: v })}
          />
          <Slider
            label="Contrast"
            value={settings.contrast}
            min={-100}
            max={100}
            onChange={(v) => patch({ contrast: v })}
          />
          <Slider
            label="Gamma"
            value={Math.round(settings.gamma * 100)}
            min={10}
            max={300}
            display={settings.gamma.toFixed(2)}
            onChange={(v) => patch({ gamma: v / 100 })}
          />
          <p className="panel__note">
            Tone is graded before the dither runs, so pushing contrast here changes which colours the
            algorithm has to reach for.
          </p>
        </section>

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">Colour</h3>
            <Button variant="text" onClick={() => patch(resetOf(COLOUR_KEYS))}>
              Reset
            </Button>
          </div>
          <Slider
            label="Saturation"
            value={settings.saturation}
            min={-100}
            max={100}
            onChange={(v) => patch({ saturation: v })}
          />
          <Slider
            label="Hue shift"
            value={settings.hueShift}
            min={-180}
            max={180}
            display={`${settings.hueShift}°`}
            onChange={(v) => patch({ hueShift: v })}
          />
          <Slider
            label="Temperature"
            value={settings.temperature}
            min={-100}
            max={100}
            display={
              settings.temperature === 0
                ? "neutral"
                : settings.temperature > 0
                  ? `+${settings.temperature} warm`
                  : `${-settings.temperature} cool`
            }
            onChange={(v) => patch({ temperature: v })}
          />
          <Slider
            label="Tint"
            value={settings.tint}
            min={-100}
            max={100}
            display={
              settings.tint === 0
                ? "neutral"
                : settings.tint > 0
                  ? `+${settings.tint} green`
                  : `${-settings.tint} magenta`
            }
            onChange={(v) => patch({ tint: v })}
          />
        </section>

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">Filters</h3>
            <Button variant="text" onClick={() => patch(resetOf(FILTER_KEYS))}>
              Reset
            </Button>
          </div>
          <Slider
            label="Blur"
            value={settings.blur}
            min={0}
            max={12}
            display={settings.blur === 0 ? "off" : `${settings.blur} px`}
            onChange={(v) => patch({ blur: v })}
          />
          <Slider
            label="Sharpen"
            value={Math.round(settings.sharpen * 100)}
            min={0}
            max={300}
            display={settings.sharpen === 0 ? "off" : `${Math.round(settings.sharpen * 100)}%`}
            onChange={(v) => patch({ sharpen: v / 100 })}
          />
          <p className="panel__note">
            A touch of blur calms noisy sources; sharpening before an ordered screen exaggerates
            edges into hard graphic shapes.
          </p>
          <Switch
            label="Grayscale"
            description="Drop colour before dithering."
            checked={settings.grayscale}
            onChange={(v) => patch({ grayscale: v })}
          />
          <Switch
            label="Invert"
            description="Flip tones after adjustments."
            checked={settings.invert}
            onChange={(v) => patch({ invert: v })}
          />
        </section>
      </div>
    </div>
  );
}

export const AdjustPanel = memo(AdjustPanelImpl);
