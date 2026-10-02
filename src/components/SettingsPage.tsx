import { useEffect, useMemo, useState, type ReactNode } from "react";
import { QUALITY_BUDGETS, type PreviewQuality } from "../dither/budget";
import { useI18n, type Locale } from "../i18n";
import { suggestedPoolSize } from "../video/pool";
import { SEED_PRESETS, type Mode, type ThemeSource } from "../theme/theme";
import { SearchBar } from "./fields";
import { Button, IconButton, Segmented, Slider } from "./primitives";
import {
  IconAuto,
  IconBack,
  IconChevronRight,
  IconDark,
  IconFavorite,
  IconLight,
  IconPalette,
} from "./Icons";
import { NavGlyph } from "./SettingsIcons";

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
  initialCategory?: SettingsCategory | null;
}

const CATEGORIES: Array<{ id: SettingsCategory }> = [
  { id: "appearance" },
  { id: "canvas" },
  { id: "performance" },
  { id: "language" },
  { id: "shortcuts" },
  { id: "about" },
];

/** Endonyms: a language list has to be readable by people who cannot read the current one. */
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
 * One row of the settings list.
 *
 * Settings are described as data and rendered afterwards, which is what lets the
 * search field work on them: it filters the same rows the category pages show,
 * and a result is a live control, not a link to one.
 */
interface Item {
  id: string;
  category: SettingsCategory;
  /** Section heading within the category. */
  section: string;
  title: string;
  supporting?: string;
  /** Extra words that should find this row, beyond its visible text. */
  keywords?: string;
  /** Controls, laid out below the text when `stacked`, to its right otherwise. */
  control?: ReactNode;
  stacked?: boolean;
  /** Replaces the whole row body, for rows that are not headline + supporting text. */
  custom?: ReactNode;
}

/**
 * A group of rows as a Material 3 segmented list: separate containers with
 * generous outer corners and tight inner ones, so a group reads as one object
 * made of rows rather than a stack of unrelated cards.
 */
