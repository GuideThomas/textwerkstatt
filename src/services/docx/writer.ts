/**
 * DOCX Writer — Phase 6
 *
 * Schreibt übersetzte Texte zurück in die DOCX-XML-Dateien.
 * Strategie: Regex-basiert, ersetzt den Text in w:t-Tags pro Paragraph.
 */

import fs from 'fs';
import path from 'path';
import type { DocxSegment, DocxTranslationMapping } from './types';

/**
 * Schreibt Übersetzungen in die entpackten DOCX-XML-Dateien.
 */
export function writeDocxTranslations(
  tempDir: string,
  segments: DocxSegment[],
  translations: DocxTranslationMapping[],
): void {
  // Translation-Map aufbauen
  const translationMap = new Map<string, string>();
  for (const t of translations) {
    translationMap.set(t.segmentId, t.translatedText);
  }

  // Segmente nach XML-Datei gruppieren
  const byFile = new Map<string, DocxSegment[]>();
  for (const seg of segments) {
    const t = translationMap.get(seg.id);
    if (!t) continue;

    const list = byFile.get(seg.xmlFile) || [];
    list.push(seg);
    byFile.set(seg.xmlFile, list);
  }

  // Pro Datei: XML laden, Paragraphen ersetzen, speichern
  for (const [xmlFile, fileSegments] of byFile) {
    const xmlPath = path.join(tempDir, xmlFile);
    let xml = fs.readFileSync(xmlPath, 'utf-8');

    // Rückwärts sortiert, damit Indizes stabil bleiben
    const sorted = [...fileSegments].sort((a, b) => b.paragraphIndex - a.paragraphIndex);

    for (const seg of sorted) {
      const translatedText = translationMap.get(seg.id);
      if (!translatedText) continue;

      xml = replaceParagraphText(xml, seg.paragraphIndex, translatedText);
    }

    fs.writeFileSync(xmlPath, xml, 'utf-8');
  }
}

/**
 * Ersetzt den Text im n-ten Text-Paragraphen.
 * Zählt nur Paragraphen die w:t-Tags enthalten.
 */
function replaceParagraphText(
  xml: string,
  paragraphIndex: number,
  translatedText: string,
): string {
  // Alle w:p Bloecke finden
  const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null;
  let textParaCount = 0;
  let targetMatch: RegExpExecArray | null = null;

  while ((match = paraRegex.exec(xml)) !== null) {
    // Nur Paragraphen mit w:t-Tags zählen
    if (/<w:t[\s>]/.test(match[0])) {
      if (textParaCount === paragraphIndex) {
        targetMatch = match;
        break;
      }
      textParaCount++;
    }
  }

  if (!targetMatch) return xml;

  const paraXml = targetMatch[0];
  const paraStart = targetMatch.index;

  // Alle w:t-Tags im Paragraphen finden
  const textTagRegex = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g;
  const textParts: { fullMatch: string; text: string }[] = [];
  let tMatch: RegExpExecArray | null;

  while ((tMatch = textTagRegex.exec(paraXml)) !== null) {
    textParts.push({
      fullMatch: tMatch[0],
      text: tMatch[2],
    });
  }

  if (textParts.length === 0) return xml;

  let newParaXml = paraXml;

  if (textParts.length === 1) {
    // Ein w:t-Tag: alles ersetzen
    const part = textParts[0];
    const attrs = part.fullMatch.match(/<w:t(\s[^>]*)?>/)?.[1] || '';
    const spaceAttr = attrs.includes('xml:space') ? attrs : ' xml:space="preserve"';
    newParaXml = newParaXml.replace(
      part.fullMatch,
      `<w:t${spaceAttr}>${escapeXml(translatedText)}</w:t>`,
    );
  } else {
    // Mehrere w:t-Tags: Text proportional verteilen
    const totalOrigLen = textParts.reduce((sum, p) => sum + p.text.length, 0);
    let remaining = translatedText;

    for (let i = textParts.length - 1; i >= 0; i--) {
      const part = textParts[i];
      let chunk: string;

      if (i === 0) {
        chunk = remaining;
      } else {
        const ratio = totalOrigLen > 0 ? part.text.length / totalOrigLen : 1 / textParts.length;
        const charCount = Math.round(translatedText.length * ratio);
        chunk = remaining.slice(-charCount);
        remaining = remaining.slice(0, -charCount);
      }

      const attrs = part.fullMatch.match(/<w:t(\s[^>]*)?>/)?.[1] || '';
      const spaceAttr = attrs.includes('xml:space') ? attrs : ' xml:space="preserve"';
      newParaXml = newParaXml.replace(
        part.fullMatch,
        `<w:t${spaceAttr}>${escapeXml(chunk)}</w:t>`,
      );
    }
  }

  return xml.slice(0, paraStart) + newParaXml + xml.slice(paraStart + paraXml.length);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
