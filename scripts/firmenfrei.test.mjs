#!/usr/bin/env node
/**
 * Wächter für das öffentliche Repo: In keiner Datei der Positivliste darf ein Firmen- oder Channelname stehen
 * (Plan `PLAN-oeffentlich-und-demo.md` §4 Phase 1, §8).
 *
 * Aufruf: node scripts/firmenfrei.test.mjs        (Exit 1 bei einem Treffer oder wenn der Selbsttest scheitert)
 *
 * Das Muster steht in scripts/oeffentlich/firmennamen.mjs (Namen als Bausteine, Kürzel mit Wortgrenzen).
 * Vor jedem Lauf prüft er sich gegen eine Positiv- und eine Negativprobe; schlägt eine fehl, ist der Lauf rot,
 * statt still nichts zu finden.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUSTER, BINAER, selbsttest } from './oeffentlich/firmennamen.mjs';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const liste = JSON.parse(readFileSync(join(WURZEL, 'scripts', 'oeffentlich', 'positivliste.json'), 'utf-8'));

// Muster, Selbsttest und Binär-Endungen teilt der Wächter mit dem Export (scripts/oeffentlich/firmennamen.mjs).
const selbst = selbsttest();
if (selbst.length) {
  console.error('Selbsttest des Wächters gescheitert:\n  ' + selbst.join('\n  '));
  process.exit(1);
}

const istAusgelassen = (rel) => liste.auslassen.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));

function sammle(rel, aus) {
  const pfad = join(WURZEL, rel);
  if (!existsSync(pfad)) return;
  if (statSync(pfad).isDirectory()) {
    for (const n of readdirSync(pfad)) {
      if (n === 'node_modules' || n === 'dist') continue;
      sammle(relative(WURZEL, join(pfad, n)).replace(/\\/g, '/'), aus);
    }
  } else if (!istAusgelassen(rel) && !BINAER.test(rel)) {
    aus.push(rel);
  }
}

const dateien = [];
for (const eintrag of liste.aufnehmen) sammle(eintrag.replace(/\/$/, ''), dateien);
const fehlend = liste.aufnehmen.filter((e) => !existsSync(join(WURZEL, e.replace(/\/$/, ''))));

const offen = new Set(liste.offen_bis_phase_3 || []);
const rot = [];
const gemeldet = [];
for (const rel of dateien) {
  const zeilen = readFileSync(join(WURZEL, rel), 'utf-8').split(/\r?\n/);
  zeilen.forEach((z, i) => {
    if (MUSTER.test(z)) (offen.has(rel) ? gemeldet : rot).push(`${rel}:${i + 1}: ${z.trim().slice(0, 120)}`);
  });
}

console.log(`Wächter firmenfrei: ${dateien.length} Dateien geprüft, Selbsttest ok`);
if (fehlend.length) console.log(`  Hinweis: in der Positivliste, aber nicht vorhanden: ${fehlend.join(', ')}`);
if (gemeldet.length) console.log(`  offen bis Phase 3 (nicht rot): ${gemeldet.length} Zeilen in ${new Set(gemeldet.map((g) => g.split(':')[0])).size} Dateien`);
if (rot.length) {
  console.error(`ROT: ${rot.length} Treffer\n  ` + rot.join('\n  '));
  process.exit(1);
}
console.log('grün: keine Treffer');
