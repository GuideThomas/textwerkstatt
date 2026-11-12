import fs from 'fs';

/**
 * Plain-Text- und CSV-Parser/-Writer.
 *
 * Strategie:
 * - TXT: jede Zeile = ein Segment. Leere Zeilen + Whitespace-only-Zeilen werden
 *   übersprungen (kein DeepL-Call), bleiben beim Schreiben aber positionsgenau erhalten.
 * - CSV: zeilen- und spalten-genau parsen, jede Zelle = ein Segment, beim Schreiben
 *   wird Quoting nur dort gesetzt wo noetig (delimiter, quote, newline) — RFC-4180-kompatibel.
 *   Trennzeichen wird auto-detektiert (`;` `,` `\t`), Quote-Char ist `"`.
 *
 * UTF-8 mit optionaler BOM bleibt erhalten (Erkennung beim Lesen, Re-Emission beim Schreiben).
 */

export interface TextSegment {
  /** Stabile ID — z.B. "L0", "L1" für TXT, "R0C0" für CSV */
  id: string;
  text: string;
  /** Übersetzungs-Modus pro Segment. Default 'text'. 'html' triggert DeepL HTML-Mode. */
  mode?: 'text' | 'html';
}

interface TxtParseInternal {
  /** Originalzeilen + Leerzeilen-Marker (null = Leerzeile, kein Segment). */
  lines: Array<{ id: string | null; original: string }>;
  lineEnding: '\n' | '\r\n';
  hasBom: boolean;
}

interface CsvParseInternal {
  /** Original-Zellen-Matrix; leere/whitespace Zellen werden NICHT übersetzt. */
  rows: Array<Array<{ id: string | null; original: string; quoted: boolean }>>;
  delimiter: string;
  lineEnding: '\n' | '\r\n';
  hasBom: boolean;
  /** Aktiv genutztes Profil (informativ, für Logging/UI). */
  profileId?: string;
  /** Header-Zeile (erste Zeile aus dem CSV). */
  header?: string[];
}

export interface TextParseResult {
  segments: TextSegment[];
  internal: { kind: 'txt'; data: TxtParseInternal } | { kind: 'csv'; data: CsvParseInternal };
}

const BOM = '﻿';

function readUtf8(filePath: string): { content: string; hasBom: boolean } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (raw.startsWith(BOM)) {
    return { content: raw.slice(1), hasBom: true };
  }
  return { content: raw, hasBom: false };
}

function detectLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function isTranslatable(s: string): boolean {
  return s.trim().length > 0;
}

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------

export function parseTxt(filePath: string): TextParseResult {
  const { content, hasBom } = readUtf8(filePath);
  const lineEnding = detectLineEnding(content);
  const rawLines = content.split(/\r\n|\n/);
  // Trailing newline am Dateiende erzeugt "" als letztes Element — verwerfen, weil wir
  // beim Schreiben mit join() implizit den abschließenden Newline gesondert handhaben.
  const trailingNewline = content.endsWith('\n');
  if (trailingNewline && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const lines: TxtParseInternal['lines'] = [];
  const segments: TextSegment[] = [];
  let segmentIndex = 0;
  for (const original of rawLines) {
    if (isTranslatable(original)) {
      const id = `L${segmentIndex++}`;
      lines.push({ id, original });
      segments.push({ id, text: original });
    } else {
      lines.push({ id: null, original });
    }
  }

  // Trailing-Newline-Marker als sentinel-Eintrag
  if (trailingNewline) lines.push({ id: null, original: '__TRAILING__' });

  return {
    segments,
    internal: { kind: 'txt', data: { lines, lineEnding, hasBom } },
  };
}

export function writeTxt(
  parse: TxtParseInternal,
  translations: Map<string, string>,
  outputPath: string,
): void {
  const out: string[] = [];
  let trailing = false;
  for (const line of parse.lines) {
    if (line.id === null && line.original === '__TRAILING__') {
      trailing = true;
      continue;
    }
    if (line.id === null) {
      out.push(line.original);
    } else {
      out.push(translations.get(line.id) ?? line.original);
    }
  }
  let body = out.join(parse.lineEnding);
  if (trailing) body += parse.lineEnding;
  if (parse.hasBom) body = BOM + body;
  fs.writeFileSync(outputPath, body, 'utf-8');
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function detectDelimiter(content: string): string {
  // Heuristik: erste 5 Zeilen anschauen, häufigstes Trennzeichen waehlen.
  const sample = content.split(/\r\n|\n/).slice(0, 5).join('\n');
  const counts: Record<string, number> = { ';': 0, ',': 0, '\t': 0 };
  let inQuote = false;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') {
      if (inQuote && sample[i + 1] === '"') { i++; continue; }
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch in counts) counts[ch]++;
  }
  // Default Semikolon (User-Anforderung), wenn keines klar fuehrt
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] === 0) return ';';
  // Bei Gleichstand bevorzugen wir Semikolon wenn enthalten, sonst Tab, sonst Komma.
  if (sorted[0][1] === sorted[1]?.[1]) {
    if (counts[';'] === sorted[0][1]) return ';';
    if (counts['\t'] === sorted[0][1]) return '\t';
  }
  return sorted[0][0];
}

