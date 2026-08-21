import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdjustPanel } from "./components/AdjustPanel";
import { AlgorithmPanel } from "./components/AlgorithmPanel";
import { PalettePanel } from "./components/PalettePanel";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { Button, useSnackbar } from "./components/primitives";
import {
  IconDownload,
  IconGrid,
  IconImage,
  IconPalette,
  IconSettings,
  IconTune,
  IconUpload,
} from "./components/Icons";
import { SettingsSheet } from "./components/SettingsSheet";
import { WindowControls } from "./components/WindowControls";
import { useDither } from "./hooks/useDither";
import { dither } from "./dither/algorithms";
import type { Rect } from "./dither/region";
import { savePng } from "./hooks/saveImage";
import { DEFAULT_SETTINGS, type Settings } from "./dither/types";
import {
  applyTheme,
  applyMatugenTheme,
  DEFAULT_SEED,
  seedFromImageData,
  type Mode,
  type ThemeSource,
} from "./theme/theme";

type Tab = "algorithm" | "palette" | "image";

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "algorithm", label: "Algorithm", icon: <IconGrid /> },
  { id: "palette", label: "Palette", icon: <IconPalette /> },
  { id: "image", label: "Image", icon: <IconTune /> },
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

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>("algorithm");
  const [native, setNative] = useState<ImageData | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Mode>(() =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [themeSource, setThemeSource] = useState<ThemeSource>("preset");
  const [dynamicSeed, setDynamicSeed] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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
  const { coarse, coarseScale, fine, region, busy, refining, ms, degraded } = useDither(
    source,
    settings,
    viewport,
  );
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
            `Loaded ${file.name} - reduced from ${clampedFrom.width}×${clampedFrom.height} to ${data.width}×${data.height}`,
          );
        } else {
          snack(`Loaded ${file.name} (${data.width}×${data.height})`);
        }
      } catch (err) {
        snack(`Could not read ${file.name}: ${(err as Error).message}`, "error");
      } finally {
        setDecoding(false);
      }
    },
    [snack],
  );

  const exportPng = useCallback(() => {
    if (!source) return;
    // The preview is allowed to be coarse or cropped to the viewport; an export
    // never is. This runs its own full-resolution pass over the whole image.
    const full = dither(source, settings);
    const canvas = document.createElement("canvas");
    canvas.width = full.width;
    canvas.height = full.height;
    canvas.getContext("2d")!.putImageData(full, 0, 0);
    canvas.toBlob(async (blob) => {
      if (!blob) {
        snack("Export failed", "error");
        return;
      }
      const base = fileName.replace(/\.[^.]+$/, "") || "dizako";
      try {
        const result = await savePng(blob, `${base}-${settings.algorithm}.png`);
        if (result === "saved") snack("Exported PNG");
      } catch {
        snack("Could not write the file", "error");
      }
    }, "image/png");
  }, [source, settings, fileName, snack]);

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
      } else if (k === "a") {
        // Inside a field, select-all is exactly right; anywhere else it selects
        // every label in the UI, which is only ever an accident.
        if (!editable(e.target)) e.preventDefault();
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
  }, [undo, redo]);

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
      else if (file) snack("That file is not an image", "error");
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
    <div className={`app ${dragOver ? "is-dragging" : ""}`}>
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar__brand">
          <img src="/icon.png" alt="Dizako logo" className="topbar__mark" draggable={false} />
          <div>
            <h1 className="topbar__title">Dizako</h1>
            <p className="topbar__sub">{fileName || "No image loaded"}</p>
          </div>
        </div>

        <div className="topbar__actions">
          <Button variant="outlined" icon={<IconUpload />} onClick={() => inputRef.current?.click()}>
            Open
          </Button>
          <Button variant="filled" icon={<IconDownload />} disabled={!hasResult} onClick={exportPng}>
            Export
          </Button>
          <WindowControls />
        </div>
      </header>

      <div className="app__body">
        <nav className="rail" aria-label="Controls">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`rail__item ${t.id === tab ? "is-selected" : ""}`}
              aria-current={t.id === tab ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              <span className="rail__pill">{t.icon}</span>
              <span className="rail__label">{t.label}</span>
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
            <span className="rail__label">Settings</span>
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
              onViewport={setViewport}
            />
          ) : decoding ? (
            <div className="empty">
              <span className="preview__spinner" aria-hidden="true" />
              <h2 className="empty__title">Reading image…</h2>
              <p className="empty__body">Large images take a moment to decode.</p>
            </div>
          ) : (
            <div className="empty">
              <div className="empty__art" aria-hidden="true">
                <IconImage />
              </div>
              <h2 className="empty__title">Drop an image to begin</h2>
              <p className="empty__body">
                PNG, JPEG, WebP, GIF or AVIF. Everything is processed locally - nothing leaves your
                machine.
              </p>
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
        dynamicSeed={dynamicSeed}
        hasImage={Boolean(native)}
      />

      {dragOver && (
        <div className="dropveil">
          <div className="dropveil__card">
            <IconUpload />
            <span>Drop to load</span>
          </div>
        </div>
      )}
    </div>
  );
}
