import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    // Content hashes prevent WebView2 from serving an older embedded renderer
    // after an application upgrade. Tauri packages the entire directory, so v2
    // no longer needs the fixed paths used by the removed Rust asset server.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
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
