#!/usr/bin/env node
/**
 * Prüfungen für die Hausschreibweise (`findHouseTermMatches`).
 *
 *   npm run build:server && node scripts/house-terms.test.mjs
 *
 * Geprüft wird die reine Suchfunktion ohne Datenbank. Jede Regel hat einen
 * Positiv- UND einen Negativfall: eine Suche, die nichts findet, sieht genauso
 * aus wie eine Suche, die richtig nichts findet.
 */
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// config.ts bricht ohne DB_PASSWORD ab; die Suchfunktion selbst braucht keine DB
if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'PLATZHALTER_NUR_FUER_DEN_IMPORT';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE = join(__dirname, '..', 'dist', 'services', 'house-terms.js');
if (!existsSync(MODULE)) {
  console.error(`Fehlt: ${MODULE} — vorher npm run build:server`);
  process.exit(1);
}
const { findHouseTermMatches, effectiveHouseTerms } = await import(pathToFileURL(MODULE).href);

// Die Suchfälle liegen in house-terms.cases.json — dieselbe Datei prüft der
// Python-Port im Chat-Werkzeug der KI-Stationen (Cockpit #1247).
const CASES = JSON.parse(readFileSync(join(__dirname, 'house-terms.cases.json'), 'utf-8'));
const TERMS = CASES.terms;

let failed = 0;
for (const c of CASES.cases) {
  const text = c.text;
  const got = findHouseTermMatches(text, c.terms ?? TERMS).map((m) => [
    text.slice(m.offset, m.offset + m.length),
    m.replacements[0].value,
  ]);
  const ok = JSON.stringify(got) === JSON.stringify(c.expected);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.name}`);
  if (!ok) console.log(`     erwartet ${JSON.stringify(c.expected)}\n     erhalten ${JSON.stringify(got)}`);
}
if (CASES.cases.length < 10) {
  failed++;
  console.log(`FAIL nur ${CASES.cases.length} Suchfälle geladen — Datei unvollständig?`);
}

const withNote = findHouseTermMatches('Lichtband', TERMS)[0];
const noteOk = withNote?.message.includes('Laut Marketing 2026.') && withNote.rule.category.id === 'HAUSSCHREIBWEISE';
if (!noteOk) failed++;
console.log(`${noteOk ? 'OK  ' : 'FAIL'} Hinweis und Kategorie im Treffer`);

// „Bleibt beim Standard": derselbe Begriff in beiden Standard-Feldern, nur ein
// Channel weicht ab. Nicht in house-terms.cases.json, weil das Auflösen in
// loadHouseTerms passiert — der Chat bekommt die Liste schon gefiltert.
const bleibt = (preferredTerm) => [
  { avoidTerm: 'LED-Trafo', preferredTerm, note: null },
  { avoidTerm: 'LED-Treiber', preferredTerm: 'LED-Trafo', note: null },
];
const checks = [
  ['bleibt: Standard ohne Treffer, andere Einträge bleiben',
    findHouseTermMatches('Der LED-Trafo und der LED-Treiber', effectiveHouseTerms(bleibt('led-trafo'))).map((m) => m.replacements[0].value),
    ['LED-Trafo']],
  ['bleibt: Channel-Begriff ersetzt den Standard-Begriff',
    findHouseTermMatches('Der LED-Trafo', effectiveHouseTerms(bleibt('Netzteil'))).map((m) => m.replacements[0].value),
    ['Netzteil']],
  ['bleibt: Filter nimmt gleiche Begriffe heraus (Groß-/Kleinschreibung egal), verschiedene nicht',
    [effectiveHouseTerms(bleibt('led-trafo')).length, effectiveHouseTerms(bleibt('Netzteil')).length],
    [1, 2]],
];
for (const [name, got, expected] of checks) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) console.log(`     erwartet ${JSON.stringify(expected)}\n     erhalten ${JSON.stringify(got)}`);
}

console.log(failed ? `\n${failed} fehlgeschlagen` : '\nAlle Prüfungen grün');
process.exit(failed ? 1 : 0);
