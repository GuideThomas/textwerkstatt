#!/usr/bin/env node
/**
 * Prüfungen für die Namensbausteine: Migration 033 und `routes/namens-bausteine.ts`
 * (Bauplan `Artikelanlage-Assistent/docs/BAUPLAN-Bausteine-Phase2.md` §3 und §4, Cockpit #1767).
 *
 * Seit Phase 3 der Wortliste (`PLAN-wortliste.md`, Cockpit #1831) liest die Schnittstelle das Glossar über die Sichten aus
 * Migration 036; der zweite Teil prüft sie dort, samt Gegenprobe ohne die Bedingung der Sicht. Der erste Teil prüft weiter die alte
 * Tabelle aus Migration 033: Sie steht bis Phase 7, und für Sprachen ohne Umzug nimmt sie noch Bausteine an.
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank. Das Passwort kommt aus der Umgebung, DeepL wird nicht
 * aufgerufen (die Translator-Methode ist ersetzt und zeichnet jeden Aufruf auf):
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-namen-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:55433:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=55433 DB_NAME=translationtool_test DB_USER=translationtool \
 *     node scripts/namens-bausteine.test.mjs
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
process.env.DEEPL_API_KEY = 'attrappe-kein-schluessel';
process.env.TRANSLATION_SERVICE_KEY = '';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('routes', 'namens-bausteine.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};
const express = require('express');
const deepl = require('deepl-node');
const deeplAufrufe = [];
let antwortVonDeepL = (text) => `${text} (DeepL)`;
deepl.Translator.prototype.translateText = async function (texte, quelle, ziel, optionen) {
  deeplAufrufe.push({ texte, quelle, ziel, optionen: { ...optionen } });
  const liste = Array.isArray(texte) ? texte : [texte];
  const aus = liste.map((t) => ({ text: antwortVonDeepL(t), detectedSourceLang: 'de' }));
  return Array.isArray(texte) ? aus : aus[0];
};

const { pool } = await laden('db', 'connection.js');
const { config } = await laden('config.js');
const q = (sql, p) => pool.query(sql, p);

const db = (await q('SELECT current_database() AS n')).rows[0].n;
assert.ok(db.endsWith('_test'), 'falsche Datenbank');
// Ein eigener Wegwerf-Server hat nur diese eine Datenbank. Am 06.11.2026 war der Port schon von einem fremden Testserver belegt,
// der Lauf landete dort und scheiterte nur zufällig an der fehlenden Rolle.
const fremde = (await q(
  `SELECT count(*)::int AS n FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', current_database())`,
)).rows[0].n;
if (fremde > 0) {
  console.error(`Abbruch: Der Server hat ${fremde} weitere Datenbank(en), das ist kein eigener Wegwerf-Server.`);
  process.exit(2);
}

await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
const MIGRATIONEN = join(WURZEL, 'migrations');
const TESTSEED = readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8');
const migriere = async () => {
  for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) {
    await q(readFileSync(join(MIGRATIONEN, f), 'utf-8'));
  }
  await q(TESTSEED);
};

const routerModul = await import(pathToFileURL(dist('routes', 'namens-bausteine.js')).href);
const router = routerModul.default?.default ?? routerModul.default;
const { MAX_MELDUNGEN, MAX_DEEPL_JE_ANFRAGE } = routerModul.default?.MAX_MELDUNGEN ? routerModul.default : routerModul;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/namens-bausteine', router);
const server = app.listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const BASIS = `http://127.0.0.1:${server.address().port}`;

const api = async (methode, pfad, { body, kopf = {} } = {}) => {
  const r = await fetch(BASIS + pfad, {
    method: methode,
    headers: { 'Content-Type': 'application/json', ...kopf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 304 ohne Körper */ }
  return { status: r.status, body: json, etag: r.headers.get('etag') };
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

/** Erwartet, dass ein SQL-Befehl scheitert; liefert die Fehlermeldung. */
const scheitert = async (sql, p) => {
  try {
    await q(sql, p);
  } catch (e) {
    return e.message;
  }
  throw new Error(`hätte scheitern müssen: ${sql.slice(0, 80)}`);
};

const fassung = async (sprache) =>
  (await q('SELECT COALESCE(max(nummer), 0)::int AS n FROM namens_bausteine_fassung WHERE sprache = $1', [sprache])).rows[0].n;
const baustein = async (sprache, deutsch, gruppe = null) =>
  (await q(
    `SELECT * FROM namens_bausteine WHERE sprache = $1 AND lower(btrim(deutsch)) = lower(btrim($2))
        AND COALESCE(produktgruppe, -1) = COALESCE($3::int, -1)`,
    [sprache, deutsch, gruppe],
  )).rows[0];
const NEU = `INSERT INTO namens_bausteine (sprache, art, deutsch, ziel, produktgruppe, wortart, genus, formen, quelle, freigegeben_von)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pruefung', 'Test')`;
const neu = (c, sprache, art, deutsch, ziel, extra = {}) =>
  c.query(NEU, [sprache, art, deutsch, ziel, extra.gruppe ?? null, extra.wortart ?? null, extra.genus ?? null, extra.formen ?? null]);

console.log('Namensbausteine');

