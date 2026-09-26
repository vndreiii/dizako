import { memo, useState } from "react";
import { useI18n } from "../i18n";
import {
  ALGORITHMS,
  DEFAULT_SETTINGS,
  makeAlgorithmLayer,
  type AlgorithmFamily,
  type AlgorithmId,
  type OminoDirection,
  type ParamKey,
  type Settings,
} from "../dither/types";
import { BareSlider, Button, IconButton, Segmented, Slider, Switch } from "./primitives";
import { IconAdd, IconArrowDown, IconArrowUp, IconDelete, IconHidden, IconReset, IconVisible } from "./Icons";

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
}

const GROUPS: AlgorithmFamily[] = ["error-diffusion", "ordered", "threshold", "experimental"];

const DIRECTIONS: Array<{ value: OminoDirection; key: string }> = [
  { value: "right", key: "dir.right" },
  { value: "left", key: "dir.left" },
  { value: "down", key: "dir.down" },
  { value: "up", key: "dir.up" },
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
  jpegCellSize: ["jpegCellSize"],
  jpegDamage: ["jpegDamage"],
  jpegErrorRate: ["jpegErrorRate"],
  jpegErrorDensity: ["jpegErrorDensity"],
  jpegErrorAmplitude: ["jpegErrorAmplitude"],
  jpegErrorCoherence: ["jpegErrorCoherence"],
};

