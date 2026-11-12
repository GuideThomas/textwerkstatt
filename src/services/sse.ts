import type { Response } from 'express';

export interface ProgressEvent {
  phase: 'parsing' | 'translating' | 'condensing' | 'finalizing' | 'completed' | 'error'
       | 'aligning' | 'analyzing';
  progress: number;
  detail: string;
  cacheHits?: number;
  translated?: number;
  total?: number;
  candidates?: number;
}

// Aktive SSE-Clients pro Projekt
const clients = new Map<string, Set<Response>>();

/**
 * SSE-Client für ein Projekt registrieren.
 */
export function addClient(projectId: string, res: Response): void {
  if (!clients.has(projectId)) {
    clients.set(projectId, new Set());
  }
  clients.get(projectId)!.add(res);

  res.on('close', () => {
    clients.get(projectId)?.delete(res);
    if (clients.get(projectId)?.size === 0) {
      clients.delete(projectId);
    }
  });
}

/**
 * Fortschritt an alle SSE-Clients eines Projekts senden.
 */
export function emitProgress(projectId: string, event: ProgressEvent): void {
  const projectClients = clients.get(projectId);
  if (!projectClients || projectClients.size === 0) return;

  const data = JSON.stringify(event);

  for (const res of projectClients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      projectClients.delete(res);
    }
  }
}
