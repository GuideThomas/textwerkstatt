/**
 * Vorschau und Senden der Textwerkstatt (Phase 3, Plan `PLAN-textwerkstatt.md` §2 „Datenfluss Cloud“ und §4 Phase 3,
 * Cockpit #1839). Was die Cloud sieht, steuert der Nutzer:
 *
 *  1. `vorschauErstellen` pseudonymisiert den Text mit den Einstellungen (Schutzliste, abgeschaltete Klassen, Muster der
 *     Artikelnummer) und den Masken des Nutzers (`verdecken`, `aufdecken`). Ergebnis und Zuordnung liegen NUR im Speicher
 *     dieses Prozesses, 15 Minuten lang, an den Nutzer gebunden. Jede Änderung der Masken erzeugt eine neue Vorschau.
 *  2. `pseudonymSenden` schickt genau den gespeicherten Text der Vorschau, nie einen Text aus dem Browser (G3). Davor die
 *     Restprüfung: Steht noch ein Wert einer Pflichtklasse (Bank, Mail, Telefon) darin, geht nichts hinaus.
 *  3. Die Antwort wird zurückgesetzt, auch `[Person 1]` statt `[PERSON_1]`. Ein erfundener Platzhalter oder ein
 *     `[REDACTED]` des Proxys verwirft die Antwort mit Grund. Ein fehlender Platzhalter wird gemeldet, nicht verworfen,
 *     denn beim Kürzen kann er gewollt fehlen.
 *
 * Gespeichert wird hier nichts, kein Text und keine Zuordnung, auch nicht im Fehlerfall im Log (Plan §0 „Texte aufbewahren“).
 * Fehlen die Einstellungen (Datenbank weg), gibt es keine Vorschau statt einer mit Vorgaben (G4).
 */
import { randomUUID } from 'crypto';
import { pool } from '../../db/connection';
import {
  KLASSE_JE_ART,
  PFLICHTKLASSEN,
  PLACEHOLDER_RE,
  PSEUDONYM_HINT,
  PseudonymKind,
  PseudonymSession,
  PseudonymizationError,
  RestFund,
  SCHUTZKLASSEN,
  SchutzBegriff,
  Schutzklasse,
  enthaeltPlatzhalter,
  restpruefung,
  vereinheitlichen,
} from './pseudonymize';
import { KiAbhaengigkeiten, KiArt, KiVerbrauch, kiAufrufen, standardAbhaengigkeiten } from '../ki-weg';
import { verrateneWerte } from '../optimieren/werte';

export type PseudonymFehlerCode =
  | 'EINGABE'
  | 'VORSCHAU_UNBEKANNT'
  | 'PFLICHT_UEBRIG'
  | 'PROXY_GESCHWAERZT'
  | 'PLATZHALTER_UNBEKANNT'
  | 'ERKENNUNG'
  | 'EINSTELLUNGEN'
  | 'WERT_IN_ANWEISUNG';

const HTTP_JE_CODE: Record<PseudonymFehlerCode, number> = {
  EINGABE: 400,
  VORSCHAU_UNBEKANNT: 404,
  PFLICHT_UEBRIG: 422,
  PROXY_GESCHWAERZT: 502,
  PLATZHALTER_UNBEKANNT: 502,
  ERKENNUNG: 422,
  EINSTELLUNGEN: 503,
  WERT_IN_ANWEISUNG: 422,
};

export class PseudonymFehler extends Error {
  readonly http: number;
  /** Gesetzt, wenn der Fehler NACH einem bezahlten Aufruf entstand (`[REDACTED]`, erfundener Platzhalter, Review M8). */
  verbrauch: KiVerbrauch | null = null;
  constructor(
    readonly code: PseudonymFehlerCode,
    message: string,
    /** Bei PFLICHT_UEBRIG: welche Klasse wie oft, nie der Wert. */
    readonly funde: RestFund[] | null = null,
  ) {
    super(message);
    this.name = 'PseudonymFehler';
    this.http = HTTP_JE_CODE[code];
  }
}

// ── Einstellungen ────────────────────────────────────────────────────────────────────────────────────────────────

