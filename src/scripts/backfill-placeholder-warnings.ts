/**
 * Backfill: Placeholder-Detector ueber bereits importierte Projekte laufen lassen.
 *
 * Liest pro Projekt die Source-Texte aus segments (joined ueber project_segments)
 * und persistiert das Resultat in projects.placeholder_warning.
 *
 * Aufruf:
 *   node dist/scripts/backfill-placeholder-warnings.js [project_id]
 * Ohne Argument: alle Projekte ohne placeholder_warning werden gescannt.
 * Mit project_id: nur dieses eine Projekt (auch wenn bereits gescannt).
 */

import { pool } from '../db/connection';
import { detectPlaceholders } from '../services/placeholder-detector';

async function main() {
  const onlyId = process.argv[2];

  const projectsRes = await pool.query<{ id: string; original_filename: string | null }>(
    onlyId
      ? `SELECT id, original_filename FROM projects WHERE id = $1`
      : `SELECT id, original_filename FROM projects WHERE placeholder_warning IS NULL ORDER BY created_at DESC`,
    onlyId ? [onlyId] : [],
  );

  console.log(`[Backfill] ${projectsRes.rows.length} Projekt(e) zu scannen`);

  let triggered = 0;
  for (const project of projectsRes.rows) {
    const segRes = await pool.query<{ position: number; source_text: string }>(
      `SELECT ps.position, s.source_text
         FROM project_segments ps
         JOIN segments s ON s.id = ps.segment_id
        WHERE ps.project_id = $1
        ORDER BY ps.position`,
      [project.id],
    );

    if (segRes.rows.length === 0) {
      console.log(`  ${project.id} (${project.original_filename}): 0 Segmente — skip`);
      continue;
    }

    const detection = detectPlaceholders(
      segRes.rows.map((r) => ({ id: `seg-${r.position}`, text: r.source_text })),
    );

    await pool.query(
      `UPDATE projects SET placeholder_warning = $2 WHERE id = $1`,
      [project.id, JSON.stringify(detection)],
    );

    const flag = detection.triggered ? '⚠ TRIGGERED' : 'ok';
    console.log(
      `  ${project.id} (${project.original_filename}): ${flag} — ` +
        `${detection.placeholderCount}/${detection.totalSegments} verdaechtig` +
        (detection.loremIpsumDetected ? ' [Lorem-Ipsum]' : ''),
    );
    if (detection.triggered) triggered++;
  }

  console.log(`[Backfill] Fertig. ${triggered} Projekt(e) mit Warnung markiert.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
