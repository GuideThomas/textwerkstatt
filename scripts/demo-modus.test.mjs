#!/usr/bin/env node
/**
 * Prüfungen für `DEMO_MODUS` (`PLAN-oeffentlich-und-demo.md` Phase 2): Tor, Positivliste der Wege, Zeichengrenzen mit klarer
 * Meldung, Aufrufe je Minute, PDF eines zur Zeit, keine Mail, Hinweise in `/api/einstellungen`. Dazu die Gegenproben aus G4:
 * `DEMO_MODUS` fehlt → kein Tor, keine Sperre; `an` ohne Passwort oder ein unbekannter Wert → der Dienst startet nicht.
 *
 * Gegen eine Wegwerf-Postgres wie `scripts/glossar-freigabe.test.mjs`; das Skript setzt die Demo-Variablen selbst, mit kleinen
 * Grenzen. Kein Aufruf verlässt den Rechner: DeepL wird nur gefragt, wenn die Grenze schon erreicht ist (dann geht nichts hinaus),
 * die KI zeigt auf einen geschlossenen Port auf 127.0.0.1.
 *
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=<port> DB_NAME=translationtool_test DB_USER=translationtool node scripts/demo-modus.test.mjs
 *
 * 🚨 Der Lauf löscht das Schema `public`. Deshalb bricht er ab, wenn die Datenbank nicht auf `_test` endet oder nicht lokal liegt.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const istLokal = ['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '');
if (!process.env.DB_PASSWORD || !istLokal || !(process.env.DB_NAME ?? '').endsWith('_test')) {
  console.error('Abbruch: nur gegen eine lokale Datenbank mit Namen *_test und mit DB_PASSWORD aus der Umgebung, siehe Kopfkommentar.');
  process.exit(2);
}

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('demo', 'sperre.js'))) {
  console.error('dist fehlt oder ist alt: zuerst npm run build:server');
  process.exit(2);
}

// Gegenproben, die einen eigenen Prozess brauchen: Die Einstellungen werden einmal beim Laden gelesen.
const ohneDemo = Object.fromEntries(Object.entries(process.env).filter(
  ([k]) => !k.startsWith('DEMO_') && !['GLOSSAR_FREIGABE', 'CHAT_SERVICE_KEY'].includes(k)));
const kind = (env, code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: WURZEL, env: { ...ohneDemo, ...env }, encoding: 'utf-8' });

const PASSWORT = randomBytes(9).toString('base64url');
const UPLOADS = mkdtempSync(join(tmpdir(), 'tt-demo-'));
Object.assign(process.env, {
  DEMO_MODUS: 'an', DEMO_PASSWORT: PASSWORT, GLOSSAR_FREIGABE: 'alle',
  DEMO_DEEPL_ZEICHEN_TAG: '100', DEMO_DEEPL_ZEICHEN_JE_SITZUNG: '60',
  DEMO_KI_ZEICHEN_TAG: '1000', DEMO_KI_ZEICHEN_JE_SITZUNG: '50',
  DEMO_TOR_VERSUCHE_JE_STUNDE: '5', DEMO_TOR_ANMELDUNGEN_JE_STUNDE: '12', DEMO_AUFRUFE_JE_MINUTE: '80', DEMO_MAX_UPLOAD_MB: '2',
  // Erkennbar unecht; DeepL wird damit nie erreicht (siehe Kopf), die KI zeigt auf einen geschlossenen Port.
  DEEPL_API_KEY: 'nur-fuer-den-test:fx', LLM_API_KEY: 'nur-fuer-den-test', LLM_BASE_URL: 'http://127.0.0.1:9/v1',
  MAIL_FROM: 'probe@example.invalid', TRANSLATION_SERVICE_KEY: '', UPLOAD_DIR: UPLOADS,
  // Die Demo verweigert den Start mit Chat-Schlüssel; einer aus der Umgebung des Aufrufers darf den Lauf nicht kippen.
  CHAT_SERVICE_KEY: '',
});

// Schranke statt Versprechen: Ein Aufruf, der den Rechner verlassen würde (etwa DeepL, wenn ein Zähler fehlt), scheitert hier.
const echtesFetch = globalThis.fetch;
const nachAussen = [];
globalThis.fetch = (url, opt) => {
  const ziel = new URL(typeof url === 'string' ? url : url.url);
  if (ziel.hostname !== '127.0.0.1') {
    nachAussen.push(ziel.host);
    return Promise.reject(new Error(`Testsperre: Aufruf nach außen (${ziel.host})`));
  }
  return echtesFetch(url, opt);
};

const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};
const router = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.default ?? m.default;
};

const { pool } = await laden('db', 'connection.js');
const { config } = await laden('config.js');
const q = (sql, p) => pool.query(sql, p);
const db = (await q('SELECT current_database() AS n')).rows[0].n;
assert.ok(db.endsWith('_test'), 'falsche Datenbank');
const fremde = (await q(
  `SELECT count(*)::int AS n FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1', current_database())`,
)).rows[0].n;
if (fremde > 0) {
  console.error(`Abbruch: Der Server hat ${fremde} weitere Datenbank(en), das ist kein eigener Wegwerf-Server.`);
  process.exit(2);
}
await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of readdirSync(join(WURZEL, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
  await q(readFileSync(join(WURZEL, 'migrations', f), 'utf-8'));
}
await q(readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8'));

const { demoSperre, demoOffen } = await laden('demo', 'sperre.js');
const grenzen = await laden('demo', 'grenzen.js');
const { requireAuth } = await laden('middleware', 'auth.js');

// Die App wie in `server.ts`: Sitzung, Sperre, Zähler, Tor, Anmeldung, dann die Wege.
const express = require('express');
const session = require('express-session');
const app = express();
app.use(express.json());
app.use(session({ secret: randomBytes(16).toString('hex'), resave: false, saveUninitialized: false }));
app.use(demoSperre);
app.use(grenzen.demoAnfrage);
app.use('/api/auth', await router('demo', 'tor.js'));
app.use('/api/auth', await router('routes', 'auth.js'));
app.use('/api', await router('routes', 'einstellungen.js'));
app.use('/api/glossaries', requireAuth, await router('routes', 'glossaries.js'));
app.use('/api/upload', requireAuth, await router('routes', 'upload.js'));
app.use('/api/quick-translate', requireAuth, await router('routes', 'quick-translate.js'));
// Ein Weg wie die echten: fängt jeden Fehler und schickt ein allgemeines 500. Die Demo muss daraus die Grenze machen.
const { translateText } = await laden('services', 'deepl.js');
app.post('/api/projects/probe-grenze', requireAuth, async (_req, res) => {
  try {
    await translateText('Ein Satz zum Übersetzen', 'DE', 'EN');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Übersetzung fehlgeschlagen' });
  }
});
// Hinter der Sperre: Erreicht ein Aufruf das hier, hat die Sperre ihn durchgelassen.
app.use((req, res) => res.status(418).json({ durchgelassen: req.path }));
const server = app.listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const BASIS = `http://127.0.0.1:${server.address().port}`;

async function api(methode, pfad, body, cookie, kopf = {}) {
  const istForm = body instanceof FormData;
  const r = await fetch(BASIS + pfad, {
    method: methode,
    headers: { ...(istForm || !body ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...kopf },
    body: istForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, body: json ?? text, cookie: r.headers.get('set-cookie')?.split(';')[0] ?? null };
}

let ok = 0;
const fehler = [];
async function pruefe(name, f) {
  try {
    await f();
    ok += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fehler.push(name);
    console.log(`  ✗ ${name}\n    ${String(err?.message ?? err).split('\n').join('\n    ')}`);
  }
}

console.log('Demo-Modus (PLAN-oeffentlich-und-demo.md Phase 2)');

// ── G4: Start und Schalter ────────────────────────────────────────────────────────────────────────────────────────────────────

await pruefe('Gegenprobe: an ohne Passwort, unbekannter Wert, kaputte Zahl → der Dienst startet nicht (server.js bricht ab)', async () => {
  for (const [env, grund] of [
    [{ DEMO_MODUS: 'an' }, 'verlangt DEMO_PASSWORT'],
    [{ DEMO_MODUS: 'an', DEMO_PASSWORT: '   ' }, 'verlangt DEMO_PASSWORT'],
    [{ DEMO_MODUS: 'ja', DEMO_PASSWORT: 'x' }, 'unbekannt'],
    [{ DEMO_MODUS: 'an', DEMO_PASSWORT: 'x', DEMO_DEEPL_ZEICHEN_TAG: 'viel' }, 'keine ganze Zahl'],
    [{ DEMO_MODUS: 'an', DEMO_PASSWORT: 'x', CHAT_SERVICE_KEY: 'irgendwas' }, 'verträgt keinen CHAT_SERVICE_KEY'],
  ]) {
    const r = spawnSync(process.execPath, [dist('server.js')], { cwd: WURZEL, env: { ...ohneDemo, ...env }, encoding: 'utf-8', timeout: 20000 });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.ok((r.stderr + r.stdout).includes(grund), `${JSON.stringify(env)}: ${r.stderr.slice(0, 300)}`);
    // Startzeile seit 12.11.2026 „<Name> running on <Adresse>:<Port>“ — vorher „… running on port …“; das alte Suchwort hätte nie mehr getroffen
    assert.ok(!(r.stdout ?? '').includes('running on '), 'der Dienst lief an');
  }
});

await pruefe('Schalter: leer, fehlend und „aus“ heißen keine Demo; „AN“ mit Passwort heißt Demo', async () => {
  const code = `const { demoEinstellungen } = await import(${JSON.stringify(pathToFileURL(dist('config.js')).href)}).then((m) => m.default ?? m);
    console.log(JSON.stringify([{}, { DEMO_MODUS: '' }, { DEMO_MODUS: 'aus' }, { DEMO_MODUS: ' AN ', DEMO_PASSWORT: 'p' }].map((e) => demoEinstellungen(e).an)));`;
  const r = kind({}, code);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '[false,false,false,true]');
});

await pruefe('Ohne Demo: ein liegengebliebener kaputter DEMO_*-Wert hindert die Produktion nicht; MAX_FILE_SIZE_MB ohne Zahl heißt 100', async () => {
  const code = `const m = await import(${JSON.stringify(pathToFileURL(dist('config.js')).href)}).then((x) => x.default ?? x);
    console.log(JSON.stringify([m.config.demo.an, m.config.upload.maxFileSizeMb]));`;
  const r = kind({ DEMO_DEEPL_ZEICHEN_TAG: 'viel', MAX_FILE_SIZE_MB: 'abc' }, code);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '[false,100]');
});

await pruefe('Gegenprobe ohne DEMO_MODUS: Tor 404, Sperre lässt alles durch, Einstellungen ohne Demo, Zähler buchen nichts', async () => {
  const code = `
    const lade = async (...t) => { const m = await import(new URL('dist/' + t.join('/'), ${JSON.stringify(pathToFileURL(WURZEL + '/').href)}).href); return m.default?.default ?? m.default ?? m; };
    const express = (await import('express')).default;
    const app = express(); app.use(express.json());
    const { demoSperre } = await import(new URL('dist/demo/sperre.js', ${JSON.stringify(pathToFileURL(WURZEL + '/').href)}).href).then((m) => m.default ?? m);
    const g = await import(new URL('dist/demo/grenzen.js', ${JSON.stringify(pathToFileURL(WURZEL + '/').href)}).href).then((m) => m.default ?? m);
    app.use(demoSperre); app.use(g.demoAnfrage);
    app.use('/api/auth', await lade('demo', 'tor.js'));
    app.use('/api', await lade('routes', 'einstellungen.js'));
    app.use((req, res) => res.status(418).end());
    const s = app.listen(0, '127.0.0.1'); await new Promise((ok) => s.once('listening', ok));
    const b = 'http://127.0.0.1:' + s.address().port;
    const tor = (await fetch(b + '/api/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passwort: '' }) })).status;
    const cep = (await fetch(b + '/api/cep/translate', { method: 'POST' })).status;
    const e = await (await fetch(b + '/api/einstellungen')).json();
    await g.verbrauche('deepl', 10 ** 9);
    const { pool } = await lade('db', 'connection.js');
    const n = (await pool.query('SELECT count(*)::int AS n FROM demo_verbrauch')).rows[0].n;
    console.log(JSON.stringify({ tor, cep, demo: e.demo, freigabe: e.glossarFreigabe, n, pdf: g.pdfBelegt() }));
    s.close(); await pool.end();`;
  const r = kind({}, code);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { tor: 404, cep: 418, demo: null, freigabe: 'admin', n: 0, pdf: false });
});

// ── Tor ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

let GAST = null;
await pruefe('Tor: falsches und leeres Passwort 401 ohne Sitzung; richtiges öffnet eine Gastsitzung (Rolle user, Cloud-KI frei)', async () => {
  for (const passwort of ['falsch', '', PASSWORT + ' ']) {
    const r = await api('POST', '/api/auth/demo', { passwort, name: 'Probe' });
    assert.equal(r.status, 401, passwort);
    assert.equal((await api('GET', '/api/auth/me', null, r.cookie)).status, 401);
  }
  const r = await api('POST', '/api/auth/demo', { passwort: PASSWORT, name: '  Erika <b>Probe</b>\u0007 ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.cookie);
  GAST = r.cookie;
  const me = await api('GET', '/api/auth/me', null, GAST);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.user.role, 'user');
  const u = (await q(`SELECT email, display_name, darf_cloud_ki, role FROM users WHERE id = $1`, [me.body.user.id])).rows[0];
  assert.match(u.email, /^gast-[0-9a-f]{12}@demo\.invalid$/);
  assert.deepEqual([u.display_name, u.darf_cloud_ki, u.role], ['Erika bProbe/b', true, 'user']);
  assert.ok(!JSON.stringify(r.body).includes(PASSWORT), 'das Passwort steht in der Antwort');
});

await pruefe('Tor: gezählt werden nur Fehlversuche — richtige Anmeldungen sperren niemanden aus; nach 5 falschen 429, auch mit dem richtigen Passwort', async () => {
  // Ein Saal hinter einer Adresse: mehr richtige Anmeldungen als die Grenze (5), alle kommen durch. Bis 13.11.2026 zählte jede mit.
  for (let i = 1; i <= 7; i += 1) {
    assert.equal((await api('POST', '/api/auth/demo', { passwort: PASSWORT })).status, 200, `richtige Anmeldung ${i}`);
  }
  // Wer schon Gast ist, bleibt derselbe Gast: kein zweiter Nutzer, kein frisches Kontingent je Sitzung.
  const nutzer = async () => (await q(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
  const vorher = await nutzer();
  const ich = (await api('GET', '/api/auth/me', null, GAST)).body.user.id;
  const nochmal = await api('POST', '/api/auth/demo', { passwort: PASSWORT, name: 'Anderer Name' }, GAST);
  assert.equal(nochmal.status, 200, JSON.stringify(nochmal.body));
  assert.equal(nochmal.body.user.id, ich, 'eine zweite Anmeldung in derselben Sitzung hat einen neuen Gast angelegt');
  assert.equal(await nutzer(), vorher);
  // Auch richtige Anmeldungen sind begrenzt (hier 12 je Adresse und Stunde; 8 stehen schon): vier gehen noch, die 13. nicht.
  for (let i = 9; i <= 12; i += 1) {
    assert.equal((await api('POST', '/api/auth/demo', { passwort: PASSWORT })).status, 200, `richtige Anmeldung ${i}`);
  }
  const zuViele = await api('POST', '/api/auth/demo', { passwort: PASSWORT });
  assert.equal(zuViele.status, 429, JSON.stringify(zuViele.body));
  assert.match(zuViele.body.error, /sehr viele Gäste/);
  assert.equal(await nutzer(), vorher + 4, 'eine abgewiesene Anmeldung hat einen Gast angelegt');
  // Drei falsche stehen schon (oben); der vierte und fünfte gehen noch mit 401 durch, danach ist zu.
  assert.equal((await api('POST', '/api/auth/demo', { passwort: 'falsch' })).status, 401);
  assert.equal((await api('POST', '/api/auth/demo', { passwort: 'falsch' })).status, 401);
  const r = await api('POST', '/api/auth/demo', { passwort: PASSWORT });
  assert.equal(r.status, 429, JSON.stringify(r.body));
  assert.equal(r.body.code, 'demo_grenze');
});

// ── Positivliste ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

await pruefe('Sperre: Verwaltung, Anmeldung, SSO, Panel, Maschinen-Routen, Referenz-Homepage, Mail-Wege 403 — auch in anderer Schreibweise', async () => {
  for (const [m, p] of [
    ['POST', '/api/auth/login'], ['GET', '/api/auth/microsoft/login'], ['GET', '/api/auth/microsoft/callback'],
    ['POST', '/api/batch-translate'], ['POST', '/api/condense'], ['POST', '/api/uebersetzung-pruefung'], ['POST', '/api/channel-fassung'],
    ['POST', '/api/namensfassung'], ['GET', '/api/namens-bausteine'], ['POST', '/api/cep/translate'], ['GET', '/api/panel/verbindungen'],
    ['GET', '/api/users'], ['PUT', '/api/users/1/cloud-ki'], ['GET', '/api/dashboard/costs'],
    ['GET', '/api/textwerkstatt/ki-wege'], ['POST', '/api/textwerkstatt/ki-wege'], ['GET', '/api/textwerkstatt/schutz'],
    ['POST', '/api/textwerkstatt/arten'], ['GET', '/api/textwerkstatt/stilprofile/alle'], ['POST', '/api/textwerkstatt/stilprofile/quelle'],
    ['POST', '/api/textwerkstatt/stilprofile/ableiten'], ['POST', '/api/native-speakers/request-review'], ['POST', '/api/native-speakers'],
    ['POST', '/api/topics'], ['GET', '/api/gibt-es-noch-nicht'], ['POST', '/API/cep/translate'], ['GET', '/Api/Users'],
    ['GET', '/api/glossaries/deepl-usage'],
    // Express ordnet ohne Rücksicht auf Schreibweise und Schrägstrich am Ende zu: Die Ausnahme muss genauso lesen (13.11.2026).
    ['GET', '/api/glossaries/DEEPL-USAGE'], ['GET', '/api/glossaries/deepl-usage/'], ['GET', '/api/glossaries//deepl-usage'],
  ]) {
    const r = await api(m, p, m === 'GET' ? null : {}, GAST);
    assert.equal(r.status, 403, `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'demo_gesperrt', `${m} ${p}`);
  }
});

await pruefe('Sperre, Gegenprobe: die Wege eines Testers kommen durch (Glossar 200, sonst bis hinter die Sperre)', async () => {
  assert.equal((await api('GET', '/api/glossaries', null, GAST)).status, 200);
  for (const [m, p] of [
    ['GET', '/api/projects'], ['POST', '/api/quick-translate'], ['POST', '/api/languagetool/check'], ['GET', '/api/house-terms'],
    ['GET', '/api/terminology'], ['GET', '/api/topics'], ['GET', '/api/textwerkstatt/stilprofile'], ['POST', '/api/textwerkstatt/optimieren'],
    ['POST', '/api/textwerkstatt/optimieren/kombination'], ['GET', '/api/users/list'], ['GET', '/api/native-speakers'],
  ]) {
    const r = await api(m, p, m === 'GET' ? null : {}, GAST);
    // 418 = hinter der Sperre angekommen; eingehängte echte Router (quick-translate) antworten selbst, etwa mit 400.
    assert.ok(r.status !== 403 && r.body?.code !== 'demo_gesperrt', `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  // Die Oberfläche (kein /api) bleibt offen.
  assert.equal((await api('GET', '/textwerkstatt', null, GAST)).status, 418);
  assert.equal(demoOffen('GET', '/api/textwerkstatt/stilprofile'), true);
  assert.equal(demoOffen('POST', '/api/textwerkstatt/stilprofile'), false);
});

// ── Zeichengrenzen ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const verbrauch = async (art, wer) => Number((await q(
  `SELECT coalesce(sum(zeichen), 0) AS n FROM demo_verbrauch WHERE art = $1 AND wer = $2`, [art, wer])).rows[0].n);

await pruefe('Zähler: je Sitzung 60, Demo gesamt 100; was eine Grenze reißt, wird nicht gebucht', async () => {
  const lauf = (wer, n) => grenzen.demoKontext.run({ wer }, () => grenzen.verbrauche('deepl', n));
  await lauf('A', 50);
  await assert.rejects(lauf('A', 20), { name: 'DemoGrenzeErreicht' });
  assert.deepEqual([await verbrauch('deepl', 'A'), await verbrauch('deepl', '')], [50, 50]);
  await lauf('B', 50);
  await assert.rejects(lauf('B', 1), (e) => e.name === 'DemoGrenzeErreicht' && /Demo hat ihr Tageskontingent/.test(e.message));
  // Außerhalb einer Anfrage (Warteschlange) zählt nur die Summe, und die ist voll.
  await assert.rejects(grenzen.verbrauche('deepl', 1), { name: 'DemoGrenzeErreicht' });
  assert.deepEqual([await verbrauch('deepl', 'B'), await verbrauch('deepl', '')], [50, 100]);
  // Gegenprobe: die KI hat ihre eigenen Zähler.
  await lauf('A', 0);
  await grenzen.demoKontext.run({ wer: 'A' }, () => grenzen.verbrauche('ki', 40));
  assert.equal(await verbrauch('ki', 'A'), 40);
});

await pruefe('Zähler sitzen in DeepL und KI: an der Grenze geht nichts hinaus (DemoGrenzeErreicht vor jedem Netzaufruf)', async () => {
  const deepl = await laden('services', 'deepl.js');
  await assert.rejects(deepl.translateText('Hallo', 'DE', 'EN'), { name: 'DemoGrenzeErreicht' });
  await assert.rejects(deepl.translateBatch(['Hallo', 'Welt'], { sourceLang: 'DE', targetLang: 'EN' }), { name: 'DemoGrenzeErreicht' });
  const { callLlm } = await laden('services', 'llm.js');
  // Unter der Grenze (A hat 40 von 50): der Aufruf geht los und scheitert am geschlossenen Port, nicht an der Grenze.
  await assert.rejects(grenzen.demoKontext.run({ wer: 'A' }, () => callLlm('System', 'kurz')), (e) => e.name !== 'DemoGrenzeErreicht');
  await assert.rejects(grenzen.demoKontext.run({ wer: 'A' }, () => callLlm('System', 'x'.repeat(30))), { name: 'DemoGrenzeErreicht' });
  // `kiAufrufen` braucht einen eingerichteten KI-Weg; hier nur, dass der Zähler im ausgelieferten Code vor dem Aufruf steht.
  const ki = readFileSync(dist('services', 'ki-weg.js'), 'utf-8');
  const stelle = ki.indexOf("verbrauche)('ki', eingabe.text.length)");
  assert.ok(stelle > 0 && stelle < ki.indexOf('client.create(', stelle), 'Zähler in kiAufrufen fehlt oder steht hinter dem Aufruf');
});

await pruefe('Meldung: ein Weg, der den Fehler fängt und 500 schickt, antwortet an der Grenze mit 429 und dem Grund', async () => {
  const r = await api('POST', '/api/projects/probe-grenze', {}, GAST);
  assert.equal(r.status, 429, JSON.stringify(r.body));
  assert.equal(r.body.code, 'demo_grenze');
  assert.match(r.body.error, /Tageskontingent für Übersetzung \(DeepL\)/);
});

await pruefe('Alternativen (roher DeepL-Aufruf neben deepl.ts) zählen mit: an der Grenze 429, nichts geht hinaus', async () => {
  const r = await api('POST', '/api/quick-translate/alternatives', { text: 'Ein Satz', sourceLang: 'DE', targetLang: 'EN', useGlossary: false }, GAST);
  assert.equal(r.status, 429, JSON.stringify(r.body));
  assert.equal(r.body.code, 'demo_grenze');
  assert.deepEqual(nachAussen, []);
});

await pruefe('Eigene Projekte: Liste, Lesen, Löschen, Sammellöschen und neue Fassung nur am eigenen; fremde sind 404', async () => {
  const { demoEigeneProjekte } = await laden('demo', 'eigene.js');
  const [A, B] = ['a1b2c3d4-0000-4000-8000-0000000000d1', 'a1b2c3d4-0000-4000-8000-0000000000d2'];
  for (const [id, n] of [[A, 'a'], [B, 'b']]) {
    await q(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, 'user')`, [id, `gast-${n}@demo.invalid`, `Gast ${n}`]);
  }
  const neu = async (wer, name) => (await q(
    `INSERT INTO projects (name, source_lang, target_lang, file_type, created_by) VALUES ($1, 'DE', 'EN', 'txt', $2) RETURNING id`, [name, wer])).rows[0].id;
  const [pa, pa2, pb] = [await neu(A, 'von A'), await neu(A, 'auch von A'), await neu(B, 'von B')];
  const app3 = express();
  app3.use(express.json());
  app3.use((req, _res, next) => { const wer = req.header('x-gast'); req.session = { userId: wer }; req.user = { id: wer, role: 'user' }; next(); });
  app3.use('/api/projects', demoEigeneProjekte);
  app3.use('/api/projects', await router('routes', 'projects.js'));
  app3.use('/api/projects', await router('routes', 'segments.js'));
  app3.use('/api/projects', await router('routes', 'review.js'));
  app3.use('/api/upload', await router('routes', 'upload.js'));
  const s3 = app3.listen(0, '127.0.0.1');
  await new Promise((ok) => s3.once('listening', ok));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  const als = async (wer, m, p, body) => {
    const r = await fetch(b3 + p, { method: m, headers: { 'x-gast': wer, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const liste = await als(A, 'GET', '/api/projects?user=');
    assert.equal(liste.status, 200, JSON.stringify(liste.body));
    const namen = JSON.stringify(liste.body);
    assert.ok(namen.includes('von A') && !namen.includes('von B'), namen.slice(0, 300));
    assert.equal((await als(A, 'GET', `/api/projects/${pa}`)).status, 200);
    assert.equal((await als(A, 'GET', `/api/projects/${pb}`)).status, 404);
    assert.equal((await als(A, 'GET', `/api/projects/${pa}/diff/${pb}`)).status, 404);
    assert.equal((await als(A, 'DELETE', `/api/projects/${pb}`)).status, 404);
    assert.equal((await als(A, 'POST', '/api/projects/bulk-delete', { ids: [pa2, pb] })).status, 404);
    const zahl = async () => (await q(`SELECT count(*)::int AS n FROM projects WHERE id = ANY($1::uuid[])`, [[pa, pa2, pb]])).rows[0].n;
    assert.equal(await zahl(), 3, 'ein abgewiesenes Löschen hat gelöscht');
    // Andere Schreibweisen derselben fremden ID (Review 13.11.2026): Postgres liest eine UUID auch ohne Bindestriche und in
    // Klammern, Express dekodiert %-Zeichen erst für die Route und ordnet `/Bulk-Delete` ohne Rücksicht auf die Schreibweise zu.
    // Positivkontrolle: dieselben Schreibweisen der EIGENEN ID wären ohne die Schranke lesbar, das fremde Projekt gibt es also.
    for (const [was, pfad] of [
      ['ohne Bindestriche', `/api/projects/${pb.replace(/-/g, '')}`],
      ['in Klammern', `/api/projects/%7B${pb}%7D`],
      ['erstes Zeichen kodiert', `/api/projects/%${pb.charCodeAt(0).toString(16)}${pb.slice(1)}`],
      ['ohne Bindestriche, Unterweg', `/api/projects/${pb.replace(/-/g, '')}/versions`],
    ]) {
      const r = await als(A, 'GET', pfad);
      assert.equal(r.status, 404, `${was}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
    assert.equal((await als(A, 'DELETE', `/api/projects/${pb.replace(/-/g, '')}`)).status, 404);
    assert.equal((await als(A, 'POST', '/api/projects/Bulk-Delete', { ids: [pb] })).status, 404, 'Bulk-Delete in anderer Schreibweise');
    assert.equal((await als(A, 'POST', '/api/projects/BULK-DELETE/', { ids: [pb] })).status, 404, 'BULK-DELETE/ mit Schrägstrich');
    assert.equal(await zahl(), 3, 'eine andere Schreibweise hat gelöscht');
    // ── Segment-Cache je Gast (Migration 051) ──────────────────────────────────────────────────────────────────────────────────
    // Zwei Gäste mit demselben Satz haben getrennte Cache-Zeilen; erst das macht den Review-Editor in der Demo bearbeitbar.
    // Die Segment-ID im Pfad ist kein Projekt (bis 13.11.2026 als eines geprüft: 404 „Projekt nicht gefunden“ für jeden Schreibweg).
    const { upsertSegment, segmentKeyOf, besitzerVon } = await laden('services', 'queue.js');
    const { hashText, normalizedHash } = await laden('services', 'text-normalize.js');
    const satz = 'Die Werkstatt prüft das Rad vor der Probefahrt.';
    const projektVon = (wer) => ({ source_lang: 'DE', target_lang: 'EN', created_by: wer });
    const zA = await upsertSegment({ text: satz }, segmentKeyOf(projektVon(A)));
    const zB = await upsertSegment({ text: satz }, segmentKeyOf(projektVon(B)));
    assert.notEqual(zA.id, zB.id, 'zwei Gäste teilen sich eine Cache-Zeile');
    assert.equal((await upsertSegment({ text: satz }, segmentKeyOf(projektVon(A)))).id, zA.id, 'derselbe Gast trifft seine eigene Zeile nicht');
    const besitzer = async (id) => (await q(`SELECT besitzer FROM segments WHERE id = $1`, [id])).rows[0].besitzer;
    assert.deepEqual([await besitzer(zA.id), await besitzer(zB.id)], [A, B]);
    // Fehlt der Besitzer in der Demo, bricht der Lauf ab, statt still in den gemeinsamen Cache zu schreiben; ohne Demo immer null.
    assert.throws(() => besitzerVon({}, true), /ohne Besitzer/);
    assert.throws(() => segmentKeyOf({ source_lang: 'DE', target_lang: 'EN' }), /ohne Besitzer/);
    assert.equal(besitzerVon({ created_by: A }, false), null);
    // Eine Zeile ohne Besitzer (hochgeladen vor der Trennung, oder Terminologie-Scan) ist eine dritte, gemeinsame.
    const zGemeinsam = await upsertSegment({ text: satz }, { ...segmentKeyOf(projektVon(A)), besitzer: null });
    assert.ok(![zA.id, zB.id].includes(zGemeinsam.id));
    // Zweite Stufe (normalisierter Hash): B hat eine Übersetzung, A fragt nach einer Schreibvariante desselben Satzes und darf
    // sie NICHT bekommen. Positivkontrolle: B selbst bekommt sie über genau diese Stufe.
    await q(`UPDATE segments SET translated_text = 'von B übersetzt' WHERE id = $1`, [zB.id]);
    const variante = [satz + ' ', '  ' + satz, satz.replace(' ', '  '), satz.toUpperCase()]
      .find((v) => hashText(v) !== hashText(satz) && normalizedHash(v) === normalizedHash(satz));
    assert.ok(variante, 'keine Schreibvariante mit gleichem normalisierten Hash gefunden — die Probe der zweiten Stufe wäre leer');
    assert.equal((await upsertSegment({ text: variante }, segmentKeyOf(projektVon(B)))).hasTranslation, true, 'Positivkontrolle: B trifft seine eigene Übersetzung');
    assert.equal((await upsertSegment({ text: variante }, segmentKeyOf(projektVon(A)))).hasTranslation, false, 'A hat die Übersetzung von B bekommen');

    const seg = async (projekt, segment) => (await q(
      `INSERT INTO project_segments (project_id, segment_id, format_segment_id, position) VALUES ($1, $2, 'probe', 0) RETURNING id`, [projekt, segment])).rows[0].id;
    const [sa, sb] = [await seg(pa, zA.id), await seg(pb, zB.id)];
    const zeile = async (id) => (await q(`SELECT translated_text, review_status FROM segments WHERE id = $1`, [id])).rows[0];
    const vorherB = await zeile(zB.id);
    assert.equal((await als(A, 'GET', `/api/projects/${pa}/segments/stats`)).status, 200, 'eigene Segmente lesen');
    assert.equal((await als(A, 'GET', `/api/projects/${pb}/segments/stats`)).status, 404, 'fremde Segmente lesen');
    // A bearbeitet und gibt frei, in SEINEM Projekt — und bei B ändert sich nichts, obwohl es derselbe Satz ist.
    const bearbeitet = await als(A, 'PUT', `/api/projects/${pa}/segments/${sa}`, { translated_text: 'von A bearbeitet' });
    assert.equal(bearbeitet.status, 200, `eigenes Segment bearbeiten: ${JSON.stringify(bearbeitet.body)}`);
    for (const [m, p, body] of [
      ['POST', `/api/projects/${pa}/segments/${sa}/approve`, {}], ['POST', `/api/projects/${pa}/segments/${sa}/unapprove`, {}],
      ['POST', `/api/projects/${pa}/segments/bulk-approve`, { project_segment_ids: [sa] }],
      ['POST', `/api/projects/${pa}/segments/${sa}/clarification`, { note: 'bitte prüfen' }],
      ['DELETE', `/api/projects/${pa}/SEGMENTS/${sa}/clarification`], ['POST', `/api/projects/${pa}/segments/${sa}/approve`, {}],
    ]) {
      const r = await als(A, m, p, body);
      assert.equal(r.status, 200, `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(await zeile(zA.id), { translated_text: 'von A bearbeitet', review_status: 'approved' });
    assert.deepEqual(await zeile(zB.id), vorherB, 'ein Schreibweg von A hat die Zeile von B geändert');
    // Fremdes Projekt: 404. Eigenes Projekt mit dem Segment eines fremden: die Route filtert auf project_id.
    assert.equal((await als(A, 'POST', `/api/projects/${pb}/segments/${sb}/approve`, {})).status, 404, 'fremdes Segment');
    assert.equal((await als(A, 'POST', `/api/projects/${pa}/segments/${sb}/approve`, {})).status, 404, 'fremdes Segment unter eigenem Projekt');
    assert.deepEqual(await zeile(zB.id), vorherB);
    // Ein eigenes Projekt, das auf eine gemeinsame Zeile zeigt (Altbestand): Schreiben bleibt zu, mit Grund — und schreibt nichts.
    const sAlt = await seg(pa2, zGemeinsam.id);
    for (const [m, p] of [
      ['POST', `/api/projects/${pa2}/segments/${sAlt}/approve`], ['PUT', `/api/projects/${pa2}/segments/${sAlt}`],
      ['POST', `/api/projects/${pa2}/segments/bulk-approve`], ['DELETE', `/api/projects/${pa2}/segments/${sAlt}/clarification`],
    ]) {
      const r = await als(A, m, p, m === 'DELETE' ? undefined : { translated_text: 'x', project_segment_ids: [sAlt] });
      assert.equal(r.status, 403, `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'demo_gesperrt', `${m} ${p}`);
      assert.match(r.body.error, /teilt sich Übersetzungen/);
    }
    assert.deepEqual(await zeile(zGemeinsam.id), { translated_text: null, review_status: (await zeile(zGemeinsam.id)).review_status });
    assert.equal((await q(`SELECT count(*)::int AS n FROM segments WHERE id = $1 AND (review_status = 'approved' OR edited_by_user)`, [zGemeinsam.id])).rows[0].n, 0, 'ein gesperrter Weg hat die gemeinsame Zeile geändert');
    assert.equal((await als(A, 'GET', `/api/projects/${pa2}/segments/stats`)).status, 200, 'Altprojekt lesen');
    // Alle Migrationen laufen bei jedem Start neu. Mit zwei Zeilen, die sich nur im Besitzer unterscheiden, dürfen 010, 012 und
    // 021 ihre engeren Indizes nicht wieder anlegen — sonst startet die Demo nach dem ersten doppelten Satz nicht mehr.
    for (const f of readdirSync(join(WURZEL, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
      await q(readFileSync(join(WURZEL, 'migrations', f), 'utf-8'));
    }
    const indizes = (await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'segments' AND indexname LIKE 'uniq_%' ORDER BY 1`)).rows.map((r) => r.indexname);
    assert.deepEqual(indizes, ['uniq_segments_hash_lang_channel_v4']);
    assert.equal((await als(A, 'POST', '/api/projects/bulk-delete', { ids: [pa2] })).status, 200);
    assert.equal(await zahl(), 2);
    // Neue Fassung zu einem fremden Projekt über den Upload: 404, und die Datei bleibt nicht liegen.
    const form = new FormData();
    form.append('file', new Blob(['Hallo'], { type: 'text/plain' }), 'fassung.txt');
    form.append('source_lang', 'DE');
    form.append('target_lang', 'EN');
    form.append('parent_project_id', pb);
    const up = await fetch(`${b3}/api/upload`, { method: 'POST', headers: { 'x-gast': A }, body: form });
    assert.equal(up.status, 404, await up.text());
    await new Promise((ok) => setTimeout(ok, 100));
    assert.deepEqual(readdirSync(UPLOADS).filter((n) => !n.startsWith('.')), []);
    // Gegenprobe: B sieht sein eigenes.
    assert.equal((await als(B, 'GET', `/api/projects/${pb}`)).status, 200);
  } finally {
    s3.close();
  }
});

// ── Aufrufe, PDF, Mail, Einstellungen ─────────────────────────────────────────────────────────────────────────────────────────

await pruefe('Aufrufe je Minute: nach 80 von derselben Sitzung 429, eine andere Sitzung ist davon frei', async () => {
  const fremd = (await api('POST', '/api/auth/demo', { passwort: PASSWORT })).status; // Tor zu (429), aber zählt nicht für GAST
  assert.equal(fremd, 429);
  let erstes429 = null;
  for (let i = 1; i <= 90 && erstes429 === null; i += 1) {
    if ((await api('GET', '/api/einstellungen', null, GAST)).status === 429) erstes429 = i;
  }
  // Wann genau, hängt an den Aufrufen davor in derselben Minute; dass es kommt, nicht.
  assert.ok(erstes429 !== null, 'kein 429 nach 90 Aufrufen');
  assert.equal((await api('GET', '/api/einstellungen')).status, 200);
});

await pruefe('PDF: nacheinander statt gleichzeitig; ein zweites PDF beim Upload 429 und die Datei ist weg', async () => {
  const laufend = [];
  let gleichzeitig = 0;
  const arbeit = (n) => grenzen.pdfNacheinander(async () => {
    laufend.push(n); gleichzeitig = Math.max(gleichzeitig, laufend.length);
    await new Promise((ok) => setTimeout(ok, 50));
    laufend.splice(laufend.indexOf(n), 1);
    return n;
  });
  const a = arbeit(1);
  const b = arbeit(2);
  assert.equal(grenzen.pdfBelegt(), true);
  // Eigene kleine App für den Upload: GAST hat seine Aufrufe dieser Minute schon verbraucht (Fall davor).
  const app2 = express();
  app2.use(express.json());
  app2.use((req, _res, next) => { req.session = {}; req.user = { id: 'a1b2c3d4-0000-4000-8000-0000000000c3', role: 'user' }; next(); });
  app2.use('/api/upload', await router('routes', 'upload.js'));
  const s2 = app2.listen(0, '127.0.0.1');
  await new Promise((ok) => s2.once('listening', ok));
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 Probe'], { type: 'application/pdf' }), 'probe.pdf');
  form.append('source_lang', 'DE');
  form.append('target_lang', 'EN');
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/upload`, { method: 'POST', body: form });
  const body = await r.json();
  assert.equal(r.status, 429, JSON.stringify(body));
  assert.equal(body.code, 'demo_grenze');
  await new Promise((ok) => setTimeout(ok, 100));
  assert.deepEqual(readdirSync(UPLOADS).filter((n) => !n.startsWith('.')), [], 'die abgewiesene Datei liegt noch im Upload-Ordner');
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  assert.equal(gleichzeitig, 1, 'zwei PDF liefen gleichzeitig');
  assert.equal(grenzen.pdfBelegt(), false);
  s2.close();
});

await pruefe('Mail: die Demo verschickt keine, auch mit gesetztem Absender', async () => {
  const { sendMail } = await laden('services', 'email.js');
  const r = await sendMail({ to: 'niemand@example.invalid', subject: 'Probe', html: '<p>x</p>', text: 'x' });
  assert.deepEqual([r.ok, /Demo/.test(r.error)], [false, true]);
});

await pruefe('Einstellungen: Demo mit nächstem Reset aus demo_stand, ohne Zeile null; Freigabe „alle“; Upload-Grenze 2 MB', async () => {
  const ohne = await api('GET', '/api/einstellungen');
  assert.deepEqual([ohne.body.demo, ohne.body.glossarFreigabe], [{ naechsterReset: null }, 'alle']);
  await q(`INSERT INTO demo_stand (letzter_reset, naechster_reset) VALUES (now(), '2026-11-22T03:00:00Z')`);
  const mit = await api('GET', '/api/einstellungen');
  assert.equal(mit.body.demo.naechsterReset, '2026-11-22T03:00:00.000Z');
  assert.ok(!JSON.stringify(mit.body).includes(PASSWORT));
  assert.equal(config.upload.maxFileSizeMb, 2);
});

await pruefe('Am Ende: kein Aufruf hat versucht, den Rechner zu verlassen', async () => {
  assert.deepEqual(nachAussen, []);
});

server.close();
await pool.end();
rmSync(UPLOADS, { recursive: true, force: true });
console.log(`\n${ok} grün, ${fehler.length} rot`);
process.exit(fehler.length ? 1 : 0);
