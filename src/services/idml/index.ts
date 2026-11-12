/**
 * IDML Pipeline Orchestrator — Phase 2
 *
 * Koordiniert den gesamten IDML-Workflow:
 * 1. Entpacken → 2. Parsen → 3. Segmente extrahieren
 * 4. (Später: Übersetzen) → 5. Zurückschreiben → 6. Packen
 */

import path from 'path';
import { unpackIdml, cleanupTempDir } from './unpacker';
import { parseAllStories } from './parser';
import { parseSpreadDimensions } from './spreads';
import { findHiddenLayerStories } from './layers';
import { writeTranslations } from './writer';
import { packIdml } from './packer';
import type {
  IdmlParseResult,
  IdmlSegment,
  TranslationMapping,
  TextFrameDimension,
} from './types';

export type { IdmlSegment, IdmlParseResult, TranslationMapping, TextFrameDimension };

/**
 * Parst eine IDML-Datei und extrahiert alle Textsegmente.
 *
 * Gibt das Parse-Ergebnis zurück. Der tempDir muss später
 * mit cleanupIdml() aufgeräumt werden.
 */
export function parseIdml(idmlPath: string): IdmlParseResult {
  const { tempDir, storyFiles, spreadFiles, masterSpreadFiles } = unpackIdml(idmlPath);

  // Layer-Sichtbarkeit pruefen: TextFrames auf Layern mit Visible="false"
  // werden in InDesign nicht angezeigt und sollen nicht uebersetzt werden.
  // Typischer Fall: Katalog-Master-Page-Layer "Beispieltexte" mit
  // Adobe-Platzhalter-Latein.
  const { hiddenStorySelfs, hiddenLayerNames } = findHiddenLayerStories(
    tempDir,
    spreadFiles,
    masterSpreadFiles,
  );
  if (hiddenStorySelfs.size > 0) {
    console.log(
      `[IDML] Layer-Filter: ${hiddenStorySelfs.size} Stories auf ` +
        `${hiddenLayerNames.length} unsichtbaren Layern (${hiddenLayerNames.join(', ')}) werden uebersprungen`,
    );
  }

  // Segmente extrahieren — Stories auf unsichtbaren Layern raus
  const rawSegments = parseAllStories(tempDir, storyFiles);
  const segments = rawSegments.filter((s) => !hiddenStorySelfs.has(s.storySelf));
  const skipped = rawSegments.length - segments.length;
  if (skipped > 0) {
    console.log(`[IDML] Layer-Filter: ${skipped} Segmente von unsichtbaren Layern entfernt`);
  }

  // Frame-Dimensionen lesen
  const frameDimensions = parseSpreadDimensions(tempDir, spreadFiles);

  // maxChars aus Frame-Dimensionen zuweisen
  for (const segment of segments) {
    const dim = frameDimensions.get(segment.storySelf);
    if (dim) {
      segment.maxChars = dim.estimatedMaxChars;
    }
  }

  return { segments, frameDimensions, tempDir, storyFiles };
}

/**
 * Schreibt Übersetzungen in ein bereits entpacktes IDML und packt es neu.
 *
 * @param parseResult Ergebnis von parseIdml()
 * @param translations Segment-ID → übersetzter Text
 * @param outputPath Zielpfad für die neue .idml-Datei
 */
export function writeAndPackIdml(
  parseResult: IdmlParseResult,
  translations: TranslationMapping[],
  outputPath: string
): void {
  writeTranslations(parseResult.tempDir, parseResult.segments, translations);
  packIdml(parseResult.tempDir, outputPath);
}

/**
 * Round-Trip: IDML parsen und unverändert zurückschreiben.
 * Für Tests — das Ergebnis sollte identisch zum Original sein.
 */
export function roundTripIdml(inputPath: string, outputPath: string): IdmlParseResult {
  const result = parseIdml(inputPath);
  // Keine Übersetzungen → XML bleibt unverändert
  packIdml(result.tempDir, outputPath);
  return result;
}

/**
 * Räumt die temporaeren Dateien eines Parse-Vorgangs auf.
 */
export function cleanupIdml(parseResult: IdmlParseResult): void {
  cleanupTempDir(parseResult.tempDir);
}

/**
 * Vollständiger IDML-Übersetzungs-Workflow (für Queue Worker).
 *
 * 1. Entpacken + Parsen
 * 2. Segmente an Callback geben (für Übersetzung)
 * 3. Zurückschreiben + Packen
 * 4. Aufräumen
 */
export async function processIdmlFile(
  inputPath: string,
  outputPath: string,
  translateFn: (segments: IdmlSegment[]) => Promise<TranslationMapping[]>
): Promise<{ segmentCount: number; translatedCount: number }> {
  const parseResult = parseIdml(inputPath);

  try {
    const translations = await translateFn(parseResult.segments);
    writeAndPackIdml(parseResult, translations, outputPath);

    return {
      segmentCount: parseResult.segments.length,
      translatedCount: translations.length,
    };
  } finally {
    cleanupIdml(parseResult);
  }
}
