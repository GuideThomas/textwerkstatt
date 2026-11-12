/**
 * Cleanup: bereits gespeicherte LLM-Halluzinationen im condensed_text aufspüren
 * und entfernen.
 *
 * Workflow:
 *   1. Iteriert alle project_segments mit condensed_text IS NOT NULL
 *   2. Wendet looksHallucinated() an
 *   3. Bei Treffer: condensed_text = NULL, project_segments.condense_status = 'manual_review'
 *
 * Aufruf:
 *   node dist/scripts/cleanup-hallucinations.js                 # dry-run, listet nur
 *   node dist/scripts/cleanup-hallucinations.js --apply          # tatsaechlich loeschen
 *   node dist/scripts/cleanup-hallucinations.js --project <uuid> # nur 1 Projekt
 */

import { pool } from '../db/connection';
import { looksHallucinated } from '../services/condensing';

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

  let hallucinated = 0;
  for (const row of rows.rows) {
    if (!looksHallucinated(row.translated_text, row.condensed_text)) continue;
    hallucinated++;
    console.log(
      `  ⚠ ${row.project_name} #${row.position + 1}\n` +
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

  console.log(`[Cleanup] ${hallucinated} Halluzinationen erkannt${apply ? ` und bereinigt` : ` (dry-run, nichts geaendert — mit --apply ausfuehren)`}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
