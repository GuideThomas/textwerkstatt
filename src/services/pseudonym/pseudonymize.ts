/**
 * Pseudonymisierung vor dem Cloud-Modell (Textwerkstatt Phase 3, Plan `PLAN-textwerkstatt.md` §4 Phase 3, Cockpit #1839).
 * Ersetzt Namen, Anschriften, Nummern, Preise durch Platzhalter wie [PERSON_1] und setzt die Antwort wieder zurück. Die
 * Zuordnung lebt nur im Speicher des Servers, sie wird nie gespeichert und nie gesendet. Rechtlich bleiben es
 * personenbezogene Daten, „anonym“ wäre falsch.
 *
 * HERKUNFT. Kopie aus dem Repo mail-agent, Datei `packages/llm/src/pseudonymize.ts`, Stand-Commit `5777c8d` vom
 * 10.11.2026 (produktiv seit 04.11.2026). Beide Repos sollen öffentlich werden; ein gemeinsames Paket ist eine spätere
 * Frage (Plan §7). Vergleich mit dem Stand:
 *   git -C <mail-agent> show 5777c8d:packages/llm/src/pseudonymize.ts | diff - src/services/pseudonym/pseudonymize.ts
 * Die Tests kamen mit, als Prüfskript `src/scripts/check-pseudonym.ts` (Abschnitt „aus dem Mail-Agent“).
 *
 * ABWEICHUNGEN gegenüber 5777c8d, alle aus den Befunden in `MESSUNG-textwerkstatt-phase0.md` §2:
 *  - Neue Arten PREIS, ARTIKELNR, PROJEKT, BIC, BANK; BELEGNR statt NUMMER; FIRMA auch ohne Rechtsform (Branchenwort + Name).
 *  - Klassen lassen sich abschalten, die Pflichtklassen BANK, MAIL, TELEFON nicht (der Konstruktor wirft).
 *  - Aufdecken: Ein Wert, den der Nutzer in der Vorschau aufgedeckt hat, bleibt stehen, außer in einer Pflichtklasse.
 *  - Schutzliste mit Art je Begriff (PERSON, FIRMA, PROJEKT, BEGRIFF), läuft vor den Regeln und in einem Durchgang.
 *  - IBAN nur mit gültiger Prüfsumme (mod 97): `LS24 5050 RGBW` ist keine. Es zählt die längste gültige Gruppenfolge,
 *    damit ein angehängtes Wort („… 3201 RGBW“) die IBAN nicht unkenntlich macht.
 *  - PLZ mit Ort nie vor einer Einheit oder einem Mengenwort: `1200 Lumen`, `3000 Kelvin`, `50000 Stunden` bleiben.
 *  - Namen mit `\p{L}` (Kovács), ein Name endet an der Zeile, Titel nach der Grußformel („Ing. Florian Moser“),
 *    „Danke, Martin“, Abteilungen nach der Grußformel sind keine Namen.
 *  - Mehr Rechtsformen (s.r.o., Kft. …), `&` im Firmennamen, „& Partner“.
 *  - Belegnummern mit mehr Kennwörtern, Komposita und Füllwörtern („Kundennummer bei Ihnen ist 20417“), alle EU-UID-Formate.
 *  - Straßen auf -park, -markt, -kai …, mit einem Wort vor der Nummer („Gewerbepark Süd 7“); -straße/-gasse auch ohne Nummer.
 *  - Telefon mit kurzer Durchwahl (`05223 58410`), Mailadresse auch als `name(at)firma.at`.
 *  - Entfernt, weil hier ohne Aufrufer: JSON aus Werkzeugen (`content`, `restoreArguments`), `personNameFrom`,
 *    `pseudonymizeForEmbedding`.
 *  - Nach dem Code-Review vom 10.11.2026 (3 hoch, 7 mittel, 5 niedrig, alle behoben, je ein Test in `check-pseudonym.ts`
 *    Abschnitt R): erst ALLE Pflichtregeln, dann der Rest; IBAN und Karte ab jedem Anfang bzw. in jedem Fenster geprüft;
 *    Formatzeichen, Vollbreite und `%40`/`%2B` vereinheitlicht; Platzhalter im Eingabetext abgelehnt; die Rücksetzung
 *    nimmt nur gesendete Platzhalter an; Schutzliste in jeder Schreibung, spät nummeriert, nie aufdeckbar; Kontonummer und
 *    BLZ als BANK; das Muster der Artikelnummer nur in einer engen Grammatik.
 *
 * Die Erkennung arbeitet mit Regeln und Wörterbuch, ohne Modell. Sie bleibt lückenhaft (Quote je Klasse im Plan, §4
 * Phase 3). Deshalb sieht der Nutzer vor dem Senden genau den Text, der hinausgeht, und kann weitere Wörter verdecken.
 * Hier steht nichts, was einer Installation gehört (Plan G5): Die Schutzliste und das Muster der Artikelnummer kommen aus
 * den Einstellungen.
 */

import { FIRST_NAMES } from './first-names';

export type PseudonymKind =
  | 'PERSON' | 'EMAIL' | 'TELEFON' | 'IBAN' | 'KARTE' | 'BIC' | 'BANK' | 'URL' | 'ADRESSE' | 'FIRMA' | 'PROJEKT'
  | 'PREIS' | 'ARTIKELNR' | 'BELEGNR' | 'BEGRIFF';

export const ARTEN: readonly PseudonymKind[] = [
  'PERSON', 'EMAIL', 'TELEFON', 'IBAN', 'KARTE', 'BIC', 'BANK', 'URL', 'ADRESSE', 'FIRMA', 'PROJEKT', 'PREIS', 'ARTIKELNR',
  'BELEGNR', 'BEGRIFF',
];

/** Was der Nutzer an- und abschaltet. EIGEN sind Schutzliste und selbst verdeckte Wörter: immer an. */
export type Schutzklasse =
  | 'BANK' | 'MAIL' | 'TELEFON' | 'PERSON' | 'ANSCHRIFT' | 'URL' | 'FIRMA' | 'PROJEKT' | 'PREIS' | 'ARTIKELNR' | 'BELEGNR'
  | 'EIGEN';

export const SCHUTZKLASSEN: readonly Exclude<Schutzklasse, 'EIGEN'>[] = [
  'BANK', 'MAIL', 'TELEFON', 'PERSON', 'ANSCHRIFT', 'URL', 'FIRMA', 'PROJEKT', 'PREIS', 'ARTIKELNR', 'BELEGNR',
];

/** Nie abschaltbar, nie aufdeckbar (Entscheid Thomas 10.11.2026, Plan §4 Phase 3). Bleibt davon etwas stehen, geht nichts hinaus. */
export const PFLICHTKLASSEN: ReadonlySet<Schutzklasse> = new Set(['BANK', 'MAIL', 'TELEFON']);

export const KLASSE_JE_ART: Readonly<Record<PseudonymKind, Schutzklasse>> = {
  PERSON: 'PERSON',
  EMAIL: 'MAIL',
  TELEFON: 'TELEFON',
  IBAN: 'BANK',
  KARTE: 'BANK',
  BIC: 'BANK',
  BANK: 'BANK',
  URL: 'URL',
  ADRESSE: 'ANSCHRIFT',
  FIRMA: 'FIRMA',
  PROJEKT: 'PROJEKT',
  PREIS: 'PREIS',
  ARTIKELNR: 'ARTIKELNR',
  BELEGNR: 'BELEGNR',
  BEGRIFF: 'EIGEN',
};

export type SchutzBegriffArt = 'PERSON' | 'FIRMA' | 'PROJEKT' | 'BEGRIFF';
export interface SchutzBegriff {
  begriff: string;
  art: SchutzBegriffArt;
}

export interface PseudonymSeed {
  /** Bekannte Personen. Ganzer Name und seine Teile fallen, auch wenn die Klasse PERSON aus ist. */
  persons?: readonly string[];
  /** Immer ersetzen (selbst verdeckte Wörter); ohne Art als BEGRIFF. Aufdeckbar. */
  terms?: readonly (string | SchutzBegriff)[];
  /**
   * Die Schutzliste der Installation: in jeder Schreibung (groß, klein, Zeilenumbruch), nie aufdeckbar, auch nicht bei
   * abgeschalteter Klasse. Eine Person bekommt erst einen Platzhalter, wenn sie im Text steht: Sonst verriete die Nummer
   * die Größe der Liste, und das Modell könnte einen nie gesendeten Platzhalter nennen (Review 10.11.2026, H1).
   */
  schutzliste?: readonly SchutzBegriff[];
  /** Ganze Namen aus einem Adressbuch, klein geschrieben. Zählen erst, wenn einer im Text steht. */
  knownNames?: ReadonlySet<string>;
  /** Abgeschaltete Klassen. Eine Pflichtklasse hier wirft. */
  aus?: Iterable<Schutzklasse>;
  /** Vom Nutzer aufgedeckte Werte: bleiben im Klartext, außer in einer Pflichtklasse. */
  aufdecken?: Iterable<string>;
  /**
   * Muster einer Artikelnummer ohne Kennwort davor, aus den Einstellungen der Installation (z. B. `[1-9][0-9]{4,6}`).
   * Ohne Muster fallen Artikelnummern nur hinter einem Kennwort (Art.-Nr., Artikel, EAN). Ein reines Ziffernmuster trifft
   * auch Messwerte; deshalb bleibt eine Zahl vor einer Einheit oder einem Hauptwort stehen (`50000 Stunden`).
   */
  artikelnummer?: string | null;
}

export const FIRST_NAME_COUNT = FIRST_NAMES.size;

export interface PseudonymReplacement {
  placeholder: string;
  kind: PseudonymKind;
  value: string;
}

/** Danach wird nichts gesendet. */
export class PseudonymizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PseudonymizationError';
  }
}

export const PSEUDONYM_HINT =
  'Hinweis: Platzhalter in eckigen Klammern wie [PERSON_1], [FIRMA_2] oder [PREIS_3] stehen für echte Angaben. Übernimm jeden unverändert in deine Antwort, erfinde keine neuen und rate nicht, wofür sie stehen.';

const WORD = "\\p{Lu}[\\p{Ll}'’]+(?:-\\p{Lu}[\\p{Ll}'’]+)?";
/** Ein Name endet an der Zeile: Unter einer Grußformel steht darunter oft die Abteilung („Innendienst“). */
const FULL_NAME = `${WORD}(?:[ \\t]+${WORD}){0,2}`;
const TITLE = '(?:Herrn?|Frau|Hr\\.|Fr\\.|Dr\\.|Mag\\.a|Mag\\.|DI|Dipl\\.-Ing\\.|Ing\\.|Prof\\.|Mr\\.?|Mrs\\.?|Ms\\.?)';

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** `m.mayr(at)kunde.at`: dieselbe Adresse, nur verkleidet. */
const EMAIL_OBF_RE = /[\p{L}\p{N}._%+-]+[ \t]?(?:\(at\)|\[at\]|\{at\}|\(ät\))[ \t]?[\p{L}\p{N}-]+(?:[ \t]?(?:\.|\(dot\)|\[dot\])[ \t]?[\p{L}\p{N}-]+)+/giu;
/** Ohne `[`: Sonst schlösse die URL einen Platzhalter ein, der schon darin steht (`[URL_1]]`, Review N3). */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'\])[]+/gi;
const FILE_ENDINGS =
  'pdf|docx?|xlsx?|pptx?|csv|txt|rtf|zip|rar|png|jpe?g|gif|webp|svg|heic|mp3|mp4|mov|wav|eml|msg|ics|vcf|xml|json|html?|css|js|ts|md|log|ini|cfg|ya?ml|sql|exe|msi|dll|sh|py|bak|tmp|dwg|dxf|step|stp|ies|ldt';
