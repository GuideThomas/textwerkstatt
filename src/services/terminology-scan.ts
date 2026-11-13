import crypto from 'crypto';
import fs from 'fs';
import { pool } from '../db/connection';
import { config } from '../config';
import { getFilePath } from './storage';
import { parseIdml, cleanupIdml } from './idml';
import { parseDocx, cleanupDocx } from './docx';
import { parseXlsx, cleanupXlsx } from './xlsx';
import { translateBatch, ensureGlossarySynced } from './deepl';
import { normalizeGlossaryLang } from './lang';
import { logTokenUsage, LlmTerminalError } from './llm';
import { callLlmGeschuetzt } from './pseudonym/maschine';
import { emitProgress } from './sse';
import type { AlignedSegment, DiffSegment, ScanFileType } from '../types';

// ===== Alignment =====

/**
 * Segmente aus zwei Dateien paarweise zuordnen.
 * Position-basiert: gleiche Anzahl → 1:1, sonst Ratio-Mapping.
 */
export function alignSegments(
  sourceTexts: string[],
  translationTexts: string[],
): AlignedSegment[] {
  const aligned: AlignedSegment[] = [];

  // Leere Segmente filtern (Indizes merken für Mapping)
  const source = sourceTexts.filter(t => t.trim().length > 0);
  const trans = translationTexts.filter(t => t.trim().length > 0);

  if (source.length === 0 || trans.length === 0) return aligned;

  for (let i = 0; i < source.length; i++) {
    // Ratio-Mapping: Bei gleicher Länge = 1:1, sonst proportional
    const transIdx = Math.min(
      Math.round(i * trans.length / source.length),
      trans.length - 1,
    );

    aligned.push({
      position: i,
      sourceText: source[i],
      existingTranslation: trans[transIdx],
    });
  }

  return aligned;
}

// ===== Levenshtein Similarity =====

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Nur zwei Zeilen nötig (Speicher-optimiert)
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // Deletion
        curr[j - 1] + 1,   // Insertion
        prev[j - 1] + cost, // Substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Ähnlichkeit zweier Texte, 0 bis 1 — normalisiert (Kleinschreibung, Leerraum).
 *
 * ⚠️ Exportiert seit 28.08.2026, weil `/api/uebersetzung-pruefung` den **Wert**
 * braucht und nicht nur die Ja/Nein-Antwort von `detectDifferences()`. Wer eine
 * Zahl anzeigt, muss sie aus derselben Funktion nehmen, die auch die Schwelle
 * zieht — sonst stehen Anzeige und Entscheidung auf zwei Rechnungen.
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ===== Diff Detection =====

/**
 * Vergleiche bestehende Übersetzung mit DeepL-Referenz.
 * Nur Segmente mit echten Abweichungen (Similarity < 0.95) werden zurückgegeben.
 */
export function detectDifferences(
  aligned: AlignedSegment[],
  deeplTranslations: string[],
): DiffSegment[] {
  const diffs: DiffSegment[] = [];

  for (let i = 0; i < aligned.length; i++) {
    const existing = aligned[i].existingTranslation;
    const deepl = deeplTranslations[i];

    if (!existing || !deepl) continue;

    const sim = textSimilarity(existing, deepl);
    if (sim < 0.95) {
      diffs.push({
        ...aligned[i],
        deeplTranslation: deepl,
      });
    }
  }

  return diffs;
}

// ===== LLM Batch Analysis =====

const BATCH_SIZE = 6;

