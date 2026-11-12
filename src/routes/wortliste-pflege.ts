/**
 * Pflege der Wortliste auf der Glossarseite (PLAN-wortliste.md §2.7, Phase 5, Cockpit #1833).
 *
 * Unter `/api/glossaries`, neben `routes/glossaries.ts`. Jeder Weg nennt den Bearbeiter in seiner Transaktion, den Verlauf schreiben
 * die Trigger (Migration 037, die Rückfrage 039), die Namensfassung zählt der Trigger aus 038.
 *
 *   PUT    /:id/entries/:entryId/wortliste          Art, Wortart, Genus, Formen, ziel_name, an_deepl
 *   PUT    /:id/entries/:entryId/gruppen/:gruppe    Ziel je Produktgruppe anlegen oder ändern
 *   DELETE /:id/entries/:entryId/gruppen/:gruppe    Ziel je Produktgruppe entfernen
 *   PUT    /:id/entries/:entryId/rueckfrage         Rückfrage stellen, ändern oder mit leerem Text lösen (nur offene Zeilen)
 *   POST   /:id/entries/:entryId/ablehnen           offene Zeile entfernen, Spur in `wortliste_abgelehnt`
 *
 * 🚨 Seit 12.11.2026 (PLAN-glossar-freigabe.md): Ein Nicht-Admin schreibt hier nur Vorschläge (`reicheEin`); Ablehnen nur Admins,
 * die Rückfrage bleibt für alle. Die Wirkungen (`wendeWortlisteAn`, `setzeGruppenziel`) ruft auch die Freigabe eines Vorschlags auf.
 *
 * 🚨 Nur `an_deepl` ändert, was an DeepL geht: Ein Wechsel erhöht die Glossarversion (Abgleich und Cache), alles andere wirkt nur in
 * Namen. `ziel_name`, Formen und Gruppenziele gehen nie an DeepL (§2.3).
 */
import { Router, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { alsBearbeiter, bearbeiterAusAnfrage, type Bearbeiter } from '../db/bearbeiter';
import { requireLoeschRecht } from '../middleware/glossar-recht';
import { schreibtDirekt, reicheEin } from '../services/glossar-vorschlaege';
import { incrementGlossaryVersion } from '../services/glossar-pflege';

const router = Router();

const ARTEN = new Set(['wort', 'muster', 'wendung', 'fest']);
const WORTARTEN = new Set(['hauptwort', 'adjektiv', 'sonstiges']);
const GENERA = new Set(['m', 'f', 'n']);

interface Zeile {
  id: string;
  glossary_id: string;
  source_term: string;
  target_term: string | null;
  approved: boolean | null;
  art: string;
  an_deepl: boolean;
  wortart: string | null;
  genus: string | null;
  formen: Record<string, string> | null;
  ziel_name: string | null;
}

class Ungueltig extends Error {}

async function ladeZeile(q: Pick<PoolClient, 'query'>, glossaryId: string, entryId: string, sperren = false): Promise<Zeile | null> {
  const r = await q.query<Zeile>(
    `SELECT id, glossary_id, source_term, target_term, approved, art, an_deepl, wortart, genus, formen, ziel_name
       FROM glossary_entries WHERE id = $1 AND glossary_id = $2${sperren ? ' FOR UPDATE' : ''}`,
    [entryId, glossaryId],
  );
  return r.rows[0] ?? null;
}

function textOderNull(wert: unknown, feld: string): string | null {
  if (wert === null) return null;
  if (typeof wert !== 'string') throw new Ungueltig(`${feld} muss Text oder leer sein`);
  const t = wert.trim();
  return t === '' ? null : t;
}

function aus(menge: Set<string>, wert: unknown, feld: string, leerErlaubt: boolean): string | null {
  if (wert === null || wert === '') {
    if (leerErlaubt) return null;
    throw new Ungueltig(`${feld} darf nicht leer sein`);
  }
  if (typeof wert !== 'string' || !menge.has(wert)) throw new Ungueltig(`${feld} muss eine von ${[...menge].join(', ')} sein`);
  return wert;
}

function formenAus(wert: unknown): Record<string, string> | null {
  if (wert === null) return null;
  if (typeof wert !== 'object' || Array.isArray(wert)) throw new Ungueltig('formen muss ein Objekt sein, z. B. {"m": "…", "f": "…"}');
  const aus: Record<string, string> = {};
  for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
    if (!GENERA.has(k)) throw new Ungueltig(`Form „${k}“ unbekannt, erlaubt sind m, f, n`);
    if (typeof v !== 'string') throw new Ungueltig(`Form „${k}“ muss Text sein`);
    if (v.trim() !== '') aus[k] = v.trim();
  }
  return Object.keys(aus).length > 0 ? aus : null;
}

