import { useI18n } from "../i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "../dither/color";
import { Button, IconButton } from "./primitives";
import { IconCheck, IconClose } from "./Icons";

/** Adobe-style colour rules, expressed as hue offsets from the base. */
const RULES = {
  analogous: { label: "Analogous", offsets: [-60, -30, 0, 30, 60] },
  monochromatic: { label: "Monochromatic", offsets: [0, 0, 0, 0, 0] },
  triad: { label: "Triad", offsets: [-120, -120, 0, 120, 120] },
  complementary: { label: "Complementary", offsets: [0, 0, 0, 180, 180] },
  "split-complementary": { label: "Split", offsets: [0, 0, 0, 150, 210] },
  "double-split": { label: "Double split", offsets: [-30, 30, 0, 150, 210] },
  square: { label: "Square", offsets: [0, 90, 0, 180, 270] },
  compound: { label: "Compound", offsets: [0, 30, 0, 180, 210] },
  shades: { label: "Shades", offsets: [0, 0, 0, 0, 0] },
} as const;

type RuleId = keyof typeof RULES;

interface Swatch {
  h: number;
  s: number;
  v: number;
}

const wrap = (h: number) => ((h % 360) + 360) % 360;

/** Expands a base colour into the five-swatch set the chosen rule describes. */
function harmony(base: Swatch, rule: RuleId): Swatch[] {
  const { offsets } = RULES[rule];
  if (rule === "monochromatic") {
    const steps = [0.45, 0.7, 1, 0.8, 0.55];
    const sats = [1, 0.9, 1, 0.6, 0.35];
    return steps.map((k, i) => ({
      h: base.h,
      s: Math.min(1, base.s * sats[i]),
      v: Math.min(1, base.v * k + (i > 2 ? 0.1 : 0)),
    }));
  }
  if (rule === "shades") {
    const steps = [0.35, 0.6, 1, 1, 1];
    const sats = [1, 1, 1, 0.75, 0.5];
    return steps.map((k, i) => ({
      h: base.h,
      s: Math.min(1, base.s * sats[i]),
      v: Math.min(1, base.v * k),
    }));
  }
  return offsets.map((o, i) => ({
    h: wrap(base.h + o),
    s: base.s,
    // Nudge the outer pair so a five-up set never reads as three flat colours.
    v: i === 2 ? base.v : Math.min(1, Math.max(0.12, base.v * (i % 2 === 0 ? 0.86 : 1.06))),
  }));
}

const toHex = (c: Swatch) => rgbToHex(hsvToRgb(c.h, c.s, c.v));

interface Props {
  open: boolean;
  /** Colour the picker opens on. */
  value: string;
  onClose: () => void;
  /** Commit a single colour. */
  onPick: (hex: string) => void;
  /** Commit the whole harmony set as layers. */
  onPickSet?: (hexes: string[]) => void;
  /** Source image, enabling the eyedropper strip. */
  source?: ImageData | null;
  title?: string;
}

