/**
 * Beantwortete Prüftabellen als Namensbausteine einlesen (Bauplan `Artikelanlage-Assistent/docs/BAUPLAN-Bausteine-Phase2.md`
 * §7 und §10 Schritt 4, Migrationen 033 und 034, Cockpit #1767).
 *
 * Eine Zeile der Prüftabelle bündelt nummerierte Wortpaare (`1. weiß → white`), der Prüfer antwortet je Zeile mit „OK“ oder mit
 * Korrekturen je Nummer (`2: noir mat`). Nicht jedes Paar ist ein Baustein:
 *   - „Schreibweise von Werten“ zeigt Wertformen (`1,5m → 1.5m`). Die gehören in die Sprachformen-Liste im Code des Assistenten,
 *     weil die Schlussprüfung „Zahlen gleich“ genau sie ausnimmt (Bauplan §4). → `wertform`
 *   - „Aufbau des Namens“ und „Wenn es eng wird“ sind Regeln für Kopf und Kürzung (Schritt 2, Phase 3). → `regel`
 *   - Ein Paar mit Ziffern (`5m Rolle → 5m roll`) ist bestätigt, seine Form als Muster mit Platzhalter legt aber erst `bildeName`
 *     fest. → `form_offen`, statt jetzt in einer Form einzugehen, die später umgebaut werden müsste.
 *   - „Angleichung nach Genus“ (IT) zeigt Kopf und Adjektiv im Ganzen (`Hängeleuchte schwarz → Lampada a sospensione nera`).
 *     Das sind Beispiele der Kopfregel, keine Bausteine. → `regel`
 *   - Zwei Ziele (`square / rectangular`) oder ein Wortteil (`Wand-`) → `rueckfrage`.
 *   - „…“ im Ziel (`Ruban LED … MiniAMP`) hält Platz für Code oder Serie, beschreibt also die Wortstellung im Kopf. → `rueckfrage`
 * Ein Baustein ist ein Kommateil (Plan §1 Punkt 1). Ein Ziel mit „, “ hätte einen Kommateil mehr, also ist der Teil danach eine
 * Erläuterung: Kurzform (`dimmerabile, abbr. dimm.`), Stellung (`Ruban LED, en tête`) oder Mehrzahl (`canal, 2 canaux`,
 * `1 zona, 2 zone`). Sie geht ins Protokoll, das Ziel ist der Teil davor. Hängt die Erläuterung am Einsatz
 * (`transparent, ampoule : claire`, `łącznik (szyna), złączka (taśma)`), wird es eine Rückfrage.
 * Ein Schrägstrich im Ziel ohne Leerzeichen, den das Deutsche nicht hat, ist ein Genuspaar (`bianco/bianca`, Plan §1 Punkt 3,
 * Entscheid Thomas 05.11.2026): Adjektiv mit Formen je Genus, das Ziel ist die erste Form. Das gilt nur für Sprachen mit Genus, nur
 * mit einer Form je Genus und nur, wenn alle Formen Wort für Wort denselben Stamm haben; sonst sind es zwei Ziele, eine Rückfrage.
 * Alles andere wird ein Baustein: `fest`, wenn das Ziel gleich dem Deutschen ist oder das Thema „Nicht übersetzen“ heißt,
 * `wendung` vor mit/für/inkl./exkl./ohne, sonst `wort`. Ein Zusatz in Klammern hinter dem Ziel („(only short form: dim.)“) geht
 * ins Protokoll, das Ziel bleibt ohne ihn. Zwei deutsche Formen („beidseitig (beids.)“) ergeben zwei Bausteine mit demselben Ziel.
 *
 * Geschrieben wird seit 10.11.2026 in die **Wortliste**, also in das Glossar DE→X (Plan `PLAN-wortliste.md` §3 Phase 6), nicht mehr
 * in `namens_bausteine`. Bestätigt („OK“ oder Korrektur) wird eine freigegebene Zeile; unbeantwortet eine offene Zeile mit dem
 * Vorschlag in `wortliste_vorschlag`; eine Rückfrage eine offene Zeile mit Rückfrage. Steht das Wort schon freigegeben mit anderem
 * Ziel da oder widersprechen sich Paare derselben Datei, wird es eine Rückfrage, nie ein Überschreiben; die freigegebene Zeile
 * bekommt die Rückfrage dazu und bleibt freigegeben, bis jemand entscheidet. Neue Zeilen gehen nicht an DeepL (§2.3). Gesucht wird
 * wie in `bildeName`: erst die exakte Schreibung, dann ohne Groß/Klein nur bei genau einem Treffer. Produktgruppe bleibt leer: Die
 * Prüftabellen bündeln nach Thema, nicht nach `U_klasse`.
 *
 * **Abgleich mit dem Glossar-Blatt** (Entscheid Thomas 10.11.2026, widerruft „Prüftabelle für Namen, Glossar-Blatt für andere
 * Texte“ vom 05.11.): Name und Fließtext sind einheitlich. Hat derselbe Prüfer im Glossar-Blatt seiner Sprache für ein Wort einen
 * anderen Wert gewählt als in der Prüftabelle, wird der Baustein eine Rückfrage und nicht geschrieben. Ohne das Blatt läuft das
 * Einlesen nur mit ausdrücklichem Grund (`{ ohne }`), damit kein Widerspruch still durchrutscht.
 *
 * Reine Regeln (`antwortFuer`, `klassifiziere`, `gleicheMitGlossarAb`) und der Datenbankteil (`spielePaareEin`) sind getrennt,
 * damit die Regeln ohne Datenbank testbar sind.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { leseAntworten } from './glossar-antworten-lesen';

export const WERTFORM_THEMEN = new Set(['Schreibweise von Werten']);
export const REGEL_THEMEN = new Set(['Aufbau des Namens', 'Wenn es eng wird', 'Angleichung nach Genus']);
export const FEST_THEMEN = new Set(['Nicht übersetzen']);
const SPRACHEN = new Set(['EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ']);
const WENDUNG = /^(mit|für|inkl\.?|exkl\.?|ohne)\s/i;
/** Genera je Sprache in der Reihenfolge, in der die Prüftabellen die Formen nennen (`bianco/bianca`). EN und HU haben keines. */
export const GENERA: Record<string, ReadonlyArray<'m' | 'f' | 'n'>> = {
  FR: ['m', 'f'], IT: ['m', 'f'], ES: ['m', 'f'], PL: ['m', 'f', 'n'], CZ: ['m', 'f', 'n'], SK: ['m', 'f', 'n'],
};
const AUSLASSUNG = /…|\.\.\./;
/**
 * Ein Wert wie in `bildeName` (`ZAHL` in `namensBildung.ts` des Assistenten): `5`, `2,5`, `1.000`. Ziffern direkt hinter einem
 * Buchstaben gehören zu einer Kennung (`GU10`, `R7s`, `IP67`, `B22H11`) und sind kein Wert: Ein Muster daraus verallgemeinerte
 * Sockel und Schutzarten, die kein Prüfer gesehen hat.
 */
