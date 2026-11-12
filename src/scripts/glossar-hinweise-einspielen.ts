/**
 * Spielt die Prüfhinweise zu den Glossareinträgen ein (Auftrag Thomas, 04.11.2026).
 *
 * Liegt unter `src/`, weil der Deploy nur `dist/` überträgt und `scripts/` nicht. Am Server:
 *
 *   cd /opt/translationtool && node dist/scripts/glossar-hinweise-einspielen.js <datei.tsv>
 *   cd /opt/translationtool && node dist/scripts/glossar-hinweise-einspielen.js <datei.tsv> --ausfuehren
 *
 * Datei: UTF-8, Tabulator als Trenner, erste Zeile die Spaltennamen
 * `target_lang, source_term, target_term, kategorie, gewissheit, quelle, vorschlag, grund`.
 * Je Eintrag und Kategorie ein Hinweis; `vorschlag` ist die neue Übersetzung und darf leer sein.
 *
 * `--ersetzt-unnoetig`: Die Datei enthält nur Markierungen „unnötig“ und ist deren neuer Stand. Was nicht mehr
 * darin steht, ist widerlegt und fällt weg; ein Verwerfen durch einen Menschen bleibt. Eine leere Datei oder eine, der
 * eine Sprache mit Markierungen fehlt, bricht ab: Sie löschte sonst lautlos alles.
 *
 * Ohne `--ausfuehren` wird alles gerechnet und zurückgerollt. Fehlerhafte Zeilen brechen den Lauf ab,
 * bevor etwas geschrieben wird. Die Transaktion rollt auch zurück, wenn sich ein Eintrag, eine
 * Glossar-Version oder der Cache verändert hätte. Wiederholbar: Ein zweiter Lauf legt nichts neu an
 * und holt verworfene Hinweise nicht zurück.
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../db/connection';
import { entferneWiderlegteUnnoetige, hinweisStand, leseHinweisDatei, spieleHinweiseEin, sprachenOhneErsatz, type HinweisStand } from '../services/glossar-hinweise';

function zeigeStand(titel: string, s: HinweisStand): void {
  console.log(`${titel}: aktiv ${s.aktiv}, verworfen ${s.verworfen}, erledigt ${s.erledigt}`);
}

async function main(): Promise<number> {
  const argumente = process.argv.slice(2);
  const ausfuehren = argumente.includes('--ausfuehren');
  const ersetzt = argumente.includes('--ersetzt-unnoetig');
  const datei = argumente.find((a) => !a.startsWith('--'));
  if (!datei) {
    console.error('Aufruf: node dist/scripts/glossar-hinweise-einspielen.js <datei.tsv> [--ersetzt-unnoetig] [--ausfuehren]');
    return 2;
  }

  const { zeilen, fehler } = leseHinweisDatei(fs.readFileSync(path.resolve(datei), 'utf-8'));
  console.log(`Gelesen: ${zeilen.length} Hinweise aus ${path.basename(datei)}`);
  if (fehler.length > 0) {
    console.error(`\nDatei nicht eingespielt, ${fehler.length} Fehler:\n  ${fehler.join('\n  ')}`);
    return 1;
  }

  if (ersetzt && (zeilen.length === 0 || zeilen.some((z) => !z.kategorie.startsWith('unnoetig_')))) {
    console.error('\n--ersetzt-unnoetig verlangt eine Datei, die nur Markierungen „unnötig“ enthält, und mindestens eine.');
    return 1;
  }

  const client = await pool.connect();
  try {
    // Ein Schnappschuss: Was der laufende Betrieb derweil ändert, löst keinen Fehlalarm aus.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const vorher = await hinweisStand(client);
    zeigeStand('Vorher', vorher);

    const e = await spieleHinweiseEin(client, zeilen);
    if (ersetzt) {
      const fehlen = await sprachenOhneErsatz(client, zeilen);
      if (fehlen.length > 0) {
        await client.query('ROLLBACK');
        console.error(`\nZurückgerollt: Der Datei fehlen Sprachen mit Markierungen: ${fehlen.join(', ')}`);
        return 1;
      }
      console.log(`Widerlegt und entfernt: ${await entferneWiderlegteUnnoetige(client, zeilen)}`);
    }
    const nachher = await hinweisStand(client);
    zeigeStand('Nachher', nachher);
    console.log(`Neu: ${e.neu}, aktualisiert: ${e.aktualisiert}, ohne passenden Eintrag: ${e.ohneEintrag.length}`);
    if (e.bleibtVerworfen > 0) console.log(`Verworfen bleibt: ${e.bleibtVerworfen}`);
    for (const z of e.ohneEintrag.slice(0, 20)) {
      console.log(`  ${z.target_lang}  ${z.source_term} → ${z.target_term}  (Zeile ${z.zeile})`);
    }
    if (e.ohneEintrag.length > 20) console.log(`  … und ${e.ohneEintrag.length - 20} weitere`);

    const verdikt: string[] = [];
    if (e.sprachenOhneGlossar.length > 0) verdikt.push(`kein eindeutiges Glossar für: ${e.sprachenOhneGlossar.join(', ')}`);
    if (vorher.eintraege !== nachher.eintraege) verdikt.push('ein Eintrag hat sich verändert');
    if (vorher.versionen !== nachher.versionen) verdikt.push('eine Glossar-Version hat sich verändert');
    if (vorher.stale !== nachher.stale) verdikt.push('der Cache hat sich verändert');
    if (verdikt.length > 0) {
      await client.query('ROLLBACK');
      console.error(`\nZurückgerollt:\n  ${verdikt.join('\n  ')}`);
      return 1;
    }

    if (!ausfuehren) {
      await client.query('ROLLBACK');
      console.log('\nNur gerechnet, nichts geändert. Einspielen mit --ausfuehren.');
      return 0;
    }
    await client.query('COMMIT');
    console.log('\nEingespielt. Einträge, Glossar-Versionen und Cache sind unverändert.');
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error('Einspielen fehlgeschlagen:', err);
    process.exitCode = 1;
  },
);
