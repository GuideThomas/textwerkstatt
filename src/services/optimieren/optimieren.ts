/**
 * Schritt „Optimieren“ der Textwerkstatt (Phase 4, Plan `PLAN-textwerkstatt.md` §2 und §4 Phase 4, Cockpit #1840).
 *
 *   lokal  Der Klartext aus dem Browser geht an den lokalen Weg (Station). Der Aufruf verlangt `erwarteteArt: 'lokal'`: Wird
 *          derselbe Weg beim Aufruf anders geladen, geht nichts hinaus (Review N1).
 *   cloud  Es geht NUR der am Server gespeicherte Pseudonym-Text einer Vorschau hinaus (`pseudonymSenden`, G3). Ein Text im
 *          Anfragekörper wird für die Cloud nie gelesen. Geprüft wird gegen den Klartext dieser Vorschau.
 *
 * Danach die harte Prüfung (`pruefung.ts`, G1) und je Lauf eine Zeile ohne Text (`textwerkstatt_laeufe`) sowie die Kosten in
 * `token_usage` (Zweck `textwerkstatt`), auch für einen Aufruf, dessen Antwort danach verworfen wurde (Review M8). Kein
 * Ausweichen auf einen anderen Weg (G2): Fehler kommen als Fehler zurück.
 *
 * Was in die Anweisung geht, kommt aus der Tabelle der Arten und aus einem Rahmen hier im Code, der keine Werte einer
 * Installation enthält (G5). Hausbegriffe gehen als Hinweis mit, beim Cloud-Weg nur, wenn sie im ausgehenden Text stehen und
 * keine Hälfte ein verdeckter Wert ist; die Schranke dahinter sitzt in `pseudonymSenden` (Review H1).
 *
 * Phase 5 (Cockpit #1841): Ein Stilprofil geht als weiterer Teil der Anweisung mit (`stilprofile.ts`). Es zählt zu den
 * veränderlichen Teilen, und für die Cloud darf es keine erkennbare Angabe tragen (`STIL_MIT_WERTEN`, Plan §5 R6). Gehört das
 * Profil zu einem Channel, muss der Lauf diesen Channel nehmen. Mit Profil und Channel läuft nach der Prüfung die
 * Channel-Fassung über das Ergebnis (`channel-fassung.ts`, `rewriteMany`), damit die Begriffe des Channels stimmen, und danach
 * die Prüfung noch einmal über den Endstand; ohne Profil bleibt der Lauf wie in Phase 4 (Review N8). Lokal schreibt dieselbe
 * Station um, über denselben Weg; in der Cloud geht dafür nichts ein zweites Mal hinaus: Dort wird nach Regel ersetzt und als
 * Hinweis gekennzeichnet (Artikel und Endungen ansehen). Geschützte Werte sind dabei gesperrt (Review M3), und was die
 * Umschreibung verwirft, fällt auf den Ersatz nach Regel und zuletzt auf den geprüften Stand davor zurück (Review N7).
 * In die Cloud geht ein Profil nur in der Fassung, die ein Admin freigegeben hat (`STIL_NICHT_FREIGEGEBEN`, Review M4).
 */
import { KiAbhaengigkeiten, KiArt, KiVerbrauch, KiWegFehler, WEG_ID_MUSTER, kiAufrufen } from '../ki-weg';
import { GRENZEN, PseudonymFehler, SchutzEinstellungen, pseudonymSenden, vorschauLesen } from '../pseudonym/vorschau';
import { KLASSE_JE_ART, PseudonymSession, PseudonymizationError, Schutzklasse, enthaeltPlatzhalter, vereinheitlichen } from '../pseudonym/pseudonymize';
import {
  placeholders as markupFolgen, rewriteMany, SYSTEM_PROMPT as CHANNEL_SYSTEM, userPrompt as channelAnfrage, stripFence,
  type Herkunft, type Treffer, type Umschreiber,
} from '../channel-fassung';
import type { HouseTerm } from '../house-terms';
import {
  Absatz, Befund, OptimierArt, absaetzeAusrichten, antwortSaeubern, pruefen, relevanteBegriffe,
} from './pruefung';
import type { Wert } from './werte';
import { STIL_GRENZEN, STIL_ID_MUSTER, StilProfil, cloudFreigegeben, stilAnweisung, stilCloudBefund, stilVeraenderlich } from './stilprofile';

export type OptimierFehlerCode =
  | 'EINGABE' | 'ART_UNBEKANNT' | 'ART_INAKTIV' | 'VORSCHAU_FEHLT' | 'TEXT_FEHLT' | 'HAUSSCHREIBWEISE' | 'SCHUTZREGELN'
  | 'STIL_UNBEKANNT' | 'STIL_INAKTIV' | 'STIL_CHANNEL' | 'STIL_MIT_WERTEN' | 'STIL_NICHT_FREIGEGEBEN' | 'STIL_VERALTET';

