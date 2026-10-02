import { useEffect, useMemo, useState, type ReactNode } from "react";
import { QUALITY_BUDGETS, type PreviewQuality } from "../dither/budget";
import { useI18n, type Locale } from "../i18n";
import { suggestedPoolSize } from "../video/pool";
import { SEED_PRESETS, type Mode, type ThemeSource } from "../theme/theme";
import { Button, IconButton, Segmented, Slider } from "./primitives";
import {
  IconAuto,
  IconBack,
  IconDark,
  IconFavorite,
  IconFit,
  IconInfo,
  IconKeyboard,
  IconLanguage,
  IconLight,
  IconPalette,
  IconTimer,
} from "./Icons";

export type SettingsCategory = "appearance" | "canvas" | "performance" | "language" | "shortcuts" | "about";

interface Props {
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
  wheelBehavior: "pan" | "zoom";
  onWheelBehavior: (behavior: "pan" | "zoom") => void;
  previewQuality: PreviewQuality;
  onPreviewQuality: (q: PreviewQuality) => void;
  /** 0 means one worker per spare core. */
  exportThreads: number;
  onExportThreads: (n: number) => void;
  /** Seed extracted from the current image, when there is one. */
  dynamicSeed: string | null;
  hasImage: boolean;
  onDonate: () => void;
  /** Open on a category rather than the overview. */
  initialCategory?: SettingsCategory | null;
}

const CATEGORIES: Array<{ id: SettingsCategory; icon: ReactNode }> = [
  { id: "appearance", icon: <IconPalette /> },
  { id: "canvas", icon: <IconFit /> },
  { id: "performance", icon: <IconTimer /> },
  { id: "language", icon: <IconLanguage /> },
  { id: "shortcuts", icon: <IconKeyboard /> },
  { id: "about", icon: <IconInfo /> },
];

