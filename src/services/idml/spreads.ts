/**
 * IDML Spread Parser — Phase 2.2.5
 *
 * Liest Frame-Dimensionen aus Spreads/*.xml für die
 * maxChars-Berechnung bei Textboxen.
 *
 * InDesign TextFrames haben ein PathPointArray mit Koordinaten:
 * <TextFrame Self="..." ParentStory="u123" ...>
 *   <Properties>
 *     <PathGeometry>
 *       <GeometryPathType>
 *         <PathPointArray>
 *           <PathPointType Anchor="-100 -50" ... />
 *           <PathPointType Anchor="100 -50" ... />
 *           <PathPointType Anchor="100 50" ... />
 *           <PathPointType Anchor="-100 50" ... />
 *         </PathPointArray>
 *       </GeometryPathType>
 *     </PathGeometry>
 *   </Properties>
 * </TextFrame>
 */

import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import type { TextFrameDimension } from './types';

// Durchschnittliche Zeichenbreite in Points (für Schätzung)
// Basierend auf ~6pt pro Zeichen bei 10pt Schriftgröße
const AVG_CHAR_WIDTH_PT = 6;
const AVG_LINE_HEIGHT_PT = 14;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: false, // Hier brauchen wir keine Ordnung
  trimValues: true,
});

/**
 * Parst alle Spread-Dateien und extrahiert TextFrame-Dimensionen.
 */
export function parseSpreadDimensions(
  tempDir: string,
  spreadFiles: string[]
): Map<string, TextFrameDimension> {
  const dimensions = new Map<string, TextFrameDimension>();

  for (const spreadFile of spreadFiles) {
    const fullPath = path.join(tempDir, spreadFile);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const xml = fs.readFileSync(fullPath, 'utf-8');
      const parsed = xmlParser.parse(xml);
      extractTextFrames(parsed, dimensions);
    } catch (err) {
      console.error(`[IDML] Failed to parse spread ${spreadFile}:`, err);
    }
  }

  console.log(`[IDML] Found ${dimensions.size} text frame dimensions`);
  return dimensions;
}

function extractTextFrames(
  node: any,
  dimensions: Map<string, TextFrameDimension>
): void {
  if (!node || typeof node !== 'object') return;

  // TextFrame direkt gefunden
  if (node['@_ParentStory'] && node['@_Self']) {
    const frame = parseTextFrame(node);
    if (frame) {
      dimensions.set(frame.parentStory, frame);
    }
  }

  // Rekursiv suchen
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        extractTextFrames(item, dimensions);
      }
    } else if (typeof child === 'object') {
      extractTextFrames(child, dimensions);
    }
  }

  // TextFrame als Array-Element
  if (node.TextFrame) {
    const frames = Array.isArray(node.TextFrame) ? node.TextFrame : [node.TextFrame];
    for (const frame of frames) {
      const parsed = parseTextFrame(frame);
      if (parsed) {
        dimensions.set(parsed.parentStory, parsed);
      }
    }
  }
}

function parseTextFrame(frame: any): TextFrameDimension | null {
  const parentStory = frame['@_ParentStory'];
  if (!parentStory) return null;

  // Versuche PathPointArray zu finden
  const pathPoints = findPathPoints(frame);
  if (pathPoints.length < 4) return null;

  // Bounding Box aus Anchor-Punkten berechnen
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const point of pathPoints) {
    const anchor = point['@_Anchor'];
    if (!anchor) continue;

    const [x, y] = anchor.split(' ').map(Number);
    if (isNaN(x) || isNaN(y)) continue;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (!isFinite(minX)) return null;

  const width = Math.abs(maxX - minX);
  const height = Math.abs(maxY - minY);

  // Schätzung: Zeichen pro Zeile * Anzahl Zeilen
  const charsPerLine = Math.floor(width / AVG_CHAR_WIDTH_PT);
  const lines = Math.floor(height / AVG_LINE_HEIGHT_PT);
  const estimatedMaxChars = charsPerLine * Math.max(lines, 1);

  return { parentStory, width, height, estimatedMaxChars };
}

function findPathPoints(node: any): any[] {
  if (!node || typeof node !== 'object') return [];

  if (node.PathPointType) {
    return Array.isArray(node.PathPointType) ? node.PathPointType : [node.PathPointType];
  }

  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const result = findPathPoints(item);
        if (result.length > 0) return result;
      }
    } else if (typeof child === 'object') {
      const result = findPathPoints(child);
      if (result.length > 0) return result;
    }
  }

  return [];
}
