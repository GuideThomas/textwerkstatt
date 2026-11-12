/**
 * Rendert Text mit hervorgehobenen Glossar-Treffern.
 *
 * Glossar-Begriffe bekommen einen dezenten Cyan-Underline + Hover-Tooltip,
 * der Quell-/Ziel-Term zeigt. Native-Speaker sehen damit auf einen Blick,
 * dass ein Begriff aus der Firmen-Terminologie stammt — und uebernehmen ihn
 * nicht versehentlich beim Korrigieren.
 *
 * Verwendet `<mark>` semantisch korrekt, statt `<span>`. Tooltip ueber HTML
 * `title`-Attribut (zuverlaessig, keine extra Lib noetig).
 */

import type { ReactNode } from 'react';
import i18n from '../../i18n';

export interface GlossaryHit {
  term: string;
  start: number;
  end: number;
  source_term: string;
  target_term: string;
}

interface Props {
  text: string;
  hits: GlossaryHit[];
  side: 'source' | 'target';
  /** Optionale Klasse fuer den Container */
  className?: string;
}

/**
 * IDML-Style-Marker (`<x id="N"/>`) markieren interne Formatgrenzen
 * (Schriftwechsel innerhalb eines Absatzes) und sind KEIN Textinhalt — im
 * finalen Dokument werden sie entfernt. In der Pruefen-Ansicht wuerden sie
 * als Code-Tags verwirren (Beschwerde 01.06.2026), daher als dezentes
 * Trennzeichen mit Tooltip rendern statt als Roh-Tag.
 */
export const STYLE_MARKER_RE = /<x\s+id=["']\d+["']\s*\/?>/g;

export function renderWithMarkers(content: string, keyPrefix: string): ReactNode {
  if (!content || !content.includes('<x ')) return content;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of content.matchAll(STYLE_MARKER_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(content.slice(last, idx));
    out.push(
      <span
        key={`${keyPrefix}-m${i++}`}
        title={i18n.t('review:highlight.styleMarker')}
        className="text-gray-300 select-none cursor-help"
      >
        ⁞
      </span>,
    );
    last = idx + m[0].length;
  }
  if (last < content.length) out.push(content.slice(last));
  return out;
}

export default function HighlightedText({ text, hits, side, className = '' }: Props) {
  if (!text) return <span className={className} />;
  if (!hits || hits.length === 0) {
    return <span className={className}>{renderWithMarkers(text, 'm')}</span>;
  }

  // Hits sind bereits nach start sortiert + ueberlappungsfrei aus dem Backend
  const parts: Array<{ type: 'text' | 'hit'; content: string; hit?: GlossaryHit }> = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) {
      parts.push({ type: 'text', content: text.slice(cursor, hit.start) });
    }
    parts.push({ type: 'hit', content: text.slice(hit.start, hit.end), hit });
    cursor = hit.end;
  }
  if (cursor < text.length) {
    parts.push({ type: 'text', content: text.slice(cursor) });
  }

  return (
    <span className={className}>
      {parts.map((p, i) => {
        if (p.type === 'text') return <span key={i}>{renderWithMarkers(p.content, `t${i}`)}</span>;
        const h = p.hit!;
        const tooltip =
          side === 'source'
            ? i18n.t('review:highlight.glossarySource', { source: h.source_term, target: h.target_term })
            : i18n.t('review:highlight.glossaryTarget', { source: h.source_term, target: h.target_term });
        return (
          <mark
            key={i}
            title={tooltip}
            className="bg-cyan-50 text-cyan-900 border-b-2 border-cyan-400 px-0.5 rounded-sm cursor-help"
            style={{ borderBottomStyle: 'dotted' }}
          >
            {p.content}
          </mark>
        );
      })}
    </span>
  );
}
