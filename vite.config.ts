import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    // esnext risks shipping syntax WebKitGTK's JavaScriptCore cannot parse
    // (there is no ES-version guard at runtime); es2022 costs nothing.
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    // The worker now code-splits (dynamic wasm-glue import); IIFE cannot.
    format: "es",
  },
  optimizeDeps: {
    // The wasm glue resolves its .wasm asset relative to import.meta.url;
    // letting the dep optimizer rewrite it breaks that in workers.
    exclude: ["dither-wasm"],
  },
});
