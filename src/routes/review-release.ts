import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getReleaseStatus, releaseProject, ReleaseError } from '../services/reviewRelease';

const router = Router();

/**
 * GET /api/projects/:projectId/release
 * Freigabe-Status: gültige Freigabe, zuletzt aufgehobene, Angefragte,
 * Prüfstand (offene Segmente/Rückfragen) und ob der Betrachter freigeben darf.
 * Hebt eine Freigabe auf, deren Text sich inzwischen geändert hat.
 */
router.get('/:projectId/release', async (req: Request, res: Response) => {
  try {
    const status = await getReleaseStatus(req.params.projectId as string, (req as AuthenticatedRequest).user!);
    if (!status) return res.status(404).json({ error: 'Projekt nicht gefunden' });
    res.json(status);
  } catch (err: any) {
    console.error('Error loading release status:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

/**
 * POST /api/projects/:projectId/release
 * Ein angefragter Reviewer gibt die Übersetzung frei.
 */
router.post('/:projectId/release', async (req: Request, res: Response) => {
  try {
    const result = await releaseProject(req.params.projectId as string, (req as AuthenticatedRequest).user!);
    res.json(result);
  } catch (err: any) {
    if (err instanceof ReleaseError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Error releasing project:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
