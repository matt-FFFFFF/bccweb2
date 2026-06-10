import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in any descendant and shows a fallback UI
 * instead of unmounting the whole React tree.
 *
 * Without this, any uncaught error in a route component blanks the
 * entire page (including Nav, Footer, FirstLoginOfSeasonGate).
 *
 * Auto-resets when the wrapping component is re-keyed on route change
 * (see usage in router.tsx).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{ maxWidth: 600, margin: "3rem auto", padding: "2rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Something went wrong</h1>
        <p style={{ color: "#555", marginBottom: "1.5rem" }}>
          This page hit an unexpected error. The rest of the site still works — try going home or reloading.
        </p>
        <pre style={{
          background: "#f8d7da",
          color: "#58151c",
          padding: "0.75rem",
          borderRadius: "0.3rem",
          fontSize: "0.8rem",
          textAlign: "left",
          overflowX: "auto",
          marginBottom: "1.5rem",
        }}>
          {this.state.error.message}
        </pre>
        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
          <Link to="/" style={{
            padding: "0.5rem 1rem",
            background: "#0066cc",
            color: "white",
            textDecoration: "none",
            borderRadius: "0.3rem",
          }}>
            Go home
          </Link>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "0.5rem 1rem",
              background: "white",
              color: "#0066cc",
              border: "1px solid #0066cc",
              borderRadius: "0.3rem",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
