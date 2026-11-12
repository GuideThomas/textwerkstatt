import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { syncGlossaryToDeepL, getDeepLUsage, glossarZielsprachenBeiDeepL } from '../services/deepl';
import { normalizeGlossaryLang } from '../services/lang';
import {
  loescheZeile,
  benenneBegriffUm,
  holeDeeplVorschlag,
  entferneEintrag,
  legeBegriffAn,
  legeGlossarAn,
  incrementGlossaryVersion,
  staleMuster,
  type Bearbeiter,
} from '../services/glossar-pflege';
import {
  HINWEISE_ALS_JSON,
  HINWEIS_ZAHLEN,
  hinweisFilter,
  hinweisFilterGueltig,
  hinweisFacetten,
  hinweisVerwerfen,
  markiereFallsWieDeepL,
  entferneMarkierungenDerZeile,
} from '../services/glossar-hinweise';
import { config } from '../config';
import { alsBearbeiter } from '../db/bearbeiter';
import { requireAdmin } from '../middleware/auth';
import { requireGlossarRecht, requireLoeschRecht } from '../middleware/glossar-recht';
import {
  schreibtDirekt,
  reicheEin,
  schlageBegriffVor,
  glossarDesSprachpaars,
  kanalBekannt,
  KEIN_GLOSSAR,
  VORSCHLAEGE_JE_ZEILE,
} from '../services/glossar-vorschlaege';

// Bleiben von hier erreichbar: `review.ts` und `terminology-scan.ts` holen sie an dieser Stelle.
export { incrementGlossaryVersion, staleMuster };

// 🚨 Seit 12.11.2026 (PLAN-glossar-freigabe.md, Entscheid Thomas): Ein Nicht-Admin schreibt hier nie ins Glossar. Jeder Schreibweg
// reicht für ihn einen Vorschlag ein (`reicheEin`, Antwort 201 mit `vorschlag: true`); Freigeben, Verwerfen und Löschen nur Admins
// (`requireAdmin`). Die Wirkung eines Wegs steht deshalb in einer eigenen Funktion (`wendeEintragAn`, `setzeChannelWert`), die
// auch die Freigabe in `routes/glossar-vorschlaege.ts` aufruft.

/** Ergebnis einer Wirkung: Statuscode und Antwort, gleich für die Route und die Freigabe eines Vorschlags. */
export interface Wirkung {
  code: number;
  body: Record<string, unknown>;
}

const vorschlagAntwort = (id: number, extra: Record<string, unknown> = {}): Wirkung =>
  ({ code: 201, body: { vorschlag: true, vorschlag_id: id, ...extra } });

const router = Router();

interface AuthUser {
  id?: string;
  email?: string;
  display_name?: string | null;
  name?: string | null;
}

function resolveUserName(user: AuthUser | undefined): string | null {
  if (!user) return null;
  return user.display_name || user.name || user.email || null;
}

function bearbeiter(req: Request): Bearbeiter {
  const user = (req as any).user as AuthUser | undefined;
  return { id: user?.id ?? null, name: resolveUserName(user) };
}


/**
 * Schreibt einen Audit-Log-Eintrag für eine Glossar-Änderung.
 * field = 'standard' für den Standard-Zielbegriff, sonst Channel-Code (z. B. SHOPA).
 */
/**
 * Vergleicht eine gerade gespeicherte Übersetzung mit DeepL ohne Glossar. Darf das Speichern weder
 * aufhalten noch scheitern lassen: höchstens 5 Sekunden warten, ein Fehler landet nur im Log.
 */
async function pruefeGegenDeepL(glossaryId: string, sourceTerm: string, targetTerm: string): Promise<void> {
  if (!config.deepl.apiKey) return;
  const pruefung = markiereFallsWieDeepL({ glossaryId, sourceTerm, targetTerm }).catch((err: Error) => {
    console.error('[Glossary] Vergleich mit DeepL fehlgeschlagen:', err.message);
  });
  await Promise.race([pruefung, new Promise<void>((fertig) => setTimeout(fertig, 5000).unref())]);
}

// 🚨 Den Verlauf (`glossary_entry_history`) schreibt seit 10.11.2026 der Trigger aus Migration 037, nicht diese Datei. Jeder Schreibweg
// unten läuft deshalb in `alsBearbeiter(bearbeiter(req), …)`: Ohne den genannten Bearbeiter stünde `unbekannt` im Verlauf. Bis dahin
// schrieb `recordHistory` hier jede Zeile von Hand; Review-Quickadd und Terminologie-Scan hatten gar keinen (Plan Wortliste §2.6).

