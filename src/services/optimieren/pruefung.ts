/**
 * Harte Prüfung nach der Antwort (Textwerkstatt Phase 4, Plan `PLAN-textwerkstatt.md` §3 G1 und §4 Phase 4, Cockpit #1840).
 *
 * Die Anweisung bittet das Modell, Zahlen, Platzhalter, Hausbegriffe und die Anrede in Ruhe zu lassen. Eine Bitte ist keine
 * Schranke (gemessen in `capitalization-llm.ts`: 10 von 10 Läufen drehten die Anrede trotz Hinweis zurück). Deshalb prüft
 * dieser Code das Ergebnis gegen das Original, und zwar beide im Klartext: beim Cloud-Weg also nach dem Zurücksetzen der
 * Platzhalter. Beide Seiten gehen vorher durch dieselbe Vereinheitlichung (geschützte Leerzeichen, Formatzeichen, CRLF):
 * Der Cloud-Weg sendet den vereinheitlichten Text, und ohne das galt eine unveränderte Antwort als geändert (Review M6).
 *
 * Zwei Stufen, damit nichts still durchgeht:
 *   verstoss  Das Ergebnis gilt als verworfen. Die Oberfläche zeigt es mit Grund, bietet aber keine Übernahme an.
 *   hinweis   Übernehmen geht, der Grund steht sichtbar daneben (Kürzen hat eine Zahl weggelassen, Ziel überschritten).
 *
 * Was eine Art lockern darf, steht in `textwerkstatt_arten` (Migration 044); dass geprüft wird, steht hier.
 *
 * Grenzen, bewusst benannt (Review 11.11.2026, N4/N5): Bedeutungswörter um eine Zahl („mindestens 50.000 h“ → „bis zu
 * 50.000 h“) prüft hier nichts; ein Hausbegriff wird gezählt, nicht verortet.
 *
 * Reine Funktionen ohne Datenbank und ohne Netz, damit `src/scripts/check-optimieren.ts` sie mit präparierten Antworten
 * prüfen kann.
 */
import { findHouseTermMatches, type HouseTerm } from '../house-terms';
import { placeholders as markupFolgen } from '../channel-fassung';
import { Wert, fuerVerrat, fuerWertvergleich, wertStatus, werteSucher } from './werte';

export type Zahlenregel = 'alle' | 'keine_neuen';
export type Anrederegel = 'beibehalten' | 'du' | 'sie';

export interface OptimierArt {
  id: string;
  name: string;
  beschreibung: string;
  anweisung: string;
  zahlen: Zahlenregel;
  platzhalter_fehlen_erlaubt: boolean;
  anrede: Anrederegel;
  /** Darf das Modell die Reihenfolge der Angaben ändern? Nein bei Korrigieren und bei du/Sie (Review M3). */
  umstellen_erlaubt: boolean;
  laenge_min: number;
  laenge_max: number;
  zielzeichen: boolean;
  aktiv: boolean;
  reihenfolge: number;
}

export type PruefStufe = 'ok' | 'hinweis' | 'verstoss';
export type PruefCode =
  | 'ZAHL_NEU'
  | 'ZAHL_FEHLT'
  | 'ZAHL_GEAENDERT'
  | 'ZAHL_VERTAUSCHT'
  | 'ZAHL_UNSICHER'
  | 'PLATZHALTER_FEHLT'
  | 'WERT_FEHLT'
  | 'WERT_TEILWEISE'
  | 'MARKUP_GEAENDERT'
  | 'HAUSBEGRIFF_ZURUECK'
  | 'HAUSBEGRIFF_OFFEN'
  | 'HAUSSCHREIBWEISE_UNGEPRUEFT'
  | 'ANREDE_SIE'
  | 'ANREDE_DU'
  | 'ANREDE_GEWECHSELT'
  | 'ANREDE_MEHRDEUTIG'
  | 'ANREDE_NEU'
  | 'LAENGE_KURZ'
  | 'LAENGE_LANG'
  | 'ZIEL_UEBERSCHRITTEN'
  | 'ANTWORT_ABGESCHNITTEN'
  /** Phase 5: Die Channel-Fassung hat nach dem Lauf Begriffe nach Regel ersetzt; Artikel und Endungen sind ungeprüft. */
  | 'CHANNEL_REGEL'
  /** Phase 5: Die Channel-Fassung hätte das Ergebnis verworfen; es bleibt der Stand davor, die Begriffe des Channels fehlen. */
  | 'CHANNEL_OFFEN';

export type PruefArt =
  | 'antwort' | 'zahlen' | 'platzhalter' | 'werte' | 'markup' | 'hausschreibweise' | 'anrede' | 'laenge' | 'zielzeichen' | 'channel';

export interface PruefPunkt {
  pruefung: PruefArt;
  stufe: PruefStufe;
  code: PruefCode | null;
  /** Was im Ergebnis fehlt (Zahlen mit Einheit, Platzhalter, Werte, Zeichenfolgen). */
  fehlt?: string[];
  /** Was im Ergebnis neu ist (Zahlen, Hausbegriffe als „vermieden → bevorzugt“). */
  neu?: string[];
  /** Messwert: Längenverhältnis, Zeichen, Anzahl der Anredeformen. */
  ist?: number;
  soll?: number | [number, number];
}

export interface Befund {
  ergebnis: 'ok' | 'hinweis' | 'verworfen';
  punkte: PruefPunkt[];
  /** Codes aller nicht bestandenen Punkte, für das Laufprotokoll (nie ein Wert aus dem Text). */
  gruende: PruefCode[];
}

// ── Vereinheitlichung für den Vergleich ──────────────────────────────────────────────────────────────────────────────

const BESONDERE_LEERZEICHEN = /[   -   　]/g;

/** Dieselbe Form für Original und Ergebnis: geschützte Leerzeichen als Leerzeichen, Formatzeichen weg, Zeilenende `\n`. */
export function fuerVergleich(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\p{Cf}/gu, '').replace(BESONDERE_LEERZEICHEN, ' ');
}

// ── Zahlen und Einheiten ─────────────────────────────────────────────────────────────────────────────────────────────