// Auch keine Ziffer und kein Dezimalzeichen davor, sonst träfe der Ausdruck in `GU10` die `0` und in `GU5.3` die `3`.
const WERT = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)*/gu;

/**
 * `5m Rolle → 5m roll` wird das Muster `#m Rolle → #m roll`: jeder Wert ein `#`, auf beiden Seiten dieselben Werte in derselben
 * Folge. `bildeName` setzt dort die Zahl des Namens in der Sprachform ein. Nennt das Ziel andere Werte (`2-fach → double`), ist es
 * kein Muster. `werte` sind die Werte des Deutschen; leer heißt, die Ziffern gehören nur zu Kennungen.
 */
export function musterAus(deutsch: string, ziel: string): { deutsch: string; ziel: string; werte: string[] } | { grund: string } {
  const nd = deutsch.match(WERT) ?? [];
  const nz = ziel.match(WERT) ?? [];
  const ziffern = (x: string) => x.replace(/[.,]/gu, '');
  if (nd.length !== nz.length || nd.some((x, i) => ziffern(x) !== ziffern(nz[i]))) {
    return { grund: `Zahlen im Ziel (${nz.join(', ') || 'keine'}) entsprechen nicht dem Deutschen (${nd.join(', ')})` };
  }
  if (deutsch.includes('#') || ziel.includes('#')) return { grund: '„#“ steht schon im Paar' };
  return { deutsch: deutsch.replace(WERT, '#'), ziel: ziel.replace(WERT, '#'), werte: nd };
}

/** Gleicher Stamm, verschiedene Endung: `nero`/`nera`, `bílý`/`bílá`. `switch`/`button` und `on`/`off` sind es nicht. */
function gleicherStamm(a: string, b: string): boolean {
  if (a === b) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p += 1;
  return p >= 2 && x.length - p <= 3 && y.length - p <= 3;
}

/**
 * `bianco/bianca` → `{ m: 'bianco', f: 'bianca' }`. Eine Form je Genus der Sprache, jede Form Wort für Wort mit demselben Stamm
 * (`nero sabbiato/nera sabbiata`). Sonst ein Grund, warum es kein Genuspaar ist.
 */
export function genusFormen(ziel: string, sprache: string): { formen: Record<string, string> } | { grund: string } {
  const genera = GENERA[sprache];
  if (!genera) return { grund: `zwei Ziele: „${ziel}“ (${sprache} hat kein Genus)` };
  const formen = ziel.split('/').map((f) => f.trim());
  if (formen.some((f) => f === '')) return { grund: `Schrägstrich ohne zweite Form: „${ziel}“` };
  if (formen.length !== genera.length) {
    return { grund: `${formen.length} Formen, ${sprache} braucht ${genera.length} (${genera.join('/')}): „${ziel}“` };
  }
  const woerter = formen.map((f) => f.split(/\s+/));
  const stamm = woerter.every((w) => w.length === woerter[0].length && w.every((x, i) => gleicherStamm(woerter[0][i], x)));
  if (!stamm) return { grund: `zwei Ziele: „${ziel}“ (nicht dieselben Wörter mit anderer Endung)` };
  return { formen: Object.fromEntries(genera.map((g, i) => [g, formen[i]])) };
}

export interface Paar {
  blattZeile: number;
  nummer: number;
  thema: string;
  deutsch: string;
  vorschlag: string;
  ok: string;
  kommentar: string;
}

export type Antwort =
  | { status: 'ok'; notiz?: string }
  | { status: 'korrektur'; ziel: string }
  | { status: 'leer' }
  | { status: 'unklar'; grund: string };

export type Ergebnis = 'freigegeben' | 'vorlaeufig' | 'bekannt' | 'doppelt' | 'rueckfrage' | 'wertform' | 'regel' | 'form_offen';

