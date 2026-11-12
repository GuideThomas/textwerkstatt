#!/usr/bin/env node
/**
 * Prüfungen für „Nicht-Admins schlagen vor, Admins geben frei“ (Plan `PLAN-glossar-freigabe.md`, Cockpit #1874).
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank; DeepL wird nicht aufgerufen:
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-freigabe-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:55442:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=55442 DB_NAME=translationtool_test DB_USER=translationtool node scripts/glossar-freigabe.test.mjs
 *
 * Je Schreibweg aus §0 des Plans, durch die echte Route, mit beiden Rollen:
 *  - Nicht-Admin: Antwort 201 mit `vorschlag: true`, und der **Fingerabdruck** aller wirksamen Daten bleibt gleich: Zeilen,
 *    Channel-Werte, Gruppenziele, Glossarversion, `glossar_an_deepl` (DeepL) und `wortliste_freigegeben` (Namen des Assistenten).
 *    Freigeben, Verwerfen, Löschen, Ablehnen, Glossar anlegen: 403, Fingerabdruck gleich.
 *  - Admin: wirkt sofort wie bisher; gibt er einen Vorschlag frei, ändert sich genau das Vorgeschlagene, und der Verlauf nennt beide.
 * Gegenproben: Der Fingerabdruck sieht eine direkte Änderung; der Admin-Weg ändert ihn (die Rolle entscheidet, nicht ein Zufall der
 * Route); `requireAdmin` ohne vorherige Anmeldung prüft selbst; eine gescheiterte Freigabe lässt den Vorschlag offen.
 *
 * 🚨 Der Lauf löscht das Schema `public`. Deshalb bricht er ab, wenn die Datenbank nicht auf `_test` endet oder nicht lokal
 * liegt, und zwar vor dem ersten Datenbankzugriff.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const istLokal = ['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '');
if (!process.env.DB_PASSWORD || !istLokal || !(process.env.DB_NAME ?? '').endsWith('_test')) {
  console.error('Abbruch: nur gegen eine lokale Datenbank mit Namen *_test und mit DB_PASSWORD aus der Umgebung, siehe Kopfkommentar.');
  process.exit(2);
}
process.env.DEEPL_API_KEY = '';
process.env.TRANSLATION_SERVICE_KEY = '';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('routes', 'glossar-vorschlaege.js'))) {
  console.error('dist fehlt oder ist alt: zuerst npm run build:server');
  process.exit(2);
}
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

const MIGRATIONEN = join(WURZEL, 'migrations');
const TESTSEED = readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8');
await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) await q(readFileSync(join(MIGRATIONEN, f), 'utf-8')); await q(TESTSEED);

const ADMIN = { id: 'a1b2c3d4-0000-4000-8000-0000000000a1', display_name: 'Admin Probe', email: 'admin@example.invalid', role: 'admin' };
const NUTZER = { id: 'a1b2c3d4-0000-4000-8000-0000000000b2', display_name: 'Nutzer Probe', email: 'nutzer@example.invalid', role: 'user' };
for (const u of [ADMIN, NUTZER]) {
  await q(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, $3, $4)`, [u.id, u.email, u.display_name, u.role]);
}

const express = require('express');
const app = express();
app.use(express.json());
// Die Rolle setzt hier der Test, wie in der Anwendung `requireAuth` aus der Datenbank. Ohne Kopf: Nicht-Admin.
app.use((req, _res, next) => {
  if (req.header('x-ohne-person') !== '1') req.user = { ...(req.header('x-rolle') === 'admin' ? ADMIN : NUTZER) };
  next();
});
app.use('/api/glossaries', await router('routes', 'glossaries.js'));
app.use('/api/glossaries', await router('routes', 'wortliste-pflege.js'));
app.use('/api/glossaries', await router('routes', 'glossar-vorschlaege.js'));
app.use('/api/projects', await router('routes', 'review.js'));
app.use('/api/terminology-scan', await router('routes', 'terminology-scan.js'));
app.use('/api/namens-bausteine', await router('routes', 'namens-bausteine.js'));
const server = app.listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const BASIS = `http://127.0.0.1:${server.address().port}`;
const api = async (methode, pfad, body, rolle = 'user', extra = {}) => {
  const r = await fetch(BASIS + pfad, {
    method: methode,
    headers: { 'content-type': 'application/json', 'x-rolle': rolle, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, body: json ?? text };
};
const alsAdmin = (methode, pfad, body) => api(methode, pfad, body, 'admin');

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

const FR = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ('Glossar DE→FR', 'DE', 'FR') RETURNING id`)).rows[0].id;
await q(
  `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, wortart) VALUES
     ($1, 'Abdeckung', 'diffuseur', TRUE, NULL), ($1, 'Endkappe', 'embout', FALSE, NULL), ($1, 'Halter', 'support', TRUE, 'hauptwort'),
     ($1, 'Rolle', 'rouleau', TRUE, NULL), ($1, 'Clip', 'clip', TRUE, NULL)`, [FR]);
const id = async (begriff) => (await q(`SELECT id FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0]?.id;
const zeile = async (begriff) => (await q(`SELECT * FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0];
await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPA', 'diffuseur G')`, [await id('Abdeckung')]);
const pfad = async (begriff, rest = '') => `/api/glossaries/${FR}/entries/${await id(begriff)}${rest}`;

/** Alles, was wirkt: Ändert sich das, hat ein Schreibweg etwas wirksam gemacht. */
const stand = async () => JSON.stringify({
  zeilen: (await q(`SELECT id, glossary_id, source_term, target_term, approved, context, category, art, wortart, genus, formen, ziel_name, an_deepl
                      FROM glossary_entries ORDER BY id`)).rows,
  channels: (await q(`SELECT entry_id, channel_code, target_term FROM glossary_entry_channels ORDER BY 1, 2`)).rows,
  gruppen: (await q(`SELECT entry_id, produktgruppe, target_term, genus FROM glossary_entry_gruppen ORDER BY 1, 2`)).rows,
  glossare: (await q(`SELECT id, source_lang, target_lang, version FROM glossaries ORDER BY id`)).rows,
  deepl: (await q(`SELECT id, source_term, target_term FROM glossar_an_deepl ORDER BY id`)).rows,
  namen: (await q(`SELECT * FROM wortliste_freigegeben ORDER BY id`)).rows,
});
const offene = async () => (await q(`SELECT * FROM glossar_vorschlag WHERE status = 'offen' ORDER BY id`)).rows;
const vorschlag = async (vid) => (await q(`SELECT * FROM glossar_vorschlag WHERE id = $1`, [vid])).rows[0];
const deepl = async (begriff) => (await q(`SELECT target_term FROM glossar_an_deepl WHERE glossary_id = $1 AND source_term = $2`, [FR, begriff])).rows[0]?.target_term;
const namen = async (begriff) => (await q(`SELECT * FROM wortliste_freigegeben WHERE sprache = 'FR' AND deutsch = $1`, [begriff])).rows[0];
const freigeben = (vid) => alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${vid}/freigeben`);

/** Ein Nicht-Admin-Aufruf, der einen Vorschlag einreichen und sonst nichts ändern soll. Gibt die Vorschlagszeile zurück. */
async function nurVorschlag(methode, p, body) {
  const vorher = await stand();
  const r = await api(methode, p, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.vorschlag, true, JSON.stringify(r.body));
  assert.equal(await stand(), vorher, 'ein Nicht-Admin hat etwas wirksam gemacht');
  return vorschlag(r.body.vorschlag_id);
}
/** Ein Nicht-Admin-Aufruf, der abgewiesen werden muss, ohne etwas zu ändern. */
async function verboten(methode, p, body) {
  const vorher = await stand();
  const r = await api(methode, p, body);
  assert.equal(r.status, 403, `${methode} ${p}: ${JSON.stringify(r.body)}`);
  assert.equal(await stand(), vorher);
}

console.log('Glossar-Freigabe: Nicht-Admins schlagen vor, Admins geben frei (PLAN-glossar-freigabe.md, Cockpit #1874)');

await pruefe('Gegenprobe: der Fingerabdruck sieht eine direkte Änderung an Ziel, Channel und Version', async () => {
  // In einer Transaktion, die zurückgerollt wird: Ein Zurücksetzen von Hand ließe die Namensfassung (Migration 038) gezählt.
  const s0 = await stand();
  const rolle = await id('Rolle');
  for (const aenderung of [
    `UPDATE glossary_entries SET target_term = 'x' WHERE id = '${rolle}'`,
    `UPDATE glossaries SET version = version + 1 WHERE id = '${FR}'`,
    `INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ('${rolle}', 'SHOPB', 'x')`,
  ]) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(aenderung);
      const alt = pool.query;
      pool.query = (sql, p) => c.query(sql, p);
      try { assert.notEqual(await stand(), s0, aenderung); } finally { pool.query = alt; }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }
  assert.equal(await stand(), s0);
});

await pruefe('Gegenprobe: requireAdmin ohne vorherige Anmeldung prüft selbst (401), mit Nicht-Admin 403, mit Admin weiter', async () => {
  const { requireAdmin } = await laden('middleware', 'auth.js');
  const antwort = () => { const r = { code: 0, status(c) { r.code = c; return r; }, json() { return r; } }; return r; };
  const ohne = antwort();
  let weiter = false;
  await requireAdmin({ session: {} }, ohne, () => { weiter = true; });
  assert.equal(ohne.code, 401);
  const nutzer = antwort();
  await requireAdmin({ session: {}, user: { ...NUTZER } }, nutzer, () => { weiter = true; });
  assert.equal(nutzer.code, 403);
  assert.equal(weiter, false);
  await requireAdmin({ session: {}, user: { ...ADMIN } }, antwort(), () => { weiter = true; });
  assert.equal(weiter, true);
});

// ── Weg 1: Glossarseite ───────────────────────────────────────────────────────────────────────────────────────────────────────

await pruefe('Glossarseite, neuer Begriff: Nicht-Admin nur Vorschlag; Admin gibt frei, dann bei DeepL und in den Namen, Verlauf nennt beide', async () => {
  const v = await nurVorschlag('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Lichtleiste', target_term: 'réglette' });
  assert.deepEqual([v.weg, v.entry_id, v.von, v.status], ['neu', null, NUTZER.display_name, 'offen']);
  assert.equal(await id('Lichtleiste'), undefined);
  const v0 = (await q(`SELECT version FROM glossaries WHERE id = $1`, [FR])).rows[0].version;
  const r = await freigeben(v.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const z = await zeile('Lichtleiste');
  assert.deepEqual([z.target_term, z.approved, z.source], ['réglette', true, 'manual']);
  assert.equal(await deepl('Lichtleiste'), 'réglette');
  assert.equal((await namen('Lichtleiste'))?.ziel, 'réglette');
  assert.ok((await q(`SELECT version FROM glossaries WHERE id = $1`, [FR])).rows[0].version > v0, 'Version steigt erst mit der Freigabe');
  assert.equal((await vorschlag(v.id)).status, 'freigegeben');
  const verlauf = (await q(`SELECT field, action, changed_by, changed_by_name FROM glossary_entry_history WHERE source_term = 'Lichtleiste' ORDER BY changed_at, id`)).rows;
  assert.ok(verlauf.some((h) => h.field === 'vorschlag' && h.action === 'vorschlag' && h.changed_by === NUTZER.id), JSON.stringify(verlauf));
  assert.ok(verlauf.some((h) => h.field === 'standard' && h.action === 'created' && h.changed_by === ADMIN.id
    && h.changed_by_name === `${ADMIN.display_name} (Vorschlag von ${NUTZER.display_name})`), JSON.stringify(verlauf));
  assert.ok(verlauf.some((h) => h.field === 'vorschlag' && h.action === 'freigabe' && h.changed_by === ADMIN.id), JSON.stringify(verlauf));
});

await pruefe('Glossarseite, Ziel eines freigegebenen Eintrags: bis zur Freigabe gilt der alte Stand, auch bei DeepL', async () => {
  const v = await nurVorschlag('PUT', await pfad('Rolle'), { target_term: 'bobine' });
  assert.equal(v.weg, 'eintrag');
  assert.equal(await deepl('Rolle'), 'rouleau');
  const liste = await api('GET', `/api/glossaries/${FR}/vorschlaege`);
  const eintrag = liste.body.find((x) => x.id === Number(v.id));
  assert.deepEqual([eintrag.aktuell.target_term, eintrag.daten.target_term], ['rouleau', 'bobine'], 'alt und neu nebeneinander');
  const e = await api('GET', `/api/glossaries/${FR}/entries?limit=50`);
  assert.equal(e.body.stats.vorschlaege, 1);
  assert.equal(e.body.entries.find((x) => x.source_term === 'Rolle').offene_vorschlaege, 1);
  assert.equal((await freigeben(v.id)).status, 200);
  assert.equal(await deepl('Rolle'), 'bobine');
});

await pruefe('Glossarseite, zweimal speichern: ein Vorschlag, ergänzt; der erste Stand bleibt als vorher', async () => {
  const a = await nurVorschlag('PUT', await pfad('Clip'), { target_term: 'agrafe' });
  const b = await nurVorschlag('PUT', await pfad('Clip'), { context: 'Befestigung' });
  assert.equal(b.id, a.id);
  assert.deepEqual(b.daten, { target_term: 'agrafe', context: 'Befestigung' });
  assert.equal(b.vorher.target_term, 'clip');
});

await pruefe('Glossarseite, Verwerfen: nur Admin, danach unverändert und entschieden; ein zweiter Entscheid ist 409', async () => {
  const v = (await offene()).find((x) => x.source_term === 'Clip');
  await verboten('POST', `/api/glossaries/${FR}/vorschlaege/${v.id}/verwerfen`);
  await verboten('POST', `/api/glossaries/${FR}/vorschlaege/${v.id}/freigeben`);
  const s0 = await stand();
  assert.equal((await alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${v.id}/verwerfen`)).status, 200);
  assert.equal(await stand(), s0);
  assert.equal((await vorschlag(v.id)).status, 'verworfen');
  assert.equal((await freigeben(v.id)).status, 409);
});

