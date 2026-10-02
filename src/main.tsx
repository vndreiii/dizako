import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/roboto-flex";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/500.css";
import "./theme/tokens.css";
import "./theme/components.css";
import "./theme/app.css";
import "./theme/fields.css";
import "./theme/palette.css";
import "./theme/settings.css";
import App from "./App";
import { NotifyProvider } from "./components/notify";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";

// Forward webview console to the Rust log (stdout) so `dizako` from a
// terminal shows renderer-side warnings and errors. No-op in browser mode.
if ("__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/plugin-log").then((m) => void m.attachConsole());
}

const container = document.getElementById("root");
if (!container) {
  // The only way here is a corrupted bundle; a blank window with nothing in the
  // console is the one outcome worth spending eight lines to avoid.
  document.body.innerHTML =
    '<div style="font:600 16px system-ui;padding:32px">Dizako could not start: the application root element is missing.</div>';
} else {
  createRoot(container).render(
    <StrictMode>
      <I18nProvider>
        <NotifyProvider>
          {/* Inside the notifier so a crash dialog can still be themed, but
              self-contained so it does not depend on it. */}
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </NotifyProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
