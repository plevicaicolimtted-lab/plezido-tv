import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || 'An unexpected error occurred in PleziDo TV.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('PleziDo TV ErrorBoundary:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#06080D] text-[#F4F6FA] flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-xl border border-rose-500/30 bg-[#0B0F17] p-6 space-y-4">
            <h1 className="font-display text-xl font-bold text-white">
              PleziDo TV Connection Recovery
            </h1>
            <p className="text-sm leading-relaxed text-slate-300">
              Something interrupted the broadcast session. Reload the studio or viewer to reconnect cleanly.
            </p>
            <p className="rounded-lg bg-[#06080D] border border-white/10 p-3 font-mono text-xs text-rose-300 break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] transition-colors"
            >
              Reload PleziDo TV
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
