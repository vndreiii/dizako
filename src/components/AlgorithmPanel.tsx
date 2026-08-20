import {
  ALGORITHMS,
  DEFAULT_SETTINGS,
  type AlgorithmFamily,
  type AlgorithmId,
  type OminoDirection,
  type ParamKey,
  type Settings,
} from "../dither/types";
import { Button, Segmented, Slider, Switch } from "./primitives";
import { IconReset } from "./Icons";

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}

const GROUPS: AlgorithmFamily[] = ["error-diffusion", "ordered", "threshold", "experimental"];

const FAMILY_LABEL: Record<AlgorithmFamily, string> = {
  "error-diffusion": "Error diffusion",
  ordered: "Ordered",
  threshold: "Threshold",
  experimental: "Experimental",
};

const DIRECTIONS: Array<{ value: OminoDirection; label: string }> = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
  { value: "down", label: "Down" },
  { value: "up", label: "Up" },
];

/** Setting keys each param group owns, so "reset" only touches what is shown. */
const RESET_KEYS: Record<ParamKey, Array<keyof Settings>> = {
  strength: ["strength"],
  serpentine: ["serpentine"],
  jitter: ["jitter"],
  errorClamp: ["errorClamp"],
  bayerSize: ["bayerSize"],
  threshold: ["threshold"],
  noiseAmount: ["noiseAmount"],
  cellSize: ["cellSize"],
  screenAngle: ["screenAngle"],
  noiseScale: ["noiseScale"],
  riemersmaQueue: ["riemersmaQueue"],
  riemersmaDecay: ["riemersmaDecay"],
  dotClassSize: ["dotClassSize"],
  omino: [
    "ominoDirection",
    "ominoErrorStrength",
    "ominoAcross",
    "ominoAside",
    "ominoPhase",
    "ominoColorCount",
  ],
};

