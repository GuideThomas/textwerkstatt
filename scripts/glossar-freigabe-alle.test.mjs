#!/usr/bin/env node
/**
 * Prüfungen für `GLOSSAR_FREIGABE=alle` (Demo): jede angemeldete Person schreibt direkt wie ein Admin, löscht aber nur Einträge,
 * die eine Person angelegt hat, nie die aus einem Seed (`PLAN-oeffentlich-und-demo.md` Phase 2, Entscheid Thomas E4).
 *
 * Die Gegenstellung (`admin`, fehlend, unbekannt) prüft `scripts/glossar-freigabe.test.mjs`; beide zusammen belegen den Schalter.
 * Aufruf wie dort, gegen eine Wegwerf-Postgres; dieses Skript setzt `GLOSSAR_FREIGABE=alle` selbst:
 *
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=<port> DB_NAME=translationtool_test DB_USER=translationtool node scripts/glossar-freigabe-alle.test.mjs
 *
 * 🚨 Der Lauf löscht das Schema `public`. Deshalb bricht er ab, wenn die Datenbank nicht auf `_test` endet oder nicht lokal liegt.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const istLokal = ['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '');
if (!process.env.DB_PASSWORD || !istLokal || !(process.env.DB_NAME ?? '').endsWith('_test')) {
  console.error('Abbruch: nur gegen eine lokale Datenbank mit Namen *_test und mit DB_PASSWORD aus der Umgebung, siehe Kopfkommentar.');
  process.exit(2);
}
process.env.DEEPL_API_KEY = '';
process.env.TRANSLATION_SERVICE_KEY = '';
process.env.GLOSSAR_FREIGABE = 'alle';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('middleware', 'glossar-recht.js'))) {
  console.error('dist fehlt oder ist alt: zuerst npm run build:server');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};
const router = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.default ?? m.default;
};

const { pool } = await laden('db', 'connection.js');
const { config, glossarFreigabe } = await laden('config.js');
const q = (sql, p) => pool.query(sql, p);

const db = (await q('SELECT current_database() AS n')).rows[0].n;
assert.ok(db.endsWith('_test'), 'falsche Datenbank');
const fremde = (await q(
  `SELECT count(*)::int AS n FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', current_database())`,
)).rows[0].n;
if (fremde > 0) {
  console.error(`Abbruch: Der Server hat ${fremde} weitere Datenbank(en), das ist kein eigener Wegwerf-Server.`);
  process.exit(2);
}

const MIGRATIONEN = join(WURZEL, 'migrations');
await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) await q(readFileSync(join(MIGRATIONEN, f), 'utf-8'));
await q(readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8'));

const ADMIN = { id: 'a1b2c3d4-0000-4000-8000-0000000000a1', display_name: 'Admin Probe', email: 'admin@example.invalid', role: 'admin' };
const NUTZER = { id: 'a1b2c3d4-0000-4000-8000-0000000000b2', display_name: 'Tester Probe', email: 'tester@example.invalid', role: 'user' };
for (const u of [ADMIN, NUTZER]) {
  await q(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, $4)`, [u.id, u.email, u.display_name, u.role]);
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { ...(req.header('x-rolle') === 'admin' ? ADMIN : NUTZER) };
  next();
});
app.use('/api/glossaries', await router('routes', 'glossaries.js'));
app.use('/api/glossaries', await router('routes', 'wortliste-pflege.js'));
app.use('/api/glossaries', await router('routes', 'glossar-vorschlaege.js'));
app.use('/api/projects', await router('routes', 'review.js'));
app.use('/api/terminology-scan', await router('routes', 'terminology-scan.js'));
const server = app.listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const BASIS = `http://127.0.0.1:${server.address().port}`;
const api = async (methode, pfad, body, rolle = 'user') => {
  const r = await fetch(BASIS + pfad, {
    method: methode,
    headers: { 'content-type': 'application/json', 'x-rolle': rolle },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, body: json ?? text };
};
const alsAdmin = (methode, pfad, body) => api(methode, pfad, body, 'admin');

let ok = 0;
const fehler = [];
async function pruefe(name, f) {
  try {
    await f();
    ok += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fehler.push(name);
    console.log(`  ✗ ${name}\n    ${String(err?.message ?? err).split('\n').join('\n    ')}`);
  }
}

// Das Beispiel-Glossar: direkt per SQL angelegt wie ein Seed, also ohne Bearbeiter.
const FR = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ('Glossar DE→FR', 'DE', 'FR') RETURNING id`)).rows[0].id;
await q(
  `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES
     ($1, 'Abdeckung', 'diffuseur', TRUE), ($1, 'Endkappe', 'embout', FALSE), ($1, 'Rolle', 'rouleau', TRUE),
     ($1, 'Kappe', 'capot', FALSE)`, [FR]);
const id = async (begriff) => (await q(`SELECT id FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0]?.id;
const zeile = async (begriff) => (await q(`SELECT * FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0];
const pfad = async (begriff, rest = '') => `/api/glossaries/${FR}/entries/${await id(begriff)}${rest}`;
const deepl = async (begriff) => (await q(`SELECT target_term FROM glossar_an_deepl WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0]?.target_term;
const namen = async (begriff) => (await q(`SELECT * FROM wortliste_freigegeben WHERE sprache = 'FR' AND deutsch = $1`, [begriff])).rows[0];
const vorschlaege = async () => (await q(`SELECT count(*)::int AS n FROM glossar_vorschlag`)).rows[0].n;
const anzahl = async () => (await q(`SELECT count(*)::int AS n FROM glossary_entries`)).rows[0].n;

/** Ein Nicht-Admin-Aufruf, der direkt wirken muss: kein Vorschlag entsteht. */
async function direkt(methode, p, body, erwartet = [200, 201]) {
  const v0 = await vorschlaege();
  const r = await api(methode, p, body);
  assert.ok(erwartet.includes(r.status), `${methode} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  assert.notEqual(r.body?.vorschlag, true, 'es entstand ein Vorschlag statt der Wirkung');
  assert.equal(await vorschlaege(), v0, 'es entstand ein Vorschlag statt der Wirkung');
  return r;
}

console.log('Glossar-Freigabe „alle“: jede angemeldete Person schreibt direkt, löscht nur Angelegtes (PLAN-oeffentlich-und-demo.md Phase 2)');

await pruefe('Schalter: nur das Wort „alle“ öffnet; leer, fehlend, „admin“, „ja“, „alles“, „true“ bleiben „admin“', async () => {
  assert.equal(config.glossarFreigabe, 'alle');
  for (const w of ['alle', 'ALLE', ' Alle ']) assert.equal(glossarFreigabe(w), 'alle', w);
  for (const w of [undefined, '', ' ', 'admin', 'ja', 'alles', 'true', '1', 'all']) assert.equal(glossarFreigabe(w), 'admin', String(w));
});

await pruefe('Seed-Einträge tragen kein angelegt_von; ein mitgeschickter Wert wird vom Trigger überschrieben', async () => {
  assert.equal((await zeile('Rolle')).angelegt_von, null);
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, angelegt_von) VALUES ($1, 'Fälschung', 'faux', TRUE, $2)`,
    [FR, NUTZER.id]);
  assert.equal((await zeile('Fälschung')).angelegt_von, null, 'angelegt_von ließ sich ohne Bearbeiter setzen');
  const r = await api('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Vortäuschung', target_term: 'leurre', angelegt_von: ADMIN.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await zeile('Vortäuschung')).angelegt_von, NUTZER.id, 'der Bearbeiter zählt, nicht der Wert aus der Anfrage');
});

