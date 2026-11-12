/**
 * Smart-Condensing-Endpoint fuer interne Service-Calls.
 *
 * Nimmt einen bereits uebersetzten Text und kuerzt ihn per LLM, damit er
 * ein hartes Zeichenlimit einhaelt (z.B. SAP B1 ItemName: 100 Zeichen).
 * Im Gegensatz zur Projekt-Pipeline (queue.ts) gibt es hier KEINE
 * DB-Schreibvorgaenge — der Aufrufer ist fuer Caching selbst zustaendig.
 *
 * Auth: Optional via X-Service-Key Header (wie /api/batch-translate).
 *
 * Clients: Artikelanlage-Assistent (ItemName-Trunc auf 100 Zeichen)
 */
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { callLlmNamen, logTokenUsage } from '../services/llm';
import { condenseAufGrenze } from '../services/condensing';
import { ladeBegriffe } from '../services/begriffe-im-text';

const router = Router();

interface CondenseRequest {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  maxChars: number;
  /** Verkaufschannel (z. B. SHOPA, B2C): dann gelten dessen Glossarbegriffe. Ohne: Standard. */
  channelCode?: string;
}

interface CondenseResponse {
  condensedText: string;
  attempts: number;
  status: 'condensed' | 'still_long' | 'manual_review';
  charactersUsed: number;
  grund?: 'budget' | 'llm_fehler';
}

function requireServiceKey(req: Request, res: Response, next: NextFunction): void {
  const expected = config.serviceKey;
  if (!expected) { next(); return; }
  const provided = req.header('X-Service-Key') || '';
  if (provided !== expected) {
    res.status(401).json({ error: 'Invalid or missing X-Service-Key' });
    return;
  }
  next();
}

router.post('/', requireServiceKey, async (req: Request, res: Response) => {
  const body = req.body as CondenseRequest;

  if (
    !body ||
    typeof body.sourceText !== 'string' ||
    typeof body.translatedText !== 'string' ||
    typeof body.sourceLang !== 'string' ||
    typeof body.targetLang !== 'string' ||
    typeof body.maxChars !== 'number' ||
    body.maxChars <= 0
  ) {
    res.status(400).json({
      error: 'sourceText, translatedText, sourceLang, targetLang, maxChars (>0) erforderlich',
    });
    return;
  }

  const sourceLang = body.sourceLang.toUpperCase();
  const targetLang = body.targetLang.toUpperCase();
  const { sourceText, translatedText, maxChars } = body;

  // Bereits kurz genug → unveraendert zurueck (Aufrufer sollte das eigentlich
  // vorab pruefen, aber wir sind hier robust).
  if (translatedText.length <= maxChars) {
    res.json({
      condensedText: translatedText,
      attempts: 0,
      status: 'condensed',
      charactersUsed: 0,
    } as CondenseResponse);
    return;
  }

  try {
    // Artikelnamen: Glossar und Wortliste samt Einträgen nur für Namen, je Channel. Gefiltert auf die Begriffe, die in
    // DIESEM Namen stehen, wird in `condenseAufGrenze` (Entscheid Thomas 11.11.2026, `begriffe-im-text.ts`).
    const channel = typeof body.channelCode === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(body.channelCode) ? body.channelCode : null;
    const begriffe = await ladeBegriffe(sourceLang, targetLang, { channel, fuerNamen: true }).catch(() => []);
    // Zwei Versuche mit Halluzinations-, Satzzeichen- und (seit 29.10.2026)
    // Komma-Schutz — Begründung am Kopf von `condenseAufGrenze()`. Kosten werden je
    // Aufruf erfasst (externer Endpoint ohne project/segment-Kontext → null).
    const ergebnis = await condenseAufGrenze(
      { sourceText, translatedText, targetLang, maxChars, begriffe },
      callLlmNamen,
      (r) => logTokenUsage(r, 'condense'),
    );
    res.json(ergebnis as CondenseResponse);
  } catch (err: any) {
    console.error('[Condense] Error:', err);
    res.status(500).json({ error: err.message || 'Condense fehlgeschlagen' });
  }
});

export default router;