// Liste aller Sales-Channels (Tabelle channels, Füllung aus seeds/<installation>)
router.get('/channels', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT code, name, sort_order FROM channels ORDER BY sort_order, code`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing channels:', err);
    res.status(500).json({ error: 'Failed to list channels' });
  }
});

// Alle Glossare auflisten
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT g.*,
        -- Für die Auswahl im Terminologie-Scan: Was das Glossar kann, nicht wie viele Zeilen es hat.
        (SELECT COUNT(*) FROM glossary_entries ge WHERE ge.glossary_id = g.id AND ge.target_term IS NOT NULL) AS entry_count,
        (SELECT COUNT(*) FROM glossary_entries ge WHERE ge.glossary_id = g.id AND ge.target_term IS NULL) AS zu_pflegen
      FROM glossaries g
      ORDER BY g.source_lang, g.target_lang
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing glossaries:', err);
    res.status(500).json({ error: 'Failed to list glossaries' });
  }
});

// Glossar-Statistiken
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        g.id, g.name, g.source_lang, g.target_lang, g.version, g.synced_version, g.deepl_glossary_id,
        COUNT(ge.id) FILTER (WHERE ge.target_term IS NOT NULL) AS entry_count,
        COUNT(ge.id) FILTER (WHERE ge.target_term IS NULL) AS zu_pflegen,
        (SELECT count(*)::int FROM glossar_vorschlag gv WHERE gv.glossary_id = g.id AND gv.status = 'offen') AS vorschlaege,
        ${HINWEIS_ZAHLEN},
        g.created_at, g.updated_at
      FROM glossaries g
      LEFT JOIN glossary_entries ge ON ge.glossary_id = g.id
      GROUP BY g.id
      ORDER BY g.source_lang, g.target_lang
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching glossary stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Sprachen für ein neues Glossar: Was DeepL ab Deutsch kann und was es noch nicht gibt. Liest nur, kostet keine Zeichen.
router.get('/zielsprachen', async (_req: Request, res: Response) => {
  if (!config.deepl.apiKey) {
    return res.status(400).json({ error: 'DEEPL_API_KEY not configured' });
  }
  try {
    const sprachen = await glossarZielsprachenBeiDeepL();
    const vorhanden = await pool.query<{ target_lang: string }>(`SELECT target_lang FROM glossaries WHERE source_lang = 'DE'`);
    const belegt = new Set(vorhanden.rows.map((g) => normalizeGlossaryLang(g.target_lang)));
    res.json(sprachen.filter((s) => !belegt.has(s.code)));
  } catch (err) {
    console.error('Error fetching glossary languages:', err);
    res.status(502).json({ error: 'DeepL hat nicht geantwortet' });
  }
});

// DeepL Usage
router.get('/deepl-usage', async (_req: Request, res: Response) => {
  try {
    if (!config.deepl.apiKey) {
      return res.json({ characterCount: 0, characterLimit: 0, configured: false });
    }
    const usage = await getDeepLUsage();
    res.json({ ...usage, configured: true });
  } catch (err) {
    console.error('Error fetching DeepL usage:', err);
    res.status(500).json({ error: 'Failed to fetch DeepL usage' });
  }
});

/** Quickadd eines Nicht-Admins: ein Vorschlag, kein Eintrag, kein neues Glossar. */
async function quickaddAlsVorschlag(
  req: Request,
  p: { sLang: string; tLang: string; quelle: string; ziel: string; context: string | null; channelCode: string | null },
): Promise<Wirkung> {
  const glossaryId = await glossarDesSprachpaars(p.sLang, p.tLang);
  if (!glossaryId) return { code: 409, body: { error: KEIN_GLOSSAR } };
  // Erst beim Einreichen prüfen: Bei der Freigabe schlüge der Fremdschlüssel erst nach dem neuen Eintrag fehl (Code-Review 12.11.2026).
  if (p.channelCode && !(await kanalBekannt(p.channelCode))) return { code: 400, body: { error: 'Unbekannter Channel' } };
  const v = await schlageBegriffVor({
    glossaryId, sourceTerm: p.quelle, targetTerm: p.ziel, context: p.context, channelCode: p.channelCode, quelle: 'quickadd',
  }, bearbeiter(req));
  if (v.status === 'unveraendert') {
    return { code: 200, body: { glossary_id: glossaryId, entry_id: v.entry_id, action: 'unchanged', channel_code: p.channelCode } };
  }
  return vorschlagAntwort(v.vorschlag_id, { glossary_id: glossaryId, entry_id: v.entry_id, action: 'vorschlag', channel_code: p.channelCode });
}

// Quickadd: Term aus Review-Editor ins passende Sprachpaar-Glossar einfügen.
// Erstellt das Glossar bei Bedarf automatisch.
router.post('/quickadd', async (req: Request, res: Response) => {
  const {
    source_term, target_term, source_lang, target_lang, context, project_id, segment_id,
    channel_code: rawChannelCode,
  } = req.body as {
    source_term?: string; target_term?: string;
    source_lang?: string; target_lang?: string;
    context?: string; project_id?: string; segment_id?: string;
    channel_code?: string | null;
  };
  const channelCode =
    typeof rawChannelCode === 'string' && rawChannelCode.trim() !== ''
      ? rawChannelCode.trim().toUpperCase()
      : null;

  if (!source_term?.trim() || !target_term?.trim() || !source_lang || !target_lang) {
    return res.status(400).json({ error: 'source_term, target_term, source_lang, target_lang erforderlich' });
  }

  const sLang = normalizeGlossaryLang(source_lang);
  const tLang = normalizeGlossaryLang(target_lang);
  const userId = (req as any).user?.id ?? null;

  if (!schreibtDirekt(req)) {
    try {
      const w = await quickaddAlsVorschlag(req, { sLang, tLang, quelle: source_term.trim(), ziel: target_term.trim(), context: context || null, channelCode });
      return res.status(w.code).json(w.body);
    } catch (err) {
      console.error('Error in glossary quickadd (Vorschlag):', err);
      return res.status(500).json({ error: 'Quickadd fehlgeschlagen' });
    }
  }

  try {
    const ergebnis = await alsBearbeiter(bearbeiter(req), async (c) => {
      // Glossar finden oder anlegen
      const glossaryRes = await c.query<{ id: string }>(
        `SELECT id FROM glossaries WHERE source_lang = $1 AND target_lang = $2 LIMIT 1`,
        [sLang, tLang]
      );
      let glossaryId: string;
      if (glossaryRes.rows.length === 0) {
        const created = await c.query<{ id: string }>(
          `INSERT INTO glossaries (name, source_lang, target_lang)
           VALUES ($1, $2, $3) RETURNING id`,
          [`${sLang} → ${tLang}`, sLang, tLang]
        );
        glossaryId = created.rows[0].id;
      } else {
        glossaryId = glossaryRes.rows[0].id;
      }

      // Standard-Eintrag finden oder anlegen. Bei Channel-Override ändern wir den
      // Standard-Eintrag NICHT, sondern speichern target_term als Channel-Override.
      const existing = await c.query<{ id: string; target_term: string | null }>(
        `SELECT id, target_term FROM glossary_entries
          WHERE glossary_id = $1 AND LOWER(BTRIM(source_term)) = LOWER(BTRIM($2))
          LIMIT 1`,
        [glossaryId, source_term.trim()]
      );

      let entryId: string;
      let action: 'created' | 'updated' | 'unchanged';

      if (existing.rows.length > 0) {
        entryId = existing.rows[0].id;
        if (channelCode && existing.rows[0].target_term !== null) {
          // Standard bleibt unangetastet — Channel-Override wird unten gesetzt
          action = 'unchanged';
        } else if (existing.rows[0].target_term === target_term.trim()) {
          action = 'unchanged';
        } else {
          await c.query(
            `UPDATE glossary_entries SET target_term = $2, approved = TRUE WHERE id = $1`,
            [entryId, target_term.trim()]
          );
          action = 'updated';
        }
      } else {
        // Neu anlegen. Bei Channel-Override fehlt der Standard-Zielbegriff —
        // als Fallback target_term verwenden, damit DeepL einen Eintrag hat.
        const inserted = await c.query<{ id: string }>(
          `INSERT INTO glossary_entries
             (glossary_id, source_term, target_term, context, approved, source,
              source_project_id, source_segment_id, created_by)
           VALUES ($1, $2, $3, $4, TRUE, 'review-quickadd', $5, $6, $7) RETURNING id`,
          [glossaryId, source_term.trim(), target_term.trim(), context || null,
           project_id || null, segment_id || null, userId]
        );
        entryId = inserted.rows[0].id;
        action = 'created';
      }

      // Channel-Override upsert wenn channel_code gesetzt
      if (channelCode) {
        const existingOverride = await c.query<{ target_term: string }>(
          `SELECT target_term FROM glossary_entry_channels
            WHERE entry_id = $1 AND channel_code = $2`,
          [entryId, channelCode]
        );
        const oldChannelTarget = existingOverride.rows[0]?.target_term ?? null;
        if (oldChannelTarget !== target_term.trim()) {
          await c.query(
            `INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term)
             VALUES ($1, $2, $3)
             ON CONFLICT (entry_id, channel_code)
               DO UPDATE SET target_term = EXCLUDED.target_term, updated_at = NOW()`,
            [entryId, channelCode, target_term.trim()]
          );
          if (action === 'unchanged') action = 'updated';
        }
      }

      if (action !== 'unchanged') {
        await incrementGlossaryVersion(glossaryId, [source_term], c);
      }
      return { glossaryId, entryId, action };
    });

    res.json({ glossary_id: ergebnis.glossaryId, entry_id: ergebnis.entryId, action: ergebnis.action, channel_code: channelCode });
  } catch (err) {
    console.error('Error in glossary quickadd:', err);
    res.status(500).json({ error: 'Quickadd fehlgeschlagen' });
  }
});

// Neues Glossar erstellen
router.post('/', requireGlossarRecht, async (req: Request, res: Response) => {
  const { source_lang, target_lang } = req.body;
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';

  if (!name || !source_lang || !target_lang) {
    return res.status(400).json({ error: 'name, source_lang, target_lang required' });
  }
  const quelle = normalizeGlossaryLang(source_lang);
  const ziel = normalizeGlossaryLang(target_lang);
  // Die Spalten fassen fünf Zeichen. Ein längerer Code (`ZH-HANS`) wäre sonst ein 500.
  if (![quelle, ziel].every((code) => /^[A-Z-]{2,5}$/.test(code))) {
    return res.status(400).json({ error: 'Unbekannter Sprachcode' });
  }

  try {
    const ergebnis = await legeGlossarAn(name, quelle, ziel, bearbeiter(req));
    if (ergebnis.status === 'vorhanden') {
      return res.status(409).json({ error: 'Für dieses Sprachpaar gibt es schon ein Glossar', glossary_id: ergebnis.glossary_id });
    }
    res.status(201).json({ ...ergebnis.glossar, vorbefuellt: ergebnis.vorbefuellt });
  } catch (err) {
    console.error('Error creating glossary:', err);
    res.status(500).json({ error: 'Failed to create glossary' });
  }
});

// Glossar löschen
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await alsBearbeiter(bearbeiter(req), async (c) => {
      await c.query('DELETE FROM glossary_entries WHERE glossary_id = $1', [req.params.id]);
      return c.query('DELETE FROM glossaries WHERE id = $1 RETURNING id', [req.params.id]);
    });

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Glossary not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting glossary:', err);
    res.status(500).json({ error: 'Failed to delete glossary' });
  }
});

// Einträge eines Glossars (mit Suche + Pagination)
router.get('/:id/entries', async (req: Request, res: Response) => {
  const searchTerm = typeof req.query.search === 'string' ? req.query.search : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : 'all'; // all|zu_pflegen|pending|approved
  const limitNum = Number(req.query.limit) || 50;
  const offsetNum = Number(req.query.offset) || 0;
  const nurMitHinweis = req.query.hinweis === '1';
  const hinweisKategorie = typeof req.query.hinweis_kategorie === 'string' ? req.query.hinweis_kategorie : '';
  const hinweisGewissheit = typeof req.query.hinweis_gewissheit === 'string' ? req.query.hinweis_gewissheit : '';

  // Ein unbekannter Wert ergäbe lautlos eine leere Liste und sähe aus wie „keine Hinweise“.
  if (!hinweisFilterGueltig(hinweisKategorie, hinweisGewissheit)) {
    return res.status(400).json({ error: 'Unbekannter Filter für Hinweise' });
  }

  try {
    const where: string[] = ['ge.glossary_id = $1'];
    const params: unknown[] = [req.params.id];

    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      where.push(`(ge.source_term ILIKE $${params.length} OR ge.target_term ILIKE $${params.length})`);
    }
    if (status === 'zu_pflegen') where.push('ge.target_term IS NULL');
    else if (status === 'pending') where.push('ge.approved = FALSE AND ge.target_term IS NOT NULL');
    else if (status === 'approved') where.push('ge.approved = TRUE');

    // Filter der Wortliste (PLAN-wortliste.md §2.7): nach Art und nach offener Rückfrage. Ein unbekannter Wert ergäbe still „leer“.
    const art = typeof req.query.art === 'string' ? req.query.art : '';
    if (art) {
      if (!['wort', 'muster', 'wendung', 'fest'].includes(art)) return res.status(400).json({ error: 'Unbekannte Art' });
      params.push(art);
      where.push(`ge.art = $${params.length}`);
    }
    if (req.query.rueckfrage === '1') {
      where.push('EXISTS (SELECT 1 FROM wortliste_vorschlag v WHERE v.entry_id = ge.id AND v.rueckfrage IS NOT NULL)');
    }
    if (req.query.nur_name === '1') where.push('(ge.an_deepl = FALSE OR ge.ziel_name IS NOT NULL)');

    const filter = hinweisFilter(
      { nurMitHinweis, kategorie: hinweisKategorie, gewissheit: hinweisGewissheit },
      params,
    );
    if (filter) where.push(filter.where);

    const baseWhere = where.join(' AND ');
    params.push(limitNum, offsetNum);

    // Channel-Overrides als JSON aggregiert. Sortierung: gefüllte Zeilen vor leeren, dann offen, dann alphabetisch.
    const query = `
      SELECT ge.*,
             COALESCE(
               (SELECT jsonb_object_agg(gec.channel_code, gec.target_term)
                FROM glossary_entry_channels gec
                WHERE gec.entry_id = ge.id),
               '{}'::jsonb
             ) AS channels,
             COALESCE(
               (SELECT jsonb_agg(jsonb_build_object('produktgruppe', gg.produktgruppe, 'target_term', gg.target_term,
                                                    'genus', gg.genus) ORDER BY gg.produktgruppe)
                  FROM glossary_entry_gruppen gg WHERE gg.entry_id = ge.id),
               '[]'::jsonb
             ) AS gruppen,
             (SELECT to_jsonb(v) - 'entry_id' FROM wortliste_vorschlag v WHERE v.entry_id = ge.id) AS vorschlag,
             ${VORSCHLAEGE_JE_ZEILE} AS offene_vorschlaege,
             ${HINWEISE_ALS_JSON} AS hinweise
        FROM glossary_entries ge
       WHERE ${baseWhere}
       ORDER BY (ge.target_term IS NULL) ASC, ge.approved ASC, ${filter ? `${filter.order}, ` : ''}ge.source_term ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const result = await pool.query(query, params);

    const countParams = params.slice(0, params.length - 2);
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM glossary_entries ge WHERE ${baseWhere}`,
      countParams,
    );

    // Status-Counts (immer alle, damit Frontend Filter-Badges zeigen kann).
    const statsRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE target_term IS NULL)::int AS zu_pflegen,
         COUNT(*) FILTER (WHERE approved = FALSE AND target_term IS NOT NULL)::int AS pending,
         COUNT(*) FILTER (WHERE approved = TRUE)::int AS approved,
         COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wortliste_vorschlag v
                                         WHERE v.entry_id = e.id AND v.rueckfrage IS NOT NULL))::int AS rueckfragen,
         COUNT(*) FILTER (WHERE an_deepl = FALSE OR ziel_name IS NOT NULL)::int AS nur_name,
         (SELECT count(*)::int FROM glossar_vorschlag gv WHERE gv.glossary_id = $1 AND gv.status = 'offen') AS vorschlaege
       FROM glossary_entries e WHERE glossary_id = $1`,
      [req.params.id],
    );

    res.json({
      entries: result.rows,
      total: parseInt(countResult.rows[0].count),
      stats: statsRes.rows[0],
      hinweis_facetten: await hinweisFacetten(String(req.params.id)),
    });
  } catch (err) {
    console.error('Error fetching glossary entries:', err);
    res.status(500).json({ error: 'Failed to fetch entries' });
  }
});

