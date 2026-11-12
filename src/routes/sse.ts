import { Router, Request, Response } from 'express';
import { addClient } from '../services/sse';

const router = Router();

/**
 * SSE Endpoint für Echtzeit-Fortschritt eines Projekts.
 * GET /api/projects/:projectId/progress
 */
router.get('/:projectId/progress', (req: Request<{ projectId: string }>, res: Response) => {
  const { projectId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx buffering deaktivieren
  });

  // Initiale Nachricht senden
  res.write(`data: ${JSON.stringify({ phase: 'connected', progress: 0, detail: 'Verbunden' })}\n\n`);

  addClient(projectId, res);
});

export default router;
