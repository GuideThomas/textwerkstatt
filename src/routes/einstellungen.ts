/**
 * Öffentliche Einstellungen für die Oberfläche, ohne Anmeldung lesbar (auch die Anmeldeseite braucht sie).
 *
 * Nur, was jeder Besucher sehen darf: der Name der Organisation und ein Link auf die LanguageTool-Sprachliste,
 * falls LanguageTool öffentlich erreichbar ist. Eine interne Adresse (localhost, Container-Netz) wird nicht
 * genannt; die Oberfläche lässt den Link dann weg.
 */
import { Router } from 'express';
import { config } from '../config';
import { pool } from '../db/connection';

const router = Router();

function oeffentlicherLink(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    const host = u.hostname;
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || !host.includes('.')) return null;
    return `${u.origin}/v2/languages`;
  } catch {
    return null;
  }
}

/** Nächster Reset der Demo aus `demo_stand` (Phase 6). Fehlt die Zeile oder scheitert die Abfrage: null, das Banner nennt dann kein Datum. */
async function naechsterReset(): Promise<string | null> {
  try {
    const r = await pool.query<{ naechster_reset: Date | null }>('SELECT naechster_reset FROM demo_stand LIMIT 1');
    return r.rows[0]?.naechster_reset?.toISOString() ?? null;
  } catch {
    return null;
  }
}

router.get('/einstellungen', async (_req, res) => {
  res.json({
    organisationName: config.organisationName,
    appName: config.appName,
    languagetoolLink: oeffentlicherLink(config.languagetool.url),
    // Die Oberfläche zeigt danach die Knöpfe; der Server prüft selbst (`middleware/glossar-recht.ts`).
    glossarFreigabe: config.glossarFreigabe,
    // Demo: Tor statt Anmeldung, Hinweise auf jeder Seite. Ohne Demo `null`, die Oberfläche bleibt wie bisher.
    demo: config.demo.an ? { naechsterReset: await naechsterReset() } : null,
  });
});

export default router;
