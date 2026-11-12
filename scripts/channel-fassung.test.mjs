#!/usr/bin/env node
/**
 * Prüfungen für die Channel-Fassung (`rewriteOne`, `checkRewrite`).
 *
 *   npm run build:server && node scripts/channel-fassung.test.mjs
 *
 * Das Sprachmodell ist eine Attrappe, die eine vorgegebene Antwort liefert —
 * geprüft wird, ob die Schranken eine schlechte Antwort ABLEHNEN. Jede Schranke
 * hat einen Fall, der durchgeht, und einen, der fällt.
 */
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// config.ts bricht ohne DB_PASSWORD ab; die Prüfungen selbst brauchen keine DB
if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'PLATZHALTER_NUR_FUER_DEN_IMPORT';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE = join(__dirname, '..', 'dist', 'services', 'channel-fassung.js');
if (!existsSync(MODULE)) {
  console.error(`Fehlt: ${MODULE} — vorher npm run build:server`);
  process.exit(1);
}
const { rewriteOne, rewriteMany } = await import(pathToFileURL(MODULE).href);

const TERMS = [
  { avoidTerm: 'LED-Treiber', preferredTerm: 'LED-Trafo', note: null },
  { avoidTerm: 'Lichtband', preferredTerm: 'LED-Streifen', note: null },
];

/** Attrappe: liefert `answer` und zählt die Aufrufe. */
function fake(answer) {
  const f = async () => { f.calls++; return answer; };
  f.calls = 0;
  return f;
}

const cases = [
  {
    name: 'Ohne Treffer: unverändert, kein Modellaufruf',
    text: 'Das Profil wird montiert.',
    answer: 'SOLLTE NIE KOMMEN',
    expect: { herkunft: 'unverändert', text: 'Das Profil wird montiert.', calls: 0 },
  },
  {
    name: 'Gute Antwort: Genus angepasst, wird übernommen',
    text: 'Ein kompaktes Lichtband mit LED-Treiber.',
    answer: 'Ein kompakter LED-Streifen mit LED-Trafo.',
    expect: { herkunft: 'sprachmodell', text: 'Ein kompakter LED-Streifen mit LED-Trafo.', calls: 1 },
  },
  {
    name: 'Schranke c: Änderung außerhalb des Fensters fällt',
    text: 'Das Profil ist sehr schön. Ein kompaktes Lichtband.',
    answer: 'Dieses Profil ist sehr schön. Ein kompakter LED-Streifen.',
    expect: { herkunft: 'regel', text: 'Das Profil ist sehr schön. Ein kompaktes LED-Streifen.', pruefen: /außerhalb/ },
  },
  {
    name: 'Schranke c: Einfügung außerhalb des Fensters fällt',
    text: 'Das Profil ist sehr schön. Ein kompaktes Lichtband.',
    answer: 'Wirklich: Das Profil ist sehr schön. Ein kompakter LED-Streifen.',
    expect: { herkunft: 'regel', pruefen: /außerhalb/ },
  },
  {
    name: 'Schranke b: Begriff stehen gelassen fällt',
    text: 'Der LED-Treiber passt.',
    answer: 'Der LED-Treiber passt.',
    expect: { herkunft: 'regel', text: 'Der LED-Trafo passt.', pruefen: /nicht ersetzt/ },
  },
  {
    name: 'Schranke b: falscher Ersatz fällt',
    text: 'Ein kompaktes Lichtband.',
    answer: 'Ein kompakter Leuchtstreifen.',
    expect: { herkunft: 'regel', pruefen: /fehlt/ },
  },
  {
    name: 'Schranke b: Umlaut-Plural des Ersatzes gilt als vorhanden',
    terms: [{ avoidTerm: 'Streifen', preferredTerm: 'Lichtband', note: null }],
    text: 'Es passen mehrere Streifen hinein.',
    answer: 'Es passen mehrere Lichtbänder hinein.',
    expect: { herkunft: 'sprachmodell', text: 'Es passen mehrere Lichtbänder hinein.' },
  },
  {
    name: 'Schranke a: IDML-Marker verloren fällt, Regel behält ihn',
    text: 'Der <x id="1"/>LED-Treiber<x id="2"/> passt.',
    answer: 'Der LED-Trafo passt.',
    expect: { herkunft: 'regel', text: 'Der <x id="1"/>LED-Trafo<x id="2"/> passt.', pruefen: /Platzhalter/ },
  },
  {
    name: 'Schranke a: Sentinel verändert fällt',
    text: 'Der LED-Treiber hat __ISOLUNIT0__.',
    answer: 'Der LED-Trafo hat 12 W.',
    expect: { herkunft: 'regel', pruefen: /Platzhalter/ },
  },
  {
    name: 'Schranke a: Marker unverändert geht durch',
    text: 'Der <x id="1"/>LED-Treiber<x id="2"/> passt.',
    answer: 'Der <x id="1"/>LED-Trafo<x id="2"/> passt.',
    expect: { herkunft: 'sprachmodell' },
  },
  {
    name: 'Schranke d: aufgeblähte Antwort fällt',
    text: 'Der LED-Treiber passt.',
    answer: 'Der LED-Trafo passt wirklich ganz ausgezeichnet und hervorragend.',
    expect: { herkunft: 'regel', pruefen: /Länge/ },
  },
  {
    name: 'Modell nicht erreichbar: Regel und Kennzeichen',
    text: 'Der LED-Treiber passt.',
    answer: null,
    expect: { herkunft: 'regel', text: 'Der LED-Trafo passt.', pruefen: /nicht erreichbar/ },
  },
  {
    name: 'Begriff in einer URL ist kein Treffer',
    text: '<a href="/led-treiber.html">Mehr</a>',
    answer: 'SOLLTE NIE KOMMEN',
    expect: { herkunft: 'unverändert', calls: 0 },
  },
  {
    name: 'Kompositum: Ersatz im zusammengesetzten Wort geht durch',
    text: 'Die LED-Treiberleistung reicht.',
    answer: 'Die LED-Trafoleistung reicht.',
    expect: { herkunft: 'sprachmodell' },
  },
];

