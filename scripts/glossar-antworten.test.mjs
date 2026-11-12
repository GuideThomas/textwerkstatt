#!/usr/bin/env node
/**
 * Prüfungen für das Einspielen von Muttersprachler-Antworten ins Glossar (`services/glossar-antworten.ts`,
 * `scripts/glossar-antworten-einspielen.ts`, erste Sprache EN am 06.11.2026).
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank; DeepL ist ersetzt:
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-antworten-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:<freier Port>:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=<Port> DB_NAME=translationtool_test DB_USER=translationtool node scripts/glossar-antworten.test.mjs
 *
 * 🚨 Der Lauf löscht das Schema `public`. Er bricht ab, wenn die Datenbank nicht auf `_test` endet, nicht lokal liegt oder der
 * Server weitere Datenbanken führt (dann ist es kein eigener Wegwerf-Server).
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
if (!existsSync(dist('scripts', 'glossar-antworten-einspielen.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};

// DeepL ersetzt: Ein angelegtes Glossar wird gemerkt und beim Zurücklesen geliefert.
const deepl = require('deepl-node');
const beiDeepL = new Map();
let lieferBeimLesen = null;
deepl.Translator.prototype.createGlossary = async function (name, q, z, eintraege) {
  const id = `attrappe-${beiDeepL.size + 1}`;
  beiDeepL.set(id, eintraege.entries());
  return { glossaryId: id };
};
deepl.Translator.prototype.deleteGlossary = async function () {};
deepl.Translator.prototype.getGlossaryEntries = async function (id) {
  const e = lieferBeimLesen ? lieferBeimLesen(beiDeepL.get(id)) : beiDeepL.get(id);
  return { entries: () => e };
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

await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
const MIGRATIONEN = join(WURZEL, 'migrations');
const TESTSEED = readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8');
for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) {
  await q(readFileSync(join(MIGRATIONEN, f), 'utf-8'));
}
await q(TESTSEED);

const { leseAntworten } = await laden('services', 'glossar-antworten.js');
const { einspielen } = await laden('scripts', 'glossar-antworten-einspielen.js');

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

const WER = 'Muttersprachler EN, Glossar-Blatt 06.11.2026 (Test)';
const KOPF = 'zeile\tdeutsch\theute\tbis0411\tvorschlag\tstand\tentscheidung';
const liste = (...zeilen) => [KOPF, ...zeilen.map((z, i) => [i + 2, ...z].join('\t'))].join('\n') + '\n';
const ANTWORTEN = liste(
  ['Aufbau', 'surface mounting', '', 'surface-mounted', 'offen / open', 'Vorschlag / Proposal'],
  ['Seilabhängung', 'cable suspension', '', 'wire suspension', 'offen / open', 'Vorschlag / Proposal'],
  ['Schiene', 'rail', '', 'track', 'offen / open', 'Vorschlag / Proposal'],
  ['Flexband', 'flex strip', 'flex stripe', '', 'neu, intern entschieden / new, decided internally', 'OK'],
);

let EN;
let FR;
const id = async (glossar, begriff) => (await q(`SELECT id FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [glossar, begriff])).rows[0].id;
const wert = async (glossar, begriff) => (await q(`SELECT target_term FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [glossar, begriff])).rows[0]?.target_term;
const version = async (glossar) => (await q(`SELECT version, synced_version FROM glossaries WHERE id = $1`, [glossar])).rows[0];

/** Baut den Ausgangsstand neu auf: EN wie im Blatt gesehen, dazu FR als Unbeteiligter. */
const aufsetzen = async () => {
  await q('TRUNCATE glossaries, glossary_entry_history, glossary_hints, segments CASCADE');
  // Eine Prüfung nimmt den Schlüssel je Schreibung weg, um den Stand vor dem Umzug nachzubilden; hier kommt er zurück.
  await q('CREATE UNIQUE INDEX IF NOT EXISTS uq_glossary_entries_schreibung ON glossary_entries (glossary_id, btrim(source_term))');
  beiDeepL.clear();
  lieferBeimLesen = null;
  EN = (await q(`INSERT INTO glossaries (name, source_lang, target_lang, version, synced_version, deepl_glossary_id)
                 VALUES ('Glossar DE→EN', 'DE', 'EN', 5, 5, 'alt-en') RETURNING id`)).rows[0].id;
  FR = (await q(`INSERT INTO glossaries (name, source_lang, target_lang, version, synced_version, deepl_glossary_id)
                 VALUES ('Glossar DE→FR', 'DE', 'FR', 3, 3, 'alt-fr') RETURNING id`)).rows[0].id;
  const neu = (g, d, z, ok = true) => q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source) VALUES ($1, $2, $3, $4, 'manual')`, [g, d, z, ok]);
  await neu(EN, 'Aufbau', 'surface mounting');
  await neu(EN, 'AUFBAU', 'SURFACE MOUNTING');
  await neu(EN, 'Seilabhängung', 'cable suspension');
  await neu(EN, 'Schiene', 'rail');
  await neu(EN, 'Flexband', 'flex strip');
  await neu(EN, 'Profil', 'profile');
  await neu(FR, 'Aufbau', 'en saillie');
  await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPA', 'hanging wire system')`, [await id(EN, 'Seilabhängung')]);
  const hinweis = (g, d, z) => q(`INSERT INTO glossary_hints (glossary_id, source_term, target_term, kategorie, gewissheit, quelle, grund)
                                   VALUES ($1, $2, $3, 'sprachlich', 'mittel', 'fachlich', 'Test')`, [g, d, z]);
  await hinweis(EN, 'Flexband', 'flex strip');
  await hinweis(EN, 'Schiene', 'rail');
  await hinweis(EN, 'Profil', 'profile');
  const seg = (sp, t) => q(`INSERT INTO segments (segment_hash, source_lang, target_lang, source_text, translated_text, glossary_version)
                            VALUES (md5($2 || $1), 'DE', $1, $2, 'x', 1)`, [sp, t]);
  await seg('EN', 'LED Profil mit Seilabhängung');
  await seg('EN', 'LED Profil für Decke');
  await seg('FR', 'LED Aufbau rund');
  // Seit Migration 037 schreibt schon das Anlegen oben Verlauf (unter „unbekannt“). Gezählt wird nur, was das Einspielen schreibt.
  await q('TRUNCATE glossary_entry_history');
};

