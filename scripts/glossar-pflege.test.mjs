#!/usr/bin/env node
/**
 * Prüfungen für die Glossar-Pflege: Im Glossar steht nur, was wir anders wollen als DeepL (Entscheid Thomas 04.11.2026,
 * PLAN-glossar-nur-abweichungen.md). Leere Zeilen entstehen nicht mehr; die Tests legen sie als Bestand von Hand an.
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank. Das Passwort kommt aus der
 * Umgebung, DeepL wird nicht aufgerufen (die Translator-Methoden sind ersetzt):
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-glossar-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:55432:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=translationtool_test DB_USER=translationtool \
 *     node scripts/glossar-pflege.test.mjs
 *
 * 🚨 Der Lauf löscht das Schema `public`. Deshalb bricht er ab, wenn die Datenbank nicht auf `_test`
 * endet oder nicht lokal liegt, und zwar vor dem ersten Datenbankzugriff.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const istLokal = ['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '');
if (!process.env.DB_PASSWORD || !istLokal || !(process.env.DB_NAME ?? '').endsWith('_test')) {
  console.error('Abbruch: nur gegen eine lokale Datenbank mit Namen *_test und mit DB_PASSWORD aus der Umgebung, siehe Kopfkommentar.');
  process.exit(2);
}
// Auch ein gesetzter echter Schlüssel darf hier nichts erreichen.
process.env.DEEPL_API_KEY = 'attrappe-kein-schluessel';
process.env.TRANSLATION_SERVICE_KEY = '';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('services', 'glossar-pflege.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};

const deepl = require('deepl-node');
const express = require('express');
const aufrufe = { uebersetzen: [], glossar: [] };
let antwortVonDeepL = (text) => text;
deepl.Translator.prototype.translateText = async function (texte, quelle, ziel, optionen) {
  aufrufe.uebersetzen.push({ texte, ziel, optionen });
  const liste = Array.isArray(texte) ? texte : [texte];
  const aus = liste.map((t) => ({ text: antwortVonDeepL(t), detectedSourceLang: 'de' }));
  return Array.isArray(texte) ? aus : aus[0];
};
deepl.Translator.prototype.createGlossary = async function (name, q, z, eintraege) {
  aufrufe.glossar.push({ name, tsv: eintraege.toTsv() });
  return { glossaryId: `attrappe-${aufrufe.glossar.length}` };
};
deepl.Translator.prototype.deleteGlossary = async function () {};

const { pool } = await laden('db', 'connection.js');
const q = (sql, p) => pool.query(sql, p);

const db = (await q('SELECT current_database() AS n')).rows[0].n;
assert.ok(db.endsWith('_test'), 'falsche Datenbank');

await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
const MIGRATIONEN = join(WURZEL, 'migrations');
const TESTSEED = readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8');
const migriere = async () => {
  for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) {
    await q(readFileSync(join(MIGRATIONEN, f), 'utf-8'));
  }
  await q(TESTSEED);
};
await migriere();

const glossaries = await laden('routes', 'glossaries.js');
const condensing = await laden('services', 'condensing.js');
const channelOverrides = await laden('services', 'channel-overrides.js');
const terminology = await laden('services', 'terminology.js');
const router = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.default ?? m.default;
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: null, display_name: 'Testperson', role: 'admin' }; next(); }); // Der direkte Weg ist seit 12.11.2026 der der Admins (PLAN-glossar-freigabe.md).
app.use('/api/glossaries', await router('routes', 'glossaries.js'));
app.use('/api/projects', await router('routes', 'review.js'));
app.use('/api/projects', await router('routes', 'segments.js'));
app.use('/api/terminology-scan', await router('routes', 'terminology-scan.js'));
app.use('/api/terminology', await router('routes', 'terminology.js'));
app.use('/api/quick-translate', await router('routes', 'quick-translate.js'));
app.use('/api/batch-translate', await router('routes', 'batch-translate.js'));
const server = app.listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const BASIS = `http://127.0.0.1:${server.address().port}`;

const api = async (methode, pfad, body) => {
  const r = await fetch(BASIS + pfad, {
    method: methode,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: r.status, body: json, text };
};

let gruen = 0;
let rot = 0;
const pruefe = async (name, f) => {
  try {
    await f();
    gruen += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    rot += 1;
    console.error(`  ROT   ${name}\n        ${e.message}`);
  }
};

// Wer eine Zeile zählt, soll denselben Schlüssel benutzen wie das System.
const zeilen = async (begriff) => (await q(
  `SELECT g.target_lang, e.id, e.glossary_id, e.source_term, e.target_term, e.approved, e.source
     FROM glossary_entries e JOIN glossaries g ON g.id = e.glossary_id
    WHERE lower(btrim(e.source_term)) = lower(btrim($1))
    ORDER BY g.source_lang, g.target_lang, e.created_at`, [begriff])).rows;
const zeileIn = async (begriff, sprache) => (await zeilen(begriff)).find((z) => z.target_lang === sprache);
const version = async (id) => (await q('SELECT version FROM glossaries WHERE id = $1', [id])).rows[0].version;
const stale = async () => (await q('SELECT count(*)::int AS n FROM segments WHERE is_stale')).rows[0].n;

const G = {};
const neuAufsetzen = async () => {
  await q('TRUNCATE glossaries, glossary_entry_history, segments, projects, terminology_scans CASCADE');
  for (const k of Object.keys(G)) delete G[k];
  for (const sprache of ['CZ', 'FR', 'IT']) {
    const r = await api('POST', '/api/glossaries', { name: `Glossar DE→${sprache}`, source_lang: 'DE', target_lang: sprache });
    G[sprache] = r.body.id;
  }
  const fremd = await api('POST', '/api/glossaries', { name: 'EN→FR', source_lang: 'EN', target_lang: 'FR' });
  G.EN_FR = fremd.body.id;
};
const lege = (sprache, begriff, ziel) => api('POST', `/api/glossaries/${G[sprache]}/entries`, { source_term: begriff, target_term: ziel });
const segment = async (text, sprache = 'FR', v = 0) => {
  await q(
    `INSERT INTO segments (segment_hash, source_lang, target_lang, source_text, translated_text, glossary_version)
     VALUES (md5($1 || $2), 'DE', $2, $1, 'alt', $3)`, [text, sprache, v]);
};

// Eine leere Zeile von Hand: Von selbst entsteht sie nur noch beim Anlegen eines Glossars, im Bestand liegen sie bis Phase 3.
const legeLeer = async (sprache, begriff) => (await q(
  `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source)
   VALUES ($1, $2, NULL, FALSE, 'nachtrag') RETURNING *`, [G[sprache], begriff])).rows[0];
const ENTFERNTE_TRIGGER = ['glossar_begriff_nachtragen', 'glossar_begriff_umbenannt'];
const ENTFERNTE_FUNKTIONEN = ['glossar_abgleich', 'glossar_begriff_nachtragen'];
const BLEIBENDE = ['glossar_leere_zeile_ersetzen', 'glossar_neu_befuellen'];
const glossarTrigger = async () => (await q(
  `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'glossar_%' AND NOT tgisinternal ORDER BY 1`)).rows.map((z) => z.tgname);
const glossarFunktionen = async () => (await q(
  `SELECT proname FROM pg_proc WHERE proname LIKE 'glossar_%' ORDER BY 1`)).rows.map((z) => z.proname);
const migrateJs = () => spawnSync(process.execPath, [dist('db', 'migrate.js')], { cwd: WURZEL, env: process.env, encoding: 'utf-8' });

console.log('\nMigration');
await neuAufsetzen();
await pruefe('zweimal migrate.js legt keinen der entfernten Trigger und keine der Funktionen neu an', async () => {
  for (let lauf = 1; lauf <= 2; lauf += 1) {
    const r = migrateJs();
    assert.equal(r.status, 0, `Lauf ${lauf}: ${r.stderr}`);
    assert.ok(r.stdout.includes('031_glossar_nur_abweichungen.sql'), r.stdout);
    // Positivkontrolle: Die Abfragen sehen Trigger und Funktionen dieses Namens überhaupt.
    assert.deepEqual(await glossarTrigger(), BLEIBENDE, `Lauf ${lauf}`);
    assert.deepEqual(await glossarFunktionen(), BLEIBENDE, `Lauf ${lauf}`);
  }
});
await pruefe('Migration 031 entfernt die alten Trigger und Funktionen aus einem Bestand, der sie noch führt', async () => {
  await q(`CREATE FUNCTION glossar_abgleich(nur_begriff TEXT DEFAULT NULL) RETURNS INT LANGUAGE sql AS 'SELECT 0'`);
  await q(`CREATE FUNCTION glossar_begriff_nachtragen() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'`);
  // Die alte Fassung rief glossar_abgleich: Bliebe sie stehen, schlüge jedes neue Glossar nach dieser Migration fehl.
  await q(`CREATE OR REPLACE FUNCTION glossar_neu_befuellen() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN PERFORM glossar_abgleich(); RETURN NULL; END'`);
  await q(`CREATE TRIGGER glossar_begriff_nachtragen AFTER INSERT ON glossary_entries FOR EACH ROW EXECUTE FUNCTION glossar_begriff_nachtragen()`);
  await q(`CREATE TRIGGER glossar_begriff_umbenannt AFTER UPDATE OF source_term ON glossary_entries FOR EACH ROW EXECUTE FUNCTION glossar_begriff_nachtragen()`);
  const vorher = await glossarTrigger();
  for (const t of ENTFERNTE_TRIGGER) assert.ok(vorher.includes(t), `Vorbedingung ${t}`);
  await q(readFileSync(join(MIGRATIONEN, '031_glossar_nur_abweichungen.sql'), 'utf-8'));
  const nachher = await glossarTrigger();
  for (const t of ENTFERNTE_TRIGGER) assert.ok(!nachher.includes(t), t);
  const funktionen = await glossarFunktionen();
  for (const f of ENTFERNTE_FUNKTIONEN) assert.ok(!funktionen.includes(f), f);
  assert.deepEqual(nachher, BLEIBENDE, 'Gegenprobe: das Befüllen bleibt');
  const neu = await api('POST', '/api/glossaries', { name: 'nach 031', source_lang: 'DE', target_lang: 'XA' });
  assert.equal(neu.status, 201, neu.text);
});
await pruefe('Migration ändert keine Zeile: Eine leere Zeile überlebt den Migrationslauf', async () => {
  await lege('FR', 'Bestandswort', 'existant');
  const leer = await legeLeer('IT', 'Bestandswort');
  await migriere();
  assert.equal((await zeileIn('Bestandswort', 'IT')).id, leer.id);
  assert.equal((await zeilen('Bestandswort')).length, 2);
});
await pruefe('target_term bleibt nullable', async () => {
  const r = await q(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'glossary_entries' AND column_name = 'target_term'`);
  assert.equal(r.rows[0].is_nullable, 'YES');
});
await pruefe('Schranke: leere Zeile lässt sich nicht freigeben, auch nicht von Hand', async () => {
  const z = await legeLeer('IT', 'Schranke');
  await assert.rejects(q('UPDATE glossary_entries SET approved = TRUE WHERE id = $1', [z.id]), /leer_nie_freigegeben/);
  await assert.rejects(q('UPDATE glossary_entries SET approved = NULL WHERE id = $1', [z.id]), /leer_nie_freigegeben/);
  await assert.rejects(
    q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'x', NULL, TRUE)`, [G.IT]),
    /leer_nie_freigegeben/,
  );
});
await pruefe('Schranke: leerer Text ist kein Zustand', async () => {
  await assert.rejects(
    q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term) VALUES ($1, 'x', '  ')`, [G.IT]),
    /kein_leerer_text/,
  );
});

console.log('\nAnlegen: jeder Schreibweg bleibt im eigenen Glossar');
await neuAufsetzen();
await pruefe('eine neue Zeile im Glossar IT legt nichts in FR an und ändert dort nichts', async () => {
  const [vFr, vCz] = [await version(G.FR), await version(G.CZ)];
  await segment('5m Rolle weiß', 'FR');
  const r = await lege('IT', '5m Rolle', 'rotolo da 5m');
  assert.equal(r.status, 201);
  const z = await zeilen('5m Rolle');
  assert.deepEqual(z.map((x) => [x.target_lang, x.target_term, x.approved]), [['IT', 'rotolo da 5m', true]]);
  assert.equal(await version(G.FR), vFr);
  assert.equal(await version(G.CZ), vCz);
  assert.equal(await stale(), 0);
});
await pruefe('Glossar mit anderer Quellsprache: ebenso nur das eigene', async () => {
  await api('POST', `/api/glossaries/${G.EN_FR}/entries`, { source_term: 'Roll', target_term: 'rouleau' });
  assert.equal((await zeilen('Roll')).length, 1);
});
await pruefe('Groß-/Kleinschreibung: derselbe Begriff in zwei Glossaren, je eine Zeile', async () => {
  await lege('FR', 'Lightbox', 'caisson');
  assert.equal((await lege('IT', 'lightbox', 'cassonetto')).status, 201);
  const z = await zeilen('LIGHTBOX');
  assert.deepEqual(z.map((x) => [x.target_lang, x.target_term]), [['FR', 'caisson'], ['IT', 'cassonetto']]);
});
await pruefe('Anlegen über einer gefüllten Zeile wird abgelehnt, statt eine Dublette zu erzeugen', async () => {
  const r = await lege('FR', 'LIGHTBOX', 'anderes ziel');
  assert.equal(r.status, 409);
  assert.equal((await zeilen('Lightbox')).filter((x) => x.target_lang === 'FR').length, 1);
});
await pruefe('das Plus ersetzt eine leere Zeile, keine zweite Zeile', async () => {
  const leer = await legeLeer('FR', 'Plusfeld');
  assert.equal((await lege('FR', 'plusfeld', 'champ')).status, 201);
  const z = await zeilen('Plusfeld');
  assert.equal(z.length, 1);
  assert.equal(z[0].target_term, 'champ');
  assert.notEqual(z[0].id, leer.id);
});
await pruefe('direktes SQL trägt nichts nach und ersetzt die leere Zeile', async () => {
  await legeLeer('FR', 'Roh');
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Roh', 'roh-fr', TRUE)`, [G.FR]);
  const z = await zeilen('Roh');
  assert.deepEqual(z.map((x) => [x.target_lang, x.target_term]), [['FR', 'roh-fr']]);
});
await pruefe('Quickadd legt nur hier an und füllt eine leere Zeile, ohne zweite Zeile', async () => {
  const neu = await api('POST', '/api/glossaries/quickadd', { source_term: 'Schnell', target_term: 'vite', source_lang: 'DE', target_lang: 'FR' });
  assert.equal(neu.body.action, 'created');
  assert.equal((await zeilen('Schnell')).length, 1);
  await legeLeer('IT', 'schnell');
  const fuellt = await api('POST', '/api/glossaries/quickadd', { source_term: 'schnell', target_term: 'veloce', source_lang: 'DE', target_lang: 'IT' });
  assert.equal(fuellt.body.action, 'updated');
  const it = (await zeilen('Schnell')).filter((x) => x.target_lang === 'IT');
  assert.equal(it.length, 1);
  assert.equal(it[0].target_term, 'veloce');
  assert.equal(it[0].approved, true);
});
await pruefe('Quickadd mit Channel füllt die leere Zeile und setzt den Override', async () => {
  await q(`INSERT INTO channels (code, name) VALUES ('TESTKANAL', 'Test') ON CONFLICT DO NOTHING`);
  await legeLeer('IT', 'Kanalwort');
  const r = await api('POST', '/api/glossaries/quickadd', { source_term: 'Kanalwort', target_term: 'parola', source_lang: 'DE', target_lang: 'IT', channel_code: 'TESTKANAL' });
  assert.equal(r.status, 200);
  const it = await zeileIn('Kanalwort', 'IT');
  assert.equal(it.target_term, 'parola');
  assert.equal(it.approved, true);
});
await pruefe('CS wird CZ: Quickadd und Review legen kein neues Glossar an', async () => {
  const vorher = (await q('SELECT count(*)::int AS n FROM glossaries')).rows[0].n;
  await api('POST', '/api/glossaries/quickadd', { source_term: 'Tschechisch', target_term: 'cesky', source_lang: 'DE', target_lang: 'CS' });
  const p = await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('p', 'DE', 'CS', 'txt') RETURNING id`);
  await api('POST', `/api/projects/${p.rows[0].id}/terminology`, { source_term: 'Review-CS', target_term: 'kandidat' });
  assert.equal((await q('SELECT count(*)::int AS n FROM glossaries')).rows[0].n, vorher);
  assert.equal((await zeileIn('Tschechisch', 'CZ')).target_term, 'cesky');
  assert.equal((await zeileIn('Review-CS', 'CZ')).target_term, 'kandidat');
});
await pruefe('Review-Kandidat legt nur hier an, bleibt offen und ersetzt die leere Zeile', async () => {
  const p = await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('p2', 'DE', 'FR', 'txt') RETURNING id`);
  const neu = await api('POST', `/api/projects/${p.rows[0].id}/terminology`, { source_term: 'Kandidat', target_term: 'candidat' });
  assert.equal(neu.status, 200);
  assert.equal((await zeilen('Kandidat')).length, 1);
  await legeLeer('IT', 'kandidat');
  const p2 = await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('p3', 'DE', 'IT', 'txt') RETURNING id`);
  await api('POST', `/api/projects/${p2.rows[0].id}/terminology`, { source_term: 'kandidat', target_term: 'candidato' });
  const it = (await zeilen('Kandidat')).filter((x) => x.target_lang === 'IT');
  assert.equal(it.length, 1);
  assert.equal(it[0].target_term, 'candidato');
  assert.equal(it[0].approved, false);
});
await pruefe('geschütztes Leerzeichen am Rand: Review und Scan speichern getrimmt, kein zweiter Begriff', async () => {
  await legeLeer('IT', 'Lichtleiste');
  const p = await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('nbsp', 'DE', 'IT', 'txt') RETURNING id`);
  const r = await api('POST', `/api/projects/${p.rows[0].id}/terminology`, { source_term: 'Lichtleiste ', target_term: 'listello ' });
  assert.equal(r.status, 200, r.text);
  const z = await zeilen('Lichtleiste');
  assert.equal(z.filter((x) => x.target_lang === 'IT').length, 1);
  assert.equal(z.find((x) => x.target_lang === 'IT').target_term, 'listello');
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossary_entries WHERE source_term LIKE '%' || chr(160)`)).rows[0].n, 0);
});
await pruefe('doppeltes Absenden im selben Glossar ergibt eine Zeile und einmal 409', async () => {
  const [a, b] = await Promise.all([lege('FR', 'Doppelklick', 'clic'), lege('FR', 'Doppelklick', 'clic')]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((await zeilen('Doppelklick')).filter((x) => x.target_lang === 'FR').length, 1);
});
await pruefe('ein PUT ohne Änderung des Begriffs wartet nicht auf die Glossar-Sperre (kein Deadlock)', async () => {
  await lege('FR', 'Sperrwort', 'verrou');
  const fr = await zeileIn('Sperrwort', 'FR');
  const halter = await pool.connect();
  try {
    await halter.query('BEGIN');
    await halter.query('SELECT pg_advisory_xact_lock(711027)');
    const antwort = await Promise.race([
      api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { approved: false }),
      new Promise((ok) => setTimeout(() => ok('Zeitüberschreitung'), 4000)),
    ]);
    assert.notEqual(antwort, 'Zeitüberschreitung', 'PUT hängt an der Sperre');
    assert.equal(antwort.status, 200);
  } finally {
    await halter.query('ROLLBACK');
    halter.release();
  }
});
await pruefe('Terminologie-Scan legt nur hier an und ersetzt die leere Zeile; leerer Zielbegriff wird übersprungen', async () => {
  const scan = await q(`INSERT INTO terminology_scans (name, source_lang, target_lang, source_file_type) VALUES ('s', 'DE', 'FR', 'txt') RETURNING id`);
  const kand = (begriff, ziel, pos) => q(
    `INSERT INTO terminology_candidates (scan_id, source_text, existing_translation, deepl_translation, source_term, existing_term, deepl_term, category, confidence, position)
     VALUES ($1, 'a', 'b', 'c', $2, $3, 'd', 'TERMINOLOGY', 0.9, $4) RETURNING id`, [scan.rows[0].id, begriff, ziel, pos]);
  const a = await kand('Scanwort', 'mot-scan', 0);
  const b = await kand('Scanleer', '  ', 1);
  const r = await api('POST', `/api/terminology-scan/${scan.rows[0].id}/candidates/approve`, { ids: [a.rows[0].id, b.rows[0].id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.approved, 1);
  assert.equal(r.body.uebersprungen, 1);
  assert.equal((await zeilen('Scanwort')).length, 1);
  assert.equal((await zeilen('Scanleer')).length, 0);
  await legeLeer('IT', 'Scanwort');
  const scanIt = await q(`INSERT INTO terminology_scans (name, source_lang, target_lang, source_file_type) VALUES ('s2', 'DE', 'IT', 'txt') RETURNING id`);
  const c = await q(
    `INSERT INTO terminology_candidates (scan_id, source_text, existing_translation, deepl_translation, source_term, existing_term, deepl_term, category, confidence, position)
     VALUES ($1, 'a', 'b', 'c', 'Scanwort', 'parola-scan', 'd', 'TERMINOLOGY', 0.9, 0) RETURNING id`, [scanIt.rows[0].id]);
  await api('POST', `/api/terminology-scan/${scanIt.rows[0].id}/candidates/approve`, { ids: [c.rows[0].id] });
  const it = (await zeilen('Scanwort')).filter((x) => x.target_lang === 'IT');
  assert.equal(it.length, 1);
  assert.equal(it[0].target_term, 'parola-scan');
});
await pruefe('zwei gleichzeitige Anlagen desselben Begriffs in zwei Glossaren: je eine Zeile', async () => {
  const [a, b] = await Promise.all([lege('FR', 'Gleichzeitig', 'en meme temps'), lege('IT', 'gleichzeitig', 'allo stesso tempo')]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const z = await zeilen('Gleichzeitig');
  assert.deepEqual(z.map((x) => [x.target_lang, x.target_term]), [['FR', 'en meme temps'], ['IT', 'allo stesso tempo']]);
});

console.log('\nEin neues Glossar bekommt die Begriffe aus mindestens der Hälfte der Glossare, einmalig');
const zeilenImGlossar = async (id) => (await q(
  'SELECT source_term, target_term, approved, source FROM glossary_entries WHERE glossary_id = $1 ORDER BY lower(source_term)', [id])).rows;
const begriffeImGlossar = async (id) => (await zeilenImGlossar(id)).map((z) => z.source_term);
const neuesGlossar = async (ziel, quelle = 'DE') => {
  const r = await api('POST', '/api/glossaries', { name: `${quelle}→${ziel}`, source_lang: quelle, target_lang: ziel });
  assert.equal(r.status, 201, r.text);
  return r.body.id;
};
const inGlossaren = async (begriff, sprachen) => { for (const s of sprachen) await lege(s, begriff, `${begriff} ${s}`); };
const LEER_NACHTRAG = { target_term: null, approved: false, source: 'nachtrag' };

await neuAufsetzen();
await inGlossaren('Zwei von drei', ['CZ', 'FR']);
await inGlossaren('Einer von drei', ['IT']);
await pruefe('bei 3 Glossaren reichen 2: Der Begriff kommt leer, nicht freigegeben, der mit 1 nicht', async () => {
  const id = await neuesGlossar('PL');
  assert.deepEqual(await zeilenImGlossar(id), [{ source_term: 'Zwei von drei', ...LEER_NACHTRAG }]);
});

await neuAufsetzen();
G.ES = await neuesGlossar('ES');
// DE→DE führt Zeilen: Zählte es als Glossar, läge die Schwelle bei 3 statt 2. Zählte es als Treffer, käme „Mit Deutsch“ mit.
const DE_DE = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ('DE→DE', 'DE', 'DE') RETURNING id`)).rows[0].id;
await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Mit Deutsch', 'Mit Deutsch', TRUE)`, [DE_DE]);
await inGlossaren('Mit Deutsch', ['FR']);
await inGlossaren('Zwei von vier', ['CZ', 'FR']);
await inGlossaren('Einer von vier', ['IT']);
await inGlossaren('Mit Lücke', ['FR']);
for (const s of ['CZ', 'IT', 'ES']) await legeLeer(s, 'Mit Lücke');
for (const s of ['CZ', 'FR', 'IT', 'ES']) await legeLeer(s, 'Nur leer');
await inGlossaren('Dublette', ['FR']);
await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'DUBLETTE', 'zweite', TRUE)`, [G.FR]);
await lege('CZ', 'leitung', 'a');
await lege('FR', 'Leitung', 'b');
await lege('IT', 'Leitung', 'c');
await pruefe('bei 4 Glossaren: Text in 2 kommt mit, Text in 1 nicht, leere Zeilen und DE→DE zählen nicht, eine Dublette zählt einmal', async () => {
  G.PL = await neuesGlossar('PL');
  assert.deepEqual(await zeilenImGlossar(G.PL), [
    { source_term: 'Leitung', ...LEER_NACHTRAG },
    { source_term: 'Zwei von vier', ...LEER_NACHTRAG },
  ], 'die häufigste Schreibweise gewinnt');
});
await pruefe('das Befüllen entwertet nichts und ändert keine Version', async () => {
  await segment('Leitung im Text', 'XB');
  await segment('Leitung im Text', 'FR');
  const v = await version(G.FR);
  const id = await neuesGlossar('XB');
  // Fünf bestehende Glossare, Schwelle 3: Die leeren Zeilen in PL zählen nicht, „Zwei von vier“ fehlt deshalb hier.
  assert.deepEqual(await begriffeImGlossar(id), ['Leitung'], 'Gegenprobe: Die Zeile ist da');
  assert.equal(await version(id), 1);
  assert.equal(await version(G.FR), v);
  assert.equal(await stale(), 0);
  await q('DELETE FROM glossaries WHERE id = $1', [id]);
});
await pruefe('ein neues Glossar mit anderer Quellsprache und ein neues DE→DE bekommen nichts', async () => {
  const en = await neuesGlossar('PL', 'EN');
  assert.deepEqual(await zeilenImGlossar(en), []);
  await q('DELETE FROM glossaries WHERE id = $1', [en]);
  await q(`DELETE FROM glossaries WHERE id = $1`, [DE_DE]);
  const de = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ('DE→DE', 'DE', 'DE') RETURNING id`)).rows[0].id;
  assert.deepEqual(await zeilenImGlossar(de), []);
  await q(`DELETE FROM glossaries WHERE id = $1`, [de]);
});
await pruefe('ein später neuer Begriff trägt in das neue Glossar nichts nach', async () => {
  const vorher = await zeilenImGlossar(G.PL);
  await inGlossaren('Später', ['CZ', 'FR', 'IT', 'ES']);
  assert.deepEqual(await zeilenImGlossar(G.PL), vorher);
});
await pruefe('die neuen Zeilen wirken nicht: DeepL und Export kennen sie nicht', async () => {
  await lege('PL', 'Gefüllt', 'wypelnione');
  aufrufe.glossar.length = 0;
  assert.equal((await api('POST', `/api/glossaries/${G.PL}/sync-deepl`)).status, 200);
  assert.ok(aufrufe.glossar[0].tsv.includes('Gefüllt'), 'Gegenprobe');
  assert.ok(!aufrufe.glossar[0].tsv.includes('Zwei von vier'));
  const csv = await api('GET', `/api/glossaries/${G.PL}/export`);
  assert.ok(csv.text.includes('Gefüllt') && !csv.text.includes('Zwei von vier'));
});
await pruefe('bei 1 Glossar reicht 1, ohne anderes Glossar entsteht nichts', async () => {
  await q(`DELETE FROM glossaries WHERE source_lang = 'DE' AND id <> $1`, [G.FR]);
  const id = await neuesGlossar('HU');
  assert.ok((await begriffeImGlossar(id)).includes('Mit Lücke'), 'Text in dem einen Glossar genügt');
  await q(`DELETE FROM glossaries WHERE source_lang = 'DE'`);
  assert.deepEqual(await zeilenImGlossar(await neuesGlossar('FR')), []);
});
await neuAufsetzen();
await pruefe('bei 8 Glossaren: ab 4', async () => {
  const sprachen = ['CZ', 'FR', 'IT', 'ES', 'EN', 'HU', 'SK', 'NL'];
  for (const s of sprachen.slice(3)) G[s] = await neuesGlossar(s);
  await inGlossaren('Vier von acht', sprachen.slice(0, 4));
  await inGlossaren('Drei von acht', sprachen.slice(0, 3));
  assert.deepEqual(await begriffeImGlossar(await neuesGlossar('PL')), ['Vier von acht']);
});

console.log('\nNeues Glossar auf der Glossarseite');
await neuAufsetzen();
const legeGlossar = (ziel, name = `Glossar DE→${ziel}`) => api('POST', '/api/glossaries', { name, source_lang: 'DE', target_lang: ziel });
const anzahlGlossare = async () => (await q('SELECT count(*)::int AS n FROM glossaries')).rows[0].n;
const hatIndex = async () => (await q(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'uq_glossaries_sprachpaar'`)).rows[0].n === 1;
await pruefe('ein zweites Glossar gleicher Sprache wird abgelehnt, nennt das vorhandene und legt nichts an', async () => {
  const vorher = await anzahlGlossare();
  const r = await legeGlossar('FR', 'anderer Name');
  assert.equal(r.status, 409);
  assert.equal(r.body.glossary_id, G.FR);
  assert.equal(await anzahlGlossare(), vorher);
});
await pruefe('CS trifft ein vorhandenes CZ', async () => {
  const vorher = await anzahlGlossare();
  const r = await legeGlossar('cs');
  assert.equal(r.status, 409);
  assert.equal(r.body.glossary_id, G.CZ);
  assert.equal(await anzahlGlossare(), vorher);
});
await pruefe('CS ohne vorhandenes CZ wird als CZ angelegt', async () => {
  await q('DELETE FROM glossaries WHERE id = $1', [G.CZ]);
  const r = await legeGlossar('CS');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.target_lang, 'CZ');
  G.CZ = r.body.id;
});
await pruefe('die Rückgabe nennt die Zahl der vorbefüllten Begriffe, die Liste zeigt das Glossar mit offenen Zeilen', async () => {
  const leer = await legeGlossar('NL');
  assert.equal(leer.body.vorbefuellt, 0, 'Gegenprobe: ohne Begriffe null');
  await inGlossaren('Oft', ['CZ', 'FR', 'IT']);
  await inGlossaren('Mittel', ['CZ', 'FR']);
  await inGlossaren('Selten', ['IT']);
  // Vier bestehende Glossare DE→X, Schwelle 2.
  const r = await legeGlossar('PL');
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.vorbefuellt, 2);
  assert.equal(r.body.name, 'Glossar DE→PL');
  const stats = (await api('GET', '/api/glossaries/stats')).body.find((g) => g.id === r.body.id);
  assert.equal(Number(stats.zu_pflegen), 2);
  assert.equal(Number(stats.entry_count), 0);
  const liste = await api('GET', `/api/glossaries/${r.body.id}/entries?status=zu_pflegen`);
  assert.deepEqual(liste.body.entries.map((e) => [e.source_term, e.target_term]), [['Mittel', null], ['Oft', null]]);
});
await pruefe('zwei gleichzeitige Anlagen derselben Sprache ergeben ein Glossar und einmal 409', async () => {
  const [a, b] = await Promise.all([legeGlossar('SK'), legeGlossar('SK')]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossaries WHERE target_lang = 'SK'`)).rows[0].n, 1);
});
await pruefe('ohne Name und mit einem Code, den die Spalte nicht trägt, 400 statt 500', async () => {
  assert.equal((await legeGlossar('HU', '   ')).status, 400);
  assert.equal((await legeGlossar('ZH-HANS')).status, 400);
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossaries WHERE target_lang = 'HU'`)).rows[0].n, 0);
});
await pruefe('zweimal migrate.js ist gefahrlos, der Index hält auch direktes SQL auf', async () => {
  for (let lauf = 1; lauf <= 2; lauf += 1) {
    const r = migrateJs();
    assert.equal(r.status, 0, `Lauf ${lauf}: ${r.stderr}`);
    assert.ok(await hatIndex(), `Lauf ${lauf}`);
  }
  await assert.rejects(q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ('x', 'DE', 'FR')`), /uq_glossaries_sprachpaar/);
});
await pruefe('eine Dublette im Bestand stoppt den Deploy nicht, die Route lehnt trotzdem ab, danach kommt der Index', async () => {
  await q('DROP INDEX uq_glossaries_sprachpaar');
  await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ('Dublette', 'DE', 'FR')`);
  const lauf = migrateJs();
  assert.equal(lauf.status, 0, lauf.stderr);
  assert.ok(!(await hatIndex()), 'kein Index neben einer Dublette');
  assert.equal((await legeGlossar('FR')).status, 409, 'die Schranke der Route hängt nicht am Index');
  await q(`DELETE FROM glossaries WHERE name = 'Dublette'`);
  assert.equal(migrateJs().status, 0);
  assert.ok(await hatIndex(), 'der nächste Deploy legt ihn an');
});
await pruefe('der Import bricht bei einem anders benannten Glossar desselben Paars ab und rollt zurück', async () => {
  await lege('FR', 'Bleibt beim Import', 'reste');
  await q(`UPDATE glossaries SET name = 'Anders benannt' WHERE id = $1`, [G.FR]);
  const ordner = mkdtempSync(join(tmpdir(), 'tt-glossar-'));
  const csv = join(ordner, 'g.csv');
  writeFileSync(csv, 'Deutsch;Französisch\nImportwort;mot\n', 'utf-8');
  const r = spawnSync(process.execPath, [dist('scripts', 'import-glossary.js'), csv], { cwd: WURZEL, env: process.env, encoding: 'utf-8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal((await zeileIn('Bleibt beim Import', 'FR')).target_term, 'reste');
  assert.equal((await zeilen('Importwort')).length, 0);
});
await pruefe('Sprachliste: nur was DeepL als Ziel und Glossar ab Deutsch kann und es noch nicht gibt, CS gilt als CZ', async () => {
  const echt = [deepl.Translator.prototype.getTargetLanguages, deepl.Translator.prototype.getGlossaryLanguagePairs];
  const ziele = [
    { code: 'cs', name: 'Czech' }, { code: 'de', name: 'German' }, { code: 'en-GB', name: 'English (British)' }, { code: 'en-US', name: 'English (American)' },
    { code: 'fr', name: 'French' }, { code: 'ja', name: 'Japanese' }, { code: 'pt-BR', name: 'Portuguese (Brazilian)' }, { code: 'pt-PT', name: 'Portuguese (European)' }, { code: 'sv', name: 'Swedish' },
  ];
  const paare = ['cs', 'de', 'en', 'fr', 'pt', 'sv'].map((targetLang) => ({ sourceLang: 'de', targetLang }));
  paare.push({ sourceLang: 'en', targetLang: 'ja' });
  deepl.Translator.prototype.getTargetLanguages = async () => ziele;
  deepl.Translator.prototype.getGlossaryLanguagePairs = async () => paare;
  try {
    const r = await api('GET', '/api/glossaries/zielsprachen');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, [{ code: 'EN', name: 'English' }, { code: 'SV', name: 'Swedish' }]);
    await q('DELETE FROM glossaries WHERE id = $1', [G.CZ]);
    assert.ok((await api('GET', '/api/glossaries/zielsprachen')).body.some((s) => s.code === 'CZ'), 'CZ, nicht CS');
    deepl.Translator.prototype.getGlossaryLanguagePairs = async () => [];
    assert.equal((await api('GET', '/api/glossaries/zielsprachen')).status, 502, 'eine leere Antwort ist kein Ergebnis');
  } finally {
    [deepl.Translator.prototype.getTargetLanguages, deepl.Translator.prototype.getGlossaryLanguagePairs] = echt;
  }
});

console.log('\nImport (CSV über das Werkzeug)');
await neuAufsetzen();
await pruefe('leere Zelle legt keine Zeile an, nichts wird nachgetragen', async () => {
  await lege('CZ', 'Nur in CZ', 'jen cz');
  const ordner = mkdtempSync(join(tmpdir(), 'tt-glossar-'));
  const csv = join(ordner, 'g.csv');
  writeFileSync(csv, 'Deutsch;Französisch;Italienisch\nBeides;les deux;entrambi\nNur FR;seulement;\n', 'utf-8');
  execFileSync(process.execPath, [dist('scripts', 'import-glossary.js'), csv], { cwd: WURZEL, env: process.env, stdio: 'pipe' });
  const nurFr = await zeilen('Nur FR');
  assert.equal(nurFr.length, 1);
  assert.equal(nurFr[0].target_lang, 'FR');
  assert.equal(nurFr[0].target_term, 'seulement');
  assert.equal(nurFr[0].source, 'csv-import');
  assert.equal((await zeilen('Nur in CZ')).length, 1);
  assert.deepEqual((await zeilen('Beides')).map((x) => x.target_term).sort(), ['entrambi', 'les deux']);
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossary_entries WHERE target_term IS NULL`)).rows[0].n, 0);
});

console.log('\nEine leere Zeile wirkt nirgends und bringt keinen Leser zu Fall (Negativfälle, je mit Gegenprobe)');
await neuAufsetzen();
await lege('FR', 'Aktivwort', 'mot-actif');
await lege('IT', 'Aktivwort', 'parola-attiva');
await lege('IT', 'Leerwort', 'solo-it');
await lege('IT', 'CRI', 'IRC');
const LEER_FR = await legeLeer('FR', 'Leerwort');
await legeLeer('FR', 'CRI');
await pruefe('Vorbedingung: im Glossar FR ist Leerwort leer und CRI leer', async () => {
  assert.equal(LEER_FR.target_term, null);
  assert.equal((await zeileIn('CRI', 'FR')).target_term, null);
});
await pruefe('die Liste zeigt sie mit Zahl und Filter, ohne sie als Eintrag zu zählen', async () => {
  const r = await api('GET', `/api/glossaries/${G.FR}/entries?limit=50`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.entries.map((e) => [e.source_term, e.target_term]), [['Aktivwort', 'mot-actif'], ['CRI', null], ['Leerwort', null]]);
  assert.equal(r.body.stats.zu_pflegen, 2);
  assert.equal(r.body.stats.pending, 0);
  const filter = await api('GET', `/api/glossaries/${G.FR}/entries?status=zu_pflegen`);
  assert.equal(filter.body.total, 2);
  const stats = await api('GET', '/api/glossaries/stats');
  const fr = stats.body.find((g) => g.id === G.FR);
  assert.equal(Number(fr.entry_count), 1);
  assert.equal(Number(fr.zu_pflegen), 2);
  assert.equal(Number(stats.body.find((g) => g.id === G.IT).zu_pflegen), 0, 'ohne solche Zeilen keine Zahl');
});
await pruefe('DeepL-Glossar enthält sie nicht, das Aktive schon', async () => {
  aufrufe.glossar.length = 0;
  const r = await api('POST', `/api/glossaries/${G.FR}/sync-deepl`);
  assert.equal(r.status, 200, r.text);
  const { tsv } = aufrufe.glossar[0];
  assert.ok(tsv.includes('Aktivwort'), 'Gegenprobe');
  assert.ok(!tsv.includes('Leerwort'));
  assert.ok(!tsv.includes('CRI'));
});
await pruefe('Prompt der Kürzung (getGlossaryTerms) enthält keine leere Zeile', async () => {
  const t = await condensing.getGlossaryTerms('DE', 'FR');
  assert.deepEqual(t, ['mot-actif']);
});
await pruefe('Channel-Overrides: Override an leerer Zeile wird abgewiesen und wirkte auch nicht', async () => {
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${LEER_FR.id}/channels/TESTKANAL`, { target_term: 'x' });
  assert.equal(r.status, 409);
  await q(`INSERT INTO channels (code, name) VALUES ('TESTKANAL', 'Test') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'TESTKANAL', 'x')`, [LEER_FR.id]);
  assert.deepEqual(await channelOverrides.getChannelOverrides('DE', 'FR', 'TESTKANAL'), []);
  await q(`DELETE FROM glossary_entry_channels WHERE entry_id = $1`, [LEER_FR.id]);
});
await pruefe('/api/terminology kennt sie nicht, das Aktive schon', async () => {
  const leer = await api('GET', '/api/terminology?term=Leerwort&target=FR');
  assert.deepEqual(leer.body.results, []);
  const aktiv = await api('GET', '/api/terminology?term=Aktivwort&target=FR');
  assert.equal(aktiv.body.results[0].target, 'mot-actif');
});
await pruefe('Schnellübersetzung: kein Treffer und kein Akronym aus einer leeren Zeile', async () => {
  antwortVonDeepL = (t) => t;
  const r = await api('POST', '/api/quick-translate', { text: 'Leerwort CRI90 Aktivwort', sourceLang: 'DE', targetLang: 'FR', useGlossary: true });
  assert.equal(r.status, 200, r.text);
  assert.ok(!/IRC/.test(r.body.translatedText));
  const treffer = (r.body.glossaryHits ?? []).map((h) => h.source);
  assert.ok(!treffer.includes('Leerwort'));
  assert.ok((r.body.glossaryHits ?? []).every((h) => h.target), 'kein Treffer ohne Ziel');
});
await pruefe('Artikeldaten (batch-translate): leeres CRI greift nicht, freigegebenes greift', async () => {
  antwortVonDeepL = (t) => t;
  const fr = await api('POST', '/api/batch-translate', { segments: [{ id: 'a', text: 'Lampe CRI90' }], sourceLang: 'DE', targetLangs: ['FR'] });
  assert.equal(fr.status, 200, fr.text);
  assert.ok(fr.text.includes('CRI90') && !fr.text.includes('IRC90'));
  const it = await api('POST', '/api/batch-translate', { segments: [{ id: 'a', text: 'Lampe CRI90' }], sourceLang: 'DE', targetLangs: ['IT'] });
  assert.ok(it.text.includes('IRC90'), 'Gegenprobe');
});
await pruefe('Prüfen-Ansicht (Segmente): kein Treffer, kein Absturz; das Aktive wird gefunden', async () => {
  const p = await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('p', 'DE', 'FR', 'txt') RETURNING id`);
  const s = await q(
    `INSERT INTO segments (segment_hash, source_lang, target_lang, source_text, translated_text)
     VALUES ('seg-hits', 'DE', 'FR', 'Leerwort und Aktivwort', 'mot-actif ici') RETURNING id`);
  await q(
    `INSERT INTO project_segments (project_id, segment_id, idml_segment_id, position) VALUES ($1, $2, 's1', 0)`,
    [p.rows[0].id, s.rows[0].id]);
  const r = await api('GET', `/api/projects/${p.rows[0].id}/segments`);
  assert.equal(r.status, 200, r.text);
  const hits = r.body.segments[0].source_glossary_hits.map((h) => h.source_term);
  assert.deepEqual(hits, ['Aktivwort']);
});
await pruefe('Terminologie-Abgleich stürzt an einer leeren Zeile nicht ab', async () => {
  const k = await terminology.filterExistingGlossaryEntries([{ targetTerm: 'mot-actif' }, { targetTerm: 'neu' }], 'DE', 'FR');
  assert.deepEqual(k.map((c) => c.targetTerm), ['neu']);
});
await pruefe('CSV-Export enthält sie nicht und schreibt kein „null“', async () => {
  const r = await api('GET', `/api/glossaries/${G.FR}/export`);
  assert.ok(r.text.includes('Aktivwort;mot-actif'), 'Gegenprobe');
  assert.ok(!r.text.includes('Leerwort'));
  assert.ok(!r.text.includes('null'));
});
await pruefe('Sammelfreigabe lässt leere Zeilen aus, gibt offene gefüllte frei', async () => {
  const p = await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('p9', 'DE', 'FR', 'txt') RETURNING id`);
  await api('POST', `/api/projects/${p.rows[0].id}/terminology`, { source_term: 'Offenwort', target_term: 'ouvert' });
  const r = await api('POST', `/api/glossaries/${G.FR}/entries/bulk-approve`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.approved, 1);
  assert.equal((await zeileIn('Offenwort', 'FR')).approved, true);
  assert.equal((await zeileIn('Leerwort', 'FR')).approved, false);
});
await pruefe('Einzelfreigabe einer leeren Zeile wird abgewiesen', async () => {
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${LEER_FR.id}`, { approved: true });
  assert.equal(r.status, 409);
  assert.equal((await zeileIn('Leerwort', 'FR')).approved, false);
});
await pruefe('Bauprüfung: Jeder Leser im Quelltext filtert auf Freigabe oder Füllung', async () => {
  const dateien = [];
  const lauf = (o) => {
    for (const n of readdirSync(o)) {
      const p = join(o, n);
      if (statSync(p).isDirectory()) lauf(p);
      else if (n.endsWith('.ts')) dateien.push(p);
    }
  };
  lauf(join(WURZEL, 'src'));
  // Die Pflege selbst muss leere Zeilen sehen; ihre Wege prüfen die Fälle oben und unten. Dazu seit Phase 3 der Wortliste der Umzug
  // der Namensbausteine, der jede Zeile zählt (`scripts/wortliste-umzug.test.mjs`), und seit Phase 5 die Pflege der Wortliste auf der
  // Glossarseite, die offene Zeilen ablehnt (`scripts/wortliste-pflege.test.mjs`), und seit Phase 6 das Einlesen der Prüftabellen,
  // das je Wort auch offene Zeilen findet (`scripts/namens-einlesen.test.mjs`), und seit 12.11.2026 die Vorschläge der Nicht-Admins,
  // die an jeder Zeile hängen dürfen, auch an einer leeren (`scripts/glossar-freigabe.test.mjs`), und seit Phase 2 von
  // PLAN-oeffentlich-und-demo.md das Löschrecht bei GLOSSAR_FREIGABE=alle, das jede Zeile auf ihre Herkunft prüft
  // (`scripts/glossar-freigabe-alle.test.mjs`).
  const pflegewege = /[\\/](routes[\\/]glossaries|routes[\\/]wortliste-pflege|services[\\/]namens-einlesen|services[\\/]glossar-pflege|services[\\/]glossar-vorschlaege|middleware[\\/]glossar-recht|services[\\/]glossar-hinweise|services[\\/]glossar-liste|scripts[\\/]glossar-nur-abweichungen|scripts[\\/]import-glossary|services[\\/]wortliste-umzug|scripts[\\/]wortliste-zusammenfuehren)\.ts$/;
  const verstoesse = [];
  let geprueft = 0;
  for (const d of dateien.filter((x) => !pflegewege.test(x))) {
    const quelltext = readFileSync(d, 'utf-8');
    // Seit Migration 036 lesen die Fließtext-Wege die Sicht `glossar_an_deepl`; sie filtert selbst auf Freigabe und Füllung.
    const stellen = quelltext.split('`').filter((teil) => /\b(FROM|JOIN)\s+(glossary_entries|glossar_an_deepl)\b/.test(teil));
    for (const sql of stellen) {
      geprueft += 1;
      if (!/approved|target_term IS NOT NULL|LOWER\(target_term\)|\bglossar_an_deepl\b/i.test(sql)) verstoesse.push(`${d}: ${sql.trim().slice(0, 90)}`);
    }
  }
  assert.ok(geprueft >= 10, `nur ${geprueft} Stellen gefunden`);
  assert.deepEqual(verstoesse, []);
});

console.log('\nFüllen und Cache');
await neuAufsetzen();
await segment('Lightbox 12W rund', 'IT');
await segment('Anderes Produkt', 'IT');
await pruefe('eine Zeile in FR entwertet in IT nichts und ändert dort keine Version', async () => {
  const vIt = await version(G.IT);
  await lege('FR', 'Lightbox', 'caisson');
  assert.equal(await version(G.IT), vIt);
  assert.equal(await stale(), 0);
});
await legeLeer('IT', 'Lightbox');
await pruefe('leerer Text beim Bestätigen wird abgewiesen, die Zeile bleibt, wie sie ist', async () => {
  const z = await zeileIn('Lightbox', 'IT');
  const vIt = await version(G.IT);
  assert.equal((await api('PUT', `/api/glossaries/${G.IT}/entries/${z.id}`, { target_term: '   ' })).status, 400);
  assert.equal((await zeileIn('Lightbox', 'IT')).target_term, null);
  assert.equal(await version(G.IT), vIt);
});
await pruefe('leere Zeile bearbeiten, ohne sie zu füllen, entwertet nichts', async () => {
  const z = await zeileIn('Lightbox', 'IT');
  const vIt = await version(G.IT);
  assert.equal((await api('PUT', `/api/glossaries/${G.IT}/entries/${z.id}`, { context: 'Hinweis' })).status, 200);
  assert.equal(await version(G.IT), vIt);
  assert.equal(await stale(), 0);
});
await pruefe('Bestätigen macht die Zeile aktiv und trifft nur Segmente mit dem Begriff', async () => {
  const z = await zeileIn('Lightbox', 'IT');
  const vIt = await version(G.IT);
  const r = await api('PUT', `/api/glossaries/${G.IT}/entries/${z.id}`, { target_term: '  cassonetto ' });
  assert.equal(r.status, 200, r.text);
  const nachher = await zeileIn('Lightbox', 'IT');
  assert.equal(nachher.target_term, 'cassonetto');
  assert.equal(nachher.approved, true);
  assert.equal(await version(G.IT), vIt + 1);
  const s = await q(`SELECT source_text, is_stale FROM segments WHERE target_lang = 'IT' ORDER BY source_text`);
  assert.deepEqual(s.rows.map((x) => [x.source_text, x.is_stale]), [['Anderes Produkt', false], ['Lightbox 12W rund', true]]);
});
await pruefe('der Verlauf hält fest, wer bestätigt hat', async () => {
  const z = await zeileIn('Lightbox', 'IT');
  const r = await api('GET', `/api/glossaries/${G.IT}/entries/${z.id}/history`);
  assert.equal(r.body[0].old_value, null);
  assert.equal(r.body[0].new_value, 'cassonetto');
  assert.equal(r.body[0].changed_by_name, 'Testperson');
});
await pruefe('Liste: leere Zeilen stehen hinten, „Offen“ zählt sie nicht mit', async () => {
  await lege('CZ', 'Aaa zuerst alphabetisch', 'a');
  await lege('CZ', 'Zzz zuletzt alphabetisch', 'z');
  await legeLeer('CZ', 'Lightbox');
  const r = await api('GET', `/api/glossaries/${G.CZ}/entries?limit=50`);
  assert.deepEqual(r.body.entries.map((e) => e.source_term), ['Aaa zuerst alphabetisch', 'Zzz zuletzt alphabetisch', 'Lightbox']);
  const offen = await api('GET', `/api/glossaries/${G.CZ}/entries?status=pending`);
  assert.equal(offen.body.total, 0);
  const frei = await api('GET', `/api/glossaries/${G.CZ}/entries?status=approved`);
  assert.equal(frei.body.total, 2);
});

console.log('\nDeepL-Vorschlag');
await neuAufsetzen();
const WERT = 'Rolle 12W, 24V DC, 3-polig';
const vorschlag = (begriff, g = G.IT) => api('POST', `/api/glossaries/${g}/vorschlag`, { source_term: begriff });
await pruefe('genau ein Aufruf, Werte bleiben geschützt, nichts wird gespeichert', async () => {
  aufrufe.uebersetzen.length = 0;
  // DeepL trennt ungeschützte Werte: Stünde `12W` im Aufruf, käme `12 W` zurück.
  antwortVonDeepL = (t) => t.replace('Rolle', 'Rotolo').replace('12W', '12 W').replace('24V DC', '24 V CC');
  const vIt = await version(G.IT);
  const r = await vorschlag(WERT);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'ok');
  assert.ok(r.body.vorschlag.includes('12W') && r.body.vorschlag.includes('24V DC'), r.body.vorschlag);
  assert.ok(r.body.vorschlag.startsWith('Rotolo'));
  assert.equal(aufrufe.uebersetzen.length, 1);
  const gesendet = aufrufe.uebersetzen[0].texte.join(' ');
  assert.ok(!gesendet.includes('12W') && !gesendet.includes('24V'), gesendet);
  assert.equal((await zeilen(WERT)).length, 0);
  assert.equal(await version(G.IT), vIt);
});
await pruefe('geht ein Wert verloren, gibt es keinen Vorschlag und keinen zweiten Aufruf', async () => {
  aufrufe.uebersetzen.length = 0;
  antwortVonDeepL = (t) => t.replace(/_*ISOLUNIT0_*/, '');
  const r = await vorschlag(WERT);
  assert.equal(r.body.status, 'wert_verloren');
  assert.ok(r.body.fehlend.length > 0);
  assert.equal(aufrufe.uebersetzen.length, 1);
});
await pruefe('geht die Polzahl verloren, gibt es keinen Vorschlag', async () => {
  antwortVonDeepL = (t) => t.replace(/_*ISOLPOL0_*/, '');
  const r = await vorschlag(WERT);
  assert.equal(r.body.status, 'wert_verloren', JSON.stringify(r.body));
  assert.ok(r.body.fehlend.length > 0);
});
await pruefe('leere Antwort von DeepL ist kein Vorschlag', async () => {
  antwortVonDeepL = () => '  ';
  const r = await vorschlag('Fassung');
  assert.equal(r.body.status, 'leer');
});
await pruefe('DeepL-Fehler kommt als Fehler an und speichert nichts', async () => {
  const echt = deepl.Translator.prototype.translateText;
  deepl.Translator.prototype.translateText = async () => { throw new Error('DeepL weg'); };
  const r = await vorschlag('Fassung');
  deepl.Translator.prototype.translateText = echt;
  assert.equal(r.status, 502);
  assert.equal((await zeilen('Fassung')).length, 0);
});
await pruefe('steht der Begriff schon im Glossar, wird DeepL nicht gefragt; in einem anderen Glossar zählt er nicht', async () => {
  antwortVonDeepL = (t) => t;
  await lege('FR', 'Vorhanden', 'deja');
  aufrufe.uebersetzen.length = 0;
  const r = await vorschlag('VORHANDEN', G.FR);
  assert.equal(r.status, 409);
  assert.equal(aufrufe.uebersetzen.length, 0);
  assert.equal((await vorschlag('Vorhanden', G.IT)).body.status, 'ok', 'Gegenprobe: im Glossar IT fehlt er');
});
await pruefe('eine leere Zeile zum Begriff bekommt den Vorschlag, gespeichert wird nichts', async () => {
  await legeLeer('IT', 'Bestandsleer');
  assert.equal((await vorschlag('Bestandsleer')).body.status, 'ok');
  assert.equal((await zeileIn('Bestandsleer', 'IT')).target_term, null);
});
await pruefe('ohne Begriff oder mit zu langem Text wird DeepL nicht gefragt, unbekanntes Glossar ergibt 404', async () => {
  aufrufe.uebersetzen.length = 0;
  assert.equal((await vorschlag('   ')).status, 400);
  assert.equal((await api('POST', `/api/glossaries/${G.IT}/vorschlag`, {})).status, 400);
  assert.equal((await vorschlag('x'.repeat(201))).status, 400);
  assert.equal((await vorschlag('Wort', '00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal(aufrufe.uebersetzen.length, 0);
});
await pruefe('Vorschlag nimmt das Glossar nur, wenn es bei DeepL schon liegt, und löst keinen Sync aus', async () => {
  antwortVonDeepL = (t) => t;
  aufrufe.glossar.length = 0;
  aufrufe.uebersetzen.length = 0;
  await vorschlag('Fassung');
  assert.equal(aufrufe.uebersetzen[0].optionen.glossary, undefined);
  await q(`UPDATE glossaries SET deepl_glossary_id = 'liegt-schon-dort', synced_version = 0 WHERE id = $1`, [G.IT]);
  aufrufe.uebersetzen.length = 0;
  await vorschlag('Fassung');
  assert.equal(aufrufe.uebersetzen[0].optionen.glossary, 'liegt-schon-dort');
  assert.equal(aufrufe.glossar.length, 0);
});

console.log('\nLöschen und Umbenennen gelten nur im eigenen Glossar');
await neuAufsetzen();
await lege('FR', 'Push', 'pousser');
await lege('IT', 'Push', 'premere');
await segment('Push Taster', 'FR');
await segment('Push Taster', 'IT');
await pruefe('ein × in IT lässt FR unberührt: Zeile, Version und Cache', async () => {
  const it = await zeileIn('Push', 'IT');
  const fr = await zeileIn('Push', 'FR');
  const [vFr, vIt] = [await version(G.FR), await version(G.IT)];
  const r = await api('DELETE', `/api/glossaries/${G.IT}/entries/${it.id}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(await zeileIn('Push', 'IT'), undefined);
  const nochFr = await zeileIn('Push', 'FR');
  assert.equal(nochFr.id, fr.id);
  assert.equal(nochFr.target_term, 'pousser');
  assert.equal(await version(G.FR), vFr);
  assert.equal(await version(G.IT), vIt + 1);
  const s = await q(`SELECT target_lang, is_stale FROM segments WHERE source_text = 'Push Taster' ORDER BY 1`);
  assert.deepEqual(s.rows.map((x) => [x.target_lang, x.is_stale]), [['FR', false], ['IT', true]]);
  const verlauf = await q(`SELECT field, action, old_value FROM glossary_entry_history WHERE entry_id = $1 AND action = 'deleted'`, [it.id]);
  assert.deepEqual(verlauf.rows, [{ field: 'standard', action: 'deleted', old_value: 'premere' }]);
});
await pruefe('das × nimmt Channel-Werte mit, der Verlauf trägt sie einzeln', async () => {
  await q(`INSERT INTO channels (code, name) VALUES ('TESTKANAL', 'Test') ON CONFLICT DO NOTHING`);
  await lege('IT', 'Kanalzeile', 'riga');
  const it = await zeileIn('Kanalzeile', 'IT');
  await api('PUT', `/api/glossaries/${G.IT}/entries/${it.id}/channels/TESTKANAL`, { target_term: 'kanal' });
  // Die Rückfrage der Oberfläche zeigt, was hier steht.
  const liste = await api('GET', `/api/glossaries/${G.IT}/entries?search=Kanalzeile`);
  assert.deepEqual(liste.body.entries[0].channels, { TESTKANAL: 'kanal' });
  assert.equal((await api('DELETE', `/api/glossaries/${G.IT}/entries/${it.id}`)).status, 200);
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossary_entry_channels WHERE entry_id = $1`, [it.id])).rows[0].n, 0);
  const verlauf = await q(`SELECT field, old_value FROM glossary_entry_history WHERE entry_id = $1 AND action = 'deleted'`, [it.id]);
  assert.deepEqual(verlauf.rows.map((v) => `${v.field}=${v.old_value}`).sort(), ['TESTKANAL=kanal', 'standard=riga']);
});
await pruefe('das × lässt die Schutzkette stehen; eine leere Zeile zum selben Begriff darf weg', async () => {
  await lege('IT', 'CRI', 'IRC');
  const it = await zeileIn('CRI', 'IT');
  const v = await version(G.IT);
  const r = await api('DELETE', `/api/glossaries/${G.IT}/entries/${it.id}`);
  assert.equal(r.status, 409);
  assert.equal((await zeileIn('CRI', 'IT')).target_term, 'IRC');
  assert.equal(await version(G.IT), v);
  const leer = await legeLeer('FR', 'CRI');
  assert.equal((await api('DELETE', `/api/glossaries/${G.FR}/entries/${leer.id}`)).status, 200);
  assert.equal(await zeileIn('CRI', 'FR'), undefined);
});
await pruefe('× an einer leeren Zeile: Zeile weg, Version und Cache unverändert', async () => {
  const leer = await legeLeer('CZ', 'Nur leer');
  const v = await version(G.CZ);
  const staleVorher = await stale();
  assert.equal((await api('DELETE', `/api/glossaries/${G.CZ}/entries/${leer.id}`)).status, 200);
  assert.equal((await zeilen('Nur leer')).length, 0);
  assert.equal(await version(G.CZ), v);
  assert.equal(await stale(), staleVorher);
});
await pruefe('Dublette: × trifft nur die eine Zeile', async () => {
  await lege('FR', 'Doppel', 'eins');
  await lege('IT', 'Doppel', 'uno');
  // Seit Migration 038 je Glossar eine Zeile je exakter Schreibung (Plan Wortliste §2.1): Die Dublette ist eine Schreibvariante.
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'doppel', 'zwei', TRUE)`, [G.FR]);
  const fr = (await zeilen('Doppel')).filter((z) => z.target_lang === 'FR');
  assert.equal(fr.length, 2);
  assert.equal((await api('DELETE', `/api/glossaries/${G.FR}/entries/${fr[0].id}`)).status, 200);
  const rest = await zeilen('Doppel');
  assert.equal(rest.filter((z) => z.target_lang === 'FR').length, 1);
  assert.equal((await zeileIn('Doppel', 'IT')).target_term, 'uno');
});
await pruefe('× im fremden Sprachpaar: gleicher Weg, und die Adresse muss stimmen', async () => {
  await api('POST', `/api/glossaries/${G.EN_FR}/entries`, { source_term: 'Local', target_term: 'local' });
  const z = (await zeilen('Local'))[0];
  assert.equal((await api('DELETE', `/api/glossaries/${G.FR}/entries/${z.id}`)).status, 404, 'fremdes Glossar in der Adresse');
  assert.equal((await zeilen('Local')).length, 1);
  assert.equal((await api('DELETE', `/api/glossaries/${G.EN_FR}/entries/${z.id}`)).status, 200);
  assert.equal((await zeilen('Local')).length, 0);
  assert.equal((await api('DELETE', `/api/glossaries/${G.EN_FR}/entries/${z.id}`)).status, 404, 'zweimal: inzwischen weg');
});
await pruefe('Umbenennen zusammen mit der Übersetzung wird abgewiesen', async () => {
  await lege('FR', 'Altname', 'ancien');
  await lege('IT', 'Altname', 'vecchio');
  const fr = await zeileIn('Altname', 'FR');
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: 'Neuname', target_term: 'x' });
  assert.equal(r.status, 400);
});
await pruefe('Umbenennen auf leer wird abgewiesen', async () => {
  const fr = await zeileIn('Altname', 'FR');
  assert.equal((await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: '  ' })).status, 400);
});
await pruefe('Umbenennen gilt nur hier: IT behält den alten Begriff, Übersetzung bleibt, Cache trifft alt und neu', async () => {
  await segment('Altname rund', 'FR');
  await segment('Neuname eckig', 'FR');
  await segment('Unbeteiligt', 'FR');
  const fr = await zeileIn('Altname', 'FR');
  const vIt = await version(G.IT);
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: 'Neuname' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await zeilen('Neuname')).map((z) => [z.target_lang, z.target_term]), [['FR', 'ancien']]);
  assert.deepEqual((await zeilen('Altname')).map((z) => [z.target_lang, z.target_term]), [['IT', 'vecchio']]);
  assert.equal(await version(G.IT), vIt);
  const s = await q(`SELECT source_text, is_stale FROM segments WHERE source_text IN ('Altname rund', 'Neuname eckig', 'Unbeteiligt') ORDER BY 1`);
  assert.deepEqual(s.rows.map((x) => x.is_stale), [true, true, false]);
  const v = await q(`SELECT old_value, new_value FROM glossary_entry_history WHERE entry_id = $1 AND field = 'begriff'`, [fr.id]);
  assert.deepEqual(v.rows[0], { old_value: 'Altname', new_value: 'Neuname' });
});
await pruefe('Channel-Werte bleiben beim Umbenennen an der Zeile', async () => {
  await lege('FR', 'Kanalalt', 'canal');
  const fr = await zeileIn('Kanalalt', 'FR');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}/channels/TESTKANAL`, { target_term: 'kanal' });
  assert.equal((await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: 'Kanalneu' })).status, 200);
  const k = await q(`SELECT target_term FROM glossary_entry_channels WHERE entry_id = $1`, [fr.id]);
  assert.deepEqual(k.rows, [{ target_term: 'kanal' }]);
});
await pruefe('nur die Schreibweise ändern: gilt nur hier, kein Konflikt', async () => {
  const fr = await zeileIn('Neuname', 'FR');
  await lege('IT', 'Neuname', 'nuovo');
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: 'NEUNAME' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await zeilen('neuname')).map((z) => [z.target_lang, z.source_term]), [['FR', 'NEUNAME'], ['IT', 'Neuname']]);
});
await pruefe('nur die Schreibweise einer Dublette ändern: kein Konflikt, die andere Zeile bleibt', async () => {
  await lege('FR', 'Paarwort', 'eins');
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'PAARWORT', 'zwei', TRUE)`, [G.FR]);
  const eins = (await zeilen('paarwort')).find((z) => z.target_term === 'eins');
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${eins.id}`, { source_term: 'PaarWort' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await zeilen('paarwort')).length, 2);
});
await pruefe('Kollision im eigenen Glossar, beide übersetzt: abgewiesen, nennt beide Übersetzungen, nichts ändert sich', async () => {
  await lege('FR', 'Ziel', 'cible');
  await lege('FR', 'Quelle', 'source');
  const fr = await zeileIn('Quelle', 'FR');
  const v = await version(G.FR);
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: 'Ziel' });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.konflikte, [{ target_term_alt: 'source', target_term_neu: 'cible' }]);
  assert.equal((await zeileIn('Quelle', 'FR')).target_term, 'source');
  assert.equal((await zeileIn('Ziel', 'FR')).target_term, 'cible');
  assert.equal(await version(G.FR), v);
});
await pruefe('derselbe Begriff in einem anderen Glossar ist keine Kollision', async () => {
  await lege('IT', 'Fremdziel', 'bersaglio');
  await lege('FR', 'Fremdquelle', 'origine');
  const fr = await zeileIn('Fremdquelle', 'FR');
  assert.equal((await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: 'Fremdziel' })).status, 200);
  assert.deepEqual((await zeilen('Fremdziel')).map((z) => [z.target_lang, z.target_term]), [['FR', 'origine'], ['IT', 'bersaglio']]);
});
await pruefe('Umbenennen auf eine leere Zeile: Sie fällt weg, keine Dublette, nichts geht verloren', async () => {
  await legeLeer('IT', 'Ziel');
  await lege('IT', 'Quelle', 'fonte');
  const it = await zeileIn('Quelle', 'IT');
  const r = await api('PUT', `/api/glossaries/${G.IT}/entries/${it.id}`, { source_term: 'Ziel' });
  assert.equal(r.status, 200, r.text);
  const z = (await zeilen('Ziel')).filter((x) => x.target_lang === 'IT');
  assert.deepEqual(z.map((x) => [x.id, x.target_term]), [[it.id, 'fonte']]);
});
await pruefe('eine leere Zeile auf einen übersetzten Begriff umbenennen: Sie fällt weg, kein Konflikt', async () => {
  const leer = await legeLeer('FR', 'Leerquelle');
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${leer.id}`, { source_term: 'Ziel' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await zeilen('Leerquelle')).length, 0);
  assert.equal((await zeileIn('Ziel', 'FR')).target_term, 'cible');
});
await pruefe('Umbenennen im fremden Sprachpaar: gleicher Weg', async () => {
  await api('POST', `/api/glossaries/${G.EN_FR}/entries`, { source_term: 'Local', target_term: 'local' });
  const z = (await zeilen('Local'))[0];
  const r = await api('PUT', `/api/glossaries/${G.EN_FR}/entries/${z.id}`, { source_term: 'Lokal' });
  assert.equal(r.status, 200);
  assert.equal((await zeilen('Lokal')).length, 1);
});
await pruefe('Zeile inzwischen weg: Umbenennen ergibt 404', async () => {
  await lege('FR', 'Verschwindet', 'part');
  const fr = await zeileIn('Verschwindet', 'FR');
  await q(`DELETE FROM glossary_entries WHERE lower(source_term) = 'verschwindet'`);
  assert.equal((await api('PUT', `/api/glossaries/${G.FR}/entries/${fr.id}`, { source_term: 'Anders' })).status, 404);
});
await pruefe('die alte Bestätigung hat keine Wirkung mehr: Der Parameter wird nicht gebraucht und nicht verlangt', async () => {
  await lege('FR', 'Altbestaetigt', 'ancien');
  const fr = await zeileIn('Altbestaetigt', 'FR');
  const r = await api('DELETE', `/api/glossaries/${G.FR}/entries/${fr.id}?bestaetigt=irgendetwas`);
  assert.equal(r.status, 200);
  assert.equal(r.body.bestaetigung_noetig, undefined);
});

console.log('\nPrüfhinweise');
await neuAufsetzen();
await lege('FR', 'Falschwort', 'mauvais');
await segment('Falschwort im Text', 'FR');
await lege('FR', 'Schreibwort', 'Majuscule');
await lege('FR', 'Fachschreibung', 'Graphie');
await lege('FR', 'Zweifach', 'double');
await lege('FR', 'Mit Nullbreite', 'invisible\u200B');
await lege('FR', 'Unberührt', 'intact');
await lege('IT', 'Falschwort', 'sbagliato');
const ORDNER = mkdtempSync(join(tmpdir(), 'tt-hinweise-'));
const datei = (name, zeilen, kopf = 'target_lang\tsource_term\ttarget_term\tkategorie\tgewissheit\tvorschlag\tgrund\tquelle') => {
  const p = join(ORDNER, name);
  writeFileSync(p, [kopf, ...zeilen].join('\n') + '\n', 'utf-8');
  return p;
};
const einspielen = (...a) => spawnSync(process.execPath, [dist('scripts', 'glossar-hinweise-einspielen.js'), ...a], { cwd: WURZEL, env: process.env, encoding: 'utf-8' });
const GUT = datei('gut.tsv', [
  'FR\tFalschwort\tmauvais\tfalsch\thoch\tbon\tDas Wort ist falsch.\tfachlich',
  'FR\tSchreibwort\tMajuscule\tschreibung\tmittel\tmajuscule\tGroßer Anfang.\tmechanisch',
  'FR\tFachschreibung\tGraphie\tschreibung\thoch\tgraphie\tFachlich beurteilt.\tfachlich',
  'FR\tZweifach\tdouble\tsprachlich\tniedrig\t\tNicht idiomatisch.\tfachlich',
  'FR\tZweifach\tdouble\tschreibung\tmittel\tDouble\tSchreibung.\tmechanisch',
  'FR\tMit Nullbreite\tinvisible\u200B\tzeichen\thoch\tinvisible\tUnsichtbares Zeichen.\tmechanisch',
  'IT\tFalschwort\tsbagliato\tfalsch\tmittel\tgiusto\tDas Wort ist falsch.\tfachlich',
  'FR\tGibt es nicht\tnichts\tfalsch\thoch\t\tDieser Eintrag fehlt.\tfachlich',
  'CZ\tFalschwort\tkeine Zeile\tfalsch\thoch\t\tDieses Glossar führt den Begriff nicht.\tfachlich',
]);
const versionenUndCache = async () => (await q(
  `SELECT (SELECT COALESCE(sum(version), 0)::int FROM glossaries) AS versionen, (SELECT count(*)::int FROM segments WHERE is_stale) AS stale`)).rows[0];
const zaehleHinweise = async () => (await q('SELECT count(*)::int AS n FROM glossary_hints')).rows[0].n;
const eintraege = (g, query = '') => api('GET', `/api/glossaries/${g}/entries?limit=50${query}`);
const zeileAus = (r, begriff) => r.body.entries.find((e) => e.source_term === begriff);
await pruefe('ohne --ausfuehren: rechnet alles und schreibt nichts', async () => {
  const r = einspielen(GUT);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes('Neu: 7, aktualisiert: 0, ohne passenden Eintrag: 2'), r.stdout);
  assert.ok(r.stdout.includes('nichts geändert'));
  assert.equal(await zaehleHinweise(), 0);
});
await pruefe('mit --ausfuehren: schreibt die Hinweise, ändert keinen Eintrag, keine Version und keinen Cache', async () => {
  const vorher = await versionenUndCache();
  const fp = (await q(`SELECT md5(string_agg(id::text || COALESCE(target_term, '') || approved::text, ',' ORDER BY id)) AS f FROM glossary_entries`)).rows[0].f;
  const r = einspielen(GUT, '--ausfuehren');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(await zaehleHinweise(), 7);
  assert.deepEqual(await versionenUndCache(), vorher);
  assert.equal((await q(`SELECT md5(string_agg(id::text || COALESCE(target_term, '') || approved::text, ',' ORDER BY id)) AS f FROM glossary_entries`)).rows[0].f, fp);
});
await pruefe('Zuordnung ist wörtlich, auch mit unsichtbarem Zeichen', async () => {
  const r = await eintraege(G.FR, '&search=Nullbreite');
  assert.equal(zeileAus(r, 'Mit Nullbreite').hinweise.length, 1);
});
await pruefe('zweiter Lauf legt nichts neu an, neuer Wortlaut aktualisiert', async () => {
  const r = einspielen(GUT, '--ausfuehren');
  assert.ok(r.stdout.includes('Neu: 0, aktualisiert: 7'), r.stdout);
  assert.equal(await zaehleHinweise(), 7);
  const neu = datei('neu.tsv', ['FR\tFalschwort\tmauvais\tfalsch\tmittel\tbesser\tNeuer Wortlaut.\tfachlich']);
  einspielen(neu, '--ausfuehren');
  assert.equal(await zaehleHinweise(), 7);
  const h = zeileAus(await eintraege(G.FR, '&search=Falschwort'), 'Falschwort').hinweise[0];
  assert.equal(h.grund, 'Neuer Wortlaut.');
  assert.equal(h.vorschlag, 'besser');
  einspielen(GUT, '--ausfuehren');
});
await pruefe('fehlerhafte Datei: Abbruch, nichts geschrieben, alle Fehler genannt', async () => {
  const schlecht = datei('schlecht.tsv', [
    'FR\tUnberührt\tintact\tgibtesnicht\thoch\t\tGrund.\tfachlich',
    'FR\tUnberührt\tintact\tfalsch\tsicher\t\tGrund.\tfachlich',
    'FR\tUnberührt\tintact\tfalsch\thoch\t\t\tfachlich',
    'FR\tUnberührt\tintact\twert\thoch\tintact\tVorschlag gleich.\tfachlich',
    'FR\tUnberührt\tintact\tsatz\thoch\t\tGrund.\tirgendwer',
    'FR\tUnberührt\tintact\tdublette\thoch\t\tEins.\tfachlich',
    'FR\tUnberührt\tintact\tdublette\thoch\t\tZwei.\tfachlich',
    'FR\tzu wenig Spalten',
  ]);
  const r = einspielen(schlecht, '--ausfuehren');
  assert.equal(r.status, 1);
  for (const teil of ['unbekannte Kategorie', 'unbekannte Gewissheit', 'Grund fehlt', 'Vorschlag ist gleich', 'unbekannte Quelle', 'zweiter Hinweis derselben Kategorie', 'Spalten']) {
    assert.ok(r.stderr.includes(teil), `${teil}: ${r.stderr}`);
  }
  assert.equal(await zaehleHinweise(), 7);
  const kopf = datei('kopf.tsv', ['FR\tUnberührt\tintact\tfalsch'], 'target_lang\tsource_term\ttarget_term\tkategorie');
  assert.equal(einspielen(kopf, '--ausfuehren').status, 1);
});
await pruefe('unbekannte Sprache: zurückgerollt, nichts geschrieben', async () => {
  const fremd = datei('fremd.tsv', ['XX\tUnberührt\tintact\tfalsch\thoch\t\tGrund.\tfachlich']);
  const r = einspielen(fremd, '--ausfuehren');
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('kein eindeutiges Glossar für: XX'), r.stderr);
  assert.equal(await zaehleHinweise(), 7);
});
await pruefe('Liste: Hinweise je Zeile mit Grund und Vorschlag, die unberührte Zeile hat keine', async () => {
  const r = await eintraege(G.FR);
  const f = zeileAus(r, 'Falschwort').hinweise[0];
  assert.equal(f.kategorie, 'falsch');
  assert.equal(f.vorschlag, 'bon');
  assert.equal(f.grund, 'Das Wort ist falsch.');
  assert.equal(zeileAus(r, 'Zweifach').hinweise.length, 2);
  assert.deepEqual(zeileAus(r, 'Unberührt').hinweise, []);
});
await pruefe('Voreinstellung blendet nur die mechanische Schreibung aus', async () => {
  const r = await eintraege(G.FR, '&hinweis=1&hinweis_kategorie=ohne_schreibung');
  const begriffe = r.body.entries.map((e) => e.source_term).sort();
  assert.deepEqual(begriffe, ['Fachschreibung', 'Falschwort', 'Mit Nullbreite', 'Zweifach'].sort());
  assert.equal(r.body.total, 4);
});
await pruefe('Filter: nur mit Hinweis, je Kategorie, je Gewissheit, beides zusammen', async () => {
  assert.equal((await eintraege(G.FR, '&hinweis=1')).body.total, 5);
  assert.equal((await eintraege(G.FR, '&hinweis_kategorie=schreibung')).body.total, 3);
  assert.equal((await eintraege(G.FR, '&hinweis_kategorie=falsch')).body.total, 1);
  assert.equal((await eintraege(G.FR, '&hinweis_gewissheit=hoch')).body.total, 3);
  assert.equal((await eintraege(G.FR, '&hinweis_kategorie=schreibung&hinweis_gewissheit=mittel')).body.total, 2);
  assert.equal((await eintraege(G.FR, '')).body.total, 6);
});
await pruefe('Sortierung im Filter: mechanische Schreibung zuletzt, Sicheres zuerst', async () => {
  const r = await eintraege(G.FR, '&hinweis=1');
  const begriffe = r.body.entries.map((e) => e.source_term);
  assert.equal(begriffe[begriffe.length - 1], 'Schreibwort', begriffe.join(', '));
  assert.ok(begriffe.indexOf('Falschwort') < begriffe.indexOf('Zweifach'), begriffe.join(', '));
});
await pruefe('unbekannter Filterwert ergibt 400, nicht lautlos eine leere Liste', async () => {
  assert.equal((await eintraege(G.FR, '&hinweis_kategorie=gibtesnicht')).status, 400);
  assert.equal((await eintraege(G.FR, '&hinweis_gewissheit=sicher')).status, 400);
});
await pruefe('Filter-Zahlen: Zeile mit zwei Hinweisen zählt in der Summe einmal', async () => {
  const f = (await eintraege(G.FR)).body.hinweis_facetten;
  const zahl = (k, g) => f.find((x) => x.kategorie === k && x.gewissheit === g);
  assert.equal(zahl(null, null).zeilen, 5);
  assert.equal(zahl(null, null).ohne_schreibflut, 4);
  assert.equal(zahl('schreibung', null).zeilen, 3);
  assert.equal(zahl('schreibung', 'mittel').zeilen, 2);
  assert.equal(zahl(null, 'hoch').zeilen, 3);
});
await pruefe('Glossarliste: Zahl der Hinweise getrennt von reiner Schreibung', async () => {
  const s = (await api('GET', '/api/glossaries/stats')).body;
  const fr = s.find((g) => g.id === G.FR);
  assert.equal(Number(fr.hinweise), 4);
  assert.equal(Number(fr.hinweise_schreibung), 1);
  const cz = s.find((g) => g.id === G.CZ);
  assert.equal(Number(cz.hinweise), 0);
});
await pruefe('ein Hinweis wirkt nicht: DeepL bekommt die Übersetzung, nie den Vorschlag', async () => {
  aufrufe.glossar.length = 0;
  await api('POST', `/api/glossaries/${G.FR}/sync-deepl`);
  const { tsv } = aufrufe.glossar[0];
  assert.ok(tsv.includes('mauvais'), 'Gegenprobe');
  assert.ok(!tsv.includes('bon') && !tsv.includes('besser'));
  assert.ok(!(await condensing.getGlossaryTerms('DE', 'FR')).includes('bon'));
});
await pruefe('Bauprüfung: nur die Pflege liest die Hinweise', async () => {
  const dateien = [];
  const lauf = (o) => {
    for (const n of readdirSync(o)) {
      const p = join(o, n);
      if (statSync(p).isDirectory()) lauf(p);
      else if (n.endsWith('.ts')) dateien.push(p);
    }
  };
  lauf(join(WURZEL, 'src'));
  const treffer = dateien.filter((d) => readFileSync(d, 'utf-8').includes('glossary_hints'));
  assert.deepEqual(treffer.map((d) => d.split(/[\\/]/).pop()).sort(), ['glossar-hinweise.ts']);
});
await pruefe('Vorschlag übernehmen geht über den normalen Speicherweg, danach ist der Hinweis erledigt', async () => {
  const z = await zeileIn('Falschwort', 'FR');
  const v = await version(G.FR);
  const staleVorher = await stale();
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { target_term: 'bon' });
  assert.equal(r.status, 200);
  assert.equal(await version(G.FR), v + 1);
  assert.equal(await stale(), staleVorher + 1);
  const verlauf = await api('GET', `/api/glossaries/${G.FR}/entries/${z.id}/history`);
  assert.equal(verlauf.body[0].new_value, 'bon');
  assert.deepEqual(zeileAus(await eintraege(G.FR, '&search=Falschwort'), 'Falschwort').hinweise, []);
  assert.equal(zeileAus(await eintraege(G.IT, '&search=Falschwort'), 'Falschwort').hinweise.length, 1, 'anderes Glossar bleibt');
});
await pruefe('Freigabe umschalten ändert den Eintrag nicht inhaltlich: Hinweis bleibt', async () => {
  const z = await zeileIn('Zweifach', 'FR');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { approved: false });
  assert.equal(zeileAus(await eintraege(G.FR, '&search=Zweifach'), 'Zweifach').hinweise.length, 2);
  await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { approved: true });
});
await pruefe('Umbenennen erledigt den Hinweis', async () => {
  const z = await zeileIn('Schreibwort', 'FR');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { source_term: 'Schreibwort neu' });
  assert.deepEqual(zeileAus(await eintraege(G.FR, '&search=Schreibwort'), 'Schreibwort neu').hinweise, []);
});
await pruefe('Verwerfen: Hinweis weg, Eintrag unverändert, erneutes Einspielen holt ihn nicht zurück', async () => {
  const h = zeileAus(await eintraege(G.FR, '&search=Fachschreibung'), 'Fachschreibung').hinweise[0];
  assert.equal((await api('POST', `/api/glossaries/${G.IT}/hinweise/${h.id}/verwerfen`)).status, 404, 'fremdes Glossar');
  const r = await api('POST', `/api/glossaries/${G.FR}/hinweise/${h.id}/verwerfen`);
  assert.equal(r.status, 200);
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/hinweise/${h.id}/verwerfen`)).status, 404, 'schon verworfen');
  const zeile = zeileAus(await eintraege(G.FR, '&search=Fachschreibung'), 'Fachschreibung');
  assert.deepEqual(zeile.hinweise, []);
  assert.equal(zeile.target_term, 'Graphie');
  einspielen(GUT, '--ausfuehren');
  assert.deepEqual(zeileAus(await eintraege(G.FR, '&search=Fachschreibung'), 'Fachschreibung').hinweise, []);
  const von = await q('SELECT verworfen_von FROM glossary_hints WHERE id = $1', [h.id]);
  assert.equal(von.rows[0].verworfen_von, 'Testperson');
});

