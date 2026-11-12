import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { sameTerm } from '../services/house-terms';

/**
 * Hausschreibweise pflegen (deutsch → deutsch). Jeder angemeldete Benutzer darf
 * pflegen (Entscheid Thomas 16.09.2026); jede Änderung landet mit Benutzer und
 * Zeitpunkt in house_term_history.
 *
 * „Stattdessen (Organisation)" leer = der Begriff bleibt beim Standard, nur Channels
 * weichen ab. Gespeichert wird das als derselbe Begriff in beiden Feldern
 * (`preferred_term` ist NOT NULL); `effectiveHouseTerms` lässt solche Einträge
 * bei der Prüfung aus, solange der Channel keinen eigenen Begriff hat.
 */
const router = Router();

interface AuthUser {
  id?: string;
  email?: string;
  display_name?: string | null;
  name?: string | null;
}

function userOf(req: Request): AuthUser | undefined {
  return (req as any).user as AuthUser | undefined;
}

async function recordHistory(params: {
  termId: string | null;
  avoidTerm: string;
  field: string;
  action: 'created' | 'updated' | 'deleted';
  oldValue: string | null;
  newValue: string | null;
  user?: AuthUser;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO house_term_history
         (term_id, avoid_term, field, action, old_value, new_value, changed_by, changed_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.termId,
        params.avoidTerm,
        params.field,
        params.action,
        params.oldValue,
        params.newValue,
        params.user?.id ?? null,
        params.user ? params.user.display_name || params.user.name || params.user.email || null : null,
      ],
    );
  } catch (err) {
    console.error('[HouseTerms] Failed to record history:', err);
  }
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Channel-Fassungen (DE→DE-Segmente) veralten mit der Liste — wie Glossar-
 * Übersetzungen mit ihrer Version. Eine Standard-Änderung trifft alle Channels
 * (sie erben den Standard), ein Channel-Begriff nur seinen Channel. Fehlschlag
 * nur loggen: die Pflege selbst ist dann trotzdem gespeichert.
 */
async function markChannelFassungStale(channelCode: string | null): Promise<void> {
  try {
    const r = await pool.query(
      `UPDATE segments SET is_stale = TRUE
        WHERE upper(source_lang) = 'DE' AND upper(target_lang) = 'DE'
          AND translated_text IS NOT NULL AND is_stale = FALSE
          AND ($1::text IS NULL OR channel_code = $1)`,
      [channelCode],
    );
    if (r.rowCount) console.log(`[HouseTerms] ${r.rowCount} Channel-Fassung(en) veraltet (${channelCode ?? 'alle Channels'})`);
  } catch (err) {
    console.error('[HouseTerms] Failed to mark channel versions stale:', err);
  }
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

// Liste inkl. Channel-Overrides und letzter Änderung
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT ht.id, ht.avoid_term, ht.preferred_term, ht.note, ht.updated_at,
              COALESCE(
                (SELECT jsonb_object_agg(htc.channel_code, htc.preferred_term)
                   FROM house_term_channels htc WHERE htc.term_id = ht.id),
                '{}'::jsonb
              ) AS channels,
              (SELECT h.changed_by_name FROM house_term_history h
                WHERE h.term_id = ht.id ORDER BY h.changed_at DESC LIMIT 1) AS last_changed_by
         FROM house_terms ht
        ORDER BY LOWER(ht.avoid_term)`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[HouseTerms] list failed:', err);
    res.status(500).json({ error: 'Hausschreibweise konnte nicht geladen werden' });
  }
});

// Neuer Eintrag
router.post('/', async (req: Request, res: Response) => {
  const avoid = cleanText(req.body?.avoid_term);
  const note = cleanText(req.body?.note);

  if (!avoid) {
    return res.status(400).json({ error: '„Nicht verwenden" ist ein Pflichtfeld' });
  }
  const preferred = cleanText(req.body?.preferred_term) ?? avoid;

  try {
    const result = await pool.query(
      `INSERT INTO house_terms (avoid_term, preferred_term, note) VALUES ($1, $2, $3) RETURNING id`,
      [avoid, preferred, note],
    );
    const id = result.rows[0].id;
    await recordHistory({
      termId: id, avoidTerm: avoid, field: 'standard', action: 'created',
      oldValue: null, newValue: preferred, user: userOf(req),
    });
    await markChannelFassungStale(null);
    res.status(201).json({ id });
  } catch (err: any) {
    if (err?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: `„${avoid}" steht bereits in der Liste` });
    }
    console.error('[HouseTerms] create failed:', err);
    res.status(500).json({ error: 'Eintrag konnte nicht angelegt werden' });
  }
});

