import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Textwerkstatt, Schritt „Prüfen“: der Text mit den Treffern von LanguageTool und der
 * Hausschreibweise. Übernommen aus der früheren Schreibhilfe-Seite (bis 10.11.2026),
 * Verhalten unverändert: Klick auf eine Markierung zeigt die Vorschläge, ein Vorschlag
 * ersetzt die Stelle im Text, „Ignorieren“ verwirft den Treffer.
 */

export interface LtMatch {
  message: string;
  shortMessage?: string;
  offset: number;
  length: number;
  replacements: Array<{ value: string }>;
  rule: {
    id: string;
    description?: string;
    issueType?: string;
    category?: { id: string; name: string };
  };
}

export interface PruefStatistik {
  checked: number;
  found: number;
  houseTerms: number;
}

// Farbe je Art des Treffers, angelehnt an die Farben von LanguageTool
const ISSUE_COLOR: Record<string, string> = {
  misspelling: 'bg-red-100 text-red-900 border-red-300',
  grammar: 'bg-orange-100 text-orange-900 border-orange-300',
  typographical: 'bg-purple-100 text-purple-900 border-purple-300',
  style: 'bg-yellow-100 text-yellow-900 border-yellow-300',
  // Hausschreibweise (eigene Liste, nicht LanguageTool)
  terminology: 'bg-cyan-100 text-cyan-900 border-cyan-400',
  default: 'bg-primary-100 text-primary-900 border-primary-300',
};

function colorForMatch(m: LtMatch): string {
  const type = m.rule?.issueType?.toLowerCase() || 'default';
  return ISSUE_COLOR[type] || ISSUE_COLOR.default;
}

/** Kategorien, deren eindeutiger Vorschlag ohne Rückfrage übernommen werden darf. */
const SAFE_CATEGORIES = new Set(['TYPOS', 'TYPOGRAPHY', 'PUNCTUATION']);

export function isSafeMatch(m: LtMatch): boolean {
  return (
    m.replacements.length === 1 &&
    !!m.rule?.category?.id &&
    SAFE_CATEGORIES.has(m.rule.category.id.toUpperCase())
  );
}

interface Props {
  text: string;
  matches: LtMatch[];
  stats: PruefStatistik | null;
  activeIdx: number | null;
  onSelect: (idx: number | null) => void;
  onApply: (idx: number, replacement: string) => void;
  onDismiss: (idx: number) => void;
  /** Nach dem Prüfen direkt zum nächsten Schritt. */
  onWeiter?: () => void;
  weiterLabel?: string;
}

export default function PruefenErgebnis({
  text, matches, stats, activeIdx, onSelect, onApply, onDismiss, onWeiter, weiterLabel,
}: Props) {
  const { t } = useTranslation('writing');

  // Text mit Markierungen: Treffer nach Stelle sortiert, dazwischen der Text.
  const rendered = useMemo(() => {
    if (!matches.length) return <span>{text || ' '}</span>;
    const sorted = [...matches].sort((a, b) => a.offset - b.offset);
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    sorted.forEach((m, idx) => {
      const realIdx = matches.indexOf(m);
      if (m.offset < cursor) return; // überlappende Treffer nicht doppelt markieren
      if (m.offset > cursor) parts.push(<span key={`t-${cursor}`}>{text.slice(cursor, m.offset)}</span>);
      const isActive = activeIdx === realIdx;
      parts.push(
        <span
          key={`m-${m.offset}-${idx}`}
          onClick={() => onSelect(isActive ? null : realIdx)}
          className={`cursor-pointer border-b-2 px-0.5 rounded-sm ${colorForMatch(m)} ${
            isActive ? 'ring-2 ring-primary-400' : ''
          }`}
          title={m.message}
        >
          {text.slice(m.offset, m.offset + m.length)}
        </span>,
      );
      cursor = m.offset + m.length;
    });
    if (cursor < text.length) parts.push(<span key="t-end">{text.slice(cursor)}</span>);
    return parts;
  }, [text, matches, activeIdx, onSelect]);

  const active = activeIdx !== null ? matches[activeIdx] : null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-700">
          {t('result.title')}
          {stats && (
            <span className="ml-2 text-xs text-gray-400">
              {t('result.hints', { count: stats.found })}
              {stats.houseTerms > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-900">
                  {t('result.houseTermsCount', { count: stats.houseTerms })}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="text-xs text-gray-400 text-right">{t('result.clickHint')}</span>
      </div>
      <div className="px-4 py-3 h-80 overflow-y-auto text-sm whitespace-pre-wrap font-sans leading-relaxed">
        {stats && text ? rendered : <span className="text-gray-300">{t('result.empty')}</span>}
      </div>

      {active && activeIdx !== null && (
        <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="text-xs">
              <div className="font-semibold text-gray-800">
                {active.shortMessage || active.rule?.category?.name || t('match.fallback')}
              </div>
              <div className="text-gray-600 mt-0.5">{active.message}</div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(activeIdx)}
              className="text-gray-400 hover:text-gray-600 text-xs"
              title={t('match.dismissTitle')}
            >
              {t('match.ignore')}
            </button>
          </div>
          {active.replacements.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {active.replacements.slice(0, 8).map((r, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onApply(activeIdx, r.value)}
                  className="px-2 py-1 text-xs bg-white border border-gray-300 rounded hover:bg-primary-50 hover:border-primary-400"
                >
                  {r.value || t('match.delete')}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-xs text-gray-400">{t('match.noSuggestion')}</div>
          )}
        </div>
      )}

      {stats && onWeiter && weiterLabel && (
        <div className="px-4 py-2 border-t border-gray-100 flex justify-end mt-auto">
          <button
            type="button"
            onClick={onWeiter}
            className="text-xs text-primary-700 hover:text-primary-900 font-semibold"
          >
            {weiterLabel} ➜
          </button>
        </div>
      )}
    </div>
  );
}
