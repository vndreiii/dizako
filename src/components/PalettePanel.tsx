import { useMemo, useState } from "react";
import { PALETTE_GROUPS } from "../dither/palettes";
import {
  layersFromColors,
  makeLayer,
  type MatchMode,
  type PaletteLayer,
  type Settings,
} from "../dither/types";
import { hsvToRgb, rgbToHex } from "../dither/color";
import { ColorPicker } from "./ColorPicker";
import { IconButton, Segmented, Slider } from "./primitives";
import {
  IconAdd,
  IconArrowDown,
  IconArrowUp,
  IconCasino,
  IconDelete,
  IconHidden,
  IconHighlights,
  IconShadows,
  IconSwapVert,
  IconVisible,
} from "./Icons";

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  /** Feeds the picker's eyedropper. */
  source?: ImageData | null;
}

const MATCH_MODES: Array<{ value: MatchMode; label: string }> = [
  { value: "rgb", label: "RGB" },
  { value: "luma", label: "Luma" },
  { value: "oklab", label: "OKLab" },
  { value: "tonal", label: "Tonal" },
];

/**
 * Re-spaces tonal levels across the stack.
 *
 * Layers are stored shadows-first. After any reorder the levels are spread
 * evenly again so position in the list *is* the tonal band the layer owns -
 * which is what makes dragging a colour upward actually move it into the
 * highlights.
 */
function respread(layers: PaletteLayer[]): PaletteLayer[] {
  const n = layers.length;
  return layers.map((l, i) => ({ ...l, level: n <= 1 ? 0.5 : i / (n - 1) }));
}

/**
 * Fresh colours for the existing stack.
 *
 * Not uniform noise: the hues stay inside one wandering range and the value
 * climbs with the layer's position, so the result is a usable ramp from shadows
 * to highlights rather than a bag of unrelated colours that dithers to mud.
 */
function randomStack(n: number): string[] {
  const base = Math.random() * 360;
  const spread = 30 + Math.random() * 140;
  const sat = 0.25 + Math.random() * 0.6;
  return Array.from({ length: n }, (_, i) => {
    const t = n <= 1 ? 0.5 : i / (n - 1);
    const h = (base + spread * (t - 0.5) + 360) % 360;
    const v = 0.08 + t * 0.88;
    // Saturation eases off at both ends so the darkest and lightest steps read
    // as shadow and highlight instead of two more saturated hues.
    const s = sat * (1 - Math.abs(t - 0.5) * 1.2);
    return rgbToHex(hsvToRgb(h, Math.max(0, s), v));
  });
}

