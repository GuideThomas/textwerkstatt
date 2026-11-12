#!/usr/bin/env node
/**
 * Prüfungen für das Kürzen auf eine harte Grenze (`condenseAufGrenze`, Route
 * `POST /api/condense` — Artikelnamen des Artikelanlage-Assistenten).
 *
 *   npm run build:server && node scripts/condense-grenze.test.mjs
 *
 * ── DER ANLASS (29.10.2026, Thomas) ─────────────────────────────────────────
 *
 * „Die Beistriche werden entfernt, und oft fällt am Ende ‚dimmbar' weg." Gezählt
 * an 4.627 gelieferten Namen: 581 ohne ein einziges Komma. Der Prompt verbot es,
 * die Route prüfte es nicht. Das Sprachmodell ist hier eine Attrappe mit
 * vorgegebenen Antworten — geprüft wird, ob die Schranke eine schlechte Antwort
 * ABLEHNT, und dass eine gute durchgeht.
 */
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

// config.ts bricht ohne DB_PASSWORD ab; die Prüfungen selbst brauchen keine DB
if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'PLATZHALTER_NUR_FUER_DEN_IMPORT';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE = join(__dirname, '..', 'dist', 'services', 'condensing.js');
if (!existsSync(MODULE)) {
  console.error(`Fehlt: ${MODULE} — vorher npm run build:server`);
  process.exit(1);
}
const { condenseAufGrenze, buildCondensingPrompt, fremdeWoerter } = await import(pathToFileURL(MODULE).href);

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

const DE = 'LED Panel-Set inkl. VG, 625x625 diffuse UGR<19, 50W, Rahmen silber, neutralweiß, 1-10V dimmbar';
const HU = 'LED-panel-készlet beleértve a trafót, 625x625 diffúz UGR<19, 50W, ezüst keret, semleges fehér, 1-10V dimmelhető';
const OHNE_KOMMA = 'LED-panel-készlet trafóval 625x625 diffúz UGR<19 50W ezüst keret semleges fehér 1-10V dimmelhető';
const GUT = 'LED-panel trafóval, 625x625 diffúz UGR<19, 50W, ezüst keret, semleges fehér, 1-10V dimmelhető';
const eingabe = { sourceText: DE, translatedText: HU, targetLang: 'HU', maxChars: 100 };

let fehler = 0;
function pruefe(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { fehler++; console.log(`  FEHL ${name}${detail ? ' — ' + detail : ''}`); }
}
const stille = console.warn;
console.warn = () => {};

console.log('\n(1) Eine gute Kürzung geht durch');
{
  const m = modell(GUT);
  const r = await condenseAufGrenze(eingabe, m);
  pruefe('condensed, ein Aufruf', r.status === 'condensed' && r.attempts === 1 && r.condensedText === GUT, JSON.stringify(r));
}

console.log('\n(2) 🚨 Kommas gestrichen → zweiter Versuch mit Hinweis');
{
  const m = modell(OHNE_KOMMA, GUT);
  const r = await condenseAufGrenze(eingabe, m);
  pruefe('der zweite Versuch gewinnt', r.status === 'condensed' && r.condensedText === GUT, JSON.stringify(r));
  pruefe('und der Hinweis nennt die Kommas', m.prompts[1]?.user.includes('Kommas entfernt'), m.prompts[1]?.user.slice(-200));
  pruefe('gleiche Ziellänge — es war ja nicht zu lang', m.prompts[1]?.user.includes('maximal 100 Zeichen'));
}

console.log('\n(3) 🚨 Beide Versuche ohne Kommas → NIE condensed, Original zurück');
{
  const m = modell(OHNE_KOMMA, OHNE_KOMMA);
  const r = await condenseAufGrenze(eingabe, m);
  pruefe('manual_review mit der Original-Übersetzung', r.status === 'manual_review' && r.condensedText === HU, JSON.stringify(r));
}

console.log('\n(4) Zu lang, aber mit Kommas → still_long (der Aufrufer kürzt)');
{
  const lang = HU.replace('beleértve a trafót', 'trafóval együtt');
  const m = modell(lang, lang);
  const r = await condenseAufGrenze(eingabe, m);
  pruefe('still_long mit dem kürzeren Text', r.status === 'still_long' && r.condensedText === lang, JSON.stringify(r));
  pruefe('zweiter Versuch 10 % strenger', m.prompts[1]?.user.includes('maximal 90 Zeichen'));
}

console.log('\n(5) Das Modell fällt aus → Original zurück');
{
  const r = await condenseAufGrenze(eingabe, async () => { throw new Error('weg'); });
  pruefe('manual_review', r.status === 'manual_review' && r.condensedText === HU);
}

