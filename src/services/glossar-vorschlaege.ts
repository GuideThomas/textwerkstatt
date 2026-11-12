/**
 * Vorschläge zum Glossar: Nicht-Admins schlagen vor, Admins geben frei (Plan `PLAN-glossar-freigabe.md`, Cockpit #1874,
 * Entscheid Thomas 12.11.2026; widerruft „jeder Angemeldete gibt frei“ vom 10.11.2026).
 *
 * 🚨 Ein Nicht-Admin schreibt nie in `glossary_entries`, `glossary_entry_channels` oder `glossary_entry_gruppen`. Jeder Schreibweg
 * ruft für ihn `reicheEin` auf, und nur das. Bis zur Freigabe gilt der alte Stand, auch für DeepL und `wortliste_freigegeben`.
 * Die Freigabe (`routes/glossar-vorschlaege.ts`) führt den Vorschlag mit demselben Code aus, mit dem ein Admin direkt schreibt.
 *
 * Wer zweimal speichert, ergänzt seinen offenen Vorschlag zum selben Ziel (Index aus Migration 048), statt einen zweiten anzulegen.
 * Den Verlauf (`glossary_entry_history`, Feld `vorschlag`) schreibt diese Datei für Einreichen und Entscheid; die Änderung selbst
 * vermerken bei der Freigabe die Trigger aus Migration 037, mit dem Admin als Bearbeiter und dem Vorschlagenden im Namen.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { alsBearbeiter, type Bearbeiter } from '../db/bearbeiter';
import { config } from '../config';

export type Weg = 'neu' | 'eintrag' | 'channel' | 'wortliste' | 'gruppe';
export type Quelle = 'glossar' | 'quickadd' | 'review' | 'terminologie-scan';

type Abfrage = Pick<PoolClient, 'query'>;

/** Rolle der angemeldeten Person. `requireAuth` setzt `req.user` aus der Datenbank, nie aus der Anfrage. */
export function istAdmin(req: unknown): boolean {
  return (req as { user?: { role?: string } }).user?.role === 'admin';
}

/**
 * Schreibt diese Person direkt ins Glossar, statt vorzuschlagen? Admins immer; bei `GLOSSAR_FREIGABE=alle` (Demo) jede angemeldete
 * Person. Jeder Schreibweg fragt hier, nicht nach der Rolle (`PLAN-oeffentlich-und-demo.md` Phase 2). Löschen regelt
 * `requireLoeschRecht` (`middleware/glossar-recht.ts`), denn dort gilt bei `alle` eine Schranke mehr.
 */
export function schreibtDirekt(req: unknown): boolean {
  if (istAdmin(req)) return true;
  return config.glossarFreigabe === 'alle' && !!(req as { user?: { id?: string } }).user?.id;
}

export interface Einreichung {
  glossaryId: string;
  /** Leer nur bei `neu`. */
  entryId: string | null;
  weg: Weg;
  /** Channel-Code, Produktgruppe oder `begriff` (Umbenennen); sonst leer. */
  schluessel?: string;
  sourceTerm: string;
  daten: Record<string, unknown>;
  quelle: Quelle;
}

/** Ein Wert für den Verlauf, kurz. */
function alsText(wert: unknown): string {
  if (wert === null || wert === undefined || wert === '') return '–';
  if (typeof wert === 'boolean') return wert ? 'ja' : 'nein';
  if (typeof wert === 'object') return JSON.stringify(wert);
  return String(wert);
}

const FELDNAME: Record<string, string> = {
  target_term: 'Ziel', source_term: 'Begriff', context: 'Kontext', category: 'Kategorie', channel_code: 'Channel',
  art: 'Art', wortart: 'Wortart', genus: 'Genus', formen: 'Formen', ziel_name: 'Ziel im Namen', an_deepl: 'an DeepL',
};

