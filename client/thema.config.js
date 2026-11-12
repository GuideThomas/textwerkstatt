/**
 * Welches Erscheinungsbild gebaut wird (PLAN-oeffentlich-und-demo.md, Phase 3).
 *
 * Ein Thema ist ein Ordner unter `client/themes/<name>/` mit vier Teilen:
 *   index.tsx      Logo, Kopfzeile, Seitenkopf, Footer, Hintergrund (Vertrag: src/thema/typ.ts)
 *   thema.css      CSS-Variablen `--pal-*`, Schriften und die Abweichungen des Themas
 *   tailwind.json  Farben und Schriften als `theme.extend` für Tailwind
 *   public/        Favicon, Logos, Schriftdateien — wird zu `client/dist/`
 *
 * Gewählt beim Build mit `THEMA=<name>`. Ohne Angabe gilt `atelier`, das Thema des öffentlichen Repos.
 * Ein Name ohne Ordner bricht den Build ab, statt still auf ein anderes Thema auszuweichen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = path.dirname(fileURLToPath(import.meta.url));
export const THEMEN_ORDNER = path.join(hier, 'themes');
export const VORGABE = 'atelier';

export function themaName() {
  const roh = (process.env.THEMA ?? '').trim();
  const name = roh === '' ? VORGABE : roh;
  const vorhanden = fs.existsSync(THEMEN_ORDNER)
    ? fs.readdirSync(THEMEN_ORDNER).filter((n) => fs.existsSync(path.join(THEMEN_ORDNER, n, 'index.tsx')))
    : [];
  if (!/^[a-z0-9-]+$/.test(name) || !vorhanden.includes(name)) {
    throw new Error(`THEMA="${roh}" gibt es nicht. Vorhanden: ${vorhanden.join(', ') || '(keines)'}`);
  }
  return name;
}

export function themaOrdner() {
  return path.join(THEMEN_ORDNER, themaName());
}

/** `theme.extend` des Themas für Tailwind. Schlüssel mit `_` vorn sind Vermerke und gehen nicht an Tailwind. */
export function themaTailwind() {
  const roh = JSON.parse(fs.readFileSync(path.join(themaOrdner(), 'tailwind.json'), 'utf8'));
  return Object.fromEntries(Object.entries(roh).filter(([k]) => !k.startsWith('_')));
}

/** Zeilen, die das Thema in den `<head>` von index.html setzt (`kopf.html`, darf fehlen). */
export function themaKopf() {
  const datei = path.join(themaOrdner(), 'kopf.html');
  return fs.existsSync(datei) ? fs.readFileSync(datei, 'utf8').trim() : '';
}
