#!/usr/bin/env node
/**
 * Prüfungen für das Einlesen der Prüftabellen als Namensbausteine (`services/namens-einlesen.ts`,
 * `scripts/namens-bausteine-einlesen.ts`, Migration 034).
 *
 * Die reinen Regeln laufen ohne Datenbank; der Rest gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank:
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-einlesen-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:<freier Port>:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=<Port> DB_NAME=translationtool_test DB_USER=translationtool node scripts/namens-einlesen.test.mjs
 *
 * 🚨 Der Lauf löscht das Schema `public`. Er bricht ab, wenn die Datenbank nicht auf `_test` endet, nicht lokal liegt oder der
 * Server weitere Datenbanken führt.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const istLokal = ['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '');
if (!process.env.DB_PASSWORD || !istLokal || !(process.env.DB_NAME ?? '').endsWith('_test')) {
  console.error('Abbruch: nur gegen eine lokale Datenbank mit Namen *_test und mit DB_PASSWORD aus der Umgebung, siehe Kopfkommentar.');
  process.exit(2);
}
const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('scripts', 'namens-bausteine-einlesen.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};

const { korrekturen, antwortFuer, klassifiziere, glossarWerte, gleicheMitGlossarAb } = await laden('services', 'namens-einlesen.js');
const OHNE = { ohne: 'Test ohne Glossar-Blatt' };
const { einlesen } = await laden('scripts', 'namens-bausteine-einlesen.js');
const { nachholen } = await laden('scripts', 'namens-form-offen-nachholen.js');

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

const paar = (thema, deutsch, vorschlag, ok = 'OK', kommentar = '', nummer = 1, blattZeile = 5) =>
  ({ blattZeile, nummer, thema, deutsch, vorschlag, ok, kommentar });
const kl = (thema, deutsch, ziel, sprache = 'EN') =>
  klassifiziere(paar(thema, deutsch, ziel), ziel, sprache).map((k) => [k.deutsch, k.ziel, k.art, k.ergebnis]);
const klVoll = (thema, deutsch, ziel, sprache) =>
  klassifiziere(paar(thema, deutsch, ziel), ziel, sprache).map((k) => ({ ziel: k.ziel, ergebnis: k.ergebnis, wortart: k.wortart, formen: k.formen, notiz: k.notiz, grund: k.grund }));

console.log('Regeln');

await pruefe('Korrekturen je Nummer werden gelesen, freier Text nicht', () => {
  assert.deepEqual([...korrekturen('2: noir mat; 5: carré')], [[2, 'noir mat'], [5, 'carré']]);
  assert.deepEqual([...korrekturen('3) blanc\n4= gris')], [[3, 'blanc'], [4, 'gris']]);
  assert.equal(korrekturen('Bitte nochmal schauen'), null);
});

await pruefe('Antwort: OK, leer, Korrektur je Nummer, nicht genannte Nummer gilt als OK, Kommentar ohne Nummern', () => {
  assert.deepEqual(antwortFuer(paar('X', 'a', 'b')), { status: 'ok' });
  assert.deepEqual(antwortFuer(paar('X', 'a', 'b', '', '')), { status: 'leer' });
  assert.deepEqual(antwortFuer(paar('X', 'a', 'b', 'Change', '2: noir mat', 2)), { status: 'korrektur', ziel: 'noir mat' });
  assert.deepEqual(antwortFuer(paar('X', 'a', 'b', 'Change', '2: noir mat', 1)), { status: 'ok' });
  assert.equal(antwortFuer(paar('X', 'a', 'b', 'Change', 'passt so nicht')).status, 'unklar');
  assert.deepEqual(antwortFuer(paar('X', 'a', 'b', 'OK', 'gut so')), { status: 'ok', notiz: 'gut so' });
  assert.equal(antwortFuer(paar('X', 'a', 'b', 'vielleicht', '')).status, 'unklar');
});

await pruefe('Wertformen und Regeln werden keine Bausteine', () => {
  assert.deepEqual(kl('Schreibweise von Werten', '1,5m', '1.5m'), [['1,5m', '1.5m', null, 'wertform']]);
  assert.deepEqual(kl('Aufbau des Namens', 'Reihenfolge', 'LED + type'), [['Reihenfolge', 'LED + type', null, 'regel']]);
  assert.deepEqual(kl('Wenn es eng wird', 'dimmbar', 'dim. (end of name only)').map((x) => x[3]), ['regel']);
});

await pruefe('Zwei Ziele und Wortteile werden Rückfragen', () => {
  assert.deepEqual(kl('Form und Bauart', 'eckig', 'square / rectangular').map((x) => x[3]), ['rueckfrage']);
  assert.deepEqual(kl('Steuerung', 'Wand-', 'wall (wall transmitter)').map((x) => x[3]), ['rueckfrage']);
});

await pruefe('Zusatz in Klammern geht ins Protokoll, zwei deutsche Formen ergeben zwei Bausteine', () => {
  const d = klassifiziere(paar('Dimmung', 'dimmbar', 'dimmable (only short form: dim.)'), 'dimmable (only short form: dim.)', 'EN');
  assert.deepEqual(d.map((k) => [k.ziel, k.art, k.ergebnis, k.notiz]), [['dimmable', 'wort', 'freigegeben', 'only short form: dim.']]);
  assert.deepEqual(kl('Kabel und Anschluss', 'beidseitig (beids.)', 'both ends'),
    [['beidseitig', 'both ends', 'wort', 'freigegeben'], ['beids.', 'both ends', 'wort', 'freigegeben']]);
});

await pruefe('Gleiches Ziel heißt fest, auch mit Ziffern; ein Zahlpaar wird ein Muster mit # für bildeName', () => {
  assert.deepEqual(kl('Nicht übersetzen', 'Linear10', 'Linear10'), [['Linear10', 'Linear10', 'fest', 'freigegeben']]);
  assert.deepEqual(kl('Industrie und Außen', 'Poller-2', 'Poller-2 (series name)'), [['Poller-2', 'Poller-2', 'fest', 'freigegeben']]);
  assert.deepEqual(kl('Kennwerte im Namen', 'CRI', 'CRI'), [['CRI', 'CRI', 'fest', 'freigegeben']]);
  assert.deepEqual(kl('Kabel und Anschluss', '2-polig', '2-pole'), [['#-polig', '#-pole', 'muster', 'freigegeben']]);
  assert.deepEqual(kl('Rolle und Länge', '5m Rolle', '5m roll'), [['#m Rolle', '#m roll', 'muster', 'freigegeben']]);
  assert.deepEqual(kl('Nicht übersetzen', 'Pipe', 'Rohr').map((x) => x[3]), ['rueckfrage']);
});

// Die 16 EN-Paare mit Ziffern (Einlesen 06.11.2026) und die gleichen Zeilen der sieben übrigen Sprachen, #1810.
await pruefe('Zahlpaare: Werte werden #, auch versetzt und mit mehreren Werten; Dezimalkomma gleich Dezimalpunkt', () => {
  assert.deepEqual(kl('Mengen', '4er Set', 'set of 4'), [['#er Set', 'set of #', 'muster', 'freigegeben']]);
  assert.deepEqual(kl('Rolle und Länge', '5m Rolle', 'rotolo da 5 m', 'IT'), [['#m Rolle', 'rotolo da # m', 'muster', 'freigegeben']]);
  assert.deepEqual(kl('Dimmung', '1-10V dimmbar', 'dimmable 1-10V', 'FR'), [['#-#V dimmbar', 'dimmable #-#V', 'muster', 'freigegeben']]);
  assert.deepEqual(kl('Mengen', '(2 Stück)', '(2 pcs)'), [['(# Stück)', '(# pcs)', 'muster', 'freigegeben']]);
  assert.deepEqual(kl('Rolle und Länge', '2,5m Rolle', '2.5m roll'), [['#m Rolle', '#m roll', 'muster', 'freigegeben']]);
  assert.match(klVoll('Mengen', '2 STK', '2 pcs', 'EN')[0].grund, /Muster aus „2 STK → 2 pcs“/);
});

await pruefe('Zahlpaare wörtlich: die Eins (Einzahl) und Ziffern, die zu einer Kennung gehören', () => {
  assert.deepEqual(kl('Mengen', '1 STK', '1 pc'), [['1 STK', '1 pc', 'wort', 'freigegeben']]);
  assert.deepEqual(kl('Industrie und Außen', 'GU10 Strahler', 'Ampoule LED GU10', 'FR'), [['GU10 Strahler', 'Ampoule LED GU10', 'wort', 'freigegeben']]);
  assert.deepEqual(kl('Leuchtmittel', 'GU5.3 Strahler', 'spot GU5.3'), [['GU5.3 Strahler', 'spot GU5.3', 'wort', 'freigegeben']]);
  assert.deepEqual(kl('Einzelbegriffe', 'R7s LED Stab', 'Lampada LED R7s', 'IT'), [['R7s LED Stab', 'Lampada LED R7s', 'wort', 'freigegeben']]);
  assert.deepEqual(kl('Industrie und Außen', 'IP67 Strahler', 'IP67 spotlight'), [['IP67 Strahler', 'IP67 spotlight', 'wort', 'freigegeben']]);
  assert.match(klVoll('Industrie und Außen', 'GU10 Strahler', 'Ampoule LED GU10', 'FR')[0].grund, /Ziffern nur in Kennungen/);
  assert.match(klVoll('Mengen', '1 STK', '1 pc', 'EN')[0].grund, /Einzahl/);
});

await pruefe('Zahlpaar bleibt offen, wenn das Ziel andere Werte nennt oder sie umstellt', () => {
  assert.deepEqual(kl('Zahl vor Hauptwort', '2-fach', 'double').map((x) => x[3]), ['form_offen']);
  assert.deepEqual(kl('Kabel und Anschluss', '2x3-polig', '3x2-pole').map((x) => x[3]), ['form_offen']);
  assert.match(klVoll('Zahl vor Hauptwort', '2-fach', 'double', 'EN')[0].grund, /Zahlen im Ziel \(keine\) entsprechen nicht dem Deutschen \(2\)/);
});

await pruefe('Wendung vor mit/für/inkl./exkl./ohne, sonst Wort', () => {
  assert.deepEqual(kl('Lieferumfang', 'inkl. Clips', 'incl. clips'), [['inkl. Clips', 'incl. clips', 'wendung', 'freigegeben']]);
  assert.deepEqual(kl('Lieferumfang', 'exkl. Leuchtmittel', 'lamp not included')[0][2], 'wendung');
  assert.deepEqual(kl('Gehäusefarben', 'weiß', 'white')[0][2], 'wort');
});

// Die drei Befunde aus #1810 (09.11.2026), Fälle wörtlich aus den Prüftabellen FR, IT, ES, PL, SK.
await pruefe('Erläuterung nach dem Komma: Ziel ist der Teil davor, der Rest geht ins Protokoll', () => {
  assert.deepEqual(klVoll('Dimmung', 'dimmbar', 'dimmerabile, abbr. dimm.', 'IT').map((k) => [k.ziel, k.ergebnis, k.notiz]),
    [['dimmerabile', 'freigegeben', 'abbr. dimm.']]);
  assert.deepEqual(klVoll('Flexband', 'Flexband', 'Ruban LED, en tête', 'FR').map((k) => [k.ziel, k.ergebnis, k.notiz]),
    [['Ruban LED', 'freigegeben', 'en tête']]);
  assert.deepEqual(klVoll('Dimmung', 'Push/DALI dimmbar', 'dimmerabile Push/DALI, abbr. dimm. Push/DALI', 'IT').map((k) => [k.ziel, k.ergebnis]),
    [['dimmerabile Push/DALI', 'freigegeben']], 'Schrägstrich, den das Deutsche auch hat, ist kein Genuspaar');
});

await pruefe('Einzahl und Mehrzahl: Ziel ist die Einzahl, die Eins nur, wenn das Deutsche sie hat', () => {
  assert.deepEqual(klVoll('Steuerung', 'Kanal', 'canal, 2 canaux', 'FR').map((k) => [k.ziel, k.notiz]), [['canal', 'Mehrzahl: 2 canaux']]);
  assert.deepEqual(klVoll('Steuerung', 'Zone', '1 zona, 2 zone', 'IT').map((k) => [k.ziel, k.notiz]), [['zona', 'Mehrzahl: 2 zone']]);
  assert.deepEqual(klVoll('Steuerung', 'Kanal', '1 canale, 2 canali', 'IT').map((k) => k.ziel), ['canale']);
});

await pruefe('Hängt die Erläuterung am Einsatz oder sind es mehr Kommateile, wird es eine Rückfrage', () => {
  assert.deepEqual(kl('Oberflächen und Material', 'klar', 'transparent, ampoule : claire', 'FR').map((x) => x[3]), ['rueckfrage']);
  assert.deepEqual(kl('3-Phasen-System', 'Verbinder', 'łącznik (szyna), złączka (taśma)', 'PL').map((x) => x[3]), ['rueckfrage']);
  assert.deepEqual(kl('Steuerung', 'Kanal', 'canal, canaux, voie', 'FR').map((x) => x[3]), ['rueckfrage']);
});

await pruefe('Genuspaar wird Adjektiv mit Formen, das Ziel ist die erste Form', () => {
  assert.deepEqual(klVoll('Gehäusefarben', 'weiß', 'bianco/bianca', 'IT'),
    [{ ziel: 'bianco', ergebnis: 'freigegeben', wortart: 'adjektiv', formen: { m: 'bianco', f: 'bianca' }, notiz: null, grund: null }]);
  assert.deepEqual(klVoll('Gehäusefarben', 'sandschwarz', 'nero sabbiato/nera sabbiata', 'IT')[0].formen,
    { m: 'nero sabbiato', f: 'nera sabbiata' });
  assert.deepEqual(klVoll('Gehäusefarben', 'weiß', 'bílý/bílá/bílé', 'CZ')[0].formen, { m: 'bílý', f: 'bílá', n: 'bílé' });
  assert.deepEqual(klVoll('Gehäusefarben', 'weiß', 'white', 'IT')[0], { ziel: 'white', ergebnis: 'freigegeben', wortart: null, formen: null, notiz: null, grund: null });
});

await pruefe('Kein Genuspaar: Sprache ohne Genus, falsche Zahl der Formen, verschiedene Wörter → Rückfrage', () => {
  assert.deepEqual(kl('Gehäusefarben', 'weiß', 'white/whitish', 'EN').map((x) => x[3]), ['rueckfrage'], 'EN hat kein Genus');
  assert.deepEqual(kl('Gehäusefarben', 'weiß', 'fehér/fehéres', 'HU').map((x) => x[3]), ['rueckfrage'], 'HU hat kein Genus');
  assert.deepEqual(kl('Gehäusefarben', 'weiß', 'biały/biała', 'PL').map((x) => x[3]), ['rueckfrage'], 'PL braucht m/f/n');
  assert.deepEqual(kl('Gehäusefarben', 'weiß', 'bianco/bianca/bianche', 'IT').map((x) => x[3]), ['rueckfrage'], 'IT kennt nur m/f');
  assert.deepEqual(kl('Steuerung', 'Schalter', 'interruttore/pulsante', 'IT').map((x) => x[3]), ['rueckfrage'], 'zwei Wörter, kein Paar');
  assert.deepEqual(kl('Steuerung', 'Taster', 'on/off', 'FR').map((x) => x[3]), ['rueckfrage']);
  assert.deepEqual(kl('Gehäusefarben', 'weiß', 'bianco/', 'IT').map((x) => x[3]), ['rueckfrage']);
  assert.match(klVoll('Gehäusefarben', 'weiß', 'biały/biała', 'PL')[0].grund, /2 Formen, PL braucht 3/);
  assert.throws(() => kl('Gehäusefarben', 'weiß', 'bianco/bianca', 'XX'), /Sprache „XX“ gibt es nicht/, 'unbekannte Sprache bricht ab');
  assert.throws(() => klassifiziere(paar('Gehäusefarben', 'weiß', 'bianco/bianca'), 'bianco/bianca'), /gibt es nicht/, 'ohne Sprache bricht ab');
});

await pruefe('„…“ hält Platz für Code oder Serie: Rückfrage statt Baustein', () => {
  assert.deepEqual(kl('Flexband', 'MiniAMP Flexband', 'Ruban LED … MiniAMP', 'FR').map((x) => x[3]), ['rueckfrage']);
  assert.deepEqual(kl('Flexband', 'NEON Flexband', 'Ruban LED NEON…', 'FR').map((x) => x[3]), ['rueckfrage']);
  assert.deepEqual(kl('Flexband', 'NEON Flexband', 'Strip LED NEON ...', 'IT').map((x) => x[3]), ['rueckfrage']);
});

// Abgleich mit dem Glossar-Blatt (Entscheid Thomas 10.11.2026). Fälle wörtlich aus EN: Prüftabelle und Glossar-Blatt vom 06.11.
const BLATT_KOPF = 'zeile\tdeutsch\theute\tbis0411\tvorschlag\tstand\tentscheidung';
const blatt = (...z) => [BLATT_KOPF, ...z.map((x) => x.join('\t'))].join('\n') + '\n';
const BLATT = blatt(
  [72, 'Stromschiene', 'track', '', 'lighting track', 'offen', 'Vorschlag / Proposal'],
  [43, 'Raster', 'grid', '', '', 'neu', 'OK'],
  [3, 'Flexband', 'flex strip', 'flex stripe', '', 'neu', 'OK'],
  [7, 'Mesh', 'Mesh', '', '', 'neu', 'OK'],
);
const ent = (deutsch, ziel, art = 'wort', ergebnis = 'freigegeben') => ({ paar: paar('X', deutsch, ziel), deutsch, ziel, art, wortart: null, formen: null, ergebnis, grund: null, antwort: 'ok' });

await pruefe('Glossar-Blatt: „OK“ behält den heutigen Wert, „Vorschlag“ nimmt den Vorschlag; Unbekanntes bricht ab', () => {
  const w = glossarWerte(BLATT);
  assert.deepEqual([...w.entries()].map(([k, v]) => [k, v.wert, v.zeile]),
    [['stromschiene', 'lighting track', 72], ['raster', 'grid', 43], ['flexband', 'flex strip', 3], ['mesh', 'Mesh', 7]]);
  assert.throws(() => glossarWerte(blatt([5, 'Dose', 'box', '', '', 'neu', 'bis 04.11.'])), /kann dieser Weg nicht/);
});

await pruefe('Abgleich: Widerspruch wird Rückfrage mit dem Wert aus dem Blatt, Gleiches bleibt, Muster und Rückfragen bleiben unberührt', () => {
  const e = [ent('Stromschiene', 'track'), ent('Raster', 'Raster', 'fest'), ent('Flexband', 'flex strip'), ent('Mesh', 'mesh'),
    ent('#m Rolle', '#m roll', 'muster'), ent('Raster', 'raster', null, 'rueckfrage'), ent('Adapter', 'adapter')];
  assert.equal(gleicheMitGlossarAb(e, glossarWerte(BLATT)), 3);
  assert.deepEqual(e.map((x) => x.ergebnis), ['rueckfrage', 'rueckfrage', 'freigegeben', 'rueckfrage', 'freigegeben', 'rueckfrage', 'freigegeben']);
  assert.match(e[0].grund, /Glossar-Blatt Zeile 72 sagt „lighting track“/);
  assert.match(e[3].grund, /nur Groß-\/Kleinschreibung/);
  assert.equal(e[5].grund, null, 'eine Rückfrage bekommt keinen zweiten Grund');
});

await pruefe('„Angleichung nach Genus“ zeigt Beispiele der Kopfregel, keine Bausteine', () => {
  assert.deepEqual(kl('Angleichung nach Genus', 'Hängeleuchte schwarz', 'Lampada a sospensione nera', 'IT').map((x) => x[3]), ['regel']);
  assert.deepEqual(kl('Angleichung nach Genus', 'warmweiß', 'bianco caldo, sempre uguale', 'IT').map((x) => x[3]), ['regel']);
});

console.log('Datenbank');

const { pool } = await laden('db', 'connection.js');
const q = (sql, p) => pool.query(sql, p);
assert.ok((await q('SELECT current_database() AS n')).rows[0].n.endsWith('_test'), 'falsche Datenbank');
const fremde = (await q(`SELECT count(*)::int AS n FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', current_database())`)).rows[0].n;
if (fremde > 0) {
  console.error(`Abbruch: Der Server hat ${fremde} weitere Datenbank(en), das ist kein eigener Wegwerf-Server.`);
  process.exit(2);
}
await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of readdirSync(join(WURZEL, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
  await q(readFileSync(join(WURZEL, 'migrations', f), 'utf-8'));
}

// Seit Wortliste Phase 6 (10.11.2026) schreibt das Einlesen in das Glossar DE→X (Plan `PLAN-wortliste.md` §3 Phase 6).
const GLOSSARE = {};
for (const s of ['EN', 'FR', 'IT', 'ES', 'HU']) {
  GLOSSARE[s] = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ($1, 'DE', $2) RETURNING id`, [`Glossar DE→${s}`, s])).rows[0].id;
}

const KOPF = 'blatt_zeile\tnummer\tthema\tdeutsch\tvorschlag\tok\tkommentar';
const tsv = (...z) => [KOPF, ...z.map((x) => x.join('\t'))].join('\n') + '\n';
const SHA = (n) => n.toString(16).padStart(64, '0');
const WER = 'Muttersprachler EN, Prüftabelle 06.11.2026 (Test)';
const LISTE = tsv(
  [5, 1, 'Gehäusefarben', 'weiß', 'white', 'OK', ''],
  [5, 2, 'Gehäusefarben', 'schwarz', 'black', 'OK', ''],
  [6, 1, 'Oberflächen und Material', 'matt', 'matt', 'Change', '2: brushed finish'],
  [6, 2, 'Oberflächen und Material', 'gebürstet', 'brushed', 'Change', '2: brushed finish'],
  [7, 1, 'Schreibweise von Werten', '1,5m', '1.5m', 'OK', ''],
  [8, 1, 'Form und Bauart', 'eckig', 'square / rectangular', 'OK', ''],
  [9, 1, 'Kabel und Anschluss', '2-fach', 'double', 'OK', ''],
  [9, 2, 'Kabel und Anschluss', 'beidseitig (beids.)', 'both ends', 'OK', ''],
  [10, 1, 'Profilzubehör', 'Endkappe', 'end cap', '', ''],
  [11, 1, 'Steuerung', 'Funk', 'wireless', 'vielleicht', ''],
  [12, 1, 'Industrie und Außen', 'weiß', 'white', 'OK', ''],
);
const n = async (sql, p) => (await q(sql, p)).rows[0].n;
/** Die Wortliste einer Sprache mit Herkunft und Rückfrage, nach Begriff sortiert. */
const wl = async (sprache) => (await q(
  `SELECT e.art, e.source_term AS deutsch, e.target_term AS ziel, e.approved, e.an_deepl, e.source, e.wortart, e.formen,
          v.vorschlag_pruefung, v.rueckfrage
     FROM glossary_entries e LEFT JOIN wortliste_vorschlag v ON v.entry_id = e.id
    WHERE e.glossary_id = $1 ORDER BY e.source_term COLLATE "C"`, [GLOSSARE[sprache]])).rows;
