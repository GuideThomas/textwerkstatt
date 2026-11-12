#!/usr/bin/env node
/**
 * Prüfungen für `/api/uebersetzung-pruefung` (Schicht 2+3 der Übersetzungsprüfung).
 *
 *   npm run build:server && node scripts/uebersetzung-pruefung.test.mjs
 *
 * ── WORAUF DIESE PRÜFUNGEN ANTWORTEN ────────────────────────────────────────
 *
 * 🚨 DER ENDPUNKT IST NEU, DER MECHANISMUS NICHT. `detectDifferences()` und
 * `analyzeBatch()` stammen aus dem Terminologie-Scan und laufen dort seit
 * Langem. Neu ist ausschliesslich der Eingang: SAP-Slots statt eines
 * Zwei-Dateien-Uploads. Geprüft wird deshalb genau das Neue — die Vorfilterung
 * (`teilePaareAuf`) und die Schwelle, gegen die sie arbeitet.
 *
 * 🚨 ZWEI FEHLALARM-FALLEN, DIE DIE PRÜFUNG WERTLOS MACHTEN, WENN SIE NICHT
 * GRIFFEN:
 *
 *   1. Der echte Übersetzungslauf **kürzt** Artikelnamen über 100 Zeichen per
 *      LLM. Die DeepL-Referenz ist ungekürzt. Ohne die `maxChars`-Regel meldete
 *      Schicht 2 jeden gekürzten Namen als Abweichung — dauerhaft, und die
 *      Prüfung wäre nach dem zweiten Blick abgeschaltet.
 *   2. Der Segment-Cache ist mit den Übersetzungen gefüllt, die der
 *      Artikelanlage-Assistent selbst erzeugt hat. Trifft er, vergleicht sich
 *      die Schicht mit sich selbst: Ähnlichkeit 1,0, kein Befund — und das
 *      liest sich wie „geprüft und gut". Solche Paare müssen markiert
 *      ankommen, dürfen aber NICHT aus dem Vergleich fallen.
 *
 * ⚠️ GEGENPROBEN. Zu jeder Regel steht ein Fall daneben, der auslösen MUSS —
 * eine Filterregel, die alles durchlässt, wäre sonst grün.
 *
 * ⚠️ Reine Funktionen: keine Datenbank, kein Netz, kein LLM, keine Kosten.
 *
 * Exit 0 = alles grün, sonst 1.
 */

import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// ⚠️ `config.ts` bricht ohne DB_PASSWORD ab, und die geprüften Module hängen
// über die Importkette daran. Hier steht deshalb ein PLATZHALTER, kein echtes
// Passwort: Der Verbindungspool wird nur angelegt, nie benutzt — diese Prüfungen
// rechnen ausschliesslich auf Zeichenketten. Ein echter Wert hätte in einer
// Testdatei ohnehin nichts verloren.
if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'PLATZHALTER_NUR_FUER_DEN_IMPORT';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ROUTE = join(ROOT, 'dist', 'routes', 'uebersetzung-pruefung.js');
const SCAN = join(ROOT, 'dist', 'services', 'terminology-scan.js');

for (const m of [ROUTE, SCAN]) {
  if (!existsSync(m)) {
    console.error('ABBRUCH: ' + m + ' fehlt — zuerst `npm run build:server`.');
    process.exit(1);
  }
}

const { teilePaareAuf, waehleFuerLlm } = await import(pathToFileURL(ROUTE).href);
const { detectDifferences, textSimilarity } = await import(pathToFileURL(SCAN).href);

let gruen = 0;
let rot = 0;
function check(name, ok, zusatz = '') {
  if (ok === true) { gruen += 1; console.log('  ok    ' + name); }
  else { rot += 1; console.log('  FEHL  ' + name); if (zusatz) console.log('        ' + zusatz); }
}

const paar = (o) => ({
  id: 'p', targetLang: 'EN', sourceText: 'Leuchte', existingTranslation: 'Luminaire',
  deeplTranslation: 'Luminaire', ...o,
});
const gruende = (ps) => teilePaareAuf(ps).nichtAuswertbar.map((n) => n.grund);

// ── 1) Leere Referenz: keine Aussage, kein Vergleich ────────────────────────
console.log('\nLeere Referenz — ein fehlendes Ergebnis darf nicht wie ein gutes aussehen');
{
  const { auswertbar, nichtAuswertbar } = teilePaareAuf([paar({ deeplTranslation: '' })]);
  check('leere Referenz fällt aus dem Vergleich', auswertbar.length === 0);
  check('und wird als `referenz_leer` benannt',
    nichtAuswertbar[0]?.grund === 'referenz_leer', JSON.stringify(nichtAuswertbar));
  check('auch reines Leerzeichen zählt als leer',
    gruende([paar({ deeplTranslation: '   ' })])[0] === 'referenz_leer');
  // 🚨 GEGENPROBE: eine gefüllte Referenz MUSS durchkommen — sonst prüfte die
  // Regel gar nichts und alle Fälle fielen still heraus.
  check('🚨 Gegenprobe: gefüllte Referenz kommt durch',
    teilePaareAuf([paar({})]).auswertbar.length === 1);
}