/** Der Vorschlag in einer Zeile, für den Verlauf: `Ziel: Lichtleiste · Kontext: –`. */
export function beschreibe(weg: Weg, schluessel: string, daten: Record<string, unknown>): string {
  const teile = Object.entries(daten)
    .filter(([k]) => k in FELDNAME)
    .map(([k, v]) => `${FELDNAME[k]}: ${alsText(v)}`);
  const ort = weg === 'channel' ? `${schluessel} ` : weg === 'gruppe' ? `Gruppe ${schluessel} ` : weg === 'neu' ? 'neu ' : '';
  return `${ort}${teile.join(' · ')}`.trim();
}

/** Der Stand der vorgeschlagenen Felder in der Zeile, wie er gerade gilt. `null` bei `neu`. */
export async function standDerFelder(
  q: Abfrage,
  v: { entryId: string | null; weg: Weg; schluessel: string; daten: Record<string, unknown> },
): Promise<Record<string, unknown> | null> {
  if (v.weg === 'neu' || !v.entryId) return null;
  if (v.weg === 'channel') {
    const r = await q.query<{ target_term: string }>(
      `SELECT target_term FROM glossary_entry_channels WHERE entry_id = $1 AND channel_code = $2`, [v.entryId, v.schluessel]);
    return { target_term: r.rows[0]?.target_term ?? null };
  }
  if (v.weg === 'gruppe') {
    const r = await q.query<{ target_term: string; genus: string | null }>(
      `SELECT target_term, genus FROM glossary_entry_gruppen WHERE entry_id = $1 AND produktgruppe = $2`,
      [v.entryId, Number(v.schluessel)]);
    return { target_term: r.rows[0]?.target_term ?? null, genus: r.rows[0]?.genus ?? null };
  }
  const r = await q.query<Record<string, unknown>>(`SELECT * FROM glossary_entries WHERE id = $1`, [v.entryId]);
  const zeile = r.rows[0];
  if (!zeile) return null;
  const stand: Record<string, unknown> = {};
  for (const k of Object.keys(v.daten)) stand[k] = zeile[k] ?? null;
  return stand;
}

/**
 * Legt einen Vorschlag an oder ergänzt den offenen derselben Person zum selben Ziel. Ändert nichts am Glossar.
 * `vorher` hält beim Ergänzen den ersten Stand fest, nicht den zwischendurch.
 */
export async function reicheEin(e: Einreichung, wer: Bearbeiter): Promise<{ id: number; ergaenzt: boolean }> {
  const schluessel = e.schluessel ?? '';
  return alsBearbeiter(wer, async (c) => {
    const vorher = await standDerFelder(c, { entryId: e.entryId, weg: e.weg, schluessel, daten: e.daten });
    const r = await c.query<{ id: string; ergaenzt: boolean; daten: Record<string, unknown> }>(
      `INSERT INTO glossar_vorschlag (glossary_id, entry_id, weg, schluessel, source_term, daten, vorher, quelle, von_id, von)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       ON CONFLICT (glossary_id, (COALESCE(entry_id::text, lower(btrim(source_term)))), weg, schluessel, (COALESCE(von_id::text, von)))
         WHERE status = 'offen'
       DO UPDATE SET daten = glossar_vorschlag.daten || EXCLUDED.daten,
                     vorher = COALESCE(EXCLUDED.vorher, '{}'::jsonb) || COALESCE(glossar_vorschlag.vorher, '{}'::jsonb),
                     quelle = EXCLUDED.quelle, geaendert_am = NOW(), fassung = glossar_vorschlag.fassung + 1
       RETURNING id, (xmax <> 0) AS ergaenzt, daten`,
      [e.glossaryId, e.entryId, e.weg, schluessel, e.sourceTerm.trim(), JSON.stringify(e.daten),
        vorher === null ? null : JSON.stringify(vorher), e.quelle,
        wer.id, (wer.name ?? '').trim() || 'unbekannt'],
    );
    const z = r.rows[0];
    await c.query(`SELECT wortliste_verlauf_schreiben($1, $2, $3, 'vorschlag', 'vorschlag', $4, $5)`, [
      e.entryId, e.glossaryId, e.sourceTerm.trim(),
      vorher === null ? null : beschreibe(e.weg, schluessel, vorher),
      beschreibe(e.weg, schluessel, z.daten),
    ]);
    return { id: Number(z.id), ergaenzt: z.ergaenzt };
  });
}

