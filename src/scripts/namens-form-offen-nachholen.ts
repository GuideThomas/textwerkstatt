/**
 * Ordnet Paare neu ein, deren Form beim Einlesen offen blieb (`form_offen`), mit den heutigen Regeln von `klassifiziere`
 * (`services/namens-einlesen.ts`, `holeFormOffenNach`). Anlass: Die 16 EN-Zahlpaare vom 06.11.2026 (`5m Rolle → 5m roll`) warteten
 * auf die Musterform von `bildeName`; seit 10.11.2026 wird daraus `#m Rolle → #m roll` (Cockpit #1810).
 *
 * Liegt unter `src/`, weil der Deploy nur `dist/` überträgt. Am Server:
 *
 *   cd /opt/translationtool && node dist/scripts/namens-form-offen-nachholen.js <SPRACHE> "<wer>"
 *   … dasselbe mit --ausfuehren
 *
 * Ohne `--ausfuehren` wird alles gerechnet und zurückgerollt. Freigegebene Bausteine erhöhen die Fassung der Sprache einmal.
 */
import { pool } from '../db/connection';
import { holeFormOffenNach, type NachholBericht } from '../services/namens-einlesen';

export async function nachholen(o: { sprache: string; wer: string; ausfuehren: boolean }): Promise<NachholBericht & { ausgefuehrt: boolean; fassungVorher: number; fassungNachher: number }> {
  const sprache = o.sprache.trim().toUpperCase();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const fassung = async () => (await c.query<{ n: number }>(
      `SELECT COALESCE(max(nummer), 0)::int AS n FROM namens_bausteine_fassung WHERE sprache = $1`, [sprache])).rows[0].n;
    const fassungVorher = await fassung();
    const b = await holeFormOffenNach(c, { sprache, wer: o.wer });
    const fassungNachher = await fassung();
    const erwartet = fassungVorher + (b.zaehlung.freigegeben > 0 ? 1 : 0);
    if (fassungNachher !== erwartet) throw new Error(`Fassung ${fassungNachher}, erwartet ${erwartet}`);
    for (const l of b.laeufe) {
      const prot = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM namens_einlesen_protokoll WHERE lauf = $1`, [l.lauf])).rows[0].n;
      if (prot !== l.entscheide.length) throw new Error(`Protokoll hat ${prot} Zeilen, erwartet ${l.entscheide.length}`);
    }
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
  const [sprache, wer] = args.filter((a) => a !== '--ausfuehren');
  if (!sprache || !wer) {
    console.error('Aufruf: node dist/scripts/namens-form-offen-nachholen.js <SPRACHE> "<wer>" [--ausfuehren]');
    process.exit(2);
  }
  const b = await nachholen({ sprache, wer, ausfuehren });
  console.log(`Offen gefunden: ${b.offen} | ${Object.entries(b.zaehlung).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`Fassung ${sprache.toUpperCase()}: ${b.fassungVorher} → ${b.fassungNachher}`);
  for (const l of b.laeufe) {
    for (const x of l.entscheide) {
      console.log(`  Z${x.paar.blattZeile} Nr. ${x.paar.nummer} ${x.paar.deutsch} ⇒ ${x.ergebnis}${x.art ? `/${x.art}` : ''} ${x.deutsch} → ${x.ziel}${x.grund ? `  [${x.grund}]` : ''}`);
    }
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
