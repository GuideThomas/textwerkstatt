import PgBoss from 'pg-boss';
import crypto from 'crypto';
import { config } from '../config';
import { demoKontext } from '../demo/grenzen';
import { pool } from '../db/connection';
import { getFilePath } from './storage';
import { parseIdml, cleanupIdml } from './idml';
import type { IdmlSegment } from './idml';
import { parseDocx, cleanupDocx } from './docx';
import type { DocxSegment } from './docx';
import { parseXlsx, cleanupXlsx } from './xlsx';
import type { XlsxSegment } from './xlsx';
import { parsePdf, cleanupPdf } from './pdf';
import type { PdfSegment } from './pdf';
import { parseMarkup, getMarkupDeepLOptions } from './markup';
import { parseAijson } from './aijson';
import {
  isSpreadsheetML,
  protectSpreadsheetML,
  parseTranslatableCells,
  SPREADSHEETML_IGNORE_TAG,
} from './markup/spreadsheetml';
import { parseTextOrCsv } from './text';
import { parseMarkdown } from './markdown';
import { translateBatch, ensureGlossarySynced, translateText } from './deepl';
import { normalizeGlossaryLang } from './lang';
import { emitProgress } from './sse';
import { needsCondensing, condenseSegments } from './condensing';
import { ladeBegriffe } from './begriffe-im-text';
import type { CondenseCandidate } from './condensing';
import { processTerminologyScan } from './terminology-scan';
import {
  getChannelOverrides,
  applyPreReplacementBatch,
  applyPostReplacementBatch,
} from './channel-overrides';
import type { ChannelOverride } from './channel-overrides';
import { detectPlaceholders } from './placeholder-detector';
import { isChannelFassung, rewriteForChannel } from './channel-fassung';
import {
  prepareMagentoHtmlCell,
  assembleMagentoHtmlCell,
  MAGENTO_INNER_IGNORE_TAG,
  tryTitleSuffixMap,
  sanitizeStrayEscapes,
} from './text/magento-html';
// Die Reihenfolge der Markup-Schutzschritte liegt in html-pipeline.ts — dieselbe
// Schicht nutzt die Schnelluebersetzung (routes/quick-translate.ts). Wer hier
// einen Schritt ergaenzt, ergaenzt ihn dort.
import {
  protectCode,
  restoreCode,
  protectMarkup,
  restoreMarkup,
  protectAttributes,
  protectAttributesBatch,
  restoreAttributes,
  warnOnSentinelLeak,
  type CodeBlockCtx,
  type MarkupCtx,
  type AttrCtx,
} from './text/html-pipeline';
import {
  protectAcronymsWithGlossary,
  restoreAcronyms,
} from './acronym-protection';
import { protectPoleCounts, restorePoleCounts } from './conductor-protection';
import { protectUnits, restoreUnits } from './unit-protection';
import { translateJsonLdBlocks } from './text/jsonld';
import { correctTargetCapitalization } from './languagetool';
import { effectiveFormality, type Formality } from './formality';
import { llmCorrectCapitalization, HONORIFIC_PRONOUNS } from './capitalization-llm';

let boss: PgBoss | null = null;