export interface Entscheid {
  paar: Paar;
  deutsch: string;
  ziel: string;
  art: 'muster' | 'wort' | 'wendung' | 'fest' | null;
  /** Nur bei einem Genuspaar: `adjektiv` mit den Formen je Genus, sonst beides `null`. */
  wortart: 'adjektiv' | null;
  formen: Record<string, string> | null;
  ergebnis: Ergebnis;
  grund: string | null;
  antwort: string;
  /** Nur beim Nachholen: die offene Zeile im Protokoll, die dieser Entscheid fortschreibt (eine Zeile je Paar). */
  vorher?: { id: number; lauf: string; grund: string | null };
}

const SPALTEN = ['blatt_zeile', 'nummer', 'thema', 'deutsch', 'vorschlag', 'ok', 'kommentar'];

export function lesePaare(text: string): Paar[] {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n').filter((z) => z.trim() !== '');
  if (zeilen.length < 2) throw new Error('Die Liste hat keine Paare');
  const kopf = zeilen[0].split('\t');
  const fehlt = SPALTEN.filter((s) => !kopf.includes(s));
  if (fehlt.length > 0) throw new Error(`Der Liste fehlen Spalten: ${fehlt.join(', ')}`);
  const stelle = (s: string) => kopf.indexOf(s);
  return zeilen.slice(1).map((roh, i) => {
    const t = roh.split('\t');
    const w = (s: string) => (t[stelle(s)] ?? '').trim();
    const blattZeile = Number(w('blatt_zeile'));
    const nummer = Number(w('nummer'));
    if (!Number.isInteger(blattZeile) || !Number.isInteger(nummer) || nummer < 1) throw new Error(`Zeile ${i + 2}: Zeile oder Nummer fehlt`);
    if (!w('deutsch') || !w('vorschlag')) throw new Error(`Zeile ${i + 2}: Paar unvollständig`);
    return { blattZeile, nummer, thema: w('thema'), deutsch: w('deutsch'), vorschlag: w('vorschlag'), ok: w('ok'), kommentar: w('kommentar') };
  });
}

/** Korrekturen je Nummer aus dem Kommentar: „2: noir mat; 5: carré“ oder je Zeile eine. `null`, wenn der Kommentar keine solche Liste ist. */
export function korrekturen(kommentar: string): Map<number, string> | null {
  const teile = kommentar.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  if (teile.length === 0) return null;
  const m = new Map<number, string>();
  for (const t of teile) {
    const r = /^(\d+)\s*[:=)]\s*(.+)$/.exec(t);
    if (!r) return null;
    m.set(Number(r[1]), r[2].trim());
  }
  return m;
}

const IST_OK = new Set(['ok', 'ja', 'yes', 'oui', 'sì', 'si', 'tak', 'igen', 'áno', 'ano', 'sí']);

export function antwortFuer(p: Paar): Antwort {
  const ok = IST_OK.has(p.ok.trim().toLowerCase());
  if (!p.ok && !p.kommentar) return { status: 'leer' };
  if (p.kommentar) {
    const k = korrekturen(p.kommentar);
    if (k) {
      const z = k.get(p.nummer);
      return z ? { status: 'korrektur', ziel: z } : { status: 'ok' };
    }
    if (ok) return { status: 'ok', notiz: p.kommentar };
    return { status: 'unklar', grund: 'Kommentar ohne Nummern, die Zeile ist nicht „OK“' };
  }
  return ok ? { status: 'ok' } : { status: 'unklar', grund: `Antwort „${p.ok}“ ohne Korrektur` };
}

export type Klasse = Omit<Entscheid, 'antwort' | 'paar'> & { notiz: string | null };

/**
 * Zerlegt ein Paar in Bausteine oder sagt, warum es keiner ist. Ohne Datenbank. Die Sprache braucht es für die Genuspaare; fehlt
 * sie oder ist sie unbekannt, bricht die Funktion ab, statt Genuspaare still als zwei Ziele zu führen (ein Aufrufer ohne Sprache,
 * das Messskript des Assistenten, hätte sie sonst unbemerkt verloren).
 */
