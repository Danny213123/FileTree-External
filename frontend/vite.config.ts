import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    // The demo build (`--mode demo`) answers every backend command from
    // invented data; see src/demo/tauriCore.ts.
    alias: mode === "demo" ? [{ find: /^@tauri-apps\/api\/core$/, replacement: "/src/demo/tauriCore.ts" }] : [],
  },
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
    fs: {
      // The What's New dialog imports CHANGELOG.md from the repository root,
      // which is outside this project root and so is blocked by default.
      allow: [".."],
    },
    // Dev mode: proxy API calls to the Rust backend
    proxy: {
      "/api": "http://127.0.0.1:7878",
    },
  },
}));
