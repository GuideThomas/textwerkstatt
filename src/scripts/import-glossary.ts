/**
 * Glossar CSV-Import
 *
 * Importiert eine Semikolon-getrennte CSV-Datei mit dem Format:
 *   Deutsch;Englisch;Französisch;Italienisch;Ungarisch;Slowakisch
 *
 * Erstellt pro Sprachpaar (DE→XX) ein Glossar und importiert die Einträge.
 *
 * Usage: npx tsx src/scripts/import-glossary.ts <csv-file> [--clear]
 *   --clear  Bestehende Glossare und Einträge vorher löschen
 *
 * Eine leere Zelle legt keine Zeile an: Im Glossar steht nur, was wir anders wollen als DeepL.
 */

import fs from 'fs';
import path from 'path';
import { pool } from '../db/connection';
import { nenneBearbeiter } from '../db/bearbeiter';

interface LangColumn {
  code: string;
  name: string;
  index: number;
}

const LANG_MAP: Record<string, string> = {
  'Deutsch': 'DE',
  'Englisch': 'EN',
  'Französisch': 'FR',
  'Italienisch': 'IT',
  'Ungarisch': 'HU',
  'Slowakisch': 'SK',
  // Fallbacks
  'English': 'EN',
  'French': 'FR',
  'Italian': 'IT',
  'Hungarian': 'HU',
  'Slovak': 'SK',
};

async function importGlossary(csvPath: string, clearExisting: boolean) {
  const absolutePath = path.resolve(csvPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`File not found: ${absolutePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) {
    console.error('CSV must have header + at least 1 data row');
    process.exit(1);
  }

  // Header parsen
  const headers = lines[0].split(';').map(h => h.trim());
  const sourceLangName = headers[0];
  const sourceLang = LANG_MAP[sourceLangName];

  if (!sourceLang) {
    console.error(`Unknown source language: "${sourceLangName}"`);
    process.exit(1);
  }

  // Zielsprachen identifizieren
  const targetLangs: LangColumn[] = [];
  for (let i = 1; i < headers.length; i++) {
    const langCode = LANG_MAP[headers[i]];
    if (langCode) {
      targetLangs.push({ code: langCode, name: headers[i], index: i });
    } else {
      console.warn(`Skipping unknown language column: "${headers[i]}"`);
    }
  }

  console.log(`Source: ${sourceLang} (${sourceLangName})`);
  console.log(`Targets: ${targetLangs.map(l => `${l.code} (${l.name})`).join(', ')}`);
  console.log(`Data rows: ${lines.length - 1}`);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // Den Verlauf schreibt der Trigger aus Migration 037 unter diesem Namen.
    await nenneBearbeiter(client, { id: null, name: 'import-glossary (CSV-Import)' });

    if (clearExisting) {
      console.log('Clearing existing glossaries...');
      await client.query('DELETE FROM glossary_entries');
      await client.query('DELETE FROM glossaries');
    }

    // Pro Zielsprache ein Glossar anlegen
    const glossaryIds: Record<string, string> = {};

    for (const lang of targetLangs) {
      // Prüfen ob Glossar bereits existiert
      const existing = await client.query(
        'SELECT id FROM glossaries WHERE source_lang = $1 AND target_lang = $2 AND name = $3',
        [sourceLang, lang.code, `${process.env.ORGANISATION_NAME || 'Glossar'} ${sourceLang}→${lang.code}`]
      );

      let glossaryId: string;
      if (existing.rows.length > 0) {
        glossaryId = existing.rows[0].id;
        // Version hochzählen
        await client.query(
          'UPDATE glossaries SET version = version + 1, updated_at = NOW() WHERE id = $1',
          [glossaryId]
        );
        // Bestehende Einträge löschen (werden neu importiert)
        await client.query('DELETE FROM glossary_entries WHERE glossary_id = $1', [glossaryId]);
        console.log(`  Updated existing glossary ${sourceLang}→${lang.code} (${glossaryId})`);
      } else {
        const result = await client.query(
          `INSERT INTO glossaries (name, source_lang, target_lang, version)
           VALUES ($1, $2, $3, 1) RETURNING id`,
          [`${process.env.ORGANISATION_NAME || 'Glossar'} ${sourceLang}→${lang.code}`, sourceLang, lang.code]
        );
        glossaryId = result.rows[0].id;
        console.log(`  Created glossary ${sourceLang}→${lang.code} (${glossaryId})`);
      }
      glossaryIds[lang.code] = glossaryId;
    }

    // Einträge importieren
    let totalImported = 0;
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(';').map(c => c.trim());
      const sourceTerm = cols[0];

      if (!sourceTerm) {
        skipped++;
        continue;
      }

      for (const lang of targetLangs) {
        const targetTerm = cols[lang.index]?.trim();

        if (!targetTerm) continue; // Leere Übersetzungen überspringen

        await client.query(
          `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source)
           VALUES ($1, $2, $3, true, 'csv-import')`,
          [glossaryIds[lang.code], sourceTerm, targetTerm]
        );
        totalImported++;
      }

      // Fortschritt alle 500 Zeilen
      if (i % 500 === 0) {
        console.log(`  Progress: ${i}/${lines.length - 1} rows...`);
      }
    }

    await client.query('COMMIT');

    console.log(`\nImport complete:`);
    console.log(`  Glossaries: ${Object.keys(glossaryIds).length}`);
    console.log(`  Entries imported: ${totalImported}`);
    console.log(`  Rows skipped (empty source): ${skipped}`);

    // Statistik pro Glossar
    for (const lang of targetLangs) {
      const count = await pool.query(
        'SELECT COUNT(*) FROM glossary_entries WHERE glossary_id = $1',
        [glossaryIds[lang.code]]
      );
      console.log(`  ${sourceLang}→${lang.code}: ${count.rows[0].count} entries`);
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
  }

  await pool.end();
}

// CLI
const args = process.argv.slice(2);
const csvFile = args.find(a => !a.startsWith('--'));
const clearFlag = args.includes('--clear');

if (!csvFile) {
  console.log('Usage: npx tsx src/scripts/import-glossary.ts <csv-file> [--clear]');
  process.exit(1);
}

importGlossary(csvFile, clearFlag);