export function klassifiziere(p: Paar, ziel: string, sprache: string): Klasse[] {
  if (!SPRACHEN.has(sprache)) throw new Error(`klassifiziere: Sprache „${sprache}“ gibt es nicht`);
  const raus = (ergebnis: Ergebnis, grund: string): Klasse[] =>
    [{ deutsch: p.deutsch, ziel, art: null, wortart: null, formen: null, ergebnis, grund, notiz: null }];
  if (WERTFORM_THEMEN.has(p.thema)) return raus('wertform', 'Wertform: gehört in die Sprachformen-Liste im Code');
  if (REGEL_THEMEN.has(p.thema)) return raus('regel', 'Regel für Kopf oder Kürzung');

  let z = ziel.trim();
  const notizen: string[] = [];
  if (AUSLASSUNG.test(z) && !AUSLASSUNG.test(p.deutsch)) {
    return raus('rueckfrage', '„…“ hält Platz für Code oder Serie: Wortstellung im Kopf, kein Baustein');
  }
  if (z.includes(', ') && !p.deutsch.includes(', ')) {
    const teile = z.split(', ').map((t) => t.trim());
    if (teile.length > 2) return raus('rueckfrage', `${teile.length} Kommateile im Ziel`);
    const [vorn, hinten] = teile;
    if (/[:()]/.test(hinten)) return raus('rueckfrage', `Ziel hängt vom Einsatz ab: „${z}“`);
    if (/^\d+\s+\S/.test(hinten)) {
      // `canal, 2 canaux` und `1 zona, 2 zone`: Einzahl und Mehrzahl. Die Eins gehört nur dann zum Ziel, wenn das Deutsche sie hat.
      const einzahl = /^1\s+(\S.*)$/.exec(vorn);
      z = einzahl && !/^1\s/.test(p.deutsch) ? einzahl[1] : vorn;
      notizen.push(`Mehrzahl: ${hinten}`);
    } else {
      z = vorn;
      notizen.push(hinten);
    }
  }
  const zusatz = /^(.*\S)\s+\(([^()]+)\)$/.exec(z);
  if (zusatz && !p.deutsch.includes('(')) { z = zusatz[1]; notizen.push(zusatz[2]); }
  if (/\s\/\s|\sor\s/i.test(z)) return raus('rueckfrage', 'zwei Ziele');
  if (/^-|-$/.test(p.deutsch)) return raus('rueckfrage', 'Wortteil, kein ganzes Wort');

  let formen: Record<string, string> | null = null;
  if (z.includes('/') && !p.deutsch.includes('/')) {
    const g = genusFormen(z, sprache);
    if ('grund' in g) return raus('rueckfrage', g.grund);
    formen = g.formen;
    z = Object.values(formen)[0];
  }
  const notiz = notizen.length > 0 ? notizen.join(' · ') : null;

  let deutsche = [p.deutsch];
  const zwei = /^([^()]+?)\s+\(([^()]+)\)$/.exec(p.deutsch);
  if (zwei) deutsche = [zwei[1], zwei[2]];
  const mitFormen = { wortart: formen ? ('adjektiv' as const) : null, formen };
  return deutsche.map((d): Klasse => {
    // Gleiches Ziel heißt: bleibt, wie es ist, auch mit Ziffern (Serie `Linear10`, Modell `Poller-2`).
    if (z === d && !formen) return { deutsch: d, ziel: z, art: 'fest', wortart: null, formen: null, ergebnis: 'freigegeben', grund: null, notiz };
    if (FEST_THEMEN.has(p.thema)) return { deutsch: d, ziel: z, art: null, ...mitFormen, ergebnis: 'rueckfrage', grund: '„Nicht übersetzen“, aber das Ziel weicht ab', notiz };
    if (/\d/.test(d)) {
      // Ein Zahlpaar wird ein Muster für `bildeName` (`5m Rolle → #m roll`). Wörtlich bleiben die Eins, weil sie oft die Einzahl
      // verlangt (`1 STK → 1 pc` neben `2 STK → 2 pcs`, ein Muster daraus machte „2 pc“), und Ziffern, die nur zu Kennungen
      // gehören (`GU10 Strahler`).
      // ⚠️ Umgekehrt gilt ein Muster aus der Mehrzahl auch für 1 (`#-fach → # voies` macht „1 voies“); das sieht erst der Bestand.
      if (formen) return { deutsch: d, ziel: z, art: null, ...mitFormen, ergebnis: 'form_offen', grund: 'Genuspaar mit Zahl: Form offen', notiz };
      const m = musterAus(d, z);
      if ('grund' in m) return { deutsch: d, ziel: z, art: null, wortart: null, formen: null, ergebnis: 'form_offen', grund: m.grund, notiz };
      if (m.werte.length === 0) {
        return { deutsch: d, ziel: z, art: 'wort', wortart: null, formen: null, ergebnis: 'freigegeben', grund: 'Ziffern nur in Kennungen: wörtlich', notiz };
      }
      if (m.werte.every((x) => x === '1')) {
        return { deutsch: d, ziel: z, art: 'wort', wortart: null, formen: null, ergebnis: 'freigegeben', grund: 'Einzahl: gilt nur für die Zahl 1', notiz };
      }
      return { deutsch: m.deutsch, ziel: m.ziel, art: 'muster', wortart: null, formen: null, ergebnis: 'freigegeben', grund: `Muster aus „${d} → ${z}“`, notiz };
    }
    const art: 'wendung' | 'wort' = WENDUNG.test(d) ? 'wendung' : 'wort';
    return { deutsch: d, ziel: z, art, ...mitFormen, ergebnis: 'freigegeben', grund: null, notiz };
  });
}

/**
 * Formen als Text für Protokoll und Vergleich: `m bianco · f bianca`. Immer in der Folge m, f, n, weil JSONB die Schlüssel
 * umsortiert zurückgibt (`{"f": …, "m": …}`); ohne feste Folge wäre ein gleicher Baustein aus der Tabelle ein Widerspruch.
 */
export const formenText = (f: Record<string, string> | null | undefined): string | null => {
  if (!f || Object.keys(f).length === 0) return null;
  const rang = (g: string) => { const i = ['m', 'f', 'n'].indexOf(g); return i < 0 ? 9 : i; };
  return Object.entries(f).sort(([a], [b]) => rang(a) - rang(b) || a.localeCompare(b)).map(([g, w]) => `${g} ${w}`).join(' · ');
};

export interface EinleseBericht {
  lauf: string;
  zaehlung: Record<Ergebnis, number>;
  entscheide: Entscheid[];
  /** Nur beim Einlesen einer Prüftabelle: womit abgeglichen wurde und wie viele Bausteine dem Glossar-Blatt widersprachen. */
  glossar?: { datei: string; begriffe: number; widersprueche: number } | { ohne: string };
}

