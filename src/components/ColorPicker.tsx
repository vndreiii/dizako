import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "../dither/color";
import { useI18n } from "../i18n";
import { ImageSampler } from "./ImageSampler";
import { Button, IconButton, Segmented } from "./primitives";
import { IconAdd, IconCheck, IconClose, IconEyedropper } from "./Icons";

/** Adobe-style colour rules, expressed as hue offsets from the base. */
const RULES = {
  analogous: [-60, -30, 0, 30, 60],
  monochromatic: [0, 0, 0, 0, 0],
  triad: [-120, -120, 0, 120, 120],
  complementary: [0, 0, 0, 180, 180],
  split: [0, 0, 0, 150, 210],
  doubleSplit: [-30, 30, 0, 150, 210],
  square: [0, 90, 0, 180, 270],
  compound: [0, 30, 0, 180, 210],
  shades: [0, 0, 0, 0, 0],
} as const;

type RuleId = keyof typeof RULES;

interface Swatch {
  h: number;
  s: number;
  v: number;
}

const wrap = (h: number) => ((h % 360) + 360) % 360;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toHex = (c: Swatch) => rgbToHex(hsvToRgb(c.h, c.s, c.v));
const fromHex = (hex: string): Swatch => {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, v] = rgbToHsv(r, g, b);
  return { h, s, v };
};

/** Expands a base colour into the five-swatch set the chosen rule describes. */
function harmony(base: Swatch, rule: RuleId): Swatch[] {
  if (rule === "monochromatic") {
    const steps = [0.45, 0.7, 1, 0.8, 0.55];
    const sats = [1, 0.9, 1, 0.6, 0.35];
    return steps.map((k, i) => ({
      h: base.h,
      s: Math.min(1, base.s * sats[i]!),
      v: Math.min(1, base.v * k + (i > 2 ? 0.1 : 0)),
    }));
  }
  if (rule === "shades") {
    const steps = [0.35, 0.6, 1, 1, 1];
    const sats = [1, 1, 1, 0.75, 0.5];
    return steps.map((k, i) => ({ h: base.h, s: Math.min(1, base.s * sats[i]!), v: Math.min(1, base.v * k) }));
  }
  return RULES[rule].map((o, i) => ({
    h: wrap(base.h + o),
    s: base.s,
    // Nudge the outer pair so a five-up set never reads as three flat colours.
    v: i === 2 ? base.v : Math.min(1, Math.max(0.12, base.v * (i % 2 === 0 ? 0.86 : 1.06))),
  }));
}

type Fields = "hex" | "rgb" | "hsb";

/**
 * A surface that reports 0..1 pointer positions while dragged.
 *
 * Pointer capture keeps the drag alive when the pointer leaves the element, so
 * no window-level listeners are needed and a drag can never get stuck.
 */
function DragSurface({
  onMove,
  className,
  style,
  children,
  ...aria
}: {
  onMove: (x: number, y: number) => void;
  className: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const report = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onMove(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
  };
  return (
    <div
      {...aria}
      ref={ref}
      className={className}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        report(e);
      }}
      onPointerMove={(e) => {
        if (dragging.current) report(e);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // Already released by the browser.
        }
      }}
    >
      {children}
    </div>
  );
}

interface EditorProps {
  /** Colour the editor opens on; also what Cancel returns to. */
  value: string;
  title?: string;
  /** Enables picking from the image. */
  source?: ImageData | null;
  /** Fires on every change, for live preview behind the editor. */
  onChange: (hex: string) => void;
  onApply: (hex: string) => void;
  onCancel: () => void;
  /** Adds the whole five-colour harmony to the palette. */
  onAddSet?: (hexes: string[]) => void;
}

/**
 * The colour editor: a saturation/brightness field, a hue bar, numeric fields
 * in the model of your choice, harmony suggestions and a picker that reads
 * straight from the image.
 *
 * It is a card, not a page: it is meant to sit beside the thing being edited
 * so the effect of a change is visible while it is being made.
 */
