import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// GET /api/topics — alle Themen mit Projekt-Anzahl (alle eingeloggten)
router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.color, t.created_at, t.updated_at,
              COALESCE(pt.cnt, 0)::int AS project_count
         FROM topics t
         LEFT JOIN (
           SELECT topic_id, COUNT(*)::int AS cnt
             FROM project_topics
            GROUP BY topic_id
         ) pt ON pt.topic_id = t.id
        ORDER BY t.name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing topics:', err);
    res.status(500).json({ error: 'Failed to list topics' });
  }
});

// POST /api/topics — neues Thema (Admin only)
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const { name, color } = req.body as { name?: string; color?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const normalizedColor = color && COLOR_RE.test(color) ? color : '#00B9F1';
  const userId = (req as AuthenticatedRequest).user?.id ?? null;

  try {
    const result = await pool.query(
      `INSERT INTO topics (name, color, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, color, created_at, updated_at`,
      [name.trim(), normalizedColor, userId]
    );
    res.status(201).json({ ...result.rows[0], project_count: 0 });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Thema mit diesem Namen existiert bereits' });
      return;
    }
    console.error('Error creating topic:', err);
    res.status(500).json({ error: 'Failed to create topic' });
  }
});

// PATCH /api/topics/:id — umbenennen / Farbe ändern (Admin only)
router.patch('/:id', requireAdmin, async (req: Request, res: Response) => {
  const { name, color } = req.body as { name?: string; color?: string };
  if (!name && !color) {
    res.status(400).json({ error: 'Mindestens name oder color erforderlich' });
    return;
  }
  if (color && !COLOR_RE.test(color)) {
    res.status(400).json({ error: 'color muss Hex-Format sein (#RRGGBB)' });
    return;
  }

  try {
    const result = await pool.query(
      `UPDATE topics SET
         name = COALESCE($2, name),
         color = COALESCE($3, color),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, color, updated_at`,
      [req.params.id, name?.trim() ?? null, color ?? null]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Thema nicht gefunden' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Thema mit diesem Namen existiert bereits' });
      return;
    }
    console.error('Error updating topic:', err);
    res.status(500).json({ error: 'Failed to update topic' });
  }
});

// DELETE /api/topics/:id — Thema entfernen (Admin only)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await pool.query('DELETE FROM topics WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Thema nicht gefunden' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting topic:', err);
    res.status(500).json({ error: 'Failed to delete topic' });
  }
});

export default router;
