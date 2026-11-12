/**
 * `POST /api/namensfassung` — einen übersetzten Artikelnamen umstellen bzw. eine
 * Wortwiederholung auflösen. Kern und Begründung: `services/namensfassung.ts`.
 *
 * Auth fail closed wie `/api/channel-fassung`: mit `TRANSLATION_SERVICE_KEY` der
 * Schlüssel, ohne nur direkte Loopback-Aufrufe ohne Proxy-Kopfzeilen.
 *
 * Clients: Artikelanlage-Assistent (prüft die Antwort selbst, bevor er sie nimmt).
 */
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { callLlmNamen, logTokenUsage } from '../services/llm';
import { namensfassung } from '../services/namensfassung';
import { ladeBegriffe } from '../services/begriffe-im-text';

const router = Router();
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function requireServiceKeyOrLocal(req: Request, res: Response, next: NextFunction): void {
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

router.post('/', requireServiceKeyOrLocal, async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const deutsch = text(b.deutsch);
  const uebersetzung = text(b.uebersetzung);
  const zielsprache = text(b.zielsprache).toUpperCase();
  const kennungVorn = text(b.kennungVorn);
  const wiederholt = Array.isArray(b.wiederholt)
    ? b.wiederholt.filter((w: unknown) => typeof w === 'string' && w.length <= 40).slice(0, 5)
    : [];
  const maxChars = typeof b.maxChars === 'number' && b.maxChars > 0 ? b.maxChars : 100;
  if (!deutsch || !uebersetzung || !zielsprache || deutsch.length > 500 || uebersetzung.length > 500) {
    res.status(400).json({ error: 'deutsch, uebersetzung und zielsprache erforderlich (höchstens 500 Zeichen)' });
    return;
  }
  if (!kennungVorn && wiederholt.length === 0) {
    res.status(400).json({ error: 'kennungVorn oder wiederholt angeben — sonst gibt es nichts zu tun' });
    return;
  }
  const channel = typeof b.channelCode === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(b.channelCode) ? b.channelCode : null;
  try {
    const begriffe = await ladeBegriffe('DE', zielsprache, { channel, fuerNamen: true }).catch(() => []);
    const r = await namensfassung(
      { deutsch, uebersetzung, zielsprache, kennungVorn, wiederholt, maxChars, begriffe },
      callLlmNamen,
      (x) => logTokenUsage(x, 'namensfassung'),
    );
    res.json(r);
  } catch (err: any) {
    console.error('[Namensfassung] Error:', err.message);
    res.status(502).json({ error: 'Sprachmodell nicht erreichbar' });
  }
});

export default router;