let failed = 0;
for (const c of cases) {
  const um = fake(c.answer);
  const r = await rewriteOne(c.text, c.terms ?? TERMS, um);
  const problems = [];
  if (r.herkunft !== c.expect.herkunft) problems.push(`herkunft ${r.herkunft}`);
  if (c.expect.text !== undefined && r.text !== c.expect.text) problems.push(`text ${JSON.stringify(r.text)}`);
  if (c.expect.calls !== undefined && um.calls !== c.expect.calls) problems.push(`Aufrufe ${um.calls}`);
  if (c.expect.pruefen && !c.expect.pruefen.test(r.pruefen ?? '')) problems.push(`pruefen ${JSON.stringify(r.pruefen)}`);
  if (!c.expect.pruefen && r.pruefen !== null) problems.push(`unerwartet pruefen ${JSON.stringify(r.pruefen)}`);
  if (problems.length) failed++;
  console.log(`${problems.length ? 'FAIL' : 'OK  '} ${c.name}`);
  if (problems.length) console.log(`     ${problems.join(' · ')}`);
}

// Reihenfolge bleibt bei paralleler Abarbeitung erhalten
const texts = ['A Lichtband', 'B ohne', 'C LED-Treiber', 'D ohne', 'E Lichtband'];
const many = await rewriteMany(texts, TERMS, async () => null);
const orderOk = JSON.stringify(many.map((m) => m.text[0])) === JSON.stringify(['A', 'B', 'C', 'D', 'E']);
if (!orderOk) failed++;
console.log(`${orderOk ? 'OK  ' : 'FAIL'} Reihenfolge bei paralleler Abarbeitung`);

console.log(failed ? `\n${failed} fehlgeschlagen` : '\nAlle Prüfungen grün');
process.exit(failed ? 1 : 0);
