#!/usr/bin/env node
/**
 * Prüfungen für die Pseudonymisierung der Maschinenwege (`services/pseudonym/maschine.ts`, Phase 6, Entscheid Thomas
 * 11.11.2026): Channel-Fassung, Wortstellung, Anrede/Großschreibung und Terminologie-Scan schicken Freitext nur noch verdeckt.
 *
 *   npm run build:server && node scripts/pseudonym-maschine.test.mjs
 *
 * Sprachmodell und Schutzeinstellungen sind Attrappen; gezählt wird, was hinausgeht und wie oft gerufen wird.
 */
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'PLATZHALTER_NUR_FUER_DEN_IMPORT';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist');
const MODUL = join(DIST, 'services', 'pseudonym', 'maschine.js');
if (!existsSync(MODUL)) { console.error(`Fehlt: ${MODUL} — vorher npm run build:server`); process.exit(1); }
const { callLlmGeschuetzt } = await import(pathToFileURL(MODUL).href);

let fehler = 0;
function pruefe(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { fehler++; console.log(`  FEHL ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const quelle = { laden: async () => ({ aus: [], liste: [{ begriff: 'Brennhofer Bau', art: 'FIRMA' }], artikelnummer: null }) };
const kaputt = { laden: async () => { throw new Error('DB weg'); } };
/** Attrappe: antwortet mit `antwort(user)` und merkt sich, was hinausging. */
function modell(antwort) {
  const f = async (system, user) => { f.aufrufe.push({ system, user }); return { text: antwort(user), model: 'attrappe', inputTokens: 1, outputTokens: 1, latencyMs: 0, costUsd: 0, usedFallback: false }; };
  f.aufrufe = [];
  return f;
}
const fehlerCode = (p) => p.then(() => null, (e) => e.code ?? e.message);
const TEXT = 'Bitte an Herrn Karl Probst (karl.probst@beispiel.at, +43 664 1234567) von Brennhofer Bau: LED-Leiste 24V liefern.';

console.log('\n(1) Verdecken und zurücksetzen');
let m = modell((u) => u.replace('liefern', 'zustellen'));
let r = await callLlmGeschuetzt('Schreibe um.', TEXT, { quelle, llm: m });
const raus = m.aufrufe[0]?.user ?? '';
pruefe('Name, Mail, Telefon, Firma gehen nicht hinaus', !/Probst|karl\.probst|1234567|Brennhofer/.test(raus), raus);
pruefe('Platzhalter gehen hinaus', /\[PERSON_1\]/.test(raus) && /\[EMAIL_1\]/.test(raus), raus);
pruefe('Hinweis zu Platzhaltern in der Anweisung', m.aufrufe[0]?.system.length > 'Schreibe um.'.length);
pruefe('Antwort mit echten Werten zurück', r.text.includes('Karl Probst') && r.text.includes('karl.probst@beispiel.at') && r.text.includes('zustellen'), r.text);
pruefe('Platzhalter gezählt', r.platzhalter >= 4, r.platzhalter);

console.log('\n(2) Nichts geht hinaus');
m = modell((u) => u);
pruefe('Platzhalter schon im Text', (await fehlerCode(callLlmGeschuetzt('S', 'Hallo [PERSON_1]', { quelle, llm: m }))) === 'PLATZHALTER_IM_TEXT' && m.aufrufe.length === 0);
m = modell((u) => u);
pruefe('Einstellungen nicht lesbar', (await fehlerCode(callLlmGeschuetzt('S', TEXT, { quelle: kaputt, llm: m }))) === 'EINSTELLUNGEN' && m.aufrufe.length === 0);
m = modell((u) => u);
pruefe('verdeckter Wert in der Anweisung (Marke/Begriff)',
  (await fehlerCode(callLlmGeschuetzt('Marken: Probst', TEXT, { quelle, llm: m, veraenderlich: 'Probst' }))) === 'WERT_IN_ANWEISUNG' && m.aufrufe.length === 0);

console.log('\n(3) Antwort verworfen');
pruefe('[REDACTED] vom Proxy', (await fehlerCode(callLlmGeschuetzt('S', TEXT, { quelle, llm: modell((u) => u.replace('[PERSON_1]', '[REDACTED]')) }))) === 'PROXY_GESCHWAERZT');
pruefe('erfundener Platzhalter', (await fehlerCode(callLlmGeschuetzt('S', TEXT, { quelle, llm: modell((u) => u + ' [PERSON_9]') }))) === 'PLATZHALTER_UNBEKANNT');
pruefe('fehlender Platzhalter', (await fehlerCode(callLlmGeschuetzt('S', TEXT, { quelle, llm: modell(() => 'LED-Leiste liefern.') }))) === 'PLATZHALTER_FEHLT');
r = await callLlmGeschuetzt('S', TEXT, { quelle, llm: modell(() => '[{"term":"LED-Leiste"}]'), fehlendErlaubt: true });
pruefe('fehlend erlaubt (Terminologie-Scan)', r.text === '[{"term":"LED-Leiste"}]' && r.fehlend > 0, r);

console.log('\n(4) Ohne Angaben');
m = modell((u) => u);
r = await callLlmGeschuetzt('Nur Anweisung', 'LED-Leiste 24V, 5 m, warmweiß', { quelle, llm: m });
pruefe('Text unverändert gesendet, Anweisung ohne Zusatz', m.aufrufe[0]?.user === 'LED-Leiste 24V, 5 m, warmweiß' && m.aufrufe[0]?.system === 'Nur Anweisung', m.aufrufe[0]);

console.log('\n(5) Die vier Wege rufen nur den geschützten Aufruf');
for (const datei of ['services/channel-fassung.js', 'routes/quick-translate.js', 'services/capitalization-llm.js', 'services/terminology-scan.js']) {
  const s = readFileSync(join(DIST, datei), 'utf8');
  pruefe(`${datei}: callLlmGeschuetzt, kein callLlm(`, s.includes('callLlmGeschuetzt)(') && !/llm_1\.callLlm\)\(/.test(s));
}

console.log(fehler === 0 ? '\nAlles grün.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
