/**
 * Cleanup: bereits gespeicherte, fehlerhaft gekuerzte condensed_text-Werte
 * aufspueren und zuruecksetzen.
 *
 * Adressiert die Beschwerde vom 01.06.2026 (Projekt "Halon_Produktinfo1a"):
 *   - Einzelwoerter/Labels wurden zu aggressiv gekuerzt (haetten gar nicht
 *     kondensiert werden duerfen → Quelle <= 2 Woerter).
 *   - Das LLM hat dabei neue Satzzeichen erfunden (Abkuerzungs-Punkte wie
 *     "oldal" → "O.", Aufzaehlungs-Kommas) → addsNewPunctuation().
 *
 * Bei Treffer: condensed_text = NULL, project_segments.condense_status =
 * 'manual_review' (die unverfaelschte DeepL-Uebersetzung wird wieder sichtbar).
 *
 * Aufruf:
 *   node dist/scripts/cleanup-overcondensed.js                 # dry-run, listet nur
 *   node dist/scripts/cleanup-overcondensed.js --apply          # tatsaechlich zuruecksetzen
 *   node dist/scripts/cleanup-overcondensed.js --project <uuid> # nur 1 Projekt
 */

import { pool } from '../db/connection';
import { addsNewPunctuation } from '../services/condensing';

function wordCount(text: string): number {
  return (text.trim().match(/\S+/g) || []).length;
}

/** Grund, warum ein condensed_text als fehlerhaft gilt — oder null wenn ok. */
function condenseDefect(
  sourceText: string,
  translatedText: string,
  condensedText: string,
): string | null {
  if (wordCount(sourceText) <= 2) return 'Einzelwort/Label (≤2 Woerter) — haette nicht gekuerzt werden duerfen';
  if (addsNewPunctuation(translatedText, condensedText)) return 'erfundene Satzzeichen (neue Punkte/Kommas)';
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const projectIdx = process.argv.indexOf('--project');
  const onlyProject = projectIdx > 0 ? process.argv[projectIdx + 1] : null;

  const rows = await pool.query<{
    segment_id: string;
    project_id: string;
    position: number;
    project_name: string;
    source_text: string;
    translated_text: string;
    condensed_text: string;
  }>(
    `SELECT
       s.id AS segment_id,
       ps.project_id,
       ps.position,
       p.original_filename AS project_name,
       s.source_text,
       s.translated_text,
       s.condensed_text
     FROM project_segments ps
     JOIN segments s ON s.id = ps.segment_id
     JOIN projects p ON p.id = ps.project_id
     WHERE s.condensed_text IS NOT NULL
       AND s.translated_text IS NOT NULL
       ${onlyProject ? 'AND ps.project_id = $1' : ''}
     ORDER BY p.created_at DESC, ps.position`,
    onlyProject ? [onlyProject] : [],
  );

  console.log(`[Cleanup] ${rows.rows.length} condensed Segmente werden geprueft (${apply ? 'APPLY' : 'DRY-RUN'})`);

  let defects = 0;
  for (const row of rows.rows) {
    const reason = condenseDefect(row.source_text, row.translated_text, row.condensed_text);
    if (!reason) continue;
    defects++;
    console.log(
      `  ⚠ ${row.project_name} #${row.position + 1} — ${reason}\n` +
        `    DeepL: "${row.translated_text.slice(0, 80)}${row.translated_text.length > 80 ? '…' : ''}"\n` +
        `    LLM:   "${row.condensed_text.slice(0, 80)}${row.condensed_text.length > 80 ? '…' : ''}"`,
    );
    if (apply) {
      await pool.query(
        `UPDATE segments SET condensed_text = NULL WHERE id = $1`,
        [row.segment_id],
      );
      await pool.query(
        `UPDATE project_segments SET condense_status = 'manual_review' WHERE segment_id = $1 AND project_id = $2`,
        [row.segment_id, row.project_id],
      );
    }
  }

  console.log(
    `[Cleanup] ${defects} fehlerhaft gekuerzte Segmente erkannt` +
      (apply ? ` und zurueckgesetzt.` : ` (dry-run, nichts geaendert — mit --apply ausfuehren).`),
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