// Zeichen-Einheiten und ihre ausgeschriebenen Formen, jeweils auf eine Form gebracht. Längere zuerst („min“ vor „m“).
// Ein Wort wie „Betriebsstunden“ ist keine Einheit; dann steht die Zahl ohne Einheit da, und das ist kein Widerspruch
// (siehe Vergleich unten).
const EINHEIT_FORM: Record<string, string> = {
  'lm/W': 'lm/W', 'lm/m': 'lm/m', 'W/m': 'W/m', kWh: 'kWh', kW: 'kW', mW: 'mW', W: 'W', mA: 'mA', A: 'A', kV: 'kV', mV: 'mV',
  VDC: 'V', VAC: 'V', V: 'V', K: 'K', lm: 'lm', lx: 'lx', cd: 'cd', kHz: 'kHz', MHz: 'MHz', Hz: 'Hz', 'mm²': 'mm²', mm: 'mm',
  cm: 'cm', dm: 'dm', km: 'km', 'm²': 'm²', m2: 'm²', 'm³': 'm³', m3: 'm³', m: 'm', 'µm': 'µm', kg: 'kg', g: 'g', '°C': '°C',
  '°F': '°F', '°': '°', '%': '%', '‰': '‰', ms: 'ms', min: 'min', h: 'h', s: 's', 'Ω': 'Ω', '€': '€', EUR: '€', Euro: '€',
  CHF: 'CHF', USD: '$', $: '$',
  Prozent: '%', Volt: 'V', Watt: 'W', Kilowatt: 'kW', Ampere: 'A', Milliampere: 'mA', Kelvin: 'K', Lumen: 'lm', Lux: 'lx',
  Hertz: 'Hz', Millimeter: 'mm', Millimetern: 'mm', Zentimeter: 'cm', Zentimetern: 'cm', Kilometer: 'km', Kilometern: 'km',
  Meter: 'm', Metern: 'm', Kilogramm: 'kg', Gramm: 'g', 'Grad Celsius': '°C', Grad: '°', Stunde: 'h', Stunden: 'h',
  'Std.': 'h', Minute: 'min', Minuten: 'min', Sekunde: 's', Sekunden: 's', Franken: 'CHF',
  // Zeitwörter: „50.000 h“ → „50.000 Tage“ und „3 Jahre“ → „3 Monate“ sind geänderte Angaben (Review Z1).
  Tag: 'Tag', Tage: 'Tag', Tagen: 'Tag', Woche: 'Woche', Wochen: 'Woche', Monat: 'Monat', Monate: 'Monat', Monaten: 'Monat',
  Jahr: 'Jahr', Jahre: 'Jahr', Jahren: 'Jahr',
};
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const EINHEIT_RE = Object.keys(EINHEIT_FORM).sort((a, b) => b.length - a.length).map(escapeRe).join('|');

// Tausender mit Punkt oder Apostroph, nur in Dreiergruppen: „1.200 lm“, „8'940.50“. Ein Leerzeichen zwischen Ziffern
// („3 600 lm“, aus einem geschützten Leerzeichen vereinheitlicht) ist mehrdeutig: 3600 oder „5 150 W“ = 5 × 150 W. Solche
// Gruppen liest `zahlenAuslesen` in der Lesart, die die andere Seite stützt (Review Z1).
const ZAHL = String.raw`\d{1,3}(?:['’]\d{3}(?!\d))+(?:[.,]\d+)?|\d{1,3}(?:\.\d{3}(?!\d))+(?:,\d+)?|\d+(?:[.,]\d+)?`;
const LEERGRUPPE = String.raw`\d{1,3}(?: \d{3}(?!\d))+(?:,\d+)?`;
const VORN = '(?<![\\p{L}\\p{N}])';
const MONATE: Record<string, number> = {
  januar: 1, jänner: 1, jan: 1, februar: 2, feber: 2, feb: 2, märz: 3, mär: 3, mrz: 3, april: 4, apr: 4, mai: 5, juni: 6, jun: 6,
  juli: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12,
  dez: 12,
};
// Groß und klein („November“, „nov.“): Der Ausdruck läuft ohne `i`, sonst träfe die Einheit „m“ auch „M“.
const MONAT_RE = Object.keys(MONATE)
  .sort((a, b) => b.length - a.length)
  .flatMap((m) => [m[0].toUpperCase() + m.slice(1), m])
  .join('|');

// Je Fundstelle genau eine Alternative; die Reihenfolge zählt: Datum vor Zahl, Zahl mit Einheit vor Bezeichnung.
const MARKEN_RE = new RegExp(
  [
    `(?<datum>${VORN}(?<dt>\\d{1,2})\\.(?<dm>\\d{1,2})\\.(?<dj>\\d{4}|\\d{2})?(?!\\p{N}))`,
    `(?<datumN>${VORN}(?<nt>\\d{1,2})\\.[ ]?(?<nm>${MONAT_RE})\\.?(?:[ ](?<nj>\\d{4}))?(?![\\p{L}\\p{N}]))`,
    `(?<zeit>${VORN}\\d{1,2}:\\d{2}(?::\\d{2})?(?!\\p{N}))`,
    `(?:(?<wvorn>€|EUR|CHF|USD|\\$)[ ]?(?<zvorn>${ZAHL}))`,
    `(?:${VORN}(?<lgruppe>${LEERGRUPPE})(?:(?:[ ]|-)?(?<lgeinheit>${EINHEIT_RE})(?![\\p{L}\\p{N}]))?)`,
    // Ein Minus zählt, wenn davor Leerraum, Zeilenanfang oder eine Klammer steht: „-30 bis +50 °C“. Ein Bindestrich zwischen
    // zwei Zahlen („2700-6500 K“) bleibt ein Bereich (Review M2).
    `(?:(?<vz>(?<=^|[\\s(\\[/])[-−+])?${VORN}(?<zahl>${ZAHL})(?:(?:[ ]|-)?(?<einheit>${EINHEIT_RE})(?![\\p{L}\\p{N}]))?)`,
    // Bezeichnung mit Ziffer: IP67, LS24, GU10. Ohne Bindestrich-Teile: „IP67-Schutz“ → „Schutzart IP67“ ändert keine Angabe,
    // und „LL-1500“ zerfällt in „LL“ (ohne Ziffer, zählt nicht) und die Zahl 1500. Ohne Rücksicht auf Groß/klein.
    `(?<code>${VORN}(?=[\\p{L}\\p{N}]*\\p{N})(?=[\\p{L}\\p{N}]*\\p{L})[\\p{L}\\p{N}]+(?![\\p{L}\\p{N}]))`,
  ].join('|'),
  'gmu',
);

