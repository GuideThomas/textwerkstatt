/**
 * Einheiten-Schutz: kompakte Wert+Einheit-Schreibweise erhalten (21.07.2026)
 *
 * Problem: Aus Platzgruenden werden technische Merkmale bewusst OHNE Leerzeichen
 * zwischen Wert und Einheit geschrieben (`12W`, `24V`, `3000K`, `CRI90`). DeepL
 * normalisiert das zielsprachen-typisch und macht daraus `12 W`, `24 V`, `CRI 90`
 * — im Franzoesischen zusaetzlich mit Tausender-Trennzeichen (`3 000 K`), im
 * Englischen sogar ausgeschrieben (`5m Kabel` -> `5-meter cable`). Der manuelle
 * Eingriff geht damit in jeder Uebersetzung verloren.
 *
 * Loesung: Nur die KOMPAKT geschriebenen Tokens werden vor DeepL durch einen
 * Sentinel ersetzt und danach 1:1 wiederhergestellt. Was im Quelltext ein
 * Leerzeichen hat (`12 W`), bleibt unangetastet und darf normal lokalisiert
 * werden — der Schutz greift also genau dort, wo die kompakte Form bewusst
 * gewaehlt wurde. Gleiches Sentinel-Muster wie `conductor-protection.ts`.
 *
 * Bewusst NICHT geschuetzt: CSS-Einheiten (px, rem, vw, vh, em, fr, deg). Die
 * stecken in Magento-HTML-Attributen, werden von DeepL ohnehin nicht angefasst
 * und wuerden die Trefferzahl unnoetig aufblaehen (Messung 21.07.: 4.443x `px`).
 */

const UNIT_SENTINEL_PREFIX = '__ISOLUNIT';

/**
 * Einheiten-Whitelist (Suffix-Form: Zahl + Einheit).
 * Reihenfolge = Alternierung in der Regex: laengere Kuerzel MUESSEN vor ihren
 * Praefixen stehen (`mm` vor `m`, `lm/W` vor `lm`), sonst greift die kuerzere
 * Alternative zuerst und laesst einen Buchstaben stehen.
 */
const UNIT_SUFFIXES = [
  // zusammengesetzt / mehrbuchstabig zuerst
  // (W/m + lm/m sind bei LED-Streifen der Normalfall: "14,4W/m", "1200lm/m")
  'lm/W', 'lm/w', 'W/m', 'w/m', 'lm/m', 'mm²', 'qmm', 'mm2',
  'kWh', 'kW', 'kV', 'kg', 'kHz', 'MHz',
  'mA', 'mV', 'mm', 'cm', 'nm', 'µm', 'Ah', 'VA', 'Hz',
  'V/DC', 'V/AC',
  'lm', 'cd', 'lx', 'dB',
  '°C', '°K', '°',
  // einbuchstabig zuletzt
  'W', 'V', 'A', 'K', 'm', 'g', 'h', 's', '%',
];

/**
 * Praefix-Form: Kennwert + Zahl (`CRI90`, `IP65`, `Ra80`, `IK08`).
 * Auch hier gilt: nur ohne Leerzeichen geschrieben wird geschuetzt.
 */
const VALUE_PREFIXES = ['CRI', 'Ra', 'IP', 'IK', 'SDCM', 'MacAdam', 'RAL'];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Suffix-Muster: Zahl (mit optionaler Dezimalstelle) DIREKT gefolgt von einer
 * Whitelist-Einheit — kein Leerzeichen dazwischen, sonst kein Treffer.
 * Vorne kein Buchstabe/Ziffer (kein Match mitten in Artikelcodes wie `LED1234W`),
 * hinten kein Buchstabe/Ziffer (kein Match in `12Wxyz`).
 */
function buildSuffixRegex(): RegExp {
  const units = UNIT_SUFFIXES.map(escapeRegex).join('|');
  return new RegExp(
    // Bereich als EIN Token (`1-10V`, `0-30W`, `0,75-2,5mm²`). Bis 04.11.2026 blieb der vordere
    // Teil frei: DeepL sah `1-__ISOLUNIT0__` und lieferte `1 10V` (FR, 7 Namen).
    // Der zweite Lookbehind verhindert den Treffer hinter einem Dezimalkomma, das zu einem
    // anderen Wort gehört (`F3G0,75mm²` wurde sonst `F3G0, 75mm²`).
    `(?<![A-Za-z0-9])(?<![0-9][.,])(\\d+(?:[.,]\\d+)?(?:[-–]\\d+(?:[.,]\\d+)?)?)(${units})(?![A-Za-z0-9À-ÿ])`,
    'g'
  );
}