await pruefe('Glossarseite: neuer Begriff wirkt sofort (DeepL, Namen), angelegt_von nennt die Person', async () => {
  await direkt('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Lichtleiste', target_term: 'réglette' });
  const z = await zeile('Lichtleiste');
  assert.deepEqual([z.target_term, z.approved, z.angelegt_von], ['réglette', true, NUTZER.id]);
  assert.equal(await deepl('Lichtleiste'), 'réglette');
  assert.ok(await namen('Lichtleiste'));
});

await pruefe('Glossarseite: Ziel ändern, Freigabe-Haken, Channel-Wert setzen und entfernen wirken sofort', async () => {
  await direkt('PUT', await pfad('Abdeckung'), { target_term: 'diffuseur opale' });
  assert.equal(await deepl('Abdeckung'), 'diffuseur opale');
  await direkt('PUT', await pfad('Endkappe'), { approved: true });
  assert.equal((await zeile('Endkappe')).approved, true);
  await direkt('PUT', await pfad('Abdeckung', '/channels/SHOPB'), { target_term: 'diffuseur S' });
  assert.equal((await namen('Abdeckung')).kanaele.SHOPB, 'diffuseur S');
  await direkt('DELETE', await pfad('Abdeckung', '/channels/SHOPB'));
  assert.equal((await namen('Abdeckung')).kanaele.SHOPB, undefined);
});

