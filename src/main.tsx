import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/roboto-flex";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/500.css";
import "./theme/tokens.css";
import "./theme/components.css";
import "./theme/app.css";
import App from "./App";
import { SnackbarProvider } from "./components/primitives";
import { I18nProvider } from "./i18n";

// Forward webview console to the Rust log (stdout) so `dizako` from a
// terminal shows renderer-side warnings and errors. No-op in browser mode.
if ("__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/plugin-log").then((m) => void m.attachConsole());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <SnackbarProvider>
        <App />
      </SnackbarProvider>
    </I18nProvider>
  </StrictMode>,
);
