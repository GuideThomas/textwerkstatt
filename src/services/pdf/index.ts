/**
 * PDF Pipeline Orchestrator — Phase 8
 *
 * Koordiniert den PDF-Workflow:
 * 1. Docling-Extraktion → 2. Segmente parsen → 3. Overlay schreiben
 *
 * Verwendet den Overlay-Ansatz: Original-PDF behalten, Text mit weissem
 * Rect überdecken, übersetzten Text draufsetzen.
 */

import { convertPdfWithDocling } from './docling';
import { parseDoclingResponse } from './parser';
import { writePdfOverlay } from './writer';
import type { PdfSegment, PdfParseResult, PdfTranslationMapping } from './types';

export type { PdfSegment, PdfParseResult, PdfTranslationMapping };

/**
 * Extrahiert Text aus einer PDF-Datei via Docling.
 * Gibt Segmente mit Bounding Boxes zurück.
 */
export async function parsePdf(filePath: string): Promise<PdfParseResult> {
  console.log(`[PDF] Starte Docling-Extraktion: ${filePath}`);

  const response = await convertPdfWithDocling(filePath);

  if (response.errors && response.errors.length > 0) {
    throw new Error(`Docling-Fehler: ${response.errors.join(', ')}`);
  }

  if (!response.document) {
    throw new Error('Docling hat kein Dokument zurückgegeben');
  }

  // docling-serve wraps the actual document in json_content
  const doclingDoc = response.document.json_content || (response.document as any);
  if (!doclingDoc || (!doclingDoc.texts && !doclingDoc.main_text && !doclingDoc.body)) {
    throw new Error('Docling json_content ist leer — prüfe to_formats Parameter');
  }

  const parseResult = parseDoclingResponse(doclingDoc, filePath);

  if (parseResult.segments.length === 0) {
    throw new Error('Keine übersetzbaren Textsegmente im PDF gefunden');
  }

  console.log(`[PDF] Extraktion abgeschlossen: ${parseResult.segments.length} Segmente, ${parseResult.pageCount} Seiten`);

  return parseResult;
}

/**
 * Schreibt übersetzte Texte als Overlay in das Original-PDF.
 */
export async function writePdf(
  parseResult: PdfParseResult,
  translations: PdfTranslationMapping[],
  outputPath: string,
): Promise<void> {
  console.log(`[PDF] Schreibe Overlay für ${translations.length} Segmente`);

  await writePdfOverlay(parseResult, translations, outputPath);

  console.log(`[PDF] Output geschrieben: ${outputPath}`);
}

/**
 * Cleanup — PDF hat kein tempDir, nichts aufzuräumen.
 */
export function cleanupPdf(): void {
  // Kein tempDir bei PDF (alles in-memory via pdf-lib)
}