await pruefe('Wortliste: an_deepl und Gruppenziel wirken sofort', async () => {
  await direkt('PUT', await pfad('Rolle', '/wortliste'), { an_deepl: false });
  assert.equal(await deepl('Rolle'), undefined);
  await direkt('PUT', await pfad('Rolle', '/gruppen/12'), { target_term: 'rouleau LED', genus: 'm' });
  assert.deepEqual((await namen('Rolle')).gruppen.map((g) => [g.produktgruppe, g.ziel]), [[12, 'rouleau LED']]);
});

await pruefe('Sammelfreigabe, Hinweis verwerfen und Glossar anlegen stehen offen; ein ganzes Glossar löschen nicht', async () => {
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Stecker', 'fiche', FALSE)`, [FR]);
  const s = await direkt('POST', `/api/glossaries/${FR}/entries/bulk-approve`, {});
  assert.ok(s.body.approved >= 1, JSON.stringify(s.body));
  assert.equal(await deepl('Stecker'), 'fiche');
  // Unbekannter Hinweis: 404 aus der Route heißt, das Recht hat durchgelassen (bei „admin“ wäre es 403).
  const h = await api('POST', `/api/glossaries/${FR}/hinweise/00000000-0000-4000-8000-000000000000/verwerfen`);
  assert.equal(h.status, 404, JSON.stringify(h.body));
  const g = await direkt('POST', '/api/glossaries', { name: 'DE → ES', source_lang: 'DE', target_lang: 'ES' });
  assert.equal(g.status, 201);
  const n0 = await anzahl();
  const weg = await api('DELETE', `/api/glossaries/${FR}`);
  assert.equal(weg.status, 403, JSON.stringify(weg.body));
  assert.equal(await anzahl(), n0);
});

await pruefe('Löschen: Seed-Einträge 403 auf allen drei Wegen (Löschen, Entfernen, Ablehnen), Stand gleich; Admin darf (Gegenprobe)', async () => {
  const n0 = await anzahl();
  for (const [m, p, b] of [
    ['DELETE', await pfad('Rolle'), undefined],
    ['POST', await pfad('Rolle', '/entfernen'), { stand: 'rouleau' }],
    ['POST', await pfad('Kappe', '/ablehnen'), { anmerkung: 'nein' }],
  ]) {
    const r = await api(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'seed_eintrag');
  }
  assert.equal(await anzahl(), n0);
  assert.equal((await alsAdmin('DELETE', await pfad('Fälschung'))).status, 200);
  assert.equal(await id('Fälschung'), undefined);
});

await pruefe('Löschen: eigene Einträge auf allen drei Wegen; ein unbekannter Eintrag ist 404', async () => {
  await direkt('DELETE', await pfad('Lichtleiste'));
  assert.equal(await id('Lichtleiste'), undefined);
  assert.equal(await deepl('Lichtleiste'), undefined);
  await direkt('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Profil', target_term: 'profilé' });
  await direkt('POST', await pfad('Profil', '/entfernen'), { stand: 'profilé' });
  assert.equal(await id('Profil'), undefined);
  // Ablehnen braucht eine offene Zeile; offen wird sie hier über den Haken.
  await direkt('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Blende', target_term: 'cache' });
  await direkt('PUT', await pfad('Blende'), { approved: false });
  await direkt('POST', await pfad('Blende', '/ablehnen'), { anmerkung: 'Probe' });
  assert.equal(await id('Blende'), undefined);
  const r = await api('DELETE', `/api/glossaries/${FR}/entries/00000000-0000-4000-8000-000000000000`);
  assert.equal(r.status, 404);
});