console.log('Liste lesen');

await pruefe('liest Kopfzeile und Entscheidungen, OK und Vorschlag', async () => {
  const z = leseAntworten(ANTWORTEN);
  assert.equal(z.length, 4);
  assert.deepEqual(z.map((x) => x.entscheidung), ['vorschlag', 'vorschlag', 'vorschlag', 'ok']);
  assert.equal(z[0].zeile, 2);
});

await pruefe('lehnt unbekannte Entscheidung, Vorschlag ohne Wert, doppelten Begriff und fehlende Spalte ab', async () => {
  assert.throws(() => leseAntworten(liste(['Aufbau', 'x', '', 'y', '', 'ohne Eintrag / no entry'])), /kann dieser Weg nicht/);
  assert.throws(() => leseAntworten(liste(['Aufbau', 'x', '', '', '', 'Vorschlag / Proposal'])), /kein Vorschlag da/);
  assert.throws(() => leseAntworten(liste(['Aufbau', 'x', '', 'y', '', 'OK'], ['Aufbau', 'x', '', 'y', '', 'OK'])), /doppelt/);
  assert.throws(() => leseAntworten(liste(['Aufbau', 'x', '', 'x', '', 'Vorschlag / Proposal'])), /gleich dem heutigen/);
  assert.throws(() => leseAntworten('deutsch\theute\nAufbau\tx\n'), /fehlen Spalten/);
});

console.log('Einspielen');

await pruefe('Trockenlauf: rechnet alles, schreibt nichts', async () => {
  await aufsetzen();
  const b = await einspielen({ sprache: 'EN', text: ANTWORTEN, wer: WER, ausfuehren: false });
  assert.deepEqual(b.abweichungen, []);
  assert.equal(b.ausgefuehrt, false);
  assert.equal(b.aenderungen.length, 4, 'drei Standardwerte und die Blockzeile');
  assert.equal(b.versionNachher, 6, 'in der Transaktion gerechnet');
  assert.equal(await wert(EN, 'Aufbau'), 'surface mounting');
  assert.equal((await version(EN)).version, 5);
  assert.equal((await q('SELECT count(*)::int AS n FROM glossary_entry_history')).rows[0].n, 0);
  assert.equal((await q('SELECT count(*)::int AS n FROM glossary_hints WHERE verworfen_am IS NOT NULL')).rows[0].n, 0);
  assert.equal(beiDeepL.size, 0, 'kein Abgleich mit DeepL');
});

