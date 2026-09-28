import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdjustPanel } from "./components/AdjustPanel";
import { AlgorithmPanel } from "./components/AlgorithmPanel";
import { PalettePanel } from "./components/PalettePanel";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { VideoTimeline } from "./components/VideoTimeline";
import { VideoExportDialog, type VideoExportConfig } from "./components/VideoExportDialog";
import { useI18n } from "./i18n";
import { Button } from "./components/primitives";
import { useGlobalFailureHandlers, useNotify } from "./components/notify";
import {
  IconDownload,
  IconFavorite,
  IconGrid,
  IconImage,
  IconMovie,
  IconPalette,
  IconSettings,
  IconTune,
  IconUpload,
  IconBack,
  IconForward,
} from "./components/Icons";
import { SettingsSheet } from "./components/SettingsSheet";
import { DonateDialog } from "./components/DonateDialog";
import { WheelStepContext } from "./components/primitives";
import { WindowControls } from "./components/WindowControls";
import { openDonatePage } from "./donate";
import { checkForUpdates, installUpdate, LATER_MS, rememberUpdateChoice, updatePromptDelay } from "./updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { useDither } from "./hooks/useDither";
import { useVideoClip } from "./hooks/useVideoClip";
import type { Rect } from "./dither/region";
import { savePng, savePngSequence, saveVideo } from "./hooks/saveImage";
import { DEFAULT_SETTINGS, type Settings } from "./dither/types";
import { loadSession, saveSession } from "./session";
import { appError, isAppError } from "./errors";
import { looksLikeVideo, VIDEO_EXTENSIONS } from "./video/clip";
import { probeEncoders } from "./video/encode";
import { exportVideo, type ExportPhaseProgress } from "./video/export";
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