export async function startQueue(): Promise<PgBoss> {
  boss = new PgBoss({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    schema: 'pgboss',
  });

  boss.on('error', (err) => {
    console.error('pg-boss error:', err);
  });

  await boss.start();
  console.log('pg-boss queue started');

  // pg-boss v10+ requires explicit queue creation (partitioned tables)
  await boss.createQueue('translate');
  await boss.createQueue('terminology-scan');

  await boss.work('translate', { batchSize: 1 }, async ([job]) => {
    const { project_id } = job.data as { project_id: string };
    console.log(`[Queue] Processing translation job for project ${project_id}`);

    await pool.query(
      `UPDATE jobs SET status = 'processing', started_at = NOW() WHERE project_id = $1 AND type = 'translate' AND status = 'queued'`,
      [project_id]
    );

    try {
      await pool.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [project_id]
      );

      // Projekt-Infos holen
      const projectResult = await pool.query(
        `SELECT id, stored_filename, file_type, source_lang, target_lang, channel_code, glossary_disabled, optimize_source, optimize_target_casing, protect_acronym_suffixes, format_profile, formality, created_by FROM projects WHERE id = $1`,
        [project_id]
      );

      if (projectResult.rows.length === 0) {
        throw new Error(`Project ${project_id} not found`);
      }

      const project = projectResult.rows[0];
      // Demo: Der Hintergrundlauf kennt keine Anfrage; die Zeichen zählen auf den Gast, dem das Projekt gehört (src/demo/grenzen.ts).
      if (config.demo.an && project.created_by) demoKontext.enterWith({ wer: String(project.created_by) });

      if (project.file_type === 'idml') {
        await processIdmlProject(project);
      } else if (project.file_type === 'docx') {
        await processDocxProject(project);
      } else if (project.file_type === 'xlsx') {
        await processXlsxProject(project);
      } else if (project.file_type === 'pdf') {
        await processPdfProject(project);
      } else if (project.file_type === 'xml' || project.file_type === 'html') {
        await processMarkupProject(project);
      } else if (project.file_type === 'txt' || project.file_type === 'csv') {
        await processTextProject(project);
      } else if (project.file_type === 'md') {
        await processMarkdownProject(project);
      } else if (project.file_type === 'aijson') {
        await processAijsonProject(project);
      } else {
        console.log(`[Queue] File type ${project.file_type} not supported`);
      }

      await pool.query(
        `UPDATE projects SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [project_id]
      );
      await pool.query(
        `UPDATE jobs SET status = 'completed', progress = 100, completed_at = NOW() WHERE project_id = $1 AND type = 'translate'`,
        [project_id]
      );

      emitProgress(project_id, { phase: 'completed', progress: 100, detail: 'Fertig' });
      console.log(`[Queue] Translation job completed for project ${project_id}`);
    } catch (err: any) {
      console.error(`[Queue] Translation job failed for project ${project_id}:`, err);

      await pool.query(
        `UPDATE projects SET status = 'error', updated_at = NOW() WHERE id = $1`,
        [project_id]
      );
      await pool.query(
        `UPDATE jobs SET status = 'error', error = $2, completed_at = NOW() WHERE project_id = $1 AND type = 'translate'`,
        [project_id, err.message || 'Unknown error']
      );

      emitProgress(project_id, { phase: 'error', progress: 0, detail: err.message });
    }
  });

  // Terminology-Scan Worker
  await boss.work('terminology-scan', { batchSize: 1 }, async ([job]) => {
    const { scan_id } = job.data as { scan_id: string };
    console.log(`[Queue] Processing terminology scan ${scan_id}`);

    try {
      await processTerminologyScan(scan_id);
      console.log(`[Queue] Terminology scan completed: ${scan_id}`);
    } catch (err: any) {
      console.error(`[Queue] Terminology scan failed for ${scan_id}:`, err);

      await pool.query(
        `UPDATE terminology_scans SET status = 'error', error = $2, updated_at = NOW() WHERE id = $1`,
        [scan_id, err.message || 'Unknown error'],
      );

      emitProgress(scan_id, { phase: 'error', progress: 0, detail: err.message });
    }
  });

  // Recovery: Re-enqueue orphaned jobs that are stuck in 'queued' status
  // This handles cases where pg-boss lost jobs due to server restarts
  const orphaned = await pool.query(
    `SELECT j.id, j.project_id, j.type FROM jobs j
     WHERE j.status = 'queued' AND j.created_at < NOW() - INTERVAL '30 seconds'`
  );
  for (const job of orphaned.rows) {
    console.log(`[Queue] Re-enqueuing orphaned ${job.type} job for project ${job.project_id}`);
    if (job.type === 'translate') {
      await boss.send('translate', { project_id: job.project_id, job_id: job.id });
    } else if (job.type === 'terminology-scan') {
      await boss.send('terminology-scan', { scan_id: job.id });
    }
  }
  if (orphaned.rows.length > 0) {
    console.log(`[Queue] Re-enqueued ${orphaned.rows.length} orphaned job(s)`);
  }

  return boss;
}

/**
 * Terminologie-Scan in die Queue einreihen.
 */
export async function enqueueTerminologyScan(scanId: string): Promise<void> {
  if (boss) {
    await boss.send('terminology-scan', { scan_id: scanId });
    console.log(`[Queue] Terminology scan enqueued: ${scanId}`);
  }
}

/**
 * Bei `source_lang='AUTO'` ein Probe-Translate mit einem repraesentativen Segment
 * an DeepL schicken, `detectedSourceLang` extrahieren und das Projekt darauf
 * umpinnen. Ohne diesen Schritt landen Cache + Glossar-Lookup unter 'AUTO' und
 * verfehlen das eigentliche Sprachpaar (DE→x usw.).
 *
 * Wird VOR den upsertSegment-Calls aufgerufen, damit Cache-Inserts und
 * project_segments mit dem richtigen Sprachcode landen.
 */
async function resolveAutoSourceLang(
  project: any,
  segmentsRaw: Array<{ text: string }>,
): Promise<void> {
  if (project.source_lang && project.source_lang.toUpperCase() !== 'AUTO') return;
  if (!config.deepl.apiKey) return;
  if (segmentsRaw.length === 0) return;

  // Repraesentatives Sample: laengstes Segment >20 Zeichen, sonst erstes nicht-leeres
  const candidate = [...segmentsRaw]
    .filter(s => s.text && s.text.trim().length > 0)
    .sort((a, b) => b.text.length - a.text.length)[0];
  const probe = candidate?.text;
  if (!probe) return;

  // Auf 500 Zeichen begrenzen — reicht zur Sprachdetektion und spart DeepL-Zeichen
  const probeText = probe.slice(0, 500);

  try {
    const result = await translateText(probeText, 'AUTO', project.target_lang);
    const detected = result.detectedSourceLang?.toUpperCase();
    if (!detected) {
      console.warn(`[Queue] AUTO-Detection lieferte keine Sprache für Projekt ${project.id}`);
      return;
    }
    console.log(`[Queue] AUTO → ${detected} für Projekt ${project.id}`);

    await pool.query(
      `UPDATE projects SET source_lang = $2, updated_at = NOW() WHERE id = $1`,
      [project.id, detected],
    );
    project.source_lang = detected;
  } catch (err: any) {
    console.error(`[Queue] AUTO-Detection fehlgeschlagen, fallback auf AUTO:`, err.message);
  }
}

/**
 * Verarbeitet ein IDML-Projekt: Parsen → Segmente → DeepL-Übersetzung.
 */
async function processIdmlProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);
  const parseResult = parseIdml(filePath);

  try {
    const segments = parseResult.segments;
    console.log(`[Queue] Parsed ${segments.length} segments from IDML`);

    emitProgress(project.id, {
      phase: 'parsing',
      progress: 20,
      detail: `${segments.length} Segmente extrahiert`,
    });

    // Fortschritt: 20% nach Parsing
    await pool.query(
      `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
      [project.id]
    );

    // AUTO-Quellsprache aufloesen, BEVOR Segmente unter source_lang persistiert werden
    await resolveAutoSourceLang(project, segments);

    // Segmente in DB speichern + Cache-Hits identifizieren
    const segmentRecords: SegmentRecord[] = [];
    let position = 0;

    for (const seg of segments) {
      const record = await upsertSegment(seg, segmentKeyOf(project));

      await pool.query(
        `INSERT INTO project_segments (project_id, segment_id, idml_segment_id, story_file, paragraph_index, content_map, max_chars, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          project.id,
          record.id,
          seg.id,
          seg.storyFile,
          seg.paragraphIndex,
          JSON.stringify(seg.contentMap),
          seg.maxChars,
          position++,
        ]
      );

      segmentRecords.push(record);
    }

    // segment_count aktualisieren
    await pool.query(
      `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
      [project.id, segments.length]
    );

    console.log(`[Queue] Stored ${segments.length} segments for project ${project.id}`);

    // Gemeinsame Übersetzungs- und Condensing-Logik
    await translateAndCondense(project, segmentRecords);
  } finally {
    cleanupIdml(parseResult);
  }
}

interface SegmentRecord {
  id: string;
  sourceText: string;
  hasTranslation: boolean;
  isStale: boolean;
}

/**
 * Upsert: Segment in Cache einfügen oder bestehenden Cache-Eintrag finden.
 * Generisch für alle Formate — braucht nur { text }.
 *
 * Lookup-Strategie:
 * 1. Exakter Hash → schnellster Pfad (sequenzielle Wiederholungen identischer Texte)
 * 2. Normalisierter Hash → Whitespace/Quote/Dash-Varianten matchen
 * 3. Cache-Miss → Neuer Eintrag mit beiden Hashes
 */
/**
 * Vollstaendiger Cache-Schluessel eines Segments. ALLE Felder sind Pflicht —
 * bewusst kein positionaler Parameter mit Default: jede uebersehene
 * Aufrufstelle bekaeme still den Default und schriebe in die falsche
 * Cache-Zeile. Mit Pflichtfeldern zeigt der Typecheck jede Stelle an.
 *
 * ⚠️ Der Typecheck ist trotzdem NICHT die ganze Struktur: `batch-translate.ts`
 * und `terminology-scan.ts` lesen und schreiben `segments` mit eigenem SQL an
 * dieser Funktion vorbei. Beide tragen die Schluesselbedingung seit 14.08.2026
 * ausgeschrieben — wer hier eine Dimension ergaenzt, muss dort nachziehen.
 */
export interface SegmentKey {
  sourceLang: string;
  targetLang: string;
  channelCode: string | null;
  glossaryDisabled: boolean;
  /** Anredestufe: 'default' | 'more' | 'less'. Siehe migrations/021_formality.sql. */
  formality: string;
  /**
   * Wem die Cache-Zeile gehört: `null` = gemeinsamer Cache (jede Installation ohne Demo), in der Demo der Gast, dem das
   * Projekt gehört. Siehe migrations/051_segment_besitzer.sql.
   */
  besitzer: string | null;
}

/**
 * Besitzer der Cache-Zeilen eines Projekts. Ohne Demo immer `null`. In der Demo der Gast — und fehlt er, wird NICHT still der
 * gemeinsame Cache genommen (das wäre die Lücke, die der Besitzer schließt), sondern der Lauf bricht ab.
 */
export function besitzerVon(project: { created_by?: string | null }, demoAn: boolean = config.demo.an): string | null {
  if (!demoAn) return null;
  if (!project.created_by) throw new Error('Demo: Projekt ohne Besitzer (created_by) — kein Zugriff auf den Segment-Cache');
  return String(project.created_by);
}

/**
 * Leitet den Schluessel aus dem Projekt ab — eine Stelle, an der die Zuordnung
 * Projekt → Cache-Dimension steht, statt neunmal derselbe Ausdruck.
 */
export function segmentKeyOf(project: {
  source_lang: string;
  target_lang: string;
  channel_code?: string | null;
  glossary_disabled?: boolean | null;
  formality?: string | null;
  created_by?: string | null;
}): SegmentKey {
  return {
    sourceLang: project.source_lang,
    targetLang: project.target_lang,
    channelCode: project.channel_code ?? null,
    glossaryDisabled: project.glossary_disabled ?? false,
    formality: project.formality ?? 'default',
    besitzer: besitzerVon(project),
  };
}

export async function upsertSegment(
  seg: { text: string },
  key: SegmentKey,
): Promise<SegmentRecord> {
  const { sourceLang, targetLang, channelCode, glossaryDisabled, formality, besitzer } = key;
  const { hashText, normalizedHash } = await import('./text-normalize');
  const hash = hashText(seg.text);
  const normHash = normalizedHash(seg.text);

  // Channel-aware Cache: NULL = Standard-Channel; Channel-spezifische Einträge
  // sind getrennt, weil Pre-Replacement zu DeepL andere Übersetzungen produziert.
  // Neutral (glossary_disabled) ist eine zusätzliche Cache-Dimension, damit
  // glossar-aware und neutrale Übersetzungen sich nicht gegenseitig vergiften.
  const channelMatch = channelCode === null
    ? 'channel_code IS NULL'
    : 'channel_code = $4';
  const channelParams = channelCode === null ? [] : [channelCode];
  const glossaryParamIdx = 4 + channelParams.length;
  // `formality` ist seit 021 Teil des Schluessels: derselbe Text unter `more`
  // und `less` ergibt verschiedene Uebersetzungen. Fehlte die Bedingung, gaebe
  // der Cache die formelle Fassung als Treffer fuer eine informelle Anfrage.
  // `besitzer` ist seit 051 Teil des Schluessels: ohne Demo immer NULL (ein gemeinsamer Cache), in der Demo der Gast.
  // `IS NOT DISTINCT FROM` trifft NULL mit NULL; fehlte die Bedingung, bekaeme ein Gast die Zeile eines anderen als Treffer
  // und schriebe beim Bearbeiten in dessen Dokument.
  const glossaryClause =
    ` AND glossary_disabled = $${glossaryParamIdx} AND formality = $${glossaryParamIdx + 1}` +
    ` AND besitzer IS NOT DISTINCT FROM $${glossaryParamIdx + 2}::uuid`;

  // 1) Exakter Hash-Treffer (channel-aware + neutral-aware)
  const existing = await pool.query(
    `SELECT id, translated_text, is_stale, normalized_hash FROM segments
     WHERE segment_hash = $1 AND source_lang = $2 AND target_lang = $3 AND ${channelMatch}${glossaryClause}`,
    [hash, sourceLang, targetLang, ...channelParams, glossaryDisabled, formality, besitzer]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    await pool.query(`UPDATE segments SET hit_count = hit_count + 1 WHERE id = $1`, [row.id]);
    if (!row.normalized_hash) {
      await pool.query(`UPDATE segments SET normalized_hash = $1 WHERE id = $2`, [normHash, row.id]);
    }
    return {
      id: row.id,
      sourceText: seg.text,
      hasTranslation: !!row.translated_text,
      isStale: row.is_stale,
    };
  }

  // 2) Normalized-Hash-Treffer (channel-aware + neutral-aware)
  //
  // `ORDER BY is_stale ASC` (29.07.2026): existieren zu einem normalisierten Hash
  // mehrere Zeilen, gewinnt eine FRISCHE. Vorher entschied `LIMIT 1` ohne
  // Sortierung willkürlich — ein zufällig gewählter stale-Zwilling erzwang eine
  // Neuübersetzung, obwohl eine gültige Übersetzung danebenlag. Das ist der
  // einzige Teil dieser Änderung, der DeepL-Aufrufe spart.
  const fuzzy = await pool.query(
    `SELECT id, translated_text, is_stale, glossary_version FROM segments
     WHERE normalized_hash = $1 AND source_lang = $2 AND target_lang = $3 AND ${channelMatch}${glossaryClause}
       AND translated_text IS NOT NULL
     ORDER BY is_stale ASC, glossary_version DESC
     LIMIT 1`,
    [normHash, sourceLang, targetLang, ...channelParams, glossaryDisabled, formality, besitzer]
  );

  if (fuzzy.rows.length > 0) {
    const row = fuzzy.rows[0];
    // `is_stale` wird MITGENOMMEN statt auf FALSE gesetzt (Variante b, 29.07.2026).
    //
    // Vorher wusch dieser Pfad die Markierung: eine als stale markierte
    // Übersetzung wurde in eine neue Zeile mit `is_stale = FALSE` kopiert und
    // damit nie wieder geprüft — jede `restale-*`-Remediation lief im Fuzzy-Fall
    // ins Leere, und ein Glossar-Update erreichte die Kopie nicht.
    //
    // Die übernommene Übersetzung bleibt als Fallback stehen: schlägt DeepL im
    // Lauf fehl, zeigt das Segment den alten Text statt gar nichts, und die
    // Review-UI kann gegen den Vorzustand diffen.
    const inserted = await pool.query(
      `INSERT INTO segments
         (segment_hash, normalized_hash, source_lang, target_lang, channel_code, glossary_disabled, formality,
          source_text, translated_text, glossary_version, is_stale, hit_count, besitzer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12)
       RETURNING id`,
      [hash, normHash, sourceLang, targetLang, channelCode, glossaryDisabled, formality, seg.text, row.translated_text, row.glossary_version ?? 0, row.is_stale, besitzer]
    );
    return {
      id: inserted.rows[0].id,
      sourceText: seg.text,
      hasTranslation: true,
      isStale: row.is_stale,
    };
  }

  // 3) Cache-Miss: Neuen Eintrag anlegen
  const result = await pool.query(
    `INSERT INTO segments (segment_hash, normalized_hash, source_lang, target_lang, channel_code, glossary_disabled, formality, source_text, besitzer)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [hash, normHash, sourceLang, targetLang, channelCode, glossaryDisabled, formality, seg.text, besitzer]
  );

  return {
    id: result.rows[0].id,
    sourceText: seg.text,
    hasTranslation: false,
    isStale: false,
  };
}

/**
 * Phase 4: Smart Condensing — Prüft alle übersetzten Segmente auf Längen-Überschreitung
 * und kürzt sie via LLM.
 */
async function runCondensingPhase(project: any): Promise<void> {
  // XML/CSV/HTML komplett vom Condensing ausnehmen: LLM-Kuerzen zerstoert
  // Markup, Code-Tags, CDATA, Magento-Konstanten und CSV-Zellgrenzen.
  // DeepL Tag-Handling (v2) erhaelt die Struktur sauber — Laengen-Toleranz
  // muss layoutseitig geloest werden, nicht durch Nach-Kuerzen.
  if (
    project.file_type === 'xml' ||
    project.file_type === 'csv' ||
    project.file_type === 'html' ||
    project.file_type === 'aijson'
  ) {
    console.log(
      `[Queue] Condensing skipped for project ${project.id} (file_type=${project.file_type})`,
    );
    return;
  }

  // Alle Segmente des Projekts mit Übersetzung laden
  // WICHTIG: format_metadata mitlesen — HTML-Mode-Segmente (Magento-CMS-Page-Content)
  // werden vom Condensing ausgenommen, weil das LLM-Kuerzen das HTML-Markup zerstoert.
  const segResult = await pool.query(
    `SELECT ps.segment_id, ps.max_chars, ps.format_metadata, s.source_text, s.translated_text
     FROM project_segments ps
     JOIN segments s ON ps.segment_id = s.id
     WHERE ps.project_id = $1
       AND s.translated_text IS NOT NULL
       AND s.condensed_text IS NULL
     ORDER BY ps.position`,
    [project.id],
  );

  // Kandidaten filtern: Nur Segmente die zu lang sind UND kein HTML-Markup enthalten
  const candidates: CondenseCandidate[] = [];
  for (const row of segResult.rows) {
    // HTML-Cells (CSV-Profil + SpreadsheetML per-Cell-Modus) skippen — das LLM
    // wuerde Tags/Attribute uppercase machen, &quot; einbauen, Comments uebersetzen.
    const meta = row.format_metadata || {};
    const segMode = meta.mode || meta.cellMode;
    if (segMode === 'html') continue;
    if (needsCondensing(row.source_text, row.translated_text, row.max_chars)) {
      candidates.push({
        segmentId: row.segment_id,
        sourceText: row.source_text,
        translatedText: row.translated_text,
        maxChars: row.max_chars,
        projectId: project.id,
      });
    }
  }

  if (candidates.length === 0) {
    console.log(`[Queue] No segments need condensing for project ${project.id}`);
    return;
  }

  console.log(`[Queue] ${candidates.length} segments need condensing for project ${project.id}`);

  await pool.query(
    `UPDATE projects SET status = 'condensing', updated_at = NOW() WHERE id = $1`,
    [project.id],
  );

  emitProgress(project.id, {
    phase: 'condensing',
    progress: 90,
    detail: `${candidates.length} Segmente werden gekürzt...`,
  });

  // Glossarbegriffe des Sprachpaars und Channels; je Segment gehen nur die passenden an das Modell (`begriffe-im-text.ts`).
  // Dokumente sind Fließtext: nur, was an DeepL geht, ohne die Einträge nur für Namen.
  const begriffe = project.glossary_disabled
    ? []
    : await ladeBegriffe(project.source_lang, project.target_lang, { channel: project.channel_code ?? null }).catch(() => []);

  // Condensing ausführen
  const { results, totalCost } = await condenseSegments(
    candidates,
    project.target_lang,
    begriffe.length > 0 ? begriffe : undefined,
    (done, total) => {
      const progress = 90 + Math.round((done / total) * 5);
      emitProgress(project.id, {
        phase: 'condensing',
        progress,
        detail: `${done}/${total} Segmente gekürzt`,
      });
    },
  );

  // condense_status in project_segments persistieren (für Review-Editor Farb-Markierung)
  for (const r of results) {
    if (r.status !== 'ok') {
      await pool.query(
        `UPDATE project_segments SET condense_status = $1
         WHERE segment_id = $2 AND project_id = $3`,
        [r.status, r.segmentId, project.id],
      );
    }
  }

  const condensed = results.filter(r => r.status === 'condensed').length;
  const stillLong = results.filter(r => r.status === 'still_long').length;
  const manualReview = results.filter(r => r.status === 'manual_review').length;

  console.log(`[Queue] Condensing done: ${condensed} OK, ${stillLong} still long, ${manualReview} manual review, cost: $${totalCost.toFixed(4)}`);
}

/**
 * Verarbeitet ein DOCX-Projekt: Parsen → Segmente → DeepL-Übersetzung.
 */
async function processDocxProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);
  const parseResult = parseDocx(filePath);

  try {
    const segments = parseResult.segments;
    console.log(`[Queue] Parsed ${segments.length} segments from DOCX`);

    emitProgress(project.id, {
      phase: 'parsing',
      progress: 20,
      detail: `${segments.length} Segmente aus DOCX extrahiert`,
    });

    await pool.query(
      `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
      [project.id]
    );

    // AUTO-Quellsprache aufloesen, BEVOR Segmente unter source_lang persistiert werden
    await resolveAutoSourceLang(project, segments);

    // Segmente in DB speichern
    const segmentRecords: SegmentRecord[] = [];
    let position = 0;

    for (const seg of segments) {
      const record = await upsertSegment(seg, segmentKeyOf(project));

      await pool.query(
        `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          project.id,
          record.id,
          seg.id,
          JSON.stringify({ source: seg.source, xmlFile: seg.xmlFile, paragraphIndex: seg.paragraphIndex, styleId: seg.styleId }),
          null,
          position++,
        ]
      );

      segmentRecords.push(record);
    }

    await pool.query(
      `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
      [project.id, segments.length]
    );

    // Gemeinsame Übersetzungs- und Condensing-Logik
    await translateAndCondense(project, segmentRecords);
  } finally {
    cleanupDocx(parseResult);
  }
}

/**
 * Verarbeitet ein XLSX-Projekt: Parsen → Segmente → DeepL-Übersetzung.
 */
async function processXlsxProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);
  const parseResult = await parseXlsx(filePath);

  try {
    const segments = parseResult.segments;
    console.log(`[Queue] Parsed ${segments.length} segments from XLSX`);

    emitProgress(project.id, {
      phase: 'parsing',
      progress: 20,
      detail: `${segments.length} Textzellen aus XLSX extrahiert`,
    });

    await pool.query(
      `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
      [project.id]
    );

    // AUTO-Quellsprache aufloesen, BEVOR Segmente unter source_lang persistiert werden
    await resolveAutoSourceLang(project, segments);

    // Segmente in DB speichern
    const segmentRecords: SegmentRecord[] = [];
    let position = 0;

    for (const seg of segments) {
      const record = await upsertSegment(seg, segmentKeyOf(project));

      await pool.query(
        `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          project.id,
          record.id,
          seg.id,
          JSON.stringify({ sheet: seg.sheet, cell: seg.cell, row: seg.row, col: seg.col }),
          null,
          position++,
        ]
      );

      segmentRecords.push(record);
    }

    await pool.query(
      `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
      [project.id, segments.length]
    );

    // Gemeinsame Übersetzungs- und Condensing-Logik
    await translateAndCondense(project, segmentRecords);
  } finally {
    cleanupXlsx();
  }
}

/**
 * Verarbeitet ein PDF-Projekt: Docling-Extraktion → Segmente → DeepL-Übersetzung.
 */
async function processPdfProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);

  emitProgress(project.id, {
    phase: 'parsing',
    progress: 5,
    detail: 'PDF wird von Docling analysiert...',
  });

  const parseResult = await parsePdf(filePath);

  const segments = parseResult.segments;
  console.log(`[Queue] Parsed ${segments.length} segments from PDF`);

  emitProgress(project.id, {
    phase: 'parsing',
    progress: 20,
    detail: `${segments.length} Segmente aus ${parseResult.pageCount} Seiten extrahiert`,
  });

  await pool.query(
    `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
    [project.id]
  );

  // AUTO-Quellsprache aufloesen, BEVOR Segmente unter source_lang persistiert werden
  await resolveAutoSourceLang(project, segments);

  // Segmente in DB speichern
  const segmentRecords: SegmentRecord[] = [];
  let position = 0;

  for (const seg of segments) {
    const record = await upsertSegment(seg, segmentKeyOf(project));

    await pool.query(
      `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        project.id,
        record.id,
        seg.id,
        JSON.stringify({ pageNumber: seg.pageNumber, bbox: seg.bbox, fontSize: seg.fontSize, label: seg.label }),
        null,
        position++,
      ]
    );

    segmentRecords.push(record);
  }

  await pool.query(
    `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
    [project.id, segments.length]
  );

  // Gemeinsame Übersetzungs- und Condensing-Logik
  await translateAndCondense(project, segmentRecords);
}

