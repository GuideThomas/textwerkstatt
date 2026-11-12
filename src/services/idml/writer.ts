/**
 * IDML Re-Writer — Phase 2.2.6
 *
 * Schreibt übersetzte Texte zurück in die Story-XML-Dateien.
 * Nutzt das ContentMapping um Text praezise auf die richtigen
 * Content-Tags aufzuteilen.
 *
 * Strategie:
 * 1. Original-XML lesen (Byte-genau, kein Re-Parsen)
 * 2. Content-Tags per Regex finden und ersetzen
 * 3. Formatierung und Attribute bleiben komplett intakt
 */

import fs from 'fs';
import path from 'path';
import type { IdmlSegment, TranslationMapping } from './types';
import { STYLE_MARKER_TAG } from './parser';

/**
 * Schreibt übersetzte Segmente in die Story-XML-Dateien zurück.
 *
 * Bei unverändertem Text (kein Mapping vorhanden) wird nichts geschrieben.
 * Das garantiert den Round-Trip-Test: Parse → Write ohne Übersetzung → Diff=0.
 */
export function writeTranslations(
  tempDir: string,
  segments: IdmlSegment[],
  translations: TranslationMapping[]
): number {
  // Index: segmentId → translatedText
  const translationMap = new Map<string, string>();
  for (const t of translations) {
    translationMap.set(t.segmentId, t.translatedText);
  }

  // Gruppiere Segmente nach Story-Datei
  const segmentsByFile = new Map<string, IdmlSegment[]>();
  for (const seg of segments) {
    const translated = translationMap.get(seg.id);
    if (translated === undefined) continue; // Kein Mapping → überspringen

    const existing = segmentsByFile.get(seg.storyFile) || [];
    existing.push(seg);
    segmentsByFile.set(seg.storyFile, existing);
  }

  let writtenCount = 0;

  for (const [storyFile, fileSegments] of segmentsByFile) {
    const fullPath = path.join(tempDir, storyFile);
    if (!fs.existsSync(fullPath)) {
      console.error(`[IDML Writer] Story file not found: ${storyFile}`);
      continue;
    }

    let xml = fs.readFileSync(fullPath, 'utf-8');

    // Sortiere Segmente nach paragraphIndex (rückwärts, damit Offsets stimmen)
    const sorted = [...fileSegments].sort((a, b) => b.paragraphIndex - a.paragraphIndex);

    for (const segment of sorted) {
      const translated = translationMap.get(segment.id);
      if (!translated || translated === segment.text) continue;

      xml = replaceSegmentInXml(xml, segment, translated);
      writtenCount++;
    }

    fs.writeFileSync(fullPath, xml, 'utf-8');
  }

  console.log(`[IDML Writer] Wrote ${writtenCount} translations across ${segmentsByFile.size} files`);
  return writtenCount;
}

/**
 * Ersetzt den Text eines Segments in der XML.
 *
 * Bei einem Segment mit mehreren Content-Tags wird der übersetzte Text
 * an den Style-Markern (<x id="N"/>) gesplittet, wenn vorhanden —
 * das erhält die Zuordnung zur korrekten CharacterStyleRange (und damit
 * die richtige Schriftgröße/Stil). Als Fallback: proportionale Verteilung.
 */
function replaceSegmentInXml(
  xml: string,
  segment: IdmlSegment,
  translatedText: string
): string {
  if (segment.contentMap.length === 0) return xml;

  if (segment.contentMap.length === 1) {
    // Einfacher Fall: Ein Content-Tag → direkt ersetzen
    const original = segment.contentMap[0].originalText;
    // Falls DeepL aus Versehen Marker durchgelassen hat, diese entfernen
    const cleaned = stripStyleMarkers(translatedText);
    return replaceContentTag(xml, escapeXml(original), escapeXml(cleaned));
  }

  // Mehrere Content-Tags: zuerst versuchen, an Style-Markern zu splitten
  const parts = segment.hasStyleMarkers
    ? splitAtStyleMarkers(translatedText, segment.contentMap)
    : distributeText(translatedText, segment.contentMap);

  // Rückwärts ersetzen damit Positionen stimmen
  for (let i = segment.contentMap.length - 1; i >= 0; i--) {
    const original = segment.contentMap[i].originalText;
    const replacement = parts[i];
    xml = replaceContentTag(xml, escapeXml(original), escapeXml(replacement));
  }

  return xml;
}

/**
 * Teilt den übersetzten Text an <x id="N"/>-Markern auf und verteilt
 * ihn exakt auf die contentMap-Einträge (nach charStyleIndex).
 *
 * Fehlen Marker (z.B. weil DeepL sie entfernt hat) → Fallback auf
 * proportionale Verteilung.
 */
