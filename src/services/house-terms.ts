import { pool } from '../db/connection';
import type { LtMatch } from './languagetool';

/**
 * Hausschreibweise: deutsche Begriffe, die die Organisation nicht verwendet, samt dem
 * Begriff, der stattdessen gilt („LED-Treiber" → „LED-Trafo").
 *
 * Die Treffer werden im Format von LanguageTool geliefert, damit die
 * Schreibhilfe sie ohne Sonderweg markieren und ersetzen kann.
 */

export interface HouseTerm {
  avoidTerm: string;
  preferredTerm: string;
  note: string | null;
}

export const HOUSE_TERM_CATEGORY = 'HAUSSCHREIBWEISE';

/** Groß-/Kleinschreibung egal, wie die Suche. */
export function sameTerm(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Nur Einträge, die im Channel etwas ersetzen. Gleich geschrieben heißt „bleibt":
 * Ist der Standard-Begriff selbst richtig und weicht nur ein Channel ab
 * („LED-Trafo" → SHOPA „Netzteil"), steht er in beiden Standard-Feldern
 * (Entscheid Thomas 27.10.2026). Ohne Override dieses Channels gibt es dann
 * nichts zu prüfen — auch nicht für den Chat, der die Liste exportiert bekommt.
 */
export function effectiveHouseTerms(terms: HouseTerm[]): HouseTerm[] {
  return terms.filter((t) => !sameTerm(t.avoidTerm, t.preferredTerm));
}

/**
 * Lädt die Liste. Mit Channel gilt dessen Override, sonst der Standard der Organisation.
 */
export async function loadHouseTerms(channelCode: string | null): Promise<HouseTerm[]> {
  const result = await pool.query<{ avoid_term: string; preferred_term: string; note: string | null }>(
    `SELECT ht.avoid_term,
            COALESCE(htc.preferred_term, ht.preferred_term) AS preferred_term,
            ht.note
       FROM house_terms ht
       LEFT JOIN house_term_channels htc
         ON htc.term_id = ht.id AND htc.channel_code = $1`,
    [channelCode],
  );
  return effectiveHouseTerms(result.rows.map((r) => ({
    avoidTerm: r.avoid_term,
    preferredTerm: r.preferred_term,
    note: r.note,
  })));
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sucht die zu vermeidenden Begriffe im Text.
 *
 * - Gross-/Kleinschreibung egal.
 * - Links muss eine Wortgrenze liegen; ein Bindestrich zählt als Grenze, damit
 *   „Konstantstrom-LED-Treiber" gefunden wird.
 * - Rechts darf das Wort weitergehen: „LED-Treibers", „LED-Treiberleistung".
 *   Markiert wird nur der Begriff selbst, die Endung bleibt stehen — beim
 *   Ersetzen wird aus „LED-Treibers" also „LED-Trafos". Passt die Endung zum
 *   neuen Begriff nicht („LED-Treibern" → „LED-Trafon"), muss man nachbessern;
 *   der Hinweistext sagt das.
 * - Steht an der Stelle bereits der bevorzugte Begriff (der den vermiedenen
 *   enthält, z. B. „Trafo" → „LED-Trafo"), ist das kein Treffer.
 * - Bei überlappenden Begriffen gewinnt der längere.
 */
export function findHouseTermMatches(text: string, terms: HouseTerm[]): LtMatch[] {
  const found: LtMatch[] = [];
  const lowerText = text.toLowerCase();
  const sorted = [...terms]
    .filter((t) => t.avoidTerm.trim() && t.preferredTerm.trim())
    .sort((a, b) => b.avoidTerm.trim().length - a.avoidTerm.trim().length);

  for (const term of sorted) {
    const avoid = term.avoidTerm.trim();
    const preferred = term.preferredTerm.trim();
    const pattern = new RegExp(escapeRegex(avoid), 'giu');

    for (const m of text.matchAll(pattern)) {
      const offset = m.index ?? 0;
      const length = m[0].length;

      const before = offset > 0 ? text[offset - 1] : '';
      if (before && WORD_CHAR.test(before)) continue;

      const posInPreferred = preferred.toLowerCase().indexOf(avoid.toLowerCase());
      if (posInPreferred >= 0) {
        const start = offset - posInPreferred;
        if (start >= 0 && lowerText.startsWith(preferred.toLowerCase(), start)) continue;
      }

      if (found.some((f) => offset < f.offset + f.length && f.offset < offset + length)) continue;

      const followedByLetters = offset + length < text.length && WORD_CHAR.test(text[offset + length]);
      const message =
        `Hausschreibweise: „${preferred}" statt „${m[0]}".` +
        (followedByLetters ? ' Nach dem Ersetzen die Wortendung prüfen.' : '') +
        (term.note ? ` ${term.note}` : '');

      found.push({
        message,
        shortMessage: 'Hausschreibweise',
        offset,
        length,
        replacements: [{ value: preferred }],
        rule: {
          id: 'HAUSSCHREIBWEISE',
          description: 'Hausschreibweise',
          issueType: 'terminology',
          category: { id: HOUSE_TERM_CATEGORY, name: 'Hausschreibweise' },
        },
      });
    }
  }

  return found.sort((a, b) => a.offset - b.offset);
}