/** Spannung mit Stromart als EIN Token: `24V DC`, `12-24V DC`. DeepL macht sonst `24V/DC` oder `24V CC`. */
function buildVoltageRegex(): RegExp {
  return /(?<![A-Za-z0-9])\d+(?:[.,]\d+)?(?:[-–]\d+(?:[.,]\d+)?)?V(?:\/| )(?:DC|AC)(?![A-Za-z0-9])/g;
}

/** Winkelbereich als EIN Token: `20°-55°`. */
function buildAngleRangeRegex(): RegExp {
  return /(?<![A-Za-z0-9])\d+(?:[.,]\d+)?°[-–]\d+(?:[.,]\d+)?°(?![A-Za-z0-9])/g;
}

/** Kennwert mit Vergleichszeichen: `UGR<19`. DeepL schreibt im Französischen sonst `UGR< 19` (99 Namen). */
function buildComparisonRegex(): RegExp {
  return /(?<![A-Za-z0-9])UGR\s?[<≤]\s?\d+(?:[.,]\d+)?(?![A-Za-z0-9])/g;
}

/** Kabeltyp mit Querschnitt als EIN Token: `H05VV-F3G0,75mm²`. */
function buildCableRegex(): RegExp {
  return /(?<![A-Za-z0-9-])[A-Z0-9]+(?:-[A-Z0-9]+)*G\d+(?:[.,]\d+)?(?:mm²|mm2|qmm)(?![A-Za-z0-9])/g;
}

/**
 * Masskette: `33x33`, `948x25x13,4mm`, `9x19°`, `2x0,33mm²` — Zahlen mit `x`
 * verbunden, ohne Leerzeichen, optional mit Einheit. Nur die kompakte Form;
 * `1100 x 500` mit Leerzeichen bleibt wie jede getrennte Schreibweise frei.
 *
 * Der Schutz hat hier einen zweiten, wichtigeren Effekt als die Schreibweise:
 * DeepL behandelt eine freistehende Massangabe als Attribut und stellt sie in
 * EN/HU voran (`LED Aufbauprofil 33x33` → `33x33 LED surface mounted profile`).
 * Als opakes Sentinel-Token passiert das nicht, die Wortstellung des deutschen
 * Artikelnamens bleibt erhalten (verifiziert 21.07.2026).
 */
function buildDimensionRegex(): RegExp {
  const units = UNIT_SUFFIXES.map(escapeRegex).join('|');
  return new RegExp(
    `(?<![A-Za-z0-9])(\\d+(?:[.,]\\d+)?(?:x\\d+(?:[.,]\\d+)?)+)(${units})?(?![A-Za-z0-9])`,
    'g'
  );
}

/** Praefix-Muster: Kennwert direkt gefolgt von einer Zahl (`CRI90`). */
function buildPrefixRegex(): RegExp {
  const prefixes = VALUE_PREFIXES.map(escapeRegex).join('|');
  return new RegExp(`(?<![A-Za-z0-9])(${prefixes})(\\d+(?:[.,]\\d+)?)(?![A-Za-z0-9])`, 'g');
}

/**
 * Zielsprachen mit Dezimal-PUNKT. Nur dort wird beim Restore aus `3,5W` ein
 * `3.5W` gemacht — im Englischen liest sich das Komma sonst als Tausender-
 * trenner (`1,47m` wirkt wie 147 m). Alle uebrigen Zielsprachen des Tools
 * (IT, FR, ES, PL, HU, CZ, SK) verwenden selbst das Komma → verbatim korrekt.
 *
 * Bewusst NICHT behandelt: ein Punkt im Quelltext (`1.200lm`) bleibt unveraendert,
 * weil dort nicht entscheidbar ist, ob deutscher Tausendertrenner oder Dezimalpunkt
 * gemeint ist. Solche Tokens gehoeren im Quelltext vereinheitlicht.
 */
const DECIMAL_POINT_LANGS = new Set(['EN', 'ZH', 'JA', 'KO']);

/** `3,5W` → `3.5W` fuer Zielsprachen mit Dezimalpunkt; sonst unveraendert. */
export function localizeDecimal(token: string, targetLang: string): string {
  const lang = (targetLang || '').slice(0, 2).toUpperCase();
  if (!DECIMAL_POINT_LANGS.has(lang)) return token;
  return token.replace(/(\d),(\d)/g, '$1.$2');
}