const ZAHLWOERTER: Record<string, string> = {
  zwei: '2', drei: '3', vier: '4', fünf: '5', sechs: '6', sieben: '7', acht: '8', neun: '9', zehn: '10', elf: '11', zwölf: '12',
  zwanzig: '20', dreißig: '30', vierzig: '40', fünfzig: '50', sechzig: '60', siebzig: '70', achtzig: '80', neunzig: '90',
  hundert: '100', tausend: '1000',
  // Ordnungszahlen („das zweite Obergeschoss“ → „2. OG“); „achte“ fehlt bewusst, es ist auch ein Verb.
  zweite: '2', dritte: '3', vierte: '4', fünfte: '5', sechste: '6', siebte: '7', neunte: '9', zehnte: '10', elfte: '11',
  zwölfte: '12', zwanzigste: '20',
};
const ORDNUNGSZAHLEN = new Set(['zweite', 'dritte', 'vierte', 'fünfte', 'sechste', 'siebte', 'neunte', 'zehnte', 'elfte', 'zwölfte', 'zwanzigste']);
const ZAHLWORT_RE = new RegExp(
  `(?<![\\p{L}])(${Object.keys(ZAHLWOERTER).sort((a, b) => b.length - a.length).join('|')})(r|s|n|m)?(?![\\p{L}])`,
  'giu',
);
/** Aufzählungsnummern am Zeilenanfang („1. “, „2) “) sind Gliederung, keine Angabe; „12. Dezember“ am Zeilenanfang nicht. */
const AUFZAEHLUNG_RE = new RegExp(`^[ \\t]*\\d{1,2}[.)][ \\t]+(?!(?:${MONAT_RE})(?![\\p{L}]))`, 'gimu');
/** Zwischen zwei Zahlen eines Bereichs („2700–6500 K“, „12/24 V“, „12, 24 und 48 V“) gilt die Einheit der letzten für alle. */
const BEREICH_RE = /^\s*(?:[–—\-/,]|bis|und|oder)\s*$/u;
/** Schreibweisen von Schutzarten vereinheitlichen: „IP 67“ = „IP67“. */
const SCHUTZART_RE = /(?<![\p{L}])(IP|IK)[ ]+(\d{2})(?!\p{N})/gu;

