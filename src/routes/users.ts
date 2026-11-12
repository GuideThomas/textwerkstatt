import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

const VALID_ROLES = ['admin', 'user', 'viewer'];

// GET /api/users/list — schlanke Auswahl-Liste für Filter-UI (alle eingeloggten)
router.get('/list', requireAuth, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT u.id, COALESCE(u.display_name, u.name, u.email) AS label, u.email,
              COUNT(p.id)::int AS project_count
         FROM users u
         LEFT JOIN projects p ON p.created_by = u.id
        WHERE u.active = TRUE
        GROUP BY u.id
        ORDER BY label`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching user list:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/users — alle Benutzer (Admin only)
router.get('/', requireAdmin, async (_req: Request, res: Response) => {
  try {
    // darf_cloud_ki*: Freischaltung der Cloud-KI in der Textwerkstatt (Migration 040, Cockpit #1838).
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.active, u.microsoft_id, u.display_name, u.created_at, u.updated_at,
              u.darf_cloud_ki, u.darf_cloud_ki_am, COALESCE(v.display_name, v.name, v.email) AS darf_cloud_ki_von_name
         FROM users u
         LEFT JOIN users v ON v.id = u.darf_cloud_ki_von
        ORDER BY u.name, u.email`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/users — neuen Benutzer anlegen (Admin only)
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !role) {
      res.status(400).json({ error: 'E-Mail und Rolle erforderlich' });
      return;
    }

    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ error: `Ungültige Rolle. Erlaubt: ${VALID_ROLES.join(', ')}` });
      return;
    }

    const passwordHash = password
      ? bcrypt.hashSync(password, 10)
      : '$2a$10$' + 'x'.repeat(53); // Placeholder for Microsoft-only users

    const result = await pool.query(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, active, created_at`,
      [email, name || null, passwordHash, role]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') { // unique_violation
      res.status(409).json({ error: 'E-Mail existiert bereits' });
      return;
    }
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PUT /api/users/:id — Benutzer aktualisieren (Admin only)
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, role, active, password } = req.body;
    const userId = req.params.id;

    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Benutzer nicht gefunden' });
      return;
    }

    if (role && !VALID_ROLES.includes(role)) {
      res.status(400).json({ error: `Ungültige Rolle. Erlaubt: ${VALID_ROLES.join(', ')}` });
      return;
    }

    await pool.query(
      `UPDATE users SET
        name = COALESCE($2, name),
        role = COALESCE($3, role),
        active = COALESCE($4, active),
        updated_at = NOW()
       WHERE id = $1`,
      [userId, name ?? null, role ?? null, active ?? null]
    );

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
    }

    const updated = await pool.query(
      `SELECT id, email, name, role, active, microsoft_id, display_name, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PUT /api/users/:id/cloud-ki — Cloud-KI der Textwerkstatt freischalten oder sperren (Admin only, Cockpit #1838).
// Vermerkt wer und wann in der Zeile und im Verlauf `ki_freischaltung_verlauf`. Geprüft wird die Freischaltung
// je Aufruf am Server (`services/ki-weg.ts`), nicht aus diesem Feld im Browser.
router.put('/:id/cloud-ki', requireAdmin, async (req: Request, res: Response) => {
  const erlaubt = req.body?.erlaubt;
  if (typeof erlaubt !== 'boolean') {
    res.status(400).json({ error: 'Feld erlaubt: ja oder nein' });
    return;
  }
  const userId = String(req.params.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    res.status(404).json({ error: 'Benutzer nicht gefunden' });
    return;
  }
  const von = (req as AuthenticatedRequest).user!.id;
  // `connect` im try: Express 4 fängt abgelehnte Promises nicht, ein voller Pool beendete sonst den Prozess.
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE users SET darf_cloud_ki = $2, darf_cloud_ki_von = $3, darf_cloud_ki_am = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING id`,
      [userId, erlaubt, von]
    );
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Benutzer nicht gefunden' });
      return;
    }
    await client.query(
      'INSERT INTO ki_freischaltung_verlauf (user_id, erlaubt, von) VALUES ($1, $2, $3)',
      [userId, erlaubt, von]
    );
    // Noch in der Transaktion lesen: Scheitert das, ist auch nichts gespeichert, und 500 stimmt.
    const updated = await client.query(
      `SELECT u.id, u.darf_cloud_ki, u.darf_cloud_ki_am, COALESCE(v.display_name, v.name, v.email) AS darf_cloud_ki_von_name
         FROM users u LEFT JOIN users v ON v.id = u.darf_cloud_ki_von WHERE u.id = $1`,
      [userId]
    );
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Error updating cloud-ki:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  } finally {
    client?.release();
  }
});

// DELETE /api/users/:id — Benutzer deaktivieren (nicht löschen)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.user?.id === req.params.id) {
      res.status(400).json({ error: 'Eigenen Account kann man nicht deaktivieren' });
      return;
    }

    const result = await pool.query(
      'UPDATE users SET active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Benutzer nicht gefunden' });
      return;
    }

    res.json({ message: 'Benutzer deaktiviert' });
  } catch (err) {
    console.error('Error deactivating user:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
