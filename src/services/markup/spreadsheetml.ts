/**
 * Excel-2003-SpreadsheetML-XML-Support (Magento CMS Page Import/Export).
 *
 * Magento exportiert CMS-Seiten als SpreadsheetML (mso-application progid="Excel.Sheet"),
 * NICHT als Tag-basiertes XML. Die Spaltennamen stehen als Text in
 * <Data ss:Type="String">title</Data>-Zellen der ersten <Row>, nicht als XML-Tags.
 *
 * Schutz-Strategie:
 *   1. Erste <Row> = Header → ALLE Zellen-Texte schuetzen.
 *   2. Datenzeilen → nur Cells, deren Spalte NICHT in translatableColumns liegt,
 *      werden geschuetzt (identifier, page_layout, store_id, Timestamps, ...).
 *
 * Mechanik: Schutz-Cell-Inhalte werden mit <isolnotr>...</isolnotr> umschlossen,
 * DeepL bekommt diesen Tag als ignoreTag. Nach der Uebersetzung werden alle
 * <isolnotr>-Wrapper wieder entfernt.
 */
import { CsvProfile } from '../text/csv-profiles';

export const SPREADSHEETML_IGNORE_TAG = 'isolnotr';

export function isSpreadsheetML(content: string): boolean {
  const head = content.slice(0, 2000);
  return (
    /mso-application[^?]*progid=["']Excel\.Sheet["']/i.test(head) ||
    /xmlns(:ss)?=["']urn:schemas-microsoft-com:office:spreadsheet["']/i.test(head)
  );
}

export function extractSpreadsheetMLHeader(content: string): string[] | undefined {
  const tableMatch = content.match(/<Table\b[^>]*>([\s\S]*?)<\/Table>/i);
  if (!tableMatch) return undefined;
  const firstRowMatch = tableMatch[1].match(/<Row\b[^>]*>([\s\S]*?)<\/Row>/i);
  if (!firstRowMatch) return undefined;
  const rowXml = firstRowMatch[1];

  const headers: string[] = [];
  let colIdx = 0;
  const cellRe = /<Cell\b([^>]*)>([\s\S]*?)<\/Cell>/gi;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(rowXml)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const idxMatch = attrs.match(/ss:Index\s*=\s*["'](\d+)["']/i);
    if (idxMatch) {
      const target = parseInt(idxMatch[1], 10) - 1;
      while (headers.length < target) headers.push('');
      colIdx = target;
    }
    const dataMatch = inner.match(/<Data\b[^>]*>([\s\S]*?)<\/Data>/i);
    headers[colIdx] = dataMatch ? decodeXmlText(dataMatch[1].trim()) : '';
    colIdx++;
  }
  return headers;
}

function decodeXmlText(s: string): string {
  return s
    // Numerische Entities VOR named entities dekodieren (z.B. &#10; → \n, &#x0A; → \n).
    // Muss VOR &amp; stehen, sonst wuerden &amp;#10; → &#10; → \n (doppelt dekodiert).
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function protectSpreadsheetML(
  content: string,
  profile: CsvProfile,
): string {
  const headers = extractSpreadsheetMLHeader(content);
  if (!headers || headers.length === 0) return content;

  const translatable = new Set(
    (profile.translatableColumns || []).map((c) => c.trim().toLowerCase()),
  );

  const colPlan: ('translate' | 'protect')[] = headers.map((h) =>
    translatable.has(h.trim().toLowerCase()) ? 'translate' : 'protect',
  );

  let rowCounter = 0;
  return content.replace(
    /<Row\b[^>]*>[\s\S]*?<\/Row>/gi,
    (rowMatch) => {
      const isHeaderRow = rowCounter++ === 0;
      return rewriteRow(rowMatch, colPlan, isHeaderRow);
    },
  );
}

function rewriteRow(
  rowXml: string,
  colPlan: ('translate' | 'protect')[],
  isHeaderRow: boolean,
): string {
  let colIdx = 0;
  return rowXml.replace(
    /(<Cell\b)([^>]*)(>)([\s\S]*?)(<\/Cell>)/gi,
    (_full, openTag, attrs, gt, inner, closeTag) => {
      const idxMatch = (attrs as string).match(/ss:Index\s*=\s*["'](\d+)["']/i);
      if (idxMatch) colIdx = parseInt(idxMatch[1], 10) - 1;
      const currentCol = colIdx;
      colIdx++;

      const plan = isHeaderRow ? 'protect' : (colPlan[currentCol] ?? 'protect');
      if (plan === 'translate') return openTag + attrs + gt + inner + closeTag;

      const protectedInner = inner.replace(
        /(<Data\b[^>]*>)([\s\S]*?)(<\/Data>)/gi,
        (_d: string, dOpen: string, dInner: string, dClose: string) => {
          if (dInner.trim() === '') return dOpen + dInner + dClose;
          if (dInner.startsWith(`<${SPREADSHEETML_IGNORE_TAG}>`)) {
            return dOpen + dInner + dClose;
          }
          return `${dOpen}<${SPREADSHEETML_IGNORE_TAG}>${dInner}</${SPREADSHEETML_IGNORE_TAG}>${dClose}`;
        },
      );
      return openTag + attrs + gt + protectedInner + closeTag;
    },
  );
}

export function unprotectSpreadsheetML(content: string): string {
  const re = new RegExp(
    `<${SPREADSHEETML_IGNORE_TAG}>([\\s\\S]*?)</${SPREADSHEETML_IGNORE_TAG}>`,
    'gi',
  );
  return content.replace(re, '$1');
}

// ---------------------------------------------------------------------------
// Per-Zelle-Uebersetzung (CMS-Page-Content ist HTML — muss in DeepL HTML-Modus
// uebersetzt werden, nicht als Text-im-XML, weil DeepL sonst Tags droppt.)
// ---------------------------------------------------------------------------

export interface SpreadsheetMLCell {
  /** Stabile ID: `cell:<rowIdx>:<columnName>` (rowIdx 1-basiert ohne Header). */
  id: string;
  /** 'html' fuer Spalten in profile.htmlColumns (z.B. content), sonst 'text'. */
  mode: 'text' | 'html';
  /** Cell-Inhalt: bei 'html' bereits entity-decoded, bei 'text' as-is. */
  text: string;
  /** Spaltenname laut Header. */
  column: string;
  /** Position im File (fuer assembleSpreadsheetML). */
  rowIdx: number;
  colIdx: number;
}

function encodeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Extrahiert alle uebersetzbaren Cell-Inhalte aus SpreadsheetML.
 * Header-Row und nicht-uebersetzbare Spalten werden uebersprungen.
 */
export function parseTranslatableCells(
  content: string,
  profile: CsvProfile,
): SpreadsheetMLCell[] {
  const headers = extractSpreadsheetMLHeader(content);
  if (!headers || headers.length === 0) return [];

  const translatable = new Set(
    (profile.translatableColumns || []).map((c) => c.trim().toLowerCase()),
  );
  const htmlCols = new Set(
    (profile.htmlColumns || []).map((c) => c.trim().toLowerCase()),
  );

  const cells: SpreadsheetMLCell[] = [];
  let rowCounter = 0; // 0 = header

  const rowRe = /<Row\b[^>]*>([\s\S]*?)<\/Row>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(content)) !== null) {
    if (rowCounter === 0) { rowCounter++; continue; }
    const rowIdx = rowCounter;
    rowCounter++;

    const rowXml = rowMatch[1];
    let colIdx = 0;
    const cellRe = /<Cell\b([^>]*)>([\s\S]*?)<\/Cell>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowXml)) !== null) {
      const attrs = cellMatch[1] || '';
      const inner = cellMatch[2] || '';
      const idxMatch = attrs.match(/ss:Index\s*=\s*["'](\d+)["']/i);
      if (idxMatch) colIdx = parseInt(idxMatch[1], 10) - 1;
      const currentCol = colIdx;
      colIdx++;

      const columnName = (headers[currentCol] || '').trim().toLowerCase();
      if (!translatable.has(columnName)) continue;

      const dataMatch = inner.match(/<Data\b[^>]*>([\s\S]*?)<\/Data>/i);
      const raw = dataMatch ? dataMatch[1] : '';
      if (raw.trim() === '') continue;

      const isHtml = htmlCols.has(columnName);
      const decoded = isHtml ? decodeXmlText(raw) : decodeXmlText(raw);

      cells.push({
        id: `cell:${rowIdx}:${columnName}`,
        mode: isHtml ? 'html' : 'text',
        text: decoded,
        column: headers[currentCol],
        rowIdx,
        colIdx: currentCol,
      });
    }
  }

  return cells;
}

/**
 * Setzt uebersetzte Cell-Texte in den Original-SpreadsheetML-Content ein.
 * Header bleibt englisch, technische Spalten unangetastet (per-cell positions
 * werden deterministisch ueber rowIdx+colIdx geloest).
 */
export function assembleSpreadsheetML(
  originalContent: string,
  translationsByCellId: Map<string, string>,
  profile: CsvProfile,
): string {
  const headers = extractSpreadsheetMLHeader(originalContent);
  if (!headers || headers.length === 0) return originalContent;

  const translatable = new Set(
    (profile.translatableColumns || []).map((c) => c.trim().toLowerCase()),
  );

  let rowCounter = 0;
  return originalContent.replace(
    /<Row\b[^>]*>[\s\S]*?<\/Row>/gi,
    (rowMatch) => {
      const isHeaderRow = rowCounter++ === 0;
      if (isHeaderRow) return rowMatch;
      const rowIdx = rowCounter - 1;

      let colIdx = 0;
      return rowMatch.replace(
        /(<Cell\b)([^>]*)(>)([\s\S]*?)(<\/Cell>)/gi,
        (_full, openTag, attrs, gt, inner, closeTag) => {
          const idxMatch = (attrs as string).match(/ss:Index\s*=\s*["'](\d+)["']/i);
          if (idxMatch) colIdx = parseInt(idxMatch[1], 10) - 1;
          const currentCol = colIdx;
          colIdx++;

          const columnName = (headers[currentCol] || '').trim().toLowerCase();
          if (!translatable.has(columnName)) {
            return openTag + attrs + gt + inner + closeTag;
          }

          const cellId = `cell:${rowIdx}:${columnName}`;
          const translation = translationsByCellId.get(cellId);
          if (translation === undefined) {
            return openTag + attrs + gt + inner + closeTag;
          }

          // Inneren <Data>-Inhalt ersetzen (XML-Encoding); ueberlaesst <Data ...>-Attribute unveraendert.
          const newInner = inner.replace(
            /(<Data\b[^>]*>)([\s\S]*?)(<\/Data>)/i,
            (_d: string, dOpen: string, _dInner: string, dClose: string) =>
              dOpen + encodeXmlText(translation) + dClose,
          );
          return openTag + attrs + gt + newInner + closeTag;
        },
      );
    },
  );
}
