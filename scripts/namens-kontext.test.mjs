#!/usr/bin/env node
/**
 * Prüfungen für die Kontext-Messung (Bauplan Bausteine Phase 2 §8, Cockpit #1767): Auswahl der Fälle
 * (`scripts/namens-kontext-faelle.mjs`), Messung und Bericht (`src/scripts/namens-kontext-messung.ts`) und dass `translateBatch`
 * den `context` an DeepL weitergibt.
 *
 * Ohne Datenbank und ohne DeepL: Die Translator-Methode ist ersetzt, alle Namen und Begriffe sind erfunden.
 *
 *   npm run build:server && node scripts/namens-kontext.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Auch ein gesetzter echter Schlüssel darf hier nichts erreichen. Die Datenbank zeigt auf Port 1: Eine Abfrage, die doch
// entsteht, scheitert sofort, statt irgendwo anzukommen.
process.env.DEEPL_API_KEY = 'attrappe-kein-schluessel';
process.env.DB_PASSWORD = 'attrappe-keine-datenbank';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('scripts', 'namens-kontext-messung.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};

const deepl = require('deepl-node');
const aufrufe = [];
deepl.Translator.prototype.translateText = async function (texte, quelle, ziel, optionen) {
  aufrufe.push({ texte, ziel, optionen: { ...optionen } });
  const liste = Array.isArray(texte) ? texte : [texte];
  const aus = liste.map((t) => ({ text: `${t}!`, detectedSourceLang: 'de' }));
  return Array.isArray(texte) ? aus : aus[0];
};

const auswahl = await import(pathToFileURL(join(WURZEL, 'scripts', 'namens-kontext-faelle.mjs')).href);
const messung = await laden('scripts', 'namens-kontext-messung.js');
const { translateBatch } = await laden('services', 'deepl.js');
const { pool } = await laden('db', 'connection.js');

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

const KOPF = 'target_lang\tsource_term\ttarget_term\tkategorie\tgewissheit\tvorschlag\tgrund\tquelle';
const h = (sprache, begriff, falsch, richtig, grund = 'Falsch heißt etwas anderes', kat = 'falsch', gew = 'hoch', qu = 'fachlich') =>
  [sprache, begriff, falsch, kat, gew, richtig, grund, qu].join('\t');
const name = (code, n) => ({ code, name: n });

console.log('Auswahl der Fälle');

await pruefe('Kandidaten: nur falsch, hoch, fachlich, ein Wort, eine Bedeutung im Grund, eine der acht Sprachen; je Sprache und Begriff einmal', async () => {
  const tsv = [KOPF,
    h('ES', 'rund', 'aproximadamente', 'redondo', 'Heißt ungefähr'),
    h('ES', 'Rund', 'otra', 'redonda'),
    h('ES', 'Ring', 'x', 'anillo', 'Falsch', 'falsch', 'mittel'),
    h('ES', 'Bogen', 'x', 'arco', 'Falsch', 'schreibung'),
    h('ES', 'Haken', 'x', 'gancho', 'Falsch', 'falsch', 'hoch', 'mechanisch'),
    h('ES', 'Lange Leiste', 'x', 'listón', 'Heißt anders'),
    h('ES', 'Kappe', 'x', 'tapa', 'Großschreibung falsch'),
    h('ES', 'Kante', 'x', '', 'Heißt anders'),
    h('DE', 'Kopf', 'x', 'y'),
    h('CZ', 'Cover', 'Obálka', 'kryt', 'Obálka bedeutet Briefumschlag'),
  ].join('\n');
  const k = auswahl.kandidaten(tsv);
  assert.deepEqual(k.map((x) => `${x.sprache} ${x.begriff}`), ['ES rund', 'CZ Cover']);
  assert.equal(k[0].falsch, 'aproximadamente');
  assert.equal(k[0].richtig, 'redondo');
});

await pruefe('Kandidaten: eine fehlende Spalte bricht ab, statt still nichts zu wählen', async () => {
  assert.throws(() => auswahl.kandidaten('target_lang\tsource_term\nES\trund'), /Spalte .* fehlt/);
});

await pruefe('Treffer nur als ganzes Wort, ohne Rücksicht auf Groß- und Kleinschreibung', async () => {
  const m = auswahl.wortMuster('rund');
  assert.ok(m.test('Einbaustrahler rund, weiß'));
  assert.ok(m.test('Einbaustrahler RUND'));
  assert.ok(!m.test('Rundprofil 2m'));
  assert.ok(!m.test('abgerundet'));
  assert.ok(auswahl.wortMuster('Sys-Wall').test('für Sys-Wall, 2m'));
  assert.ok(auswahl.wortMuster('a.b').test('x a.b y') && !auswahl.wortMuster('a.b').test('x acb y'), 'Sonderzeichen sind keine Muster');
});

await pruefe('Wahl: ein fehlender Planfall bricht ab, statt die Messung ohne ihn laufen zu lassen', async () => {
  assert.throws(() => auswahl.waehle([], [name('1', 'x')]), /Planfall ES rund/);
});

const planKand = auswahl.PLANFAELLE.map((p) => ({ sprache: p.sprache, begriff: p.begriff, falsch: 'f', richtig: 'r', grund: '' }));
const planNamen = auswahl.PLANFAELLE.map((p, i) => name(String(900 + i), `Artikel ${p.begriff} Ende`));

await pruefe(`Wahl: mindestens ${auswahl.MIN_NAMEN} Namen, je Sprache die ${auswahl.JE_SPRACHE} häufigsten, Gleichstand nach Alphabet, Kontext mit der kleinsten Nummer`, async () => {
  const kand = [...planKand, ...['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].map((b) => ({ sprache: 'FR', begriff: b, falsch: 'f', richtig: 'r', grund: '' }))];
  const namen = [...planNamen];
  const viele = { Aa: 12, Bb: 15, Cc: 12, Dd: 20, Ee: auswahl.MIN_NAMEN - 1 };
  let nr = 100;
  for (const [b, n] of Object.entries(viele)) for (let i = 0; i < n; i += 1) namen.push(name(String(nr--), `Leuchte ${b} Nr ${i}`));
  namen.push(name('9', 'Leuchte Dd klein'));
  const w = auswahl.waehle(kand, namen);
  const fr = w.filter((x) => x.sprache === 'FR');
  assert.deepEqual(fr.map((x) => x.begriff), ['Dd', 'Bb', 'Aa'], 'Dd 21, Bb 15, dann Aa vor Cc bei 12, Ee unter der Schwelle');
  assert.equal(fr[0].kontext, 'Leuchte Dd klein', 'Nummer 9 ist kleiner als 42 (numerisch; als Text wäre 42 vorn)');
  assert.equal(fr[0].namen, 21);
  assert.ok(fr.every((x) => x.grundDerWahl === 'regel'));
  const plan = w.filter((x) => x.grundDerWahl === 'plan');
  assert.deepEqual(plan.map((x) => `${x.sprache} ${x.begriff}`), ['ES rund', 'SK Rolle', 'CZ Cover'], 'unter der Schwelle trotzdem dabei');
});

await pruefe('Wahl: ein Planfall, den schon die Regel wählt, steht nur einmal da', async () => {
  const namen = [...planNamen];
  for (let i = 0; i < auswahl.MIN_NAMEN; i += 1) namen.push(name(String(10 + i), `Strahler rund ${i}`));
  const w = auswahl.waehle(planKand, namen);
  const rund = w.filter((x) => x.sprache === 'ES' && x.begriff === 'rund');
  assert.equal(rund.length, 1);
  assert.equal(rund[0].grundDerWahl, 'regel');
});

await pruefe('Die Falldatei der Auswahl liest die Messung ohne Verlust, auch mit Tabulator im Namen', async () => {
  const w = auswahl.waehle(planKand, [...planNamen, name('5', 'Name\tmit Tab Rolle')]);
  const zurueck = messung.leseFaelle(auswahl.alsTsv(w));
  assert.equal(zurueck.length, 3);
  assert.deepEqual(zurueck.map((f) => f.begriff), ['rund', 'Rolle', 'Cover']);
  assert.equal(zurueck[1].kontext, 'Name mit Tab Rolle', 'der Tabulator wird zum Leerzeichen, die Spalten bleiben');
  assert.equal(zurueck[1].artikelnummer, '5');
  assert.equal(typeof zurueck[0].namen, 'number');
});

await pruefe('Falldatei: falsche Kopfzeile, fehlende Spalte oder leeres Pflichtfeld brechen ab', async () => {
  assert.throws(() => messung.leseFaelle('a\tb\n1\t2'), /Kopfzeile/);
  const kopf = 'sprache\tbegriff\tfalsch\trichtig\tkontext\tartikelnummer\tnamen\twahl';
  assert.throws(() => messung.leseFaelle(`${kopf}\nES\trund\tx`), /Spalten/);
  assert.throws(() => messung.leseFaelle(`${kopf}\nES\trund\tx\ty\t\t1\t3\tplan`), /Pflichtfeld/);
});

console.log('\nMessung');

const FALL = { sprache: 'ES', begriff: 'rund', falsch: 'aproximadamente', richtig: 'redondo', kontext: 'Strahler rund, weiß', artikelnummer: '1', namen: 3, wahl: 'plan' };

await pruefe('je Fall vier Aufrufe in der Reihenfolge ohne, mit, ohne, mit; Kontext nur auf der Seite „mit“, nie ein Glossar', async () => {
  const gesehen = [];
  await messung.messe([FALL], async (p) => {
    gesehen.push(p);
    return { status: 'ok', vorschlag: 'x' };
  });
  assert.deepEqual(gesehen.map((p) => p.kontext), [null, FALL.kontext, null, FALL.kontext]);
  assert.ok(gesehen.every((p) => p.deeplGlossaryId === null && p.sourceLang === 'DE' && p.targetLang === 'ES' && p.begriff === 'rund'));
});

await pruefe('Lesart: alter Fehler, Vorschlag der Prüfung, anders, kein Vorschlag; Groß- und Kleinschreibung und Satzzeichen am Rand zählen nicht', async () => {
  assert.equal(messung.lies({ status: 'ok', vorschlag: 'Aproximadamente.' }, FALL).lesart, 'falsch');
  assert.equal(messung.lies({ status: 'ok', vorschlag: ' „Redondo“ ' }, FALL).lesart, 'richtig');
  assert.equal(messung.lies({ status: 'ok', vorschlag: 'redonda' }, FALL).lesart, 'anders');
  const k = messung.lies({ status: 'wert_verloren', fehlend: ['x'] }, FALL);
  assert.deepEqual([k.lesart, k.text], ['kein_vorschlag', null]);
});

const antworten = (folge) => {
  let i = 0;
  return async () => ({ status: 'ok', vorschlag: folge[i++] });
};

await pruefe('Zusammenfassung: behoben zählt nur, wenn beide Seiten im Kontrolllauf gleich bleiben', async () => {
  // Reihenfolge je Fall: ohne1, mit1, ohne2, mit2
  const e = await messung.messe([FALL, FALL, FALL, FALL], antworten([
    'aproximadamente', 'redondo', 'aproximadamente', 'redondo', // stabil, behoben
    'aproximadamente', 'redondo', 'redonda', 'redondo', // ohne schwankt: zählt nicht als behoben
    'redondo', 'aproximadamente', 'redondo', 'aproximadamente', // stabil, verschlechtert
    'redondo', 'redondo', 'redondo', 'redondo', // stabil, unverändert
  ]));
  const z = messung.fasseZusammen(e);
  assert.equal(z.faelle, 4);
  assert.deepEqual(z.ohne, { falsch: 2, richtig: 2, anders: 0, kein_vorschlag: 0 });
  assert.deepEqual(z.mit, { falsch: 1, richtig: 3, anders: 0, kein_vorschlag: 0 });
  assert.deepEqual(z.stabil, { ohne: 3, mit: 4, beide: 3 });
  assert.deepEqual([z.geaendert, z.behoben, z.verschlechtert], [2, 1, 1]);
  assert.deepEqual([z.vomFehlerWeg, z.zumFehlerHin], [1, 1]);
});

await pruefe('Zusammenfassung: der Weg zum alten Fehler zählt auch, wenn der Text ohne Kontext weder Fehler noch Prüfvorschlag war', async () => {
  // rückversetzt EN am 09.11.2026: ohne „set back“, mit „recessed“; verschlechtert sieht das nicht.
  const fall = { ...FALL, sprache: 'EN', begriff: 'rückversetzt', falsch: 'recessed', richtig: 'deep-set' };
  const e = await messung.messe([fall], antworten(['set back', 'recessed', 'set back', 'recessed']));
  const z = messung.fasseZusammen(e);
  assert.equal(z.verschlechtert, 0);
  assert.equal(z.zumFehlerHin, 1);
  assert.equal(z.vomFehlerWeg, 0);
});

await pruefe('Bericht: Adressen werden ausgelassen, ein senkrechter Strich bricht die Tabelle nicht', async () => {
  const adresse = ['w', 'w', 'w'].join('') + '.beispiel.at';
  const fall = { ...FALL, kontext: `Strahler rund | siehe ${adresse}` };
  const e = await messung.messe([fall], antworten(['a|b', 'redondo', 'a|b', 'redondo']));
  const md = messung.alsMarkdown(e, messung.fasseZusammen(e), { datum: '2026-11-09-1200', vorher: 100, nachher: 140, faelleDatei: 'faelle.tsv' });
  assert.ok(!md.includes(adresse));
  assert.ok(md.includes('[Text mit Adresse ausgelassen]'));
  assert.ok(md.includes('a\\|b'));
  assert.ok(md.includes('40 Zeichen'));
});

await pruefe('Bericht neu aus der JSON-Datei: Zusammenfassung neu gerechnet, Antworten unverändert, kein DeepL-Aufruf', async () => {
  const e = await messung.messe([FALL], antworten(['aproximadamente', 'redondo', 'aproximadamente', 'redondo']));
  const ordner = mkdtempSync(join(tmpdir(), 'kontext-'));
  const json = join(ordner, 'kontext-2026-11-09-1200.json');
  // So sah eine Datei vor den Zählern vomFehlerWeg und zumFehlerHin aus: veraltete Zusammenfassung, kein Name der Falldatei.
  writeFileSync(json, JSON.stringify({ datum: '2026-11-09-1200', vorher: 10, nachher: 20, zusammenfassung: { alt: true }, ergebnis: e }));
  aufrufe.length = 0;
  const md = messung.berichtNeu(json);
  assert.equal(aufrufe.length, 0);
  const neu = JSON.parse(readFileSync(json, 'utf-8'));
  assert.deepEqual(neu.ergebnis, e);
  assert.equal(neu.zusammenfassung.vomFehlerWeg, 1);
  assert.equal(neu.faelleDatei, 'faelle.tsv');
  const text = readFileSync(md, 'utf-8');
  assert.ok(text.includes('Vom alten Fehler weg: 1, zum alten Fehler hin: 0'));
  assert.ok(text.includes('10 Zeichen'));
  assert.throws(() => {
    writeFileSync(json, JSON.stringify({ datum: 'x', ergebnis: [] }));
    messung.berichtNeu(json);
  }, /keine Messung/);
});

console.log('\ntranslateBatch reicht den Kontext durch');

await pruefe('mit Kontext: genau dieser Text als context, getrimmt; ohne oder nur Leerzeichen: kein Parameter', async () => {
  aufrufe.length = 0;
  await translateBatch(['rund'], { sourceLang: 'DE', targetLang: 'ES', context: '  Strahler rund, weiß ' });
  await translateBatch(['rund'], { sourceLang: 'DE', targetLang: 'ES' });
  await translateBatch(['rund'], { sourceLang: 'DE', targetLang: 'ES', context: '   ' });
  assert.equal(aufrufe.length, 3);
  assert.equal(aufrufe[0].optionen.context, 'Strahler rund, weiß');
  assert.ok(!('context' in aufrufe[1].optionen));
  assert.ok(!('context' in aufrufe[2].optionen));
});

await pool.end();
console.log(`\n${gruen} grün, ${rot} rot`);
process.exit(rot === 0 ? 0 : 1);
