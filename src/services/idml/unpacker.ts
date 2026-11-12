/**
 * IDML Unpacker — Phase 2.2.1
 *
 * Entpackt IDML-Dateien (ZIP-Format) in temporaere Verzeichnisse
 * und identifiziert relevante Dateien (Stories, Spreads).
 */

import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UnpackResult } from './types';

/**
 * Entpackt eine IDML-Datei in ein temporaeres Verzeichnis.
 * IDML ist ein ZIP-Archiv mit XML-Dateien.
 */
export function unpackIdml(idmlPath: string): UnpackResult {
  if (!fs.existsSync(idmlPath)) {
    throw new Error(`IDML file not found: ${idmlPath}`);
  }

  const zip = new AdmZip(idmlPath);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idml-'));

  zip.extractAllTo(tempDir, true);

  const entries = zip.getEntries().map(e => e.entryName);

  const storyFiles = entries
    .filter(e => e.startsWith('Stories/') && e.endsWith('.xml'))
    .sort();

  const spreadFiles = entries
    .filter(e => e.startsWith('Spreads/') && e.endsWith('.xml'))
    .sort();

  const masterSpreadFiles = entries
    .filter(e => e.startsWith('MasterSpreads/') && e.endsWith('.xml'))
    .sort();

  const designMapPath = path.join(tempDir, 'designmap.xml');
  if (!fs.existsSync(designMapPath)) {
    throw new Error('Invalid IDML: designmap.xml not found');
  }

  console.log(
    `[IDML] Unpacked to ${tempDir}: ${storyFiles.length} stories, ` +
      `${spreadFiles.length} spreads, ${masterSpreadFiles.length} master spreads`,
  );

  return { tempDir, storyFiles, spreadFiles, masterSpreadFiles, designMapPath };
}

/**
 * Räumt ein temporaeres IDML-Verzeichnis auf.
 */
export function cleanupTempDir(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[IDML] Failed to cleanup ${tempDir}:`, err);
  }
}
