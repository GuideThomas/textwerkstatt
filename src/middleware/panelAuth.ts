import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { clientOf, lookupPanelToken, recordSharedKeyUse, safeEqual, PanelUser } from '../services/panelAuth';

/**
 * Zugang zu `/api/cep/*` (Illustrator-Panel), 28.10.2026.
 *
 * 1. `Authorization: Bearer ttp_…` — persönlicher Panel-Schlüssel aus der
 *    Kopplung (services/panelAuth.ts). Aufträge gehören dann der Person.
 * 2. Übergang: `X-Service-Key` = `CEP_SERVICE_KEY`, solange der Schlüssel in der
 *    `.env` steht. Jede Nutzung wird gezählt (`cep_shared_key_uses`); entfernt wird
 *    er, wenn dort 14 Tage nichts mehr dazukommt (PLAN-panel-anmeldung.md §5 F4).
 * 3. Sonst 401 — auch dann, wenn GAR KEIN Schlüssel konfiguriert ist.
 *
 * Bis 28.10.2026 ließ die Route alles durch, wenn weder `CEP_SERVICE_KEY` noch
 * `TRANSLATION_SERVICE_KEY` gesetzt war („Localhost-Vertrauen"). Genau so stand es
 * bis 27.10. am Server (README §Auth) — nginx leitet von außen auf denselben Port.
 * `TRANSLATION_SERVICE_KEY` öffnet `/api/cep` nicht mehr: außer dem Panel ruft die
 * Route niemand auf (gesucht über alle Projekte, 28.10.2026).
 */

export interface PanelAuth {
  kind: 'personal' | 'shared';
  tokenId?: string;
  user?: PanelUser;
}

export interface PanelRequest extends Request {
  panelAuth?: PanelAuth;
}

/** Am Fehlercode erkennt das Panel, dass sein eigener Schlüssel nicht mehr gilt. */
export const PANEL_TOKEN_INVALID = 'panel_token_invalid';

export async function requirePanelAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.header('Authorization') || '');
    if (bearer) {
      const found = await lookupPanelToken(bearer[1]);
      if (!found) {
        res.status(401).json({
          error: 'Panel-Verbindung ungültig oder getrennt — bitte im Panel neu anmelden',
          code: PANEL_TOKEN_INVALID,
        });
        return;
      }
      (req as PanelRequest).panelAuth = { kind: 'personal', tokenId: found.tokenId, user: found.user };
      next();
      return;
    }

    const provided = req.header('X-Service-Key') || '';
    if (config.cepServiceKey && provided && safeEqual(provided, config.cepServiceKey)) {
      (req as PanelRequest).panelAuth = { kind: 'shared' };
      recordSharedKeyUse(clientOf(req.ip)).catch((err) => console.error('[Panel] Zählung gemeinsamer Schlüssel:', err));
      next();
      return;
    }

    res.status(401).json({ error: 'Nicht angemeldet — bitte das Panel mit Microsoft verbinden' });
  } catch (err) {
    console.error('[Panel] Auth failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}