export interface SchutzEinstellungen {
  /** Abgeschaltete Klassen. Eine Pflichtklasse hier wird übergangen (und die Datenbank verbietet sie, Migration 042). */
  aus: Schutzklasse[];
  liste: SchutzBegriff[];
  artikelnummer: string | null;
}

export interface SchutzQuelle {
  laden(): Promise<SchutzEinstellungen>;
}

export const standardSchutzQuelle: SchutzQuelle = {
  async laden() {
    const k = await pool.query('SELECT klasse, aktiv, muster FROM textwerkstatt_schutzklassen');
    const l = await pool.query('SELECT begriff, art FROM textwerkstatt_schutzliste ORDER BY id');
    const aus = k.rows.filter((r) => r.aktiv === false).map((r) => r.klasse as Schutzklasse);
    const artikel = k.rows.find((r) => r.klasse === 'ARTIKELNR')?.muster ?? null;
    return { aus, liste: l.rows.map((r) => ({ begriff: r.begriff, art: r.art })), artikelnummer: artikel };
  },
};

// ── Vorschau ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const GRENZEN = {
  /** wie `POST /api/quick-translate` */
  zeichen: 10_000,
  verdecken: 50,
  verdeckenZeichen: 100,
  aufdecken: 200,
  aufdeckenZeichen: 300,
  jeNutzer: 20,
  gesamt: 2_000,
  gueltigMs: 15 * 60_000,
} as const;

interface Vorschau {
  id: string;
  nutzerId: string;
  erstellt: number;
  ablauf: number;
  original: string;
  ausgehend: string;
  sitzung: PseudonymSession;
  /** Für das Laufprotokoll (Phase 4): Platzhalter je Klasse, selbst verdeckte und aufgedeckte Wörter. Nur Zähler. */
  zaehler: Partial<Record<Schutzklasse, number>>;
  verdeckt: number;
  aufgedeckt: number;
}

const vorschauen = new Map<string, Vorschau>();

function aufraeumen(jetzt: number): void {
  for (const [id, v] of vorschauen) if (v.ablauf <= jetzt) vorschauen.delete(id);
}

/** Nur für Prüfskripte. */
export function vorschauenLeeren(): void {
  vorschauen.clear();
}

/** Nur für Prüfskripte: wie viele Vorschauen gerade im Speicher liegen. */
export function vorschauAnzahl(): number {
  return vorschauen.size;
}

export type Segment =
  | { text: string }
  | { platzhalter: string; art: PseudonymKind; klasse: Schutzklasse; wert: string; pflicht: boolean; aufdeckbar: boolean };

export interface VorschauAntwort {
  vorschauId: string;
  gueltigBis: string;
  /** Genau dieser Text geht hinaus. */
  ausgehend: string;
  segmente: Segment[];
  /** Platzhalter im ausgehenden Text je Klasse (verschiedene, nicht Vorkommen). */
  zaehler: Partial<Record<Schutzklasse, number>>;
  aufgedeckt: string[];
  /** Aufgedeckt, aber in einer Pflichtklasse: bleibt verdeckt. */
  nichtAufdeckbar: string[];
  klassenAus: Schutzklasse[];
  restpruefung: { ok: boolean; funde: RestFund[] };
}

export interface VorschauEingabe {
  nutzerId: string;
  text: unknown;
  verdecken?: unknown;
  aufdecken?: unknown;
}

function liste(wert: unknown, feld: string, max: number, maxZeichen: number, minZeichen: number): string[] {
  if (wert === undefined || wert === null) return [];
  if (!Array.isArray(wert)) throw new PseudonymFehler('EINGABE', `${feld}: eine Liste von Wörtern`);
  if (wert.length > max) throw new PseudonymFehler('EINGABE', `${feld}: höchstens ${max} Einträge`);
  return wert.map((w) => {
    if (typeof w !== 'string') throw new PseudonymFehler('EINGABE', `${feld}: nur Text`);
    const t = w.replace(/\s+/g, ' ').trim();
    if (t.length < minZeichen || t.length > maxZeichen) {
      throw new PseudonymFehler('EINGABE', `${feld}: je Eintrag ${minZeichen} bis ${maxZeichen} Zeichen`);
    }
    if (/[[\]]/.test(t)) throw new PseudonymFehler('EINGABE', `${feld}: ohne eckige Klammern (Platzhalter lassen sich nicht verdecken)`);
    if (enthaeltPlatzhalter(t)) throw new PseudonymFehler('EINGABE', `${feld}: kein Platzhalter wie PERSON_1`);
    return t;
  });
}