/**
 * Verarbeitet ein XML/HTML-Projekt als ein Segment und übergibt es DeepL mit
 * passendem tagHandling. Der gesamte File-Inhalt wird 1:1 mit erhaltener
 * Tag-Struktur übersetzt — Code-Tags bleiben unberuehrt, nur Textknoten werden
 * übersetzt. Bei HTML zusätzlich script/style/code/pre als ignoreTags.
 */
async function processTextProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);
  const fileType = project.file_type as 'txt' | 'csv';
  const parseResult = parseTextOrCsv(filePath, fileType, project.format_profile);
  const segments = parseResult.segments;
  const csvProfileId =
    parseResult.internal.kind === 'csv' ? parseResult.internal.data.profileId : undefined;

  console.log(
    `[Queue] Parsed ${segments.length} segments from ${fileType.toUpperCase()}` +
      (csvProfileId ? ` (profile: ${csvProfileId})` : ''),
  );

  emitProgress(project.id, {
    phase: 'parsing',
    progress: 20,
    detail: `${segments.length} ${fileType === 'csv' ? 'Zellen' : 'Zeilen'} aus ${fileType.toUpperCase()} extrahiert`,
  });

  await pool.query(
    `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
    [project.id],
  );

  await resolveAutoSourceLang(project, segments);

  // Segment-Modes (Profil-Pfad für CSV) + Magento-Tokens für HTML-Spalten
  const segmentModes = new Map<string, 'text' | 'html'>();
  let preservedTokens: string[] = [];
  if (csvProfileId) {
    const { getCsvProfileById } = await import('./text/csv-profiles');
    const profile = getCsvProfileById(csvProfileId);
    if (profile?.preservedTokens) preservedTokens = profile.preservedTokens;
  }

  const segmentRecords: SegmentRecord[] = [];
  let position = 0;
  for (const seg of segments) {
    const record = await upsertSegment(seg, segmentKeyOf(project));
    if (seg.mode) segmentModes.set(record.id, seg.mode);
    await pool.query(
      `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        project.id,
        record.id,
        seg.id,
        JSON.stringify({ textType: fileType, mode: seg.mode || 'text', csvProfile: csvProfileId }),
        null,
        position++,
      ],
    );
    segmentRecords.push(record);
  }

  await pool.query(
    `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
    [project.id, segments.length],
  );

  await translateAndCondense(project, segmentRecords, { segmentModes, preservedTokens });
}

async function processMarkdownProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);
  const parseResult = parseMarkdown(filePath);
  const segments = parseResult.segments;

  console.log(`[Queue] Parsed Markdown — ${parseResult.internal.replacements.size} Code-Bloecke maskiert`);

  emitProgress(project.id, {
    phase: 'parsing',
    progress: 20,
    detail: `Markdown eingelesen (${parseResult.internal.replacements.size} Code-Bloecke geschützt)`,
  });

  await pool.query(
    `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
    [project.id],
  );

  await resolveAutoSourceLang(project, segments);

  const segmentRecords: SegmentRecord[] = [];
  let position = 0;
  for (const seg of segments) {
    const record = await upsertSegment(seg, segmentKeyOf(project));
    await pool.query(
      `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        project.id,
        record.id,
        seg.id,
        JSON.stringify({ textType: 'md', maskedCodeBlocks: parseResult.internal.replacements.size }),
        null,
        position++,
      ],
    );
    segmentRecords.push(record);
  }

  await pool.query(
    `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
    [project.id, segments.length],
  );

  await translateAndCondense(project, segmentRecords);
}

