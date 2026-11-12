#!/usr/bin/env node
/**
 * Prüfungen für die Wortliste Phase 3: das Zusammenführen der Namensbausteine ins Glossar (`services/wortliste-umzug.ts`,
 * `scripts/wortliste-zusammenfuehren.ts`, Migration 038; Plan `PLAN-wortliste.md` §4, Cockpit #1831).
 *
 * Läuft gegen eine Wegwerf-Postgres, nie gegen eine echte Datenbank; DeepL ist ersetzt und zeichnet auf:
 *
 *   export DB_PASSWORD=<selbst erzeugt, nur für diesen Lauf>
 *   docker run -d --rm --name tt-wortliste-test --memory 512m --cpus 1 -e POSTGRES_PASSWORD="$DB_PASSWORD" \
 *     -e POSTGRES_DB=translationtool_test -e POSTGRES_USER=translationtool -p 127.0.0.1:55441:5432 postgres:15
 *   npm run build:server
 *   DB_HOST=127.0.0.1 DB_PORT=55441 DB_NAME=translationtool_test DB_USER=translationtool node scripts/wortliste-umzug.test.mjs
 *
 * Der Bestand ist dem echten nachgebaut (gemessen 10.11.2026): Bausteine, die gleich im Glossar stehen, solche mit anderem Wert und
 * Entscheid, solche ohne Zeile, Blockschrift neben normaler Schreibung, ein Muster, eine Wendung mit Ausnahme im Namen, ein
 * Gruppenziel, offene, abgelehnte und nachgefragte Vorschläge, eine exakte Dublette in einer anderen Sprache.
 *
 * 🚨 Der Lauf löscht das Schema `public`. Deshalb bricht er ab, wenn die Datenbank nicht auf `_test` endet oder nicht lokal
 * liegt, und zwar vor dem ersten Datenbankzugriff.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const istLokal = ['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '');
if (!process.env.DB_PASSWORD || !istLokal || !(process.env.DB_NAME ?? '').endsWith('_test')) {
  console.error('Abbruch: nur gegen eine lokale Datenbank mit Namen *_test und mit DB_PASSWORD aus der Umgebung, siehe Kopfkommentar.');
  process.exit(2);
}
process.env.DEEPL_API_KEY = 'attrappe-kein-schluessel';

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (...t) => join(WURZEL, 'dist', ...t);
if (!existsSync(dist('scripts', 'wortliste-zusammenfuehren.js'))) {
  console.error('dist fehlt: zuerst npm run build:server');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const laden = async (...t) => {
  const m = await import(pathToFileURL(dist(...t)).href);
  return m.default?.__esModule || m.default?.default ? m.default : m;
};

// DeepL: Anlegen, Löschen und Zurücklesen eines Glossars; gelesen wird, was zuletzt angelegt wurde.
const deepl = require('deepl-node');
let beiDeepL = {};
let angelegt = 0;
deepl.Translator.prototype.createGlossary = async function (_n, _q, _z, eintraege) {
  angelegt += 1;
  beiDeepL = eintraege.entries();
  return { glossaryId: `attrappe-${angelegt}` };
};
deepl.Translator.prototype.deleteGlossary = async function () {};
deepl.Translator.prototype.getGlossaryEntries = async function () { return { entries: () => ({ ...beiDeepL }) }; };

const { pool } = await laden('db', 'connection.js');
const { fuehreZusammen, pruefeSicherung } = await laden('scripts', 'wortliste-zusammenfuehren.js');
const { leseEntscheide } = await laden('services', 'wortliste-umzug.js');
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

const MIGRATIONEN = join(WURZEL, 'migrations');
const TESTSEED = readFileSync(join(WURZEL, 'seeds', 'test', '010_channels.sql'), 'utf-8');
const migriere = async () => {
  for (const f of readdirSync(MIGRATIONEN).filter((n) => n.endsWith('.sql')).sort()) await q(readFileSync(join(MIGRATIONEN, f), 'utf-8')); await q(TESTSEED);
};

// ── Bestand ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function aufbauen() {
  await q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migriere();
  // Wie im echten Bestand: Dort fehlt der Schlüssel je Schreibung, weil 2 exakte Dubletten ihn verhindern (Migration 038 warnt).
  await q('DROP INDEX uq_glossary_entries_schreibung');
  const G = {};
  for (const s of ['EN', 'FR', 'HU', 'IT']) {
    G[s] = (await q(`INSERT INTO glossaries (name, source_lang, target_lang) VALUES ($1, 'DE', $2) RETURNING id`, [`Glossar DE→${s}`, s])).rows[0].id;
  }
  const zeile = async (s, d, z, extra = {}) => (await q(
    `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, created_at) VALUES ($1, $2, $3, TRUE, $4) RETURNING id`,
    [G[s], d, z, extra.am ?? new Date()])).rows[0].id;
  const flex = await zeile('EN', 'Flexband', 'flex strip');
  await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPA', 'LED strip')`, [flex]);
  for (const [d, z] of [['Cover', 'Cover'], ['COVER', 'COVER'], ['Raster', 'grid'], ['Hallenleuchte', 'high-bay luminaire'],
    ['MALE', 'MALE'], ['exkl. Leuchtmittel', 'excl. bulb'], ['Profil', 'profile']]) await zeile('EN', d, z);
  // Exakte Dublette in HU wie im Bestand (gleiches Ziel), der Channel-Wert hängt an der jüngeren Zeile.
  await zeile('HU', 'Profil', 'profil', { am: new Date('2026-01-01') });
  const zweite = await zeile('HU', 'Profil', 'profil', { am: new Date('2026-02-01') });
  await q(`INSERT INTO glossary_entry_channels (entry_id, channel_code, target_term) VALUES ($1, 'SHOPB', 'profilsín')`, [zweite]);
  await zeile('IT', 'Profil', 'profilo');

  const B = {};
  const baustein = async (art, d, z, extra = {}) => {
    B[d + (extra.gruppe ?? '')] = (await q(
      `INSERT INTO namens_bausteine (sprache, art, deutsch, ziel, produktgruppe, wortart, genus, formen, quelle, freigegeben_von)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pruefung', 'Test') RETURNING id`,
      [extra.sprache ?? 'EN', art, d, z, extra.gruppe ?? null, extra.wortart ?? null, extra.genus ?? null, extra.formen ?? null])).rows[0].id;
  };
  await baustein('wort', 'Flexband', 'flex strip', { wortart: 'hauptwort', genus: 'm' });
  await baustein('wort', 'Cover', 'cover');
  await baustein('wort', 'Cover', 'diffuser', { gruppe: 16 });
  await baustein('fest', 'Raster', 'Raster');
  await baustein('wort', 'Hallenleuchte', 'high bay');
  await baustein('fest', 'male', 'male');
  await baustein('muster', '#m Rolle', '#m roll');
  await baustein('wendung', 'exkl. Leuchtmittel', 'lamp not included');
  await baustein('wort', 'Profil', 'profile');
  const VORL = `INSERT INTO namens_bausteine_vorlaeufig (sprache, art, deutsch, quelle, vorschlag_markt, vorschlag_deepl, status, anmerkung, bearbeitet_von, beispiele)
                VALUES ('EN', 'wort', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`;
  const V = {};
  V.endkappe = (await q(VORL, ['Endkappe', 'markt', 'end cap', null, 'vorschlag', null, null, ['Endkappe für Profil X']])).rows[0].id;
  V.klemme = (await q(VORL, ['Klemme', 'deepl', null, 'clamp', 'rueckfrage', 'Klemme oder Clip?', 'p@example.invalid', []])).rows[0].id;
  V.buegel = (await q(VORL, ['Bügel', 'deepl', null, 'bracket', 'abgelehnt', 'passt nicht', 'p@example.invalid', []])).rows[0].id;
  // Ein Einleseprotokoll-Eintrag, der auf einen Baustein zeigt.
  await q(`INSERT INTO namens_einlesen_protokoll (lauf, datei, datei_sha256, sprache, blatt_zeile, nummer, thema, deutsch, vorschlag, ergebnis, baustein_id, von)
           VALUES (gen_random_uuid(), 'Pruefung_EN.xlsx', repeat('a', 64), 'EN', 3, 1, 'Flexband', 'Flexband', 'flex strip', 'freigegeben', $1, 'Test')`, [B.Flexband]);
  return { G, B, V };
}

const ENTSCHEIDE_EN = leseEntscheide([
  'deutsch\tziel\tziel_name\tart\tquelle',
  'Cover\tcover\t\t\tpruefung',
  'Raster\tGrid\t\twort\tthomas',
  'Hallenleuchte\thigh bay\t\t\tpruefung',
  'exkl. Leuchtmittel\tlamp not included\texcl. bulb\t\tthomas',
].join('\n'));
const LAUF = (o = {}) => ({ wer: 'Test', sprachen: ['EN', 'FR', 'HU', 'IT'], entscheide: { EN: ENTSCHEIDE_EN }, ausfuehren: false, ...o });
const stand = async () => (await q(`
  SELECT (SELECT md5(string_agg(e.id::text || e.source_term || COALESCE(e.target_term, '') || e.art || e.an_deepl::text || COALESCE(e.ziel_name, ''), ',' ORDER BY e.id)) FROM glossary_entries e) AS zeilen,
         (SELECT md5(COALESCE(string_agg(entry_id::text || channel_code || target_term, ',' ORDER BY entry_id, channel_code), '')) FROM glossary_entry_channels) AS kanaele,
         (SELECT count(*) FROM glossary_entry_gruppen) AS gruppen, (SELECT count(*) FROM wortliste_umzug) AS umzug,
         (SELECT count(*) FROM wortliste_herkunft) AS herkunft, (SELECT max(nummer) FROM namens_bausteine_fassung WHERE sprache = 'EN') AS fassung_en`)).rows[0];
const fassung = async (s) => (await q(`SELECT COALESCE(max(nummer), 0)::int AS n FROM namens_bausteine_fassung WHERE sprache = $1`, [s])).rows[0].n;
const frei = async (s, d) => (await q(`SELECT * FROM wortliste_freigegeben WHERE sprache = $1 AND deutsch = $2`, [s, d])).rows[0];

console.log('Wortliste Phase 3 (Zusammenführen)');

await pruefe('Entscheiddatei: Doppel und fehlende Spalten werden abgewiesen', async () => {
  assert.throws(() => leseEntscheide('deutsch\tziel\tziel_name\tart\tquelle\nCover\tcover\t\t\t\nCover\tCover\t\t\t'), /doppelt/u);
  assert.throws(() => leseEntscheide('deutsch\tziel\nCover\tcover'), /Spalte/u);
});

// Die echte Entscheiddatei gehört zu den Daten einer Installation und liegt nicht in jedem Baum (öffentliches Repo: nicht).
// Fehlt sie, wird der Fall sichtbar übersprungen, nicht still grün gezählt.
const ECHTE_ENTSCHEIDE = join(WURZEL, 'wortliste', 'entscheide-EN.tsv');
if (existsSync(ECHTE_ENTSCHEIDE)) {
  await pruefe('Entscheiddatei: die echte EN-Datei liest sich, 16 Begriffe, Raster als Wort, eine Ausnahme im Namen', async () => {
    const e = leseEntscheide(readFileSync(ECHTE_ENTSCHEIDE, 'utf-8'));
    assert.equal(e.length, 16);
    assert.deepEqual(e.find((x) => x.deutsch === 'Raster'), { deutsch: 'Raster', ziel: 'Grid', zielName: null, art: 'wort', quelle: 'thomas' });
    assert.deepEqual(e.filter((x) => x.zielName).map((x) => [x.deutsch, x.ziel, x.zielName]), [['exkl. Leuchtmittel', 'lamp not included', 'excl. bulb']]);
  });
} else {
  console.log('  –  übersprungen: echte Entscheiddatei wortliste/entscheide-EN.tsv fehlt in diesem Baum');
}

let T = await aufbauen();
await pruefe('Trockenlauf: rechnet alles, schreibt nichts, keine Sprache gesperrt', async () => {
  const vorher = await stand();
  const e = await fuehreZusammen(LAUF());
  assert.equal(e.ausgefuehrt, false);
  assert.deepEqual(e.berichte.flatMap((b) => b.abweichungen), []);
  assert.deepEqual(await stand(), vorher);
});

await pruefe('ohne Entscheid für einen anderen Wert: Halt mit Grund, nichts geschrieben, auch nicht in den übrigen Sprachen', async () => {
  const vorher = await stand();
  const e = await fuehreZusammen(LAUF({ entscheide: { EN: ENTSCHEIDE_EN.filter((x) => x.deutsch !== 'Hallenleuchte') }, ausfuehren: true }));
  assert.equal(e.ausgefuehrt, false);
  assert.ok(e.berichte.find((b) => b.sprache === 'EN').abweichungen.some((a) => /Hallenleuchte.*ohne Entscheid/u.test(a)));
  assert.deepEqual(await stand(), vorher);
});

await pruefe('Gegenprobe: eine fremde Änderung im selben Lauf (andere DeepL-Zeile, zusätzliche Zeile) fällt auf, nichts ausgeführt', async () => {
  const vorher = await stand();
  // Ein Trigger, der beim Umschreiben von „Cover“ eine andere Zeile ändert und eine dazulegt, wie ein vergessener Nebenweg.
  await q(`CREATE FUNCTION probe_fremd() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source_term = 'Cover' AND NEW.target_term = 'cover' AND OLD.target_term = 'Cover' THEN
        UPDATE glossary_entries SET target_term = 'profile system' WHERE glossary_id = NEW.glossary_id AND source_term = 'Profil';
        INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES (NEW.glossary_id, 'Fremdzeile', 'x', TRUE);
      END IF;
      RETURN NULL;
    END $$`);
  await q(`CREATE TRIGGER probe_fremd AFTER UPDATE ON glossary_entries FOR EACH ROW EXECUTE FUNCTION probe_fremd()`);
  try {
    const e = await fuehreZusammen(LAUF({ ausfuehren: true }));
    assert.equal(e.ausgefuehrt, false);
    const a = e.berichte.find((b) => b.sprache === 'EN').abweichungen;
    assert.ok(a.some((x) => /an DeepL änderte sich „Profil“ ohne Entscheid/u.test(x)), a.join(' | '));
    assert.ok(a.some((x) => /Zeilen im Glossar, erwartet/u.test(x)), a.join(' | '));
  } finally {
    await q(`DROP TRIGGER probe_fremd ON glossary_entries; DROP FUNCTION probe_fremd()`);
  }
  assert.deepEqual(await stand(), vorher);
});

const fVorher = { EN: await fassung('EN'), FR: await fassung('FR'), HU: await fassung('HU'), IT: await fassung('IT') };
const zeilenVorher = (await q(`SELECT g.target_lang, count(*)::int AS n FROM glossary_entries e JOIN glossaries g ON g.id = e.glossary_id GROUP BY 1`)).rows;
let E;
await pruefe('Ausführen: Zählung je Sprache geht auf, Fassung je Sprache genau +1', async () => {
  E = await fuehreZusammen(LAUF({ ausfuehren: true }));
  assert.equal(E.ausgefuehrt, true);
  const en = E.berichte.find((b) => b.sprache === 'EN');
  assert.deepEqual(en.bausteine, { gesamt: 9, schonUmgezogen: 0, gleich: 2, entschieden: 4, neu: 2, gruppe: 1 });
  assert.deepEqual(en.vorlaeufig, { offen: 2, abgelehnt: 1, schonInDerListe: 0 });
  assert.equal(en.eingefuegt, 4, 'male, #m Rolle, Endkappe, Klemme');
  const vorher = Object.fromEntries(zeilenVorher.map((r) => [r.target_lang, r.n]));
  assert.equal(en.glossarNachher, vorher.EN + 4);
  const hu = E.berichte.find((b) => b.sprache === 'HU');
  assert.equal(hu.dublettenEntfernt, 1);
  assert.equal(hu.glossarNachher, vorher.HU - 1);
  for (const s of ['EN', 'FR', 'HU', 'IT']) assert.equal(await fassung(s), fVorher[s] + 1, s);
});

await pruefe('nach dem Umzug stehen die Bausteine mit dem erwarteten Ziel in der Sicht für Namen', async () => {
  const flex = await frei('EN', 'Flexband');
  assert.deepEqual([flex.ziel, flex.art, flex.an_deepl, flex.wortart, flex.genus, flex.kanaele], ['flex strip', 'wort', true, 'hauptwort', 'm', { SHOPA: 'LED strip' }]);
  const cover = await frei('EN', 'Cover');
  assert.deepEqual([cover.ziel, cover.an_deepl, cover.gruppen.map((g) => [g.produktgruppe, g.ziel])], ['cover', true, [[16, 'diffuser']]]);
  assert.equal((await frei('EN', 'COVER')).ziel, 'COVER', 'die Blockschrift-Zeile bleibt daneben');
  const raster = await frei('EN', 'Raster');
  assert.deepEqual([raster.ziel, raster.art], ['Grid', 'wort']);
  const exkl = await frei('EN', 'exkl. Leuchtmittel');
  assert.deepEqual([exkl.ziel, exkl.ziel_name, exkl.art, exkl.an_deepl], ['lamp not included', 'excl. bulb', 'wendung', true]);
  const male = await frei('EN', 'male');
  assert.deepEqual([male.ziel, male.art, male.an_deepl], ['male', 'fest', false]);
  assert.equal((await frei('EN', 'MALE')).ziel, 'MALE');
  const rolle = await frei('EN', '#m Rolle');
  assert.deepEqual([rolle.ziel, rolle.art, rolle.an_deepl], ['#m roll', 'muster', false]);
});

await pruefe('Vorschläge: offen mit Herkunft, Rückfrage mit Text, abgelehnter nur als Spur', async () => {
  const o = (await q(`SELECT * FROM wortliste_offen WHERE sprache = 'EN' ORDER BY deutsch`)).rows;
  assert.deepEqual(o.map((r) => [r.deutsch, r.status, r.ziel]), [['Endkappe', 'vorschlag', 'end cap'], ['Klemme', 'rueckfrage', 'clamp']]);
  assert.equal(o.find((r) => r.deutsch === 'Klemme').rueckfrage, 'Klemme oder Clip?');
  assert.deepEqual(o.find((r) => r.deutsch === 'Endkappe').beispiele, ['Endkappe für Profil X']);
  assert.equal((await q(`SELECT count(*)::int AS n FROM wortliste_abgelehnt WHERE source_term = 'Bügel'`)).rows[0].n, 1);
  assert.equal((await q(`SELECT count(*)::int AS n FROM glossary_entries WHERE source_term = 'Bügel'`)).rows[0].n, 0);
});

await pruefe('DeepL: genau die entschiedenen Wörter ändern sich, abgeglichen und zurückgelesen gleich', async () => {
  const en = E.berichte.find((b) => b.sprache === 'EN');
  assert.deepEqual([...en.deepl.geaendert].sort(), ['Cover', 'Hallenleuchte', 'Raster', 'exkl. Leuchtmittel']);
  assert.deepEqual(E.berichte.filter((b) => b.sprache !== 'EN').flatMap((b) => b.deepl.geaendert), [], 'die Dublette ändert DeepL nicht');
  assert.deepEqual(E.deepl.map((d) => [d.sprache, d.synchron, d.falsch]), [['EN', true, []]]);
  assert.equal(beiDeepL.Raster, 'Grid');
  assert.equal(beiDeepL['#m Rolle'], undefined, 'ein Muster geht nie an DeepL');
  assert.equal(beiDeepL.male, undefined, 'ein neues Namenswort geht nicht an DeepL');
});

await pruefe('Dublette zusammengelegt: der Channel-Wert zog zur bleibenden Zeile, der Schlüssel je Schreibung steht', async () => {
  const hu = (await q(`SELECT e.id, (SELECT jsonb_object_agg(channel_code, target_term) FROM glossary_entry_channels c WHERE c.entry_id = e.id) AS k
                         FROM glossary_entries e JOIN glossaries g ON g.id = e.glossary_id WHERE g.target_lang = 'HU' AND e.source_term = 'Profil'`)).rows;
  assert.equal(hu.length, 1);
  assert.deepEqual(hu[0].k, { SHOPB: 'profilsín' });
  assert.equal(E.schluessel, 'angelegt');
  await assert.rejects(q(`INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved) VALUES ($1, 'Profil', 'x', TRUE)`, [T.G.IT]), /uq_glossary_entries_schreibung/u);
});

await pruefe('Herkunft, Einleseprotokoll und Verlauf: jede Zeile kennt ihren alten Baustein, der Verlauf den Lauf mit Fassung', async () => {
  assert.equal((await q(`SELECT count(*)::int AS n FROM wortliste_herkunft WHERE sprache = 'EN'`)).rows[0].n, 9 + 3);
  const p = (await q(`SELECT p.entry_id, e.source_term FROM namens_einlesen_protokoll p JOIN glossary_entries e ON e.id = p.entry_id`)).rows;
  assert.deepEqual(p.map((r) => r.source_term), ['Flexband']);
  const v = (await q(`SELECT DISTINCT changed_by_name, fassung FROM glossary_entry_history h JOIN glossaries g ON g.id = h.glossary_id
                       WHERE g.target_lang = 'EN' AND h.source_term = 'Raster' AND h.field = 'standard' AND h.action = 'updated'`)).rows;
  assert.deepEqual(v, [{ changed_by_name: 'Zusammenführung Wortliste: Test', fassung: fVorher.EN + 1 }]);
});

await pruefe('Sperre je Sprache: EN nimmt in der alten Tabelle nichts mehr an, FR (kein Umzug) noch', async () => {
  await assert.rejects(q(`INSERT INTO namens_bausteine (sprache, art, deutsch, ziel, quelle, freigegeben_von) VALUES ('EN', 'wort', 'Neu', 'new', 'pruefung', 'Test')`),
    /umgezogen/u);
  await assert.rejects(q(`UPDATE namens_bausteine_vorlaeufig SET status = 'vorschlag' WHERE sprache = 'EN'`), /umgezogen/u);
  await q(`INSERT INTO namens_bausteine (sprache, art, deutsch, ziel, quelle, freigegeben_von) VALUES ('FR', 'wort', 'Profil', 'profilé', 'pruefung', 'Test')`);
});

await pruefe('zweiter Lauf ohne Neues: nichts geändert, keine neue Fassung', async () => {
  const vorher = await stand();
  const fr = await fassung('FR');
  const e = await fuehreZusammen(LAUF({ sprachen: ['EN', 'HU', 'IT'], ausfuehren: true }));
  assert.equal(e.ausgefuehrt, true);
  assert.deepEqual(e.berichte.map((b) => b.bausteine.gesamt), [0, 0, 0]);
  assert.deepEqual(await stand(), vorher);
  assert.equal(await fassung('FR'), fr);
});

await pruefe('später eingelesene Sprache: ein neuer Lauf nimmt FR mit und sperrt FR danach', async () => {
  const fr = await fassung('FR');
  const e = await fuehreZusammen(LAUF({ sprachen: ['FR'], ausfuehren: true }));
  const b = e.berichte[0];
  assert.deepEqual([b.bausteine.gesamt, b.bausteine.neu, b.abweichungen], [1, 1, []]);
  assert.equal((await frei('FR', 'Profil')).ziel, 'profilé');
  assert.equal(await fassung('FR'), fr + 1);
  await assert.rejects(q(`INSERT INTO namens_bausteine (sprache, art, deutsch, ziel, quelle, freigegeben_von) VALUES ('FR', 'wort', 'Clip', 'clip', 'pruefung', 'Test')`), /umgezogen/u);
});

await pruefe('Sicherung: fehlend, leer oder ohne die Tabellen wird abgewiesen, eine echte geht durch', async () => {
  const ordner = mkdtempSync(join(tmpdir(), 'wortliste-'));
  const leer = join(ordner, 'leer.sql');
  writeFileSync(leer, '');
  const halb = join(ordner, 'halb.sql');
  writeFileSync(halb, 'CREATE TABLE public.glossary_entries (\n');
  const ganz = join(ordner, 'ganz.sql');
  writeFileSync(ganz, ['glossary_entries', 'glossary_entry_channels', 'glossary_entry_history', 'namens_bausteine', 'namens_bausteine_vorlaeufig']
    .map((t) => `CREATE TABLE public.${t} (\n  id uuid\n);`).join('\n'));
  assert.match(pruefeSicherung(join(ordner, 'gibtsnicht.sql')), /fehlt/u);
  assert.match(pruefeSicherung(leer), /leer/u);
  assert.match(pruefeSicherung(halb), /enthält glossary_entry_channels nicht/u);
  assert.equal(pruefeSicherung(ganz), null);
});

await pool.end();
console.log(`\n${ok} grün, ${fehler.length} rot`);
process.exit(fehler.length ? 1 : 0);
