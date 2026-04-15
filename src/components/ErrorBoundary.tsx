import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-dark p-8 text-center select-text">
          <div className="bg-accent-red/10 border border-accent-red/20 rounded-2xl p-6 max-w-lg w-full backdrop-blur-xl shadow-2xl">
            <h1 className="text-2xl font-black text-accent-red mb-4 uppercase tracking-widest">Critical Error</h1>
            <p className="text-sm text-dim mb-4">An unexpected error occurred and the UI crashed.</p>
            <div className="bg-black/50 rounded-lg p-4 mb-6 overflow-auto max-h-48 text-left border border-white/5">
              <code className="text-xs font-mono text-accent-red/80 whitespace-pre-wrap break-all">{this.state.error?.toString()}</code>
            </div>
            <button onClick={() => window.location.reload()} className="px-6 py-2 bg-accent-red hover:bg-accent-red/90 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-all">
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
