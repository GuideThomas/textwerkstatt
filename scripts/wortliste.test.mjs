#!/usr/bin/env node
/**
 * Prüfungen für die Wortliste Phase 1: Migration 036 und die Fließtext-Leser (Plan `PLAN-wortliste.md` §2.1–§2.3, Cockpit #1829).
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank. Das Passwort kommt aus der Umgebung, DeepL wird nicht
 * aufgerufen (die Translator-Methoden sind ersetzt und zeichnen auf):
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-wortliste-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:55441:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=55441 DB_NAME=translationtool_test DB_USER=translationtool node scripts/wortliste.test.mjs
 *
 * Was belegt wird:
 *   1. 036 lässt den Bestand unverändert: jede Zeile bleibt Wort und geht an DeepL; der DeepL-Abgleich schickt vorher und nachher
 *      dieselben Einträge. Zweimal migrieren ändert nichts.
 *   2. Eine Zeile mit `an_deepl = FALSE` erreicht keinen Fließtext-Leser (DeepL-Abgleich, Channel-Ersetzung, Kürzung);
 *      Gegenprobe: mit TRUE erreicht sie jeden.
 *   3. Die Schranken der Tabelle: Muster nie an DeepL, Serie bleibt, Genus nur am Hauptwort, Formen nur am Adjektiv.
 *   4. Schreibung: `COVER` neben `Cover` sind zwei Zeilen; eine exakte Dublette im Bestand hält 036 nicht auf. Den eindeutigen
 *      Schlüssel je Schreibung bringt erst Phase 3, nach dem Zusammenlegen (Plan §2.1).
 *   5. Das Ziel einer offenen Zeile folgt den Vorschlägen in der Reihenfolge Prüftabelle, Glossar, Markt, DeepL, aber nicht über
 *      eine Handänderung und nie an einer freigegebenen Zeile.
 *   6. `wortliste_freigegeben` kennt nur Freigegebenes (Gegenprobe: die Sicht ohne Bedingung ließe Offenes durch),
 *      `wortliste_offen` nur Offenes.
 *   7. Quelltext: Die sechs Fließtext-Leser nennen `glossary_entries` nicht mehr. Eine Schicht, keine Garantie.
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

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('services', 'deepl.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};

// DeepL: Anlegen und Löschen eines Glossars zeichnen auf, was geschickt würde.
const deepl = require('deepl-node');
const angelegt = [];
deepl.Translator.prototype.createGlossary = async function (name, quelle, ziel, eintraege) {
  angelegt.push({ name, quelle, ziel, eintraege: eintraege.entries() });
  return { glossaryId: `attrappe-${angelegt.length}` };
};
deepl.Translator.prototype.deleteGlossary = async function () {};

const { pool } = await laden('db', 'connection.js');
const { syncGlossaryToDeepL } = await laden('services', 'deepl.js');
const { getChannelOverrides } = await laden('services', 'channel-overrides.js');
const { getGlossaryTerms } = await laden('services', 'condensing.js');
const q = (sql, p) => pool.query(sql, p);

const db = (await q('SELECT current_database() AS n')).rows[0].n;
assert.ok(db.endsWith('_test'), 'falsche Datenbank');
// Ein eigener Wegwerf-Server hat nur diese eine Datenbank (Befund 06.11.2026: ein fremder Testserver auf demselben Port).
const fremde = (await q(
  `SELECT count(*)::int AS n FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', current_database())`,
)).rows[0].n;
if (fremde > 0) {
  console.error(`Abbruch: Der Server hat ${fremde} weitere Datenbank(en), das ist kein eigener Wegwerf-Server.`);
  process.exit(2);
}

const MIGRATIONEN = join(WURZEL, 'migrations');
const TESTSEED = readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8');
const dateien = readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort();
const migriere = async (bis = null) => {
  for (const f of dateien) {
    if (bis && f >= bis) break;
    await q(readFileSync(join(MIGRATIONEN, f), 'utf-8'));
  }
  await q(TESTSEED);
};
const neuesSchema = () => q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

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

async function glossar(ziel) {
  return (await q(
    `INSERT INTO glossaries (name, source_lang, target_lang) VALUES ($1, 'DE', $2) RETURNING id`,
    [`Glossar DE→${ziel}`, ziel],
  )).rows[0].id;
}
async function zeile(gid, quelle, ziel, extra = {}) {
  const felder = { glossary_id: gid, source_term: quelle, target_term: ziel, approved: true, ...extra };
  const spalten = Object.keys(felder);
  const werte = spalten.map((k) => (k === 'formen' && felder[k] !== null ? JSON.stringify(felder[k]) : felder[k]));
  const p = spalten.map((_, i) => `$${i + 1}`).join(', ');
  return (await q(`INSERT INTO glossary_entries (${spalten.join(', ')}) VALUES (${p}) RETURNING id`, werte)).rows[0].id;
}
async function anDeepL(gid) {
  angelegt.length = 0;
  await syncGlossaryToDeepL(gid, 'probe', 'DE', 'FR');
  assert.equal(angelegt.length, 1, 'genau ein Glossar bei DeepL angelegt');
  return angelegt[0].eintraege;
}
const schemaStand = async () => (await q(`
  SELECT (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'glossary_entries'::regclass) AS c,
         (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public') AS i,
         (SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.views WHERE table_schema = 'public') AS v,
         (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal) AS t,
         (SELECT count(*) FROM glossary_entries) AS n`)).rows[0];

console.log('Wortliste Phase 1 (Migration 036)');

// ── 1. Bestand vor 036 anlegen, dann 036 laufen lassen ─────────────────────────────────────────────────────────────────
await neuesSchema();
await migriere('036');
const FR = await glossar('FR');
const EN = await glossar('EN');
const flex = await zeile(FR, 'Flexband', 'ruban LED');
await zeile(FR, 'Rolle', 'rouleau');
await zeile(FR, 'COVER', 'COVER');
await zeile(FR, 'Cover', 'cache');
await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPA', 'bande LED')`, [flex]);
await zeile(EN, 'Flexband', 'flex strip');
// Vor 036 gibt es die Sicht nicht: Der Vorher-Stand kommt aus den Abfragen des alten Codes im Wortlaut (deepl.ts, channel-overrides.ts
// bis 10.11.2026), der Nachher-Stand aus dem neuen Code.
const vorher = Object.fromEntries((await q(
  `SELECT source_term, target_term FROM glossary_entries WHERE glossary_id = $1 AND approved = TRUE ORDER BY source_term`, [FR],
)).rows.map((r) => [r.source_term, r.target_term]));
const kanalVorher = (await q(
  `SELECT ge.source_term, gec.target_term AS channel_target_term
     FROM glossary_entries ge JOIN glossaries g ON g.id = ge.glossary_id JOIN glossary_entry_channels gec ON gec.entry_id = ge.id
    WHERE g.source_lang = 'DE' AND g.target_lang = 'FR' AND gec.channel_code = 'SHOPA' AND ge.approved = TRUE
    ORDER BY LENGTH(ge.source_term) DESC, ge.source_term`,
)).rows.map((r) => [r.source_term, r.channel_target_term]);
assert.equal(Object.keys(vorher).length, 4, 'Vorher-Stand: vier Einträge FR');

await migriere();

await pruefe('036 lässt den Bestand unverändert: Wort, an DeepL, gleiche Einträge bei DeepL', async () => {
  const r = (await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE art = 'wort' AND an_deepl)::int AS gleich FROM glossary_entries`)).rows[0];
  assert.equal(r.n, 5);
  assert.equal(r.gleich, 5);
  assert.deepEqual(await anDeepL(FR), vorher);
  assert.deepEqual((await getChannelOverrides('DE', 'FR', 'SHOPA')).map((o) => [o.sourceTerm, o.channelTargetTerm]), kanalVorher);
});

await pruefe('zweimal migrieren ändert nichts', async () => {
  const a = await schemaStand();
  await migriere();
  assert.deepEqual(await schemaStand(), a);
});

// ── 2. an_deepl = FALSE erreicht keinen Fließtext-Leser, TRUE jeden ─────────────────────────────────────────────────────
const nurName = await zeile(FR, 'Wannenleuchte', 'luminaire étanche', { an_deepl: false });
await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPA', 'réglette étanche')`, [nurName]);

await pruefe('an_deepl = FALSE: nicht im DeepL-Glossar, nicht in der Channel-Ersetzung, nicht in der Kürzung', async () => {
  assert.equal((await anDeepL(FR)).Wannenleuchte, undefined);
  assert.ok(!(await getChannelOverrides('DE', 'FR', 'SHOPA')).some((o) => o.sourceTerm === 'Wannenleuchte'));
  assert.ok(!(await getGlossaryTerms('DE', 'FR')).includes('luminaire étanche'));
});

await pruefe('Gegenprobe: an_deepl = TRUE erreicht alle drei', async () => {
  await q(`UPDATE glossary_entries SET an_deepl = TRUE WHERE id = $1`, [nurName]);
  try {
    assert.equal((await anDeepL(FR)).Wannenleuchte, 'luminaire étanche');
    assert.ok((await getChannelOverrides('DE', 'FR', 'SHOPA')).some((o) => o.sourceTerm === 'Wannenleuchte'));
    assert.ok((await getGlossaryTerms('DE', 'FR')).includes('luminaire étanche'));
  } finally {
    await q(`UPDATE glossary_entries SET an_deepl = FALSE WHERE id = $1`, [nurName]);
  }
});

await pruefe('eine offene Zeile geht nicht an DeepL, auch mit an_deepl', async () => {
  await zeile(FR, 'Endkappe', 'embout', { approved: false });
  assert.equal((await anDeepL(FR)).Endkappe, undefined);
});

// ── 3. Schranken der Tabelle ───────────────────────────────────────────────────────────────────────────────────────────
const lehntAb = async (sql, p, constraint) => {
  await assert.rejects(q(sql, p), (e) => e.constraint === constraint || new RegExp(constraint).test(e.message));
};
await pruefe('Muster nie an DeepL', async () => {
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, art) VALUES ($1, '#m Rolle', '# m rouleau', TRUE, 'muster')`,
    [FR], 'glossary_entries_muster_nie_an_deepl');
  await zeile(FR, '#m Rolle', '# m rouleau', { art: 'muster', an_deepl: false });
});
await pruefe('Serie bleibt, wie sie ist, auch im Namen', async () => {
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, art) VALUES ($1, 'NEON927', 'néon927', TRUE, 'fest')`,
    [FR], 'glossary_entries_fest_bleibt');
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, art, ziel_name) VALUES ($1, 'NEON927', 'NEON927', TRUE, 'fest', 'neon')`,
    [FR], 'glossary_entries_fest_bleibt');
  await zeile(FR, 'NEON927', 'NEON927', { art: 'fest' });
});
await pruefe('Genus nur am Hauptwort, Formen nur am Adjektiv, Art aus der Liste', async () => {
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, genus) VALUES ($1, 'Profil', 'profilé', TRUE, 'm')`,
    [FR], 'glossary_entries_genus_am_hauptwort');
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, wortart, genus) VALUES ($1, 'Profil', 'profilé', TRUE, 'adjektiv', 'm')`,
    [FR], 'glossary_entries_genus_am_hauptwort');
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, formen) VALUES ($1, 'schwarz', 'noir', TRUE, '{"f":"noire"}')`,
    [FR], 'glossary_entries_formen_am_adjektiv');
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, wortart, formen) VALUES ($1, 'schwarz', 'noir', TRUE, 'hauptwort', '{"f":"noire"}')`,
    [FR], 'glossary_entries_formen_am_adjektiv');
  await lehntAb(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, art) VALUES ($1, 'x', 'y', TRUE, 'satz')`,
    [FR], 'glossary_entries_art_gueltig');
  await zeile(FR, 'Profil', 'profilé', { wortart: 'hauptwort', genus: 'm' });
  await zeile(FR, 'schwarz', 'noir', { wortart: 'adjektiv', formen: { m: 'noir', f: 'noire' } });
});

// ── 4. Schreibung: COVER neben Cover (der eindeutige Schlüssel kommt mit Phase 3) ──────────────────────────────────────────
await pruefe('COVER neben Cover: zwei Zeilen, beide in der Sicht für Namen', async () => {
  const n = (await q(`SELECT count(*)::int AS n FROM wortliste_freigegeben WHERE sprache = 'FR' AND lower(deutsch) = 'cover'`)).rows[0].n;
  assert.equal(n, 2);
});

// ── 5. Ziel einer offenen Zeile folgt den Vorschlägen ────────────────────────────────────────────────────────────────────
const ziel = async (id) => (await q(`SELECT target_term FROM glossary_entries WHERE id = $1`, [id])).rows[0].target_term;
await pruefe('Ziel folgt Prüftabelle vor Glossar vor Markt vor DeepL', async () => {
  const id = await zeile(FR, 'Einputzdose', null, { approved: false });
  await q(`INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_deepl) VALUES ($1, 'deepl', 'boîte à encastrer')`, [id]);
  assert.equal(await ziel(id), 'boîte à encastrer');
  await q(`UPDATE wortliste_vorschlag SET vorschlag_markt = 'boîte d''encastrement' WHERE entry_id = $1`, [id]);
  assert.equal(await ziel(id), 'boîte d\'encastrement');
  await q(`UPDATE wortliste_vorschlag SET vorschlag_pruefung = 'boîte encastrable' WHERE entry_id = $1`, [id]);
  assert.equal(await ziel(id), 'boîte encastrable');
  await q(`UPDATE wortliste_vorschlag SET vorschlag_glossar = 'boîte' WHERE entry_id = $1`, [id]);
  assert.equal(await ziel(id), 'boîte encastrable', 'Glossar steht hinter der Prüftabelle');
});
await pruefe('keine Überschreibung einer Handänderung, keine an einer freigegebenen Zeile', async () => {
  const hand = await zeile(FR, 'Aufbaurahmen', null, { approved: false });
  await q(`INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_deepl) VALUES ($1, 'deepl', 'cadre')`, [hand]);
  await q(`UPDATE glossary_entries SET target_term = 'cadre en saillie' WHERE id = $1`, [hand]);
  await q(`UPDATE wortliste_vorschlag SET vorschlag_pruefung = 'cadre apparent' WHERE entry_id = $1`, [hand]);
  assert.equal(await ziel(hand), 'cadre en saillie');
  const frei = await zeile(FR, 'Stromschiene', 'rail');
  await q(`INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_pruefung) VALUES ($1, 'pruefung', 'rail d''alimentation')`, [frei]);
  assert.equal(await ziel(frei), 'rail');
});

// ── 6. Sichten ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const offenId = (await q(`SELECT id FROM glossary_entries WHERE source_term = 'Einputzdose'`)).rows[0].id;
await q(`UPDATE wortliste_vorschlag SET rueckfrage = 'Unterputz oder Hohlwand?' WHERE entry_id = $1`, [offenId]);
const leer = await zeile(FR, 'Schukostecker', null, { approved: false });
await q(`INSERT INTO glossary_entry_gruppen (entry_id, produktgruppe, target_term, genus) VALUES ($1, 16, 'diffuseur', 'm'), ($1, 5, 'collerette', 'f')`,
  [(await q(`SELECT id FROM glossary_entries WHERE source_term = 'Cover' AND glossary_id = $1`, [FR])).rows[0].id]);

/** Die Prüfung der Sicht, über einen beliebigen Client, damit die Gegenprobe dieselbe Prüfung gegen eine geänderte Sicht fährt. */
async function pruefeFreigegeben(c) {
  const z = (await c.query(`SELECT * FROM wortliste_freigegeben WHERE sprache = 'FR'`)).rows;
  const deutsch = z.map((r) => r.deutsch);
  for (const offen of ['Endkappe', 'Einputzdose', 'Aufbaurahmen', 'Schukostecker']) assert.ok(!deutsch.includes(offen), `offen: ${offen}`);
  for (const frei of ['Flexband', 'Wannenleuchte', '#m Rolle', 'NEON927', 'Stromschiene']) assert.ok(deutsch.includes(frei), frei);
  assert.deepEqual(z.find((r) => r.deutsch === 'Flexband').kanaele, { SHOPA: 'bande LED' });
  assert.deepEqual(z.find((r) => r.deutsch === 'Cover').gruppen.map((g) => [g.produktgruppe, g.ziel]), [[5, 'collerette'], [16, 'diffuseur']]);
  assert.equal(z.find((r) => r.deutsch === 'Wannenleuchte').an_deepl, false, 'Namenswörter sind dabei');
}
await pruefe('wortliste_freigegeben: nur Freigegebenes, mit Channel-Werten und Gruppenzielen', () => pruefeFreigegeben(pool));
await pruefe('Gegenprobe: dieselbe Sicht ohne ihre Bedingung fällt durch dieselbe Prüfung', async () => {
  const sql = readFileSync(join(MIGRATIONEN, '036_wortliste.sql'), 'utf-8');
  const def = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW wortliste_freigegeben'));
  const ohne = def.slice(0, def.indexOf(';') + 1).replace(/WHERE e\.approved = TRUE AND e\.target_term IS NOT NULL\s+AND /u, 'WHERE ');
  assert.notEqual(ohne, def.slice(0, def.indexOf(';') + 1), 'die Bedingung steht nicht mehr im erwarteten Wortlaut');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(ohne);
    await assert.rejects(pruefeFreigegeben(c), /offen: /u);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
await pruefe('wortliste_offen: nur Offenes, mit Status und Herkunft', async () => {
  const z = (await q(`SELECT * FROM wortliste_offen WHERE sprache = 'FR' ORDER BY deutsch`)).rows;
  assert.deepEqual(z.map((r) => r.deutsch), ['Aufbaurahmen', 'Einputzdose', 'Endkappe', 'Schukostecker']);
  const e = z.find((r) => r.deutsch === 'Einputzdose');
  assert.equal(e.status, 'rueckfrage');
  assert.equal(e.vorschlag_deepl, 'boîte à encastrer');
  assert.equal(z.find((r) => r.deutsch === 'Schukostecker').ziel, null);
  assert.equal(z.find((r) => r.deutsch === 'Endkappe').status, 'vorschlag');
  void leer;
});

// ── 4b. Bestand mit exakter Dublette (2 im Bestand, gemessen 10.11.2026): 036 läuft durch und lässt sie stehen ──────────────
await pruefe('exakte Dublette im Bestand: 036 ohne Abbruch, beide Zeilen bleiben', async () => {
  await neuesSchema();
  await migriere('036');
  const IT = await glossar('IT');
  await zeile(IT, 'Profil', 'profilo');
  await zeile(IT, 'Profil', 'profilo');
  await migriere();
  await migriere();
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossary_entries WHERE glossary_id = $1`, [IT])).rows[0].n, 2);
});

// ── 7. Quelltext der Fließtext-Leser ─────────────────────────────────────────────────────────────────────────────────────
await pruefe('Quelltext: die sechs Fließtext-Leser nennen glossary_entries nicht', async () => {
  const leser = ['src/services/deepl.ts', 'src/services/channel-overrides.ts', 'src/routes/batch-translate.ts',
    'src/routes/quick-translate.ts', 'src/services/condensing.ts', 'src/services/queue.ts'];
  for (const f of leser) {
    const s = readFileSync(join(WURZEL, f), 'utf-8');
    assert.ok(s.includes('glossar_an_deepl'), `${f} liest die Sicht nicht`);
    assert.ok(!/\b(FROM|JOIN)\s+glossary_entries\b/i.test(s), `${f} liest glossary_entries direkt`);
  }
});

await pool.end();
console.log(`\n${ok} grün, ${fehler.length} rot`);
process.exit(fehler.length ? 1 : 0);
