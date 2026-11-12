import type { Request, Response, NextFunction } from 'express';
import { ERROR_CATALOG } from '../i18n/errorCatalog';

/**
 * Übersetzt Fehlermeldungen der API in die Oberflächensprache (18.09.2026).
 *
 * Der Client schickt `X-UI-Lang` (de/en/it/fr/hu/sk). Statt jede der über
 * 200 `res.status(…).json({ error: '…' })`-Stellen einzeln umzubauen, fängt
 * diese Middleware `res.json` ab und schlägt `body.error` (und `body.message`)
 * im Katalog nach. Schlüssel ist der Originaltext, exakt.
 *
 * Grenzen, bewusst:
 *  - Texte mit eingesetzten Werten (Template-Strings) treffen nur, wenn der
 *    Katalog ein Muster mit `{…}`-Platzhaltern dafür hat (siehe `translateMessage`).
 *  - Nicht im Katalog = Originaltext bleibt stehen. Nichts geht verloren.
 *  - Maschinen-Clients (CEP-Panel, Chat-Werkzeug, Artikelanlage-Assistent)
 *    schicken keinen Header und bekommen den Originaltext wie bisher.
 */
const SUPPORTED = new Set(['de', 'en', 'it', 'fr', 'hu', 'sk']);

export type UiLang = 'de' | 'en' | 'it' | 'fr' | 'hu' | 'sk';

export function requestLang(req: Request): UiLang | null {
  const raw = String(req.headers['x-ui-lang'] || '').slice(0, 2).toLowerCase();
  return SUPPORTED.has(raw) ? (raw as UiLang) : null;
}

// Muster mit Platzhaltern einmal vorkompilieren: „Datei {name} fehlt" → /^Datei (.+?) fehlt$/
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = Object.entries(ERROR_CATALOG)
  .filter(([src]) => /\{\w+\}/.test(src))
  .map(([src, tr]) => {
    const names: string[] = [];
    const re = new RegExp(
      '^' + src.split(/(\{\w+\})/).map((part) => {
        const m = part.match(/^\{(\w+)\}$/);
        if (m) { names.push(m[1]); return '([\\s\\S]+?)'; }
        return escapeRe(part);
      }).join('') + '$',
    );
    return { re, names, tr };
  });

export function translateMessage(msg: string, lang: UiLang): string {
  const exact = ERROR_CATALOG[msg];
  if (exact) return exact[lang] ?? msg;
  for (const p of PATTERNS) {
    const m = msg.match(p.re);
    if (!m) continue;
    const target = p.tr[lang];
    if (!target) return msg;
    return p.names.reduce((out, name, i) => out.split(`{${name}}`).join(m[i + 1]), target);
  }
  return msg;
}

export function uiLang(req: Request, res: Response, next: NextFunction) {
  const lang = requestLang(req);
  if (!lang) return next();
  const origJson = res.json.bind(res);
  res.json = ((body: any) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const field of ['error', 'message'] as const) {
        if (typeof body[field] === 'string') {
          body = { ...body, [field]: translateMessage(body[field], lang) };
        }
      }
    }
    return origJson(body);
  }) as Response['json'];
  next();
}
