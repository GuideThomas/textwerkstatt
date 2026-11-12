/**
 * Remediation: Segment-Cache-Eintraege mit IDML-Style-Markern (`<x id="N"/>`)
 * als stale markieren, damit sie bei der naechsten Uebersetzung NEU (mit DeepL
 * Tag-Handling v1) erzeugt werden statt den fehlerhaften v2-Cache zu treffen.
 *
 * Hintergrund (01.06.2026): DeepL Tag-Handling v2 (Phase 16) hat um die
 * positionsgebundenen Marker Leerzeichen/Satzzeichen eingefuegt → verschobene
 * Zahlen, erfundene Punkte ("Cover<x/>. 20"), Vorlauf-Leerzeichen. Fix erzwingt
 * jetzt v1 fuer den Marker-Pfad; dieser Cache muss invalidiert werden.
 *
 * Wirkung: setzt `is_stale = TRUE` und `condensed_text = NULL` auf allen
 * Cache-Zeilen, deren `source_text` einen `<x ...>`-Marker enthaelt. Die
 * eigentliche Neu-Uebersetzung passiert beim naechsten Re-Upload des Dokuments
 * (die Quelldateien alter Projekte sind durch 24h-Auto-Delete weg, daher ist
 * Re-Upload ohnehin der einzige Weg zu einem korrigierten Download).
 *
 * Aufruf:
 *   node dist/scripts/restale-marker-segments.js            # dry-run, zaehlt nur
 *   node dist/scripts/restale-marker-segments.js --apply     # markieren
 */

import { pool } from '../db/connection';

async function main() {
  const apply = process.argv.includes('--apply');

  const affected = await pool.query<{ count: string; langs: string[] }>(
    `SELECT COUNT(*)::text AS count, ARRAY_AGG(DISTINCT target_lang ORDER BY target_lang) AS langs
       FROM segments
      WHERE source_text ~ '<x\\s+id='`,
  );
  const count = parseInt(affected.rows[0]?.count || '0', 10);
  const langs = affected.rows[0]?.langs || [];

  console.log(
    `[Remediation] ${count} Cache-Segmente mit Style-Markern ` +
      `(Sprachen: ${langs.join(', ') || '–'}) (${apply ? 'APPLY' : 'DRY-RUN'})`,
  );

  if (apply && count > 0) {
    const res = await pool.query(
      `UPDATE segments
          SET is_stale = TRUE, condensed_text = NULL
        WHERE source_text ~ '<x\\s+id='`,
    );
    console.log(`[Remediation] ${res.rowCount} Segmente als stale markiert + condensed_text geleert.`);
    console.log('[Remediation] Naechster Schritt: betroffene IDML-Dokumente neu hochladen → v1-Neuuebersetzung.');
  } else if (!apply) {
    console.log('[Remediation] Dry-run — nichts geaendert. Mit --apply ausfuehren.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
