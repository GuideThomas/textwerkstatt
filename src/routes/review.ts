import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { pool } from '../db/connection';
import { detectTerminologyCandidates, filterExistingGlossaryEntries } from '../services/terminology';
import { incrementGlossaryVersion } from './glossaries';
import { normalizeGlossaryLang } from '../services/lang';
import { alsBearbeiter, bearbeiterAusAnfrage } from '../db/bearbeiter';
import { schreibtDirekt, schlageBegriffVor, glossarDesSprachpaars, KEIN_GLOSSAR } from '../services/glossar-vorschlaege';
import { parseIdml, writeAndPackIdml, cleanupIdml } from '../services/idml';
import { parseDocx, writeAndPackDocx, cleanupDocx } from '../services/docx';
import { parseXlsx, writeXlsx } from '../services/xlsx';
import { parsePdf, writePdf } from '../services/pdf';
import { writeMarkup } from '../services/markup';
import { parseTextOrCsv, writeTextOrCsv } from '../services/text';
import { parseMarkdown, writeMarkdown } from '../services/markdown';
import { writeAijson } from '../services/aijson';
import { getFilePath } from '../services/storage';
import { revokeForSegments } from '../services/reviewRelease';

const router = Router();

/**
 * PUT /api/projects/:projectId/segments/:projectSegmentId
 * User editiert eine Übersetzung im Review-Editor.
 */
