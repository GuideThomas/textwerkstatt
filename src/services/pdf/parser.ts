/**
 * PDF Parser — Phase 8
 *
 * Konvertiert Docling-Response in PdfSegment[].
 * Filtert leere/zu kurze Bloecke, generiert eindeutige Segment-IDs.
 */

import type { PdfSegment, PdfTextBlock, PdfParseResult } from './types';
import type { DoclingDocument, DoclingTextItem } from './docling';
import { extractTextItems } from './docling';

/** Minimale Textlänge für ein Segment (filtert Seitenzahlen, Fusszeilen-Artefakte) */
const MIN_TEXT_LENGTH = 3;

/** Labels die übersprungen werden (keine Übersetzung nötig) */
const SKIP_LABELS = new Set(['page_footer', 'page_header', 'footnote']);

/**
 * Labels die expliziter Tabellen-Inhalt sind. Werden wie normale Text-
 * Segmente behandelt (übersetzt), aber intern markiert für bessere
 * Fontgrößen-Heuristik (Tabellenzellen haben oft nur eine Zeile).
 */
const TABLE_LABELS = new Set(['table', 'table_cell', 'table_header', 'table_row_header']);

/** Default-Schriftgröße wenn Docling keine liefert */
const DEFAULT_FONT_SIZE = 11;

/**
 * Parst eine Docling-Response zu PdfParseResult.
 */
export function parseDoclingResponse(
  doc: DoclingDocument,
  filePath: string,
): PdfParseResult {
  const items = extractTextItems(doc);
  const blocks: PdfTextBlock[] = [];
  const segments: PdfSegment[] = [];

  // Seitendimensionen sammeln (für Koordinaten-Umrechnung)
  const pageDimensions = extractPageDimensions(doc);

  // Zähler pro Seite für eindeutige IDs
  const pageBlockCount: Record<number, number> = {};

  for (const item of items) {
    // Bestimmte Labels überspringen
    if (item.label && SKIP_LABELS.has(item.label)) {
      continue;
    }

    const text = (item.text || '').trim();
    if (text.length < MIN_TEXT_LENGTH) {
      continue;
    }

    // Provenance: Position + Seite
    const prov = item.prov?.[0];
    if (!prov) {
      // Kein Positionsdaten — trotzdem als Segment aufnehmen (ohne BBox)
      const pageNo = 1;
      const blockIdx = (pageBlockCount[pageNo] = (pageBlockCount[pageNo] || 0) + 1) - 1;

      const block: PdfTextBlock = {
        text,
        page: pageNo - 1,
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        fontSize: DEFAULT_FONT_SIZE,
        label: item.label,
      };
      blocks.push(block);

      segments.push({
        id: `pdf_p${pageNo}_b${blockIdx}`,
        text,
        pageNumber: pageNo,
        bbox: block.bbox,
        fontSize: block.fontSize,
        label: item.label,
      });
      continue;
    }

    const pageNo = prov.page_no; // 1-indexed
    const pageHeight = pageDimensions[pageNo]?.height || 792; // Default US Letter

    // Docling bbox: l,t,r,b with coord_origin
    // pdf-lib bbox: x,y,width,height (Ursprung unten-links)
    const bbox = doclingBboxToPdfLib(prov.bbox, pageHeight);

    // Primaerquellen für Schriftgröße in dieser Reihenfolge:
    //   1. Docling font_size (wenn vorhanden)
    //   2. Docling formatting.size (v2 Variante)
    //   3. Heuristik basierend auf BBox-Höhe + Zeilen- und Zeichenanalyse
    const explicitSize = (item as any).font_size
      || (item as any).formatting?.size
      || (item as any).formatting?.font_size;

    const isTableContent = item.label ? TABLE_LABELS.has(item.label) : false;

    const fontSize = explicitSize
      || estimateFontSize(bbox.height, text, bbox.width, isTableContent)
      || DEFAULT_FONT_SIZE;

    const blockIdx = (pageBlockCount[pageNo] = (pageBlockCount[pageNo] || 0) + 1) - 1;

    const block: PdfTextBlock = {
      text,
      page: pageNo - 1,
      bbox,
      fontSize,
      label: item.label,
    };
    blocks.push(block);

    segments.push({
      id: `pdf_p${pageNo}_b${blockIdx}`,
      text,
      pageNumber: pageNo,
      bbox,
      fontSize,
      label: item.label,
    });
  }

  // Seitenanzahl bestimmen
  const pageCount = Object.keys(pageDimensions).length
    || (segments.length > 0 ? Math.max(...segments.map(s => s.pageNumber)) : 0);

  console.log(`[PDF Parser] ${segments.length} Segmente aus ${pageCount} Seiten extrahiert`);

  return {
    segments,
    filePath,
    pageCount,
    blocks,
  };
}

