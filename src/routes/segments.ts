import { Router } from 'express';
import { pool } from '../db/connection';
import { effectiveMaxChars } from '../services/condensing';

const router = Router();

interface GlossaryEntry {
  source_term: string;
  target_term: string;
}

interface GlossaryHit {
  term: string;
  start: number;
  end: number;
  source_term: string;
  target_term: string;
}

/**
 * Findet alle Vorkommen aller Glossar-Eintraege in einem Text.
 * Case-insensitive Substring-Match an Wortgrenzen (\b). Mehrwort-Terme werden
 * unterstuetzt. Ueberlappungen werden vermieden (laengster Treffer gewinnt).
 *
 * `side` waehlt, welcher Term im Text gesucht wird (Quell- oder Zielseite).
 */
function findGlossaryHits(
  text: string,
  entries: GlossaryEntry[],
  side: 'source' | 'target',
): GlossaryHit[] {
  if (!text) return [];
  const hits: GlossaryHit[] = [];
  // Laenger zuerst, damit "LED-Strip" vor "LED" matcht
  const sorted = [...entries].sort(
    (a, b) =>
      (side === 'source' ? b.source_term.length : b.target_term.length) -
      (side === 'source' ? a.source_term.length : a.target_term.length),
  );

  for (const entry of sorted) {
    const needle = side === 'source' ? entry.source_term : entry.target_term;
    if (!needle || needle.length < 2) continue;
    const re = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Ueberlappung mit bereits gefundenen Treffern vermeiden
      if (hits.some((h) => !(end <= h.start || start >= h.end))) continue;
      hits.push({
        term: m[0],
        start,
        end,
        source_term: entry.source_term,
        target_term: entry.target_term,
      });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/projects/:projectId/segments
 * Gibt alle Segmente eines Projekts zurück, mit Quell- und Übersetzungstext.
 */
router.get('/:projectId/segments', async (req, res) => {
  try {
    const { projectId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const filter = req.query.filter as string; // 'all' | 'translated' | 'untranslated' | 'condensed' | 'review' | 'approved'

    let whereClause = 'WHERE ps.project_id = $1';
    const params: any[] = [projectId];

    if (filter === 'translated') {
      whereClause += ' AND s.translated_text IS NOT NULL';
    } else if (filter === 'untranslated') {
      whereClause += ' AND s.translated_text IS NULL';
    } else if (filter === 'condensed') {
      whereClause += ' AND s.condensed_text IS NOT NULL';
    } else if (filter === 'review') {
      whereClause += ` AND (ps.condense_status IN ('still_long','manual_review') OR (s.review_status = 'pending' AND s.translated_text IS NOT NULL))`;
    } else if (filter === 'approved') {
      whereClause += ` AND s.review_status = 'approved'`;
    } else if (filter === 'clarification') {
      whereClause += ` AND s.review_status = 'needs_clarification'`;
    } else if (filter === 'edited') {
      whereClause += ` AND s.edited_by_user = TRUE`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM project_segments ps
       LEFT JOIN segments s ON ps.segment_id = s.id
       ${whereClause}`,
      params
    );

    const result = await pool.query(
      `SELECT
        ps.id,
        ps.idml_segment_id,
        ps.story_file,
        ps.paragraph_index,
        ps.max_chars,
        ps.position,
        ps.segment_id,
        ps.condense_status,
        s.source_text,
        s.translated_text,
        s.condensed_text,
        s.hit_count,
        s.is_stale,
        s.glossary_version,
        s.review_status,
        s.edited_by_user,
        s.original_translation,
        s.approved_at,
        s.clarification_note,
        s.clarification_at,
        s.channel_rewrite,
        COALESCE(ua.display_name, ua.name, ua.email) AS approved_by_name,
        COALESCE(uc.display_name, uc.name, uc.email) AS clarification_by_name
      FROM project_segments ps
      LEFT JOIN segments s ON ps.segment_id = s.id
      LEFT JOIN users ua ON ua.id = s.approved_by
      LEFT JOIN users uc ON uc.id = s.clarification_by
      ${whereClause}
      ORDER BY ps.position ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    // Glossar-Eintraege fuer dieses Projekt einmal laden, dann pro Segment Hits berechnen
    let glossaryEntries: GlossaryEntry[] = [];
    try {
      const projRes = await pool.query<{ source_lang: string; target_lang: string }>(
        `SELECT source_lang, target_lang FROM projects WHERE id = $1`,
        [projectId],
      );
      if (projRes.rows.length > 0) {
        const { source_lang, target_lang } = projRes.rows[0];
        const entriesRes = await pool.query<GlossaryEntry>(
          `SELECT ge.source_term, ge.target_term
             FROM glossary_entries ge
             JOIN glossaries g ON g.id = ge.glossary_id
            WHERE g.source_lang = $1 AND g.target_lang = $2 AND ge.target_term IS NOT NULL`,
          [source_lang, target_lang],
        );
        glossaryEntries = entriesRes.rows;
      }
    } catch (e) {
      // Glossar-Lookup ist nice-to-have — bei Fehler nur loggen, nicht crashen
      console.warn('[segments] Glossar-Hits konnten nicht berechnet werden:', e);
    }

    const segmentsWithHits = result.rows.map((row) => ({
      ...row,
      // Anzeige = die Grenze, gegen die tatsächlich gekürzt wird (nicht der Rohwert aus der DB)
      max_chars: effectiveMaxChars(row.source_text || '', row.max_chars),
      source_glossary_hits:
        glossaryEntries.length > 0 && row.source_text
          ? findGlossaryHits(row.source_text, glossaryEntries, 'source')
          : [],
      target_glossary_hits:
        glossaryEntries.length > 0 && (row.condensed_text || row.translated_text)
          ? findGlossaryHits(row.condensed_text || row.translated_text, glossaryEntries, 'target')
          : [],
    }));

    res.json({
      segments: segmentsWithHits,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (err: any) {
    console.error('Failed to fetch segments:', err);
    res.status(500).json({ error: 'Failed to fetch segments' });
  }
});

/**
 * GET /api/projects/:projectId/segments/stats
 * Statistiken zu den Segmenten eines Projekts.
 */
router.get('/:projectId/segments/stats', async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await pool.query(
      `SELECT
        COUNT(*) as total,
        COUNT(s.translated_text) as translated,
        COUNT(s.condensed_text) as condensed,
        COUNT(*) FILTER (WHERE s.is_stale = TRUE) as stale,
        COUNT(*) FILTER (WHERE s.review_status = 'approved') as approved,
        COUNT(*) FILTER (WHERE s.review_status = 'edited') as edited,
        COUNT(*) FILTER (WHERE s.review_status = 'needs_clarification') as clarification,
        COUNT(*) FILTER (WHERE ps.condense_status IN ('still_long','manual_review')) as needs_review,
        SUM(s.hit_count) as total_cache_hits,
        AVG(LENGTH(s.source_text))::int as avg_source_length
      FROM project_segments ps
      LEFT JOIN segments s ON ps.segment_id = s.id
      WHERE ps.project_id = $1`,
      [projectId]
    );

    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('Failed to fetch segment stats:', err);
    res.status(500).json({ error: 'Failed to fetch segment stats' });
  }
});

export default router;
