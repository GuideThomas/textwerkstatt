/**
 * Werte (Namen, Firmen, Begriffe, Nummern) in einem Text finden — mit zwei Regeln für zwei verschiedene Fragen.
 *
 *  1. „Steht der Wert im Ergebnis?“ (`werteSucher`, `wertStatus`): als ganzes Wort, ohne Rücksicht auf Groß/klein und
 *     Leerraum. „Li“ steckt nicht in „Lichtleiste“. Eine Telefon- oder Bankverbindung zählt nach ihren Ziffern
 *     („0664/1234567“ = „0664 1234567“), ein ganzer Name gilt als gekürzt, wenn nur ein Teil dasteht („Hallo Karl“).
 *
 *  2. „Verrät dieser Text einen verdeckten Wert?“ (`verraetWert`): strenger, auch als Wortteil. Gemessen im Review vom
 *     11.11.2026 (H1-Rest): Mit der Ganzwort-Regel gingen „Lichtleistenprofil“, „Brennhofers“ und „Mayrtrafo“ in die
 *     Anweisung an die Cloud, obwohl „Lichtleiste“, „Brennhofer“ und „Mayr“ verdeckt waren. Ab 4 Zeichen genügt deshalb
 *     jedes Vorkommen als Zeichenfolge; darunter das ganze Wort, sonst träfe „Li“ jedes „Licht“. Lieber eine Anweisung zu
 *     viel abgelehnt als ein verdecktes Wort in der Cloud.
 */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Formatzeichen weg, besondere Leerzeichen und Zeilenumbrüche als ein Leerzeichen, klein. */
export function fuerWertvergleich(s: string): string {
  return s
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s   -   　]+/g, ' ')
    .toLowerCase();
}

const MUSTER = new Map<string, RegExp | null>();
function ganzwortMuster(wert: string): RegExp | null {
  const w = fuerWertvergleich(wert).trim();
  if (!MUSTER.has(w)) {
    MUSTER.set(w, w ? new RegExp(`(?<![\\p{L}\\p{N}])${w.split(' ').map(escapeRe).join(' ')}(?![\\p{L}\\p{N}])`, 'u') : null);
    if (MUSTER.size > 5000) MUSTER.clear();
  }
  return MUSTER.get(w) ?? null;
}

/** Sucht viele Werte in einem Text; der Text wird einmal vereinheitlicht, die Muster werden wiederverwendet. */
export function werteSucher(text: string): (wert: string) => boolean {
  const t = fuerWertvergleich(text);
  return (wert) => ganzwortMuster(wert)?.test(t) ?? false;
}

export function wertKommtVor(text: string, wert: string): boolean {
  return werteSucher(text)(wert);
}

/** Die Werte, die im Text vorkommen, in der Reihenfolge der Liste, ohne Doppel. */
export function enthalteneWerte(text: string, werte: readonly string[]): string[] {
  const hat = werteSucher(text);
  return [...new Set(werte)].filter((w) => w.trim() && hat(w));
}

/**
 * Für Frage 2 auch andere Schreibungen desselben Wortes: zusammengesetzte Unicode-Form, „ü“ = „ue“, „ß“ = „ss“, ohne
 * Bindestriche und Leerzeichen. Sonst gingen „Mueller-Trafo“ für verdecktes „Müller“ und „Müllerlicht“ für „Müller-Licht“
 * hinaus (Review, zweite Nachprüfung).
 */
export function fuerVerrat(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[\p{Cf}\s\u00A0\u202F\-‐‑–—_.'’]/gu, '');
}

/** Frage 2: Verrät der Text den Wert, auch als Wortteil, gebeugt oder anders geschrieben? Ab 4 Zeichen als Zeichenfolge. */
export function verraetWert(text: string, wert: string): boolean {
  const w = fuerWertvergleich(wert).trim();
  if (!w) return false;
  if (w.length < 4) return ganzwortMuster(w)?.test(fuerWertvergleich(text)) ?? false;
  return fuerWertvergleich(text).includes(w) || fuerVerrat(text).includes(fuerVerrat(wert));
}

/** Die verdeckten Werte, die ein Text verrät (Frage 2). */
export function verrateneWerte(text: string, werte: readonly string[]): string[] {
  return [...new Set(werte)].filter((w) => verraetWert(text, w));
}

// ── Frage 1 mit Klasse ───────────────────────────────────────────────────────────────────────────────────────────────

export interface Wert {
  wert: string;
  klasse: string;
}

const ZIFFERN_KLASSEN = new Set(['TELEFON', 'BANK']);
const TITEL = new Set(['herr', 'herrn', 'frau', 'dr', 'dr.', 'mag', 'mag.', 'mag.a', 'di', 'ing', 'ing.', 'dipl.-ing.', 'prof', 'prof.']);

/**
 * Die Ziffern des Werts in dieser Folge, dazwischen beliebige Trenner („0664/1234567“ = „0664 1234567“). Der Text selbst wird
 * nicht zusammengezogen: Sonst verschmölze „6020 0664 1234567“ (Postleitzahl und Telefon) zu einer Folge, und die Nummer
 * fehlte (Review, zweite Nachprüfung).
 */
const ziffernMuster = (ziffern: string) => new RegExp(`(?<!\\d)${ziffern.split('').join('[\\s/.\\-()]*')}(?!\\d)`);

/**
 * Steht der Wert im Text? `teil`: Von einem ganzen Namen steht nur ein Teil da („Herr Karl Moser“ → „Hallo Karl“). Das ist
 * bei Informell gewollt und deshalb ein Hinweis, kein Verstoß (Review W1).
 */
export function wertStatus(text: string, w: Wert, hat: (wert: string) => boolean = werteSucher(text)): 'ja' | 'teil' | 'nein' {
  if (ZIFFERN_KLASSEN.has(w.klasse)) {
    const z = w.wert.replace(/\D/g, '');
    if (z.length >= 5) return ziffernMuster(z).test(text) ? 'ja' : 'nein';
  }
  if (hat(w.wert)) return 'ja';
  if (w.klasse === 'PERSON') {
    const teile = w.wert.split(/\s+/).filter((x) => x.length >= 2 && !TITEL.has(x.toLowerCase()));
    if (teile.length > 1 && teile.some((x) => hat(x))) return 'teil';
  }
  return 'nein';
}