function segmenteBauen(ausgehend: string, sitzung: PseudonymSession): Segment[] {
  const segmente: Segment[] = [];
  let pos = 0;
  for (const m of ausgehend.matchAll(new RegExp(PLACEHOLDER_RE.source, 'g'))) {
    if (m.index! > pos) segmente.push({ text: ausgehend.slice(pos, m.index) });
    const r = sitzung.replacementOf(m[0]);
    if (r) {
      const klasse = KLASSE_JE_ART[r.kind];
      segmente.push({ platzhalter: m[0], art: r.kind, klasse, wert: r.value, pflicht: PFLICHTKLASSEN.has(klasse), aufdeckbar: sitzung.aufdeckbar(r) });
    } else {
      segmente.push({ text: m[0] });
    }
    pos = m.index! + m[0].length;
  }
  if (pos < ausgehend.length) segmente.push({ text: ausgehend.slice(pos) });
  return segmente;
}

export async function vorschauErstellen(
  e: VorschauEingabe,
  quelle: SchutzQuelle = standardSchutzQuelle,
  jetzt: number = Date.now(),
): Promise<VorschauAntwort> {
  if (typeof e.text !== 'string' || !e.text.trim()) throw new PseudonymFehler('EINGABE', 'Text fehlt');
  if (e.text.length > GRENZEN.zeichen) throw new PseudonymFehler('EINGABE', `Text: höchstens ${GRENZEN.zeichen} Zeichen`);
  // Ein Platzhalter im Eingabetext machte die Zuordnung mehrdeutig und verriete über die Segmente fremde Werte (Review M1).
  if (enthaeltPlatzhalter(vereinheitlichen(e.text))) {
    throw new PseudonymFehler('EINGABE', 'Der Text enthält schon Platzhalter wie [PERSON_1] oder [REDACTED]; bitte entfernen');
  }
  const verdecken = liste(e.verdecken, 'verdecken', GRENZEN.verdecken, GRENZEN.verdeckenZeichen, 2);
  const aufdecken = liste(e.aufdecken, 'aufdecken', GRENZEN.aufdecken, GRENZEN.aufdeckenZeichen, 1);

  let einst: SchutzEinstellungen;
  try {
    einst = await quelle.laden();
  } catch {
    console.warn('[Textwerkstatt] Schutzeinstellungen nicht lesbar, keine Vorschau');
    throw new PseudonymFehler('EINSTELLUNGEN', 'Die Schutzeinstellungen sind nicht lesbar, es gibt keine Vorschau');
  }
  // Der Code entscheidet über die Pflicht, nicht die Tabelle (G3).
  const aus = einst.aus.filter((k) => (SCHUTZKLASSEN as readonly string[]).includes(k) && !PFLICHTKLASSEN.has(k));

  let sitzung: PseudonymSession;
  try {
    sitzung = new PseudonymSession({
      schutzliste: einst.liste,
      terms: verdecken.map((v) => ({ begriff: v, art: 'BEGRIFF' as const })),
      aus,
      aufdecken,
      artikelnummer: einst.artikelnummer,
    });
  } catch (err) {
    // Etwa ein Muster in der Tabelle, das am Code vorbei gesetzt wurde: zu statt mit Vorgaben (G4).
    if (err instanceof PseudonymizationError) throw new PseudonymFehler('EINSTELLUNGEN', err.message);
    throw err;
  }
  let ausgehend: string;
  try {
    ausgehend = sitzung.text(e.text);
  } catch (err) {
    if (err instanceof PseudonymizationError) throw new PseudonymFehler('ERKENNUNG', err.message);
    throw err;
  }

  aufraeumen(jetzt);
  const eigene = [...vorschauen.values()].filter((v) => v.nutzerId === e.nutzerId).sort((a, b) => a.erstellt - b.erstellt);
  while (eigene.length >= GRENZEN.jeNutzer) vorschauen.delete(eigene.shift()!.id);
  if (vorschauen.size >= GRENZEN.gesamt) {
    const aelteste = [...vorschauen.values()].sort((a, b) => a.erstellt - b.erstellt)[0];
    if (aelteste) vorschauen.delete(aelteste.id);
  }
  const zaehler: Partial<Record<Schutzklasse, number>> = {};
  for (const p of new Set(ausgehend.match(new RegExp(PLACEHOLDER_RE.source, 'g')) ?? [])) {
    const r = sitzung.replacementOf(p);
    if (r) zaehler[KLASSE_JE_ART[r.kind]] = (zaehler[KLASSE_JE_ART[r.kind]] ?? 0) + 1;
  }
  const befund = sitzung.aufdeckBefund();
  const v: Vorschau = {
    id: randomUUID(),
    nutzerId: e.nutzerId,
    erstellt: jetzt,
    ablauf: jetzt + GRENZEN.gueltigMs,
    original: e.text,
    ausgehend,
    sitzung,
    zaehler,
    verdeckt: verdecken.length,
    aufgedeckt: befund.aufgedeckt.length,
  };
  vorschauen.set(v.id, v);
  return {
    vorschauId: v.id,
    gueltigBis: new Date(v.ablauf).toISOString(),
    ausgehend,
    segmente: segmenteBauen(ausgehend, sitzung),
    zaehler,
    aufgedeckt: befund.aufgedeckt,
    nichtAufdeckbar: befund.nichtAufdeckbar,
    klassenAus: aus,
    restpruefung: restpruefung(ausgehend),
  };
}

