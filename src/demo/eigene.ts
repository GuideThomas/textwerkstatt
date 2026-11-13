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

/** Wege unter `/api/projects` ohne Projekt-ID im Pfad (`routes/projects.ts`). Ein neuer Sammelweg gehört hierher, sonst ist er 404. */
const SAMMELWEGE = new Set(['storage-stats', 'bulk-delete', 'consistency-check']);

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
    if (teile.length === 0) return next(); // POST /: ein neues Projekt gehört dem, der es anlegt
    const ids: string[] = [];
    // Express ordnet Routen ohne Rücksicht auf Groß- und Kleinschreibung zu, also hier genauso (`/Bulk-Delete`).
    const erstes = teile[0].toLowerCase();
    if (teile.length === 1 && SAMMELWEGE.has(erstes)) {
      if (erstes === 'bulk-delete') {
        const body = (req.body ?? {}) as { ids?: unknown };
        if (Array.isArray(body.ids)) ids.push(...(body.ids as string[]));
      }
    } else {
      // Alles andere ist `/:id/…`. Das erste Stück MUSS eine streng geschriebene UUID sein: Postgres nimmt eine UUID auch ohne
      // Bindestriche oder in Klammern an, und Express dekodiert `%34…` erst für die Route. Bis 13.11.2026 wurden nur Stücke
      // geprüft, die wie eine UUID aussahen; alles andere lief ungeprüft durch, und der Router fand das fremde Projekt.
      if (!UUID.test(teile[0])) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      ids.push(teile[0]);
      // `/:id/diff/:otherId` nennt ein zweites Projekt. Weitere UUIDs im Pfad sind KEINE Projekte (`/:id/segments/:segmentId`):
      // Sie als Projekt zu prüfen, hat bis 13.11.2026 jeden Schreibweg an einem eigenen Segment mit 404 „Projekt nicht gefunden“
      // beantwortet — die richtige Wirkung aus dem falschen Grund. Die Sperre dafür steht unten, mit ihrem Grund.
      if (teile[1]?.toLowerCase() === 'diff') {
        if (!teile[2] || !UUID.test(teile[2])) {
          res.status(404).json({ error: 'Project not found' });
          return;
        }
        ids.push(teile[2]);
      }
    }
    if (!(await gehoertGast(userId, ids))) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    // Segmente lesen ja, schreiben nein: Die Zeilen in `segments` sind der Übersetzungs-Cache, und der ist für alle Gäste
    // gemeinsam (Schlüssel: Text, Sprachpaar, Channel …). Wer in SEINEM Projekt ein Segment bearbeitet oder freigibt, ändert
    // dieselbe Zeile, auf die das Projekt eines anderen Gasts mit demselben Satz zeigt. In der Firma ist das gewollt, in einer
    // öffentlichen Demo ein Schreibzugriff über die Projektgrenze. Offen erst, wenn der Cache der Demo je Gast getrennt ist.
    const schreibt = req.method !== 'GET' && req.method !== 'HEAD';
    if (schreibt && teile[1]?.toLowerCase() === 'segments') {
      res.status(403).json({
        error: 'In der Demo lassen sich Segmente nicht bearbeiten oder freigeben: Der Übersetzungs-Cache ist für alle Gäste gemeinsam.',
        code: 'demo_gesperrt',
      });
      return;
    }
    next();
  } catch (err) {
    console.error('Demo, eigene Projekte:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
