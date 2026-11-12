import { config } from '../config';

export interface LtReplacement {
  value: string;
}

export interface LtMatch {
  message: string;
  shortMessage?: string;
  offset: number;
  length: number;
  replacements: LtReplacement[];
  rule: {
    id: string;
    description?: string;
    issueType?: string;
    category?: { id: string; name: string };
  };
  context?: { text: string; offset: number; length: number };
}

export interface LtCheckResult {
  matches: LtMatch[];
  language: { code: string; name: string };
}

const LT_LANG_MAP: Record<string, string> = {
  DE: 'de-DE', EN: 'en-US', FR: 'fr', IT: 'it',
  ES: 'es', NL: 'nl', PL: 'pl-PL', CS: 'cs-CZ',
  CZ: 'cs-CZ', HU: 'hu-HU', SK: 'sk-SK', SL: 'sl-SI',
  AUTO: 'auto',
};

export function toLtLanguage(lang: string): string {
  return LT_LANG_MAP[lang.toUpperCase()] || lang.toLowerCase();
}

/**
 * Text gegen LanguageTool prüfen. Wirft bei Service-Fehler, gibt sonst die
 * Liste der Matches zurück (kann leer sein).
 */
export async function checkText(
  text: string,
  language: string,
  options: { picky?: boolean; preferredVariants?: string } = {},
): Promise<LtCheckResult> {
  if (!text.trim()) {
    return { matches: [], language: { code: language, name: '' } };
  }

  const params = new URLSearchParams();
  params.append('text', text);
  params.append('language', toLtLanguage(language));
  if (options.picky) params.append('level', 'picky');
  if (options.preferredVariants) {
    params.append('preferredVariants', options.preferredVariants);
  }

  if (!config.languagetool.url) {
    throw new Error('LanguageTool ist nicht eingerichtet (LANGUAGETOOL_URL fehlt)');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.languagetool.timeoutMs);

  try {
    const res = await fetch(`${config.languagetool.url}/v2/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`LanguageTool HTTP ${res.status}`);
    }
    const data = (await res.json()) as { matches?: LtMatch[]; language?: { code: string; name: string } };
    return {
      matches: data.matches || [],
      language: data.language || { code: toLtLanguage(language), name: '' },
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Target-Capitalization-Post-Pass (Thema A, 22.05.2026)
// ---------------------------------------------------------------------------

/**
 * Akronyme/Brand-Namen, die im Target NIE klein geschrieben werden duerfen —
 * auch wenn LT das vorschlaegt. Erweiterbar via env LT_TARGET_CASE_ALLOWLIST.
 */
const DEFAULT_CASE_ALLOWLIST = new Set([
  'LED', 'RGB', 'RGBW', 'RGBWW', 'IP', 'CRI', 'UGR', 'IRC', 'CCT', 'CB', 'PWM',
  'DALI', 'KNX', 'WLAN', 'WiFi', 'Bluetooth', 'USB', 'AC', 'DC', 'PV', 'PCB',
  'Magento', 'PageBuilder', 'DeepL',
  'ETIM', 'SAP', 'API', 'CSV', 'XML', 'HTML', 'JSON', 'PDF', 'CMS',
  'OK', 'EU', 'DIN', 'EN', 'ISO', 'CE', 'RoHS', 'REACH',
  // Eigene Marken- und Produktnamen dieser Installation (GESCHUETZTE_WOERTER)
  ...config.geschuetzteWoerter,
]);

/** Pattern: ein Wort, das gross beginnt (oder ALL-CAPS ist). Unicode-aware. */
const CAPITALIZED_WORD_RE = /[\p{Lu}][\p{L}\p{N}-]*/gu;

/**
 * Position eines Wortes innerhalb seines Satzes bestimmen. Liefert 0 bei
 * Satzanfang, >0 sonst. Naive Satzgrenzen: `.!?` gefolgt von Whitespace
 * oder Stringanfang.
 */
function isSentenceStart(text: string, offset: number): boolean {
  if (offset === 0) return true;
  // Rueckwaerts bis zum naechsten Satz-Endezeichen oder Stringanfang scannen.
  // Ueberspringt Whitespace direkt vor dem Wort.
  let i = offset - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  return /[.!?:;]/.test(text[i]);
}

export interface CaseFix {
  from: string;
  to: string;
  offset: number;
  ruleId: string;
}

/**
 * Target-Capitalization-Korrektur: deutsche Mid-Sentence-Grossschreibung,
 * die DeepL im Target (FR/IT/ES/etc.) faelschlicherweise beibehaelt.
 *
 * Heuristik:
 *  1. LanguageTool laufen lassen (Target-Sprache).
 *  2. Nur Matches mit genau einer Replacement-Variante akzeptieren.
 *  3. Matches filtern: Original muss Grossbuchstabe sein, Replacement Klein —
 *     wir machen NUR Big→Small, nie umgekehrt (Schutz vor Brand-Klein-Schreiben).
 *  4. Original-Wort darf nicht am Satzanfang stehen.
 *  5. Original-Wort darf nicht in der Allowlist (Akronyme + Brands) stehen.
 *  6. Original-Wort darf nicht in `protectedTerms` stehen (Glossar + Channel).
 *
 * Greedy von hinten nach vorne anwenden, damit Offsets stabil bleiben.
 */
export async function correctTargetCapitalization(
  text: string,
  targetLang: string,
  protectedTerms: string[] = [],
  extraAllowlist: string[] = [],
): Promise<{ corrected: string; fixes: CaseFix[] }> {
  // Languages where DE-typische Uebergrosschreibung haeufig durchschlaegt.
  // Englisch ausgeschlossen (Title-Case-Konventionen variieren stark).
  const SUPPORTED = new Set(['FR', 'IT', 'ES', 'PT', 'NL']);
  const langUpper = (targetLang || '').toUpperCase().split('-')[0];
  if (!SUPPORTED.has(langUpper)) {
    return { corrected: text, fixes: [] };
  }
  if (!text.trim()) {
    return { corrected: text, fixes: [] };
  }

  let result: LtCheckResult;
  try {
    result = await checkText(text, langUpper);
  } catch (err: any) {
    // LT-Service down → kein Crash, nur kein Post-Pass
    console.warn('[LT-Target-Pass] LanguageTool nicht erreichbar:', err.message);
    return { corrected: text, fixes: [] };
  }

  const allowlist = new Set([
    ...DEFAULT_CASE_ALLOWLIST,
    ...extraAllowlist,
    ...protectedTerms,
  ]);

  const fixes: CaseFix[] = [];
  for (const m of result.matches) {
    if (m.replacements.length !== 1) continue;
    const from = text.slice(m.offset, m.offset + m.length);
    const to = m.replacements[0].value;
    if (from === to) continue;
    // Nur Big→Small. Erster Zeichen-Unterschied muss Gross→Klein sein.
    if (!CAPITALIZED_WORD_RE.test(from)) continue;
    CAPITALIZED_WORD_RE.lastIndex = 0; // Regex-State zuruecksetzen
    const firstCharFrom = from.charAt(0);
    const firstCharTo = to.charAt(0);
    if (firstCharFrom.toLowerCase() !== firstCharTo.toLowerCase()) continue; // ganz anderes Wort
    if (firstCharFrom === firstCharFrom.toLowerCase()) continue; // Original war schon klein
    if (firstCharTo !== firstCharTo.toLowerCase()) continue; // Replacement nicht klein
    // Pruefe: Wort darf nicht am Satzanfang stehen
    if (isSentenceStart(text, m.offset)) continue;
    // Allowlist: weder das ganze Wort noch sein Praefix
    if (allowlist.has(from)) continue;
    // Auch Single-Word-Praefix pruefen (z.B. `LED-Modul` → `LED` ist allowed)
    const prefixMatch = from.match(/^[\p{Lu}]+/u);
    if (prefixMatch && allowlist.has(prefixMatch[0])) continue;

    fixes.push({ from, to, offset: m.offset, ruleId: m.rule.id });
  }

  // Greedy von hinten nach vorne anwenden, damit Offsets nicht verschieben.
  fixes.sort((a, b) => b.offset - a.offset);
  let corrected = text;
  for (const fix of fixes) {
    corrected = corrected.slice(0, fix.offset) + fix.to + corrected.slice(fix.offset + fix.from.length);
  }
  // Wieder nach Offset sortieren fuer Audit-Log
  fixes.sort((a, b) => a.offset - b.offset);
  return { corrected, fixes };
}

/**
 * Wendet nur "sichere" Matches automatisch an: genau eine Replacement,
 * Kategorie in der silentCategories-Whitelist. Liefert den korrigierten Text
 * plus Liste der angewandten Änderungen (zur Logging im Project).
 *
 * Greedy von hinten nach vorne, damit Offsets nicht verschieben.
 */
export function applyHighConfidenceFixes(
  text: string,
  matches: LtMatch[],
  silentCategories: string[] = config.languagetool.silentCategories,
): { corrected: string; applied: Array<{ from: string; to: string; ruleId: string }> } {
  const whitelist = new Set(silentCategories.map((c) => c.toUpperCase()));
  const safe = matches
    .filter(
      (m) =>
        m.replacements.length === 1 &&
        m.rule?.category?.id &&
        whitelist.has(m.rule.category.id.toUpperCase()),
    )
    .sort((a, b) => b.offset - a.offset);

  let corrected = text;
  const applied: Array<{ from: string; to: string; ruleId: string }> = [];
  for (const m of safe) {
    const from = corrected.slice(m.offset, m.offset + m.length);
    const to = m.replacements[0].value;
    if (from === to) continue;
    corrected = corrected.slice(0, m.offset) + to + corrected.slice(m.offset + m.length);
    applied.push({ from, to, ruleId: m.rule.id });
  }
  return { corrected, applied };
}
