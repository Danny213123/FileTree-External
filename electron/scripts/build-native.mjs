// Builds the native Windows drag addon (electron/native) and copies the
// resulting cdylib into electron/dist as `filetree_drag.node` so the Electron
// main process can `require` it next to main.js — in both dev (`npm start`)
// and the packaged portable build (which copies electron/dist wholesale).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const electronDir = join(scriptDir, "..");
const nativeDir = join(electronDir, "native");
const manifest = join(nativeDir, "Cargo.toml");
const targetDir = join(nativeDir, "target");
const distDir = join(electronDir, "dist");

const dll = join(targetDir, "release", "filetree_drag.dll");
const out = join(distDir, "filetree_drag.node");

if (process.platform !== "win32") {
  console.warn("[build-native] skipping: native drag addon is Windows-only");
  process.exit(0);
}

if (!existsSync(manifest)) {
  console.error(`[build-native] missing crate manifest: ${manifest}`);
  process.exit(1);
}

console.log("[build-native] cargo build --release (electron/native)");
try {
  execSync(
    `cargo build --release --manifest-path "${manifest}" --target-dir "${targetDir}"`,
    { stdio: "inherit" },
  );
} catch (err) {
  console.error("[build-native] cargo build failed:", err?.message ?? err);
  process.exit(1);
}

if (!existsSync(dll)) {
  console.error(`[build-native] expected artifact not found: ${dll}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
copyFileSync(dll, out);
const { size } = statSync(out);
console.log(`[build-native] wrote ${out} (${size} bytes)`);
