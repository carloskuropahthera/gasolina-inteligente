import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <span className="text-4xl mb-3">⚠️</span>
          <p className="text-zinc-300 font-semibold mb-1">Algo salió mal</p>
          <p className="text-zinc-500 text-sm mb-4">Se produjo un error en esta sección</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="px-4 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30
                       text-emerald-400 text-sm hover:bg-emerald-500/25 transition-colors"
          >
            Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
