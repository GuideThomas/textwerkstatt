/**
 * IDML Story Parser — Phase 2.2.2 + 2.2.3 + 2.2.4 + Phase 10 (Tables + Style-Marker)
 *
 * Parst Story-XML-Dateien und extrahiert Textsegmente.
 *
 * Phase 10 Erweiterungen:
 * - Rekursive Extraktion: erfasst auch Paragraphen in Tabellen
 *   (<Table> → <Row>/<Cell> → <ParagraphStyleRange>)
 * - Style-Marker: bei Paragraphen mit mehreren CharacterStyleRanges
 *   werden <x id="N"/> Marker in den kombinierten Text eingewoben,
 *   damit DeepL (tag_handling=xml, ignore_tags=x) die Grenzen erhält
 *   und wir die Übersetzung exakt auf die richtige CharacterStyleRange
 *   (mit ursprünglicher Schriftgröße/Stil) zurückschreiben können.
 *
 * IDML XML Struktur (vereinfacht):
 * <Story Self="u123">
 *   <ParagraphStyleRange AppliedParagraphStyle="...">
 *     <CharacterStyleRange AppliedCharacterStyle="...">
 *       <Content>Text hier</Content>
 *     </CharacterStyleRange>
 *     <Table Self="..."><Row/><Cell>
 *       <ParagraphStyleRange>
 *         <CharacterStyleRange><Content>Zellentext</Content></CharacterStyleRange>
 *       </ParagraphStyleRange>
 *     </Cell></Table>
 *   </ParagraphStyleRange>
 * </Story>
 */

import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import type { IdmlSegment, ContentMapping } from './types';

// fast-xml-parser Konfiguration für IDML
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,  // Leerzeichen in Content sind wichtig!
  cdataPropName: '__cdata',
  commentPropName: '__comment',
  textNodeName: '#text',
});

/** Marker-Tag-Name für Style-Grenzen (muss in DeepL ignore_tags stehen). */
export const STYLE_MARKER_TAG = 'x';

/**
 * Parst eine einzelne Story-XML-Datei und extrahiert Segmente (inkl. Tabellenzellen).
 */
export function parseStoryFile(storyFilePath: string, storyFileName: string): IdmlSegment[] {
  const xml = fs.readFileSync(storyFilePath, 'utf-8');
  const parsed = xmlParser.parse(xml);

  const segments: IdmlSegment[] = [];

  // Root ist ein Array bei preserveOrder
  const storyNodes = findNodes(parsed, 'Story');
  if (storyNodes.length === 0) {
    // Manche Stories sind in idPkg:Story gewrapped
    const pkgStories = findNodes(parsed, 'idPkg:Story');
    for (const pkgStory of pkgStories) {
      const innerStories = findChildNodes(pkgStory, 'Story');
      storyNodes.push(...innerStories);
    }
  }

  for (const storyNode of storyNodes) {
    const storySelf = getAttr(storyNode, 'Self') || path.basename(storyFileName, '.xml');

    // Rekursiv alle ParagraphStyleRange-Knoten in dieser Story sammeln
    // (Pre-order DFS: zuerst der ParagraphStyleRange, dann Kinder in Tabellen)
    const allParagraphs: any[] = [];
    collectParagraphStyleRanges(storyNode, allParagraphs);

    for (let pIdx = 0; pIdx < allParagraphs.length; pIdx++) {
      const para = allParagraphs[pIdx];
      const result = extractParagraphSegment(para, storyFileName, storySelf, pIdx);
      if (result && result.text.trim().length > 0) {
        segments.push(result);
      }
    }
  }

  return segments;
}

/**
 * Rekursiv alle ParagraphStyleRange-Knoten in Pre-Order-DFS sammeln.
 * Erfasst sowohl Top-Level-Paragraphen als auch verschachtelte
 * Paragraphen in <Cell>-Elementen (Tabellen).
 */