/** Der Wert, den der Prüfer im Glossar-Blatt gewählt hat, je Begriff (klein, ohne Rand). */
export type GlossarWerte = Map<string, { wert: string; zeile: number; deutsch: string }>;
/** Womit beim Einlesen abgeglichen wird: das Glossar-Blatt derselben Sprache oder, ausdrücklich begründet, keins. */
export type GlossarAbgleich = { datei: string; werte: GlossarWerte } | { ohne: string };

/**
 * Die Antworten des Glossar-Blatts (`leseAntworten`, Spalten wie beim Einspielen) als Wert je Begriff: „OK“ behält den heutigen
 * Wert, „Vorschlag“ nimmt den Vorschlag. Eine Entscheidung, die der Einspielweg nicht kennt, bricht hier genauso ab.
 */
export function glossarWerte(text: string): GlossarWerte {
  const m: GlossarWerte = new Map();
  for (const z of leseAntworten(text)) {
    const wert = (z.entscheidung === 'vorschlag' ? z.vorschlag : z.heute).trim();
    if (wert) m.set(z.deutsch.trim().toLowerCase(), { wert, zeile: z.zeile, deutsch: z.deutsch });
  }
  return m;
}

/**
 * Widerspricht ein Baustein der Antwort im Glossar-Blatt, wird er eine Rückfrage (Entscheid Thomas 10.11.2026). Verglichen werden
 * Wörter, Wendungen und feste Bausteine mit gleichem Deutsch; Muster haben im Glossar kein Gegenstück. Gibt die Zahl zurück.
 */
export function gleicheMitGlossarAb(entscheide: Entscheid[], werte: GlossarWerte): number {
  let n = 0;
  for (const e of entscheide) {
    if (!e.art || e.art === 'muster' || (e.ergebnis !== 'freigegeben' && e.ergebnis !== 'vorlaeufig')) continue;
    const g = werte.get(e.deutsch.trim().toLowerCase());
    if (!g || g.wert === e.ziel) continue;
    const nurSchreibung = g.wert.toLowerCase() === e.ziel.toLowerCase();
    e.ergebnis = 'rueckfrage';
    e.grund = [e.grund, `Glossar-Blatt Zeile ${g.zeile} sagt „${g.wert}“${nurSchreibung ? ' (nur Groß-/Kleinschreibung)' : ''}: Name und Fließtext sollen gleich sein`]
      .filter(Boolean).join(' · ');
    n += 1;
  }
  return n;
}

// Die Wortliste kennt je Schreibung ein Ziel, die Art gehört nicht zum Schlüssel (Plan Wortliste §2.1): `Raster` als Serie und als
// Wort in derselben Datei ist ein Widerspruch, `COVER` neben `Cover` sind zwei Zeilen.
const schluessel = (_art: string, deutsch: string) => deutsch.trim();

