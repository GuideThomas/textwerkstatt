/**
 * Stilprofile der Textwerkstatt (Phase 5, Plan `PLAN-textwerkstatt.md` §4 Phase 5, Cockpit #1841).
 *
 * Ein Profil ist eine Beschreibung des Schreibstils und ein paar Beispielsätze. Im Schritt „Optimieren“ gehen beide als Teil
 * der Anweisung an das Modell (`stilAnweisung`); die harte Prüfung danach gilt unverändert (G1). Weil beide aus Daten stammen,
 * gehören sie zu den veränderlichen Teilen der Anweisung: Die Schranke in `pseudonymSenden` prüft sie auf verdeckte Werte des
 * gerade gesendeten Textes (Review H1 aus Phase 4).
 *
 * Für die Cloud reicht das nicht. Ein Profil kann aus einem eingefügten internen Text stammen und dann Namen, Nummern oder
 * Preise tragen, die im aktuellen Text gar nicht vorkommen; die sähe die Cloud im Klartext, ohne dass der Nutzer sie in der
 * Vorschau sieht (Plan §5 R6). `stilCloudBefund` erkennt sie mit denselben Regeln wie die Vorschau; findet es etwas, geht ein
 * Cloud-Lauf mit diesem Profil nicht hinaus (`STIL_MIT_WERTEN`). Die Prüfung läuft am Ort, wo gesendet wird, nicht beim
 * Speichern: Die Schutzliste kann sich seither geändert haben. Die Verwaltung zeigt denselben Befund vorab.
 *
 * Die Regeln erkennen nicht jeden Namen (Plan §5 R1): „Brennhofer“ oder „zwölf Euro vierzig“ bestehen den Befund (Review M4).
 * Deshalb geht ein Profil außerdem nur in der Fassung in die Cloud, die ein Admin gelesen und freigegeben hat
 * (`cloudFreigegeben`); der Befund heißt in der Oberfläche „keine Angaben erkannt“, nicht „darf in die Cloud“.
 *
 * Was ein Profil bestimmt und was nicht: Ton, Satzbau und Wortwahl ja; Anrede und Länge nein, die legt die Art fest und die
 * harte Prüfung setzt sie durch. Gemessen am 11.11.2026 (erster Probelauf, `messung/textwerkstatt-phase5/`): Ein Profil, das
 * „spricht den Leser mit Sie an“ und „Aufforderungen am Ende“ enthielt, ließ lokal 8 von 10 verkaufsfördernden Läufen an der
 * Anrede oder der Länge scheitern (ohne Profil 2). Deshalb sagen Ableitung und Rahmen beides ausdrücklich.
 *
 * Einlesen: `ABLEIT_SYSTEM` leitet aus einem Referenztext eine Beschreibung ab. Der Text kommt aus einer Seite, die der Server
 * holt (`referenz.ts`), oder ist eingefügt; lokal geht er im Klartext an die Station, in die Cloud nur über die Vorschau.
 *
 * Keine Werte einer Installation (G5): Die Profile stehen in der Tabelle, die Füllung einer Installation im Seed.
 */
import {
  KLASSE_JE_ART, PFLICHTKLASSEN, PLACEHOLDER_RE, PseudonymSession, PseudonymizationError, SCHUTZKLASSEN, Schutzklasse, enthaeltPlatzhalter,
  restpruefung, vereinheitlichen,
} from '../pseudonym/pseudonymize';
import type { SchutzEinstellungen } from '../pseudonym/vorschau';

export type QuelleArt = 'hand' | 'url' | 'text';

export interface StilProfil {
  id: string;
  name: string;
  channel_code: string | null;
  beschreibung: string;
  beispiele: string;
  quelle_art: QuelleArt;
  quelle_url: string | null;
  quelle_zeichen: number | null;
  fassung: number;
  aktiv: boolean;
  reihenfolge: number;
  /** Die Fassung, die ein Admin für die Cloud freigegeben hat; nur sie geht hinaus. */
  cloud_freigabe_fassung?: number | null;
  cloud_freigabe_am?: string | null;
  geaendert_am?: string | null;
}

/** Ist genau diese Fassung für die Cloud freigegeben? Eine ältere Freigabe gilt nicht. */
export function cloudFreigegeben(p: Pick<StilProfil, 'fassung' | 'cloud_freigabe_fassung'>): boolean {
  return p.cloud_freigabe_fassung != null && p.cloud_freigabe_fassung === p.fassung;
}

export const STIL_ID_MUSTER = /^[a-z][a-z0-9-]{0,31}$/;
export const CHANNEL_MUSTER = /^[A-Za-z0-9_-]{1,20}$/;
export const STIL_GRENZEN = { beschreibung: 3000, beispiele: 2000, beschreibungAktiv: 20, url: 500, referenz: 8000 } as const;

