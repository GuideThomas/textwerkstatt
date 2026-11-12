/**
 * Pol-/Litzenzahl-Schutz (18.06.2026)
 *
 * Problem: In Artikelnamen steht die Pol-/Litzenzahl als kompakter Token wie
 * `4-polig`, `2-pol.`, `2 polig`, `3pol.` (Anzahl der Litzen/Pole bei Kabeln,
 * Track48-Schienen, Steckern, Einspeisungen). DeepL "verschluckt" diese Angabe
 * teils komplett oder verstuemmelt die Zahl — die Litzenanzahl geht in der
 * Uebersetzung verloren.
 *
 * Loesung: Das gesamte `<Zahl><Sep>pol[ig][.]`-Konstrukt wird VOR DeepL durch
 * einen Sentinel ersetzt und danach mit der ZIELSPRACHEN-Form restored
 * (EN `4-pole`, IT `4 poli`, FR `4 pôles`, ...). DeepL sieht den Token nie,
 * die Zahl bleibt garantiert erhalten. Gleiches Sentinel-Muster wie
 * `acronym-protection.ts` / Magento-Direktiven.
 *
 * Terminologie-Entscheidung (Thomas, 18.06.2026): Pol-Semantik (nicht
 * Ader/Litze), da der Token auch bei Track48-Schienen/Steckern verwendet wird.
 */

const POLE_SENTINEL_PREFIX = '__ISOLPOL';

// <Zahl 1-2-stellig> + optionaler Separator (Bindestrich und/oder Leerzeichen)
// + "pol" + optional Abk.-Punkt ODER "ig" mit optionaler deutscher
// Deklinationsendung (-e/-er/-en/-es/-em). Case-insensitive.
//
// Trifft: 4-polig · 2-pol. · 2 polig · 4polig · 3pol. · 2-pol · 4-poliger
// Lookbehind/-ahead verhindern Treffer mitten in Woertern oder Codes
// (z.B. "Napoli", "Bipolar", "Track48polig" gibt es nicht — aber sicher ist sicher).
const POLE_PATTERN_SOURCE =
  '(?<![A-Za-z0-9])(\\d{1,2})\\s*-?\\s*pol(?:\\.|ig(?:e[rnms]?)?)?(?![A-Za-zÄÖÜäöüß])';

function buildPoleRegex(): RegExp {
  // Frische Instanz pro Aufruf — vermeidet lastIndex-State bei /g.
  return new RegExp(POLE_PATTERN_SOURCE, 'gi');
}

/**
 * Zielsprachen-Form der Pol-Angabe. `n` = die (unveraenderte) Zahl als String.
 * Schluessel sind die 2-Buchstaben-Codes wie sie das Tool/der Artikelanlage-
 * Assistent liefert (EN, PL, IT, HU, FR, ES, CZ, SK). CS = Alias fuer CZ.
 */
const POLE_TERM_BY_LANG: Record<string, (n: string) => string> = {
  DE: (n) => `${n}-polig`,
  EN: (n) => `${n}-pole`,
  IT: (n) => `${n} poli`,
  FR: (n) => `${n} pôles`,
  ES: (n) => `${n} polos`,
  PL: (n) => `${n}-biegunowy`,
  HU: (n) => `${n} pólusú`,
  CZ: (n) => `${n}-pólový`,
  CS: (n) => `${n}-pólový`,
  SK: (n) => `${n}-pólový`,
};

function normalizeLang(targetLang: string): string {
  return (targetLang || '').slice(0, 2).toUpperCase();
}

/** Liefert die lokalisierte Pol-Form, oder null wenn die Sprache unbekannt ist. */
export function localizePole(num: string, targetLang: string): string | null {
  const fmt = POLE_TERM_BY_LANG[normalizeLang(targetLang)];
  return fmt ? fmt(num) : null;
}

export interface PoleProtection {
  protectedText: string;
  restoreMap: Map<string, string>;
  /** Audit-Trail: welche Pol-Angaben wurden ersetzt? */
  substitutions: Array<{ source: string; target: string }>;
}

/**
 * Schuetzt alle `<Zahl><Sep>pol...`-Konstrukte vor DeepL und merkt sich die
 * ZIELSPRACHEN-Form fuer den Restore. Bei unbekannter Zielsprache wird der
 * Original-Token verbatim geschuetzt (Zahl bleibt erhalten, Wort bleibt deutsch)
 * — immer noch besser als von DeepL verschluckt zu werden.
 */
export function protectPoleCounts(text: string, targetLang: string): PoleProtection {
  const restoreMap = new Map<string, string>();
  const substitutions: Array<{ source: string; target: string }> = [];

  let counter = 0;
  const protectedText = text.replace(buildPoleRegex(), (match, num: string) => {
    const restored = localizePole(num, targetLang) ?? match;
    const sentinel = `${POLE_SENTINEL_PREFIX}${counter++}__`;
    restoreMap.set(sentinel, restored);
    substitutions.push({ source: match, target: restored });
    return sentinel;
  });

  return { protectedText, restoreMap, substitutions };
}

export function restorePoleCounts(text: string, restoreMap: Map<string, string>): string {
  let result = text;
  for (const [sentinel, original] of restoreMap.entries()) {
    result = result.split(sentinel).join(original);
  }
  return result;
}

/** True, wenn der Text mindestens eine Pol-/Litzenzahl-Angabe enthaelt. */
export function hasPolePattern(text: string): boolean {
  return buildPoleRegex().test(text);
}