router.put('/:projectId/segments/:projectSegmentId', async (req: Request, res: Response) => {
  try {
    const { projectId, projectSegmentId } = req.params;
    const { translated_text } = req.body;

    if (!translated_text || typeof translated_text !== 'string') {
      return res.status(400).json({ error: 'translated_text is required' });
    }

    // Project + Segment laden
    const psResult = await pool.query(
      `SELECT ps.segment_id, s.translated_text, s.original_translation, s.source_text,
              p.source_lang, p.target_lang
       FROM project_segments ps
       JOIN segments s ON ps.segment_id = s.id
       JOIN projects p ON ps.project_id = p.id
       WHERE ps.id = $1 AND ps.project_id = $2`,
      [projectSegmentId, projectId],
    );

    if (psResult.rows.length === 0) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    const row = psResult.rows[0];
    const segmentId = row.segment_id;

    // Erstmaliger Edit: original_translation sichern
    if (!row.original_translation && row.translated_text) {
      await pool.query(
        `UPDATE segments SET original_translation = translated_text WHERE id = $1 AND original_translation IS NULL`,
        [segmentId],
      );
    }

    // Übersetzung aktualisieren
    await pool.query(
      `UPDATE segments SET translated_text = $2, review_status = 'edited', edited_by_user = TRUE, condensed_text = NULL
       WHERE id = $1`,
      [segmentId, translated_text.trim()],
    );

    // Geänderter Text hebt eine bestehende Freigabe auf (und meldet das).
    await revokeForSegments([segmentId], (req as AuthenticatedRequest).user ?? null);

    // Terminology-Detection
    const originalForDiff = row.original_translation || row.translated_text;
    let candidates = detectTerminologyCandidates(
      originalForDiff,
      translated_text.trim(),
      row.source_text,
      row.target_lang,
    );

    // Bestehende Glossar-Einträge filtern
    candidates = await filterExistingGlossaryEntries(candidates, row.source_lang, row.target_lang);

    res.json({ ok: true, candidates });
  } catch (err: any) {
    console.error('Error updating segment:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/segments/:projectSegmentId/approve
 * Segment als geprüft markieren.
 */
router.post('/:projectId/segments/:projectSegmentId/approve', async (req: Request, res: Response) => {
  try {
    const { projectId, projectSegmentId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.id ?? null;

    const psResult = await pool.query(
      `SELECT segment_id FROM project_segments WHERE id = $1 AND project_id = $2`,
      [projectSegmentId, projectId],
    );

    if (psResult.rows.length === 0) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    await pool.query(
      `UPDATE segments
          SET review_status = 'approved',
              approved_by = $2,
              approved_at = NOW(),
              clarification_note = NULL,
              clarification_by = NULL,
              clarification_at = NULL
        WHERE id = $1`,
      [psResult.rows[0].segment_id, userId],
    );

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error approving segment:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/segments/bulk-approve
 * Body: { project_segment_ids: string[] }
 *
 * Genehmigt mehrere Segmente in einer Transaktion. Verwendet vom UI-Button
 * "Alle sichtbaren genehmigen" sowie vom Shift-Click-Bulk-Select.
 */
router.post('/:projectId/segments/bulk-approve', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const { project_segment_ids } = req.body as { project_segment_ids?: string[] };
    const userId = (req as AuthenticatedRequest).user?.id ?? null;

    if (!Array.isArray(project_segment_ids) || project_segment_ids.length === 0) {
      return res.status(400).json({ error: 'project_segment_ids array required' });
    }
    if (project_segment_ids.length > 1000) {
      return res.status(400).json({ error: 'Maximal 1000 Segmente pro Bulk-Operation' });
    }

    const psResult = await pool.query(
      `SELECT segment_id FROM project_segments
        WHERE project_id = $1 AND id = ANY($2::uuid[])`,
      [projectId, project_segment_ids],
    );

    if (psResult.rows.length === 0) {
      return res.json({ approved: 0 });
    }

    const segmentIds = psResult.rows.map((r) => r.segment_id);
    const result = await pool.query(
      `UPDATE segments
          SET review_status = 'approved',
              approved_by = $2,
              approved_at = NOW(),
              clarification_note = NULL,
              clarification_by = NULL,
              clarification_at = NULL
        WHERE id = ANY($1::uuid[])
          AND translated_text IS NOT NULL`,
      [segmentIds, userId],
    );

    res.json({ approved: result.rowCount ?? 0 });
  } catch (err: any) {
    console.error('Error bulk-approving segments:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/segments/:projectSegmentId/unapprove
 * Approval ruecknehmen — Checkbox-Toggle vom Native-Speaker.
 * Setzt zurueck auf 'edited' wenn das Segment manuell editiert wurde,
 * sonst auf 'pending'.
 */
router.post('/:projectId/segments/:projectSegmentId/unapprove', async (req: Request, res: Response) => {
  try {
    const { projectId, projectSegmentId } = req.params;

    const psResult = await pool.query(
      `SELECT segment_id FROM project_segments WHERE id = $1 AND project_id = $2`,
      [projectSegmentId, projectId],
    );

    if (psResult.rows.length === 0) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    await pool.query(
      `UPDATE segments
          SET review_status = CASE WHEN edited_by_user = TRUE THEN 'edited' ELSE 'pending' END,
              approved_by = NULL,
              approved_at = NULL
        WHERE id = $1`,
      [psResult.rows[0].segment_id],
    );

    await revokeForSegments([psResult.rows[0].segment_id], (req as AuthenticatedRequest).user ?? null);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error unapproving segment:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/segments/:projectSegmentId/clarification
 * Body: { note?: string }  — leerer Body / DELETE-aequivalent loescht die Markierung
 *
 * Markiert ein Segment als "Unklar / Nachfragen". Der Native-Speaker kann
 * eine Notiz hinterlassen ("ist 'Strip' hier eine Lichtleiste oder ein Streifen?"),
 * statt selbst eine Annahme zu treffen.
 */
router.post('/:projectId/segments/:projectSegmentId/clarification', async (req: Request, res: Response) => {
  try {
    const { projectId, projectSegmentId } = req.params;
    const { note } = req.body as { note?: string };
    const userId = (req as AuthenticatedRequest).user?.id ?? null;

    const psResult = await pool.query(
      `SELECT segment_id FROM project_segments WHERE id = $1 AND project_id = $2`,
      [projectSegmentId, projectId],
    );

    if (psResult.rows.length === 0) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    const cleanedNote = typeof note === 'string' ? note.trim().slice(0, 1000) : null;

    await pool.query(
      `UPDATE segments
          SET review_status = 'needs_clarification',
              clarification_note = $2,
              clarification_by = $3,
              clarification_at = NOW(),
              approved_by = NULL,
              approved_at = NULL
        WHERE id = $1`,
      [psResult.rows[0].segment_id, cleanedNote, userId],
    );

    await revokeForSegments([psResult.rows[0].segment_id], (req as AuthenticatedRequest).user ?? null);

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error flagging clarification:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/projects/:projectId/segments/:projectSegmentId/clarification
 * Entfernt die Clarification-Markierung.
 */
router.delete('/:projectId/segments/:projectSegmentId/clarification', async (req: Request, res: Response) => {
  try {
    const { projectId, projectSegmentId } = req.params;

    const psResult = await pool.query(
      `SELECT segment_id FROM project_segments WHERE id = $1 AND project_id = $2`,
      [projectSegmentId, projectId],
    );

    if (psResult.rows.length === 0) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    await pool.query(
      `UPDATE segments
          SET review_status = CASE WHEN edited_by_user = TRUE THEN 'edited' ELSE 'pending' END,
              clarification_note = NULL,
              clarification_by = NULL,
              clarification_at = NULL
        WHERE id = $1`,
      [psResult.rows[0].segment_id],
    );

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error clearing clarification:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/terminology
 * Terminology-Kandidat als Glossar-Eintrag speichern.
 */
router.post('/:projectId/terminology', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const { context } = req.body;
    // Getrimmt speichern: Sonst gälte „Lichtleiste“ mit geschütztem Leerzeichen als neuer Begriff.
    const source_term = typeof req.body.source_term === 'string' ? req.body.source_term.trim() : '';
    const target_term = typeof req.body.target_term === 'string' ? req.body.target_term.trim() : '';

    if (!source_term || !target_term) {
      return res.status(400).json({ error: 'source_term and target_term are required' });
    }

    // Projekt-Sprachen holen
    const projResult = await pool.query(
      `SELECT source_lang, target_lang FROM projects WHERE id = $1`,
      [projectId],
    );

    if (projResult.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Sprachcodes normalisieren: Ein Projekt mit UI-Code `CS` legte sonst ein neuntes Glossar an.
    const source_lang = normalizeGlossaryLang(projResult.rows[0].source_lang);
    const target_lang = normalizeGlossaryLang(projResult.rows[0].target_lang);

    // Reviewer schlagen nur vor, ein Admin gibt frei (PLAN-glossar-freigabe.md, Entscheid Thomas 12.11.2026).
    if (!schreibtDirekt(req)) {
      const glossarId = await glossarDesSprachpaars(source_lang, target_lang);
      if (!glossarId) return res.status(409).json({ error: KEIN_GLOSSAR });
      const v = await schlageBegriffVor({
        glossaryId: glossarId, sourceTerm: source_term, targetTerm: target_term, context: context || null, quelle: 'review',
      }, bearbeiterAusAnfrage(req));
      if (v.status === 'unveraendert') return res.json({ ok: true, duplicate: true, entry_id: v.entry_id });
      return res.status(201).json({ ok: true, vorschlag: true, vorschlag_id: v.vorschlag_id, entry_id: v.entry_id });
    }

    // In einer Transaktion mit genanntem Bearbeiter: Den Verlauf schreibt der Trigger aus Migration 037. Bis 10.11.2026 legte dieser
    // Weg Zeilen ganz ohne Verlauf an (Plan Wortliste §1).
    const ergebnis = await alsBearbeiter(bearbeiterAusAnfrage(req), async (c) => {
      // Glossar finden oder erstellen
      const glossaryResult = await c.query(
        `SELECT id FROM glossaries WHERE source_lang = $1 AND target_lang = $2 LIMIT 1`,
        [source_lang, target_lang],
      );

      let glossaryId: string;
      if (glossaryResult.rows.length === 0) {
        const newGlossary = await c.query(
          `INSERT INTO glossaries (name, source_lang, target_lang)
           VALUES ($1, $2, $3) RETURNING id`,
          [`${source_lang}→${target_lang}`, source_lang, target_lang],
        );
        glossaryId = newGlossary.rows[0].id;
      } else {
        glossaryId = glossaryResult.rows[0].id;
      }

      // Duplikat-Check
      const dupCheck = await c.query(
        `SELECT id FROM glossary_entries
         WHERE glossary_id = $1 AND LOWER(source_term) = LOWER($2) AND LOWER(target_term) = LOWER($3)`,
        [glossaryId, source_term, target_term],
      );

      if (dupCheck.rows.length > 0) {
        return { duplicate: true, entryId: dupCheck.rows[0].id as string };
      }

      // Eintrag anlegen
      const entry = await c.query(
        `INSERT INTO glossary_entries (glossary_id, source_term, target_term, context, source, approved)
         VALUES ($1, $2, $3, $4, 'auto-detected', FALSE)
         RETURNING id`,
        [glossaryId, source_term, target_term, context || null],
      );

      await incrementGlossaryVersion(glossaryId, [source_term], c);
      return { duplicate: false, entryId: entry.rows[0].id as string };
    });

    if (ergebnis.duplicate) return res.json({ ok: true, duplicate: true, entry_id: ergebnis.entryId });
    res.json({ ok: true, entry_id: ergebnis.entryId });
  } catch (err: any) {
    console.error('Error creating terminology entry:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/projects/:projectId/download
 * Übersetzte IDML-Datei generieren und herunterladen.
 */
router.get('/:projectId/download', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    // Projekt laden
    const projResult = await pool.query(
      `SELECT stored_filename, original_filename, file_type, format_profile, target_lang FROM projects WHERE id = $1`,
      [projectId],
    );

    if (projResult.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = projResult.rows[0];
    const supportedTypes = ['idml', 'docx', 'xlsx', 'pdf', 'xml', 'html', 'txt', 'csv', 'md', 'aijson'];
    if (!supportedTypes.includes(project.file_type)) {
      return res.status(400).json({ error: `Download für ${project.file_type} noch nicht verfügbar` });
    }

    const inputPath = getFilePath(project.stored_filename);
    if (!fs.existsSync(inputPath)) {
      return res.status(410).json({ error: 'Originaldatei nicht mehr vorhanden (24h Auto-Delete)' });
    }

    // Segmente mit finalem Text laden (generisch via format_segment_id, Fallback auf idml_segment_id)
    const segResult = await pool.query(
      `SELECT COALESCE(ps.format_segment_id, ps.idml_segment_id) AS seg_id,
              COALESCE(s.condensed_text, s.translated_text) AS final_text
       FROM project_segments ps
       JOIN segments s ON ps.segment_id = s.id
       WHERE ps.project_id = $1 AND (s.translated_text IS NOT NULL OR s.condensed_text IS NOT NULL)
       ORDER BY ps.position`,
      [projectId],
    );

    const translations = segResult.rows.map((r: any) => ({
      segmentId: r.seg_id,
      translatedText: r.final_text,
    }));

    const ext = project.file_type as string;
    const baseName = (project.original_filename || 'translated').replace(new RegExp(`\\.${ext}$`, 'i'), '');
    // Zielsprache statt generischem "translated" anhaengen, damit aus dem
    // Dateinamen Sprache (und ueber den beibehaltenen Basisnamen die Dokument-
    // version, z.B. "...1a") hervorgeht: "Halon_Produktinfo1a_HU.idml".
    const langSuffix = (project.target_lang || '').toString().trim().toUpperCase();
    const outputFilename = langSuffix
      ? `${baseName}_${langSuffix}.${ext}`
      : `${baseName}_translated.${ext}`;
    const outputPath = path.join(os.tmpdir(), `tt_${Date.now()}_${outputFilename}`);

    try {
      if (project.file_type === 'idml') {
        const parseResult = parseIdml(inputPath);
        try {
          writeAndPackIdml(parseResult, translations, outputPath);
        } finally {
          cleanupIdml(parseResult);
        }
      } else if (project.file_type === 'docx') {
        const parseResult = parseDocx(inputPath);
        try {
          writeAndPackDocx(parseResult, translations, outputPath);
        } finally {
          cleanupDocx(parseResult);
        }
      } else if (project.file_type === 'xlsx') {
        const parseResult = await parseXlsx(inputPath);
        await writeXlsx(parseResult, translations, outputPath);
      } else if (project.file_type === 'pdf') {
        const parseResult = await parsePdf(inputPath);
        await writePdf(parseResult, translations, outputPath);
      } else if (project.file_type === 'xml' || project.file_type === 'html') {
        // Markup: entweder ein "root"-Segment (Standard-Pfad) oder mehrere
        // `cell:*`-Segmente (SpreadsheetML per-cell). writeMarkup branched intern.
        writeMarkup(translations, outputPath, {
          inputPath,
          formatProfile: project.format_profile ?? null,
        });
      } else if (project.file_type === 'txt' || project.file_type === 'csv') {
        // TXT/CSV: Original re-parsen um Struktur (Zeilen/Zellen, Quoting, Delimiter)
        // zu rekonstruieren, dann segment-IDs durch Übersetzungen ersetzen.
        const parseResult = parseTextOrCsv(inputPath, project.file_type, project.format_profile);
        const map = new Map<string, string>();
        for (const t of translations) map.set(t.segmentId, t.translatedText);
        writeTextOrCsv(parseResult.internal, map, outputPath);
      } else if (project.file_type === 'md') {
        // Markdown: Original re-parsen um Code-Block-Mapping zu rekonstruieren,
        // übersetzten Text demaskieren und schreiben.
        const parseResult = parseMarkdown(inputPath);
        writeMarkdown(parseResult.internal, translations, outputPath);
      } else if (project.file_type === 'aijson') {
        // Illustrator-Austausch: Original-JSON re-parsen (Reihenfolge + schema/
        // source erhalten), text pro stabiler ID durch Übersetzung ersetzen.
        writeAijson(inputPath, translations, outputPath);
      }

      res.download(outputPath, outputFilename, (err) => {
        try { fs.unlinkSync(outputPath); } catch {}
      });
    } catch (writeErr) {
      try { fs.unlinkSync(outputPath); } catch {}
      throw writeErr;
    }
  } catch (err: any) {
    console.error('Error generating download:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/projects/:projectId/token-usage
 * LLM-Kosten für ein Projekt.
 */
router.get('/:projectId/token-usage', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;

    const result = await pool.query(
      `SELECT
         COALESCE(SUM(cost_usd), 0)::float AS total_cost,
         COUNT(*)::int AS total_calls
       FROM token_usage WHERE project_id = $1`,
      [projectId],
    );

    const byModel = await pool.query(
      `SELECT model, COUNT(*)::int AS count, COALESCE(SUM(cost_usd), 0)::float AS cost
       FROM token_usage WHERE project_id = $1
       GROUP BY model ORDER BY cost DESC`,
      [projectId],
    );

    const byPurpose = await pool.query(
      `SELECT purpose, COUNT(*)::int AS count, COALESCE(SUM(cost_usd), 0)::float AS cost
       FROM token_usage WHERE project_id = $1
       GROUP BY purpose ORDER BY cost DESC`,
      [projectId],
    );

    res.json({
      totalCost: result.rows[0].total_cost,
      totalCalls: result.rows[0].total_calls,
      byModel: byModel.rows,
      byPurpose: byPurpose.rows,
    });
  } catch (err: any) {
    console.error('Error fetching token usage:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