const fassungen = (sprache) => n(`SELECT count(*)::int AS n FROM namens_bausteine_fassung WHERE sprache = $1`, [sprache]);
const version = async (sprache) => (await q(`SELECT version FROM glossaries WHERE id = $1`, [GLOSSARE[sprache]])).rows[0].version;
const offen = async (sprache, deutsch, ziel, mehr = {}) => {
  const id = (await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source, an_deepl, art)
                       VALUES ($1, $2, $3, FALSE, 'gemeldet', $4, 'wort') RETURNING id`,
    [GLOSSARE[sprache], deutsch, ziel, mehr.an_deepl ?? false])).rows[0].id;
  if (mehr.vorschlag) {
    await q(`INSERT INTO wortliste_vorschlag (entry_id, quelle, vorschlag_deepl, vorschlag_pruefung) VALUES ($1, $2, $3, $4)`,
      [id, mehr.vorschlag.quelle, mehr.vorschlag.deepl ?? null, mehr.vorschlag.pruefung ?? null]);
  }
  return id;
};

await pruefe('Trockenlauf: rechnet alles, schreibt nichts', async () => {
  const b = await einlesen({ sprache: 'EN', text: LISTE, datei: 'test.xlsx', sha256: SHA(1), wer: WER, glossar: OHNE, ausfuehren: false });
  assert.equal(b.ausgefuehrt, false);
  assert.ok(b.zaehlung.freigegeben > 0);
  assert.equal(await n('SELECT count(*)::int AS n FROM glossary_entries'), 0);
  assert.equal(await n('SELECT count(*)::int AS n FROM namens_einlesen_protokoll'), 0);
  assert.equal(await n('SELECT count(*)::int AS n FROM namens_bausteine_fassung'), 0);
});

await pruefe('Ausführen: Bestätigtes wird freigegebene Zeile der Wortliste, nicht an DeepL; Offenes offene Zeile; eine Fassung; Verlauf mit dem Prüfer', async () => {
  // Eine offene Zeile aus einer Meldung liegt schon für „schwarz“ da; der Prüfer bestätigt sie, sie wird freigegeben.
  await offen('EN', 'schwarz', 'black', { vorschlag: { quelle: 'gemeldet', deepl: 'black' } });
  const v0 = await version('EN');
  const m0 = await n('SELECT count(*)::int AS n FROM glossary_entry_history');
  const b = await einlesen({ sprache: 'EN', text: LISTE, datei: 'test.xlsx', sha256: SHA(1), wer: WER, glossar: OHNE, ausfuehren: true });
  assert.equal(b.ausgefuehrt, true);
  assert.deepEqual(b.zaehlung, { freigegeben: 6, vorlaeufig: 1, bekannt: 0, doppelt: 1, rueckfrage: 2, wertform: 1, regel: 0, form_offen: 1 });
  const w = await wl('EN');
  assert.deepEqual(w.map((r) => [r.art, r.deutsch, r.ziel, r.approved]), [
    ['wort', 'Endkappe', 'end cap', false], ['wort', 'beids.', 'both ends', true], ['wort', 'beidseitig', 'both ends', true],
    ['wort', 'gebürstet', 'brushed finish', true], ['fest', 'matt', 'matt', true], ['wort', 'schwarz', 'black', true],
    ['wort', 'weiß', 'white', true],
  ]);
  assert.ok(w.every((r) => r.an_deepl === false), 'Namenswörter aus der Prüftabelle gehen nicht an DeepL');
  assert.deepEqual(w.filter((r) => r.source === 'pruefung').length, 6, 'neue Zeilen tragen die Quelle');
  assert.equal(w.find((r) => r.deutsch === 'Endkappe').vorschlag_pruefung, 'end cap');
  assert.equal(w.find((r) => r.deutsch === 'schwarz').vorschlag_pruefung, 'black');
  assert.equal(await version('EN'), v0, 'nichts davon ändert das DeepL-Glossar');
  assert.equal(await fassungen('EN'), 1);
  assert.equal(await n(`SELECT count(*)::int AS n FROM namens_einlesen_protokoll WHERE lauf = $1`, [b.lauf]), 12, '11 Paare, eines doppelt geteilt');
  assert.equal(await n(`SELECT count(*)::int AS n FROM namens_einlesen_protokoll WHERE lauf = $1 AND entry_id IS NOT NULL`, [b.lauf]), 7);
  const r = (await q(`SELECT deutsch, ergebnis FROM namens_einlesen_protokoll WHERE ergebnis IN ('rueckfrage', 'doppelt', 'form_offen', 'wertform') ORDER BY lower(deutsch), deutsch`)).rows;
  assert.deepEqual(r.map((x) => [x.deutsch, x.ergebnis]), [['1,5m', 'wertform'], ['2-fach', 'form_offen'], ['eckig', 'rueckfrage'], ['Funk', 'rueckfrage'], ['weiß', 'doppelt']]);
  const wer = (await q(`SELECT DISTINCT x.n FROM (SELECT changed_by_name AS n FROM glossary_entry_history ORDER BY changed_at OFFSET $1) x`, [m0]))
    .rows.map((x) => x.n);
  assert.deepEqual(wer, [WER], 'der Verlauf nennt den Prüfer, nie „unbekannt“');
});

await pruefe('Dieselbe Fassung der Datei ein zweites Mal: hält an, schreibt nichts', async () => {
  const vorher = await n('SELECT count(*)::int AS n FROM namens_einlesen_protokoll');
  await assert.rejects(() => einlesen({ sprache: 'EN', text: LISTE, datei: 'test.xlsx', sha256: SHA(1), wer: WER, glossar: OHNE, ausfuehren: true }), /schon eingelesen/);
  assert.equal(await n('SELECT count(*)::int AS n FROM namens_einlesen_protokoll'), vorher);
});

await pruefe('Derselbe Inhalt als neue Datei: alles bekannt, die Wortliste und ihr Verlauf bleiben unverändert', async () => {
  const stand = async () => JSON.stringify([await wl('EN'), await n('SELECT count(*)::int AS n FROM glossary_entry_history'), await fassungen('EN')]);
  const vorher = await stand();
  const b = await einlesen({ sprache: 'EN', text: LISTE, datei: 'test-kopie.xlsx', sha256: SHA(10), wer: WER, glossar: OHNE, ausfuehren: true });
  assert.deepEqual([b.zaehlung.freigegeben, b.zaehlung.vorlaeufig, b.zaehlung.bekannt], [0, 0, 7]);
  assert.equal(await stand(), vorher);
});

await pruefe('Eine neue Datei mit anderem Ziel: Rückfrage an der freigegebenen Zeile, nie ein Überschreiben', async () => {
  const b = await einlesen({ sprache: 'EN', datei: 'zweite.xlsx', sha256: SHA(2), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 1, 'Gehäusefarben', 'weiß', 'white', 'OK', ''],
    [5, 2, 'Gehäusefarben', 'schwarz', 'jet black', 'OK', ''],
  ) });
  assert.deepEqual([b.zaehlung.bekannt, b.zaehlung.rueckfrage, b.zaehlung.freigegeben], [1, 1, 0]);
  const s = (await wl('EN')).find((r) => r.deutsch === 'schwarz');
  assert.deepEqual([s.ziel, s.approved], ['black', true], 'bleibt freigegeben mit dem alten Ziel');
  assert.match(s.rueckfrage, /freigegeben ist schon „black“/);
  assert.equal(b.fassungNachher, b.fassungVorher, 'nichts freigegeben, keine neue Fassung');
});

await pruefe('Widerspruch in derselben Datei: eine offene Zeile mit Rückfrage, keine freigegeben', async () => {
  const b = await einlesen({ sprache: 'FR', datei: 'fr.xlsx', sha256: SHA(3), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 1, 'Gehäusefarben', 'grau', 'gris', 'OK', ''],
    [9, 1, 'Industrie und Außen', 'grau', 'gris anthracite', 'OK', ''],
  ) });
  assert.deepEqual([b.zaehlung.rueckfrage, b.zaehlung.freigegeben], [2, 0]);
  const w = await wl('FR');
  assert.deepEqual(w.map((r) => [r.deutsch, r.approved]), [['grau', false]]);
  assert.match(w[0].rueckfrage, /widersprüchlich in der Datei: „gris“ gegen „gris anthracite“/);
});

await pruefe('Eine offene Zeile, die schon an DeepL ging, wird freigegeben: Glossarversion +1', async () => {
  await offen('FR', 'Profil', 'profilé', { an_deepl: true });
  const v0 = await version('FR');
  const b = await einlesen({ sprache: 'FR', datei: 'fr2.xlsx', sha256: SHA(11), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 1, 'Profile', 'Profil', 'profilé', 'Change', '1: profil'],
  ) });
  assert.equal(b.zaehlung.freigegeben, 1);
  const p = (await wl('FR')).find((r) => r.deutsch === 'Profil');
  assert.deepEqual([p.ziel, p.approved, p.an_deepl], ['profil', true, true]);
  assert.equal(await version('FR'), v0 + 1);
});

await pruefe('Zwei Schreibungen ohne exakte: Rückfrage im Protokoll, nichts geschrieben', async () => {
  await offen('FR', 'COVER', 'COVER');
  await offen('FR', 'Cover', 'diffuseur');
  const vorher = JSON.stringify(await wl('FR'));
  const b = await einlesen({ sprache: 'FR', datei: 'fr3.xlsx', sha256: SHA(12), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [6, 1, 'Profilzubehör', 'cover', 'diffuseur', 'OK', ''],
  ) });
  assert.equal(b.zaehlung.rueckfrage, 1);
  assert.match(b.entscheide[0].grund, /mehrere Schreibungen in der Wortliste: „COVER“, „Cover“/);
  assert.equal(JSON.stringify(await wl('FR')), vorher);
});

await pruefe('Genuspaar: freigegeben als Adjektiv mit Formen, unbeantwortet offen mit Formen, Erläuterung im Protokoll', async () => {
  const b = await einlesen({ sprache: 'IT', datei: 'it.xlsx', sha256: SHA(4), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 1, 'Gehäusefarben', 'weiß', 'bianco/bianca', 'OK', ''],
    [5, 2, 'Gehäusefarben', 'schwarz', 'nero/nera', '', ''],
    [9, 1, 'Dimmung', 'dimmbar', 'dimmerabile, abbr. dimm.', 'OK', ''],
    [14, 3, 'Flexband', 'MiniAMP Flexband', 'Strip LED … MiniAMP', 'OK', ''],
  ) });
  assert.deepEqual([b.zaehlung.freigegeben, b.zaehlung.vorlaeufig, b.zaehlung.rueckfrage], [2, 1, 1]);
  assert.deepEqual((await wl('IT')).map((r) => ({ deutsch: r.deutsch, ziel: r.ziel, approved: r.approved, wortart: r.wortart, formen: r.formen })), [
    { deutsch: 'dimmbar', ziel: 'dimmerabile', approved: true, wortart: null, formen: null },
    { deutsch: 'schwarz', ziel: 'nero', approved: false, wortart: 'adjektiv', formen: { m: 'nero', f: 'nera' } },
    { deutsch: 'weiß', ziel: 'bianco', approved: true, wortart: 'adjektiv', formen: { m: 'bianco', f: 'bianca' } },
  ]);
  const p = (await q(`SELECT deutsch, ergebnis, grund FROM namens_einlesen_protokoll WHERE sprache = 'IT' ORDER BY blatt_zeile, nummer`)).rows;
  assert.match(p.find((x) => x.deutsch === 'weiß').grund, /Formen: m bianco · f bianca/);
  assert.match(p.find((x) => x.deutsch === 'dimmbar').grund, /Zusatz: abbr\. dimm\./);
  assert.match(p.find((x) => x.deutsch === 'MiniAMP Flexband').grund, /Wortstellung im Kopf/);
});

await pruefe('Genuspaar ein zweites Mal: gleiche Formen bekannt (trotz JSONB-Sortierung), andere Formen Rückfrage', async () => {
  const b = await einlesen({ sprache: 'IT', datei: 'it2.xlsx', sha256: SHA(5), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 1, 'Gehäusefarben', 'weiß', 'bianco/bianca', 'OK', ''],
  ) });
  assert.deepEqual([b.zaehlung.bekannt, b.zaehlung.rueckfrage], [1, 0]);
  const c = await einlesen({ sprache: 'IT', datei: 'it3.xlsx', sha256: SHA(6), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 1, 'Gehäusefarben', 'weiß', 'bianco/bianche', 'OK', ''],
  ) });
  assert.deepEqual([c.zaehlung.bekannt, c.zaehlung.rueckfrage], [0, 1]);
  assert.match(c.entscheide[0].grund, /freigegeben ist schon „bianco \(m bianco · f bianca\)“/);
  const d = await einlesen({ sprache: 'IT', datei: 'it4.xlsx', sha256: SHA(7), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 1, 'Gehäusefarben', 'weiß', 'bianco', 'OK', ''],
  ) });
  assert.equal(d.zaehlung.rueckfrage, 1, 'dasselbe Ziel ohne Formen ist ein anderer Baustein');
});

await pruefe('Genuspaar unbeantwortet auf eine offene Zeile: Formen kommen mit dem Vorschlag der Prüftabelle, sonst nicht', async () => {
  // „grau“ kam aus einer Meldung (nur DeepL), „matt“ trägt schon einen Vorschlag der Prüftabelle; der bleibt samt seinen Formen.
  await offen('IT', 'grau', 'grigio', { vorschlag: { quelle: 'gemeldet', deepl: 'grigio' } });
  await offen('IT', 'matt', 'opaco', { vorschlag: { quelle: 'pruefung', pruefung: 'opaco' } });
  await einlesen({ sprache: 'IT', datei: 'it5.xlsx', sha256: SHA(8), wer: WER, glossar: OHNE, ausfuehren: true, text: tsv(
    [5, 4, 'Gehäusefarben', 'grau', 'grigio/grigia', '', ''],
    [6, 1, 'Oberflächen und Material', 'matt', 'opaco/opaca', '', ''],
  ) });
  const v = (await wl('IT')).filter((r) => ['grau', 'matt'].includes(r.deutsch))
    .map((r) => ({ deutsch: r.deutsch, vorschlag_pruefung: r.vorschlag_pruefung, wortart: r.wortart, formen: r.formen }));
  assert.deepEqual(v, [
    { deutsch: 'grau', vorschlag_pruefung: 'grigio', wortart: 'adjektiv', formen: { m: 'grigio', f: 'grigia' } },
    { deutsch: 'matt', vorschlag_pruefung: 'opaco', wortart: null, formen: null },
  ]);
});

// Was der Lauf vom 06.11.2026 hinterließ: Zahlpaare als `form_offen` im Protokoll (#1810). Hier ES, damit nichts aus EN stört.
const ALT_LAUF = '00000000-0000-4000-8000-000000000001';
const VON_DAMALS = 'Muttersprachler ES, Prüftabelle (Test)';
const altesProtokoll = async (zeilen) => {
  for (const [zeile, nr, thema, deutsch, vorschlag, antwort] of zeilen) {
    await q(`INSERT INTO namens_einlesen_protokoll (lauf, datei, datei_sha256, sprache, blatt_zeile, nummer, thema, deutsch, vorschlag,
                                                    antwort, ergebnis, grund, von)
             VALUES ($1, 'es.xlsx', $2, 'ES', $3, $4, $5, $6, $7, $8, 'form_offen', 'Wert im Paar: Form als Muster legt bildeName fest', $9)`,
      [ALT_LAUF, SHA(20), zeile, nr, thema, deutsch, vorschlag, antwort, VON_DAMALS]);
  }
};
const ER = `Claude, Wort Thomas (Test)`;

await pruefe('Nachholen: Trockenlauf findet die offenen Paare und schreibt nichts', async () => {
  await altesProtokoll([
    [15, 1, 'Rolle und Länge', '5m Rolle', 'rollo de 5 m', 'ok'],
    [15, 2, 'Rolle und Länge', '20m Rolle', 'rollo de 20 m', 'ok'],
    [10, 1, 'Mengen', '1 STK', '1 ud.', 'Korrektur: 1 ud.'],
    [32, 5, 'Weitere Einzelbegriffe', '2-fach', 'doble', 'ok'],
    [10, 5, 'Mengen', '6er Pack', 'paquete de 6', 'leer'],
  ]);
  const vorher = await n(`SELECT count(*)::int AS n FROM namens_einlesen_protokoll`);
  const b = await nachholen({ sprache: 'ES', wer: ER, ausfuehren: false });
  assert.equal(b.offen, 5);
  assert.equal(b.ausgefuehrt, false);
  assert.equal(await n(`SELECT count(*)::int AS n FROM namens_einlesen_protokoll`), vorher);
  assert.equal((await wl('ES')).length, 0);
});

await pruefe('Nachholen: Muster und Einzahl freigegeben, Doppel einmal, Unbeantwortetes offen, Abweichendes bleibt offen', async () => {
  const b = await nachholen({ sprache: 'ES', wer: ER, ausfuehren: true });
  assert.equal(b.offen, 5);
  assert.deepEqual([b.zaehlung.freigegeben, b.zaehlung.doppelt, b.zaehlung.vorlaeufig, b.zaehlung.form_offen], [2, 1, 1, 1]);
  assert.equal(b.fassungNachher, b.fassungVorher + 1);
  assert.deepEqual((await wl('ES')).map((r) => [r.art, r.deutsch, r.ziel, r.approved, r.an_deepl]), [
    ['muster', '#er Pack', 'paquete de #', false, false], ['muster', '#m Rolle', 'rollo de # m', true, false], ['wort', '1 STK', '1 ud.', true, false],
  ]);
  const wer = (await q(`SELECT DISTINCT changed_by_name AS n FROM glossary_entry_history WHERE glossary_id = $1`, [GLOSSARE.ES])).rows.map((x) => x.n);
  assert.deepEqual(wer, [`${VON_DAMALS}; Form nachgeholt: ${ER}`], 'Prüfer von damals und wer nachholt');
  const p = (await q(`SELECT datei, datei_sha256, deutsch, ergebnis, antwort FROM namens_einlesen_protokoll WHERE lauf = $1 ORDER BY blatt_zeile, nummer`, [b.laeufe[0].lauf])).rows;
  assert.equal(p.length, 5);
  assert.ok(p.every((x) => x.datei === 'es.xlsx' && x.datei_sha256 === SHA(20)), 'Datei und Prüfwert von damals');
  assert.deepEqual(p.map((x) => [x.deutsch, x.ergebnis]),
    [['1 STK', 'freigegeben'], ['#er Pack', 'vorlaeufig'], ['#m Rolle', 'freigegeben'], ['#m Rolle', 'doppelt'], ['2-fach', 'form_offen']]);
  assert.equal(p[0].antwort, 'Korrektur: 1 ud.', 'Antwort von damals bleibt');
  assert.equal(await n(`SELECT count(*)::int AS n FROM namens_einlesen_protokoll WHERE sprache = 'ES'`), 5, 'fortgeschrieben, nicht verdoppelt');
  const g = (await q(`SELECT grund FROM namens_einlesen_protokoll WHERE sprache = 'ES' AND blatt_zeile = 15 AND nummer = 1`)).rows[0].grund;
  assert.match(g, /Muster aus „5m Rolle → rollo de 5 m“ · nachgeholt, vorher form_offen in Lauf 00000000-0000-4000-8000-000000000001: Wert im Paar/);
});

await pruefe('Nachholen ein zweites Mal: nur das wieder Offene, keine neue Fassung', async () => {
  const b = await nachholen({ sprache: 'ES', wer: ER, ausfuehren: true });
  assert.equal(b.offen, 1);
  assert.deepEqual([b.zaehlung.form_offen, b.zaehlung.freigegeben], [1, 0]);
  assert.equal(b.fassungNachher, b.fassungVorher);
  await assert.rejects(() => nachholen({ sprache: 'ES', wer: ' ', ausfuehren: false }), /genannt/);
});

await pruefe('Ohne Prüfwert, mit fremder Sprache oder ohne Bearbeiter wird nicht eingelesen', async () => {
  await assert.rejects(() => einlesen({ sprache: 'EN', text: LISTE, datei: 'x', sha256: 'abc', wer: WER, glossar: OHNE, ausfuehren: true }), /SHA-256/);
  await assert.rejects(() => einlesen({ sprache: 'DE', text: LISTE, datei: 'x', sha256: SHA(9), wer: WER, glossar: OHNE, ausfuehren: true }), /gibt es nicht/);
  await assert.rejects(() => einlesen({ sprache: 'EN', text: LISTE, datei: 'x', sha256: SHA(9), wer: ' ', glossar: OHNE, ausfuehren: true }), /genannt/);
  await assert.rejects(() => einlesen({ sprache: 'EN', text: LISTE, datei: 'x', sha256: SHA(9), wer: WER, ausfuehren: true }), /Glossar-Blatt fehlt/);
  await assert.rejects(() => einlesen({ sprache: 'EN', text: LISTE, datei: 'x', sha256: SHA(9), wer: WER, glossar: { ohne: ' ' }, ausfuehren: true }), /Glossar-Blatt fehlt/);
  await assert.rejects(() => einlesen({ sprache: 'PL', text: LISTE, datei: 'x', sha256: SHA(9), wer: WER, glossar: OHNE, ausfuehren: true }), /Glossar DE→PL: 0 gefunden/);
});

await pruefe('Einlesen mit Glossar-Blatt: der Widerspruch wird Rückfrage an derselben Zeile, die freigegeben bleibt; DeepL unberührt', async () => {
  const id = (await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Stromschiene', 'sínrendszer', TRUE) RETURNING id`,
    [GLOSSARE.HU])).rows[0].id;
  const v0 = await version('HU');
  const b = await einlesen({ sprache: 'HU', datei: 'hu.xlsx', sha256: SHA(30), wer: WER, ausfuehren: true,
    glossar: { datei: 'hu-glossar.tsv', werte: glossarWerte(blatt([72, 'Stromschiene', 'sín', '', 'sínrendszer', 'offen', 'Vorschlag / Proposal'])) },
    text: tsv([24, 1, '3-Phasen-System', 'Stromschiene', 'sín', 'OK', ''], [26, 1, 'Profilzubehör', 'Endkappe', 'végzáró', 'OK', '']) });
  assert.deepEqual(b.glossar, { datei: 'hu-glossar.tsv', begriffe: 1, widersprueche: 1 });
  assert.deepEqual([b.zaehlung.freigegeben, b.zaehlung.rueckfrage], [1, 1]);
  const w = await wl('HU');
  assert.deepEqual(w.map((r) => [r.deutsch, r.ziel, r.approved]), [['Endkappe', 'végzáró', true], ['Stromschiene', 'sínrendszer', true]]);
  assert.match(w.find((r) => r.deutsch === 'Stromschiene').rueckfrage, /Glossar-Blatt Zeile 72 sagt „sínrendszer“/);
  assert.equal((await q(`SELECT entry_id FROM namens_einlesen_protokoll WHERE sprache = 'HU' AND deutsch = 'Stromschiene'`)).rows[0].entry_id, id, 'an derselben Zeile');
  assert.equal(await version('HU'), v0);
});

await pruefe('Bauprüfung: das Einlesen nennt die alten Bausteintabellen nicht mehr', async () => {
  for (const f of ['src/services/namens-einlesen.ts', 'src/scripts/namens-bausteine-einlesen.ts', 'src/scripts/namens-form-offen-nachholen.ts']) {
    const s = readFileSync(join(WURZEL, f), 'utf-8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    assert.ok(!/namens_bausteine(?!_fassung)\b|namens_bausteine_vorlaeufig/.test(s), `${f} nennt noch die alte Tabelle`);
  }
});

await pool.end();
console.log(`\n${gruen} grün, ${rot} rot`);
process.exitCode = rot === 0 ? 0 : 1;
