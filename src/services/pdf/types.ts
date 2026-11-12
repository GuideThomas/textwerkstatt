/**
 * PDF Types — Phase 8
 *
 * Typen für die PDF-Übersetzungs-Pipeline via Docling + pdf-lib Overlay.
 */

/** Bounding Box in PDF-Koordinaten (Punkte, Ursprung unten-links) */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Roh-Textblock aus Docling-Extraktion */
export interface PdfTextBlock {
  text: string;
  page: number;        // 0-indexed (Docling)
  bbox: BBox;          // PDF-Koordinaten
  fontSize: number;
  label?: string;      // Docling-Klassifikation: text, title, list_item, etc.
}

/** Segment für Translation-Pipeline */
export interface PdfSegment {
  id: string;          // "pdf_p1_b0" (page 1, block 0)
  text: string;
  pageNumber: number;  // 1-indexed (für Anzeige)
  bbox: BBox;
  fontSize: number;
  label?: string;
}

/** Ergebnis der PDF-Extraktion */
export interface PdfParseResult {
  segments: PdfSegment[];
  filePath: string;    // Original-PDF Pfad (für Writer)
  pageCount: number;
  blocks: PdfTextBlock[];
}

/** Mapping Segment-ID → übersetzter Text (für Writer) */
export interface PdfTranslationMapping {
  segmentId: string;
  translatedText: string;
}

/** Docling API Response (vereinfacht — relevante Felder) */
export interface DoclingResponse {
  pages: DoclingPage[];
}

export interface DoclingPage {
  page_no: number;     // 0-indexed
  size: { width: number; height: number };
  cells?: DoclingCell[];
}

export interface DoclingCell {
  text: string;
  bbox: {
    l: number;   // left
    t: number;   // top
    r: number;   // right
    b: number;   // bottom
  };
  label?: string;
  font_size?: number;
}
