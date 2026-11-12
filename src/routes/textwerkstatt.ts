/**
 * Textwerkstatt — Phase 2: KI-Anbindung (Plan `PLAN-textwerkstatt.md` §4 Phase 2, Cockpit #1838),
 * Phase 3: Pseudonymisierung mit Vorschau (§4 Phase 3, Cockpit #1839).
 *
 *   GET    /api/textwerkstatt/ki-status             alle Angemeldeten: welche Wege dieser Nutzer nehmen kann, mit Budget
 *   GET    /api/textwerkstatt/ki-wege               Admin: Wege mit Variablennamen, Schlüssel gesetzt/fehlt, Budget
 *   POST   /api/textwerkstatt/ki-wege               Admin: Weg anlegen
 *   PUT    /api/textwerkstatt/ki-wege/:id           Admin: Weg ändern
 *   POST   /api/textwerkstatt/ki-wege/:id/probe     Admin: Probeaufruf mit festem Text
 *   POST   /api/textwerkstatt/vorschau              Freigeschaltete und Admins: Text pseudonymisieren, so wie er hinausginge
 *   GET    /api/textwerkstatt/schutz                Admin: Klassen, Muster der Artikelnummer, Schutzliste
 *   PUT    /api/textwerkstatt/schutz/klassen/:k     Admin: Klasse an/aus (Pflichtklassen nie aus), Muster der Artikelnummer
 *   POST   /api/textwerkstatt/schutz/liste          Admin: Begriff in die Schutzliste
 *   DELETE /api/textwerkstatt/schutz/liste/:id      Admin: Begriff aus der Schutzliste
 *   GET    /api/textwerkstatt/arten                 alle Angemeldeten: aktive Arten der Optimierung (Phase 4, #1840)
 *   GET    /api/textwerkstatt/arten/alle            Admin: alle Arten mit Anweisung und Prüfregeln
 *   POST   /api/textwerkstatt/arten                 Admin: Art anlegen
 *   PUT    /api/textwerkstatt/arten/:id             Admin: Art ändern
 *   POST   /api/textwerkstatt/optimieren            Text optimieren: lokal mit `text`, Cloud nur mit `vorschauId`
 *   POST   /api/textwerkstatt/optimieren/kombination  zusammengesetzte Fassung (einzelne Absätze) prüfen, ohne Modell
 *   GET    /api/textwerkstatt/stilprofile           alle Angemeldeten: eingeschaltete Stilprofile (Phase 5, #1841)
 *   GET    /api/textwerkstatt/stilprofile/alle      Admin: alle Profile mit Befund „darf in die Cloud“
 *   POST   /api/textwerkstatt/stilprofile           Admin: Profil anlegen
 *   PUT    /api/textwerkstatt/stilprofile/:id       Admin: Profil ändern; eine inhaltliche Änderung ist eine neue Fassung
 *   GET    /api/textwerkstatt/stilprofile/:id/verlauf  Admin: Fassungen des Profils
 *   POST   /api/textwerkstatt/stilprofile/:id/cloud    Admin: genau diese Fassung für die Cloud freigeben oder die Freigabe entziehen
 *   POST   /api/textwerkstatt/stilprofile/quelle    Admin: Seite holen (der Server, nie der Browser) und Text herausziehen
 *   POST   /api/textwerkstatt/stilprofile/ableiten  Admin: aus einem Referenztext eine Stilbeschreibung ableiten; lokal mit
 *                                                   `text`, Cloud nur mit `vorschauId` wie beim Optimieren
 *
 * Der Probeaufruf schickt einen festen Satz, der hier im Code steht, nie einen Text aus dem Browser (G3). Auch die Probe
 * prüft die Freischaltung: Ein Admin ohne Freischaltung bekommt für den Cloud-Weg 403 wie jeder andere.
 *
 * Die Vorschau sendet nichts. Nutzertext an ein Modell gibt nur `/optimieren`: für die Cloud ausschließlich über die
 * `vorschauId`, sodass `pseudonymSenden` genau den gespeicherten Text schickt; ein `text` im Körper wird dort nicht gelesen.
 *
 * Fehler antworten mit `{ error, code, bis?, funde? }`; `code` ist einer aus `KiFehlerCode`, `PseudonymFehlerCode` oder
 * `OptimierFehlerCode`, die Oberfläche übersetzt ihn.
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { requireAuth as echtesRequireAuth, requireAdmin as echtesRequireAdmin, AuthenticatedRequest } from '../middleware/auth';
import {
  KiAbhaengigkeiten,
  KiWeg,
  KiWegFehler,
  kiAufrufen,
  budgetLesen,
  wegZustand,
  sperreLesen,
  standardAbhaengigkeiten,
  ENDPUNKT_VARIABLE_MUSTER,
  SCHLUESSEL_VARIABLE_MUSTER,
  WEG_ID_MUSTER,
  LOKAL_SCHLUESSEL_PRAEFIX,
  artPasstZumSchluessel,
  zusatzPruefen,
} from '../services/ki-weg';
import { PseudonymFehler, SchutzQuelle, pseudonymSenden, standardSchutzQuelle, vorschauErstellen } from '../services/pseudonym/vorschau';
import {
  PFLICHTKLASSEN, PseudonymSession, PseudonymizationError, SCHUTZKLASSEN, SchutzBegriffArt, Schutzklasse, enthaeltPlatzhalter,
} from '../services/pseudonym/pseudonymize';
import { ART_ID_MUSTER, LaufZeile, OptimierFehler, kombinationPruefen, optimieren } from '../services/optimieren/optimieren';
import type { OptimierArt } from '../services/optimieren/pruefung';
import { loadHouseTerms, type HouseTerm } from '../services/house-terms';
import {
  ABLEIT_MAX_TOKENS, ABLEIT_SYSTEM, FASSUNG_FELDER, STIL_GRENZEN, STIL_ID_MUSTER, StilProfil, ableitungLesen, cloudFreigegeben,
  profilPruefen, profilStandPruefen, neueFassung, stilCloudBefund,
} from '../services/optimieren/stilprofile';
import { ReferenzFehler, ReferenzOptionen, referenzHolen } from '../services/optimieren/referenz';

export const PROBE_SYSTEM = 'Du bist ein Lektorat. Gib nur den korrigierten Satz zurück, ohne Erklärung.';
export const PROBE_TEXT = 'Das ist ein kurzer Probesatz, mit dem die Verbindung geprüft wird.';

export interface WegSpeicher {
  anlegen(weg: KiWeg, von: string): Promise<void>;
  aendern(id: string, felder: Partial<KiWeg>, von: string): Promise<boolean>;
  verbrauchMerken(modell: string, eingabe: number, ausgabe: number, kosten: number | null, dauerMs: number): Promise<void>;
}

/** Führt `arbeit` in einer Transaktion aus; `pool.connect` steht im `try`, damit ein voller Pool kein unbehandelter Fehler wird. */
async function inTransaktion<T>(arbeit: (q: (sql: string, werte: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const c = client;
    const ergebnis = await arbeit((sql, werte) => c.query(sql, werte as any[]));
    await client.query('COMMIT');
    return ergebnis;
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client?.release();
  }
}

const standardSpeicher: WegSpeicher = {
  // Art, Schlüssel- und Endpunkt-Variable stehen nur beim Anlegen im SQL; das UPDATE kennt sie nicht (fest nach dem Anlegen).
  async anlegen(weg, von) {
    await inTransaktion(async (q) => {
      await q(
        `INSERT INTO ki_wege (id, name, art, modell, endpunkt_variable, schluessel_variable, zeitlimit_s, zusatz_parameter,
                              budget_lesen, aktiv, reihenfolge, geaendert_von, geaendert_am)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [weg.id, weg.name, weg.art, weg.modell, weg.endpunkt_variable, weg.schluessel_variable, weg.zeitlimit_s,
          JSON.stringify(weg.zusatz_parameter), weg.budget_lesen, weg.aktiv, weg.reihenfolge, von],
      );
      await q(`INSERT INTO ki_wege_verlauf (weg_id, aktion, felder, von) VALUES ($1, 'angelegt', $2, $3)`,
        [weg.id, JSON.stringify(weg), von]);
    });
  },
  async aendern(id, f, von) {
    return inTransaktion(async (q) => {
      const r = await q(
        `UPDATE ki_wege SET
           name = COALESCE($2, name), modell = COALESCE($3, modell), zeitlimit_s = COALESCE($4, zeitlimit_s),
           zusatz_parameter = COALESCE($5::jsonb, zusatz_parameter), budget_lesen = COALESCE($6, budget_lesen),
           aktiv = COALESCE($7, aktiv), reihenfolge = COALESCE($8, reihenfolge), geaendert_von = $9, geaendert_am = NOW()
         WHERE id = $1`,
        [id, f.name ?? null, f.modell ?? null, f.zeitlimit_s ?? null,
          f.zusatz_parameter ? JSON.stringify(f.zusatz_parameter) : null, f.budget_lesen ?? null, f.aktiv ?? null,
          f.reihenfolge ?? null, von],
      );
      if ((r.rowCount ?? 0) === 0) return false;
      await q(`INSERT INTO ki_wege_verlauf (weg_id, aktion, felder, von) VALUES ($1, 'geaendert', $2, $3)`,
        [id, JSON.stringify(f), von]);
      return true;
    });
  },
  async verbrauchMerken(modell, eingabe, ausgabe, kosten, dauerMs) {
    await pool.query(
      `INSERT INTO token_usage (model, purpose, input_tokens, output_tokens, cost_usd, latency_ms)
       VALUES ($1, 'textwerkstatt', $2, $3, $4, $5)`,
      [modell, eingabe, ausgabe, kosten ?? 0, dauerMs],
    );
  },
};

// ── Schutzregeln der Pseudonymisierung (Phase 3) ────────────────────────────────────────────────────────────────────

export interface SchutzKlasseZeile {
  klasse: Schutzklasse;
  aktiv: boolean;
  muster: string | null;
  geaendert_am: string | null;
}

export interface SchutzListeZeile {
  id: number;
  begriff: string;
  art: SchutzBegriffArt;
  angelegt_am: string | null;
}

export interface SchutzSpeicher extends SchutzQuelle {
  klassenLesen(): Promise<SchutzKlasseZeile[]>;
  listeLesen(): Promise<SchutzListeZeile[]>;
  klasseSetzen(klasse: Schutzklasse, felder: { aktiv?: boolean; muster?: string | null }, von: string): Promise<boolean>;
  /** `null`, wenn es den Begriff (ohne Rücksicht auf die Schreibung) schon gibt. */
  begriffAnlegen(begriff: string, art: SchutzBegriffArt, von: string): Promise<SchutzListeZeile | null>;
  begriffLoeschen(id: number, von: string): Promise<boolean>;
}

const standardSchutzSpeicher: SchutzSpeicher = {
  laden: standardSchutzQuelle.laden,
  async klassenLesen() {
    const r = await pool.query('SELECT klasse, aktiv, muster, geaendert_am FROM textwerkstatt_schutzklassen');
    return r.rows;
  },
  async listeLesen() {
    const r = await pool.query('SELECT id, begriff, art, angelegt_am FROM textwerkstatt_schutzliste ORDER BY lower(begriff)');
    return r.rows;
  },
  async klasseSetzen(klasse, f, von) {
    return inTransaktion(async (q) => {
      const r = await q(
        `UPDATE textwerkstatt_schutzklassen SET
           aktiv = COALESCE($2, aktiv),
           muster = CASE WHEN $3::boolean THEN $4 ELSE muster END,
           geaendert_von = $5, geaendert_am = NOW()
         WHERE klasse = $1`,
        [klasse, f.aktiv ?? null, f.muster !== undefined, f.muster ?? null, von],
      );
      if ((r.rowCount ?? 0) === 0) return false;
      await q(`INSERT INTO textwerkstatt_schutz_verlauf (bereich, schluessel, aktion, felder, von) VALUES ('klasse', $1, 'geaendert', $2, $3)`,
        [klasse, JSON.stringify(f), von]);
      return true;
    });
  },
  async begriffAnlegen(begriff, art, von) {
    return inTransaktion(async (q) => {
      const r = await q(
        `INSERT INTO textwerkstatt_schutzliste (begriff, art, angelegt_von) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id, begriff, art, angelegt_am`,
        [begriff, art, von],
      );
      if (!r.rows[0]) return null;
      await q(`INSERT INTO textwerkstatt_schutz_verlauf (bereich, schluessel, aktion, felder, von) VALUES ('liste', $1, 'angelegt', $2, $3)`,
        [String(r.rows[0].id), JSON.stringify({ begriff, art }), von]);
      return r.rows[0];
    });
  },
  async begriffLoeschen(id, von) {
    return inTransaktion(async (q) => {
      const r = await q('DELETE FROM textwerkstatt_schutzliste WHERE id = $1 RETURNING begriff, art', [id]);
      if (!r.rows[0]) return false;
      await q(`INSERT INTO textwerkstatt_schutz_verlauf (bereich, schluessel, aktion, felder, von) VALUES ('liste', $1, 'geloescht', $2, $3)`,
        [String(id), JSON.stringify(r.rows[0]), von]);
      return true;
    });
  },
};

const SCHUTZ_BEGRIFF_ARTEN: readonly SchutzBegriffArt[] = ['PERSON', 'FIRMA', 'PROJEKT', 'BEGRIFF'];
export const SCHUTZLISTE_HOECHSTENS = 2_000;

/** `null`, wenn das Muster der Artikelnummer zulässig ist, sonst der Grund. Leer heißt: nur mit Kennwort. */
export function musterPruefen(muster: unknown): string | null {
  if (muster === null) return null;
  if (typeof muster !== 'string' || !muster.trim() || muster.length > 200) return 'Muster: 1 bis 200 Zeichen, oder leer';
  // Dieselbe Prüfung wie im Code der Erkennung (enge Grammatik, keine Wörter, nicht leer), damit kein Weg sie umgeht.
  try {
    PseudonymSession.artikelMuster(muster);
  } catch (err) {
    return err instanceof PseudonymizationError ? `Muster: ${err.message}` : 'Muster: ungültig';
  }
  return null;
}

// ── Arten der Optimierung und Laufprotokoll (Phase 4) ───────────────────────────────────────────────────────────────

export interface OptimierSpeicher {
  artenLesen(): Promise<OptimierArt[]>;
  artLaden(id: string): Promise<OptimierArt | null>;
  artAnlegen(art: OptimierArt, von: string): Promise<void>;
  artAendern(id: string, felder: Partial<OptimierArt>, von: string): Promise<boolean>;
  laufMerken(z: LaufZeile): Promise<void>;
  begriffeLaden(channelCode: string | null): Promise<HouseTerm[]>;
}

const ART_SPALTEN = `id, name, beschreibung, anweisung, zahlen, platzhalter_fehlen_erlaubt, anrede, umstellen_erlaubt, laenge_min,
  laenge_max, zielzeichen, aktiv, reihenfolge`;

/** NUMERIC kommt aus `pg` als Zeichenkette. */
function artAusZeile(r: any): OptimierArt {
  return { ...r, laenge_min: Number(r.laenge_min), laenge_max: Number(r.laenge_max) };
}

const standardOptimierSpeicher: OptimierSpeicher = {
  async artenLesen() {
    const r = await pool.query(`SELECT ${ART_SPALTEN} FROM textwerkstatt_arten ORDER BY reihenfolge, id`);
    return r.rows.map(artAusZeile);
  },
  async artLaden(id) {
    const r = await pool.query(`SELECT ${ART_SPALTEN} FROM textwerkstatt_arten WHERE id = $1`, [id]);
    return r.rows[0] ? artAusZeile(r.rows[0]) : null;
  },
  async artAnlegen(a, von) {
    await inTransaktion(async (q) => {
      await q(
        `INSERT INTO textwerkstatt_arten (id, name, beschreibung, anweisung, zahlen, platzhalter_fehlen_erlaubt, anrede, umstellen_erlaubt,
                                          laenge_min, laenge_max, zielzeichen, aktiv, reihenfolge, geaendert_von, geaendert_am)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
        [a.id, a.name, a.beschreibung, a.anweisung, a.zahlen, a.platzhalter_fehlen_erlaubt, a.anrede, a.umstellen_erlaubt, a.laenge_min,
          a.laenge_max, a.zielzeichen, a.aktiv, a.reihenfolge, von],
      );
      await q(`INSERT INTO textwerkstatt_arten_verlauf (art_id, aktion, felder, von) VALUES ($1, 'angelegt', $2, $3)`,
        [a.id, JSON.stringify(a), von]);
    });
  },
  async artAendern(id, f, von) {
    return inTransaktion(async (q) => {
      const r = await q(
        `UPDATE textwerkstatt_arten SET
           name = COALESCE($2, name), beschreibung = COALESCE($3, beschreibung), anweisung = COALESCE($4, anweisung),
           zahlen = COALESCE($5, zahlen), platzhalter_fehlen_erlaubt = COALESCE($6, platzhalter_fehlen_erlaubt),
           anrede = COALESCE($7, anrede), laenge_min = COALESCE($8, laenge_min), laenge_max = COALESCE($9, laenge_max),
           zielzeichen = COALESCE($10, zielzeichen), aktiv = COALESCE($11, aktiv), reihenfolge = COALESCE($12, reihenfolge),
           umstellen_erlaubt = COALESCE($14, umstellen_erlaubt), geaendert_von = $13, geaendert_am = NOW()
         WHERE id = $1`,
        [id, f.name ?? null, f.beschreibung ?? null, f.anweisung ?? null, f.zahlen ?? null, f.platzhalter_fehlen_erlaubt ?? null,
          f.anrede ?? null, f.laenge_min ?? null, f.laenge_max ?? null, f.zielzeichen ?? null, f.aktiv ?? null, f.reihenfolge ?? null, von,
          f.umstellen_erlaubt ?? null],
      );
      if ((r.rowCount ?? 0) === 0) return false;
      await q(`INSERT INTO textwerkstatt_arten_verlauf (art_id, aktion, felder, von) VALUES ($1, 'geaendert', $2, $3)`,
        [id, JSON.stringify(f), von]);
      return true;
    });
  },
  async laufMerken(z) {
    await pool.query(
      `INSERT INTO textwerkstatt_laeufe (user_id, weg_id, weg_art, modell, optimier_art, zeichen_ein, zeichen_aus, platzhalter,
                                         masken_verdeckt, masken_aufgedeckt, ergebnis, pruefgruende, fehler_code, dauer_ms,
                                         eingabe_token, ausgabe_token, denk_token, kosten_usd, stilprofil_id, stilprofil_fassung,
                                         channel_code, channel_schritt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [z.nutzerId, z.wegId, z.wegArt, z.modell, z.artId, z.zeichenEin, z.zeichenAus, z.platzhalter ? JSON.stringify(z.platzhalter) : null,
        z.maskenVerdeckt, z.maskenAufgedeckt, z.ergebnis, JSON.stringify(z.pruefgruende), z.fehlerCode, z.dauerMs, z.eingabeToken,
        z.ausgabeToken, z.denkToken, z.kostenUsd, z.stilprofilId, z.stilprofilFassung, z.channelCode, z.channelSchritt],
    );
  },
  begriffeLaden: (channelCode) => loadHouseTerms(channelCode),
};

// ── Stilprofile (Phase 5) ────────────────────────────────────────────────────────────────────────────────────────────

export interface StilVerlaufZeile {
  fassung: number;
  aktion: 'angelegt' | 'geaendert';
  felder: Partial<StilProfil>;
  von: string | null;
  am: string;
}

export interface StilSpeicher {
  profileLesen(): Promise<StilProfil[]>;
  profilLaden(id: string): Promise<StilProfil | null>;
  profilAnlegen(p: StilProfil, von: string): Promise<void>;
  /**
   * Ändert; eine inhaltliche Änderung zählt die Fassung hoch (`neueFassung`). `null`, wenn es das Profil nicht gibt; `veraltet`,
   * wenn `erwartet` gesetzt ist und die Fassung inzwischen eine andere ist (zwei Admins zugleich, Review N4). Ändert sich nichts,
   * wird nichts geschrieben.
   */
  profilAendern(id: string, felder: Partial<StilProfil>, von: string, erwartet?: number): Promise<StilProfil | null | 'veraltet'>;
  /** Setzt die Freigabe für die Cloud auf genau `fassung` oder entzieht sie (`null`); `veraltet` wie oben. */
  cloudFreigabeSetzen(id: string, fassung: number | null, von: string): Promise<StilProfil | null | 'veraltet'>;
  verlaufLesen(id: string): Promise<StilVerlaufZeile[]>;
}

const STIL_SPALTEN = `id, name, channel_code, beschreibung, beispiele, quelle_art, quelle_url, quelle_zeichen, fassung, aktiv, reihenfolge,
  cloud_freigabe_fassung, cloud_freigabe_am, geaendert_am`;

/** Unterscheidet sich ein Feld vom alten Stand? Felder, die es im Profil nicht gibt, zählen nicht. */
export function stilGeaendert(alt: StilProfil, f: Partial<StilProfil>): boolean {
  const k: (keyof StilProfil)[] = [...FASSUNG_FELDER, 'name', 'aktiv', 'reihenfolge'];
  return k.some((x) => f[x] !== undefined && f[x] !== alt[x]);
}

/** Was eine Fassung ausmacht; so steht sie im Verlauf. */
function stilInhalt(p: StilProfil) {
  return {
    name: p.name, channel_code: p.channel_code, beschreibung: p.beschreibung, beispiele: p.beispiele, quelle_art: p.quelle_art,
    quelle_url: p.quelle_url, quelle_zeichen: p.quelle_zeichen, aktiv: p.aktiv,
  };
}

const standardStilSpeicher: StilSpeicher = {
  async profileLesen() {
    const r = await pool.query(`SELECT ${STIL_SPALTEN} FROM textwerkstatt_stilprofile ORDER BY reihenfolge, id`);
    return r.rows;
  },
  async profilLaden(id) {
    const r = await pool.query(`SELECT ${STIL_SPALTEN} FROM textwerkstatt_stilprofile WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  },
  async profilAnlegen(p, von) {
    await inTransaktion(async (q) => {
      await q(
        `INSERT INTO textwerkstatt_stilprofile (id, name, channel_code, beschreibung, beispiele, quelle_art, quelle_url, quelle_zeichen,
                                                fassung, aktiv, reihenfolge, geaendert_von, geaendert_am)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $11, NOW())`,
        [p.id, p.name, p.channel_code, p.beschreibung, p.beispiele, p.quelle_art, p.quelle_url, p.quelle_zeichen, p.aktiv, p.reihenfolge, von],
      );
      await q(`INSERT INTO textwerkstatt_stilprofile_verlauf (profil_id, fassung, aktion, felder, von) VALUES ($1, 1, 'angelegt', $2, $3)`,
        [p.id, JSON.stringify(stilInhalt(p)), von]);
    });
  },
  async profilAendern(id, f, von, erwartet) {
    return inTransaktion(async (q) => {
      // Gesperrt gelesen: Zwei Admins, die zugleich speichern, bekommen zwei Fassungen statt einer doppelten; wer auf einer alten
      // Fassung speichert, bekommt `veraltet` statt den Stand des anderen still zu überschreiben.
      const a = await q(`SELECT ${STIL_SPALTEN} FROM textwerkstatt_stilprofile WHERE id = $1 FOR UPDATE`, [id]);
      const alt: StilProfil | undefined = a.rows[0];
      if (!alt) return null;
      if (erwartet !== undefined && erwartet !== alt.fassung) return 'veraltet';
      if (!stilGeaendert(alt, f)) return alt;
      const neu: StilProfil = { ...alt, ...f, fassung: alt.fassung + (neueFassung(alt, f) ? 1 : 0) };
      const r = await q(
        `UPDATE textwerkstatt_stilprofile SET
           name = $2, channel_code = $3, beschreibung = $4, beispiele = $5, quelle_art = $6, quelle_url = $7, quelle_zeichen = $8,
           fassung = $9, aktiv = $10, reihenfolge = $11, geaendert_von = $12, geaendert_am = NOW()
         WHERE id = $1 RETURNING ${STIL_SPALTEN}`,
        [id, neu.name, neu.channel_code, neu.beschreibung, neu.beispiele, neu.quelle_art, neu.quelle_url, neu.quelle_zeichen, neu.fassung,
          neu.aktiv, neu.reihenfolge, von],
      );
      await q(`INSERT INTO textwerkstatt_stilprofile_verlauf (profil_id, fassung, aktion, felder, von) VALUES ($1, $2, 'geaendert', $3, $4)`,
        [id, neu.fassung, JSON.stringify(stilInhalt(neu)), von]);
      return r.rows[0];
    });
  },
  async cloudFreigabeSetzen(id, fassung, von) {
    return inTransaktion(async (q) => {
      const a = await q(`SELECT ${STIL_SPALTEN} FROM textwerkstatt_stilprofile WHERE id = $1 FOR UPDATE`, [id]);
      const alt: StilProfil | undefined = a.rows[0];
      if (!alt) return null;
      if (fassung !== null && fassung !== alt.fassung) return 'veraltet';
      const r = await q(
        `UPDATE textwerkstatt_stilprofile SET cloud_freigabe_fassung = $2, cloud_freigabe_von = $3, cloud_freigabe_am = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() END
         WHERE id = $1 RETURNING ${STIL_SPALTEN}`,
        [id, fassung, fassung === null ? null : von],
      );
      await q(`INSERT INTO textwerkstatt_stilprofile_verlauf (profil_id, fassung, aktion, felder, von) VALUES ($1, $2, $3, $4, $5)`,
        [id, alt.fassung, fassung === null ? 'cloud_entzogen' : 'cloud_freigegeben', JSON.stringify({ cloud_freigabe_fassung: fassung }), von]);
      return r.rows[0];
    });
  },
  async verlaufLesen(id) {
    const r = await pool.query(
      `SELECT h.fassung, h.aktion, h.felder, h.am, COALESCE(u.display_name, u.name, u.email) AS von
       FROM textwerkstatt_stilprofile_verlauf h LEFT JOIN users u ON u.id = h.von
       WHERE h.profil_id = $1 ORDER BY h.am DESC, h.id DESC LIMIT 50`,
      [id],
    );
    return r.rows;
  },
};

type ArtPruefung = { ok: true; felder: Partial<OptimierArt> } | { ok: false; fehler: string };

/** Prüft die Felder einer Art wie `wegPruefen`: `vollstaendig` beim Anlegen; unbekannte Felder werden verworfen. */
export function artPruefen(eingabe: any, vollstaendig: boolean): ArtPruefung {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const f: Partial<OptimierArt> = {};
  if (vollstaendig) {
    if (typeof e.id !== 'string' || !ART_ID_MUSTER.test(e.id)) {
      return { ok: false, fehler: 'Kennung: Kleinbuchstaben, Ziffern, Bindestrich, höchstens 32 Zeichen' };
    }
    f.id = e.id;
    for (const k of ['name', 'anweisung', 'laenge_min', 'laenge_max']) {
      if (e[k] === undefined || e[k] === null || e[k] === '') return { ok: false, fehler: `Feld ${k} fehlt` };
    }
  }
  if (e.name !== undefined) {
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.trim().length > 60) return { ok: false, fehler: 'Name: 1 bis 60 Zeichen' };
    f.name = e.name.trim();
  }
  if (e.beschreibung !== undefined) {
    if (typeof e.beschreibung !== 'string' || e.beschreibung.length > 300) return { ok: false, fehler: 'Beschreibung: höchstens 300 Zeichen' };
    f.beschreibung = e.beschreibung.trim();
  }
  if (e.anweisung !== undefined) {
    if (typeof e.anweisung !== 'string' || e.anweisung.trim().length < 10 || e.anweisung.trim().length > 4000) {
      return { ok: false, fehler: 'Anweisung: 10 bis 4.000 Zeichen' };
    }
    f.anweisung = e.anweisung.trim();
  }
  if (e.zahlen !== undefined) {
    if (e.zahlen !== 'alle' && e.zahlen !== 'keine_neuen') return { ok: false, fehler: 'Zahlen: alle oder keine_neuen' };
    f.zahlen = e.zahlen;
  }
  if (e.anrede !== undefined) {
    if (!['beibehalten', 'du', 'sie'].includes(e.anrede)) return { ok: false, fehler: 'Anrede: beibehalten, du oder sie' };
    f.anrede = e.anrede;
  }
  for (const k of ['laenge_min', 'laenge_max'] as const) {
    if (e[k] !== undefined) {
      const n = Number(e[k]);
      if (typeof e[k] === 'boolean' || !Number.isFinite(n) || n < 0.05 || n > 5) return { ok: false, fehler: 'Längenband: 0,05 bis 5' };
      f[k] = Math.round(n * 100) / 100;
    }
  }
  for (const k of ['platzhalter_fehlen_erlaubt', 'umstellen_erlaubt', 'zielzeichen', 'aktiv'] as const) {
    if (e[k] !== undefined) {
      if (typeof e[k] !== 'boolean') return { ok: false, fehler: `Feld ${k}: ja oder nein` };
      f[k] = e[k];
    }
  }
  if (e.reihenfolge !== undefined) {
    const r = Number(e.reihenfolge);
    if (!Number.isInteger(r) || r < 0 || r > 1000) return { ok: false, fehler: 'Reihenfolge: 0 bis 1000' };
    f.reihenfolge = r;
  }
  if (vollstaendig) {
    f.beschreibung ??= '';
    f.zahlen ??= 'alle';
    f.anrede ??= 'beibehalten';
    f.platzhalter_fehlen_erlaubt ??= false;
    f.umstellen_erlaubt ??= true;
    f.zielzeichen ??= false;
    f.aktiv ??= true;
    f.reihenfolge ??= 0;
  }
  return { ok: true, felder: f };
}

// ── Prüfung der Eingaben für Anlegen und Ändern ─────────────────────────────────────────────────────────────────────

type Pruefung = { ok: true; felder: Partial<KiWeg> } | { ok: false; fehler: string };

/** Prüft die Felder eines Wegs. `vollstaendig` verlangt alle Pflichtfelder (Anlegen). Unbekannte Felder werden verworfen. */
export function wegPruefen(eingabe: any, vollstaendig: boolean): Pruefung {
  const e = eingabe && typeof eingabe === 'object' ? eingabe : {};
  const f: Partial<KiWeg> = {};
  const fehlt = (k: string) => vollstaendig && (e[k] === undefined || e[k] === null || e[k] === '');

  if (vollstaendig) {
    if (typeof e.id !== 'string' || !WEG_ID_MUSTER.test(e.id)) return { ok: false, fehler: 'Kennung: Kleinbuchstaben, Ziffern, Bindestrich, höchstens 32 Zeichen' };
    f.id = e.id;
  }
  for (const k of ['name', 'art', 'modell', 'endpunkt_variable', 'schluessel_variable', 'zeitlimit_s']) {
    if (fehlt(k)) return { ok: false, fehler: `Feld ${k} fehlt` };
  }
  if (e.name !== undefined) {
    if (typeof e.name !== 'string' || !e.name.trim() || e.name.trim().length > 80) return { ok: false, fehler: 'Name: 1 bis 80 Zeichen' };
    f.name = e.name.trim();
  }
  if (e.art !== undefined) {
    if (e.art !== 'lokal' && e.art !== 'cloud') return { ok: false, fehler: 'Art: lokal oder cloud' };
    f.art = e.art;
  }
  if (e.modell !== undefined) {
    if (typeof e.modell !== 'string' || !e.modell.trim() || e.modell.trim().length > 120) return { ok: false, fehler: 'Modell: 1 bis 120 Zeichen' };
    f.modell = e.modell.trim();
  }
  if (e.endpunkt_variable !== undefined) {
    if (typeof e.endpunkt_variable !== 'string' || !ENDPUNKT_VARIABLE_MUSTER.test(e.endpunkt_variable)) {
      return { ok: false, fehler: 'Endpunkt-Variable: LLM_BASE_URL oder KI_WEG_…_URL' };
    }
    f.endpunkt_variable = e.endpunkt_variable;
  }
  if (e.schluessel_variable !== undefined) {
    if (typeof e.schluessel_variable !== 'string' || !SCHLUESSEL_VARIABLE_MUSTER.test(e.schluessel_variable)) {
      return { ok: false, fehler: 'Schlüssel-Variable: KI_WEG_…_KEY' };
    }
    f.schluessel_variable = e.schluessel_variable;
  }
  if (e.zeitlimit_s !== undefined) {
    const z = Number(e.zeitlimit_s);
    if (!Number.isInteger(z) || z < 1 || z > 900) return { ok: false, fehler: 'Zeitlimit: 1 bis 900 Sekunden' };
    f.zeitlimit_s = z;
  }
  if (e.zusatz_parameter !== undefined) {
    const z = e.zusatz_parameter;
    const grund = zusatzPruefen(z);
    if (grund) return { ok: false, fehler: grund };
    if (JSON.stringify(z).length > 4000) return { ok: false, fehler: 'Zusatzparameter: höchstens 4.000 Zeichen' };
    f.zusatz_parameter = z;
  }
  for (const k of ['budget_lesen', 'aktiv'] as const) {
    if (e[k] !== undefined) {
      if (typeof e[k] !== 'boolean') return { ok: false, fehler: `Feld ${k}: ja oder nein` };
      f[k] = e[k];
    }
  }
  if (e.reihenfolge !== undefined) {
    const r = Number(e.reihenfolge);
    if (!Number.isInteger(r) || r < 0 || r > 1000) return { ok: false, fehler: 'Reihenfolge: 0 bis 1000' };
    f.reihenfolge = r;
  }
  if (vollstaendig && !artPasstZumSchluessel(f.art!, f.schluessel_variable!)) {
    return {
      ok: false,
      fehler: f.art === 'lokal'
        ? `Ein lokaler Weg braucht eine Schlüssel-Variable ${LOKAL_SCHLUESSEL_PRAEFIX}…_KEY`
        : `Ein Cloud-Weg darf keine Schlüssel-Variable ${LOKAL_SCHLUESSEL_PRAEFIX}… lesen`,
    };
  }
  if (vollstaendig) {
    f.zusatz_parameter ??= {};
    f.budget_lesen ??= false;
    f.aktiv ??= true;
    f.reihenfolge ??= 0;
  }
  return { ok: true, felder: f };
}

function fehlerAntwort(res: Response, err: unknown): void {
  if (err instanceof KiWegFehler) {
    res.status(err.http).json({ error: err.message, code: err.code, ...(err.bis ? { bis: err.bis } : {}) });
    return;
  }
  if (err instanceof PseudonymFehler) {
    res.status(err.http).json({ error: err.message, code: err.code, ...(err.funde ? { funde: err.funde } : {}) });
    return;
  }
  if (err instanceof OptimierFehler || err instanceof ReferenzFehler) {
    res.status(err.http).json({ error: err.message, code: err.code });
    return;
  }
  console.error('[Textwerkstatt] unerwarteter Fehler:', (err as Error)?.message);
  res.status(500).json({ error: 'Interner Serverfehler' });
}

const nutzerId = (req: Request) => (req as AuthenticatedRequest).user!.id;
const wegParam = (req: Request) => String(req.params.id);

export function textwerkstattRouter(opts: {
  deps?: KiAbhaengigkeiten;
  speicher?: WegSpeicher;
  schutz?: SchutzSpeicher;
  optimier?: OptimierSpeicher;
  stil?: StilSpeicher;
  /** Nur Prüfskripte: Einlesen gegen einen Server auf 127.0.0.1. */
  referenz?: ReferenzOptionen;
  requireAuth?: RequestHandler | ((req: Request, res: Response, next: NextFunction) => Promise<void>);
  requireAdmin?: RequestHandler | ((req: Request, res: Response, next: NextFunction) => Promise<void>);
} = {}): Router {
  const deps = opts.deps ?? standardAbhaengigkeiten;
  const speicher = opts.speicher ?? standardSpeicher;
  const schutz = opts.schutz ?? standardSchutzSpeicher;
  const optimier = opts.optimier ?? standardOptimierSpeicher;
  const stil = opts.stil ?? standardStilSpeicher;
  const referenz = opts.referenz ?? {};
  const requireAuth = (opts.requireAuth ?? echtesRequireAuth) as RequestHandler;
  const requireAdmin = (opts.requireAdmin ?? echtesRequireAdmin) as RequestHandler;
  const router = Router();

  router.get('/ki-status', requireAuth, async (req, res) => {
    try {
      const id = nutzerId(req);
      const darfCloud = await deps.darfCloud(id);
      const wege = (await deps.wegeLaden()).filter((w) => w.aktiv);
      const zustaende = [];
      for (const w of wege) {
        const z = await wegZustand(w, id, deps);
        // Verbrauch und Grenze der Cloud sieht nur, wer sie nutzen darf.
        zustaende.push(w.art === 'cloud' && !darfCloud ? { ...z, budget: null } : z);
      }
      res.json({ darfCloud, wege: zustaende });
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.get('/ki-wege', requireAdmin, async (_req, res) => {
    try {
      const jetzt = deps.jetzt();
      const wege = await deps.wegeLaden();
      const liste = [];
      for (const w of wege) {
        const sperre = sperreLesen(w.schluessel_variable, jetzt);
        liste.push({
          ...w,
          schluesselGesetzt: !!deps.env(w.schluessel_variable)?.trim(),
          endpunktGesetzt: !!deps.env(w.endpunkt_variable)?.trim(),
          budget: w.aktiv ? await budgetLesen(w, deps) : null,
          sperre: sperre ? { art: sperre.art, bis: new Date(sperre.bis).toISOString() } : null,
        });
      }
      res.json(liste);
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.post('/ki-wege', requireAdmin, async (req, res) => {
    const p = wegPruefen(req.body, true);
    if (!p.ok) { res.status(400).json({ error: p.fehler }); return; }
    try {
      if (await deps.wegLaden(p.felder.id!)) { res.status(409).json({ error: 'Diese Kennung gibt es schon' }); return; }
      await speicher.anlegen(p.felder as KiWeg, nutzerId(req));
      res.status(201).json(await deps.wegLaden(p.felder.id!));
    } catch (err: any) {
      if (err?.code === '23505') { res.status(409).json({ error: 'Diese Kennung gibt es schon' }); return; }
      if (err?.code === '23514') { res.status(400).json({ error: 'Die Datenbank lehnt den Weg ab (Prüfregel)' }); return; }
      fehlerAntwort(res, err);
    }
  });

  router.put('/ki-wege/:id', requireAdmin, async (req, res) => {
    const p = wegPruefen(req.body, false);
    if (!p.ok) { res.status(400).json({ error: p.fehler }); return; }
    try {
      const alt = await deps.wegLaden(wegParam(req));
      if (!alt) { res.status(404).json({ error: 'KI-Weg nicht gefunden' }); return; }
      // Fest nach dem Anlegen: Sonst ließe sich ein lokaler Weg in einen Cloud-Weg verwandeln, ohne dass ein neuer Weg
      // (mit eigener Kennung und eigenem Verlauf) entsteht. Wer das will, schaltet den Weg aus und legt einen neuen an.
      for (const k of ['art', 'schluessel_variable', 'endpunkt_variable'] as const) {
        if (p.felder[k] !== undefined && p.felder[k] !== alt[k]) {
          res.status(400).json({ error: 'Art, Schlüssel- und Endpunkt-Variable sind nach dem Anlegen fest; Weg ausschalten und neu anlegen' });
          return;
        }
      }
      if (!(await speicher.aendern(wegParam(req), p.felder, nutzerId(req)))) {
        res.status(404).json({ error: 'KI-Weg nicht gefunden' });
        return;
      }
      res.json(await deps.wegLaden(wegParam(req)));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.post('/ki-wege/:id/probe', requireAdmin, async (req, res) => {
    try {
      const e = await kiAufrufen(
        { wegId: wegParam(req), nutzerId: nutzerId(req), system: PROBE_SYSTEM, text: PROBE_TEXT, maxTokens: 200 },
        deps,
      );
      await speicher.verbrauchMerken(e.modell, e.eingabeToken, e.ausgabeToken, e.kostenUsd, e.dauerMs).catch(() => {
        console.warn('[Textwerkstatt] Verbrauch der Probe nicht gespeichert');
      });
      res.json({
        wegId: e.wegId,
        art: e.art,
        modell: e.modell,
        antwort: e.text.slice(0, 500),
        dauerMs: e.dauerMs,
        eingabeToken: e.eingabeToken,
        ausgabeToken: e.ausgabeToken,
        denkToken: e.denkToken,
        kostenUsd: e.kostenUsd,
      });
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  // ── Phase 3: Vorschau und Schutzregeln ─────────────────────────────────────────────────────────────────────────

  // Die Vorschau gehört zum Weg in die Cloud; sie bekommt, wer die Cloud nutzen darf, und ein Admin, der die Regeln prüft.
  router.post('/vorschau', requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      if (user.role !== 'admin' && !(await deps.darfCloud(user.id))) {
        res.status(403).json({ error: 'Für die Cloud-KI ist dieser Zugang nicht freigeschaltet', code: 'NICHT_FREIGESCHALTET' });
        return;
      }
      const b = req.body ?? {};
      res.json(await vorschauErstellen({ nutzerId: user.id, text: b.text, verdecken: b.verdecken, aufdecken: b.aufdecken }, schutz));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.get('/schutz', requireAdmin, async (_req, res) => {
    try {
      const zeilen = new Map((await schutz.klassenLesen()).map((z) => [z.klasse, z]));
      const klassen = SCHUTZKLASSEN.map((k) => {
        const z = zeilen.get(k);
        return {
          klasse: k,
          // Eine Pflichtklasse ist an, was auch in der Tabelle steht: Der Code entscheidet (G3).
          aktiv: PFLICHTKLASSEN.has(k) ? true : (z?.aktiv ?? true),
          pflicht: PFLICHTKLASSEN.has(k),
          muster: z?.muster ?? null,
          geaendertAm: z?.geaendert_am ?? null,
        };
      });
      res.json({ klassen, liste: await schutz.listeLesen() });
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.put('/schutz/klassen/:klasse', requireAdmin, async (req, res) => {
    const klasse = String(req.params.klasse) as Schutzklasse;
    if (!(SCHUTZKLASSEN as readonly string[]).includes(klasse)) { res.status(404).json({ error: 'Diese Klasse gibt es nicht' }); return; }
    const b = req.body ?? {};
    const felder: { aktiv?: boolean; muster?: string | null } = {};
    if (b.aktiv !== undefined) {
      if (typeof b.aktiv !== 'boolean') { res.status(400).json({ error: 'aktiv: ja oder nein' }); return; }
      if (!b.aktiv && PFLICHTKLASSEN.has(klasse)) {
        res.status(400).json({ error: 'Bankverbindung, Mail und Telefon lassen sich nicht abschalten', code: 'PFLICHTKLASSE' });
        return;
      }
      felder.aktiv = b.aktiv;
    }
    if (b.muster !== undefined) {
      if (klasse !== 'ARTIKELNR') { res.status(400).json({ error: 'Ein Muster gibt es nur für die Artikelnummer' }); return; }
      const muster = typeof b.muster === 'string' && !b.muster.trim() ? null : b.muster;
      const grund = musterPruefen(muster);
      if (grund) { res.status(400).json({ error: grund }); return; }
      felder.muster = muster;
    }
    if (felder.aktiv === undefined && felder.muster === undefined) { res.status(400).json({ error: 'Nichts zu ändern' }); return; }
    try {
      if (!(await schutz.klasseSetzen(klasse, felder, nutzerId(req)))) { res.status(404).json({ error: 'Diese Klasse gibt es nicht' }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      if (err?.code === '23514') { res.status(400).json({ error: 'Die Datenbank lehnt die Änderung ab (Prüfregel)' }); return; }
      fehlerAntwort(res, err);
    }
  });

  router.post('/schutz/liste', requireAdmin, async (req, res) => {
    const b = req.body ?? {};
    const begriff = typeof b.begriff === 'string' ? b.begriff.replace(/\s+/g, ' ').trim() : '';
    const art = (b.art ?? 'BEGRIFF') as SchutzBegriffArt;
    if (begriff.length < 2 || begriff.length > 200 || /[[\]]/.test(begriff) || enthaeltPlatzhalter(begriff)) {
      res.status(400).json({ error: 'Begriff: 2 bis 200 Zeichen, ohne eckige Klammern und ohne Platzhalter wie PERSON_1' });
      return;
    }
    if (!SCHUTZ_BEGRIFF_ARTEN.includes(art)) { res.status(400).json({ error: 'Art: PERSON, FIRMA, PROJEKT oder BEGRIFF' }); return; }
    try {
      // Eine Obergrenze, damit eine Vorschau nicht Sekunden braucht (5.000 Begriffe kosteten 1,7 s, Review N2).
      if ((await schutz.listeLesen()).length >= SCHUTZLISTE_HOECHSTENS) {
        res.status(409).json({ error: `Die Schutzliste hat schon ${SCHUTZLISTE_HOECHSTENS} Begriffe` });
        return;
      }
      const zeile = await schutz.begriffAnlegen(begriff, art, nutzerId(req));
      if (!zeile) { res.status(409).json({ error: 'Diesen Begriff gibt es schon' }); return; }
      res.status(201).json(zeile);
    } catch (err: any) {
      if (err?.code === '23514') { res.status(400).json({ error: 'Die Datenbank lehnt den Begriff ab (Prüfregel)' }); return; }
      fehlerAntwort(res, err);
    }
  });

  router.delete('/schutz/liste/:id', requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    // isSafeInteger: `1e21` ist eine ganze Zahl, aber keine, die PostgreSQL annimmt (Review, Hinweis).
    if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: 'Kennung: eine Zahl' }); return; }
    try {
      if (!(await schutz.begriffLoeschen(id, nutzerId(req)))) { res.status(404).json({ error: 'Diesen Begriff gibt es nicht' }); return; }
      res.status(204).end();
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  // ── Phase 4: Arten und Optimieren ──────────────────────────────────────────────────────────────────────────────

  // Für die Auswahl auf der Seite: ohne Anweisung und Prüfregeln, die braucht nur der Admin.
  router.get('/arten', requireAuth, async (_req, res) => {
    try {
      const arten = (await optimier.artenLesen()).filter((a) => a.aktiv);
      res.json(arten.map((a) => ({ id: a.id, name: a.name, beschreibung: a.beschreibung, anrede: a.anrede, zielzeichen: a.zielzeichen })));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.get('/arten/alle', requireAdmin, async (_req, res) => {
    try {
      res.json(await optimier.artenLesen());
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.post('/arten', requireAdmin, async (req, res) => {
    const p = artPruefen(req.body, true);
    if (!p.ok) { res.status(400).json({ error: p.fehler }); return; }
    if (p.felder.laenge_min! > p.felder.laenge_max!) { res.status(400).json({ error: 'Längenband: unten höchstens oben' }); return; }
    try {
      if (await optimier.artLaden(p.felder.id!)) { res.status(409).json({ error: 'Diese Kennung gibt es schon' }); return; }
      await optimier.artAnlegen(p.felder as OptimierArt, nutzerId(req));
      res.status(201).json(await optimier.artLaden(p.felder.id!));
    } catch (err: any) {
      if (err?.code === '23505') { res.status(409).json({ error: 'Diese Kennung gibt es schon' }); return; }
      if (err?.code === '23514') { res.status(400).json({ error: 'Die Datenbank lehnt die Art ab (Prüfregel)' }); return; }
      fehlerAntwort(res, err);
    }
  });

  router.put('/arten/:id', requireAdmin, async (req, res) => {
    const p = artPruefen(req.body, false);
    if (!p.ok) { res.status(400).json({ error: p.fehler }); return; }
    if (Object.keys(p.felder).length === 0) { res.status(400).json({ error: 'Nichts zu ändern' }); return; }
    try {
      const id = String(req.params.id);
      const alt = await optimier.artLaden(id);
      if (!alt) { res.status(404).json({ error: 'Diese Art gibt es nicht' }); return; }
      if ((p.felder.laenge_min ?? alt.laenge_min) > (p.felder.laenge_max ?? alt.laenge_max)) {
        res.status(400).json({ error: 'Längenband: unten höchstens oben' });
        return;
      }
      if (!(await optimier.artAendern(id, p.felder, nutzerId(req)))) { res.status(404).json({ error: 'Diese Art gibt es nicht' }); return; }
      res.json(await optimier.artLaden(id));
    } catch (err: any) {
      if (err?.code === '23514') { res.status(400).json({ error: 'Die Datenbank lehnt die Änderung ab (Prüfregel)' }); return; }
      fehlerAntwort(res, err);
    }
  });

  // Optimieren: Wer die lokale KI nimmt, schickt den Text; wer die Cloud nimmt, nur die Kennung seiner Vorschau. Ob ein Weg
  // lokal oder Cloud ist, steht am Server (`ki_wege.art`), nicht in der Anfrage (G3).
  router.post('/optimieren', requireAuth, async (req, res) => {
    try {
      const b = req.body ?? {};
      res.json(await optimieren(
        {
          nutzerId: nutzerId(req),
          artId: b.art,
          wegId: b.wegId,
          text: b.text,
          vorschauId: b.vorschauId,
          zielzeichen: b.zielzeichen,
          channelCode: b.channelCode,
          stilprofilId: b.stilprofil,
          stilprofilFassung: b.stilprofilFassung,
        },
        {
          ki: deps,
          stilLaden: (id) => stil.profilLaden(id),
          artLaden: (id) => optimier.artLaden(id),
          begriffeLaden: (c) => optimier.begriffeLaden(c),
          schutzLaden: () => schutz.laden(),
          laufMerken: (z) => optimier.laufMerken(z),
          verbrauchMerken: (m, ein, aus, k, ms) => speicher.verbrauchMerken(m, ein, aus, k, ms),
        },
      ));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  // Vor der Übernahme einzelner Absätze: die zusammengesetzte Fassung mit derselben Prüfung, ohne Modell (Review M9-Rest).
  router.post('/optimieren/kombination', requireAuth, async (req, res) => {
    try {
      const b = req.body ?? {};
      res.json({
        befund: await kombinationPruefen(
          { artId: b.art, original: b.original, text: b.text, channelCode: b.channelCode, zielzeichen: b.zielzeichen },
          { artLaden: (id) => optimier.artLaden(id), begriffeLaden: (c) => optimier.begriffeLaden(c), schutzLaden: () => schutz.laden() },
        ),
      });
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  // ── Phase 5: Stilprofile ─────────────────────────────────────────────────────────────────────────────────────────

  const stilFehler = (res: Response, err: any): void => {
    if (err?.code === '23505') { res.status(409).json({ error: 'Diese Kennung gibt es schon' }); return; }
    if (err?.code === '23503') { res.status(400).json({ error: 'Diesen Channel gibt es nicht' }); return; }
    if (err?.code === '23514') { res.status(400).json({ error: 'Die Datenbank lehnt das Profil ab (Prüfregel)' }); return; }
    fehlerAntwort(res, err);
  };
  const stilParam = (req: Request): string | null => {
    const id = String(req.params.id);
    return STIL_ID_MUSTER.test(id) ? id : null;
  };

  // Für die Auswahl auf der Seite: nur eingeschaltete. Die Beschreibung geht mit, damit der Nutzer sieht, was das Modell liest.
  router.get('/stilprofile', requireAuth, async (_req, res) => {
    try {
      const einst = await schutz.laden().catch(() => null);
      const liste = (await stil.profileLesen()).filter((p) => p.aktiv && p.beschreibung.trim().length >= STIL_GRENZEN.beschreibungAktiv);
      res.json(liste.map((p) => ({
        id: p.id,
        name: p.name,
        channelCode: p.channel_code,
        fassung: p.fassung,
        beschreibung: p.beschreibung,
        beispiele: p.beispiele,
        // Für die Cloud nur in der freigegebenen Fassung und ohne erkannte Angabe; ohne lesbare Schutzregeln nicht (G4). Der Lauf
        // prüft ohnehin noch einmal.
        cloud: cloudFreigegeben(p) && (einst ? stilCloudBefund(p, einst).ok : false),
      })));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.get('/stilprofile/alle', requireAdmin, async (_req, res) => {
    try {
      const einst = await schutz.laden().catch(() => null);
      res.json((await stil.profileLesen()).map((p) => ({ ...p, cloud: einst ? stilCloudBefund(p, einst) : null, cloudFreigegeben: cloudFreigegeben(p) })));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  router.post('/stilprofile', requireAdmin, async (req, res) => {
    const p = profilPruefen(req.body, true);
    if (!p.ok) { res.status(400).json({ error: p.fehler }); return; }
    const grund = profilStandPruefen(p.felder as StilProfil);
    if (grund) { res.status(400).json({ error: grund }); return; }
    try {
      if (await stil.profilLaden(p.felder.id!)) { res.status(409).json({ error: 'Diese Kennung gibt es schon' }); return; }
      await stil.profilAnlegen({ ...(p.felder as StilProfil), fassung: 1 }, nutzerId(req));
      res.status(201).json(await stil.profilLaden(p.felder.id!));
    } catch (err) {
      stilFehler(res, err);
    }
  });

  router.put('/stilprofile/:id', requireAdmin, async (req, res) => {
    const id = stilParam(req);
    if (!id) { res.status(404).json({ error: 'Dieses Stilprofil gibt es nicht' }); return; }
    const p = profilPruefen(req.body, false);
    if (!p.ok) { res.status(400).json({ error: p.fehler }); return; }
    if (Object.keys(p.felder).length === 0) { res.status(400).json({ error: 'Nichts zu ändern' }); return; }
    try {
      const alt = await stil.profilLaden(id);
      if (!alt) { res.status(404).json({ error: 'Dieses Stilprofil gibt es nicht' }); return; }
      const grund = profilStandPruefen({ ...alt, ...p.felder });
      if (grund) { res.status(400).json({ error: grund }); return; }
      let erwartet: number | undefined;
      if (req.body?.fassung !== undefined) {
        erwartet = Number(req.body.fassung);
        if (!Number.isInteger(erwartet) || erwartet < 1) { res.status(400).json({ error: 'Fassung: eine ganze Zahl' }); return; }
      }
      const neu = await stil.profilAendern(id, p.felder, nutzerId(req), erwartet);
      if (!neu) { res.status(404).json({ error: 'Dieses Stilprofil gibt es nicht' }); return; }
      if (neu === 'veraltet') {
        res.status(409).json({ error: 'Das Profil wurde inzwischen geändert; bitte neu laden', code: 'STIL_VERALTET' });
        return;
      }
      res.json(neu);
    } catch (err) {
      stilFehler(res, err);
    }
  });

  // Freigeben heißt: Ein Admin hat genau diese Fassung gelesen; die Regeln erkennen nicht jeden Namen (Review M4). Die Fassung
  // kommt aus dem Browser und muss die aktuelle sein, sonst gälte die Freigabe einem Stand, den der Admin nicht gesehen hat.
  router.post('/stilprofile/:id/cloud', requireAdmin, async (req, res) => {
    const id = stilParam(req);
    if (!id) { res.status(404).json({ error: 'Dieses Stilprofil gibt es nicht' }); return; }
    const b = req.body ?? {};
    if (typeof b.freigeben !== 'boolean') { res.status(400).json({ error: 'freigeben: ja oder nein' }); return; }
    const fassung = Number(b.fassung);
    if (b.freigeben && (!Number.isInteger(fassung) || fassung < 1)) { res.status(400).json({ error: 'Fassung: eine ganze Zahl' }); return; }
    try {
      const alt = await stil.profilLaden(id);
      if (!alt) { res.status(404).json({ error: 'Dieses Stilprofil gibt es nicht' }); return; }
      if (b.freigeben) {
        let einst;
        try { einst = await schutz.laden(); } catch {
          res.status(503).json({ error: 'Die Schutzregeln sind nicht lesbar; ohne sie keine Freigabe', code: 'SCHUTZREGELN' });
          return;
        }
        if (!stilCloudBefund(alt, einst).ok) {
          res.status(422).json({ error: 'Das Profil enthält erkannte Angaben; erst entfernen, dann freigeben', code: 'STIL_MIT_WERTEN' });
          return;
        }
      }
      const neu = await stil.cloudFreigabeSetzen(id, b.freigeben ? fassung : null, nutzerId(req));
      if (!neu) { res.status(404).json({ error: 'Dieses Stilprofil gibt es nicht' }); return; }
      if (neu === 'veraltet') {
        res.status(409).json({ error: 'Das Profil wurde inzwischen geändert; bitte neu laden', code: 'STIL_VERALTET' });
        return;
      }
      res.json({ ...neu, cloudFreigegeben: cloudFreigegeben(neu) });
    } catch (err) {
      stilFehler(res, err);
    }
  });

  router.get('/stilprofile/:id/verlauf', requireAdmin, async (req, res) => {
    const id = stilParam(req);
    if (!id) { res.status(404).json({ error: 'Dieses Stilprofil gibt es nicht' }); return; }
    try {
      res.json(await stil.verlaufLesen(id));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  // Die Seite holt der Server. Zurück geht nur Text, ohne Adressen und Mailadressen (`referenz.ts`).
  router.post('/stilprofile/quelle', requireAdmin, async (req, res) => {
    try {
      res.json(await referenzHolen(req.body?.url, referenz));
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  // Eine Antwort, die danach verworfen wurde (leer, `[REDACTED]`, erfundener Platzhalter), hat trotzdem gekostet (Review N6).
  const verworfenBuchen = async (err: unknown): Promise<never> => {
    const v = err instanceof KiWegFehler || err instanceof PseudonymFehler ? err.verbrauch : null;
    if (v) {
      await speicher.verbrauchMerken(v.modell, v.eingabeToken, v.ausgabeToken, v.kostenUsd, v.dauerMs)
        .catch(() => console.warn('[Textwerkstatt] Verbrauch des Ableitens nicht gespeichert'));
    }
    throw err;
  };

  // Ableiten wie Optimieren: lokal mit dem Text, Cloud nur über die Vorschau (der Referenztext kann intern sein, Plan §5 R6).
  router.post('/stilprofile/ableiten', requireAdmin, async (req, res) => {
    try {
      const b = req.body ?? {};
      if (typeof b.wegId !== 'string' || !WEG_ID_MUSTER.test(b.wegId)) { res.status(400).json({ error: 'KI-Weg: eine Kennung', code: 'EINGABE' }); return; }
      const weg = await deps.wegLaden(b.wegId);
      if (!weg) throw new KiWegFehler('WEG_UNBEKANNT', `KI-Weg ${b.wegId} gibt es nicht`, b.wegId);
      let antwort: string;
      let ki: { modell: string; dauerMs: number; eingabeToken: number; ausgabeToken: number; kostenUsd: number | null; abgeschnitten: boolean };
      if (weg.art === 'cloud') {
        if (typeof b.vorschauId !== 'string' || !b.vorschauId) {
          throw new OptimierFehler('VORSCHAU_FEHLT', 'Für die Cloud-KI zuerst die Vorschau erstellen; gesendet wird nur deren Text');
        }
        // Die Anweisung ist fester Code ohne Daten: Es gibt keinen veränderlichen Teil, den ein verdeckter Wert erreichen könnte.
        const s = await pseudonymSenden(
          { vorschauId: b.vorschauId, nutzerId: nutzerId(req), wegId: weg.id, system: ABLEIT_SYSTEM, veraenderlich: '', maxTokens: ABLEIT_MAX_TOKENS },
          deps,
        ).catch(verworfenBuchen);
        antwort = s.text;
        ki = { ...s.ki };
      } else {
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (text.length < 100) throw new OptimierFehler('TEXT_FEHLT', 'Referenztext: mindestens 100 Zeichen');
        if (text.length > STIL_GRENZEN.referenz) {
          throw new OptimierFehler('EINGABE', `Referenztext: höchstens ${STIL_GRENZEN.referenz.toLocaleString('de-AT')} Zeichen`);
        }
        const k = await kiAufrufen(
          { wegId: weg.id, nutzerId: nutzerId(req), system: ABLEIT_SYSTEM, text, maxTokens: ABLEIT_MAX_TOKENS, erwarteteArt: 'lokal' },
          deps,
        ).catch(verworfenBuchen);
        antwort = k.text;
        ki = k;
      }
      await speicher.verbrauchMerken(ki.modell, ki.eingabeToken, ki.ausgabeToken, ki.kostenUsd, ki.dauerMs).catch(() => {
        console.warn('[Textwerkstatt] Verbrauch des Ableitens nicht gespeichert');
      });
      const a = ableitungLesen(antwort);
      const einst = await schutz.laden().catch(() => null);
      res.json({
        beschreibung: a.beschreibung,
        beispiele: a.beispiele,
        erkannt: a.erkannt,
        abgeschnitten: ki.abgeschnitten,
        cloud: einst ? stilCloudBefund(a, einst) : null,
        weg: { id: weg.id, art: weg.art, modell: weg.modell },
        ki: { dauerMs: ki.dauerMs, eingabeToken: ki.eingabeToken, ausgabeToken: ki.ausgabeToken, kostenUsd: ki.kostenUsd },
      });
    } catch (err) {
      fehlerAntwort(res, err);
    }
  });

  return router;
}

export default textwerkstattRouter();
