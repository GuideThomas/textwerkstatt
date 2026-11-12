import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { requireAdmin } from '../middleware/auth';
import { config } from '../config';
import { isDeepLReachable, getDeepLLastError, getDeepLLastCheck, checkDeepLHealth } from '../services/deepl';

const router = Router();

// GET /api/dashboard/costs — Token usage overview
router.get('/costs', requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Daily costs (last 30 days)
    const dailyCosts = await pool.query(`
      SELECT
        -- Tagesgrenze ausdruecklich Wien, nicht aus der Session geerbt (11.09.2026):
        -- DATE() auf einem timestamptz wertet in der SESSION-Zeitzone aus. Die kommt
        -- hier von der Systemzone des VPS (Europe/Berlin, versatzgleich) und stimmt
        -- damit heute — steht aber nirgends im Code. Auf einem Host in UTC fielen
        -- alle Kosten zwischen 00:00 und 02:00 Wiener Zeit auf den Vortag.
        DATE(created_at AT TIME ZONE 'Europe/Vienna') AS day,
        model,
        COUNT(*) AS requests,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cost_usd) AS cost_usd
      FROM token_usage
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at AT TIME ZONE 'Europe/Vienna'), model
      ORDER BY day DESC, model
    `);

    // Costs per project
    const projectCosts = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.source_lang,
        p.target_lang,
        p.file_type,
        COUNT(t.id) AS llm_requests,
        COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(t.cost_usd), 0) AS cost_usd
      FROM projects p
      LEFT JOIN token_usage t ON t.project_id = p.id
      GROUP BY p.id, p.name, p.source_lang, p.target_lang, p.file_type
      ORDER BY cost_usd DESC
      LIMIT 50
    `);

    // Total costs
    const totals = await pool.query(`
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COUNT(DISTINCT model) AS models_used
      FROM token_usage
    `);

    // Costs by purpose
    const purposeCosts = await pool.query(`
      SELECT
        purpose,
        COUNT(*) AS requests,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM token_usage
      GROUP BY purpose
      ORDER BY cost_usd DESC
    `);

    // Usage by model (with tokens + cost)
    const fallbackRate = await pool.query(`
      SELECT
        model,
        COUNT(*) AS count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM token_usage
      GROUP BY model
      ORDER BY cost_usd DESC
    `);

    res.json({
      daily: dailyCosts.rows,
      projects: projectCosts.rows,
      totals: totals.rows[0],
      byPurpose: purposeCosts.rows,
      byModel: fallbackRate.rows,
    });
  } catch (err) {
    console.error('Dashboard costs error:', err);
    res.status(500).json({ error: 'Failed to fetch cost data' });
  }
});

// GET /api/dashboard/cache — Cache statistics
router.get('/cache', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) AS total_segments,
        COUNT(*) FILTER (WHERE hit_count > 0) AS segments_with_hits,
        COALESCE(SUM(hit_count), 0) AS total_hits,
        ROUND(
          COUNT(*) FILTER (WHERE hit_count > 0) * 100.0 / NULLIF(COUNT(*), 0), 1
        ) AS hit_rate_pct
      FROM segments
    `);

    // Top cached segments
    const topCached = await pool.query(`
      SELECT
        LEFT(source_text, 80) AS source_preview,
        source_lang,
        target_lang,
        hit_count,
        is_stale
      FROM segments
      WHERE hit_count > 0
      ORDER BY hit_count DESC
      LIMIT 20
    `);

    // Stale segments
    const staleCount = await pool.query(`
      SELECT COUNT(*) AS stale_count FROM segments WHERE is_stale = TRUE
    `);

    res.json({
      stats: stats.rows[0],
      topCached: topCached.rows,
      staleCount: parseInt(staleCount.rows[0].stale_count),
    });
  } catch (err) {
    console.error('Dashboard cache error:', err);
    res.status(500).json({ error: 'Failed to fetch cache data' });
  }
});

// GET /api/dashboard/deepl — DeepL usage tracking
router.get('/deepl', requireAdmin, async (_req: Request, res: Response) => {
  try {
    // Try to get DeepL usage from their API
    let deeplUsage = null;
    if (config.deepl.apiKey) {
      try {
        const deeplUrl = config.deepl.apiKey.endsWith(':fx')
          ? 'https://api-free.deepl.com/v2/usage'
          : 'https://api.deepl.com/v2/usage';

        const response = await fetch(deeplUrl, {
          headers: { Authorization: `DeepL-Auth-Key ${config.deepl.apiKey}` },
        });

        if (response.ok) {
          deeplUsage = await response.json();
        }
      } catch {
        // DeepL API not reachable
      }
    }

    // Count translated segments from DB
    const segmentStats = await pool.query(`
      SELECT
        COUNT(*) AS total_translated,
        SUM(LENGTH(source_text)) AS total_source_chars,
        SUM(LENGTH(translated_text)) AS total_translated_chars
      FROM segments
      WHERE translated_text IS NOT NULL
    `);

    res.json({
      deepl: deeplUsage,
      segments: segmentStats.rows[0],
      reachable: isDeepLReachable(),
      lastError: getDeepLLastError(),
      lastCheck: getDeepLLastCheck(),
    });
  } catch (err) {
    console.error('Dashboard DeepL error:', err);
    res.status(500).json({ error: 'Failed to fetch DeepL data' });
  }
});

// GET /api/dashboard/overview — Quick summary
router.get('/overview', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const projects = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'processing' OR status = 'translating' OR status = 'condensing') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'error') AS errors
      FROM projects
    `);

    const glossaries = await pool.query(`
      SELECT COUNT(*) AS total FROM glossaries
    `);

    const entries = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE target_term IS NOT NULL) AS total,
        COUNT(*) FILTER (WHERE approved = TRUE) AS approved
      FROM glossary_entries
    `);

    const segments = await pool.query(`
      SELECT COUNT(*) AS total FROM segments
    `);

    res.json({
      projects: projects.rows[0],
      glossaries: parseInt(glossaries.rows[0].total),
      glossaryEntries: entries.rows[0],
      segments: parseInt(segments.rows[0].total),
    });
  } catch (err) {
    console.error('Dashboard overview error:', err);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

// GET /api/dashboard/deepl/health — Live-Reachability prüfen
router.get('/deepl/health', requireAdmin, async (_req: Request, res: Response) => {
  const result = await checkDeepLHealth();
  res.json(result);
});

export default router;