/**
 * Stueckzahlen (`4Stk`, `25Stk`) sind ein Sonderfall: kompakt wie die Einheiten,
 * aber `Stk` ist eine DEUTSCHE Abkuerzung und keine internationale Einheit —
 * verbatim wiederhergestellt stuende `4Stk` im italienischen Artikelnamen.
 * Der Token wird deshalb kompakt UND in der Zielsprache wiederhergestellt
 * (gleiches Prinzip wie `conductor-protection.ts`: `4-polig` → `4 poli`).
 *
 * Nur die kompakte Schreibweise wird erfasst — `4 Stk` mit Leerzeichen bleibt
 * unangetastet und wird von DeepL normal uebersetzt.
 */
const PIECE_TERM_BY_LANG: Record<string, string> = {
  DE: 'Stk',
  EN: 'pcs',
  IT: 'pz',
  FR: 'pcs',
  ES: 'uds',
  PL: 'szt',
  HU: 'db',
  CZ: 'ks',
  CS: 'ks',
  SK: 'ks',
};

/**
 * `<Zahl>Stk` ohne Leerzeichen; `Stück`/`Stueck`/`Stck`/`Stk`/`St` als Variante
 * (laengste zuerst). Ein folgender Abkuerzungspunkt wird bewusst NICHT
 * konsumiert — sonst ginge er am Satzende verloren; und `pcs.`/`pz.` schreibt
 * man in den Zielsprachen ohnehin oft mit Punkt.
 */
function buildPieceRegex(): RegExp {
  return new RegExp(
    '(?<![A-Za-z0-9])(\\d+)(?:St(?:ü|ue)ck|Stck|Stk|St)(?![A-Za-zÄÖÜäöüß])',
    'g'
  );
}

/** Zielsprachen-Form einer kompakten Stueckzahl, z.B. `4Stk` + IT → `4pz`. */
export function localizePieces(num: string, targetLang: string): string | null {
  const term = PIECE_TERM_BY_LANG[(targetLang || '').slice(0, 2).toUpperCase()];
  return term ? `${num}${term}` : null;
}

export interface UnitProtection {
  protectedText: string;
  /** Sentinel → wiederherzustellender Token (bereits zielsprachen-lokalisiert). */
  restoreMap: Map<string, string>;
  /** Audit-Trail: welche Tokens wurden geschuetzt? (Original-Schreibweise) */
  substitutions: string[];
}

/**
 * Schuetzt alle kompakt geschriebenen Wert+Einheit-Tokens vor DeepL.
 * Der Token wird nach der Uebersetzung wiederhergestellt — Einheit und
 * Schreibweise bleiben also exakt wie im Quelltext; einzige Anpassung ist das
 * Dezimaltrennzeichen fuer Zielsprachen mit Punkt (siehe `localizeDecimal`).
 */
export function protectUnits(text: string, targetLang: string = ''): UnitProtection {
  const restoreMap = new Map<string, string>();
  const substitutions: string[] = [];
  let counter = 0;

  const replace = (match: string): string => {
    const sentinel = `${UNIT_SENTINEL_PREFIX}${counter++}__`;
    restoreMap.set(sentinel, localizeDecimal(match, targetLang));
    substitutions.push(match);
    return sentinel;
  };

  // Stueckzahlen zuerst: der Token wird zielsprachen-lokalisiert restored,
  // nicht verbatim (siehe PIECE_TERM_BY_LANG).
  const protectedText = text
    .replace(buildPieceRegex(), (match, num: string) => {
      const sentinel = `${UNIT_SENTINEL_PREFIX}${counter++}__`;
      restoreMap.set(sentinel, localizePieces(num, targetLang) ?? match);
      substitutions.push(match);
      return sentinel;
    })
    // Zusammengesetzte Tokens VOR den Einzel-Einheiten: sonst greift das Suffix-Muster
    // nur an einem Teil (`24V` aus `24V DC`, `13,4mm` aus `948x25x13,4mm`).
    .replace(buildCableRegex(), (m) => replace(m))
    .replace(buildComparisonRegex(), (m) => replace(m))
    .replace(buildVoltageRegex(), (m) => replace(m))
    .replace(buildAngleRangeRegex(), (m) => replace(m))
    .replace(buildDimensionRegex(), (m) => replace(m))
    .replace(buildSuffixRegex(), (m) => replace(m))
    .replace(buildPrefixRegex(), (m) => replace(m));

  return { protectedText, restoreMap, substitutions };
}