function AlgorithmPanelImpl({ settings, patch }: Props) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stack = settings.algorithmLayers.length
    ? settings.algorithmLayers
    : [{ id: "legacy", algorithm: settings.algorithm, enabled: true, opacity: 1 }];
  const selected = stack.find((layer) => layer.id === selectedId) ?? stack[stack.length - 1];
  const meta = ALGORITHMS.find((a) => a.id === selected.algorithm) ?? ALGORITHMS[0];
  const has = (p: ParamKey) => meta.params.includes(p);
  const controlSettings = { ...settings, ...selected.params };
  const patchParams = (changes: Partial<Settings>) => {
    if (!settings.algorithmLayers.length) {
      patch(changes);
      return;
    }
    patch({ algorithmLayers: stack.map((layer) => layer.id === selected.id
      ? { ...layer, params: { ...layer.params, ...changes } }
      : layer) });
  };

  const replaceStack = (algorithm: AlgorithmId) => {
    const layer = makeAlgorithmLayer(algorithm);
    patch({ algorithm, algorithmLayers: [layer] });
    setSelectedId(layer.id);
  };
  const append = (algorithm: AlgorithmId) => {
    const layer = makeAlgorithmLayer(algorithm);
    patch({ algorithm, algorithmLayers: [...stack, layer] });
    setSelectedId(layer.id);
  };
  const updateStack = (id: string, change: Partial<(typeof stack)[number]>) =>
    patch({ algorithmLayers: stack.map((layer) => layer.id === id ? { ...layer, ...change } : layer) });
  const move = (id: string, direction: -1 | 1) => {
    const from = stack.findIndex((layer) => layer.id === id);
    const to = from + direction;
    if (to < 0 || to >= stack.length) return;
    const next = [...stack];
    [next[from], next[to]] = [next[to], next[from]];
    patch({ algorithmLayers: next });
  };
  const remove = (id: string) => {
    if (stack.length <= 1) return;
    const next = stack.filter((layer) => layer.id !== id);
    const nextSelected = selected.id === id ? next[next.length - 1] : selected;
    patch({ algorithmLayers: next, algorithm: nextSelected.algorithm });
    setSelectedId(nextSelected.id);
  };

  const resetParams = () => {
    const p: Partial<Settings> = {};
    for (const key of meta.params) {
      for (const k of RESET_KEYS[key]) {
        (p as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
      }
    }
    patchParams(p);
  };

  return (
    <div className="panel panel--dock">
      <header className="panel__header">
        <h2 className="panel__title">{t("algorithm.title")}</h2>
        <p className="panel__subtitle">
          {t("algorithm.count").replace("{n}", String(ALGORITHMS.length))}
        </p>
      </header>

      <div className="panel__scroll">
        {GROUPS.map((g) => (
          <section key={g} className="panel__section">
            <h3 className="panel__section-title">{t(`family.${g}`)}</h3>
            <div className="algo-grid">
              {ALGORITHMS.filter((a) => a.family === g).map((a) => (
                <div className="algo-choice" key={a.id}>
                  <button
                    className={`algo-card ${a.id === selected.algorithm ? "is-selected" : ""}`}
                    aria-label={t("algorithm.useOnly").replace("{name}", a.name)}
                    onClick={() => replaceStack(a.id)}
                  >
                    <span className="algo-card__name">{a.name}</span>
                    <span className="algo-card__blurb">{t(`algo.${a.id}.blurb`)}</span>
                  </button>
                  <IconButton label={t("algorithm.append").replace("{name}", a.name)} onClick={() => append(a.id)}>
                    <IconAdd />
                  </IconButton>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="panel__section">
          <div className="panel__section-head">
            <h3 className="panel__section-title">
              {t("algorithm.controls").replace("{name}", meta.name)}
            </h3>
            <Button variant="text" icon={<IconReset />} onClick={resetParams}>
              {t("common.reset")}
            </Button>
          </div>

          {has("strength") && (
            <Slider
              label={t("param.strength")}
              value={Math.round(controlSettings.strength * 100)}
              min={0}
              max={200}
              display={`${Math.round(controlSettings.strength * 100)}%`}
              onChange={(v) => patchParams({ strength: v / 100 })}
            />
          )}

          {has("errorClamp") && (
            <Slider
              label={t("param.errorClamp")}
              value={controlSettings.errorClamp}
              min={0}
              max={255}
              display={
                controlSettings.errorClamp === 0 ? t("common.off") : String(controlSettings.errorClamp)
              }
              onChange={(v) => patchParams({ errorClamp: v })}
            />
          )}

          {has("jitter") && (
            <Slider
              label={t("param.jitter")}
              value={Math.round(controlSettings.jitter * 100)}
              min={0}
              max={100}
              display={`${Math.round(controlSettings.jitter * 100)}%`}
              onChange={(v) => patchParams({ jitter: v / 100 })}
            />
          )}

          {has("bayerSize") && (
            <div className="panel__field">
              <span className="panel__field-label">{t("param.matrixSize")}</span>
              <Segmented
                ariaLabel={t("param.bayerSizeAria")}
                value={String(controlSettings.bayerSize)}
                onChange={(v) => patchParams({ bayerSize: Number(v) })}
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
              label={t("param.cellSize")}
              value={controlSettings.cellSize}
              min={2}
              max={32}
              display={`${controlSettings.cellSize} px`}
              onChange={(v) => patchParams({ cellSize: v })}
            />
          )}

          {has("screenAngle") && (
            <Slider
              label={t("param.screenAngle")}
              value={controlSettings.screenAngle}
              min={0}
              max={90}
              display={`${controlSettings.screenAngle}°`}
              onChange={(v) => patchParams({ screenAngle: v })}
            />
          )}

          {has("noiseScale") && (
            <Slider
              label={t("param.noiseScale")}
              value={Math.round(controlSettings.noiseScale * 10)}
              min={5}
              max={80}
              display={`${controlSettings.noiseScale.toFixed(1)}×`}
              onChange={(v) => patchParams({ noiseScale: v / 10 })}
            />
          )}

          {has("threshold") && (
            <Slider
              label={t("param.threshold")}
              value={controlSettings.threshold}
              min={0}
              max={255}
              onChange={(v) => patchParams({ threshold: v })}
            />
          )}

          {has("noiseAmount") && (
            <Slider
              label={t("param.noiseAmount")}
              value={Math.round(controlSettings.noiseAmount * 100)}
              min={0}
              max={200}
              display={`${Math.round(controlSettings.noiseAmount * 100)}%`}
              onChange={(v) => patchParams({ noiseAmount: v / 100 })}
            />
          )}

          {has("riemersmaQueue") && (
            <Slider
              label={t("param.queueLength")}
              value={controlSettings.riemersmaQueue}
              min={2}
              max={64}
              display={`${controlSettings.riemersmaQueue} px`}
              onChange={(v) => patchParams({ riemersmaQueue: v })}
            />
          )}

          {has("riemersmaDecay") && (
            <Slider
              label={t("param.queueDecay")}
              value={Math.round(controlSettings.riemersmaDecay * 100)}
              min={5}
              max={99}
              display={controlSettings.riemersmaDecay.toFixed(2)}
              onChange={(v) => patchParams({ riemersmaDecay: v / 100 })}
            />
          )}

          {has("dotClassSize") && (
            <div className="panel__field">
              <span className="panel__field-label">{t("param.classMatrix")}</span>
              <Segmented
                ariaLabel={t("param.classMatrixAria")}
                value={String(controlSettings.dotClassSize)}
                onChange={(v) => patchParams({ dotClassSize: Number(v) })}
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
                <span className="panel__field-label">{t("param.marchDirection")}</span>
                <Segmented
                  ariaLabel={t("param.marchDirection")}
                  value={controlSettings.ominoDirection}
                  onChange={(v) => patchParams({ ominoDirection: v as OminoDirection })}
                  options={DIRECTIONS.map((d) => ({ value: d.value, label: t(d.key) }))}
                />
              </div>
              <Slider
                label={t("param.errorStrength")}
                value={Math.round(controlSettings.ominoErrorStrength * 100)}
                min={0}
                max={400}
                display={`${Math.round(controlSettings.ominoErrorStrength * 100)}%`}
                onChange={(v) => patchParams({ ominoErrorStrength: v / 100 })}
              />
              <Slider
                label={t("param.errorAcross")}
                value={Math.round(controlSettings.ominoAcross * 100)}
                min={0}
                max={150}
                display={`${Math.round(controlSettings.ominoAcross * 100)}%`}
                onChange={(v) => patchParams({ ominoAcross: v / 100 })}
              />
              <Slider
                label={t("param.errorAside")}
                value={Math.round(controlSettings.ominoAside * 100)}
                min={0}
                max={150}
                display={`${Math.round(controlSettings.ominoAside * 100)}%`}
                onChange={(v) => patchParams({ ominoAside: v / 100 })}
              />
              <Slider
                label={t("param.initialPhase")}
                value={controlSettings.ominoPhase}
                min={0}
                max={360}
                display={`${controlSettings.ominoPhase}°`}
                onChange={(v) => patchParams({ ominoPhase: v })}
              />
              <Slider
                label={t("param.colourCount")}
                value={controlSettings.ominoColorCount}
                min={1}
                max={16}
                display={t("param.colourCountOf")
                  .replace("{n}", String(controlSettings.ominoColorCount))
                  .replace("{total}", String(settings.layers.length))}
                onChange={(v) => patchParams({ ominoColorCount: v })}
              />
              <p className="panel__note">{t("omino.note")}</p>
            </>
          )}

          {has("jpegCellSize") && (
            <>
              <Slider
                label={t("param.jpegCellSize")}
                value={controlSettings.jpegCellSize}
                min={2}
                max={128}
                display={`${controlSettings.jpegCellSize}px`}
                onChange={(v) => patchParams({ jpegCellSize: v })}
              />
              <Slider
                label={t("param.jpegDamage")}
                value={Math.round((Math.log10(Math.max(controlSettings.jpegDamage, 0.01)) + 2) * 100)}
                min={0}
                max={800}
                display={controlSettings.jpegDamage < 1 ? controlSettings.jpegDamage.toFixed(2) : `${Math.round(controlSettings.jpegDamage).toLocaleString()}×`}
                onChange={(v) => patchParams({ jpegDamage: Math.pow(10, v / 100 - 2) })}
              />
              <Slider
                label={t("param.jpegErrorRate")}
                value={Math.round(controlSettings.jpegErrorRate * 10)}
                min={0}
                max={80}
                display={`${(controlSettings.jpegErrorRate).toFixed(1)} / cell`}
                onChange={(v) => patchParams({ jpegErrorRate: v / 10 })}
              />
              <Slider
                label={t("param.jpegErrorDensity")}
                value={Math.round(controlSettings.jpegErrorDensity * 100)}
                min={0}
                max={100}
                display={`${Math.round(controlSettings.jpegErrorDensity * 100)}%`}
                onChange={(v) => patchParams({ jpegErrorDensity: v / 100 })}
              />
              <Slider
                label={t("param.jpegErrorAmplitude")}
                value={Math.round(controlSettings.jpegErrorAmplitude * 100)}
                min={0}
                max={400}
                display={`${Math.round(controlSettings.jpegErrorAmplitude * 100)}%`}
                onChange={(v) => patchParams({ jpegErrorAmplitude: v / 100 })}
              />
              <Slider
                label={t("param.jpegErrorCoherence")}
                value={Math.round(controlSettings.jpegErrorCoherence * 100)}
                min={0}
                max={100}
                display={`${Math.round(controlSettings.jpegErrorCoherence * 100)}%`}
                onChange={(v) => patchParams({ jpegErrorCoherence: v / 100 })}
              />
            </>
          )}

          {has("serpentine") && (
            <Switch
              label={t("param.serpentine")}
              checked={controlSettings.serpentine}
              onChange={(v) => patchParams({ serpentine: v })}
            />
          )}

          <p className="panel__note">{t(`algo.${meta.id}.blurb`)}</p>
        </section>
      </div>

      <div className="layerdock algorithm-dock">
        <div className="layerdock__head">
          <h3 className="layerdock__title">{t("algorithm.stack")}</h3>
          <span className="layerdock__count">{stack.length}</span>
        </div>
        <p className="panel__note">{t("algorithm.stackHint")}</p>
        <ol className="layerdock__list">
          {stack.map((layer, index) => {
            const name = ALGORITHMS.find((a) => a.id === layer.algorithm)?.name ?? layer.algorithm;
            return (
              <li key={layer.id} className={`layer algorithm-layer ${layer.enabled ? "" : "is-off"} ${selected.id === layer.id ? "is-selected" : ""}`}>
                <span className="algorithm-layer__index">{index + 1}</span>
                <div className="layer__body">
                  <button className="algorithm-layer__name" onClick={() => { setSelectedId(layer.id); patch({ algorithm: layer.algorithm }); }}>
                    {name}
                  </button>
                  <div className="layer__line">
                    <span className="layer__hex">{t("algorithm.opacity")}</span>
                    <span className="layer__weight">{Math.round(layer.opacity * 100)}%</span>
                  </div>
                  <BareSlider ariaLabel={t("algorithm.opacityFor").replace("{name}", name)} value={Math.round(layer.opacity * 100)} min={0} max={100} onChange={(v) => updateStack(layer.id, { opacity: v / 100 })} />
                </div>
                <div className="layer__ops">
                  <IconButton label={t("algorithm.moveEarlier")} disabled={index === 0} onClick={() => move(layer.id, -1)}><IconArrowUp /></IconButton>
                  <IconButton label={t("algorithm.moveLater")} disabled={index === stack.length - 1} onClick={() => move(layer.id, 1)}><IconArrowDown /></IconButton>
                  <IconButton label={layer.enabled ? t("algorithm.disable") : t("algorithm.enable")} onClick={() => updateStack(layer.id, { enabled: !layer.enabled })}>{layer.enabled ? <IconVisible /> : <IconHidden />}</IconButton>
                  <IconButton label={t("algorithm.remove")} disabled={stack.length <= 1} onClick={() => remove(layer.id)}><IconDelete /></IconButton>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export const AlgorithmPanel = memo(AlgorithmPanelImpl);
