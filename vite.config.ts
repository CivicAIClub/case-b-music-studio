import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Production builds are served from GitHub Pages at
 * https://civicaiclub.github.io/case-b-music-studio/ (project site), so
 * asset URLs need that subpath. If this repo is ever renamed, update the
 * base below to match. Dev keeps the root so `npm run dev` still serves
 * at http://localhost:5173/.
 */
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/case-b-music-studio/" : "/",
  plugins: [react()],
}));
