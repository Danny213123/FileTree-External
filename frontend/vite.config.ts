import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    // Fixed output names so Rust include_str!/include_bytes! paths are stable
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
    // Inline small assets (fonts, images) into CSS/JS to avoid extra embed paths
    assetsInlineLimit: 1024 * 1024,
  },
  server: {
    // Dev mode: proxy API calls to the Rust backend
    proxy: {
      "/api": "http://127.0.0.1:7878",
    },
  },
});
