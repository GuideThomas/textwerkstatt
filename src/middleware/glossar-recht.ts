/**
 * Rechte an den Glossar-Schreibwegen, die bisher nur Admins offenstanden: Freigeben, Verwerfen, Ablehnen, Hinweise verwerfen,
 * Glossar anlegen und Löschen (`PLAN-oeffentlich-und-demo.md` Phase 2, Schalter `GLOSSAR_FREIGABE`).
 *
 * - `admin` (Vorgabe, auch bei fehlendem oder unbekanntem Wert): genau `requireAdmin`, wie seit `PLAN-glossar-freigabe.md`.
 * - `alle`: jede angemeldete Person wie ein Admin. **Löschen** nur Einträge, die eine Person über die Anwendung angelegt hat
 *   (`glossary_entries.angelegt_von`, gesetzt vom Trigger aus Migration 049). Einträge aus einem Seed tragen dort nichts und
 *   bleiben stehen (Entscheid Thomas E4, 12.11.2026). Ein ganzes Glossar löschen bleibt Admin-Sache, es enthält Seed-Einträge.
 */
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/connection';
import { requireAdmin } from './auth';
import { istAdmin, schreibtDirekt } from '../services/glossar-vorschlaege';

/** Statt `requireAdmin` an jedem Glossar-Weg, der bei `GLOSSAR_FREIGABE=alle` allen offensteht. */
export function requireGlossarRecht(req: Request, res: Response, next: NextFunction): Promise<void> | void {
  if (schreibtDirekt(req)) return next();
  return requireAdmin(req, res, next);
}

/** Löschen einer Zeile (`DELETE …/entries/:entryId`, `POST …/entries/:entryId/entfernen`). */
export async function requireLoeschRecht(
  req: Request<{ id: string; entryId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (istAdmin(req) || !schreibtDirekt(req)) {
    await requireAdmin(req, res, next);
    return;
  }
  try {
    const r = await pool.query<{ angelegt_von: string | null }>(
      `SELECT angelegt_von FROM glossary_entries WHERE id = $1 AND glossary_id = $2`,
      [req.params.entryId, req.params.id],
    );
    if (r.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    if (!r.rows[0].angelegt_von) {
      res.status(403).json({ error: 'Dieser Eintrag gehört zum Beispiel-Glossar und bleibt stehen', code: 'seed_eintrag' });
      return;
    }
    next();
  } catch (err) {
    console.error('Löschrecht prüfen:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
