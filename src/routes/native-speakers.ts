/**
 * Native-Speaker CRUD + Review-Anfrage.
 *
 * Native-Speaker sind eine vom Admin gepflegte Liste externer Reviewer
 * (Muttersprachler), die nach Klick auf "Anfrage senden" eine E-Mail
 * mit Link zur Review-Seite erhalten.
 *
 * Auth-Modell: Speaker-Liste != users-Tabelle. Die Liste dient nur dem
 * Dropdown. Echte Authorization laeuft weiter ueber MS-Entra-Login + users.
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { sendMail, buildReviewRequestEmail, mailLangFor } from '../services/email';
import { config } from '../config';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeLanguages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0 && s.length <= 8);
}

// GET /api/native-speakers — alle aktiven Speaker (jeder eingeloggte User darf lesen,
// damit der Dropdown auf der Pruefen-Seite funktioniert).
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const lang = typeof req.query.language === 'string' ? req.query.language.toUpperCase() : null;
  try {
    const result = lang
      ? await pool.query(
          `SELECT id, name, email, languages
             FROM native_speakers
            WHERE active = TRUE AND $1 = ANY(languages)
            ORDER BY name`,
          [lang],
        )
      : await pool.query(
          `SELECT id, name, email, languages
             FROM native_speakers
            WHERE active = TRUE
            ORDER BY name`,
        );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing native speakers:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/native-speakers/admin — vollstaendige Liste inkl. inactive (Admin only)
router.get('/admin', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, languages, active, created_at, updated_at
         FROM native_speakers
        ORDER BY active DESC, name`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing native speakers (admin):', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/native-speakers (Admin)
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const { name, email, languages, active } = req.body as {
    name?: string;
    email?: string;
    languages?: unknown;
    active?: boolean;
  };

  if (!name || !name.trim()) {
    res.status(400).json({ error: 'Name erforderlich' });
    return;
  }
  if (!email || !EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: 'Gültige E-Mail-Adresse erforderlich' });
    return;
  }

  const normLangs = normalizeLanguages(languages);
  if (normLangs.length === 0) {
    res.status(400).json({ error: 'Mindestens eine Sprache erforderlich' });
    return;
  }

  const userId = (req as AuthenticatedRequest).user?.id ?? null;
  try {
    const result = await pool.query(
      `INSERT INTO native_speakers (name, email, languages, active, created_by)
       VALUES ($1, $2, $3, COALESCE($4, TRUE), $5)
       RETURNING id, name, email, languages, active, created_at, updated_at`,
      [name.trim(), email.trim().toLowerCase(), normLangs, active, userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits eingetragen' });
      return;
    }
    console.error('Error creating native speaker:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PUT /api/native-speakers/:id (Admin)
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  const { name, email, languages, active } = req.body as {
    name?: string;
    email?: string;
    languages?: unknown;
    active?: boolean;
  };

  const fields: string[] = [];
  const values: any[] = [];

  if (name !== undefined) {
    if (!name.trim()) {
      res.status(400).json({ error: 'Name darf nicht leer sein' });
      return;
    }
    values.push(name.trim());
    fields.push(`name = $${values.length}`);
  }
  if (email !== undefined) {
    if (!EMAIL_RE.test(email.trim())) {
      res.status(400).json({ error: 'Gültige E-Mail-Adresse erforderlich' });
      return;
    }
    values.push(email.trim().toLowerCase());
    fields.push(`email = $${values.length}`);
  }
  if (languages !== undefined) {
    const normLangs = normalizeLanguages(languages);
    if (normLangs.length === 0) {
      res.status(400).json({ error: 'Mindestens eine Sprache erforderlich' });
      return;
    }
    values.push(normLangs);
    fields.push(`languages = $${values.length}`);
  }
  if (active !== undefined) {
    values.push(!!active);
    fields.push(`active = $${values.length}`);
  }

  if (fields.length === 0) {
    res.status(400).json({ error: 'Keine Änderungen übergeben' });
    return;
  }

  fields.push(`updated_at = NOW()`);
  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE native_speakers SET ${fields.join(', ')}
       WHERE id = $${values.length}
       RETURNING id, name, email, languages, active, created_at, updated_at`,
      values,
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Native-Speaker nicht gefunden' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits eingetragen' });
      return;
    }
    console.error('Error updating native speaker:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/native-speakers/:id (Admin)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `DELETE FROM native_speakers WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Native-Speaker nicht gefunden' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting native speaker:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/native-speakers/request-review
// Body: { project_id, speaker_ids: string[], message? } — `speaker_id` (einzeln) geht weiterhin.
// Mehrere Angefragte sind der Normalfall: wer zuerst Zeit hat, prüft; eine Freigabe genügt.
router.post('/request-review', requireAuth, async (req: Request, res: Response) => {
  const { project_id, speaker_id, speaker_ids, message } = req.body as {
    project_id?: string;
    speaker_id?: string;
    speaker_ids?: string[];
    message?: string;
  };

  const ids = Array.from(new Set(
    (Array.isArray(speaker_ids) ? speaker_ids : speaker_id ? [speaker_id] : [])
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  ));

  if (!project_id || ids.length === 0) {
    res.status(400).json({ error: 'project_id und mindestens ein Native-Speaker erforderlich' });
    return;
  }
  if (ids.length > 20) {
    res.status(400).json({ error: 'Maximal 20 Native-Speaker je Anfrage' });
    return;
  }

  try {
    const projectRes = await pool.query<{
      id: string;
      name: string;
      source_lang: string;
      target_lang: string;
      segment_count: number;
    }>(
      `SELECT id, name, source_lang, target_lang, segment_count
         FROM projects WHERE id = $1`,
      [project_id],
    );
    if (projectRes.rows.length === 0) {
      res.status(404).json({ error: 'Projekt nicht gefunden' });
      return;
    }
    const project = projectRes.rows[0];

    const speakerRes = await pool.query<{
      id: string;
      name: string;
      email: string;
      languages: string[];
      active: boolean;
    }>(
      `SELECT id, name, email, languages, active
         FROM native_speakers WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    // Erst alle prüfen, dann versenden — sonst geht bei einer ungültigen
    // Auswahl die Hälfte raus und die andere nicht.
    const speakers = ids.map((id) => speakerRes.rows.find((s) => s.id === id));
    const missing = ids.filter((_, i) => !speakers[i]);
    if (missing.length > 0) {
      res.status(404).json({ error: 'Native-Speaker nicht gefunden' });
      return;
    }
    for (const speaker of speakers) {
      if (!speaker!.active) {
        res.status(400).json({ error: `Native-Speaker ${speaker!.name} ist deaktiviert` });
        return;
      }
      if (!speaker!.languages.includes(project.target_lang.toUpperCase())) {
        res.status(400).json({
          error: `${speaker!.name} spricht ${project.target_lang} nicht (nur: ${speaker!.languages.join(', ')})`,
        });
        return;
      }
    }

    const requester = (req as AuthenticatedRequest).user!;
    // requester aus DB anreichern (name fuer E-Mail-Signatur)
    const requesterRes = await pool.query<{ display_name: string | null; name: string | null; email: string }>(
      `SELECT display_name, name, email FROM users WHERE id = $1`,
      [requester.id],
    );
    const requesterRow = requesterRes.rows[0];
    const requesterName =
      requesterRow?.display_name || requesterRow?.name || requesterRow?.email || `${config.organisationName} Translator`.trim();
    const requesterEmail = requesterRow?.email || config.mailFrom;

    const reviewUrl = `${config.publicUrl.replace(/\/$/, '')}/?review=${project.id}`;
    const trimmedMessage = typeof message === 'string' ? message.trim() : null;

    const results: Array<{ speaker_name: string; to: string; ok: boolean; error?: string }> = [];
    for (const speaker of speakers as NonNullable<(typeof speakers)[number]>[]) {
      const mail = buildReviewRequestEmail({
        speakerName: speaker.name,
        requesterName,
        requesterEmail,
        projectName: project.name,
        sourceLang: project.source_lang,
        targetLang: project.target_lang,
        segmentCount: project.segment_count || 0,
        reviewUrl,
        message: trimmedMessage,
        otherReviewerCount: speakers.length - 1,
        lang: mailLangFor(project.target_lang),
      });

      const result = await sendMail({
        to: speaker.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: requesterEmail,
      });

      await pool.query(
        `INSERT INTO review_invitations
           (project_id, speaker_id, speaker_email, requested_by, message, delivery_status, delivery_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          project_id,
          speaker.id,
          speaker.email,
          requester.id,
          trimmedMessage,
          result.ok ? 'sent' : 'failed',
          result.ok ? null : result.error,
        ],
      );

      results.push({
        speaker_name: speaker.name,
        to: speaker.email,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
    }

    const sent = results.filter((r) => r.ok).length;
    if (sent === 0) {
      res.status(502).json({ error: `E-Mail-Versand fehlgeschlagen: ${results[0].error}`, results });
      return;
    }

    res.json({ sent, failed: results.length - sent, results });
  } catch (err: any) {
    console.error('Error sending review request:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/native-speakers/invitations/:project_id — Liste der Versand-Historie pro Projekt
router.get('/invitations/:projectId', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.speaker_id, i.speaker_email, i.sent_at, i.delivery_status,
              s.name AS speaker_name
         FROM review_invitations i
         JOIN native_speakers s ON s.id = i.speaker_id
        WHERE i.project_id = $1
        ORDER BY i.sent_at DESC`,
      [req.params.projectId],
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing invitations:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