await pruefe('Glossarseite, Freigabe-Haken: Nicht-Admin 403, offene Zeile bleibt offen; Admin gibt frei (Gegenprobe)', async () => {
  const vorher = await stand();
  const r = await api('PUT', await pfad('Endkappe'), { approved: true });
  assert.equal(r.status, 403);
  assert.equal(await stand(), vorher);
  assert.equal((await alsAdmin('PUT', await pfad('Endkappe'), { approved: true })).status, 200);
  assert.equal((await zeile('Endkappe')).approved, true);
});

await pruefe('Glossarseite, Umbenennen: Vorschlag; nach Freigabe umbenannt', async () => {
  const v = await nurVorschlag('PUT', await pfad('Halter'), { source_term: 'Halterung' });
  assert.deepEqual([v.weg, v.schluessel], ['eintrag', 'begriff']);
  assert.equal((await freigeben(v.id)).status, 200);
  assert.equal(await id('Halter'), undefined);
  assert.equal((await zeile('Halterung')).target_term, 'support');
});

await pruefe('Glossarseite, Channel-Wert setzen und entfernen: Vorschlag, Namen unverändert; nach Freigabe wirksam', async () => {
  const setzen = await nurVorschlag('PUT', await pfad('Abdeckung', '/channels/SHOPB'), { target_term: 'diffuseur S' });
  assert.deepEqual([setzen.weg, setzen.schluessel], ['channel', 'SHOPB']);
  assert.equal((await freigeben(setzen.id)).status, 200);
  assert.equal((await namen('Abdeckung')).kanaele.SHOPB, 'diffuseur S');
  const weg = await nurVorschlag('DELETE', await pfad('Abdeckung', '/channels/SHOPA'));
  assert.equal(weg.daten.target_term, null);
  assert.equal((await freigeben(weg.id)).status, 200);
  assert.equal((await namen('Abdeckung')).kanaele.SHOPA, undefined);
});

