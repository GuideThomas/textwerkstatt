import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  cancelPairing,
  confirmPairing,
  getPairing,
  listTokens,
  PanelAuthError,
  revokeToken,
} from '../services/panelAuth';

/**
 * Web-App-Seite der Panel-Anmeldung (Sitzung nötig, `requireAuth` in server.ts).
 *
 * Die Person landet über den Link aus dem Panel (`/?panel=<id>`) hier, meldet
 * sich wie gewohnt an und bestätigt die Kopplung — nur wenn im Panel derselbe
 * Code steht. Danach sieht und trennt sie ihre Verbindungen; ein Admin alle.
 */

const router = Router();

function sendError(res: Response, err: unknown, what: string): Response {
  if (err instanceof PanelAuthError) return res.status(err.status).json({ error: err.message });
  console.error(`[Panel] ${what} failed:`, err);
  return res.status(500).json({ error: 'Interner Serverfehler' });
}

/** GET /api/panel/pairings/:id — Code, Gerät und Zustand für die Bestätigungsseite. */
router.get('/pairings/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    return res.json(await getPairing(req.params.id as string, user.id));
  } catch (err) {
    return sendError(res, err, 'Pairing lookup');
  }
});

/** POST /api/panel/pairings/:id/confirm — die angemeldete Person übernimmt die Kopplung. */
router.post('/pairings/:id/confirm', async (req: Request, res: Response) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    await confirmPairing(req.params.id as string, user.id);
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'Pairing confirm');
  }
});

/** POST /api/panel/pairings/:id/cancel — „Abbrechen": die Kopplung verfällt sofort. */
router.post('/pairings/:id/cancel', async (req: Request, res: Response) => {
  try {
    await cancelPairing(req.params.id as string);
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err, 'Pairing cancel');
  }
});

/** GET /api/panel/tokens — eigene Verbindungen; `?all=1` für Admins: alle. */
router.get('/tokens', async (req: Request, res: Response) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const all = req.query.all === '1' && user.role === 'admin';
    return res.json({ tokens: await listTokens(all ? {} : { userId: user.id }) });
  } catch (err) {
    return sendError(res, err, 'Token list');
  }
});

/** DELETE /api/panel/tokens/:id — Verbindung trennen (eigene; Admin: jede). */
router.delete('/tokens/:id', async (req: Request, res: Response) => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    await revokeToken(req.params.id as string, user);
    return res.status(204).end();
  } catch (err) {
    return sendError(res, err, 'Token revoke');
  }
});

export default router;
