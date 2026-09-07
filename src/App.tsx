import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdjustPanel } from "./components/AdjustPanel";
import { AlgorithmPanel } from "./components/AlgorithmPanel";
import { PalettePanel } from "./components/PalettePanel";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { useI18n } from "./i18n";
import { Button, useSnackbar } from "./components/primitives";
import {
  IconDownload,
  IconFavorite,
  IconGrid,
  IconImage,
  IconPalette,
  IconSettings,
  IconTune,
  IconUpload,
  IconBack,
  IconForward,
} from "./components/Icons";
import { SettingsSheet } from "./components/SettingsSheet";
import { WheelStepContext } from "./components/primitives";
import { WindowControls } from "./components/WindowControls";
import { openDonatePage } from "./donate";
import { useDither } from "./hooks/useDither";
import type { Rect } from "./dither/region";
import { savePng } from "./hooks/saveImage";
import { DEFAULT_SETTINGS, type Settings } from "./dither/types";
import { loadSession, saveSession } from "./session";
import {
  applyTheme,
  applyMatugenTheme,
  DEFAULT_SEED,
  seedFromImageData,
  type Mode,
  type ThemeSource,
} from "./theme/theme";

type Tab = "algorithm" | "palette" | "image";

const TABS: Array<{ id: Tab; icon: React.ReactNode }> = [
  { id: "algorithm", icon: <IconGrid /> },
  { id: "palette", icon: <IconPalette /> },
  { id: "image", icon: <IconTune /> },
];

/**
 * Upper bound on the decoded working image.
 *
 * This is a memory and responsiveness guard, not a canvas limit - WebKit
 * decodes and reads back far larger canvases without complaint. The cost is in
 * the dither pass: error diffusion carries a Float32 error plane of
 * `width * height * 3`, i.e. 12 bytes per pixel on top of the RGBA buffers. A
 * 192 MP source needs ~2.3 GB for that plane alone and takes ~20 s per pass,
 * which makes every slider drag unusable. 16 MP keeps the error plane near
 * 192 MB and a pass near 2 s. Anything larger is scaled down, and the user is
 * told in the snackbar rather than silently getting a smaller export.
 */
const MAX_PIXELS = 16_000_000;
const MAX_DIMENSION = 8192;

/** A pause this long ends an edit, so a slider drag becomes one undo step. */
const COALESCE_MS = 450;
const HISTORY_LIMIT = 80;

function fitWithinLimits(w: number, h: number): number {
  let scale = 1;
  if (w * h > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w * h));
  const longest = Math.max(w, h) * scale;
  if (longest > MAX_DIMENSION) scale *= MAX_DIMENSION / longest;
  return scale;
}

export interface DecodeResult {
  data: ImageData;
  /** Set when the source had to be reduced to stay within canvas limits. */
  clampedFrom: { width: number; height: number } | null;
}

async function decode(file: File): Promise<DecodeResult> {
  const bitmap = await createImageBitmap(file);
  const scale = fitWithinLimits(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.floor(bitmap.width * scale));
  const h = Math.max(1, Math.floor(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error("Could not acquire a 2D context");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  const clampedFrom = scale < 1 ? { width: bitmap.width, height: bitmap.height } : null;
  bitmap.close();

  const data = ctx.getImageData(0, 0, w, h);

  // Guard against the silent-blank-canvas case anyway: if every pixel is fully
  // transparent the draw did not land, and a blank preview would be the only
  // symptom the user ever sees.
  let opaque = false;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] !== 0) {
      opaque = true;
      break;
    }
  }
  if (!opaque) throw new Error("The decoded image was empty (canvas size limit)");

  return { data, clampedFrom };
}