function splitAtStyleMarkers(
  translatedText: string,
  contentMap: {
    originalText: string;
    startOffset: number;
    endOffset: number;
    charStyleIndex: number;
    contentIndex: number;
  }[]
): string[] {
  // Regex: <x id="N"/> oder <x id='N'/> (mit oder ohne Whitespace)
  const markerRegex = new RegExp(`<${STYLE_MARKER_TAG}\\s+id=["']\\d+["']\\s*/?>`, 'g');

  // Text in Chunks pro CharacterStyleRange zerlegen
  const chunks: string[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(translatedText)) !== null) {
    chunks.push(translatedText.slice(lastIdx, match.index));
    lastIdx = match.index + match[0].length;
  }
  chunks.push(translatedText.slice(lastIdx));

  // Wir erwarten pro CharacterStyleRange einen Chunk.
  // Distinct charStyleIndex-Werte bestimmen die erwartete Chunk-Anzahl.
  const uniqueCharIdxOrder: number[] = [];
  for (const cm of contentMap) {
    if (!uniqueCharIdxOrder.includes(cm.charStyleIndex)) {
      uniqueCharIdxOrder.push(cm.charStyleIndex);
    }
  }

  if (chunks.length !== uniqueCharIdxOrder.length) {
    // Marker fehlen oder sind verdoppelt → auf proportionale Verteilung fallen
    console.warn(
      `[IDML Writer] Style-Marker-Mismatch: ${chunks.length} Chunks, ${uniqueCharIdxOrder.length} CharStyleRanges erwartet — Fallback`
    );
    return distributeText(stripStyleMarkers(translatedText), contentMap);
  }

  // Chunk pro charStyleIndex
  const chunkByCharIdx = new Map<number, string>();
  for (let i = 0; i < uniqueCharIdxOrder.length; i++) {
    chunkByCharIdx.set(uniqueCharIdxOrder[i], chunks[i]);
  }

  // Innerhalb einer CharacterStyleRange: Chunk proportional auf die
  // einzelnen Content-Tags verteilen (anhand der Original-Zeichenzahlen)
  const parts: string[] = new Array(contentMap.length);
  const byCharIdx = new Map<number, { mapIdx: number; origLen: number }[]>();

  for (let i = 0; i < contentMap.length; i++) {
    const cm = contentMap[i];
    const arr = byCharIdx.get(cm.charStyleIndex) || [];
    arr.push({ mapIdx: i, origLen: cm.originalText.length });
    byCharIdx.set(cm.charStyleIndex, arr);
  }

  for (const [charIdx, entries] of byCharIdx) {
    const chunk = chunkByCharIdx.get(charIdx) ?? '';
    if (entries.length === 1) {
      parts[entries[0].mapIdx] = chunk;
      continue;
    }

    const totalOrig = entries.reduce((s, e) => s + e.origLen, 0) || 1;
    let consumed = 0;
    for (let i = 0; i < entries.length; i++) {
      if (i === entries.length - 1) {
        parts[entries[i].mapIdx] = chunk.slice(consumed);
      } else {
        const ratio = entries[i].origLen / totalOrig;
        const count = Math.round(chunk.length * ratio);
        parts[entries[i].mapIdx] = chunk.slice(consumed, consumed + count);
        consumed += count;
      }
    }
  }

  return parts;
}

/** Entfernt <x id="N"/> Marker aus einem Text (Fallback-Cleanup). */
function stripStyleMarkers(text: string): string {
  const markerRegex = new RegExp(`<${STYLE_MARKER_TAG}\\s+id=["']\\d+["']\\s*/?>`, 'g');
  return text.replace(markerRegex, '');
}

/**
 * Verteilt übersetzten Text proportional auf mehrere Content-Tags.
 * Behält die ursprüngliche Verteilung bei (z.B. Bold/Normal Abschnitte).
 */
function distributeText(
  translatedText: string,
  contentMap: { originalText: string; startOffset: number; endOffset: number }[]
): string[] {
  const totalOrigLen = contentMap.reduce((sum, c) => sum + c.originalText.length, 0);

  if (totalOrigLen === 0) return contentMap.map(() => '');

  // Proportionale Verteilung
  const parts: string[] = [];
  let consumed = 0;

  for (let i = 0; i < contentMap.length; i++) {
    const ratio = contentMap[i].originalText.length / totalOrigLen;

    if (i === contentMap.length - 1) {
      // Letzter Teil bekommt den Rest
      parts.push(translatedText.slice(consumed));
    } else {
      const charCount = Math.round(ratio * translatedText.length);
      // An Wortgrenze aufteilen wenn möglich
      let end = consumed + charCount;
      const spaceAfter = translatedText.indexOf(' ', end);
      const spaceBefore = translatedText.lastIndexOf(' ', end);

      if (spaceAfter !== -1 && spaceAfter - end < 5) {
        end = spaceAfter + 1;
      } else if (spaceBefore !== -1 && end - spaceBefore < 5 && spaceBefore > consumed) {
        end = spaceBefore + 1;
      }

      parts.push(translatedText.slice(consumed, end));
      consumed = end;
    }
  }

  return parts;
}

/**
 * Ersetzt den Text innerhalb eines <Content>-Tags in der XML.
 * Findet das erste Vorkommen des Originaltexts in einem Content-Tag.
 */
function replaceContentTag(xml: string, escapedOriginal: string, escapedReplacement: string): string {
  // Regex: <Content>ORIGINALTEXT</Content>
  // Escaped für Regex-Sonderzeichen
  const regexSafe = escapedOriginal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(<Content>)${regexSafe}(</Content>)`, 's');
  return xml.replace(pattern, `$1${escapedReplacement}$2`);
}

/** XML-Sonderzeichen escapen */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