// Bulk-Approve: alle aktuell offenen (approved=FALSE) Eintraege eines Glossars
// freigeben — optional eingeschraenkt auf source (z.B. 'deepl-auto') oder eine
// Liste von IDs. Loggt jede Aenderung in der History. Leere Zeilen bleiben draussen: Sie bekommen
// ihre Uebersetzung nur einzeln durch einen Menschen.
router.post('/:id/entries/bulk-approve', requireGlossarRecht, async (req: Request<{ id: string }>, res: Response) => {
  const { ids, source: filterSource } = req.body as { ids?: string[]; source?: string };

  try {
    // Zeilen mit offener Rückfrage bleiben draußen: Die Frage soll erst jemand beantworten (PLAN-wortliste.md §2.7).
    const where: string[] = ['glossary_id = $1', 'approved = FALSE', 'target_term IS NOT NULL',
      `NOT EXISTS (SELECT 1 FROM wortliste_vorschlag v WHERE v.entry_id = glossary_entries.id AND v.rueckfrage IS NOT NULL)`];
    const params: unknown[] = [req.params.id];
    if (Array.isArray(ids) && ids.length > 0) {
      params.push(ids);
      where.push(`id = ANY($${params.length}::uuid[])`);
    }
    if (typeof filterSource === 'string' && filterSource.trim() !== '') {
      params.push(filterSource.trim());
      where.push(`source = $${params.length}`);
    }

    // Je Zeile vermerkt der Trigger `freigabe: offen → freigegeben` mit dem Bearbeiter (Migration 037).
    const freigegeben = await alsBearbeiter(bearbeiter(req), async (c) => {
      const u = await c.query(
        `UPDATE glossary_entries SET approved = TRUE WHERE ${where.join(' AND ')} RETURNING id`,
        params,
      );
      // Glossar-Version bumpen, damit DeepL beim naechsten Job re-syncht
      // (approved-only-Eintraege wandern ins DeepL-Glossar).
      if ((u.rowCount ?? 0) > 0) {
        await c.query(
          `UPDATE glossaries SET version = version + 1, updated_at = NOW() WHERE id = $1`,
          [req.params.id],
        );
      }
      return u.rowCount ?? 0;
    });

    res.json({ approved: freigegeben });
  } catch (err) {
    console.error('Error bulk-approving entries:', err);
    res.status(500).json({ error: 'Failed to bulk-approve' });
  }
});