/** Felder, deren Änderung eine neue Fassung ergibt: Sie bestimmen, was an das Modell geht, oder woher es stammt. */
export const FASSUNG_FELDER = ['beschreibung', 'beispiele', 'channel_code', 'quelle_art', 'quelle_url', 'quelle_zeichen'] as const;

export type ProfilPruefung = { ok: true; felder: Partial<StilProfil> } | { ok: false; fehler: string };

const ohnePlatzhalter = (t: string) => !enthaeltPlatzhalter(vereinheitlichen(t));

/** Zeilenenden vereinheitlichen, Leerraum am Rand weg. */
function textFeld(t: string): string {
  return t.replace(/\r\n?/g, '\n').trim();
}

/** Prüft die Felder eines Profils wie `artPruefen`: `vollstaendig` beim Anlegen; unbekannte Felder werden verworfen. */
export function profilPruefen(eingabe: any, vollstaendig: boolean): ProfilPruefung {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const f: Partial<StilProfil> = {};
  if (vollstaendig) {
    if (typeof e.id !== 'string' || !STIL_ID_MUSTER.test(e.id)) {
      return { ok: false, fehler: 'Kennung: Kleinbuchstaben, Ziffern, Bindestrich, höchstens 32 Zeichen' };
    }
    f.id = e.id;
    if (e.name === undefined || e.name === null || e.name === '') return { ok: false, fehler: 'Feld name fehlt' };
  }
  if (e.name !== undefined) {
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.trim().length > 60) return { ok: false, fehler: 'Name: 1 bis 60 Zeichen' };
    f.name = e.name.trim();
  }
  if (e.channel_code !== undefined) {
    if (e.channel_code === null || e.channel_code === '') f.channel_code = null;
    else if (typeof e.channel_code !== 'string' || !CHANNEL_MUSTER.test(e.channel_code)) return { ok: false, fehler: 'Channel: eine Kennung oder leer' };
    else f.channel_code = e.channel_code;
  }
  for (const [k, max] of [['beschreibung', STIL_GRENZEN.beschreibung], ['beispiele', STIL_GRENZEN.beispiele]] as const) {
    if (e[k] === undefined) continue;
    if (typeof e[k] !== 'string') return { ok: false, fehler: `${k}: Text` };
    const t = textFeld(e[k]);
    if (t.length > max) return { ok: false, fehler: `${k}: höchstens ${max.toLocaleString('de-AT')} Zeichen` };
    // Ein Platzhalter in der Anweisung ließe sich von einem des Textes nicht unterscheiden: Das Modell gäbe ihn zurück, und
    // er würde verworfen oder mit einem fremden Wert zurückgesetzt.
    if (!ohnePlatzhalter(t)) return { ok: false, fehler: `${k}: ohne Platzhalter wie [PERSON_1] oder [REDACTED]` };
    f[k] = t;
  }
  if (e.quelle_art !== undefined) {
    if (!['hand', 'url', 'text'].includes(e.quelle_art)) return { ok: false, fehler: 'Quelle: hand, url oder text' };
    f.quelle_art = e.quelle_art;
  }
  if (e.quelle_url !== undefined) {
    if (e.quelle_url === null || e.quelle_url === '') f.quelle_url = null;
    else {
      if (typeof e.quelle_url !== 'string' || e.quelle_url.length > STIL_GRENZEN.url) return { ok: false, fehler: 'Adresse: höchstens 500 Zeichen' };
      let u: URL;
      try { u = new URL(e.quelle_url); } catch { return { ok: false, fehler: 'Adresse: keine gültige URL' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, fehler: 'Adresse: nur http oder https' };
      if (u.username || u.password) return { ok: false, fehler: 'Adresse: ohne Benutzer und Kennwort' };
      // Nach der Vereinheitlichung gemessen: Prozent- und Punycode-Schreibung können die Adresse verlängern (Review N9).
      if (u.toString().length > STIL_GRENZEN.url) return { ok: false, fehler: 'Adresse: höchstens 500 Zeichen' };
      f.quelle_url = u.toString();
    }
  }
  if (e.quelle_zeichen !== undefined) {
    if (e.quelle_zeichen === null) f.quelle_zeichen = null;
    else {
      const n = Number(e.quelle_zeichen);
      if (typeof e.quelle_zeichen === 'boolean' || !Number.isInteger(n) || n < 0 || n > 1_000_000) return { ok: false, fehler: 'Länge der Quelle: eine ganze Zahl' };
      f.quelle_zeichen = n;
    }
  }
  if (e.aktiv !== undefined) {
    if (typeof e.aktiv !== 'boolean') return { ok: false, fehler: 'Feld aktiv: ja oder nein' };
    f.aktiv = e.aktiv;
  }
  if (e.reihenfolge !== undefined) {
    const r = Number(e.reihenfolge);
    if (!Number.isInteger(r) || r < 0 || r > 1000) return { ok: false, fehler: 'Reihenfolge: 0 bis 1000' };
    f.reihenfolge = r;
  }
  if (vollstaendig) {
    f.channel_code ??= null;
    f.beschreibung ??= '';
    f.beispiele ??= '';
    f.quelle_art ??= 'hand';
    f.quelle_url ??= null;
    f.quelle_zeichen ??= null;
    f.aktiv ??= false;
    f.reihenfolge ??= 0;
  }
  return { ok: true, felder: f };
}

