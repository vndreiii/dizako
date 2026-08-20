import { useEffect, useRef } from "react";
import { IconAuto, IconClose, IconDark, IconLight, IconPalette } from "./Icons";
import { SEED_PRESETS, type Mode, type ThemeSource } from "../theme/theme";

interface Props {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  onMode: (m: Mode) => void;
  source: ThemeSource;
  onSource: (s: ThemeSource) => void;
  seed: string;
  onSeed: (hex: string) => void;
  /** Seed extracted from the current image, when there is one. */
  dynamicSeed: string | null;
  hasImage: boolean;
}

export function SettingsSheet({
  open,
  onClose,
  mode,
  onMode,
  source,
  onSource,
  seed,
  onSeed,
  dynamicSeed,
  hasImage,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="sheet-scrim" onPointerDown={onClose}>
      <div
        ref={panelRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sheet__header">
          <h2 className="sheet__title">Settings</h2>
          <button className="sheet__close" onClick={onClose} aria-label="Close settings">
            <IconClose />
          </button>
        </header>

        <section className="sheet__section">
          <h3 className="sheet__section-title">Appearance</h3>

          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">Mode</span>
              <span className="setting__hint">Light or dark surfaces.</span>
            </div>
            <div className="m3-segmented" role="group" aria-label="Theme mode">
              <button
                className={`m3-segmented__item ${mode === "light" ? "is-selected" : ""}`}
                aria-pressed={mode === "light"}
                onClick={() => onMode("light")}
              >
                <span className="m3-segmented__icon">
                  <IconLight />
                </span>
                Light
              </button>
              <button
                className={`m3-segmented__item ${mode === "dark" ? "is-selected" : ""}`}
                aria-pressed={mode === "dark"}
                onClick={() => onMode("dark")}
              >
                <span className="m3-segmented__icon">
                  <IconDark />
                </span>
                Dark
              </button>
            </div>
          </div>

          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">Accent</span>
              <span className="setting__hint">
                {source === "dynamic"
                  ? hasImage
                    ? "Taken from the colours in your image."
                    : "Will follow your image once one is loaded."
                  : "A fixed accent colour."}
              </span>
            </div>
            <div className="m3-segmented" role="group" aria-label="Accent source">
              <button
                className={`m3-segmented__item ${source === "preset" ? "is-selected" : ""}`}
                aria-pressed={source === "preset"}
                onClick={() => onSource("preset")}
              >
                <span className="m3-segmented__icon">
                  <IconPalette />
                </span>
                Preset
              </button>
              <button
                className={`m3-segmented__item ${source === "dynamic" ? "is-selected" : ""}`}
                aria-pressed={source === "dynamic"}
                onClick={() => onSource("dynamic")}
              >
                <span className="m3-segmented__icon">
                  <IconAuto />
                </span>
                Dynamic
              </button>
            </div>
          </div>

          {source === "preset" ? (
            <div className="swatches" role="group" aria-label="Accent colour">
              {SEED_PRESETS.map((p) => (
                <button
                  key={p.seed}
                  className={`swatch ${p.seed === seed ? "is-selected" : ""}`}
                  style={{ background: p.seed }}
                  aria-label={p.name}
                  aria-pressed={p.seed === seed}
                  title={p.name}
                  onClick={() => onSeed(p.seed)}
                />
              ))}
            </div>
          ) : (
            <div className="dynamic-preview">
              <span
                className="swatch is-static"
                style={{ background: dynamicSeed ?? "var(--md-sys-color-surface-container-highest)" }}
                aria-hidden="true"
              />
              <span className="setting__hint">
                {dynamicSeed
                  ? `Sourced from your image — ${dynamicSeed.toUpperCase()}`
                  : "No image loaded yet."}
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