/**
 * Channel-Wert setzen (`wert`) oder entfernen (`null`, Rückfall auf den Standard). Die Wirkung für Admins und für die Freigabe.
 * Den Verlauf (angelegt, geändert, entfernt) schreibt der Trigger auf glossary_entry_channels (Migration 037).
 */
export async function setzeChannelWert(
  glossaryId: string, entryId: string, channelCode: string, wert: string | null, wer: Bearbeiter,
): Promise<Wirkung> {
  const entryCheck = await pool.query<{ id: string; target_term: string | null }>(
    `SELECT id, target_term FROM glossary_entries WHERE id = $1 AND glossary_id = $2`,
    [entryId, glossaryId],
  );
  if (entryCheck.rowCount === 0) return { code: 404, body: { error: 'Entry not found' } };
  if (wert === null) {
    const weg = await alsBearbeiter(wer, (c) => c.query(
      `DELETE FROM glossary_entry_channels WHERE entry_id = $1 AND channel_code = $2`,
      [entryId, channelCode],
    ));
    return { code: 200, body: { entry_id: entryId, channel_code: channelCode, target_term: null, deleted: (weg.rowCount ?? 0) > 0 } };
  }
  if (entryCheck.rows[0].target_term === null) {
    return { code: 409, body: { error: 'Zuerst die Übersetzung des Begriffs eintragen' } };
  }
  await alsBearbeiter(wer, (c) => c.query(
    `INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term)
     VALUES ($1, $2, $3)
     ON CONFLICT (entry_id, channel_code)
     DO UPDATE SET target_term = EXCLUDED.target_term, updated_at = NOW()`,
    [entryId, channelCode, wert],
  ));
  return { code: 200, body: { entry_id: entryId, channel_code: channelCode, target_term: wert } };
}

