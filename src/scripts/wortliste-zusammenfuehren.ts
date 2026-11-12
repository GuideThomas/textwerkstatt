/**
 * Zieht die Namensbausteine ins Glossar um: eine Wortliste je Sprache (Plan `PLAN-wortliste.md` §4, Cockpit #1831).
 *
 * Liegt unter `src/`, weil der Deploy nur `dist/` und `migrations/` überträgt. Die Entscheiddateien (`wortliste/entscheide-<SPRACHE>.tsv`)
 * kommen deshalb von Hand an den Server. Am Server, in dieser Reihenfolge:
 *
 *   1. Sicherung ziehen und hineinsehen:
 *        sudo -u postgres pg_dump -d translationtool -t glossaries -t 'glossary_*' -t 'namens_*' -t 'wortliste_*' \
 *          > /root/backup-translationtool/vor-wortliste-<Datum>.sql
 *        grep -c 'CREATE TABLE' /root/backup-translationtool/vor-wortliste-<Datum>.sql
 *   2. Trockenlauf (rechnet je Sprache, rollt zurück, schreibt nichts):
 *        cd /opt/translationtool && node dist/scripts/wortliste-zusammenfuehren.js "<wer>" --entscheide <ordner>
 *   3. Ausführen, nur mit Sicherung:
 *        … --entscheide <ordner> --sicherung /root/backup-translationtool/vor-wortliste-<Datum>.sql --ausfuehren
 *
 * 🚨 ALLES ODER NICHTS ÜBER DIE SPRACHEN. Erst laufen alle Sprachen als Trockenlauf. Weicht eine ab, wird keine ausgeführt. Erst wenn
 * alle sauber sind, läuft jede Sprache in einer eigenen Transaktion noch einmal und wird committet; weicht sie dabei doch ab (ein
 * gleichzeitiger Schreibweg), rollt sie zurück und der Lauf endet mit Fehler.
 *
 * Danach: DeepL abgleichen und zurücklesen, wo sich etwas geändert hat, und den Schlüssel je Schreibung anlegen (Migration 038 legt ihn
 * sonst beim nächsten Deploy an).
 *
 * Rückweg: Sicherung einspielen. Die alten Tabellen bleiben bis Phase 7 unverändert stehen.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../db/connection';
import { fuehreSpracheZusammen, leseEntscheide, UMZUG_SPRACHEN, type Entscheid, type UmzugBericht } from '../services/wortliste-umzug';
import { ensureGlossarySynced, leseDeepLGlossarEintraege } from '../services/deepl';

export interface Lauf {
  wer: string;
  sprachen: string[];
  entscheide: Record<string, Entscheid[]>;
  ausfuehren: boolean;
}

export interface LaufErgebnis {
  ausgefuehrt: boolean;
  berichte: UmzugBericht[];
  deepl: Array<{ sprache: string; synchron: boolean; falsch: string[] }>;
  schluessel: 'angelegt' | 'vorhanden' | 'dubletten' | 'nicht_versucht';
}

async function eineSprache(sprache: string, lauf: Lauf, commit: boolean): Promise<UmzugBericht> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const b = await fuehreSpracheZusammen(c, sprache, lauf.entscheide[sprache] ?? [], lauf.wer);
    if (commit && b.abweichungen.length === 0) await c.query('COMMIT');
    else await c.query('ROLLBACK');
    return b;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function fuehreZusammen(lauf: Lauf): Promise<LaufErgebnis> {
  const ergebnis: LaufErgebnis = { ausgefuehrt: false, berichte: [], deepl: [], schluessel: 'nicht_versucht' };
  for (const s of lauf.sprachen) ergebnis.berichte.push(await eineSprache(s, lauf, false));
  if (!lauf.ausfuehren || ergebnis.berichte.some((b) => b.abweichungen.length > 0)) return ergebnis;

  ergebnis.berichte = [];
  for (const s of lauf.sprachen) {
    const b = await eineSprache(s, lauf, true);
    ergebnis.berichte.push(b);
    if (b.abweichungen.length > 0) throw new Error(`${s}: beim Ausführen abgewichen, zurückgerollt (vorige Sprachen sind committet): ${b.abweichungen[0]}`);
  }
  ergebnis.ausgefuehrt = true;

  // Nach dem Commit: Scheitert DeepL, ist die Wortliste trotzdem umgezogen. Der Fehler steht im Bericht und färbt den Lauf rot; der
  // Abgleich holt die nächste Übersetzung nach (`ensureGlossarySynced`), oder er wird mit `POST /api/glossaries/:id/sync-deepl` angestoßen.
  for (const b of ergebnis.berichte.filter((x) => x.deepl.geaendert.length > 0)) {
    let id: string | undefined;
    const falsch: string[] = [];
    try {
      id = await ensureGlossarySynced('DE', b.sprache);
    } catch (err) {
      falsch.push(`DeepL-Abgleich gescheitert: ${err instanceof Error ? err.message : String(err)}`);
    }
    const g = (await pool.query<{ id: string; version: number; synced_version: number }>(
      `SELECT id, version, synced_version FROM glossaries WHERE source_lang = 'DE' AND target_lang = $1`, [b.sprache])).rows[0];
    if (id) {
      const bei = await leseDeepLGlossarEintraege(id);
      const soll = (await pool.query<{ source_term: string; target_term: string }>(
        `SELECT source_term, target_term FROM glossar_an_deepl WHERE glossary_id = $1`, [g.id])).rows;
      if (Object.keys(bei).length !== soll.length) falsch.push(`DeepL hält ${Object.keys(bei).length} Einträge, die Liste ${soll.length}`);
      for (const z of soll) if (bei[z.source_term] !== z.target_term) falsch.push(`${z.source_term}: DeepL „${bei[z.source_term] ?? ''}“`);
    }
    ergebnis.deepl.push({ sprache: b.sprache, synchron: !!id && g.synced_version === g.version, falsch: falsch.slice(0, 20) });
  }

  const dubletten = (await pool.query(
    `SELECT 1 FROM glossary_entries GROUP BY glossary_id, btrim(source_term) HAVING count(*) > 1 LIMIT 1`)).rows.length > 0;
  if (dubletten) ergebnis.schluessel = 'dubletten';
  else {
    const da = (await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_glossary_entries_schreibung'`)).rows.length > 0;
    if (!da) await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_glossary_entries_schreibung ON glossary_entries (glossary_id, btrim(source_term))`);
    ergebnis.schluessel = da ? 'vorhanden' : 'angelegt';
  }
  return ergebnis;
}

/** Die Sicherung muss es geben und sie muss die Tabellen enthalten, die der Lauf ändert. Hineinsehen, nicht nachsehen. */
export function pruefeSicherung(pfad: string): string | null {
  if (!existsSync(pfad) || statSync(pfad).size === 0) return `Sicherung ${pfad} fehlt oder ist leer`;
  const text = readFileSync(pfad, 'utf-8');
  for (const t of ['glossary_entries', 'glossary_entry_channels', 'glossary_entry_history', 'namens_bausteine', 'namens_bausteine_vorlaeufig']) {
    if (!new RegExp(`CREATE TABLE public\\.${t} \\(`).test(text)) return `Sicherung ${pfad} enthält ${t} nicht`;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wert = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ausfuehren = args.includes('--ausfuehren');
  const wer = args.find((a, i) => !a.startsWith('--') && !['--entscheide', '--sicherung', '--sprachen'].includes(args[i - 1] ?? ''));
  const ordner = wert('--entscheide');
  if (!wer || !ordner) {
    console.error('Aufruf: node dist/scripts/wortliste-zusammenfuehren.js "<wer>" --entscheide <ordner> [--sprachen EN,FR] [--sicherung <datei> --ausfuehren]');
    process.exit(2);
  }
  if (ausfuehren) {
    const s = wert('--sicherung');
    const f = s ? pruefeSicherung(s) : 'Ausführen nur mit --sicherung <datei>';
    if (f) { console.error(`ABBRUCH: ${f}`); process.exit(2); }
  }
  const sprachen = (wert('--sprachen') ?? UMZUG_SPRACHEN.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const entscheide: Record<string, Entscheid[]> = {};
  for (const s of sprachen) {
    const d = join(ordner, `entscheide-${s}.tsv`);
    if (existsSync(d)) entscheide[s] = leseEntscheide(readFileSync(d, 'utf-8'));
  }

  const e = await fuehreZusammen({ wer, sprachen, entscheide, ausfuehren });
  for (const b of e.berichte) {
    console.log(`\n${b.sprache}: Glossar ${b.glossarVorher} → ${b.glossarNachher} Zeilen (Dubletten −${b.dublettenEntfernt}, neu +${b.eingefuegt}), Fassung ${b.fassungVorher} → ${b.fassungNachher}`);
    console.log(`  Bausteine ${b.bausteine.gesamt} (schon umgezogen ${b.bausteine.schonUmgezogen}): gleich ${b.bausteine.gleich}, entschieden ${b.bausteine.entschieden}, neu ${b.bausteine.neu}, Gruppenziel ${b.bausteine.gruppe}`);
    console.log(`  Vorschläge: offen ${b.vorlaeufig.offen}, abgelehnt ${b.vorlaeufig.abgelehnt}, schon in der Liste ${b.vorlaeufig.schonInDerListe}`);
    console.log(`  DeepL: ${b.deepl.vorher} → ${b.deepl.nachher} Einträge, geändert ${b.deepl.geaendert.length}${b.deepl.geaendert.length ? ` (${b.deepl.geaendert.join(', ')})` : ''}`);
    if (b.entscheideUngenutzt.length) console.log(`  Entscheide ohne Baustein: ${b.entscheideUngenutzt.join(', ')}`);
    for (const a of b.abweichungen) console.log(`  ABWEICHUNG: ${a}`);
  }
  for (const d of e.deepl) console.log(`\nDeepL ${d.sprache}: ${d.synchron ? 'abgeglichen' : 'NICHT abgeglichen'}${d.falsch.length ? `, falsch: ${d.falsch.join('; ')}` : ', zurückgelesen gleich'}`);
  console.log(`\n${e.ausgefuehrt ? 'AUSGEFÜHRT' : 'Trockenlauf, nichts geschrieben'}; Schlüssel je Schreibung: ${e.schluessel}`);
  if (e.berichte.some((b) => b.abweichungen.length > 0) || e.deepl.some((d) => !d.synchron || d.falsch.length > 0)) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => pool.end());
}
