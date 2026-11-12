import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/connection';
import { config } from '../config';
import { enqueueTranslation } from '../services/queue';
import { AIJSON_SCHEMA_PREFIX } from '../services/aijson';
import { requirePanelAuth, PanelRequest } from '../middleware/panelAuth';
import { clientOf, createPairing, pollPairing, PanelAuthError } from '../services/panelAuth';

/**
 * CEP-API für das Illustrator-Panel.
 *
 * Reine JSON-Schnittstelle (kein Multipart, keine MS-Session): das Panel
 * exportiert TextFrame-Segmente, schickt sie hierher, pollt den Status und
 * holt die Übersetzung. Intern wird daraus ein ganz normales `.aijson`-Projekt
 * — es läuft durch dieselbe Pipeline (Glossar, Terminologie, Review).
 *
 * Auth: persönlicher Panel-Schlüssel aus der Kopplung mit dem eigenen Konto
 * (`Authorization: Bearer`), übergangsweise noch `CEP_SERVICE_KEY` — Details und
 * Begründung in `middleware/panelAuth.ts`. Die beiden Kopplungs-Routen
 * `/pair` und `/pair/:id/poll` brauchen keinen Schlüssel; sie holen ihn ja erst.
 */

const router = Router();

const MAX_SEGMENTS = 5000;
const MAX_TEXT_CHARS = 100_000;
const MAX_TARGETS = 12;

function sendPanelError(res: Response, err: unknown, what: string): Response {
  if (err instanceof PanelAuthError) return res.status(err.status).json({ error: err.message });
  console.error(`[CEP] ${what} failed:`, err);
  return res.status(500).json({ error: 'Internal error' });
}

/**
 * POST /api/cep/pair
 * Kopplung anlegen. Das Panel zeigt den Code an und öffnet `verifyUrl` im Browser.
 * `pollSecret` bleibt im Panel — es steht in keiner URL.
 */
router.post('/pair', async (req: Request, res: Response) => {
  try {
    const pairing = await createPairing(req.body?.label, clientOf(req.ip));
    const verifyUrl = `${config.publicUrl.replace(/\/$/, '')}/?panel=${pairing.pairingId}`;
    return res.status(201).json({ ...pairing, verifyUrl });
  } catch (err) {
    return sendPanelError(res, err, 'Pairing');
  }
});

/**
 * POST /api/cep/pair/:pairingId/poll   Body: { pollSecret }
 * 202 = noch nicht bestätigt · 200 = Schlüssel (genau einmal) · 410 = abgelaufen/verbraucht
 */
router.post('/pair/:pairingId/poll', async (req: Request, res: Response) => {
  try {
    const result = await pollPairing(req.params.pairingId as string, req.body?.pollSecret);
    if (result.state === 'pending') return res.status(202).json({ state: 'pending' });
    return res.json(result);
  } catch (err) {
    return sendPanelError(res, err, 'Pairing poll');
  }
});

/** GET /api/cep/me — wer ist mit diesem Schlüssel angemeldet? */
router.get('/me', requirePanelAuth, (req: Request, res: Response) => {
  const auth = (req as PanelRequest).panelAuth!;
  if (auth.kind !== 'personal') return res.json({ kind: 'shared' });
  const u = auth.user!;
  return res.json({ kind: 'personal', user: { name: u.display_name || u.name || u.email, email: u.email } });
});

/** DELETE /api/cep/token — das Panel meldet sich ab und trennt seine Verbindung. */
router.delete('/token', requirePanelAuth, async (req: Request, res: Response) => {
  const auth = (req as PanelRequest).panelAuth!;
  if (auth.kind !== 'personal') return res.status(400).json({ error: 'Kein persönlicher Schlüssel' });
  try {
    await pool.query(
      `UPDATE panel_tokens SET revoked_at = NOW(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL`,
      [auth.tokenId, auth.user!.id],
    );
    return res.status(204).end();
  } catch (err) {
    return sendPanelError(res, err, 'Token revoke');
  }
});

