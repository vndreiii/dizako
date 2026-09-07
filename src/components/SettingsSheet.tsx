import { useEffect, useRef } from "react";
import { IconAuto, IconClose, IconDark, IconLight, IconPalette } from "./Icons";
import { useI18n, type Locale } from "../i18n";
import { SEED_PRESETS, type Mode, type ThemeSource } from "../theme/theme";
import { Slider } from "./primitives";

interface Props {
  open: boolean;
  onClose: () => void;
  mode: Mode;
  onMode: (m: Mode) => void;
  source: ThemeSource;
  onSource: (s: ThemeSource) => void;
  seed: string;
  onSeed: (hex: string) => void;
  /** Wheel increment applied to every slider. */
  wheelStep: number;
  onWheelStep: (n: number) => void;
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
  wheelStep,
  onWheelStep,
  dynamicSeed,
  hasImage,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { t, locale, setLocale } = useI18n();

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
        aria-label={t("settings.sheetAria")}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="sheet__header">
          <h2 className="sheet__title">{t("settings.title")}</h2>
          <button className="sheet__close" onClick={onClose} aria-label="Close settings">
            <IconClose />
          </button>
        </header>

        <section className="sheet__section">
          <h3 className="sheet__section-title">{t("settings.appearance")}</h3>

          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t("settings.mode")}</span>
              <span className="setting__hint">{t("settings.modeHint")}</span>
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
                {t("settings.light")}
              </button>
              <button
                className={`m3-segmented__item ${mode === "dark" ? "is-selected" : ""}`}
                aria-pressed={mode === "dark"}
                onClick={() => onMode("dark")}
              >
                <span className="m3-segmented__icon">
                  <IconDark />
                </span>
                {t("settings.dark")}
              </button>
            </div>
          </div>

          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t("settings.accent")}</span>
              <span className="setting__hint">
                {source === "dynamic"
                  ? hasImage
                    ? t("settings.accentDynamicHint")
                    : t("settings.accentDynamicEmpty")
                  : source === "matugen"
                    ? t("settings.colorsFromMatugen")
                    : t("settings.accentPresetHint")}
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
                {t("settings.preset")}
              </button>
              <button
                className={`m3-segmented__item ${source === "dynamic" ? "is-selected" : ""}`}
                aria-pressed={source === "dynamic"}
                onClick={() => onSource("dynamic")}
              >
                <span className="m3-segmented__icon">
                  <IconAuto />
                </span>
                {t("settings.dynamic")}
              </button>
              <button
                className={`m3-segmented__item ${source === "matugen" ? "is-selected" : ""}`}
                aria-pressed={source === "matugen"}
                onClick={() => onSource("matugen")}
              >
                <span className="m3-segmented__icon">
                  <IconPalette />
                </span>
                {t("settings.matugen") || "Matugen"}
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
                  aria-label={t(`settings.seed.${p.name.toLowerCase()}`)}
                  aria-pressed={p.seed === seed}
                  title={t(`settings.seed.${p.name.toLowerCase()}`)}
                  onClick={() => onSeed(p.seed)}
                />
              ))}
            </div>
          ) : source === "matugen" ? (
            <div className="dynamic-preview">
              <span className="setting__hint">{t("settings.colorsFromMatugen")}</span>
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
                  ? `Sourced from your image - ${dynamicSeed.toUpperCase()}`
                  : "No image loaded yet."}
              </span>
            </div>
          )}
          
          <div className="setting" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div className="setting__text">
              <span className="setting__label">{t("settings.wheelStep")}</span>
              <span className="setting__hint">{t("settings.wheelStepHint")}</span>
            </div>
            <Slider
              label={t("settings.wheelStep")}
              value={wheelStep}
              min={1}
              max={10}
              display={`${wheelStep}×`}
              onChange={onWheelStep}
            />
          </div>

          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t("settings.language")}</span>
              <span className="setting__hint">{t("settings.languageHint")}</span>
            </div>
            <div className="swatches" style={{ gap: '8px', flexWrap: 'wrap' }} role="group" aria-label="Language">
              {['en','es','fr','de','it','pt','ru','ja','zh','bs','sr','ko','ar','hi','tr','pl','nl','sv'].map(lang => (
                <button
                  key={lang}
                  style={{ width: 'auto', padding: '4px 12px', background: locale === lang ? 'var(--md-sys-color-primary)' : 'var(--md-sys-color-surface-container-highest)', color: locale === lang ? 'var(--md-sys-color-on-primary)' : 'var(--md-sys-color-on-surface)', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'var(--m3-font-body)', fontWeight: 500, textTransform: 'uppercase' }}
                  aria-pressed={locale === lang}
                  onClick={() => setLocale(lang as Locale)}
                >
                  {lang}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