function parseCsvContent(content: string, delimiter: string): Array<Array<{ original: string; quoted: boolean }>> {
  const rows: Array<Array<{ original: string; quoted: boolean }>> = [];
  let row: Array<{ original: string; quoted: boolean }> = [];
  let cell = '';
  let inQuote = false;
  let cellStartedQuoted = false;
  let cellHasContent = false;

  const pushCell = () => {
    row.push({ original: cell, quoted: cellStartedQuoted });
    cell = '';
    cellStartedQuoted = false;
    cellHasContent = false;
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuote) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    // Nicht-quoted
    if (ch === '"' && !cellHasContent) {
      inQuote = true;
      cellStartedQuoted = true;
      continue;
    }
    if (ch === delimiter) { pushCell(); continue; }
    if (ch === '\r') {
      if (content[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    if (ch === '\n') { pushRow(); continue; }
    cell += ch;
    cellHasContent = true;
  }
  // Letzte Zelle/Zeile
  if (cell.length > 0 || row.length > 0) pushRow();
  return rows;
}

function csvCellNeedsQuoting(cell: string, delimiter: string): boolean {
  return cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r');
}

function csvEscapeCell(cell: string, delimiter: string, originallyQuoted: boolean): string {
  if (originallyQuoted || csvCellNeedsQuoting(cell, delimiter)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/** Fix #6: Warnung-Schwelle fuer ueberraschend grosse Zellen (Bytes). */
const CSV_CELL_WARN_BYTES = 50_000;

// Eigenständige Implementierung. Geschwister (Stand 07.09.2026): Projekte/Artikelanlage-Assistent/renderer/src/highlights.js,
// Projekte/Cockpit/server/src/lib/finance-csv.ts, Projekte/Marketing-Produktdossiers/scripts/{merge,prepare}-enrichment.js (parseCsvRow).
// Entscheid Thomas 07.09.2026: getrennt lassen, Kopiermarker statt Paket.
export function parseCsv(filePath: string, profileId?: string): TextParseResult {
  const { content, hasBom } = readUtf8(filePath);
  const lineEnding = detectLineEnding(content);
  const delimiter = detectDelimiter(content);
  const rawRows = parseCsvContent(content, delimiter);

  const rows: CsvParseInternal['rows'] = [];
  const segments: TextSegment[] = [];

  // Profil bestimmen — explizit oder Auto-Detection über Header.
  const { detectCsvProfile, getCsvProfileById, buildColumnPlan, GENERIC_CSV } =
    require('./csv-profiles') as typeof import('./csv-profiles');

  const header = rawRows.length > 0 ? rawRows[0].map((c) => c.original) : [];
  let profile = profileId && profileId !== 'auto' ? getCsvProfileById(profileId) : undefined;
  if (!profile) profile = detectCsvProfile(header);
  const columnPlan = buildColumnPlan(header, profile);

  for (let r = 0; r < rawRows.length; r++) {
    const rawRow = rawRows[r];
    const row: CsvParseInternal['rows'][number] = [];
    for (let c = 0; c < rawRow.length; c++) {
      const cell = rawRow[c];

      // Header-Zeile (r=0) NIEMALS übersetzen — Magento braucht exakte Spaltennamen.
      // Daten-Zeilen: nur Spalten gemäß Profil-Plan.
      const isHeaderRow = r === 0;
      const planMode = columnPlan.get(c);
      const shouldTranslate =
        !isHeaderRow && planMode !== undefined && isTranslatable(cell.original);

      if (shouldTranslate) {
        const id = `R${r}C${c}`;
        // Fix #6: Riesige Zellen sind oft Magento-CMS-Page-Content. Warnung loggen,
        // damit der Worker (und Operator) sehen kann ob etwas Auffaelliges passiert.
        const cellBytes = Buffer.byteLength(cell.original, 'utf-8');
        if (cellBytes > CSV_CELL_WARN_BYTES) {
          console.warn(
            `[CSV] Grosse Zelle R${r}C${c} (${header[c] || '?'}): ` +
              `${(cellBytes / 1024).toFixed(1)} KB — Mode=${planMode}. ` +
              `Bei Magento-CMS-Page-HTML normal; bei anderen Profilen ggf. pruefen.`,
          );
        }
        row.push({ id, original: cell.original, quoted: cell.quoted });
        segments.push({ id, text: cell.original, mode: planMode });
      } else {
        row.push({ id: null, original: cell.original, quoted: cell.quoted });
      }
    }
    rows.push(row);
  }

  // Generisches Profil als Fallback: Verhalten wie vorher (alle nicht-leeren Zellen
  // ausser Header-Zeile übersetzen). Plan ist dort komplett-translatable.
  if (profile.id === GENERIC_CSV.id && segments.length === 0 && rawRows.length > 1) {
    // Sicherheitsnetz: wenn Plan leer (kein Header erkannt), trotzdem alle Datenzellen
    // ab Zeile 2 als Plain-Text-Segmente nehmen.
    for (let r = 1; r < rawRows.length; r++) {
      for (let c = 0; c < rawRows[r].length; c++) {
        const cell = rawRows[r][c];
        if (isTranslatable(cell.original)) {
          const id = `R${r}C${c}`;
          // Vorhandenes row-Item korrigieren
          rows[r][c] = { id, original: cell.original, quoted: cell.quoted };
          segments.push({ id, text: cell.original, mode: 'text' });
        }
      }
    }
  }

  return {
    segments,
    internal: {
      kind: 'csv',
      data: { rows, delimiter, lineEnding, hasBom, profileId: profile.id, header },
    },
  };
}

export function writeCsv(
  parse: CsvParseInternal,
  translations: Map<string, string>,
  outputPath: string,
): void {
  const lines: string[] = [];
  for (const row of parse.rows) {
    const cells = row.map((cell) => {
      const value = cell.id !== null ? (translations.get(cell.id) ?? cell.original) : cell.original;
      return csvEscapeCell(value, parse.delimiter, cell.quoted);
    });
    lines.push(cells.join(parse.delimiter));
  }
  let body = lines.join(parse.lineEnding);
  // Trailing newline beibehalten falls Original eines hatte (heuristisch: meist gewünscht)
  body += parse.lineEnding;
  if (parse.hasBom) body = BOM + body;
  fs.writeFileSync(outputPath, body, 'utf-8');
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

export function parseTextOrCsv(
  filePath: string,
  fileType: 'txt' | 'csv',
  profileId?: string,
): TextParseResult {
  return fileType === 'csv' ? parseCsv(filePath, profileId) : parseTxt(filePath);
}

export function writeTextOrCsv(
  parse: TextParseResult['internal'],
  translations: Map<string, string>,
  outputPath: string,
): void {
  if (parse.kind === 'csv') writeCsv(parse.data, translations, outputPath);
  else writeTxt(parse.data, translations, outputPath);
}
