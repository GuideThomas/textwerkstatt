#!/usr/bin/env node
/**
 * Prüfungen für die Wortliste Phase 5: die Schreibwege der Glossarseite (Plan `PLAN-wortliste.md` §2.7, Cockpit #1833).
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank; DeepL wird nicht aufgerufen:
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-wortliste-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:55441:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=55441 DB_NAME=translationtool_test DB_USER=translationtool node scripts/wortliste-pflege.test.mjs
 *
 * Belegt je Weg durch die echte Route: was geschrieben wird, dass es mit dem Namen der angemeldeten Person im Verlauf steht, was
 * die Namensfassung zählt und was die Glossarversion (nur `an_deepl` an einer freigegebenen Zeile). Dazu: „Seite freigeben“ lässt
 * Zeilen mit Rückfrage aus, Ablehnen hinterlässt die Spur, und die Gegenprobe ohne Trigger zeigt, dass die Rückfrage-Prüfung den
 * Verlauf wirklich sieht.
 *
 * 🚨 Der Lauf löscht das Schema `public`. Deshalb bricht er ab, wenn die Datenbank nicht auf `_test` endet oder nicht lokal
 * liegt, und zwar vor dem ersten Datenbankzugriff.
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

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('routes', 'wortliste-pflege.js'))) {
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
const TESTSEED = readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8');
await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) await q(readFileSync(join(MIGRATIONEN, f), 'utf-8')); await q(TESTSEED);

const PERSON = { id: 'a1b2c3d4-0000-4000-8000-000000000005', display_name: 'Prüferin Glossarseite', email: 'g@example.invalid' };
await q(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [PERSON.id, PERSON.email, PERSON.display_name]);
const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { ...PERSON, role: 'admin' }; next(); }); // Der direkte Weg ist seit 12.11.2026 der der Admins (PLAN-glossar-freigabe.md).
app.use('/api/glossaries', await router('routes', 'glossaries.js'));
app.use('/api/glossaries', await router('routes', 'wortliste-pflege.js'));
const server = app.listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const BASIS = `http://127.0.0.1:${server.address().port}`;
const api = async (methode, pfad, body) => {
  const r = await fetch(BASIS + pfad, { method: methode, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, body: json ?? text };
};

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

const FR = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ('Glossar DE→FR', 'DE', 'FR') RETURNING id`)).rows[0].id;
await q(
  `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES
     ($1, 'Abdeckung', 'diffuseur', TRUE), ($1, 'Endkappe', 'embout', FALSE), ($1, 'Clip', 'clip', FALSE),
     ($1, 'Rolle', 'rouleau', TRUE), ($1, 'Stecker', 'fiche', FALSE), ($1, 'Halter', 'support', TRUE)`, [FR]);
const id = async (begriff) => (await q(`SELECT id FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0]?.id;
const zeile = async (begriff) => (await q(`SELECT * FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0];
const version = async () => (await q(`SELECT version FROM glossaries WHERE id = $1`, [FR])).rows[0].version;
const fassung = async () => (await q(`SELECT COALESCE(max(nummer), 0)::int AS n FROM namens_bausteine_fassung WHERE sprache = 'FR'`)).rows[0].n;
const marke = async () => (await q(`SELECT count(*)::int AS n FROM glossary_entry_history`)).rows[0];
const neueEintraege = async (m) => (await q(
  `SELECT source_term, field, action, old_value, new_value, changed_by, changed_by_name
     FROM glossary_entry_history ORDER BY changed_at, field OFFSET $1`, [m.n],
)).rows;
const vonPerson = (e) => e.changed_by === PERSON.id && e.changed_by_name === PERSON.display_name;
const felder = (eintraege) => eintraege.map((e) => e.field).sort();
const pfad = async (begriff, rest = '') => `/api/glossaries/${FR}/entries/${await id(begriff)}${rest}`;

console.log('Wortliste Phase 5: Schreibwege der Glossarseite (PLAN-wortliste.md §2.7, Cockpit #1833)');

await pruefe('Art, Wortart, Genus, ziel_name: geschrieben, je Feld ein Verlaufseintrag mit Namen, Fassung +1, DeepL unberührt', async () => {
  const [v0, f0, m] = [await version(), await fassung(), await marke()];
  const r = await api('PUT', await pfad('Abdeckung', '/wortliste'), { art: 'wendung', wortart: 'hauptwort', genus: 'm', ziel_name: 'diffuseur alu' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const z = await zeile('Abdeckung');
  assert.deepEqual([z.art, z.wortart, z.genus, z.ziel_name], ['wendung', 'hauptwort', 'm', 'diffuseur alu']);
  const e = await neueEintraege(m);
  assert.deepEqual(felder(e), ['art', 'genus', 'wortart', 'ziel_name']);
  assert.ok(e.every(vonPerson), JSON.stringify(e));
  assert.equal(await fassung(), f0 + 1, 'eine Transaktion, eine Fassung');
  assert.equal(await version(), v0, 'nichts davon geht an DeepL');
});

await pruefe('an_deepl an einer freigegebenen Zeile: Glossarversion +1, Verlauf ja → nein', async () => {
  const [v0, m] = [await version(), await marke()];
  const r = await api('PUT', await pfad('Rolle', '/wortliste'), { an_deepl: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await version(), v0 + 1);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.old_value, x.new_value]), [['an_deepl', 'ja', 'nein']]);
  assert.ok(e.every(vonPerson));
  const anDeepl = (await q(`SELECT count(*)::int AS n FROM glossar_an_deepl WHERE glossary_id = $1 AND source_term = 'Rolle'`, [FR])).rows[0].n;
  assert.equal(anDeepl, 0, 'die Sicht für DeepL kennt die Zeile nicht mehr');
});

await pruefe('an_deepl an einer offenen Zeile: Glossarversion bleibt (offen geht ohnehin nicht an DeepL)', async () => {
  const v0 = await version();
  assert.equal((await api('PUT', await pfad('Clip', '/wortliste'), { an_deepl: false })).status, 200);
  assert.equal(await version(), v0);
});

await pruefe('Muster: geht nie an DeepL, ausdrücklich verlangt ist es ein Fehler', async () => {
  assert.equal((await api('PUT', await pfad('Halter', '/wortliste'), { art: 'muster', an_deepl: true })).status, 400);
  const r = await api('PUT', await pfad('Halter', '/wortliste'), { art: 'muster' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const z = await zeile('Halter');
  assert.deepEqual([z.art, z.an_deepl], ['muster', false]);
});

await pruefe('Wortart Adjektiv: Genus fällt weg, Formen werden gespeichert; unbekannte Form ist ein Fehler', async () => {
  assert.equal((await api('PUT', await pfad('Abdeckung', '/wortliste'), { wortart: 'adjektiv', formen: { x: 'a' } })).status, 400);
  const r = await api('PUT', await pfad('Abdeckung', '/wortliste'), { wortart: 'adjektiv', formen: { m: 'noir', f: 'noire' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const z = await zeile('Abdeckung');
  assert.equal(z.genus, null);
  assert.deepEqual(z.formen, { m: 'noir', f: 'noire' });
  assert.equal((await api('PUT', await pfad('Abdeckung', '/wortliste'), { art: 'unsinn' })).status, 400);
});

await pruefe('Gruppenziel: anlegen, ändern, entfernen, je Schritt im Verlauf mit Namen; die Liste liefert es mit', async () => {
  const m = await marke();
  assert.equal((await api('PUT', await pfad('Abdeckung', '/gruppen/16'), { target_term: 'collerette' })).status, 200);
  assert.equal((await api('PUT', await pfad('Abdeckung', '/gruppen/16'), { target_term: 'collerette ronde' })).status, 200);
  const liste = await api('GET', `/api/glossaries/${FR}/entries?search=Abdeckung`);
  const g = liste.body.entries.find((x) => x.source_term === 'Abdeckung').gruppen;
  assert.deepEqual(g, [{ produktgruppe: 16, target_term: 'collerette ronde', genus: null }]);
  assert.equal((await api('DELETE', await pfad('Abdeckung', '/gruppen/16'))).status, 200);
  assert.equal((await api('DELETE', await pfad('Abdeckung', '/gruppen/16'))).status, 404);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action]), [['gruppe:16', 'created'], ['gruppe:16', 'updated'], ['gruppe:16', 'deleted']]);
  assert.ok(e.every(vonPerson), JSON.stringify(e));
  assert.equal((await api('PUT', await pfad('Abdeckung', '/gruppen/x1'), { target_term: 'a' })).status, 400);
  assert.equal((await api('PUT', await pfad('Abdeckung', '/gruppen/16'), { target_term: '  ' })).status, 400);
});

await pruefe('Rückfrage: stellen und lösen mit Namen im Verlauf; Filter findet sie; an einer freigegebenen Zeile 409', async () => {
  const m = await marke();
  assert.equal((await api('PUT', await pfad('Endkappe', '/rueckfrage'), { text: 'embout oder capuchon?' })).status, 200);
  const gefiltert = await api('GET', `/api/glossaries/${FR}/entries?rueckfrage=1`);
  assert.deepEqual(gefiltert.body.entries.map((x) => x.source_term), ['Endkappe']);
  assert.equal(gefiltert.body.entries[0].vorschlag.rueckfrage, 'embout oder capuchon?');
  assert.equal(gefiltert.body.stats.rueckfragen, 1);
  assert.equal((await api('PUT', await pfad('Abdeckung', '/rueckfrage'), { text: 'warum?' })).status, 409);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action, x.new_value]), [['rueckfrage', 'created', 'embout oder capuchon?']]);
  assert.ok(e.every(vonPerson), JSON.stringify(e));
  const zielVorher = (await zeile('Endkappe')).target_term;
  assert.equal(zielVorher, 'embout', 'die neue Herkunftszeile ohne Vorschläge lässt das Ziel stehen');
});

await pruefe('„Seite freigeben“ lässt die Zeile mit Rückfrage aus und gibt die anderen offenen frei', async () => {
  const r = await api('POST', `/api/glossaries/${FR}/entries/bulk-approve`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await zeile('Endkappe')).approved, false, 'die Rückfrage hält die Zeile offen');
  assert.equal((await zeile('Clip')).approved, true);
  assert.equal((await zeile('Stecker')).approved, true);
});

await pruefe('Rückfrage lösen: Verlauf „deleted“, danach gibt „Seite freigeben“ die Zeile frei', async () => {
  const m = await marke();
  assert.equal((await api('PUT', await pfad('Endkappe', '/rueckfrage'), { text: '' })).status, 200);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action, x.old_value]), [['rueckfrage', 'deleted', 'embout oder capuchon?']]);
  assert.equal((await api('POST', `/api/glossaries/${FR}/entries/bulk-approve`, {})).body.approved, 1);
  assert.equal((await zeile('Endkappe')).approved, true);
});

await pruefe('Ablehnen: Zeile weg, Spur in wortliste_abgelehnt mit Namen, Verlauf mit Namen; Freigegebenes 409', async () => {
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Kappe', 'capot', FALSE)`, [FR]);
  assert.equal((await api('POST', await pfad('Abdeckung', '/ablehnen'), {})).status, 409);
  const m = await marke();
  const r = await api('POST', await pfad('Kappe', '/ablehnen'), { anmerkung: 'gibt es nicht' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await id('Kappe'), undefined);
  const spur = (await q(`SELECT source_term, ziel, anmerkung, von FROM wortliste_abgelehnt WHERE glossary_id = $1`, [FR])).rows;
  assert.deepEqual(spur, [{ source_term: 'Kappe', ziel: 'capot', anmerkung: 'gibt es nicht', von: PERSON.display_name }]);
  const e = await neueEintraege(m);
  assert.ok(e.length > 0 && e.every(vonPerson), JSON.stringify(e));
  assert.ok(e.some((x) => x.field === 'standard' && x.action === 'deleted'));
});

await pruefe('Gegenprobe: ohne den Trigger aus 039 steht die Rückfrage in keinem Verlauf, die Prüfung oben sähe es', async () => {
  await q(`DROP TRIGGER trg_wortliste_verlauf_rueckfrage ON wortliste_vorschlag`);
  try {
    await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Profil', 'profilé', FALSE)`, [FR]);
    const m = await marke();
    assert.equal((await api('PUT', await pfad('Profil', '/rueckfrage'), { text: 'profil oder profilé?' })).status, 200);
    assert.deepEqual(await neueEintraege(m), []);
  } finally {
    await q(readFileSync(join(MIGRATIONEN, '039_wortliste_rueckfrage_verlauf.sql'), 'utf-8'));
  }
});

server.close();
await pool.end();
console.log(`\n${ok} grün, ${fehler.length} rot`);
process.exit(fehler.length ? 1 : 0);