/**
 * Prüft den Stand, der nach dem Speichern gälte (alter Stand mit den neuen Feldern). `null`, wenn er gültig ist, sonst der Grund.
 * Die Datenbank prüft dasselbe (Migration 046); hier steht es, damit die Antwort einen Grund nennt statt „Prüfregel“.
 */
export function profilStandPruefen(p: Pick<StilProfil, 'aktiv' | 'beschreibung' | 'quelle_art' | 'quelle_url'>): string | null {
  if (p.aktiv && p.beschreibung.trim().length < STIL_GRENZEN.beschreibungAktiv) {
    return `Einschalten erst mit einer Beschreibung von mindestens ${STIL_GRENZEN.beschreibungAktiv} Zeichen`;
  }
  if (p.quelle_art === 'url' && !p.quelle_url) return 'Quelle „Adresse“ braucht die Adresse';
  if (p.quelle_art !== 'url' && p.quelle_url) return 'Eine Adresse gibt es nur bei der Quelle „Adresse“';
  return null;
}

/** Ändert sich mit diesen Feldern die Fassung? */
export function neueFassung(alt: StilProfil, felder: Partial<StilProfil>): boolean {
  return FASSUNG_FELDER.some((k) => felder[k] !== undefined && felder[k] !== alt[k]);
}