const HTTP_JE_CODE: Record<OptimierFehlerCode, number> = {
  EINGABE: 400,
  ART_UNBEKANNT: 404,
  ART_INAKTIV: 409,
  VORSCHAU_FEHLT: 400,
  TEXT_FEHLT: 400,
  HAUSSCHREIBWEISE: 503,
  SCHUTZREGELN: 503,
  STIL_UNBEKANNT: 404,
  STIL_INAKTIV: 409,
  STIL_CHANNEL: 409,
  STIL_MIT_WERTEN: 422,
  STIL_NICHT_FREIGEGEBEN: 409,
  STIL_VERALTET: 409,
};

/** Was die Channel-Fassung über dem Ergebnis tat. `offen`: Sie hätte das Ergebnis verworfen; es bleibt der Stand davor. */
export type ChannelSchritt = Herkunft | 'offen';

export class OptimierFehler extends Error {
  readonly http: number;
  constructor(readonly code: OptimierFehlerCode, message: string) {
    super(message);
    this.name = 'OptimierFehler';
    this.http = HTTP_JE_CODE[code];
  }
}

export const ART_ID_MUSTER = /^[a-z][a-z0-9-]{0,31}$/;
const CHANNEL_MUSTER = /^[A-Za-z0-9_-]{1,40}$/;
export const ZIELZEICHEN = { min: 20, max: GRENZEN.zeichen } as const;

/**
 * Klassen, deren Werte lokal im Ergebnis wieder stehen müssen und je Absatz verglichen werden. Preise, Artikel- und
 * Belegnummern prüft die Zahlenprüfung; ihr Wortlaut („42 % auf Liste“) darf sich ändern.
 */
const WERT_KLASSEN: ReadonlySet<Schutzklasse> = new Set(['PERSON', 'FIRMA', 'PROJEKT', 'MAIL', 'TELEFON', 'BANK', 'URL', 'ANSCHRIFT', 'EIGEN']);

export interface LaufZeile {
  nutzerId: string;
  wegId: string;
  wegArt: KiArt | null;
  modell: string | null;
  artId: string;
  zeichenEin: number;
  zeichenAus: number | null;
  platzhalter: Record<string, number> | null;
  maskenVerdeckt: number | null;
  maskenAufgedeckt: number | null;
  ergebnis: 'ok' | 'hinweis' | 'verworfen' | 'fehler';
  pruefgruende: string[];
  fehlerCode: string | null;
  dauerMs: number | null;
  eingabeToken: number | null;
  ausgabeToken: number | null;
  denkToken: number | null;
  kostenUsd: number | null;
  /** Phase 5: Profil und Fassung, mit denen optimiert wurde; Channel des Laufs und was die Channel-Fassung danach tat. */
  stilprofilId: string | null;
  stilprofilFassung: number | null;
  channelCode: string | null;
  channelSchritt: ChannelSchritt | null;
}

export interface OptimierAbhaengigkeiten {
  ki: KiAbhaengigkeiten;
  artLaden(id: string): Promise<OptimierArt | null>;
  begriffeLaden(channelCode: string | null): Promise<HouseTerm[]>;
  /** Schutzregeln (Schutzliste, Muster der Artikelnummer): lokal für die Werteprüfung. */
  schutzLaden(): Promise<SchutzEinstellungen>;
  laufMerken(z: LaufZeile): Promise<void>;
  verbrauchMerken(modell: string, eingabe: number, ausgabe: number, kosten: number | null, dauerMs: number): Promise<void>;
  /** Phase 5. Fehlt er, gibt es keine Stilprofile (jede Kennung ist unbekannt). */
  stilLaden?(id: string): Promise<StilProfil | null>;
  /** Für die Gültigkeit der Vorschau; nur Prüfskripte setzen ihn. */
  jetzt?: () => number;
}

export interface OptimierEingabe {
  nutzerId: string;
  artId: unknown;
  wegId: unknown;
  /** Nur für den lokalen Weg. */
  text?: unknown;
  /** Nur für den Cloud-Weg. */
  vorschauId?: unknown;
  zielzeichen?: unknown;
  channelCode?: unknown;
  /** Phase 5, optional. */
  stilprofilId?: unknown;
  /**
   * Die Fassung, die die Seite angezeigt hat. Weicht sie ab, ist das Profil seit dem Laden geändert worden: Dann geht nichts
   * hinaus, sonst sähe der Nutzer einen anderen Profiltext als den gesendeten (Nachprüfung, Hinweis).
   */
  stilprofilFassung?: unknown;
}

