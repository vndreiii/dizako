import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { extractPalette } from "../dither/extract";
import {
  appendColour,
  dropLayer,
  MAX_COLOURS,
  MIN_COLOURS,
  nextColour,
  randomStack,
  respread,
  shiftLayer,
  starterLayers,
} from "../dither/paletteOps";
import { layersFromColors, makeLayer, type PaletteLayer, type Settings } from "../dither/types";
import { useI18n } from "../i18n";
import { ColorEditor } from "./ColorPicker";
import { BareSlider, Button, IconButton } from "./primitives";
import {
  IconAdd,
  IconBack,
  IconCasino,
  IconCheck,
  IconClose,
  IconDelete,
  IconForward,
  IconHidden,
  IconImage,
  IconReset,
  IconSwapVert,
  IconVisible,
} from "./Icons";

interface Props {
  settings: Settings;
  patch: (p: Partial<Settings>) => void;
  /** Feeds "from image" and the colour editor's picker. */
  source?: ImageData | null;
  onClose: () => void;
  /** Swatch to open straight into the editor on; `fresh` when it was just added. */
  initial?: { id: string; fresh: boolean } | null;
}

const luminance = (hex: string) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/**
 * The palette as a handful of big swatches in a floating card.
 *
 * Shadows sit on the left and highlights on the right, matching the way the
 * stack is stored, so reading the strip is reading the tonal range. Every edit
 * is applied live - the image behind the card is the preview - and a single
 * swatch can be opened in the colour editor without touching the others.
 */