/** Vor einem großgeschriebenen Wort: steht es am Satzanfang? */
const SATZANFANG_RE = /(?:^|[.!?:…\n•·▪\-–—])[\s"„“”‚‘'«»(\[]*$/u;
const amSatzanfang = (text: string, pos: number) => SATZANFANG_RE.test(text.slice(Math.max(0, pos - 40), pos));

function zahlWert(roh: string, vorzeichen: string | undefined): string {
  let s = roh;
  if (/['’]/.test(s)) s = s.replace(/['’]/g, '').replace(',', '.');
  else {
    if (/^\d{1,3}(?:[ .]\d{3})+(?:,\d+)?$/.test(s)) s = s.replace(/[ .]/g, '');
    s = s.replace(',', '.');
  }
  const n = Number(s) * (vorzeichen === '-' || vorzeichen === '−' ? -1 : 1);
  return Number.isFinite(n) ? String(n) : roh;
}

export interface Marke {
  /** Vergleichsschlüssel ohne Einheit: Zahl, Datum, Uhrzeit oder Bezeichnung. */
  schluessel: string;
  /** Einheit in vereinheitlichter Form, leer ohne Einheit. Nur bei Zahlen. */
  einheit: string;
  anzeige: string;
  start: number;
  ende: number;
  /** Aus einem Zahlwort („zwei“): nimmt nicht an Bereichen teil. */
  wort: boolean;
  /**
   * Unsicher als Angabe: eine nackte „1“ (oft „ein/eine“ als Ziffer), eine Ordnungszahl („zum zweiten Mal“ → „erneut“), eine
   * Leerzeichen-Gruppe, die in der zusammengezogenen Lesart gelesen wurde. Fehlt oder kommt nur so etwas dazu, ist das ein
   * Hinweis, kein Verstoß.
   */
  schwach: boolean;
  /** Aus einer Leerzeichen-Gruppe zusammengezogen („3 600“ als 3600, weil die andere Seite „3600“ schreibt). */
  gruppe?: boolean;
  /** Teil einer getrennt gelesenen Leerzeichen-Gruppe („3 600“ als 3 und 600): Kennung der Gruppe und ihre Anzeige. */
  teilVon?: { id: number; anzeige: string };
}

/** „1 Tag“, „1 Stunde“: meist „ein Tag“ als Ziffer geschrieben (Korpus PB09); wie die nackte „1“ nur ein Hinweis. */
const ZEIT_EINHEITEN = new Set(['Tag', 'Woche', 'Monat', 'Jahr', 'h', 'min', 's']);

/** Werte der Zahlen ohne Leerzeichen-Gruppen: Stützt die andere Seite die zusammengezogene Lesart einer Gruppe? */
function einzelWerte(t: string): Set<string> {
  const re = new RegExp(`${VORN}(?:${ZAHL})(?![\\p{N}])`, 'gu');
  return new Set([...t.matchAll(re)].map((m) => zahlWert(m[0], undefined)));
}
function gruppenWerte(t: string): string[] {
  return [...t.matchAll(new RegExp(`${VORN}${LEERGRUPPE}`, 'gu'))].map((m) => zahlWert(m[0].replace(/ /g, ''), undefined));
}

/**
 * Zahlen, Einheiten, Daten und Bezeichnungen mit Ziffern eines Textes, vereinheitlicht: „1.200 lm“ = „1200 Lumen“,
 * „89,90 €“ = „€ 89,90“, „48V“ = „48 V“, „zwei“ = „2“, „20.11.26“ = „20. November 2026“, „-20 °C“ ≠ „20 °C“.
 */
export function zahlenAuslesen(roh: string, zusammen: ReadonlySet<string> = new Set()): Marke[] {
  const woerter = new Set<number>();
  const ordnung = new Set<number>();
  return markenAus(vorbereiten(roh), woerter, ordnung, zusammen);
}

/** Vereinheitlichen, Aufzählungen und Schutzarten; Zahlwörter erst in `markenAus`, weil dort die Stellen gemerkt werden. */
function vorbereiten(roh: string): string {
  return fuerVergleich(roh)
    .replace(AUFZAEHLUNG_RE, (m) => ' '.repeat(m.length))
    .replace(SCHUTZART_RE, (m, a: string, b: string) => `${a}${b}${' '.repeat(m.length - a.length - b.length)}`);
}

function markenAus(vorbereitet: string, woerter: Set<number>, ordnung: Set<number>, zusammen: ReadonlySet<string>): Marke[] {
  const t = vorbereitet.replace(ZAHLWORT_RE, (m: string, wort: string, _end: string | undefined, pos: number, ganz: string) => {
    // Klein überall, groß nur am Satzanfang: „außer Acht lassen“ ist keine Acht (Review M5).
    if (m[0] !== m[0].toLowerCase() && !amSatzanfang(ganz, pos)) return m;
    const ziffer = ZAHLWOERTER[wort.toLowerCase()];
    // Rechtsbündig, damit eine folgende Einheit an der Zahl hängt („zwei Jahre“ → „   2 Jahre“).
    const start = pos + m.length - ziffer.length;
    woerter.add(start);
    if (ORDNUNGSZAHLEN.has(wort.toLowerCase())) ordnung.add(start);
    return ' '.repeat(m.length - ziffer.length) + ziffer;
  });
  const marken: Marke[] = [];
  for (const m of t.matchAll(MARKEN_RE)) {
    const g = m.groups ?? {};
    const start = m.index ?? 0;
    const ende = start + m[0].length;
    const zahlMarke = (wert: string, einheit: string, schwach = false): Marke => ({
      schluessel: `z:${wert}`, einheit, anzeige: m[0].trim(), start, ende, wort: woerter.has(start),
      schwach: schwach || ordnung.has(start) || (wert === '1' && (!einheit || ZEIT_EINHEITEN.has(einheit))),
    });
    if (g.datum) {
      const j = g.dj ? (g.dj.length === 2 ? `20${g.dj}` : g.dj) : '';
      marken.push({ schluessel: `d:${Number(g.dt)}.${Number(g.dm)}${j ? `.${j}` : ''}`, einheit: '', anzeige: m[0], start, ende, wort: false, schwach: false });
    } else if (g.datumN) {
      const mon = MONATE[g.nm.toLowerCase()];
      marken.push({ schluessel: `d:${Number(g.nt)}.${mon}${g.nj ? `.${g.nj}` : ''}`, einheit: '', anzeige: m[0], start, ende, wort: false, schwach: false });
    } else if (g.zeit) {
      marken.push({ schluessel: `t:${m[0]}`, einheit: '', anzeige: m[0], start, ende, wort: false, schwach: false });
    } else if (g.lgruppe) {
      const einheit = g.lgeinheit ? (EINHEIT_FORM[g.lgeinheit] ?? g.lgeinheit) : '';
      const zus = zahlWert(g.lgruppe.replace(/ /g, ''), undefined);
      if (zusammen.has(zus)) {
        marken.push({ ...zahlMarke(zus, einheit), gruppe: true });
      } else {
        // Getrennt gelesen: „5 150 W“ → 5 und 150 W. Die Einheit hängt an der letzten Zahl.
        const teile = g.lgruppe.split(' ');
        const teilVon = { id: start, anzeige: m[0].trim() };
        let p = start;
        teile.forEach((teil, i) => {
          const letzte = i === teile.length - 1;
          marken.push({
            schluessel: `z:${zahlWert(teil, undefined)}`, einheit: letzte ? einheit : '', anzeige: letzte && einheit ? `${teil} ${einheit}` : teil,
            start: p, ende: p + teil.length, wort: false, schwach: teil === '1' && !(letzte && einheit), teilVon,
          });
          p += teil.length + 1;
        });
      }
    } else if (g.zvorn) {
      marken.push(zahlMarke(zahlWert(g.zvorn, undefined), EINHEIT_FORM[g.wvorn] ?? g.wvorn));
    } else if (g.zahl) {
      marken.push(zahlMarke(zahlWert(g.zahl, g.vz), g.einheit ? (EINHEIT_FORM[g.einheit] ?? g.einheit) : ''));
    } else if (g.code) {
      // Eine Bezeichnung wie „48V“ ist eine Zahl mit Einheit und wird wie „48 V“ verglichen.
      const zu = new RegExp(`^(${ZAHL})(${EINHEIT_RE})$`, 'u').exec(g.code);
      if (zu) marken.push(zahlMarke(zahlWert(zu[1], undefined), EINHEIT_FORM[zu[2]] ?? zu[2]));
      else marken.push({ schluessel: `c:${g.code.toUpperCase()}`, einheit: '', anzeige: g.code, start, ende, wort: false, schwach: false });
    }
  }
  // Bereiche von hinten nach vorn: „12, 24 und 48 V“ → 12 V, 24 V, 48 V. Nicht für Zahlwörter („Zwei, 3000 K“).
  for (let i = marken.length - 2; i >= 0; i -= 1) {
    const a = marken[i];
    const b = marken[i + 1];
    if (!a.schluessel.startsWith('z:') || a.einheit || !b.einheit || a.wort || b.wort) continue;
    if (!BEREICH_RE.test(t.slice(a.ende, b.start))) continue;
    a.einheit = b.einheit;
    a.anzeige = `${a.anzeige} ${b.einheit}`;
  }
  return marken;
}

interface ZahlenVergleich {
  fehlt: string[];
  neu: string[];
  /** Nur eine nackte „1“: oft „ein/eine“ als Ziffer geschrieben oder umgekehrt. Hinweis, kein Verstoß. */
  unsicherFehlt: string[];
  unsicherNeu: string[];
  /** Gleiche Werte, andere Reihenfolge („230 V Eingang, 24 V Ausgang“ getauscht). */
  vertauscht: boolean;
}

/**
 * Als Menge verglichen: Kommt „24 V“ im Ergebnis einmal statt zweimal vor, ist keine Angabe verloren. Eine Zahl gilt als
 * geändert, wenn sie fehlt oder neu ist, oder wenn beide Seiten eine Einheit nennen und keine gemeinsam ist („24 V“ → „24 W“).
 * Steht sie auf einer Seite ohne Einheit („50.000 h“ → „50.000 Betriebsstunden“), ist das kein Widerspruch (Review M5).
 */
function zahlenVergleich(original: string, ergebnis: string, reihenfolge: boolean): ZahlenVergleich {
  const gruppe = (ms: Marke[]) => {
    const g = new Map<string, { einheiten: Map<string, string>; anzeige: string; erste: number; schwach: boolean; gruppe: boolean }>();
    ms.forEach((m, i) => {
      const x = g.get(m.schluessel) ?? { einheiten: new Map<string, string>(), anzeige: m.anzeige, erste: i, schwach: true, gruppe: false };
      if (m.einheit && !x.einheiten.has(m.einheit)) x.einheiten.set(m.einheit, m.anzeige);
      x.schwach = x.schwach && m.schwach;
      x.gruppe = x.gruppe || !!m.gruppe;
      g.set(m.schluessel, x);
    });
    return g;
  };
  // Welche Leerzeichen-Gruppen („3 600“) zusammengezogen gelesen werden: die, deren Wert eine Seite als eine Zahl schreibt.
  const ta = vorbereiten(original);
  const tb = vorbereiten(ergebnis);
  const einzeln = new Set([...einzelWerte(ta), ...einzelWerte(tb)]);
  const zusammen = new Set([...gruppenWerte(ta), ...gruppenWerte(tb)].filter((w) => einzeln.has(w)));
  const ma = zahlenAuslesen(original, zusammen);
  const mb = zahlenAuslesen(ergebnis, zusammen);
  const a = gruppe(ma);
  const b = gruppe(mb);
  const v: ZahlenVergleich = { fehlt: [], neu: [], unsicherFehlt: [], unsicherNeu: [], vertauscht: false };
  // Schwache Werte, die fehlen bzw. neu sind, je Einheit: Fehlt „2. Jahr“ und kommt „3. Jahr“ dazu, ist das eine geänderte
  // Angabe, kein Hinweis (Review, zweite Nachprüfung).
  const schwachFehlt: { anzeige: string; einheiten: string[] }[] = [];
  const schwachNeu: { anzeige: string; einheiten: string[] }[] = [];
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y) {
      if (x.schwach) schwachFehlt.push({ anzeige: x.anzeige, einheiten: [...x.einheiten.keys()] });
      else v.fehlt.push(x.anzeige);
      continue;
    }
    // Einheiten je Wert als Menge: Eine Einheit, die nur eine Seite nennt, ist eine geänderte Angabe — außer eine Seite nennt
    // gar keine („50.000 Betriebsstunden“). „5 m und 5 kg“ → „5 m und 5 g“ fällt so auf (Review Z1).
    if (x.einheiten.size > 0 && y.einheiten.size > 0) {
      for (const [e, anz] of x.einheiten) if (!y.einheiten.has(e)) v.fehlt.push(anz);
      for (const [e, anz] of y.einheiten) if (!x.einheiten.has(e)) v.neu.push(anz);
    }
    // „3 600 lm“ ↔ „3600 lm“: gleich gelesen, aber nur in einer der zwei Lesarten (auch 3 und 600). Sichtbar, nicht still gleich.
    if (x.gruppe !== y.gruppe) v.unsicherNeu.push(x.gruppe ? x.anzeige : y.anzeige);
  }
  for (const [k, y] of b) {
    if (a.has(k)) continue;
    if (y.schwach) schwachNeu.push({ anzeige: y.anzeige, einheiten: [...y.einheiten.keys()] });
    else v.neu.push(y.anzeige);
  }
  const gemeinsameEinheit = schwachFehlt.some((f) => f.einheiten.some((e) => schwachNeu.some((n) => n.einheiten.includes(e))));
  if (gemeinsameEinheit) {
    v.fehlt.push(...schwachFehlt.map((f) => f.anzeige));
    v.neu.push(...schwachNeu.map((n) => n.anzeige));
  } else {
    v.unsicherFehlt.push(...schwachFehlt.map((f) => f.anzeige));
    v.unsicherNeu.push(...schwachNeu.map((n) => n.anzeige));
  }
  // Eine getrennt gelesene Gruppe („3 600 lm“) zählt als Ganzes: Sie gilt als vorhanden, wenn die andere Seite dieselbe Gruppe
  // trägt oder alle Teile als einzelne Zahlen außerhalb einer Gruppe („fünf Netzteile mit je 150 W“). Sonst fielen
  // „3 600 lm“ → „2 600 lm“ und ein zugleich getauschtes „2 Stück“ → „3 Stück“ als Menge nicht auf (Review, zweite Nachprüfung).
  const gruppen = (ms: Marke[]) => {
    const g = new Map<number, { anzeige: string; folge: string; teile: Marke[] }>();
    for (const m of ms) {
      if (!m.teilVon) continue;
      const x = g.get(m.teilVon.id) ?? { anzeige: m.teilVon.anzeige, folge: '', teile: [] };
      x.teile.push(m);
      x.folge = x.teile.map((t) => `${t.schluessel}|${t.einheit}`).join(' ');
      g.set(m.teilVon.id, x);
    }
    return [...g.values()];
  };
  const vorhanden = (grp: { folge: string; teile: Marke[] }, andere: Marke[]) =>
    gruppen(andere).some((o) => o.folge === grp.folge)
    || grp.teile.every((t) => andere.some((o) => !o.teilVon && o.schluessel === t.schluessel && (!t.einheit || !o.einheit || o.einheit === t.einheit)));
  for (const grp of gruppen(ma)) if (!vorhanden(grp, mb) && !v.fehlt.includes(grp.anzeige)) v.fehlt.push(grp.anzeige);
  for (const grp of gruppen(mb)) if (!vorhanden(grp, ma) && !v.neu.includes(grp.anzeige)) v.neu.push(grp.anzeige);
  if (reihenfolge && v.fehlt.length === 0 && v.neu.length === 0) {
    const folge = (g: typeof a, andere: typeof a) =>
      [...g].filter(([k]) => andere.has(k)).sort((p, q) => p[1].erste - q[1].erste).map(([k]) => k).join('|');
    v.vertauscht = folge(a, b) !== folge(b, a);
  }
  return v;
}

