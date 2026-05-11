"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface State {
  hasError: boolean;
  error?: Error;
}

export default class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  State
> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Voxaris Pitch panel error:", error, info);
  }

  reset = () => this.setState({ hasError: false, error: undefined });

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="glass-panel p-6 border border-rose/30 bg-rose/[0.04]">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-xl bg-rose/15 border border-rose/25 flex items-center justify-center text-rose flex-shrink-0">
              <AlertTriangle size={14} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-display font-semibold tracking-tight text-[14px] text-rose">
                Something didn&apos;t load
              </div>
              <div className="text-[12px] text-slate-400 mt-1 leading-relaxed">
                Refresh to retry. Your other panels are unaffected.
              </div>
              <button onClick={this.reset} className="glass-button-secondary mt-3 text-[12px] py-1.5 px-3">
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
