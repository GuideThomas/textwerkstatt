/**
 * Ausführbare Spezifikation der Panel-Anmeldung (PLAN-panel-anmeldung.md §8, P1).
 *
 *   DB_HOST=127.0.0.1 DB_PORT=… DB_NAME=…_test DB_USER=… DB_PASSWORD=… \
 *   CEP_SERVICE_KEY=<irgendein Testwert> TRANSLATION_SERVICE_KEY=<anderer Testwert> \
 *   UPLOAD_DIR=<Wegwerf-Ordner> npx tsx src/scripts/verify-panel-auth.ts
 *
 * Läuft gegen die ECHTEN Router (`routes/cep.ts`, `routes/panel.ts`) mit echter
 * Sitzung (`requireAuth`, Store in Postgres wie im Betrieb) — nur der
 * Microsoft-Login ist durch eine Test-Route ersetzt, die die Sitzung setzt.
 *
 * 🚨 Nur gegen eine Wegwerf-Datenbank: Das Skript bricht ab, wenn `DB_NAME` nicht
 * auf `_test` endet oder der Host nicht lokal ist. Es legt Benutzer an und ändert
 * Zeitstempel — gegen die Produktiv-DB wäre das ein Schaden, kein Test.
 */
import crypto from 'crypto';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { AddressInfo } from 'net';

const dbName = process.env.DB_NAME || '';
const dbHost = process.env.DB_HOST || '';
if (!dbName.endsWith('_test') || !['127.0.0.1', 'localhost', '::1'].includes(dbHost)) {
  console.error(`Abbruch: nur gegen eine lokale Wegwerf-DB (DB_NAME=…_test, DB_HOST lokal). Gesetzt: ${dbHost}/${dbName}`);
  process.exit(2);
}
if (!process.env.CEP_SERVICE_KEY || !process.env.TRANSLATION_SERVICE_KEY) {
  console.error('Abbruch: CEP_SERVICE_KEY und TRANSLATION_SERVICE_KEY als (verschiedene) Testwerte setzen.');
  process.exit(2);
}