/** Channel-Wert eines Nicht-Admins: prüft wie der direkte Weg, schreibt aber nur einen Vorschlag. */
async function channelAlsVorschlag(req: Request, glossaryId: string, entryId: string, channelCode: string, wert: string | null): Promise<Wirkung> {
  const r = await pool.query<{ source_term: string; target_term: string | null; channel: string | null }>(
    `SELECT e.source_term, e.target_term,
            (SELECT k.target_term FROM glossary_entry_channels k WHERE k.entry_id = e.id AND k.channel_code = $3) AS channel
       FROM glossary_entries e WHERE e.id = $1 AND e.glossary_id = $2`,
    [entryId, glossaryId, channelCode],
  );
  const z = r.rows[0];
  if (!z) return { code: 404, body: { error: 'Entry not found' } };
  if (!(await kanalBekannt(channelCode))) return { code: 400, body: { error: 'Unbekannter Channel' } };
  if (wert !== null && z.target_term === null) return { code: 409, body: { error: 'Zuerst die Übersetzung des Begriffs eintragen' } };
  if (z.channel === wert) return { code: 200, body: { entry_id: entryId, channel_code: channelCode, target_term: wert, unveraendert: true } };
  const v = await reicheEin({ glossaryId, entryId, weg: 'channel', schluessel: channelCode, sourceTerm: z.source_term,
    daten: { target_term: wert }, quelle: 'glossar' }, bearbeiter(req));
  return vorschlagAntwort(v.id, { entry_id: entryId, channel_code: channelCode });
}

// Channel-Override für einen Glossar-Eintrag setzen oder entfernen.
// PUT mit target_term="" oder DELETE entfernt den Override (= Fallback auf Standard).
router.put(
  '/:id/entries/:entryId/channels/:channelCode',
  async (req: Request<{ id: string; entryId: string; channelCode: string }>, res: Response) => {
    const { target_term } = req.body as { target_term?: string };
    const channelCode = req.params.channelCode.toUpperCase();
    const trimmed = (target_term ?? '').trim();
    const wert = trimmed === '' ? null : trimmed;

    try {
      const w = schreibtDirekt(req)
        ? await setzeChannelWert(req.params.id, req.params.entryId, channelCode, wert, bearbeiter(req))
        : await channelAlsVorschlag(req, req.params.id, req.params.entryId, channelCode, wert);
      res.status(w.code).json(w.body);
    } catch (err) {
      console.error('Error setting channel override:', err);
      res.status(500).json({ error: 'Failed to set channel override' });
    }
  }
);

router.delete(
  '/:id/entries/:entryId/channels/:channelCode',
  async (req: Request<{ id: string; entryId: string; channelCode: string }>, res: Response) => {
    const channelCode = req.params.channelCode.toUpperCase();
    try {
      const vorhanden = await pool.query(
        `SELECT 1 FROM glossary_entry_channels gec JOIN glossary_entries ge ON ge.id = gec.entry_id
          WHERE ge.id = $1 AND ge.glossary_id = $2 AND gec.channel_code = $3`,
        [req.params.entryId, req.params.id, channelCode],
      );
      if (vorhanden.rowCount === 0) return res.status(404).json({ error: 'Override not found' });
      if (!schreibtDirekt(req)) {
        const w = await channelAlsVorschlag(req, req.params.id, req.params.entryId, channelCode, null);
        return res.status(w.code).json(w.body);
      }
      const w = await setzeChannelWert(req.params.id, req.params.entryId, channelCode, null, bearbeiter(req));
      if (w.body.deleted === false) return res.status(404).json({ error: 'Override not found' });
      res.json({ deleted: true });
    } catch (err) {
      console.error('Error deleting channel override:', err);
      res.status(500).json({ error: 'Failed to delete channel override' });
    }
  }
);

