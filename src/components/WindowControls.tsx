import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconClose, IconMaximize, IconMinimize } from "./Icons";

/**
 * Replaces the system title bar, which is switched off in tauri.conf.json.
 * Rendered only under Tauri - in a plain browser there is no window to control.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const { t } = useI18n();
  const underTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;


  useEffect(() => {
    if (!underTauri) return;
    const w = getCurrentWindow();
    void w.isMaximized().then(setMaximized);
    const unlisten = w.onResized(() => void w.isMaximized().then(setMaximized));
    return () => void unlisten.then((f) => f());
  }, [underTauri]);

  if (!underTauri) return null;
  const w = getCurrentWindow();

  return (
    <div className="wincontrols">
      <button className="wincontrol" aria-label={t("win.minimise")} onClick={() => void w.minimize()}>
        <IconMinimize />
      </button>
      <button
        className="wincontrol"
        aria-label={maximized ? t("win.restore") : t("win.maximise")}
        onClick={() => void w.toggleMaximize()}
      >
        <IconMaximize />
      </button>
      <button
        className="wincontrol wincontrol--close"
        aria-label={t("win.close")}
        onClick={() => void w.close()}
      >
        <IconClose />
      </button>
    </div>
  );
}
