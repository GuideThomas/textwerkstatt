import { Router, Request, Response } from 'express';
import fs from 'fs';
import { pool } from '../db/connection';
import { getFilePath } from '../services/storage';
import { Project, CreateProjectRequest } from '../types';
import { AuthenticatedRequest, requireAdmin } from '../middleware/auth';

const router = Router();

const SORT_COLUMNS: Record<string, string> = {
  date: 'p.created_at',
  size: 'p.file_size_bytes',
  name: 'p.name',
};

// Erweitert eine Liste von Projekt-IDs auf die vollstaendige Versionskette (Wurzel + alle
// Nachfolger). Damit beim Löschen einer Version automatisch alle anderen Versionen
// desselben logischen Dokuments mitgelöscht werden.
async function expandToVersionChain(client: any, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const result = await client.query(
    `WITH RECURSIVE
       ancestors AS (
         SELECT id, parent_project_id FROM projects WHERE id = ANY($1::uuid[])
         UNION
         SELECT p.id, p.parent_project_id
           FROM projects p JOIN ancestors a ON p.id = a.parent_project_id
       ),
       roots AS (
         SELECT id FROM ancestors WHERE parent_project_id IS NULL
         UNION
         SELECT id FROM ancestors a WHERE NOT EXISTS (
           SELECT 1 FROM projects p2 WHERE p2.id = a.parent_project_id
         )
       ),
       descendants AS (
         SELECT id FROM roots
         UNION
         SELECT p.id FROM projects p JOIN descendants d ON p.parent_project_id = d.id
       )
     SELECT DISTINCT id::text AS id FROM descendants`,
    [ids]
  );
  return result.rows.map((r: { id: string }) => r.id);
}

// GET /api/projects — Liste mit Topics, Owner, optional gefiltert/sortiert
// Query-Params: ?sort=date|size|name&order=asc|desc&user=me|<uuid>&topics=<id>,<id>&limit=200
router.get('/', async (req: Request, res: Response) => {
  const sortKey = String(req.query.sort ?? 'date');
  const orderKey = String(req.query.order ?? 'desc').toLowerCase();
  const sortColumn = SORT_COLUMNS[sortKey] ?? SORT_COLUMNS.date;
  const order = orderKey === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 500);

  let userFilter = String(req.query.user ?? '').trim();
  if (userFilter === 'me') {
    userFilter = (req as AuthenticatedRequest).user?.id ?? '';
  }

  const topicsParam = String(req.query.topics ?? '').trim();
  const topicIds = topicsParam ? topicsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

  const where: string[] = [];
  const params: any[] = [];

  if (userFilter) {
    params.push(userFilter);
    where.push(`p.created_by = $${params.length}`);
  }

  if (topicIds.length > 0) {
    params.push(topicIds);
    where.push(`EXISTS (
      SELECT 1 FROM project_topics pt2
       WHERE pt2.project_id = p.id AND pt2.topic_id = ANY($${params.length}::uuid[])
    )`);
  }

  // Alte Versionen (Projekte die als parent_project_id referenziert werden) ausblenden —
  // nur die jeweils neueste Version (Leaf der Versionskette) zeigen.
  where.push(`NOT EXISTS (
    SELECT 1 FROM projects child WHERE child.parent_project_id = p.id
  )`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);

  try {
    const result = await pool.query(
      `SELECT p.*,
              u.display_name AS created_by_name,
              u.email AS created_by_email,
              COALESCE(
                (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
                   FROM project_topics pt
                   JOIN topics t ON t.id = pt.topic_id
                  WHERE pt.project_id = p.id),
                '[]'::json
              ) AS topics,
              -- Summe aller Dateigroessen der vollstaendigen Versionskette (Vorgaenger + dieses Projekt).
              -- Es kann nur Vorgaenger geben, da p schon der Leaf ist (NOT EXISTS-Filter oben).
              (
                WITH RECURSIVE chain AS (
                  SELECT id, parent_project_id, file_size_bytes FROM projects WHERE id = p.id
                  UNION ALL
                  SELECT pp.id, pp.parent_project_id, pp.file_size_bytes
                    FROM projects pp JOIN chain c ON pp.id = c.parent_project_id
                )
                SELECT COALESCE(SUM(file_size_bytes), 0)::bigint FROM chain
              ) AS version_chain_size_bytes,
              (
                WITH RECURSIVE chain AS (
                  SELECT id, parent_project_id FROM projects WHERE id = p.id
                  UNION ALL
                  SELECT pp.id, pp.parent_project_id
                    FROM projects pp JOIN chain c ON pp.id = c.parent_project_id
                )
                SELECT COUNT(*)::int FROM chain
              ) AS version_chain_count
         FROM projects p
         LEFT JOIN users u ON u.id = p.created_by
         ${whereSql}
        ORDER BY ${sortColumn} ${order} NULLS LAST, p.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing projects:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// GET /api/projects/storage-stats — Aggregierte Speichernutzung
router.get('/storage-stats', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS file_count,
              COALESCE(SUM(file_size_bytes), 0)::bigint AS total_bytes
         FROM projects
        WHERE stored_filename IS NOT NULL`
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching storage stats:', err);
    res.status(500).json({ error: 'Failed to fetch storage stats' });
  }
});