/**
 * Illustrator-Austauschformat (.aijson, erzeugt von export-text.jsx).
 * Flache Liste von TextFrame-Inhalten mit stabilen IDs — reiner Text, kein
 * Markup. Condensing ist fuer aijson global ausgenommen (Design-Layout wird
 * nicht nachgekuerzt; Overflow loest Illustrator beim Reimport selbst).
 */
async function processAijsonProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);
  const parseResult = parseAijson(filePath);
  const segments = parseResult.segments;

  console.log(
    `[Queue] Parsed ${segments.length} Illustrator-Segmente aus .aijson` +
      (parseResult.source ? ` (Quelle: ${parseResult.source})` : ''),
  );

  emitProgress(project.id, {
    phase: 'parsing',
    progress: 20,
    detail: `${segments.length} Textrahmen aus Illustrator extrahiert`,
  });

  await pool.query(
    `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
    [project.id],
  );

  await resolveAutoSourceLang(project, segments);

  const segmentRecords: SegmentRecord[] = [];
  let position = 0;
  for (const seg of segments) {
    const record = await upsertSegment(seg, segmentKeyOf(project));
    await pool.query(
      `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        project.id,
        record.id,
        seg.id,
        JSON.stringify({ textType: 'aijson', source: parseResult.source ?? null }),
        null,
        position++,
      ],
    );
    segmentRecords.push(record);
  }

  await pool.query(
    `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
    [project.id, segments.length],
  );

  await translateAndCondense(project, segmentRecords);
}

async function processMarkupProject(project: any): Promise<void> {
  const filePath = getFilePath(project.stored_filename);
  const parseResult = parseMarkup(filePath);
  const segments = parseResult.segments;

  // Magento-Profil ermitteln (explizite Wahl oder Content-Sniffing für XML).
  // Liefert preservedTokens (1column, inner, ...) und xmlIgnoreTags (page_layout,
  // identifier, ...) zum Schutz technischer Werte vor DeepL.
  let preservedTokens: string[] = [];
  let xmlIgnoreTags: string[] = [];
  let profileIdUsed: string | undefined;
  let spreadsheetCells: ReturnType<typeof parseTranslatableCells> | null = null;
  if (project.file_type === 'xml' || project.file_type === 'html') {
    const { getCsvProfileById, detectXmlProfile } = await import('./text/csv-profiles');
    let profile;
    if (project.format_profile && project.format_profile !== 'auto') {
      profile = getCsvProfileById(project.format_profile);
    }
    if (!profile && segments[0]?.text) {
      profile = detectXmlProfile(segments[0].text);
    }
    if (profile) {
      preservedTokens = profile.preservedTokens || [];
      xmlIgnoreTags = profile.xmlIgnoreTags || [];
      profileIdUsed = profile.id;

      // SpreadsheetML + Magento → per-Zelle-Pipeline (HTML-Cells brauchen DeepL HTML-Modus,
      // Whole-File-XML-Pass droppt Tags weil escapter HTML als Text behandelt wird).
      if (project.file_type === 'xml' && isSpreadsheetML(segments[0].text)) {
        spreadsheetCells = parseTranslatableCells(segments[0].text, profile);
        if (spreadsheetCells.length > 0) {
          console.log(
            `[Queue] SpreadsheetML per-cell mode: ${spreadsheetCells.length} translatable cells ` +
              `(${spreadsheetCells.filter((c) => c.mode === 'html').length} HTML, ` +
              `${spreadsheetCells.filter((c) => c.mode === 'text').length} text)`,
          );
        } else {
          // Fallback: alte Schutz-Logik (Header + technische Cells)
          const original = segments[0].text;
          const protectedText = protectSpreadsheetML(original, profile);
          if (protectedText !== original) {
            segments[0] = { ...segments[0], text: protectedText };
            xmlIgnoreTags = [...xmlIgnoreTags, SPREADSHEETML_IGNORE_TAG];
          }
        }
      }
    }
  }

  // Per-Zelle-Pipeline: jede uebersetzbare Zelle wird ein eigener Segment-Record.
  // Beim Download re-parst writeMarkup das Original und setzt die uebersetzten
  // Cell-Texte per cell-ID an die richtige Position ein.
  if (spreadsheetCells && spreadsheetCells.length > 0) {
    await resolveAutoSourceLang(project, [{ text: spreadsheetCells[0].text }]);

    emitProgress(project.id, {
      phase: 'parsing',
      progress: 20,
      detail: `${spreadsheetCells.length} Zellen extrahiert (per-Zelle-Modus)`,
    });
    await pool.query(
      `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
      [project.id],
    );

    const segmentModes = new Map<string, 'text' | 'html'>();
    const cellRecords: SegmentRecord[] = [];
    let position = 0;
    for (const cell of spreadsheetCells) {
      const record = await upsertSegment({ text: cell.text }, segmentKeyOf(project));
      await pool.query(
        `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          project.id,
          record.id,
          cell.id,
          JSON.stringify({
            markupType: 'xml-spreadsheet',
            cellMode: cell.mode,
            column: cell.column,
            rowIdx: cell.rowIdx,
            colIdx: cell.colIdx,
          }),
          null,
          position++,
        ],
      );
      cellRecords.push(record);
      segmentModes.set(record.id, cell.mode);
    }

    await pool.query(
      `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
      [project.id, cellRecords.length],
    );

    // Kein markupType — Pipeline schaltet pro Segment basierend auf segmentModes
    // zwischen Text- und HTML-DeepL-Modus um. preservedTokens (Magento-Konstanten)
    // greifen weiterhin fuer HTML-Cells.
    await translateAndCondense(project, cellRecords, {
      segmentModes,
      preservedTokens,
    });
    return;
  }

  console.log(
    `[Queue] Parsed ${segments.length} markup segment(s) from ${project.file_type}` +
      (profileIdUsed ? ` (profile: ${profileIdUsed})` : ''),
  );

  emitProgress(project.id, {
    phase: 'parsing',
    progress: 20,
    detail: `Markup-Datei eingelesen (${(Buffer.byteLength(segments[0].text, 'utf-8') / 1024).toFixed(1)} KB)`,
  });

  await pool.query(
    `UPDATE jobs SET progress = 20 WHERE project_id = $1 AND type = 'translate'`,
    [project.id],
  );

  // AUTO-Quellsprache aufloesen
  await resolveAutoSourceLang(project, segments);

  const segmentRecords: SegmentRecord[] = [];
  let position = 0;

  for (const seg of segments) {
    const record = await upsertSegment(seg, segmentKeyOf(project));

    await pool.query(
      `INSERT INTO project_segments (project_id, segment_id, format_segment_id, format_metadata, max_chars, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        project.id,
        record.id,
        seg.id,
        JSON.stringify({ markupType: project.file_type, encoding: parseResult.encoding ?? null }),
        null,
        position++,
      ],
    );

    segmentRecords.push(record);
  }

  await pool.query(
    `UPDATE projects SET segment_count = $2, updated_at = NOW() WHERE id = $1`,
    [project.id, segments.length],
  );

  // Markup nutzt eigenen DeepL-Pfad (tagHandling), aber Cache + Channel-Pipeline werden mit-genutzt
  await translateAndCondense(project, segmentRecords, {
    markupType: project.file_type as 'xml' | 'html',
    preservedTokens,
    extraIgnoreTags: xmlIgnoreTags,
  });
}

/**
 * Gemeinsame Logik für DeepL-Übersetzung + Smart Condensing.
 * Wird von allen Format-Processoren nach dem Segment-Speichern aufgerufen.
 */
/**
 * Channel-Fassung eines DE→DE-Projekts: jedes offene Segment über
 * `rewriteForChannel`, Ergebnis als `translated_text`, die Art der Änderung in
 * `channel_rewrite` (Migration 025) für die Review-Ansicht.
 */
async function rewriteChannelFassungSegments(
  project: any,
  untranslated: SegmentRecord[],
  cached: number,
  total: number,
): Promise<void> {
  if (!project.channel_code) {
    throw new Error('Deutsch → Deutsch braucht einen Channel (Channel-Fassung)');
  }
  const { fassungen, begriffe, eigene } = await rewriteForChannel(
    untranslated.map((s) => s.sourceText),
    project.channel_code,
    { projectId: project.id },
  );

  for (let i = 0; i < untranslated.length; i++) {
    const f = fassungen[i];
    const info = f.herkunft === 'unverändert'
      ? null
      : JSON.stringify({ herkunft: f.herkunft, treffer: f.treffer, pruefen: f.pruefen });
    await pool.query(
      `UPDATE segments
          SET translated_text = $2, glossary_version = 0, is_stale = FALSE, channel_rewrite = $3
        WHERE id = $1`,
      [untranslated[i].id, f.text, info],
    );
  }

  const modell = fassungen.filter((f) => f.herkunft === 'sprachmodell').length;
  const regel = fassungen.filter((f) => f.herkunft === 'regel').length;
  console.log(
    `[Queue] Channel-Fassung ${project.channel_code}: ${untranslated.length} Segmente, ` +
      `${modell} Sprachmodell, ${regel} nach Regel (prüfen) · Liste ${begriffe} Begriffe, davon ${eigene} eigene`,
  );
  emitProgress(project.id, {
    phase: 'translating',
    progress: 90,
    detail: `Channel-Fassung ${project.channel_code}: ${modell + regel} Segmente umgeschrieben`,
    translated: total,
    total,
    cacheHits: cached,
  });
}

async function translateAndCondense(
  project: any,
  segmentRecords: SegmentRecord[],
  opts: {
    markupType?: 'xml' | 'html';
    /** Pro Segment-DB-ID den Translation-Mode (CSV-Profil-Pfad). */
    segmentModes?: Map<string, 'text' | 'html'>;
    /** Tokens, die in HTML-Modus-Segmenten vor DeepL geschützt werden (Magento-Konstanten). */
    preservedTokens?: string[];
    /** Zusätzliche XML/HTML-Tags für DeepL ignoreTags (z.B. Magento `<identifier>`). */
    extraIgnoreTags?: string[];
  } = {},
): Promise<void> {
  // Adobe-Latein / Lorem-Ipsum-Detektor: scannt die Quellsegmente und
  // persistiert das Ergebnis am Projekt. Laeuft VOR DeepL, damit die Warnung
  // unabhaengig vom DeepL-API-Key auch in der Pipeline-Liste auftaucht.
  // Fehlschlag soll die Uebersetzung nicht blockieren — nur loggen.
  try {
    const detection = detectPlaceholders(
      segmentRecords.map((s, idx) => ({ id: `seg-${idx}`, text: s.sourceText })),
    );
    await pool.query(
      `UPDATE projects SET placeholder_warning = $2, updated_at = NOW() WHERE id = $1`,
      [project.id, JSON.stringify(detection)],
    );
    if (detection.triggered) {
      console.warn(
        `[Queue] Project ${project.id}: Platzhalter erkannt — ` +
          `${detection.placeholderCount}/${detection.totalSegments} Segmente verdaechtig` +
          (detection.loremIpsumDetected ? ' (Lorem-Ipsum klassisch)' : ''),
      );
    }
  } catch (err: any) {
    console.warn(`[Queue] Placeholder-Detector fehlgeschlagen: ${err.message}`);
  }

  if (!config.deepl.apiKey) {
    console.log('[Queue] DEEPL_API_KEY not set, skipping translation');
    return;
  }

  await pool.query(
    `UPDATE projects SET status = 'translating', updated_at = NOW() WHERE id = $1`,
    [project.id]
  );

  const untranslated = segmentRecords.filter(s => !s.hasTranslation || s.isStale);
  const cached = segmentRecords.length - untranslated.length;

  // Aggregierte Zeichen-Statistik für die Pre-Translation-Schätzung
  const totalChars = segmentRecords.reduce((sum, s) => sum + s.sourceText.length, 0);
  const newChars = untranslated.reduce((sum, s) => sum + s.sourceText.length, 0);
  const cachedChars = totalChars - newChars;

  console.log(`[Queue] Cache: ${cached}/${segmentRecords.length} hits (${Math.round((cached / segmentRecords.length) * 100) || 0}%), ${untranslated.length} zu übersetzen`);

  // Estimate-Snapshot in jobs-Tabelle persistieren — Frontend kann's beim Polling lesen
  await pool.query(
    `UPDATE jobs SET estimate = $2 WHERE project_id = $1 AND type = 'translate'`,
    [project.id, JSON.stringify({
      totalSegments: segmentRecords.length,
      cacheHits: cached,
      newSegments: untranslated.length,
      totalChars,
      cachedChars,
      newChars,
    })]
  ).catch(() => { /* Spalte evtl. nicht da — Migration läuft asynchron, ignorieren */ });

  emitProgress(project.id, {
    phase: 'translating',
    progress: 40,
    detail: `${cached} Cache-Hits, ${untranslated.length} zu übersetzen (${newChars.toLocaleString('de-AT')} neue Zeichen)`,
    cacheHits: cached,
    total: segmentRecords.length,
  });

  await pool.query(
    `UPDATE jobs SET progress = 40 WHERE project_id = $1 AND type = 'translate'`,
    [project.id]
  );

  // Deutsch → Deutsch = Channel-Fassung: kein DeepL, kein Condensing, sondern die
  // Hausschreibweise des Channels (PLAN-channel-fassung.md). Der Segment-Cache
  // trennt die Fassungen bereits über Ziel `DE` + `channel_code`.
  const channelFassung = isChannelFassung(project.source_lang, project.target_lang);
  if (channelFassung && untranslated.length > 0) {
    await rewriteChannelFassungSegments(project, untranslated, cached, segmentRecords.length);
  }

  if (untranslated.length > 0 && !channelFassung) {
    // Neutral-Modus: weder Glossar-Sync noch Channel-Overrides anwenden.
    const neutralMode = !!project.glossary_disabled;

    const deeplGlossaryId = neutralMode
      ? undefined
      : await ensureGlossarySynced(project.source_lang, project.target_lang);

    let currentGlossaryVersion = 0;
    if (!neutralMode) {
      const glossaryVersionResult = await pool.query(
        `SELECT version FROM glossaries WHERE source_lang = $1 AND target_lang = $2 LIMIT 1`,
        [project.source_lang, project.target_lang],
      );
      currentGlossaryVersion = glossaryVersionResult.rows[0]?.version ?? 0;
    }

    // Channel-Overrides laden falls Projekt einem Channel zugeordnet ist.
    // Bei NULL-Channel (= Standard der Organisation) oder Neutral-Modus bleibt die Liste
    // leer und Pre-/Post-Replacement ist ein No-Op.
    let channelOverrides: ChannelOverride[] = [];
    if (!neutralMode && project.channel_code) {
      channelOverrides = await getChannelOverrides(
        project.source_lang,
        project.target_lang,
        project.channel_code,
      );
      console.log(`[Queue] Channel ${project.channel_code}: ${channelOverrides.length} Overrides geladen`);
    }
    if (neutralMode) {
      console.log(`[Queue] Project ${project.id}: Neutral-Modus (ohne Glossar)`);
    }

    const batchSize = config.deepl.batchSize;
    let translated = 0;

    // Style-Marker-Pattern aus IDML-Parser: <x id="N"/>
    const STYLE_MARKER_REGEX = /<x\s+id=["']\d+["']\s*\/?>/;
    // Globale Variante fuer Split (capturing) — alle Marker im Text finden.
    const STYLE_MARKER_SPLIT_REGEX = /(<x\s+id=["']\d+["']\s*\/?>)/g;

    // DeepL-XML-Tag-Handling crasht an nicht-escapten &, <, > im Source-Text
    // (z.B. "Maß-Konfektion & OEM-Fertigung"). Marker bleiben as-is, damit
    // ignoreTags=['x'] greift; der restliche Text wird minimal XML-escaped.
    const escapeOutsideXmlMarkers = (text: string): string => {
      const parts = text.split(STYLE_MARKER_SPLIT_REGEX);
      return parts
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        )
        .join('');
    };
    const unescapeOutsideXmlMarkers = (text: string): string => {
      const parts = text.split(STYLE_MARKER_SPLIT_REGEX);
      return parts
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part
                .replace(/&gt;/g, '>')
                .replace(/&lt;/g, '<')
                .replace(/&amp;/g, '&'),
        )
        .join('');
    };

    // LanguageTool Pre-Pass: vor DeepL silent High-Confidence-Korrekturen
    // (Tippfehler/Typografie/Interpunktion) anwenden. Stil-Hinweise werden
    // bewusst NICHT angewandt — die Batch-Pipeline ist nicht der richtige Ort
    // für subjektive Stilentscheidungen.
    const ltOptimize = !!project.optimize_source;
    if (ltOptimize) {
      const { checkText, applyHighConfidenceFixes } = await import('./languagetool');
      console.log(`[Queue] Project ${project.id}: LanguageTool Pre-Pass aktiviert`);
      let totalApplied = 0;
      for (const seg of untranslated) {
        try {
          const lt = await checkText(seg.sourceText, project.source_lang);
          const { corrected, applied } = applyHighConfidenceFixes(seg.sourceText, lt.matches);
          if (applied.length > 0) {
            await pool.query(
              `UPDATE segments
                 SET source_text_original = COALESCE(source_text_original, source_text),
                     source_text = $2,
                     lt_corrections = $3
               WHERE id = $1`,
              [seg.id, corrected, JSON.stringify(applied)],
            );
            seg.sourceText = corrected;
            totalApplied += applied.length;
          }
        } catch (err: any) {
          console.warn(`[Queue] LT Pre-Pass fehlgeschlagen für Segment ${seg.id}: ${err.message}`);
        }
      }
      console.log(`[Queue] LT Pre-Pass: ${totalApplied} Korrekturen über ${untranslated.length} Segmente`);
    }

    // CSV-Profil-Pfad: Segmente nach Mode (text/html) gruppieren — HTML-Segmente
    // bekommen DeepL HTML-Modus + Magento-Token-Schutz, Text-Segmente laufen wie bisher.
    const segmentMode = (id: string): 'text' | 'html' =>
      opts.segmentModes?.get(id) ?? 'text';
    const preservedTokens = opts.preservedTokens || [];

    // Glossar-Eintraege fuer Akronym-Pre-Pass (Thema B) + Casing-Target-Pass (Thema A)
    // einmalig laden. Beide Schritte sind opt-out via Projekt-Flag.
    let glossaryEntries: Array<{ source_term: string; target_term: string }> = [];
    if (!project.glossary_disabled && project.protect_acronym_suffixes !== false) {
      const gloss = await pool.query(
        `SELECT ge.source_term, ge.target_term
           FROM glossar_an_deepl ge
           JOIN glossaries g ON g.id = ge.glossary_id
          WHERE g.source_lang = $1 AND g.target_lang = $2`,
        [
          normalizeGlossaryLang(project.source_lang),
          normalizeGlossaryLang(project.target_lang),
        ],
      );
      glossaryEntries = gloss.rows;
    }
    const enableTargetCasing =
      !project.glossary_disabled && project.optimize_target_casing !== false;
    const enableAcronymProt =
      !project.glossary_disabled && project.protect_acronym_suffixes !== false;

    // Fix #4: Title-Suffix-Mapping (z.B. " DE" → " FR") VOR der Batch-Loop.
    // Solche Cells erkennen wir an kurzer Laenge + Suffix-Match; sie werden direkt
    // gemappt und nicht an DeepL geschickt — vermeidet Halluzinationen wie
    // "Test Translate Tool DE" → "Exemples formats".
    const titleMapped = new Set<string>();
    for (const seg of untranslated) {
      if (segmentMode(seg.id) !== 'text') continue;
      const mapped = tryTitleSuffixMap(seg.sourceText, project.target_lang);
      if (mapped === null) continue;
      await pool.query(
        `UPDATE segments
           SET translated_text = $2, glossary_version = $3, is_stale = FALSE
         WHERE id = $1`,
        [seg.id, mapped, currentGlossaryVersion],
      );
      titleMapped.add(seg.id);
      console.log(`[Title-Map] ${seg.id}: "${seg.sourceText}" → "${mapped}" (kein DeepL-Call)`);
    }
    const untranslatedAfterTitleMap = untranslated.filter((s) => !titleMapped.has(s.id));

    // buildSubBatches operiert jetzt auf der gefilterten Liste (Title-Mappings
    // sind raus). Wir bauen lokal neu.
    const buildFilteredSubBatches = (): SegmentRecord[][] => {
      const result: SegmentRecord[][] = [];
      let current: SegmentRecord[] = [];
      let currentMode: 'text' | 'html' | null = null;
      for (const seg of untranslatedAfterTitleMap) {
        const mode = segmentMode(seg.id);
        if (currentMode === null || (mode === currentMode && current.length < batchSize)) {
          current.push(seg);
          currentMode = mode;
        } else {
          result.push(current);
          current = [seg];
          currentMode = mode;
        }
      }
      if (current.length > 0) result.push(current);
      return result;
    };

    // Anredestufe des Projekts. EINMAL abgeleitet und an ALLE DeepL-Aufrufe
    // dieses Laufs durchgereicht — Magento-HTML-Zellen, JSON-LD, Attributwerte
    // und Haupttext sind VIER getrennte Wege zu DeepL. Wird einer vergessen,
    // traegt ein Dokument zwei Anredeformen.
    // `undefined` = kein Parameter, also exakt der Aufruf von heute.
    const projFormality = effectiveFormality(
      (project.formality ?? 'default') as Formality,
      project.target_lang,
    );

    for (const batch of buildFilteredSubBatches()) {
      const batchMode = segmentMode(batch[0].id);
      const sourceTexts = batch.map(s => s.sourceText);

      // Fix #1: Magento-HTML-Cell-Pipeline (CSV-Profil-Pfad).
      // Doppelt entity-encoded HTML in <div data-content-type="html"> wird vor DeepL
      // einmal decoded, separat uebersetzt und danach wieder encoded. Vermeidet
      // DeepLs HTML-Normalization (Uppercasing, &quot;-Escape, CSS-Comment-Translation).
      if (batchMode === 'html' && opts.segmentModes && !opts.markupType) {
        // DIAG (28.05.2026): Sabrina-Block/Page-Bug — bestaetigen, dass dieser Branch greift.
        console.log(
          `[DIAG MagentoCell] enter project=${project.id} batch=${batch.length} firstSeg=${batch[0]?.id} cellLen=${batch[0]?.sourceText?.length ?? 0} profile=${project.format_profile}`,
        );
        for (let j = 0; j < batch.length; j++) {
          const seg = batch[j];
          const translatedCell = await translateMagentoHtmlCell(
            seg.sourceText,
            project.source_lang,
            project.target_lang,
            deeplGlossaryId,
            preservedTokens,
            channelOverrides,
            {
              glossaryEntries: enableAcronymProt ? glossaryEntries : [],
              enableTargetCasing,
              formality: projFormality,
            },
          );
          await pool.query(
            `UPDATE segments
               SET translated_text = $2, glossary_version = $3, is_stale = FALSE
             WHERE id = $1`,
            [seg.id, translatedCell, currentGlossaryVersion],
          );
        }
        translated += batch.length;
        const htmlProgress = 40 + Math.round((translated / untranslatedAfterTitleMap.length) * 50);
        await pool.query(
          `UPDATE jobs SET progress = $2 WHERE project_id = $1 AND type = 'translate'`,
          [project.id, htmlProgress],
        );
        emitProgress(project.id, {
          phase: 'translating',
          progress: htmlProgress,
          detail: `${translated}/${untranslatedAfterTitleMap.length} uebersetzt`,
          translated: cached + translated,
          total: segmentRecords.length,
        });
        continue;
      }

      // JSON-LD-Daten (schema.org FAQPage etc.) vor dem Channel-Pre-Replacement
      // uebersetzen — sonst geraten __TERM__-Tokens in den re-serialisierten Block,
      // der danach via protectCodeBlocks ausgeblendet wird und vom Post-Replacement
      // nicht mehr gesehen wuerde. No-op wenn kein ld+json-Block im Text steckt.
      // Nur fuer HTML/Markup-Inhalte relevant (Sabrina 29.06.2026).
      let jsonLdTexts = sourceTexts;
      if (batchMode === 'html' || !!opts.markupType) {
        jsonLdTexts = await Promise.all(
          sourceTexts.map((t) =>
            translateJsonLdBlocks(t, async (values) => {
              const r = await translateBatch(values, {
                sourceLang: project.source_lang,
                targetLang: project.target_lang,
                glossaryId: deeplGlossaryId,
                tagHandling: 'html',
                formality: projFormality,
              });
              return r.map((x) => x.translatedText);
            }),
          ),
        );
      }

      // Ab hier gilt: HTML-artiger Inhalt? Dann greifen die HTML-Schutzschichten
      // (Code-Blöcke, URL-Attribute, Attribut-Pre-Pass). Reine Text-Formate
      // (IDML/DOCX/PDF/XLSX/TXT) bleiben davon unberührt.
      const isHtmlLike = batchMode === 'html' || !!opts.markupType;

      // Stufe 1 der gemeinsamen Schutzschicht (./text/html-pipeline.ts):
      // <script>/<style> ZUERST — vor Pre-Replacement/Akronym/Pol/Einheit/Token,
      // deren Sentinels sonst im ausgelagerten Code-Block stehen blieben.
      const codeCtxs: CodeBlockCtx[] = [];
      let texts = jsonLdTexts.map((t) => {
        const prot = protectCode(t);
        codeCtxs.push(prot.ctx);
        return prot.text;
      });

      // Channel-Pre-Replacement: Override-Quellbegriffe → Token __TERM_NNN__
      const pre = applyPreReplacementBatch(texts, channelOverrides);
      texts = pre.texts;

      // Stufen 2–4: URL-Attribute + Store-View, Magento-Direktiven, CSS-Kommentare.
      // Vor Akronym/Pol/Einheit/Token, damit keine fremden Sentinels in eine URL
      // oder Direktive geraten. Unkonditional wie bisher der Direktiven-Schutz —
      // die Einzelschritte sind für markup-freien Text No-ops.
      const markupCtxs: MarkupCtx[] = [];
      let urlsRewritten = 0;
      texts = texts.map((t) => {
        const prot = protectMarkup(t, project.target_lang);
        markupCtxs.push(prot.ctx);
        urlsRewritten += prot.ctx.urlsRewritten;
        return prot.text;
      });

      // Akronym-Pre-Pass (Thema B, 22.05.2026): CRI90 → IRC90 via Glossar-Lookup.
      // Pro Text Restore-Map. Wirkt fuer text-mode UND html-mode-Batches.
      const acronymRestoreMaps: Array<Map<string, string>> = [];
      if (enableAcronymProt && glossaryEntries.length > 0) {
        texts = texts.map((t) => {
          const prot = protectAcronymsWithGlossary(t, glossaryEntries);
          acronymRestoreMaps.push(prot.restoreMap);
          return prot.protectedText;
        });
      }

      // Pol-/Litzenzahl-Schutz (18.06.2026): `4-polig`, `2-pol.` etc. → Sentinel,
      // Restore als Zielsprachen-Form. Pro Text eine Restore-Map.
      const poleRestoreMaps: Array<Map<string, string>> = [];
      texts = texts.map((t) => {
        const prot = protectPoleCounts(t, project.target_lang);
        poleRestoreMaps.push(prot.restoreMap);
        return prot.protectedText;
      });

      // Einheiten-Schutz (21.07.2026): kompakte Wert+Einheit-Tokens (`12W`,
      // `CRI90`) bleiben verbatim — DeepL trennt sie sonst zielsprachen-typisch.
      const unitRestoreMaps: Array<Map<string, string>> = [];
      texts = texts.map((t) => {
        const prot = protectUnits(t, project.target_lang);
        unitRestoreMaps.push(prot.restoreMap);
        return prot.protectedText;
      });

      // Magento-Token-Schutz: greift für CSV-HTML-Spalten UND für Markup-Pfad
      // (XML/HTML als ganze Datei). Restore-Maps pro Text gespeichert.
      const tokenProtectionActive =
        preservedTokens.length > 0 && (batchMode === 'html' || !!opts.markupType);
      const tokenRestoreMaps: Array<Map<string, string>> = [];
      if (tokenProtectionActive) {
        const { applyTokenProtection } = await import('./text/csv-profiles');
        texts = texts.map((t) => {
          const { text: protectedText, restore } = applyTokenProtection(t, preservedTokens);
          tokenRestoreMaps.push(restore);
          return protectedText;
        });
      }

      // Attribut-Pre-Pass (Regel 2, ./html-attributes.ts): alt/title/placeholder/
      // aria-*/label/value/meta-content. Lief bisher NUR im Magento-Zellen-Pfad —
      // bei HTML-/XML-Datei-Uploads blieben die Attribute damit unübersetzt, weil
      // DeepLs HTML-Mode sie in der Praxis nicht anfasst (Befund 28.07.2026).
      // Die Werte werden gesammelt und in EINEM Text-Mode-Batch übersetzt.
      // Stufe 5: Attribut-Pre-Pass. Die Werte ALLER Texte gehen in EINEN
      // Text-Mode-Batch (sonst ein DeepL-Aufruf je Segment).
      let attrCtxs: AttrCtx[] = [];
      if (isHtmlLike) {
        const attrProt = await protectAttributesBatch(texts, async (values) => {
          const attrResults = await translateBatch(values, {
            sourceLang: project.source_lang,
            targetLang: project.target_lang,
            glossaryId: deeplGlossaryId,
            formality: projFormality,
          });
          console.log(`[Attr-Pre] ${values.length} Attributwert(e) übersetzt`);
          return attrResults.map((r) => r.translatedText);
        });
        texts = attrProt.texts;
        attrCtxs = attrProt.ctxs;
      }

      // Tag-Handling: HTML-Mode aus CSV-Profil hat hoechste Prio.
      // Sonst markup-opts vom Caller, sonst IDML-Style-Marker-Detection.
      let idmlMarkerMode = false;
      let tagOpts: { tagHandling?: 'xml' | 'html'; ignoreTags?: string[]; tagHandlingVersion?: 'v1' | 'v2' } = {};
      if (batchMode === 'html') {
        tagOpts = { tagHandling: 'html', ignoreTags: ['style', 'script', 'code', 'pre'] };
      } else if (opts.markupType) {
        tagOpts = getMarkupDeepLOptions(opts.markupType);
      } else if (texts.some(t => STYLE_MARKER_REGEX.test(t))) {
        // IDML-Style-Marker: v1 ZWINGEND (v2 fuegt Leerzeichen/Satzzeichen um die
        // positionsgebundenen <x>-Marker ein → verschobene Zahlen, erfundene Punkte,
        // Vorlauf-Leerzeichen). Empirisch bestaetigt 01.06.2026.
        tagOpts = { tagHandling: 'xml', ignoreTags: ['x'], tagHandlingVersion: 'v1' };
        idmlMarkerMode = true;
      }
      // Profil-spezifische extraIgnoreTags (Magento-XML: page_layout, identifier, ...)
      if (opts.extraIgnoreTags && opts.extraIgnoreTags.length > 0 && tagOpts.tagHandling) {
        tagOpts.ignoreTags = [...(tagOpts.ignoreTags || []), ...opts.extraIgnoreTags];
      }

      // XML-Tag-Handling: nackte & / < / > außerhalb von <x id="N"/>-Markern escapen,
      // sonst crasht DeepL bei z.B. "Maß-Konfektion & OEM-Fertigung" mit
      // "not well-formed (invalid token)". Marker bleiben unangetastet, damit
      // ignoreTags=['x'] weiterhin greift. Nach Receive wieder entescapen.
      // Vorfall 29.05.2026 (Halon_Produktinfo1a), siehe Memory.
      //
      // ⚠️ NUR für den IDML-Marker-Pfad (28.07.2026 eingegrenzt). Die Bedingung
      // lautete `tagOpts.tagHandling === 'xml'` und traf damit auch echte
      // XML-Datei-Uploads: dort wurde die KOMPLETTE Dokumentstruktur escaped,
      // DeepL sah keine Tags mehr (→ Tag-/Elementnamen wurden mit-übersetzt und
      // `extraIgnoreTags` wie `identifier`/`page_layout` waren wirkungslos).
      // Ein wohlgeformtes XML braucht das Escaping nicht — dort sind `&`/`<`/`>`
      // im Text bereits als Entity kodiert.
      let xmlEscapeActive = false;
      if (tagOpts.tagHandling === 'xml' && idmlMarkerMode) {
        xmlEscapeActive = true;
        texts = texts.map((t) => escapeOutsideXmlMarkers(t));
      }

      const results = await translateBatch(texts, {
        sourceLang: project.source_lang,
        targetLang: project.target_lang,
        glossaryId: deeplGlossaryId,
        formality: projFormality,
        ...tagOpts,
      });

      // Magento-Tokens nach DeepL wieder restaurieren
      let translatedTexts = results.map(r => r.translatedText);

      // XML-Escape rueckgaengig (siehe oben). DeepL liefert die Marker
      // unveraendert zurueck, daher gleiche Split-Logik anwendbar.
      if (xmlEscapeActive) {
        translatedTexts = translatedTexts.map((t) => unescapeOutsideXmlMarkers(t));
      }

      // Attribut-Restore ZUERST: die Werte können Token-/Akronym-Sentinels
      // enthalten, die von den folgenden Restores noch aufgelöst werden müssen.
      if (attrCtxs.length > 0) {
        translatedTexts = translatedTexts.map((t, idx) =>
          attrCtxs[idx] ? restoreAttributes(t, attrCtxs[idx]) : t,
        );
      }

      if (tokenProtectionActive && tokenRestoreMaps.length > 0) {
        const { restoreTokens } = await import('./text/csv-profiles');
        translatedTexts = translatedTexts.map((t, idx) =>
          restoreTokens(t, tokenRestoreMaps[idx] || new Map()),
        );
      }

      // Akronym-Restore (Thema B): Sentinels → Glossar-Target + Original-Suffix
      if (acronymRestoreMaps.length > 0) {
        translatedTexts = translatedTexts.map((t, idx) =>
          restoreAcronyms(t, acronymRestoreMaps[idx] || new Map()),
        );
      }

      // Einheiten-Restore: Sentinel → Original-Token (verbatim)
      if (unitRestoreMaps.length > 0) {
        translatedTexts = translatedTexts.map((t, idx) =>
          restoreUnits(t, unitRestoreMaps[idx] || new Map()),
        );
      }

      // Pol-/Litzenzahl-Restore: Sentinel → Zielsprachen-Form
      if (poleRestoreMaps.length > 0) {
        translatedTexts = translatedTexts.map((t, idx) =>
          restorePoleCounts(t, poleRestoreMaps[idx] || new Map()),
        );
      }

      // Stufen 4–2 rückwärts (CSS-Kommentare, Direktiven, URL-Attribute) — VOR dem
      // Post-Replacement, damit ein Channel-Token in einem URL-Slug noch aufgelöst
      // wird (gleiche Reihenfolge wie im Magento-Zellen-Pfad).
      translatedTexts = translatedTexts.map((t, idx) =>
        markupCtxs[idx] ? restoreMarkup(t, markupCtxs[idx]) : t,
      );
      if (urlsRewritten > 0) {
        console.log(
          `[Storeview] target=${project.target_lang} umgeschrieben=${urlsRewritten}`,
        );
      }

      // Channel-Post-Replacement: Token → Channel-Zielbegriff
      let finalTexts = applyPostReplacementBatch(
        translatedTexts,
        pre.replacementsPerText,
      );

      // Capitalization-Post-Pass (Thema A, 22.05.2026):
      // Faelschliche Mid-Sentence-Grossschreibung im Target korrigieren.
      // Engine: LLM (Cheap-Tier) bevorzugt, weil LanguageTool fuer FR/IT/ES/PT/NL
      // keine Standard-Rules fuer diese Klasse hat. LT laeuft danach als Sicherheits-
      // netz fuer die wenigen Faelle, die LT doch erkennt. Beide Schritte haben
      // Sanity-Checks + skip-on-error → kein Crash bei LLM/LT-Ausfall.
      if (enableTargetCasing) {
        const protectedTerms: string[] = [
          ...channelOverrides.map((c) => c.channelTargetTerm),
          ...glossaryEntries.map((e) => e.target_term),
        ];
        for (let j = 0; j < finalTexts.length; j++) {
          // 1) LLM-Pass (primaere Engine)
          try {
            const llmFix = await llmCorrectCapitalization(finalTexts[j], project.target_lang, {
              extraAllowlist: protectedTerms,
              protectHonorifics: projFormality !== undefined,
            });
            if (!llmFix.skipped) {
              finalTexts[j] = llmFix.corrected;
            } else if (llmFix.skipReason && !llmFix.skipReason.startsWith('lang ') && llmFix.skipReason !== 'no uppercase chars' && llmFix.skipReason !== 'length out of range') {
              console.warn(`[LLM-Cap] Segment ${batch[j].id} skipped: ${llmFix.skipReason}`);
            }
          } catch (err: any) {
            console.warn(`[LLM-Cap] Segment ${batch[j].id} error: ${err.message}`);
          }
          // 2) LT-Pass (Fallback/Sicherheitsnetz fuer Faelle die LT erkennt)
          try {
            const ltFix = await correctTargetCapitalization(
              finalTexts[j],
              project.target_lang,
              protectedTerms,
              projFormality !== undefined ? HONORIFIC_PRONOUNS : [],
            );
            finalTexts[j] = ltFix.corrected;
          } catch (err: any) {
            console.warn(`[LT-Cap] Segment ${batch[j].id} skipped: ${err.message}`);
          }
        }
      }

      // <script>/<style> ganz zuletzt verbatim wieder einsetzen — nach
      // Post-Replacement und Casing, damit niemand den Code-Inhalt anfasst.
      for (let j = 0; j < finalTexts.length; j++) {
        if (codeCtxs[j]) finalTexts[j] = restoreCode(finalTexts[j], codeCtxs[j]);
        warnOnSentinelLeak(finalTexts[j], `Segment ${batch[j].id}`);
      }

      for (let j = 0; j < results.length; j++) {
        await pool.query(
          `UPDATE segments
           SET translated_text = $2, glossary_version = $3, is_stale = FALSE
           WHERE id = $1`,
          [batch[j].id, finalTexts[j], currentGlossaryVersion],
        );
      }

      translated += batch.length;
      const progress = 40 + Math.round((translated / untranslatedAfterTitleMap.length) * 50);

      await pool.query(
        `UPDATE jobs SET progress = $2 WHERE project_id = $1 AND type = 'translate'`,
        [project.id, progress]
      );

      emitProgress(project.id, {
        phase: 'translating',
        progress,
        detail: `${translated}/${untranslatedAfterTitleMap.length} übersetzt`,
        translated: cached + translated,
        total: segmentRecords.length,
      });
    }
  }

  // Smart Condensing — nicht für die Channel-Fassung: sie ändert nur einzelne
  // Begriffe, ein Kürzen würde den deutschen Text umformulieren.
  if (config.llm.apiKey && !channelFassung) {
    await runCondensingPhase(project);
  }

  await pool.query(
    `UPDATE jobs SET progress = 95 WHERE project_id = $1 AND type = 'translate'`,
    [project.id]
  );

  emitProgress(project.id, {
    phase: 'finalizing',
    progress: 95,
    detail: 'Wird abgeschlossen...',
  });
}

export async function enqueueTranslation(projectId: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO jobs (project_id, type, status) VALUES ($1, 'translate', 'queued') RETURNING id`,
    [projectId]
  );
  const jobId = result.rows[0].id;

  if (boss) {
    await boss.send('translate', { project_id: projectId, job_id: jobId });
  }

  return jobId;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}

