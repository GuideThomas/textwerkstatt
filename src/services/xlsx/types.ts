/**
 * XLSX Parser Types — Phase 6
 */

/** Ein extrahiertes Textsegment aus einer Excel-Zelle */
export interface XlsxSegment {
  /** Eindeutige ID: <SheetName>_<CellRef> z.B. "Sheet1_B3" */
  id: string;
  /** Text der Zelle */
  text: string;
  /** Sheet-Name */
  sheet: string;
  /** Zell-Referenz (z.B. "B3") */
  cell: string;
  /** Zeile (1-basiert) */
  row: number;
  /** Spalte (1-basiert) */
  col: number;
}

/** Ergebnis des XLSX-Parsings */
export interface XlsxParseResult {
  segments: XlsxSegment[];
  /** Pfad zur Original-Datei (wird für Write-Back benötigt) */
  filePath: string;
}

/** Übersetzungs-Zuordnung für den Re-Writer */
export interface XlsxTranslationMapping {
  segmentId: string;
  translatedText: string;
}