/**
 * Neuer Begriff in diesem Glossar, für Admins und die Freigabe. Ein Channel-Wert (aus dem Quickadd) kommt gleich mit.
 * `quelle` landet in `glossary_entries.source`.
 */
export async function legeEintragAn(
  glossaryId: string,
  e: { sourceTerm: string; targetTerm: string; context: string | null; category: string | null; channelCode?: string | null; quelle?: string },
  wer: Bearbeiter,
): Promise<Wirkung> {
  const ergebnis = await legeBegriffAn(glossaryId, {
    sourceTerm: e.sourceTerm, targetTerm: e.targetTerm, context: e.context, category: e.category, quelle: e.quelle,
  }, wer);
  if (ergebnis.status === 'vorhanden') {
    return { code: 409, body: { error: 'Den Begriff gibt es in diesem Glossar schon', entry_id: ergebnis.entry_id } };
  }
  if (e.channelCode) {
    await setzeChannelWert(glossaryId, String(ergebnis.zeile.id), e.channelCode, e.targetTerm, wer);
  }
  await pruefeGegenDeepL(glossaryId, e.sourceTerm, e.targetTerm);
  return { code: 201, body: ergebnis.zeile };
}

// Eintrag hinzufügen
router.post('/:id/entries', async (req: Request<{ id: string }>, res: Response) => {
  const { context, category } = req.body;
  const sourceTerm = typeof req.body.source_term === 'string' ? req.body.source_term.trim() : '';
  const targetTerm = typeof req.body.target_term === 'string' ? req.body.target_term.trim() : '';

  if (!sourceTerm || !targetTerm) {
    return res.status(400).json({ error: 'source_term and target_term required' });
  }

  try {
    if (!schreibtDirekt(req)) {
      const glossar = await pool.query(`SELECT 1 FROM glossaries WHERE id = $1`, [req.params.id]);
      if (glossar.rowCount === 0) return res.status(404).json({ error: 'Glossary not found' });
      const vorhanden = await pool.query<{ id: string }>(
        `SELECT id FROM glossary_entries
          WHERE glossary_id = $1 AND lower(btrim(source_term)) = lower(btrim($2)) AND target_term IS NOT NULL LIMIT 1`,
        [req.params.id, sourceTerm],
      );
      if (vorhanden.rows.length > 0) {
        return res.status(409).json({ error: 'Den Begriff gibt es in diesem Glossar schon', entry_id: vorhanden.rows[0].id });
      }
      const daten: Record<string, unknown> = { target_term: targetTerm };
      if (context) daten.context = String(context);
      if (category) daten.category = String(category);
      const v = await reicheEin({ glossaryId: req.params.id, entryId: null, weg: 'neu', sourceTerm, daten, quelle: 'glossar' }, bearbeiter(req));
      const w = vorschlagAntwort(v.id, { source_term: sourceTerm, target_term: targetTerm });
      return res.status(w.code).json(w.body);
    }

    const w = await legeEintragAn(req.params.id, {
      sourceTerm, targetTerm, context: context || null, category: category || null,
    }, bearbeiter(req));
    res.status(w.code).json(w.body);
  } catch (err) {
    console.error('Error adding glossary entry:', err);
    res.status(500).json({ error: 'Failed to add entry' });
  }
});

/** Die Felder, die `PUT /:id/entries/:entryId` ändert. Ein leerer Begriff oder ein leeres Ziel ist ein 400. */
export interface EintragFelder {
  source_term?: string;
  target_term?: string;
  context?: string;
  category?: string;
  approved?: boolean;
}

export function eintragFelderAus(body: Record<string, unknown>): EintragFelder | { fehler: string } {
  const text = (w: unknown) => (typeof w === 'string' ? w.trim() : undefined);
  const f: EintragFelder = {};
  if (body.source_term !== undefined && body.source_term !== null) {
    f.source_term = text(body.source_term);
    if (!f.source_term) return { fehler: 'Der Begriff darf nicht leer sein' };
  }
  if (body.target_term !== undefined && body.target_term !== null) {
    f.target_term = text(body.target_term);
    if (!f.target_term) return { fehler: 'Die Übersetzung darf nicht leer sein' };
  }
  if (body.context !== undefined && body.context !== null) f.context = String(body.context);
  if (body.category !== undefined && body.category !== null) f.category = String(body.category);
  if (body.approved !== undefined && body.approved !== null) {
    if (typeof body.approved !== 'boolean') return { fehler: 'approved muss ja oder nein sein' };
    f.approved = body.approved;
  }
  return f;
}

/**
 * Die Wirkung von `PUT /:id/entries/:entryId`, für Admins und die Freigabe. `freigeben` setzt eine Zeile mit neuem Ziel auf
 * freigegeben: Ein Admin hat den Vorschlag bestätigt.
 */
