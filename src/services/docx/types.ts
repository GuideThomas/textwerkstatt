/**
 * DOCX Parser Types — Phase 6
 */

/** Ein extrahiertes Textsegment aus einem DOCX-Paragraphen */
export interface DocxSegment {
  /** Eindeutige ID: p_<index> oder h_<index> (header), f_<index> (footer) */
  id: string;
  /** Kombinierter Text aller <w:t>-Tags im Paragraphen */
  text: string;
  /** Quelle: 'body' | 'header' | 'footer' */
  source: 'body' | 'header' | 'footer';
  /** Dateiname innerhalb des ZIP (z.B. "word/document.xml", "word/header1.xml") */
  xmlFile: string;
  /** Absatz-Index innerhalb der Datei */
  paragraphIndex: number;
  /** Style-ID des Absatzes (z.B. "Heading1", "Normal") */
  styleId: string | null;
}

/** Ergebnis des DOCX-Parsings */
export interface DocxParseResult {
  segments: DocxSegment[];
  tempDir: string;
  /** Alle XML-Dateien die Text enthalten */
  contentFiles: string[];
}

/** Übersetzungs-Zuordnung für den Re-Writer */
export interface DocxTranslationMapping {
  segmentId: string;
  translatedText: string;
}