await pruefe('Umbenennen löscht keine leere Seed-Zeile (Review 12.11.2026): beide Richtungen 403, Stand gleich; Admin darf', async () => {
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Leerzeile', NULL, FALSE)`, [FR]);
  await direkt('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Eigenwort', target_term: 'mot propre' });
  const n0 = await anzahl();
  // (a) eigener Eintrag auf den Begriff der leeren Seed-Zeile: die Seed-Zeile fiele weg.
  const a = await api('PUT', await pfad('Eigenwort'), { source_term: 'Leerzeile' });
  assert.deepEqual([a.status, a.body.code], [403, 'seed_eintrag'], JSON.stringify(a.body));
  // (b) die leere Seed-Zeile auf einen übersetzten Begriff: sie löschte sich selbst.
  const b = await api('PUT', await pfad('Leerzeile'), { source_term: 'Abdeckung' });
  assert.deepEqual([b.status, b.body.code], [403, 'seed_eintrag'], JSON.stringify(b.body));
  assert.equal(await anzahl(), n0);
  assert.ok(await id('Leerzeile'));
  assert.ok(await id('Eigenwort'));
  // Gegenprobe: ein Umbenennen ohne Löschen geht, und der Admin darf auch mit.
  await direkt('PUT', await pfad('Eigenwort'), { source_term: 'Eigenwörter' });
  assert.ok(await id('Eigenwörter'));
  assert.equal((await alsAdmin('PUT', await pfad('Eigenwörter'), { source_term: 'Leerzeile' })).status, 200);
  assert.equal(await anzahl(), n0 - 1);
});

await pruefe('Schnelleintrag, Review und Terminologie-Scan schreiben direkt, mit angelegt_von', async () => {
  await direkt('POST', '/api/glossaries/quickadd', { source_lang: 'DE', target_lang: 'FR', source_term: 'Schiene', target_term: 'rail' });
  assert.deepEqual([await deepl('Schiene'), (await zeile('Schiene')).angelegt_von], ['rail', NUTZER.id]);
  const PROJEKT = (await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('Probe', 'DE', 'FR', 'txt') RETURNING id`)).rows[0].id;
  await direkt('POST', `/api/projects/${PROJEKT}/terminology`, { source_term: 'Montageclip', target_term: 'clip de montage' });
  assert.equal((await zeile('Montageclip')).angelegt_von, NUTZER.id);
  const SCAN = (await q(`INSERT INTO terminology_scans (name, source_lang, target_lang, source_file_type, glossary_id) VALUES ('Probe', 'DE', 'FR', 'xlsx', $1) RETURNING id`, [FR])).rows[0].id;
  const k = (await q(
    `INSERT INTO terminology_candidates (scan_id, source_text, existing_translation, deepl_translation, source_term, existing_term, deepl_term, category, confidence)
     VALUES ($1, 'Gehäuse', 'boîtier', 'boîtier', 'Gehäuse', 'boîtier', 'boîtier', 'TERMINOLOGY', 0.9) RETURNING id`, [SCAN])).rows[0].id;
  const r = await direkt('POST', `/api/terminology-scan/${SCAN}/candidates/approve`, { ids: [k] });
  assert.equal(r.body.inserted, 1, JSON.stringify(r.body));
  assert.equal((await zeile('Gehäuse')).angelegt_von, NUTZER.id);
});

await pruefe('Gegenprobe: ohne Anmeldung prüfen beide Rechte selbst (401), auch bei „alle“', async () => {
  const { requireGlossarRecht, requireLoeschRecht } = await laden('middleware', 'glossar-recht.js');
  const antwort = () => { const r = { code: 0, status(c) { r.code = c; return r; }, json() { return r; } }; return r; };
  let weiter = false;
  const a = antwort();
  await requireGlossarRecht({ session: {} }, a, () => { weiter = true; });
  const b = antwort();
  await requireLoeschRecht({ session: {}, params: { id: FR, entryId: await id('Rolle') } }, b, () => { weiter = true; });
  assert.deepEqual([a.code, b.code, weiter], [401, 401, false]);
});

await pruefe('Am Ende: kein Vorschlag entstanden, und jede Wirkung des Testers steht unter seinem Namen im Verlauf', async () => {
  assert.equal(await vorschlaege(), 0);
  assert.ok((await q(`SELECT count(*)::int AS n FROM glossary_entry_history WHERE changed_by = $1`, [NUTZER.id])).rows[0].n > 0);
});

server.close();
await pool.end();
console.log(`\n${ok} grün, ${fehler.length} rot`);
process.exit(fehler.length ? 1 : 0);