/**
 * Jede kleingeschriebene Domain samt Unterdomäne: Eine Liste von Endungen ließ `.art` und `.academy` durch (11 von 30 Aufrufen,
 * gemessen 04.11.2026), und `firma.sharepoint.com` verrät den Namen vorne. Dateinamen bleiben lesbar. Ein Bindestrich danach
 * beendet die Domain (`host.art-Server`), außer es folgt ein weiterer Punkt: Dann ist es noch dieselbe (`a.b-c.pdf`).
 */
const DOMAIN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}@._-])(?:[a-z0-9][a-z0-9-]*\\.)+(?!(?:${FILE_ENDINGS})(?![a-z0-9]))[a-z]{2,24}(?![\\p{L}\\p{N}@]|\\.[a-z0-9]|-[\\p{L}\\p{N}-]*\\.[a-z0-9])`,
  'gu',
);
/** Großgeschrieben nur mit bekannter Endung: `MUSTER.AT` ist eine Domain, `Mio.Euro` nicht. */
const KNOWN_DOMAIN_RE = /(?<![\p{L}\p{N}@._-])(?:[a-z0-9][a-z0-9-]*\.)+(?:at|de|ch|com|org|net|eu|io|info|biz|shop)(?![\p{L}\p{N}@]|-[\p{L}\p{N}-]*\.[a-z0-9])/giu;
/**
 * Jeder mögliche Anfang einer IBAN, auch klein geschrieben, mit Punkt, Bindestrich oder Zeilenumbruch: Die Prüfsumme
 * entscheidet. Geprüft wird ab JEDEM Anfang, nicht nur ab dem ersten Treffer, sonst verdeckt ein Kürzel davor die echte
 * IBAN (`Ref RE26 DE89 3704 …`, Review H2).
 */
const IBAN_ANFANG_RE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}/g;
const IBAN_KANDIDAT_RE = /^[A-Za-z]{2}\d{2}(?:[ .\t\n-]?[A-Za-z0-9]{1,4}){2,8}/;
/** Ziffernläufe mit einzelnen Trennern. Darin wird jedes Fenster aus 13–19 Ziffern an Gruppengrenzen geprüft. */
const ZIFFERNLAUF_RE = /(?<![\p{N}])\d(?:[ \t-]?\d){12,40}(?![\p{N}])/gu;
const BIC_RE = /\b((?:BIC|SWIFT|BIC\/SWIFT|SWIFT-Code|BIC-Code)[ \t]*[:=]?[ \t]*)([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/g;
const ABLAUF_RE = /((?:gültig[ \t]+bis|Ablauf(?:datum)?|läuft[ \t]+ab|valid[ \t]+(?:thru|until)|exp\.?)[ \t]*:?[ \t]*)(\d{1,2}[ \t]?\/[ \t]?\d{2,4})(?![\p{N}])/giu;
const KARTEN_KONTEXT_RE = /karte|\[KARTE_|kreditkarte|card|visa|mastercard/i;
/** Kontonummer und Bankleitzahl gehören zur Bankverbindung (Pflicht), nicht zu den Belegnummern (Review M3). */
const KONTO_RE =
  /((?:Kontonummer|Kontonr\.?|Konto-Nr\.?|Konto|Kto\.?(?:-?Nr\.?)?|Bankleitzahl|BLZ)[ \t]*[:.]?[ \t]*)(\d(?:[ \t]?\d){3,})(?![\p{N}])/gu;
/** Ein Monat/Jahr neben einer Karte ist ihr Ablauf, auch ohne Kennwort: „lautet auf 5555 …, läuft 11/27 ab“ (Fremdkorpus 2). */
const KARTEN_DATUM_RE = /(?<![\p{N}/.])(?:0?[1-9]|1[0-2])[ \t]?\/[ \t]?(?:\d{2}|20\d{2})(?![\p{N}/])/gu;
/** Alle Formate der EU (dazu CH, GB, NO), weil auch Kunden im Ausland ihre UID schreiben: `HU23456789` (Messung §2). */
const VAT_RE =
  /\b(?:ATU\d{8}|DE\d{9}|CHE[-. ]?\d{3}[. ]?\d{3}[. ]?\d{3}(?:[ ]?(?:MWST|TVA|IVA))?|HU\d{8}|CZ\d{8,10}|SK\d{10}|SI\d{8}|IT\d{11}|PL\d{10}|HR\d{11}|FR[A-HJ-NP-Z0-9]{2}\d{9}|NL\d{9}B\d{2}|BE[01]\d{9}|LU\d{8}|ES[A-Z0-9]\d{7}[A-Z0-9]|DK\d{8}|SE\d{12}|FI\d{8}|RO\d{2,10}|BG\d{9,10}|EL\d{9}|IE\d{7}[A-Z]{1,2}|PT\d{9}|LT\d{9,12}|LV\d{11}|EE\d{9}|MT\d{8}|CY\d{8}[A-Z]|GB\d{9}(?:\d{3})?|NO\d{9}MVA)\b/g;
/** Mit kurzer Rufnummer: `05223 58410` und `07242 6677` haben nach der Vorwahl nur vier oder fünf Ziffern. */
const PHONE_RE = /(?:\+|\b00)\d[\d\s/().-]{6,}\d\b|\b0\d{1,4}[\s/()-]{1,2}\d[\d\s/()-]{2,}\d\b/g;
/**
 * Hinter einem Kennwort auch ohne Vorwahl und ohne führende Null: `Handy 349 556 7788`, `Durchwahl -214`. Beides kam im
 * Erstlauf am fremden Korpus durch (Plan §4 Phase 3, gemessen 10.11.2026).
 */
const TELEFON_KENNWORT = '(?:Tel(?:efon)?\\.?|Telefonnummer|Handy(?:nummer)?|Mobil(?:nummer|telefon)?|Mobile|Fax|Zentrale|Hotline|Rufnummer|Festnetz)';
const PHONE_KENNWORT_RE = new RegExp(`(${TELEFON_KENNWORT}[ \\t]*[:.]?[ \\t]*(?:unter[ \\t]+)?)((?:\\+|00)?\\d[\\d \\t/().-]{4,}\\d)(?![\\p{N}])`, 'gu');
const DURCHWAHL_RE = /((?:Durchwahl|DW|Klappe|Nebenstelle|Nst\.)[ \t]*[:.]?[ \t]*)(-?\d{2,6})(?![\p{N}])/gu;
/**
 * Ziffern in Gruppen, mindestens neun, in einem Satz über Erreichbarkeit: `erreichbar über … und 335 123 4567`
 * (Fremdkorpus 2, italienische Handynummer ohne Vorwahl und ohne Kennwort davor).
 */
const ZIFFERNGRUPPEN_RE = /(?<![\p{N}.,:/-])\d{2,4}(?:[ \t/.-]\d{2,4}){2,4}(?![\p{N}]|[.,]\d)/gu;
const KONTAKT_KONTEXT_RE = /erreichbar|anrufen|\bruf\b|Rückruf|zurückrufen|Kontakt|\bTel\b|Telefon|Handy|Mobil|WhatsApp|SMS|Natel|Nummer/i;
const DATE_LIKE = /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/;

/**
 * Kennwort, dann die Nummer, auch mit Füllwort dazwischen („Kundennummer bei Ihnen ist 20417“) und als Kompositum
 * („Auftragsbestätigung AB-26-0451“, „Reklamationsbericht 2026-R-117“). Nicht dabei sind Kennwörter, die klein
 * geschrieben etwas anderes sind („ab 120 m“), weil die Regel ohne Rücksicht auf die Schreibung läuft.
 */
const BELEG_STAMM =
  '(?:Rechnungs?|Kunden|Vertrags?|Auftrags?|Bestell(?:ung)?|Beleg|Angebots?|Referenz|Akten|Versicherungs|Mitglieds|Lieferschein|Reklamations?|Gutschrift|Proforma-?Rechnung|Ticket|Vorgangs?|Kommissions?|Mahnung|Storno|Offerte|Kalkulation|Lieferanten|Prüf|Servicebericht|Serviceauftrag|Serviceticket|Servicefall|Wartungs|Messbericht|Messprotokoll|Invoice|Order|Customer)';
const BELEG_FUELLWORT = '(?:bei[ \\t]+(?:Ihnen|uns|euch|dir)|lautet|lauten|ist|sind|unter|mit[ \\t]+der[ \\t]+Nummer|Nr\\.?|Nummer)';
const REFERENCE_RE = new RegExp(
  `\\b(${BELEG_STAMM}[\\p{L}-]{0,20}?(?:-?(?:nummer|nr\\.?|no\\.?))?(?:\\s*[:#]\\s*|\\s+|-)(?:${BELEG_FUELLWORT}\\s+){0,3})([A-Z]{0,4}[-/]?\\d[A-Z0-9/-]{2,})`,
  'giu',
);

const STRASSE_ENDE =
  '(?:straße|strasse|Straße|Strasse|str\\.|gasse|Gasse|weg|Weg|platz|Platz|allee|Allee|ring|Ring|zeile|Zeile|gürtel|Gürtel|park|Park|markt|Markt|kai|Kai|lände|Lände|damm|Damm|ufer|Ufer|steig|Steig|promenade|Promenade)';
/** Ein Wort darf vor der Nummer stehen: `Gewerbepark Süd 7` (Messung §2). */
const STREET_RE = new RegExp(`(?<![\\p{L}])\\p{Lu}[\\p{L}-]*?${STRASSE_ENDE}(?:[ \\t]+\\p{Lu}[\\p{L}-]*)?\\s+\\d+[a-z]?(?:\\/\\d+)*\\b`, 'gu');
/** Zwei Wörter: `Kieler Straße 88`, `Wiener Platz 3`; und vorangestellt wie in Italien und Frankreich: `Via Lugano 15`. */
const STREET_ZWEI_RE =
  /(?<![\p{L}])\p{Lu}[\p{L}-]*er[ \t]+(?:Straße|Strasse|Gasse|Weg|Platz|Allee|Ring|Zeile|Gürtel)[ \t]+\d+[a-z]?(?:\/\d+)*\b/gu;
const STREET_VORN_RE =
  /(?<![\p{L}])(?:Via|Viale|Piazza|Piazzale|Corso|Vicolo|Rue|Avenue|Chemin|Route|Place|Ulica|Calle)[ \t]+\p{Lu}[\p{L}'’-]*(?:[ \t]+\p{Lu}[\p{L}'’-]*){0,2}[ \t]+\d+[a-z]?\b/gu;
/** Ohne Nummer nur mit einer Endung, die kein anderes Hauptwort hat: `in der Maria-Theresien-Straße`, nicht `Rückweg`. */
const STREET_ONLY_RE = /(?<![\p{L}])\p{Lu}[\p{L}-]*?(?:straße|strasse|Straße|Strasse|gasse|Gasse|allee|Allee)(?![\p{L}])/gu;
/** Nicht hinter einem Bindestrich: `LL-1500 Slim` ist eine Typenbezeichnung (Fremdkorpus 2). */
const POSTCODE_RE =
  /(?:\b(?:A|D|AT|DE|CH)-|(?<![\p{L}\p{N}-]))\d{4,5}[ \t]+(\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?(?:[ \t]+(?:am|an der|im|in|bei|ob der)[ \t]+\p{Lu}\p{Ll}+)?)/gu;
/**
 * Hinter einer Zahl ist ein solches Wort eine Menge, kein Ort: `1200 Lumen`, `3000 Kelvin`, `50000 Stunden` galten im
 * Mail-Agent als PLZ mit Ort (Messung §2). Auch eine Artikelnummer steht nie davor.
 */
const MENGENWORT = new Set(
  [
    'kelvin lumen lux watt volt ampere hertz candela stunden stunde minuten sekunden tage tagen wochen monate monaten jahre',
    'jahren mal stück stk euro franken dollar forint kronen meter metern millimeter zentimeter kilometer kilogramm gramm tonnen',
    'liter grad prozent einheiten teile stücke rollen packungen kartons paletten leuchten spots lampen module mitarbeiter',
    'mitarbeiterinnen mitarbeitende kunden kundinnen besucher gäste zimmer betten plätze sitzplätze wohnungen quadratmeter',
    'kubikmeter zyklen schaltzyklen betriebsstunden lichtpunkte punkte exemplare artikel bestellungen aufträge projekte',
    'filialen standorte nutzer seiten zeilen zeichen mails',
  ]
    .join(' ')
    .split(' '),
);
/** Auch im Dativ: „15000 Mitarbeitern“, „30 Kunden“. */
const istMengenwort = (wort: string): boolean => {
  const w = wort.toLowerCase();
  return MENGENWORT.has(w) || MENGENWORT.has(w.replace(/n$/, '')) || MENGENWORT.has(w.replace(/en$/, ''));
};
const EINHEIT =
  "(?:K|V|W|A|mA|Hz|kHz|lm|lx|cd|h|min|s|ms|mm|cm|dm|m|km|m²|m2|qm|m³|kg|g|t|°C|°|%|‰|€|EUR|CHF|USD|Stk\\.?|x|×|VA|kW|kWh|Wh|Ah|mAh|bar|Pa|dB|Bit|GB|MB|Mbit|lm/W|W/m|lm/m|LED|LEDs|V\\s?DC|V\\s?AC)";
const EINHEIT_DANACH_RE = new RegExp(`^[ \\t]?${EINHEIT}(?![\\p{L}\\p{N}])`, 'u');

/** Rechtsformen aus dem deutschen Sprachraum und den Nachbarländern; „& Partner“ wirkt wie eine. */
const RECHTSFORM =
  '(?:GmbH(?:\\s*&\\s*Co\\.?\\s*KG)?|GesmbH|Ges\\.m\\.b\\.H\\.|AG|KG|OG|OHG|GesbR|e\\.U\\.|e\\.K\\.|e\\.V\\.|mbH|SE|Ltd\\.?|LLC|Inc\\.?|UG|PLC|s\\.r\\.o\\.|spol\\. s r\\.o\\.|a\\.s\\.|Kft\\.?|Zrt\\.?|Nyrt\\.?|Bt\\.|Sp\\. z o\\.o\\.|S\\.p\\.A\\.|S\\.r\\.l\\.|SRL|d\\.o\\.o\\.|S\\.A\\.|SARL|B\\.V\\.|BV|N\\.V\\.|ApS|Oy|Sagl|Sàrl|SA|eG|GbR|KlG|&\\s+(?:Partner|Söhne|Sohn|Co\\.?)(?:\\s+(?:GmbH|KG|OG|mbB))?)';
const COMPANY_RE = new RegExp(`(?:(?:\\p{Lu}[\\p{L}&.-]*|&)[ \\t]+){1,4}${RECHTSFORM}(?![\\p{L}])`, 'gu');

/** Ein Name eines Objekts, Betriebs oder Projekts: groß geschriebene Wörter, auch mit „St.“, „Am“, „Zum“ davor. */
const EIGENNAME =
  "(?:(?:St\\.|Sankt|Am|Im|An der|Zum|Zur|Zu den|Bei der|Auf der)[ \\t]+)?\\p{Lu}[\\p{L}'’-]*(?:[ \\t]+(?:St\\.[ \\t]+)?(?:&[ \\t]+)?\\p{Lu}[\\p{L}'’-]*){0,2}";
const BRANCHE =
  '(?:Firma|Fa\\.|Elektro|Elektrotechnik|Elektroinstallationen|Stadtwerke|Stadt|Büro|Lichtkonzept|Planungsgruppe|Hotel|Hotelgruppe|Gasthof|Gasthaus|Wirtshaus|Restaurant|Café|Cafe|Bäckerei|Konditorei|Metzgerei|Fleischerei|Weingut|Brauerei|Spedition|Planungsbüro|Architekturbüro|Ingenieurbüro|Steuerberatung|Kanzlei|Modehaus|Autohaus|Möbelhaus|Einrichtungshaus|Tischlerei|Schreinerei|Schlosserei|Malerei|Baufirma|Bauunternehmen|Baumeister|Lichttechnik|Lichtplanung|Lichtdesign|Installateur|Haustechnik|Gebäudetechnik|Gemeinde|Stadtgemeinde|Marktgemeinde|Magistrat|Pension|Apotheke|Juwelier|Galerie|Reisebüro|Fahrschule|Druckerei|Gärtnerei|Sägewerk|Holzbau|Hausverwaltung|Landratsamt|Bezirkshauptmannschaft|Bezirksamt|Gemeindeamt|Hochschule|Fachhochschule|Universität|Tennisclub|Sportverein|Verein)';
/**
 * „Firma“ und „Fa.“ bleiben stehen, bei allen anderen gehört das Branchenwort zum Namen („Hotel Seeblick“). Ein „für“
 * oder „der“ darf dazwischen stehen: „Hochschule für Gestaltung Luzern“ (Fremdkorpus 2).
 */
const FIRMA_BRANCHE_RE = new RegExp(`(?<![\\p{L}])(${BRANCHE})[ \\t]+((?:(?:für|der|des)[ \\t]+)?${EIGENNAME})`, 'gu');
const PROJEKT_KENNWORT =
  '(?:Projekt(?:bericht|name)?|Bauvorhaben|BV|Objekt(?:bericht)?|Baustelle(?:nbericht)?|Abschlussbericht|Zwischenbericht|Abnahmebericht|Abnahmeprotokoll|Ausschreibung|Bautagebuch)';
const OBJEKT_WORT =
  '(?:Schulzentrum|Flughafen|Tennishalle|Kreisklinik|Klinik|Hallenbad|Schwimmbad|Bibliothek|Theater|Wohnanlage|Wohnpark|Wohnhausanlage|Wohnbau|Bürohaus|Bürogebäude|Büropark|Geschäftshaus|Logistikzentrum|Einkaufszentrum|Fachmarktzentrum|Seniorenheim|Pflegeheim|Altersheim|Volksschule|Mittelschule|Hauptschule|Gymnasium|Kindergarten|Krankenhaus|Klinikum|Sporthalle|Turnhalle|Stadion|Residenz|Campus|Quartier|Areal|Tower|Hotelanlage|Lagerhalle|Produktionshalle|Werkshalle|Parkhaus|Tiefgarage|Rathaus|Pfarrkirche)';
const PROJEKT_RE = new RegExp(
  `(?<![\\p{L}])(${PROJEKT_KENNWORT}[ \\t]*[:–-]?[ \\t]+(?:Sanierung[ \\t]+|Neubau[ \\t]+|Umbau[ \\t]+)?[„"»]?)((?:${OBJEKT_WORT}[ \\t]+)?${EIGENNAME})`,
  'gu',
);
const OBJEKT_RE = new RegExp(`(?<![\\p{L}])${OBJEKT_WORT}[ \\t]+${EIGENNAME}`, 'gu');
const EIGENNAME_VORWORT_RE = /^(?:(?:für|der|des)[ \t]+)?(?:St\.|Sankt|Am|Im|An der|Zum|Zur|Zu den|Bei der|Auf der)?[ \t]*/u;
/** Das erste Wort eines Eigennamens nach „Am“, „Zum“ …, klein geschrieben. */
const erstesWort = (name: string): string => name.replace(EIGENNAME_VORWORT_RE, '').split(/[ \t]+/)[0]!.toLowerCase();
/** Kein Eigenname, auch wenn es hinter „Projekt“ groß steht. */
const KEIN_EIGENNAME = new Set(
  [
    'status team leitung abschluss start plan planung übersicht liste nummer phase ende beginn budget kosten termin termine',
    'bericht management leiter leiterin dokumentation stand ziel ziele name ablauf zeitplan aus und oder der die das ein eine',
    'für mit von bei nach vor seit kw q1 q2 q3 q4 woche monat quartal jahr',
  ]
    .join(' ')
    .split(' '),
);

/** Bankname nur in einem Satz über eine Bankverbindung: Sonst wäre jede „Datenbank“ verdächtig. */
/** Auch „Bank Südtirol Mitte“: Das Wort Bank vorn, der Name dahinter (Fremdkorpus 2). */
const BANKNAME_RE =
  /(?<![\p{L}])(?:(?:\p{Lu}[\p{L}-]*[ \t]+)?\p{Lu}[\p{L}-]*(?:bank|kasse)|(?:\p{Lu}[\p{L}-]*[ \t]+)?(?:Bank|Sparkasse|Kasse))(?:[ \t]+\p{Lu}[\p{L}-]*){0,2}(?![\p{L}])/gu;
const BANK_KONTEXT_RE = /IBAN|\[IBAN_|BIC|\[BIC_|Konto|Bankverbindung|überweis/i;

// ── Preise und Konditionen (neu, Messung §2: 0 von 31 erkannt) ────────────────────────────────────────────────────
/** Auch die Schweizer Schreibung mit Apostroph und Punkt: `CHF 8'940.50`, `CHF 1'250.–` (Fremdkorpus 2: Ziffern blieben stehen). */
const BETRAG =
  "\\d{1,3}(?:['’]\\d{3})+(?:\\.\\d{1,2}|\\.[-–]{1,2})?|\\d{1,3}(?:[. \\u2009]\\d{3})+(?:,\\d{1,2}|,[-–]{1,2})?|\\d+(?:,\\d{1,2}|,[-–]{1,2}|\\.\\d{2}(?!\\d)|\\.[-–]{1,2})?";
const WAEHRUNG = '€|EUR|Euro|CHF|Franken|USD|US-Dollar|Dollar|£|GBP|HUF|Forint|CZK|PLN|TEUR|T€|k€';
const GROESSE = '(?:[ \\t]?(?:Mio\\.?|Millionen|Mrd\\.?|Milliarden|Tsd\\.?|Tausend))?';
const PREIS_NACH_RE = new RegExp(`(?<![\\p{L}\\p{N}.,])(?:${BETRAG})${GROESSE}[ \\t]?(?:${WAEHRUNG})(?![\\p{L}-])`, 'gu');
const PREIS_VOR_RE = new RegExp(`(?:€|EUR|CHF|USD|\\$|£)[ \\t]?(?:${BETRAG})${GROESSE}(?![\\p{N}])`, 'gu');
/** Die Währung gilt für beide Beträge: „von 25.000 auf 40.000 Euro“. */
const PREIS_SPANNE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.,])(?:${BETRAG})${GROESSE}[ \\t]*(?:bis|auf|und|–|-)[ \\t]*(?:${BETRAG})${GROESSE}[ \\t]?(?:${WAEHRUNG})(?![\\p{L}-])`,
  'gu',
);
/** „ca. 25k“ nur hinter einem Wort für Geld; sonst wäre „4k“ auch eine Bildschirmauflösung. */
const PREIS_K_RE = /(?<![\p{L}\p{N}.,])\d{1,4}(?:,\d{1,2})?[ \t]?(?:[kK](?:€|EUR)?|Tsd\.|Tausend|Mio\.)(?![\p{L}\p{N}])/gu;
/** Bis zu 24 Zeichen dazwischen, auch „ca.“: „Budget laut ihr ca. 25k“. */
const GELDWORT_DAVOR_RE = /(?:Budget|Kosten|Preis|Volumen|Umsatz|Limit|Auftragswert|Investition|Summe|Betrag)\p{L}*[^\n\d!?]{0,24}$/u;
const ZAHLUNGSZIEL_RE =
  /((?:Zahlungsziel|Zahlungsfrist|Zahlungsbedingung(?:en)?|Zahlungskondition(?:en)?)(?:[ \t]+(?:von|bei|bleibt[ \t]+bei|beträgt|ist|sind|:))?[ \t]*:?[ \t]+)(\d{1,3}[ \t]?Tage(?:n)?)/gu;
/** Eine Frist bei der Zahlung oder beim Skonto: „Bei Zahlung binnen 14 Tagen“, „3 % bei 10 Tagen“. */
const FRIST_RE =
  /((?:Zahlung|zahlbar|Skonto|\[PREIS_\d+\])[^.\n]{0,20}?(?:binnen|innerhalb(?:[ \t]+von)?|bei|nach)[ \t]+)(\d{1,3}[ \t]?Tage(?:n)?)/gu;
const TAGE_NETTO_RE = /(?<![\p{N}])\d{1,3}[ \t]?Tage(?:n)?[ \t]+(?:rein[ \t]+)?(?:netto|ohne[ \t]+Abzug)|netto[ \t]+\d{1,3}[ \t]?Tage(?:n)?/gu;
const CODE_RE =
  /((?:(?:Aktions|Gutschein|Rabatt|Promo|Coupon|Vorteils)-?[Cc]ode|[Cc]ode|Gutschein)[ \t]*[:„"»]?[ \t]*)([A-Z0-9][A-Z0-9-]{3,19})(?![\p{L}\p{N}])/gu;
const PROZENT_RE = /(?<![\p{N},.])\d{1,3}(?:,\d{1,2})?[ \t]?(?:%|Prozent)(?![\p{L}])/gu;
/** Prozent ist nur neben einem Konditionswort ein Preis: `91 %` Wirkungsgrad und `80 %` montiert bleiben stehen. */
const KONDITION =
  "(?:\\p{L}*(?:[Rr]abatt|[Nn]achlass|[Bb]onus|[Ss]konto|[Pp]rovision|[Aa]ufschlag|[Aa]bschlag|[Ee]rmäßigung|[Vv]ergünstigung)\\p{L}*|Kulanz|abzüglich|Abzug|minus|günstiger|billiger|reduziert|Liste|Listenpreis\\p{L}*|UVP|Marge|Discount)";
const KONDITION_DAVOR_RE = new RegExp(
  `${KONDITION}[ \\t]*(?:von|in[ \\t]+Höhe[ \\t]+von|i\\.[ \\t]?H\\.[ \\t]?v\\.|bis[ \\t]+zu|bis|zu|um|mit|über|auf|:|=)?[ \\t]*$`,
  'u',
);
const KONDITION_DANACH_RE = new RegExp(
  `^[ \\t]*(?:(?:(?:auf|vom|von)[ \\t]+(?:die|den|das|dem)?[ \\t]*)?${KONDITION}|auf[ \\t]+(?:alle|ausgewählte|das[ \\t]+gesamte|den[ \\t]+gesamten)(?![\\p{L}]))`,
  'u',
);

// ── Artikelnummern (neu, Messung §2: 0 von 20 erkannt) ─────────────────────────────────────────────────────────────
const ARTIKEL_KENNWORT =
  '(?:Art(?:ikel)?\\.?[ \\t]?-?[ \\t]?(?:Nr|Nummer|No)\\.?|Artikelnummern?|Artikel-?Nr\\.?|Artikeln?|ArtNr\\.?|EAN(?:-Code|-Nummer)?|GTIN|Barcode)';
const ARTIKEL_LISTE_RE = new RegExp(
  `(?<![\\p{L}])(${ARTIKEL_KENNWORT}[ \\t]*[:#]?[ \\t]*)(\\d{4,14}(?:[ \\t]*(?:,|;|\\/|und|sowie|oder|bzw\\.|bis|–|-)[ \\t]*\\d{4,14})*)(?![\\p{N}])`,
  'gu',
);
const EAN13_RE = /(?<![\p{N}])\d{13}(?![\p{N}])/gu;

const GREETING_RE = new RegExp(
  `(?:Hallo|Hi|Hey|Hoi|Grüezi|Sali|Salü|Ciao|Servus|Moin|Liebe[rs]?|Sehr geehrte[rs]?|Guten Tag|Grüß Gott|Dear|Hello)(?:\\s+${TITLE})*\\s+(${FULL_NAME})`,
  'gu',
);
const ANREDE_ZEILE_RE = /(?:^|\n)[ \t]*(\p{Lu}\p{Ll}+)[,:][ \t]/gu;
/** `@Nicole kannst du …`: eine Erwähnung im Chat. */
const ERWAEHNUNG_RE = new RegExp(`(?<![\\p{L}\\p{N}._%+-])@(${FULL_NAME})`, 'gu');
/** Eine Rolle mit Doppelpunkt, dann der Name: „Beratung: Ladina Caduff“ (Fremdkorpus 2). */
const ROLLE_RE = new RegExp(
  `(?:Ansprechpartner(?:in)?|Kontaktperson|Kontakt|Beratung|Bearbeiter(?:in)?|Sachbearbeiter(?:in)?|Techniker(?:in)?|Monteur(?:in)?|Bauleiter(?:in)?|Projektleiter(?:in)?|Prüfer(?:in)?|Verkäufer(?:in)?|Vertreter(?:in)?|Planer(?:in)?|Architekt(?:in)?|Elektriker(?:in)?|Polier|Teilnehmer(?:in)?|Verfasser(?:in)?|Erstellt von|Absender(?:in)?)[ \\t]*:[ \\t]*(?:${TITLE}[ \\t]+)*(${FULL_NAME})`,
  'gu',
);
const TITLED_RE = new RegExp(`${TITLE}\\s+(?:${TITLE}\\s+)*(${FULL_NAME})`, 'gu');
const CLOSING_RE = new RegExp(
  `(?:Mit freundlichen Grüßen|Mit besten Grüßen|Freundliche Grüße|Beste Grüße|Viele Grüße|Liebe Grüße|Herzliche Grüße|Schöne Grüße|Danke und Grüße|Grüße|MfG|LG|VG|Best regards|Kind regards|Regards|Cheers)[,.!]?\\s*(?:\\\\n|\\s)*(?:${TITLE}\\s+)*(${FULL_NAME})`,
  'gu',
);
/**
 * „Danke, Martin“ und „Bis später, Ines“ als Schluss einer kurzen Mail. Nur mit Komma, Rufzeichen oder Zeilenumbruch:
 * „Danke Ihnen“ und „Bis später Bericht schicken“ sind keiner. Auch mit Initiale: „J. Brandt“.
 */
const THANKS_RE = new RegExp(
  `(?:Danke|Vielen Dank|Merci|Thanks|Thx|Bis später|Bis bald|Bis dann|Bis morgen|Ciao|Tschüss|Tschüs|Pfiat di|Grüßle)(?:[,!][ \\t]*(?:\\n[ \\t]*)?|[ \\t]*\\n[ \\t]*)((?:\\p{Lu}\\.[ \\t]*)?${FULL_NAME})`,
  'gu',
);
/** Eine Grußformel mit Initiale: „Viele Grüße\nJ. Brandt“. */
const CLOSING_INITIAL_RE = new RegExp(
  `(?:Mit freundlichen Grüßen|Freundliche Grüße|Beste Grüße|Viele Grüße|Liebe Grüße|Herzliche Grüße|Schöne Grüße|Grüße|MfG|LG|VG)[,.!]?\\s*(\\p{Lu}\\.[ \\t]*${WORD})`,
  'gu',
);
/** Zum Vergleich zweier Schreibungen: „Horáková“ im Text, „horakova“ in der Adresse, „Müller“ und „mueller“. */
const falte = (s: string): string =>
  s.toLowerCase().replace(/ß/g, 'ss').replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u').normalize('NFD').replace(/\p{M}/gu, '');

/** Kein Name, auch wenn es wie einer aussieht oder im Mailkopf steht: „Freitag“ als Nachname darf „bis Freitag“ nicht treffen. */
const NOT_A_NAME = new Set(
  [
    'montag dienstag mittwoch donnerstag freitag samstag sonnabend sonntag',
    'januar jänner februar feber märz april mai juni juli august september oktober november dezember',
    'damen herren kolleginnen kollegen team zusammen allerseits alle kunde kundin kunden ihnen dir dein deine ihr ihre mein meine',
    'und oder aus von vom bei mit für das der die den dem des ein eine einen wir sie ich herr frau grüße gruß danke vielen',
    'service support info office kontakt newsletter redaktion buchhaltung vertrieb verwaltung hausverwaltung team admin',
    'heute morgen gestern anbei bitte hier sehr geehrte liebe lieber hallo guten tag',
    'rechnung angebot auftrag termin mail nachricht betreff datum',
    'noreply reply no-reply mailer postmaster sales hello hallo contact billing',
    // Abteilungen unter der Grußformel (Messung §2: „Innendienst“, „Export“ galten als Name)
    'innendienst außendienst export import einkauf technik marketing geschäftsführung projektleitung lager logistik',
    'kundendienst verkauf disposition assistenz sekretariat empfang zentrale',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Mehr Namensflächen je Lauf gehen nicht hinaus. Echte Texte bleiben weit darunter. Ein Text voller erfundener Namen
 * scheitert so schnell, statt den Server aufzuhalten, und sendet nichts.
 */
const MAX_PERSON_SURFACES = 10_000;

/** Kein Nachname: Nach einem Vornamen folgt hier eine Firma, ein Messwert oder eine englische Überschrift. */
const NOT_A_SURNAME = new Set(
  [
    'gmbh ag kg og mbh ug ltd llc inc co group gruppe bank versicherung online shop store magazin verlag zeitung akademie academy',
    'software systems solutions consulting media digital design events hotel restaurant apotheke praxis kanzlei stiftung verein',
    'institut universität klinik schule agentur holding code',
    'länge breite höhe tiefe leistung power watt volt ampere strom spannung temperatur anzahl größe menge preis gewicht',
    'straße strasse gasse platz allee',
    'your you the our for and with from this that more new now here',
  ]
    .join(' ')
    .split(' '),
);
const PARTICLES = new Set(['von', 'van', 'de', 'di', 'da', 'del', 'zu', 'ter', 'ten']);
const NAME_WORD = "\\p{Lu}[\\p{L}'’-]*\\p{L}";
const PARTICLE = `(?:${[...PARTICLES].join('|')})`;
/** Eine Folge großer Wörter in einer Zeile. Welche davon ein Name sind, entscheidet `nameLengthAt`. */
const NAME_RUN_RE = new RegExp(`(?<![\\p{L}\\p{N}_])${NAME_WORD}(?: (?:${PARTICLE} )?${NAME_WORD})+(?![\\p{L}\\p{N}_])`, 'gu');

const isSurnameWord = (word: string): boolean => !NOT_A_NAME.has(word.toLowerCase()) && !NOT_A_SURNAME.has(word.toLowerCase());

interface NameWord {
  bare: string;
  /** Mit Zusatz davor: „van Beethoven“. */
  full: string;
}

const phraseAt = (words: readonly NameWord[], i: number, length: number): string =>
  [words[i]!.bare, ...words.slice(i + 1, i + length).map((w) => w.full)].join(' ');

const ARTEN_ALTERNATIVE = ARTEN.join('|');
/** Genau die Form, die diese Sitzung schreibt. */
export const PLACEHOLDER_RE = new RegExp(`\\[(${ARTEN_ALTERNATIVE})_(\\d+(?:\\.\\d+)?)\\]`, 'g');
/**
 * Wie ein Modell Platzhalter zurückgibt: `[Person 1]`, `[PERSON 1]`, `[person-1]`, `[E-Mail_2]`, auch ohne Klammern
 * (`PERSON_1`). Alles davon wird zurückgesetzt; was nicht in der Zuordnung steht, ist erfunden.
 */
const LOOSE_PLACEHOLDER_RE = new RegExp(
  `\\[[ \\t]*(${ARTEN_ALTERNATIVE}|E-?Mail)[ \\t_-]*(\\d+(?:\\.\\d+)?)[ \\t]*\\]|\\b(${ARTEN_ALTERNATIVE})_(\\d+(?:\\.\\d+)?)\\b`,
  'giu',
);
const REDACTED_RE = /\[REDACTED\]/gi;
/** Was ein Modell als Platzhalter erfinden könnte: Großbuchstaben in eckigen Klammern, mit oder ohne Nummer. */
const PLATZHALTER_FORM_RE = /\[[ \t]*[A-ZÄÖÜ][A-ZÄÖÜ-]{2,}(?:[ \t_-]*\d+(?:\.\d+)?)?[ \t_-]*\]/g;

/** Geschützte und schmale Leerzeichen, in 36 % der Mails gemessen (04.11.2026). Sonst greift keine Regel, die ein Leerzeichen erwartet. */
const SPECIAL_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
/** Alle Formatzeichen (\p{Cf}): weicher Trennstrich, Nullbreite, Richtungszeichen. U+200C vor einem @ ließ sonst die Mail
 * durch, U+200D/U+200E zerteilten Telefon und IBAN (Review H3). */
const INVISIBLE_RE = /\p{Cf}/gu;
/** Vollbreite Zeichen (U+FF01–FF5E) wie ASCII: `０６６４` ist eine Telefonnummer, `＠` ein At (Review H3). */
const VOLLBREIT_RE = /[\uFF01-\uFF5E]/g;
/** Prozentkodiert in einer URL: `%40` ist ein @, `%2B` ein Plus (`?email=a%40b.at&tel=%2B43…`, Review H3). */
const PROZENT_KODIERT_RE = /%(?:40|2[Bb])/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const schluessel = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Prüfsumme einer IBAN nach ISO 13616 (mod 97 = 1). */
export function ibanGueltig(roh: string): boolean {
  const iban = roh.replace(/[\s.-]+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const umgestellt = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of umgestellt) {
    const wert = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const ziffer of wert) rest = (rest * 10 + Number(ziffer)) % 97;
  }
  return rest === 1;
}

/** Die längste gültige IBAN am Anfang eines Treffers, an Gruppengrenzen gekürzt; `null`, wenn keine gültig ist. */
export function gueltigeIbanAmAnfang(treffer: string): string | null {
  const grenzen: number[] = [];
  for (let i = 1; i <= treffer.length; i += 1) {
    if (i === treffer.length || /[\s.-]/.test(treffer[i]!)) grenzen.push(i);
  }
  // Ohne Trenner geschrieben: jede Länge ab 15 Zeichen ist eine mögliche Grenze.
  if (!/[\s.-]/.test(treffer)) for (let i = 15; i < treffer.length; i += 1) grenzen.push(i);
  for (const ende of [...new Set(grenzen)].sort((a, b) => b - a)) {
    const teil = treffer.slice(0, ende);
    if (ibanGueltig(teil)) return teil;
  }
  return null;
}

/** Prüfziffer einer EAN-13 (GS1). */
export function ean13Gueltig(ziffern: string): boolean {
  if (!/^\d{13}$/.test(ziffern)) return false;
  let summe = 0;
  for (let i = 0; i < 12; i += 1) summe += Number(ziffern[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (summe % 10)) % 10 === Number(ziffern[12]);
}

/** Was die Erkennung vor allen Regeln vereinheitlicht. Der ausgehende Text ist danach genau dieser Text. */
export function vereinheitlichen(text: string): string {
  return text
    .replace(INVISIBLE_RE, '')
    .replace(SPECIAL_SPACE_RE, ' ')
    .replace(VOLLBREIT_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(PROZENT_KODIERT_RE, (c) => (c === '%40' ? '@' : '+'));
}

interface Stelle {
  start: number;
  ende: number;
}

/** Alle gültigen IBANs im Text: ab jedem möglichen Anfang die längste gültige Gruppenfolge (Review H2). */
export function ibanStellen(text: string): Stelle[] {
  const stellen: Stelle[] = [];
  let frei = 0;
  for (const m of text.matchAll(IBAN_ANFANG_RE)) {
    if (m.index! < frei) continue;
    const kandidat = IBAN_KANDIDAT_RE.exec(text.slice(m.index!, m.index! + 60))?.[0];
    const iban = kandidat ? gueltigeIbanAmAnfang(kandidat) : null;
    if (iban) {
      stellen.push({ start: m.index!, ende: m.index! + iban.length });
      frei = m.index! + iban.length;
    }
  }
  return stellen;
}

/**
 * Karten in einem Ziffernlauf: jedes Fenster aus 13–19 Ziffern zwischen zwei Gruppengrenzen, das längste gültige zuerst.
 * So fällt `4111 1111 1111 1111` auch hinter einer Ziffer („Karte 2 4111 …“, Review H2). Ein Lauf ohne Trenner zählt nur
 * als Ganzes: In einer langen Ziffernfolge bestünde sonst irgendein Fenster die Prüfung zufällig.
 */
function kartenImLauf(lauf: string, versatz: number): Stelle[] {
  const trenner = /[ \t-]/;
  const anfaenge = [0];
  const enden: number[] = [];
  for (let i = 1; i < lauf.length; i += 1) if (trenner.test(lauf[i - 1]!) && !trenner.test(lauf[i]!)) anfaenge.push(i);
  for (let i = 0; i < lauf.length; i += 1) {
    if (!trenner.test(lauf[i]!) && (i === lauf.length - 1 || trenner.test(lauf[i + 1]!))) enden.push(i + 1);
  }
  const fenster: { a: number; e: number; n: number }[] = [];
  for (const a of anfaenge) {
    for (const e of enden) {
      if (e <= a) continue;
      const n = lauf.slice(a, e).replace(/\D/g, '').length;
      if (n >= 13 && n <= 19) fenster.push({ a, e, n });
    }
  }
  fenster.sort((x, y) => y.n - x.n || x.a - y.a);
  const t = fenster.find((f) => luhn(lauf.slice(f.a, f.e).replace(/\D/g, '')));
  if (!t) return [];
  return [
    ...kartenImLauf(lauf.slice(0, t.a), versatz),
    { start: versatz + t.a, ende: versatz + t.e },
    ...kartenImLauf(lauf.slice(t.e), versatz + t.e),
  ];
}

export function kartenStellen(text: string): Stelle[] {
  return [...text.matchAll(ZIFFERNLAUF_RE)].flatMap((m) => kartenImLauf(m[0], m.index!));
}

function stellenErsetzen(text: string, stellen: Stelle[], ersetze: (wert: string) => string): string {
  let out = '';
  let pos = 0;
  for (const s of [...stellen].sort((a, b) => a.start - b.start)) {
    if (s.start < pos) continue;
    out += text.slice(pos, s.start) + ersetze(text.slice(s.start, s.ende));
    pos = s.ende;
  }
  return out + text.slice(pos);
}

/** Steht im Text schon etwas, das wie ein Platzhalter aussieht? Dann wäre die Zuordnung mehrdeutig (Review M1). */
export function enthaeltPlatzhalter(text: string): boolean {
  return new RegExp(LOOSE_PLACEHOLDER_RE.source, 'iu').test(text) || /\[REDACTED\]/i.test(text);
}

/**
 * Ein Muster für die Artikelnummer: nur Zeichenklassen, einzelne Zeichen und begrenzte Wiederholungen `{m}` oder `{m,n}`,
 * Alternativen nur auf oberster Ebene. Keine Gruppen, kein `+`, kein `*`: Verschachtelte Wiederholungen legten den Server
 * lahm (`(?:\d+)+`, 28 Ziffern 1,3 s, Review M4), eine Fanggruppe brach die Erkennung (M5).
 */
const MUSTER_BAUSTEIN = '(?:\\[[0-9A-Za-z-]+\\]|\\\\d|[0-9A-Za-z-])(?:\\{\\d{1,2}(?:,\\d{1,2})?\\})?';
const MUSTER_GRAMMATIK_RE = new RegExp(`^(?:${MUSTER_BAUSTEIN})+(?:\\|(?:${MUSTER_BAUSTEIN})+)*$`);

/** Der Satz um eine Stelle, für Regeln, die nur in einem bestimmten Zusammenhang gelten. */
function satzUm(text: string, start: number, ende: number): string {
  const davor = text.slice(0, start);
  const anfang = Math.max(davor.lastIndexOf('. '), davor.lastIndexOf('\n'), davor.lastIndexOf('! '), davor.lastIndexOf('? ')) + 1;
  const rest = text.slice(ende);
  const m = /[.!?](?:\s|$)|\n/.exec(rest);
  return text.slice(anfang, ende + (m ? m.index : rest.length));
}

export class PseudonymSession {
  private readonly byKey = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, PseudonymReplacement>();
  private readonly counters = new Map<PseudonymKind, number>();
  /** Fläche im Text → Platzhalter, die längsten zuerst ersetzt. */
  private readonly persons = new Map<string, string>();
  /** Schutzliste und eigene Wörter, klein geschrieben → Art. */
  private readonly terms = new Map<string, PseudonymKind>();
  private readonly knownNames: ReadonlySet<string>;
  private readonly aus: ReadonlySet<Schutzklasse>;
  private readonly aufdecken: ReadonlySet<string>;
  private readonly artikelRe: RegExp | null;
  private readonly aufgedecktGenutzt = new Set<string>();
  private readonly nichtAufdeckbar = new Set<string>();
  private personMatcher: { size: number; re: RegExp } | null = null;
  /** Gefaltete Schreibung eines Namens oder Namensteils → Platzhalter. */
  private readonly gefaltet = new Map<string, string>();
  /** Platzhalter, deren Wert aus einer Mailadresse erschlossen ist: Die Schreibung im Text ersetzt ihn. */
  private readonly ausAdresse = new Set<string>();
  /** Personen der Schutzliste: Sie warten, bis sie im Text stehen (Review H1). */
  private readonly listenPersonen: string[] = [];
  /** Schutzliste (klein geschrieben, samt Namensteilen): nie aufdeckbar. */
  private readonly fest = new Set<string>();
  /** Personen der Schutzliste, die im Text stehen: Fläche klein geschrieben → Platzhalter. */
  private readonly listenFlaechen = new Map<string, string>();

  constructor(seed: PseudonymSeed = {}) {
    this.knownNames = seed.knownNames ?? new Set();
    const aus = new Set(seed.aus ?? []);
    for (const k of aus) {
      if (PFLICHTKLASSEN.has(k)) throw new PseudonymizationError(`Die Klasse ${k} lässt sich nicht abschalten`);
    }
    this.aus = aus;
    this.aufdecken = new Set([...(seed.aufdecken ?? [])].map(schluessel).filter((s) => s.length > 0));
    this.artikelRe = seed.artikelnummer ? PseudonymSession.artikelMuster(seed.artikelnummer) : null;
    for (const p of seed.persons ?? []) this.addPerson(p);
    for (const t of seed.terms ?? []) {
      const eintrag = typeof t === 'string' ? { begriff: t, art: 'BEGRIFF' as const } : t;
      const term = eintrag.begriff.replace(/\s+/g, ' ').trim();
      if (term.length >= 2 && !term.includes('[') && !term.includes(']')) this.terms.set(term.toLowerCase(), eintrag.art);
    }
    for (const eintrag of seed.schutzliste ?? []) {
      const term = eintrag.begriff.replace(/\s+/g, ' ').trim();
      if (term.length < 2 || term.includes('[') || term.includes(']')) continue;
      this.fest.add(schluessel(term));
      if (eintrag.art === 'PERSON') {
        this.listenPersonen.push(term);
        for (const teil of term.split(/[ ,]+/)) if (teil.length >= 2) this.fest.add(schluessel(teil));
      } else {
        this.terms.set(term.toLowerCase(), eintrag.art);
      }
    }
  }

  /** Baut aus dem Muster der Einstellungen eine Regel mit festen Rändern. Wirft bei einem ungültigen Muster. */
  static artikelMuster(muster: string): RegExp {
    if (muster.length > 200 || !MUSTER_GRAMMATIK_RE.test(muster)) {
      throw new PseudonymizationError(
        'Das Muster der Artikelnummer darf nur Zeichenklassen wie [0-9], einzelne Zeichen, {m} oder {m,n} und | enthalten',
      );
    }
    let probe: RegExp;
    try {
      probe = new RegExp(`^(?:${muster})$`, 'u');
    } catch {
      throw new PseudonymizationError('Das Muster der Artikelnummer ist kein gültiger regulärer Ausdruck');
    }
    if (probe.test('')) throw new PseudonymizationError('Das Muster der Artikelnummer trifft auch einen leeren Text');
    // Ein Muster, das Wörter trifft, verdeckte jeden Text (Review N1): reine Buchstabenfolgen jeder Länge bis 12 prüfen.
    for (let n = 1; n <= 12; n += 1) {
      for (const z of ['a', 'A', 'x', 'Z']) {
        if (probe.test(z.repeat(n))) throw new PseudonymizationError('Das Muster der Artikelnummer darf keine Wörter treffen');
      }
    }
    return new RegExp(`(?<![\\p{L}\\p{N}_.,:/\\[-])(?:${muster})(?![\\p{N}_\\]]|[.,:/-]\\p{N})`, 'gu');
  }

  private an(klasse: Schutzklasse): boolean {
    return !this.aus.has(klasse);
  }

  /** Aufgedeckt und erlaubt: Der Wert bleibt stehen. Eine Pflichtklasse und die Schutzliste lassen sich nicht aufdecken. */
  private bleibtOffen(kind: PseudonymKind, value: string): boolean {
    const key = schluessel(value);
    if (!this.aufdecken.has(key)) return false;
    if (PFLICHTKLASSEN.has(KLASSE_JE_ART[kind]) || this.fest.has(key)) {
      this.nichtAufdeckbar.add(value);
      return false;
    }
    this.aufgedecktGenutzt.add(value);
    return true;
  }

  private placeholder(kind: PseudonymKind, value: string): string {
    const key = `${kind}:${schluessel(value)}`;
    const known = this.byKey.get(key);
    if (known) return known;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const placeholder = `[${kind}_${n}]`;
    this.byKey.set(key, placeholder);
    this.byPlaceholder.set(placeholder, { placeholder, kind, value });
    return placeholder;
  }

  /** Platzhalter, oder der Wert selbst, wenn der Nutzer ihn aufgedeckt hat. */
  private verdecke(kind: PseudonymKind, value: string): string {
    return this.bleibtOffen(kind, value) ? value : this.placeholder(kind, value);
  }

  /** „Anna Müller“ wird [PERSON_1], „Anna“ allein [PERSON_1.1]: Das Modell sieht, dass es dieselbe ist, und die Antwort bleibt wörtlich. */
  addPerson(raw: string, ausDerAdresse = false, ausListe = false): void {
    const name = raw.replace(/["<>]/g, '').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim();
    if (name.length < (ausListe ? 2 : 3) || name.includes('@')) return;
    if (this.persons.has(name)) return;
    if (this.bleibtOffen('PERSON', name)) return;
    // Dieselbe Person in anderer Schreibung: derselbe Platzhalter, und die Schreibung des Textes gilt beim Zurücksetzen.
    const gleich = this.gefaltet.get(falte(name));
    if (gleich) {
      this.persons.set(name, gleich);
      this.schreibungUebernehmen(gleich, name);
      for (const token of name.split(/[ ,]+/)) {
        const teil = this.gefaltet.get(falte(token));
        if (teil && teil !== gleich && !this.persons.has(token)) {
          this.persons.set(token, teil);
          this.schreibungUebernehmen(teil, token);
        }
      }
      return;
    }
    // Auch „Moser, Karl“: Das Komma gehört nicht zum Wort.
    const tokens = name.split(/[ ,]+/).filter((t) => t.length >= (ausListe ? 2 : 3) && !t.endsWith('.') && !PARTICLES.has(t));
    const usable = tokens.filter((t) => !NOT_A_NAME.has(t.toLowerCase()));
    // Sind alle Wörter zu kurz für einen Teilnamen (`Bo Li`), bleibt der ganze Name.
    if (tokens.length > 0 && usable.length === 0) return;
    const placeholder = this.placeholder('PERSON', name);
    this.persons.set(name, placeholder);
    // Aus der Schutzliste in jeder Schreibung (Review M6): ein eigener Durchgang ohne Rücksicht auf groß/klein.
    if (ausListe) this.listenFlaechen.set(schluessel(name), placeholder);
    this.gefaltet.set(falte(name), placeholder);
    if (ausDerAdresse) this.ausAdresse.add(placeholder);
    if (tokens.length < 2) return;
    usable.forEach((token, i) => {
      if (this.persons.has(token) || this.bleibtOffen('PERSON', token)) return;
      const part = `${placeholder.slice(0, -1)}.${i + 1}]`;
      this.persons.set(token, part);
      if (ausListe && !this.listenFlaechen.has(schluessel(token))) this.listenFlaechen.set(schluessel(token), part);
      this.byPlaceholder.set(part, { placeholder: part, kind: 'PERSON', value: token });
      if (!this.gefaltet.has(falte(token))) this.gefaltet.set(falte(token), part);
      if (ausDerAdresse) this.ausAdresse.add(part);
    });
  }

  /** Eine Person der Schutzliste bekommt ihren Platzhalter erst, wenn sie (oder ein Teil ihres Namens) im Text steht. */
  private listenPersonenEintragen(text: string): void {
    for (const p of this.listenPersonen) {
      if (this.persons.has(p)) continue;
      const teile = [p, ...p.split(/[ ,]+/).filter((t) => t.length >= 2 && !PARTICLES.has(t))].map(escapeRe);
      if (new RegExp(`(?<![\\p{L}\\p{N}_])(?:${teile.join('|')})(?![\\p{L}\\p{N}])`, 'iu').test(text)) this.addPerson(p, false, true);
    }
  }

  /** Die Personen der Schutzliste in jeder Schreibung, auch über einen Zeilenumbruch, die längsten zuerst. */
  private listenErsetzen(text: string): string {
    if (this.listenFlaechen.size === 0) return text;
    const flaechen = [...this.listenFlaechen.keys()].sort((a, b) => b.length - a.length).map((f) => escapeRe(f).replace(/ /g, '\\s+'));
    const re = new RegExp(`(?<![\\p{L}\\p{N}_\\[])(?:${flaechen.join('|')})(?![\\p{L}\\p{N}\\]]|_\\d)`, 'giu');
    return text.replace(re, (m) => this.listenFlaechen.get(schluessel(m)) ?? m);
  }

  private schreibungUebernehmen(platzhalter: string, wert: string): void {
    if (!this.ausAdresse.has(platzhalter)) return;
    this.byPlaceholder.set(platzhalter, { placeholder: platzhalter, kind: 'PERSON', value: wert });
    this.ausAdresse.delete(platzhalter);
  }

  /** `anna.mueller@…` verrät den Namen, auch wenn er sonst nirgends steht. */
  addAddress(address: string, name?: string | null): void {
    if (name) this.addPerson(name);
    const local = address.split('@')[0] ?? '';
    const parts = local.split(/[._-]/);
    if (parts.length < 2 || parts.length > 3) return;
    if (!parts.every((p) => /^\p{L}{3,}$/u.test(p) && !NOT_A_NAME.has(p.toLowerCase()))) return;
    this.addPerson(parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' '), true);
  }

  /** Wie viele Wörter ab `i` ein Name sind, 0 sonst. Erst das Adressbuch, dann die Vornamen: „Anna Maria Huber“ sind drei Wörter. */
  private nameLengthAt(words: readonly NameWord[], i: number): number {
    for (const length of [3, 2]) {
      if (i + length > words.length) continue;
      const phrase = phraseAt(words, i, length).toLowerCase();
      // Auch im Genitiv: „Karl Mosers Angebot“, „Karl Moser's“.
      if (this.knownNames.has(phrase) || this.knownNames.has(phrase.replace(/(?:['’]s|s)$/, ''))) return length;
      // Schon bekannt in anderer Schreibung, etwa aus der Mailadresse daneben.
      if (this.gefaltet.has(falte(phrase))) return length;
    }
    const first = words[i]!.bare.split('-')[0]!.toLowerCase();
    const next = words[i + 1];
    if (!FIRST_NAMES.has(first) || !next || !isSurnameWord(next.bare)) return 0;
    const after = words[i + 2];
    const nextIsFirstName = FIRST_NAMES.has(next.bare.toLowerCase());
    // „Karl von Peter Müller“: Mit dem Zusatz beginnt hier die nächste Person, nicht der Nachname.
    if (nextIsFirstName && next.full !== next.bare && after) return 0;
    return nextIsFirstName && after && isSurnameWord(after.bare) ? 3 : 2;
  }

  /** Namen im Fließtext, ohne Anrede oder Mailkopf. Der Zusatz zählt nur hinter dem ersten Wort: „Mail von Anna Huber“ beginnt bei Anna. */
  private learnNames(text: string): void {
    for (const run of text.matchAll(NAME_RUN_RE)) {
      const words: NameWord[] = [];
      let particle = '';
      for (const piece of run[0].split(' ')) {
        if (PARTICLES.has(piece)) {
          particle = `${piece} `;
        } else {
          words.push({ bare: piece, full: particle + piece });
          particle = '';
        }
      }
      let i = 0;
      while (i < words.length - 1) {
        const length = this.nameLengthAt(words, i);
        if (length > 0) this.addPerson(phraseAt(words, i, length));
        i += length || 1;
      }
      this.assertWithinLimit();
    }
  }

  /**
   * Alle Personen in einem Durchgang, die längsten zuerst. Je Name ein eigener Durchlauf über den Text wäre quadratisch
   * (1000 Namen in 13 KB brauchten so 1,4 s). `_\d` schützt die Platzhalter selbst: `[URL_1]` bleibt, auch wenn jemand URL
   * heißt. Eine Klammer davor schützt keinen Namen.
   */
  private replacePersons(text: string): string {
    if (this.persons.size === 0) return text;
    this.assertWithinLimit();
    if (this.personMatcher?.size !== this.persons.size) {
      const surfaces = [...this.persons.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
      this.personMatcher = { size: this.persons.size, re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${surfaces.join('|')})(?![\\p{L}\\p{N}]|_\\d)`, 'gu') };
    }
    return text.replace(this.personMatcher.re, (surface) => this.persons.get(surface) ?? surface);
  }

  /** Schutzliste und eigene Wörter in einem Durchgang, in jeder Schreibweise, nie mitten im Wort, die längsten zuerst. */
  private replaceTerms(text: string): string {
    if (this.terms.size === 0) return text;
    const alle = [...this.terms.keys()].sort((a, b) => b.length - a.length).map((t) => escapeRe(t).replace(/ /g, '\\s+'));
    // Nie in einem Platzhalter: `verdecken: ['EMAIL_1']` traf sonst „[EMAIL_1]“ (Review N3).
    const re = new RegExp(`(?<![\\p{L}\\p{N}_\\[])(?:${alle.join('|')})(?![\\p{L}\\p{N}\\]]|_\\d)`, 'giu');
    return text.replace(re, (m) => this.verdecke(this.terms.get(schluessel(m)) ?? 'BEGRIFF', m));
  }

  private assertWithinLimit(): void {
    if (this.persons.size > MAX_PERSON_SURFACES) {
      throw new PseudonymizationError(`Mehr als ${MAX_PERSON_SURFACES} Namen in einem Lauf, es wird nichts gesendet`);
    }
  }

  private preise(text: string): string {
    let out = text.replace(PREIS_VOR_RE, (m) => this.verdecke('PREIS', m));
    out = out.replace(PREIS_SPANNE_RE, (m) => this.verdecke('PREIS', m));
    out = out.replace(PREIS_NACH_RE, (m) => this.verdecke('PREIS', m));
    out = out.replace(PREIS_K_RE, (m, offset: number, s: string) =>
      GELDWORT_DAVOR_RE.test(s.slice(Math.max(0, offset - 40), offset)) ? this.verdecke('PREIS', m) : m,
    );
    out = out.replace(ZAHLUNGSZIEL_RE, (_m, davor: string, wert: string) => davor + this.verdecke('PREIS', wert));
    out = out.replace(TAGE_NETTO_RE, (m) => this.verdecke('PREIS', m));
    out = out.replace(CODE_RE, (m, davor: string, code: string) =>
      /\d/.test(code) || (code.length >= 5 && code === code.toUpperCase()) ? davor + this.verdecke('PREIS', code) : m,
    );
    out = out.replace(PROZENT_RE, (m, offset: number, s: string) => {
      const davor = s.slice(Math.max(0, offset - 60), offset);
      const danach = s.slice(offset + m.length, offset + m.length + 50);
      return KONDITION_DAVOR_RE.test(davor) || KONDITION_DANACH_RE.test(danach) ? this.verdecke('PREIS', m) : m;
    });
    // Nach den Prozenten: „[PREIS_3] bei 10 Tagen“ braucht den Platzhalter davor.
    out = out.replace(FRIST_RE, (_m, davor: string, wert: string) => davor + this.verdecke('PREIS', wert));
    return out;
  }

  /** Hinter einem Kennwort jede Nummer einer Aufzählung: „den Artikeln 112455, 112456 und 31540“. */
  private artikelMitKennwort(text: string): string {
    return text.replace(ARTIKEL_LISTE_RE, (_m, kennwort: string, liste: string) =>
      kennwort + liste.replace(/\d{4,14}/g, (nr) => this.verdecke('ARTIKELNR', nr)),
    );
  }

  /** Nach dem Muster der Installation, aber nie vor einer Einheit, einem Mengenwort oder einem Hauptwort. */
  private artikelOhneKennwort(text: string): string {
    let out = text;
    if (this.artikelRe) {
      out = out.replace(this.artikelRe, (m, ...rest: unknown[]) => {
        // Stelle und Text stehen am Ende der Argumente, auch wenn das Muster doch eine Gruppe hätte (Review M5).
        const offset = rest[rest.length - 2] as number;
        const s = rest[rest.length - 1] as string;
        const davor = s.slice(Math.max(0, offset - 12), offset);
        const danach = s.slice(offset + m.length, offset + m.length + 30);
        if (/(?:€|EUR|CHF|USD|\$|£)[ \t]?$/.test(davor)) return m;
        // Eine Norm ist keine Artikelnummer: „EN 60598“ (Fehltreffer im Erstlauf am fremden Korpus).
        if (/(?:EN|DIN|ISO|IEC|ÖNORM|ÖVE|OVE|VDE|UL|BS|NF|CIE)[ \t/-]?$/.test(davor)) return m;
        if (/^(?:19|20)\d\d$/.test(m)) return m;
        if (EINHEIT_DANACH_RE.test(danach)) return m;
        const wort = /^[ \t]+(\p{L}+)/u.exec(danach)?.[1];
        if (wort && (istMengenwort(wort) || /^\p{Lu}/u.test(wort))) return m;
        return this.verdecke('ARTIKELNR', m);
      });
    }
    // Eine EAN mit gültiger Prüfziffer ist auch ohne Kennwort eine.
    return out.replace(EAN13_RE, (m) => (ean13Gueltig(m) ? this.verdecke('ARTIKELNR', m) : m));
  }

  private projekte(text: string): string {
    let out = text.replace(PROJEKT_RE, (m, kennwort: string, name: string) => {
      const erstes = erstesWort(name);
      return KEIN_EIGENNAME.has(erstes) ? m : kennwort + this.verdecke('PROJEKT', name);
    });
    out = out.replace(OBJEKT_RE, (m) => this.verdecke('PROJEKT', m));
    return out;
  }

  private firmenNachBranche(text: string): string {
    return text.replace(FIRMA_BRANCHE_RE, (m, branche: string, name: string) => {
      const erstes = erstesWort(name);
      // Hinter „für“ darf ein Fachwort stehen: „Hochschule für Technik Rapperswil“.
      const mitFuer = /^(?:für|der|des)[ \t]/u.test(name);
      if (KEIN_EIGENNAME.has(erstes) || (!mitFuer && NOT_A_NAME.has(erstes)) || istMengenwort(erstes)) return m;
      if (branche === 'Firma' || branche === 'Fa.') return `${branche} ${this.verdecke('FIRMA', name)}`;
      return this.verdecke('FIRMA', m);
    });
  }

  /**
   * Text pseudonymisieren. Wirft, wenn schon Platzhalter darin stehen oder danach noch eine Mailadresse dasteht.
   *
   * Reihenfolge (Review M2): zuerst ALLE Pflichtregeln (Bank, Mail, Telefon), danach Schutzliste, eigene Wörter und die
   * übrigen Klassen. Sonst zerteilt ein verdecktes Wort oder eine Artikelnummer eine Telefon- oder Kartennummer, und der
   * Rest geht hinaus (`verdecken: ['0664']` → `Tel. [BEGRIFF_1] 1234567`).
   */
  text(input: string): string {
    let out = vereinheitlichen(input);
    if (enthaeltPlatzhalter(out)) {
      throw new PseudonymizationError('Der Text enthält schon Platzhalter wie [PERSON_1] oder [REDACTED]; bitte entfernen');
    }
    const replace = (re: RegExp, kind: PseudonymKind, accept?: (value: string) => boolean): void => {
      out = out.replace(re, (m) => (accept && !accept(m) ? m : this.verdecke(kind, m)));
    };
    // ── Pflicht: Bank. Prüfsummen entscheiden, nicht das Aussehen, und zwar ab jedem möglichen Anfang (Review H2).
    out = stellenErsetzen(out, ibanStellen(out), (iban) => this.verdecke('IBAN', iban));
    // Die Karte vor dem Kennwort „Artikel“: Eine als Karte verdeckte EAN ist der sicherere Fehler (Review M2).
    out = stellenErsetzen(out, kartenStellen(out), (karte) => this.verdecke('KARTE', karte));
    out = out.replace(BIC_RE, (_m, davor: string, bic: string) => davor + this.verdecke('BIC', bic));
    out = out.replace(KONTO_RE, (_m, davor: string, nummer: string) => davor + this.verdecke('BANK', nummer));
    out = out.replace(ABLAUF_RE, (m, davor: string, datum: string, offset: number, s: string) =>
      KARTEN_KONTEXT_RE.test(satzUm(s, offset, offset + m.length)) ? davor + this.verdecke('BANK', datum) : m,
    );
    out = out.replace(KARTEN_DATUM_RE, (m, offset: number, s: string) =>
      /\[KARTE_\d+\]/.test(satzUm(s, offset, offset + m.length)) ? this.verdecke('BANK', m) : m,
    );
    // ── Pflicht: Mail. Unabhängig von der Klasse URL (Review H3).
    for (const email of out.match(EMAIL_RE) ?? []) if (this.an('PERSON')) this.addAddress(email);
    replace(EMAIL_RE, 'EMAIL');
    replace(EMAIL_OBF_RE, 'EMAIL');
    // ── Pflicht: Telefon.
    replace(PHONE_RE, 'TELEFON', (m) => !DATE_LIKE.test(m.trim()) && m.replace(/\D/g, '').length >= 8);
    out = out.replace(PHONE_KENNWORT_RE, (m, davor: string, nummer: string) =>
      !DATE_LIKE.test(nummer.trim()) && nummer.replace(/\D/g, '').length >= 6 ? davor + this.verdecke('TELEFON', nummer) : m,
    );
    out = out.replace(DURCHWAHL_RE, (_m, davor: string, nummer: string) => davor + this.verdecke('TELEFON', nummer));
    out = out.replace(ZIFFERNGRUPPEN_RE, (m, offset: number, s: string) =>
      m.replace(/\D/g, '').length >= 9 && !DATE_LIKE.test(m) && KONTAKT_KONTEXT_RE.test(satzUm(s, offset, offset + m.length))
        ? this.verdecke('TELEFON', m)
        : m,
    );
    // ── Pflicht: Bankname, braucht den Zusammenhang „IBAN/Konto“ im Satz.
    out = out.replace(BANKNAME_RE, (m, offset: number, s: string) =>
      BANK_KONTEXT_RE.test(satzUm(s, offset, offset + m.length)) ? this.verdecke('BANK', m) : m,
    );
    // ── Ab hier abschaltbar.
    if (this.an('URL')) {
      replace(URL_RE, 'URL');
      replace(DOMAIN_RE, 'URL');
      replace(KNOWN_DOMAIN_RE, 'URL');
    }
    // Schutzliste und eigene Wörter: immer, vor den übrigen Regeln, damit ein Kundenname als Ganzes fällt.
    this.listenPersonenEintragen(out);
    out = this.listenErsetzen(out);
    out = this.replaceTerms(out);
    if (this.an('ARTIKELNR')) out = this.artikelMitKennwort(out);
    if (this.an('PREIS')) out = this.preise(out);
    if (this.an('BELEGNR')) replace(VAT_RE, 'BELEGNR');
    if (this.an('BELEGNR')) {
      // Vor einer Einheit ist es eine Menge: „den bestellten 3000 K Bändern“ traf sonst „Bestell…“ (Korpus PB09).
      out = out.replace(REFERENCE_RE, (m, label: string, number: string, offset: number, s: string) =>
        EINHEIT_DANACH_RE.test(s.slice(offset + m.length, offset + m.length + 12)) ? m : `${label}${this.verdecke('BELEGNR', number)}`,
      );
    }
    if (this.an('ANSCHRIFT')) {
      replace(STREET_ZWEI_RE, 'ADRESSE');
      replace(STREET_VORN_RE, 'ADRESSE');
      replace(STREET_RE, 'ADRESSE');
      replace(STREET_ONLY_RE, 'ADRESSE');
      out = out.replace(POSTCODE_RE, (m, place: string) => {
        const digits = m.match(/\d{4,5}/)?.[0] ?? '';
        const ortWort = place.split(/[ \t-]/)[0]!.toLowerCase();
        if (/^(19|20)\d\d$/.test(digits) || NOT_A_NAME.has(ortWort) || istMengenwort(ortWort)) return m;
        return this.verdecke('ADRESSE', m);
      });
    }
    if (this.an('ARTIKELNR')) out = this.artikelOhneKennwort(out);
    if (this.an('FIRMA')) replace(COMPANY_RE, 'FIRMA');
    if (this.an('PROJEKT')) out = this.projekte(out);
    if (this.an('FIRMA')) out = this.firmenNachBranche(out);
    if (this.an('PERSON')) {
      for (const re of [GREETING_RE, TITLED_RE, CLOSING_RE, CLOSING_INITIAL_RE, THANKS_RE, ERWAEHNUNG_RE, ROLLE_RE]) {
        for (const match of out.matchAll(re)) this.addPerson(match[1]!);
      }
      // Ein Vorname als Anrede am Zeilenanfang: „Mirko, Kundenanruf: …“, „Mia, bitte …“ (Fremdkorpus 2).
      for (const match of out.matchAll(ANREDE_ZEILE_RE)) {
        if (FIRST_NAMES.has(match[1]!.toLowerCase())) this.addPerson(match[1]!);
      }
      this.learnNames(out);
    }
    out = this.replacePersons(out);
    if (new RegExp(EMAIL_RE.source, 'u').test(out)) {
      throw new PseudonymizationError('Eine Mailadresse wäre unverändert hinausgegangen');
    }
    return out;
  }

  /** Antwort zurücksetzen, nur die genaue Form. Ein Platzhalter, den das Modell erfunden hat, bleibt sichtbar stehen. */
  restore(input: string): string {
    return input.replace(PLACEHOLDER_RE, (m) => this.byPlaceholder.get(m)?.value ?? m);
  }

  /**
   * Antwort des Modells zurücksetzen, auch in veränderter Form (`[Person 1]`). Meldet erfundene Platzhalter, fehlende
   * (aus dem gesendeten Text) und `[REDACTED]` des Proxys. Ob die Antwort trotzdem gilt, entscheidet der Aufrufer.
   */
  zuruecksetzen(antwort: string, gesendet: string): { text: string; unbekannt: string[]; fehlend: PseudonymReplacement[]; geschwaerzt: number } {
    const unbekannt = new Set<string>();
    const gefunden = new Set<string>();
    const imText = new Set(gesendet.match(PLACEHOLDER_RE) ?? []);
    // Gilt nur, was gesendet wurde, dazu die Teile eines gesendeten ganzen Namens ([PERSON_1] → [PERSON_1.2]). Sonst setzte
    // ein Platzhalter, den das Modell rät, einen Wert ein, der nie hinausging (Review H1).
    const erlaubt = (p: string) => imText.has(p) || (/\.\d+\]$/.test(p) && imText.has(p.replace(/\.\d+\]$/, ']')));
    const text = antwort.replace(LOOSE_PLACEHOLDER_RE, (m, k1?: string, n1?: string, k2?: string, n2?: string) => {
      const art = (k1 ?? k2 ?? '').toUpperCase().replace(/^E-?MAIL$/, 'EMAIL');
      const platzhalter = `[${art}_${n1 ?? n2}]`;
      const eintrag = this.byPlaceholder.get(platzhalter);
      if (!eintrag || !erlaubt(platzhalter)) {
        unbekannt.add(m);
        return m;
      }
      gefunden.add(platzhalter);
      return eintrag.value;
    });
    // Was danach noch wie ein Platzhalter aussieht und so nicht gesendet wurde, ist erfunden: `[KUNDE_1]`, `[NAME]`,
    // `[PERSON１]` (Review N4). `[REDACTED]` zählt eigens.
    for (const m of text.normalize('NFKC').matchAll(PLATZHALTER_FORM_RE)) {
      if (!/^\[REDACTED\]$/i.test(m[0]) && !gesendet.includes(m[0])) unbekannt.add(m[0]);
    }
    const fehlend = [...imText].filter((p) => !gefunden.has(p)).map((p) => this.byPlaceholder.get(p)!).filter(Boolean);
    const geschwaerzt = (antwort.match(REDACTED_RE) ?? []).length;
    return { text, unbekannt: [...unbekannt], fehlend, geschwaerzt };
  }

  /** Für die Vorschau und den Test, nie für den Ausgang. */
  replacements(): PseudonymReplacement[] {
    return [...this.byPlaceholder.values()];
  }

  replacementOf(placeholder: string): PseudonymReplacement | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  /** Lässt sich dieser Treffer aufdecken? Nicht in einer Pflichtklasse und nicht, wenn er aus der Schutzliste kommt. */
  aufdeckbar(r: PseudonymReplacement): boolean {
    return !PFLICHTKLASSEN.has(KLASSE_JE_ART[r.kind]) && !this.fest.has(schluessel(r.value));
  }

  counts(): Partial<Record<PseudonymKind, number>> {
    return Object.fromEntries(this.counters);
  }

  /** Welche aufgedeckten Werte gewirkt haben, und welche nicht, weil sie zu einer Pflichtklasse gehören. */
  aufdeckBefund(): { aufgedeckt: string[]; nichtAufdeckbar: string[] } {
    return { aufgedeckt: [...this.aufgedecktGenutzt], nichtAufdeckbar: [...this.nichtAufdeckbar] };
  }
}

// ── Restprüfung: eigene, breitere Muster, nicht die der Erkennung ───────────────────────────────────────────────────

export interface RestFund {
  klasse: Schutzklasse;
  art: 'IBAN' | 'KARTE' | 'BIC' | 'EMAIL' | 'TELEFON';
  anzahl: number;
}

const REST_MAIL_RE = /[\p{L}\p{N}._%+-]@[^\s]|[\p{L}\p{N}._%+-][ \t]?(?:\(at\)|\[at\]|\{at\})[ \t]?[\p{L}\p{N}]/giu;
const REST_TELEFON_RE = /(?:\+|(?<![\p{N}])00)\d[\d \t/().-]{6,}\d|(?<![\p{N}])0\d{1,4}[ \t/()-]{1,2}\d[\d \t/()-]{2,}\d/gu;
const REST_TELEFON_KENNWORT_RE = new RegExp(`${TELEFON_KENNWORT}[ \\t]*[:.]?[ \\t]*(?:unter[ \\t]+)?(?:\\+|00)?\\d[\\d \\t/().-]{4,}\\d`, 'gu');
const REST_DURCHWAHL_RE = /(?:Durchwahl|DW|Klappe|Nebenstelle)[ \t]*[:.]?[ \t]*-?\d{2,6}(?![\p{N}])/gu;
const REST_BIC_RE = /\b(?:BIC|SWIFT)\b[^\n]{0,12}?\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g;

/**
 * Prüft den fertigen Text vor dem Senden auf die Pflichtklassen. Steht davon etwas, geht nichts hinaus (wie im
 * Mail-Agent bei der Mailadresse). Meldet Klasse und Anzahl, nie den Wert.
 *
 * Geprüft wird eine **Schattenkopie**: NFKC (Vollbreite, Ligaturen), ohne Formatzeichen, `%40`/`%2B` dekodiert, jeder
 * Leerraum ein Leerzeichen. So fällt auch auf, was die Erkennung durch Schreibweise verpasst (Review H3: U+200C vor dem @,
 * IBAN über einen Zeilenumbruch). Die Muster für Mail und Telefon sind breiter als die der Erkennung. IBAN und Karte
 * prüft sie wie die Erkennung ab jedem Anfang und in jedem Fenster; unabhängig ist dort nur die Schattenkopie.
 */
export function restpruefung(roh: string): { ok: boolean; funde: RestFund[] } {
  const text = vereinheitlichen(roh.normalize('NFKC')).replace(/\s+/g, ' ');
  const funde: RestFund[] = [];
  const zaehle = (art: RestFund['art'], klasse: Schutzklasse, n: number) => {
    if (n > 0) funde.push({ klasse, art, anzahl: n });
  };
  zaehle('EMAIL', 'MAIL', (text.match(REST_MAIL_RE) ?? []).length);
  zaehle('IBAN', 'BANK', ibanStellen(text).length);
  zaehle('KARTE', 'BANK', kartenStellen(text).length);
  zaehle('BIC', 'BANK', (text.match(REST_BIC_RE) ?? []).length);
  zaehle(
    'TELEFON',
    'TELEFON',
    (text.match(REST_TELEFON_RE) ?? []).filter((m) => !DATE_LIKE.test(m.trim()) && m.replace(/\D/g, '').length >= 8).length +
      (text.match(REST_TELEFON_KENNWORT_RE) ?? []).filter((m) => m.replace(/\D/g, '').length >= 6).length +
      (text.match(REST_DURCHWAHL_RE) ?? []).length +
      [...text.matchAll(ZIFFERNGRUPPEN_RE)].filter(
        (m) => m[0].replace(/\D/g, '').length >= 9 && !DATE_LIKE.test(m[0]) && KONTAKT_KONTEXT_RE.test(satzUm(text, m.index!, m.index! + m[0].length)),
      ).length,
  );
  return { ok: funde.length === 0, funde };
}