/** Everything the file picker and drop target will take. */
const ACCEPT = `image/*,video/*,${VIDEO_EXTENSIONS.map((e) => `.${e}`).join(",")}`;

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
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (err) {
    throw appError("image/decode-failed", {
      values: { name: file.name },
      detail: `createImageBitmap rejected ${file.name} (${file.type || "unknown type"}, ${file.size} bytes): ${String(err)}`,
      cause: err,
    });
  }
  const scale = fitWithinLimits(bitmap.width, bitmap.height);
  const w = Math.max(1, Math.floor(bitmap.width * scale));
  const h = Math.max(1, Math.floor(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw appError("image/no-2d-context", { detail: `getContext("2d") returned null for ${w}×${h}` });
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
  if (!opaque) {
    throw appError("image/empty-after-decode", {
      values: { name: file.name },
      detail: `every pixel of the ${w}×${h} decode was fully transparent`,
    });
  }

  return { data, clampedFrom };
}

/** Box-downsample via canvas, used for the pixel-scale control. */
const pixelScaleCache = new WeakMap<ImageData, Map<number, ImageData>>();

function downscale(src: ImageData, factor: number): ImageData {
  if (factor <= 1) return src;
  // Memoised per (plane, factor): without it every slider tick elsewhere in the
  // app re-ran a multi-megapixel canvas round-trip that produces identical
  // pixels every time.
  let byFactor = pixelScaleCache.get(src);
  if (!byFactor) {
    byFactor = new Map();
    pixelScaleCache.set(src, byFactor);
  }
  const hit = byFactor.get(factor);
  if (hit) return hit;

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
  const out = ctx.getImageData(0, 0, w, h);
  byFactor.set(factor, out);
  return out;
}

/** Read once per launch; every key falls back to defaults when absent. */
const restoredSession = loadSession();

export default function App() {
  const { t } = useI18n();
  const notify = useNotify();
  const installGlobalHandlers = useGlobalFailureHandlers();
  const [settings, setSettings] = useState<Settings>(restoredSession.settings ?? DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>("algorithm");
  const [still, setStill] = useState<ImageData | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<Mode>(() => restoredSession.appearance?.mode ?? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
  const [seed, setSeed] = useState(restoredSession.appearance?.seed ?? DEFAULT_SEED);
  const [themeSource, setThemeSource] = useState<ThemeSource>(restoredSession.appearance?.themeSource ?? "preset");
  const [wheelStep, setWheelStep] = useState(restoredSession.appearance?.wheelStep ?? 2);
  const [wheelBehavior, setWheelBehavior] = useState<"pan" | "zoom">(
    restoredSession.appearance?.wheelBehavior === "zoom" ? "zoom" : "pan",
  );
  const [dynamicSeed, setDynamicSeed] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyFrameRef = useRef<HTMLDivElement>(null);

  // A single funnel for every failure, so a call site never has to decide
  // between a toast, a dialog and a console line.
  const fail = notify.fail;
  const video = useVideoClip(fail);

  useEffect(() => installGlobalHandlers(), [installGlobalHandlers]);

  // Ask before downloading a signed update. Later is offered again after 24h;
  // Dismiss hides only this version, so a newer release can still be offered.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let offered: Update | null = null;

    const check = async () => {
      try {
        const update = await checkForUpdates();
        if (!update) return;
        if (cancelled) {
          void update.close();
          return;
        }
        const delay = updatePromptDelay(update.version);
        if (delay !== 0) {
          void update.close();
          if (delay !== null) timer = window.setTimeout(() => void check(), delay);
          return;
        }

        offered = update;
        const choose = (choice: "later" | "dismiss") => {
          rememberUpdateChoice(update.version, choice);
          notify.prompt(null);
          offered = null;
          void update.close();
          if (choice === "later") timer = window.setTimeout(() => void check(), LATER_MS);
        };
        notify.prompt({
          text: t("update.available").replace("{version}", update.version),
          actions: [
            {
              label: t("update.install"),
              onClick: () => {
                notify.prompt(null);
                offered = null;
                void installUpdate(update, (status) => notify.toast(t(`update.${status}`))).catch((err) => {
                  fail(appError("update/install-failed", { detail: String(err), cause: err }), {
                    onRecover: () => void check(),
                  });
                  void update.close();
                  if (!cancelled) timer = window.setTimeout(() => void check(), 60_000);
                });
              },
            },
            { label: t("update.later"), onClick: () => choose("later") },
            { label: t("update.dismiss"), onClick: () => choose("dismiss") },
          ],
        });
      } catch (err) {
        // A failed check is not worth a dialog: the app works, it just does not
        // know whether it is current.
        fail(appError("update/check-failed", { detail: String(err), cause: err }), { as: "toast" });
      }
    };

    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      notify.prompt(null);
      if (offered) void offered.close();
    };
  }, [notify, fail, t]);

  // In dynamic mode the accent follows the image; falls back to the chosen
  // preset until one is loaded.
  const activeSeed = themeSource === "dynamic" ? (dynamicSeed ?? seed) : seed;
  useEffect(() => {
    if (themeSource !== "matugen") {
      applyTheme({ seed: activeSeed, mode });
      return;
    }
    Promise.all([import("@tauri-apps/plugin-fs"), import("@tauri-apps/api/path")])
      .then(async ([{ readTextFile }, { BaseDirectory }]) => {
        const text = await readTextFile("colors.json", { baseDir: BaseDirectory.AppConfig });
        try {
          applyMatugenTheme(JSON.parse(text), mode);
        } catch (err) {
          applyTheme({ seed: activeSeed, mode });
          throw appError("theme/matugen-invalid", { detail: String(err), cause: err });
        }
      })
      .catch((err) => {
        applyTheme({ seed: activeSeed, mode });
        fail(isAppError(err) ? err : appError("theme/matugen-unreadable", { detail: String(err), cause: err }), {
          as: "toast",
          onRecover: () => setSettingsOpen(true),
        });
      });
  }, [themeSource, activeSeed, mode, fail]);

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

  /**
   * The pixels currently being dithered.
   *
   * A still and a video frame are the same thing to everything downstream, so
   * the whole pipeline - algorithms, palette, adjustments, undo, PNG export -
   * works on video without a second code path.
   */
  const native = video.clip ? video.frameImage : still;

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
  } = useDither(source, settings, viewport, { skipFine: video.playing });
  const hasResult = Boolean(coarse);

  /**
   * The plane the palette panel's eyedropper reads.
   *
   * `source` is a different object on every displayed frame while a clip
   * plays, and the eyedropper rasterises a strip from whatever it is handed -
   * sixty times a second, for a control nobody is using mid-playback. Withheld
   * during playback, the panel drops out of the per-frame render path entirely
   * and the picker comes back the moment the playhead stops.
   */
  const pickerSource = video.playing ? null : source;

  // Memoised so `AdjustPanel`'s memo boundary actually holds: a fresh object
  // literal per render would defeat it on every frame of playback.
  const sourceSize = useMemo(
    () => (native ? { width: native.width, height: native.height } : null),
    [native],
  );

  // The engine failing outright is not something the HUD caption can carry on
  // its own - it means nothing will ever render - so it is also raised once.
  const reportedEngineError = useRef<string | null>(null);
  useEffect(() => {
    if (!error || reportedEngineError.current === error) return;
    reportedEngineError.current = error;
    fail(appError("engine/unavailable", { detail: error }));
  }, [error, fail]);

  // Demotion still renders, just slower; a toast is the right weight for it.
  const reportedDemotion = useRef(false);
  useEffect(() => {
    if (!degraded || reportedDemotion.current) return;
    reportedDemotion.current = true;
    fail(appError("engine/worker-demoted", { detail: `backend is now "${backendLabel}"` }), { as: "toast" });
  }, [degraded, backendLabel, fail]);

  const loadStill = useCallback(
    async (file: File) => {
      setDecoding(true);
      try {
        const { data, clampedFrom } = await decode(file);
        video.close();
        setStill(data);
        setFileName(file.name);
        setDynamicSeed(seedFromImageData(data));
        if (clampedFrom) {
          notify.toast(
            t("app.loadedReduced")
              .replace("{name}", file.name)
              .replace("{fw}", String(clampedFrom.width))
              .replace("{fh}", String(clampedFrom.height))
              .replace("{w}", String(data.width))
              .replace("{h}", String(data.height)),
            { tone: "warning" },
          );
        } else {
          notify.toast(
            t("app.loaded").replace("{name}", file.name).replace("{w}", String(data.width)).replace("{h}", String(data.height)),
            { tone: "success" },
          );
        }
      } catch (err) {
        fail(err, { onRecover: () => inputRef.current?.click(), context: { file: file.name, type: file.type } });
      } finally {
        setDecoding(false);
      }
    },
    [fail, notify, t, video],
  );

  const loadClip = useCallback(
    async (file: File) => {
      const ok = await video.open(file);
      if (!ok) return;
      setStill(null);
      setFileName(file.name);
      notify.toast(t("video.loaded").replace("{name}", file.name), { tone: "success" });
    },
    [notify, t, video],
  );

  /** Routes a dropped or picked file to the still or the clip path. */
  const load = useCallback(
    async (file: File) => {
      if (file.type.startsWith("image/") && !file.type.startsWith("image/gif")) {
        await loadStill(file);
        return;
      }
      if (looksLikeVideo(file)) {
        await loadClip(file);
        return;
      }
      // Some hosts report no type at all for a dragged file. An image decode is
      // cheap and tells us definitively, so try it before refusing.
      try {
        await loadStill(file);
      } catch {
        fail(appError("image/not-an-image", { values: { name: file.name }, detail: `type "${file.type}"` }), {
          onRecover: () => inputRef.current?.click(),
        });
      }
    },
    [fail, loadClip, loadStill],
  );

  // A clip's accent follows its first frame, computed once rather than per
  // frame - the palette must not strobe while the video plays.
  const seededClip = useRef<string | null>(null);
  useEffect(() => {
    if (!video.clip || !video.frameImage) return;
    if (seededClip.current === video.clip.url) return;
    seededClip.current = video.clip.url;
    setDynamicSeed(seedFromImageData(video.frameImage));
  }, [video.clip, video.frameImage]);

  /**
   * Export runs through the render worker at native resolution and encodes
   * there too, so the UI stays responsive for the whole job. The result is
   * the exact pixels a full-resolution preview of these settings would show.
   */
  // Retry actions re-enter the very callback that raised the failure, which a
  // closure cannot reference before it exists. A ref holding the newest one is
  // read at click time, long after both are defined.
  const retryExportPng = useRef<() => void>(() => {});
  const retryVideoExport = useRef<(config: VideoExportConfig) => void>(() => {});

  const exportPng = useCallback(async () => {
    if (!source || exporting) return;
    let result: Awaited<ReturnType<typeof requestExport>>;
    try {
      result = await requestExport(settings);
    } catch (err) {
      fail(appError("export/render-failed", { detail: String(err), cause: err }), {
        onRecover: () => retryExportPng.current(),
      });
      return;
    }
    if (result === "cancelled") return;
    const base = fileName.replace(/\.[^.]+$/, "") || "dizako";
    const suffix = video.clip ? `${settings.algorithm}-f${String(video.frame).padStart(5, "0")}` : settings.algorithm;
    try {
      const saved = await savePng(result.blob, `${base}-${suffix}.png`);
      if (saved === "saved") notify.toast(t("app.exported"), { tone: "success" });
    } catch (err) {
      fail(isAppError(err) ? err : appError("export/write-failed", { detail: String(err), cause: err }), {
        onRecover: () => retryExportPng.current(),
      });
    }
  }, [source, settings, fileName, notify, t, exporting, requestExport, fail, video.clip, video.frame]);

  /* ---------------- video export ---------------- */

  const encoders = useMemo(() => probeEncoders(), []);
  const [exportOpen, setExportOpen] = useState(false);
  const [videoProgress, setVideoProgress] = useState<ExportPhaseProgress | null>(null);
  const [frameErrors, setFrameErrors] = useState(0);
  const cancelExport = useRef(false);

  const runVideoExport = useCallback(
    async (config: VideoExportConfig) => {
      const clip = video.clip;
      if (!clip) return;
      video.pause();
      cancelExport.current = false;
      setFrameErrors(0);
      setVideoProgress({ phase: "render", done: 0, total: 1, fraction: 0, etaS: null });

      const base = fileName.replace(/\.[^.]+$/, "") || "dizako";
      try {
        const result = await exportVideo({
          clip,
          settings,
          startFrame: config.startFrame,
          endFrame: config.endFrame,
          scale: config.scale,
          container: config.container,
          mimeType: config.mimeType,
          bitrate: config.bitrate,
          onProgress: setVideoProgress,
          shouldCancel: () => cancelExport.current,
          onFrameError: (index, err) => {
            // Counted for the progress line and logged individually: a report
            // that says "3 frames repeated" is only actionable with the reason.
            console.warn(`[dizako] frame ${index} could not be rendered; repeating the previous one`, err);
            setFrameErrors((n) => n + 1);
          },
        });

        const outcome =
          result.container === "png-sequence"
            ? await savePngSequence(result.frames!, `${base}-${settings.algorithm}`, (done, total) =>
                setVideoProgress({ phase: "mux", done, total, fraction: done / total, etaS: null }),
              )
            : await saveVideo(
                result.blob!,
                `${base}-${settings.algorithm}.${result.container === "mp4" ? "mp4" : "webm"}`,
                result.container === "mp4" ? "mp4" : "webm",
              );

        if (outcome === "cancelled") {
          notify.toast(t("video.saveCancelled"), { tone: "neutral" });
        } else {
          setExportOpen(false);
          const summary = t("video.exported")
            .replace("{frames}", String(result.frameCount))
            .replace("{w}", String(result.width))
            .replace("{h}", String(result.height))
            .replace("{seconds}", (result.renderMs / 1000).toFixed(1));
          if (result.substituted.length > 0) {
            // Silently shipping repeated frames would be a lie about what the
            // file contains, so the exact indices are on offer.
            void notify.dialog({
              title: t("video.exportedWithGaps"),
              body: summary,
              tone: "warning",
              detail: `substituted frames (${result.substituted.length}):\n${result.substituted.join(", ")}`,
            });
          } else {
            notify.toast(summary, { tone: "success", duration: 7000 });
          }
        }
      } catch (err) {
        if (isAppError(err) && err.code === "video/export-cancelled") {
          notify.toast(t("video.cancelled"), { tone: "neutral" });
        } else {
          fail(err, {
            onRecover: () => retryVideoExport.current(config),
            context: {
              container: config.container,
              mimeType: config.mimeType ?? "n/a",
              frames: config.endFrame - config.startFrame + 1,
              scale: config.scale,
            },
          });
        }
      } finally {
        setVideoProgress(null);
      }
    },
    [video, fileName, settings, notify, t, fail],
  );

  // eslint-disable-next-line react-hooks/refs -- latest-ref binding for the retry actions
  retryExportPng.current = () => void exportPng();
  // eslint-disable-next-line react-hooks/refs -- see above
  retryVideoExport.current = (config: VideoExportConfig) => void runVideoExport(config);

  // Persist everything that used to reset on launch.
  useEffect(() => {
    try {
      saveSession(settings, { mode, themeSource, seed, wheelStep, wheelBehavior });
    } catch (err) {
      fail(appError("session/save-failed", { detail: String(err), cause: err }), { as: "toast" });
    }
  }, [settings, mode, themeSource, seed, wheelStep, wheelBehavior, fail]);

  /**
   * App-level keyboard and pointer behaviour.
   *
   * Dizako runs in a web view but is not a web page: the browser defaults that
   * leak through are all wrong here. Ctrl+Z should step the edit history rather
   * than do nothing, Ctrl+A should not paint the entire chrome in selection
   * blue, and a right click on the stage should not offer to reload or save an
   * image that is not a real element.
   */
  const videoRef = useRef(video);
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern for a window listener
  videoRef.current = video;
  useEffect(() => {
    const editable = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      // Space is the universal transport key; it only means "play" when a clip
      // is open and the focus is not in a field.
      if (e.key === " " && !editable(e.target) && videoRef.current.clip) {
        e.preventDefault();
        videoRef.current.toggle();
        return;
      }
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
        if (e.shiftKey && videoRef.current.clip) setExportOpen(true);
        else void exportPng();
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
      // edit-history back/forth. The timeline scrubs, so it is exempt too.
      const target = e.target as Element | null;
      if (target?.closest?.(".preview__stage") || target?.closest?.(".timeline")) return;

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
      const files = e.dataTransfer?.files;
      const file = files?.[0];
      if (!file) return;
      if (files.length > 1) {
        notify.toast(t("app.firstOfMany").replace("{name}", file.name), { tone: "warning" });
      }
      void load(file);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [load, notify, t]);

  const reading = decoding || video.opening;
  const exportBusy = exporting || videoProgress !== null;

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
            disabled={!hasResult || exportBusy}
            onClick={() => void exportPng()}
          >
            {exporting ? t("topbar.exporting") : video.clip ? t("topbar.exportFrame") : t("topbar.export")}
          </Button>
          {video.clip && (
            <Button
              variant="tonal"
              icon={<IconMovie />}
              disabled={exportBusy}
              onClick={() => setExportOpen(true)}
            >
              {t("topbar.exportVideo")}
            </Button>
          )}
          <Button
            variant="donate"
            icon={<IconFavorite />}
            onClick={() => {
              void openDonatePage().then((ok) => {
                if (!ok) setDonateOpen(true);
              });
            }}
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

        <aside className={`sidebar ${tab === "palette" || tab === "algorithm" ? "sidebar--wide" : ""}`}>
          {tab === "algorithm" && <AlgorithmPanel settings={settings} patch={patch} />}
          {tab === "palette" && (
            <PalettePanel settings={settings} patch={patch} source={pickerSource} />
          )}
          {tab === "image" && (
            <AdjustPanel settings={settings} patch={patch} sourceSize={sourceSize} />
          )}
        </aside>

        <main className="stage">
          {native ? (
            <PreviewCanvas
              wheelBehavior={wheelBehavior}
              original={source}
              coarse={coarse}
              coarseScale={coarseScale}
              fine={fine}
              region={region}
              busy={busy}
              refining={refining}
              ms={ms}
              degraded={degraded}
              backendLabel={video.coarseFrames ? `${backendLabel} · ${t("video.playbackQuality")}` : backendLabel}
              error={error}
              onViewport={setViewport}
              footer={
                video.clip ? (
                  <VideoTimeline
                    clip={video.clip}
                    frame={video.frame}
                    playing={video.playing}
                    loop={video.loop}
                    range={video.range}
                    locked={videoProgress !== null}
                    onFrame={video.goToFrame}
                    onStep={video.step}
                    onToggle={video.toggle}
                    onLoop={video.setLoop}
                    onRange={video.setRange}
                    onExport={() => setExportOpen(true)}
                  />
                ) : null
              }
            />
          ) : reading ? (
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
                {t("empty.chooseBtn")}
              </Button>
            </div>
          )}
        </main>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
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
        wheelBehavior={wheelBehavior}
        onWheelBehavior={setWheelBehavior}
        dynamicSeed={dynamicSeed}
        hasImage={Boolean(native)}
      />

      {exportOpen && video.clip && (
        <VideoExportDialog
          clip={video.clip}
          encoders={encoders}
          range={video.range}
          progress={videoProgress}
          frameErrors={frameErrors}
          onStart={(config) => void runVideoExport(config)}
          onCancel={() => {
            cancelExport.current = true;
          }}
          onClose={() => setExportOpen(false)}
        />
      )}

      {donateOpen && <DonateDialog onClose={() => setDonateOpen(false)} />}

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