// ---------------------------------------------------------------------------
// Magento-CMS-Page HTML-Cell Pipeline (Fix #1 + #2 + #3 + #5)
// ---------------------------------------------------------------------------

/**
 * Magento CMS-Page Content-Cell uebersetzen.
 *
 * Pipeline:
 *  1. Outer/Inner split — entity-encoded inner HTML (<div data-content-type="html">)
 *     wird einmal decoded und durch Sentinel-Tags im Outer ersetzt.
 *  2. Outer durch DeepL HTML-Mode (mit isolinner als zusaetzlichem ignoreTag).
 *  3. Jeder Inner-Block durch DeepL HTML-Mode (style/script/code/pre als ignoreTags).
 *  4. CSS-Comment- und URL-Slug-Schutz, Magento-Token-Schutz, Channel-Overrides
 *     greifen pro Aufruf (Outer + Inner) separat.
 *  5. Inner wird entity-enkodiert und an Sentinel-Position zurueckgesetzt.
 *  6. Sanity-Check: stray-escape-Tokens entfernen.
 */
async function translateMagentoHtmlCell(
  cellText: string,
  sourceLang: string,
  targetLang: string,
  glossaryId: string | undefined,
  preservedTokens: string[],
  channelOverrides: ChannelOverride[],
  options: {
    glossaryEntries?: Array<{ source_term: string; target_term: string }>;
    enableTargetCasing?: boolean;
    /** Bereits geprueft (`effectiveFormality`); `undefined` = kein Parameter. */
    formality?: 'more' | 'less';
  } = {},
): Promise<string> {
  const { outerWithSentinels, innerBlocks } = prepareMagentoHtmlCell(cellText);
  // DIAG (28.05.2026): Inner-Block-Extraktion-Tracking
  console.log(
    `[DIAG MagentoPrep] cellLen=${cellText.length} innerBlocks=${innerBlocks.length} outerLen=${outerWithSentinels.length}` +
      (innerBlocks[0] ? ` firstInnerLen=${innerBlocks[0].decoded.length} firstInnerHead=${JSON.stringify(innerBlocks[0].decoded.slice(0, 80))}` : ''),
  );

  // Outer durch DeepL — Sentinel-Tags + style/script/code/pre als ignoreTags.
  const translatedOuter = await translateProtectedHtml(
    outerWithSentinels,
    sourceLang,
    targetLang,
    glossaryId,
    preservedTokens,
    channelOverrides,
    [MAGENTO_INNER_IGNORE_TAG, 'style', 'script', 'code', 'pre'],
    options,
  );

  // Pro Inner-Block: separate Uebersetzung als echtes HTML.
  const translatedInners: Array<{ sentinelId: string; translated: string }> = [];
  for (const inner of innerBlocks) {
    const translated = await translateProtectedHtml(
      inner.decoded,
      sourceLang,
      targetLang,
      glossaryId,
      preservedTokens,
      channelOverrides,
      ['style', 'script', 'code', 'pre'],
      options,
    );
    translatedInners.push({ sentinelId: inner.sentinelId, translated });
  }

  const reassembled = assembleMagentoHtmlCell(translatedOuter, translatedInners);
  const { cleaned, strayCount } = sanitizeStrayEscapes(reassembled);
  if (strayCount > 0) {
    console.warn(`[Magento-HTML] ${strayCount} stray escape token(s) entfernt`);
  }
  return cleaned;
}

