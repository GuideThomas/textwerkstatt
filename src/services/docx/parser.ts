/**
 * DOCX Parser — Phase 6 + Phase 10 (Tabellen-Support)
 *
 * DOCX ist ein ZIP-Archiv mit XML-Dateien.
 * Text liegt in <w:p> (Paragraphen) → <w:r> (Runs) → <w:t> (Text-Tags).
 *
 * Phase 10: Tabellen-Support
 * ─────────────────────────────
 * Tabellen werden in DOCX als <w:tbl> mit <w:tr> (Zeilen) und <w:tc>
 * (Zellen) gespeichert. Jede Zelle enthält wieder <w:p>-Paragraphen.
 *
 * Fix: Parser enumeriert ALLE <w:p>-Bloecke im Dokument in Dokumenten-
 * reihenfolge — egal ob auf Top-Level oder verschachtelt in Tabellen.
 * Das entspricht exakt der Logik im Writer (replaceParagraphText),
 * wodurch paragraphIndex konsistent bleibt.
 */

import fs from 'fs';
import path from 'path';
import type { DocxSegment } from './types';

/**
 * Parst eine einzelne DOCX-XML-Datei und extrahiert Textsegmente.
 * Enumeriert ALLE <w:p>-Bloecke mit Text-Inhalt, inklusive Paragraphen
 * in Tabellenzellen.
 */
export function parseDocxXml(
  tempDir: string,
  xmlFile: string,
  source: 'body' | 'header' | 'footer',
  idPrefix: string,
): DocxSegment[] {
  const xmlPath = path.join(tempDir, xmlFile);
  if (!fs.existsSync(xmlPath)) return [];

  const xml = fs.readFileSync(xmlPath, 'utf-8');
  const segments: DocxSegment[] = [];

  // Regex: alle <w:p>-Bloecke finden (Nicht-greedy, mehrzeilig)
  // Dieselbe Logik wie im Writer → garantiert synchrone Indizierung.
  const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null;
  let textParaCount = 0;

  while ((match = paraRegex.exec(xml)) !== null) {
    const paraXml = match[0];

    // Nur Paragraphen mit w:t-Tags zählen (leere Absätze skippen)
    if (!/<w:t[\s>]/.test(paraXml)) continue;

    const text = extractParagraphText(paraXml);
    if (!text.trim()) {
      textParaCount++;
      continue;
    }

    // Style-ID aus <w:pStyle w:val="..."/> extrahieren
    const styleMatch = paraXml.match(/<w:pStyle[^>]*w:val=["']([^"']+)["']/);
    const styleId = styleMatch ? styleMatch[1] : null;

    segments.push({
      id: `${idPrefix}_${textParaCount}`,
      text,
      source,
      xmlFile,
      paragraphIndex: textParaCount,
      styleId,
    });

    textParaCount++;
  }

  return segments;
}

/**
 * Extrahiert den kombinierten Text aus einem rohen <w:p>-XML-Block.
 * Sammelt ALLE <w:t>-Inhalte (auch aus Runs in Hyperlinks, aus
 * verschachtelten Elementen etc.) in Dokumentenreihenfolge.
 */
function extractParagraphText(paraXml: string): string {
  const textTagRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  const parts: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = textTagRegex.exec(paraXml)) !== null) {
    parts.push(decodeXmlEntities(m[1]));
  }

  return parts.join('');
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
