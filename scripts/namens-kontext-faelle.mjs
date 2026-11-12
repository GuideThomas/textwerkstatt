#!/usr/bin/env node
/**
 * Wählt die Fälle für die Kontext-Messung (Bauplan Bausteine Phase 2 §8, Cockpit #1767) und schreibt sie als TSV.
 *
 * Rein: liest zwei Dateien, schreibt eine, fragt weder DeepL noch eine Datenbank. Die Regel steht hier, **bevor** gemessen wird,
 * damit sich die Auswahl nicht nach dem Ergebnis richtet:
 *
 *   Kandidat     Zeile aus `glossar_hinweise.tsv` (Assistent `docs/analyse-artikelnamen/glossar/`) mit kategorie `falsch`,
 *                gewissheit `hoch`, quelle `fachlich`, Zielsprache eine der acht Namenssprachen, Begriff ein Wort ohne
 *                Leerzeichen, Grund nennt eine Bedeutung (`heißt`, `bedeutet`), Vorschlag nicht leer. Das sind die Fälle, in denen
 *                ein Wort für sich gelesen etwas anderes heißt als im Artikelnamen; nur dort kann ein Kontext etwas ändern.
 *   Baustein     der Begriff steht als ganzes Wort in mindestens `MIN_NAMEN` deutschen Artikelnamen.
 *   Auswahl      je Sprache die `JE_SPRACHE` mit den meisten Namen (Gleichstand: Begriff nach Alphabet), dazu die drei Fälle
 *                aus dem Plan (`rund` ES, `Rolle` SK, `Cover` CZ), wenn sie nicht schon dabei sind.
 *   Kontext      der Name mit der kleinsten Artikelnummer unter den Treffern, also kein ausgesuchter.
 *
 * Aufruf (am VPS, wo die Namen liegen; die Namensdatei ist `item_code<TAB>item_name` je Zeile, ohne Kopf):
 *
 *   node scripts/namens-kontext-faelle.mjs <glossar_hinweise.tsv> <namen.tsv> <faelle.tsv>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SPRACHEN = ['EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ'];
export const MIN_NAMEN = 10;
export const JE_SPRACHE = 3;
export const PLANFAELLE = [
  { sprache: 'ES', begriff: 'rund' },
  { sprache: 'SK', begriff: 'Rolle' },
  { sprache: 'CZ', begriff: 'Cover' },
];

const ESC = /[.*+?^${}()|[\]\\]/g;
/** Ganzes Wort: weder davor noch danach ein Buchstabe oder eine Ziffer. Groß- und Kleinschreibung zählt nicht. */
export const wortMuster = (begriff) => new RegExp(`(?<![\\p{L}\\p{N}])${begriff.replace(ESC, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');

export function kandidaten(hinweiseTsv) {
  const [kopf, ...zeilen] = hinweiseTsv.split(/\r?\n/).filter((z) => z.trim() !== '');
  const spalten = kopf.split('\t');
  const i = (n) => {
    const k = spalten.indexOf(n);
    if (k < 0) throw new Error(`Spalte ${n} fehlt in den Hinweisen`);
    return k;
  };
  const [sp, be, al, ka, ge, vo, gr, qu] = ['target_lang', 'source_term', 'target_term', 'kategorie', 'gewissheit', 'vorschlag', 'grund', 'quelle'].map(i);
  const aus = new Map();
  for (const z of zeilen) {
    const f = z.split('\t');
    const k = { sprache: f[sp], begriff: (f[be] ?? '').trim(), falsch: (f[al] ?? '').trim(), richtig: (f[vo] ?? '').trim(), grund: f[gr] ?? '' };
    if (f[ka] !== 'falsch' || f[ge] !== 'hoch' || f[qu] !== 'fachlich') continue;
    if (!SPRACHEN.includes(k.sprache) || !k.begriff || /\s/u.test(k.begriff) || !k.richtig || !k.falsch) continue;
    if (!/heißt|bedeutet/iu.test(k.grund)) continue;
    const schluessel = `${k.sprache}\t${k.begriff.toLowerCase()}`;
    if (!aus.has(schluessel)) aus.set(schluessel, k);
  }
  return [...aus.values()];
}

export function waehle(kand, namen) {
  const nummer = (a, b) => a.code.localeCompare(b.code, 'de', { numeric: true });
  const mitTreffern = kand.map((k) => {
    const m = wortMuster(k.begriff);
    const treffer = namen.filter((n) => m.test(n.name)).sort(nummer);
    return { ...k, namen: treffer.length, kontext: treffer[0]?.name ?? '', code: treffer[0]?.code ?? '' };
  });
  const gewaehlt = [];
  for (const s of SPRACHEN) {
    const je = mitTreffern
      .filter((k) => k.sprache === s && k.namen >= MIN_NAMEN)
      .sort((a, b) => b.namen - a.namen || a.begriff.localeCompare(b.begriff, 'de'))
      .slice(0, JE_SPRACHE);
    gewaehlt.push(...je.map((k) => ({ ...k, grundDerWahl: 'regel' })));
  }
  for (const p of PLANFAELLE) {
    if (gewaehlt.some((k) => k.sprache === p.sprache && k.begriff.toLowerCase() === p.begriff.toLowerCase())) continue;
    const k = mitTreffern.find((x) => x.sprache === p.sprache && x.begriff.toLowerCase() === p.begriff.toLowerCase());
    if (!k) throw new Error(`Planfall ${p.sprache} ${p.begriff} steht nicht unter den Kandidaten`);
    if (!k.kontext) throw new Error(`Planfall ${p.sprache} ${p.begriff} hat keinen Namen als Kontext`);
    gewaehlt.push({ ...k, grundDerWahl: 'plan' });
  }
  return gewaehlt;
}

export function alsTsv(faelle) {
  const kopf = ['sprache', 'begriff', 'falsch', 'richtig', 'kontext', 'artikelnummer', 'namen', 'wahl'];
  const sauber = (t) => String(t).replace(/[\t\r\n]+/gu, ' ');
  return [kopf.join('\t'), ...faelle.map((k) =>
    [k.sprache, k.begriff, k.falsch, k.richtig, k.kontext, k.code, k.namen, k.grundDerWahl].map(sauber).join('\t'))].join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [hinweise, namenDatei, ziel] = process.argv.slice(2);
  if (!hinweise || !namenDatei || !ziel) {
    console.error('Aufruf: node scripts/namens-kontext-faelle.mjs <glossar_hinweise.tsv> <namen.tsv> <faelle.tsv>');
    process.exit(2);
  }
  const namen = readFileSync(namenDatei, 'utf-8').split(/\r?\n/).filter(Boolean).map((z) => {
    const t = z.indexOf('\t');
    return { code: z.slice(0, t), name: z.slice(t + 1) };
  }).filter((n) => n.code && n.name);
  if (namen.length === 0) throw new Error('keine Namen gelesen');
  const kand = kandidaten(readFileSync(hinweise, 'utf-8'));
  const faelle = waehle(kand, namen);
  writeFileSync(ziel, alsTsv(faelle));
  console.log(`${namen.length} Namen, ${kand.length} Kandidaten, ${faelle.length} Fälle → ${ziel}`);
  for (const s of SPRACHEN) console.log(`  ${s}: ${faelle.filter((k) => k.sprache === s).map((k) => `${k.begriff} (${k.namen})`).join(', ')}`);
}
