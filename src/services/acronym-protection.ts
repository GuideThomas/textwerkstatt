/**
 * Akronym-Pre-Pass mit Glossar-Lookup (Thema B, 22.05.2026)
 *
 * Problem: Glossar-Eintraege wie `CRI → IRC` greifen nur bei Wortgrenzen-Matches.
 * Wenn der Source `CRI90` (ohne Leerzeichen) enthaelt, sieht DeepL ein Token
 * und der Glossar-Hit funktioniert nicht — Output bleibt `CRI90` statt `IRC90`.
 *
 * Loesung: Vor DeepL den Source-Text nach `[A-Z]{2,5}(\d+[A-Z]?)`-Pattern scannen.
 * Wenn der Buchstaben-Teil im aktiven Glossar als Source-Begriff existiert,
 * wird das gesamte Konstrukt durch einen Sentinel ersetzt und nach DeepL
 * direkt mit `<Glossar-Target><Suffix>` restored. DeepL sieht den Begriff nie.
 *
 * Bonus: Operatoren wie `UGR<19`, `CRI≥90` werden ebenfalls erkannt
 * (erweiterte Regex), bleiben aber unangetastet wenn kein Glossar-Treffer.
 */

const ACRONYM_SENTINEL_PREFIX = '__ISOLAC';

// Akronym (2-5 Grossbuchstaben) + entweder direkt anhaengende Ziffer(n) mit
// optionalem Einheit-Buchstaben (CRI90, IP66, 50W), oder Operator + Wert
// (UGR<19, CRI>=90).
//
// Bewusst case-sensitive: nur ALL-CAPS-Praefix matcht. `Test123` waere
// kein Treffer; `LED4000K` schon.
const ACRONYM_PATTERN_RE =
  /\b([A-Z]{2,5})(?:([<>=]+|≤|≥|<=|>=)?(\d+[A-Z]?))\b/g;

export interface AcronymProtection {
  protectedText: string;
  restoreMap: Map<string, string>;
  /** Audit-Trail: welche Akronyme wurden ersetzt? */
  substitutions: Array<{ source: string; target: string; glossarySource: string; glossaryTarget: string }>;
}

export interface AcronymGlossaryEntry {
  source_term: string;
  target_term: string;
}

/**
 * Schuetzt `<AKRONYM><Operator?><Wert>`-Konstrukte vor DeepL, wenn das
 * Akronym im Glossar als Source-Begriff existiert.
 *
 * Glossar wird als Map indiziert (case-sensitive — `CRI` matcht nicht `cri`).
 * Wenn beide Spalten identisch sind (Akronym uebersetzt sich selbst, z.B. `IP → IP`),
 * lassen wir's unangetastet — kein Sentinel noetig, DeepL macht's eh richtig.
 */
export function protectAcronymsWithGlossary(
  text: string,
  glossaryEntries: AcronymGlossaryEntry[],
): AcronymProtection {
  // Glossar als Map fuer O(1) Lookup. Case-sensitive — wir wollen `CRI` nicht
  // mit zufaelligen Fliesstext-Vorkommen vermischen.
  const glossaryMap = new Map<string, string>();
  for (const entry of glossaryEntries) {
    if (!entry.source_term || !entry.target_term) continue;
    if (entry.source_term === entry.target_term) continue; // gleicher Begriff: kein Bedarf
    // Nur Akronym-faehige Eintraege (2-5 Grossbuchstaben) indizieren.
    if (/^[A-Z]{2,5}$/.test(entry.source_term)) {
      glossaryMap.set(entry.source_term, entry.target_term);
    }
  }

  const restoreMap = new Map<string, string>();
  const substitutions: Array<{ source: string; target: string; glossarySource: string; glossaryTarget: string }> = [];

  if (glossaryMap.size === 0) {
    return { protectedText: text, restoreMap, substitutions };
  }

  let counter = 0;
  const protectedText = text.replace(ACRONYM_PATTERN_RE, (match, acronym, operator, value) => {
    const glossaryTarget = glossaryMap.get(acronym);
    if (!glossaryTarget) {
      return match; // kein Glossar-Treffer → unveraendert
    }
    const sentinel = `${ACRONYM_SENTINEL_PREFIX}${counter++}__`;
    const restored = `${glossaryTarget}${operator || ''}${value}`;
    restoreMap.set(sentinel, restored);
    substitutions.push({
      source: match,
      target: restored,
      glossarySource: acronym,
      glossaryTarget,
    });
    return sentinel;
  });

  return { protectedText, restoreMap, substitutions };
}

export function restoreAcronyms(text: string, restoreMap: Map<string, string>): string {
  let result = text;
  for (const [sentinel, original] of restoreMap.entries()) {
    result = result.split(sentinel).join(original);
  }
  return result;
}