// POST /api/projects/bulk-delete — Mehrere Projekte löschen
router.post('/bulk-delete', async (req: Request, res: Response) => {
  const { ids } = req.body as { ids?: string[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Versionsketten expandieren: jede übergebene ID wird auf die komplette Kette
    // (Wurzel + Nachfolger) erweitert, sodass alte Versionen mitgelöscht werden.
    const fullIds = await expandToVersionChain(client, ids);
    const fileInfo = await client.query(
      `SELECT stored_filename FROM projects WHERE id = ANY($1::uuid[])`,
      [fullIds]
    );
    await client.query('DELETE FROM token_usage WHERE project_id = ANY($1::uuid[])', [fullIds]);
    await client.query('DELETE FROM project_segments WHERE project_id = ANY($1::uuid[])', [fullIds]);
    const result = await client.query(
      'DELETE FROM projects WHERE id = ANY($1::uuid[]) RETURNING id',
      [fullIds]
    );
    await client.query('COMMIT');

    let filesDeleted = 0;
    for (const row of fileInfo.rows) {
      if (row.stored_filename) {
        try { fs.unlinkSync(getFilePath(row.stored_filename)); filesDeleted++; } catch { /* ignore */ }
      }
    }
    res.json({ deleted: result.rowCount, files_deleted: filesDeleted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error bulk-deleting projects:', err);
    res.status(500).json({ error: 'Failed to bulk-delete' });
  } finally {
    client.release();
  }
});

// GET /api/projects/consistency-check — Findet Quelltexte mit unterschiedlichen Übersetzungen
// (vor `/:id` registrieren, sonst kollidiert die Route)
// Nur Admins (18.09.2026): zeigt übersetzungsübergreifend alle Sprachpaare.
router.get('/consistency-check', requireAdmin, async (req: Request, res: Response) => {
  const sourceLang = String(req.query.source_lang ?? '').toUpperCase();
  const targetLang = String(req.query.target_lang ?? '').toUpperCase();
  if (!sourceLang || !targetLang) {
    res.status(400).json({ error: 'source_lang und target_lang erforderlich' });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT
          MIN(source_text) AS source_text,
          normalized_hash,
          COUNT(DISTINCT translated_text)::int AS variant_count,
          ARRAY_AGG(DISTINCT translated_text) AS variants,
          SUM(hit_count)::int AS total_hits
         FROM segments
         WHERE source_lang = $1 AND target_lang = $2
           AND translated_text IS NOT NULL
           AND normalized_hash IS NOT NULL
         GROUP BY normalized_hash
         HAVING COUNT(DISTINCT translated_text) > 1
         ORDER BY total_hits DESC, variant_count DESC
         LIMIT 200`,
      [sourceLang, targetLang]
    );
    res.json({ items: result.rows, source_lang: sourceLang, target_lang: targetLang });
  } catch (err) {
    console.error('Error in consistency check:', err);
    res.status(500).json({ error: 'Konsistenz-Check fehlgeschlagen' });
  }
});

// GET /api/projects/:id — Einzelnes Projekt mit Topics
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              u.display_name AS created_by_name,
              u.email AS created_by_email,
              COALESCE(
                (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
                   FROM project_topics pt
                   JOIN topics t ON t.id = pt.topic_id
                  WHERE pt.project_id = p.id),
                '[]'::json
              ) AS topics
         FROM projects p
         LEFT JOIN users u ON u.id = p.created_by
        WHERE p.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching project:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// POST /api/projects — Neues Projekt (ohne Datei)
router.post('/', async (req: Request, res: Response) => {
  const { name, source_lang, target_lang } = req.body as CreateProjectRequest;
  if (!name || !source_lang || !target_lang) {
    res.status(400).json({ error: 'name, source_lang, and target_lang are required' });
    return;
  }
  const userId = (req as AuthenticatedRequest).user?.id ?? null;

  try {
    const result = await pool.query<Project>(
      `INSERT INTO projects (name, source_lang, target_lang, file_type, status, created_by)
       VALUES ($1, $2, $3, 'idml', 'pending', $4)
       RETURNING *`,
      [name, source_lang, target_lang, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// PUT /api/projects/:id/topics — Topics ersetzen
router.put('/:id/topics', async (req: Request, res: Response) => {
  const { topic_ids } = req.body as { topic_ids?: string[] };
  if (!Array.isArray(topic_ids)) {
    res.status(400).json({ error: 'topic_ids must be an array' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
    if (exists.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    await client.query('DELETE FROM project_topics WHERE project_id = $1', [req.params.id]);
    if (topic_ids.length > 0) {
      await client.query(
        `INSERT INTO project_topics (project_id, topic_id)
         SELECT $1, t.id FROM topics t WHERE t.id = ANY($2::uuid[])`,
        [req.params.id, topic_ids]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, topic_ids });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating project topics:', err);
    res.status(500).json({ error: 'Failed to update topics' });
  } finally {
    client.release();
  }
});

// DELETE /api/projects/:id — Projekt + Datei entfernen
router.delete('/:id', async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Versionskette expandieren — beim Löschen eines Projekts werden alle Versionen
    // desselben logischen Dokuments (Wurzel + alle Nachfolger) entfernt.
    const fullIds = await expandToVersionChain(client, [String(req.params.id)]);
    if (fullIds.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const fileInfo = await client.query(
      'SELECT stored_filename FROM projects WHERE id = ANY($1::uuid[])',
      [fullIds]
    );
    await client.query('DELETE FROM token_usage WHERE project_id = ANY($1::uuid[])', [fullIds]);
    await client.query('DELETE FROM project_segments WHERE project_id = ANY($1::uuid[])', [fullIds]);

    const result = await client.query(
      'DELETE FROM projects WHERE id = ANY($1::uuid[]) RETURNING id',
      [fullIds]
    );
    await client.query('COMMIT');

    let filesDeleted = 0;
    for (const row of fileInfo.rows) {
      if (row.stored_filename) {
        try { fs.unlinkSync(getFilePath(row.stored_filename)); filesDeleted++; } catch { /* ignore */ }
      }
    }
    res.json({ deleted: true, deleted_count: result.rowCount, files_deleted: filesDeleted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  } finally {
    client.release();
  }
});

// GET /api/projects/:id/versions — Versionskette (Vorgänger + Nachfolger) eines Projekts
router.get('/:id/versions', async (req: Request, res: Response) => {
  try {
    // Wurzel der Kette finden (rekursiv über parent_project_id)
    const root = await pool.query<{ root_id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_project_id FROM projects WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_project_id
           FROM projects p JOIN chain c ON p.id = c.parent_project_id
       )
       SELECT id AS root_id FROM chain WHERE parent_project_id IS NULL LIMIT 1`,
      [req.params.id]
    );
    const rootId = root.rows[0]?.root_id ?? req.params.id;

    // Komplette Kette ab Wurzel laden
    const chain = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_project_id, name, source_lang, target_lang, version_number,
                status, created_at, segment_count, file_size_bytes
           FROM projects WHERE id = $1
         UNION ALL
         SELECT p.id, p.parent_project_id, p.name, p.source_lang, p.target_lang, p.version_number,
                p.status, p.created_at, p.segment_count, p.file_size_bytes
           FROM projects p JOIN chain c ON p.parent_project_id = c.id
       )
       SELECT * FROM chain ORDER BY version_number, created_at`,
      [rootId]
    );
    res.json({ root_id: rootId, versions: chain.rows });
  } catch (err) {
    console.error('Error fetching version chain:', err);
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

// GET /api/projects/:id/diff/:otherId — Diff zwischen zwei Projekten (gleiches Sprachpaar)
router.get('/:id/diff/:otherId', async (req: Request, res: Response) => {
  try {
    const a = await pool.query(
      `SELECT ps.position, ps.idml_segment_id, s.source_text, s.translated_text
         FROM project_segments ps
         JOIN segments s ON s.id = ps.segment_id
        WHERE ps.project_id = $1
        ORDER BY ps.position`,
      [req.params.id]
    );
    const b = await pool.query(
      `SELECT ps.position, ps.idml_segment_id, s.source_text, s.translated_text
         FROM project_segments ps
         JOIN segments s ON s.id = ps.segment_id
        WHERE ps.project_id = $1
        ORDER BY ps.position`,
      [req.params.otherId]
    );

    const aMap = new Map(a.rows.map((r: any) => [r.idml_segment_id, r]));
    const bMap = new Map(b.rows.map((r: any) => [r.idml_segment_id, r]));

    const added: any[] = [];
    const removed: any[] = [];
    const changed: any[] = [];

    for (const [key, br] of bMap) {
      const ar = aMap.get(key);
      if (!ar) added.push(br);
      else if (ar.source_text !== br.source_text) changed.push({ from: ar, to: br });
    }
    for (const [key, ar] of aMap) {
      if (!bMap.has(key)) removed.push(ar);
    }

    res.json({
      counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged: bMap.size - added.length - changed.length },
      added, removed, changed,
    });
  } catch (err) {
    console.error('Error computing project diff:', err);
    res.status(500).json({ error: 'Failed to compute diff' });
  }
});

// GET /api/consistency-check — Findet Quelltexte mit unterschiedlichen Übersetzungen je Sprachpaar
// GET /api/projects/:id/jobs — Jobs eines Projekts
router.get('/:id/jobs', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM jobs WHERE project_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching jobs:', err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

export default router;