function buildSystemPrompt(): string {
  return `Du analysierst Übersetzungsabweichungen für ein Unternehmen im Bereich LED-Beleuchtung.

Für jedes Segment-Paar (nummeriert):
- source: Originaltext
- existing: Bestehende Übersetzung (vom Unternehmen)
- deepl: DeepL-Referenzübersetzung

Klassifiziere jede Abweichung zwischen "existing" und "deepl":

TERMINOLOGY — Bewusste Firmen-Terminologie (Fachbegriffe, Produktnamen, Markenbegriffe)
STYLE — Bewusster Stil/Tonfall (kürzere Marketingsprache, formaler/informaler)
ERROR — Wahrscheinlicher Übersetzungsfehler oder veraltete Formulierung
CONTEXT — Kontextabhaengige Anpassung (macht nur im Dokument-Kontext Sinn)

Extrahiere den konkreten abweichenden Term (nicht den ganzen Satz).

Antworte AUSSCHLIESSLICH als JSON-Array:
[{"segment": 1, "source_term": "...", "existing_term": "...", "deepl_term": "...",
  "category": "TERMINOLOGY", "confidence": 0.85, "explanation": "Kurze Begründung"}]

Wenn ein Segment keine relevante Abweichung hat, überspringe es.`;
}

function buildUserPrompt(batch: DiffSegment[]): string {
  const segments = batch.map((d, i) => {
    return `[${i + 1}]
source: ${d.sourceText}
existing: ${d.existingTranslation}
deepl: ${d.deeplTranslation}`;
  }).join('\n\n');

  return `Analysiere diese Segment-Paare:\n\n${segments}`;
}

interface LlmCandidate {
  segment: number;
  source_term: string;
  existing_term: string;
  deepl_term: string;
  category: string;
  confidence: number;
  explanation: string;
}

/**
 * LLM-Batch-Analyse: Klassifiziert Abweichungen in Batches.
 */
export async function analyzeBatch(
  diffs: DiffSegment[],
  scanId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ candidates: Array<LlmCandidate & { position: number; sourceText: string; existingTranslation: string; deeplTranslation: string }>; totalCost: number }> {
  const allCandidates: Array<LlmCandidate & { position: number; sourceText: string; existingTranslation: string; deeplTranslation: string }> = [];
  let totalCost = 0;
  const totalBatches = Math.ceil(diffs.length / BATCH_SIZE);

  const systemPrompt = buildSystemPrompt();

  for (let i = 0; i < diffs.length; i += BATCH_SIZE) {
    const batch = diffs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    try {
      const userPrompt = buildUserPrompt(batch);
      // Verdeckt und ohne Ausweichmodell (Phase 6). Die Antwort nennt nur Kandidaten, also fehlen Platzhalter zu Recht.
      const result = await callLlmGeschuetzt(systemPrompt, userPrompt, { fehlendErlaubt: true });

      await logTokenUsage(result, 'terminology', undefined, undefined);
      totalCost += result.costUsd;

      // JSON aus Antwort extrahieren (kann in Markdown-Block sein)
      let jsonStr = result.text;
      const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const parsed: LlmCandidate[] = JSON.parse(jsonStr);

      for (const c of parsed) {
        const validCategories = ['TERMINOLOGY', 'STYLE', 'ERROR', 'CONTEXT'];
        if (!validCategories.includes(c.category)) continue;
        if (c.confidence < 0.3) continue;

        const segIdx = c.segment - 1; // 1-based → 0-based
        if (segIdx < 0 || segIdx >= batch.length) continue;

        const diff = batch[segIdx];
        allCandidates.push({
          ...c,
          confidence: Math.min(1, Math.max(0, c.confidence)),
          position: diff.position,
          sourceText: diff.sourceText,
          existingTranslation: diff.existingTranslation,
          deeplTranslation: diff.deeplTranslation,
        });
      }
    } catch (err: any) {
      // Budget-/Key-Fehler heilt kein weiterer Batch — jeder Folge-Aufruf haengt am
      // selben Virtual Key und scheitert identisch. Am 07.08.2026 liefen so 471
      // Batches ins Leere (942 abgewiesene Requests in 4 Minuten). Abbrechen und den
      // Fehler nach oben geben, damit der Aufrufer ihn dem Nutzer zeigen kann.
      if (err instanceof LlmTerminalError) {
        console.error(`[TermScan] Abbruch bei Batch ${batchNum}/${totalBatches}: ${err.message}`);
        throw err;
      }
      console.error(`[TermScan] Batch ${batchNum}/${totalBatches} failed:`, err.message);
      // Weiter mit nächstem Batch
    }

    onProgress?.(batchNum, totalBatches);
  }

  return { candidates: allCandidates, totalCost };
}

