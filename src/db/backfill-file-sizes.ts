import fs from 'fs';
import { pool } from './connection';
import { getFilePath } from '../services/storage';

async function backfill() {
  console.log('Backfilling file_size_bytes für bestehende Projekte ...');
  const result = await pool.query<{ id: string; stored_filename: string | null }>(
    `SELECT id, stored_filename
       FROM projects
      WHERE stored_filename IS NOT NULL
        AND (file_size_bytes IS NULL OR file_size_bytes = 0)`
  );

  let updated = 0;
  let missing = 0;
  for (const row of result.rows) {
    if (!row.stored_filename) continue;
    const filePath = getFilePath(row.stored_filename);
    try {
      const stats = fs.statSync(filePath);
      await pool.query('UPDATE projects SET file_size_bytes = $1 WHERE id = $2', [stats.size, row.id]);
      updated++;
    } catch {
      missing++;
    }
  }

  console.log(`Aktualisiert: ${updated}, Datei fehlt: ${missing}, Gesamt geprüft: ${result.rowCount}`);
  await pool.end();
}

backfill().catch((err) => {
  console.error('Backfill fehlgeschlagen:', err);
  process.exit(1);
});
