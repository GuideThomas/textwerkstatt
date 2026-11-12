/**
 * Wortvergleich und Absatzzerlegung für die Gegenüberstellung im Schritt „Optimieren“ (Textwerkstatt Phase 4, #1840).
 *
 * `absaetze` zerlegt genau wie `absaetze()` in `src/services/optimieren/pruefung.ts`: Der Server liefert die Paare je Absatz,
 * die Oberfläche setzt die gewählten wieder in den Originaltext ein. Weichen die beiden Zerlegungen ab, landet ein Absatz an
 * der falschen Stelle; deshalb dieselbe Regel (Trenner sind Folgen von Zeilenumbrüchen, leere Teile zählen nicht).
 */

export type DiffTeil = { art: 'gleich' | 'weg' | 'neu'; text: string };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const vereinheitlicht = (s: string) =>
  s.replace(/\p{Cf}/gu, '').replace(/[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, ' ').toLowerCase();

/**
 * Steht ein Wort als ganzes Wort im Text? Dieselbe Regel wie `werteSucher` am Server (`src/services/optimieren/werte.ts`), mit
 * der die Vorschau verdeckt: „Lichtleiste“ verdeckt nicht „Lichtleisten“. Eine Maske, die nach dieser Regel nichts mehr
 * trifft, wirkt nicht mehr und wird deshalb gemeldet (Review M1-Rest).
 */
export function wortSucher(text: string): (wort: string) => boolean {
  const t = vereinheitlicht(text);
  return (wort) => {
    const w = vereinheitlicht(wort).trim();
    if (!w) return false;
    return new RegExp(`(?<![\\p{L}\\p{N}])${w.split(' ').map(escapeRe).join(' ')}(?![\\p{L}\\p{N}])`, 'u').test(t);
  };
}

/** Ab dieser Zahl an Wörtern (je Seite) wird nicht verglichen, sondern das Ergebnis ohne Markierung gezeigt. */
const HOECHSTENS = 3000;

const zerlegen = (s: string): string[] => s.match(/\s+|[^\s]+/g) ?? [];

/** Wortweise: was gleich blieb, was wegfiel, was neu ist. `null`, wenn der Text für den Vergleich zu lang ist. */
export function wortDiff(alt: string, neu: string): DiffTeil[] | null {
  const a = zerlegen(alt);
  const b = zerlegen(neu);
  if (a.length > HOECHSTENS || b.length > HOECHSTENS) return null;
  const n = a.length;
  const m = b.length;
  // Längster gemeinsamer Teil von hinten, eine Zeile je Wort (Uint16 reicht bis 65.535, hier höchstens 3.000).
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const teile: DiffTeil[] = [];
  const dazu = (art: DiffTeil['art'], text: string) => {
    const letzter = teile[teile.length - 1];
    if (letzter && letzter.art === art) letzter.text += text;
    else teile.push({ art, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { dazu('gleich', a[i]); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { dazu('weg', a[i]); i += 1; }
    else { dazu('neu', b[j]); j += 1; }
  }
  while (i < n) { dazu('weg', a[i]); i += 1; }
  while (j < m) { dazu('neu', b[j]); j += 1; }
  return teile;
}

/** Inhaltsabsätze wie am Server. */
export function absaetze(text: string): string[] {
  return text.split(/(\n+)/).filter((p, i) => i % 2 === 0 && p.trim() !== '');
}

/** Setzt die gewählten Absätze des Ergebnisses in das Original ein; Trenner und übrige Absätze bleiben. */
export function absaetzeEinsetzen(original: string, neu: string[], auswahl: ReadonlySet<number>): string {
  let k = 0;
  return original
    .split(/(\n+)/)
    .map((p, i) => {
      if (i % 2 !== 0 || p.trim() === '') return p;
      const nr = k;
      k += 1;
      return auswahl.has(nr) && neu[nr] !== undefined ? neu[nr] : p;
    })
    .join('');
}
