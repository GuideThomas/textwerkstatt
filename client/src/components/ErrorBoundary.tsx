import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '../i18n';

/**
 * ErrorBoundary — faengt Render-Exceptions ab, damit ein einzelner Fehler
 * nicht die ganze App weiss reisst. Zeigt stattdessen eine lesbare Meldung
 * inkl. Stacktrace (zum Diagnostizieren) und einen Reload-Button.
 *
 * React-ErrorBoundaries muessen Klassen-Komponenten sein (kein Hook-Aequivalent).
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optionaler Kontext-Name (z. B. Tab) fuer die Fehleranzeige. */
  context?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In die Browser-Konsole loggen — bleibt fuer Diagnose erhalten.
    console.error('[ErrorBoundary] Render-Fehler abgefangen:', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private handleReset = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    const { context } = this.props;
    return (
      <div className="max-w-3xl mx-auto my-10 p-6 bg-white rounded-lg border border-red-200 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="text-2xl" aria-hidden>⚠️</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-red-800">
              {context
                ? i18n.t('common:errorBoundary.titleWithContext', { context })
                : i18n.t('common:errorBoundary.title')}
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              {i18n.t('common:errorBoundary.description')}
            </p>

            <div className="mt-4">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                {i18n.t('common:errorBoundary.errorMessage')}
              </div>
              <pre className="text-xs bg-red-50 border border-red-100 rounded p-3 overflow-auto text-red-900 whitespace-pre-wrap">
                {error.name}: {error.message}
              </pre>
            </div>

            {error.stack && (
              <details className="mt-3">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                  {i18n.t('common:errorBoundary.showStack')}
                </summary>
                <pre className="mt-1 text-[11px] bg-gray-50 border border-gray-200 rounded p-3 overflow-auto text-gray-700 whitespace-pre-wrap">
                  {error.stack}
                </pre>
              </details>
            )}

            {componentStack && (
              <details className="mt-2">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                  {i18n.t('common:errorBoundary.showComponentStack')}
                </summary>
                <pre className="mt-1 text-[11px] bg-gray-50 border border-gray-200 rounded p-3 overflow-auto text-gray-700 whitespace-pre-wrap">
                  {componentStack}
                </pre>
              </details>
            )}

            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={this.handleReset}
                className="text-sm bg-primary-600 text-white px-4 py-2 rounded-md hover:bg-primary-700 transition-colors"
              >
                {i18n.t('common:errorBoundary.retry')}
              </button>
              <button
                onClick={() => window.location.reload()}
                className="text-sm text-gray-600 hover:text-gray-900 px-4 py-2 rounded-md hover:bg-gray-100 transition-colors"
              >
                {i18n.t('common:errorBoundary.reload')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
