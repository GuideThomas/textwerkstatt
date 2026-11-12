#!/usr/bin/env node
/**
 * Prüfungen für „Begriffe passend zum Text“ (`services/begriffe-im-text.ts`) und ihre Wirkung im Kürzen
 * (`condenseAufGrenze`, `condenseSegment`-Prompt) und in der Namensfassung.
 *
 *   npm run build:server && node scripts/begriffe-im-text.test.mjs
 *
 * ── DER ANLASS (11.11.2026, Thomas) ─────────────────────────────────────────
 * Das Kürzen bekam die ersten 100 Zielbegriffe des Glossars in alphabetischer Reihenfolge, unabhängig vom Text, und
 * niemand prüfte, ob ein Begriff danach noch dastand. Entscheid: nur die Begriffe, die im Text stehen, je Channel, und
 * danach hart prüfen. Das Sprachmodell ist hier eine Attrappe; geprüft wird, dass die Schranke eine schlechte Antwort
 * ABLEHNT und eine gute durchlässt, und was in der Anweisung steht. Ohne Datenbank (`ladeBegriffe` prüft der Lauf am VPS).
 */
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'PLATZHALTER_NUR_FUER_DEN_IMPORT';

const __dirname = dirname(fileURLToPath(import.meta.url));
const laden = async (...teile) => {
  const p = join(__dirname, '..', 'dist', ...teile);
  if (!existsSync(p)) { console.error(`Fehlt: ${p} — vorher npm run build:server`); process.exit(1); }
  return import(pathToFileURL(p).href);
};
const B = await laden('services', 'begriffe-im-text.js');
const { condenseAufGrenze, buildCondensingPrompt } = await laden('services', 'condensing.js');
const { namensfassung, buildNamensfassungPrompt, passendeBegriffe } = await laden('services', 'namensfassung.js');