/** Die Vorschau dieses Nutzers. Eine fremde oder abgelaufene gibt es für ihn nicht (dieselbe Antwort, kein Hinweis). */
function vorschauHolen(id: unknown, nutzerId: string, jetzt: number): Vorschau {
  aufraeumen(jetzt);
  const v = typeof id === 'string' ? vorschauen.get(id) : undefined;
  if (!v || v.nutzerId !== nutzerId) {
    throw new PseudonymFehler('VORSCHAU_UNBEKANNT', 'Diese Vorschau gibt es nicht oder nicht mehr, bitte neu erstellen');
  }
  return v;
}

export interface VorschauStand {
  /** Der Klartext, zu dem die Vorschau gehört: Gegen ihn prüft `/optimieren` das Ergebnis, nie gegen einen Text des Browsers. */
  original: string;
  /** Genau der Text, der hinausgeht. Was die Anweisung aus dem Text übernimmt (Hausbegriffe), richtet sich nach ihm. */
  ausgehend: string;
  /** Die verdeckten Werte. Keiner davon darf in die Anweisung; je Absatz müssen Original und Ergebnis dieselben tragen. */
  werte: { wert: string; klasse: Schutzklasse }[];
  zaehler: Partial<Record<Schutzklasse, number>>;
  verdeckt: number;
  aufgedeckt: number;
}

/** Stand einer Vorschau dieses Nutzers, ohne die Zuordnung. Wirft wie `pseudonymSenden`, wenn es sie nicht (mehr) gibt. */
export function vorschauLesen(id: unknown, nutzerId: string, jetzt: number = Date.now()): VorschauStand {
  const v = vorschauHolen(id, nutzerId, jetzt);
  return {
    original: v.original,
    ausgehend: v.ausgehend,
    werte: v.sitzung.replacements().map((r) => ({ wert: r.value, klasse: KLASSE_JE_ART[r.kind] })),
    zaehler: { ...v.zaehler },
    verdeckt: v.verdeckt,
    aufgedeckt: v.aufgedeckt,
  };
}

// ── Senden ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SendeEingabe {
  vorschauId: unknown;
  nutzerId: string;
  wegId: string;
  /** Die Anweisung legt der Server fest (Art der Optimierung, Phase 4), nie der Browser. */
  system: string;
  /**
   * Die Teile der Anweisung, die aus Daten stammen (Anweisung der Art, Hausbegriffe, Zielzahl). Nur sie prüft die Schranke auf
   * verdeckte Werte: Der feste Rahmen im Code enthält keine Werte, löste aber Fehlalarme aus („Mark“ steckt in „Markdown“).
   * Fehlt die Angabe, wird die ganze Anweisung geprüft.
   */
  veraenderlich?: string;
  maxTokens?: number;
}