await pruefe('Glossarseite: Löschen, Sammelfreigabe, Entfernen, Hinweis verwerfen, Glossar anlegen und löschen nur Admins', async () => {
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Stecker', 'fiche', FALSE)`, [FR]);
  await verboten('DELETE', await pfad('Rolle'));
  await verboten('POST', `/api/glossaries/${FR}/entries/bulk-approve`, {});
  await verboten('POST', await pfad('Rolle', '/entfernen'), { stand: 'bobine' });
  await verboten('POST', `/api/glossaries/${FR}/hinweise/00000000-0000-4000-8000-000000000000/verwerfen`);
  await verboten('POST', '/api/glossaries', { name: 'DE → ES', source_lang: 'DE', target_lang: 'ES' });
  await verboten('DELETE', `/api/glossaries/${FR}`);
  // Gegenprobe: derselbe Aufruf als Admin wirkt.
  const r = await alsAdmin('POST', `/api/glossaries/${FR}/entries/bulk-approve`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.approved, 1);
  assert.equal(await deepl('Stecker'), 'fiche');
});

await pruefe('Glossarseite, Admin direkt: neuer Begriff sofort wirksam, ohne Vorschlag (Gegenprobe zur Rolle)', async () => {
  const n0 = (await offene()).length;
  const r = await alsAdmin('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Netzteil', target_term: 'alimentation' });
  assert.equal(r.status, 201);
  assert.equal(r.body.vorschlag, undefined);
  assert.equal(await deepl('Netzteil'), 'alimentation');
  assert.equal((await offene()).length, n0);
});

