/**
 * IDML Layer Visibility
 *
 * Liest aus `designmap.xml` welche Layer als ausgeblendet (`Visible="false"`)
 * markiert sind, und walked Spreads + MasterSpreads, um alle TextFrames auf
 * diesen Layern zu finden. Die ParentStory-IDs dieser Frames werden zurueck-
 * gegeben — der Parser ueberspringt dann diese Stories.
 *
 * Hintergrund: Katalog-Master-Pages haben oft einen Layer "Beispieltexte"
 * (Visible="false"), der Formatreferenz-Platzhaltertext enthaelt. Der Layer
 * ist im InDesign-UI ausgeblendet und wird auch nicht gedruckt — soll also
 * nicht uebersetzt werden. Siehe Vorfall 20.05.2026 (Bedienungsanleitung
 * 117453 V2): unsichtbarer Master-Layer wurde mit-uebersetzt.
 */

import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: false,
  trimValues: true,
});

/**
 * Liefert die Story-IDs (Self-Attribute), die auf unsichtbaren Layern liegen.
 *
 * @param tempDir            Verzeichnis mit entpacktem IDML
 * @param spreadFiles        Spread-XML-Dateien (relative Pfade)
 * @param masterSpreadFiles  MasterSpread-XML-Dateien (relative Pfade)
 */
export function findHiddenLayerStories(
  tempDir: string,
  spreadFiles: string[],
  masterSpreadFiles: string[],
): { hiddenStorySelfs: Set<string>; hiddenLayerNames: string[] } {
  const designMapPath = path.join(tempDir, 'designmap.xml');
  const hiddenLayers = parseHiddenLayers(designMapPath);

  const hiddenStorySelfs = new Set<string>();
  if (hiddenLayers.ids.size === 0) {
    return { hiddenStorySelfs, hiddenLayerNames: [] };
  }

  for (const file of [...spreadFiles, ...masterSpreadFiles]) {
    const fullPath = path.join(tempDir, file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const xml = fs.readFileSync(fullPath, 'utf-8');
      const parsed = xmlParser.parse(xml);
      collectFramesOnHiddenLayers(parsed, hiddenLayers.ids, hiddenStorySelfs);
    } catch (err) {
      console.error(`[IDML] Layer-Filter: Failed to parse ${file}:`, err);
    }
  }

  return { hiddenStorySelfs, hiddenLayerNames: Array.from(hiddenLayers.names) };
}

/**
 * Parst designmap.xml und liefert IDs + Namen aller Layer mit Visible="false".
 *
 * Regex statt voll-parsen — designmap kann gross sein und die Layer stehen
 * immer auf einer einzelnen Zeile mit Self+Visible+Name als Attribute.
 * Robust gegen Attribut-Reihenfolge.
 */
function parseHiddenLayers(designMapPath: string): {
  ids: Set<string>;
  names: Set<string>;
} {
  const ids = new Set<string>();
  const names = new Set<string>();

  if (!fs.existsSync(designMapPath)) return { ids, names };

  const xml = fs.readFileSync(designMapPath, 'utf-8');
  const layerMatches = xml.matchAll(/<Layer\b([^>]+)\/?>/g);
  for (const match of layerMatches) {
    const attrs = match[1];
    const visible = attrs.match(/\bVisible\s*=\s*"([^"]+)"/)?.[1];
    if (visible !== 'false') continue;
    const self = attrs.match(/\bSelf\s*=\s*"([^"]+)"/)?.[1];
    const name = attrs.match(/\bName\s*=\s*"([^"]+)"/)?.[1];
    if (self) ids.add(self);
    if (name) names.add(name);
  }

  return { ids, names };
}

/**
 * Walked rekursiv durch ein geparstes Spread/MasterSpread und sammelt
 * ParentStory-IDs aller TextFrames, deren ItemLayer in hiddenLayerIds liegt.
 */
function collectFramesOnHiddenLayers(
  node: any,
  hiddenLayerIds: Set<string>,
  out: Set<string>,
): void {
  if (!node || typeof node !== 'object') return;

  // TextFrame: identifiziert durch ParentStory + (optional) ItemLayer
  if (node['@_ParentStory'] && node['@_ItemLayer']) {
    if (hiddenLayerIds.has(node['@_ItemLayer'])) {
      out.add(node['@_ParentStory']);
    }
  }

  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) collectFramesOnHiddenLayers(item, hiddenLayerIds, out);
    } else if (typeof child === 'object') {
      collectFramesOnHiddenLayers(child, hiddenLayerIds, out);
    }
  }
}
