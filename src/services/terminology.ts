import type { TerminologyCandidate } from '../types';
import { pool } from '../db/connection';

/** Stop-Words die keine Terminologie-Kandidaten sind */
const STOP_WORDS: Record<string, Set<string>> = {
  DE: new Set(['der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'in', 'mit', 'von', 'zu', 'auf', 'für', 'ist', 'sind', 'wird', 'den', 'dem', 'des', 'nicht', 'auch', 'als', 'an', 'es', 'im', 'sich']),
  EN: new Set(['the', 'a', 'an', 'and', 'or', 'in', 'with', 'of', 'to', 'on', 'for', 'is', 'are', 'was', 'not', 'also', 'as', 'at', 'it', 'by', 'from', 'be', 'has', 'have', 'this', 'that']),
  IT: new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'e', 'o', 'in', 'con', 'di', 'a', 'da', 'per', 'su', 'del', 'della', 'dei', 'delle', 'nel', 'nella', 'non', 'che', 'si']),
  FR: new Set(['le', 'la', 'les', 'un', 'une', 'des', 'et', 'ou', 'en', 'avec', 'de', 'du', 'a', 'au', 'aux', 'pour', 'sur', 'dans', 'par', 'ne', 'pas', 'que', 'qui', 'se', 'est', 'sont']),
};

function tokenize(text: string): string[] {
  return text.split(/[\s,.;:!?()\[\]{}"'\/\-–—]+/).filter(t => t.length > 0);
}

function isStopWord(word: string, lang: string): boolean {
  const stops = STOP_WORDS[lang.toUpperCase()] || STOP_WORDS.EN;
  return stops.has(word.toLowerCase());
}

/**
 * LCS-basierter Wort-Diff: Findet geänderte Spans zwischen zwei Wort-Arrays.
 */
function wordDiff(original: string[], edited: string[]): { origSpan: string[]; editSpan: string[]; position: number }[] {
  const m = original.length;
  const n = edited.length;

  // LCS-Tabelle
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1].toLowerCase() === edited[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack um Diff-Spans zu finden
  const changes: { origSpan: string[]; editSpan: string[]; position: number }[] = [];
  let i = m, j = n;
  let origBuf: string[] = [];
  let editBuf: string[] = [];
  let lastPos = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i - 1].toLowerCase() === edited[j - 1].toLowerCase()) {
      if (origBuf.length > 0 || editBuf.length > 0) {
        changes.push({ origSpan: origBuf.reverse(), editSpan: editBuf.reverse(), position: lastPos });
        origBuf = [];
        editBuf = [];
      }
      lastPos = i - 1;
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      editBuf.push(edited[j - 1]);
      j--;
    } else {
      origBuf.push(original[i - 1]);
      lastPos = i - 1;
      i--;
    }
  }

  if (origBuf.length > 0 || editBuf.length > 0) {
    changes.push({ origSpan: origBuf.reverse(), editSpan: editBuf.reverse(), position: lastPos });
  }

  return changes.reverse();
}

/**
 * Erkennt Terminologie-Kandidaten aus einem User-Edit.
 * Vergleicht DeepL-Original mit User-Edit und schlaegt geänderte Terme als Glossar-Kandidaten vor.
 */
export function detectTerminologyCandidates(
  originalTranslation: string,
  editedTranslation: string,
  sourceText: string,
  targetLang: string,
): TerminologyCandidate[] {
  if (!originalTranslation || !editedTranslation) return [];
  if (originalTranslation === editedTranslation) return [];

  const origTokens = tokenize(originalTranslation);
  const editTokens = tokenize(editedTranslation);
  const sourceTokens = tokenize(sourceText);

  const changes = wordDiff(origTokens, editTokens);
  const candidates: TerminologyCandidate[] = [];

  for (const change of changes) {
    if (change.origSpan.length === 0 || change.editSpan.length === 0) continue;

    const origTerm = change.origSpan.join(' ');
    const editTerm = change.editSpan.join(' ');

    // Minor changes (nur Gross-/Kleinschreibung, Satzzeichen) überspringen
    if (origTerm.toLowerCase() === editTerm.toLowerCase()) continue;

    // Stop-Words filtern
    if (change.editSpan.length === 1 && isStopWord(change.editSpan[0], targetLang)) continue;
    if (change.origSpan.length === 1 && isStopWord(change.origSpan[0], targetLang)) continue;

    // Source-Term über Position-Mapping schätzen
    const posRatio = sourceTokens.length > 0 ? change.position / origTokens.length : 0;
    const sourceIdx = Math.min(Math.floor(posRatio * sourceTokens.length), sourceTokens.length - 1);
    const sourceSpanLen = Math.max(1, change.origSpan.length);
    const sourceTerm = sourceTokens.slice(sourceIdx, sourceIdx + sourceSpanLen).join(' ');

    // Confidence berechnen
    let confidence = 0.7;
    if (change.editSpan.length === 1 && change.editSpan[0].length > 3) confidence = 0.9;
    if (change.editSpan.length > 2) confidence = 0.6;
    if (editTerm.length <= 2) confidence = 0.3;

    if (confidence >= 0.5 && sourceTerm.length > 1) {
      candidates.push({
        sourceTerm,
        targetTerm: editTerm,
        originalTargetTerm: origTerm,
        confidence,
        context: sourceText.substring(0, 100),
      });
    }
  }

  // Max 3, sortiert nach Confidence
  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

/**
 * Filtert Kandidaten die bereits im Glossar existieren.
 */
export async function filterExistingGlossaryEntries(
  candidates: TerminologyCandidate[],
  sourceLang: string,
  targetLang: string,
): Promise<TerminologyCandidate[]> {
  if (candidates.length === 0) return [];

  const result = await pool.query(
    `SELECT ge.target_term FROM glossary_entries ge
     JOIN glossaries g ON ge.glossary_id = g.id
     WHERE g.source_lang = $1 AND g.target_lang = $2 AND ge.target_term IS NOT NULL`,
    [sourceLang.toUpperCase(), targetLang.toUpperCase()],
  );

  const existingTerms = new Set(result.rows.map((r: any) => r.target_term.toLowerCase()));
  return candidates.filter(c => !existingTerms.has(c.targetTerm.toLowerCase()));
}
