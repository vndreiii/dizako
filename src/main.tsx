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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SnackbarProvider>
      <App />
    </SnackbarProvider>
  </StrictMode>,
);
