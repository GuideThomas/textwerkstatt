/**
 * Wächter Thema (PLAN-oeffentlich-und-demo.md Phase 3): Jede Variable `--pal-*`, `--login-*`, `--schrift-*`, die die
 * Oberfläche liest (client/src/**), muss jedes Thema unter client/themes/<name>/thema.css setzen. Fehlt sie, fällt die
 * Farbe lautlos auf den Browser-Standard — kein Build-Fehler, kein Hinweis. Dazu: jedes Thema hat alle vier Teile.
 *
 * Selbsttest vorweg: eine erfundene Variable muss als fehlend erkannt werden, eine gesetzte nicht.
 * Aufruf: node scripts/oeffentlich/thema.test.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLIENT = join(WURZEL, 'client');
const THEMEN = join(CLIENT, 'themes');
const MUSTER = /var\((--(?:pal|login|schrift)-[a-z0-9-]+)\)/g;
const TEILE = ['index.tsx', 'thema.css', 'tailwind.json', 'public/favicon.svg'];

function dateien(ordner, aus = []) {
  for (const n of readdirSync(ordner)) {
    const p = join(ordner, n);
    if (statSync(p).isDirectory()) dateien(p, aus);
    else if (/\.(tsx?|css)$/.test(n)) aus.push(p);
  }
  return aus;
}

const gelesen = new Map(); // Variable → erste Fundstelle
for (const datei of dateien(join(CLIENT, 'src'))) {
  for (const m of readFileSync(datei, 'utf8').matchAll(MUSTER)) {
    if (!gelesen.has(m[1])) gelesen.set(m[1], relative(WURZEL, datei));
  }
}

const gesetzt = (css) => new Set([...css.matchAll(/(--(?:pal|login|schrift)-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const fehlend = (css, namen) => namen.filter((n) => !gesetzt(css).has(n));

// Selbsttest
const probe = ':root { --pal-da: #fff; }';
if (fehlend(probe, ['--pal-da']).length !== 0 || fehlend(probe, ['--pal-erfunden']).length !== 1 || gelesen.size < 10) {
  console.error(`Selbsttest gescheitert (gelesene Variablen: ${gelesen.size})`);
  process.exit(1);
}

const rot = [];
const themen = readdirSync(THEMEN).filter((n) => statSync(join(THEMEN, n)).isDirectory());
if (!themen.includes('atelier')) rot.push('Thema atelier fehlt (Vorgabe in client/thema.config.js)');
for (const name of themen) {
  for (const teil of TEILE) if (!existsSync(join(THEMEN, name, teil))) rot.push(`${name}: ${teil} fehlt`);
  const css = existsSync(join(THEMEN, name, 'thema.css')) ? readFileSync(join(THEMEN, name, 'thema.css'), 'utf8') : '';
  for (const n of fehlend(css, [...gelesen.keys()])) rot.push(`${name}: ${n} nicht gesetzt (gelesen in ${gelesen.get(n)})`);
}

console.log(`Wächter Thema: ${gelesen.size} Variablen, Themen ${themen.join(', ')}, Selbsttest ok`);
if (rot.length) {
  console.error(`ROT: ${rot.length}\n  ${rot.join('\n  ')}`);
  process.exit(1);
}
console.log('grün');