await pruefe('Migrationen laufen zweimal hintereinander durch (wiederholbar wie bei jedem Deploy)', async () => {
  await migriere();
  await migriere();
  const t = (await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'namens_bausteine'::regclass AND NOT tgisinternal`)).rows[0].n;
  // Drei aus Migration 033, dazu die Umzugssperre aus 038 (Plan Wortliste Phase 3).
  assert.equal(t, 4, 'vier Trigger, keiner doppelt');
});

await pruefe('Fassung: zwei Bausteine in einer Transaktion ergeben eine Fassung', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await neu(c, 'FR', 'wort', 'weiß', 'blanc', { wortart: 'adjektiv', formen: { m: 'blanc', f: 'blanche' } });
    await neu(c, 'FR', 'wort', 'schwarz', 'noir', { wortart: 'adjektiv', formen: { m: 'noir', f: 'noire' } });
    await c.query('COMMIT');
  } finally { c.release(); }
  assert.equal(await fassung('FR'), 1);
  assert.equal((await baustein('FR', 'weiß')).fassung, 1);
  assert.equal((await baustein('FR', 'schwarz')).fassung, 1);
  assert.equal((await q(`SELECT count(*)::int AS n FROM namens_bausteine_fassung WHERE sprache = 'FR'`)).rows[0].n, 1);
});

await pruefe('Fassung: eine neue Transaktion zählt weiter, eine andere Sprache zählt für sich', async () => {
  await neu(pool, 'FR', 'muster', '# Rolle', '# rouleau');
  assert.equal(await fassung('FR'), 2);
  assert.equal((await baustein('FR', '# Rolle')).fassung, 2);
  await neu(pool, 'IT', 'wort', 'weiß', 'bianco', { wortart: 'adjektiv', formen: { m: 'bianco', f: 'bianca' } });
  assert.equal(await fassung('IT'), 1);
  assert.equal(await fassung('FR'), 2);
});

await pruefe('Fassung: zwei gleichzeitige Transaktionen derselben Sprache ziehen verschiedene Nummern', async () => {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await neu(a, 'ES', 'wort', 'Rolle', 'rollo', { wortart: 'hauptwort', genus: 'm' });
    const wartet = neu(b, 'ES', 'wort', 'Kabel', 'cable', { wortart: 'hauptwort', genus: 'm' });
    await new Promise((ok) => setTimeout(ok, 200));
    await a.query('COMMIT');
    await wartet;
    await b.query('COMMIT');
  } finally { a.release(); b.release(); }
  const n = (await q(`SELECT nummer FROM namens_bausteine_fassung WHERE sprache = 'ES' ORDER BY nummer`)).rows.map((r) => r.nummer);
  assert.deepEqual(n, [1, 2]);
});

await pruefe('Änderung: neue Fassung und ein Verlaufseintrag mit altem und neuem Ziel', async () => {
  await q(`UPDATE namens_bausteine SET ziel = 'noir mat', formen = '{"m":"noir mat","f":"noire mate"}', freigegeben_von = 'Prüferin FR'
            WHERE sprache = 'FR' AND deutsch = 'schwarz'`);
  assert.equal(await fassung('FR'), 3);
  const b = await baustein('FR', 'schwarz');
  assert.equal(b.fassung, 3);
  const v = (await q(`SELECT * FROM namens_bausteine_verlauf WHERE baustein_id = $1 ORDER BY id`, [b.id])).rows;
  assert.deepEqual(v.map((r) => r.aktion), ['angelegt', 'geaendert']);
  assert.equal(v[1].alt.ziel, 'noir');
  assert.equal(v[1].neu.ziel, 'noir mat');
  assert.equal(v[1].von, 'Prüferin FR');
  assert.equal(v[1].fassung, 3);
});

await pruefe('Nur Metadaten geändert: keine neue Fassung, kein Verlaufseintrag', async () => {
  const vorher = (await q('SELECT count(*)::int AS n FROM namens_bausteine_verlauf')).rows[0].n;
  await q(`UPDATE namens_bausteine SET freigegeben_von = 'Jemand anderes', quelle = 'pflege' WHERE sprache = 'FR' AND deutsch = 'weiß'`);
  assert.equal(await fassung('FR'), 3);
  assert.equal((await baustein('FR', 'weiß')).fassung, 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM namens_bausteine_verlauf')).rows[0].n, vorher);
});

await pruefe('Einfügen und Ändern in derselben Transaktion: eine Fassung, zwei Verlaufseinträge', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await neu(c, 'FR', 'wort', 'opal', 'opale', { wortart: 'adjektiv' });
    await c.query(`UPDATE namens_bausteine SET ziel = 'opalin' WHERE sprache = 'FR' AND deutsch = 'opal'`);
    await c.query('COMMIT');
  } finally { c.release(); }
  assert.equal(await fassung('FR'), 4);
  const b = await baustein('FR', 'opal');
  const v = (await q(`SELECT aktion, fassung FROM namens_bausteine_verlauf WHERE baustein_id = $1 ORDER BY id`, [b.id])).rows;
  assert.deepEqual(v, [{ aktion: 'angelegt', fassung: 4 }, { aktion: 'geaendert', fassung: 4 }]);
});

await pruefe('Entfernen: neue Fassung, im Verlauf steht, wer es mit SET LOCAL gesagt hat', async () => {
  const id = (await baustein('FR', 'opal')).id;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL namens_bausteine.von = 'Prüferin FR'`);
    await c.query(`DELETE FROM namens_bausteine WHERE id = $1`, [id]);
    await c.query('COMMIT');
  } finally { c.release(); }
  assert.equal(await fassung('FR'), 5);
  const v = (await q(`SELECT * FROM namens_bausteine_verlauf WHERE baustein_id = $1 AND aktion = 'entfernt'`, [id])).rows;
  assert.equal(v.length, 1);
  assert.equal(v[0].von, 'Prüferin FR');
  assert.equal(v[0].alt.ziel, 'opalin');
  assert.equal((await q(`SELECT von FROM namens_bausteine_fassung WHERE sprache = 'FR' AND nummer = 5`)).rows[0].von, 'Prüferin FR');
});