console.log('\n(6) Der Prompt nennt Dimmbarkeit und Lichtfarbe');
{
  const p = buildCondensingPrompt('HU', DE, HU, 100, []);
  pruefe('„Dimmbarkeit … dürfen NIE wegfallen"', /Dimmbarkeit[^\n]*NIE wegfallen/.test(p.system), p.system);
  pruefe('„Lichtfarbe" steht in der Liste der Angaben am Ende', /ENDE des Textes \([^)]*Lichtfarbe/.test(p.system));
}

console.log('\n(7) 🚨 Wörter aus einer anderen Sprache (115173 PL, 03.11.2026)');
{
  const dePl = 'LED Panel Backlight Line 625 UGR<19 8H/8H, CRI90, 36W, neutralweiß, Push/DALI dimmbar';
  const pl = 'Backlight Line LED panel, UGR< 19, 8H/8H, CRI90, 36W, biały neutralny, z regulacją jasności za pomocą przycisku lub protokołu DALI';
  const mitDeutsch = 'Backlight Line LED panel, UGR<19, 8H/8H, CRI90, 36W, biały neutralny, Push/DALI dimmbar';
  const mitEnglisch = 'Backlight Line LED panel, UGR<19, 8H/8H, CRI90, 36W, biały neutralny, Push/DALI dimmable';
  const gut = 'Backlight Line LED panel, UGR<19, 8H/8H, CRI90, 36W, biały neutralny, z regulacją jasności DALI';
  const einPl = { sourceText: dePl, translatedText: pl, targetLang: 'PL', maxChars: 100 };

  const m1 = modell(mitDeutsch, gut);
  const r1 = await condenseAufGrenze(einPl, m1);
  pruefe('„dimmbar" → zweiter Versuch gewinnt', r1.status === 'condensed' && r1.condensedText === gut && r1.attempts === 2, JSON.stringify(r1));
  pruefe('der Hinweis nennt das Wort', m1.prompts[1]?.user.includes('dimmbar') && m1.prompts[1]?.user.includes('anderen Sprache'), m1.prompts[1]?.user.slice(-220));

  const m2 = modell(mitEnglisch, gut);
  const r2 = await condenseAufGrenze(einPl, m2);
  pruefe('„dimmable" in PL → zweiter Versuch gewinnt', r2.status === 'condensed' && r2.condensedText === gut, JSON.stringify(r2));

  const r3 = await condenseAufGrenze(einPl, modell(mitDeutsch, mitEnglisch));
  pruefe('🚨 beide Versuche fremd → nie condensed, Original zurück', r3.status === 'manual_review' && r3.condensedText === pl, JSON.stringify(r3));

  const enDe = 'LED Panel, 36W, DALI dimmbar';
  const en = 'LED panel with a very long description of the product and its properties for testing purposes, 36W, DALI dimmable by protocol';
  const enKurz = 'LED panel, 36W, DALI dimmable';
  const r4 = await condenseAufGrenze({ sourceText: enDe, translatedText: en, targetLang: 'EN', maxChars: 100 }, modell(enKurz));
  pruefe('Gegenprobe: „dimmable" in EN geht durch', r4.status === 'condensed' && r4.attempts === 1, JSON.stringify(r4));

  pruefe('Gegenprobe: „Alu" kürzt „aluminiowa"', fremdeWoerter('Endkappe Alu', 'Nasadka aluminiowa', 'Nasadka Alu', 'PL').length === 0);
  pruefe('Gegenprobe: Kennungen zählen nicht', fremdeWoerter('LED, Push/DALI dimmbar', 'Panel LED przez DALI', 'Panel LED Push/DALI', 'PL').length === 0);
  pruefe('Gegenprobe: auch ohne Schrägstrich', fremdeWoerter('LED, KNX dimmbar', 'Panel LED przez protokół', 'Panel LED KNX', 'PL').length === 0);

  const pPl = buildCondensingPrompt('PL', dePl, pl, 100, []);
  pruefe('🚨 Prompt PL: nennt das polnische Wort', pPl.system.includes('z regulacją jasności'));
  pruefe('🚨 Prompt PL: nennt „dimmable" nicht mehr', !pPl.system.includes('dimmable'), pPl.system);
  pruefe('Prompt: Quelltext nur zum Verständnis', /Übernimm KEIN Wort/.test(pPl.system));
  for (const [iso, name, wort] of [
    ['CZ', 'Tschechisch', 's možností stmívání'], ['SK', 'Slowakisch', 'stmievateľné'], ['HU', 'Ungarisch', 'dimmelhető'],
    ['IT', 'Italienisch', 'dimmerabile'], ['ES', 'Spanisch', 'regulable'], ['FR', 'Franzoesisch', 'dimmable'], ['EN', 'Englisch', 'dimmable'],
  ]) {
    const s = buildCondensingPrompt(iso, DE, HU, 100, []).system;
    pruefe(`Prompt ${iso}: „${name}" und „${wort}"`, s.includes(name) && s.includes(`„${wort}"`), s.slice(0, 200));
  }
}

console.warn = stille;
console.log(fehler === 0 ? '\nAlles grün.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
