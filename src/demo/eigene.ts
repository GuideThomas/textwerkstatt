/**
 * In der Demo sieht und berührt jeder Gast nur seine eigenen Projekte (`projects.created_by`). In der Firma ist das Gegenteil
 * gewollt — alle sehen alle Dokumente —, in einer öffentlichen Demo hieße es: Besucher A lädt die Dateien von Besucher B herunter
 * oder löscht mit einem `bulk-delete` die Projekte aller (Review 12.11.2026). Ohne Demo reicht alles nur weiter.
 *
 * Geprüft wird vor den Routern, an einer Stelle, statt in jeder der 25 Projektrouten: jede Projekt-ID im Pfad (`/:id`, `/:id/…`,
 * `/:id/diff/:otherId`) und in `bulk-delete`; die Liste filtert auf die eigene Person. Ein fremdes oder unbekanntes Projekt ist 404,
 * nicht 403 — der Gast soll nicht erfahren, dass es existiert. Der Upload (Formular, erst in der Route gelesen) prüft
 * `project_id` und `parent_project_id` selbst über `gehoertGast`.
 */
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/connection';
import { config } from '../config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gehören alle diese Projekte der Person? Leere Liste: ja. Eine ID, die keine UUID ist: nein. */
export async function gehoertGast(userId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) return false;
  const r = await pool.query<{ n: number }>(
    `SELECT count(DISTINCT id)::int AS n FROM projects WHERE id = ANY($1::uuid[]) AND created_by = $2`,
    [ids, userId],
  );
  return r.rows[0].n === new Set(ids.map((i) => i.toLowerCase())).size;
}

/** Vor `/api/projects` einhängen, hinter der Sitzung. */
export async function demoEigeneProjekte(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!config.demo.an) return next();
  const userId = req.session?.userId;
  // Ohne Sitzung antwortet gleich `requireAuth` mit 401.
  if (!userId) return next();
  try {
    // `req.path` ist hier relativ zu /api/projects.
    const teile = req.path.split('/').filter(Boolean);
    if (teile.length === 0 && req.method === 'GET') {
      (req.query as Record<string, unknown>).user = 'me';
      return next();
    }
    const ids = teile.filter((t) => UUID.test(t));
    if (teile[0] === 'bulk-delete') {
      const body = (req.body ?? {}) as { ids?: unknown };
      if (Array.isArray(body.ids)) ids.push(...(body.ids as string[]));
    }
    // Ein erstes Pfadstück, das weder UUID noch ein bekannter Sammelweg ist, fällt an den Router (404 oder Admin-Weg).
    if (!(await gehoertGast(userId, ids))) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    next();
  } catch (err) {
    console.error('Demo, eigene Projekte:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