await pruefe('Entfernen ohne Namen: im Verlauf steht „unbekannt“', async () => {
  await neu(pool, 'FR', 'wort', 'klar', 'clair', { wortart: 'adjektiv' });
  const id = (await baustein('FR', 'klar')).id;
  await q(`DELETE FROM namens_bausteine WHERE id = $1`, [id]);
  const v = (await q(`SELECT von FROM namens_bausteine_verlauf WHERE baustein_id = $1 AND aktion = 'entfernt'`, [id])).rows;
  assert.equal(v[0].von, 'unbekannt');
});

await pruefe('TRUNCATE ist gesperrt, die Zeilen bleiben', async () => {
  const vorher = (await q('SELECT count(*)::int AS n FROM namens_bausteine')).rows[0].n;
  assert.ok(vorher > 0, 'Positivkontrolle: es gibt Zeilen');
  const f = await scheitert('TRUNCATE namens_bausteine CASCADE');
  assert.match(f, /nicht geleert/);
  assert.equal((await q('SELECT count(*)::int AS n FROM namens_bausteine')).rows[0].n, vorher);
});

await pruefe('Die Sprache eines Bausteins lässt sich nicht ändern', async () => {
  const f = await scheitert(`UPDATE namens_bausteine SET sprache = 'IT' WHERE sprache = 'FR' AND deutsch = 'weiß'`);
  assert.match(f, /Sprache eines Namensbausteins ist fest/);
});

await pruefe('Schranken: leeres Ziel, fremde Sprache, falsche Art, „fest“ mit anderem Ziel, Genus am Adjektiv, Formen am Hauptwort', async () => {
  const vorher = await fassung('FR');
  await scheitert(NEU, ['FR', 'wort', 'grau', '  ', null, null, null, null]);
  await scheitert(NEU, ['DE', 'wort', 'grau', 'gris', null, null, null, null]);
  await scheitert(NEU, ['CS', 'wort', 'grau', 'šedá', null, null, null, null]);
  await scheitert(NEU, ['FR', 'satz', 'grau', 'gris', null, null, null, null]);
  await scheitert(NEU, ['FR', 'fest', 'NEON927', 'NÉON927', null, null, null, null]);
  await scheitert(NEU, ['FR', 'wort', 'grau', 'gris', null, 'adjektiv', 'm', null]);
  await scheitert(NEU, ['FR', 'wort', 'Kappe', 'embout', null, 'hauptwort', 'm', { m: 'embout' }]);
  await scheitert(`INSERT INTO namens_bausteine (sprache, art, deutsch, ziel, quelle, freigegeben_von) VALUES ('FR', 'wort', 'grau', 'gris', 'pruefung', ' ')`);
  assert.equal(await fassung('FR'), vorher, 'ein gescheiterter Schreibversuch zieht keine Fassung');
  // Gegenprobe: dieselbe Zeile richtig geschrieben geht durch.
  await neu(pool, 'FR', 'fest', 'NEON927', 'NEON927');
  assert.equal(await fassung('FR'), vorher + 1);
});

await pruefe('Schlüssel: gleiches Deutsch mit anderer Schreibung kollidiert, eine andere Produktgruppe nicht', async () => {
  const f = await scheitert(NEU, ['FR', 'wort', '  Weiß  ', 'blanc', null, 'adjektiv', null, null]);
  assert.match(f, /uq_namens_bausteine_schluessel/);
  await neu(pool, 'FR', 'wort', 'Cover', 'cache', { wortart: 'hauptwort', genus: 'm' });
  await neu(pool, 'FR', 'wort', 'Cover', 'diffuseur', { gruppe: 16, wortart: 'hauptwort', genus: 'm' });
  await neu(pool, 'FR', 'wort', 'Cover', 'collerette', { gruppe: 6, wortart: 'hauptwort', genus: 'f' });
  await scheitert(NEU, ['FR', 'wort', 'cover', 'diffuseur', 16, 'hauptwort', 'm', null]);
  assert.equal((await baustein('FR', 'Cover', 16)).ziel, 'diffuseur');
  assert.equal((await baustein('FR', 'Cover', 6)).ziel, 'collerette');
  assert.equal((await baustein('FR', 'Cover')).ziel, 'cache');
});

const VORL = `INSERT INTO namens_bausteine_vorlaeufig (sprache, art, deutsch, quelle, vorschlag_pruefung, vorschlag_glossar, vorschlag_markt, vorschlag_deepl, status)
              VALUES ($1, 'wort', $2, $3, $4, $5, $6, $7, COALESCE($8, 'vorschlag')) RETURNING ziel`;

await pruefe('Vorläufig: das Ziel folgt Prüftabelle vor Glossar vor Markt vor DeepL (Entscheid 06.11.2026)', async () => {
  const z = async (d, p, g, m, dl) => (await q(VORL, ['IT', d, 'pruefung', p, g, m, dl, null])).rows[0].ziel;
  assert.equal(await z('a1', 'P', 'G', 'M', 'D'), 'P');
  assert.equal(await z('a2', null, 'G', 'M', 'D'), 'G');
  assert.equal(await z('a3', null, null, 'M', 'D'), 'M');
  assert.equal(await z('a4', null, null, null, 'D'), 'D');
  assert.equal(await z('a5', null, null, null, null), null);
  await scheitert(`UPDATE namens_bausteine_vorlaeufig SET ziel = 'X' WHERE deutsch = 'a1'`);
});