await pruefe('Freigabe scheitert, Vorschlag bleibt offen: der Begriff ist inzwischen angelegt', async () => {
  const v = await nurVorschlag('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Diffusor', target_term: 'diffuseur opale' });
  assert.equal((await alsAdmin('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Diffusor', target_term: 'diffuseur' })).status, 201);
  const r = await freigeben(v.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.vorschlag_offen, true);
  assert.equal((await vorschlag(v.id)).status, 'offen');
  assert.equal(await deepl('Diffusor'), 'diffuseur');
  assert.equal((await alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${v.id}/verwerfen`)).status, 200);
});

// ── Befunde des Code-Reviews 12.11.2026: Rennen, gesehene Fassung, Teilwirkung ───────────────────────────────────────────────

await pruefe('Review 3.2: freigegeben wird nur die Fassung, die der Admin gesehen hat; eine ergänzte gibt 409 und wirkt nicht', async () => {
  const a = await nurVorschlag('PUT', await pfad('Halterung'), { target_term: 'support mural' });
  const gesehen = (await api('GET', `/api/glossaries/${FR}/vorschlaege`)).body.find((x) => x.id === Number(a.id)).fassung;
  const b = await nurVorschlag('PUT', await pfad('Halterung'), { target_term: 'support de fixation' });
  assert.deepEqual([b.id, b.fassung], [a.id, gesehen + 1]);
  const s0 = await stand();
  const alt = await alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${a.id}/freigeben`, { fassung: gesehen });
  assert.equal(alt.status, 409, JSON.stringify(alt.body));
  assert.equal(await stand(), s0);
  assert.equal((await vorschlag(a.id)).status, 'offen');
  // Gegenprobe: mit der neuen Fassung wirkt sie.
  assert.equal((await alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${a.id}/freigeben`, { fassung: gesehen + 1 })).status, 200);
  assert.equal(await deepl('Halterung'), 'support de fixation');
});

await pruefe('Review 3.1/3.4: in Arbeit sperrt Verwerfen und zweites Freigeben; nach zehn Minuten gilt ein hängender wieder als offen', async () => {
  const v = await nurVorschlag('PUT', await pfad('Clip'), { target_term: 'attache' });
  await q(`UPDATE glossar_vorschlag SET status = 'in_arbeit', entschieden_am = NOW(), entschieden_von = 'anderer Admin' WHERE id = $1`, [v.id]);
  const s0 = await stand();
  assert.equal((await alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${v.id}/verwerfen`)).status, 409);
  assert.equal((await freigeben(v.id)).status, 409);
  assert.equal(await stand(), s0);
  await q(`UPDATE glossar_vorschlag SET entschieden_am = NOW() - interval '11 minutes' WHERE id = $1`, [v.id]);
  assert.equal((await alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${v.id}/verwerfen`)).status, 200);
  assert.equal((await vorschlag(v.id)).status, 'verworfen');
});

await pruefe('Review 3.4: ein zweiter Klick auf Freigeben wirkt nicht noch einmal (Version steigt einmal)', async () => {
  const v = await nurVorschlag('PUT', await pfad('Clip'), { target_term: 'pince' });
  const v0 = (await q(`SELECT version FROM glossaries WHERE id = $1`, [FR])).rows[0].version;
  const [x, y] = await Promise.all([freigeben(v.id), freigeben(v.id)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal((await q(`SELECT version FROM glossaries WHERE id = $1`, [FR])).rows[0].version, v0 + 1);
});

await pruefe('Review 3.3: unbekannter Channel schon beim Einreichen 400, kein Vorschlag; bekannter geht (Gegenprobe)', async () => {
  const n0 = (await offene()).length;
  const s0 = await stand();
  const a = await api('POST', '/api/glossaries/quickadd', { source_lang: 'DE', target_lang: 'FR', source_term: 'Kabel', target_term: 'câble', channel_code: 'NICHTDA' });
  const b = await api('PUT', await pfad('Clip', '/channels/NICHTDA'), { target_term: 'x' });
  assert.deepEqual([a.status, b.status], [400, 400]);
  assert.equal((await offene()).length, n0);
  assert.equal(await stand(), s0);
  await nurVorschlag('POST', '/api/glossaries/quickadd', { source_lang: 'DE', target_lang: 'FR', source_term: 'Kabel', target_term: 'câble', channel_code: 'SHOPB' });
});

await pruefe('Freigabe einer gescheiterten Wirkung gibt den Vorschlag ganz zurück (offen, ohne Entscheider)', async () => {
  const w =await nurVorschlag('PUT', await pfad('Stecker'), { target_term: 'prise' });
  await alsAdmin('DELETE', await pfad('Stecker'));
  assert.equal(await vorschlag(w.id), undefined, 'mit der Zeile fällt ihr Vorschlag weg (ON DELETE CASCADE)');
  const n = await nurVorschlag('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Gehäusedeckel', target_term: 'couvercle' });
  await alsAdmin('POST', `/api/glossaries/${FR}/entries`, { source_term: 'Gehäusedeckel', target_term: 'capot' });
  assert.equal((await freigeben(n.id)).status, 409);
  const z = await vorschlag(n.id);
  assert.deepEqual([z.status, z.entschieden_von, z.entschieden_am], ['offen', null, null]);
});

// ── Weg 2: Wortliste ──────────────────────────────────────────────────────────────────────────────────────────────────────────

await pruefe('Wortliste, an_deepl aus: Vorschlag, DeepL behält den Begriff; nach Freigabe weg bei DeepL, Version +1', async () => {
  const v = await nurVorschlag('PUT', await pfad('Abdeckung', '/wortliste'), { an_deepl: false });
  assert.equal(v.weg, 'wortliste');
  assert.equal(await deepl('Abdeckung'), 'diffuseur');
  const v0 = (await q(`SELECT version FROM glossaries WHERE id = $1`, [FR])).rows[0].version;
  assert.equal((await freigeben(v.id)).status, 200);
  assert.equal(await deepl('Abdeckung'), undefined);
  assert.equal((await q(`SELECT version FROM glossaries WHERE id = $1`, [FR])).rows[0].version, v0 + 1);
});

await pruefe('Wortliste, ungültige Angabe: 400 schon beim Einreichen, kein Vorschlag', async () => {
  const n0 = (await offene()).length;
  const r = await api('PUT', await pfad('Rolle', '/wortliste'), { art: 'quatsch' });
  assert.equal(r.status, 400);
  assert.equal((await offene()).length, n0);
});

await pruefe('Wortliste, Gruppenziel setzen und entfernen: Vorschlag, Namen unverändert; nach Freigabe in den Namen', async () => {
  const v = await nurVorschlag('PUT', await pfad('Rolle', '/gruppen/12'), { target_term: 'rouleau LED', genus: 'm' });
  assert.deepEqual([v.weg, v.schluessel], ['gruppe', '12']);
  assert.equal((await freigeben(v.id)).status, 200);
  assert.deepEqual((await namen('Rolle')).gruppen.map((g) => [g.produktgruppe, g.ziel]), [[12, 'rouleau LED']]);
  const weg = await nurVorschlag('DELETE', await pfad('Rolle', '/gruppen/12'));
  assert.equal((await freigeben(weg.id)).status, 200);
  assert.deepEqual((await namen('Rolle')).gruppen, []);
  // Review 3.5: Entfernen, wo inzwischen nichts mehr steht, gilt als erreicht, nicht als offen.
  await alsAdmin('PUT', await pfad('Rolle', '/gruppen/13'), { target_term: 'rouleau 13' });
  const zweimal = await nurVorschlag('DELETE', await pfad('Rolle', '/gruppen/13'));
  await alsAdmin('DELETE', await pfad('Rolle', '/gruppen/13'));
  assert.equal((await freigeben(zweimal.id)).status, 200);
  assert.equal((await vorschlag(zweimal.id)).status, 'freigegeben');
});

await pruefe('Wortliste: Ablehnen nur Admins, die Rückfrage bleibt für alle', async () => {
  await q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Kappe', 'capot', FALSE)`, [FR]);
  await verboten('POST', await pfad('Kappe', '/ablehnen'), { anmerkung: 'nein' });
  const r = await api('PUT', await pfad('Kappe', '/rueckfrage'), { text: 'capot oder embout?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await q(`SELECT rueckfrage FROM wortliste_vorschlag WHERE entry_id = $1`, [await id('Kappe')])).rows[0].rueckfrage, 'capot oder embout?');
  assert.equal((await alsAdmin('POST', await pfad('Kappe', '/ablehnen'), {})).status, 200);
  assert.equal(await id('Kappe'), undefined);
});

// ── Weg 3: Schnelleintrag (Textwerkstatt, Review-Editor) ──────────────────────────────────────────────────────────────────────

await pruefe('Schnelleintrag: Nicht-Admin neuer Begriff, anderes Ziel, Channel: je ein Vorschlag; gleiches Ziel: unverändert', async () => {
  const basis = { source_lang: 'DE', target_lang: 'FR' };
  const neu = await nurVorschlag('POST', '/api/glossaries/quickadd', { ...basis, source_term: 'Schiene', target_term: 'rail' });
  assert.deepEqual([neu.weg, neu.quelle], ['neu', 'quickadd']);
  const anders = await nurVorschlag('POST', '/api/glossaries/quickadd', { ...basis, source_term: 'Netzteil', target_term: 'bloc' });
  assert.equal(anders.weg, 'eintrag');
  const kanal = await nurVorschlag('POST', '/api/glossaries/quickadd', { ...basis, source_term: 'Netzteil', target_term: 'bloc G', channel_code: 'shopa' });
  assert.deepEqual([kanal.weg, kanal.schluessel], ['channel', 'SHOPA']);
  const s0 = await stand();
  const gleich = await api('POST', '/api/glossaries/quickadd', { ...basis, source_term: 'Netzteil', target_term: 'alimentation' });
  assert.deepEqual([gleich.status, gleich.body.action], [200, 'unchanged']);
  assert.equal(await stand(), s0);
  assert.equal((await freigeben(neu.id)).status, 200);
  assert.deepEqual([(await zeile('Schiene')).source, await deepl('Schiene')], ['review-quickadd', 'rail']);
});

await pruefe('Schnelleintrag ohne Glossar des Sprachpaars: Nicht-Admin 409, kein Glossar angelegt; Admin legt es an (Gegenprobe)', async () => {
  const vorher = await stand();
  const r = await api('POST', '/api/glossaries/quickadd', { source_lang: 'DE', target_lang: 'ES', source_term: 'Schiene', target_term: 'riel' });
  assert.equal(r.status, 409);
  assert.equal(await stand(), vorher);
  const a = await alsAdmin('POST', '/api/glossaries/quickadd', { source_lang: 'DE', target_lang: 'ES', source_term: 'Schiene', target_term: 'riel' });
  // Das neue Glossar bringt die leere Zeile „Schiene“ schon mit (Migration 031), daher `updated`.
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const es = (await q(`SELECT e.target_term, e.approved FROM glossary_entries e JOIN glossaries g ON g.id = e.glossary_id
                        WHERE g.target_lang = 'ES' AND e.source_term = 'Schiene'`)).rows;
  assert.deepEqual(es, [{ target_term: 'riel', approved: true }]);
});

// ── Weg 4: Native-Speaker-Review ──────────────────────────────────────────────────────────────────────────────────────────────

const PROJEKT = (await q(`INSERT INTO projects (name, source_lang, target_lang, file_type) VALUES ('Probe', 'DE', 'FR', 'txt') RETURNING id`)).rows[0].id;

await pruefe('Review: Reviewer nur Vorschlag (Quelle review); Admin legt wie bisher eine offene Zeile an (Gegenprobe)', async () => {
  const v = await nurVorschlag('POST', `/api/projects/${PROJEKT}/terminology`, { source_term: 'Montageclip', target_term: 'clip de montage' });
  assert.deepEqual([v.weg, v.quelle], ['neu', 'review']);
  assert.equal(await id('Montageclip'), undefined);
  const r = await alsAdmin('POST', `/api/projects/${PROJEKT}/terminology`, { source_term: 'Befestigungsclip', target_term: 'clip de fixation' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await zeile('Befestigungsclip')).approved, false, 'der Weg des Admins gibt nicht frei, wie vor dem Umbau');
  assert.equal((await freigeben(v.id)).status, 200);
  assert.equal(await deepl('Montageclip'), 'clip de montage');
});

// ── Weg 5: Terminologie-Scan ──────────────────────────────────────────────────────────────────────────────────────────────────

const SCAN = (await q(`INSERT INTO terminology_scans (name, source_lang, target_lang, source_file_type, glossary_id) VALUES ('Probe', 'DE', 'FR', 'xlsx', $1) RETURNING id`, [FR])).rows[0].id;
const kandidat = async (quelle, ziel) => (await q(
  `INSERT INTO terminology_candidates (scan_id, source_text, existing_translation, deepl_translation, source_term, existing_term, deepl_term, category, confidence)
   VALUES ($1, $2, $3, $3, $2, $3, $3, 'TERMINOLOGY', 0.9) RETURNING id`, [SCAN, quelle, ziel])).rows[0].id;

await pruefe('Terminologie-Scan: Nicht-Admin schlägt vor (Kandidat vorgeschlagen); Admin übernimmt direkt (Gegenprobe)', async () => {
  const k1 = await kandidat('Endstück', 'pièce terminale');
  const vorher = await stand();
  const r = await api('POST', `/api/terminology-scan/${SCAN}/candidates/approve`, { ids: [k1] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.vorschlag, r.body.vorgeschlagen, r.body.inserted], [true, 1, 0]);
  assert.equal(await stand(), vorher);
  assert.equal((await q(`SELECT status FROM terminology_candidates WHERE id = $1`, [k1])).rows[0].status, 'vorgeschlagen');
  assert.ok((await offene()).some((v) => v.source_term === 'Endstück' && v.quelle === 'terminologie-scan'));
  // Der Kandidat folgt dem Entscheid (Review 3.9), sonst hinge er auf „vorgeschlagen“.
  const vs = (await offene()).find((v) => v.source_term === 'Endstück');
  assert.equal((await freigeben(vs.id)).status, 200);
  assert.deepEqual(Object.values((await q(`SELECT status, glossary_entry_id IS NOT NULL AS mit_zeile FROM terminology_candidates WHERE id = $1`, [k1])).rows[0]), ['approved', true]);
  const k3 = await kandidat('Endplatte', 'plaque');
  await api('POST', `/api/terminology-scan/${SCAN}/candidates/approve`, { ids: [k3] });
  const vp = (await offene()).find((v) => v.source_term === 'Endplatte');
  assert.equal((await alsAdmin('POST', `/api/glossaries/${FR}/vorschlaege/${vp.id}/verwerfen`)).status, 200);
  assert.equal((await q(`SELECT status FROM terminology_candidates WHERE id = $1`, [k3])).rows[0].status, 'rejected');
  const k2 = await kandidat('Gehäuse', 'boîtier');
  const a = await alsAdmin('POST', `/api/terminology-scan/${SCAN}/candidates/approve`, { ids: [k2] });
  assert.equal(a.body.inserted, 1);
  assert.equal(await deepl('Gehäuse'), 'boîtier');
});

// ── Weg 6 und 7: Excel-Antworten nur Admins, Maschinenweg direkt ─────────────────────────────────────────────────────────────

await pruefe('Excel-Antworten und Prüfliste: kein HTTP-Weg, nur die Skripte auf dem Server (also nur, wer dort eine Shell hat)', async () => {
  const routen = readdirSync(dist('routes')).filter((n) => n.endsWith('.js'));
  for (const n of routen) {
    const t = readFileSync(dist('routes', n), 'utf-8');
    for (const dienst of ['glossar-antworten', 'glossar-liste']) {
      assert.ok(!new RegExp(`services/${dienst}['"]`).test(t), `${n} bindet ${dienst} ein`);
    }
  }
  // Gegenprobe: das Skript bindet ihn ein, die Suche oben fände also eine Route.
  assert.ok(/services\/glossar-antworten['"]/.test(readFileSync(dist('scripts', 'glossar-antworten-einspielen.js'), 'utf-8')));
});

await pruefe('Maschinenweg des Assistenten bleibt direkt: Meldung ohne Person legt die offene Zeile an, ohne Vorschlag', async () => {
  const n0 = (await offene()).length;
  const r = await api('POST', '/api/namens-bausteine/unbekannt', { meldungen: [{ sprache: 'FR', art: 'wort', deutsch: 'Probewort' }] },
    'user', { 'x-ohne-person': '1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.angelegt, 1, JSON.stringify(r.body));
  assert.equal((await zeile('Probewort')).approved, false);
  assert.equal((await offene()).length, n0);
});

await pruefe('Am Ende: Kein Nicht-Admin steht im Verlauf als Bearbeiter einer wirksamen Änderung', async () => {
  const r = (await q(
    `SELECT field, action, source_term FROM glossary_entry_history WHERE changed_by = $1 AND field NOT IN ('vorschlag', 'rueckfrage')`,
    [NUTZER.id])).rows;
  assert.deepEqual(r, []);
  // Gegenprobe: vom Admin gibt es solche Einträge.
  assert.ok((await q(`SELECT count(*)::int AS n FROM glossary_entry_history WHERE changed_by = $1 AND field <> 'vorschlag'`, [ADMIN.id])).rows[0].n > 0);
});

server.close();
await pool.end();
console.log(`\n${ok} grün, ${fehler.length} rot`);
process.exit(fehler.length ? 1 : 0);