/**
 * Ein einzelnes HTML-Fragment durch DeepL schicken — mit Channel-Overrides,
 * URL-Slug-Schutz, CSS-Comment-Schutz und Magento-Token-Schutz vorgeschaltet.
 *
 * Optional: Akronym-Pre-Pass (Thema B) und LanguageTool-Target-Pass (Thema A)
 * werden ausgefuehrt wenn `glossaryEntries` bzw. `enableTargetCasing` gesetzt.
 */
async function translateProtectedHtml(
  text: string,
  sourceLang: string,
  targetLang: string,
  glossaryId: string | undefined,
  preservedTokens: string[],
  channelOverrides: ChannelOverride[],
  ignoreTags: string[],
  options: {
    glossaryEntries?: Array<{ source_term: string; target_term: string }>;
    enableTargetCasing?: boolean;
    /** Bereits geprueft (`effectiveFormality`); `undefined` = kein Parameter. */
    formality?: 'more' | 'less';
  } = {},
): Promise<string> {
  // JSON-LD-Daten (schema.org FAQPage etc.) ZUERST uebersetzen — vor dem
  // Channel-Pre-Replacement, damit keine __TERM__-Tokens in den re-serialisierten
  // Block geraten (der danach via protectCodeBlocks ausgeblendet wird und vom
  // Post-Replacement nicht mehr gesehen wuerde). Die name/text-Felder gehen
  // separat durch DeepL (HTML-Mode → <br> in Antworten bleibt erhalten), der Block
  // wird in-place neu serialisiert. Das nachgelagerte protectCodeBlocks() schuetzt
  // den bereits uebersetzten Block dann verbatim vor dem Haupt-DeepL-Pass.
  // (Sabrina 29.06.2026: FAQ-JSON wurde bisher als Code uebersprungen.)
  text = await translateJsonLdBlocks(text, async (texts) => {
    const r = await translateBatch(texts, {
      sourceLang,
      targetLang,
      glossaryId,
      tagHandling: 'html',
      formality: options.formality,
    });
    return r.map((x) => x.translatedText);
  });

  // Stufe 1 der gemeinsamen Schutzschicht (./text/html-pipeline.ts): <script>/<style>
  // ZUERST — auch vor dem Channel-Pre-Replacement, dessen `__TERM_n__`-Tokens sonst
  // im ausgelagerten Code landen und dort stehen bleiben.
  const codeProt = protectCode(text);
  let working = codeProt.text;

  // Channel-Pre-Replacement
  const pre = applyPreReplacementBatch([working], channelOverrides);
  working = pre.texts[0];

  // Stufen 2–4: URL-Attribute + Store-View, Magento-Direktiven, CSS-Kommentare.
  // Vor allen weiteren sentinel-erzeugenden Schritten, damit keine Akronym-/Pol-/
  // Einheiten-/Token-Sentinels in einer URL oder Direktive landen.
  const markupProt = protectMarkup(working, targetLang);
  working = markupProt.text;

  // Akronym-Pre-Pass (Thema B, 22.05.2026): Glossar-Akronyme mit angehaengten
  // Ziffern (CRI90 → IRC90) durch Sentinels schuetzen und direkt mit
  // Glossar-Target restoren — DeepL sieht sie nie.
  const acronymProt =
    options.glossaryEntries && options.glossaryEntries.length > 0
      ? protectAcronymsWithGlossary(working, options.glossaryEntries)
      : { protectedText: working, restoreMap: new Map<string, string>(), substitutions: [] };
  working = acronymProt.protectedText;

  // Pol-/Litzenzahl-Schutz (18.06.2026): `4-polig`, `2-pol.` etc. vor DeepL
  // schuetzen, Restore als Zielsprachen-Form (EN `4-pole`, ...).
  const poleProt = protectPoleCounts(working, targetLang);
  working = poleProt.protectedText;

  // Einheiten-Schutz: `12W`/`CRI90` verbatim erhalten.
  const unitProt = protectUnits(working, targetLang);
  working = unitProt.protectedText;

  // Magento-Token-Schutz (1column, inner, main, ...)
  let tokenRestore = new Map<string, string>();
  if (preservedTokens.length > 0) {
    const { applyTokenProtection } = await import('./text/csv-profiles');
    const tp = applyTokenProtection(working, preservedTokens);
    working = tp.text;
    tokenRestore = tp.restore;
  }

  // Stufe 5: Attribut-Pre-Pass (alt/title/aria-*/placeholder/value/meta-content).
  // Die Werte gehen als eigener TEXT-Mode-Batch durch DeepL.
  const attrProt = await protectAttributes(working, async (values) => {
    const attrResults = await translateBatch(values, {
      sourceLang,
      targetLang,
      glossaryId,
      formality: options.formality,
    });
    return attrResults.map((r) => r.translatedText);
  });
  working = attrProt.text;

  // DeepL — splittingTags=['br','p','li','h1'..'h6'] zwingt DeepL pro Block
  // eigenstaendig zu uebersetzen. Reicht aber NICHT: DeepL fuegt im FR/IT
  // trotzdem typografische Trenner ('; ', '. ') zwischen <br>-getrennte
  // Zeilen ein. Daher zusaetzlich Post-Cleanup (Vorfall Sabrina 22.06.2026).
  const results = await translateBatch([working], {
    sourceLang,
    targetLang,
    glossaryId,
    formality: options.formality,
    tagHandling: 'html',
    ignoreTags,
    splittingTags: ['br', 'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  });
  let translated = results[0].translatedText;

  // Post-Cleanup: '<br>; xyz' und '<br>. xyz' → '<br>xyz' (DeepL-Artefakt fuer FR/IT).
  // Sicher weil <br>;/<br>. praktisch nie legitimes HTML ist; matched nur mit
  // nachfolgendem Whitespace (verhindert false positives wie '<br>...loading').
  translated = translated.replace(/(<br\s*\/?>)\s*[;.,]\s+/gi, '$1');

  // Reverse-Order Restore
  // HTML-Attribute zuerst restoren (Sentinels wurden im Outer-Token-Pfad nicht angefasst,
  // muessen vor Token-Restore zurueck damit Token-Sentinels in Attributen korrekt aufloesen).
  translated = restoreAttributes(translated, attrProt.ctx);
  if (tokenRestore.size > 0) {
    const { restoreTokens } = await import('./text/csv-profiles');
    translated = restoreTokens(translated, tokenRestore);
  }
  translated = restoreAcronyms(translated, acronymProt.restoreMap);
  translated = restoreUnits(translated, unitProt.restoreMap);
  translated = restorePoleCounts(translated, poleProt.restoreMap);
  // Stufen 4–2 rückwärts (CSS-Kommentare, Direktiven, URL-Attribute) — VOR dem
  // Post-Replacement, damit ein Channel-Token in einem URL-Slug noch aufgelöst wird.
  translated = restoreMarkup(translated, markupProt.ctx);
  if (markupProt.ctx.urlsRewritten > 0) {
    console.log(
      `[Storeview] target=${targetLang} umgeschrieben=${markupProt.ctx.urlsRewritten}`,
    );
  }

  // Channel-Post-Replacement
  const finalTexts = applyPostReplacementBatch([translated], pre.replacementsPerText);
  translated = finalTexts[0];

  // Capitalization-Post-Pass (Thema A, 22.05.2026): LLM-primaer + LT-Fallback.
  if (options.enableTargetCasing) {
    const protectedTerms: string[] = [
      ...channelOverrides.map((c) => c.channelTargetTerm),
      ...(options.glossaryEntries?.map((e) => e.target_term) ?? []),
    ];
    try {
      const llmFix = await llmCorrectCapitalization(translated, targetLang, {
        extraAllowlist: protectedTerms,
        protectHonorifics: options.formality !== undefined,
      });
      if (!llmFix.skipped) translated = llmFix.corrected;
    } catch (err: any) {
      console.warn('[LLM-Cap] HTML fragment error:', err.message);
    }
    try {
      const ltFix = await correctTargetCapitalization(
        translated,
        targetLang,
        protectedTerms,
        options.formality !== undefined ? HONORIFIC_PRONOUNS : [],
      );
      translated = ltFix.corrected;
    } catch (err: any) {
      console.warn('[LT-Cap] HTML fragment error:', err.message);
    }
  }

  // <script>/<style>-Bloecke ganz zuletzt verbatim wieder einsetzen — nach allen
  // anderen Restores/Injections, damit nichts den Code-Inhalt anfasst.
  translated = restoreCode(translated, codeProt.ctx);
  warnOnSentinelLeak(translated, 'Magento-HTML-Fragment');

  return translated;
}