// ── 2) Die Verdichtung des echten Laufs ist kein Übersetzungsfehler ─────────
console.log('\nGekürzte Artikelnamen — die Falle, die jeden langen Namen rot färbte');
{
  const lang = 'A'.repeat(120);   // Referenz ungekürzt, > 100
  const kurz = 'A'.repeat(90);    // Bestand verdichtet, <= 100
  check('Referenz über der Grenze, Bestand darunter ⇒ nicht auswertbar',
    gruende([paar({ maxChars: 100, deeplTranslation: lang, existingTranslation: kurz })])[0]
      === 'verdichtet');
  check('und aus dem Vergleich genommen',
    teilePaareAuf([paar({ maxChars: 100, deeplTranslation: lang, existingTranslation: kurz })])
      .auswertbar.length === 0);

  // 🚨 GEGENPROBEN: Die Regel darf nur greifen, wo sie soll. Drei Fälle, die
  // AUSWERTBAR bleiben müssen — sonst versteckte sie echte Befunde.
  check('🚨 Gegenprobe: ohne maxChars greift sie nicht (nur Namensfelder haben die Grenze)',
    teilePaareAuf([paar({ deeplTranslation: lang, existingTranslation: kurz })])
      .auswertbar.length === 1);
  check('🚨 Gegenprobe: beide unter der Grenze ⇒ ganz normaler Vergleich',
    teilePaareAuf([paar({ maxChars: 100, deeplTranslation: 'kurz', existingTranslation: 'kürzer' })])
      .auswertbar.length === 1);
  check('🚨 Gegenprobe: BEIDE über der Grenze ⇒ die Kürzung erklärt nichts, also auswertbar',
    teilePaareAuf([paar({
      maxChars: 100, deeplTranslation: lang, existingTranslation: 'B'.repeat(115),
    })]).auswertbar.length === 1);
}

// ── 3) Der eigene Cache: markieren, nicht aussortieren ─────────────────────
console.log('\nReferenz aus dem eigenen Segment-Cache — sichtbar, aber nicht weggefiltert');
{
  const { auswertbar, nichtAuswertbar } = teilePaareAuf([
    paar({ id: 'c', referenzHerkunft: 'cache', deeplTranslation: 'Lamp' }),
  ]);
  check('🚨 sie bleibt im Vergleich — der Befund wäre sonst still verschwunden',
    auswertbar.length === 1, JSON.stringify(auswertbar));
  check('und ist zugleich als nicht unabhängig ausgewiesen',
    nichtAuswertbar[0]?.grund === 'referenz_aus_eigenem_cache',
    JSON.stringify(nichtAuswertbar));
  // 🚨 GEGENPROBE: frisch von DeepL geholt ⇒ keine Markierung.
  check('🚨 Gegenprobe: Herkunft `deepl` erzeugt keinen Vermerk',
    teilePaareAuf([paar({ referenzHerkunft: 'deepl' })]).nichtAuswertbar.length === 0);
  check('🚨 Gegenprobe: fehlende Herkunftsangabe erzeugt keinen Vermerk',
    teilePaareAuf([paar({})]).nichtAuswertbar.length === 0);
}

// ── 4) Reihenfolge der Regeln ──────────────────────────────────────────────
//
// Eine leere Referenz aus dem Cache ist zuerst einmal LEER. Stünde die
// Cache-Regel vorne, meldete die Antwort „nicht unabhängig" für ein Paar, das
// überhaupt nicht verglichen wurde — zwei Aussagen über denselben Slot, von
// denen nur eine stimmt.
console.log('\nReihenfolge der Regeln — der stärkere Grund gewinnt');
{
  const g = gruende([paar({ deeplTranslation: '', referenzHerkunft: 'cache' })]);
  check('leer schlägt Cache', g.length === 1 && g[0] === 'referenz_leer', JSON.stringify(g));
  const g2 = gruende([paar({
    maxChars: 100, deeplTranslation: 'A'.repeat(120), existingTranslation: 'A'.repeat(90),
    referenzHerkunft: 'cache',
  })]);
  check('verdichtet schlägt Cache', g2.length === 1 && g2[0] === 'verdichtet', JSON.stringify(g2));
}

