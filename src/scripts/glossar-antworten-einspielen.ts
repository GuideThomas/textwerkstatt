/**
 * Spielt die Antworten eines Muttersprachlers auf das Glossar-Blatt ein (`services/glossar-antworten.ts`).
 *
 * Liegt unter `src/`, weil der Deploy nur `dist/` überträgt und `scripts/` nicht. Am Server:
 *
 *   cd /opt/translationtool && node dist/scripts/glossar-antworten-einspielen.js EN <antworten.tsv> "<wer>"
 *   cd /opt/translationtool && node dist/scripts/glossar-antworten-einspielen.js EN <antworten.tsv> "<wer>" --ausfuehren
 *
 * Die Liste hat die Spalten `zeile, deutsch, heute, vorschlag, entscheidung`, so wie sie aus dem Blatt der Sprache gezogen wird
 * (`Artikelanlage-Assistent/docs/analyse-artikelnamen/antworten/<SPRACHE>/README.md`). `<wer>` steht im Verlauf als Bearbeiter;
 * Namen der Prüfer werden nicht geführt (Thomas 06.11.2026), es steht die Rolle da.
 *
 * Ohne `--ausfuehren` wird alles gerechnet und zurückgerollt. Die Transaktion rollt auch zurück, wenn eine Zeile nicht mehr dem
 * Stand des Blatts entspricht oder sich eine Zeile außerhalb der geplanten verändert hätte. Nach dem Einspielen wird das Glossar
 * sofort mit DeepL abgeglichen und dort zurückgelesen, statt auf die nächste Übersetzung zu warten.
 * Rückweg: Der Verlauf trägt je Zeile den alten Wert (`changed_by_name` = `<wer>`).
 */
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { leseAntworten, spieleAntwortenEin, type Aenderung } from '../services/glossar-antworten';
import { ensureGlossarySynced, leseDeepLGlossarEintraege } from '../services/deepl';
import { normalizeGlossaryLang } from '../services/lang';

export interface EinspielBericht {
  glossar: string;
  ausgefuehrt: boolean;
  abweichungen: string[];
  aenderungen: Aenderung[];
  okZeilen: number;
  hinweiseVerworfen: number;
  versionVorher: number;
  versionNachher: number;
  deepl?: { synchron: boolean; geprueft: number; falsch: string[] };
}

/** Fingerabdruck je Glossarzeile, über alle Glossare. */
async function zeilenStand(c: PoolClient): Promise<Map<string, string>> {
  const r = await c.query<{ id: string; h: string }>(
    `SELECT id, md5(glossary_id::text || '|' || source_term || '|' || COALESCE(target_term, '') || '|' ||
                    COALESCE(approved::text, '') || '|' || COALESCE(context, '') || '|' || COALESCE(category, '')) AS h
       FROM glossary_entries`,
  );
  return new Map(r.rows.map((x) => [x.id, x.h]));
}

async function kanalStand(c: PoolClient): Promise<string> {
  const r = await c.query<{ h: string }>(
    `SELECT md5(COALESCE(string_agg(entry_id::text || channel_code || target_term, ',' ORDER BY entry_id, channel_code), '')) AS h
       FROM glossary_entry_channels`,
  );
  return r.rows[0].h;
}