// Standard-Felder ändern: avoid_term, preferred_term, note (nur die mitgeschickten)
router.put('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const fields: Array<{ key: 'avoid_term' | 'preferred_term' | 'note'; history: string; required: boolean }> = [
    { key: 'avoid_term', history: 'avoid', required: true },
    { key: 'preferred_term', history: 'standard', required: false },
    { key: 'note', history: 'note', required: false },
  ];

  try {
    const before = await pool.query(
      `SELECT avoid_term, preferred_term, note FROM house_terms WHERE id = $1`,
      [req.params.id],
    );
    if (before.rows.length === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const old = before.rows[0];
    // „Bleibt" folgt dem Begriff, wenn nur „Nicht verwenden" korrigiert wird —
    // sonst würde aus dem Tippfehler-Fix still eine Ersetzung.
    const keptStandard = sameTerm(old.avoid_term, old.preferred_term);

    const next = { ...old };
    for (const f of fields) {
      if (!(f.key in (req.body || {}))) continue;
      const value = cleanText(req.body[f.key]);
      if (f.required && !value) {
        return res.status(400).json({ error: 'Pflichtfeld darf nicht leer sein' });
      }
      next[f.key] = value;
    }
    if (!next.preferred_term || (keptStandard && !('preferred_term' in (req.body || {})))) {
      next.preferred_term = next.avoid_term;
    }

    await pool.query(
      `UPDATE house_terms SET avoid_term = $2, preferred_term = $3, note = $4, updated_at = NOW() WHERE id = $1`,
      [req.params.id, next.avoid_term, next.preferred_term, next.note],
    );

    for (const f of fields) {
      if ((old[f.key] ?? null) !== (next[f.key] ?? null)) {
        await recordHistory({
          termId: req.params.id, avoidTerm: next.avoid_term, field: f.history, action: 'updated',
          oldValue: old[f.key], newValue: next[f.key], user: userOf(req),
        });
      }
    }
    await markChannelFassungStale(null);
    res.json({ id: req.params.id, ...next });
  } catch (err: any) {
    if (err?.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: 'Dieser Begriff steht bereits in der Liste' });
    }
    console.error('[HouseTerms] update failed:', err);
    res.status(500).json({ error: 'Eintrag konnte nicht gespeichert werden' });
  }
});

// Eintrag löschen
router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const result = await pool.query(
      `DELETE FROM house_terms WHERE id = $1 RETURNING avoid_term, preferred_term`,
      [req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    await recordHistory({
      termId: req.params.id, avoidTerm: result.rows[0].avoid_term, field: 'standard', action: 'deleted',
      oldValue: result.rows[0].preferred_term, newValue: null, user: userOf(req),
    });
    await markChannelFassungStale(null);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[HouseTerms] delete failed:', err);
    res.status(500).json({ error: 'Eintrag konnte nicht gelöscht werden' });
  }
});

// Channel-Override setzen; leerer Wert = Override entfernen (Fallback auf Standard)
router.put('/:id/channels/:channelCode', async (req: Request<{ id: string; channelCode: string }>, res: Response) => {
  const channelCode = req.params.channelCode.toUpperCase();
  const value = cleanText(req.body?.preferred_term);

  try {
    const term = await pool.query(`SELECT avoid_term FROM house_terms WHERE id = $1`, [req.params.id]);
    if (term.rows.length === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    const avoidTerm = term.rows[0].avoid_term;

    const existing = await pool.query(
      `SELECT preferred_term FROM house_term_channels WHERE term_id = $1 AND channel_code = $2`,
      [req.params.id, channelCode],
    );
    const oldValue: string | null = existing.rows[0]?.preferred_term ?? null;

    if (!value) {
      if (oldValue !== null) {
        await pool.query(
          `DELETE FROM house_term_channels WHERE term_id = $1 AND channel_code = $2`,
          [req.params.id, channelCode],
        );
        await recordHistory({
          termId: req.params.id, avoidTerm, field: channelCode, action: 'deleted',
          oldValue, newValue: null, user: userOf(req),
        });
        await markChannelFassungStale(channelCode);
      }
      return res.json({ channel_code: channelCode, preferred_term: null });
    }

    await pool.query(
      `INSERT INTO house_term_channels (term_id, channel_code, preferred_term)
       VALUES ($1, $2, $3)
       ON CONFLICT (term_id, channel_code)
       DO UPDATE SET preferred_term = EXCLUDED.preferred_term, updated_at = NOW()`,
      [req.params.id, channelCode, value],
    );
    if (oldValue !== value) {
      await recordHistory({
        termId: req.params.id, avoidTerm, field: channelCode,
        action: oldValue === null ? 'created' : 'updated',
        oldValue, newValue: value, user: userOf(req),
      });
      await markChannelFassungStale(channelCode);
    }
    res.json({ channel_code: channelCode, preferred_term: value });
  } catch (err: any) {
    if (err?.code === FK_VIOLATION) {
      return res.status(400).json({ error: `Unbekannter Channel ${channelCode}` });
    }
    console.error('[HouseTerms] channel override failed:', err);
    res.status(500).json({ error: 'Channel-Begriff konnte nicht gespeichert werden' });
  }
});

// Änderungsverlauf eines Eintrags
router.get('/:id/history', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT field, action, old_value, new_value, changed_by_name, changed_at
         FROM house_term_history WHERE term_id = $1 ORDER BY changed_at DESC LIMIT 100`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[HouseTerms] history failed:', err);
    res.status(500).json({ error: 'Verlauf konnte nicht geladen werden' });
  }
});

export default router;