export function PalettePanel({ settings, patch, source }: Props) {
  const layers = settings.layers;
  const [editing, setEditing] = useState<string | "new" | null>(null);

  // {t("palette.layersHint")}
  const display = useMemo(() => [...layers].reverse(), [layers]);

  const setLayers = (next: PaletteLayer[]) => patch({ layers: respread(next) });

  const update = (id: string, p: Partial<PaletteLayer>) =>
    patch({ layers: layers.map((l) => (l.id === id ? { ...l, ...p } : l)) });

  /** `dir` is in display terms: -1 is toward the highlights. */
  const move = (id: string, dir: -1 | 1) => {
    const i = layers.findIndex((l) => l.id === id);
    const j = i - dir;
    if (i < 0 || j < 0 || j >= layers.length) return;
    const next = [...layers];
    [next[i], next[j]] = [next[j], next[i]];
    setLayers(next);
  };

  const remove = (id: string) => {
    if (layers.length <= 2) return;
    setLayers(layers.filter((l) => l.id !== id));
  };

  const editingLayer = editing && editing !== "new" ? layers.find((l) => l.id === editing) : null;

  return (
    <div className="panel panel--dock">
      <header className="panel__header">
        <h2 className="panel__title">Palette</h2>
        <p className="panel__subtitle">
          {PALETTE_GROUPS.reduce((n, g) => n + g.palettes.length, 0)} presets
        </p>
      </header>

      <div className="panel__scroll">
        <section className="panel__section">
          <h3 className="panel__section-title">{t("palette.matching")}</h3>
          <Segmented
            ariaLabel="Colour matching mode"
            value={settings.matchMode}
            onChange={(v) => patch({ matchMode: v as MatchMode })}
            options={MATCH_MODES}
          />
          <p className="panel__note">
            {settings.matchMode === "rgb" && "Nearest colour by weighted RGB distance."}
            {settings.matchMode === "luma" && "Matches on brightness alone - colour is ignored."}
            {settings.matchMode === "oklab" && "{t("palette.matchingHint")}"}
            {settings.matchMode === "tonal" &&
              "Each layer owns a slice of the tonal range, sized by its weight. Position in the stack decides everything."}
          </p>
          {settings.matchMode !== "tonal" && (
            <>
              <Slider
                label="Stack influence"
                value={Math.round(settings.tonalBias * 100)}
                min={0}
                max={100}
                display={
                  settings.tonalBias === 0
                    ? "off - nearest colour"
                    : `${Math.round(settings.tonalBias * 100)}%`
                }
                onChange={(v) => patch({ tonalBias: v / 100 })}
              />
              <p className="panel__note">
                How much a layer&apos;s place in the stack outweighs plain nearest-colour matching.
                At zero the arrangement is decorative - the same two colours land on the same pixels
                however you stack them. Turn it up and a colour parked at the bottom actually claims
                the shadows.
              </p>
            </>
          )}
        </section>

        <section className="panel__section">
          <h3 className="panel__section-title">{t("palette.yourOwn")}</h3>
          <div className="lib-grid">
            <button
              className="lib-card__blank"
              onClick={() => {
                // Start from a clean two-colour stack rather than whatever was
                // loaded, so "make your own" is not "edit the last preset".
                patch({ layers: layersFromColors(["#000000", "#FFFFFF"]) });
                setEditing("new");
              }}
              title="Start a palette from scratch"
            >
              <span className="lib-card__blank-plus" aria-hidden="true">
                +
              </span>
              <span className="lib-card__name">Make your own</span>
            </button>
          </div>
        </section>

        {PALETTE_GROUPS.map((group) => (
          <section key={group.group} className="panel__section">
            <h3 className="panel__section-title">{group.group}</h3>
            <div className="lib-grid">
              {group.palettes.map((p) => (
                <div key={p.name} className="lib-card">
                  <button
                    className="lib-card__main"
                    onClick={() => patch({ layers: layersFromColors(p.colors) })}
                    title={`Send ${p.name} to the layer stack`}
                  >
                    <span className="lib-card__strip">
                      {p.colors.slice(0, 16).map((c, i) => (
                        <span key={i} style={{ background: c }} />
                      ))}
                    </span>
                    <span className="lib-card__name">{p.name}</span>
                    <span className="lib-card__count">{p.colors.length}</span>
                  </button>
                  <IconButton
                    label={`Append ${p.name} to the stack`}
                    onClick={() =>
                      setLayers([...layers, ...p.colors.map((c) => makeLayer(c, 0.5))])
                    }
                  >
                    <IconAdd />
                  </IconButton>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Pinned: the stack stays reachable no matter how far the library scrolls. */}
      <div className="layerdock">
        <div className="layerdock__head">
          <h3 className="layerdock__title">{t("palette.layers")}</h3>
          <span className="layerdock__count">{layers.length}</span>
          <span className="layerdock__spacer" />
          <IconButton
            label="Flip the stack - shadows become highlights"
            onClick={() => setLayers([...layers].reverse())}
          >
            <IconSwapVert />
          </IconButton>
          <IconButton
            label="Randomise the stack colours"
            onClick={() => {
              // One draw for the whole stack - calling it per layer would pick a
              // new base hue each time and hand back an incoherent set.
              const hexes = randomStack(layers.length);
              patch({ layers: layers.map((l, i) => ({ ...l, hex: hexes[i] })) });
            }}
          >
            <IconCasino />
          </IconButton>
          <IconButton label="Add a colour" onClick={() => setEditing("new")}>
            <IconAdd />
          </IconButton>
        </div>

        {/* Top of the list is the highlight end, bottom is the shadow end. The
            markers sit at those ends rather than side by side, so which way the
            arrows move a layer needs no explaining. */}
        <div className="layerdock__edge">
          <IconHighlights />
          <span>{t("palette.highlights")}</span>
        </div>

        <ul className="layerdock__list">
          {display.map((l, i) => (
            <li key={l.id} className={`layer ${l.enabled ? "" : "is-off"}`}>
              <button
                className="layer__swatch"
                style={{ background: l.hex }}
                onClick={() => setEditing(l.id)}
                title={`Edit ${l.hex}`}
              />
              <div className="layer__body">
                <div className="layer__line">
                  <span className="layer__hex">{l.hex.toUpperCase()}</span>
                  <span className="layer__weight">{l.width.toFixed(2)}×</span>
                </div>
                <input
                  className="layer__width"
                  type="range"
                  min={0.25}
                  max={8}
                  step={0.25}
                  value={l.width}
                  aria-label={`Weight for ${l.hex}`}
                  onChange={(e) => update(l.id, { width: Number(e.target.value) })}
                />
              </div>
              <div className="layer__ops">
                <IconButton
                  label="Move toward highlights"
                  disabled={i === 0}
                  onClick={() => move(l.id, -1)}
                >
                  <IconArrowUp />
                </IconButton>
                <IconButton
                  label="Move toward shadows"
                  disabled={i === display.length - 1}
                  onClick={() => move(l.id, 1)}
                >
                  <IconArrowDown />
                </IconButton>
                <IconButton
                  label={l.enabled ? "Disable layer" : "Enable layer"}
                  onClick={() => update(l.id, { enabled: !l.enabled })}
                >
                  {l.enabled ? <IconVisible /> : <IconHidden />}
                </IconButton>
                <IconButton
                  label="Remove layer"
                  disabled={layers.length <= 2}
                  onClick={() => remove(l.id)}
                >
                  <IconDelete />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>

        <div className="layerdock__edge layerdock__edge--low">
          <IconShadows />
          <span>{t("palette.shadows")}</span>
        </div>
      </div>

      <ColorPicker
        open={editing !== null}
        title={editing === "new" ? "Add a colour" : "Edit layer"}
        value={editingLayer?.hex ?? "#7C4DFF"}
        source={source}
        onClose={() => setEditing(null)}
        onPick={(hex) => {
          if (editing === "new") setLayers([...layers, makeLayer(hex, 1)]);
          else if (editing) update(editing, { hex });
          setEditing(null);
        }}
        onPickSet={(hexes) => {
          setLayers([...layers, ...hexes.map((h) => makeLayer(h, 0.5))]);
          setEditing(null);
        }}
      />
    </div>
  );
}
