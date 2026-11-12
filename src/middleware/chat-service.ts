import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { requireAuth } from './auth';

/**
 * Auth fuer den Chat-Zugang (Open WebUI auf einem eigenen KI-Server).
 *
 * Warum ein EIGENER Schluessel und nicht `TRANSLATION_SERVICE_KEY`:
 * Der Chat ist ein anderer Vertrauensbereich als die internen Dienste. Der
 * Schluessel liegt dort in einer Open-WebUI-„Valve", also fuer jeden
 * WebUI-Administrator lesbar, und er wird von einem Werkzeug benutzt, das die
 * gesamte Belegschaft aufrufen kann. Er muss getrennt rotier- und widerrufbar
 * sein, ohne batch-translate/condense/CEP mitzureissen.
 *
 * 🚨 Unterschied zum bestehenden Muster (`/api/cep`, `/api/batch-translate`):
 *    Dort gilt „kein Schluessel gesetzt = keine Auth" (Localhost-Vertrauen).
 *    Hier NICHT. Ein leerer `CHAT_SERVICE_KEY` bedeutet **geschlossen**, nicht
 *    offen. Grund: Dieser Pfad gibt DeepL-Uebersetzungen an einen Aufrufer
 *    ausserhalb des Hauses frei und kostet Geld — ein vergessener Schluessel
 *    darf nicht in einen offenen Endpunkt umschlagen. Fail-closed ist hier die
 *    einzig vertretbare Vorgabe.
 */

interface Window {
  windowStart: number;
  requests: number;
  chars: number;
  day: string;
}

const windows = new Map<string, Window>();

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual wirft bei ungleicher Laenge — Laengenvergleich zuerst.
  // Der Laengen-Leak ist hinnehmbar, ein Byte-fuer-Byte-Vergleich waere es nicht.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Bremse gegen einen abhanden gekommenen Schluessel: Anfragen je Minute und
 * uebersetzte Zeichen je Tag.
 *
 * ⚠️ Der Zaehler lebt im Prozess-Speicher und faellt bei jedem Neustart auf
 *    null zurueck. Das ist eine BREMSE, keine Buchhaltung — die belastbare
 *    Zahl liefert DeepL selbst (`GET /api/glossaries/deepl-usage`). Wer ein
 *    hartes Budget braucht, muss es dort ablesen, nicht hier.
 */
function withinLimits(keyName: string, chars: number): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  const day = todayKey();
  let w = windows.get(keyName);

  if (!w || w.day !== day) {
    w = { windowStart: now, requests: 0, chars: 0, day };
    windows.set(keyName, w);
  }
  if (now - w.windowStart >= 60_000) {
    w.windowStart = now;
    w.requests = 0;
  }

  if (w.requests + 1 > config.chatService.maxRequestsPerMinute) {
    return { ok: false, reason: `Zu viele Anfragen (max. ${config.chatService.maxRequestsPerMinute}/min)` };
  }
  if (w.chars + chars > config.chatService.maxCharsPerDay) {
    return {
      ok: false,
      reason: `Tages-Zeichenbudget erschoepft (max. ${config.chatService.maxCharsPerDay} Zeichen)`,
    };
  }

  w.requests += 1;
  w.chars += chars;
  return { ok: true };
}

/** Nur fuer Tests/Deploys: Zaehler zuruecksetzen. */
export function resetChatServiceLimits(): void {
  windows.clear();
}

function estimateChars(req: Request): number {
  const body = req.body as { text?: unknown } | undefined;
  return typeof body?.text === 'string' ? body.text.length : 0;
}

/**
 * Prueft den Chat-Schluessel. Wird NUR aufgerufen, wenn der Aufrufer sich
 * ueber `X-Service-Key` ausweist (siehe `sessionOrChatKey`).
 */
export function requireChatServiceKey(req: Request, res: Response, next: NextFunction): void {
  const expected = config.chatService.key;
  if (!expected) {
    console.warn('[ChatService] Aufruf abgelehnt: CHAT_SERVICE_KEY ist nicht gesetzt (fail-closed)');
    res.status(503).json({ error: 'Chat-Zugang ist nicht konfiguriert' });
    return;
  }

  const provided = req.header('X-Service-Key') || '';
  if (!timingSafeEquals(provided, expected)) {
    console.warn(`[ChatService] Ungueltiger Schluessel fuer ${req.method} ${req.originalUrl}`);
    res.status(401).json({ error: 'Invalid or missing X-Service-Key' });
    return;
  }

  const chars = estimateChars(req);
  const limit = withinLimits('chat', chars);
  if (!limit.ok) {
    console.warn(`[ChatService] Limit erreicht: ${limit.reason}`);
    res.status(429).json({ error: limit.reason });
    return;
  }

  // Audit: Der Chat ist der einzige Aufrufer, der Text von aussen einspeist —
  // ohne diese Zeile laesst sich spaeter nicht belegen, wie viel ueber ihn lief.
  console.log(`[ChatService] ${req.method} ${req.path} — ${chars} Zeichen`);
  next();
}

/**
 * Doppel-Eingang fuer Routen, die sowohl die Weboberflaeche (Entra-Sitzung) als
 * auch der Chat nutzt: Liegt ein `X-Service-Key`-Kopf an, gilt der Chat-Pfad,
 * sonst die normale Sitzungspruefung.
 *
 * Bewusst NICHT „erst Sitzung, dann Schluessel": Ein falscher Schluessel muss
 * mit 401 abgewiesen werden und nicht still auf die Sitzungspruefung fallen —
 * sonst verdeckt eine Fehlkonfiguration im Chat sich selbst.
 *
 * `allowedPaths` begrenzt, WELCHE Unterrouten der Chat-Schluessel oeffnet.
 * Ohne diese Liste oeffnete er den ganzen Router: An `/api/quick-translate`
 * haengen ausser der Uebersetzung auch `/alternatives` und `/word-order`, und
 * die rufen ein LLM. Ein abhanden gekommener Schluessel soll uebersetzen
 * koennen — nicht Token verbrennen. Die Sitzungs-Nutzer der Weboberflaeche
 * sind davon nicht betroffen.
 */
export function sessionOrChatKey(allowedPaths?: string[]) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (req.header('X-Service-Key')) {
      if (allowedPaths && !allowedPaths.includes(req.path)) {
        console.warn(`[ChatService] Route ${req.path} ist fuer den Chat-Zugang nicht freigegeben`);
        res.status(403).json({ error: 'Diese Route ist fuer den Chat-Zugang nicht freigegeben' });
        return;
      }
      requireChatServiceKey(req, res, next);
      return;
    }
    requireAuth(req, res, next);
  };
}