await pruefe('Ausführen: Werte ersetzt, Blockzeile nachgezogen, Channel-Wert bleibt, Verlauf mit Rolle, eine Version mehr', async () => {
  await aufsetzen();
  const b = await einspielen({ sprache: 'EN', text: ANTWORTEN, wer: WER, ausfuehren: true });
  assert.deepEqual(b.abweichungen, []);
  assert.equal(b.ausgefuehrt, true);
  assert.equal(await wert(EN, 'Aufbau'), 'surface-mounted');
  assert.equal(await wert(EN, 'AUFBAU'), 'SURFACE-MOUNTED');
  assert.equal(await wert(EN, 'Seilabhängung'), 'wire suspension');
  assert.equal(await wert(EN, 'Schiene'), 'track');
  assert.equal(await wert(EN, 'Flexband'), 'flex strip', 'OK ändert nichts');
  assert.equal(await wert(EN, 'Profil'), 'profile');
  assert.equal(await wert(FR, 'Aufbau'), 'en saillie', 'ein anderes Glossar bleibt');
  const k = (await q(`SELECT target_term FROM glossary_entry_channels WHERE entry_id = $1`, [await id(EN, 'Seilabhängung')])).rows;
  assert.deepEqual(k.map((r) => r.target_term), ['hanging wire system']);
  const v = (await q(`SELECT source_term, old_value, new_value, changed_by_name FROM glossary_entry_history ORDER BY source_term`)).rows;
  assert.equal(v.length, 4);
  assert.ok(v.every((r) => r.changed_by_name === WER));
  assert.deepEqual(v.find((r) => r.source_term === 'AUFBAU'), { source_term: 'AUFBAU', old_value: 'SURFACE MOUNTING', new_value: 'SURFACE-MOUNTED', changed_by_name: WER });
  const ve = await version(EN);
  assert.equal(ve.version, 6, 'genau eine Version mehr');
  assert.equal((await version(FR)).version, 3);
});

await pruefe('Ausführen: DeepL abgeglichen und zurückgelesen, synced_version = version', async () => {
  // Stand aus der vorigen Prüfung.
  const ve = await version(EN);
  assert.equal(ve.synced_version, ve.version);
  const id = (await q(`SELECT deepl_glossary_id FROM glossaries WHERE id = $1`, [EN])).rows[0].deepl_glossary_id;
  assert.notEqual(id, 'alt-en');
  assert.equal(beiDeepL.get(id)['Aufbau'], 'surface-mounted');
  assert.equal(beiDeepL.get(id)['Seilabhängung'], 'wire suspension');
});

await pruefe('Ausführen: Cache veraltet nur, wo ein geänderter Begriff steht, und nur im eigenen Sprachpaar', async () => {
  const s = (await q(`SELECT target_lang, source_text, is_stale FROM segments ORDER BY target_lang, source_text`)).rows;
  assert.deepEqual(s.map((r) => [r.target_lang, r.source_text, r.is_stale]), [
    ['EN', 'LED Profil für Decke', false],
    ['EN', 'LED Profil mit Seilabhängung', true],
    ['FR', 'LED Aufbau rund', false],
  ]);
});

await pruefe('Ausführen: Hinweis zu einem OK verworfen, Hinweis zum alten Wert und fremde Hinweise bleiben stehen', async () => {
  const h = (await q(`SELECT source_term, verworfen_von FROM glossary_hints ORDER BY source_term`)).rows;
  assert.deepEqual(h, [
    { source_term: 'Flexband', verworfen_von: WER },
    { source_term: 'Profil', verworfen_von: null },
    { source_term: 'Schiene', verworfen_von: null },
  ]);
});

await pruefe('Ein zweiter Lauf mit derselben Liste hält an und schreibt nichts', async () => {
  const vorher = (await q('SELECT count(*)::int AS n FROM glossary_entry_history')).rows[0].n;
  const b = await einspielen({ sprache: 'EN', text: ANTWORTEN, wer: WER, ausfuehren: true });
  assert.ok(b.abweichungen.length >= 3, 'die drei geänderten Werte passen nicht mehr');
  assert.equal(b.ausgefuehrt, false);
  assert.equal((await q('SELECT count(*)::int AS n FROM glossary_entry_history')).rows[0].n, vorher);
});