await pruefe('Vorläufig: höchstens ein offener Vorschlag je Schlüssel, ein abgelehnter steht daneben', async () => {
  await q(VORL, ['IT', 'Bügel', 'markt', null, null, 'staffa', null, null]);
  await scheitert(VORL, ['IT', ' bügel ', 'deepl', null, null, null, 'archetto', null]);
  await q(`UPDATE namens_bausteine_vorlaeufig SET status = 'abgelehnt' WHERE sprache = 'IT' AND deutsch = 'Bügel'`);
  await q(VORL, ['IT', 'Bügel', 'deepl', null, null, null, 'archetto', null]);
  const n = (await q(`SELECT status FROM namens_bausteine_vorlaeufig WHERE sprache = 'IT' AND lower(deutsch) = 'bügel' ORDER BY angelegt_am`)).rows;
  assert.deepEqual(n.map((r) => r.status), ['abgelehnt', 'vorschlag']);
});

console.log('Routen');

await pruefe('Zugang: ohne konfigurierten Schlüssel direkt lokal 200, über einen Proxy 403', async () => {
  config.serviceKey = '';
  assert.equal((await api('GET', '/api/namens-bausteine?sprache=FR')).status, 200);
  assert.equal((await api('GET', '/api/namens-bausteine?sprache=FR', { kopf: { 'X-Forwarded-For': '203.0.113.7' } })).status, 403);
  assert.equal((await api('GET', '/api/namens-bausteine/vorlaeufig?sprache=FR', { kopf: { 'X-Real-IP': '203.0.113.7' } })).status, 403);
  assert.equal((await api('POST', '/api/namens-bausteine/unbekannt', { kopf: { 'CF-Connecting-IP': '203.0.113.7' }, body: { meldungen: [] } })).status, 403);
});

await pruefe('Zugang: mit konfiguriertem Schlüssel ohne Kopf 401, falscher Schlüssel 401, richtiger 200', async () => {
  config.serviceKey = 'test-schluessel-nur-fuer-diesen-lauf';
  try {
    assert.equal((await api('GET', '/api/namens-bausteine?sprache=FR')).status, 401);
    assert.equal((await api('GET', '/api/namens-bausteine?sprache=FR', { kopf: { 'X-Service-Key': 'falsch' } })).status, 401);
    assert.equal((await api('POST', '/api/namens-bausteine/unbekannt', { body: { meldungen: [] } })).status, 401);
    assert.equal((await api('GET', '/api/namens-bausteine?sprache=FR', { kopf: { 'X-Service-Key': config.serviceKey } })).status, 200);
  } finally {
    config.serviceKey = '';
  }
});

// ── Schnittstelle seit Phase 3 der Wortliste: liest das Glossar über die Sichten (Plan PLAN-wortliste.md §2.2–§2.4) ────────────
console.log('\nSchnittstelle aus der Wortliste (Plan Wortliste Phase 3)');
const GL = {};
for (const s of ['EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ']) {
  GL[s] = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ($1, 'DE', $2) RETURNING id`, [`Glossar DE→${s}`, s])).rows[0].id;
}
/** Eine Zeile der Wortliste. Ohne `approved: false` freigegeben; `an_deepl` wie ein Namenswort nein, außer gesetzt. */
const wort = async (sprache, deutsch, ziel, extra = {}) => {
  const f = { glossary_id: GL[sprache], source_term: deutsch, target_term: ziel, approved: true, an_deepl: false, ...extra };
  const sp = Object.keys(f);
  const w = sp.map((k) => (k === 'formen' && f[k] !== null ? JSON.stringify(f[k]) : f[k]));
  return (await q(`INSERT INTO glossary_entries (${sp.join(', ')}) VALUES (${sp.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, w)).rows[0].id;
};
const cover = await wort('FR', 'Cover', 'cache');
await q(`INSERT INTO glossary_entry_gruppen (entry_id, produktgruppe, target_term, genus) VALUES ($1, 16, 'diffuseur', 'm'), ($1, 6, 'collerette', 'f')`, [cover]);
await wort('FR', 'weiß', 'blanc', { wortart: 'adjektiv', formen: { m: 'blanc', f: 'blanche' } });
const flex = await wort('FR', 'Flexband', 'ruban LED', { an_deepl: true });
await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPA', 'bande LED')`, [flex]);
await wort('FR', '#m Rolle', '# m rouleau', { art: 'muster' });
const endkappe = await wort('FR', 'Endkappe', null, { approved: false });
await q(`INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_markt) VALUES ($1, 'markt', 'embout')`, [endkappe]);
await wort('FR', 'Schukostecker', null, { approved: false });
await wort('IT', 'weiß', 'bianco', { wortart: 'adjektiv', formen: { m: 'bianco', f: 'bianca' } });
const buegel = await wort('IT', 'Bügel', null, { approved: false });
await q(`INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_markt) VALUES ($1, 'markt', 'archetto')`, [buegel]);
const klemme = await wort('IT', 'Klemme', null, { approved: false });
await q(`INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_deepl, rueckfrage) VALUES ($1, 'deepl', 'morsetto', 'Klemme oder Clip?')`, [klemme]);

