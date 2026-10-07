import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Production builds are served from GitHub Pages at
 * https://civicaiclub.github.io/case-b-music-studio/ (project site), so
 * asset URLs need that subpath. If this repo is ever renamed, update the
 * base below to match. Dev keeps the root so `npm run dev` still serves
 * at http://localhost:5173/.
 *
 * `npm run build:gas` (mode "gas") builds the same app for Google hosting
 * instead: ONE self-contained HTML file in dist-gas/ (all JavaScript, CSS and
 * images inlined), pasted into the Apps Script editor as the HTML file "Index"
 * and served by doGet. In that mode no VITE_* values are read at all (the
 * envPrefix below matches nothing we set), so the Apps Script /exec URL and
 * the shared secret can never end up in the page: it talks to Apps Script
 * through google.script.run instead (see src/api/appsScriptTransport.ts).
 */
export default defineConfig(({ command, mode }) => {
  if (mode === "gas") {
    return {
      base: "./",
      plugins: [react(), viteSingleFile()],
      envPrefix: "MUSIC_STUDIO_GAS_PAGE_ONLY_",
      publicDir: false,
      build: {
        outDir: "dist-gas",
        emptyOutDir: true,
      },
    };
  }
  return {
    base: command === "build" ? "/case-b-music-studio/" : "/",
    plugins: [react()],
  };
});
