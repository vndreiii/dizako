import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconClose, IconMaximize, IconMinimize } from "./Icons";

/**
 * Replaces the system title bar, which is switched off in tauri.conf.json.
 * Rendered only under Tauri - in a plain browser there is no window to control.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
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
      <button className="wincontrol" aria-label="Minimise" onClick={() => void w.minimize()}>
        <IconMinimize />
      </button>
      <button
        className="wincontrol"
        aria-label={maximized ? "Restore" : "Maximise"}
        onClick={() => void w.toggleMaximize()}
      >
        <IconMaximize />
      </button>
      <button
        className="wincontrol wincontrol--close"
        aria-label="Close"
        onClick={() => void w.close()}
      >
        <IconClose />
      </button>
    </div>
  );
}
