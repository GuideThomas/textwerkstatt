#!/usr/bin/env node
/**
 * Prüfungen für die Modellwahl je Weg und das Ausweichmodell (`services/llm.ts`, Phase 6, Entscheid Thomas 11.11.2026).
 *
 *   npm run build:server && node scripts/llm-wege.test.mjs
 *
 * Gegen eine Attrappe von LiteLLM auf 127.0.0.1, die jeden Körper mitschreibt:
 *   - Artikelnamen (`callLlmNamen`) gehen an `gpt-5.6-luna`, ohne Temperatur (luna lehnt 0 mit HTTP 400 ab) und mit
 *     `extra_body.reasoning_effort = low`.
 *   - Alle anderen Wege (`callLlm`) gehen an das Hauptmodell mit Temperatur und ohne `extra_body`.
 *   - Fällt das Modell aus, weicht nur `callLlmNamen` aus; `callLlm` meldet den Fehler, das Ausweichmodell bleibt unberührt.
 *   - Ein Budgetfehler (429) weicht auch bei `callLlmNamen` nicht aus.
 */
import { createServer } from 'http';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const koerper = [];
let ausfall = new Set();
let budget = false;
const server = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    koerper.push(j);
    res.setHeader('Content-Type', 'application/json');
    if (budget) { res.statusCode = 429; res.end(JSON.stringify({ error: { message: 'ExceededBudget: max_budget reached' } })); return; }
    if (ausfall.has(j.model)) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'kaputt' } })); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: `Antwort von ${j.model}` } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

process.env.DB_PASSWORD ||= 'PLATZHALTER_NUR_FUER_DEN_IMPORT';
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.LLM_API_KEY = 'k-test';
process.env.LLM_PRIMARY_MODEL = 'haupt-test';
process.env.LLM_FALLBACK_MODEL = 'ausweich-test';
delete process.env.LLM_NAMEN_MODEL;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODUL = join(__dirname, '..', 'dist', 'services', 'llm.js');
if (!existsSync(MODUL)) { console.error(`Fehlt: ${MODUL} — vorher npm run build:server`); process.exit(1); }
const { callLlm, callLlmNamen, resetLlmBudgetLock } = await import(pathToFileURL(MODUL).href);

let fehler = 0;
function pruefe(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { fehler++; console.log(`  FEHL ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); }
}
const neu = () => { koerper.length = 0; ausfall = new Set(); budget = false; resetLlmBudgetLock(); };

console.log('\n(1) Modell und Parameter');
neu();
let r = await callLlmNamen('S', 'U');
pruefe('Namen → gpt-5.6-luna', koerper[0]?.model === 'gpt-5.6-luna', koerper[0]);
pruefe('luna ohne Temperatur', koerper[0] && !('temperature' in koerper[0]), koerper[0]);
pruefe('luna mit reasoning_effort low in extra_body', koerper[0]?.extra_body?.reasoning_effort === 'low', koerper[0]);
pruefe('no-cache bleibt', koerper[0]?.cache?.['no-cache'] === true);
pruefe('Ergebnis nennt das Modell', r.model === 'gpt-5.6-luna' && !r.usedFallback, r);
neu();
r = await callLlm('S', 'U');
pruefe('andere Wege → Hauptmodell', koerper[0]?.model === 'haupt-test', koerper[0]);
pruefe('Hauptmodell mit Temperatur', koerper[0]?.temperature === 0, koerper[0]);
pruefe('Hauptmodell ohne extra_body', koerper[0] && !('extra_body' in koerper[0]), koerper[0]);

console.log('\n(2) Ausweichen');
neu(); ausfall.add('haupt-test');
const e1 = await callLlm('S', 'U').then(() => null, (e) => e);
pruefe('andere Wege: Fehler statt Ausweichen', e1 && /kein Ausweichmodell/.test(e1.message), e1?.message);
pruefe('andere Wege: Ausweichmodell nicht gerufen', !koerper.some((k) => k.model === 'ausweich-test'), koerper.map((k) => k.model));
neu(); ausfall.add('gpt-5.6-luna');
r = await callLlmNamen('S', 'U').catch((e) => ({ fehler: e.message }));
pruefe('Namen: weicht aus', r.model === 'ausweich-test' && r.usedFallback === true, r);
// Der OpenAI-Client wiederholt 429 und 5xx selbst (maxRetries 2); gezählt wird deshalb nach Modell, nicht nach Stelle.
const ausweich = koerper.find((k) => k.model === 'ausweich-test');
pruefe('Namen: Ausweichmodell mit Temperatur (keine luna-Parameter)', ausweich?.temperature === 0 && !('extra_body' in (ausweich ?? {})), ausweich);
neu(); budget = true;
const e2 = await callLlmNamen('S', 'U').then(() => null, (e) => e);
pruefe('Budget: auch Namen weichen nicht aus', e2?.name === 'LlmTerminalError' && !koerper.some((k) => k.model === 'ausweich-test'),
  { modelle: koerper.map((k) => k.model), e: e2?.message });
resetLlmBudgetLock();

server.close();
console.log(fehler === 0 ? '\nAlles grün.' : `\n${fehler} Prüfung(en) fehlgeschlagen.`);
process.exit(fehler === 0 ? 0 : 1);