function collectParagraphStyleRanges(node: any, out: any[]): void {
  if (!node || typeof node !== 'object') return;

  // Der preserveOrder-Node hat die Form { TagName: [children], ':@': {attrs} }
  const keys = Object.keys(node).filter(k => k !== ':@');

  for (const key of keys) {
    const children = node[key];
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      if (!child || typeof child !== 'object') continue;

      // Ist das Kind selbst eine ParagraphStyleRange?
      if ('ParagraphStyleRange' in child) {
        out.push(child);
        // NICHT weiter rekursieren — der Paragraph-Extractor kuemmert sich
        // um Content innerhalb dieses Paragraphs. Tabellen innerhalb eines
        // Paragraphs erzeugen separate innere ParagraphStyleRanges (in Cells),
        // die der Extractor ignoriert; diese sammeln wir hier separat:
        collectNestedCellParagraphs(child, out);
      } else {
        // Durch andere Container (Table, Row, Cell, XMLElement, ...) hindurchgehen
        collectParagraphStyleRanges(child, out);
      }
    }
  }
}

/**
 * Findet ParagraphStyleRanges, die innerhalb von <Cell>-Elementen eines
 * gegebenen Parent-ParagraphStyleRange liegen. Damit werden Tabellenzellen
 * als eigene Segmente erfasst.
 */
function collectNestedCellParagraphs(paraNode: any, out: any[]): void {
  // Finde alle Tables innerhalb des Paragraphs (auch tief verschachtelt)
  const tables: any[] = [];
  collectDescendantsByTag(paraNode, 'Table', tables);

  for (const table of tables) {
    const cells: any[] = [];
    collectDescendantsByTag(table, 'Cell', cells);
    for (const cell of cells) {
      // Direkte und verschachtelte ParagraphStyleRanges innerhalb der Cell
      const cellParagraphs: any[] = [];
      collectDescendantsByTag(cell, 'ParagraphStyleRange', cellParagraphs);
      for (const p of cellParagraphs) {
        out.push(p);
        // Falls verschachtelte Tabellen: auch deren Zellen erfassen
        collectNestedCellParagraphs(p, out);
      }
    }
  }
}

/** Findet alle Descendants mit gegebenem Tag-Namen (Pre-Order-DFS). */
function collectDescendantsByTag(node: any, tagName: string, out: any[]): void {
  if (!node || typeof node !== 'object') return;
  const keys = Object.keys(node).filter(k => k !== ':@');
  for (const key of keys) {
    const children = node[key];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      if (tagName in child) {
        out.push(child);
      }
      collectDescendantsByTag(child, tagName, out);
    }
  }
}

/**
 * Extrahiert ein Segment aus einem ParagraphStyleRange.
 * Kombiniert alle Content-Tags zu einem zusammenhaengenden Text.
 * Bei mehreren CharacterStyleRanges werden Style-Marker eingefügt.
 *
 * WICHTIG: Content-Tags werden NUR innerhalb der DIREKTEN
 * CharacterStyleRanges des Paragraphs gesammelt — Tabellen-Inhalt
 * wird separat als eigene Segmente erfasst (siehe collectNestedCellParagraphs).
 */