await pruefe('Alles oder nichts: ein inzwischen geänderter Wert hält den ganzen Lauf an', async () => {
  await aufsetzen();
  await q(`UPDATE glossary_entries SET target_term = 'rail system' WHERE glossary_id = $1 AND source_term = 'Schiene'`, [EN]);
  const b = await einspielen({ sprache: 'EN', text: ANTWORTEN, wer: WER, ausfuehren: true });
  assert.equal(b.abweichungen.length, 1);
  assert.match(b.abweichungen[0], /Schiene.*rail system.*sah „rail“/);
  assert.equal(await wert(EN, 'Aufbau'), 'surface mounting', 'auch die passenden Zeilen bleiben');
  assert.equal((await version(EN)).version, 5);
  assert.equal((await q('SELECT count(*)::int AS n FROM glossary_hints WHERE verworfen_am IS NOT NULL')).rows[0].n, 0);
});

await pruefe('Hält an: Zeile fehlt, nicht freigegeben, zwei Zeilen zum Begriff, Blockzeile mit fremdem Wert', async () => {
  await aufsetzen();
  let b = await einspielen({ sprache: 'EN', text: liste(['Gibtsnicht', 'x', '', 'y', '', 'Vorschlag / Proposal']), wer: WER, ausfuehren: true });
  assert.match(b.abweichungen.join(), /keine Zeile/);
  await q(`UPDATE glossary_entries SET approved = FALSE WHERE glossary_id = $1 AND source_term = 'Profil'`, [EN]);
  b = await einspielen({ sprache: 'EN', text: liste(['Profil', 'profile', '', 'profile system', '', 'Vorschlag / Proposal']), wer: WER, ausfuehren: true });
  assert.match(b.abweichungen.join(), /nicht freigegeben/);
  // Zwei Zeilen gleicher Schreibung verbietet seit Migration 038 der Schlüssel je Schreibung; vor dem Umzug (Plan Wortliste Phase 3)
  // fehlt er am Server, weil Dubletten stehen. Diesen Stand bildet die Prüfung nach, `aufsetzen` legt den Schlüssel wieder an.
  await q('DROP INDEX IF EXISTS uq_glossary_entries_schreibung');
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Schiene', 'rail', TRUE)`, [EN]);
  b = await einspielen({ sprache: 'EN', text: liste(['Schiene', 'rail', '', 'track', '', 'Vorschlag / Proposal']), wer: WER, ausfuehren: true });
  assert.match(b.abweichungen.join(), /2 Zeilen/);
  await q(`UPDATE glossary_entries SET target_term = 'SURFACE' WHERE glossary_id = $1 AND source_term = 'AUFBAU'`, [EN]);
  b = await einspielen({ sprache: 'EN', text: liste(['Aufbau', 'surface mounting', '', 'surface-mounted', '', 'Vorschlag / Proposal']), wer: WER, ausfuehren: true });
  assert.match(b.abweichungen.join(), /Blockzeile „AUFBAU“ trägt „SURFACE“/);
  // Die Eingriffe der Prüfung selbst stehen als „unbekannt“ im Verlauf; das Einspielen hat nichts geschrieben.
  assert.equal((await q('SELECT count(*)::int AS n FROM glossary_entry_history WHERE changed_by_name = $1', [WER])).rows[0].n, 0);
});

await pruefe('DeepL liefert beim Zurücklesen den alten Wert: der Bericht nennt ihn', async () => {
  await aufsetzen();
  lieferBeimLesen = (e) => ({ ...e, Schiene: 'rail' });
  const b = await einspielen({ sprache: 'EN', text: ANTWORTEN, wer: WER, ausfuehren: true });
  assert.equal(b.ausgefuehrt, true);
  assert.deepEqual(b.deepl.falsch, ['Schiene: DeepL „rail“']);
});

await pruefe('Ohne genannten Bearbeiter wird nicht eingespielt; ein unbekanntes Glossar hält an', async () => {
  await aufsetzen();
  await assert.rejects(() => einspielen({ sprache: 'EN', text: ANTWORTEN, wer: '  ', ausfuehren: true }), /genannt/);
  await assert.rejects(() => einspielen({ sprache: 'HU', text: ANTWORTEN, wer: WER, ausfuehren: true }), /0 gefunden/);
  assert.equal((await version(EN)).version, 5);
});

await pool.end();
console.log(`\n${gruen} grün, ${rot} rot`);
process.exitCode = rot === 0 ? 0 : 1;
