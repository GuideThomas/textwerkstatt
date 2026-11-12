import fs from 'fs';
import path from 'path';
import { pool } from './connection';

async function migrate() {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} migration(s)`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');
    console.log(`Running migration: ${file}`);
    try {
      await pool.query(sql);
      console.log(`  OK: ${file}`);
    } catch (err) {
      console.error(`  FAILED: ${file}`, err);
      process.exit(1);
    }
  }

  console.log('All migrations completed.');
  await pool.end();
}

migrate();
