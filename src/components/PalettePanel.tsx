import { useI18n } from "../i18n";
import { useMemo, useState, memo } from "react";
import { PALETTE_GROUPS } from "../dither/palettes";
import {
  layersFromColors,
  makeLayer,
  type MatchMode,
  type PaletteLayer,
  type Settings,
} from "../dither/types";
import { extractPalette } from "../dither/extract";
import {
  appendColour,
  dropLayer,
  nextColour,
  randomStack,
  respread,
  shiftLayer,
  starterLayers,
} from "../dither/paletteOps";
import { PaletteStudio } from "./PaletteStudio";
import { SearchBar } from "./fields";
import { BareSlider, Button, IconButton, Segmented, Slider } from "./primitives";
import {
  IconAdd,
  IconArrowDown,
  IconArrowUp,
  IconCasino,
  IconDelete,
  IconHidden,
  IconHighlights,
  IconPalette,
  IconReset,
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

/** How many colours "reset to image colours" can ask for. */
const IMAGE_COUNTS = ["3", "4", "6", "8", "12", "16"];

function PalettePanelImpl({ settings, patch, source }: Props) { const { t } = useI18n();
  const layers = settings.layers;
  /** The studio overlay, optionally opened straight onto one swatch. */
  const [studio, setStudio] = useState<{ id: string; fresh: boolean } | "open" | null>(null);
  const [imageCount, setImageCount] = useState("6");
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  /** Presets matching the search, by name or group; all of them when it is empty. */
  const groups = useMemo(
    () =>
      PALETTE_GROUPS.map((group) => ({
        ...group,
        palettes: needle
          ? group.palettes.filter(
              (p) => p.name.toLowerCase().includes(needle) || group.group.toLowerCase().includes(needle),
            )
          : group.palettes,
      })).filter((group) => group.palettes.length > 0),
    [needle],
  );
  const matchCount = groups.reduce((n, g) => n + g.palettes.length, 0);

  // {t("palette.layersHint")}
  const display = useMemo(() => [...layers].reverse(), [layers]);

  const setLayers = (next: PaletteLayer[]) => patch({ layers: respread(next) });

  const update = (id: string, p: Partial<PaletteLayer>) =>
    patch({ layers: layers.map((l) => (l.id === id ? { ...l, ...p } : l)) });

  /** `dir` is in display terms: -1 is toward the highlights. */
  const move = (id: string, dir: -1 | 1) => patch({ layers: shiftLayer(layers, id, (-dir) as -1 | 1) });

  const remove = (id: string) => patch({ layers: dropLayer(layers, id) });

  /** The colours the image is made of, for "reset to image colours". */
  const imageColours = useMemo(
    () => (source ? extractPalette(source.data, source.width, source.height, { count: Number(imageCount) }) : null),
    [source, imageCount],
  );

  return (
    <div className="panel panel--dock">
      <header className="panel__header">
        <h2 className="panel__title">{t("palette.title")}</h2>
        <p className="panel__subtitle">
          {t("palette.presetsCount").replace(
            "{n}",
            String(PALETTE_GROUPS.reduce((n, g) => n + g.palettes.length, 0)),
          )}
        </p>
      </header>

      <div className="panel__scroll">
        <div className="panel__search">
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder={t("palette.search")}
            clearLabel={t("common.clearSearch")}
          />
        </div>

        {needle && matchCount === 0 && (
          <p className="panel__empty">{t("common.noMatches").replace("{q}", query.trim())}</p>
        )}

        {!needle && (
        <section className="panel__section">
          <h3 className="panel__section-title">{t("palette.matching")}</h3>
          <Segmented
            ariaLabel="Colour matching mode"
            value={settings.matchMode}
            onChange={(v) => patch({ matchMode: v as MatchMode })}
            options={MATCH_MODES}
          />
          <p className="panel__note">
            {settings.matchMode === "rgb" && t("palette.matchRgb")}
            {settings.matchMode === "luma" && t("palette.matchLuma")}
            {settings.matchMode === "oklab" && t("palette.matchingHint")}
            {settings.matchMode === "tonal" && t("palette.matchTonal")}
          </p>
          {settings.matchMode !== "tonal" && (
            <>
              <Slider
                label={t("palette.stackInfluence")}
                value={Math.round(settings.tonalBias * 100)}
                min={0}
                max={100}
                display={
                  settings.tonalBias === 0
                    ? t("palette.influenceOff")
                    : `${Math.round(settings.tonalBias * 100)}%`
                }
                onChange={(v) => patch({ tonalBias: v / 100 })}
              />
              <p className="panel__note">
                {t("palette.stackInfluenceNote")}
              </p>
            </>
          )}
        </section>

        )}

        {!needle && (
        <>
        <section className="panel__section">
          <h3 className="panel__section-title">{t("palette.fromImage")}</h3>
          <div className="imgpal">
            <div className="imgpal__strip" aria-hidden="true">
              {imageColours
                ? imageColours.map((c, i) => <span key={i} style={{ background: c }} title={c} />)
                : <span className="imgpal__empty">{t("palette.fromImageEmpty")}</span>}
            </div>
            <Segmented
              ariaLabel={t("palette.fromImageCount")}
              value={imageCount}
              onChange={setImageCount}
              options={IMAGE_COUNTS.map((n) => ({ value: n, label: n }))}
            />
            <div className="imgpal__actions">
              <Button
                variant="tonal"
                icon={<IconReset />}
                disabled={!imageColours}
                onClick={() => imageColours && patch({ layers: layersFromColors(imageColours) })}
              >
                {t("palette.resetToImage")}
              </Button>
              <Button
                variant="text"
                onClick={() => patch({ layers: layersFromColors(["#000000", "#FFFFFF"]) })}
              >
                {t("palette.resetDefault")}
              </Button>
            </div>
            <p className="panel__note">{t("palette.fromImageNote")}</p>
          </div>
        </section>

        <section className="panel__section">
          <h3 className="panel__section-title">{t("palette.yourOwn")}</h3>
          <div className="lib-grid">
            <button
              className="lib-card__blank"
              onClick={() => {
                // Start from a fresh five-colour stack rather than whatever was
                // loaded, so "make your own" is not "edit the last preset".
                patch({ layers: starterLayers() });
                setStudio("open");
              }}
              title={t("palette.startScratch")}
            >
              <span className="lib-card__blank-plus" aria-hidden="true">
                +
              </span>
              <span className="lib-card__name">{t("palette.makeYourOwn")}</span>
            </button>
          </div>
        </section>
        </>
        )}

        {groups.map((group) => (
          <section key={group.group} className="panel__section">
            <h3 className="panel__section-title">{group.group}</h3>
            <div className="lib-grid">
              {group.palettes.map((p) => (
                <div key={p.name} className="lib-card">
                  <button
                    className="lib-card__main"
                    onClick={() => patch({ layers: layersFromColors(p.colors) })}
                    title={t("palette.sendToStack").replace("{name}", p.name)}
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
                    label={t("palette.append").replace("{name}", p.name)}
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
            label={t("palette.flipStack")}
            onClick={() => setLayers([...layers].reverse())}
          >
            <IconSwapVert />
          </IconButton>
          <IconButton
            label={t("palette.randomise")}
            onClick={() => {
              // One draw for the whole stack - calling it per layer would pick a
              // new base hue each time and hand back an incoherent set.
              const hexes = randomStack(layers.length);
              patch({ layers: layers.map((l, i) => ({ ...l, hex: hexes[i] })) });
            }}
          >
            <IconCasino />
          </IconButton>
          <IconButton label={t("studio.title")} onClick={() => setStudio("open")}>
            <IconPalette />
          </IconButton>
          <IconButton
            label={t("palette.addColour")}
            onClick={() => {
              const next = appendColour(layers, nextColour(layers));
              if (next === layers) return;
              patch({ layers: next });
              setStudio({ id: next[next.length - 1]!.id, fresh: true });
            }}
          >
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
                onClick={() => setStudio({ id: l.id, fresh: false })}
                title={t("palette.editHex").replace("{hex}", l.hex)}
              />
              <div className="layer__body">
                <div className="layer__line">
                  <span className="layer__hex">{l.hex.toUpperCase()}</span>
                  <span className="layer__weight">{l.width.toFixed(2)}×</span>
                </div>
                <BareSlider
                  className="layer__width"
                  value={l.width}
                  min={0.25}
                  max={8}
                  step={0.25}
                  ariaLabel={t("palette.weightFor").replace("{hex}", l.hex)}
                  onChange={(v) => update(l.id, { width: v })}
                />
              </div>
              <div className="layer__ops">
                <IconButton
                  label={t("palette.moveHighlights")}
                  disabled={i === 0}
                  onClick={() => move(l.id, -1)}
                >
                  <IconArrowUp />
                </IconButton>
                <IconButton
                  label={t("palette.moveShadows")}
                  disabled={i === display.length - 1}
                  onClick={() => move(l.id, 1)}
                >
                  <IconArrowDown />
                </IconButton>
                <IconButton
                  label={l.enabled ? t("palette.disableLayer") : t("palette.enableLayer")}
                  onClick={() => update(l.id, { enabled: !l.enabled })}
                >
                  {l.enabled ? <IconVisible /> : <IconHidden />}
                </IconButton>
                <IconButton
                  label={t("palette.removeLayer")}
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

      {studio && (
        <PaletteStudio
          settings={settings}
          patch={patch}
          source={source}
          initial={studio === "open" ? null : studio}
          onClose={() => setStudio(null)}
        />
      )}
    </div>
  );
}

export const PalettePanel = memo(PalettePanelImpl);