export function PaletteStudio({ settings, patch, source, onClose, initial = null }: Props) {
  const { t } = useI18n();
  const layers = settings.layers;
  const [selected, setSelected] = useState<string | null>(initial?.id ?? layers[0]?.id ?? null);
  /**
   * The swatch open in the colour editor, with what a cancel puts back: its
   * old colour, or removal of the swatch if it was only just added.
   */
  const [edit, setEdit] = useState<{ id: string; hex: string; fresh: boolean } | null>(() => {
    const first = layers.find((l) => l.id === initial?.id);
    // A freshly added swatch opens already holding its colour, which is what a
    // cancel must remove it for - so `hex` is only used when it is not fresh.
    return first ? { id: first.id, hex: first.hex, fresh: initial?.fresh ?? false } : null;
  });
  const editing = edit?.id ?? null;

  // Always read the newest stack inside callbacks that outlive a render.
  const latest = useRef(layers);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern for editor callbacks
  latest.current = layers;

  const setLayers = useCallback((next: PaletteLayer[]) => patch({ layers: next }), [patch]);
  const update = (id: string, change: Partial<PaletteLayer>) =>
    setLayers(latest.current.map((l) => (l.id === id ? { ...l, ...change } : l)));

  const selectedLayer = layers.find((l) => l.id === selected) ?? null;
  const editingLayer = layers.find((l) => l.id === editing) ?? null;

  useEffect(() => {
    // A removed layer cannot stay selected.
    if (selected && !layers.some((l) => l.id === selected)) setSelected(layers[0]?.id ?? null);
    if (editing && !layers.some((l) => l.id === editing)) setEdit(null);
  }, [layers, selected, editing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The editor owns Escape while it is open.
      if (e.key === "Escape" && !editing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);

  const openEditor = (layer: PaletteLayer, fresh = false) => {
    setSelected(layer.id);
    setEdit({ id: layer.id, hex: layer.hex, fresh });
  };

  const addColour = () => {
    if (layers.length >= MAX_COLOURS) return;
    const next = appendColour(layers, nextColour(layers));
    setLayers(next);
    const added = next[next.length - 1]!;
    openEditor(added, true);
  };

  const cancelEdit = useCallback(() => {
    setEdit((current) => {
      if (current) {
        if (current.fresh) setLayers(dropLayer(latest.current, current.id));
        else setLayers(latest.current.map((l) => (l.id === current.id ? { ...l, hex: current.hex } : l)));
      }
      return null;
    });
  }, [setLayers]);

  const applyEdit = useCallback(
    (hex: string) => {
      setEdit((current) => {
        if (current) setLayers(latest.current.map((l) => (l.id === current.id ? { ...l, hex } : l)));
        return null;
      });
    },
    [setLayers],
  );

  const liveEdit = useCallback(
    (hex: string) => {
      if (!editing) return;
      setLayers(latest.current.map((l) => (l.id === editing ? { ...l, hex } : l)));
    },
    [setLayers, editing],
  );

  const fromImage = () => {
    if (!source) return;
    const colours = extractPalette(source.data, source.width, source.height, { count: Math.max(layers.length, 4) });
    setLayers(layersFromColors(colours));
    setSelected(null);
  };

  const flip = () => setLayers(respread([...layers].reverse()));
  const randomise = () => {
    const hexes = randomStack(layers.length);
    setLayers(layers.map((l, i) => ({ ...l, hex: hexes[i]! })));
  };

  const body = (
    <div className="studio-layer" onPointerDown={onClose}>
      <div className="studio-wrap" onPointerDown={(e) => e.stopPropagation()}>
        <section className="pstudio" role="dialog" aria-label={t("studio.title")}>
          <header className="pstudio__head">
            <div>
              <h2 className="pstudio__title">{t("studio.title")}</h2>
              <p className="pstudio__sub">
                {t("studio.count").replace("{n}", String(layers.length))}
              </p>
            </div>
            <IconButton label={t("studio.done")} onClick={onClose}>
              <IconClose />
            </IconButton>
          </header>

          <div className="pstudio__ends" aria-hidden="true">
            <span>{t("palette.shadows")}</span>
            <span>{t("palette.highlights")}</span>
          </div>

          <ul className="pstudio__strip" aria-label={t("studio.swatches")}>
            {layers.map((l) => (
              <li key={l.id} className="pstudio__item">
                <button
                  className={`pstudio__swatch ${l.id === selected ? "is-selected" : ""} ${l.enabled ? "" : "is-off"}`}
                  style={{ background: l.hex, color: luminance(l.hex) > 0.6 ? "#101010" : "#fff" }}
                  aria-pressed={l.id === selected}
                  aria-label={t("palette.editHex").replace("{hex}", l.hex)}
                  onClick={() => (l.id === selected ? openEditor(l) : setSelected(l.id))}
                  onDoubleClick={() => openEditor(l)}
                >
                  <span className="pstudio__hex">{l.hex.toUpperCase()}</span>
                  {!l.enabled && <span className="pstudio__off">{t("studio.hidden")}</span>}
                </button>
              </li>
            ))}
            {layers.length < MAX_COLOURS && (
              <li className="pstudio__item">
                <button className="pstudio__add" onClick={addColour} aria-label={t("palette.addColour")}>
                  <IconAdd />
                </button>
              </li>
            )}
          </ul>

          {selectedLayer ? (
            <div className="pstudio__detail">
              <div className="pstudio__detailhead">
                <span className="pstudio__chip" style={{ background: selectedLayer.hex }} />
                <span className="pstudio__detailhex">{selectedLayer.hex.toUpperCase()}</span>
                <span className="pstudio__spacer" />
                <Button variant="tonal" onClick={() => openEditor(selectedLayer)}>
                  {t("studio.editColour")}
                </Button>
              </div>

              <div className="pstudio__weight">
                <span>{t("studio.weight")}</span>
                <BareSlider
                  value={selectedLayer.width}
                  min={0.25}
                  max={8}
                  step={0.25}
                  ariaLabel={t("palette.weightFor").replace("{hex}", selectedLayer.hex)}
                  onChange={(v) => update(selectedLayer.id, { width: v })}
                />
                <span className="pstudio__weightval">{selectedLayer.width.toFixed(2)}×</span>
              </div>

              <div className="pstudio__ops">
                <IconButton
                  label={t("studio.moveShadows")}
                  disabled={layers[0]?.id === selectedLayer.id}
                  onClick={() => setLayers(shiftLayer(layers, selectedLayer.id, -1))}
                >
                  <IconBack />
                </IconButton>
                <IconButton
                  label={t("studio.moveHighlights")}
                  disabled={layers[layers.length - 1]?.id === selectedLayer.id}
                  onClick={() => setLayers(shiftLayer(layers, selectedLayer.id, 1))}
                >
                  <IconForward />
                </IconButton>
                <IconButton
                  label={selectedLayer.enabled ? t("palette.disableLayer") : t("palette.enableLayer")}
                  onClick={() => update(selectedLayer.id, { enabled: !selectedLayer.enabled })}
                >
                  {selectedLayer.enabled ? <IconVisible /> : <IconHidden />}
                </IconButton>
                <IconButton
                  label={t("palette.removeLayer")}
                  disabled={layers.length <= MIN_COLOURS}
                  onClick={() => setLayers(dropLayer(layers, selectedLayer.id))}
                >
                  <IconDelete />
                </IconButton>
              </div>
            </div>
          ) : (
            <p className="pstudio__hint">{t("studio.pickOne")}</p>
          )}

          <footer className="pstudio__foot">
            <div className="pstudio__tools">
              <IconButton label={t("palette.flipStack")} onClick={flip}>
                <IconSwapVert />
              </IconButton>
              <IconButton label={t("palette.randomise")} onClick={randomise}>
                <IconCasino />
              </IconButton>
              <IconButton label={t("studio.fromImage")} disabled={!source} onClick={fromImage}>
                <IconImage />
              </IconButton>
              <IconButton
                label={t("studio.startOver")}
                onClick={() => {
                  setLayers(starterLayers());
                  setSelected(null);
                }}
              >
                <IconReset />
              </IconButton>
            </div>
            <Button variant="filled" icon={<IconCheck />} onClick={onClose}>
              {t("studio.done")}
            </Button>
          </footer>
        </section>

        {editingLayer && (
          <ColorEditor
            key={editingLayer.id}
            value={edit?.hex ?? editingLayer.hex}
            title={t("palette.editLayer")}
            source={source}
            onChange={liveEdit}
            onApply={applyEdit}
            onCancel={cancelEdit}
            onAddSet={(hexes) => {
              // The harmony joins the stack; the colour being edited stays put.
              const added = hexes.map((h) => makeLayer(h, 0.5));
              setLayers(respread([...latest.current, ...added].slice(0, MAX_COLOURS)));
              setEdit(null);
            }}
          />
        )}
      </div>
    </div>
  );

  return createPortal(body, document.body);
}
