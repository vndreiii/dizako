import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Imported rather than read from disk so the config needs no Node typings.
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  define: {
    // Diagnostics need the shipped version; reading package.json at runtime is
    // not an option inside the bundle.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // esnext risks shipping syntax WebKitGTK's JavaScriptCore cannot parse
    // (there is no ES-version guard at runtime); es2022 costs nothing.
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    // Compressed-size reporting gzips every chunk purely to print a number.
    reportCompressedSize: false,
    cssMinify: "esbuild",
    rollupOptions: {
      output: {
        /**
         * Keep the framework and the locale table out of the app chunk.
         *
         * React barely changes between releases and the translation table
         * changes independently of the code, so splitting them means a patch
         * release re-downloads the part that actually changed. Inside the
         * desktop shell the files are local, but the parse and the update
         * delta both still benefit.
         */
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          if (id.includes("material-color-utilities")) return "color";
          if (id.includes("locales/translations.json")) return "locales";
          return undefined;
        },
      },
    },
  },
  esbuild: {
    // `debugger` statements have no business in a shipped desktop binary.
    drop: ["debugger"],
    legalComments: "none",
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
