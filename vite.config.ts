import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { publicAgentInstructions } from "./scripts/lib/public-agent-instructions";

export default defineConfig({
  plugins: [react(), publicAgentInstructions()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@db": path.resolve(__dirname, "./db"),
    },
  },
  build: {
    target: "es2020",
    outDir: "dist",
    sourcemap: false,
    // Never base64-inline font files. Vite's default 4096-byte inline limit
    // otherwise embeds the smaller KaTeX faces (e.g. KaTeX_Size3-Regular.woff2,
    // ~3.6 KB) straight into the bundled CSS as `data:font/woff2;…` URLs. The
    // app ships a deliberately strict CSP (`font-src 'self' …`, no `data:`), so
    // the browser blocks those inlined fonts. Emitting every font as a real
    // `/assets/*.woff2` file keeps it served from `'self'` and the CSP intact.
    assetsInlineLimit(filePath) {
      if (/\.(woff2?|eot|ttf|otf)(\?.*)?$/i.test(filePath)) return false;
      return undefined;
    },
    rollupOptions: {
      output: {
        // Function form (not the object form) because rolldown-vite only
        // accepts a `manualChunks` callback — the object map throws
        // "manualChunks is not a function" at build time. The callback
        // reproduces the same vendor split: React core and the i18n runtime
        // are large and change rarely, so isolating them keeps browser
        // caches valid across app-code-only deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
              id,
            )
          ) {
            return "react-vendor";
          }
          if (
            /[\\/]node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector)[\\/]/.test(
              id,
            )
          ) {
            return "i18n-vendor";
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
    open: true,
  },
});