export async function einspielen(o: { sprache: string; text: string; wer: string; ausfuehren: boolean }): Promise<EinspielBericht> {
  const zeilen = leseAntworten(o.text);
  if (!o.wer.trim()) throw new Error('Wer einspielt, muss genannt sein (Rolle genügt)');
  const sprache = normalizeGlossaryLang(o.sprache);

  const c = await pool.connect();
  let bericht: EinspielBericht;
  try {
    await c.query('BEGIN');
    const g = await c.query<{ id: string; name: string; version: number }>(
      `SELECT id, name, version FROM glossaries WHERE source_lang = 'DE' AND target_lang = $1 FOR UPDATE`,
      [sprache],
    );
    if (g.rows.length !== 1) throw new Error(`Glossar DE→${sprache}: ${g.rows.length} gefunden, erwartet genau eines`);
    const glossar = g.rows[0];

    const vorher = await zeilenStand(c);
    const kanaeleVorher = await kanalStand(c);
    const erg = await spieleAntwortenEin(c, glossar.id, zeilen, o.wer);
    bericht = {
      glossar: glossar.name, ausgefuehrt: false, abweichungen: erg.abweichungen, aenderungen: erg.aenderungen,
      okZeilen: erg.okZeilen, hinweiseVerworfen: erg.hinweiseVerworfen, versionVorher: glossar.version, versionNachher: glossar.version,
    };
    if (erg.abweichungen.length > 0) {
      await c.query('ROLLBACK');
      return bericht;
    }

    // Nur die geplanten Zeilen dürfen sich geändert haben, keine darf dazukommen oder wegfallen.
    const nachher = await zeilenStand(c);
    const geplant = new Set(erg.beruehrt);
    const fremd: string[] = [];
    for (const [id, h] of nachher) if (vorher.get(id) !== h && !geplant.has(id)) fremd.push(id);
    for (const id of vorher.keys()) if (!nachher.has(id)) fremd.push(id);
    for (const id of geplant) if (vorher.get(id) === nachher.get(id)) fremd.push(`${id} (geplant, aber unverändert)`);
    if (fremd.length > 0) throw new Error(`Außerhalb der Planung verändert: ${fremd.slice(0, 5).join(', ')}`);
    if ((await kanalStand(c)) !== kanaeleVorher) throw new Error('Channel-Werte hätten sich verändert');

    bericht.versionNachher = (await c.query<{ version: number }>(`SELECT version FROM glossaries WHERE id = $1`, [glossar.id])).rows[0].version;
    const erwartet = glossar.version + (erg.aenderungen.length > 0 ? 1 : 0);
    if (bericht.versionNachher !== erwartet) throw new Error(`Version ${bericht.versionNachher}, erwartet ${erwartet}`);

    if (!o.ausfuehren) {
      await c.query('ROLLBACK');
      return bericht;
    }
    await c.query('COMMIT');
    bericht.ausgefuehrt = true;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }

  if (bericht.aenderungen.length > 0) {
    const id = await ensureGlossarySynced('DE', sprache);
    const g = (await pool.query<{ version: number; synced_version: number }>(
      `SELECT version, synced_version FROM glossaries WHERE source_lang = 'DE' AND target_lang = $1`, [sprache])).rows[0];
    const falsch: string[] = [];
    if (id) {
      const bei = await leseDeepLGlossarEintraege(id);
      for (const a of bericht.aenderungen) if (bei[a.begriff] !== a.neu) falsch.push(`${a.begriff}: DeepL „${bei[a.begriff] ?? ''}“`);
    }
    bericht.deepl = { synchron: !!id && g.synced_version === g.version, geprueft: bericht.aenderungen.length, falsch };
  }
  return bericht;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ausfuehren = args.includes('--ausfuehren');
  const [sprache, datei, wer] = args.filter((a) => a !== '--ausfuehren');
  if (!sprache || !datei || !wer) {
    console.error('Aufruf: node dist/scripts/glossar-antworten-einspielen.js <SPRACHE> <antworten.tsv> "<wer>" [--ausfuehren]');
    process.exit(2);
  }
  const b = await einspielen({ sprache, text: readFileSync(datei, 'utf-8'), wer, ausfuehren });
  console.log(`Glossar: ${b.glossar}`);
  if (b.abweichungen.length > 0) {
    console.log(`ABWEICHUNGEN (${b.abweichungen.length}), nichts geschrieben:`);
    for (const a of b.abweichungen) console.log(`  ${a}`);
    process.exitCode = 1;
    return;
  }
  const block = b.aenderungen.filter((a) => a.block).length;
  const kanal = b.aenderungen.filter((a) => a.kanalBleibt).length;
  console.log(`Ersetzt: ${b.aenderungen.length - block} Standardwerte, dazu ${block} Blockzeilen; davon ${kanal} mit Channel-Wert (bleibt)`);
  console.log(`OK, unverändert: ${b.okZeilen}; Prüfhinweise verworfen: ${b.hinweiseVerworfen}`);
  console.log(`Version: ${b.versionVorher} → ${b.versionNachher}`);
  for (const a of b.aenderungen) console.log(`  ${a.begriff}: „${a.alt}“ → „${a.neu}“${a.block ? ' (Blockzeile)' : ''}${a.kanalBleibt ? ' [Channel-Wert bleibt]' : ''}`);
  if (!b.ausgefuehrt) {
    console.log('Trockenlauf: zurückgerollt. Mit --ausfuehren schreiben.');
    return;
  }
  console.log(`Geschrieben.`);
  if (b.deepl) {
    console.log(`DeepL: ${b.deepl.synchron ? 'abgeglichen' : 'NICHT abgeglichen'}, ${b.deepl.geprueft - b.deepl.falsch.length} von ${b.deepl.geprueft} Werten dort zurückgelesen`);
    for (const f of b.deepl.falsch) console.log(`  FALSCH ${f}`);
    if (!b.deepl.synchron || b.deepl.falsch.length > 0) process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Abbruch:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
