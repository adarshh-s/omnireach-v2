import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Short name of what's wrapped, shown in the fallback (e.g. "Live Voice Demo"). Omit for
   * the app-level boundary, which renders a full-page fallback instead of an inline card. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Without a boundary, any error thrown while rendering unmounts the entire React tree —
 * which looks like the app going to a blank/black screen. This catches it and shows a
 * recoverable message instead: inline for a wrapped feature, full-page at the app root.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // The project doesn't install @types/react, so the base class's members aren't typed.
  declare props: Readonly<ErrorBoundaryProps>;
  declare setState: (state: ErrorBoundaryState) => void;
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.label) {
      return (
        <div className="bg-surface/50 backdrop-blur-3xl border border-border rounded-2xl p-6 shadow-card flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-ink">{this.props.label} hit a problem</p>
            <p className="text-xs text-ink-muted mt-1">The rest of the page still works.</p>
            <button
              onClick={this.reset}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-surface-hover border border-border text-ink hover:border-border-strong"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Try again
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-canvas text-ink">
        <div className="max-w-md text-center">
          <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
          <h1 className="text-lg font-bold mt-3">Something went wrong</h1>
          <p className="text-sm text-ink-muted mt-2">
            OmniReach hit an unexpected error. Reloading the page usually fixes it — your data is saved.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold bg-gradient-to-r from-[#4285F4] to-[#128C7E] text-white"
          >
            <RefreshCw className="w-4 h-4" />
            Reload OmniReach
          </button>
        </div>
      </div>
    );
  }
}
