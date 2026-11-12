/**
 * Spielt eine Stufe der Entscheidungsliste ins Glossar ein (PLAN-glossar-nur-abweichungen.md, Phase 3).
 *
 * Liegt unter `src/`, weil der Deploy nur `dist/` überträgt und `scripts/` nicht. Am Server:
 *
 *   cd /opt/translationtool && node dist/scripts/glossar-nur-abweichungen.js <liste.tsv>
 *   cd /opt/translationtool && node dist/scripts/glossar-nur-abweichungen.js <liste.tsv> --ausfuehren
 *
 * Die Liste hat die Spalten `entry_id, folge, deutsch, eintrag, neu`, Folge `leer_entfernen`, `weg` oder `neu`.
 * Ohne `--ausfuehren` wird alles gerechnet und zurückgerollt. Die Transaktion rollt auch zurück, wenn eine Zeile nicht
 * mehr dem Stand der Liste entspricht, die Zählung nicht aufgeht oder sich etwas außerhalb der Liste verändert hätte.
 * Wiederholbar nur mit einer neuen Liste: Nach einem Lauf gibt es die Zeilen nicht mehr, ein zweiter Lauf hält an.
 * Rückweg: Der Verlauf trägt je Zeile den alten Wert (`changed_by_name` wie `WER`). Kontext, Kategorie und Herkunft
 * gelöschter Zeilen stehen nur in der Sicherung, die vorher zu ziehen ist.
 *
 * Zu DeepL kommt das über den Auto-Sync bei der nächsten Übersetzung (`ensureGlossarySynced`).
 */
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { leseListe, wendeListeAn } from '../services/glossar-liste';
import { AKRONYM_KENNWERTE } from '../services/unit-protection';

const WER = 'Bereinigung: Glossar führt nur Abweichungen';

interface Stand {
  zeilen: number;
  mitText: number;
  channels: string;
  schutzkette: string;
  jeSprache: Map<string, { zeilen: number; leer: number }>;
}

async function stand(c: PoolClient): Promise<Stand> {
  const r = await c.query<{ zeilen: number; mit_text: number; channels: string; schutzkette: string }>(
    `SELECT (SELECT count(*)::int FROM glossary_entries) AS zeilen,
            (SELECT count(*)::int FROM glossary_entries WHERE target_term IS NOT NULL) AS mit_text,
            (SELECT md5(COALESCE(string_agg(entry_id::text || channel_code || target_term, ',' ORDER BY entry_id, channel_code), ''))
               FROM glossary_entry_channels) AS channels,
            (SELECT md5(COALESCE(string_agg(id::text || COALESCE(target_term, '') || COALESCE(approved::text, ''), ',' ORDER BY id), ''))
               FROM glossary_entries WHERE source_term = ANY($1::text[]) AND target_term IS NOT NULL) AS schutzkette`,
    [AKRONYM_KENNWERTE],
  );
  const s = await c.query<{ target_lang: string; zeilen: number; leer: number }>(
    `SELECT g.target_lang, count(e.id)::int AS zeilen, count(e.id) FILTER (WHERE e.target_term IS NULL)::int AS leer
       FROM glossaries g LEFT JOIN glossary_entries e ON e.glossary_id = g.id
      WHERE g.source_lang = 'DE' AND g.target_lang <> 'DE'
      GROUP BY g.target_lang`,
  );
  return {
    zeilen: r.rows[0].zeilen,
    mitText: r.rows[0].mit_text,
    channels: r.rows[0].channels,
    schutzkette: r.rows[0].schutzkette,
    jeSprache: new Map(s.rows.map((x) => [x.target_lang, { zeilen: x.zeilen, leer: x.leer }])),
  };
}

/** Fingerabdruck aller Zeilen außer den übergebenen: Sie dürfen sich nicht ändern. */
async function fingerabdruck(c: PoolClient, ausser: string[]): Promise<string> {
  const r = await c.query<{ f: string }>(
    `SELECT md5(COALESCE(string_agg(id::text || source_term || COALESCE(target_term, '') || COALESCE(approved::text, ''), ',' ORDER BY id), '')) AS f
       FROM glossary_entries WHERE NOT (id = ANY($1::uuid[]))`,
    [ausser],
  );
  return r.rows[0].f;
}

async function main(): Promise<number> {
  const argumente = process.argv.slice(2);
  const ausfuehren = argumente.includes('--ausfuehren');
  const pfad = argumente.find((a) => !a.startsWith('--'));
  if (!pfad) {
    console.error('Aufruf: glossar-nur-abweichungen.js <liste.tsv> [--ausfuehren]');
    return 2;
  }
  const zeilen = leseListe(readFileSync(pfad, 'utf-8'));
  console.log(`Liste: ${zeilen.length} Zeilen`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const ids = zeilen.map((z) => z.entryId);
    const vorher = await stand(client);
    const unberuehrtVorher = await fingerabdruck(client, ids);

    const e = await wendeListeAn(client, zeilen, WER);
    if (e.abweichungen.length > 0) {
      await client.query('ROLLBACK');
      console.error(`Zurückgerollt, ${e.abweichungen.length} Zeilen entsprechen nicht mehr der Liste:`);
      for (const a of e.abweichungen.slice(0, 40)) console.error(`  ${a}`);
      return 1;
    }

    const nachher = await stand(client);
    const unberuehrtNachher = await fingerabdruck(client, ids);
    console.log('Sprache  Zeilen vorher → nachher, leer vorher → nachher');
    for (const [sprache, v] of vorher.jeSprache) {
      const n = nachher.jeSprache.get(sprache);
      console.log(`${sprache.padEnd(8)} ${v.zeilen} → ${n?.zeilen}, ${v.leer} → ${n?.leer}`);
    }
    console.log(`Leere Zeilen entfernt: ${e.leerEntfernt}, Zeilen mit Text entfernt: ${e.entfernt}, ersetzt: ${e.ersetzt}, Glossare mit neuer Version: ${e.glossare}`);
    console.log(`Zeilen: ${vorher.zeilen} → ${nachher.zeilen}. Mit Text: ${vorher.mitText} → ${nachher.mitText}`);

    const verdikt: string[] = [];
    if (e.leerEntfernt + e.entfernt + e.ersetzt !== zeilen.length) verdikt.push('Die Zahl der bearbeiteten Zeilen ist nicht die der Liste');
    if (nachher.zeilen !== vorher.zeilen - e.leerEntfernt - e.entfernt) verdikt.push('Die Zählung der Zeilen geht nicht auf');
    if (nachher.mitText !== vorher.mitText - e.entfernt) verdikt.push('Die Zählung der Zeilen mit Text geht nicht auf');
    if (nachher.channels !== vorher.channels) verdikt.push('Ein Channel-Wert hat sich verändert');
    if (nachher.schutzkette !== vorher.schutzkette) verdikt.push('Ein Kennwert der Schutzkette hat sich verändert');
    if (unberuehrtNachher !== unberuehrtVorher) verdikt.push('Eine Zeile außerhalb der Liste hat sich verändert');
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
    console.log('\nEingespielt. Zu DeepL kommt das bei der nächsten Übersetzung über den Auto-Sync.');
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
