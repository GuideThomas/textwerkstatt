import { pool } from './connection';
import { normalizedHash } from '../services/text-normalize';

async function backfill() {
  console.log('Backfilling normalized_hash für bestehende Segmente ...');
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM segments WHERE normalized_hash IS NULL`);
  console.log(`Zu verarbeiten: ${total.rows[0].n} Segmente`);

  const BATCH = 500;
  let processed = 0;
  while (true) {
    const result = await pool.query<{ id: string; source_text: string }>(
      `SELECT id, source_text FROM segments
        WHERE normalized_hash IS NULL
        LIMIT $1`,
      [BATCH]
    );
    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      await pool.query(
        `UPDATE segments SET normalized_hash = $1 WHERE id = $2`,
        [normalizedHash(row.source_text), row.id]
      );
    }
    processed += result.rows.length;
    console.log(`  ${processed} verarbeitet`);
  }

  console.log(`Fertig. Gesamt: ${processed} Segmente aktualisiert.`);
  await pool.end();
}

backfill().catch((err) => {
  console.error('Backfill fehlgeschlagen:', err);
  process.exit(1);
});
