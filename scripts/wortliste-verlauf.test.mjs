#!/usr/bin/env node
/**
 * Prüfungen für die Wortliste Phase 2: der Verlauf aus der Datenbank (Migration 037) und die Schreibwege, die sich nennen
 * (Plan `PLAN-wortliste.md` §2.6, Cockpit #1830).
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank; DeepL wird nicht aufgerufen:
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-wortliste-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:55441:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=55441 DB_NAME=translationtool_test DB_USER=translationtool node scripts/wortliste-verlauf.test.mjs
 *
 * Belegt je Schreibweg durch die echte Route: genau ein Verlaufseintrag je geändertem Feld, mit dem Namen der angemeldeten
 * Person, altem und neuem Wert. Dazu: ein Griff ohne Bearbeiter steht als `unbekannt` da, nie ohne Eintrag; mit Bearbeiter steht
 * auch die Nutzer-ID; und die Gegenprobe ohne Trigger zeigt, dass diese Prüfungen den Verlauf wirklich sehen.
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
if (!existsSync(dist('db', 'bearbeiter.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
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
const { alsBearbeiter } = await laden('db', 'bearbeiter.js');
const { wendeListeAn } = await laden('services', 'glossar-liste.js');
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
const migriere = async () => {
  for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) await q(readFileSync(join(MIGRATIONEN, f), 'utf-8')); await q(TESTSEED);
};
await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migriere();

const PERSON = { id: 'a1b2c3d4-0000-4000-8000-000000000001', display_name: 'Prüferin Wortliste', email: 'p@example.invalid' };
// Quickadd schreibt `created_by`, das auf `users` verweist: Die Person muss es geben.
await q(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [PERSON.id, PERSON.email, PERSON.display_name]);
const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { ...PERSON, role: 'admin' }; next(); }); // Der direkte Weg ist seit 12.11.2026 der der Admins (PLAN-glossar-freigabe.md).
app.use('/api/glossaries', await router('routes', 'glossaries.js'));
app.use('/api/projects', await router('routes', 'review.js'));
app.use('/api/terminology-scan', await router('routes', 'terminology-scan.js'));
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
/** Verlaufseinträge, die seit `seit` hinzugekommen sind, ohne Zeitstempel. */
const marke = async () => (await q(`SELECT COALESCE(max(changed_at), '-infinity') AS t, count(*)::int AS n FROM glossary_entry_history`)).rows[0];
const neueEintraege = async (m) => (await q(
  `SELECT source_term, field, action, old_value, new_value, changed_by, changed_by_name
     FROM glossary_entry_history ORDER BY changed_at, field OFFSET $1`, [m.n],
)).rows;
const vonPerson = (e) => e.changed_by === PERSON.id && e.changed_by_name === PERSON.display_name;
const eintragId = async (begriff) => (await q(`SELECT id FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0]?.id;

console.log('Wortliste Phase 2 (Verlauf aus der Datenbank)');

await pruefe('Plus: eine neue Zeile ergibt genau einen Eintrag „standard angelegt“ mit Person und Nutzer-ID', async () => {
  const m = await marke();
  const r = await api('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Flexband', target_term: 'ruban LED' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action, x.old_value, x.new_value]), [['standard', 'created', null, 'ruban LED']]);
  assert.ok(e.every(vonPerson), JSON.stringify(e));
});

await pruefe('Ziel ändern: genau ein Eintrag mit altem und neuem Wert', async () => {
  const id = await eintragId('Flexband');
  const m = await marke();
  assert.equal((await api('PUT', `/api/glossaries/${FR}/entries/${id}`, { target_term: 'bande LED' })).status, 200);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action, x.old_value, x.new_value]), [['standard', 'updated', 'ruban LED', 'bande LED']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Kontext und Kategorie ändern: je ein Eintrag (gab es bis 10.11. nicht)', async () => {
  const id = await eintragId('Flexband');
  const m = await marke();
  assert.equal((await api('PUT', `/api/glossaries/${FR}/entries/${id}`, { context: 'Band', category: 'produkt' })).status, 200);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.new_value]).sort(), [['kategorie', 'produkt'], ['kontext', 'Band']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Channel-Wert anlegen, ändern, gleich lassen, entfernen: je ein Eintrag, beim gleichen Wert keiner', async () => {
  const id = await eintragId('Flexband');
  const pfad = `/api/glossaries/${FR}/entries/${id}/channels/SHOPA`;
  let m = await marke();
  assert.equal((await api('PUT', pfad, { target_term: 'bande' })).status, 200);
  assert.deepEqual((await neueEintraege(m)).map((x) => [x.field, x.action, x.old_value, x.new_value]), [['SHOPA', 'created', null, 'bande']]);
  m = await marke();
  await api('PUT', pfad, { target_term: 'bandeau' });
  assert.deepEqual((await neueEintraege(m)).map((x) => [x.action, x.old_value, x.new_value]), [['updated', 'bande', 'bandeau']]);
  m = await marke();
  await api('PUT', pfad, { target_term: 'bandeau' });
  assert.equal((await neueEintraege(m)).length, 0);
  m = await marke();
  assert.equal((await api('DELETE', pfad)).status, 200);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action, x.old_value]), [['SHOPA', 'deleted', 'bandeau']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Umbenennen: ein Eintrag „begriff“', async () => {
  const id = await eintragId('Flexband');
  const m = await marke();
  assert.equal((await api('PUT', `/api/glossaries/${FR}/entries/${id}`, { source_term: 'LED-Flexband' })).status, 200);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.old_value, x.new_value]), [['begriff', 'Flexband', 'LED-Flexband']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Seite freigeben: je Zeile ein Eintrag „freigabe offen → freigegeben“', async () => {
  await alsBearbeiter({ id: null, name: 'Vorbereitung' }, (c) => c.query(
    `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Endkappe', 'embout', FALSE), ($1, 'Clip', 'clip', FALSE)`, [FR]));
  const m = await marke();
  const r = await api('POST', `/api/glossaries/${FR}/entries/bulk-approve`, {});
  assert.equal(r.body.approved, 2);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.source_term, x.field, x.old_value, x.new_value]).sort(),
    [['Clip', 'freigabe', 'offen', 'freigegeben'], ['Endkappe', 'freigabe', 'offen', 'freigegeben']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('×: Ziel und Channel-Wert stehen einzeln als „entfernt“, einmal, mit Person', async () => {
  const id = await eintragId('Endkappe');
  await api('PUT', `/api/glossaries/${FR}/entries/${id}/channels/SHOPB`, { target_term: 'capuchon' });
  const m = await marke();
  assert.equal((await api('DELETE', `/api/glossaries/${FR}/entries/${id}`)).status, 200);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action, x.old_value]).sort(), [['SHOPB', 'deleted', 'capuchon'], ['standard', 'deleted', 'embout']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Quickadd aus dem Review-Editor: Anlegen und Channel-Wert, je ein Eintrag', async () => {
  const m = await marke();
  const r = await api('POST', '/api/glossaries/quickadd', { source_term: 'Netzteil', target_term: 'alimentation', source_lang: 'DE', target_lang: 'FR', channel_code: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const r2 = await api('POST', '/api/glossaries/quickadd', { source_term: 'Netzteil', target_term: 'bloc', source_lang: 'DE', target_lang: 'FR', channel_code: 'SHOPA' });
  assert.equal(r2.status, 200);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.action, x.new_value]), [['standard', 'created', 'alimentation'], ['SHOPA', 'created', 'bloc']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Begriff aus dem Review (bis 10.11. ohne Verlauf): „standard angelegt“ und „freigabe offen“', async () => {
  const p = await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('p', 'DE', 'FR', 'txt') RETURNING id`);
  const m = await marke();
  const r = await api('POST', `/api/projects/${p.rows[0].id}/terminology`, { source_term: 'Lichtleiste', target_term: 'réglette' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.new_value]).sort(), [['freigabe', 'offen'], ['standard', 'réglette']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Terminologie-Scan übernehmen (bis 10.11. ohne Verlauf): ein Eintrag je Begriff', async () => {
  const scan = await q(`INSERT INTO terminology_scans (name, source_lang, target_lang, source_file_type, glossary_id) VALUES ('s', 'DE', 'FR', 'txt', $1) RETURNING id`, [FR]);
  const k = await q(
    `INSERT INTO terminology_candidates (scan_id, source_text, existing_translation, deepl_translation, source_term, existing_term, deepl_term, category, confidence, position)
     VALUES ($1, 'a', 'b', 'c', 'Scanwort', 'mot-scan', 'd', 'TERMINOLOGY', 0.9, 0) RETURNING id`, [scan.rows[0].id]);
  const m = await marke();
  const r = await api('POST', `/api/terminology-scan/${scan.rows[0].id}/candidates/approve`, { ids: [k.rows[0].id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.source_term, x.field, x.new_value]), [['Scanwort', 'standard', 'mot-scan']]);
  assert.ok(e.every(vonPerson));
});

await pruefe('Listenweg (Bereinigung): Verlauf unter dem Namen des Laufs, einmal je Zeile', async () => {
  const id = await eintragId('Clip');
  const m = await marke();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const e = await wendeListeAn(c, [{ entryId: id, folge: 'neu', deutsch: 'Clip', eintrag: 'clip', neu: 'agrafe' }], 'Bereinigung Probe');
    assert.deepEqual(e.abweichungen, []);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.old_value, x.new_value, x.changed_by, x.changed_by_name]), [['standard', 'clip', 'agrafe', null, 'Bereinigung Probe']]);
});

await pruefe('neue Felder der Wortliste: an_deepl, Art, Gruppenziel stehen im Verlauf', async () => {
  const id = await eintragId('LED-Flexband');
  const m = await marke();
  await alsBearbeiter({ id: PERSON.id, name: PERSON.display_name }, async (c) => {
    await c.query(`UPDATE glossary_entries SET an_deepl = FALSE, wortart = 'hauptwort', genus = 'm' WHERE id = $1`, [id]);
    await c.query(`INSERT INTO glossary_entry_gruppen (entry_id, produktgruppe, target_term, genus) VALUES ($1, 16, 'ruban', 'm')`, [id]);
    await c.query(`UPDATE glossary_entry_gruppen SET target_term = 'bande' WHERE entry_id = $1`, [id]);
    await c.query(`DELETE FROM glossary_entry_gruppen WHERE entry_id = $1`, [id]);
  });
  const e = await neueEintraege(m);
  // Eine Transaktion, ein Zeitstempel: verglichen wird ohne Reihenfolge.
  const sortiert = (l) => l.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(sortiert(e.map((x) => [x.field, x.action, x.old_value, x.new_value])), sortiert([
    ['an_deepl', 'updated', 'ja', 'nein'], ['genus', 'updated', null, 'm'], ['wortart', 'updated', null, 'hauptwort'],
    ['gruppe:16', 'created', null, 'ruban [m]'], ['gruppe:16', 'updated', 'ruban [m]', 'bande [m]'], ['gruppe:16', 'deleted', 'bande [m]', null],
  ]));
  assert.ok(e.every(vonPerson));
});

await pruefe('ohne Bearbeiter (psql, vergessener Weg): Eintrag mit „unbekannt“, nie ohne Eintrag', async () => {
  const id = await eintragId('Netzteil');
  const m = await marke();
  await q(`UPDATE glossary_entries SET target_term = 'bloc d''alimentation' WHERE id = $1`, [id]);
  const e = await neueEintraege(m);
  assert.deepEqual(e.map((x) => [x.field, x.changed_by, x.changed_by_name]), [['standard', null, 'unbekannt']]);
});

await pruefe('die Angabe gilt nur in ihrer Transaktion: danach wieder „unbekannt“', async () => {
  const id = await eintragId('Netzteil');
  await alsBearbeiter({ id: null, name: 'Kurz da' }, (c) => c.query(`UPDATE glossary_entries SET context = 'eins' WHERE id = $1`, [id]));
  const m = await marke();
  await q(`UPDATE glossary_entries SET context = 'zwei' WHERE id = $1`, [id]);
  assert.deepEqual((await neueEintraege(m)).map((x) => x.changed_by_name), ['unbekannt']);
});

await pruefe('Gegenprobe: ohne die Trigger aus 037 entsteht beim Plus kein Eintrag, die Prüfung oben fiele also auf', async () => {
  await q(`DROP TRIGGER trg_wortliste_verlauf_eintrag ON glossary_entries`);
  try {
    const m = await marke();
    assert.equal((await api('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Ohneverlauf', target_term: 'sans' })).status, 201);
    assert.equal((await neueEintraege(m)).length, 0, 'der Schreibweg schreibt keinen eigenen Verlauf mehr');
  } finally {
    await q(readFileSync(join(MIGRATIONEN, '037_wortliste_verlauf.sql'), 'utf-8'));
  }
});

await pruefe('Quelltext: kein Schreibweg schreibt den Verlauf noch selbst', async () => {
  const wege = ['src/routes/glossaries.ts', 'src/services/glossar-pflege.ts', 'src/services/glossar-liste.ts', 'src/routes/review.ts',
    'src/routes/terminology-scan.ts', 'src/services/glossar-antworten.ts', 'src/services/wortliste-umzug.ts', 'src/routes/namens-bausteine.ts',
    'src/routes/wortliste-pflege.ts', 'src/services/namens-einlesen.ts'];
  for (const f of wege) {
    const s = readFileSync(join(WURZEL, f), 'utf-8');
    assert.ok(!/INSERT\s+INTO\s+glossary_entry_history/i.test(s), `${f} schreibt den Verlauf selbst`);
  }
});

server.close();
await pool.end();
console.log(`\n${ok} grün, ${fehler.length} rot`);
process.exit(fehler.length ? 1 : 0);