export interface VorschlagZeile {
  id: number;
  glossary_id: string;
  entry_id: string | null;
  weg: Weg;
  schluessel: string;
  source_term: string;
  daten: Record<string, unknown>;
  vorher: Record<string, unknown> | null;
  quelle: Quelle;
  von_id: string | null;
  von: string;
  am: string;
  fassung: number;
  status: 'offen' | 'in_arbeit' | 'freigegeben' | 'verworfen';
  entschieden_von: string | null;
  entschieden_am: string | null;
}

export async function ladeVorschlag(glossaryId: string, id: string, q: Abfrage = pool): Promise<VorschlagZeile | null> {
  if (!/^\d{1,18}$/u.test(id)) return null;
  const r = await q.query<VorschlagZeile>(
    `SELECT * FROM glossar_vorschlag WHERE id = $1 AND glossary_id = $2`, [id, glossaryId]);
  return r.rows[0] ? { ...r.rows[0], id: Number(r.rows[0].id) } : null;
}

/** Die Vorschläge eines Glossars, jeder mit dem Stand von jetzt (`aktuell`) zum Gegenüberstellen. */
export async function listeVorschlaege(glossaryId: string, status: 'offen' | 'entschieden', limit = 200): Promise<Array<VorschlagZeile & { aktuell: Record<string, unknown> | null }>> {
  const r = await pool.query<VorschlagZeile>(
    `SELECT * FROM glossar_vorschlag
      WHERE glossary_id = $1 AND (CASE WHEN $2 = 'offen' THEN status IN ('offen', 'in_arbeit') ELSE status IN ('freigegeben', 'verworfen') END)
      ORDER BY ${status === 'offen' ? 'am ASC' : 'entschieden_am DESC'}, id
      LIMIT $3`,
    [glossaryId, status, limit],
  );
  const aus: Array<VorschlagZeile & { aktuell: Record<string, unknown> | null }> = [];
  for (const v of r.rows) {
    const aktuell = await standDerFelder(pool, { entryId: v.entry_id, weg: v.weg, schluessel: v.schluessel, daten: v.daten });
    aus.push({ ...v, id: Number(v.id), aktuell });
  }
  return aus;
}

/** Ein Vorschlag, der in Arbeit hängen blieb (Absturz zwischen Beanspruchen und Wirkung), gilt nach dieser Zeit wieder als offen. */
const HAENGT_NACH = "interval '10 minutes'";

/**
 * Beansprucht einen offenen Vorschlag für einen Entscheid, in einem Schritt: Nur einer gewinnt, ein zweiter Admin bekommt `null`.
 * `fassung` ist die, die der Admin gesehen hat; hat der Vorschlagende inzwischen ergänzt, wird nicht entschieden (`null`).
 * `verworfen` ist damit schon fertig, samt Verlauf; `in_arbeit` schließt `schliesseFreigabe` ab oder `gibZurueck` löst es.
 */
export async function beanspruche(
  glossaryId: string, id: string, fassung: number | null, ziel: 'in_arbeit' | 'verworfen', wer: Bearbeiter,
): Promise<VorschlagZeile | null> {
  if (!/^\d{1,18}$/u.test(id)) return null;
  return alsBearbeiter(wer, async (c) => {
    const r = await c.query<VorschlagZeile>(
      `UPDATE glossar_vorschlag
          SET status = $3, entschieden_von = $4, entschieden_von_id = $5, entschieden_am = NOW()
        WHERE id = $1 AND glossary_id = $2 AND ($6::int IS NULL OR fassung = $6::int)
          AND (status = 'offen' OR (status = 'in_arbeit' AND entschieden_am < NOW() - ${HAENGT_NACH}))
        RETURNING *`,
      [id, glossaryId, ziel, (wer.name ?? '').trim() || 'unbekannt', wer.id, fassung],
    );
    const v = r.rows[0] ? { ...r.rows[0], id: Number(r.rows[0].id) } : null;
    if (v && ziel === 'verworfen') {
      await c.query(`SELECT wortliste_verlauf_schreiben($1, $2, $3, 'vorschlag', 'verworfen', $4, $5)`, [
        v.entry_id, v.glossary_id, v.source_term, `von ${v.von}`, beschreibe(v.weg, v.schluessel, v.daten)]);
      await zieheKandidatNach(c, v, 'rejected', null);
    }
    return v;
  });
}