console.log('\nUnnötige Zeilen');
await neuAufsetzen();
await lege('FR', 'Ueberall weg', 'partout');
await lege('FR', 'Nur hier weg', 'ici');
await lege('FR', 'Dazu falsch', 'mauvais');
await lege('FR', 'Dazu Schreibung', 'Majuscule');
await lege('FR', 'Nur Schreibung', 'Graphie');
await lege('FR', 'Nur falsch', 'faux');
await lege('FR', 'Unmarkiert', 'intact');
await lege('IT', 'Nur hier weg', 'di proposito');
const UNNOETIG_DATEI = datei('unnoetig.tsv', [
  'FR\tUeberall weg\tpartout\tunnoetig_ueberall\thoch\t\tDeepL liefert dasselbe.\tmechanisch',
  'FR\tNur hier weg\tici\tunnoetig_hier\tmittel\t\tNur Groß/klein.\tmechanisch',
  'FR\tDazu falsch\tmauvais\tunnoetig_hier\thoch\t\tDeepL liefert dasselbe.\tmechanisch',
  'FR\tDazu falsch\tmauvais\tfalsch\thoch\tbon\tDas Wort ist falsch.\tfachlich',
  'FR\tDazu Schreibung\tMajuscule\tunnoetig_hier\thoch\t\tDeepL liefert dasselbe.\tmechanisch',
  'FR\tDazu Schreibung\tMajuscule\tschreibung\tmittel\tmajuscule\tGroßer Anfang.\tmechanisch',
  'FR\tNur Schreibung\tGraphie\tschreibung\tmittel\tgraphie\tGroßer Anfang.\tmechanisch',
  'FR\tNur falsch\tfaux\tfalsch\tmittel\tvrai\tDas Wort ist falsch.\tfachlich',
]);
await pruefe('Werkzeug nimmt die neuen Kategorien an, die Datenbank eine erfundene nicht', async () => {
  const r = einspielen(UNNOETIG_DATEI, '--ausfuehren');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes('Neu: 8, aktualisiert: 0, ohne passenden Eintrag: 0'), r.stdout);
  await assert.rejects(q(`INSERT INTO glossary_hints (glossary_id, source_term, target_term, kategorie, gewissheit, quelle, grund)
    VALUES ($1, 'x', 'y', 'unnoetig_erfunden', 'hoch', 'mechanisch', 'z')`, [G.FR]), /kategorie_check/);
});
await pruefe('Glossarliste: Unnötig zählt getrennt und nicht als Hinweis', async () => {
  const s = (await api('GET', '/api/glossaries/stats')).body;
  const fr = s.find((g) => g.id === G.FR);
  assert.equal(Number(fr.unnoetig), 4);
  assert.equal(Number(fr.unnoetig_ueberall), 1);
  assert.equal(Number(fr.hinweise), 2, 'nur die beiden falschen');
  assert.equal(Number(fr.hinweise_schreibung), 2, 'reine Schreibung und Schreibung neben unnötig');
  const it = s.find((g) => g.id === G.IT);
  assert.equal(Number(it.unnoetig), 0);
});
await pruefe('Filter: beide Stufen zusammen und einzeln, die Voreinstellung blendet sie aus', async () => {
  const zeilen = async (x) => (await eintraege(G.FR, x)).body.entries.map((e) => e.source_term).sort();
  assert.deepEqual(await zeilen('&hinweis=1&hinweis_kategorie=unnoetig'), ['Dazu Schreibung', 'Dazu falsch', 'Nur hier weg', 'Ueberall weg'].sort());
  assert.deepEqual(await zeilen('&hinweis=1&hinweis_kategorie=unnoetig_ueberall'), ['Ueberall weg']);
  assert.deepEqual(await zeilen('&hinweis=1&hinweis_kategorie=unnoetig_hier'), ['Dazu Schreibung', 'Dazu falsch', 'Nur hier weg'].sort());
  assert.deepEqual(await zeilen('&hinweis=1&hinweis_kategorie=unnoetig&hinweis_gewissheit=mittel'), ['Nur hier weg']);
  assert.deepEqual(await zeilen('&hinweis=1&hinweis_kategorie=ohne_schreibung'), ['Dazu falsch', 'Nur falsch'].sort());
  assert.equal((await eintraege(G.FR, '&hinweis_kategorie=unnoetig_erfunden')).status, 400);
  assert.equal((await eintraege(G.IT, '&hinweis=1&hinweis_kategorie=unnoetig')).body.total, 0);
});
await pruefe('Liste: Unnötig steht hinter den echten Hinweisen', async () => {
  const r = (await eintraege(G.FR, '&hinweis=1&hinweis_kategorie=')).body.entries.map((e) => e.source_term);
  const letzte = (b) => r.indexOf(b);
  // „Nur falsch“ hat die schwächere Gewissheit und steht trotzdem vorn: Ohne Rang gewänne „Ueberall weg“ über die höhere Gewissheit.
  assert.ok(letzte('Nur falsch') < letzte('Ueberall weg'), r.join(', '));
  assert.ok(letzte('Dazu falsch') < letzte('Nur hier weg'), r.join(', '));
});
await pruefe('Filter-Zahlen: Voreinstellung ohne Unnötig, je Kategorie mit Zeilen', async () => {
  const f = (await eintraege(G.FR)).body.hinweis_facetten;
  const summe = f.find((x) => x.kategorie === null && x.gewissheit === null);
  assert.equal(summe.ohne_schreibflut, 2);
  assert.equal(summe.zeilen, 6);
  assert.equal(f.find((x) => x.kategorie === 'unnoetig_hier' && x.gewissheit === null).zeilen, 3);
  assert.equal(f.find((x) => x.kategorie === 'unnoetig_hier' && x.gewissheit === null).ohne_schreibflut, 0);
});
await pruefe('eine Markierung wirkt nicht: die Zeile bleibt, DeepL bekommt sie weiter', async () => {
  aufrufe.glossar.length = 0;
  const r = await api('POST', `/api/glossaries/${G.FR}/sync-deepl`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const an = aufrufe.glossar[0];
  assert.ok(JSON.stringify(an).includes('partout'), JSON.stringify(an));
});
await pruefe('Übersetzung ändern erledigt die Markierung, Verwerfen auch, erneutes Einspielen holt sie nicht zurück', async () => {
  const uw = zeileAus(await eintraege(G.FR, '&search=Ueberall'), 'Ueberall weg');
  assert.equal(uw.hinweise[0].kategorie, 'unnoetig_ueberall');
  const nh = zeileAus(await eintraege(G.FR, '&search=Nur%20hier'), 'Nur hier weg');
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/hinweise/${nh.hinweise[0].id}/verwerfen`)).status, 200);
  assert.equal((await api('PUT', `/api/glossaries/${G.FR}/entries/${uw.id}`, { target_term: 'partout, neu' })).status, 200);
  einspielen(UNNOETIG_DATEI, '--ausfuehren');
  assert.deepEqual(zeileAus(await eintraege(G.FR, '&search=Ueberall'), 'Ueberall weg').hinweise, []);
  assert.deepEqual(zeileAus(await eintraege(G.FR, '&search=Nur%20hier'), 'Nur hier weg').hinweise, []);
  assert.equal(zeileAus(await eintraege(G.FR, '&search=Nur%20hier'), 'Nur hier weg').target_term, 'ici');
  assert.equal(Number((await api('GET', '/api/glossaries/stats')).body.find((g) => g.id === G.FR).unnoetig), 2);
});

console.log('\nBeim Befüllen: die Markierung bleibt');
await neuAufsetzen();
const hinweiseZu = async (begriff, g = G.FR) => (await q(
  `SELECT kategorie, gewissheit, grund FROM glossary_hints WHERE glossary_id = $1 AND source_term = $2 AND verworfen_am IS NULL`, [g, begriff])).rows;
const zeileVon = async (begriff, g = G.FR) => (await q(
  'SELECT * FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2', [g, begriff])).rows[0];
antwortVonDeepL = (t) => (t === 'Gleichwort' ? 'pareil' : t === 'Kleinwort' ? 'Petit' : t === 'Strichwort' ? 'mot-trait' : 'autre chose');
await pruefe('leere Bestandszeile bekommt eine Übersetzung wie DeepL: gespeichert und als unnötig markiert', async () => {
  await legeLeer('FR', 'Gleichwort');
  const z = await zeileVon('Gleichwort');
  assert.equal(z.target_term, null);
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { target_term: 'pareil' });
  assert.equal(r.status, 200, r.text);
  const nachher = await zeileVon('Gleichwort');
  assert.equal(nachher.target_term, 'pareil');
  assert.equal(nachher.approved, true);
  const h = await hinweiseZu('Gleichwort');
  assert.equal(h.length, 1);
  assert.equal(h[0].kategorie, 'unnoetig_hier');
  assert.equal(h[0].gewissheit, 'niedrig', 'hoch trägt nur, was auch im Satz bestätigt ist');
});
await pruefe('nur Groß/klein oder Schreibzeichen: ebenfalls markiert', async () => {
  await legeLeer('FR', 'Kleinwort');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${(await zeileVon('Kleinwort')).id}`, { target_term: 'petit' });
  assert.ok((await hinweiseZu('Kleinwort'))[0].grund.includes('nur die Schreibung'));
  await legeLeer('FR', 'Strichwort');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${(await zeileVon('Strichwort')).id}`, { target_term: 'mot trait' });
  assert.equal((await hinweiseZu('Strichwort')).length, 1);
});
await pruefe('andere Übersetzung als DeepL: keine Markierung', async () => {
  await legeLeer('FR', 'Eigenwort');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${(await zeileVon('Eigenwort')).id}`, { target_term: 'mot à nous' });
  assert.equal((await zeileVon('Eigenwort')).target_term, 'mot à nous');
  assert.deepEqual(await hinweiseZu('Eigenwort'), []);
});
await pruefe('der Vergleich läuft ohne Glossar und nur bei geändertem Text', async () => {
  const z = await zeileVon('Gleichwort');
  await q(`UPDATE glossaries SET deepl_glossary_id = 'liegt-dort' WHERE id = $1`, [G.FR]);
  aufrufe.uebersetzen.length = 0;
  await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { target_term: 'pareil' });
  assert.equal(aufrufe.uebersetzen.length, 0, 'unveränderter Text');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { context: 'nur Kontext' });
  assert.equal(aufrufe.uebersetzen.length, 0, 'nur Kontext');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { target_term: 'neu formuliert' });
  assert.equal(aufrufe.uebersetzen.length, 1);
  assert.equal(aufrufe.uebersetzen[0].optionen.glossary, undefined, 'ohne Glossar');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { target_term: 'pareil' });
  await q(`UPDATE glossaries SET deepl_glossary_id = NULL WHERE id = $1`, [G.FR]);
});
await pruefe('ein Zeichen zwischen Ziffern ist Teil des Werts: 1,5 m ist nicht 15 m', async () => {
  const vorher = antwortVonDeepL;
  antwortVonDeepL = () => '15 m';
  await lege('FR', 'Wertwort', '1,5 m');
  assert.deepEqual(await hinweiseZu('Wertwort'), []);
  antwortVonDeepL = () => '1.5 m';
  await lege('FR', 'Wertwort zwei', '1,5 m');
  assert.equal((await hinweiseZu('Wertwort zwei')).length, 1, 'nur das Dezimalzeichen weicht ab');
  antwortVonDeepL = vorher;
});
await pruefe('derselbe Text neu eingetragen: Die Markierung gilt wieder nur als am Wort geprüft', async () => {
  const vorher = antwortVonDeepL;
  antwortVonDeepL = () => 'retour';
  await lege('FR', 'Rueckwort', 'anders gesetzt');
  await q(`INSERT INTO glossary_hints (glossary_id, source_term, target_term, kategorie, gewissheit, quelle, grund)
           VALUES ($1, 'Rueckwort', 'retour', 'unnoetig_hier', 'hoch', 'satztest', 'Im Satz bestätigt.')`, [G.FR]);
  const z = await zeileVon('Rueckwort');
  assert.equal((await api('PUT', `/api/glossaries/${G.FR}/entries/${z.id}`, { target_term: 'retour' })).status, 200);
  antwortVonDeepL = vorher;
  const h = (await q(`SELECT quelle, gewissheit FROM glossary_hints WHERE source_term = 'Rueckwort'`)).rows;
  assert.deepEqual(h, [{ quelle: 'mechanisch', gewissheit: 'niedrig' }]);
});
await pruefe('neuer Begriff über das Plus wird genauso geprüft', async () => {
  await lege('FR', 'Gleichwort neu', 'autre chose');
  assert.equal((await hinweiseZu('Gleichwort neu')).length, 1);
});
await pruefe('DeepL fällt aus: gespeichert, keine Markierung, kein Fehler', async () => {
  const vorher = antwortVonDeepL;
  antwortVonDeepL = () => { throw new Error('DeepL weg'); };
  await legeLeer('FR', 'Ausfallwort');
  const r = await api('PUT', `/api/glossaries/${G.FR}/entries/${(await zeileVon('Ausfallwort')).id}`, { target_term: 'panne' });
  antwortVonDeepL = vorher;
  assert.equal(r.status, 200, r.text);
  assert.equal((await zeileVon('Ausfallwort')).target_term, 'panne');
  assert.deepEqual(await hinweiseZu('Ausfallwort'), []);
});
await pruefe('kein Vergleich bei Channel-Werten, bei der Schutzkette und außerhalb der Familie', async () => {
  aufrufe.uebersetzen.length = 0;
  const vorher = antwortVonDeepL;
  // DeepL liefert hier genau unseren Text: Ohne die Schranke wäre das „wie DeepL“ und damit markiert.
  antwortVonDeepL = () => 'IRC';
  await lege('FR', 'CRI', 'IRC');
  antwortVonDeepL = vorher;
  assert.deepEqual(await hinweiseZu('CRI'), []);
  const fremd = await api('POST', `/api/glossaries/${G.EN_FR}/entries`, { source_term: 'Fremdwort', target_term: 'autre chose' });
  assert.equal(fremd.status, 201, fremd.text);
  assert.deepEqual(await hinweiseZu('Fremdwort', G.EN_FR), []);
  await lege('FR', 'Kanalwort', 'canal');
  const k = await zeileVon('Kanalwort');
  await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPA', 'galaxie')`, [k.id]);
  aufrufe.uebersetzen.length = 0;
  await api('PUT', `/api/glossaries/${G.FR}/entries/${k.id}`, { target_term: 'autre chose' });
  assert.equal(aufrufe.uebersetzen.length, 0);
  assert.deepEqual(await hinweiseZu('Kanalwort'), []);
});
await pruefe('Eintrag entfernen: Zeile weg, andere Sprache unberührt, Markierung verbraucht, Version und Cache wie jede Änderung', async () => {
  await lege('FR', 'Leerwort', 'vide');
  await lege('IT', 'Leerwort', 'vuoto');
  await segment('Ein Leerwort im Text', 'FR', 0);
  await segment('Kein Treffer hier', 'FR', 0);
  const z = await zeileVon('Leerwort');
  const v = (await q('SELECT version FROM glossaries WHERE id = $1', [G.FR])).rows[0].version;
  const vIt = (await q('SELECT version FROM glossaries WHERE id = $1', [G.IT])).rows[0].version;
  const veraltet = await api('POST', `/api/glossaries/${G.FR}/entries/${z.id}/entfernen`, { stand: 'längst anders' });
  assert.equal(veraltet.status, 409, 'gezeigter Text ist nicht mehr der gespeicherte');
  assert.equal((await zeileVon('Leerwort')).target_term, 'vide');
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/entries/${z.id}/entfernen`)).status, 409, 'ohne Stand');
  await q(`INSERT INTO glossary_hints (glossary_id, source_term, target_term, kategorie, gewissheit, quelle, grund) VALUES ($1, 'Leerwort', 'vide', 'unnoetig_hier', 'hoch', 'satztest', 'Im Satz bestätigt.')`, [G.FR]);
  const r = await api('POST', `/api/glossaries/${G.FR}/entries/${z.id}/entfernen`, { stand: 'vide' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'entfernt');
  assert.deepEqual(await hinweiseZu('Leerwort'), [], 'die Markierung ist verbraucht');
  assert.equal(await zeileVon('Leerwort'), undefined, 'die Zeile ist weg, nicht leer');
  assert.equal((await zeileVon('Leerwort', G.IT)).target_term, 'vuoto', 'andere Sprache unberührt');
  assert.equal((await q('SELECT version FROM glossaries WHERE id = $1', [G.FR])).rows[0].version, v + 1);
  assert.equal((await q('SELECT version FROM glossaries WHERE id = $1', [G.IT])).rows[0].version, vIt);
  const stale = (await q(`SELECT source_text, is_stale FROM segments WHERE target_lang = 'FR'`)).rows;
  assert.equal(stale.find((s) => s.source_text.includes('Leerwort')).is_stale, true);
  assert.equal(stale.find((s) => s.source_text.includes('Kein Treffer')).is_stale, false);
  const verlauf = await q(`SELECT action, old_value, new_value FROM glossary_entry_history WHERE entry_id = $1 ORDER BY changed_at DESC LIMIT 1`, [z.id]);
  assert.deepEqual(verlauf.rows[0], { action: 'deleted', old_value: 'vide', new_value: null });
});
await pruefe('Eintrag entfernen: DeepL bekommt die Zeile nicht mehr, die andere Sprache schon', async () => {
  aufrufe.glossar.length = 0;
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/sync-deepl`)).status, 200);
  assert.ok(!aufrufe.glossar[0].tsv.includes('Leerwort'));
  aufrufe.glossar.length = 0;
  assert.equal((await api('POST', `/api/glossaries/${G.IT}/sync-deepl`)).status, 200);
  assert.ok(aufrufe.glossar[0].tsv.includes('Leerwort'));
});
await pruefe('Eintrag entfernen: abgelehnt bei Channel-Wert und Schutzkette, zweimal ergibt 404, fremdes Glossar 404', async () => {
  const k = await zeileVon('Kanalwort');
  const r = await api('POST', `/api/glossaries/${G.FR}/entries/${k.id}/entfernen`, { stand: 'autre chose' });
  assert.equal(r.status, 409);
  assert.ok(r.body.error.includes('Channel'));
  assert.notEqual(await zeileVon('Kanalwort'), undefined);
  const c = await zeileVon('CRI');
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/entries/${c.id}/entfernen`, { stand: 'IRC' })).status, 409);
  assert.equal((await zeileVon('CRI')).target_term, 'IRC');
  await lege('FR', 'Einmalwort', 'une fois');
  const e = await zeileVon('Einmalwort');
  assert.equal((await api('POST', `/api/glossaries/${G.IT}/entries/${e.id}/entfernen`, { stand: 'une fois' })).status, 404);
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/entries/${e.id}/entfernen`, { stand: 'une fois' })).status, 200);
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/entries/${e.id}/entfernen`, { stand: 'une fois' })).status, 404);
});
await pruefe('Eintrag entfernen an einer leeren Zeile: 409, keine Verlaufszeile, die Zeile bleibt', async () => {
  const leer = await legeLeer('FR', 'Bestandsrest');
  // Seit Migration 037 vermerkt schon das Anlegen der leeren Zeile einen Verlauf; der abgewiesene Klick darf keinen dazuschreiben.
  const verlauf = async () => (await q(`SELECT count(*)::int AS n FROM glossary_entry_history WHERE entry_id = $1`, [leer.id])).rows[0].n;
  const vorher = await verlauf();
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/entries/${leer.id}/entfernen`)).status, 409);
  assert.notEqual(await zeileVon('Bestandsrest'), undefined);
  assert.equal(await verlauf(), vorher);
});
await pruefe('Eintrag entfernen bei Dublette: nur diese Zeile fällt weg, der Begriff bleibt mit seiner anderen Zeile', async () => {
  await lege('FR', 'Dublett', 'un');
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source) VALUES ($1, 'DUBLETT', 'deux', TRUE, 'manual')`, [G.FR]);
  const z = await zeileVon('Dublett');
  const r = await api('POST', `/api/glossaries/${G.FR}/entries/${z.id}/entfernen`, { stand: 'un' });
  assert.equal(r.body.status, 'entfernt');
  assert.equal(await zeileVon('Dublett'), undefined);
  assert.equal((await zeileVon('DUBLETT')).target_term, 'deux');
});
await pruefe('wird die entfernte Abweichung neu angelegt, gilt wieder der Vergleich', async () => {
  antwortVonDeepL = () => 'vide';
  assert.equal((await lege('FR', 'Leerwort', 'vide')).status, 201);
  assert.equal((await hinweiseZu('Leerwort')).length, 1);
  antwortVonDeepL = (t) => t;
});

console.log('\nEine neue Prüfdatei ersetzt die Markierungen „unnötig“');
await neuAufsetzen();
antwortVonDeepL = (t) => t;
await lege('FR', 'Ungeprueft', 'non vérifié');
await lege('FR', 'Abgelehnt', 'refusé');
await lege('IT', 'Drei', 'tre');
await pruefe('Vorbedingung: ein Mensch verwirft eine Markierung', async () => {
  const d = datei('verwerfen.tsv', ['FR\tAbgelehnt\trefusé\tunnoetig_hier\thoch\t\tIm Satz bestätigt.\tsatztest']);
  assert.equal(einspielen(d, '--ausfuehren').status, 0);
  const h = zeileAus(await eintraege(G.FR, '&search=Abgelehnt'), 'Abgelehnt').hinweise[0];
  assert.equal((await api('POST', `/api/glossaries/${G.FR}/hinweise/${h.id}/verwerfen`)).status, 200);
});
await pruefe('eine Datei „ersetzt unnötig“: Widerlegtes fällt weg, Verworfenes bleibt, fremde Kategorien werden abgelehnt', async () => {
  const anzahl = async (begriff) => (await q(`SELECT count(*)::int AS n FROM glossary_hints WHERE source_term = $1`, [begriff])).rows[0].n;
  await lege('FR', 'Widerlegt', 'contredit');
  await lege('FR', 'Falschfrei', 'faux');
  const erst = datei('erst.tsv', [
    'FR\tWiderlegt\tcontredit\tunnoetig_hier\tniedrig\t\tAm Wort.\tmechanisch',
    'FR\tFalschfrei\tfaux\tfalsch\thoch\t\tFalsch.\tfachlich',
  ]);
  assert.equal(einspielen(erst, '--ausfuehren').status, 0);
  const falsch = einspielen(erst, '--ersetzt-unnoetig', '--ausfuehren');
  assert.equal(falsch.status, 1);
  assert.ok(falsch.stderr.includes('nur Markierungen'), falsch.stderr);
  const leer = einspielen(datei('leer2.tsv', []), '--ersetzt-unnoetig', '--ausfuehren');
  assert.equal(leer.status, 1, 'eine leere Datei löscht nichts');
  assert.equal(await anzahl('Widerlegt'), 1);
  assert.equal(einspielen(datei('it.tsv', ['IT\tDrei\ttre\tunnoetig_hier\tniedrig\t\tAm Wort.\tmechanisch']), '--ausfuehren').status, 0);
  const luecke = einspielen(datei('nurfr.tsv', ['FR\tUngeprueft\tnon vérifié\tunnoetig_hier\tniedrig\t\tAm Wort.\tmechanisch']), '--ersetzt-unnoetig', '--ausfuehren');
  assert.equal(luecke.status, 1, luecke.stdout + luecke.stderr);
  assert.ok(luecke.stderr.includes('IT'), luecke.stderr);
  assert.equal(await anzahl('Widerlegt'), 1, 'zurückgerollt');
  const neu = datei('neu2.tsv', [
    'FR\tUngeprueft\tnon vérifié\tunnoetig_hier\tniedrig\t\tAm Wort.\tmechanisch',
    'IT\tDrei\ttre\tunnoetig_hier\tniedrig\t\tAm Wort.\tmechanisch',
  ]);
  const r = einspielen(neu, '--ersetzt-unnoetig', '--ausfuehren');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.stdout.includes('Widerlegt und entfernt:'), r.stdout);
  assert.equal(await anzahl('Widerlegt'), 0);
  assert.equal(await anzahl('Ungeprueft'), 1);
  assert.equal(await anzahl('Falschfrei'), 1, 'andere Kategorie bleibt');
  assert.equal(await anzahl('Abgelehnt'), 1, 'Verwerfen eines Menschen bleibt');
});

console.log('\nDeploy: Sync-Stand');
await pruefe('ein weiterer Migrationslauf lässt eine offene Änderung offen', async () => {
  await q(`UPDATE glossaries SET deepl_glossary_id = 'g-offen', version = 7, synced_version = 5 WHERE id = $1`, [G.FR]);
  await q(`UPDATE glossaries SET deepl_glossary_id = 'g-alt', version = 3, synced_version = 0 WHERE id = $1`, [G.IT]);
  await migriere();
  const r = await q('SELECT id, version, synced_version FROM glossaries WHERE id = ANY($1)', [[G.FR, G.IT]]);
  const fr = r.rows.find((z) => z.id === G.FR);
  const it = r.rows.find((z) => z.id === G.IT);
  assert.equal(fr.synced_version, 5, 'offene Änderung bleibt offen');
  assert.equal(it.synced_version, 3, 'nur der Altbestand ohne Stand wird gesetzt');
});

console.log('\nOberfläche: Texte');
await pruefe('alle sechs Sprachen tragen dieselben Schlüssel', async () => {
  const sammeln = (o, p = '') => Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' ? sammeln(v, `${p}${k}.`) : [`${p}${k}`.replace(/_(one|few|many|other)$/, '')]);
  const lade = (l) => JSON.parse(readFileSync(join(WURZEL, 'client', 'src', 'i18n', 'locales', l, 'glossary.json'), 'utf-8'));
  const de = [...new Set(sammeln(lade('de')))].sort();
  for (const l of ['en', 'it', 'fr', 'hu', 'sk']) {
    assert.deepEqual([...new Set(sammeln(lade(l)))].sort(), de, l);
  }
});
await pruefe('jeder im GlossaryManager verwendete Schlüssel existiert', async () => {
  const quelle = readFileSync(join(WURZEL, 'client', 'src', 'components', 'GlossaryManager.tsx'), 'utf-8');
  const de = JSON.parse(readFileSync(join(WURZEL, 'client', 'src', 'i18n', 'locales', 'de', 'glossary.json'), 'utf-8'));
  const fehlt = [...new Set([...quelle.matchAll(/\bt\('(glossaries\.[\w.]+)'/g)].map((m) => m[1]))].filter((k) => {
    const teile = k.split('.');
    const blatt = teile.pop();
    const knoten = teile.reduce((o, t) => o?.[t], de);
    return !(knoten && (knoten[blatt] !== undefined || knoten[`${blatt}_other`] !== undefined));
  });
  assert.deepEqual(fehlt, []);
});
await pruefe('jede Kategorie, Gewissheit und Quelle hat in allen sechs Sprachen einen Text', async () => {
  for (const l of ['de', 'en', 'it', 'fr', 'hu', 'sk']) {
    const h = JSON.parse(readFileSync(join(WURZEL, 'client', 'src', 'i18n', 'locales', l, 'glossary.json'), 'utf-8')).glossaries.hinweis;
    for (const k of ['falsch', 'sprachlich', 'schreibung', 'zeichen', 'satz', 'wert', 'mehrdeutig', 'dublette', 'eigenname', 'unuebersetzt', 'unnoetig_ueberall', 'unnoetig_hier']) assert.ok(h.kategorie[k], `${l} ${k}`);
    for (const g of ['hoch', 'mittel', 'niedrig']) assert.ok(h.gewissheit[g], `${l} ${g}`);
    for (const q2 of ['mechanisch', 'fachlich', 'satztest']) assert.ok(h.quelle[q2], `${l} ${q2}`);
  }
});
await pruefe('leere Zeilen blinken nicht mehr', async () => {
  const css = readFileSync(join(WURZEL, 'client', 'src', 'index.css'), 'utf-8');
  const tsx = readFileSync(join(WURZEL, 'client', 'src', 'components', 'GlossaryManager.tsx'), 'utf-8');
  assert.ok(!css.includes('glossar-blinkt') && !tsx.includes('glossar-blinkt'));
  assert.ok(!css.includes('glossar-rot-blinken'));
});
await pruefe('der Knopf „Neues Glossar“ führt zum Dialog, alle Sprachen nennen die Zahl der vorbefüllten Begriffe', async () => {
  const tsx = readFileSync(join(WURZEL, 'client', 'src', 'components', 'GlossaryManager.tsx'), 'utf-8');
  assert.ok(tsx.includes('NeuesGlossarDialog') && tsx.includes('/api/glossaries/zielsprachen') && tsx.includes("source_lang: 'DE'"));
  for (const l of ['de', 'en', 'it', 'fr', 'hu', 'sk']) {
    const neu = JSON.parse(readFileSync(join(WURZEL, 'client', 'src', 'i18n', 'locales', l, 'glossary.json'), 'utf-8')).glossaries.neu;
    assert.ok(neu.angelegt.includes('{{anzahl}}'), l);
  }
});
await pruefe('die Oberfläche kennt „DeepL entscheidet“ und die Rückfrage über alle Glossare nicht mehr, in keiner Sprache', async () => {
  const tsx = readFileSync(join(WURZEL, 'client', 'src', 'components', 'GlossaryManager.tsx'), 'utf-8');
  for (const w of ['deeplEntscheidet', 'bestaetigung_noetig', 'nur_diese_zeile', '/leeren']) assert.ok(!tsx.includes(w), w);
  assert.ok(tsx.includes("opt === 'zu_pflegen' && stats.zu_pflegen === 0 && !active"), 'Filter nur, wenn es solche Zeilen gibt');
  for (const l of ['de', 'en', 'it', 'fr', 'hu', 'sk']) {
    const roh = readFileSync(join(WURZEL, 'client', 'src', 'i18n', 'locales', l, 'glossary.json'), 'utf-8');
    for (const w of ['deeplEntscheidet', 'nurDieseZeile', 'leerenTitle']) assert.ok(!roh.includes(w), `${l} ${w}`);
    assert.ok(JSON.parse(roh).glossaries.hinweis.entfernen, `${l}: Gegenprobe, der neue Text ist da`);
  }
});
await pruefe('jede neue Server-Meldung steht im Fehlerkatalog', async () => {
  const { ERROR_CATALOG } = await laden('i18n', 'errorCatalog.js');
  for (const m of ['Für dieses Sprachpaar gibt es schon ein Glossar', 'Unbekannter Sprachcode', 'Dieser Kennwert bleibt stehen', 'Der Begriff ist zu lang', 'Der neue Begriff ist schon übersetzt', 'Eine leere Zeile kann nicht freigegeben werden',
    'Zuerst die Übersetzung des Begriffs eintragen', 'Den Begriff gibt es in diesem Glossar schon', 'Der Begriff darf nicht leer sein',
    'Die Übersetzung darf nicht leer sein', 'Begriff und Übersetzung getrennt ändern', 'DeepL hat nicht geantwortet']) {
    assert.ok(ERROR_CATALOG[m]?.sk, m);
  }
});

// Eine Artikelbezeichnung beginnt in jeder Sprache groß (Thomas, 05.11.2026).
await pruefe('Namensanfang: groß wie die Quelle, eine Zahl zählt wie groß, klein bleibt klein, Markup bleibt', async () => {
  const { anfangWieQuelle } = await laden('services', 'anfang-gross.js');
  for (const [q, z, soll] of [
    ['Seilabhängung für Profil', 'lanové zavesenie pre profil', 'Lanové zavesenie pre profil'],
    ['10er Set GU10', 'sada 10 ks GU10', 'Sada 10 ks GU10'],
    ['eloxiert', 'anodizovaný', 'anodizovaný'],
    ['Profil', 'Profil', 'Profil'],
    ['LED Profil', '„profil LED“', '„Profil LED“'],
    ['<b>Profil</b>', '<b>profil</b>', '<b>profil</b>'],
    ['123', '123', '123'],
    ['', 'text', 'text'],
  ]) assert.equal(anfangWieQuelle(q, z), soll, q);
});
await pruefe('Namensanfang im Weg der Artikeldaten: DeepL liefert klein, ausgeliefert und im Cache steht groß', async () => {
  const vorher = antwortVonDeepL;
  antwortVonDeepL = () => 'profil klein';
  try {
    const r = await api('POST', '/api/batch-translate', { segments: [{ id: 'a', text: 'Anfangstest Profilname' }], sourceLang: 'DE', targetLangs: ['FR'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.translations.a.FR, 'Profil klein');
    const c = await q(`SELECT translated_text FROM segments WHERE source_text = 'Anfangstest Profilname' AND target_lang = 'FR'`);
    assert.equal(c.rows[0].translated_text, 'Profil klein');
  } finally {
    antwortVonDeepL = vorher;
  }
});

// Was im deutschen Namen in Blockbuchstaben steht, steht auch in der Übersetzung so (Thomas, 05.11.2026).
await pruefe('Blockwörter: Wert wird großgeschrieben, nur wenn der Begriff in Blockbuchstaben in der Quelle steht', async () => {
  const { blockWieGlossar, nurBlockEintraege } = await laden('services', 'block-woerter.js');
  const e = nurBlockEintraege([
    { source_term: 'SET', target_term: 'SADA' }, { source_term: 'STK', target_term: 'SZT.' }, { source_term: 'AUFBAU', target_term: 'POVRCHOVÁ MONTÁŽ' },
    { source_term: 'FLAT', target_term: 'FLAT' }, { source_term: 'Set', target_term: 'sada' }, { source_term: 'Cover', target_term: 'COVER' }, { source_term: 'MALE', target_term: 'samec' },
  ]);
  assert.deepEqual(e.map((x) => x.source_term), ['AUFBAU', 'FLAT', 'SET', 'STK'], 'normal geschriebene Begriffe und Werte zählen nicht');
  for (const [q, z, soll] of [
    ['Montageclip SET', 'Sada montážních spon', 'SADA montážních spon'],
    ['SET mit Clip', 'mała sada, sada', 'mała SADA, SADA'],
    ['DIVE12 FLAT', 'DIVE12 flat', 'DIVE12 FLAT'],
    ['Packung 2 STK', 'balení 2 szt.', 'balení 2 SZT.'],
    ['AUFBAU-Profil', 'profil povrchová montáž', 'profil POVRCHOVÁ MONTÁŽ'],
    ['AUFBAU-Profil', 'profil pro povrchovou montáž', 'profil pro povrchovou montáž'],
    ['Set mit Clip', 'Sada spon', 'Sada spon'],
    ['SETZLING', 'Sada spon', 'Sada spon'],
    ['Montageclip SET', 'Sadařství', 'Sadařství'],
    ['Montageclip SET', '<b>sada</b>', '<b>sada</b>'],
  ]) assert.equal(blockWieGlossar(q, z, e), soll, q);
  // Satzzeichen im Begriff oder Wert: Bis 05.11.2026 warf ein Bindestrich hier einen Fehler, und der ganze Lauf fiel mit 500 aus.
  const z = nurBlockEintraege([
    { source_term: 'WIFI', target_term: 'WI-FI' }, { source_term: 'MINI-MAXI-ECK', target_term: 'MINI-MAXI-ROH' }, { source_term: 'RGB+W', target_term: 'RGB+W' },
    { source_term: 'A/B (C)', target_term: 'A/B (C).' }, { source_term: 'UP&DOWN', target_term: 'UP&DOWN' },
  ]);
  for (const [q, t, soll] of [
    ['TUYA WIFI Spot', 'TUYA Wi-Fi spot', 'TUYA WI-FI spot'],
    ['für MINI-MAXI-ECK', 'pre mini-maxi-roh', 'pre MINI-MAXI-ROH'],
    ['Band RGB+W', 'pás rgb+w', 'pás RGB+W'],
    ['Teil A/B (C)', 'díl a/b (c).', 'díl A/B (C).'],
    ['UP&DOWN 2xGU10', 'up&down 2xGU10', 'UP&DOWN 2xGU10'],
  ]) assert.equal(blockWieGlossar(q, t, z), soll, q);
});
await pruefe('Blockwörter im Weg der Artikeldaten: ausgeliefert und im Cache steht der Wert in Blockbuchstaben', async () => {
  await lege('FR', 'SET', 'KIT');
  await lege('FR', 'WIFI', 'WI-FI');
  const vorher = antwortVonDeepL;
  antwortVonDeepL = () => 'kit de clips';
  try {
    const r = await api('POST', '/api/batch-translate', { segments: [{ id: 'a', text: 'Montageclip SET Blocktest' }, { id: 'b', text: 'Montageclip Set Blocktest' }], sourceLang: 'DE', targetLangs: ['FR'] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.translations.a.FR, 'KIT de clips');
    assert.equal(r.body.translations.b.FR, 'Kit de clips', 'Gegenprobe: normal geschrieben bleibt normal');
    const w = await api('POST', '/api/batch-translate', { segments: [{ id: 'w', text: 'Spot WIFI Blocktest' }], sourceLang: 'DE', targetLangs: ['FR'] });
    assert.equal(w.status, 200, 'Begriff mit Bindestrich im Wert: ' + w.text);
    const c = await q(`SELECT translated_text FROM segments WHERE source_text = 'Montageclip SET Blocktest' AND target_lang = 'FR'`);
    assert.equal(c.rows[0].translated_text, 'KIT de clips');
  } finally {
    antwortVonDeepL = vorher;
  }
});

// Phase 3: Die Entscheidungsliste.
let listeNr = 0;
const listeDatei = (...z) => datei(`liste-${++listeNr}.tsv`, z, 'entry_id\tfolge\tdeutsch\teintrag\tneu');
const listeLauf = (...a) => spawnSync(process.execPath, [dist('scripts', 'glossar-nur-abweichungen.js'), ...a], { cwd: WURZEL, env: process.env, encoding: 'utf-8' });
await neuAufsetzen();
await lege('FR', 'Listenwort', 'mot liste');
await lege('FR', 'Wegwort', 'mot parti');
await lege('FR', 'Anderes', 'reste');
await legeLeer('FR', 'Leerwort');
await segment('Das Listenwort im Satz');
await segment('Das Wegwort im Satz');
await segment('Das Leerwort im Satz');
await segment('Das Anderes im Satz');
const listeZeile = async (b, folge, neu = '') => { const z = await zeileIn(b, 'FR'); return `${z.id}\t${folge}\t${b}\t${z.target_term ?? ''}\t${neu}`; };
await pruefe('die Liste rechnet ohne --ausfuehren und ändert nichts', async () => {
  const v = await version(G.FR);
  const f = listeDatei(await listeZeile('Listenwort', 'neu', 'nouveau'), await listeZeile('Wegwort', 'weg'), await listeZeile('Leerwort', 'leer_entfernen'));
  const r = listeLauf(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Leere Zeilen entfernt: 1, Zeilen mit Text entfernt: 1, ersetzt: 1/);
  assert.equal((await zeileIn('Listenwort', 'FR')).target_term, 'mot liste');
  assert.ok(await zeileIn('Wegwort', 'FR'));
  assert.ok(await zeileIn('Leerwort', 'FR'));
  assert.equal(await version(G.FR), v);
});
await pruefe('die Liste hält an, wenn eine Zeile nicht mehr ihrem Stand entspricht, und ändert dann gar nichts', async () => {
  const z = await zeileIn('Listenwort', 'FR');
  const f = listeDatei(`${z.id}\tneu\tListenwort\tveraltet\tnouveau`, await listeZeile('Wegwort', 'weg'));
  const r = listeLauf(f, '--ausfuehren');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Eintrag ist jetzt/);
  assert.equal((await zeileIn('Listenwort', 'FR')).target_term, 'mot liste');
  assert.ok(await zeileIn('Wegwort', 'FR'));
});
await pruefe('die Liste fasst Channel-Werte und Kennwerte nicht an', async () => {
  await q(`INSERT INTO channels (code, name) VALUES ('TESTKANAL', 'Test') ON CONFLICT DO NOTHING`);
  await lege('FR', 'Kanalwort', 'canal');
  const k = await zeileIn('Kanalwort', 'FR');
  await api('PUT', `/api/glossaries/${G.FR}/entries/${k.id}/channels/TESTKANAL`, { target_term: 'kanal' });
  await lege('FR', 'CRI', 'IRC');
  for (const [b, muster] of [['Kanalwort', /Channel-Wert/], ['CRI', /Schutzkette/]]) {
    const r = listeLauf(listeDatei(await listeZeile(b, 'weg')), '--ausfuehren');
    assert.equal(r.status, 1, b);
    assert.match(r.stderr, muster);
    assert.ok(await zeileIn(b, 'FR'), b);
  }
});
await pruefe('die Liste lehnt eine unpassende Folge ab, eine unbekannte Folge und „neu“ ohne Wert', async () => {
  assert.match(listeLauf(listeDatei(await listeZeile('Wegwort', 'leer_entfernen'))).stderr, /nicht leer/);
  assert.match(listeLauf(listeDatei(await listeZeile('Leerwort', 'weg'))).stderr, /ist leer/);
  assert.match(listeLauf(listeDatei(await listeZeile('Wegwort', 'loeschen'))).stderr, /unbekannte Folge/);
  assert.match(listeLauf(listeDatei(await listeZeile('Wegwort', 'neu'))).stderr, /ohne Wert/);
  assert.ok(await zeileIn('Wegwort', 'FR'));
});
await pruefe('leere Zeilen allein: weg, Version und Cache unverändert', async () => {
  const v = await version(G.FR);
  const s = await stale();
  const r = listeLauf(listeDatei(await listeZeile('Leerwort', 'leer_entfernen')), '--ausfuehren');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await zeileIn('Leerwort', 'FR'), undefined);
  assert.equal(await version(G.FR), v);
  assert.equal(await stale(), s);
});
await pruefe('ersetzen und entfernen: Verlauf mit altem Wert, Version steigt, nur betroffene Segmente werden stale, das Übrige bleibt', async () => {
  const v = await version(G.FR);
  const anderes = await zeileIn('Anderes', 'FR');
  const wort = await zeileIn('Wegwort', 'FR');
  const liste = await zeileIn('Listenwort', 'FR');
  const r = listeLauf(listeDatei(await listeZeile('Listenwort', 'neu', 'nouveau'), await listeZeile('Wegwort', 'weg')), '--ausfuehren');
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await zeileIn('Listenwort', 'FR')).target_term, 'nouveau');
  assert.equal((await zeileIn('Listenwort', 'FR')).approved, liste.approved);
  assert.equal(await zeileIn('Wegwort', 'FR'), undefined);
  assert.equal(await version(G.FR), v + 1);
  const st = await q(`SELECT source_text FROM segments WHERE is_stale ORDER BY source_text`);
  assert.deepEqual(st.rows.map((x) => x.source_text), ['Das Listenwort im Satz', 'Das Wegwort im Satz']);
  assert.equal((await zeileIn('Anderes', 'FR')).target_term, anderes.target_term);
  const h = await q(`SELECT action, old_value, new_value FROM glossary_entry_history WHERE entry_id = ANY($1::uuid[]) AND changed_by_name LIKE 'Bereinigung%' ORDER BY action`, [[wort.id, liste.id]]);
  assert.deepEqual(h.rows, [
    { action: 'deleted', old_value: 'mot parti', new_value: null },
    { action: 'updated', old_value: 'mot liste', new_value: 'nouveau' },
  ]);
});
await pruefe('derselbe Lauf ein zweites Mal hält an, statt doppelt zu schreiben', async () => {
  const z = await zeileIn('Anderes', 'FR');
  const r = listeLauf(listeDatei(`00000000-0000-4000-8000-000000000000\tweg\tGibt es nicht\tnichts\t`, `${z.id}\tweg\tAnderes\treste\t`), '--ausfuehren');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gibt es nicht mehr/);
  assert.ok(await zeileIn('Anderes', 'FR'));
});

server.close();
await pool.end();
console.log(`\n${gruen} grün, ${rot} rot`);
process.exitCode = rot === 0 ? 0 : 1;