export function ColorPicker({
  open,
  value,
  onClose,
  onPick,
  onPickSet,
  source,
  title = "Colour",
}: Props) {
  const { t } = useI18n();
  const [color, setColor] = useState<Swatch>(() => {
    const [r, g, b] = hexToRgb(value);
    const [h, s, v] = rgbToHsv(r, g, b);
    return { h, s, v };
  });
  const [rule, setRule] = useState<RuleId>("analogous");
  const [hexDraft, setHexDraft] = useState(value);
  const [picking, setPicking] = useState(false);
  const ringRef = useRef<HTMLDivElement>(null);
  const squareRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"ring" | "square" | null>(null);
  const sampleRef = useRef<HTMLCanvasElement>(null);

  // Re-seed whenever the picker is opened on a different swatch.
  useEffect(() => {
    if (!open) return;
    const [r, g, b] = hexToRgb(value);
    const [h, s, v] = rgbToHsv(r, g, b);
    setColor({ h, s, v });
    setHexDraft(value.toUpperCase());
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const hex = toHex(color);
  const [r, g, b] = hexToRgb(hex);
  const set = useMemo(() => harmony(color, rule), [color, rule]);

  useEffect(() => setHexDraft(hex.toUpperCase()), [hex]);

  const fromRing = useCallback((clientX: number, clientY: number) => {
    const el = ringRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    // Hue zero sits at the top and runs clockwise, matching the conic ring.
    const deg = wrap((Math.atan2(dx, -dy) * 180) / Math.PI);
    setColor((c) => ({ ...c, h: deg }));
  }, []);

  const fromSquare = useCallback((clientX: number, clientY: number) => {
    const el = squareRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const sy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    setColor((c) => ({ ...c, s: sx, v: 1 - sy }));
  }, []);

  useEffect(() => {
    if (!open) return;
    const move = (e: PointerEvent) => {
      if (dragRef.current === "ring") fromRing(e.clientX, e.clientY);
      else if (dragRef.current === "square") fromSquare(e.clientX, e.clientY);
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [open, fromRing, fromSquare]);

  // Paint the eyedropper strip once per source image.
  useEffect(() => {
    const canvas = sampleRef.current;
    if (!canvas || !source || !open) return;
    const maxW = 320;
    const scale = Math.min(1, maxW / source.width);
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    canvas.width = w;
    canvas.height = h;

    const full = document.createElement("canvas");
    full.width = source.width;
    full.height = source.height;
    full.getContext("2d")!.putImageData(source, 0, 0);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(full, 0, 0, w, h);
  }, [source, open]);

  const sample = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = sampleRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height);
    const px = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, 1, 1).data;
    const [hh, ss, vv] = rgbToHsv(px[0], px[1], px[2]);
    setColor({ h: hh, s: ss, v: vv });
    setPicking(false);
  };

  const commitHex = (raw: string) => {
    const clean = raw.trim().replace(/^#/, "");
    if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(clean)) return;
    const [rr, gg, bb] = hexToRgb(`#${clean}`);
    const [hh, ss, vv] = rgbToHsv(rr, gg, bb);
    setColor({ h: hh, s: ss, v: vv });
  };

  const setChannel = (which: "r" | "g" | "b", raw: number) => {
    const v = Math.max(0, Math.min(255, Math.round(raw)));
    const next: [number, number, number] = [r, g, b];
    next[which === "r" ? 0 : which === "g" ? 1 : 2] = v;
    const [hh, ss, vv] = rgbToHsv(next[0], next[1], next[2]);
    setColor({ h: hh, s: ss, v: vv });
  };

  if (!open) return null;

  const ringSize = 268;
  const ringRadius = ringSize / 2 - 17;
  const markerAt = (h: number) => {
    const a = (h * Math.PI) / 180;
    return {
      left: `${ringSize / 2 + Math.sin(a) * ringRadius}px`,
      top: `${ringSize / 2 - Math.cos(a) * ringRadius}px`,
    };
  };

  return (
    <div className="sheet-scrim" onPointerDown={onClose}>
      <div
        className="sheet sheet--picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sheet__header">
          <h2 className="sheet__title">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <IconClose />
          </IconButton>
        </header>

        <div className="picker">
          <div className="picker__wheel" style={{ width: ringSize, height: ringSize }}>
            <div
              ref={ringRef}
              className="picker__ring"
              onPointerDown={(e) => {
                dragRef.current = "ring";
                fromRing(e.clientX, e.clientY);
              }}
            />
            {set.map((c, i) => (
              <span
                key={i}
                className={`picker__marker ${i === 2 ? "is-base" : ""}`}
                style={{ ...markerAt(c.h), background: toHex(c) }}
              />
            ))}
            <div
              ref={squareRef}
              className="picker__square"
              style={{ ["--picker-hue" as string]: `hsl(${color.h} 100% 50%)` }}
              onPointerDown={(e) => {
                dragRef.current = "square";
                fromSquare(e.clientX, e.clientY);
              }}
            >
              <span
                className="picker__thumb"
                style={{
                  left: `${color.s * 100}%`,
                  top: `${(1 - color.v) * 100}%`,
                  background: hex,
                }}
              />
            </div>
          </div>

          <div className="picker__side">
            <div className="picker__preview" style={{ background: hex }}>
              <span style={{ color: color.v > 0.6 ? "#111" : "#fff" }}>{hex.toUpperCase()}</span>
            </div>

            <label className="picker__field">
              <span>Hex</span>
              <input
                value={hexDraft}
                spellCheck={false}
                onChange={(e) => {
                  setHexDraft(e.target.value);
                  commitHex(e.target.value);
                }}
              />
            </label>

            <div className="picker__row">
              {(["r", "g", "b"] as const).map((ch, i) => (
                <label key={ch} className="picker__field picker__field--num">
                  <span>{ch.toUpperCase()}</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={[r, g, b][i]}
                    onChange={(e) => setChannel(ch, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>

            <div className="picker__row">
              <label className="picker__field picker__field--num">
                <span>H</span>
                <input
                  type="number"
                  min={0}
                  max={359}
                  value={Math.round(color.h)}
                  onChange={(e) => setColor((c) => ({ ...c, h: wrap(Number(e.target.value)) }))}
                />
              </label>
              <label className="picker__field picker__field--num">
                <span>S</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(color.s * 100)}
                  onChange={(e) =>
                    setColor((c) => ({ ...c, s: Math.min(1, Math.max(0, Number(e.target.value) / 100)) }))
                  }
                />
              </label>
              <label className="picker__field picker__field--num">
                <span>B</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(color.v * 100)}
                  onChange={(e) =>
                    setColor((c) => ({ ...c, v: Math.min(1, Math.max(0, Number(e.target.value) / 100)) }))
                  }
                />
              </label>
            </div>

            {source && (
              <div className="picker__eyedrop">
                <button
                  className={`picker__eyebtn ${picking ? "is-active" : ""}`}
                  onClick={() => setPicking((p) => !p)}
                >
                  {picking ? "Click the image…" : "Eyedrop from image"}
                </button>
                <canvas
                  ref={sampleRef}
                  className={`picker__sample ${picking ? "is-armed" : ""}`}
                  onClick={sample}
                />
              </div>
            )}
          </div>
        </div>

        <div className="picker__rules">
          {(Object.keys(RULES) as RuleId[]).map((id) => (
            <button
              key={id}
              className={`picker__rule ${id === rule ? "is-selected" : ""}`}
              onClick={() => setRule(id)}
            >
              {t("picker." + (id === "split-complementary" ? "split" : id === "double-split" ? "doubleSplit" : id)) || RULES[id].label}
            </button>
          ))}
        </div>

        <div className="picker__set">
          {set.map((c, i) => {
            const h = toHex(c);
            return (
              <button
                key={i}
                className="picker__setswatch"
                style={{ background: h }}
                title={h.toUpperCase()}
                onClick={() => setColor(c)}
              >
                <span>{h.toUpperCase()}</span>
              </button>
            );
          })}
        </div>

        <footer className="sheet__foot">
          {onPickSet && (
            <Button variant="outlined" onClick={() => onPickSet(set.map(toHex))}>
              Add all five
            </Button>
          )}
          <Button variant="filled" icon={<IconCheck />} onClick={() => onPick(hex)}>
            {t("picker.useColour")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