/** Schließt eine gelungene Freigabe ab: Status, Verlauf, ein Scan-Kandidat dazu. */
export async function schliesseFreigabe(v: VorschlagZeile, wer: Bearbeiter, entryId: string | null): Promise<void> {
  await alsBearbeiter(wer, async (c) => {
    await c.query(
      `UPDATE glossar_vorschlag SET status = 'freigegeben', entschieden_am = NOW() WHERE id = $1 AND status = 'in_arbeit'`, [v.id]);
    await c.query(`SELECT wortliste_verlauf_schreiben($1, $2, $3, 'vorschlag', 'freigabe', $4, $5)`, [
      entryId, v.glossary_id, v.source_term, `von ${v.von}`, beschreibe(v.weg, v.schluessel, v.daten)]);
    await zieheKandidatNach(c, v, 'approved', entryId);
  });
}

/** Gibt einen beanspruchten Vorschlag zurück, wenn die Wirkung scheiterte: Er bleibt offen, wie vorher. */
export async function gibZurueck(v: VorschlagZeile): Promise<void> {
  await pool.query(
    `UPDATE glossar_vorschlag SET status = 'offen', entschieden_von = NULL, entschieden_von_id = NULL, entschieden_am = NULL
      WHERE id = $1 AND status = 'in_arbeit'`, [v.id]);
}

/** Ein Kandidat des Terminologie-Scans folgt dem Entscheid über seinen Vorschlag, sonst hinge er auf `vorgeschlagen`. */
async function zieheKandidatNach(c: Abfrage, v: VorschlagZeile, status: 'approved' | 'rejected', entryId: string | null): Promise<void> {
  const kandidat = typeof v.daten.kandidat_id === 'string' ? v.daten.kandidat_id : null;
  if (v.quelle !== 'terminologie-scan' || !kandidat) return;
  await c.query(
    `UPDATE terminology_candidates SET status = $2, glossary_entry_id = COALESCE($3, glossary_entry_id)
      WHERE id = $1 AND status = 'vorgeschlagen'`, [kandidat, status, entryId ?? v.entry_id]);
}

/** Ein Channel-Code, den es gibt. Ein unbekannter scheiterte sonst erst bei der Freigabe am Fremdschlüssel. */
export async function kanalBekannt(code: string): Promise<boolean> {
  return (await pool.query(`SELECT 1 FROM channels WHERE code = $1`, [code])).rows.length > 0;
}

/** Der Bearbeiter, unter dem eine Freigabe schreibt: der Admin, mit dem Vorschlagenden im Namen. So nennt der Verlauf beide. */
export function freigabeBearbeiter(admin: Bearbeiter, v: VorschlagZeile): Bearbeiter {
  return { id: admin.id, name: `${admin.name ?? 'unbekannt'} (Vorschlag von ${v.von})` };
}

export type BegriffVorschlag =
  | { status: 'unveraendert'; entry_id: string }
  | { status: 'vorschlag'; vorschlag_id: number; entry_id: string | null; ergaenzt: boolean };

