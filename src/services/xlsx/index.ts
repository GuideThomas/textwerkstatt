/**
 * XLSX Pipeline Orchestrator — Phase 6
 *
 * Liest Excel-Dateien, extrahiert nur Textzellen (Formeln/Zahlen werden
 * übersprungen), und schreibt Übersetzungen zurück.
 *
 * Verwendet exceljs für vollständiges Round-Trip (Styles bleiben erhalten).
 */

import ExcelJS from 'exceljs';
import path from 'path';
import type { XlsxSegment, XlsxParseResult, XlsxTranslationMapping } from './types';

export type { XlsxSegment, XlsxParseResult, XlsxTranslationMapping };

/**
 * Parst eine XLSX-Datei und extrahiert alle Textzellen.
 * Zahlen, Formeln und leere Zellen werden übersprungen.
 */
export async function parseXlsx(xlsxPath: string): Promise<XlsxParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  const segments: XlsxSegment[] = [];

  workbook.eachSheet((sheet) => {
    sheet.eachRow((row, rowNumber) => {
      row.eachCell((cell, colNumber) => {
        // Nur Textzellen übersetzen
        if (!isTranslatableCell(cell)) return;

        const text = getCellText(cell);
        if (!text.trim()) return;

        const cellRef = `${columnToLetter(colNumber)}${rowNumber}`;
        const id = `${sanitizeSheetName(sheet.name)}_${cellRef}`;

        segments.push({
          id,
          text,
          sheet: sheet.name,
          cell: cellRef,
          row: rowNumber,
          col: colNumber,
        });
      });
    });
  });

  return { segments, filePath: xlsxPath };
}

/**
 * Schreibt Übersetzungen in eine Kopie der XLSX-Datei.
 */
export async function writeXlsx(
  parseResult: XlsxParseResult,
  translations: XlsxTranslationMapping[],
  outputPath: string,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(parseResult.filePath);

  // Translation-Map aufbauen
  const translationMap = new Map<string, string>();
  for (const t of translations) {
    translationMap.set(t.segmentId, t.translatedText);
  }

  // Segmente zurückschreiben
  for (const seg of parseResult.segments) {
    const translated = translationMap.get(seg.id);
    if (!translated) continue;

    const sheet = workbook.getWorksheet(seg.sheet);
    if (!sheet) continue;

    const cell = sheet.getCell(seg.cell);
    cell.value = translated;
  }

  await workbook.xlsx.writeFile(outputPath);
}

/**
 * Prüft ob eine Zelle übersetzbar ist (Text, kein Formel/Zahl/Boolean).
 */
function isTranslatableCell(cell: ExcelJS.Cell): boolean {
  if (cell.type === ExcelJS.ValueType.Formula) return false;
  if (cell.type === ExcelJS.ValueType.Number) return false;
  if (cell.type === ExcelJS.ValueType.Boolean) return false;
  if (cell.type === ExcelJS.ValueType.Null) return false;
  if (cell.type === ExcelJS.ValueType.Error) return false;
  if (cell.type === ExcelJS.ValueType.Date) return false;

  return true;
}

/**
 * Extrahiert den Textinhalt einer Zelle (auch Rich Text).
 */
function getCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';

  // Rich Text: { richText: [{ text: "..." }, ...] }
  if (typeof value === 'object' && 'richText' in value && Array.isArray((value as any).richText)) {
    return (value as any).richText.map((part: any) => part.text || '').join('');
  }

  return String(value);
}

/**
 * Spaltennummer → Buchstabe(n): 1=A, 2=B, ..., 26=Z, 27=AA
 */
function columnToLetter(col: number): string {
  let result = '';
  let n = col;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/**
 * Sheet-Name für IDs sanitisieren (Sonderzeichen entfernen).
 */
function sanitizeSheetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * XLSX hat keine temporaeren Dateien — Cleanup ist ein No-Op.
 */
export function cleanupXlsx(): void {
  // exceljs arbeitet im Speicher, kein Cleanup nötig
}