// ===== Text-Extraktion pro Format =====

function extractTextsFromFile(filePath: string, fileType: ScanFileType): { texts: string[]; cleanup: () => void } {
  if (fileType === 'txt') {
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      texts: content.split(/\r?\n/).filter((l: string) => l.trim().length > 0),
      cleanup: () => {},
    };
  }

  if (fileType === 'idml') {
    const result = parseIdml(filePath);
    return {
      texts: result.segments.map(s => s.text),
      cleanup: () => cleanupIdml(result),
    };
  }

  if (fileType === 'docx') {
    const result = parseDocx(filePath);
    return {
      texts: result.segments.map(s => s.text),
      cleanup: () => cleanupDocx(result),
    };
  }

  if (fileType === 'xlsx') {
    // parseXlsx ist async, aber wir müssen sync bleiben — Wrapper
    throw new Error('XLSX must be handled via processTerminologyScanAsync');
  }

  throw new Error(`Unsupported scan file type: ${fileType}`);
}

async function extractTextsFromFileAsync(filePath: string, fileType: ScanFileType): Promise<{ texts: string[]; cleanup: () => void }> {
  if (fileType === 'xlsx') {
    const result = await parseXlsx(filePath);
    return {
      texts: result.segments.map(s => s.text),
      cleanup: () => cleanupXlsx(),
    };
  }
  return extractTextsFromFile(filePath, fileType);
}

// ===== Segment Cache Upsert (aus queue.ts Pattern) =====
//
// ⚠️ Diese Funktion ist eine KOPIE des Musters aus `queue.ts`, nicht dessen
// Aufruf — sie geht mit eigenem SQL an `upsertSegment` vorbei. Kommt dort eine
// Cache-Dimension dazu, zeigt der Typecheck diese Stelle NICHT an. Bis
// 14.08.2026 fehlten hier `channel_code` und `glossary_disabled`; mit
// `formality` waere daraus erstmals ein echter Fehltreffer geworden. Der
// Terminologie-Scan arbeitet immer neutral.

