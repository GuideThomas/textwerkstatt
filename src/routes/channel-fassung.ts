/**
 * POST /api/channel-fassung — deutsche Texte in die Fassung eines Channels
 * umschreiben (Hausschreibweise), für interne Dienste.
 *
 * Client: Artikelanlage-Assistent („Channel-Fassung vorschlagen" an den
 * Shopzeilen). Der Assistent zeigt das Ergebnis als Vorschlag; geschrieben wird
 * erst nach Bestätigung, und zwar dort, nicht hier.
 *
 * 🚨 `batch-translate` bleibt kanalneutral (Entscheid Thomas 27.08.2026). Die
 * Channel-Wirkung entsteht im deutschen Quelltext; übersetzt wird danach wie
 * bisher neutral (PLAN-channel-fassung.md §5.3).
 *
 * body:  { channelCode: "SHOPA", segments: [{ id, text }] }
 * reply: { channelCode, begriffe, eigene, fassungen: { [id]: ChannelFassung } }
 *
 * Auth: X-Service-Key, wenn konfiguriert. Ohne Schlüssel — anders als
 * batch-translate — NICHT offen, sondern nur für direkte Aufrufe vom selben
 * Rechner: Jeder Aufruf kostet Sprachmodell-Tokens, und am 27.10.2026 war
 * `TRANSLATION_SERVICE_KEY` am VPS nicht gesetzt — `batch-translate` nahm
 * Anfragen von außen an (HTTP 400 statt 401). Fail closed statt fail open.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { pool } from '../db/connection';
import { rewriteForChannel } from '../services/channel-fassung';

const router = Router();

const MAX_SEGMENTS = 500;
const MAX_TEXT = 10000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Mit Schlüssel: Schlüssel. Ohne: nur ein direkter Aufruf über die Loopback-
 * Schnittstelle. nginx verbindet sich zwar auch von 127.0.0.1, setzt aber
 * X-Forwarded-For/X-Real-IP — ein Aufruf von außen trägt sie immer.
 */
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
  const channelCode = typeof req.body?.channelCode === 'string' ? req.body.channelCode.trim().toUpperCase() : '';
  const segments = req.body?.segments;

  if (!channelCode) {
    res.status(400).json({ error: 'channelCode ist erforderlich' });
    return;
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    res.status(400).json({ error: 'segments muss ein nicht leeres Array sein' });
    return;
  }
  if (segments.length > MAX_SEGMENTS) {
    res.status(400).json({ error: `Höchstens ${MAX_SEGMENTS} Segmente je Aufruf` });
    return;
  }
  const valid = segments.every(
    (s: any) => s && typeof s.id === 'string' && s.id && typeof s.text === 'string' && s.text.length <= MAX_TEXT,
  );
  if (!valid) {
    res.status(400).json({ error: `Jedes Segment braucht id und text (höchstens ${MAX_TEXT} Zeichen)` });
    return;
  }

  try {
    const known = await pool.query(`SELECT code FROM channels ORDER BY sort_order, code`);
    const codes = known.rows.map((r: { code: string }) => r.code);
    if (!codes.includes(channelCode)) {
      // Kein stiller Rückfall auf den Standard: ein Tippfehler sähe sonst aus wie „nichts zu ändern"
      res.status(404).json({ error: `Unbekannter Channel ${channelCode}`, availableChannels: codes });
      return;
    }

    const { fassungen, begriffe, eigene } = await rewriteForChannel(
      segments.map((s: { text: string }) => s.text),
      channelCode,
    );
    const byId: Record<string, (typeof fassungen)[number]> = {};
    segments.forEach((s: { id: string }, i: number) => { byId[s.id] = fassungen[i]; });

    res.json({ channelCode, begriffe, eigene, fassungen: byId });
  } catch (err: any) {
    console.error('[Channel-Fassung] API:', err.message);
    res.status(500).json({ error: 'Channel-Fassung fehlgeschlagen' });
  }
});

export default router;