let fehler = 0;
function pruefe(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { fehler++; console.log(`  FEHL ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Attrappe: liefert die Antworten der Reihe nach und merkt sich die Prompts. */
function modell(...antworten) {
  const f = async (system, user) => {
    f.prompts.push({ system, user });
    const text = antworten[Math.min(f.prompts.length - 1, antworten.length - 1)];
    return { text, model: 'attrappe', inputTokens: 1, outputTokens: 1, latencyMs: 0, costUsd: 0, usedFallback: false };
  };
  f.prompts = [];
  return f;
}

// Ein Glossar wie im Bestand: viele Einträge, alphabetisch weit vor den passenden.
const GLOSSAR = [
  ...Array.from({ length: 150 }, (_, i) => ({ deutsch: `Aaa${i}wort`, ziel: `aaa${i}parola` })),
  { deutsch: 'Einbaustrahler', ziel: 'faretto da incasso' },
  { deutsch: 'Strahler', ziel: 'faretto' },
  { deutsch: 'Deckenleuchte', ziel: 'plafoniera' },
  { deutsch: 'Netzteil', ziel: 'alimentatore' },
  { deutsch: 'LED', ziel: 'LED' },
  { deutsch: 'IP', ziel: 'IP' },
];

console.log('\n(1) Treffer');
const de = 'LED Einbaustrahler BACK45, rund, 5W, dimmbar';
const it = 'Faretto da incasso LED BACK45, rotondo, 5W, dimmerabile';
const p = B.begriffeImText(de, it, GLOSSAR);
pruefe('nur der passende Begriff, nicht die alphabetisch ersten', p.length === 2 && p.some((x) => x.ziel === 'faretto da incasso'),
  JSON.stringify(p));
pruefe('der kürzere „Strahler“ in „Einbaustrahler“ zählt nicht extra', !p.some((x) => x.deutsch === 'Strahler'), JSON.stringify(p));
pruefe('„LED“ mit 3 Zeichen zählt, „IP“ mit 2 nicht', p.some((x) => x.ziel === 'LED') && !p.some((x) => x.ziel === 'IP'));
pruefe('kein Paar, wenn der Zielbegriff nicht in der Übersetzung steht (DeepL wich ab)',
  B.begriffeImText('Deckenleuchte rund', 'Lampada da soffitto rotonda', GLOSSAR).length === 0);
pruefe('Beugung rechts: „Netzteile“ trifft „Netzteil“',
  B.begriffeImText('Netzteile 24V', 'alimentatore 24V', GLOSSAR).some((x) => x.ziel === 'alimentatore'));
// Grenze, bewusst: Ändert die Beugung das Ende des Zielbegriffs („alimentatori“), steht er nicht wörtlich da, und das Paar
// gilt nicht. Dann gibt es keine Vorgabe statt einer, die das Modell zu einer falschen Form drängt.
pruefe('Grenze: Plural mit anderem Ende im Ziel → kein Paar',
  B.begriffeImText('Netzteile 24V', 'alimentatori 24V', GLOSSAR).length === 0);
pruefe('links Wortgrenze: „Steckernetzteil“ trifft „Netzteil“ nicht',
  B.begriffeImText('Steckernetzteil 24V', 'alimentatore a spina 24V', GLOSSAR).length === 0);
pruefe('links Bindestrich ist Grenze: „LED-Netzteil“ trifft',
  B.begriffeImText('LED-Netzteil 24V', 'alimentatore LED 24V', GLOSSAR).some((x) => x.ziel === 'alimentatore'));
{
  // Hier braucht es die Überlappungsregel: Nach dem Bindestrich ist „Netzteil“ eine Wortgrenze und träfe sonst mit.
  const g2 = [{ deutsch: 'LED-Netzteil', ziel: 'alimentatore LED' }, { deutsch: 'Netzteil', ziel: 'alimentatore' }, { deutsch: 'LED', ziel: 'LED' }];
  const u = B.begriffeImText('LED-Netzteil 24V', 'alimentatore LED 24V', g2);
  pruefe('Überlappung: nur der längere Begriff, nicht seine Teile', u.length === 1 && u[0].ziel === 'alimentatore LED', JSON.stringify(u));
}
pruefe('höchstens MAX_BEGRIFFE', B.begriffeImText(GLOSSAR.map((g) => g.deutsch).join(' '), GLOSSAR.map((g) => g.ziel).join(' '), GLOSSAR).length
  === B.MAX_BEGRIFFE);
pruefe('fehlendeBegriffe: groß/klein egal', B.fehlendeBegriffe('FARETTO DA INCASSO LED', p).length === 0);
pruefe('fehlendeBegriffe: abgekürzt fehlt', B.fehlendeBegriffe('Far. da inc. LED', p).includes('faretto da incasso'));
pruefe('Hinweis leer ohne Paar', B.begriffeHinweis([]) === '');

console.log('\n(2) Kürzen');
const pr = buildCondensingPrompt('IT', de, it, 40, p);
pruefe('Prompt nennt den passenden Begriff', pr.system.includes('„faretto da incasso“'));
pruefe('Prompt nennt keinen der alphabetisch ersten', !pr.system.includes('aaa0parola'));
pruefe('Prompt ohne Paare ohne Glossarzeile', !buildCondensingPrompt('IT', de, it, 40, []).system.includes('Glossar'));

const lang = 'Faretto da incasso LED BACK45 rotondo per controsoffitti in cartongesso';
const deLang = 'LED Einbaustrahler BACK45 rund für Gipskartondecken';
const gutErgebnis = 'Faretto da incasso LED BACK45 rotondo';
const schlecht = 'Faretto LED BACK45 rotondo cartongesso';
let m = modell(schlecht, gutErgebnis);
let g = await condenseAufGrenze({ sourceText: deLang, translatedText: lang, targetLang: 'IT', maxChars: 45, begriffe: GLOSSAR }, m);
pruefe('gestrichener Glossarbegriff → zweiter Versuch mit Hinweis', m.prompts.length === 2 && m.prompts[1].user.includes('Fachbegriffe'),
  m.prompts[1]?.user.slice(-200));
pruefe('zweiter Versuch mit Begriff wird genommen', g.status === 'condensed' && g.condensedText === gutErgebnis, JSON.stringify(g));
m = modell(schlecht, schlecht);
g = await condenseAufGrenze({ sourceText: deLang, translatedText: lang, targetLang: 'IT', maxChars: 45, begriffe: GLOSSAR }, m);
pruefe('beide ohne Begriff → nicht „condensed“', g.status !== 'condensed', JSON.stringify(g));
m = modell(schlecht);
g = await condenseAufGrenze({ sourceText: deLang, translatedText: lang, targetLang: 'IT', maxChars: 45 }, m);
pruefe('ohne Glossar bleibt das Kürzen wie bisher', g.status === 'condensed' && m.prompts.length === 1, JSON.stringify(g));

console.log('\n(2b) Produktwort am Anfang (Entscheid Thomas 12.11.2026)');
{
  const { produktwort, behaeltProduktwort } = await laden('services', 'condensing.js');
  pruefe('IT: „Faretto“', produktwort('Faretto da incasso LED BACK45 rotondo') === 'Faretto');
  pruefe('Kennungen übersprungen: „LED T5/T8 retrofit“ → „retrofit“', produktwort('LED T5/T8 retrofit circuit board 865') === 'retrofit');
  pruefe('Bindestrich: „LED-panel-készlet“ → „panel“', produktwort('LED-panel-készlet beleértve a trafót') === 'panel');
  pruefe('ES: „LED Back68“ verliert „Lámpara“', !behaeltProduktwort('Lámpara LED empotrable Back68', 'LED Back68'));
  pruefe('groß/klein egal', behaeltProduktwort('Faretto da incasso LED', 'faretto LED'));
  pruefe('ohne Produktwort keine Vorgabe', produktwort('LED 24V DC') === null && behaeltProduktwort('LED 24V DC', 'LED 24V'));
  const lang2 = 'Faretto da incasso LED BACK45 rotondo per controsoffitti in cartongesso';
  const ohneWort = 'incasso LED BACK45 rotondo cartongesso';
  const mitWort = 'Faretto da incasso LED BACK45 rotondo';
  let m2 = modell(ohneWort, mitWort);
  let g2 = await condenseAufGrenze({ sourceText: deLang, translatedText: lang2, targetLang: 'IT', maxChars: 45 }, m2);
  pruefe('Live-Fall: ohne Produktwort → zweiter Versuch, der mit Wort gewinnt', m2.prompts.length === 2 && g2.condensedText === mitWort
    && m2.prompts[1].user.includes('„Faretto“'), JSON.stringify(g2));
  m2 = modell(ohneWort, ohneWort);
  g2 = await condenseAufGrenze({ sourceText: deLang, translatedText: lang2, targetLang: 'IT', maxChars: 45 }, m2);
  pruefe('Live-Fall: beide ohne Produktwort → nicht „condensed“', g2.status !== 'condensed', JSON.stringify(g2));
}

console.log('\n(3) Namensfassung');
const auftrag = {
  deutsch: 'LED Einbaustrahler BACK45, rund, Einbaustrahler-Set', uebersetzung: 'Faretto da incasso LED BACK45, rotondo, set faretto da incasso',
  zielsprache: 'IT', wiederholt: ['faretto'], maxChars: 100, begriffe: GLOSSAR,
};
pruefe('passende Begriffe', passendeBegriffe(auftrag).length === 2, JSON.stringify(passendeBegriffe(auftrag)));
pruefe('Prompt nennt den Begriff', buildNamensfassungPrompt(auftrag).system.includes('„faretto da incasso“'));
let n = await namensfassung(auftrag, modell('Faretto da incasso LED BACK45, rotondo, set'));
pruefe('Begriff einmal erhalten → Text kommt zurück', n.text === 'Faretto da incasso LED BACK45, rotondo, set', JSON.stringify(n));
n = await namensfassung(auftrag, modell('Spot encastré LED BACK45, rotondo, set'));
pruefe('Begriff ersetzt → leerer Text, fehlender Begriff genannt', n.text === '' && n.fehlendeBegriffe?.includes('faretto da incasso'),
  JSON.stringify(n));
n = await namensfassung({ ...auftrag, begriffe: undefined }, modell('Spot encastré LED BACK45, rotondo, set'));
pruefe('ohne Glossar wie bisher', n.text === 'Spot encastré LED BACK45, rotondo, set');

console.log(fehler === 0 ? '\nAlles grün.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
