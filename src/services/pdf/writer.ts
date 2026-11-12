/**
 * PDF Overlay Writer — Phase 8
 *
 * Overlay-Ansatz: Original-PDF laden, Textbloecke mit weissem Rect überdecken,
 * übersetzten Text an gleicher Position draufsetzen.
 *
 * Verwendet pdf-lib für PDF-Manipulation.
 */

import fs from 'fs';
import path from 'path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PdfParseResult, PdfTranslationMapping, BBox } from './types';

/**
 * Unicode-Schrift statt der PDF-Standardschrift Helvetica. Die Standardschriften
 * kennen nur WinAnsi (Windows-1252): schon ein „↧“ im Quelltext oder ein
 * ungarisches „ő“ / slowakisches „č“ in der Übersetzung bricht drawText() mit
 * „WinAnsi cannot encode …“ ab, der Download endet in HTTP 500 (20.10.2026,
 * Montageanleitung Wannenleuchte SL → IT). DejaVu Sans deckt Latin Extended
 * (HU, SK, CZ, PL), Griechisch, Kyrillisch und Pfeile ab. Die Schrift kommt aus
 * dem npm-Paket, weil der Deploy nur `dist/` kopiert und `npm ci` ausführt.
 */
const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

/** Minimale Schriftgröße nach Auto-Scaling (in pt) */
const MIN_FONT_SIZE = 6;

/**
 * Maximale relative Reduktion der Schriftgröße gegenüber Original.
 * 0.35 = bis zu 35% kleiner (z.B. 12pt → 7.8pt). Absolut ebenfalls
 * begrenzt durch MIN_FONT_SIZE. Großzügiger als die früheren starren
 * -3pt, damit Tabellen-/Header-Texte nicht überlaufen.
 */
const MAX_FONT_REDUCTION_RATIO = 0.35;

/** Padding um den Textblock (in pt) */
const RECT_PADDING = 2;

/** Zeilenhöhe-Faktor relativ zur Schriftgröße */
const LINE_HEIGHT_FACTOR = 1.2;

/**
 * Schreibt übersetzte Texte als Overlay in das PDF.
 *
 * 1. Original-PDF laden
 * 2. Für jeden übersetzten Block:
 *    a) Weisses Rect an Original-Koordinaten
 *    b) Neuer Text mit pdf-lib drawText()
 * 3. Als neues PDF speichern
 */
export async function writePdfOverlay(
  parseResult: PdfParseResult,
  translations: PdfTranslationMapping[],
  outputPath: string,
): Promise<void> {
  const pdfBytes = fs.readFileSync(parseResult.filePath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Unicode-Schrift einbetten, nur die benutzten Glyphen (subset)
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fs.readFileSync(FONT_REGULAR), { subset: true });
  const fontBold = await pdfDoc.embedFont(fs.readFileSync(FONT_BOLD), { subset: true });

  const pages = pdfDoc.getPages();

  // Translation-Map aufbauen: segmentId → translatedText
  const translationMap = new Map<string, string>();
  for (const t of translations) {
    translationMap.set(t.segmentId, t.translatedText);
  }

  // Segment-Map aufbauen: segmentId → Segment-Daten
  const segmentMap = new Map(parseResult.segments.map(s => [s.id, s]));

  let overlayCount = 0;

  for (const [segmentId, translatedText] of translationMap) {
    const segment = segmentMap.get(segmentId);
    if (!segment) continue;

    // Seite holen (0-indexed in pdf-lib)
    const pageIndex = segment.pageNumber - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;

    const page = pages[pageIndex];

    // Leere/ungültige BBox überspringen
    if (segment.bbox.width <= 0 || segment.bbox.height <= 0) continue;

    // Optimale Schriftgröße bestimmen
    const originalSize = segment.fontSize;
    const { fontSize, lines } = fitTextToBox(
      translatedText,
      segment.bbox,
      font,
      originalSize,
    );

    // 1. Weisses Rect zeichnen (überdeckt Original-Text)
    const rectBbox = expandBbox(segment.bbox, RECT_PADDING);
    page.drawRectangle({
      x: rectBbox.x,
      y: rectBbox.y,
      width: rectBbox.width,
      height: rectBbox.height,
      color: rgb(1, 1, 1),  // Weiss
      borderWidth: 0,
    });

    // 2. Übersetzten Text zeichnen
    const lineHeight = fontSize * LINE_HEIGHT_FACTOR;
    // Startposition: Oberkante der BBox (pdf-lib y = unten-links, Text Baseline)
    let yPos = segment.bbox.y + segment.bbox.height - fontSize;

    // Font basierend auf Label wählen
    const useFont = (segment.label === 'title' || segment.label === 'section_header')
      ? fontBold
      : font;

    for (const line of lines) {
      if (yPos < segment.bbox.y - fontSize) break; // Über BBox hinaus

      page.drawText(line, {
        x: segment.bbox.x,
        y: yPos,
        size: fontSize,
        font: useFont,
        color: rgb(0, 0, 0),
      });

      yPos -= lineHeight;
    }

    overlayCount++;
  }

  console.log(`[PDF Writer] ${overlayCount} Overlays geschrieben`);

  // PDF speichern
  const outputBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, outputBytes);
}

/**
 * Passt Text und Schriftgröße an die BBox an.
 * Reduziert Schriftgröße schrittweise wenn nötig.
 *
 * Returns die finale Schriftgröße und die umbrochenen Zeilen.
 */
function fitTextToBox(
  text: string,
  bbox: BBox,
  font: any,
  originalSize: number,
): { fontSize: number; lines: string[] } {
  const minSize = Math.max(MIN_FONT_SIZE, originalSize * (1 - MAX_FONT_REDUCTION_RATIO));

  for (let size = originalSize; size >= minSize; size -= 0.5) {
    const lines = wrapText(text, bbox.width, font, size);
    const totalHeight = lines.length * size * LINE_HEIGHT_FACTOR;

    if (totalHeight <= bbox.height + size) {
      return { fontSize: size, lines };
    }
  }

  // Fallback: Kleinste Größe, Text wird ggf. abgeschnitten
  const lines = wrapText(text, bbox.width, font, minSize);
  return { fontSize: minSize, lines };
}

/**
 * Bricht Text in Zeilen um, basierend auf verfügbarer Breite.
 */
function wrapText(text: string, maxWidth: number, font: any, fontSize: number): string[] {
  if (maxWidth <= 0) return [text];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    let textWidth: number;

    try {
      textWidth = font.widthOfTextAtSize(testLine, fontSize);
    } catch {
      // Font kann nicht alle Zeichen messen → Schätzung
      textWidth = testLine.length * fontSize * 0.5;
    }

    if (textWidth <= maxWidth || !currentLine) {
      currentLine = testLine;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Vergrößert eine BBox um Padding (in alle Richtungen).
 */
function expandBbox(bbox: BBox, padding: number): BBox {
  return {
    x: bbox.x - padding,
    y: bbox.y - padding,
    width: bbox.width + padding * 2,
    height: bbox.height + padding * 2,
  };
}