// ── 5) Die Schwelle, gegen die das alles arbeitet ──────────────────────────
console.log('\nSchwelle 0,95 — dieselbe wie im Terminologie-Scan');
{
  check('gleicher Text ⇒ Ähnlichkeit 1', textSimilarity('Luminaire LED', 'Luminaire LED') === 1);
  check('Gross-/Kleinschreibung und Leerraum werden normalisiert',
    textSimilarity('Luminaire  LED', 'luminaire led') === 1);
  const aligned = [
    { position: 0, sourceText: 'Leuchte', existingTranslation: 'Luminaire LED' },
    { position: 1, sourceText: 'Leuchte', existingTranslation: 'Lampe komplett anders' },
  ];
  const diffs = detectDifferences(aligned, ['Luminaire LED', 'Luminaire LED']);
  check('nur die echte Abweichung wird gemeldet',
    diffs.length === 1 && diffs[0].position === 1, JSON.stringify(diffs.map((d) => d.position)));
  // 🚨 GEGENPROBE: eine Schwelle, die IMMER auslöst, wäre genauso wertlos wie
  // eine, die nie auslöst.
  check('🚨 Gegenprobe: zwei identische Paare ergeben KEINEN Befund',
    detectDifferences(aligned, ['Luminaire LED', 'Lampe komplett anders']).length === 0);
  check('die `position` überlebt die Filterung — sonst zeigt der Befund auf den falschen Slot',
    detectDifferences(
      [{ position: 7, sourceText: 'x', existingTranslation: 'aaa' }], ['zzz'],
    )[0].position === 7);
}

// ── 6) Mehrere Paare, gemischt ─────────────────────────────────────────────
console.log('\nGemischte Menge — die Zählungen müssen aufgehen');
{
  const menge = [
    paar({ id: '0' }),
    paar({ id: '1', deeplTranslation: '' }),
    paar({ id: '2', referenzHerkunft: 'cache' }),
    paar({ id: '3', maxChars: 100, deeplTranslation: 'A'.repeat(120), existingTranslation: 'A'.repeat(50) }),
  ];
  const { auswertbar, nichtAuswertbar } = teilePaareAuf(menge);
  check('2 von 4 bleiben im Vergleich (das leere und das verdichtete fallen raus)',
    auswertbar.length === 2, auswertbar.map((p) => p.id).join(','));
  check('das Cache-Paar ist unter den auswertbaren',
    auswertbar.some((p) => p.id === '2'));
  check('3 Vermerke: leer, Cache, verdichtet',
    nichtAuswertbar.length === 3, JSON.stringify(nichtAuswertbar.map((n) => n.grund)));
  check('jeder Vermerk trägt Kennung und Sprache',
    nichtAuswertbar.every((n) => n.id && n.targetLang));
}

// ── 7) Wer ans Modell darf ─────────────────────────────────────────────────
//
// 🚨 GEMESSEN AM 28.08.2026 AN 203 ECHTEN SAP-SLOTS: 78,3 % liegen unter der
// Schwelle 0,95, Median 0,486. Für Artikelnamen ist „weicht ab" die Regel, nicht
// die Ausnahme — Schicht 2 ordnet also nach Auffälligkeit, statt zu entscheiden.
// Ans Modell gehen deshalb die auffälligsten N. Ohne diese Auswahl kostete ein
// Klick auf 500 Slots rund 390 Bewertungen für eine Liste, die niemand liest.
console.log('\nAuswahl fürs Modell — das Unähnlichste zuerst');
{
  const d = (pos, existing, deepl) =>
    ({ position: pos, sourceText: 'x', existingTranslation: existing, deeplTranslation: deepl });
  // Absteigende Ähnlichkeit: 0 ist am unähnlichsten, 3 am ähnlichsten.
  const diffs = [
    d(0, 'aaaaaaaaaa', 'zzzzzzzzzz'),
    d(1, 'aaaaaaaaaa', 'aazzzzzzzz'),
    d(2, 'aaaaaaaaaa', 'aaaaazzzzz'),
    d(3, 'aaaaaaaaaa', 'aaaaaaaazz'),
  ];
  check('die Obergrenze wird eingehalten', waehleFuerLlm(diffs, 2).length === 2);
  check('🚨 und es sind die UNÄHNLICHSTEN — nicht die ersten der Eingabe',
    waehleFuerLlm(diffs, 2).map((x) => x.position).join(',') === '0,1',
    waehleFuerLlm(diffs, 2).map((x) => x.position).join(','));
  check('die Reihenfolge ist aufsteigend nach Ähnlichkeit',
    waehleFuerLlm(diffs, 4).map((x) => x.position).join(',') === '0,1,2,3');
  // 🚨 GEGENPROBE: eine Auswahl, die IMMER alles nimmt, wäre keine Schranke.
  check('🚨 Gegenprobe: Obergrenze 0 wählt nichts aus', waehleFuerLlm(diffs, 0).length === 0);
  check('Obergrenze über der Menge liefert alle', waehleFuerLlm(diffs, 99).length === 4);
  check('die Eingabeliste bleibt unverändert (keine Sortierung an Ort und Stelle)',
    diffs.map((x) => x.position).join(',') === '0,1,2,3');
}

console.log(`\n${gruen} gruen, ${rot} rot`);
process.exit(rot === 0 ? 0 : 1);