/** Stimmen die Zahlen zweier Texte überein (ohne die unsichere „1“)? Für die Übernahme einzelner Absätze. */
export function gleicheZahlen(a: string, b: string, reihenfolge = false): boolean {
  const v = zahlenVergleich(a, b, reihenfolge);
  return v.fehlt.length === 0 && v.neu.length === 0 && !v.vertauscht;
}

// ── Anrede ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const DU_RE = /(?<![\p{L}\p{N}])(du|dich|dir|dein|deine|deinem|deinen|deiner|deines|euch|euer|eure|eurem|euren|eurer|eures)(?![\p{L}\p{N}])/giu;
const SIE_RE = /(?<![\p{L}\p{N}])(Sie|Ihnen|Ihr|Ihre|Ihrem|Ihren|Ihrer|Ihres)(?![\p{L}\p{N}])/gu;

/**
 * Wie oft der Leser geduzt und gesiezt wird. Ein großes „Sie“/„Ihr…“ mitten im Satz ist gesiezt; am Satzanfang ist es
 * mehrdeutig („Sie“ ist dort auch „sie“, „Ihr“ auch „ihr“) und zählt eigens (Review M4).
 */
export function anredeZaehlen(roh: string): { du: number; sie: number; sieAnfang: number } {
  const text = fuerVergleich(roh);
  const du = (text.match(DU_RE) ?? []).length;
  let sie = 0;
  let sieAnfang = 0;
  for (const m of text.matchAll(SIE_RE)) {
    if (amSatzanfang(text, m.index ?? 0)) sieAnfang += 1;
    else sie += 1;
  }
  return { du, sie, sieAnfang };
}

// ── Hausschreibweise ─────────────────────────────────────────────────────────────────────────────────────────────────

function hausTreffer(text: string, begriffe: HouseTerm[]): Map<string, { anzahl: number; bevorzugt: string; wie: string }> {
  const z = new Map<string, { anzahl: number; bevorzugt: string; wie: string }>();
  for (const h of findHouseTermMatches(text, begriffe)) {
    const wie = text.slice(h.offset, h.offset + h.length);
    const k = wie.toLowerCase();
    const alt = z.get(k);
    z.set(k, { anzahl: (alt?.anzahl ?? 0) + 1, bevorzugt: h.replacements[0]?.value ?? '', wie: alt?.wie ?? wie });
  }
  return z;
}