async function main() {
  // Erst nach der Prüfung oben laden — config.ts liest die Umgebung beim Import.
  const { pool } = await import('../db/connection');
  const { config } = await import('../config');
  const { requireAuth } = await import('../middleware/auth');
  const cepRouter = (await import('../routes/cep')).default;
  const panelRouter = (await import('../routes/panel')).default;
  const { MAX_OPEN_PAIRINGS_PER_CLIENT } = await import('../services/panelAuth');

  const PgSession = connectPgSimple(session);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
    secret: crypto.randomBytes(16).toString('hex'),
    resave: false,
    saveUninitialized: false,
  }));
  // Ersatz für den Microsoft-Callback: setzt die Sitzung wie microsoftAuth.ts.
  app.post('/test/login', (req, res) => {
    req.session.userId = req.body.userId;
    req.session.save(() => res.json({ ok: true }));
  });
  app.use('/api/cep', cepRouter);
  app.use('/api/panel', requireAuth, panelRouter);

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let failures = 0;
  let passes = 0;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    if (ok) { passes++; console.log(`  ✓ ${name}`); }
    else { failures++; console.log(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
  };

  async function call(method: string, p: string, opts: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {}) {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.cookie) headers.Cookie = opts.cookie;
    const r = await fetch(base + p, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: r.status, json, setCookie: r.headers.get('set-cookie') };
  }
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function makeUser(tag: string, role = 'user') {
    const email = `panel-test-${tag}-${crypto.randomBytes(4).toString('hex')}@example.invalid`;
    const r = await pool.query(
      `INSERT INTO users (email, name, display_name, role) VALUES ($1, $2, $2, $3) RETURNING id`,
      [email, `Test ${tag}`, role],
    );
    const login = await call('POST', '/test/login', { body: { userId: r.rows[0].id } });
    const cookie = (login.setCookie || '').split(';')[0];
    return { id: r.rows[0].id as string, email, cookie };
  }

  /** Kompletter Kopplungsweg für eine Person — gibt den Panel-Schlüssel zurück. */
  async function pairAs(user: { cookie: string }, label = 'TEST · Illustrator 29.3') {
    const p = await call('POST', '/api/cep/pair', { body: { label } });
    await call('POST', `/api/panel/pairings/${p.json.pairingId}/confirm`, { cookie: user.cookie });
    const got = await call('POST', `/api/cep/pair/${p.json.pairingId}/poll`, { body: { pollSecret: p.json.pollSecret } });
    return got.json.token as string;
  }

  const created: string[] = [];
  try {
    const A = await makeUser('a');
    const B = await makeUser('b');
    const ADMIN = await makeUser('admin', 'admin');
    created.push(A.id, B.id, ADMIN.id);

    console.log('\nA) Kopplung');
    const p = await call('POST', '/api/cep/pair', { body: { label: 'NBWIT · Illustrator 29.3' } });
    check('Kopplung anlegen → 201', p.status === 201, p);
    check('Code im Format XXX-XXX ohne 0/O/1/I/L', /^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/.test(p.json.code), p.json.code);
    check('verifyUrl trägt nur die Kopplungs-ID, nicht das Abhol-Geheimnis',
      p.json.verifyUrl.endsWith(`/?panel=${p.json.pairingId}`) && !p.json.verifyUrl.includes(p.json.pollSecret), p.json.verifyUrl);
    const wrong = await call('POST', `/api/cep/pair/${p.json.pairingId}/poll`, { body: { pollSecret: 'falsch' } });
    check('Abholen mit falschem Geheimnis → 404', wrong.status === 404, wrong);
    const early = await call('POST', `/api/cep/pair/${p.json.pairingId}/poll`, { body: { pollSecret: p.json.pollSecret } });
    check('Abholen vor Bestätigung → 202', early.status === 202, early);
    const anon = await call('GET', `/api/panel/pairings/${p.json.pairingId}`);
    check('Bestätigungsseite ohne Sitzung → 401', anon.status === 401, anon);
    const view = await call('GET', `/api/panel/pairings/${p.json.pairingId}`, { cookie: A.cookie });
    check('Bestätigungsseite zeigt denselben Code und das Gerät',
      view.status === 200 && view.json.code === p.json.code && view.json.label === 'NBWIT · Illustrator 29.3' && view.json.state === 'pending', view);
    const conf = await call('POST', `/api/panel/pairings/${p.json.pairingId}/confirm`, { cookie: A.cookie });
    check('Bestätigen → 200', conf.status === 200, conf);
    const conf2 = await call('POST', `/api/panel/pairings/${p.json.pairingId}/confirm`, { cookie: B.cookie });
    check('Zweite Bestätigung (andere Person) → 409', conf2.status === 409, conf2);
    const got = await call('POST', `/api/cep/pair/${p.json.pairingId}/poll`, { body: { pollSecret: p.json.pollSecret } });
    const tokenA = got.json?.token as string;
    check('Abholen nach Bestätigung → 200 mit ttp_-Schlüssel der Person A',
      got.status === 200 && /^ttp_[A-Za-z0-9_-]{43}$/.test(tokenA) && got.json.user.email === A.email, got);
    const again = await call('POST', `/api/cep/pair/${p.json.pairingId}/poll`, { body: { pollSecret: p.json.pollSecret } });
    check('Zweites Abholen → 410', again.status === 410, again);
    const plain = await pool.query(`SELECT COUNT(*)::int AS n FROM panel_tokens WHERE token_hash = $1`, [tokenA]);
    const hashed = await pool.query(`SELECT COUNT(*)::int AS n FROM panel_tokens WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [tokenA]);
    check('DB hält nur den Hash, nie den Klartext', plain.rows[0].n === 0 && hashed.rows[0].n === 1, { plain: plain.rows[0], hashed: hashed.rows[0] });

    console.log('\nB) Zugang zu /api/cep');
    const me = await call('GET', '/api/cep/me', { headers: bearer(tokenA) });
    check('/me mit Schlüssel → Person A', me.status === 200 && me.json.kind === 'personal' && me.json.user.email === A.email, me);
    const job = await call('POST', '/api/cep/jobs', {
      headers: bearer(tokenA),
      body: { segments: [{ id: 't1', text: 'Hallo Welt' }], source: 'Test.ai', sourceLang: 'DE', targetLangs: ['EN'] },
    });
    check('Auftrag mit persönlichem Schlüssel → 201', job.status === 201, job);
    const projectA = job.json?.projects?.[0]?.projectId as string;
    const owner = await pool.query(`SELECT created_by FROM projects WHERE id = $1`, [projectA]);
    check('Auftrag gehört Person A (created_by)', owner.rows[0]?.created_by === A.id, owner.rows[0]);

    const tokenB = await pairAs(B);
    check('Person B koppelt eigenes Panel', /^ttp_/.test(tokenB || ''), tokenB);
    const stA = await call('GET', `/api/cep/jobs/${projectA}`, { headers: bearer(tokenA) });
    const stB = await call('GET', `/api/cep/jobs/${projectA}`, { headers: bearer(tokenB) });
    const stShared = await call('GET', `/api/cep/jobs/${projectA}`, { headers: { 'X-Service-Key': process.env.CEP_SERVICE_KEY! } });
    check('Status: A sieht eigenen Auftrag → 200', stA.status === 200, stA);
    check('Status: B sieht fremden Auftrag NICHT → 404', stB.status === 404, stB);
    check('Positiv-Kontrolle: derselbe Auftrag ist da (gemeinsamer Schlüssel → 200)', stShared.status === 200, stShared);
    const resB = await call('GET', `/api/cep/jobs/${projectA}/result`, { headers: bearer(tokenB) });
    check('Ergebnis: B bekommt fremdes Ergebnis NICHT → 404', resB.status === 404, resB);

    const none = await call('GET', '/api/cep/me');
    check('Ohne Schlüssel → 401', none.status === 401, none);
    const bogus = await call('GET', '/api/cep/me', { headers: bearer('ttp_' + 'x'.repeat(43)) });
    check('Unbekannter Schlüssel → 401 mit Code panel_token_invalid', bogus.status === 401 && bogus.json.code === 'panel_token_invalid', bogus);
    const trans = await call('GET', '/api/cep/me', { headers: { 'X-Service-Key': process.env.TRANSLATION_SERVICE_KEY! } });
    check('TRANSLATION_SERVICE_KEY öffnet /api/cep nicht mehr → 401', trans.status === 401, trans);

    const usesBefore = await pool.query(`SELECT COALESCE(SUM(uses),0)::int AS n FROM cep_shared_key_uses`);
    const shared = await call('GET', '/api/cep/me', { headers: { 'X-Service-Key': process.env.CEP_SERVICE_KEY! } });
    await new Promise((r) => setTimeout(r, 200));
    const usesAfter = await pool.query(`SELECT COALESCE(SUM(uses),0)::int AS n FROM cep_shared_key_uses`);
    check('Gemeinsamer CEP-Schlüssel gilt übergangsweise → 200', shared.status === 200 && shared.json.kind === 'shared', shared);
    check('… und jede Nutzung wird gezählt', usesAfter.rows[0].n === usesBefore.rows[0].n + 1, { before: usesBefore.rows[0], after: usesAfter.rows[0] });
    const sharedJob = await call('POST', '/api/cep/jobs', {
      headers: { 'X-Service-Key': process.env.CEP_SERVICE_KEY! },
      body: { segments: [{ id: 't1', text: 'Hallo' }], sourceLang: 'DE', targetLangs: ['EN'] },
    });
    const sharedOwner = await pool.query(`SELECT created_by FROM projects WHERE id = $1`, [sharedJob.json?.projects?.[0]?.projectId]);
    check('Auftrag mit gemeinsamem Schlüssel bleibt ohne Besitzer', sharedJob.status === 201 && sharedOwner.rows[0]?.created_by === null, sharedOwner.rows[0]);

    const savedKey = config.cepServiceKey;
    (config as any).cepServiceKey = '';
    const closedShared = await call('GET', '/api/cep/me', { headers: { 'X-Service-Key': savedKey } });
    const closedNone = await call('GET', '/api/cep/me');
    const closedEmpty = await call('GET', '/api/cep/me', { headers: { 'X-Service-Key': '' } });
    (config as any).cepServiceKey = savedKey;
    check('Kein CEP_SERVICE_KEY konfiguriert → trotzdem 401 (fail closed)',
      closedShared.status === 401 && closedNone.status === 401 && closedEmpty.status === 401, { closedShared, closedNone, closedEmpty });
    const stillPersonal = await call('GET', '/api/cep/me', { headers: bearer(tokenA) });
    check('… persönliche Schlüssel gelten davon unberührt', stillPersonal.status === 200, stillPersonal);

    console.log('\nC) Verbindungen ansehen und trennen');
    const listA = await call('GET', '/api/panel/tokens', { cookie: A.cookie });
    const tokA = listA.json?.tokens?.[0];
    check('A sieht genau seine eine Verbindung mit Gerät', listA.status === 200 && listA.json.tokens.length === 1 && tokA.label === 'NBWIT · Illustrator 29.3', listA);
    const listAllAsUser = await call('GET', '/api/panel/tokens?all=1', { cookie: A.cookie });
    check('?all=1 als Nicht-Admin zeigt trotzdem nur die eigenen', listAllAsUser.json?.tokens?.length === 1, listAllAsUser.json);
    const listAllAsAdmin = await call('GET', '/api/panel/tokens?all=1', { cookie: ADMIN.cookie });
    const adminSeesBoth = [A.id, B.id].every((id) => listAllAsAdmin.json?.tokens?.some((t: any) => t.user_id === id));
    check('Admin sieht alle Verbindungen', adminSeesBoth, listAllAsAdmin.json);
    const bRevokesA = await call('DELETE', `/api/panel/tokens/${tokA.id}`, { cookie: B.cookie });
    check('B kann A nicht trennen → 404', bRevokesA.status === 404, bRevokesA);
    const aRevokes = await call('DELETE', `/api/panel/tokens/${tokA.id}`, { cookie: A.cookie });
    const afterRevoke = await call('GET', '/api/cep/me', { headers: bearer(tokenA) });
    check('A trennt in der Web-App → Panel bekommt 401 panel_token_invalid',
      aRevokes.status === 204 && afterRevoke.status === 401 && afterRevoke.json.code === 'panel_token_invalid', { aRevokes, afterRevoke });

    const selfOut = await call('DELETE', '/api/cep/token', { headers: bearer(tokenB) });
    const afterSelf = await call('GET', '/api/cep/me', { headers: bearer(tokenB) });
    check('Panel meldet sich selbst ab → Schlüssel tot', selfOut.status === 204 && afterSelf.status === 401, { selfOut, afterSelf });

    const tokenA2 = await pairAs(A, 'zweiter Rechner');
    const tokenAdmin = await pairAs(ADMIN, 'Admin-Rechner');
    const adminRevokes = await call('GET', '/api/panel/tokens', { cookie: A.cookie });
    const a2 = adminRevokes.json.tokens.find((t: any) => t.label === 'zweiter Rechner');
    const adminDel = await call('DELETE', `/api/panel/tokens/${a2.id}`, { cookie: ADMIN.cookie });
    const afterAdmin = await call('GET', '/api/cep/me', { headers: bearer(tokenA2) });
    check('Admin trennt die Verbindung einer anderen Person', adminDel.status === 204 && afterAdmin.status === 401, { adminDel, afterAdmin });

    await pool.query(`UPDATE users SET active = FALSE WHERE id = $1`, [ADMIN.id]);
    const inactive = await call('GET', '/api/cep/me', { headers: bearer(tokenAdmin) });
    check('Deaktiviertes Konto → Panel-Schlüssel gilt nicht mehr', inactive.status === 401, inactive);
    await pool.query(`UPDATE users SET active = TRUE WHERE id = $1`, [ADMIN.id]);
    const reactivated = await call('GET', '/api/cep/me', { headers: bearer(tokenAdmin) });
    check('Positiv-Kontrolle: wieder aktiv → Schlüssel gilt wieder', reactivated.status === 200, reactivated);

    await pool.query(
      `UPDATE panel_tokens SET created_at = NOW() - INTERVAL '181 days', last_used_at = NOW() - INTERVAL '181 days'
        WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [tokenAdmin]);
    const idle = await call('GET', '/api/cep/me', { headers: bearer(tokenAdmin) });
    check('181 Tage ohne Nutzung → 401', idle.status === 401, idle);
    await pool.query(
      `UPDATE panel_tokens SET last_used_at = NOW() - INTERVAL '179 days' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [tokenAdmin]);
    const notIdle = await call('GET', '/api/cep/me', { headers: bearer(tokenAdmin) });
    check('Positiv-Kontrolle: 179 Tage → gilt noch', notIdle.status === 200, notIdle);

    console.log('\nD) Ablauf, Abbruch, Obergrenze, Gleichzeitigkeit');
    const pe = await call('POST', '/api/cep/pair', { body: {} });
    await pool.query(`UPDATE panel_pairings SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [pe.json.pairingId]);
    const expConf = await call('POST', `/api/panel/pairings/${pe.json.pairingId}/confirm`, { cookie: A.cookie });
    const expPoll = await call('POST', `/api/cep/pair/${pe.json.pairingId}/poll`, { body: { pollSecret: pe.json.pollSecret } });
    check('Abgelaufene Kopplung: Bestätigen 410, Abholen 410', expConf.status === 410 && expPoll.status === 410, { expConf, expPoll });

    const pc = await call('POST', '/api/cep/pair', { body: {} });
    await call('POST', `/api/panel/pairings/${pc.json.pairingId}/cancel`, { cookie: A.cookie });
    const cview = await call('GET', `/api/panel/pairings/${pc.json.pairingId}`, { cookie: A.cookie });
    check('Abbrechen → Kopplung gilt als abgelaufen', cview.json?.state === 'expired', cview);

    const pr = await call('POST', '/api/cep/pair', { body: {} });
    await call('POST', `/api/panel/pairings/${pr.json.pairingId}/confirm`, { cookie: A.cookie });
    const [r1, r2] = await Promise.all([
      call('POST', `/api/cep/pair/${pr.json.pairingId}/poll`, { body: { pollSecret: pr.json.pollSecret } }),
      call('POST', `/api/cep/pair/${pr.json.pairingId}/poll`, { body: { pollSecret: pr.json.pollSecret } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check('Zwei gleichzeitige Abholungen → genau eine bekommt den Schlüssel', statuses[0] === 200 && statuses[1] === 410, statuses);

    // Obergrenze: alles Offene dieses Absenders zählt; wir füllen bis zur Grenze auf.
    await pool.query(`DELETE FROM panel_pairings WHERE picked_up_at IS NULL`);
    const codes: number[] = [];
    for (let i = 0; i < MAX_OPEN_PAIRINGS_PER_CLIENT + 1; i++) {
      codes.push((await call('POST', '/api/cep/pair', { body: {} })).status);
    }
    check(`Obergrenze: ${MAX_OPEN_PAIRINGS_PER_CLIENT} offene erlaubt, die nächste → 429`,
      codes.slice(0, -1).every((s) => s === 201) && codes[codes.length - 1] === 429, codes);
  } finally {
    // Aufräumen: Projekte und Benutzer dieses Laufs (Kopplungen/Schlüssel hängen per CASCADE daran).
    if (created.length) {
      await pool.query(`DELETE FROM projects WHERE created_by = ANY($1) OR (created_by IS NULL AND original_filename IN ('Test.aijson','illustrator.aijson'))`, [created]);
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [created]);
    }
    await pool.query(`DELETE FROM panel_pairings WHERE user_id IS NULL`);
    server.close();
    await pool.end();
  }

  console.log(`\n${passes} bestanden, ${failures} fehlgeschlagen`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
