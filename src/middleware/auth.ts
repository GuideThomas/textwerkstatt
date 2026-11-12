import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/connection';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    display_name: string | null;
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT id, email, name, role, display_name, active FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      req.session.destroy(() => {});
      res.status(401).json({ error: 'User not found or inactive' });
      return;
    }

    (req as AuthenticatedRequest).user = result.rows[0];
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Nur Admins. Hat `requireAuth` in dieser Anfrage schon geprüft (Router unter `app.use(…, requireAuth, …)`), gilt dessen Ergebnis;
 * `req.user` setzt allein `requireAuth`, aus der Datenbank. Sonst prüft diese Funktion die Anmeldung selbst.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const pruefeRolle = () => {
    const user = (req as AuthenticatedRequest).user;
    if (user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  };
  if ((req as AuthenticatedRequest).user) {
    pruefeRolle();
    return Promise.resolve();
  }
  return requireAuth(req, res, pruefeRolle);
}