/**
 * Konvertiert Docling BBox zu pdf-lib (Ursprung unten-links).
 * Handhabt coord_origin: BOTTOMLEFT (v2, bereits korrekt) oder TOPLEFT (legacy).
 */
function doclingBboxToPdfLib(
  bbox: { l: number; t: number; r: number; b: number; coord_origin?: string },
  pageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const width = bbox.r - bbox.l;

  if (bbox.coord_origin === 'BOTTOMLEFT') {
    // v2: Koordinaten sind bereits von unten — direkt verwenden
    const height = bbox.t - bbox.b;
    return { x: bbox.l, y: bbox.b, width, height: Math.abs(height) };
  }

  // Legacy (TOPLEFT): Y-Achse umkehren
  const height = bbox.b - bbox.t;
  const y = pageHeight - bbox.b;
  return { x: bbox.l, y, width, height };
}

/**
 * Schätzt Schriftgröße aus BBox-Höhe und Textlänge.
 *
 * Verbesserte Heuristik (Phase 10):
 * 1. Wenn Original-Text \n enthält → echte Zeilenanzahl verwenden.
 * 2. Sonst: Zeichen/Breite-Verhältnis nutzen, um Zeilen zu schätzen
 *    (statt starrer "Zeichen/80"-Annahme).
 * 3. Tabellen-Zellen: praktisch immer 1 Zeile — daher direkt height*0.72.
 * 4. Einzeilige Bloecke (wide/flat bbox): direkt height*0.72.
 */
function estimateFontSize(
  blockHeight: number,
  text: string,
  blockWidth = 0,
  isTableContent = false,
): number | null {
  if (blockHeight <= 0) return null;

  // 1. Explizite Zeilenumbrueche im Original zählen
  const explicitLines = (text.match(/\n/g) || []).length + 1;

  let estimatedLines: number;

  if (isTableContent) {
    // Tabellenzellen sind praktisch immer 1 Zeile (auch lange Texte)
    estimatedLines = Math.max(1, explicitLines);
  } else if (explicitLines > 1) {
    // 2. Echte Zeilenumbrueche vorhanden
    estimatedLines = explicitLines;
  } else if (blockWidth > 0 && blockHeight > 0) {
    // 3. Aspect-Ratio: flache, breite Bloecke sind typischerweise einzeilig
    const aspectRatio = blockWidth / blockHeight;
    if (aspectRatio > 8) {
      // sehr breit, flach → einzeilig
      estimatedLines = 1;
    } else {
      // 4. Fallback: Zeichenzahl gegen geschätzte Breite abgleichen.
      //    Annahme: durchschnittliche Zeichenbreite ≈ 0.5 × fontSize.
      //    Wir iterieren: nehmen an, fontSize ≈ height*0.72, berechnen daraus
      //    die Zeilenkapazitaet und leiten Zeilenzahl ab.
      const assumedFontSize = blockHeight * 0.72;
      const charsPerLine = Math.max(10, blockWidth / (assumedFontSize * 0.5));
      estimatedLines = Math.max(1, Math.ceil(text.length / charsPerLine));
    }
  } else {
    estimatedLines = 1;
  }

  const lineHeight = blockHeight / estimatedLines;

  // Schriftgröße ≈ 72% der Zeilenhöhe (1.4× Line-Height-Faktor → 1/1.4 ≈ 0.72)
  const fontSize = Math.round(lineHeight * 0.72);

  // Plausibilitaets-Check
  if (fontSize < 6 || fontSize > 72) return null;
  return fontSize;
}

/**
 * Extrahiert Seitendimensionen aus dem Docling-Dokument.
 */
function extractPageDimensions(
  doc: DoclingDocument,
): Record<number, { width: number; height: number }> {
  const dims: Record<number, { width: number; height: number }> = {};

  if (doc.pages) {
    for (const [key, info] of Object.entries(doc.pages)) {
      // Page keys can be "1" or "0" — docling-serve v2 uses 1-indexed
      const pageNo = parseInt(key, 10) || 1;
      // v2: dimensions in size.width/size.height; legacy: direct width/height
      const w = info.size?.width || info.width || 595;
      const h = info.size?.height || info.height || 842;
      dims[pageNo] = { width: w, height: h };
    }
  }

  return dims;
}
