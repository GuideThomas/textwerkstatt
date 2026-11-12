import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/connection';
import { config } from '../config';
import { enqueueTerminologyScan } from '../services/queue';
import { normalizeGlossaryLang } from '../services/lang';
import { addClient } from '../services/sse';
import { incrementGlossaryVersion } from './glossaries';
import { alsBearbeiter, bearbeiterAusAnfrage } from '../db/bearbeiter';
import { schreibtDirekt, schlageBegriffVor, glossarDesSprachpaars, KEIN_GLOSSAR } from '../services/glossar-vorschlaege';
import { SCAN_SUPPORTED_EXTENSIONS, ScanFileType } from '../types';

const router = Router();

// Multer für Zwei-Dateien-Upload
const storage = multer.diskStorage({
  destination: config.upload.dir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const scanUpload = multer({
  storage,
  limits: { fileSize: config.upload.maxFileSizeMb * 1024 * 1024 },
});

// Upload: Source + Translation Dateien
router.post(
  '/upload',
  scanUpload.fields([
    { name: 'source', maxCount: 1 },
    { name: 'translation', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    if (!files?.source?.[0] || !files?.translation?.[0]) {
      res.status(400).json({ error: 'Both source and translation files are required' });
      return;
    }

    const sourceFile = files.source[0];
    const translationFile = files.translation[0];
    const { source_lang, target_lang, glossary_id } = req.body;

    if (!source_lang || !target_lang) {
      res.status(400).json({ error: 'source_lang and target_lang are required' });
      return;
    }

    const ext = path.extname(sourceFile.originalname).toLowerCase();
    const fileType: ScanFileType | undefined = SCAN_SUPPORTED_EXTENSIONS[ext];

    if (!fileType) {
      res.status(400).json({
        error: `Unsupported file type: ${ext}. Supported: ${Object.keys(SCAN_SUPPORTED_EXTENSIONS).join(', ')}`,
      });
      return;
    }

    try {
      const name = `Scan: ${path.basename(sourceFile.originalname, ext)}`;

      const result = await pool.query(
        `INSERT INTO terminology_scans
          (name, source_lang, target_lang, source_file_type, source_filename, translation_filename,
           source_stored_filename, translation_stored_filename, glossary_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [name, source_lang, target_lang, fileType,
         sourceFile.originalname, translationFile.originalname,
         sourceFile.filename, translationFile.filename,
         glossary_id || null],
      );

      const scanId = result.rows[0].id;
      await enqueueTerminologyScan(scanId);

      res.status(201).json({
        scan_id: scanId,
        name,
        file_type: fileType,
        status: 'pending',
      });
    } catch (err) {
      console.error('Error creating terminology scan:', err);
      res.status(500).json({ error: 'Failed to create terminology scan' });
    }
  },
);

// Alle Scans auflisten
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM terminology_scans ORDER BY created_at DESC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing scans:', err);
    res.status(500).json({ error: 'Failed to list scans' });
  }
});

// Scan-Details
router.get('/:scanId', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT * FROM terminology_scans WHERE id = $1`,
      [req.params.scanId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error getting scan:', err);
    res.status(500).json({ error: 'Failed to get scan' });
  }
});

// Kandidaten mit Filter + Pagination
router.get('/:scanId/candidates', async (req: Request, res: Response) => {
  try {
    const { category, status, minConfidence, limit = '100', offset = '0' } = req.query;

    let query = `SELECT * FROM terminology_candidates WHERE scan_id = $1`;
    const params: any[] = [req.params.scanId];
    let paramIdx = 2;

    if (category) {
      query += ` AND category = $${paramIdx++}`;
      params.push(category);
    }
    if (status) {
      query += ` AND status = $${paramIdx++}`;
      params.push(status);
    }
    if (minConfidence) {
      query += ` AND confidence >= $${paramIdx++}`;
      params.push(parseFloat(minConfidence as string));
    }

    query += ` ORDER BY confidence DESC, position ASC`;
    query += ` LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(Math.min(parseInt(limit as string, 10), 500));
    params.push(parseInt(offset as string, 10));

    const result = await pool.query(query, params);

    // Zähler für Stats
    const countResult = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE status = 'approved') AS approved,
         COUNT(*) FILTER (WHERE status = 'vorgeschlagen') AS vorgeschlagen,
         COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
         COUNT(*) FILTER (WHERE category = 'TERMINOLOGY') AS terminology,
         COUNT(*) FILTER (WHERE category = 'STYLE') AS style,
         COUNT(*) FILTER (WHERE category = 'ERROR') AS error_cat,
         COUNT(*) FILTER (WHERE category = 'CONTEXT') AS context
       FROM terminology_candidates WHERE scan_id = $1`,
      [req.params.scanId],
    );

    res.json({
      candidates: result.rows,
      stats: countResult.rows[0],
    });
  } catch (err) {
    console.error('Error listing candidates:', err);
    res.status(500).json({ error: 'Failed to list candidates' });
  }
});

// Bulk Approve
router.post('/:scanId/candidates/approve', async (req: Request, res: Response) => {
  const { ids } = req.body as { ids: string[] };
  if (!ids || ids.length === 0) {
    res.status(400).json({ error: 'ids array is required' });
    return;
  }

  try {
    // Scan holen für Sprachpaar
    const scanResult = await pool.query(
      `SELECT source_lang, target_lang, glossary_id FROM terminology_scans WHERE id = $1`,
      [req.params.scanId],
    );
    if (scanResult.rows.length === 0) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }
    const scan = scanResult.rows[0];

    // Nicht-Admins übernehmen nicht, sie schlagen vor (PLAN-glossar-freigabe.md, Entscheid Thomas 12.11.2026). Ein Glossar legen sie
    // nicht an; der Kandidat steht danach auf `vorgeschlagen`, bis ein Admin den Vorschlag auf der Glossarseite entscheidet.
    if (!schreibtDirekt(req)) {
      const glossarId = scan.glossary_id
        ?? await glossarDesSprachpaars(normalizeGlossaryLang(scan.source_lang), normalizeGlossaryLang(scan.target_lang));
      if (!glossarId) {
        res.status(409).json({ error: KEIN_GLOSSAR });
        return;
      }
      const kandidaten = await pool.query(
        `SELECT * FROM terminology_candidates WHERE scan_id = $1 AND id = ANY($2) AND status = 'pending'`,
        [req.params.scanId, ids],
      );
      let vorgeschlagen = 0;
      let ohneZiel = 0;
      for (const c of kandidaten.rows) {
        const quellBegriff = (c.source_term ?? '').trim();
        const zielBegriff = (c.existing_term ?? '').trim();
        if (!quellBegriff || !zielBegriff) {
          ohneZiel++;
          continue;
        }
        const v = await schlageBegriffVor({
          glossaryId: glossarId, sourceTerm: quellBegriff, targetTerm: zielBegriff,
          context: c.explanation, category: c.category, quelle: 'terminologie-scan', kandidatId: String(c.id),
        }, bearbeiterAusAnfrage(req));
        // Steht der Begriff schon so im Glossar, ist der Kandidat erledigt wie bei einem Admin.
        await pool.query(
          `UPDATE terminology_candidates SET status = $3, glossary_entry_id = $2 WHERE id = $1`,
          [c.id, v.entry_id, v.status === 'unveraendert' ? 'approved' : 'vorgeschlagen'],
        );
        if (v.status === 'vorschlag') vorgeschlagen++;
      }
      res.status(201).json({
        vorschlag: true, approved: 0, inserted: 0, vorgeschlagen, uebersprungen: ohneZiel, glossary_id: glossarId,
      });
      return;
    }

    // Glossar finden oder erstellen — Sprachcodes normalisieren, sonst legt ein
    // Scan mit UI-Code `CS` ein zweites, konkurrierendes Tschechisch-Glossar an.
    const scanSourceLang = normalizeGlossaryLang(scan.source_lang);
    const scanTargetLang = normalizeGlossaryLang(scan.target_lang);
    let glossaryId = scan.glossary_id;
    if (!glossaryId) {
      const existing = await pool.query(
        `SELECT id FROM glossaries WHERE source_lang = $1 AND target_lang = $2 LIMIT 1`,
        [scanSourceLang, scanTargetLang],
      );

      if (existing.rows.length > 0) {
        glossaryId = existing.rows[0].id;
      } else {
        // Mit Bearbeiter: Der Trigger aus Migration 031 befüllt ein neues Glossar, den Verlauf dazu schreibt Migration 037.
        const newGlossary = await alsBearbeiter(bearbeiterAusAnfrage(req), (c) => c.query(
          `INSERT INTO glossaries (name, source_lang, target_lang) VALUES ($1, $2, $3) RETURNING id`,
          [`${scanSourceLang} → ${scanTargetLang}`, scanSourceLang, scanTargetLang],
        ));
        glossaryId = newGlossary.rows[0].id;
      }
    }

    // Kandidaten laden
    const candidatesResult = await pool.query(
      `SELECT * FROM terminology_candidates WHERE scan_id = $1 AND id = ANY($2) AND status = 'pending'`,
      [req.params.scanId, ids],
    );

    let insertedCount = 0;
    let uebersprungen = 0;
    const neueBegriffe: string[] = [];

    for (const c of candidatesResult.rows) {
      // Getrimmt speichern: Sonst gälte ein Begriff mit geschütztem Leerzeichen als neuer Begriff.
      const quellBegriff = (c.source_term ?? '').trim();
      const zielBegriff = (c.existing_term ?? '').trim();
      // Ohne Zielbegriff gibt es nichts zu übernehmen; die Datenbank lehnt leeren Text ab.
      if (!quellBegriff || !zielBegriff) {
        uebersprungen++;
        continue;
      }

      // Duplikat-Check (case-insensitive)
      const dupCheck = await pool.query(
        `SELECT id FROM glossary_entries
         WHERE glossary_id = $1 AND LOWER(source_term) = LOWER($2) AND LOWER(target_term) = LOWER($3)`,
        [glossaryId, quellBegriff, zielBegriff],
      );

      if (dupCheck.rows.length > 0) {
        // Bereits vorhanden → Kandidat als approved markieren
        await pool.query(
          `UPDATE terminology_candidates SET status = 'approved', glossary_entry_id = $2 WHERE id = $1`,
          [c.id, dupCheck.rows[0].id],
        );
        continue;
      }

      // Glossar-Eintrag erstellen. Mit Bearbeiter: Bis 10.11.2026 legte dieser Weg Zeilen ganz ohne Verlauf an (Plan Wortliste §1).
      const entryResult = await alsBearbeiter(bearbeiterAusAnfrage(req), (k) => k.query(
        `INSERT INTO glossary_entries (glossary_id, source_term, target_term, context, category, approved, source)
         VALUES ($1, $2, $3, $4, $5, TRUE, 'auto-detected')
         RETURNING id`,
        [glossaryId, quellBegriff, zielBegriff, c.explanation, c.category],
      ));

      // Kandidat als approved markieren
      await pool.query(
        `UPDATE terminology_candidates SET status = 'approved', glossary_entry_id = $2 WHERE id = $1`,
        [c.id, entryResult.rows[0].id],
      );

      insertedCount++;
      neueBegriffe.push(quellBegriff);
    }

    // Glossar-Version inkrementieren wenn neue Einträge
    if (insertedCount > 0) {
      await incrementGlossaryVersion(glossaryId, neueBegriffe);
    }

    res.json({
      approved: candidatesResult.rows.length - uebersprungen,
      inserted: insertedCount,
      uebersprungen,
      glossary_id: glossaryId,
    });
  } catch (err) {
    console.error('Error approving candidates:', err);
    res.status(500).json({ error: 'Failed to approve candidates' });
  }
});

// Bulk Reject
router.post('/:scanId/candidates/reject', async (req: Request, res: Response) => {
  const { ids } = req.body as { ids: string[] };
  if (!ids || ids.length === 0) {
    res.status(400).json({ error: 'ids array is required' });
    return;
  }

  try {
    await pool.query(
      `UPDATE terminology_candidates SET status = 'rejected' WHERE scan_id = $1 AND id = ANY($2)`,
      [req.params.scanId, ids],
    );
    res.json({ ok: true, rejected: ids.length });
  } catch (err) {
    console.error('Error rejecting candidates:', err);
    res.status(500).json({ error: 'Failed to reject candidates' });
  }
});

// SSE Progress
router.get('/:scanId/progress', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`data: ${JSON.stringify({ phase: 'connected', progress: 0, detail: 'Verbunden' })}\n\n`);
  addClient(req.params.scanId as string, res);
});

// Scan löschen
router.delete('/:scanId', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `DELETE FROM terminology_scans WHERE id = $1 RETURNING id`,
      [req.params.scanId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Scan not found' });
      return;
    }
    res.json({ ok: true, deleted: req.params.scanId });
  } catch (err) {
    console.error('Error deleting scan:', err);
    res.status(500).json({ error: 'Failed to delete scan' });
  }
});

export default router;
