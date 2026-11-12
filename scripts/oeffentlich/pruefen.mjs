#!/usr/bin/env node
/**
 * Führt alle Prüfskripte aus (`scripts/*.test.mjs`, `scripts/oeffentlich/*.test.mjs`), eines nach dem anderen, und meldet
 * am Ende, welche rot waren. Exit 1, wenn eines rot ist oder keines gefunden wurde.
 *
 * Die meisten Prüfungen brauchen eine WEGWERF-Datenbank: Sie bauen ihr Schema per `DROP SCHEMA` neu. Deshalb nur mit
 * DB_HOST auf dem eigenen Rechner und einem Datenbanknamen auf `_test`; sonst bricht das Skript ab, bevor eines läuft.
 * Vorher `npm run build:server`, die Prüfungen laden ihre Module aus dist/.
 *
 *   docker run -d --rm --name tw-test -e POSTGRES_PASSWORD=<selbst erzeugt> -e POSTGRES_DB=textwerkstatt_test \
 *     -e POSTGRES_USER=textwerkstatt -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=textwerkstatt_test DB_USER=textwerkstatt DB_PASSWORD=<…> node scripts/oeffentlich/pruefen.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const istLokal = ['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '');
if (!process.env.DB_PASSWORD || !istLokal || !(process.env.DB_NAME ?? '').endsWith('_test')) {
  console.error('Nur gegen eine Wegwerf-Datenbank: DB_HOST lokal, DB_NAME auf _test, DB_PASSWORD gesetzt (Kopf dieser Datei).');
  process.exit(1);
}
if (!existsSync(join(WURZEL, 'dist', 'server.js'))) {
  console.error('dist/ fehlt: zuerst npm run build:server');
  process.exit(1);
}

const skripte = [
  ...readdirSync(join(WURZEL, 'scripts')).filter((n) => n.endsWith('.test.mjs')).map((n) => join('scripts', n)),
  ...readdirSync(join(WURZEL, 'scripts', 'oeffentlich')).filter((n) => n.endsWith('.test.mjs')).map((n) => join('scripts', 'oeffentlich', n)),
].sort();
if (skripte.length === 0) { console.error('keine Prüfskripte gefunden'); process.exit(1); }

const rot = [];
for (const s of skripte) {
  const r = spawnSync(process.execPath, [s], { cwd: WURZEL, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  const letzte = `${r.stdout}${r.stderr}`.trim().split(/\r?\n/).pop() ?? '';
  const gruen = r.status === 0;
  console.log(`${gruen ? 'grün' : 'ROT '}  ${s}  ${letzte.slice(0, 100)}`);
  if (!gruen) { rot.push(s); console.log(`${r.stdout}${r.stderr}`.split(/\r?\n/).slice(-40).map((z) => `      ${z}`).join('\n')); }
}
console.log(`\n${skripte.length - rot.length} von ${skripte.length} grün`);
if (rot.length) { console.error(`ROT: ${rot.join(', ')}`); process.exit(1); }