function extractParagraphSegment(
  paraNode: any,
  storyFile: string,
  storySelf: string,
  paragraphIndex: number
): IdmlSegment | null {
  const contentMap: ContentMapping[] = [];
  let combinedText = '';

  const charRanges = findChildNodes(paraNode, 'CharacterStyleRange');

  // Erst einmal zählen, wie viele CharacterStyleRanges tatsächlich Text enthalten
  // (damit wir entscheiden, ob Style-Marker sinnvoll sind)
  const rangesWithText: { idx: number; contents: any[] }[] = [];
  for (let csIdx = 0; csIdx < charRanges.length; csIdx++) {
    const charRange = charRanges[csIdx];
    const contents = findChildNodes(charRange, 'Content');
    const hasText = contents.some(c => {
      const t = getTextContent(c);
      return t !== null && t.length > 0;
    });
    if (hasText) {
      rangesWithText.push({ idx: csIdx, contents });
    }
  }

  const useMarkers = rangesWithText.length > 1;

  for (let rIdx = 0; rIdx < rangesWithText.length; rIdx++) {
    const { idx: csIdx, contents } = rangesWithText[rIdx];

    // Vor jeder Range (außer der ersten) einen Style-Marker einfügen
    if (useMarkers && rIdx > 0) {
      combinedText += `<${STYLE_MARKER_TAG} id="${rIdx}"/>`;
    }

    for (let cIdx = 0; cIdx < contents.length; cIdx++) {
      const contentText = getTextContent(contents[cIdx]);
      if (contentText === null) continue;

      const startOffset = combinedText.length;
      combinedText += contentText;

      contentMap.push({
        startOffset,
        endOffset: combinedText.length,
        originalText: contentText,
        charStyleIndex: csIdx,
        contentIndex: cIdx,
      });
    }
  }

  if (combinedText.length === 0) return null;

  return {
    id: `story_${storySelf}_p${paragraphIndex}`,
    text: combinedText,
    storyFile,
    storySelf,
    paragraphIndex,
    contentMap,
    maxChars: null,
    hasStyleMarkers: useMarkers,
  };
}

/**
 * Parst alle Story-Dateien in einem entpackten IDML-Verzeichnis.
 */
export function parseAllStories(tempDir: string, storyFiles: string[]): IdmlSegment[] {
  const allSegments: IdmlSegment[] = [];

  for (const storyFile of storyFiles) {
    const fullPath = path.join(tempDir, storyFile);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const segments = parseStoryFile(fullPath, storyFile);
      allSegments.push(...segments);
    } catch (err) {
      console.error(`[IDML] Failed to parse ${storyFile}:`, err);
    }
  }

  const markerCount = allSegments.filter(s => s.hasStyleMarkers).length;
  console.log(`[IDML] Extracted ${allSegments.length} segments from ${storyFiles.length} stories (${markerCount} with style markers)`);
  return allSegments;
}

// ─── Hilfsfunktionen für preserveOrder-Format ─────────────────────────

/**
 * Findet Nodes mit einem bestimmten Tag-Namen in einem preserveOrder-Array.
 * preserveOrder gibt [{tagName: [...children]}, ...] zurück.
 */
function findNodes(arr: any[], tagName: string): any[] {
  const results: any[] = [];
  if (!Array.isArray(arr)) return results;

  for (const item of arr) {
    if (item && typeof item === 'object' && tagName in item) {
      results.push(item);
    }
  }
  return results;
}

/**
 * Findet Kind-Nodes eines preserveOrder-Nodes.
 */
function findChildNodes(node: any, tagName: string): any[] {
  // Bei preserveOrder hat jeder Node die Form: { TagName: [...children], ':@': {attrs} }
  // Die children sind im Array unter dem Tag-Key
  const keys = Object.keys(node).filter(k => k !== ':@');
  const results: any[] = [];

  for (const key of keys) {
    const children = node[key];
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      if (child && typeof child === 'object' && tagName in child) {
        results.push(child);
      }
    }
  }

  return results;
}

/**
 * Liest ein Attribut aus einem preserveOrder-Node.
 */
function getAttr(node: any, attrName: string): string | undefined {
  const attrs = node[':@'];
  if (!attrs) return undefined;
  return attrs[`@_${attrName}`];
}

/**
 * Extrahiert den Textinhalt eines Content-Nodes.
 */
function getTextContent(contentNode: any): string | null {
  const children = contentNode['Content'];
  if (!Array.isArray(children)) return null;

  let text = '';
  for (const child of children) {
    if (child && typeof child === 'object' && '#text' in child) {
      text += child['#text'];
    }
  }

  return text.length > 0 ? text : null;
}