export async function wendeEintragAn(
  glossaryId: string, entryId: string, f: EintragFelder, wer: Bearbeiter, opt: { freigeben?: boolean } = {},
): Promise<Wirkung> {
  const { source_term, target_term, context, category } = f;
  let approved = f.approved;

  // Vorher-Snapshot für History
  const before = await pool.query<{ source_term: string; target_term: string | null }>(
    `SELECT source_term, target_term FROM glossary_entries WHERE id = $1 AND glossary_id = $2`,
    [entryId, glossaryId]
  );
  if (before.rowCount === 0) return { code: 404, body: { error: 'Entry not found' } };
  const beforeRow = before.rows[0];

  // Umbenennen gilt nur in diesem Glossar. Übersetzung und Channel-Werte bleiben an der Zeile.
  if (source_term && source_term !== beforeRow.source_term) {
    if (target_term || context !== undefined || category !== undefined || approved !== undefined) {
      return { code: 400, body: { error: 'Begriff und Übersetzung getrennt ändern' } };
    }
    const ergebnis = await benenneBegriffUm(glossaryId, entryId, source_term, wer);
    if (!ergebnis) return { code: 404, body: { error: 'Entry not found' } };
    if (ergebnis.status === 'konflikt') {
      return { code: 409, body: { error: 'Der neue Begriff ist schon übersetzt', konflikte: ergebnis.konflikte } };
    }
    if (ergebnis.status === 'geschuetzt') {
      return { code: 403, body: { error: 'Dabei fiele ein Eintrag des Beispiel-Glossars weg, er bleibt stehen', code: 'seed_eintrag' } };
    }
    return { code: 200, body: { umbenannt: ergebnis.umbenannt, source_term } };
  }

  if (opt.freigeben && target_term) approved = true;
  if (beforeRow.target_term === null) {
    if (target_term) {
      // Hier wird der Vorschlag zur Übersetzung: Ein Mensch hat ihn bestätigt.
      approved = approved ?? true;
    } else if (approved === true) {
      return { code: 409, body: { error: 'Eine leere Zeile kann nicht freigegeben werden' } };
    }
  }

  // Den Verlauf je geändertem Feld (Ziel, Freigabe, Kontext, Kategorie) schreibt der Trigger (Migration 037).
  const result = await alsBearbeiter(wer, async (c) => {
    const r = await c.query(
      `UPDATE glossary_entries
       SET source_term = COALESCE($3, source_term),
           target_term = COALESCE($4, target_term),
           context = COALESCE($5, context),
           category = COALESCE($6, category),
           approved = COALESCE($7, approved)
       WHERE id = $2 AND glossary_id = $1
       RETURNING *`,
      [glossaryId, entryId, source_term ?? null, target_term ?? null, context ?? null, category ?? null, approved ?? null]
    );
    // Alter und neuer Begriff: Texte mit dem alten sind nun ohne Eintrag, Texte mit dem neuen bekommen ihn.
    // Eine Zeile, die leer war und leer bleibt, war nie aktiv und entwertet nichts.
    if (beforeRow.target_term !== null || r.rows[0].target_term !== null) {
      await incrementGlossaryVersion(glossaryId, [beforeRow.source_term, r.rows[0].source_term], c);
    }
    return r;
  });

  if (target_term !== undefined && target_term !== beforeRow.target_term) {
    await pruefeGegenDeepL(glossaryId, result.rows[0].source_term, target_term);
  }
  return { code: 200, body: result.rows[0] };
}

/** `PUT /:id/entries/:entryId` eines Nicht-Admins: Freigeben darf er nicht, alles andere wird ein Vorschlag. */
async function eintragAlsVorschlag(req: Request, glossaryId: string, entryId: string, f: EintragFelder): Promise<Wirkung> {
  if (f.approved !== undefined) return { code: 403, body: { error: 'Freigeben dürfen nur Admins' } };
  const r = await pool.query<Record<string, string | null>>(
    `SELECT source_term, target_term, context, category FROM glossary_entries WHERE id = $1 AND glossary_id = $2`,
    [entryId, glossaryId],
  );
  const z = r.rows[0];
  if (!z) return { code: 404, body: { error: 'Entry not found' } };
  const umbenennen = f.source_term !== undefined && f.source_term !== z.source_term;
  if (umbenennen && (f.target_term !== undefined || f.context !== undefined || f.category !== undefined)) {
    return { code: 400, body: { error: 'Begriff und Übersetzung getrennt ändern' } };
  }
  const daten: Record<string, unknown> = {};
  if (umbenennen) daten.source_term = f.source_term;
  else {
    for (const k of ['target_term', 'context', 'category'] as const) {
      if (f[k] !== undefined && f[k] !== z[k]) daten[k] = f[k];
    }
  }
  if (Object.keys(daten).length === 0) return { code: 200, body: { ...z, id: entryId, unveraendert: true } };
  const v = await reicheEin({
    glossaryId, entryId, weg: 'eintrag', schluessel: umbenennen ? 'begriff' : '', sourceTerm: z.source_term as string,
    daten, quelle: 'glossar',
  }, bearbeiter(req));
  return vorschlagAntwort(v.id, { entry_id: entryId });
}