function antwortFehler(res: Response, err: unknown, was: string) {
  if (err instanceof Ungueltig) return res.status(400).json({ error: err.message });
  const pg = err as { code?: string; constraint?: string };
  // Die CHECKs aus Migration 036 sind die letzte Schicht; die Prüfung oben soll sie nie erreichen lassen.
  if (pg.code === '23514') return res.status(400).json({ error: 'Die Angaben passen nicht zusammen', constraint: pg.constraint });
  console.error(`Wortliste: ${was}:`, err);
  return res.status(500).json({ error: `${was} fehlgeschlagen` });
}

/** Ergebnis einer Wirkung: Statuscode und Antwort, gleich für die Route und die Freigabe eines Vorschlags. */
export interface Wirkung {
  code: number;
  body: Record<string, unknown>;
}

/** Fehler einer Wirkung als Antwort; ein unbekannter Fehler geht weiter an den Aufrufer. */
function alsWirkung(err: unknown): Wirkung {
  if (err instanceof Ungueltig) return { code: 400, body: { error: err.message } };
  const pg = err as { code?: string; constraint?: string };
  if (pg.code === '23514') return { code: 400, body: { error: 'Die Angaben passen nicht zusammen', constraint: pg.constraint } };
  throw err;
}

const WORTLISTE_FELDER = ['art', 'wortart', 'genus', 'formen', 'ziel_name', 'an_deepl'] as const;

/** Der neue Stand der Wortlisten-Felder aus `b`. Wirft `Ungueltig`; schreibt nichts. */
function berechneWortliste(vorher: Zeile, b: Record<string, unknown>): Zeile {
  const neu = { ...vorher };
  if ('art' in b) neu.art = aus(ARTEN, b.art, 'art', false)!;
  if ('wortart' in b) neu.wortart = aus(WORTARTEN, b.wortart, 'wortart', true);
  if ('genus' in b) neu.genus = aus(GENERA, b.genus, 'genus', true);
  if ('formen' in b) neu.formen = formenAus(b.formen);
  if ('ziel_name' in b) neu.ziel_name = textOderNull(b.ziel_name, 'ziel_name');
  if ('an_deepl' in b) {
    if (typeof b.an_deepl !== 'boolean') throw new Ungueltig('an_deepl muss ja oder nein sein');
    neu.an_deepl = b.an_deepl;
  }
  // Was nicht mehr passt, fällt mit: Genus nur am Hauptwort, Formen nur am Adjektiv, ein Muster nie an DeepL.
  if (neu.wortart !== 'hauptwort') neu.genus = null;
  if (neu.wortart !== 'adjektiv') neu.formen = null;
  if (neu.art === 'muster') {
    if ('an_deepl' in b && b.an_deepl === true) throw new Ungueltig('Ein Muster geht nie an DeepL');
    neu.an_deepl = false;
  }
  if (neu.ziel_name !== null && neu.ziel_name === neu.target_term) neu.ziel_name = null;
  return neu;
}

