/**
 * Misst, ob der DeepL-`context` den Vorschlag für einen Namensbaustein ändert (Bauplan Bausteine Phase 2 §8, Cockpit #1767).
 *
 * Je Fall vier Aufrufe von `holeDeeplVorschlag`, also derselbe Weg wie in `POST /api/namens-bausteine/unbekannt`, ohne Glossar:
 * ohne Kontext, mit Kontext, dann beides noch einmal. Die Wiederholung ist der Kontrolllauf: DeepL liefert schon bei gleicher
 * Eingabe nicht immer denselben Wortlaut (bei Artikelnamen mit Glossar in 20 % der Namen), und ein Unterschied zwischen „mit“ und
 * „ohne“ zählt erst, wenn er größer ist als der zwischen zwei gleichen Aufrufen. Die Reihenfolge ist verschränkt, damit eine
 * Änderung bei DeepL während des Laufs nicht nur eine Seite trifft.
 *
 * Die Fälle wählt `scripts/namens-kontext-faelle.mjs` nach einer festen Regel. Bewertet wird gegen zwei Texte je Fall: den alten
 * Glossarfehler (`falsch`) und den Vorschlag der Glossarprüfung (`richtig`). Alles andere heißt `anders` und steht wörtlich in der
 * Ergebnisdatei, zum Ansehen statt zum Zählen.
 *
 * Liegt unter `src/`, weil der Deploy nur `dist/` überträgt. Am Server, nach dem Deploy:
 *
 *   cd /opt/translationtool && node dist/scripts/namens-kontext-messung.js --faelle <faelle.tsv> --aus <ordner>
 *   node dist/scripts/namens-kontext-messung.js --bericht <ordner>/kontext-<datum>.json   (nur neu auswerten, ohne DeepL)
 *
 * Kosten: die Zeichen der Begriffe, viermal; der Kontext wird nicht berechnet. Das Skript liest den Zählerstand vorher und nachher
 * und schreibt beides in die Ergebnisdatei. Geschrieben wird nur die Ergebnisdatei, nichts in die Datenbank.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db/connection';
import { config } from '../config';
import { getDeepLUsage } from '../services/deepl';
import { holeDeeplVorschlag, type VorschlagErgebnis } from '../services/glossar-pflege';

export interface KontextFall {
  sprache: string;
  begriff: string;
  falsch: string;
  richtig: string;
  kontext: string;
  artikelnummer: string;
  namen: number;
  wahl: string;
}

export type Lesart = 'falsch' | 'richtig' | 'anders' | 'kein_vorschlag';
export interface Antwort {
  text: string | null;
  status: VorschlagErgebnis['status'];
  lesart: Lesart;
}
export interface FallErgebnis {
  fall: KontextFall;
  ohne: [Antwort, Antwort];
  mit: [Antwort, Antwort];
}

type Hole = (p: Parameters<typeof holeDeeplVorschlag>[0]) => Promise<VorschlagErgebnis>;

const SPALTEN = ['sprache', 'begriff', 'falsch', 'richtig', 'kontext', 'artikelnummer', 'namen', 'wahl'] as const;

export function leseFaelle(tsv: string): KontextFall[] {
  const [kopf, ...zeilen] = tsv.split(/\r?\n/).filter((z) => z.trim() !== '');
  if (kopf?.split('\t').join('|') !== SPALTEN.join('|')) throw new Error(`Kopfzeile muss ${SPALTEN.join(', ')} sein`);
  return zeilen.map((z, i) => {
    const f = z.split('\t');
    if (f.length !== SPALTEN.length) throw new Error(`Zeile ${i + 2}: ${f.length} statt ${SPALTEN.length} Spalten`);
    const [sprache, begriff, falsch, richtig, kontext, artikelnummer, namen, wahl] = f;
    if (!sprache || !begriff || !falsch || !richtig || !kontext) throw new Error(`Zeile ${i + 2}: ein Pflichtfeld ist leer`);
    return { sprache, begriff, falsch, richtig, kontext, artikelnummer, namen: Number(namen), wahl };
  });
}

/** Für den Vergleich: klein, ohne Rand aus Leerzeichen, Satzzeichen und Anführungszeichen. */
export const normal = (t: string): string => t.toLocaleLowerCase('de').trim().replace(/^[\s"'„“«»,.;:]+|[\s"'„“«»,.;:]+$/gu, '');

export function lies(e: VorschlagErgebnis, fall: KontextFall): Antwort {
  if (e.status !== 'ok') return { text: null, status: e.status, lesart: 'kein_vorschlag' };
  const n = normal(e.vorschlag);
  const lesart: Lesart = n === normal(fall.falsch) ? 'falsch' : n === normal(fall.richtig) ? 'richtig' : 'anders';
  return { text: e.vorschlag, status: e.status, lesart };
}

/** Misst alle Fälle. `hole` ist im Betrieb `holeDeeplVorschlag`; der Test setzt eine Attrappe ein. */
export async function messe(faelle: KontextFall[], hole: Hole = holeDeeplVorschlag): Promise<FallErgebnis[]> {
  const aus: FallErgebnis[] = [];
  for (const fall of faelle) {
    const frage = (kontext: string | null) =>
      hole({ begriff: fall.begriff, sourceLang: 'DE', targetLang: fall.sprache, deeplGlossaryId: null, kontext }).then((e) => lies(e, fall));
    const ohne1 = await frage(null);
    const mit1 = await frage(fall.kontext);
    const ohne2 = await frage(null);
    const mit2 = await frage(fall.kontext);
    aus.push({ fall, ohne: [ohne1, ohne2], mit: [mit1, mit2] });
  }
  return aus;
}

export interface Zusammenfassung {
  faelle: number;
  ohne: Record<Lesart, number>;
  mit: Record<Lesart, number>;
  /** Je Seite: beide Läufe gleich. Erst wenn das gilt, ist ein Unterschied zwischen den Seiten ein Befund. */
  stabil: { ohne: number; mit: number; beide: number };
  /** Nur Fälle, die auf beiden Seiten stabil sind. */
  geaendert: number;
  behoben: number;
  verschlechtert: number;
  /** Ohne Kontext der alte Fehler, mit Kontext nicht mehr. Zählt auch, wenn der neue Text weder Fehler noch Prüfvorschlag ist. */
  vomFehlerWeg: number;
  /**
   * Mit Kontext der alte Fehler, ohne nicht. `verschlechtert` sieht das nicht, wenn der Text ohne Kontext weder Fehler noch
   * Prüfvorschlag war (09.11.2026: `rückversetzt` EN, ohne „set back“, mit „recessed“).
   */
  zumFehlerHin: number;
}

const nullen = (): Record<Lesart, number> => ({ falsch: 0, richtig: 0, anders: 0, kein_vorschlag: 0 });

export function fasseZusammen(e: FallErgebnis[]): Zusammenfassung {
  const z: Zusammenfassung = {
    faelle: e.length, ohne: nullen(), mit: nullen(), stabil: { ohne: 0, mit: 0, beide: 0 },
    geaendert: 0, behoben: 0, verschlechtert: 0, vomFehlerWeg: 0, zumFehlerHin: 0,
  };
  for (const r of e) {
    // Gezählt wird der erste Lauf; der zweite ist nur Kontrolle.
    z.ohne[r.ohne[0].lesart] += 1;
    z.mit[r.mit[0].lesart] += 1;
    const so = r.ohne[0].text === r.ohne[1].text;
    const sm = r.mit[0].text === r.mit[1].text;
    if (so) z.stabil.ohne += 1;
    if (sm) z.stabil.mit += 1;
    if (!(so && sm)) continue;
    z.stabil.beide += 1;
    if (r.ohne[0].text !== r.mit[0].text) z.geaendert += 1;
    if (r.ohne[0].lesart !== 'richtig' && r.mit[0].lesart === 'richtig') z.behoben += 1;
    if (r.ohne[0].lesart === 'richtig' && r.mit[0].lesart !== 'richtig') z.verschlechtert += 1;
    if (r.ohne[0].lesart === 'falsch' && r.mit[0].lesart !== 'falsch') z.vomFehlerWeg += 1;
    if (r.ohne[0].lesart !== 'falsch' && r.mit[0].lesart === 'falsch') z.zumFehlerHin += 1;
  }
  return z;
}

const ADRESSE = /https?:\/\/|w{3}\./iu;
const zelle = (t: string | null): string => (t === null ? '–' : ADRESSE.test(t) ? '[Text mit Adresse ausgelassen]' : t.replace(/\|/gu, '\\|'));
const antwortZelle = (a: Antwort): string => (a.text === null ? `– (${a.status})` : `${zelle(a.text)} · ${a.lesart}`);

export function alsMarkdown(e: FallErgebnis[], z: Zusammenfassung, k: { datum: string; vorher: number | null; nachher: number | null; faelleDatei: string }): string {
  const verbrauch = k.vorher !== null && k.nachher !== null ? `${(k.nachher - k.vorher).toLocaleString('de-AT')} Zeichen` : 'nicht gemessen';
  const zeile = (l: Lesart) => `| ${l} | ${z.ohne[l]} | ${z.mit[l]} |`;
  const teile = [
    `# DeepL-Kontext für Namensbausteine, Messung ${k.datum}`,
    '',
    `Erzeugt von \`dist/scripts/namens-kontext-messung.js\` (Translationtool), Fälle aus \`${k.faelleDatei}\`. Weg: \`holeDeeplVorschlag\` ohne Glossar,`,
    'wie in `POST /api/namens-bausteine/unbekannt`. Je Fall ohne Kontext, mit Kontext, dann beides noch einmal als Kontrolle.',
    `Verbrauch laut Zähler: ${verbrauch} (ein gleichzeitiger anderer Lauf zählte mit).`,
    '',
    '## Ergebnis',
    '',
    `${z.faelle} Fälle. Gezählt ist der erste Lauf, „falsch“ heißt der alte Glossarfehler, „richtig“ der Vorschlag der Glossarprüfung.`,
    '',
    '| Lesart | ohne Kontext | mit Kontext |',
    '|---|---:|---:|',
    zeile('falsch'),
    zeile('richtig'),
    zeile('anders'),
    zeile('kein_vorschlag'),
    '',
    `Kontrolllauf: ohne Kontext ${z.stabil.ohne} von ${z.faelle} gleich, mit Kontext ${z.stabil.mit} von ${z.faelle}; auf beiden Seiten stabil ${z.stabil.beide}.`,
    `Unter den stabilen ändert der Kontext den Vorschlag in ${z.geaendert} Fällen, ${z.behoben} davon zum Vorschlag der Prüfung hin, ${z.verschlechtert} von ihm weg.`,
    `Vom alten Fehler weg: ${z.vomFehlerWeg}, zum alten Fehler hin: ${z.zumFehlerHin}. „anders“ ist nicht bewertet; ob es dieselbe Bedeutung in anderer Form ist, sagt nur ein Leser.`,
    '',
    '## Je Fall',
    '',
    '| Sprache | Begriff | alt falsch | Prüfung | ohne Kontext (1 / 2) | mit Kontext (1 / 2) | Kontext |',
    '|---|---|---|---|---|---|---|',
    ...e.map((r) => `| ${r.fall.sprache} | ${zelle(r.fall.begriff)} | ${zelle(r.fall.falsch)} | ${zelle(r.fall.richtig)} | ${antwortZelle(r.ohne[0])} / ${antwortZelle(r.ohne[1])} | ${antwortZelle(r.mit[0])} / ${antwortZelle(r.mit[1])} | ${zelle(r.fall.kontext)} |`),
    '',
  ];
  return teile.join('\n');
}

function zeitstempel(): string {
  const t = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
  return t.replace(' ', '-').replace(':', '');
}

/**
 * Schreibt Bericht und Zusammenfassung aus einer gespeicherten Messung neu, ohne DeepL zu fragen: Ändert sich die Auswertung,
 * bleiben die Antworten dieselben. Die Antworten selbst fasst das nicht an.
 */
export function berichtNeu(jsonDatei: string): string {
  const alt = JSON.parse(readFileSync(jsonDatei, 'utf-8')) as {
    datum: string; vorher: number | null; nachher: number | null; faelleDatei?: string; ergebnis: FallErgebnis[];
  };
  if (!Array.isArray(alt.ergebnis) || alt.ergebnis.length === 0) throw new Error(`${jsonDatei} enthält keine Messung`);
  const z = fasseZusammen(alt.ergebnis);
  const faelleDatei = alt.faelleDatei ?? 'faelle.tsv';
  const basis = jsonDatei.replace(/\.json$/u, '');
  writeFileSync(`${basis}.md`, alsMarkdown(alt.ergebnis, z, { datum: alt.datum, vorher: alt.vorher, nachher: alt.nachher, faelleDatei }));
  writeFileSync(jsonDatei, JSON.stringify({ ...alt, faelleDatei, zusammenfassung: z }, null, 2));
  return `${basis}.md`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wert = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const neu = wert('--bericht');
  if (neu) {
    console.log(`Bericht neu geschrieben: ${berichtNeu(neu)}`);
    return;
  }
  const faelleDatei = wert('--faelle');
  const ordner = wert('--aus');
  if (!faelleDatei || !ordner) {
    console.error('Aufruf: node dist/scripts/namens-kontext-messung.js --faelle <faelle.tsv> --aus <ordner> | --bericht <messung.json>');
    process.exit(2);
  }
  if (!config.deepl.apiKey) throw new Error('DEEPL_API_KEY ist nicht gesetzt');
  const faelle = leseFaelle(readFileSync(faelleDatei, 'utf-8'));
  if (faelle.length === 0) throw new Error('keine Fälle');
  const vorher = (await getDeepLUsage()).characterCount;
  const ergebnis = await messe(faelle);
  const nachher = (await getDeepLUsage()).characterCount;
  const z = fasseZusammen(ergebnis);
  const datum = zeitstempel();
  mkdirSync(ordner, { recursive: true });
  const basis = join(ordner, `kontext-${datum}`);
  const faelleName = faelleDatei.split(/[\\/]/).pop() ?? faelleDatei;
  writeFileSync(`${basis}.md`, alsMarkdown(ergebnis, z, { datum, vorher, nachher, faelleDatei: faelleName }));
  writeFileSync(`${basis}.json`, JSON.stringify({ datum, vorher, nachher, faelleDatei: faelleName, zusammenfassung: z, ergebnis }, null, 2));
  console.log(`${faelle.length} Fälle, ${nachher - vorher} Zeichen → ${basis}.md`);
  console.log(`ohne Kontext: ${JSON.stringify(z.ohne)}  mit Kontext: ${JSON.stringify(z.mit)}`);
  console.log(`stabil ohne ${z.stabil.ohne}, mit ${z.stabil.mit}, beide ${z.stabil.beide}; geändert ${z.geaendert}, behoben ${z.behoben}, verschlechtert ${z.verschlechtert}; vom Fehler weg ${z.vomFehlerWeg}, zum Fehler hin ${z.zumFehlerHin}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
