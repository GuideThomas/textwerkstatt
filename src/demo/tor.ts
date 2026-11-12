/**
 * Das Tor der Demo (`PLAN-oeffentlich-und-demo.md` Phase 2): ein gemeinsames Passwort (`DEMO_PASSWORT`) öffnet eine Gastsitzung.
 *
 * Ein Gast ist eine gewöhnliche Zeile in `users` (Rolle `user`, E-Mail `gast-…@demo.invalid`, Cloud-KI frei — die Demo hat ihren
 * eigenen KI-Schlüssel mit Tagesgrenze, E5). So gelten für ihn dieselben Wege wie für jeden Nicht-Admin; was die Demo zusätzlich
 * schließt, steht in `sperre.ts`. Das Zurücksetzen (Phase 6) leert die Tabelle mit allem anderen.
 *
 * Ohne `DEMO_MODUS=an` gibt es den Weg nicht (404). Versuche je Adresse und Stunde sind begrenzt; das Passwort wird in fester Zeit
 * verglichen und nie ausgegeben oder protokolliert.
 */
import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/connection';
import { config } from '../config';

const router = Router();

const versuche = new Map<string, { stunde: number; n: number }>();

function zuVieleVersuche(adresse: string): boolean {
  const stunde = Math.floor(Date.now() / 3600000);
  const v = versuche.get(adresse);
  if (!v || v.stunde !== stunde) {
    versuche.set(adresse, { stunde, n: 1 });
    if (versuche.size > 5000) for (const [k, w] of versuche) if (w.stunde !== stunde) versuche.delete(k);
    return false;
  }
  v.n += 1;
  return v.n > config.demo.torVersucheJeStunde;
}

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Anzeigename: höchstens 40 Zeichen, ohne Steuerzeichen; leer heißt „Gast“. */
export function anzeigename(roh: unknown): string {
  const s = typeof roh === 'string' ? roh.replace(/[\p{C}<>]/gu, '').trim().slice(0, 40) : '';
  return s || 'Gast';
}

router.post('/demo', async (req, res) => {
  if (!config.demo.an) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (zuVieleVersuche(req.ip ?? '')) {
    res.status(429).json({ error: 'Zu viele Versuche. Bitte in einer Stunde noch einmal.', code: 'demo_grenze' });
    return;
  }
  const passwort = typeof req.body?.passwort === 'string' ? req.body.passwort : '';
  if (!timingSafeEqual(hash(passwort), hash(config.demo.passwort))) {
    res.status(401).json({ error: 'Das Passwort stimmt nicht' });
    return;
  }
  try {
    const name = anzeigename(req.body?.name);
    const email = `gast-${randomBytes(6).toString('hex')}@demo.invalid`;
    const r = await pool.query<{ id: string; email: string; role: string }>(
      `INSERT INTO users (email, display_name, role, active, darf_cloud_ki, darf_cloud_ki_am)
       VALUES ($1, $2, 'user', TRUE, TRUE, NOW()) RETURNING id, email, role`,
      [email, name],
    );
    const u = r.rows[0];
    // Neue Sitzungs-ID beim Anmelden, damit eine vorher untergeschobene nicht weiterlebt.
    req.session.regenerate((err) => {
      if (err) {
        console.error('Demo-Tor: Sitzung', err);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      req.session.userId = u.id;
      req.session.email = u.email;
      req.session.role = u.role;
      res.json({ user: { id: u.id, email: u.email, name, role: u.role } });
    });
  } catch (err) {
    console.error('Demo-Tor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
