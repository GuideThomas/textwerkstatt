/**
 * Zugang für interne Dienste: mit `X-Service-Key`, wenn einer konfiguriert ist, sonst nur direkt vom selben Rechner.
 *
 * Dasselbe Verhalten wie `requireServiceKeyOrLocal` in `routes/channel-fassung.ts`: zu statt offen. Am 27.10.2026 war
 * `TRANSLATION_SERVICE_KEY` am VPS nicht gesetzt, und `batch-translate` nahm Anfragen von außen an (#1634). Ohne Schlüssel
 * kommt nur durch, wer direkt über Loopback spricht und keinen Proxy-Kopf trägt: nginx verbindet sich zwar auch von
 * 127.0.0.1, setzt aber X-Forwarded-For/X-Real-IP, ein Aufruf von außen trägt sie also immer.
 *
 * Der Schlüssel wird je Anfrage gelesen, nicht beim Laden des Moduls.
 */
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function requireServiceKeyOrLocal(req: Request, res: Response, next: NextFunction): void {
  const expected = config.serviceKey;
  if (expected) {
    if ((req.header('X-Service-Key') || '') !== expected) {
      res.status(401).json({ error: 'Invalid or missing X-Service-Key' });
      return;
    }
    next();
    return;
  }
  const direct = LOOPBACK.has(req.socket.remoteAddress ?? '');
  const proxied = !!(req.header('X-Forwarded-For') || req.header('X-Real-IP') || req.header('CF-Connecting-IP'));
  if (direct && !proxied) {
    next();
    return;
  }
  res.status(403).json({ error: 'Nur für interne Dienste' });
}