/** Kommt ein vermiedener Begriff im Ergebnis öfter vor als im Original? Dann hat ihn das Modell gebracht. */
function hausZurueck(original: string, ergebnis: string, begriffe: HouseTerm[]) {
  const vorher = hausTreffer(original, begriffe);
  const nachher = hausTreffer(ergebnis, begriffe);
  const anzeigen = (l: [string, { wie: string; bevorzugt: string }][]) => l.map(([, v]) => `${v.wie} → ${v.bevorzugt}`);
  return {
    zurueck: anzeigen([...nachher].filter(([k, v]) => v.anzahl > (vorher.get(k)?.anzahl ?? 0))),
    offen: anzeigen([...nachher].filter(([k, v]) => v.anzahl <= (vorher.get(k)?.anzahl ?? 0))),
  };
}

/**
 * Begriffe, die im Text vorkommen (vermieden oder bevorzugt): Nur die gehen als Hinweis in die Anweisung. Ein Begriff, dessen
 * eine Hälfte ein verdeckter Wert ist oder einen enthält, fällt weg (Review H1): Sonst stünde das verdeckte Wort in der
 * Anweisung. Die Schranke dafür sitzt zusätzlich in `pseudonymSenden`.
 */
export function relevanteBegriffe(text: string, begriffe: HouseTerm[], verdeckt: readonly string[] = [], hoechstens = 20): HouseTerm[] {
  const klein = fuerVergleich(text).toLowerCase();
  // Als Zeichenfolge, in beide Richtungen und ohne Mindestlänge: „Lichtleistenprofil“ verrät „Lichtleiste“, „Brennhofer-Trafo“
  // steckt in „Brennhofer-Trafo GmbH“ (Review H1-Rest). Ein weggelassenes Paar kostet nur einen Hinweis an das Modell.
  const verdecktN = verdeckt.map((w) => fuerVerrat(w)).filter(Boolean);
  const verraet = (s: string) => {
    const h = fuerVerrat(s);
    return !!h && verdecktN.some((w) => h.includes(w) || w.includes(h));
  };
  return begriffe
    .filter((b) => klein.includes(b.avoidTerm.trim().toLowerCase()) || klein.includes(b.preferredTerm.trim().toLowerCase()))
    .filter((b) => !verraet(b.avoidTerm) && !verraet(b.preferredTerm))
    .slice(0, hoechstens);
}

// ── Prüfung ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PruefEingabe {
  original: string;
  ergebnis: string;
  art: Pick<OptimierArt, 'zahlen' | 'platzhalter_fehlen_erlaubt' | 'anrede' | 'laenge_min' | 'laenge_max'> & { umstellen_erlaubt?: boolean };
  /** `null`: Die Hausschreibweise ließ sich nicht laden. Dann gilt die Prüfung als nicht bestanden, nicht als bestanden. */
  begriffe: HouseTerm[] | null;
  /** Cloud: Platzhalter, die gesendet wurden und in der Antwort fehlen. Lokal: `null` (es gibt keine). */
  fehlend: { platzhalter: string }[] | null;
  /** Lokal: im Original erkannte Werte (Personen, Firmen, Mail …), die im Ergebnis wieder stehen müssen. Cloud: `null`. */
  werte?: readonly Wert[] | null;
  zielzeichen: number | null;
  /** Die Antwort endete an der Obergrenze der Token. */
  abgeschnitten?: boolean;
}

/** Unter dieser Länge ist ein Längenverhältnis wenig wert („Hallo.“ → „Hallo!“); dann nur ein Hinweis. */
export const KURZER_TEXT = 40;

/**
 * Welche Werte des Originals im Ergebnis fehlen (`fehlt`) und welche nur gekürzt dastehen (`teil`, ein ganzer Name von dem nur
 * ein Teil blieb). Ein Wert, der Teil eines anderen der Liste ist („Jakob“ in „Jakob Rainer“), zählt nicht eigens.
 */
export function werteVergleich(werte: readonly Wert[], ergebnis: string): { fehlt: string[]; teil: string[] } {
  const eindeutig = [...new Map(werte.filter((w) => w.wert.trim()).map((w) => [w.wert, w])).values()];
  // Je längerem Wert ein Sucher, einmal gebaut: Bei 600 Werten waren es sonst 360.000 Vereinheitlichungen (1,3 s).
  const sucher = eindeutig.map((x) => ({ x, hat: werteSucher(x.wert), laenge: fuerWertvergleich(x.wert).trim().length }));
  const ganz = eindeutig.filter((w) => {
    const l = fuerWertvergleich(w.wert).trim().length;
    return !sucher.some((s) => s.laenge > l && s.hat(w.wert));
  });
  const hat = werteSucher(ergebnis);
  const fehlt: string[] = [];
  const teil: string[] = [];
  for (const w of ganz) {
    const st = wertStatus(ergebnis, w, hat);
    if (st === 'nein') fehlt.push(w.wert);
    else if (st === 'teil') teil.push(w.wert);
  }
  return { fehlt, teil };
}

