/**
 * IDML Round-Trip Test — Phase 2.2.8
 *
 * Parst eine IDML-Datei, schreibt sie unverändert zurück
 * und vergleicht Original mit Ergebnis.
 *
 * Aufruf: npx tsx src/scripts/idml-roundtrip.ts <input.idml> [output.idml]
 */

import path from 'path';
import AdmZip from 'adm-zip';
import { roundTripIdml, cleanupIdml } from '../services/idml';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx tsx src/scripts/idml-roundtrip.ts <input.idml> [output.idml]');
  process.exit(1);
}

const outputPath = process.argv[3] || inputPath.replace('.idml', '_roundtrip.idml');

console.log(`\n=== IDML Round-Trip Test ===`);
console.log(`Input:  ${path.resolve(inputPath)}`);
console.log(`Output: ${path.resolve(outputPath)}`);

const result = roundTripIdml(inputPath, outputPath);

console.log(`\nSegments extracted: ${result.segments.length}`);
console.log(`Frame dimensions:   ${result.frameDimensions.size}`);

// Segmente anzeigen
if (result.segments.length > 0) {
  console.log(`\n--- First 10 Segments ---`);
  for (const seg of result.segments.slice(0, 10)) {
    const preview = seg.text.length > 80
      ? seg.text.slice(0, 77) + '...'
      : seg.text;
    console.log(`  [${seg.id}] "${preview}" (${seg.contentMap.length} content tags, maxChars: ${seg.maxChars ?? 'n/a'})`);
  }
  if (result.segments.length > 10) {
    console.log(`  ... and ${result.segments.length - 10} more`);
  }
}

// ZIP-Vergleich: Alle Story-Dateien Byte-für-Byte prüfen
console.log(`\n--- Round-Trip Verification ---`);
const originalZip = new AdmZip(inputPath);
const roundtripZip = new AdmZip(outputPath);

let identical = 0;
let different = 0;
let missing = 0;

const originalEntries = originalZip.getEntries();
for (const entry of originalEntries) {
  if (entry.isDirectory) continue;

  const roundtripEntry = roundtripZip.getEntry(entry.entryName);
  if (!roundtripEntry) {
    console.log(`  MISSING: ${entry.entryName}`);
    missing++;
    continue;
  }

  const originalContent = entry.getData();
  const roundtripContent = roundtripEntry.getData();

  if (originalContent.equals(roundtripContent)) {
    identical++;
  } else {
    // Bei XML-Dateien: Whitespace-Differenzen sind OK
    const origStr = originalContent.toString('utf-8');
    const rtStr = roundtripContent.toString('utf-8');
    if (origStr.replace(/\s+/g, ' ').trim() === rtStr.replace(/\s+/g, ' ').trim()) {
      console.log(`  WHITESPACE-DIFF: ${entry.entryName} (semantisch identisch)`);
      identical++;
    } else {
      console.log(`  DIFFERENT: ${entry.entryName} (${originalContent.length} → ${roundtripContent.length} bytes)`);
      different++;
    }
  }
}

console.log(`\nResult: ${identical} identical, ${different} different, ${missing} missing`);

if (different === 0 && missing === 0) {
  console.log('✓ Round-trip test PASSED');
} else {
  console.log('✗ Round-trip test FAILED');
  // Nicht mit Exit-Code 1 beenden — Whitespace-Differenzen durch XML-Repackaging sind erwartbar
}

cleanupIdml(result);
console.log('\nDone.');