/** Die Prüfung der Lieferung, über eine Funktion, damit die Gegenprobe dieselbe Prüfung gegen eine geänderte Sicht fährt. */
const pruefeLieferung = async () => {
  const r = await api('GET', '/api/namens-bausteine?sprache=FR');
  assert.equal(r.status, 200);
  const deutsch = r.body.bausteine.map((b) => b.deutsch);
  for (const offen of ['Endkappe', 'Schukostecker']) assert.ok(!deutsch.includes(offen), `offen: ${offen}`);
  return r;
};
await pruefe('GET liefert die freigegebenen Wörter mit Fassung, Channel-Werten und Gruppenzielen, nichts Offenes', async () => {
  const r = await pruefeLieferung();
  const zeilen = (await q(`SELECT count(*)::int AS n FROM wortliste_freigegeben WHERE sprache = 'FR'`)).rows[0].n;
  const gruppen = (await q(`SELECT count(*)::int AS n FROM glossary_entry_gruppen p JOIN glossary_entries e ON e.id = p.entry_id WHERE e.glossary_id = $1`, [GL.FR])).rows[0].n;
  assert.equal(r.body.anzahl, zeilen + gruppen);
  assert.equal(r.body.bausteine.length, zeilen + gruppen);
  assert.equal(r.body.fassung, await fassung('FR'));
  assert.equal(r.etag, `"namens-FR-${await fassung('FR')}"`);
  assert.ok(r.body.bausteine.every((b) => !('freigegeben_von' in b) && !('changed_by_name' in b)), 'keine Personennamen in der Lieferung');
  assert.deepEqual(r.body.bausteine.filter((b) => b.deutsch === 'Cover').map((b) => [b.produktgruppe, b.ziel, b.genus]),
    [[null, 'cache', null], [6, 'collerette', 'f'], [16, 'diffuseur', 'm']]);
  assert.deepEqual(r.body.bausteine.find((b) => b.deutsch === 'weiß').formen, { m: 'blanc', f: 'blanche' });
  const fl = r.body.bausteine.find((b) => b.deutsch === 'Flexband');
  assert.deepEqual(fl.kanaele, { SHOPA: 'bande LED' });
  assert.ok(r.body.bausteine.filter((b) => b.produktgruppe !== null).every((b) => Object.keys(b.kanaele).length === 0), 'Gruppenziele ohne Channel');
  assert.ok(deutsch(r).includes('#m Rolle'), 'Namenswörter ohne DeepL sind dabei');
});
function deutsch(r) { return r.body.bausteine.map((b) => b.deutsch); }

await pruefe('Gegenprobe: dieselbe Sicht ohne ihre Bedingung ließe Offenes durch, die Prüfung oben fiele also auf', async () => {
  const sql = readFileSync(join(MIGRATIONEN, '036_wortliste.sql'), 'utf-8');
  const def = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW wortliste_freigegeben'));
  const ohne = def.slice(0, def.indexOf(';') + 1).replace(/WHERE e\.approved = TRUE AND e\.target_term IS NOT NULL\s+AND /u, 'WHERE ');
  assert.notEqual(ohne, def.slice(0, def.indexOf(';') + 1));
  await q(ohne);
  try {
    await assert.rejects(pruefeLieferung(), /offen: /u);
  } finally {
    await q(sql);
  }
  await pruefeLieferung();
});

await pruefe('Quelltext: der GET-Zweig liest nur die Sicht, nie glossary_entries (eine Schicht, keine Garantie)', async () => {
  const s = readFileSync(join(WURZEL, 'src', 'routes', 'namens-bausteine.ts'), 'utf-8');
  const get = s.slice(s.indexOf("router.get('/', "), s.indexOf("router.get('/vorlaeufig'"));
  assert.ok(get.includes('FROM wortliste_freigegeben'), 'GET liest die Sicht');
  assert.ok(!/glossary_entries|namens_bausteine\b(?!_fassung)/u.test(get), 'GET liest eine Tabelle direkt');
});

await pruefe('Fassung: neues Wort 200 mit neuem ETag, nur an_deepl geändert 304, Channel-Wert geändert 200', async () => {
  const erst = await api('GET', '/api/namens-bausteine?sprache=FR');
  const wieder = await api('GET', '/api/namens-bausteine?sprache=FR', { kopf: { 'If-None-Match': erst.etag } });
  assert.equal(wieder.status, 304);
  assert.equal(wieder.body, null);
  await wort('FR', 'eckig', 'carré', { wortart: 'adjektiv', formen: { m: 'carré', f: 'carrée' } });
  const zwei = await api('GET', '/api/namens-bausteine?sprache=FR', { kopf: { 'If-None-Match': erst.etag } });
  assert.equal(zwei.status, 200);
  assert.ok(zwei.body.bausteine.some((b) => b.deutsch === 'eckig'));
  await q(`UPDATE glossary_entries SET an_deepl = TRUE WHERE glossary_id = $1 AND source_term = 'eckig'`, [GL.FR]);
  assert.equal((await api('GET', '/api/namens-bausteine?sprache=FR', { kopf: { 'If-None-Match': zwei.etag } })).status, 304, 'an_deepl ist kein Namensfeld');
  await q(`UPDATE glossary_entry_channels SET target_term = 'bandeau LED' WHERE entry_id = $1`, [flex]);
  const drei = await api('GET', '/api/namens-bausteine?sprache=FR', { kopf: { 'If-None-Match': zwei.etag } });
  assert.equal(drei.status, 200);
  assert.deepEqual(drei.body.bausteine.find((b) => b.deutsch === 'Flexband').kanaele, { SHOPA: 'bandeau LED' });
});

await pruefe('GET: eine Sprache ohne Wörter liefert Fassung 0 und eine leere Liste', async () => {
  const r = await api('GET', '/api/namens-bausteine?sprache=HU');
  assert.equal(r.status, 200);
  assert.equal(r.body.fassung, 0);
  assert.deepEqual(r.body.bausteine, []);
});

