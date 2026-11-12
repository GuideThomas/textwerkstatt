#!/usr/bin/env node
/**
 * Prüfungen für den Schutz technischer Werte und die gezielte Cache-Entwertung.
 *
 *   npm run build:server && DB_PASSWORD=nur-zum-import node scripts/platzhalter-schutz.test.mjs
 *
 * `config.ts` bricht ohne die Variable ab, eine Datenbank braucht der Test nicht.
 *
 * ── DER ANLASS (04.11.2026, Thomas) ──────────────────────
 *
 * Artikelnamen verloren `IRC`, bekamen `UGR< 19` und `1 10V`, und jede Glossaränderung entwertete
 * das ganze Sprachpaar. Die Analyse steht im Artikelanlage-Assistenten unter
 * `docs/ANALYSE-Artikelnamen-Uebersetzung.md`, §2 U6 und U7. DeepL wird hier nicht aufgerufen.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

if (!process.env.DB_PASSWORD) {
  console.error('DB_PASSWORD muss für den Import gesetzt sein, siehe Kopfkommentar.');
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const pfad = (...t) => join(__dirname, '..', 'dist', ...t);
if (!existsSync(pfad('services', 'unit-protection.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const laden = async (...t) => {
  const m = await import(pathToFileURL(pfad(...t)).href);
  return m.default && !m.protectUnits && !m.staleMuster && !m.protectAcronymsWithGlossary ? m.default : m;
};
const unit = await laden('services', 'unit-protection.js');
const akronym = await laden('services', 'acronym-protection.js');
const condensing = await laden('services', 'condensing.js');
const glossaries = await laden('routes', 'glossaries.js');
const batch = await import(pathToFileURL(pfad('routes', 'batch-translate.js')).href);
const { protectUnits, restoreUnits, fehlendeWerte, zahlenVollstaendig, PLATZHALTER_REST, AKRONYM_KENNWERTE } = unit;
const { protectAcronymsWithGlossary, restoreAcronyms } = akronym;

let gruen = 0;
const pruefe = async (name, f) => {
  try {
    await f();
    gruen += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FEHLT ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};
const werte = (text, sprache = 'FR') => [...protectUnits(text, sprache).restoreMap.values()];

console.log('Schutz: zusammengesetzte Werte bleiben ein Token');
await pruefe('1-10V als ein Token', () => assert.ok(werte('LED Trafo, 1-10V dimmbar').includes('1-10V')));
await pruefe('0-30W als ein Token', () => assert.ok(werte('LED Trafo 24V DC, 0-30W, IP68').includes('0-30W')));
await pruefe('0,75-2,5mm² als ein Token', () => assert.ok(werte('Kabelverbinder 0,75-2,5mm², 16A').includes('0,75-2,5mm²')));
await pruefe('24V DC als ein Token', () => assert.ok(werte('LED Trafo 24V DC, 30W').includes('24V DC')));
await pruefe('12-24V DC als ein Token', () => assert.ok(werte('Dimmer, 12-24V DC 2x1.5A').includes('12-24V DC')));
await pruefe('24V/DC bleibt wörtlich', () => assert.ok(werte('LED Trafo 24V/DC, 30W').includes('24V/DC')));
await pruefe('UGR<19 als ein Token', () => assert.ok(werte('LED Panel UGR<19 4H/8H, 26W').includes('UGR<19')));
await pruefe('20°-55° als ein Token', () => assert.ok(werte('Strahler, 12W, 20°-55°, weiß').includes('20°-55°')));
await pruefe('Kabeltyp bleibt ganz', () => assert.ok(werte('Anschlussleitung, H05VV-F3G0,75mm², schwarz').includes('H05VV-F3G0,75mm²')));
await pruefe('Kein Treffer auf 75mm² hinter fremdem Komma', () => {
  assert.ok(!werte('Kabel F3G0,75mm² schwarz').includes('75mm²'));
});
await pruefe('130x25° und 900W wie bisher', () => {
  const w = werte('LED Flutlichtanlage 900W, 130x25°, 4 Module');
  assert.ok(w.includes('900W') && w.includes('130x25°'));
});
await pruefe('3-Phasen wird nicht zum Bereich', () => {
  assert.ok(protectUnits('3-Phasen Adapter, schwarz', 'FR').protectedText.startsWith('3-Phasen'));
});
await pruefe('EN: Dezimalpunkt im Bereich', () => assert.ok(werte('Kabel 0,75-2,5mm²', 'EN').includes('0.75-2.5mm²')));

console.log('Wiederherstellen und Prüfung danach');
await pruefe('Rundlauf ist verlustfrei', () => {
  const t = 'LED Trafo 24V DC, 0-30W, UGR<19, 1-10V dimmbar, IP68';
  const p = protectUnits(t, 'FR');
  const zurueck = restoreUnits(p.protectedText, p.restoreMap);
  assert.equal(zurueck, t);
  assert.deepEqual(fehlendeWerte(zurueck, p.restoreMap), []);
});
await pruefe('verlorener Platzhalter wird erkannt (Negativfall)', () => {
  const p = protectUnits('LED Trafo 24V DC, 30W', 'FR');
  const [erster] = p.restoreMap.keys();
  const ergebnis = restoreUnits(p.protectedText.replace(erster, ''), p.restoreMap);
  assert.equal(fehlendeWerte(ergebnis, p.restoreMap).length, 1);
});
await pruefe('veränderter Platzhalter wird trotzdem ersetzt', () => {
  const p = protectUnits('LED Trafo, 30W', 'FR');
  const zurueck = restoreUnits(p.protectedText.replace(/__/g, '_').toLowerCase(), p.restoreMap);
  assert.ok(zurueck.includes('30W'), zurueck);
  assert.ok(!PLATZHALTER_REST.test(zurueck), zurueck);
});
await pruefe('doppelter Wert: ein verlorener wird erkannt', () => {
  const m = new Map([['a', 'IP65'], ['b', 'IP65']]);
  assert.deepEqual(fehlendeWerte('Leuchte IP65', m), ['IP65']);
  assert.deepEqual(fehlendeWerte('IP65 und IP65', m), []);
});
await pruefe('Teilstring zählt nicht: 5m in 15m, 24V neben 24V DC', () => {
  assert.deepEqual(fehlendeWerte('Rolle 15m', new Map([['a', '5m']])), ['5m']);
  assert.deepEqual(fehlendeWerte('Trafo 24V DC', new Map([['a', '24V'], ['b', '24V DC']])), ['24V']);
  assert.deepEqual(fehlendeWerte('Trafo 24V DC, Ausgang 24V', new Map([['a', '24V'], ['b', '24V DC']])), []);
});
await pruefe('Dezimalkomma im Wert wird erkannt', () => {
  assert.deepEqual(fehlendeWerte('Band 0,75mm², rund', new Map([['a', '0,75mm²']])), []);
  assert.deepEqual(fehlendeWerte('Band 10,75mm²', new Map([['a', '0,75mm²']])), ['0,75mm²']);
});
await pruefe('Feld mit fehlendem Teil bleibt leer, sonst unverändert', () => {
  assert.equal(batch.feldAusTeilen(['a', '', 'c'], true), '');
  assert.equal(batch.feldAusTeilen(['a', 'c'], true), 'a | c');
  assert.equal(batch.feldAusTeilen(['a'], false), 'a');
  assert.equal(batch.feldAusTeilen([''], false), '');
});
await pruefe('Platzhalterrest wird erkannt', () => assert.ok(PLATZHALTER_REST.test('LED __ISOLPOL0__ Kabel')));
await pruefe('Zahlen vollständig: richtig und falsch', () => {
  assert.equal(zahlenVollstaendig('LED 900W, 130x25°, IP66', 'LED 900 W, 130x25 °, IP66'), true);
  assert.equal(zahlenVollstaendig('LED 900W, 130x25°, IP66', 'LED, IP66'), false);
  assert.equal(zahlenVollstaendig('2700|3000K', '2 700|3 000K'), true);
});

console.log('Akronym-Pass vor dem Einheiten-Schutz');
const glossar = [{ source_term: 'CRI', target_term: 'IRC' }];
await pruefe('CRI930 wird IRC930, auch mit Einheiten-Schutz', () => {
  const a = protectAcronymsWithGlossary('LED CRI930 Linear10 Flexband, 24V DC, 22W', glossar);
  const u = protectUnits(a.protectedText, 'FR');
  assert.ok(![...u.restoreMap.values()].includes('CRI930'), 'Einheiten-Schutz darf CRI930 nicht sehen');
  const zurueck = restoreAcronyms(restoreUnits(u.protectedText, u.restoreMap), a.restoreMap);
  assert.equal(zurueck, 'LED IRC930 Linear10 Flexband, 24V DC, 22W');
});
await pruefe('Liste enthält nur Kennwerte: Seriennamen wie COVER27 bleiben (Negativfall)', () => {
  assert.deepEqual(AKRONYM_KENNWERTE, ['CRI']);
  const volleListe = [{ source_term: 'COVER', target_term: 'OBÁLKA' }];
  const erlaubt = volleListe.filter((e) => AKRONYM_KENNWERTE.includes(e.source_term));
  assert.equal(protectAcronymsWithGlossary('Abdeckung COVER27', erlaubt).protectedText, 'Abdeckung COVER27');
  // Gegenprobe: Ohne die Liste entstünde genau der Fehler.
  const ungefiltert = protectAcronymsWithGlossary('Abdeckung COVER27', volleListe);
  assert.equal(restoreAcronyms(ungefiltert.protectedText, ungefiltert.restoreMap), 'Abdeckung OBÁLKA27');
});
await pruefe('ohne Glossareintrag bleibt CRI90', () => {
  const a = protectAcronymsWithGlossary('LED CRI90', []);
  const u = protectUnits(a.protectedText, 'IT');
  assert.equal(restoreAcronyms(restoreUnits(u.protectedText, u.restoreMap), a.restoreMap), 'LED CRI90');
});

console.log('Gezielte Entwertung');
await pruefe('Muster je Begriff, maskiert, ohne Dubletten und Leeres', () => {
  assert.deepEqual(glossaries.staleMuster(['Push', 'Push', ' ', '100%_x']), ['%Push%', '%100\\%\\_x%']);
});
await pruefe('ohne Begriff kein Muster', () => assert.deepEqual(glossaries.staleMuster([]), []));

console.log('Kürzung nennt den Grund, wenn das Modell ausfällt');
const budgetFehler = Object.assign(new Error('LLM-Budget erschöpft'), { kind: 'budget' });
const eingabe = { sourceText: 'LED Trafo, dimmbar', translatedText: 'x'.repeat(120), targetLang: 'FR', maxChars: 100 };
await pruefe('Budget-Sperre: manual_review mit grund=budget', async () => {
  const r = await condensing.condenseAufGrenze(eingabe, async () => { throw budgetFehler; });
  assert.equal(r.status, 'manual_review');
  assert.equal(r.grund, 'budget');
});
await pruefe('anderer Ausfall: grund=llm_fehler', async () => {
  const r = await condensing.condenseAufGrenze(eingabe, async () => { throw new Error('Zeitüberschreitung'); });
  assert.equal(r.grund, 'llm_fehler');
});
await pruefe('Modell antwortet: kein grund (Negativfall)', async () => {
  const r = await condensing.condenseAufGrenze(
    { sourceText: 'Lange Bezeichnung, dimmbar', translatedText: 'Longue designation tres longue, dimmable', targetLang: 'FR', maxChars: 35 },
    async () => ({ text: 'Longue designation, dimmable', inputTokens: 1, outputTokens: 1 }),
  );
  assert.equal(r.status, 'condensed');
  assert.equal(r.grund, undefined);
});

console.log(`\n${gruen} grün${process.exitCode ? ', mindestens eine Prüfung rot' : ''}`);
if (!process.exitCode) process.exit(0);
