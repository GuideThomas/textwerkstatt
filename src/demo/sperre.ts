/**
 * Was die Demo offen lässt (`PLAN-oeffentlich-und-demo.md` Phase 2): eine **Positivliste**. Jeder API-Weg, der hier nicht steht,
 * ist in der Demo 403 — auch einer, den es heute noch nicht gibt. So fällt ein neuer Weg nach zu, nicht nach offen (G4).
 *
 * Zu sind damit: Nutzerverwaltung, KI-Anbindung, Schutzregeln, Arten und Stilprofile bearbeiten, das Einlesen einer
 * Referenz-Homepage (E10), Microsoft-Anmeldung, die Anmeldung mit Passwort (nur das Tor führt hinein), Mail (Review anfordern,
 * Einladungen), Illustrator-Panel, Kosten-Übersicht und alle Maschinen-Routen. Offen bleibt, was ein Tester ausprobieren soll:
 * Projekte, Übersetzen, Glossar, Terminologie, Hausschreibweise, Prüfen und Optimieren.
 *
 * Nur Pfade unter `/api/` werden geprüft; die Oberfläche selbst liefert `express.static`. Express vergleicht Pfade ohne Rücksicht
 * auf Groß- und Kleinschreibung, die Liste hier nicht: `/API/cep` passt auf keine Zeile und ist damit zu.
 */
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';

type Methoden = 'alle' | 'lesen' | string[];

const OFFEN: [Methoden, RegExp][] = [
  [['POST'], /^\/api\/auth\/(demo|logout)$/],
  [['GET'], /^\/api\/auth\/me$/],
  [['GET'], /^\/api\/(health|einstellungen)$/],
  ['alle', /^\/api\/projects(\/|$)/],
  ['alle', /^\/api\/upload(\/|$)/],
  ['alle', /^\/api\/glossaries(\/|$)/],
  ['alle', /^\/api\/terminology-scan(\/|$)/],
  ['alle', /^\/api\/quick-translate(\/|$)/],
  [['POST'], /^\/api\/languagetool\/check$/],
  ['alle', /^\/api\/house-terms(\/|$)/],
  ['lesen', /^\/api\/terminology(\/|$)/],
  ['lesen', /^\/api\/topics(\/|$)/],
  [['GET'], /^\/api\/native-speakers$/],
  [['GET'], /^\/api\/users\/list$/],
  [['GET'], /^\/api\/textwerkstatt\/(ki-status|arten|stilprofile)$/],
  [['POST'], /^\/api\/textwerkstatt\/(vorschau|optimieren|optimieren\/kombination)$/],
];

/** Unterwege eines offenen Präfixes, die trotzdem zu bleiben: Verbrauch und Limit des DeepL-Kontos der Firma (Review 12.11.2026). */
const ZU: RegExp[] = [/^\/api\/glossaries\/deepl-usage$/];

const passt = (m: Methoden, methode: string) =>
  m === 'alle' || (m === 'lesen' ? methode === 'GET' || methode === 'HEAD' : m.includes(methode));

/** Steht dieser Aufruf auf der Liste? Für die Prüfskripte ausgelagert. */
export function demoOffen(methode: string, pfad: string): boolean {
  // `/API/…` ist für Express ein API-Weg: der Vergleich hier ohne Rücksicht auf die Schreibweise, die Liste unten mit.
  if (!pfad.toLowerCase().startsWith('/api')) return true;
  if (ZU.some((muster) => muster.test(pfad))) return false;
  return OFFEN.some(([m, muster]) => passt(m, methode.toUpperCase()) && muster.test(pfad));
}

export function demoSperre(req: Request, res: Response, next: NextFunction): void {
  if (!config.demo.an) return next();
  if (!demoOffen(req.method, req.path)) {
    res.status(403).json({ error: 'In der Demo nicht verfügbar', code: 'demo_gesperrt' });
    return;
  }
  next();
}