/** Die Wirkung von `PUT …/wortliste`, für Admins und die Freigabe. */
export async function wendeWortlisteAn(glossaryId: string, entryId: string, b: Record<string, unknown>, wer: Bearbeiter): Promise<Wirkung> {
  try {
    const ergebnis = await alsBearbeiter(wer, async (c) => {
      const vorher = await ladeZeile(c, glossaryId, entryId, true);
      if (!vorher) return null;
      const neu = berechneWortliste(vorher, b);
      const r = await c.query<Zeile>(
        `UPDATE glossary_entries
            SET art = $3, wortart = $4, genus = $5, formen = $6::jsonb, ziel_name = $7, an_deepl = $8
          WHERE id = $1 AND glossary_id = $2
          RETURNING *`,
        [vorher.id, vorher.glossary_id, neu.art, neu.wortart, neu.genus, neu.formen === null ? null : JSON.stringify(neu.formen),
          neu.ziel_name, neu.an_deepl],
      );
      // Nur eine freigegebene Zeile mit Ziel steht in `glossar_an_deepl`; nur dann ändert der Schalter, was an DeepL geht.
      if (vorher.an_deepl !== neu.an_deepl && vorher.approved === true && vorher.target_term !== null) {
        await incrementGlossaryVersion(vorher.glossary_id, [vorher.source_term], c);
      }
      return r.rows[0];
    });
    if (!ergebnis) return { code: 404, body: { error: 'Entry not found' } };
    return { code: 200, body: ergebnis as unknown as Record<string, unknown> };
  } catch (err) {
    return alsWirkung(err);
  }
}

/** Wortlisten-Felder eines Nicht-Admins: geprüft wie der direkte Weg, gespeichert nur als Vorschlag. */
async function wortlisteAlsVorschlag(req: Request, glossaryId: string, entryId: string, b: Record<string, unknown>): Promise<Wirkung> {
  try {
    const vorher = await ladeZeile(pool, glossaryId, entryId);
    if (!vorher) return { code: 404, body: { error: 'Entry not found' } };
    const neu = berechneWortliste(vorher, b);
    const daten: Record<string, unknown> = {};
    for (const k of WORTLISTE_FELDER) if (k in b) daten[k] = b[k];
    const geaendert = WORTLISTE_FELDER.some((k) => JSON.stringify(neu[k]) !== JSON.stringify(vorher[k]));
    if (!geaendert) return { code: 200, body: { ...vorher, unveraendert: true } };
    const v = await reicheEin({ glossaryId, entryId, weg: 'wortliste', sourceTerm: vorher.source_term, daten, quelle: 'glossar' },
      bearbeiterAusAnfrage(req));
    return { code: 201, body: { vorschlag: true, vorschlag_id: v.id, entry_id: entryId } };
  } catch (err) {
    return alsWirkung(err);
  }
}

router.put('/:id/entries/:entryId/wortliste', async (req: Request<{ id: string; entryId: string }>, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    const w = schreibtDirekt(req)
      ? await wendeWortlisteAn(req.params.id, req.params.entryId, b, bearbeiterAusAnfrage(req))
      : await wortlisteAlsVorschlag(req, req.params.id, req.params.entryId, b);
    res.status(w.code).json(w.body);
  } catch (err) {
    antwortFehler(res, err, 'Wortliste speichern');
  }
});

function gruppeAus(roh: string): number {
  if (!/^\d{1,4}$/u.test(roh)) throw new Ungueltig('Die Produktgruppe muss eine ganze Zahl sein');
  return Number(roh);
}