export async function spielePaareEin(
  c: PoolClient,
  o: { sprache: string; datei: string; sha256: string; wer: string; paare: Paar[]; glossar: GlossarAbgleich },
): Promise<EinleseBericht> {
  if (!SPRACHEN.has(o.sprache)) throw new Error(`Sprache ${o.sprache} gibt es nicht`);
  if (!/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error('Prüfwert der Datei fehlt oder ist kein SHA-256');
  if (!o.wer.trim()) throw new Error('Wer einliest, muss genannt sein (Rolle genügt)');
  if (!o.glossar || ('ohne' in o.glossar ? !o.glossar.ohne.trim() : !(o.glossar.werte instanceof Map))) {
    throw new Error('Glossar-Blatt fehlt: mit dem Blatt derselben Sprache abgleichen oder ausdrücklich begründen, warum nicht');
  }
  const schon = await c.query(`SELECT 1 FROM namens_einlesen_protokoll WHERE datei_sha256 = $1 LIMIT 1`, [o.sha256]);
  if (schon.rows.length > 0) throw new Error('Diese Fassung der Datei ist schon eingelesen');

  // 1. Je Paar Antwort und Klassifizierung, ohne Datenbank; dann der Abgleich mit dem Glossar-Blatt desselben Prüfers.
  const entscheide = o.paare.flatMap((p) => entscheideFuer(p, antwortFuer(p), o.sprache));
  const glossar = 'ohne' in o.glossar
    ? { ohne: o.glossar.ohne }
    : { datei: o.glossar.datei, begriffe: o.glossar.werte.size, widersprueche: gleicheMitGlossarAb(entscheide, o.glossar.werte) };
  return { ...(await schreibeEntscheide(c, o, entscheide)), glossar };
}

/** Antwort als Text fürs Protokoll; `holeFormOffenNach` liest sie von dort zurück. */
const antwortText = (a: Antwort) => (a.status === 'korrektur' ? `Korrektur: ${a.ziel}` : a.status === 'unklar' ? `unklar: ${a.grund}` : a.status);

/** Die Entscheide zu einem Paar: bei klarer Antwort `klassifiziere` mit dem bestätigten oder korrigierten Ziel, sonst Rückfrage. */
function entscheideFuer(p: Paar, a: Antwort, sprache: string, antwort = antwortText(a)): Entscheid[] {
  if (a.status === 'unklar') {
    return [{ paar: p, deutsch: p.deutsch, ziel: p.vorschlag, art: null, wortart: null, formen: null, ergebnis: 'rueckfrage', grund: a.grund, antwort }];
  }
  const ziel = a.status === 'korrektur' ? a.ziel : p.vorschlag;
  return klassifiziere(p, ziel, sprache).map((k): Entscheid => {
    const ft = formenText(k.formen);
    const grund = [k.grund, ft ? `Formen: ${ft}` : null, k.notiz ? `Zusatz: ${k.notiz}` : null,
      a.status === 'ok' && a.notiz ? `Anmerkung: ${a.notiz}` : null].filter(Boolean).join(' · ') || null;
    const ergebnis: Ergebnis = k.ergebnis === 'freigegeben' && a.status === 'leer' ? 'vorlaeufig' : k.ergebnis;
    return { paar: p, deutsch: k.deutsch, ziel: k.ziel, art: k.art, wortart: k.wortart, formen: k.formen, ergebnis, grund, antwort };
  });
}

export interface NachholBericht {
  offen: number;
  laeufe: EinleseBericht[];
  zaehlung: Record<Ergebnis, number>;
}

/**
 * Paare, deren Form beim Einlesen offen blieb (`form_offen`), mit den heutigen Regeln neu einordnen: aus dem Protokoll, mit der
 * Antwort von damals, ohne die Datei noch einmal zu lesen. EN wurde am 06.11.2026 eingelesen, als `klassifiziere` noch keine
 * Muster bilden konnte; 16 Zahlpaare blieben offen (#1810).
 *
 * Offen ist ein Paar, solange seine Zeile im Protokoll `form_offen` sagt. Die Zeile wird fortgeschrieben (eine Zeile je Paar):
 * neuer Lauf, Ergebnis, Baustein; Datei und Prüfwert bleiben, `von` nennt den Prüfer von damals und wer nachholt, der alte Grund
 * steht im neuen. Was wieder offen bleibt, findet ein zweiter Aufruf wieder.
 */
export async function holeFormOffenNach(c: PoolClient, o: { sprache: string; wer: string }): Promise<NachholBericht> {
  if (!SPRACHEN.has(o.sprache)) throw new Error(`Sprache ${o.sprache} gibt es nicht`);
  if (!o.wer.trim()) throw new Error('Wer nachholt, muss genannt sein (Rolle genügt)');
  const r = await c.query<{ id: number; lauf: string; grund: string | null; datei: string; datei_sha256: string; blatt_zeile: number;
    nummer: number; thema: string; deutsch: string; vorschlag: string; antwort: string | null; von: string }>(
    `SELECT id::int AS id, lauf::text AS lauf, grund, datei, datei_sha256, blatt_zeile, nummer, thema, deutsch, vorschlag, antwort, von
       FROM namens_einlesen_protokoll
      WHERE sprache = $1 AND ergebnis = 'form_offen'
      ORDER BY datei_sha256, blatt_zeile, nummer, id
      FOR UPDATE`,
    [o.sprache],
  );
  const dateien = new Map<string, typeof r.rows>();
  for (const z of r.rows) dateien.set(z.datei_sha256, [...(dateien.get(z.datei_sha256) ?? []), z]);
  const laeufe: EinleseBericht[] = [];
  for (const zeilen of dateien.values()) {
    const vonDamals = [...new Set(zeilen.map((z) => z.von))].join(' / ');
    const entscheide = zeilen.flatMap((z) => {
      const p: Paar = { blattZeile: z.blatt_zeile, nummer: z.nummer, thema: z.thema, deutsch: z.deutsch, vorschlag: z.vorschlag, ok: '', kommentar: '' };
      const a: Antwort = z.antwort === 'leer' ? { status: 'leer' } : z.antwort?.startsWith('Korrektur: ') ? { status: 'korrektur', ziel: z.vorschlag } : { status: 'ok' };
      // Die erste Klasse schreibt die offene Zeile fort; ergäben sich zwei Bausteine, käme der zweite als eigene Zeile dazu.
      return entscheideFuer(p, a, o.sprache, z.antwort ?? 'ok')
        .map((e, i) => (i === 0 ? { ...e, vorher: { id: z.id, lauf: z.lauf, grund: z.grund } } : e));
    });
    laeufe.push(await schreibeEntscheide(c, { sprache: o.sprache, datei: zeilen[0].datei, sha256: zeilen[0].datei_sha256,
      wer: `${vonDamals}; Form nachgeholt: ${o.wer}` }, entscheide));
  }
  const zaehlung = { freigegeben: 0, vorlaeufig: 0, bekannt: 0, doppelt: 0, rueckfrage: 0, wertform: 0, regel: 0, form_offen: 0 } as Record<Ergebnis, number>;
  for (const l of laeufe) for (const [k, v] of Object.entries(l.zaehlung)) zaehlung[k as Ergebnis] += v;
  return { offen: r.rows.length, laeufe, zaehlung };
}

/**
 * Schritte 2 bis 4 des Einlesens, gemeinsam für eine neue Datei (`spielePaareEin`) und für Paare, deren Form offen war
 * (`holeFormOffenNach`): Widersprüche, Abgleich mit der Tabelle, Schreiben, Protokoll.
 */
async function schreibeEntscheide(
  c: PoolClient,
  o: { sprache: string; datei: string; sha256: string; wer: string },
  entscheide: Entscheid[],
): Promise<EinleseBericht> {
  // 2. Widersprüche innerhalb der Datei: gleicher Schlüssel, anderes Ziel → alle Rückfrage; gleiches Ziel → einmal, Rest doppelt.
  //    Zum Ziel gehören die Formen: `bianco` mit und ohne `bianca` ist ein Widerspruch.
  const gruppen = new Map<string, Entscheid[]>();
  for (const e of entscheide) if (e.art && (e.ergebnis === 'freigegeben' || e.ergebnis === 'vorlaeufig')) {
    const k = schluessel(e.art, e.deutsch);
    gruppen.set(k, [...(gruppen.get(k) ?? []), e]);
  }
  const zielMitFormen = (e: { ziel: string; formen: Record<string, string> | null }) => {
    const ft = formenText(e.formen);
    return ft ? `${e.ziel} (${ft})` : e.ziel;
  };
  for (const g of gruppen.values()) {
    if (new Set(g.map(zielMitFormen)).size > 1) {
      for (const e of g) { e.ergebnis = 'rueckfrage'; e.grund = `widersprüchlich in der Datei: ${[...new Set(g.map((x) => `„${zielMitFormen(x)}“`))].join(' gegen ')}`; }
    } else {
      for (const e of g.slice(1)) { e.ergebnis = 'doppelt'; e.grund = `schon in Zeile ${g[0].paar.blattZeile} Nr. ${g[0].paar.nummer}`; }
    }
  }

  // 3. Gegen die Wortliste (Plan Wortliste §3 Phase 6): bekannt, widersprüchlich, sonst schreiben. Bis 10.11.2026 stand hier
  //    `namens_bausteine`; seit dem Umzug sperrt sich diese Tabelle je Sprache (Migration 038).
  const lauf = randomUUID();
  const ids = new Map<Entscheid, string>();
  const g = await c.query<{ id: string }>(`SELECT id FROM glossaries WHERE source_lang = 'DE' AND target_lang = $1`, [o.sprache]);
  if (g.rows.length !== 1) throw new Error(`Glossar DE→${o.sprache}: ${g.rows.length} gefunden, erwartet genau eins`);
  const gid = g.rows[0].id;
  // Wer einliest, steht so im Verlauf (Migration 037), sonst stünde dort „unbekannt“. Hier selbst gesetzt statt über
  // `db/bearbeiter`: Das Messskript des Assistenten lädt diese Datei und darf keine Datenbank-Konfiguration nachziehen.
  await c.query(`SELECT set_config('wortliste.von_id', '', true), set_config('wortliste.von', $1, true)`, [o.wer.trim()]);
  const anDeepl: string[] = [];
  const rueckfrageText = (e: Entscheid) => (e.ergebnis === 'rueckfrage' ? (e.grund ?? 'Rückfrage aus der Prüftabelle') : null);
  const vorschlagSetzen = (entryId: string, e: Entscheid) => c.query<{ vorher_pruefung: string | null; vorher_frage: string | null }>(
    // Der erste Vorschlag der Prüftabelle bleibt, eine Rückfrage auch: Ein zweites Einlesen überschreibt nichts.
    `WITH alt AS (SELECT vorschlag_pruefung, rueckfrage FROM wortliste_vorschlag WHERE entry_id = $1)
     INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_pruefung, rueckfrage, rueckfrage_von, rueckfrage_am)
     VALUES ($1, 'pruefung', $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE $4 END, CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END)
     ON CONFLICT (entry_id) DO UPDATE SET
       vorschlag_pruefung = COALESCE(wortliste_vorschlag.vorschlag_pruefung, EXCLUDED.vorschlag_pruefung),
       rueckfrage     = COALESCE(wortliste_vorschlag.rueckfrage, EXCLUDED.rueckfrage),
       rueckfrage_von = CASE WHEN wortliste_vorschlag.rueckfrage IS NULL THEN EXCLUDED.rueckfrage_von ELSE wortliste_vorschlag.rueckfrage_von END,
       rueckfrage_am  = CASE WHEN wortliste_vorschlag.rueckfrage IS NULL THEN EXCLUDED.rueckfrage_am ELSE wortliste_vorschlag.rueckfrage_am END,
       geaendert_am   = NOW()
     RETURNING (SELECT vorschlag_pruefung FROM alt) AS vorher_pruefung, (SELECT rueckfrage FROM alt) AS vorher_frage`,
    [entryId, e.ziel || null, rueckfrageText(e), o.wer.trim()],
  );

  for (const e of entscheide) {
    if (!e.art || (e.ergebnis !== 'freigegeben' && e.ergebnis !== 'vorlaeufig' && e.ergebnis !== 'rueckfrage')) continue;
    const treffer = await c.query<{ id: string; source_term: string; target_term: string | null; ziel_name: string | null;
      approved: boolean | null; formen: Record<string, string> | null; vorschlag_pruefung: string | null; rueckfrage: string | null }>(
      `SELECT e.id, e.source_term, e.target_term, e.ziel_name, e.approved, e.formen, v.vorschlag_pruefung, v.rueckfrage
         FROM glossary_entries e LEFT JOIN wortliste_vorschlag v ON v.entry_id = e.id
        WHERE e.glossary_id = $1 AND lower(btrim(e.source_term)) = lower(btrim($2))
        FOR UPDATE OF e`,
      [gid, e.deutsch],
    );
    const exakt = treffer.rows.filter((r) => r.source_term.trim() === e.deutsch.trim());
    const z = exakt[0] ?? (treffer.rows.length === 1 ? treffer.rows[0] : undefined);
    if (!z && treffer.rows.length > 1) {
      e.ergebnis = 'rueckfrage';
      e.grund = [e.grund, `mehrere Schreibungen in der Wortliste: ${treffer.rows.map((r) => `„${r.source_term}“`).join(', ')}`]
        .filter(Boolean).join(' · ');
      continue;
    }
    const formen = e.formen ? JSON.stringify(e.formen) : null;

    if (!z) {
      // Neues Wort: eine Zeile, die nicht an DeepL geht. Offen mit Vorschlag (und Rückfrage), oder gleich freigegeben.
      const neu = await c.query<{ id: string }>(
        `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source, an_deepl, art, wortart, formen)
         VALUES ($1, $2, $3, $4, 'pruefung', FALSE, $5, $6, $7::jsonb) RETURNING id`,
        [gid, e.deutsch.trim(), e.ziel || null, e.ergebnis === 'freigegeben', e.art, e.wortart, formen],
      );
      ids.set(e, neu.rows[0].id);
      if (e.ergebnis !== 'freigegeben') await vorschlagSetzen(neu.rows[0].id, e);
      continue;
    }

    ids.set(e, z.id);
    const alt = zielMitFormen({ ziel: z.ziel_name ?? z.target_term ?? '', formen: z.formen });
    if (z.approved === true && e.ergebnis !== 'rueckfrage') {
      if (alt === zielMitFormen(e)) { e.ergebnis = 'bekannt'; continue; }
      e.ergebnis = 'rueckfrage';
      e.grund = `freigegeben ist schon „${alt}“`;
    }
    if (e.ergebnis === 'freigegeben' && z.rueckfrage) {
      e.ergebnis = 'rueckfrage';
      e.grund = [e.grund, `an der Zeile steht die Rückfrage „${z.rueckfrage}“`].filter(Boolean).join(' · ');
    }

    if (e.ergebnis === 'freigegeben') {
      // Offene Zeile, der Prüfer hat entschieden: sein Ziel gilt. Formen nur, wenn er welche genannt hat; ein Muster nie an DeepL.
      const u = await c.query<{ an_deepl: boolean; source_term: string }>(
        `UPDATE glossary_entries
            SET target_term = $2, art = $3, approved = TRUE, an_deepl = an_deepl AND $3 <> 'muster',
                wortart = CASE WHEN $4::jsonb IS NULL THEN wortart ELSE 'adjektiv' END,
                genus   = CASE WHEN $4::jsonb IS NULL THEN genus ELSE NULL END,
                formen  = COALESCE($4::jsonb, formen)
          WHERE id = $1 RETURNING an_deepl, source_term`,
        [z.id, e.ziel, e.art, formen],
      );
      if (u.rows[0].an_deepl) anDeepl.push(u.rows[0].source_term);
      await vorschlagSetzen(z.id, e);
      continue;
    }

    // Vorschlag oder Rückfrage an einer vorhandenen Zeile. Die Formen gehören zum Vorschlag der Prüftabelle: Sie kommen nur mit, wo
    // dieser Vorschlag neu gesetzt wird, und nur an einer offenen Zeile.
    const v = await vorschlagSetzen(z.id, e);
    const vorher = v.rows[0];
    if (formen && z.approved !== true && vorher.vorher_pruefung === null) {
      await c.query(`UPDATE glossary_entries SET wortart = 'adjektiv', genus = NULL, formen = $2::jsonb WHERE id = $1`, [z.id, formen]);
    }
    if (e.ergebnis === 'vorlaeufig' && vorher.vorher_pruefung === e.ziel) e.ergebnis = 'bekannt';
  }
  // Nur eine offene Zeile, die schon an DeepL ging und jetzt freigegeben ist, ändert das DeepL-Glossar. Erst hier geladen, siehe oben.
  if (anDeepl.length > 0) {
    const { incrementGlossaryVersion } = await import('./glossar-pflege');
    await incrementGlossaryVersion(gid, anDeepl, c);
  }

  // 4. Protokoll: jedes Paar, auch die, die keine Bausteine sind. Eine nachgeholte Zeile wird fortgeschrieben, nicht verdoppelt
  //    (`uq_namens_einlesen_protokoll_paar`); was vorher dort stand, bleibt im Grund lesbar.
  for (const e of entscheide) {
    if (e.vorher) {
      const grund = [e.grund, `nachgeholt, vorher form_offen in Lauf ${e.vorher.lauf}${e.vorher.grund ? `: ${e.vorher.grund}` : ''}`].filter(Boolean).join(' · ');
      const u = await c.query(
        `UPDATE namens_einlesen_protokoll SET lauf = $2, deutsch = $3, vorschlag = $4, ergebnis = $5, grund = $6, entry_id = $7, von = $8, am = NOW()
          WHERE id = $1 AND ergebnis = 'form_offen'`,
        [e.vorher.id, lauf, e.deutsch, e.ziel, e.ergebnis, grund, ids.get(e) ?? null, o.wer],
      );
      if (u.rowCount !== 1) throw new Error(`Protokollzeile ${e.vorher.id} ist nicht mehr offen`);
      continue;
    }
    await c.query(
      `INSERT INTO namens_einlesen_protokoll
              (lauf, datei, datei_sha256, sprache, blatt_zeile, nummer, thema, deutsch, vorschlag, antwort, ergebnis, grund, entry_id, von)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [lauf, o.datei, o.sha256, o.sprache, e.paar.blattZeile, e.paar.nummer, e.paar.thema, e.deutsch, e.ziel, e.antwort,
       e.ergebnis, e.grund, ids.get(e) ?? null, o.wer],
    );
  }
  const zaehlung = { freigegeben: 0, vorlaeufig: 0, bekannt: 0, doppelt: 0, rueckfrage: 0, wertform: 0, regel: 0, form_offen: 0 } as Record<Ergebnis, number>;
  for (const e of entscheide) zaehlung[e.ergebnis] += 1;
  return { lauf, zaehlung, entscheide };
}
