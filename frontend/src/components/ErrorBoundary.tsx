import { Component, type ErrorInfo, type ReactNode } from "react";
import { logActivity } from "../lib/activity";

// App-root error boundary. The per-view `ChunkErrorBoundary` in LazyView only
// guards lazy chunk loads inside a single view; a render throw in App, the
// providers, or the shared shell would otherwise unmount the whole React root
// and leave a blank window. This boundary catches any such throw and shows a
// recoverable screen (with the error message + a Reload button) instead, and
// records the error to the console and the activity log for diagnostics.
interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] uncaught render error:", error, info.componentStack);
    try {
      logActivity(error.message || String(error), "error", "app");
    } catch {
      /* logging must never re-throw from the boundary */
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 32,
          textAlign: "center",
          background: "var(--bg)",
          color: "var(--text)",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
        <div
          style={{
            maxWidth: 560,
            fontSize: 13,
            color: "var(--text-4)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error.message || String(error)}
        </div>
        <button
          type="button"
          onClick={() => location.reload()}
          style={{
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 500,
            color: "#fff",
            background: "var(--accent)",
            border: "1px solid var(--accent)",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