export function ColorEditor({ value, title, source, onChange, onApply, onCancel, onAddSet }: EditorProps) {
  const { t } = useI18n();
  const [color, setColor] = useState<Swatch>(() => fromHex(value));
  const [fields, setFields] = useState<Fields>("hex");
  const [rule, setRule] = useState<RuleId>("analogous");
  const [sampling, setSampling] = useState(false);
  const [hexDraft, setHexDraft] = useState(value.toUpperCase());
  const cardRef = useRef<HTMLDivElement>(null);

  const hex = toHex(color);
  const [r, g, b] = hexToRgb(hex);
  const set = useMemo(() => harmony(color, rule), [color, rule]);
  const first = useRef(true);
  // Callbacks may be new objects every render; only a *colour* change should
  // reach the outside, or a parent that re-renders on each report would feed
  // the effect its own echo.
  const reportRef = useRef(onChange);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
  reportRef.current = onChange;

  // Reflect every edit outward so the image behind updates as the thumb moves.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reportRef.current(hex);
  }, [hex]);

  useEffect(() => setHexDraft(hex), [hex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sampling) {
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter" && !sampling && (e.target as HTMLElement).tagName !== "BUTTON") {
        onApply(hex);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel, onApply, hex, sampling]);


  const commitHex = (raw: string) => {
    const clean = raw.trim().replace(/^#/, "");
    if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(clean)) return;
    setColor(fromHex(`#${clean}`));
  };

  const setChannel = (which: 0 | 1 | 2, raw: number) => {
    if (!Number.isFinite(raw)) return;
    const next: [number, number, number] = [r, g, b];
    next[which] = Math.max(0, Math.min(255, Math.round(raw)));
    const [h, s, v] = rgbToHsv(next[0], next[1], next[2]);
    // A grey has no hue of its own; keep the one the user was on.
    setColor((c) => ({ h: s === 0 ? c.h : h, s, v }));
  };

  const onHexInput = useCallback((value: string) => {
    setHexDraft(value);
    commitHex(value);
  }, []);

  const nudge = (e: React.KeyboardEvent, apply: (delta: number) => void) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      apply(step);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      apply(-step);
    }
  };

  const textOn = color.v > 0.62 && color.s < 0.75 ? "#101010" : "#fff";

  return (
    <div
      ref={cardRef}
      className="cp"
      role="dialog"
      aria-label={title ?? t("picker.title")}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header className="cp__head">
        <h3 className="cp__title">{title ?? t("picker.title")}</h3>
        <IconButton label={t("picker.cancel")} onClick={onCancel}>
          <IconClose />
        </IconButton>
      </header>

      <div className="cp__compare" aria-hidden="true">
        <span className="cp__new" style={{ background: hex, color: textOn }}>
          {hex}
        </span>
        <span className="cp__old" style={{ background: value.toUpperCase() }} title={t("picker.original")} />
      </div>

      {sampling && source ? (
        <div className="cp__sampling">
          <ImageSampler
            source={source}
            onLive={(h) => setColor(fromHex(h))}
            onPick={(h) => {
              setColor(fromHex(h));
              setSampling(false);
            }}
            onCancel={() => setSampling(false)}
          />
          <Button variant="text" onClick={() => setSampling(false)}>
            {t("picker.backToEditor")}
          </Button>
        </div>
      ) : (
        <>
          <DragSurface
            onMove={(x, y) => setColor((c) => ({ ...c, s: x, v: 1 - y }))}
            className="cp__area"
            style={{ ["--cp-hue" as string]: `hsl(${color.h} 100% 50%)` }}
            role="slider"
            tabIndex={0}
            aria-label={t("picker.satBright")}
            aria-valuetext={`${Math.round(color.s * 100)}% / ${Math.round(color.v * 100)}%`}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.1 : 0.01;
              if (e.key === "ArrowRight") setColor((c) => ({ ...c, s: clamp01(c.s + step) }));
              else if (e.key === "ArrowLeft") setColor((c) => ({ ...c, s: clamp01(c.s - step) }));
              else if (e.key === "ArrowUp") setColor((c) => ({ ...c, v: clamp01(c.v + step) }));
              else if (e.key === "ArrowDown") setColor((c) => ({ ...c, v: clamp01(c.v - step) }));
              else return;
              e.preventDefault();
            }}
          >
            <span
              className="cp__thumb"
              style={{ left: `${color.s * 100}%`, top: `${(1 - color.v) * 100}%`, background: hex }}
            />
          </DragSurface>

          <DragSurface
            onMove={(x) => setColor((c) => ({ ...c, h: x * 359.999 }))}
            className="cp__hue"
            role="slider"
            tabIndex={0}
            aria-label={t("picker.hue")}
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={Math.round(color.h)}
            onKeyDown={(e) => nudge(e, (d) => setColor((c) => ({ ...c, h: wrap(c.h + d) })))}
          >
            <span className="cp__huethumb" style={{ left: `${(color.h / 360) * 100}%`, background: `hsl(${color.h} 100% 50%)` }} />
          </DragSurface>

          <div className="cp__fieldbar">
            <Segmented
              ariaLabel={t("picker.model")}
              value={fields}
              onChange={setFields}
              options={[
                { value: "hex", label: "HEX" },
                { value: "rgb", label: "RGB" },
                { value: "hsb", label: "HSB" },
              ]}
            />
            {source && (
              <IconButton label={t("picker.pickFromImage")} variant="tonal" onClick={() => setSampling(true)}>
                <IconEyedropper />
              </IconButton>
            )}
          </div>

          {fields === "hex" && (
            <label className="cp__field cp__field--wide">
              <span>HEX</span>
              <input
                value={hexDraft}
                spellCheck={false}
                maxLength={7}
                onChange={(e) => onHexInput(e.target.value)}
                onBlur={() => setHexDraft(hex)}
              />
            </label>
          )}
          {fields === "rgb" && (
            <div className="cp__row">
              {(["R", "G", "B"] as const).map((label, i) => (
                <label key={label} className="cp__field">
                  <span>{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={255}
                    value={[r, g, b][i]}
                    onChange={(e) => setChannel(i as 0 | 1 | 2, Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
          )}
          {fields === "hsb" && (
            <div className="cp__row">
              <label className="cp__field">
                <span>H</span>
                <input
                  type="number"
                  min={0}
                  max={359}
                  value={Math.round(color.h) % 360}
                  onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setColor((c) => ({ ...c, h: wrap(e.target.valueAsNumber) }))}
                />
              </label>
              <label className="cp__field">
                <span>S</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(color.s * 100)}
                  onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setColor((c) => ({ ...c, s: clamp01(e.target.valueAsNumber / 100) }))}
                />
              </label>
              <label className="cp__field">
                <span>B</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(color.v * 100)}
                  onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setColor((c) => ({ ...c, v: clamp01(e.target.valueAsNumber / 100) }))}
                />
              </label>
            </div>
          )}

          <div className="cp__harmony">
            <div className="cp__rules" role="group" aria-label={t("picker.harmony")}>
              {(Object.keys(RULES) as RuleId[]).map((id) => (
                <button
                  key={id}
                  className={`cp__rule ${id === rule ? "is-selected" : ""}`}
                  aria-pressed={id === rule}
                  onClick={() => setRule(id)}
                >
                  {t(`picker.${id}`)}
                </button>
              ))}
            </div>
            <div className="cp__set">
              {set.map((c, i) => {
                const h = toHex(c);
                return (
                  <button key={i} className="cp__setswatch" style={{ background: h }} title={h} aria-label={h} onClick={() => setColor(c)} />
                );
              })}
              {onAddSet && (
                <IconButton label={t("picker.addAllFive")} onClick={() => onAddSet(set.map(toHex))}>
                  <IconAdd />
                </IconButton>
              )}
            </div>
          </div>
        </>
      )}

      <footer className="cp__foot">
        <Button variant="text" onClick={onCancel}>
          {t("picker.cancel")}
        </Button>
        <Button variant="filled" icon={<IconCheck />} onClick={() => onApply(hex)}>
          {t("picker.apply")}
        </Button>
      </footer>
    </div>
  );
}