/**
 * Ein Begriff mit Übersetzung als Vorschlag, für Wege ohne Zeilenbezug (Quickadd, Review, Terminologie-Scan). Gibt es den Begriff im
 * Glossar schon, wird es ein Vorschlag zu dessen Ziel (`eintrag`), sonst ein neuer Begriff (`neu`). Gleiches Ziel: nichts zu tun.
 * Bei Dubletten gilt die gefüllte, älteste Zeile, wie überall in `glossar-pflege.ts`.
 */
export async function schlageBegriffVor(
  p: {
    glossaryId: string; sourceTerm: string; targetTerm: string; context?: string | null; category?: string | null;
    channelCode?: string | null; quelle: Quelle; kandidatId?: string;
  },
  wer: Bearbeiter,
): Promise<BegriffVorschlag> {
  const r = await pool.query<{ id: string; source_term: string; target_term: string | null }>(
    `SELECT id, source_term, target_term FROM glossary_entries
      WHERE glossary_id = $1 AND lower(btrim(source_term)) = lower(btrim($2))
      ORDER BY (target_term IS NULL), created_at, id LIMIT 1`,
    [p.glossaryId, p.sourceTerm],
  );
  const z = r.rows[0];
  // Die Scan-Kandidaten folgen dem Entscheid (`zieheKandidatNach`); dafür trägt der Vorschlag die Nummer mit.
  const herkunft: Record<string, unknown> = p.kandidatId ? { kandidat_id: p.kandidatId } : {};
  if (z && p.channelCode && z.target_term !== null) {
    const k = await pool.query<{ target_term: string }>(
      `SELECT target_term FROM glossary_entry_channels WHERE entry_id = $1 AND channel_code = $2`, [z.id, p.channelCode]);
    if (k.rows[0]?.target_term === p.targetTerm) return { status: 'unveraendert', entry_id: z.id };
    const v = await reicheEin({ glossaryId: p.glossaryId, entryId: z.id, weg: 'channel', schluessel: p.channelCode,
      sourceTerm: z.source_term, daten: { target_term: p.targetTerm, ...herkunft }, quelle: p.quelle }, wer);
    return { status: 'vorschlag', vorschlag_id: v.id, entry_id: z.id, ergaenzt: v.ergaenzt };
  }
  if (z) {
    if (z.target_term === p.targetTerm) return { status: 'unveraendert', entry_id: z.id };
    const v = await reicheEin({ glossaryId: p.glossaryId, entryId: z.id, weg: 'eintrag', sourceTerm: z.source_term,
      daten: { target_term: p.targetTerm, ...herkunft }, quelle: p.quelle }, wer);
    return { status: 'vorschlag', vorschlag_id: v.id, entry_id: z.id, ergaenzt: v.ergaenzt };
  }
  const daten: Record<string, unknown> = { target_term: p.targetTerm, ...herkunft };
  if (p.context) daten.context = p.context;
  if (p.category) daten.category = p.category;
  if (p.channelCode) daten.channel_code = p.channelCode;
  const v = await reicheEin({ glossaryId: p.glossaryId, entryId: null, weg: 'neu', sourceTerm: p.sourceTerm, daten, quelle: p.quelle }, wer);
  return { status: 'vorschlag', vorschlag_id: v.id, entry_id: null, ergaenzt: v.ergaenzt };
}

/** Das Glossar eines Sprachpaars, für Nicht-Admins ohne Anlegen: Ein neues Glossar legt nur ein Admin an. */
export async function glossarDesSprachpaars(sourceLang: string, targetLang: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM glossaries WHERE source_lang = $1 AND target_lang = $2 ORDER BY created_at, id LIMIT 1`, [sourceLang, targetLang]);
  return r.rows[0]?.id ?? null;
}

export const KEIN_GLOSSAR = 'Für dieses Sprachpaar gibt es noch kein Glossar. Anlegen kann es ein Admin.';

/** Offene Vorschläge je Zeile eines Glossars, für die Markierung in der Liste. */
export const VORSCHLAEGE_JE_ZEILE = `(SELECT count(*)::int FROM glossar_vorschlag gv WHERE gv.entry_id = ge.id AND gv.status = 'offen')`;
