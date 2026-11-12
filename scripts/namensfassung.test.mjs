#!/usr/bin/env node
/**
 * Prüfungen für die Namensfassung (`namensfassung`, `buildNamensfassungPrompt`).
 *
 *   npm run build:server && node scripts/namensfassung.test.mjs
 *
 * Der Dienst schreibt nur den Prompt und holt die Antwort; ob sie taugt, prüft der
 * Artikelanlage-Assistent (`namensFassung.ts`, dort die harten Schranken). Geprüft wird
 * hier, dass der Prompt die Aufgabe und die Schutzregeln trägt — und die Ausnahme
 * Gehäusefarbe + Lichtfarbe (Entscheid Thomas 29.10.2026).
 */
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'PLATZHALTER_NUR_FUER_DEN_IMPORT';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE = join(__dirname, '..', 'dist', 'services', 'namensfassung.js');
if (!existsSync(MODULE)) {
  console.error(`Fehlt: ${MODULE} — vorher npm run build:server`);
  process.exit(1);
}
const { namensfassung, buildNamensfassungPrompt } = await import(pathToFileURL(MODULE).href);

let fehler = 0;
function pruefe(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { fehler++; console.log(`  FEHL ${name}${detail ? ' — ' + detail : ''}`); }
}

const basis = {
  deutsch: 'LED Fluter 120Watt, warmweiß, anthrazit, IP65',
  uebersetzung: '120-watt LED floodlight, warm white, anthracite, IP65',
  zielsprache: 'EN',
  maxChars: 100,
};

console.log('\n(1) Kennung vorn');
const p1 = buildNamensfassungPrompt({ ...basis, kennungVorn: 'LED' });
pruefe('Aufgabe nennt die Kennung', p1.user.includes('mit „LED" beginnt'));
pruefe('nur umstellen, kein Wort ändern', p1.user.includes('KEIN Wort'));
pruefe('keine Wiederholungs-Aufgabe, wenn keine angefragt', !p1.user.includes('mehrfach'));

console.log('\n(2) Wiederholung');
const p2 = buildNamensfassungPrompt({
  ...basis, deutsch: 'GU5.3 Fassung mit Keramiksockel für G4/MR16 Leuchtmittel, 12-24V',
  uebersetzung: 'GU5.3 Socket with Ceramic Socket for G4/MR16 Illuminants, 12-24V', wiederholt: ['socket'],
});
pruefe('Aufgabe nennt das Wort', p2.user.includes('„socket"'));
pruefe('Ausnahme Gehäusefarbe + Lichtfarbe steht in den Regeln', p2.system.includes('keine Wiederholung'));
pruefe('Kommas, Zahlen, Dimmung, Lichtfarbe sind Regeln', ['Kommas', 'Zahlen', 'Dimmbarkeit', 'Lichtfarbe'].every((w) => p2.system.includes(w)));

console.log('\n(3) Antwort wird nur bereinigt, nicht geprüft');
const attrappe = (text) => async () => ({ text, model: 'x', inputTokens: 2, outputTokens: 3, latencyMs: 0, costUsd: 0, usedFallback: false });
const r = await namensfassung({ ...basis, kennungVorn: 'LED' }, attrappe('„LED floodlight 120-watt, warm white, anthracite, IP65"\n'));
pruefe('Anführungszeichen und Leerraum entfernt', r.text === 'LED floodlight 120-watt, warm white, anthracite, IP65', r.text);
pruefe('Tokens gezählt', r.tokens === 5);

console.log(fehler === 0 ? '\nAlles grün.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