export interface OptimierErgebnis {
  /** Das geprüfte Ergebnis im Klartext. */
  text: string;
  /** Der Klartext, gegen den geprüft wurde. Weicht der Text im Browser davon ab, ist das Ergebnis veraltet. */
  original: string;
  art: { id: string; name: string };
  weg: { id: string; art: KiArt; modell: string };
  befund: Befund;
  /** Paare je Absatz, wenn Original und Ergebnis gleich viele haben; sonst `null` (nur ganz übernehmen). */
  absaetze: Absatz[] | null;
  /** Cloud: Platzhalter, die in der Antwort fehlen, mit dem Wert, für den sie stehen. */
  fehlend: { platzhalter: string; klasse: string; wert: string }[];
  /** Die Zielzahl, mit der geprüft wurde; die Prüfung einer Auswahl von Absätzen nimmt dieselbe. */
  zielzeichen: number | null;
  /** Summe über alle Aufrufe dieses Laufs (Optimieren und, lokal, die Channel-Fassung). */
  ki: { dauerMs: number; eingabeToken: number; ausgabeToken: number; denkToken: number | null; kostenUsd: number | null };
  stil: { id: string; name: string; fassung: number } | null;
  /** Mit Channel: was die Channel-Fassung über dem Ergebnis tat. `regel` heißt: nach Regel ersetzt, Artikel und Endungen ansehen. */
  channel: { code: string; herkunft: ChannelSchritt; treffer: Treffer[] } | null;
}

/**
 * Die Teile der Anweisung, die aus Daten kommen (Art, Hausbegriffe, Zielzahl). Nur sie kann ein verdeckter Wert erreichen; die
 * Schranke in `pseudonymSenden` prüft genau sie.
 */