// Eintrag aktualisieren
router.put('/:id/entries/:entryId', async (req: Request<{ id: string; entryId: string }>, res: Response) => {
  const f = eintragFelderAus((req.body ?? {}) as Record<string, unknown>);
  if ('fehler' in f) return res.status(400).json({ error: f.fehler });

  try {
    const w = schreibtDirekt(req)
      ? await wendeEintragAn(req.params.id, req.params.entryId, f, bearbeiter(req))
      : await eintragAlsVorschlag(req, req.params.id, req.params.entryId, f);
    res.status(w.code).json(w.body);
  } catch (err) {
    console.error('Error updating glossary entry:', err);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// Zeile löschen: nur in diesem Glossar, Channel-Werte gehen mit. Die Rückfrage zeigt die Oberfläche, sie kennt beides.
router.delete('/:id/entries/:entryId', requireLoeschRecht, async (req: Request<{ id: string; entryId: string }>, res: Response) => {
  try {
    const ergebnis = await loescheZeile(req.params.id, req.params.entryId, bearbeiter(req));
    if (!ergebnis) return res.status(404).json({ error: 'Entry not found' });
    if (ergebnis.status === 'schutzkette') return res.status(409).json({ error: 'Dieser Kennwert bleibt stehen' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting entry:', err);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// Obergrenze für den DeepL-Vorschlag: Die Route kostet Kontingent, ein Glossarbegriff ist kein Absatz.
const VORSCHLAG_MAX_ZEICHEN = 200;

// Vorschlag von DeepL, für eine neue Abweichung oder eine Zeile ohne Übersetzung: ein Aufruf je Klick, nichts wird gespeichert.
// Beim Plus gibt es die Zeile noch nicht, der Begriff kommt deshalb aus der Anfrage. Hat er im Glossar schon eine Übersetzung,
// wird DeepL nicht gefragt.
router.post('/:id/vorschlag', async (req: Request<{ id: string }>, res: Response) => {
  if (!config.deepl.apiKey) {
    return res.status(400).json({ error: 'DEEPL_API_KEY not configured' });
  }
  const begriff = typeof req.body?.source_term === 'string' ? req.body.source_term.trim() : '';
  if (!begriff) return res.status(400).json({ error: 'Der Begriff darf nicht leer sein' });
  if (begriff.length > VORSCHLAG_MAX_ZEICHEN) return res.status(400).json({ error: 'Der Begriff ist zu lang' });

  try {
    const glossar = await pool.query<{ source_lang: string; target_lang: string; deepl_glossary_id: string | null }>(
      `SELECT source_lang, target_lang, deepl_glossary_id FROM glossaries WHERE id = $1`,
      [req.params.id],
    );
    if (glossar.rows.length === 0) return res.status(404).json({ error: 'Glossary not found' });

    const vorhanden = await pool.query(
      `SELECT 1 FROM glossary_entries
        WHERE glossary_id = $1 AND lower(btrim(source_term)) = lower(btrim($2)) AND target_term IS NOT NULL
        LIMIT 1`,
      [req.params.id, begriff],
    );
    if (vorhanden.rows.length > 0) return res.status(409).json({ error: 'Den Begriff gibt es in diesem Glossar schon' });

    const g = glossar.rows[0];
    res.json(await holeDeeplVorschlag({
      begriff,
      sourceLang: g.source_lang,
      targetLang: g.target_lang,
      deeplGlossaryId: g.deepl_glossary_id,
    }));
  } catch (err) {
    console.error('Error fetching DeepL suggestion:', err);
    res.status(502).json({ error: 'DeepL hat nicht geantwortet' });
  }
});

// Eintrag entfernen an einer Markierung „unnötig“: Die Zeile fällt weg, hier übersetzt künftig DeepL frei.
router.post('/:id/entries/:entryId/entfernen', requireLoeschRecht, async (req: Request<{ id: string; entryId: string }>, res: Response) => {
  try {
    const stand = typeof req.body?.stand === 'string' ? req.body.stand : null;
    const e = await entferneEintrag(req.params.id, req.params.entryId, stand, bearbeiter(req));
    if (!e) return res.status(404).json({ error: 'Entry not found' });
    if (e.status === 'channel') return res.status(409).json({ error: 'Diese Zeile hat Channel-Werte und bleibt stehen' });
    if (e.status === 'schutzkette') return res.status(409).json({ error: 'Dieser Kennwert bleibt stehen' });
    if (e.status === 'veraltet') return res.status(409).json({ error: 'Der Stand hat sich geändert, bitte erneut bestätigen' });
    await entferneMarkierungenDerZeile(req.params.id, e.begriff, e.alt);
    res.json({ status: e.status });
  } catch (err) {
    console.error('Error removing entry:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Prüfhinweis verwerfen: Der Eintrag ist richtig so. Der Eintrag bleibt unberührt, nur der Hinweis fällt weg.
router.post('/:id/hinweise/:hinweisId/verwerfen', requireGlossarRecht, async (req: Request<{ id: string; hinweisId: string }>, res: Response) => {
  try {
    const ok = await hinweisVerwerfen(req.params.id, req.params.hinweisId, bearbeiter(req).name);
    if (!ok) return res.status(404).json({ error: 'Hinweis nicht gefunden' });
    res.json({ verworfen: true });
  } catch (err) {
    console.error('Error dismissing hint:', err);
    res.status(500).json({ error: 'Failed to dismiss hint' });
  }
});

// CSV-Export eines Glossars
router.get('/:id/export', async (req: Request, res: Response) => {
  try {
    const glossaryResult = await pool.query('SELECT * FROM glossaries WHERE id = $1', [req.params.id]);
    if (glossaryResult.rows.length === 0) {
      return res.status(404).json({ error: 'Glossary not found' });
    }

    const glossary = glossaryResult.rows[0];
    const entries = await pool.query(
      'SELECT source_term, target_term FROM glossary_entries WHERE glossary_id = $1 AND target_term IS NOT NULL ORDER BY source_term',
      [req.params.id]
    );

    const header = `${glossary.source_lang};${glossary.target_lang}`;
    const rows = entries.rows.map((e: any) => `${e.source_term};${e.target_term}`);
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // Die Namen tragen `→`: Roh im Header wirft Node `ERR_INVALID_CHAR`, und der Export endete in einer 500.
    const dateiname = `${glossary.name}.csv`;
    const ascii = dateiname.replace(/[^ -~]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(dateiname)}`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting glossary:', err);
    res.status(500).json({ error: 'Failed to export glossary' });
  }
});

// DeepL-Glossar synchronisieren
router.post('/:id/sync-deepl', async (req: Request, res: Response) => {
  if (!config.deepl.apiKey) {
    return res.status(400).json({ error: 'DEEPL_API_KEY not configured' });
  }

  try {
    const glossaryResult = await pool.query('SELECT * FROM glossaries WHERE id = $1', [req.params.id]);
    if (glossaryResult.rows.length === 0) {
      return res.status(404).json({ error: 'Glossary not found' });
    }

    const g = glossaryResult.rows[0];
    const deeplGlossaryId = await syncGlossaryToDeepL(
      g.id, g.name, g.source_lang, g.target_lang
    );

    res.json({ deepl_glossary_id: deeplGlossaryId, synced: true });
  } catch (err: any) {
    console.error('Error syncing glossary to DeepL:', err);
    res.status(500).json({ error: err.message || 'Failed to sync glossary' });
  }
});

// Änderungsverlauf eines Eintrags
router.get(
  '/:id/entries/:entryId/history',
  async (req: Request<{ id: string; entryId: string }>, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT id, source_term, field, action, old_value, new_value,
                changed_by, changed_by_name, changed_at
           FROM glossary_entry_history
          WHERE entry_id = $1 AND glossary_id = $2
          ORDER BY changed_at DESC
          LIMIT 200`,
        [req.params.entryId, req.params.id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching entry history:', err);
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  }
);

export default router;
