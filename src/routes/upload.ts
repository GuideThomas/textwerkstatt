import { Router, Request, Response } from 'express';
import { parseFormality } from '../services/formality';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { pdfBelegt } from '../demo/grenzen';
import { gehoertGast } from '../demo/eigene';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/connection';
import { config } from '../config';
import { SUPPORTED_FILE_TYPES, FileType } from '../types';
import { enqueueTranslation } from '../services/queue';
import { isChannelFassung } from '../services/channel-fassung';
import { AuthenticatedRequest } from '../middleware/auth';

// Multer-Storage mit eindeutigem Dateinamen
const storage = multer.diskStorage({
  destination: config.upload.dir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext in SUPPORTED_FILE_TYPES) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${ext}. Supported: ${Object.keys(SUPPORTED_FILE_TYPES).join(', ')}`));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.upload.maxFileSizeMb * 1024 * 1024 },
});

const router = Router();

// Datei hochladen und Projekt(e) erstellen.
// Multi-Target: target_langs (JSON-Array) erzeugt N parallele Projekte mit gemeinsamem sibling_group_id.
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  // Eine abgelehnte Anfrage lässt keine Datei liegen. Multer hat sie schon gespeichert, bevor die Felder geprüft sind; bis
  // 13.11.2026 blieb sie bei jedem 400 (Sprache fehlt, Anrede ungültig, DE → DE ohne Channel) für immer im Upload-Ordner.
  // Bei 4xx/5xx hat diese Route kein Projekt angelegt, das auf die Datei zeigt — außer beim Ersetzen (`project_id`), siehe unten.
  const abgelegt = req.file.path;
  let dateiVergeben = false;
  res.on('finish', () => {
    if (res.statusCode >= 400 && !dateiVergeben) fs.unlink(abgelegt, () => undefined);
  });
  // Demo: ein PDF zur Zeit (E3). Liest Docling gerade eines, wird das zweite gleich abgewiesen statt minutenlang zu warten.
  if (pdfBelegt() && path.extname(req.file.originalname).toLowerCase() === '.pdf') {
    fs.unlink(req.file.path, () => undefined);
    res.status(429).json({ error: 'In der Demo wird ein PDF nach dem anderen gelesen, und gerade läuft eines. Bitte in ein, zwei Minuten noch einmal.', code: 'demo_grenze' });
    return;
  }

  const { project_id, source_lang, target_lang, target_langs: targetLangsRaw, topic_ids: topicIdsRaw, parent_project_id, channel_code: channelCodeRaw, glossary_disabled: glossaryDisabledRaw, optimize_source: optimizeSourceRaw, format_profile: formatProfileRaw, formality: formalityRaw } = req.body;

  // Demo: eine neue Fassung nur zu eigenen Projekten (src/demo/eigene.ts); das Formular liest erst diese Route.
  if (config.demo.an) {
    const gast = (req as AuthenticatedRequest).user?.id ?? '';
    const ziele = [project_id, parent_project_id].filter((x): x is string => typeof x === 'string' && x !== '');
    if (!gast || !(await gehoertGast(gast, ziele))) {
      fs.unlink(req.file.path, () => undefined);
      res.status(404).json({ error: 'Project not found' });
      return;
    }
  }

  // Hinweis: `inject_storeview_prefix` wird nicht mehr ausgewertet — die
  // Store-View-Anpassung interner Links läuft seit 28.07.2026 für ALLE
  // Projekte (Entscheidung Thomas). Alt-Clients dürfen das Feld weiter senden,
  // es wird ignoriert. Siehe services/text/storeview.ts + Migration 020.

  if (!source_lang || !target_lang) {
    res.status(400).json({ error: 'source_lang and target_lang are required' });
    return;
  }

  // glossary_disabled = Neutral-Modus: keine Glossar- und keine Channel-Logik
  const glossaryDisabled =
    glossaryDisabledRaw === true ||
    glossaryDisabledRaw === 'true' ||
    glossaryDisabledRaw === '1';

  // Anredestufe des Projekts. Unbrauchbarer Wert wird abgewiesen statt still
  // auf 'default' zu fallen — sonst saehe eine wirkungslose Wahl aus wie eine
  // wirksame. Der Spalten-Default 'default' haelt alle anderen projektanlegenden
  // Routen (`cep.ts`, `projects.ts`) ohne Codeaenderung neutral.
  const formality = parseFormality(formalityRaw);
  if (formality === null) {
    res.status(400).json({ error: `formality muss 'default', 'more' oder 'less' sein` });
    return;
  }

  // optimize_source: LanguageTool Pre-Pass vor DeepL (silent High-Confidence-Fixes)
  const optimizeSource =
    optimizeSourceRaw === true ||
    optimizeSourceRaw === 'true' ||
    optimizeSourceRaw === '1';

  // format_profile: 'auto' (default) | 'magento-cms-page' | 'magento-product' | 'generic-csv'
  const allowedProfiles = new Set(['auto', 'magento-cms-page', 'magento-cms-block', 'magento-product', 'generic-csv']);
  const formatProfile =
    typeof formatProfileRaw === 'string' && allowedProfiles.has(formatProfileRaw)
      ? formatProfileRaw
      : 'auto';

  // channel_code optional, leerer/whitespace String → NULL (= Standard der Organisation)
  // Im Neutral-Modus erzwungen NULL.
  const channelCode: string | null = glossaryDisabled
    ? null
    : typeof channelCodeRaw === 'string' && channelCodeRaw.trim() !== ''
      ? channelCodeRaw.trim().toUpperCase()
      : null;

  // target_langs als JSON-Array (Multi-Target). Fallback: nur target_lang.
  let targetLangs: string[] = [target_lang];
  if (targetLangsRaw) {
    try {
      const parsed = typeof targetLangsRaw === 'string' ? JSON.parse(targetLangsRaw) : targetLangsRaw;
      if (Array.isArray(parsed) && parsed.length > 0) {
        targetLangs = parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch { /* ignore */ }
  }

  // Deutsch → Deutsch ist die Channel-Fassung (services/channel-fassung.ts) —
  // ohne Channel gäbe es nichts umzuschreiben, und DeepL lehnt DE → DE ab.
  if (!channelCode && targetLangs.some((tl) => isChannelFassung(source_lang, tl))) {
    res.status(400).json({ error: 'Für Deutsch → Deutsch einen Channel wählen' });
    return;
  }

  let topicIds: string[] = [];
  if (topicIdsRaw) {
    try {
      const parsed = typeof topicIdsRaw === 'string' ? JSON.parse(topicIdsRaw) : topicIdsRaw;
      if (Array.isArray(parsed)) topicIds = parsed.filter((x): x is string => typeof x === 'string');
    } catch { /* ignore */ }
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const fileType: FileType = SUPPORTED_FILE_TYPES[ext];
  const fileSize = req.file.size ?? 0;
  const userId = (req as AuthenticatedRequest).user?.id ?? null;

  try {
    // Bei project_id-Update: nur dieses Projekt, kein Multi-Target
    if (project_id) {
      await pool.query(
        `UPDATE projects SET
          file_type = $1, original_filename = $2, stored_filename = $3,
          file_size_bytes = $4, channel_code = $5, glossary_disabled = $6, optimize_source = $7, format_profile = $8, status = 'pending', updated_at = NOW()
         WHERE id = $9`,
        [fileType, req.file.originalname, req.file.filename, fileSize, channelCode, glossaryDisabled, optimizeSource, formatProfile, project_id]
      );
      dateiVergeben = true; // das Projekt zeigt jetzt auf die Datei, auch wenn das Einreihen danach scheitert
      const jobId = await enqueueTranslation(project_id);
      res.status(201).json({
        project_id, job_id: jobId,
        filename: req.file.originalname, file_type: fileType, status: 'queued',
      });
      return;
    }

    const name = path.basename(req.file.originalname, ext);
    // Bei N>1 ein gemeinsames sibling_group_id setzen
    const siblingGroupId = targetLangs.length > 1 ? (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id : null;

    // Versionsketten: Wenn parent_project_id gesetzt → version_number = parent.version_number + 1
    let versionNumber = 1;
    if (parent_project_id) {
      const parentRes = await pool.query<{ version_number: number }>(
        'SELECT version_number FROM projects WHERE id = $1',
        [parent_project_id]
      );
      versionNumber = (parentRes.rows[0]?.version_number ?? 0) + 1;
    }

    const createdProjects: { id: string; target_lang: string; job_id: string }[] = [];

    for (const tl of targetLangs) {
      const result = await pool.query(
        `INSERT INTO projects
          (name, source_lang, target_lang, file_type, original_filename, stored_filename,
           file_size_bytes, created_by, sibling_group_id, parent_project_id, version_number, channel_code, glossary_disabled, optimize_source, format_profile, formality)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [name, source_lang, tl, fileType, req.file.originalname, req.file.filename,
         fileSize, userId, siblingGroupId, parent_project_id || null, versionNumber, channelCode, glossaryDisabled, optimizeSource, formatProfile, formality]
      );
      const projectId = result.rows[0].id;
      dateiVergeben = true; // ab hier zeigt ein Projekt auf die Datei

      if (topicIds.length > 0) {
        await pool.query(
          `INSERT INTO project_topics (project_id, topic_id)
           SELECT $1, t.id FROM topics t WHERE t.id = ANY($2::uuid[])`,
          [projectId, topicIds]
        );
      }

      const jobId = await enqueueTranslation(projectId);
      createdProjects.push({ id: projectId, target_lang: tl, job_id: jobId });
    }

    // Response: erstes Projekt für Backwards-Compat + alle als projects-Array
    res.status(201).json({
      project_id: createdProjects[0].id,
      job_id: createdProjects[0].job_id,
      filename: req.file.originalname,
      file_type: fileType,
      status: 'queued',
      sibling_group_id: siblingGroupId,
      projects: createdProjects,
    });
  } catch (err) {
    console.error('Error processing upload:', err);
    res.status(500).json({ error: 'Failed to process upload' });
  }
});

export default router;
