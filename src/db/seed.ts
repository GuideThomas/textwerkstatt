/**
 * Spielt die Füllung einer Installation ein: `seeds/<name>/*.sql`, nach Namen sortiert.
 *
 * Aufruf: `node dist/db/seed.js <name> [<name> …]` bzw. `npm run seed -- <name>`.
 *
 * Migrationen tragen nur das Schema; Channels, Stilprofile, Schutzmuster und Beispielglossare einer Installation
 * stehen hier (Plan `PLAN-oeffentlich-und-demo.md` §4 Phase 1). Jede Datei muss wiederholbar sein, denn der Deploy
 * spielt sie wie die Migrationen bei jedem Lauf neu ein: nur Erstanlage (`ON CONFLICT DO NOTHING`), nie überschreiben,
 * was ein Admin geändert hat.
 *
 * Fehlt ein genannter Ordner oder ist er leer, bricht der Lauf ab: Eine Installation ohne ihre Füllung soll laut
 * scheitern, nicht still leer starten.
 */
import fs from 'fs';
import path from 'path';
import { pool } from './connection';

async function seed(namen: string[]): Promise<void> {
  if (namen.length === 0) {
    console.error('Aufruf: node dist/db/seed.js <name> [<name> …]  (Ordner unter seeds/)');
    process.exit(1);
  }
  const basis = path.resolve(__dirname, '../../seeds');

  for (const name of namen) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      console.error(`Ungültiger Seed-Name: ${name}`);
      process.exit(1);
    }
    const ordner = path.join(basis, name);
    if (!fs.existsSync(ordner)) {
      console.error(`Seed-Ordner fehlt: ${ordner}`);
      process.exit(1);
    }
    const dateien = fs.readdirSync(ordner).filter((f) => f.endsWith('.sql')).sort();
    if (dateien.length === 0) {
      console.error(`Seed-Ordner ohne .sql-Dateien: ${ordner}`);
      process.exit(1);
    }
    for (const datei of dateien) {
      const sql = fs.readFileSync(path.join(ordner, datei), 'utf-8');
      console.log(`Seed ${name}/${datei}`);
      try {
        await pool.query(sql);
      } catch (err) {
        console.error(`  FEHLER: ${name}/${datei}`, err);
        process.exit(1);
      }
    }
  }
  console.log('Seeds eingespielt.');
  await pool.end();
}

seed(process.argv.slice(2));