export function veraenderlicheTeile(
  art: OptimierArt,
  o: { zielzeichen: number | null; begriffe: HouseTerm[]; stil?: Pick<StilProfil, 'beschreibung' | 'beispiele'> | null },
): string {
  return [
    art.anweisung,
    o.stil ? stilVeraenderlich(o.stil) : '',
    ...o.begriffe.flatMap((b) => [b.preferredTerm, b.avoidTerm]),
    o.zielzeichen ? String(o.zielzeichen) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Den Rahmen setzt der Code, die Anweisung die Art. Keine Werte einer Installation. */
export function systemBauen(
  art: OptimierArt,
  o: { zielzeichen: number | null; markup: boolean; begriffe: HouseTerm[]; stil?: Pick<StilProfil, 'beschreibung' | 'beispiele'> | null },
): string {
  const z = ['Du überarbeitest einen deutschen Text nach dieser Anweisung:', art.anweisung.trim(), ''];
  if (o.stil) z.push(stilAnweisung(o.stil), '');
  z.push('Dabei gilt immer:');
  z.push(art.zahlen === 'alle'
    ? '- Jede Zahl mit ihrer Einheit und jede Produkt- oder Typbezeichnung bleibt genau so stehen. Erfinde keine neuen Zahlen oder Angaben.'
    : '- Zahlen mit Einheit und Produkt- oder Typbezeichnungen, die du behältst, bleiben genau so stehen. Weglassen darfst du sie, ändern nicht. Erfinde keine neuen Zahlen oder Angaben.');
  if (!art.umstellen_erlaubt) z.push('- Die Reihenfolge der Angaben bleibt.');
  if (art.anrede === 'beibehalten') z.push('- Die Anrede bleibt: Wer gesiezt wird, wird weiter gesiezt; wer geduzt wird, weiter geduzt.');
  z.push('- Namen von Personen, Firmen und Projekten bleiben stehen.');
  if (o.markup) z.push('- Zeichenfolgen wie <b>, </p>, <x id="1"/>, {{…}} oder __NAME__ bleiben genau so und in derselben Reihenfolge stehen.');
  for (const b of o.begriffe) z.push(`- Schreibe „${b.preferredTerm.trim()}“, nie „${b.avoidTerm.trim()}“.`);
  if (o.zielzeichen) z.push(`- Das Ergebnis hat höchstens ${o.zielzeichen} Zeichen.`);
  z.push('- Die Gliederung in Absätze bleibt erhalten.');
  z.push('- Antworte nur mit dem überarbeiteten Text: ohne Einleitung, ohne Erklärung, ohne Anführungszeichen, ohne Markdown.');
  return z.join('\n');
}

/**
 * Obergrenze der Antwort: das Längenband der Art über den Text, rund 2,5 Zeichen je Token, dazu Luft für das Denken.
 * Gemessen 11.11.2026: Beim Kürzen in der Cloud kamen 2 von 10 Antworten leer zurück, bei bis zu 308 Denk-Token und einer
 * Grenze von 414 (Review M7). Bezahlt wird nur, was das Modell wirklich erzeugt; die Luft kostet nichts.
 */
export function maxTokensFuer(zeichen: number, art: OptimierArt): number {
  return Math.min(12_000, Math.ceil((zeichen * art.laenge_max) / 2.5) + 1500);
}

/** Werte eines Klartexts mit den Schutzregeln der Installation erkennen, ohne etwas zu senden. */
function werteErkennen(text: string, einst: SchutzEinstellungen): Wert[] {
  try {
    const s = new PseudonymSession({ schutzliste: einst.liste, artikelnummer: einst.artikelnummer });
    s.text(text);
    return s.replacements().map((r) => ({ wert: r.value, klasse: KLASSE_JE_ART[r.kind] })).filter((w) => WERT_KLASSEN.has(w.klasse as Schutzklasse));
  } catch (err) {
    if (err instanceof PseudonymizationError) throw new OptimierFehler('EINGABE', err.message);
    throw err;
  }
}

async function schutzLesen(d: Pick<OptimierAbhaengigkeiten, 'schutzLaden'>): Promise<SchutzEinstellungen> {
  try {
    return await d.schutzLaden();
  } catch {
    console.warn('[Textwerkstatt] Schutzregeln nicht lesbar, keine Prüfung');
    throw new OptimierFehler('SCHUTZREGELN', 'Die Schutzregeln sind gerade nicht lesbar; ohne sie wird nicht optimiert');
  }
}

async function begriffeLesen(d: Pick<OptimierAbhaengigkeiten, 'begriffeLaden'>, channel: string | null): Promise<HouseTerm[]> {
  try {
    return await d.begriffeLaden(channel);
  } catch {
    console.warn('[Textwerkstatt] Hausschreibweise nicht lesbar, keine Prüfung');
    throw new OptimierFehler('HAUSSCHREIBWEISE', 'Die Hausschreibweise ist gerade nicht lesbar; ohne sie wird nicht optimiert');
  }
}

export interface KombinationEingabe {
  artId: unknown;
  original: unknown;
  text: unknown;
  channelCode?: unknown;
  zielzeichen?: unknown;
}

/**
 * Prüft eine aus Original und Ergebnis zusammengesetzte Fassung (Übernahme einzelner Absätze), bevor sie in den Text geht —
 * ohne Aufruf eines Modells. Die Prüfung je Absatz kann eine Summe über mehrere Absätze nicht absichern: Ein Absatz um
 * einen erfundenen Satz länger, ein anderer kürzer, und das Ganze lag im Band; nur Absatz 1 übernommen lag es nicht mehr
 * (Review M9-Rest). Beide Texte kommen vom Browser; geprüft wird nur, gesendet wird nichts.
 */
export async function kombinationPruefen(
  e: KombinationEingabe,
  d: Pick<OptimierAbhaengigkeiten, 'artLaden' | 'begriffeLaden' | 'schutzLaden'>,
): Promise<Befund> {
  if (typeof e.artId !== 'string' || !ART_ID_MUSTER.test(e.artId)) throw new OptimierFehler('EINGABE', 'Art: eine Kennung');
  for (const [name, t] of [['Original', e.original], ['Text', e.text]] as const) {
    if (typeof t !== 'string' || !t.trim()) throw new OptimierFehler('TEXT_FEHLT', `${name} fehlt`);
    if (t.length > GRENZEN.zeichen) throw new OptimierFehler('EINGABE', `${name}: höchstens ${GRENZEN.zeichen} Zeichen`);
  }
  let channel: string | null = null;
  if (e.channelCode !== undefined && e.channelCode !== null && e.channelCode !== '') {
    if (typeof e.channelCode !== 'string' || !CHANNEL_MUSTER.test(e.channelCode)) throw new OptimierFehler('EINGABE', 'Channel: eine Kennung');
    channel = e.channelCode;
  }
  const art = await d.artLaden(e.artId);
  if (!art) throw new OptimierFehler('ART_UNBEKANNT', `Die Art ${e.artId} gibt es nicht`);
  const zielzeichen = zielzeichenLesen(art, e.zielzeichen);
  const original = e.original as string;
  const werte = werteErkennen(original, await schutzLesen(d));
  const begriffe = await begriffeLesen(d, channel);
  return pruefen({ original, ergebnis: e.text as string, art, begriffe, fehlend: null, werte, zielzeichen });
}

function zielzeichenLesen(art: OptimierArt, roh: unknown): number | null {
  if (!art.zielzeichen || roh === undefined || roh === null || roh === '') return null;
  const n = Number(roh);
  if (!Number.isInteger(n) || n < ZIELZEICHEN.min || n > ZIELZEICHEN.max) {
    throw new OptimierFehler('EINGABE', `Zielzahl: ${ZIELZEICHEN.min} bis ${ZIELZEICHEN.max} Zeichen`);
  }
  return n;
}

export async function optimieren(e: OptimierEingabe, d: OptimierAbhaengigkeiten): Promise<OptimierErgebnis> {
  // ── Eingaben ──
  if (typeof e.artId !== 'string' || !ART_ID_MUSTER.test(e.artId)) throw new OptimierFehler('EINGABE', 'Art: eine Kennung');
  if (typeof e.wegId !== 'string' || !WEG_ID_MUSTER.test(e.wegId)) throw new OptimierFehler('EINGABE', 'KI-Weg: eine Kennung');
  let channel: string | null = null;
  if (e.channelCode !== undefined && e.channelCode !== null && e.channelCode !== '') {
    if (typeof e.channelCode !== 'string' || !CHANNEL_MUSTER.test(e.channelCode)) throw new OptimierFehler('EINGABE', 'Channel: eine Kennung');
    channel = e.channelCode;
  }
  const art = await d.artLaden(e.artId);
  if (!art) throw new OptimierFehler('ART_UNBEKANNT', `Die Art ${e.artId} gibt es nicht`);
  if (!art.aktiv) throw new OptimierFehler('ART_INAKTIV', `Die Art ${art.name} ist ausgeschaltet`);
  const zielzeichen = zielzeichenLesen(art, e.zielzeichen);
  const stil = await stilLesen(e.stilprofilId, channel, d);
  if (stil && e.stilprofilFassung !== undefined && e.stilprofilFassung !== null && Number(e.stilprofilFassung) !== stil.fassung) {
    throw new OptimierFehler('STIL_VERALTET', 'Das Stilprofil wurde seit dem Laden der Seite geändert; bitte die Seite neu laden');
  }

  // Der Weg entscheidet, woher der Text kommt. Ob der Nutzer ihn nehmen darf, prüft `kiAufrufen` (G3).
  const weg = await d.ki.wegLaden(e.wegId);
  if (!weg) throw new KiWegFehler('WEG_UNBEKANNT', `KI-Weg ${e.wegId} gibt es nicht`, e.wegId);
  const jetzt = d.jetzt?.() ?? Date.now();

  let original: string;
  let ausgehend: string;
  /** Geschützte Werte: Cloud die verdeckten (alle Klassen), lokal die im Original erkannten. */
  let werteAlle: { wert: string; klasse: Schutzklasse }[];
  let stand: ReturnType<typeof vorschauLesen> | null = null;
  if (weg.art === 'cloud') {
    if (typeof e.vorschauId !== 'string' || !e.vorschauId) {
      throw new OptimierFehler('VORSCHAU_FEHLT', 'Für die Cloud-KI zuerst die Vorschau erstellen; gesendet wird nur deren Text');
    }
    stand = vorschauLesen(e.vorschauId, e.nutzerId, jetzt);
    original = stand.original;
    ausgehend = stand.ausgehend;
    werteAlle = stand.werte;
  } else {
    if (typeof e.text !== 'string' || !e.text.trim()) throw new OptimierFehler('TEXT_FEHLT', 'Text fehlt');
    if (e.text.length > GRENZEN.zeichen) throw new OptimierFehler('EINGABE', `Text: höchstens ${GRENZEN.zeichen} Zeichen`);
    // Wie die Vorschau: Ein Platzhalter im Text ließe sich vom Ergebnis nicht unterscheiden.
    if (enthaeltPlatzhalter(vereinheitlichen(e.text))) {
      throw new OptimierFehler('EINGABE', 'Der Text enthält Platzhalter wie [PERSON_1] oder [REDACTED]; bitte entfernen');
    }
    original = e.text;
    ausgehend = e.text;
    // Lokal gibt es keine Platzhalter, die fehlen könnten. Dieselbe Erkennung wie für die Cloud findet die Werte, die nach der
    // Antwort wieder dastehen müssen; gesendet wird dabei nichts.
    werteAlle = werteErkennen(original, await schutzLesen(d)) as { wert: string; klasse: Schutzklasse }[];
  }
  const werte: Wert[] = werteAlle.filter((w) => WERT_KLASSEN.has(w.klasse));

  // Ein Profil sieht der Nutzer in der Vorschau nicht. In die Cloud geht es nur in der Fassung, die ein Admin gelesen und
  // freigegeben hat, und nur, wenn die Regeln darin keine Angabe erkennen (Plan §5 R6, Review M4). Geprüft wird hier, wo
  // gesendet wird, mit den Schutzregeln von jetzt, nicht mit denen beim Speichern.
  if (stil && weg.art === 'cloud' && !cloudFreigegeben(stil)) {
    throw new OptimierFehler('STIL_NICHT_FREIGEGEBEN', 'Diese Fassung des Stilprofils ist nicht für die Cloud freigegeben; es wurde nichts gesendet');
  }
  if (stil && weg.art === 'cloud' && !stilCloudBefund(stil, await schutzLesen(d)).ok) {
    throw new OptimierFehler(
      'STIL_MIT_WERTEN',
      'Das Stilprofil enthält Angaben (Namen, Nummern, Preise, Kontaktdaten), die die Cloud nicht im Klartext sehen darf; es wurde nichts gesendet',
    );
  }

  // Ohne Hausschreibweise keine Prüfung, also auch kein Aufruf (G4): Das Ergebnis wäre ohnehin verworfen.
  const begriffe = await begriffeLesen(d, channel);

  const hinweisBegriffe = relevanteBegriffe(ausgehend, begriffe, weg.art === 'cloud' ? werteAlle.map((w) => w.wert) : []);
  const system = systemBauen(art, { zielzeichen, markup: markupFolgen(ausgehend).length > 0, begriffe: hinweisBegriffe, stil });
  const maxTokens = maxTokensFuer(original.length, art);

  const zeile: LaufZeile = {
    nutzerId: e.nutzerId,
    wegId: weg.id,
    wegArt: weg.art,
    modell: weg.modell,
    artId: art.id,
    zeichenEin: original.length,
    zeichenAus: null,
    platzhalter: stand ? (stand.zaehler as Record<string, number>) : null,
    maskenVerdeckt: stand ? stand.verdeckt : null,
    maskenAufgedeckt: stand ? stand.aufgedeckt : null,
    ergebnis: 'fehler',
    pruefgruende: [],
    fehlerCode: null,
    dauerMs: null,
    eingabeToken: null,
    ausgabeToken: null,
    denkToken: null,
    kostenUsd: null,
    stilprofilId: stil?.id ?? null,
    stilprofilFassung: stil?.fassung ?? null,
    channelCode: channel,
    channelSchritt: null,
  };
  const verbrauchEintragen = async (v: KiVerbrauch) => {
    Object.assign(zeile, { dauerMs: v.dauerMs, eingabeToken: v.eingabeToken, ausgabeToken: v.ausgabeToken, denkToken: v.denkToken, kostenUsd: v.kostenUsd });
    await d.verbrauchMerken(v.modell, v.eingabeToken, v.ausgabeToken, v.kostenUsd, v.dauerMs)
      .catch(() => console.warn('[Textwerkstatt] Verbrauch nicht gespeichert'));
  };
  const merken = async () => {
    await d.laufMerken(zeile).catch(() => console.warn('[Textwerkstatt] Laufzeile nicht gespeichert'));
  };

  let roh: string;
  let ki: OptimierErgebnis['ki'];
  let abgeschnitten: boolean;
  let fehlend: OptimierErgebnis['fehlend'] = [];
  try {
    if (weg.art === 'cloud') {
      const s = await pseudonymSenden(
        { vorschauId: e.vorschauId, nutzerId: e.nutzerId, wegId: weg.id, system, veraenderlich: veraenderlicheTeile(art, { zielzeichen, begriffe: hinweisBegriffe, stil }), maxTokens },
        d.ki,
        jetzt,
      );
      roh = s.text;
      ki = { dauerMs: s.ki.dauerMs, eingabeToken: s.ki.eingabeToken, ausgabeToken: s.ki.ausgabeToken, denkToken: s.ki.denkToken, kostenUsd: s.ki.kostenUsd };
      abgeschnitten = s.ki.abgeschnitten;
      fehlend = s.fehlend;
    } else {
      const k = await kiAufrufen({ wegId: weg.id, nutzerId: e.nutzerId, system, text: original, maxTokens, erwarteteArt: 'lokal' }, d.ki);
      roh = k.text;
      ki = { dauerMs: k.dauerMs, eingabeToken: k.eingabeToken, ausgabeToken: k.ausgabeToken, denkToken: k.denkToken, kostenUsd: k.kostenUsd };
      abgeschnitten = k.abgeschnitten;
    }
  } catch (err) {
    zeile.fehlerCode = err instanceof KiWegFehler || err instanceof PseudonymFehler ? err.code : 'UNERWARTET';
    // Kam die Antwort und wurde danach verworfen (leer, [REDACTED], erfundener Platzhalter), hat der Aufruf trotzdem gekostet.
    const v = err instanceof KiWegFehler || err instanceof PseudonymFehler ? err.verbrauch : null;
    if (v) await verbrauchEintragen(v);
    await merken();
    throw err;
  }

  let text = antwortSaeubern(roh, original);
  const pruefenGegen = (t: string) => pruefen({
    original,
    ergebnis: t,
    art,
    begriffe,
    fehlend: weg.art === 'cloud' ? fehlend : null,
    werte: weg.art === 'cloud' ? null : werte,
    zielzeichen,
    abgeschnitten,
  });
  let befund = pruefenGegen(text);
  await verbrauchEintragen({ modell: weg.modell, ...ki });

  // ── Channel-Fassung über das Ergebnis (Phase 5) ──
  // Nur mit Stilprofil (Plan §4 Phase 5); ohne Profil bleibt der Lauf wie in Phase 4 (Review N8). Ein verworfenes Ergebnis
  // lässt sich nicht übernehmen; es umzuschreiben kostete nur.
  let channelInfo: OptimierErgebnis['channel'] = null;
  if (stil && channel && befund.ergebnis !== 'verworfen') {
    const zusaetzlich = async (v: KiVerbrauch) => {
      ki.dauerMs += v.dauerMs;
      ki.eingabeToken += v.eingabeToken;
      ki.ausgabeToken += v.ausgabeToken;
      if (v.denkToken !== null) ki.denkToken = (ki.denkToken ?? 0) + v.denkToken;
      if (v.kostenUsd !== null) ki.kostenUsd = (ki.kostenUsd ?? 0) + v.kostenUsd;
      await d.verbrauchMerken(v.modell, v.eingabeToken, v.ausgabeToken, v.kostenUsd, v.dauerMs)
        .catch(() => console.warn('[Textwerkstatt] Verbrauch nicht gespeichert'));
    };
    const umschreiber: Umschreiber = weg.art === 'lokal'
      ? async (absatz, hits) => {
        try {
          const k = await kiAufrufen({
            wegId: weg.id, nutzerId: e.nutzerId, system: CHANNEL_SYSTEM, text: channelAnfrage(absatz, hits),
            maxTokens: Math.min(12_000, Math.ceil((absatz.length * 1.6) / 2.5) + 1500), erwarteteArt: 'lokal',
          }, d.ki);
          await zusaetzlich(k);
          return k.abgeschnitten ? null : stripFence(k.text);
        } catch (err) {
          if (err instanceof KiWegFehler && err.verbrauch) await zusaetzlich(err.verbrauch);
          // Kein anderer Weg (G2): ersetzt wird dann nach Regel und gekennzeichnet.
          return null;
        }
      }
      // Cloud: Der Klartext des Ergebnisses ginge ein zweites Mal hinaus, ohne Vorschau. Nach Regel ersetzen, kennzeichnen.
      : async () => null;
    const paare = (t: Treffer[]) => [...new Set(t.map((x) => `${x.original} → ${x.ersatz}`))];
    // Geschützte Werte (in der Cloud die verdeckten, lokal die erkannten) sind für die Umschreibung gesperrt: Sonst ersetzte die
    // Regel „Lichtband“ auch in der Firma „Lichtband Profi“, und in der Cloud prüft danach nichts die Werte (Review M3).
    // In der Cloud sind das die verdeckten Werte UND alles, was die Erkennung im Original findet: Was der Nutzer aufgedeckt oder
    // eine abgeschaltete Klasse durchgelassen hat, steht im Klartext da und darf trotzdem nicht umgeschrieben werden (Nachprüfung
    // M3-Rest: „Die Lichtband Profi GmbH“ aufgedeckt wurde zu „Die LED-Streifen Profi GmbH“).
    const geschuetzt = weg.art === 'cloud'
      ? [...werteAlle.map((w) => w.wert), ...werteErkennen(original, await schutzLesen(d)).map((w) => w.wert)]
      : werteAlle.map((w) => w.wert);
    const sperre = werteSperren(text, geschuetzt);
    let schritt: ChannelSchritt;
    let treffer: Treffer[] = [];
    if (!sperre) {
      // Der Text trägt schon die Sperrmarke: lieber nicht umschreiben als einen Wert falsch zurücksetzen.
      schritt = 'offen';
      befund = mitHinweis(befund, { pruefung: 'channel', stufe: 'hinweis', code: 'CHANNEL_OFFEN' });
    } else {
      let f = await channelFassungJeAbsatz(sperre.text, begriffe, umschreiber);
      let kandidat = sperre.zurueck(f.text);
      // Der Endstand ist, was übernommen wird: Er wird geprüft, nicht der Zwischenstand.
      let b = f.herkunft === 'unverändert' ? befund : pruefenGegen(kandidat);
      // Verwirft die Prüfung die Umschreibung des Modells, gilt der Ersatz nach Regel; ein bestandenes Ergebnis geht nicht
      // verloren, weil das Modell beim Umschreiben etwas geändert hat (Review N7).
      if (b.ergebnis === 'verworfen' && f.herkunft === 'sprachmodell') {
        f = await channelFassungJeAbsatz(sperre.text, begriffe, async () => null);
        kandidat = sperre.zurueck(f.text);
        b = pruefenGegen(kandidat);
      }
      treffer = f.treffer;
      if (f.herkunft === 'unverändert') {
        schritt = 'unverändert';
      } else if (b.ergebnis === 'verworfen') {
        // Auch der Ersatz nach Regel hält nicht: Es bleibt der geprüfte Stand davor, die Begriffe sind nicht angepasst.
        schritt = 'offen';
        befund = mitHinweis(befund, { pruefung: 'channel', stufe: 'hinweis', code: 'CHANNEL_OFFEN', neu: paare(f.treffer) });
      } else {
        schritt = f.herkunft;
        text = kandidat;
        befund = f.herkunft === 'regel'
          ? mitHinweis(b, { pruefung: 'channel', stufe: 'hinweis', code: 'CHANNEL_REGEL', neu: paare(f.treffer) })
          : b;
      }
    }
    channelInfo = { code: channel, herkunft: schritt, treffer };
    Object.assign(zeile, {
      channelSchritt: schritt, dauerMs: ki.dauerMs, eingabeToken: ki.eingabeToken, ausgabeToken: ki.ausgabeToken, denkToken: ki.denkToken, kostenUsd: ki.kostenUsd,
    });
  }

  Object.assign(zeile, { zeichenAus: text.length, ergebnis: befund.ergebnis, pruefgruende: befund.gruende });
  await merken();

  return {
    text,
    original,
    art: { id: art.id, name: art.name },
    weg: { id: weg.id, art: weg.art, modell: weg.modell },
    befund,
    absaetze: absaetzeAusrichten(original, text, { art, begriffe, werte }),
    fehlend,
    zielzeichen,
    ki,
    stil: stil ? { id: stil.id, name: stil.name, fassung: stil.fassung } : null,
    channel: channelInfo,
  };
}

const SPERRMARKE = '__TWSCHUTZ';

/**
 * Ersetzt jeden geschützten Wert durch eine Marke `__TWSCHUTZ0__`, die die Channel-Fassung wie einen Platzhalter behandelt: Die
 * Regel ersetzt in ihr nichts (`findChannelHits` lässt geschützte Bereiche aus), und `checkRewrite` verwirft eine Antwort des
 * Modells, die sie verändert. Längere Werte zuerst, damit „Karl Moser“ vor „Moser“ greift. `null`, wenn der Text die Marke schon
 * enthält.
 */
export function werteSperren(text: string, werte: readonly string[]): { text: string; zurueck: (t: string) => string } | null {
  if (text.includes(SPERRMARKE)) return null;
  const liste = [...new Set(werte.filter((w) => w.trim()))].sort((a, b) => b.length - a.length);
  if (liste.length === 0) return { text, zurueck: (x) => x };
  // In EINEM Durchgang über den Text: Eine schon eingesetzte Marke wird nie noch einmal durchsucht. Bis zur Nachprüfung ersetzte
  // die Sperre Wert für Wert, und ein Wert wie „TWS“ oder „10“ traf danach die Marke selbst (Fuzz: 15.988 von 20.000 Rundläufen
  // hinterließen einen Rest, die Prüfung verwarf ihn, das Ergebnis war unnötig „offen“).
  const muster = new RegExp(liste.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const wertJeMarke: string[] = [];
  const nummer = new Map<string, number>();
  const t = text.replace(muster, (w) => {
    if (!nummer.has(w)) { nummer.set(w, wertJeMarke.length); wertJeMarke.push(w); }
    return `${SPERRMARKE}${nummer.get(w)}__`;
  });
  return { text: t, zurueck: (x) => x.replace(/__TWSCHUTZ(\d+)__/g, (ganz, n: string) => wertJeMarke[Number(n)] ?? ganz) };
}

/** Ein Punkt mehr im Befund; das Ergebnis wird mindestens „Hinweis“. */
function mitHinweis(b: Befund, p: Befund['punkte'][number]): Befund {
  return {
    ergebnis: b.ergebnis === 'verworfen' ? 'verworfen' : 'hinweis',
    punkte: [...b.punkte, p],
    gruende: p.code ? [...b.gruende, p.code] : b.gruende,
  };
}

/**
 * Die Channel-Fassung absatzweise wie `rewriteTextForChannel`: Ein Absatz ist die Einheit, in der das Modell Artikel und
 * Endungen anpasst, und die Wortprüfung von `checkRewrite` bleibt unter ihrer Grenze. Nur Absätze mit Treffer kosten einen
 * Aufruf.
 */
async function channelFassungJeAbsatz(
  text: string,
  begriffe: HouseTerm[],
  umschreiber: Umschreiber,
): Promise<{ text: string; herkunft: Herkunft; treffer: Treffer[] }> {
  const teile = text.split(/(\n+)/);
  const inhalt = teile.map((p, i) => (i % 2 === 0 && p.trim() ? i : -1)).filter((i) => i >= 0);
  const fassungen = await rewriteMany(inhalt.map((i) => teile[i]), begriffe, umschreiber);
  inhalt.forEach((ti, k) => { teile[ti] = fassungen[k].text; });
  const herkunft: Herkunft = fassungen.some((f) => f.herkunft === 'regel') ? 'regel'
    : fassungen.some((f) => f.herkunft === 'sprachmodell') ? 'sprachmodell' : 'unverändert';
  return { text: teile.join(''), herkunft, treffer: fassungen.flatMap((f) => f.treffer) };
}

/** Das gewählte Profil, geprüft: Es gibt es, es ist eingeschaltet, und sein Channel ist der des Laufs. */
async function stilLesen(roh: unknown, channel: string | null, d: Pick<OptimierAbhaengigkeiten, 'stilLaden'>): Promise<StilProfil | null> {
  if (roh === undefined || roh === null || roh === '') return null;
  if (typeof roh !== 'string' || !STIL_ID_MUSTER.test(roh)) throw new OptimierFehler('EINGABE', 'Stilprofil: eine Kennung');
  const p = d.stilLaden ? await d.stilLaden(roh) : null;
  if (!p) throw new OptimierFehler('STIL_UNBEKANNT', `Das Stilprofil ${roh} gibt es nicht`);
  if (!p.aktiv || p.beschreibung.trim().length < STIL_GRENZEN.beschreibungAktiv) {
    throw new OptimierFehler('STIL_INAKTIV', `Das Stilprofil ${p.name} ist ausgeschaltet`);
  }
  if (p.channel_code && p.channel_code !== channel) {
    throw new OptimierFehler('STIL_CHANNEL', `Das Stilprofil ${p.name} gehört zum Channel ${p.channel_code}; bitte diesen Channel wählen`);
  }
  return p;
}