export function AlgorithmPanel({ settings, patch }: Props) {
  const meta = ALGORITHMS.find((a) => a.id === settings.algorithm) ?? ALGORITHMS[0];
  const has = (p: ParamKey) => meta.params.includes(p);

  const resetParams = () => {
    const p: Partial<Settings> = {};
    for (const key of meta.params) {
      for (const k of RESET_KEYS[key]) {
        (p as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
      }
    }
    patch(p);
  };

  return (
    <div className="panel">
      <header className="panel__header">
        <h2 className="panel__title">Algorithm</h2>
        <p className="panel__subtitle">{ALGORITHMS.length} to choose from</p>
      </header>

      <div className="panel__scroll">
        {GROUPS.map((g) => (
          <section key={g} className="panel__section">
            <h3 className="panel__section-title">{FAMILY_LABEL[g]}</h3>
            <div className="algo-grid">
              {ALGORITHMS.filter((a) => a.family === g).map((a) => (
                <button
                  key={a.id}
                  className={`algo-card ${a.id === settings.algorithm ? "is-selected" : ""}`}
                  aria-pressed={a.id === settings.algorithm}
                  onClick={() => patch({ algorithm: a.id as AlgorithmId })}
                >
                  <span className="algo-card__name">{a.name}</span>
                  <span className="algo-card__blurb">{a.blurb}</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">{meta.name} controls</h3>
            <Button variant="text" icon={<IconReset />} onClick={resetParams}>
              Reset
            </Button>
          </div>

          {has("strength") && (
            <Slider
              label="Diffusion strength"
              value={Math.round(settings.strength * 100)}
              min={0}
              max={200}
              display={`${Math.round(settings.strength * 100)}%`}
              onChange={(v) => patch({ strength: v / 100 })}
            />
          )}

          {has("errorClamp") && (
            <Slider
              label="Error clamp"
              value={settings.errorClamp}
              min={0}
              max={255}
              display={settings.errorClamp === 0 ? "off" : String(settings.errorClamp)}
              onChange={(v) => patch({ errorClamp: v })}
            />
          )}

          {has("jitter") && (
            <Slider
              label="Kernel jitter"
              value={Math.round(settings.jitter * 100)}
              min={0}
              max={100}
              display={`${Math.round(settings.jitter * 100)}%`}
              onChange={(v) => patch({ jitter: v / 100 })}
            />
          )}

          {has("bayerSize") && (
            <div className="panel__field">
              <span className="panel__field-label">Matrix size</span>
              <Segmented
                ariaLabel="Bayer matrix size"
                value={String(settings.bayerSize)}
                onChange={(v) => patch({ bayerSize: Number(v) })}
                options={[
                  { value: "2", label: "2×2" },
                  { value: "4", label: "4×4" },
                  { value: "8", label: "8×8" },
                  { value: "16", label: "16×16" },
                ]}
              />
            </div>
          )}

          {has("cellSize") && (
            <Slider
              label="Cell size"
              value={settings.cellSize}
              min={2}
              max={32}
              display={`${settings.cellSize} px`}
              onChange={(v) => patch({ cellSize: v })}
            />
          )}

          {has("screenAngle") && (
            <Slider
              label="Screen angle"
              value={settings.screenAngle}
              min={0}
              max={90}
              display={`${settings.screenAngle}°`}
              onChange={(v) => patch({ screenAngle: v })}
            />
          )}

          {has("noiseScale") && (
            <Slider
              label="Noise scale"
              value={Math.round(settings.noiseScale * 10)}
              min={5}
              max={80}
              display={`${settings.noiseScale.toFixed(1)}×`}
              onChange={(v) => patch({ noiseScale: v / 10 })}
            />
          )}

          {has("threshold") && (
            <Slider
              label="Threshold"
              value={settings.threshold}
              min={0}
              max={255}
              onChange={(v) => patch({ threshold: v })}
            />
          )}

          {has("noiseAmount") && (
            <Slider
              label="Noise amount"
              value={Math.round(settings.noiseAmount * 100)}
              min={0}
              max={200}
              display={`${Math.round(settings.noiseAmount * 100)}%`}
              onChange={(v) => patch({ noiseAmount: v / 100 })}
            />
          )}

          {has("riemersmaQueue") && (
            <Slider
              label="Error queue"
              value={settings.riemersmaQueue}
              min={2}
              max={64}
              display={`${settings.riemersmaQueue} px`}
              onChange={(v) => patch({ riemersmaQueue: v })}
            />
          )}

          {has("riemersmaDecay") && (
            <Slider
              label="Queue decay"
              value={Math.round(settings.riemersmaDecay * 100)}
              min={5}
              max={99}
              display={settings.riemersmaDecay.toFixed(2)}
              onChange={(v) => patch({ riemersmaDecay: v / 100 })}
            />
          )}

          {has("dotClassSize") && (
            <div className="panel__field">
              <span className="panel__field-label">Class matrix</span>
              <Segmented
                ariaLabel="Dot diffusion class matrix size"
                value={String(settings.dotClassSize)}
                onChange={(v) => patch({ dotClassSize: Number(v) })}
                options={[
                  { value: "4", label: "4×4" },
                  { value: "8", label: "8×8" },
                  { value: "16", label: "16×16" },
                ]}
              />
            </div>
          )}

          {has("omino") && (
            <>
              <div className="panel__field">
                <span className="panel__field-label">March direction</span>
                <Segmented
                  ariaLabel="March direction"
                  value={settings.ominoDirection}
                  onChange={(v) => patch({ ominoDirection: v as OminoDirection })}
                  options={DIRECTIONS}
                />
              </div>
              <Slider
                label="Error strength"
                value={Math.round(settings.ominoErrorStrength * 100)}
                min={0}
                max={400}
                display={`${Math.round(settings.ominoErrorStrength * 100)}%`}
                onChange={(v) => patch({ ominoErrorStrength: v / 100 })}
              />
              <Slider
                label="Error across"
                value={Math.round(settings.ominoAcross * 100)}
                min={0}
                max={150}
                display={`${Math.round(settings.ominoAcross * 100)}%`}
                onChange={(v) => patch({ ominoAcross: v / 100 })}
              />
              <Slider
                label="Error aside"
                value={Math.round(settings.ominoAside * 100)}
                min={0}
                max={150}
                display={`${Math.round(settings.ominoAside * 100)}%`}
                onChange={(v) => patch({ ominoAside: v / 100 })}
              />
              <Slider
                label="Initial phase"
                value={settings.ominoPhase}
                min={0}
                max={360}
                display={`${settings.ominoPhase}°`}
                onChange={(v) => patch({ ominoPhase: v })}
              />
              <Slider
                label="Colour count"
                value={settings.ominoColorCount}
                min={1}
                max={16}
                display={`${settings.ominoColorCount} of ${settings.layers.length}`}
                onChange={(v) => patch({ ominoColorCount: v })}
              />
              <p className="panel__note">
                Stripe width comes from each layer's weight in the Palette tab — widen one and it
                claims longer runs. Eyedropping a few colours straight out of the image is the
                classic way to use this.
              </p>
            </>
          )}

          {has("serpentine") && (
            <Switch
              label="Serpentine scan"
              checked={settings.serpentine}
              onChange={(v) => patch({ serpentine: v })}
            />
          )}

          <p className="panel__note">{meta.blurb}</p>
        </section>
      </div>
    </div>
  );
}