/** Box-downsample via canvas, used for the pixel-scale control. */
function downscale(src: ImageData, factor: number): ImageData {
  if (factor <= 1) return src;
  const w = Math.max(1, Math.round(src.width / factor));
  const h = Math.max(1, Math.round(src.height / factor));

  const from = document.createElement("canvas");
  from.width = src.width;
  from.height = src.height;
  from.getContext("2d")!.putImageData(src, 0, 0);

  const to = document.createElement("canvas");
  to.width = w;
  to.height = h;
  const ctx = to.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(from, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Read once per launch; every key falls back to defaults when absent. */
const restoredSession = loadSession();

export default function App() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings>(restoredSession.settings ?? DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>("algorithm");
  const [native, setNative] = useState<ImageData | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Mode>(() => restoredSession.appearance?.mode ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  const [seed, setSeed] = useState(restoredSession.appearance?.seed ?? DEFAULT_SEED);
  const [themeSource, setThemeSource] = useState<ThemeSource>(restoredSession.appearance?.themeSource ?? "preset");
  const [wheelStep, setWheelStep] = useState(restoredSession.appearance?.wheelStep ?? 2);
  const [dynamicSeed, setDynamicSeed] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyFrameRef = useRef<HTMLDivElement>(null);
  const snack = useSnackbar();

  // In dynamic mode the accent follows the image; falls back to the chosen
  // preset until one is loaded.
  const activeSeed = themeSource === "dynamic" ? (dynamicSeed ?? seed) : seed;
  useEffect(() => {
    if (themeSource === "matugen") {
      Promise.all([
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path")
      ]).then(([{ readTextFile }, { BaseDirectory }]) => {
        readTextFile("colors.json", { baseDir: BaseDirectory.AppConfig })
          .then((text) => {
            try {
              const colors = JSON.parse(text);
              applyMatugenTheme(colors, mode);
            } catch (e) {
              console.error("Invalid matugen colors.json", e);
              applyTheme({ seed: activeSeed, mode });
            }
          })
          .catch((err) => {
            console.error("Could not read matugen colors.json", err);
            applyTheme({ seed: activeSeed, mode });
          });
      }).catch((err) => {
        console.error("Tauri APIs not available", err);
        applyTheme({ seed: activeSeed, mode });
      });
    } else {
      applyTheme({ seed: activeSeed, mode });
    }
  }, [themeSource, activeSeed, mode]);

  /**
   * Undo history for the settings object.
   *
   * Entries are coalesced by time rather than by key: dragging a slider fires a
   * patch per pixel of travel, and an undo stack that recorded each one would
   * take fifty presses to walk back a single gesture. A pause longer than
   * COALESCE_MS is what marks the end of an edit.
   */
  const past = useRef<Settings[]>([]);
  const future = useRef<Settings[]>([]);
  const lastPush = useRef(0);

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((s) => {
      const now = Date.now();
      if (now - lastPush.current > COALESCE_MS) {
        past.current = [...past.current.slice(-HISTORY_LIMIT), s];
        future.current = [];
      }
      lastPush.current = now;
      return { ...s, ...p };
    });
  }, []);

  const undo = useCallback(() => {
    setSettings((s) => {
      const prev = past.current.pop();
      if (!prev) return s;
      future.current.push(s);
      // Force the next patch to open a fresh entry, so an edit made right after
      // an undo does not overwrite the state we just stepped back to.
      lastPush.current = 0;
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    setSettings((s) => {
      const next = future.current.pop();
      if (!next) return s;
      past.current.push(s);
      lastPush.current = 0;
      return next;
    });
  }, []);

  // The scaled source is what actually feeds the dither pass.
  const source = useMemo(
    () => (native ? downscale(native, settings.pixelScale) : null),
    [native, settings.pixelScale],
  );

  const [viewport, setViewport] = useState<Rect | null>(null);
  const {
    coarse,
    coarseScale,
    fine,
    region,
    busy,
    refining,
    ms,
    degraded,
    backendLabel,
    exporting,
    error,
    requestExport,
  } = useDither(source, settings, viewport);
  const hasResult = Boolean(coarse);

  const load = useCallback(
    async (file: File) => {
      setDecoding(true);
      try {
        const { data, clampedFrom } = await decode(file);
        setNative(data);
        setFileName(file.name);
        setDynamicSeed(seedFromImageData(data));
        if (clampedFrom) {
          snack(
            t("app.loadedReduced")
              .replace("{name}", file.name)
              .replace("{fw}", String(clampedFrom.width))
              .replace("{fh}", String(clampedFrom.height))
              .replace("{w}", String(data.width))
              .replace("{h}", String(data.height)),
          );
        } else {
          snack(t("app.loaded").replace("{name}", file.name).replace("{w}", String(data.width)).replace("{h}", String(data.height)));
        }
      } catch (err) {
        snack(t("app.loadFailed").replace("{name}", file.name).replace("{error}", (err as Error).message), "error");
      } finally {
        setDecoding(false);
      }
    },
    [snack],
  );

  /**
   * Export runs through the render worker at native resolution and encodes
   * there too, so the UI stays responsive for the whole job. The result is
   * the exact pixels a full-resolution preview of these settings would show.
   */
  const exportPng = useCallback(async () => {
    if (!source || exporting) return;
    const result = await requestExport(settings);
    if (result === "cancelled") return;
    const base = fileName.replace(/\.[^.]+$/, "") || "dizako";
    try {
      const saved = await savePng(result.blob, `${base}-${settings.algorithm}.png`);
      if (saved === "saved") snack(t("app.exported"));
    } catch {
      snack(t("app.couldNotWrite"), "error");
    }
  }, [source, settings, fileName, snack, t, exporting, requestExport]);

  // Persist everything that used to reset on launch.
  useEffect(() => {
    saveSession(settings, { mode, themeSource, seed, wheelStep });
  }, [settings, mode, themeSource, seed, wheelStep]);

  /**
   * App-level keyboard and pointer behaviour.
   *
   * Dizako runs in a web view but is not a web page: the browser defaults that
   * leak through are all wrong here. Ctrl+Z should step the edit history rather
   * than do nothing, Ctrl+A should not paint the entire chrome in selection
   * blue, and a right click on the stage should not offer to reload or save an
   * image that is not a real element.
   */
  useEffect(() => {
    const editable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        if (editable(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "y") {
        if (editable(e.target)) return;
        e.preventDefault();
        redo();
      } else if (k === "o") {
        // Editor-standard open; the browser file dialog default is useless here.
        e.preventDefault();
        inputRef.current?.click();
      } else if (k === "e" || k === "s") {
        // Ctrl+E exports; Ctrl+S is accepted as the muscle-memory alias.
        if (editable(e.target)) return;
        e.preventDefault();
        void exportPng();
      } else if (k === "a") {
        // Inside a field, select-all is exactly right; anywhere else it selects
        // every label in the UI, which is only ever an accident.
        if (!editable(e.target)) e.preventDefault();
      } else if (k === "=" || k === "+" || k === "-" || k === "0") {
        // Ctrl+/-/0 are page-zoom hotkeys in every WebView; Dizako zooms the
        // canvas itself, so these must never scale the chrome.
        e.preventDefault();
      }
    };

    // Kept as one handler so re-enabling a real context menu later is a matter
    // of routing the event rather than finding where it was suppressed.
    const onContextMenu = (e: MouseEvent) => {
      if (editable(e.target)) return;
      e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [undo, redo, exportPng]);

  /**
   * Trackpad gestures that browsers steal for themselves.
   *
   * - Pinch (ctrl/meta + wheel) must never page-zoom the shell; the preview
   *   stage owns pinch and zooms only the canvas.
   * - Two-finger left/right maps to undo/redo. Progress is scrubbed live so
   *   the arrow/rail animation follows the fingers; an idle gap ends the
   *   gesture (commit past the arm threshold, otherwise snap back).
   */
  useEffect(() => {
    const COMMIT_PX = 140;
    const ARM_PROGRESS = 0.55;
    const IDLE_MS = 130;
    const FLICK_PX_PER_MS = 1.35;

    type Dir = "back" | "forward";
    const frame = () => historyFrameRef.current;
    const swipe = {
      dir: null as Dir | null,
      progress: 0,
      lastTs: 0,
      velocity: 0,
      settling: false,
      idleTimer: 0 as number | undefined,
      raf: 0 as number | undefined,
      scrubRaf: 0 as number | undefined,
      paintedDir: null as Dir | null,
      paintedArmed: false,
      paintedSettling: false,
      paintedSwiping: false,
    };

    const paintVisual = (progress: number, dir: Dir | null, settling: boolean) => {
      const el = frame();
      if (!el) return;
      const p = Math.min(1, Math.max(0, progress));
      el.style.setProperty("--history-p", p.toFixed(4));

      const swiping = p > 0.001 || settling;
      const armed = p >= ARM_PROGRESS;
      if (dir !== swipe.paintedDir) {
        if (dir) el.dataset.dir = dir;
        else delete el.dataset.dir;
        swipe.paintedDir = dir;
      }
      if (swiping !== swipe.paintedSwiping) {
        el.classList.toggle("is-swiping", swiping);
        swipe.paintedSwiping = swiping;
      }
      if (armed !== swipe.paintedArmed) {
        el.classList.toggle("is-armed", armed);
        swipe.paintedArmed = armed;
      }
      if (settling !== swipe.paintedSettling) {
        el.classList.toggle("is-settling", settling);
        swipe.paintedSettling = settling;
      }
    };

    /** Scrub updates coalesce to one paint per frame; settles paint immediately. */
    const applyVisual = (progress: number, dir: Dir | null, settling: boolean) => {
      if (settling) {
        if (swipe.scrubRaf !== undefined) {
          cancelAnimationFrame(swipe.scrubRaf);
          swipe.scrubRaf = undefined;
        }
        paintVisual(progress, dir, true);
        return;
      }
      if (swipe.scrubRaf !== undefined) return;
      swipe.scrubRaf = requestAnimationFrame(() => {
        swipe.scrubRaf = undefined;
        paintVisual(swipe.progress, swipe.dir, false);
      });
    };

    const stopRaf = () => {
      if (swipe.raf !== undefined) {
        cancelAnimationFrame(swipe.raf);
        swipe.raf = undefined;
      }
      if (swipe.scrubRaf !== undefined) {
        cancelAnimationFrame(swipe.scrubRaf);
        swipe.scrubRaf = undefined;
      }
    };

    const animateTo = (target: number, ms: number, onDone?: () => void) => {
      stopRaf();
      const start = swipe.progress;
      const t0 = performance.now();
      swipe.settling = true;
      applyVisual(start, swipe.dir, true);
      const tick = (now: number) => {
        const t = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
        const eased = 1 - (1 - t) ** 3;
        swipe.progress = start + (target - start) * eased;
        applyVisual(swipe.progress, swipe.dir, true);
        if (t < 1) {
          swipe.raf = requestAnimationFrame(tick);
          return;
        }
        swipe.raf = undefined;
        onDone?.();
      };
      swipe.raf = requestAnimationFrame(tick);
    };

    const resetSwipe = () => {
      swipe.dir = null;
      swipe.progress = 0;
      swipe.velocity = 0;
      swipe.settling = false;
      if (swipe.scrubRaf !== undefined) {
        cancelAnimationFrame(swipe.scrubRaf);
        swipe.scrubRaf = undefined;
      }
      paintVisual(0, null, false);
    };

    const finish = () => {
      if (swipe.settling || !swipe.dir) return;
      const dir = swipe.dir;
      const flick = Math.abs(swipe.velocity) >= FLICK_PX_PER_MS;
      const armed = swipe.progress >= ARM_PROGRESS || (flick && swipe.progress > 0.2);
      const canCommit =
        dir === "back" ? past.current.length > 0 : future.current.length > 0;

      if (armed && canCommit) {
        animateTo(1, flick ? 90 : 160, () => {
          if (dir === "back") undo();
          else redo();
          animateTo(0, flick ? 120 : 220, resetSwipe);
        });
      } else {
        animateTo(0, flick && armed ? 140 : 200, resetSwipe);
      }
    };

    const canScrollX = (el: Element | null) => {
      for (let n = el as HTMLElement | null; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        const ox = style.overflowX;
        if (ox === "auto" || ox === "scroll") {
          return n.scrollWidth > n.clientWidth + 1;
        }
        if (n === document.body) break;
      }
      return false;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        return;
      }

      // Canvas owns two-finger pan/orbit and pinch-zoom; never treat those as
      // edit-history back/forth.
      const overPreview = (e.target as Element | null)?.closest?.(".preview__stage");
      if (overPreview) return;

      const absX = Math.abs(e.deltaX);
      const absY = Math.abs(e.deltaY);
      if (absX <= absY || absX === 0) return;
      if (canScrollX(e.target as Element | null)) return;
      if (swipe.settling) return;

      e.preventDefault();

      const now = performance.now();
      const dt = Math.max(8, now - (swipe.lastTs || now));
      // Positive deltaX ≈ fingers left → forward (redo).
      const nextDir: Dir = e.deltaX > 0 ? "forward" : "back";
      const delta = Math.abs(e.deltaX);
      swipe.lastTs = now;

      if (!swipe.dir) {
        swipe.dir = nextDir;
      } else if (nextDir !== swipe.dir) {
        // Fingers reversed: scrub the rail closed instead of flipping sides.
        swipe.velocity = -(delta / dt);
        swipe.progress = Math.max(0, swipe.progress - delta / COMMIT_PX);
        if (swipe.progress <= 0.001) {
          swipe.dir = null;
          swipe.progress = 0;
          swipe.velocity = 0;
          applyVisual(0, null, false);
        } else {
          applyVisual(swipe.progress, swipe.dir, false);
        }
        if (swipe.idleTimer !== undefined) window.clearTimeout(swipe.idleTimer);
        swipe.idleTimer = window.setTimeout(finish, IDLE_MS);
        return;
      }

      swipe.velocity = delta / dt;
      swipe.progress = Math.min(1, swipe.progress + delta / COMMIT_PX);
      applyVisual(swipe.progress, swipe.dir, false);

      if (swipe.idleTimer !== undefined) window.clearTimeout(swipe.idleTimer);
      swipe.idleTimer = window.setTimeout(finish, IDLE_MS);
    };

    const killGesture = (e: Event) => e.preventDefault();

    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    document.addEventListener("gesturestart", killGesture, { passive: false });
    document.addEventListener("gesturechange", killGesture, { passive: false });
    document.addEventListener("gestureend", killGesture, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener("gesturestart", killGesture);
      document.removeEventListener("gesturechange", killGesture);
      document.removeEventListener("gestureend", killGesture);
      if (swipe.idleTimer !== undefined) window.clearTimeout(swipe.idleTimer);
      stopRaf();
    };
  }, [undo, redo]);

  // Custom chrome owns the titlebar (decorations: false), so the system
  // double-click-to-maximise gesture has to be re-created on the drag region.
  const onTopbarDoubleClick = useCallback(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow().toggleMaximize(),
    );
  }, []);

  // Global drag & drop.
  useEffect(() => {
    // Only a drag carrying files is an import; dragging the preview around
    // must not raise the drop veil.
    const carriesFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const over = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setDragOver(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file?.type.startsWith("image/")) void load(file);
      else if (file) snack(t("app.notImage"), "error");
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [load, snack]);

  return (
    <WheelStepContext.Provider value={wheelStep}>
    <div
      ref={historyFrameRef}
      className="history-frame"
      style={{ ["--history-p" as string]: 0 }}
    >
      <div className="history-rail history-rail--back" aria-hidden="true">
        <span className="history-rail__glyph">
          <IconBack />
        </span>
      </div>
    <div className={`app ${dragOver ? "is-dragging" : ""}`}>
      <header className="topbar" data-tauri-drag-region onDoubleClick={onTopbarDoubleClick}>
        <div className="topbar__brand">
          <img src="/icon.png" alt="Dizako logo" className="topbar__mark" draggable={false} />
          <div>
            <h1 className="topbar__title">Dizako</h1>
            <p className="topbar__sub">{fileName || t("topbar.noImage")}</p>
          </div>
        </div>

        <div className="topbar__actions">
          <Button variant="outlined" icon={<IconUpload />} onClick={() => inputRef.current?.click()}>
            {t("topbar.open")}
          </Button>
          <Button
            variant="filled"
            icon={<IconDownload />}
            disabled={!hasResult || exporting}
            onClick={() => void exportPng()}
          >
            {exporting ? t("topbar.exporting") : t("topbar.export")}
          </Button>
          <Button
            variant="donate"
            icon={<IconFavorite />}
            onClick={() => void openDonatePage()}
            title={t("topbar.donateHint")}
          >
            {t("topbar.donate")}
          </Button>
          <WindowControls />
        </div>
      </header>

      <div className="app__body">
        <nav className="rail" aria-label="Controls">
          {TABS.map((tabItem) => (
            <button
              key={tabItem.id}
              className={`rail__item ${tabItem.id === tab ? "is-selected" : ""}`}
              aria-current={tabItem.id === tab ? "page" : undefined}
              onClick={() => setTab(tabItem.id)}
            >
              <span className="rail__pill">{tabItem.icon}</span>
              <span className="rail__label">{t(`tabs.${tabItem.id}`)}</span>
            </button>
          ))}

          {/* Pinned to the foot of the rail so it shares the tabs' X position -
              it is app-level, not another view of the image. */}
          <span className="rail__spacer" />
          <button
            className="rail__item rail__item--foot"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
          >
            <span className="rail__pill">
              <IconSettings />
            </span>
            <span className="rail__label">{t("settings.title")}</span>
          </button>
        </nav>

        <aside className={`sidebar ${tab === "palette" ? "sidebar--wide" : ""}`}>
          {tab === "algorithm" && <AlgorithmPanel settings={settings} patch={patch} />}
          {tab === "palette" && (
            <PalettePanel settings={settings} patch={patch} source={source} />
          )}
          {tab === "image" && (
            <AdjustPanel
              settings={settings}
              patch={patch}
              sourceSize={native ? { width: native.width, height: native.height } : null}
            />
          )}
        </aside>

        <main className="stage">
          {native ? (
            <PreviewCanvas
              original={source}
              coarse={coarse}
              coarseScale={coarseScale}
              fine={fine}
              region={region}
              busy={busy}
              refining={refining}
              ms={ms}
              degraded={degraded}
              backendLabel={backendLabel}
              error={error}
              onViewport={setViewport}
            />
          ) : decoding ? (
            <div className="empty">
              <span className="preview__spinner" aria-hidden="true" />
              <h2 className="empty__title">{t("empty.readingTitle")}</h2>
              <p className="empty__body">{t("empty.readingBody")}</p>
            </div>
          ) : (
            <div className="empty">
              <div className="empty__art" aria-hidden="true">
                <IconImage />
              </div>
              <h2 className="empty__title">{t("empty.dropTitle")}</h2>
              <p className="empty__body">{t("empty.dropBody")}</p>
              <Button variant="filled" icon={<IconUpload />} onClick={() => inputRef.current?.click()}>
                Choose image
              </Button>
            </div>
          )}
        </main>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void load(f);
          e.target.value = "";
        }}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        mode={mode}
        onMode={setMode}
        source={themeSource}
        onSource={setThemeSource}
        seed={seed}
        onSeed={setSeed}
        wheelStep={wheelStep}
        onWheelStep={setWheelStep}
        dynamicSeed={dynamicSeed}
        hasImage={Boolean(native)}
      />

      {dragOver && (
        <div className="dropveil">
          <div className="dropveil__card">
            <IconUpload />
            <span>{t("empty.dropToLoad") || "Drop to load"}</span>
          </div>
        </div>
      )}
    </div>
      <div className="history-rail history-rail--forward" aria-hidden="true">
        <span className="history-rail__glyph">
          <IconForward />
        </span>
      </div>
    </div>
    </WheelStepContext.Provider>
  );
}