/** Beispielsätze je Zeile, ohne Aufzählungszeichen und Leerzeilen. */
export function beispielZeilen(beispiele: string): string[] {
  return beispiele
    .split('\n')
    .map((z) => z.replace(/^\s*(?:[-–•*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Der Teil der Anweisung, den das Profil beisteuert. Den Rahmen setzt der Code; er enthält keine Werte. Der Name des Profils
 * geht nicht mit: Er hilft dem Modell nicht und ist bei einem Channel eine Marke.
 */
export function stilAnweisung(p: Pick<StilProfil, 'beschreibung' | 'beispiele'>): string {
  const z = [
    'Schreibe in diesem Stil. Er bestimmt nur Ton, Satzbau und Wortwahl; die Anweisung oben und die Regeln unten gehen vor.',
    'Die Anrede legen die Anweisung und die Regeln fest, nicht dieser Stil: Wer im Text nicht angesprochen wird, wird auch jetzt nicht angesprochen. Der Stil allein ist kein Grund, Sätze, Fragen oder Aufforderungen hinzuzufügen.',
    p.beschreibung.trim(),
  ];
  const b = beispielZeilen(p.beispiele);
  if (b.length > 0) {
    z.push('Beispielsätze in diesem Stil, nur als Vorbild für Ton und Satzbau. Übernimm daraus keinen Inhalt, keine Namen, keine Zahlen und keine Angaben:');
    for (const s of b) z.push(`- ${s}`);
  }
  return z.join('\n');
}

/** Die Teile des Profils, die aus Daten stammen; sie prüft die Schranke in `pseudonymSenden`. */
export function stilVeraenderlich(p: Pick<StilProfil, 'beschreibung' | 'beispiele'>): string {
  return [p.beschreibung, p.beispiele].filter((t) => t.trim()).join('\n');
}

export interface StilCloudBefund {
  ok: boolean;
  /** Je Klasse, wie viele verschiedene Werte erkannt wurden — nie der Wert. */
  klassen: Partial<Record<Schutzklasse, number>>;
  /** Die Restprüfung (Bank, Mail, Telefon) fand etwas, das die Erkennung nicht ersetzt hätte. */
  rest: boolean;
}

/**
 * Darf dieses Profil in die Cloud? Dieselbe Erkennung wie die Vorschau (Schutzliste, Muster der Artikelnummer, abgeschaltete
 * Klassen außer den Pflichtklassen), aber ohne Masken: Es gibt keinen Nutzer, der das Profil in einer Vorschau sieht. Jede
 * erkannte Angabe sperrt, auch ein Preis oder eine Artikelnummer.
 */
export function stilCloudBefund(p: Pick<StilProfil, 'beschreibung' | 'beispiele'>, einst: SchutzEinstellungen): StilCloudBefund {
  const text = stilVeraenderlich(p);
  if (!text) return { ok: true, klassen: {}, rest: false };
  const aus = einst.aus.filter((k) => (SCHUTZKLASSEN as readonly string[]).includes(k) && !PFLICHTKLASSEN.has(k));
  const s = new PseudonymSession({ schutzliste: einst.liste, aus, artikelnummer: einst.artikelnummer });
  let ersetzt: string;
  try {
    ersetzt = s.text(text);
  } catch (err) {
    // Lässt sich der Text nicht prüfen, gilt er als nicht geprüft, also nicht als frei (G4).
    if (err instanceof PseudonymizationError) return { ok: false, klassen: {}, rest: true };
    throw err;
  }
  const klassen: Partial<Record<Schutzklasse, number>> = {};
  // Verschiedene Platzhalter im ersetzten Text, wie die Vorschau zählt; die Sitzung kennt je Name auch seine Teile.
  for (const ph of new Set(ersetzt.match(new RegExp(PLACEHOLDER_RE.source, 'g')) ?? [])) {
    const r = s.replacementOf(ph);
    if (!r) continue;
    const k = KLASSE_JE_ART[r.kind];
    klassen[k] = (klassen[k] ?? 0) + 1;
  }
  const rest = !restpruefung(text).ok;
  return { ok: Object.keys(klassen).length === 0 && !rest, klassen, rest };
}

// ── Ableiten aus einem Referenztext ──────────────────────────────────────────────────────────────────────────────────

/** Fester Rahmen, keine Werte einer Installation. Der Referenztext geht als Nutzernachricht, nie in die Anweisung. */
export const ABLEIT_SYSTEM = [
  'Du beschreibst den Schreibstil eines deutschen Referenztextes, damit ein anderes Sprachmodell neue Texte in genau diesem Stil schreiben kann.',
  'Beschreibe nur den Stil, nicht den Inhalt: Tonfall, Satzlänge und Satzbau, Wortwahl und Fachsprache, aktiv oder passiv, Aufbau von Absätzen, Zeichensetzung und Hervorhebungen.',
  'Lege keine Anrede fest (weder du noch Sie) und keine Länge; beides bestimmt später die Art der Überarbeitung. Empfiehl keine zusätzlichen Sätze, Fragen oder Aufforderungen zum Handeln.',
  'Nenne keine Namen von Personen, Firmen, Marken, Produkten oder Orten, keine Zahlen, Preise, Adressen, Nummern oder Kontaktdaten.',
  'Antworte genau in dieser Form, ohne weitere Erklärung:',
  'STIL:',
  '- fünf bis zehn kurze Punkte',
  'BEISPIELE:',
  '- zwei bis vier kurze Sätze in diesem Stil, mit neuem, allgemeinem Inhalt ohne Namen und Zahlen und ohne den Leser anzusprechen',
].join('\n');

/** Obergrenze der Antwort beim Ableiten: Die Antwort ist kurz; Luft für das Denken wie beim Optimieren. */
export const ABLEIT_MAX_TOKENS = 2500;

const MARKE = /^\s*(?:#+\s*|\*\*)?\s*(STIL|BEISPIELE)\s*:?\s*(?:\*\*)?\s*:?\s*$/i;

/**
 * Liest die Antwort des Modells in Beschreibung und Beispiele. Fehlen die Marken, ist die ganze Antwort die Beschreibung: Der
 * Admin sieht sie ohnehin, bevor er speichert. Gekürzt auf die Grenzen der Tabelle.
 */
export function ableitungLesen(antwort: string): { beschreibung: string; beispiele: string; erkannt: boolean } {
  const zeilen = antwort.replace(/\r\n?/g, '\n').split('\n');
  let teil: 'vor' | 'stil' | 'beispiele' = 'vor';
  const stil: string[] = [];
  const beispiele: string[] = [];
  let marken = 0;
  for (const z of zeilen) {
    const m = z.match(MARKE);
    if (m) {
      teil = m[1].toUpperCase() === 'STIL' ? 'stil' : 'beispiele';
      marken += 1;
      continue;
    }
    if (teil === 'stil') stil.push(z);
    else if (teil === 'beispiele') beispiele.push(z);
  }
  const sauber = (l: string[]) => l.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (marken === 0) {
    return { beschreibung: sauber(zeilen).slice(0, STIL_GRENZEN.beschreibung), beispiele: '', erkannt: false };
  }
  const b = beispielZeilen(sauber(beispiele)).map((s) => s.replace(/^[„“"»«‚‘']+|[„“"»«‚‘']+$/g, '').trim()).filter(Boolean);
  return {
    beschreibung: sauber(stil).slice(0, STIL_GRENZEN.beschreibung),
    beispiele: b.join('\n').slice(0, STIL_GRENZEN.beispiele),
    erkannt: true,
  };
}