/** Gruppenziel setzen (`ziel`) oder entfernen (`null`), für Admins und die Freigabe. */
export async function setzeGruppenziel(
  glossaryId: string, entryId: string, gruppe: number, ziel: string | null, genus: string | null, wer: Bearbeiter,
): Promise<Wirkung> {
  try {
    if (ziel === null) {
      const weg = await alsBearbeiter(wer, (c) => c.query(
        `DELETE FROM glossary_entry_gruppen g USING glossary_entries e
          WHERE g.entry_id = e.id AND e.id = $1 AND e.glossary_id = $2 AND g.produktgruppe = $3`,
        [entryId, glossaryId, gruppe],
      ));
      if ((weg.rowCount ?? 0) === 0) return { code: 404, body: { error: 'Gruppenziel nicht gefunden' } };
      return { code: 200, body: { deleted: true } };
    }
    const ergebnis = await alsBearbeiter(wer, async (c) => {
      const z = await ladeZeile(c, glossaryId, entryId, true);
      if (!z) return null;
      const r = await c.query(
        `INSERT INTO glossary_entry_gruppen (entry_id, produktgruppe, target_term, genus)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (entry_id, produktgruppe)
         DO UPDATE SET target_term = EXCLUDED.target_term, genus = EXCLUDED.genus, updated_at = NOW()
         RETURNING entry_id, produktgruppe, target_term, genus`,
        [z.id, gruppe, ziel, genus],
      );
      return r.rows[0];
    });
    if (!ergebnis) return { code: 404, body: { error: 'Entry not found' } };
    return { code: 200, body: ergebnis };
  } catch (err) {
    return alsWirkung(err);
  }
}

/** Gruppenziel eines Nicht-Admins als Vorschlag. Entfernen schlägt er nur vor, wo es ein Ziel gibt. */
async function gruppeAlsVorschlag(
  req: Request, glossaryId: string, entryId: string, gruppe: number, ziel: string | null, genus: string | null,
): Promise<Wirkung> {
  const z = await ladeZeile(pool, glossaryId, entryId);
  if (!z) return { code: 404, body: { error: 'Entry not found' } };
  const jetzt = await pool.query<{ target_term: string; genus: string | null }>(
    `SELECT target_term, genus FROM glossary_entry_gruppen WHERE entry_id = $1 AND produktgruppe = $2`, [entryId, gruppe]);
  const alt = jetzt.rows[0] ?? null;
  if (ziel === null && !alt) return { code: 404, body: { error: 'Gruppenziel nicht gefunden' } };
  if (ziel !== null && alt && alt.target_term === ziel && (alt.genus ?? null) === genus) {
    return { code: 200, body: { entry_id: entryId, produktgruppe: gruppe, target_term: ziel, genus, unveraendert: true } };
  }
  const daten: Record<string, unknown> = ziel === null ? { target_term: null } : { target_term: ziel, genus };
  const v = await reicheEin({ glossaryId, entryId, weg: 'gruppe', schluessel: String(gruppe), sourceTerm: z.source_term, daten,
    quelle: 'glossar' }, bearbeiterAusAnfrage(req));
  return { code: 201, body: { vorschlag: true, vorschlag_id: v.id, entry_id: entryId } };
}

router.put('/:id/entries/:entryId/gruppen/:gruppe', async (req: Request<{ id: string; entryId: string; gruppe: string }>, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    const gruppe = gruppeAus(req.params.gruppe);
    const ziel = textOderNull(b.target_term ?? null, 'target_term');
    if (ziel === null) throw new Ungueltig('Das Ziel der Gruppe darf nicht leer sein; zum Entfernen DELETE');
    const genus = 'genus' in b ? aus(GENERA, b.genus, 'genus', true) : null;
    const w = schreibtDirekt(req)
      ? await setzeGruppenziel(req.params.id, req.params.entryId, gruppe, ziel, genus, bearbeiterAusAnfrage(req))
      : await gruppeAlsVorschlag(req, req.params.id, req.params.entryId, gruppe, ziel, genus);
    res.status(w.code).json(w.body);
  } catch (err) {
    antwortFehler(res, err, 'Gruppenziel speichern');
  }
});

router.delete('/:id/entries/:entryId/gruppen/:gruppe', async (req: Request<{ id: string; entryId: string; gruppe: string }>, res: Response) => {
  try {
    const gruppe = gruppeAus(req.params.gruppe);
    const w = schreibtDirekt(req)
      ? await setzeGruppenziel(req.params.id, req.params.entryId, gruppe, null, null, bearbeiterAusAnfrage(req))
      : await gruppeAlsVorschlag(req, req.params.id, req.params.entryId, gruppe, null, null);
    res.status(w.code).json(w.body);
  } catch (err) {
    antwortFehler(res, err, 'Gruppenziel entfernen');
  }
});