async function upsertSegmentCache(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<{ id: string; translatedText: string | null; isStale: boolean }> {
  const hash = crypto.createHash('sha256').update(text).digest('hex');

  const existing = await pool.query(
    `SELECT id, translated_text, is_stale FROM segments
     WHERE segment_hash = $1 AND source_lang = $2 AND target_lang = $3
       AND channel_code IS NULL AND glossary_disabled = FALSE
       AND formality = 'default' AND besitzer IS NULL`,
    [hash, sourceLang, targetLang],
  );

  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE segments SET hit_count = hit_count + 1 WHERE id = $1`,
      [existing.rows[0].id],
    );
    return {
      id: existing.rows[0].id,
      translatedText: existing.rows[0].translated_text,
      isStale: existing.rows[0].is_stale,
    };
  }

  const result = await pool.query(
    // `besitzer` NULL (051): Ein Scan gehört niemandem (`terminology_scans` kennt keinen Besitzer), seine Zeilen liegen im
    // gemeinsamen Cache. Projekte der Demo treffen sie nie, denn die suchen mit dem Gast als Besitzer.
    `INSERT INTO segments (segment_hash, source_lang, target_lang, channel_code, glossary_disabled, formality, source_text, besitzer)
     VALUES ($1, $2, $3, NULL, FALSE, 'default', $4, NULL) RETURNING id`,
    [hash, sourceLang, targetLang, text],
  );

  return { id: result.rows[0].id, translatedText: null, isStale: false };
}

// ===== Haupt-Orchestrierer =====

/**
 * Verarbeitet einen Terminologie-Scan vollständig:
 * Parse → Align → DeepL-Referenz → Diff → LLM-Analyse → Kandidaten speichern
 */
export async function processTerminologyScan(scanId: string): Promise<void> {
  // 1. Scan laden
  const scanResult = await pool.query(
    `SELECT * FROM terminology_scans WHERE id = $1`,
    [scanId],
  );
  if (scanResult.rows.length === 0) throw new Error(`Scan ${scanId} not found`);
  const scan = scanResult.rows[0];

  // 2. Status → aligning
  await pool.query(
    `UPDATE terminology_scans SET status = 'aligning', updated_at = NOW() WHERE id = $1`,
    [scanId],
  );

  emitProgress(scanId, { phase: 'aligning', progress: 5, detail: 'Dateien werden analysiert...' });

  // 3. Beide Dateien parsen
  const sourcePath = getFilePath(scan.source_stored_filename);
  const translationPath = getFilePath(scan.translation_stored_filename);

  const sourceResult = await extractTextsFromFileAsync(sourcePath, scan.source_file_type);
  const translationResult = await extractTextsFromFileAsync(translationPath, scan.source_file_type);

  try {
    const sourceTexts = sourceResult.texts;
    const translationTexts = translationResult.texts;

    console.log(`[TermScan] Source: ${sourceTexts.length} segments, Translation: ${translationTexts.length} segments`);

    // 4. Alignment
    const aligned = alignSegments(sourceTexts, translationTexts);
    const totalSegments = aligned.length;

    await pool.query(
      `UPDATE terminology_scans SET total_segments = $2, updated_at = NOW() WHERE id = $1`,
      [scanId, totalSegments],
    );

    emitProgress(scanId, {
      phase: 'aligning',
      progress: 15,
      detail: `${totalSegments} Segmente aligned`,
      total: totalSegments,
    });

    // 5. Status → translating, DeepL-Referenz
    await pool.query(
      `UPDATE terminology_scans SET status = 'translating', updated_at = NOW() WHERE id = $1`,
      [scanId],
    );

    if (!config.deepl.apiKey) {
      throw new Error('DEEPL_API_KEY not configured');
    }

    const deeplGlossaryId = await ensureGlossarySynced(scan.source_lang, scan.target_lang);

    // Cache-Check und DeepL-Übersetzung
    const deeplTranslations: string[] = [];
    let cacheHits = 0;
    const textsToTranslate: { index: number; text: string; segId: string }[] = [];

    for (let i = 0; i < aligned.length; i++) {
      const cacheEntry = await upsertSegmentCache(
        aligned[i].sourceText,
        scan.source_lang,
        scan.target_lang,
      );

      if (cacheEntry.translatedText && !cacheEntry.isStale) {
        deeplTranslations[i] = cacheEntry.translatedText;
        cacheHits++;
      } else {
        deeplTranslations[i] = ''; // Platzhalter
        textsToTranslate.push({ index: i, text: aligned[i].sourceText, segId: cacheEntry.id });
      }
    }

    emitProgress(scanId, {
      phase: 'translating',
      progress: 25,
      detail: `${cacheHits} Cache-Hits, ${textsToTranslate.length} zu übersetzen`,
      cacheHits,
      total: totalSegments,
    });

    // DeepL Batch-Übersetzung für Cache-Misses
    if (textsToTranslate.length > 0) {
      const batchSize = config.deepl.batchSize;
      let translated = 0;

      // Glossar-Version holen
      const gvResult = await pool.query(
        `SELECT version FROM glossaries WHERE source_lang = $1 AND target_lang = $2 LIMIT 1`,
        [scan.source_lang, scan.target_lang],
      );
      const glossaryVersion = gvResult.rows[0]?.version ?? 0;

      for (let i = 0; i < textsToTranslate.length; i += batchSize) {
        const batch = textsToTranslate.slice(i, i + batchSize);
        const texts = batch.map(b => b.text);

        const results = await translateBatch(texts, {
          sourceLang: scan.source_lang,
          targetLang: scan.target_lang,
          glossaryId: deeplGlossaryId,
        });

        for (let j = 0; j < results.length; j++) {
          deeplTranslations[batch[j].index] = results[j].translatedText;

          // Cache aktualisieren
          await pool.query(
            `UPDATE segments SET translated_text = $2, glossary_version = $3, is_stale = FALSE WHERE id = $1`,
            [batch[j].segId, results[j].translatedText, glossaryVersion],
          );
        }

        translated += batch.length;
        const progress = 25 + Math.round((translated / textsToTranslate.length) * 30);
        emitProgress(scanId, {
          phase: 'translating',
          progress,
          detail: `${translated}/${textsToTranslate.length} übersetzt (${cacheHits} Cache-Hits)`,
          cacheHits,
          translated: cacheHits + translated,
          total: totalSegments,
        });
      }
    }

    // 6. Diff-Erkennung
    const diffs = detectDifferences(aligned, deeplTranslations);

    await pool.query(
      `UPDATE terminology_scans SET diff_segments = $2, updated_at = NOW() WHERE id = $1`,
      [scanId, diffs.length],
    );

    emitProgress(scanId, {
      phase: 'analyzing',
      progress: 60,
      detail: `${diffs.length} Abweichungen erkannt, LLM-Analyse startet...`,
      total: totalSegments,
    });

    if (diffs.length === 0) {
      await pool.query(
        `UPDATE terminology_scans SET status = 'completed', candidate_count = 0, updated_at = NOW() WHERE id = $1`,
        [scanId],
      );
      emitProgress(scanId, { phase: 'completed', progress: 100, detail: 'Keine Abweichungen gefunden', candidates: 0 });
      return;
    }

    // 7. Status → analyzing, LLM-Batch-Analyse
    await pool.query(
      `UPDATE terminology_scans SET status = 'analyzing', updated_at = NOW() WHERE id = $1`,
      [scanId],
    );

    const { candidates, totalCost } = await analyzeBatch(
      diffs,
      scanId,
      (done, total) => {
        const progress = 60 + Math.round((done / total) * 30);
        emitProgress(scanId, {
          phase: 'analyzing',
          progress,
          detail: `LLM-Analyse: ${done}/${total} Batches`,
        });
      },
    );

    console.log(`[TermScan] ${candidates.length} candidates found, cost: $${totalCost.toFixed(4)}`);

    // 8. Deduplizierung gegen bestehende Glossar-Einträge
    const existingEntries = await pool.query(
      `SELECT LOWER(source_term) AS st, LOWER(target_term) AS tt
       FROM glossary_entries ge
       JOIN glossaries g ON ge.glossary_id = g.id
       WHERE g.source_lang = $1 AND g.target_lang = $2 AND ge.approved = TRUE`,
      [normalizeGlossaryLang(scan.source_lang), normalizeGlossaryLang(scan.target_lang)],
    );

    const existingSet = new Set(
      existingEntries.rows.map(r => `${r.st}|||${r.tt}`),
    );

    const uniqueCandidates = candidates.filter(c => {
      const key = `${c.source_term.toLowerCase()}|||${c.existing_term.toLowerCase()}`;
      return !existingSet.has(key);
    });

    // 9. Kandidaten speichern
    for (const c of uniqueCandidates) {
      await pool.query(
        `INSERT INTO terminology_candidates
         (scan_id, source_text, existing_translation, deepl_translation, source_term, existing_term, deepl_term, category, confidence, explanation, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [scanId, c.sourceText, c.existingTranslation, c.deeplTranslation,
         c.source_term, c.existing_term, c.deepl_term, c.category,
         c.confidence, c.explanation || null, c.position],
      );
    }

    // 10. Finalize
    await pool.query(
      `UPDATE terminology_scans SET status = 'completed', candidate_count = $2, updated_at = NOW() WHERE id = $1`,
      [scanId, uniqueCandidates.length],
    );

    emitProgress(scanId, {
      phase: 'completed',
      progress: 100,
      detail: `${uniqueCandidates.length} Kandidaten gefunden`,
      candidates: uniqueCandidates.length,
    });

    console.log(`[TermScan] Scan ${scanId} completed: ${uniqueCandidates.length} candidates (${diffs.length} diffs, ${totalSegments} total)`);
  } finally {
    sourceResult.cleanup();
    translationResult.cleanup();
  }
}
