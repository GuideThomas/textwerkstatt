import { Router } from 'express';
import { pool } from '../db/connection';

const router = Router();

router.get('/health', async (_req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() AS time');
    res.json({
      status: 'ok',
      version: '0.1.0',
      db: {
        connected: true,
        time: dbResult.rows[0].time,
      },
    });
  } catch {
    res.status(503).json({
      status: 'error',
      db: { connected: false },
    });
  }
});

export default router;
