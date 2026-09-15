import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { ErrorBoundary } from "./components/ErrorBoundary";

// App is loaded dynamically so a demo build can replace Tauri's IPC before any
// app module runs. In normal builds the demo branch compiles away.
async function boot() {
  if (import.meta.env.VITE_FILETREE_DEMO === "1") (await import("./demo/install")).installDemo();
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void boot().catch((error: unknown) => {
  // Startup failed before React could mount; show why instead of a blank window.
  document.body.textContent = `FileTree failed to start: ${error instanceof Error ? error.message : String(error)}`;
});
