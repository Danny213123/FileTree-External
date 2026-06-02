import { Component, Suspense, type ReactNode } from "react";

// Wrapper for React.lazy() views: a Suspense fallback while the chunk loads plus
// an error boundary so a failed dynamic import degrades to a contained message
// instead of crashing the whole React tree. Network/chunk fetches can always
// fail (offline, a stale cached index.html referencing an old chunk, or a host
// that doesn't serve the split /assets/*.js files yet), so every lazy boundary
// gets one.
interface ChunkBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

class ChunkErrorBoundary extends Component<ChunkBoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    // Surfaced for diagnostics; the UI already shows the fallback.
    console.error("[LazyView] failed to load view chunk:", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const DefaultLoading = (
  <div className="lazy-view-fallback" role="status" aria-live="polite">
    Loading…
  </div>
);

const DefaultError = (
  <div className="lazy-view-fallback lazy-view-error" role="alert">
    This view failed to load.
  </div>
);

export function LazyView({
  children,
  loading = DefaultLoading,
  error = DefaultError,
}: {
  children: ReactNode;
  loading?: ReactNode;
  error?: ReactNode;
}) {
  return (
    <ChunkErrorBoundary fallback={error}>
      <Suspense fallback={loading}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}