function SegmentedList({ items }: { items: Item[] }) {
  return (
    <ul className="slist">
      {items.map((item) => (
        <li key={item.id} className={`slist__item ${item.stacked ? "is-stacked" : ""}`}>
          {item.custom ?? (
            <>
              <div className="slist__text">
                <span className="slist__title">{item.title}</span>
                {item.supporting && <span className="slist__supporting">{item.supporting}</span>}
              </div>
              {item.control && <div className="slist__control">{item.control}</div>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SettingsPage(props: Props) {
  const { t, locale, setLocale } = useI18n();
  const { onClose } = props;
  const [category, setCategory] = useState<SettingsCategory>(props.initialCategory ?? "appearance");
  /** At narrow widths the list and the detail are separate screens. */
  const [detailOpen, setDetailOpen] = useState(Boolean(props.initialCategory));
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      // One step back at a time: the search field handles its own Escape; a
      // detail screen returns to the list; the list closes the page.
      if (detailOpen && typeof window !== "undefined" && window.innerWidth < NARROW) setDetailOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen, onClose]);

  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const autoThreads = suggestedPoolSize();
  const threadsText = (n: number) =>
    n === 0 ? t("settings.threadsAutoShort").replace("{n}", String(autoThreads)) : t("settings.threadsFixed").replace("{n}", String(n));

  const items = useMemo<Item[]>(() => {
    const sec = (k: string) => t(`settings.sec.${k}`);
    const list: Item[] = [
      {
        id: "mode",
        category: "appearance",
        section: sec("theme"),
        title: t("settings.mode"),
        supporting: t("settings.modeHint"),
        keywords: "dark light theme night day colour scheme",
        stacked: true,
        control: (
          <Segmented
            ariaLabel={t("settings.mode")}
            value={props.mode}
            onChange={props.onMode}
            options={[
              { value: "light", label: t("settings.light"), icon: <IconLight /> },
              { value: "dark", label: t("settings.dark"), icon: <IconDark /> },
            ]}
          />
        ),
      },
      {
        id: "accent-source",
        category: "appearance",
        section: sec("accent"),
        title: t("settings.accent"),
        supporting:
          props.source === "dynamic"
            ? props.hasImage
              ? t("settings.accentDynamicHint")
              : t("settings.accentDynamicEmpty")
            : props.source === "matugen"
              ? t("settings.colorsFromMatugen")
              : t("settings.accentPresetHint"),
        keywords: "accent colour color seed dynamic matugen material you",
        stacked: true,
        control: (
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
        ),
      },
      {
        id: "accent-colour",
        category: "appearance",
        section: sec("accent"),
        title: props.source === "preset" ? t("settings.accentChoose") : t("settings.accentCurrent"),
        keywords: "accent swatch colour color preset",
        custom:
          props.source === "preset" ? (
            <div className="slist__swatches" role="group" aria-label={t("settings.accent")}>
              <span className="slist__title">{t("settings.accentChoose")}</span>
              <div className="slist__swatchrow">
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
            </div>
          ) : (
            <>
              <div className="slist__text">
                <span className="slist__title">{t("settings.accentCurrent")}</span>
                <span className="slist__supporting">
                  {props.source === "matugen"
                    ? t("settings.colorsFromMatugen")
                    : props.dynamicSeed
                      ? t("settings.sourcedFromImage").replace("{hex}", props.dynamicSeed.toUpperCase())
                      : t("settings.noImageYet")}
                </span>
              </div>
              <div className="slist__control">
                <span
                  className="swatch is-static"
                  style={{ background: props.dynamicSeed ?? "var(--md-sys-color-surface-container-highest)" }}
                  aria-hidden="true"
                />
              </div>
            </>
          ),
      },
      {
        id: "wheel-behaviour",
        category: "canvas",
        section: sec("preview"),
        title: t("settings.previewWheel"),
        supporting: t("settings.previewWheelHint"),
        keywords: "scroll wheel mouse pan zoom trackpad",
        stacked: true,
        control: (
          <Segmented
            ariaLabel={t("settings.previewWheel")}
            value={props.wheelBehavior}
            onChange={props.onWheelBehavior}
            options={[
              { value: "pan", label: t("settings.previewWheelPan") },
              { value: "zoom", label: t("settings.previewWheelZoom") },
            ]}
          />
        ),
      },
      {
        id: "wheel-step",
        category: "canvas",
        section: sec("sliders"),
        title: t("settings.wheelStep"),
        supporting: t("settings.wheelStepHint"),
        keywords: "scroll wheel slider increment step speed",
        stacked: true,
        control: (
          <Slider
            label={t("settings.wheelStep")}
            value={props.wheelStep}
            min={1}
            max={10}
            display={`${props.wheelStep}×`}
            onChange={props.onWheelStep}
          />
        ),
      },
      {
        id: "preview-quality",
        category: "performance",
        section: sec("preview"),
        title: t("settings.previewQuality"),
        supporting: t(`settings.quality.${props.previewQuality}Hint`).replace(
          "{ms}",
          String(QUALITY_BUDGETS[props.previewQuality].coarse),
        ),
        keywords: "speed fast sharp balanced resolution lag smooth slow",
        stacked: true,
        control: (
          <Segmented
            ariaLabel={t("settings.previewQuality")}
            value={props.previewQuality}
            onChange={props.onPreviewQuality}
            options={(["fast", "balanced", "sharp"] as const).map((q) => ({ value: q, label: t(`settings.quality.${q}`) }))}
          />
        ),
      },
      {
        id: "export-threads",
        category: "performance",
        section: sec("video"),
        title: t("settings.exportThreads"),
        supporting: t("settings.exportThreadsHint").replace("{cores}", String(cores)).replace("{auto}", String(autoThreads)),
        keywords: "threads workers cores cpu parallel video export render",
        stacked: true,
        control: (
          <Slider
            label={t("settings.threadsLabel")}
            value={props.exportThreads}
            min={0}
            max={Math.max(2, Math.min(12, cores))}
            display={threadsText(props.exportThreads)}
            onChange={props.onExportThreads}
          />
        ),
      },
      {
        id: "stack-cache",
        category: "performance",
        section: sec("video"),
        title: t("settings.cacheTitle"),
        supporting: t("settings.performanceNote"),
        keywords: "cache stack layers passes memory reuse",
      },
      ...LANGUAGES.map<Item>((l) => ({
        id: `lang-${l.id}`,
        category: "language",
        section: sec("language"),
        title: l.name,
        keywords: `language locale translation ${l.id}`,
        custom: (
          <button
            className="slist__radio"
            role="radio"
            aria-checked={locale === l.id}
            lang={l.id}
            onClick={() => setLocale(l.id)}
          >
            <span className="slist__title">{l.name}</span>
            <span className={`slist__radiodot ${locale === l.id ? "is-on" : ""}`} aria-hidden="true" />
          </button>
        ),
      })),
      ...SHORTCUTS.map<Item>((s) => ({
        id: `key-${s.key}`,
        category: "shortcuts",
        section: sec("keyboard"),
        title: t(s.key),
        keywords: `keyboard shortcut hotkey ${s.keys.join(" ")}`,
        control: (
          <span className="slist__keys">
            {s.keys.map((k, i) => (
              <kbd key={i}>{k}</kbd>
            ))}
          </span>
        ),
      })),
      {
        id: "about-version",
        category: "about",
        section: sec("about"),
        title: "Dizako",
        supporting: `${t("settings.version").replace("{v}", __APP_VERSION__)} · ${t("settings.aboutText")}`,
        keywords: "about version info privacy local offline",
        custom: (
          <>
            <img src="/icon.png" alt="" className="slist__mark" draggable={false} />
            <div className="slist__text">
              <span className="slist__title">Dizako</span>
              <span className="slist__supporting">{t("settings.version").replace("{v}", __APP_VERSION__)}</span>
              <span className="slist__supporting">{t("settings.aboutText")}</span>
            </div>
          </>
        ),
      },
      {
        id: "about-donate",
        category: "about",
        section: sec("support"),
        title: t("topbar.donate"),
        supporting: t("topbar.donateHint"),
        keywords: "donate support kofi tip",
        control: (
          <Button variant="donate" icon={<IconFavorite />} onClick={props.onDonate}>
            {t("topbar.donate")}
          </Button>
        ),
      },
    ];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `props` is the whole bag; the list is cheap and rebuilt when any setting changes
  }, [t, locale, setLocale, props.mode, props.source, props.seed, props.wheelStep, props.wheelBehavior, props.previewQuality, props.exportThreads, props.dynamicSeed, props.hasImage, cores, autoThreads]);

  const categoryName = (id: SettingsCategory) => t(`settings.cat.${id}`);

  /** Rows grouped by section, preserving the order they were declared in. */
  const sectionsOf = (rows: Item[]) => {
    const out: Array<{ name: string; rows: Item[] }> = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (last && last.name === row.section) last.rows.push(row);
      else out.push({ name: row.section, rows: [row] });
    }
    return out;
  };

  const results = useMemo(() => {
    if (!needle) return [];
    return items.filter((i) =>
      [i.title, i.supporting ?? "", i.keywords ?? "", i.section, categoryName(i.category)].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- categoryName only reads `t`
  }, [items, needle, t]);

  const summary = (id: SettingsCategory): string => {
    switch (id) {
      case "appearance":
        return `${t(props.mode === "dark" ? "settings.dark" : "settings.light")} · ${
          props.source === "dynamic" ? t("settings.dynamic") : props.source === "matugen" ? "Matugen" : t("settings.preset")
        }`;
      case "canvas":
        return `${t(props.wheelBehavior === "zoom" ? "settings.previewWheelZoom" : "settings.previewWheelPan")} · ${props.wheelStep}×`;
      case "performance":
        return `${t(`settings.quality.${props.previewQuality}`)} · ${threadsText(props.exportThreads)}`;
      case "language":
        return LANGUAGES.find((l) => l.id === locale)?.name ?? locale;
      case "shortcuts":
        return t("settings.shortcutCount").replace("{n}", String(SHORTCUTS.length));
      case "about":
        return `Dizako ${__APP_VERSION__}`;
    }
  };

  const inCategory = items.filter((i) => i.category === category);

  return (
    <div className={`spage ${detailOpen ? "is-detail" : ""} ${needle ? "is-searching" : ""}`} role="region" aria-label={t("settings.title")}>
      <header className="spage__bar">
        <IconButton
          label={detailOpen ? t("settings.backToOverview") : t("settings.close")}
          onClick={() => (detailOpen && window.innerWidth < NARROW ? setDetailOpen(false) : onClose())}
        >
          <IconBack />
        </IconButton>
        <h2 className="spage__title">{t("settings.title")}</h2>
        <div className="spage__search">
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder={t("settings.search")}
            clearLabel={t("common.clearSearch")}
          />
        </div>
      </header>

      <div className="spage__body">
        <nav className="spage__nav" aria-label={t("settings.categories")}>
          <ul>
            {CATEGORIES.map((c) => (
              <li key={c.id}>
                <button
                  className={`navitem ${c.id === category && !needle ? "is-selected" : ""}`}
                  aria-current={c.id === category && !needle ? "page" : undefined}
                  onClick={() => {
                    setQuery("");
                    setCategory(c.id);
                    setDetailOpen(true);
                  }}
                >
                  <span className="navitem__icon">
                    <NavGlyph id={c.id} />
                  </span>
                  <span className="navitem__text">
                    <span className="navitem__title">{categoryName(c.id)}</span>
                    <span className="navitem__summary">{summary(c.id)}</span>
                  </span>
                  <span className="navitem__chev" aria-hidden="true">
                    <IconChevronRight />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="spage__detail" key={needle ? "search" : category}>
          <div className="spage__detailinner">
            {needle ? (
              <>
                <h3 className="spage__headline">{t("settings.results")}</h3>
                {results.length === 0 ? (
                  <p className="spage__empty">{t("settings.noResults").replace("{q}", query.trim())}</p>
                ) : (
                  CATEGORIES.filter((c) => results.some((r) => r.category === c.id)).map((c) => (
                    <section key={c.id} className="ssection">
                      <h4 className="ssection__title">{categoryName(c.id)}</h4>
                      <SegmentedList items={results.filter((r) => r.category === c.id)} />
                    </section>
                  ))
                )}
              </>
            ) : (
              <>
                <h3 className="spage__headline">{categoryName(category)}</h3>
                {sectionsOf(inCategory).map((s) => (
                  <section key={s.name} className="ssection">
                    <h4 className="ssection__title">{s.name}</h4>
                    <SegmentedList items={s.rows} />
                  </section>
                ))}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/** Below this width the list and the detail are two screens instead of two panes. */
const NARROW = 860;