await pruefe('GET: fehlende oder fremde Sprache 400, CS wird nicht still zu CZ', async () => {
  for (const s of ['', 'DE', 'CS', 'fr-FR']) {
    const r = await api('GET', `/api/namens-bausteine?sprache=${encodeURIComponent(s)}`);
    assert.equal(r.status, 400, s);
  }
  assert.equal((await api('GET', '/api/namens-bausteine?sprache=fr')).status, 200, 'Kleinschreibung ist erlaubt');
});

await pruefe('GET vorläufig: offene Zeilen der Sprache mit Status, nicht freigegebene, nicht fremde Sprachen', async () => {
  const r = await api('GET', '/api/namens-bausteine/vorlaeufig?sprache=IT');
  assert.equal(r.status, 200);
  assert.equal(r.body.vorlaeufig, true);
  const d = r.body.eintraege.map((e) => [e.deutsch, e.status, e.ziel]);
  assert.ok(d.some(([x, s, z]) => x === 'Bügel' && s === 'vorschlag' && z === 'archetto'), JSON.stringify(d));
  assert.ok(d.some(([x, s, z]) => x === 'Klemme' && s === 'rueckfrage' && z === 'morsetto'));
  assert.ok(!d.some(([x]) => x === 'weiß'), 'ein freigegebenes Wort steht nicht in der vorläufigen Liste');
  assert.ok(!d.some(([x]) => x === 'Endkappe'), 'FR erscheint nicht unter IT');
});

const melde = (meldungen) => api('POST', '/api/namens-bausteine/unbekannt', { body: { meldungen } });
const vorlaeufig = async (sprache, deutsch) => (await q(
  `SELECT e.id, e.source_term, e.target_term, e.approved, e.an_deepl, e.art, e.source, v.*
     FROM glossary_entries e JOIN wortliste_vorschlag v ON v.entry_id = e.id
    WHERE e.glossary_id = $1 AND e.source_term = $2 AND e.approved IS NOT TRUE`, [GL[sprache], deutsch])).rows[0];

await pruefe('POST unbekannt: legt eine offene Zeile an, eine zweite Meldung ergänzt statt zu verdoppeln; höchstens zwei Beispiele', async () => {
  const fVorher = await fassung('PL');
  const a = await melde([{ sprache: 'PL', art: 'wendung', deutsch: 'mit Kabeldurchführung', stelle: 'kopf', kopfwort: 'Endkappe',
    produktgruppe: 16, artikelAnzahl: 12, beispiele: ['Endkappe A mit Kabeldurchführung', 'Endkappe B mit Kabeldurchführung'] }]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.angelegt, a.body.aktualisiert, a.body.bekannt], [1, 0, 0]);
  const b = await melde([{ sprache: 'pl', art: 'wendung', deutsch: ' MIT Kabeldurchführung ', produktgruppe: 16, artikelAnzahl: 15,
    beispiele: ['Endkappe C mit Kabeldurchführung'] }]);
  assert.deepEqual([b.body.angelegt, b.body.aktualisiert], [0, 1]);
  const z = (await q(`SELECT e.*, v.* FROM glossary_entries e JOIN wortliste_vorschlag v ON v.entry_id = e.id
                       WHERE e.glossary_id = $1 AND lower(btrim(e.source_term)) = 'mit kabeldurchführung'`, [GL.PL])).rows;
  assert.equal(z.length, 1);
  assert.equal(z[0].artikel_anzahl, 15);
  assert.deepEqual(z[0].beispiele, ['Endkappe A mit Kabeldurchführung', 'Endkappe B mit Kabeldurchführung']);
  assert.equal(z[0].quelle, 'gemeldet');
  assert.equal(z[0].vorschlag_deepl, 'mit Kabeldurchführung (DeepL)', 'die erste Meldung holt den DeepL-Vorschlag');
  assert.equal(z[0].target_term, z[0].vorschlag_deepl, 'ohne Prüftabelle, Glossar und Markt ist DeepL das vorläufige Ziel');
  assert.equal(z[0].kopfwort, 'Endkappe');
  assert.deepEqual([z[0].approved, z[0].an_deepl, z[0].art], [false, false, 'wendung']);
  assert.equal(await fassung('PL'), fVorher, 'eine Meldung ändert keine Fassung');
  const h = (await q(`SELECT DISTINCT changed_by_name FROM glossary_entry_history WHERE entry_id = $1`, [z[0].entry_id])).rows.map((x) => x.changed_by_name);
  assert.deepEqual(h, ['Artikelanlage-Assistent (gemeldet)'], 'der Verlauf nennt den Melder');
});