export function restoreUnits(text: string, restoreMap: Map<string, string>): string {
  // Ein leicht veränderter Platzhalter (`_ISOLUNIT0_`, `__isolunit0__`) ist noch erkennbar.
  // Bliebe er stehen, stünde er im Artikelnamen und der Wert fehlte.
  let result = text.replace(/_{1,2}\s?ISOLUNIT(\d+)\s?_{1,2}/gi, `${UNIT_SENTINEL_PREFIX}$1__`);
  for (const [sentinel, original] of restoreMap.entries()) {
    result = result.split(sentinel).join(original);
  }
  return result;
}

/**
 * Kennwerte, deren Glossar-Fassung im Akronym-Pass der Artikeldaten greifen darf (`CRI90` → `IRC90`).
 *
 * 🚨 Bewusst eine Liste, nicht alle Glossar-Kürzel: Das Muster trifft jedes Kürzel mit Ziffer, und das
 * Glossar führt `COVER → OBÁLKA`, `HIDE → OCULTAR`, `SIDE → STRANA`, `ROUND → OKRÚHLY`. Offen gelassen
 * würde aus dem Seriennamen `COVER27` ein `OBÁLKA27` (gemessen am Glossar 04.11.2026).
 */
export const AKRONYM_KENNWERTE = ['CRI'];

/** Rest eines Platzhalters nach dem Wiederherstellen; dann ist etwas schiefgegangen. */
export const PLATZHALTER_REST = /ISOL(?:UNIT|POL|AC)\d+/i;

/**
 * Welche geschützten Werte fehlen nach dem Wiederherstellen?
 *
 * 🚨 Geht ein Platzhalter bei DeepL verloren, fehlt der Wert im Ergebnis, und `restoreUnits` merkt
 * es nicht: Aus `LED Trafo 24V DC, 30W` wurde im Versuch `LED Trafo 24V DC, ` (belegt 04.11.2026).
 */
export function fehlendeWerte(uebersetzung: string, restoreMap: Map<string, string>): string[] {
  const soll = new Map<string, number>();
  for (const wert of restoreMap.values()) soll.set(wert, (soll.get(wert) ?? 0) + 1);
  // Längere Werte zuerst und jeweils aus dem Rest entfernen: Sonst genügte `24V DC` für einen
  // fehlenden Wert `24V`. Die Ränder verhindern, dass `5m` in `15m` als Treffer zählt.
  let rest = uebersetzung;
  const fehlend: string[] = [];
  for (const [wert, anzahl] of [...soll].sort((a, b) => b[0].length - a[0].length)) {
    const muster = new RegExp(`(?<![0-9A-Za-zÀ-ÿ.,])${escapeRegex(wert)}(?![0-9A-Za-zÀ-ÿ])`, 'g');
    const gefunden = (rest.match(muster) ?? []).length;
    rest = rest.replace(muster, ' ');
    for (let i = gefunden; i < anzahl; i++) fehlend.push(wert);
  }
  return fehlend;
}

/** Fehlt eine Zahl des Quelltexts in der Übersetzung? Für den Versuch ohne Platzhalter. */
export function zahlenVollstaendig(quelle: string, uebersetzung: string): boolean {
  const zahlen = (t: string) => (t.match(/\d+(?:[.,]\d+)*/g) ?? []).map((z) => z.replace(/[.,\s]/g, ''));
  const ziel = zahlen(uebersetzung.replace(/(?<=\d)[\s\u00a0\u202f](?=\d{3}(?!\d))/g, ''));
  return zahlen(quelle).every((z) => {
    const i = ziel.indexOf(z);
    if (i < 0) return false;
    ziel.splice(i, 1);
    return true;
  });
}

/** True, wenn der Text mindestens einen kompakten Wert+Einheit-Token enthaelt. */
export function hasUnitPattern(text: string): boolean {
  return (
    buildCableRegex().test(text) ||
    buildComparisonRegex().test(text) ||
    buildVoltageRegex().test(text) ||
    buildAngleRangeRegex().test(text) ||
    buildSuffixRegex().test(text) ||
    buildPrefixRegex().test(text) ||
    buildPieceRegex().test(text) ||
    buildDimensionRegex().test(text)
  );
}