export interface SendeErgebnis {
  /** Antwort mit den echten Werten. */
  text: string;
  /** Was hinausging, zum Nachlesen an der Belegquelle. */
  ausgehend: string;
  /** Platzhalter, die im gesendeten Text standen und in der Antwort fehlen: im Ergebnis sichtbar markieren. */
  fehlend: { platzhalter: string; klasse: Schutzklasse; wert: string }[];
  ki: {
    wegId: string;
    art: KiArt;
    modell: string;
    dauerMs: number;
    eingabeToken: number;
    ausgabeToken: number;
    denkToken: number | null;
    kostenUsd: number | null;
    abgeschnitten: boolean;
  };
}

export async function pseudonymSenden(
  e: SendeEingabe,
  deps: KiAbhaengigkeiten = standardAbhaengigkeiten,
  jetzt: number = Date.now(),
): Promise<SendeErgebnis> {
  const v = vorschauHolen(e.vorschauId, e.nutzerId, jetzt);
  // Jedes Mal neu geprüft, nicht das Ergebnis der Vorschau übernommen: Die Prüfung gehört an den Ort, wo gesendet wird.
  const rest = restpruefung(v.ausgehend);
  if (!rest.ok) {
    throw new PseudonymFehler('PFLICHT_UEBRIG', 'Im Text steht noch eine Bankverbindung, Mailadresse oder Telefonnummer; es wurde nichts gesendet', rest.funde);
  }
  // Auch die Anweisung geht hinaus. Steht ein verdeckter Wert darin (etwa als Hausbegriff, Review H1), geht nichts hinaus:
  // Sonst hätte der Nutzer ein Wort verdeckt, das das Modell trotzdem liest. Auch als Wortteil („Lichtleistenprofil“) und
  // gebeugt („Brennhofers“): Die Anweisung sieht der Nutzer nicht (Review H1-Rest, `werte.ts`).
  const system = `${e.system}\n\n${PSEUDONYM_HINT}`;
  const inAnweisung = verrateneWerte(e.veraenderlich ?? system, v.sitzung.replacements().map((r) => r.value));
  if (inAnweisung.length > 0) {
    throw new PseudonymFehler('WERT_IN_ANWEISUNG', `Die Anweisung enthält ${inAnweisung.length} verdeckte Angabe(n); es wurde nichts gesendet`);
  }
  const k = await kiAufrufen(
    { wegId: e.wegId, nutzerId: e.nutzerId, system, text: v.ausgehend, maxTokens: e.maxTokens, erwarteteArt: 'cloud' },
    deps,
  );
  const verbrauch: KiVerbrauch = {
    modell: k.modell, eingabeToken: k.eingabeToken, ausgabeToken: k.ausgabeToken, denkToken: k.denkToken, kostenUsd: k.kostenUsd, dauerMs: k.dauerMs,
  };
  const z = v.sitzung.zuruecksetzen(k.text, v.ausgehend);
  if (z.geschwaerzt > 0) {
    const f = new PseudonymFehler(
      'PROXY_GESCHWAERZT',
      `Vom Proxy geschwärzt: ${z.geschwaerzt}× [REDACTED] in der Antwort. Der Egress-Filter hat einen Teil des Textes ersetzt, die Antwort wurde verworfen`,
    );
    f.verbrauch = verbrauch;
    throw f;
  }
  if (z.unbekannt.length > 0) {
    const f = new PseudonymFehler('PLATZHALTER_UNBEKANNT', `Das Modell hat ${z.unbekannt.length} Platzhalter erfunden; die Antwort wurde verworfen`);
    f.verbrauch = verbrauch;
    throw f;
  }
  return {
    text: z.text,
    ausgehend: v.ausgehend,
    fehlend: z.fehlend.map((r) => ({ platzhalter: r.placeholder, klasse: KLASSE_JE_ART[r.kind], wert: r.value })),
    ki: {
      wegId: k.wegId,
      art: k.art,
      modell: k.modell,
      dauerMs: k.dauerMs,
      eingabeToken: k.eingabeToken,
      ausgabeToken: k.ausgabeToken,
      denkToken: k.denkToken,
      kostenUsd: k.kostenUsd,
      abgeschnitten: k.abgeschnitten,
    },
  };
}