export function pruefen(eingabe: PruefEingabe): Befund {
  const e = { ...eingabe, original: fuerVergleich(eingabe.original), ergebnis: fuerVergleich(eingabe.ergebnis) };
  const punkte: PruefPunkt[] = [];
  const ok = (pruefung: PruefArt): PruefPunkt => ({ pruefung, stufe: 'ok', code: null });

  // Eine abgeschnittene Antwort ist unvollständig, auch wenn der Rest stimmt (Review M7).
  if (e.abgeschnitten) punkte.push({ pruefung: 'antwort', stufe: 'verstoss', code: 'ANTWORT_ABGESCHNITTEN' });

  // Zahlen und Einheiten: keine neue, keine geänderte; fehlen darf eine nur, wo die Art es erlaubt.
  const umstellen = e.art.umstellen_erlaubt !== false;
  const z = zahlenVergleich(e.original, e.ergebnis, !umstellen);
  if (z.neu.length > 0) {
    punkte.push({ pruefung: 'zahlen', stufe: 'verstoss', code: z.fehlt.length > 0 ? 'ZAHL_GEAENDERT' : 'ZAHL_NEU', fehlt: z.fehlt, neu: z.neu });
  } else if (z.fehlt.length > 0) {
    punkte.push({ pruefung: 'zahlen', stufe: e.art.zahlen === 'alle' ? 'verstoss' : 'hinweis', code: 'ZAHL_FEHLT', fehlt: z.fehlt });
  } else if (z.vertauscht) {
    punkte.push({ pruefung: 'zahlen', stufe: 'verstoss', code: 'ZAHL_VERTAUSCHT' });
  } else if (z.unsicherFehlt.length > 0 || z.unsicherNeu.length > 0) {
    punkte.push({ pruefung: 'zahlen', stufe: 'hinweis', code: 'ZAHL_UNSICHER', fehlt: z.unsicherFehlt, neu: z.unsicherNeu });
  } else {
    punkte.push(ok('zahlen'));
  }

  // Platzhalter der Pseudonymisierung (nur Cloud). Erfundene und `[REDACTED]` verwirft schon `pseudonymSenden`.
  if (e.fehlend) {
    punkte.push(e.fehlend.length > 0
      ? { pruefung: 'platzhalter', stufe: e.art.platzhalter_fehlen_erlaubt ? 'hinweis' : 'verstoss', code: 'PLATZHALTER_FEHLT', fehlt: e.fehlend.map((f) => f.platzhalter) }
      : ok('platzhalter'));
  }
  // Lokal das Gegenstück: die erkannten Werte des Originals. Gemessen 11.11.2026: „Informell“ strich „Frau Steiner“ aus der
  // Anrede, und keine Prüfung schlug an, weil es lokal keine Platzhalter gibt.
  if (e.werte) {
    const w = werteVergleich(e.werte, e.ergebnis);
    if (w.fehlt.length > 0) {
      punkte.push({ pruefung: 'werte', stufe: e.art.platzhalter_fehlen_erlaubt ? 'hinweis' : 'verstoss', code: 'WERT_FEHLT', fehlt: w.fehlt });
    } else if (w.teil.length > 0) {
      // „Herr Karl Moser“ → „Hallo Karl“ ist bei Informell gerade die gewünschte Form (Review W1).
      punkte.push({ pruefung: 'werte', stufe: 'hinweis', code: 'WERT_TEILWEISE', fehlt: w.teil });
    } else {
      punkte.push(ok('werte'));
    }
  }

  // Tags, Marker und Direktiven in derselben Folge (dieselbe Bedingung wie `checkRewrite` der Channel-Fassung).
  const ma = markupFolgen(e.original);
  const mb = markupFolgen(e.ergebnis);
  if (ma.length > 0 || mb.length > 0) {
    punkte.push(JSON.stringify(ma) === JSON.stringify(mb)
      ? ok('markup')
      : { pruefung: 'markup', stufe: 'verstoss', code: 'MARKUP_GEAENDERT', fehlt: ma.filter((x) => !mb.includes(x)), neu: mb.filter((x) => !ma.includes(x)) });
  }

  // Hausschreibweise auf dem Ergebnis: Ein vermiedener Begriff darf nicht (öfter) zurückkommen. Stand er schon im Original
  // und steht noch da, ist das ein Hinweis, kein Verstoß: Den hat nicht das Modell gebracht.
  if (e.begriffe === null) {
    punkte.push({ pruefung: 'hausschreibweise', stufe: 'verstoss', code: 'HAUSSCHREIBWEISE_UNGEPRUEFT' });
  } else {
    const h = hausZurueck(e.original, e.ergebnis, e.begriffe);
    if (h.zurueck.length > 0) punkte.push({ pruefung: 'hausschreibweise', stufe: 'verstoss', code: 'HAUSBEGRIFF_ZURUECK', neu: h.zurueck });
    else if (h.offen.length > 0) punkte.push({ pruefung: 'hausschreibweise', stufe: 'hinweis', code: 'HAUSBEGRIFF_OFFEN', neu: h.offen });
    else punkte.push(ok('hausschreibweise'));
  }

  // Anrede: bei du/Sie durchgesetzt, sonst darf sie nicht wechseln. Ein „Sie“ am Satzanfang ist mehrdeutig: im Du-Ergebnis
  // ein Hinweis, im Original ein Zeichen für „gesiezt“ (Review M4).
  const ar = anredeZaehlen(e.ergebnis);
  if (e.art.anrede === 'du') {
    if (ar.sie > 0) punkte.push({ pruefung: 'anrede', stufe: 'verstoss', code: 'ANREDE_SIE', ist: ar.sie });
    else if (ar.sieAnfang > 0) punkte.push({ pruefung: 'anrede', stufe: 'hinweis', code: 'ANREDE_MEHRDEUTIG', ist: ar.sieAnfang });
    else punkte.push(ok('anrede'));
  } else if (e.art.anrede === 'sie') {
    punkte.push(ar.du > 0 ? { pruefung: 'anrede', stufe: 'verstoss', code: 'ANREDE_DU', ist: ar.du } : ok('anrede'));
  } else {
    const ao = anredeZaehlen(e.original);
    const gesiezt = (ao.sie > 0 || ao.sieAnfang > 0) && ao.du === 0;
    const geduzt = ao.du > 0 && ao.sie === 0 && ao.sieAnfang === 0;
    if ((gesiezt && ar.du > 0) || (geduzt && ar.sie > 0)) {
      punkte.push({ pruefung: 'anrede', stufe: 'verstoss', code: 'ANREDE_GEWECHSELT', ist: gesiezt ? ar.du : ar.sie });
    } else if (ao.du === 0 && ao.sie === 0 && ao.sieAnfang === 0 && (ar.du > 0 || ar.sie > 0)) {
      punkte.push({ pruefung: 'anrede', stufe: 'hinweis', code: 'ANREDE_NEU', ist: ar.du + ar.sie });
    } else {
      punkte.push(ok('anrede'));
    }
  }

  // Länge gegen das Band der Art. Mit Zielzahl gilt die untere Grenze nicht: Dann bestimmt der Nutzer, wie kurz.
  const lo = e.original.trim().length;
  const le = e.ergebnis.trim().length;
  const verhaeltnis = Math.round((le / Math.max(1, lo)) * 100) / 100;
  const unten = e.zielzeichen ? 0 : e.art.laenge_min;
  const stufeLaenge: PruefStufe = lo < KURZER_TEXT ? 'hinweis' : 'verstoss';
  if (verhaeltnis < unten) punkte.push({ pruefung: 'laenge', stufe: stufeLaenge, code: 'LAENGE_KURZ', ist: verhaeltnis, soll: [unten, e.art.laenge_max] });
  else if (verhaeltnis > e.art.laenge_max) punkte.push({ pruefung: 'laenge', stufe: stufeLaenge, code: 'LAENGE_LANG', ist: verhaeltnis, soll: [unten, e.art.laenge_max] });
  else punkte.push(ok('laenge'));

  if (e.zielzeichen) {
    punkte.push(le > e.zielzeichen * 1.1
      ? { pruefung: 'zielzeichen', stufe: 'hinweis', code: 'ZIEL_UEBERSCHRITTEN', ist: le, soll: e.zielzeichen }
      : ok('zielzeichen'));
  }

  const gruende = punkte.filter((p) => p.code).map((p) => p.code!) as PruefCode[];
  const ergebnis = punkte.some((p) => p.stufe === 'verstoss') ? 'verworfen' : punkte.some((p) => p.stufe === 'hinweis') ? 'hinweis' : 'ok';
  return { ergebnis, punkte, gruende };
}

// ── Antwort säubern, Absätze ausrichten ──────────────────────────────────────────────────────────────────────────────