/** Endonyms: a language picker has to be readable by people who cannot read the current one. */
const LANGUAGES: Array<{ id: Locale; name: string }> = [
  { id: "en", name: "English" },
  { id: "es", name: "Español" },
  { id: "fr", name: "Français" },
  { id: "de", name: "Deutsch" },
  { id: "it", name: "Italiano" },
  { id: "pt", name: "Português" },
  { id: "nl", name: "Nederlands" },
  { id: "sv", name: "Svenska" },
  { id: "pl", name: "Polski" },
  { id: "tr", name: "Türkçe" },
  { id: "ru", name: "Русский" },
  { id: "sr", name: "Srpski" },
  { id: "bs", name: "Bosanski" },
  { id: "ja", name: "日本語" },
  { id: "zh", name: "中文" },
  { id: "ko", name: "한국어" },
  { id: "hi", name: "हिन्दी" },
  { id: "ar", name: "العربية" },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

const SHORTCUTS: Array<{ keys: string[]; key: string }> = [
  { keys: [MOD, "O"], key: "shortcuts.open" },
  { keys: [MOD, "E"], key: "shortcuts.export" },
  { keys: [MOD, "Shift", "E"], key: "shortcuts.exportVideo" },
  { keys: [MOD, "Z"], key: "shortcuts.undo" },
  { keys: [MOD, "Shift", "Z"], key: "shortcuts.redo" },
  { keys: ["Space"], key: "shortcuts.play" },
  { keys: ["Esc"], key: "shortcuts.close" },
];

/**
 * Settings as a page rather than a sheet.
 *
 * It opens on an overview of categories - each a large pill showing what it
 * currently holds - and each category is a page of its own. A strip of the same
 * pills stays at the top of a category so moving between them never needs a
 * trip back to the overview.
 */
export function SettingsPage(props: Props) {
  const { t, locale, setLocale } = useI18n();
  const [category, setCategory] = useState<SettingsCategory | null>(props.initialCategory ?? null);
  const { onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // One step back at a time: category → overview → the editor.
      e.stopPropagation();
      if (category) setCategory(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [category, onClose]);

  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const autoThreads = suggestedPoolSize();

  const summaries = useMemo<Record<SettingsCategory, string>>(
    () => ({
      appearance: `${t(props.mode === "dark" ? "settings.dark" : "settings.light")} · ${
        props.source === "dynamic" ? t("settings.dynamic") : props.source === "matugen" ? "Matugen" : t("settings.preset")
      }`,
      canvas: `${t(props.wheelBehavior === "zoom" ? "settings.previewWheelZoom" : "settings.previewWheelPan")} · ${props.wheelStep}×`,
      performance: `${t(`settings.quality.${props.previewQuality}`)} · ${
        props.exportThreads === 0
          ? t("settings.threadsAutoShort").replace("{n}", String(autoThreads))
          : t("settings.threadsFixed").replace("{n}", String(props.exportThreads))
      }`,
      language: LANGUAGES.find((l) => l.id === locale)?.name ?? locale,
      shortcuts: t("settings.shortcutCount").replace("{n}", String(SHORTCUTS.length)),
      about: `Dizako ${__APP_VERSION__}`,
    }),
    [t, props.mode, props.source, props.wheelBehavior, props.wheelStep, props.previewQuality, props.exportThreads, locale, autoThreads],
  );

  const pages: Record<SettingsCategory, ReactNode> = {
    appearance: (
      <>
        <div className="sgroup">
          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t("settings.mode")}</span>
              <span className="setting__hint">{t("settings.modeHint")}</span>
            </div>
            <Segmented
              ariaLabel={t("settings.mode")}
              value={props.mode}
              onChange={props.onMode}
              options={[
                { value: "light", label: t("settings.light"), icon: <IconLight /> },
                { value: "dark", label: t("settings.dark"), icon: <IconDark /> },
              ]}
            />
          </div>
        </div>

        <div className="sgroup">
          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t("settings.accent")}</span>
              <span className="setting__hint">
                {props.source === "dynamic"
                  ? props.hasImage
                    ? t("settings.accentDynamicHint")
                    : t("settings.accentDynamicEmpty")
                  : props.source === "matugen"
                    ? t("settings.colorsFromMatugen")
                    : t("settings.accentPresetHint")}
              </span>
            </div>
            <Segmented
              ariaLabel={t("settings.accent")}
              value={props.source}
              onChange={props.onSource}
              options={[
                { value: "preset", label: t("settings.preset"), icon: <IconPalette /> },
                { value: "dynamic", label: t("settings.dynamic"), icon: <IconAuto /> },
                { value: "matugen", label: t("settings.matugen") || "Matugen", icon: <IconPalette /> },
              ]}
            />
          </div>

          {props.source === "preset" ? (
            <div className="swatches swatches--flat" role="group" aria-label={t("settings.accent")}>
              {SEED_PRESETS.map((p) => (
                <button
                  key={p.seed}
                  className={`swatch ${p.seed === props.seed ? "is-selected" : ""}`}
                  style={{ background: p.seed }}
                  aria-label={t(`settings.seed.${p.name.toLowerCase()}`)}
                  aria-pressed={p.seed === props.seed}
                  title={t(`settings.seed.${p.name.toLowerCase()}`)}
                  onClick={() => props.onSeed(p.seed)}
                />
              ))}
            </div>
          ) : props.source === "matugen" ? (
            <div className="dynamic-preview dynamic-preview--flat">
              <span className="setting__hint">{t("settings.colorsFromMatugen")}</span>
            </div>
          ) : (
            <div className="dynamic-preview dynamic-preview--flat">
              <span
                className="swatch is-static"
                style={{ background: props.dynamicSeed ?? "var(--md-sys-color-surface-container-highest)" }}
                aria-hidden="true"
              />
              <span className="setting__hint">
                {props.dynamicSeed
                  ? t("settings.sourcedFromImage").replace("{hex}", props.dynamicSeed.toUpperCase())
                  : t("settings.noImageYet")}
              </span>
            </div>
          )}
        </div>
      </>
    ),

    canvas: (
      <>
        <div className="sgroup">
          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t("settings.previewWheel")}</span>
              <span className="setting__hint">{t("settings.previewWheelHint")}</span>
            </div>
            <Segmented
              ariaLabel={t("settings.previewWheel")}
              value={props.wheelBehavior}
              onChange={props.onWheelBehavior}
              options={[
                { value: "pan", label: t("settings.previewWheelPan") },
                { value: "zoom", label: t("settings.previewWheelZoom") },
              ]}
            />
          </div>
        </div>
        <div className="sgroup">
          <div className="setting setting--stack">
            <div className="setting__text">
              <span className="setting__label">{t("settings.wheelStep")}</span>
              <span className="setting__hint">{t("settings.wheelStepHint")}</span>
            </div>
            <Slider
              label={t("settings.wheelStep")}
              value={props.wheelStep}
              min={1}
              max={10}
              display={`${props.wheelStep}×`}
              onChange={props.onWheelStep}
            />
          </div>
        </div>
      </>
    ),

    performance: (
      <>
        <div className="sgroup">
          <div className="setting setting--stack">
            <div className="setting__text">
              <span className="setting__label">{t("settings.previewQuality")}</span>
              <span className="setting__hint">{t("settings.previewQualityHint")}</span>
            </div>
            <Segmented
              ariaLabel={t("settings.previewQuality")}
              value={props.previewQuality}
              onChange={props.onPreviewQuality}
              options={(["fast", "balanced", "sharp"] as const).map((q) => ({
                value: q,
                label: t(`settings.quality.${q}`),
              }))}
            />
            <p className="setting__hint">
              {t(`settings.quality.${props.previewQuality}Hint`).replace(
                "{ms}",
                String(QUALITY_BUDGETS[props.previewQuality].coarse),
              )}
            </p>
          </div>
        </div>
        <div className="sgroup">
          <div className="setting setting--stack">
            <div className="setting__text">
              <span className="setting__label">{t("settings.exportThreads")}</span>
              <span className="setting__hint">
                {t("settings.exportThreadsHint").replace("{cores}", String(cores)).replace("{auto}", String(autoThreads))}
              </span>
            </div>
            <Slider
              label={t("settings.threadsLabel")}
              value={props.exportThreads}
              min={0}
              max={Math.max(2, Math.min(12, cores))}
              display={
                props.exportThreads === 0
                  ? t("settings.threadsAutoShort").replace("{n}", String(autoThreads))
                  : t("settings.threadsFixed").replace("{n}", String(props.exportThreads))
              }
              onChange={props.onExportThreads}
            />
          </div>
        </div>
        <p className="spage__note">{t("settings.performanceNote")}</p>
      </>
    ),

    language: (
      <div className="sgroup">
        <div className="setting setting--stack">
          <div className="setting__text">
            <span className="setting__label">{t("settings.language")}</span>
            <span className="setting__hint">{t("settings.languageHint")}</span>
          </div>
          <div className="langgrid" role="group" aria-label={t("settings.language")}>
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                className={`langgrid__item ${locale === l.id ? "is-selected" : ""}`}
                aria-pressed={locale === l.id}
                lang={l.id}
                onClick={() => setLocale(l.id)}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    ),

    shortcuts: (
      <div className="sgroup">
        <ul className="keylist">
          {SHORTCUTS.map((s) => (
            <li key={s.key} className="keylist__row">
              <span className="keylist__label">{t(s.key)}</span>
              <span className="keylist__keys">
                {s.keys.map((k, i) => (
                  <kbd key={i}>{k}</kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    ),

    about: (
      <>
        <div className="sgroup about">
          <img src="/icon.png" alt="" className="about__mark" draggable={false} />
          <div>
            <h3 className="about__name">Dizako</h3>
            <p className="about__version">{t("settings.version").replace("{v}", __APP_VERSION__)}</p>
            <p className="about__text">{t("settings.aboutText")}</p>
          </div>
        </div>
        <div className="sgroup">
          <div className="setting">
            <div className="setting__text">
              <span className="setting__label">{t("topbar.donate")}</span>
              <span className="setting__hint">{t("topbar.donateHint")}</span>
            </div>
            <Button variant="donate" icon={<IconFavorite />} onClick={props.onDonate}>
              {t("topbar.donate")}
            </Button>
          </div>
        </div>
      </>
    ),
  };

  return (
    <div className="spage" role="region" aria-label={t("settings.title")}>
      <header className="spage__bar">
        <IconButton label={category ? t("settings.backToOverview") : t("settings.close")} variant="tonal" onClick={() => (category ? setCategory(null) : onClose())}>
          <IconBack />
        </IconButton>
        <div className="spage__heading">
          <h2 className="spage__title">{category ? t(`settings.cat.${category}`) : t("settings.title")}</h2>
          <p className="spage__crumb">
            {category ? (
              <>
                <button className="spage__crumblink" onClick={() => setCategory(null)}>
                  {t("settings.title")}
                </button>
                <span aria-hidden="true"> / </span>
                {t(`settings.cat.${category}`)}
              </>
            ) : (
              t("settings.overviewHint")
            )}
          </p>
        </div>
        <span className="spage__spacer" />
        <Button variant="text" onClick={onClose}>
          {t("settings.done")}
        </Button>
      </header>

      {category && (
        <nav className="spage__pills" aria-label={t("settings.categories")}>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`spill ${c.id === category ? "is-selected" : ""}`}
              aria-current={c.id === category ? "page" : undefined}
              onClick={() => setCategory(c.id)}
            >
              <span className="spill__icon">{c.icon}</span>
              {t(`settings.cat.${c.id}`)}
            </button>
          ))}
        </nav>
      )}

      <div className="spage__scroll">
        <div className="spage__inner" key={category ?? "overview"}>
          {category ? (
            pages[category]
          ) : (
            <div className="scards">
              {CATEGORIES.map((c) => (
                <button key={c.id} className="scard" onClick={() => setCategory(c.id)}>
                  <span className="scard__icon">{c.icon}</span>
                  <span className="scard__text">
                    <span className="scard__title">{t(`settings.cat.${c.id}`)}</span>
                    <span className="scard__summary">{summaries[c.id]}</span>
                  </span>
                  <span className="scard__chev" aria-hidden="true">
                    <IconBack />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