router.put('/:id/entries/:entryId/rueckfrage', async (req: Request<{ id: string; entryId: string }>, res: Response) => {
  const wer = bearbeiterAusAnfrage(req);
  try {
    const text = textOderNull((req.body ?? {}).text ?? null, 'text');
    const ergebnis = await alsBearbeiter(wer, async (c) => {
      const z = await ladeZeile(c, req.params.id, req.params.entryId, true);
      if (!z) return { status: 404 as const };
      if (z.approved === true && text !== null) return { status: 409 as const };
      if (text === null) {
        await c.query(
          `UPDATE wortliste_vorschlag SET rueckfrage = NULL, rueckfrage_von = NULL, rueckfrage_am = NULL, geaendert_am = NOW()
            WHERE entry_id = $1 AND rueckfrage IS NOT NULL`,
          [z.id],
        );
      } else {
        // Eine offene Zeile ohne Herkunft (Plus, Quickadd) bekommt hier ihre erste: das Glossar selbst.
        await c.query(
          `INSERT INTO wortliste_vorschlag (entry_id, quelle, rueckfrage, rueckfrage_von, rueckfrage_am)
           VALUES ($1, 'glossar', $2, $3, NOW())
           ON CONFLICT (entry_id) DO UPDATE
             SET rueckfrage = EXCLUDED.rueckfrage, rueckfrage_von = EXCLUDED.rueckfrage_von,
                 rueckfrage_am = EXCLUDED.rueckfrage_am, geaendert_am = NOW()`,
          [z.id, text, wer.name ?? 'unbekannt'],
        );
      }
      return { status: 200 as const };
    });
    if (ergebnis.status === 404) return res.status(404).json({ error: 'Entry not found' });
    if (ergebnis.status === 409) return res.status(409).json({ error: 'Eine Rückfrage gibt es nur an offenen Zeilen' });
    res.json({ entry_id: req.params.entryId, rueckfrage: text });
  } catch (err) {
    antwortFehler(res, err, 'Rückfrage speichern');
  }
});

router.post('/:id/entries/:entryId/ablehnen', requireLoeschRecht, async (req: Request<{ id: string; entryId: string }>, res: Response) => {
  const wer = bearbeiterAusAnfrage(req);
  try {
    const anmerkung = textOderNull((req.body ?? {}).anmerkung ?? null, 'anmerkung');
    const ergebnis = await alsBearbeiter(wer, async (c) => {
      const z = await ladeZeile(c, req.params.id, req.params.entryId, true);
      if (!z) return 404;
      // Freigegebenes wird nicht abgelehnt, sondern gelöscht (eigener Weg mit Rückfrage auf der Seite).
      if (z.approved === true) return 409;
      await c.query(
        `INSERT INTO wortliste_abgelehnt (glossary_id, art, source_term, ziel, anmerkung, von)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (glossary_id, btrim(source_term))
         DO UPDATE SET art = EXCLUDED.art, ziel = EXCLUDED.ziel, anmerkung = EXCLUDED.anmerkung, von = EXCLUDED.von, am = NOW()`,
        [z.glossary_id, z.art, z.source_term, z.target_term, anmerkung, wer.name ?? 'unbekannt'],
      );
      // Den Verlauf (Zeile entfernt) schreibt der Trigger vor dem Löschen, mit diesem Bearbeiter.
      await c.query(`DELETE FROM glossary_entries WHERE id = $1`, [z.id]);
      return 200;
    });
    if (ergebnis === 404) return res.status(404).json({ error: 'Entry not found' });
    if (ergebnis === 409) return res.status(409).json({ error: 'Nur offene Zeilen lassen sich ablehnen' });
    res.json({ abgelehnt: true });
  } catch (err) {
    antwortFehler(res, err, 'Ablehnen');
  }
});

export default router;
