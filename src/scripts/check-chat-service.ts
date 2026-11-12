/**
 * Prueft die Sicherheitszusagen des Chat-Zugangs (middleware/chat-service.ts).
 * Ohne Datenbank, ohne Netz — reine Logikpruefung.
 *
 * Aufruf:
 *   DB_PASSWORD=egal CHAT_SERVICE_KEY=$(openssl rand -hex 32) npx tsx src/scripts/check-chat-service.ts
 *
 * Warum als eigenes Skript und nicht als Testfall: Das Projekt hat kein
 * Test-Framework. Diese vier Zusagen — fail-closed, timing-sicherer Vergleich,
 * Begrenzungen, Routen-Beschraenkung — sind aber genau die, die man beim
 * Umbauen versehentlich aufweicht, ohne dass etwas sichtbar kaputtgeht.
 * Deshalb pruefbar hinterlegt statt nur beschrieben.
 */

import type { Request, Response, NextFunction } from 'express';
import { requireChatServiceKey, sessionOrChatKey, resetChatServiceLimits } from '../middleware/chat-service';

interface FakeRes {
  code?: number;
  body?: unknown;
  status: (c: number) => FakeRes;
  json: (b: unknown) => FakeRes;
}

function mkRes(): FakeRes {
  const r = {} as FakeRes;
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

function mkReq(headers: Record<string, string>, text = 'abc', path = '/'): Request {
  return {
    method: 'POST',
    path,
    originalUrl: '/api/quick-translate',
    body: { text },
    header: (n: string) => headers[n] ?? headers[n.toLowerCase()],
    session: {},
  } as unknown as Request;
}

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}

const KEY = process.env.CHAT_SERVICE_KEY || '';
if (!KEY) {
  console.error('CHAT_SERVICE_KEY muss gesetzt sein, sonst prueft dieses Skript nichts.');
  process.exit(2);
}

const call = (
  mw: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
): { res: FakeRes; passed: boolean } => {
  const res = mkRes();
  let passed = false;
  mw(req, res as unknown as Response, () => { passed = true; });
  return { res, passed };
};

resetChatServiceLimits();
let r = call(requireChatServiceKey, mkReq({ 'X-Service-Key': KEY }));
check('richtiger Schluessel laesst durch', r.passed && r.res.code === undefined);

resetChatServiceLimits();
r = call(requireChatServiceKey, mkReq({ 'X-Service-Key': 'falsch' }));
check('falscher Schluessel → 401', !r.passed && r.res.code === 401);

resetChatServiceLimits();
r = call(requireChatServiceKey, mkReq({ 'X-Service-Key': 'x'.repeat(KEY.length) }));
check('gleiche Laenge, falscher Inhalt → 401', !r.passed && r.res.code === 401);

resetChatServiceLimits();
r = call(sessionOrChatKey(), mkReq({}));
check('ohne Kopf → Sitzungspruefung (401 ohne Sitzung)', !r.passed && r.res.code === 401);

resetChatServiceLimits();
let letzte = mkRes();
for (let i = 0; i < 35; i++) letzte = call(requireChatServiceKey, mkReq({ 'X-Service-Key': KEY }, 'a')).res;
check('Ratenbegrenzung greift (429)', letzte.code === 429);

resetChatServiceLimits();
r = call(requireChatServiceKey, mkReq({ 'X-Service-Key': KEY }, 'x'.repeat(300_000)));
check('Tages-Zeichenbudget greift (429)', !r.passed && r.res.code === 429);

resetChatServiceLimits();
r = call(sessionOrChatKey(['/']), mkReq({ 'X-Service-Key': KEY }, 'abc', '/alternatives'));
check('Chat-Schluessel auf nicht freigegebener Route → 403', !r.passed && r.res.code === 403);

resetChatServiceLimits();
r = call(sessionOrChatKey(['/']), mkReq({}, 'abc', '/alternatives'));
check('dieselbe Route ohne Kopf → Sitzungspruefung, kein 403', !r.passed && r.res.code === 401);

console.log(failed === 0 ? '\nAlle Pruefungen bestanden.' : `\n${failed} Pruefung(en) fehlgeschlagen.`);
process.exit(failed === 0 ? 0 : 1);