// Nur eine Zeile, die vom Text selbst spricht („Hier ist der überarbeitete Text:“). „Gerne stellen wir Ihnen unser Band vor:“
// ist Inhalt und bleibt (Review N6).
const EINLEITUNG_RE =
  /^(?:hier\s+(?:ist|sind|kommt|folgt)|gerne|gern|natürlich|sicher|klar|selbstverständlich)\b[^\n]{0,120}\b(?:text|fassung|version|überarbeitung|ergebnis|mail|e-mail|nachricht|beschreibung|antwort)\b[^\n]{0,40}:[ \t]*\n+/iu;
const ANFUEHRUNG: [string, string][] = [['„', '“'], ['"', '"'], ['“', '”'], ['»', '«'], ['«', '»']];

/**
 * Was ein Modell trotz Anweisung um den Text legt: Markdown-Zaun, Anführungszeichen um alles, eine Einleitungszeile
 * („Hier ist der überarbeitete Text:“). Weg kommt nur, was nicht schon im Original stand. Leerraum am Rand übernimmt das
 * Ergebnis vom Original, damit eine Übernahme die Umbrüche davor und danach nicht verliert. Zeilen, die das Modell nicht
 * geändert hat, kommen aus dem Original: Sonst ersetzte jede Übernahme still die geschützten Leerzeichen (Review M6).
 */
export function antwortSaeubern(antwort: string, original: string): string {
  let t = antwort.trim();
  if (!original.includes('\r')) t = t.replace(/\r\n?/g, '\n');
  const zaun = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (zaun && !original.trim().startsWith('```')) t = zaun[1].trim();
  if (EINLEITUNG_RE.test(t) && !EINLEITUNG_RE.test(original.trim())) t = t.replace(EINLEITUNG_RE, '').trim();
  const o = original.trim();
  for (const [auf, zu] of ANFUEHRUNG) {
    if (t.length > 2 && t.startsWith(auf) && t.endsWith(zu) && !(o.startsWith(auf) && o.endsWith(zu))) {
      const innen = t.slice(auf.length, t.length - zu.length);
      // Nur, wenn innen kein weiteres Paar steht: „A“ und „B“ ist kein umschließendes Paar.
      if (!innen.includes(zu)) { t = innen.trim(); break; }
    }
  }
  const alteZeilen = new Map<string, string>();
  for (const z of original.split('\n')) {
    const k = fuerVergleich(z).trim();
    if (k && !alteZeilen.has(k)) alteZeilen.set(k, z.replace(/\r$/, ''));
  }
  t = t.split('\n').map((z) => alteZeilen.get(fuerVergleich(z).trim()) ?? z).join('\n');
  const vorn = /^\s*/.exec(original)![0];
  const hinten = /\s*$/.exec(original)![0];
  return vorn + t + hinten;
}

/** Inhaltszeilen eines Textes in der Zerlegung, die auch die Oberfläche für die Übernahme je Absatz nimmt. */
export function absaetze(text: string): string[] {
  return text.split(/(\n+)/).filter((p, i) => i % 2 === 0 && p.trim() !== '');
}

export type AbsatzGrund = 'gleich' | 'zahlen' | 'markup' | 'hausschreibweise' | 'werte' | 'anrede' | 'zuordnung' | 'laenge';

export interface Absatz {
  alt: string;
  neu: string;
  /** Einzeln übernehmbar: Die zusammengesetzte Fassung hält dann jede Prüfung ein, die das Ganze eingehalten hat. */
  waehlbar: boolean;
  /** Warum nicht einzeln übernehmbar. */
  grund: AbsatzGrund | null;
}

const woerter = (s: string) => fuerVergleich(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Anteil gemeinsamer Wörter (in Reihenfolge) an beiden Absätzen; unter 0,3 gehören sie nicht zusammen (Review M9). */
function aehnlichkeit(a: string, b: string): number {
  const x = woerter(a);
  const y = woerter(b);
  if (x.length === 0 && y.length === 0) return 1;
  if (x.length > 400 || y.length > 400) return 0;
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  return (2 * dp[0][0]) / (x.length + y.length);
}

export interface AusrichtKontext {
  art: Pick<OptimierArt, 'anrede' | 'laenge_min' | 'laenge_max'> & { umstellen_erlaubt?: boolean };
  begriffe: HouseTerm[];
  /** Geschützte Werte (Cloud: verdeckte, lokal: erkannte). Je Absatz müssen beide Seiten dieselben tragen. */
  werte: readonly Wert[];
}

/**
 * Absätze von Original und Ergebnis paarweise, wenn ihre Zahl übereinstimmt; sonst `null` (dann nur ganz übernehmen).
 * Einzeln wählbar ist ein Paar nur, wenn es für sich dieselben Zahlen, Tags, Werte trägt, keinen vermiedenen Begriff
 * zurückbringt und erkennbar dieselbe Stelle ist. Bei du/Sie gibt es keine Teilübernahme: Sonst stünden beide Formen im
 * Text (Review M9).
 */
export function absaetzeAusrichten(alt: string, neu: string, k: AusrichtKontext): Absatz[] | null {
  const a = absaetze(alt);
  const b = absaetze(neu);
  if (a.length < 2 || a.length !== b.length) return null;
  const reihenfolge = k.art.umstellen_erlaubt === false;
  const werteGleich = (x: string, y: string) => {
    const hx = werteSucher(x);
    const hy = werteSucher(y);
    return k.werte.every((w) => wertStatus(x, w, hx) === wertStatus(y, w, hy));
  };
  // Je Absatz im Band der Art, nach oben mindestens 1: Dann liegt jede Mischung aus übernommenen und alten Absätzen ebenfalls
  // im Band (Review M9-Rest). Kurze Absätze unter 20 Zeichen zählen nicht, dort ist ein Verhältnis wenig wert.
  const laengeOk = (x: string, y: string) => {
    const lx = fuerVergleich(x).trim().length;
    if (lx < 20) return true;
    const r = fuerVergleich(y).trim().length / lx;
    return r >= k.art.laenge_min && r <= Math.max(1, k.art.laenge_max);
  };
  return a.map((x, i) => {
    const y = b[i];
    const grund: AbsatzGrund | null =
      fuerVergleich(x).trim() === fuerVergleich(y).trim() ? 'gleich'
        : k.art.anrede !== 'beibehalten' ? 'anrede'
        : aehnlichkeit(x, y) < 0.3 ? 'zuordnung'
        : !gleicheZahlen(x, y, reihenfolge) ? 'zahlen'
        : JSON.stringify(markupFolgen(fuerVergleich(x))) !== JSON.stringify(markupFolgen(fuerVergleich(y))) ? 'markup'
        : hausZurueck(x, y, k.begriffe).zurueck.length > 0 ? 'hausschreibweise'
        : !werteGleich(x, y) ? 'werte'
        : !laengeOk(x, y) ? 'laenge'
        : null;
    return { alt: x, neu: y, waehlbar: grund === null, grund };
  });
}
