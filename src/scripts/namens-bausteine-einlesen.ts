/**
 * Liest eine beantwortete Prüftabelle als Namensbausteine ein (`services/namens-einlesen.ts`, Migrationen 033 und 034).
 *
 * Liegt unter `src/`, weil der Deploy nur `dist/` überträgt. Am Server:
 *
 *   cd /opt/translationtool && node dist/scripts/namens-bausteine-einlesen.js <SPRACHE> <paare.tsv> <datei> <sha256> "<wer>" \
 *     --glossar <antworten.tsv>          (oder: --ohne-glossar "<Grund>")
 *   … dasselbe mit --ausfuehren
 *
 * `paare.tsv` hat die Spalten `blatt_zeile, nummer, thema, deutsch, vorschlag, ok, kommentar` (je nummeriertes Paar eine Zeile,
 * `ok` und `kommentar` aus der Zeile des Blatts); `<datei>` und `<sha256>` nennen die beantwortete Datei, deren Paare das sind.
 * `--glossar` ist die Antwortliste des Glossar-Blatts derselben Sprache, wie sie `glossar-antworten-einspielen.js` liest
 * (`zeile, deutsch, heute, vorschlag, entscheidung`). Widerspricht ein Baustein ihr, wird er eine Rückfrage (Entscheid Thomas
 * 10.11.2026). Eine der beiden Angaben ist Pflicht, damit kein Widerspruch still durchrutscht.
 * Ohne `--ausfuehren` wird alles gerechnet und zurückgerollt. Freigegebene Bausteine erhöhen die Fassung der Sprache einmal.
 */
import { readFileSync } from 'node:fs';
import { pool } from '../db/connection';
import { glossarWerte, lesePaare, spielePaareEin, type EinleseBericht, type GlossarAbgleich } from '../services/namens-einlesen';

export async function einlesen(o: { sprache: string; text: string; datei: string; sha256: string; wer: string; glossar: GlossarAbgleich; ausfuehren: boolean }): Promise<EinleseBericht & { ausgefuehrt: boolean; fassungVorher: number; fassungNachher: number }> {
  const paare = lesePaare(o.text);
  const sprache = o.sprache.trim().toUpperCase();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const fassung = async () => (await c.query<{ n: number }>(
      `SELECT COALESCE(max(nummer), 0)::int AS n FROM namens_bausteine_fassung WHERE sprache = $1`, [sprache])).rows[0].n;
    const fassungVorher = await fassung();
    const b = await spielePaareEin(c, { sprache, datei: o.datei, sha256: o.sha256, wer: o.wer, paare, glossar: o.glossar });
    const fassungNachher = await fassung();
    const erwartet = fassungVorher + (b.zaehlung.freigegeben > 0 ? 1 : 0);
    if (fassungNachher !== erwartet) throw new Error(`Fassung ${fassungNachher}, erwartet ${erwartet}`);
    const prot = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM namens_einlesen_protokoll WHERE lauf = $1`, [b.lauf])).rows[0].n;
    if (prot !== b.entscheide.length) throw new Error(`Protokoll hat ${prot} Zeilen, erwartet ${b.entscheide.length}`);
    await c.query(o.ausfuehren ? 'COMMIT' : 'ROLLBACK');
    return { ...b, ausgefuehrt: o.ausfuehren, fassungVorher, fassungNachher };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ausfuehren = args.includes('--ausfuehren');
  const option = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const glossarDatei = option('--glossar');
  const ohneGrund = option('--ohne-glossar');
  const optionen = new Set(['--glossar', '--ohne-glossar']);
  const positional = args.filter((a, i) => a !== '--ausfuehren' && !optionen.has(a) && !optionen.has(args[i - 1]));
  const [sprache, liste, datei, sha256, wer] = positional;
  const aufruf = 'Aufruf: node dist/scripts/namens-bausteine-einlesen.js <SPRACHE> <paare.tsv> <datei> <sha256> "<wer>" '
    + '(--glossar <antworten.tsv> | --ohne-glossar "<Grund>") [--ausfuehren]';
  if (!sprache || !liste || !datei || !sha256 || !wer || positional.length !== 5 || (glossarDatei === undefined) === (ohneGrund === undefined)) {
    console.error(aufruf);
    process.exit(2);
  }
  const glossar: GlossarAbgleich = glossarDatei !== undefined
    ? { datei: glossarDatei, werte: glossarWerte(readFileSync(glossarDatei, 'utf-8')) }
    : { ohne: ohneGrund ?? '' };
  const b = await einlesen({ sprache, text: readFileSync(liste, 'utf-8'), datei, sha256, wer, glossar, ausfuehren });
  console.log(`Paare: ${b.entscheide.length} | ${Object.entries(b.zaehlung).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(b.glossar && 'ohne' in b.glossar
    ? `Glossar-Blatt: nicht abgeglichen (${b.glossar.ohne})`
    : `Glossar-Blatt: ${b.glossar?.datei}, ${b.glossar?.begriffe} Begriffe, ${b.glossar?.widersprueche} Widersprüche → Rückfrage`);
  console.log(`Fassung ${sprache}: ${b.fassungVorher} → ${b.fassungNachher}`);
  for (const art of ['rueckfrage', 'form_offen', 'wertform', 'regel', 'doppelt', 'bekannt'] as const) {
    const e = b.entscheide.filter((x) => x.ergebnis === art);
    if (e.length === 0) continue;
    console.log(`-- ${art} (${e.length})`);
    for (const x of e) console.log(`  Z${x.paar.blattZeile} Nr. ${x.paar.nummer} ${x.deutsch} → ${x.ziel}${x.grund ? `  [${x.grund}]` : ''}`);
  }
  console.log(b.ausgefuehrt ? 'Geschrieben.' : 'Trockenlauf: zurückgerollt. Mit --ausfuehren schreiben.');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('Abbruch:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