/** Mit persönlichem Schlüssel sieht die Person nur ihre eigenen Aufträge. */
function ownerFilter(req: Request, alias: string, nextParam: number): { sql: string; params: unknown[] } {
  const auth = (req as PanelRequest).panelAuth!;
  if (auth.kind === 'personal') {
    return { sql: ` AND ${alias}created_by = $${nextParam}`, params: [auth.user!.id] };
  }
  return { sql: '', params: [] };
}

interface CepSegment {
  id: string;
  text: string;
}

interface CepJobRequest {
  segments: CepSegment[];
  source?: string;
  sourceLang: string;
  targetLangs: string[];
  glossaryDisabled?: boolean;
  channelCode?: string | null;
  optimizeSource?: boolean;
}

/**
 * POST /api/cep/jobs
 * Segmente aus Illustrator entgegennehmen, .aijson-Datei + Projekt(e) anlegen,
 * Übersetzung einreihen. Multi-Target erzeugt N Projekte mit sibling_group_id.
 */
router.post('/jobs', requirePanelAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body as CepJobRequest;

    // --- Validierung ---------------------------------------------------------
    if (!body || !Array.isArray(body.segments) || body.segments.length === 0) {
      return res.status(400).json({ error: 'segments (nicht-leeres Array) erforderlich' });
    }
    if (body.segments.length > MAX_SEGMENTS) {
      return res.status(413).json({ error: `Zu viele Segmente (${body.segments.length} > ${MAX_SEGMENTS})` });
    }
    const seen = new Set<string>();
    for (const s of body.segments) {
      if (!s || typeof s.id !== 'string' || s.id.length === 0 || typeof s.text !== 'string') {
        return res.status(400).json({ error: 'Jedes Segment braucht id (string) + text (string)' });
      }
      if (s.text.length > MAX_TEXT_CHARS) {
        return res.status(413).json({ error: `Segment "${s.id}" zu lang (> ${MAX_TEXT_CHARS} Zeichen)` });
      }
      if (seen.has(s.id)) {
        return res.status(400).json({ error: `Doppelte Segment-ID "${s.id}"` });
      }
      seen.add(s.id);
    }

    if (typeof body.sourceLang !== 'string' || body.sourceLang.trim() === '') {
      return res.status(400).json({ error: 'sourceLang erforderlich (z.B. "DE" oder "AUTO")' });
    }
    if (!Array.isArray(body.targetLangs) || body.targetLangs.length === 0) {
      return res.status(400).json({ error: 'targetLangs (nicht-leeres Array) erforderlich' });
    }
    const targetLangs = body.targetLangs
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim().toUpperCase());
    if (targetLangs.length === 0) {
      return res.status(400).json({ error: 'targetLangs enthält keine gültigen Codes' });
    }
    if (targetLangs.length > MAX_TARGETS) {
      return res.status(413).json({ error: `Zu viele Zielsprachen (max ${MAX_TARGETS})` });
    }

    const sourceLang = body.sourceLang.trim().toUpperCase();
    const glossaryDisabled = body.glossaryDisabled === true;
    const optimizeSource = body.optimizeSource === true;
    const channelCode: string | null = glossaryDisabled
      ? null
      : typeof body.channelCode === 'string' && body.channelCode.trim() !== ''
        ? body.channelCode.trim().toUpperCase()
        : null;

    // --- .aijson-Datei schreiben (gleiche Struktur wie export-text.jsx) -------
    const sourceName = (typeof body.source === 'string' && body.source.trim() !== '')
      ? body.source.trim()
      : 'illustrator';
    const aijson = {
      schema: `${AIJSON_SCHEMA_PREFIX}@1`,
      source: sourceName,
      segments: body.segments.map((s) => ({ id: s.id, text: s.text })),
    };

    const storedFilename = `${uuidv4()}.aijson`;
    const storedPath = path.join(config.upload.dir, storedFilename);
    fs.mkdirSync(config.upload.dir, { recursive: true });
    fs.writeFileSync(storedPath, JSON.stringify(aijson, null, 2), 'utf-8');
    const fileSize = Buffer.byteLength(JSON.stringify(aijson), 'utf-8');

    const originalFilename = sourceName.replace(/\.aijson$/i, '').replace(/\.ai$/i, '') + '.aijson';
    const projectBaseName = path.basename(originalFilename, '.aijson');

    // --- Projekt(e) anlegen + einreihen --------------------------------------
    const siblingGroupId =
      targetLangs.length > 1 ? (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id : null;

    // Mit persönlichem Schlüssel gehört der Auftrag der Person: Er steht unter
    // „Meine Dokumente", dort lässt sich ein Review anfordern. Mit dem gemeinsamen
    // Schlüssel bleibt er wie bisher ohne Besitzer.
    const auth = (req as PanelRequest).panelAuth!;
    const createdBy = auth.kind === 'personal' ? auth.user!.id : null;

    const created: Array<{ projectId: string; targetLang: string; jobId: string }> = [];
    for (const tl of targetLangs) {
      const result = await pool.query(
        `INSERT INTO projects
           (name, source_lang, target_lang, file_type, original_filename, stored_filename,
            file_size_bytes, created_by, sibling_group_id, channel_code, glossary_disabled, optimize_source)
         VALUES ($1, $2, $3, 'aijson', $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          projectBaseName, sourceLang, tl, originalFilename, storedFilename,
          fileSize, createdBy, siblingGroupId, channelCode, glossaryDisabled, optimizeSource,
        ],
      );
      const projectId = result.rows[0].id;
      const jobId = await enqueueTranslation(projectId);
      created.push({ projectId, targetLang: tl, jobId });
    }

    return res.status(201).json({
      source: sourceName,
      segmentCount: body.segments.length,
      siblingGroupId,
      projects: created,
    });
  } catch (err: any) {
    console.error('[CEP] Job creation failed:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

/**
 * GET /api/cep/jobs/:projectId
 * Status + Fortschritt eines Übersetzungsjobs.
 */
router.get('/jobs/:projectId', requirePanelAuth, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const owner = ownerFilter(req, 'p.', 2);
    const proj = await pool.query(
      `SELECT p.status, p.segment_count,
              COALESCE(j.progress, 0) AS progress, j.error
       FROM projects p
       LEFT JOIN jobs j ON j.project_id = p.id AND j.type = 'translate'
       WHERE p.id = $1${owner.sql}
       ORDER BY j.created_at DESC NULLS LAST
       LIMIT 1`,
      [projectId, ...owner.params],
    );
    if (proj.rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    const r = proj.rows[0];
    return res.json({
      projectId,
      status: r.status,
      progress: r.progress,
      segmentCount: r.segment_count,
      error: r.error ?? null,
    });
  } catch (err: any) {
    console.error('[CEP] Status query failed:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

/**
 * GET /api/cep/jobs/:projectId/result
 * Übersetzte Segmente [{id, text}] (final = condensed ?? translated).
 * Erst nach status='completed' verfügbar (sonst 409).
 */
router.get('/jobs/:projectId/result', requirePanelAuth, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const owner = ownerFilter(req, '', 2);
    const proj = await pool.query(
      `SELECT status, original_filename FROM projects WHERE id = $1${owner.sql}`,
      [projectId, ...owner.params],
    );
    if (proj.rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    if (proj.rows[0].status !== 'completed') {
      return res.status(409).json({ error: `Noch nicht fertig (status=${proj.rows[0].status})` });
    }

    const segResult = await pool.query(
      `SELECT COALESCE(ps.format_segment_id, ps.idml_segment_id) AS seg_id,
              COALESCE(s.condensed_text, s.translated_text) AS final_text
       FROM project_segments ps
       JOIN segments s ON ps.segment_id = s.id
       WHERE ps.project_id = $1 AND (s.translated_text IS NOT NULL OR s.condensed_text IS NOT NULL)
       ORDER BY ps.position`,
      [projectId],
    );

    const segments = segResult.rows.map((r: any) => ({ id: r.seg_id, text: r.final_text }));
    return res.json({
      schema: `${AIJSON_SCHEMA_PREFIX}@1`,
      source: proj.rows[0].original_filename,
      segments,
    });
  } catch (err: any) {
    console.error('[CEP] Result query failed:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

export default router;
