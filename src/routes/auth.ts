import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/connection';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// POST /api/auth/login — Local email/password login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password required' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT id, email, name, role, display_name, password_hash, active FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    if (!user.active) {
      res.status(401).json({ error: 'Account is inactive' });
      return;
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.role = user.role;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name || user.display_name,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      res.status(500).json({ error: 'Failed to logout' });
      return;
    }
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me — Return current user
router.get('/me', requireAuth, (req: Request, res: Response) => {
  const user = (req as AuthenticatedRequest).user!;
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name || user.display_name,
      role: user.role,
    },
  });
});

export default router;