await pruefe('POST unbekannt: freigegeben zählt als bekannt (auch eindeutig ohne Groß/Klein), abgelehnt wird nicht neu vorgeschlagen', async () => {
  await q(`DELETE FROM glossary_entries WHERE id = $1`, [buegel]);
  await q(`INSERT INTO wortliste_abgelehnt (glossary_id, art, source_term, von) VALUES ($1, 'wort', 'Bügel', 'Test')`, [GL.IT]);
  await wort('FR', 'COVER', 'COVER');
  const r = await melde([
    { sprache: 'FR', art: 'wort', deutsch: 'Weiß' },
    { sprache: 'IT', art: 'wort', deutsch: 'Bügel' },
    { sprache: 'FR', art: 'wort', deutsch: 'Cover', produktgruppe: 11 },
    { sprache: 'FR', art: 'wort', deutsch: 'cover' },
  ]);
  assert.deepEqual([r.body.bekannt, r.body.abgelehnt, r.body.angelegt], [2, 1, 1], JSON.stringify(r.body));
  assert.ok(await vorlaeufig('FR', 'cover'), '„cover“ trifft „Cover“ und „COVER“, also kein eindeutiger Treffer: Vorschlag');
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossary_entries WHERE glossary_id = $1 AND source_term = 'Bügel'`, [GL.IT])).rows[0].n, 0);
});

await pruefe('POST unbekannt: ungültige Meldungen einzeln abgewiesen, die gültigen trotzdem gespeichert', async () => {
  const r = await melde([
    { sprache: 'DE', art: 'wort', deutsch: 'grau' },
    { sprache: 'SK', art: 'fest', deutsch: 'NEON927' },
    { sprache: 'SK', art: 'wort', deutsch: '' },
    { sprache: 'SK', art: 'wort', deutsch: 'x'.repeat(301) },
    { sprache: 'SK', art: 'wort', deutsch: 'grau\u0007' },
    { sprache: 'SK', art: 'wort', deutsch: 'grau', produktgruppe: -1 },
    { sprache: 'SK', art: 'wort', deutsch: 'grau', produktgruppe: '16' },
    { sprache: 'SK', art: 'wort', deutsch: 'grau', stelle: 'mitte' },
    { sprache: 'SK', art: 'wort', deutsch: 'grau', beispiele: 'kein Feld' },
    'keine Meldung',
    { sprache: 'SK', art: 'wort', deutsch: 'grau', produktgruppe: 16, artikelAnzahl: 3 },
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.abgewiesen.map((a) => a.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(r.body.angelegt, 1);
});

await pruefe('POST unbekannt: leere Liste 400, zu viele Meldungen 413, nichts gespeichert', async () => {
  const vorher = (await q('SELECT count(*)::int AS n FROM glossary_entries')).rows[0].n;
  assert.equal((await melde([])).status, 400);
  assert.equal((await api('POST', '/api/namens-bausteine/unbekannt', { body: {} })).status, 400);
  const viele = Array.from({ length: MAX_MELDUNGEN + 1 }, (_, i) => ({ sprache: 'EN', art: 'wort', deutsch: `w${i}` }));
  assert.equal((await melde(viele)).status, 413);
  assert.equal((await q('SELECT count(*)::int AS n FROM glossary_entries')).rows[0].n, vorher);
});

console.log('\nDeepL-Vorschlag mit Kontext (Bauplan §8)');

await pruefe('DeepL bekommt den ersten Beispielnamen als context, kein Glossar, Quelle DE, Ziel nach Sprachcode (CZ → cs)', async () => {
  deeplAufrufe.length = 0;
  antwortVonDeepL = () => 'kryt';
  const r = await melde([{ sprache: 'CZ', art: 'wort', deutsch: 'Cover', beispiele: ['Cover opal für Profil Sys-Wall68, 2m', 'Cover klar für Profil X'] }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deepl, { geholt: 1, verworfen: 0, ausstehend: 0, fehler: null });
  assert.equal(deeplAufrufe.length, 1);
  const a = deeplAufrufe[0];
  assert.deepEqual(a.texte, ['Cover']);
  assert.equal(a.quelle, 'de');
  assert.equal(a.ziel, 'cs');
  assert.equal(a.optionen.context, 'Cover opal für Profil Sys-Wall68, 2m');
  assert.equal(a.optionen.glossary, undefined, 'kein Glossar: der DeepL-Wert soll eine eigene Quelle sein');
  const z = await vorlaeufig('CZ', 'Cover');
  assert.equal(z.vorschlag_deepl, 'kryt');
  assert.equal(z.target_term, 'kryt');
  assert.equal(z.quelle, 'gemeldet', 'die Quelle des Vorschlags bleibt die Meldung');
});

await pruefe('ohne Beispiel wird DeepL nicht gefragt; ein Wort ohne Zusammenhang ist der alte Fehlerweg', async () => {
  deeplAufrufe.length = 0;
  const r = await melde([{ sprache: 'ES', art: 'wort', deutsch: 'rund' }]);
  assert.equal(r.body.angelegt, 1);
  assert.deepEqual(r.body.deepl, { geholt: 0, verworfen: 0, ausstehend: 0, fehler: null });
  assert.equal(deeplAufrufe.length, 0);
  assert.equal((await vorlaeufig('ES', 'rund')).vorschlag_deepl, null);
  antwortVonDeepL = () => 'redondo';
  const b = await melde([{ sprache: 'ES', art: 'wort', deutsch: 'rund', beispiele: ['Einbaustrahler rund, weiß, GU10'] }]);
  assert.equal(b.body.aktualisiert, 1);
  assert.equal(b.body.deepl.geholt, 1);
  assert.equal(deeplAufrufe[0].optionen.context, 'Einbaustrahler rund, weiß, GU10');
  assert.equal((await vorlaeufig('ES', 'rund')).vorschlag_deepl, 'redondo');
});

await pruefe('ein vorhandener DeepL-Wert wird nicht noch einmal geholt und nicht überschrieben', async () => {
  deeplAufrufe.length = 0;
  antwortVonDeepL = () => 'anders';
  const r = await melde([{ sprache: 'ES', art: 'wort', deutsch: 'rund', beispiele: ['Pendelleuchte rund, schwarz'] }]);
  assert.equal(r.body.aktualisiert, 1);
  assert.deepEqual(r.body.deepl, { geholt: 0, verworfen: 0, ausstehend: 0, fehler: null });
  assert.equal(deeplAufrufe.length, 0);
  assert.equal((await vorlaeufig('ES', 'rund')).vorschlag_deepl, 'redondo');
});

await pruefe('bekannt und abgelehnt fragen DeepL nicht', async () => {
  deeplAufrufe.length = 0;
  const r = await melde([
    { sprache: 'FR', art: 'wort', deutsch: 'Weiß', beispiele: ['Leuchte Weiß'] },
    { sprache: 'IT', art: 'wort', deutsch: 'Bügel', beispiele: ['Bügel für Profil'] },
  ]);
  assert.deepEqual([r.body.bekannt, r.body.abgelehnt], [1, 1]);
  assert.equal(deeplAufrufe.length, 0);
});

await pruefe('verliert DeepL einen geschützten Wert, bleibt das Feld leer und die Zeile zählt als verworfen', async () => {
  deeplAufrufe.length = 0;
  antwortVonDeepL = (t) => t.replace(/_*ISOLUNIT\d+_*/u, '');
  const r = await melde([{ sprache: 'IT', art: 'muster', deutsch: '24V DC Rolle', beispiele: ['Flexband 24V DC Rolle, 5m'] }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deepl, { geholt: 0, verworfen: 1, ausstehend: 0, fehler: null });
  assert.equal(deeplAufrufe.length, 1);
  assert.ok(!deeplAufrufe[0].texte[0].includes('24V'), 'der Wert ging geschützt hinaus');
  const z = await vorlaeufig('IT', '24V DC Rolle');
  assert.equal(z.vorschlag_deepl, null);
  assert.deepEqual([z.art, z.an_deepl], ['muster', false], 'ein Muster geht nie an DeepL');
});

await pruefe('DeepL-Fehler: Meldungen bleiben gespeichert, der Rest steht als ausstehend, kein weiterer Aufruf', async () => {
  deeplAufrufe.length = 0;
  const echt = deepl.Translator.prototype.translateText;
  let n = 0;
  deepl.Translator.prototype.translateText = async () => { n += 1; throw new Error('Kontingent erschöpft'); };
  try {
    const r = await melde([
      { sprache: 'HU', art: 'wort', deutsch: 'Fehlerwort1', beispiele: ['Name mit Fehlerwort1'] },
      { sprache: 'HU', art: 'wort', deutsch: 'Fehlerwort2', beispiele: ['Name mit Fehlerwort2'] },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.body.angelegt, 2);
    assert.deepEqual(r.body.deepl, { geholt: 0, verworfen: 0, ausstehend: 2, fehler: 'DeepL hat nicht geantwortet' });
    assert.equal(n, 1, 'nach dem ersten Fehler kein weiterer Aufruf');
  } finally {
    deepl.Translator.prototype.translateText = echt;
  }
  assert.ok(await vorlaeufig('HU', 'Fehlerwort1'));
  antwortVonDeepL = () => 'pótlás';
  const b = await melde([{ sprache: 'HU', art: 'wort', deutsch: 'Fehlerwort1', beispiele: ['Name mit Fehlerwort1'] }]);
  assert.equal(b.body.deepl.geholt, 1, 'die nächste Meldung holt nach');
});

await pruefe(`höchstens ${MAX_DEEPL_JE_ANFRAGE} DeepL-Aufrufe je Anfrage, die größten Artikelzahlen zuerst`, async () => {
  deeplAufrufe.length = 0;
  antwortVonDeepL = (t) => `pl-${t}`;
  const viele = Array.from({ length: MAX_DEEPL_JE_ANFRAGE + 2 }, (_, i) =>
    ({ sprache: 'PL', art: 'wort', deutsch: `Grenzwort${i}`, artikelAnzahl: i, beispiele: [`Name ${i}`] }));
  const r = await melde(viele);
  assert.equal(r.body.angelegt, MAX_DEEPL_JE_ANFRAGE + 2);
  assert.deepEqual(r.body.deepl, { geholt: MAX_DEEPL_JE_ANFRAGE, verworfen: 0, ausstehend: 2, fehler: null });
  assert.equal(deeplAufrufe.length, MAX_DEEPL_JE_ANFRAGE);
  assert.equal((await vorlaeufig('PL', 'Grenzwort0')).vorschlag_deepl, null, 'die kleinste Artikelzahl bleibt liegen');
  assert.equal((await vorlaeufig('PL', `Grenzwort${MAX_DEEPL_JE_ANFRAGE + 1}`)).vorschlag_deepl, `pl-Grenzwort${MAX_DEEPL_JE_ANFRAGE + 1}`);
});

await pruefe('ohne DEEPL_API_KEY: kein Aufruf, ausstehend mit Grund, die Meldung ist trotzdem gespeichert', async () => {
  deeplAufrufe.length = 0;
  const alt = config.deepl.apiKey;
  config.deepl.apiKey = '';
  try {
    const r = await melde([{ sprache: 'SK', art: 'wort', deutsch: 'Rolle', beispiele: ['Flexband 5m Rolle'] }]);
    assert.equal(r.body.angelegt, 1);
    assert.deepEqual(r.body.deepl, { geholt: 0, verworfen: 0, ausstehend: 1, fehler: 'DEEPL_API_KEY ist nicht gesetzt' });
    assert.equal(deeplAufrufe.length, 0);
  } finally {
    config.deepl.apiKey = alt;
  }
});

server.close();
await pool.end();
console.log(`\n${gruen} grün, ${rot} rot`);
process.exit(rot === 0 ? 0 : 1);
