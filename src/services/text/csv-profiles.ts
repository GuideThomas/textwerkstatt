/**
 * CSV-Format-Profile für Translationtool.
 *
 * Statt jede CSV-Zelle blind durch DeepL zu jagen, weiss das Profil welche
 * Spalten übersetzbar sind (title, meta_*, content) und welche technisch
 * (identifier, page_layout, store_id, ...). Spalten mit HTML-Inhalt bekommen
 * DeepL HTML-Modus + ignore_tags für style/script.
 *
 * Magento-Konstanten (1column, inner, default, ...) werden über Pre-/Post-
 * Replacement geschützt — gleiches Pattern wie bei Channel-Overrides.
 */

export interface CsvProfile {
  id: string;
  name: string;
  /** Header-basierte Auto-Erkennung (CSV): liefert true wenn Header diesem Profil entspricht. */
  detect: (header: string[]) => boolean;
  /** Content-basierte Auto-Erkennung (XML): liefert true wenn der File-Inhalt diesem Profil entspricht. */
  detectXml?: (content: string) => boolean;
  /** Spalten, deren Werte übersetzt werden sollen. Alles andere bleibt unangetastet. */
  translatableColumns: string[];
  /** Subset von translatableColumns: enthält HTML — DeepL bekommt tagHandling=html. */
  htmlColumns: string[];
  /** Tokens, die selbst innerhalb von HTML-Inhalten nie übersetzt werden duerfen.
   *  Werden vor DeepL durch Sentinel-Strings ersetzt und danach restauriert. */
  preservedTokens?: string[];
  /** Zusätzliche XML/HTML-Tags, deren Inhalt für DeepL als ignoreTag markiert wird —
   *  greift im Markup-Pfad (file_type=xml/html). Magento z.B. hat technische Tags wie
   *  `<identifier>`, `<page_layout>` deren Inhalt nicht übersetzt werden darf. */
  xmlIgnoreTags?: string[];
}

export const MAGENTO_CMS_PAGE: CsvProfile = {
  id: 'magento-cms-page',
  name: 'Magento CMS-Page Export',
  detect: (header) =>
    header.includes('identifier') &&
    header.includes('page_layout') &&
    header.includes('content'),
  detectXml: (content) => {
    // 1) Tag-basiertes Magento-CMS-XML (echte <page_layout>/<identifier> Tags)
    if (/<page_layout\b/.test(content) && /<identifier\b/.test(content)) return true;
    // 2) SpreadsheetML (Excel 2003 Export): Headernamen stehen als TEXT in <Data>-Cells.
    //    Erkennung via Sniff + Header-Extraktion.
    try {
      // Lazy require um Zyklus zu vermeiden (markup importiert csv-profiles)
      const { isSpreadsheetML, extractSpreadsheetMLHeader } = require('../markup/spreadsheetml');
      if (isSpreadsheetML(content)) {
        const headers = extractSpreadsheetMLHeader(content);
        if (headers) {
          const lower = headers.map((h: string) => h.trim().toLowerCase());
          if (lower.includes('identifier') && lower.includes('page_layout') && lower.includes('content')) {
            return true;
          }
        }
      }
    } catch { /* spreadsheetml-Modul evtl. nicht geladen — Fallback false */ }
    return false;
  },
  translatableColumns: [
    'title',
    'meta_title',
    'meta_keywords',
    'meta_description',
    'content_heading',
    'content',
  ],
  htmlColumns: ['content'],
  // Magento-CMS-Page XML enthält diese Tags als technische Felder — Inhalt darf
  // niemals übersetzt werden (Werte wie '1column', URL-Identifier, Timestamps).
  xmlIgnoreTags: [
    'identifier',
    'page_layout',
    'store_id',
    'is_active',
    'creation_time',
    'update_time',
    'custom_theme_from',
    'custom_theme_to',
    'custom_theme',
    'custom_root_template',
    'layout_update_xml',
    'custom_layout_update_xml',
    'sort_order',
  ],
  preservedTokens: [
    // Magento Page-Layout-Werte
    '1column',
    '2columns-left',
    '2columns-right',
    '3columns',
    'empty',
    // PageBuilder data-content-type Werte
    'row',
    'column-group',
    'column-line',
    'column',
    'html',
    'text',
    'heading',
    'image',
    'video',
    'banner',
    'slider',
    'slide',
    'buttons',
    'button-item',
    'divider',
    'tabs',
    'tab-item',
    'block',
    'dynamic_block',
    'products',
    'map',
    // PageBuilder data-appearance Werte
    'contained',
    'full-width',
    'full-bleed',
    'full-height',
    'default',
    'collage-left',
    'collage-centered',
    'collage-right',
    'poster',
    // PageBuilder element/main/inner Schlüsselwoerter
    'inner',
    'main',
    // Magento File-Path Konvention (bleibt unverändert)
    'pagebuilder-column-group',
    'pagebuilder-column-line',
    'pagebuilder-column',
    'pagebuilder-row',
  ],
};

export const MAGENTO_CMS_BLOCK: CsvProfile = {
  id: 'magento-cms-block',
  name: 'Magento CMS-Block Export',
  // Block hat title+identifier+content wie Page, ABER kein page_layout
  // (das ist der disambiguierende Unterschied — Page hat Layout-Felder, Block nicht).
  detect: (header) =>
    header.includes('identifier') &&
    header.includes('content') &&
    !header.includes('page_layout'),
  detectXml: (content) => {
    // Tag-basiertes Magento-Block-XML (echte <identifier>/<content> ohne <page_layout>)
    if (/<identifier\b/.test(content) && /<content\b/.test(content) && !/<page_layout\b/.test(content)) {
      return true;
    }
    // SpreadsheetML-Variante
    try {
      const { isSpreadsheetML, extractSpreadsheetMLHeader } = require('../markup/spreadsheetml');
      if (isSpreadsheetML(content)) {
        const headers = extractSpreadsheetMLHeader(content);
        if (headers) {
          const lower = headers.map((h: string) => h.trim().toLowerCase());
          if (
            lower.includes('identifier') &&
            lower.includes('content') &&
            !lower.includes('page_layout')
          ) {
            return true;
          }
        }
      }
    } catch { /* spreadsheetml-Modul evtl. nicht geladen — Fallback false */ }
    return false;
  },
  translatableColumns: [
    'title',
    'content',
  ],
  htmlColumns: ['content'],
  xmlIgnoreTags: [
    'identifier',
    'store_id',
    'is_active',
    'creation_time',
    'update_time',
  ],
  // PageBuilder-Konstanten identisch zu Page — Block-Content nutzt gleiches Markup.
  preservedTokens: [
    'row', 'column-group', 'column-line', 'column',
    'html', 'text', 'heading', 'image', 'video',
    'banner', 'slider', 'slide', 'buttons', 'button-item',
    'divider', 'tabs', 'tab-item', 'block', 'dynamic_block',
    'products', 'map',
    'contained', 'full-width', 'full-bleed', 'full-height',
    'default', 'collage-left', 'collage-centered', 'collage-right', 'poster',
    'inner', 'main',
    'pagebuilder-column-group', 'pagebuilder-column-line',
    'pagebuilder-column', 'pagebuilder-row',
  ],
};

export const MAGENTO_PRODUCT: CsvProfile = {
  id: 'magento-product',
  name: 'Magento Product Export',
  detect: (header) =>
    header.includes('sku') &&
    (header.includes('product_type') || header.includes('attribute_set_code')),
  translatableColumns: [
    'name',
    'description',
    'short_description',
    'meta_title',
    'meta_keywords',
    'meta_description',
  ],
  htmlColumns: ['description', 'short_description'],
  preservedTokens: ['1column', 'simple', 'configurable', 'virtual', 'bundle', 'grouped', 'downloadable'],
};

export const GENERIC_CSV: CsvProfile = {
  id: 'generic-csv',
  name: 'Generisch (alle Spalten ausser Header)',
  detect: () => true,
  // Leere Liste = "alle Spalten ausser Header" (siehe applyProfile).
  translatableColumns: [],
  htmlColumns: [],
};

// Reihenfolge ist relevant: spezifischere Profile (Page mit page_layout) vor generischeren (Block ohne).
const PROFILES_ORDERED: CsvProfile[] = [MAGENTO_CMS_PAGE, MAGENTO_CMS_BLOCK, MAGENTO_PRODUCT, GENERIC_CSV];

export function getCsvProfiles(): CsvProfile[] {
  return PROFILES_ORDERED;
}

export function getCsvProfileById(id: string): CsvProfile | undefined {
  return PROFILES_ORDERED.find((p) => p.id === id);
}

export function detectCsvProfile(header: string[]): CsvProfile {
  const normalized = header.map((h) => h.trim().toLowerCase());
  for (const p of PROFILES_ORDERED) {
    if (p.id === GENERIC_CSV.id) continue;
    if (p.detect(normalized)) return p;
  }
  return GENERIC_CSV;
}

/**
 * Magento-Profil aus XML-Inhalt erkennen (Sniffing der ersten ~10 KB).
 * Liefert undefined wenn keines passt — Caller fällt dann auf Default-XML-Pfad zurück.
 */
export function detectXmlProfile(content: string): CsvProfile | undefined {
  // SpreadsheetML kann gigantische Header-Zeilen haben — Sniff-Fenster nur fuer
  // klassische Tag-Suche begrenzen. Den File-Anfang nutzen wir zur Format-Erkennung,
  // detect-Funktionen koennen bei Bedarf selbst den ganzen Content scannen.
  for (const p of PROFILES_ORDERED) {
    if (p.id === GENERIC_CSV.id) continue;
    if (p.detectXml && p.detectXml(content)) return p;
  }
  return undefined;
}

/**
 * Liefert pro Spalten-Index, ob die Spalte übersetzbar ist und in welchem Modus.
 *
 * @param header - Header-Zeile aus der CSV
 * @param profile - aktives Profil
 * @returns Map column-index → mode oder undefined
 */
export function buildColumnPlan(
  header: string[],
  profile: CsvProfile,
): Map<number, 'text' | 'html'> {
  const plan = new Map<number, 'text' | 'html'>();
  const normalized = header.map((h) => h.trim().toLowerCase());

  if (profile.id === GENERIC_CSV.id) {
    // Generisch: alle Spalten als Text — Verhalten wie vorher (Header bleibt aber unangetastet).
    for (let i = 0; i < normalized.length; i++) plan.set(i, 'text');
    return plan;
  }

  const translatable = new Set(profile.translatableColumns.map((c) => c.toLowerCase()));
  const html = new Set(profile.htmlColumns.map((c) => c.toLowerCase()));

  for (let i = 0; i < normalized.length; i++) {
    const name = normalized[i];
    if (!translatable.has(name)) continue;
    plan.set(i, html.has(name) ? 'html' : 'text');
  }
  return plan;
}

/**
 * Magento-Konstanten in Text durch Sentinel-Tokens ersetzen, damit DeepL sie nicht
 * übersetzt. Liefert ersetzten Text + Restore-Map.
 *
 * Greedy longest-match, Word-Boundary-bewusst (Unicode).
 */
export function applyTokenProtection(
  text: string,
  tokens: string[],
): { text: string; restore: Map<string, string> } {
  if (!tokens || tokens.length === 0) return { text, restore: new Map() };

  // Lange Tokens zuerst, damit "pagebuilder-column-line" vor "column-line" matcht.
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  const restore = new Map<string, string>();
  let result = text;
  let counter = 0;

  for (const token of sorted) {
    if (!token) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word-Boundary mit Unicode-Buchstaben/Ziffern, aber Bindestriche zaehlen NICHT als Boundary
    // (sonst matcht "column" innerhalb "pagebuilder-column-group"). Bindestrich-Konstanten sind
    // mit ihrem ganzen Namen in der Liste.
    const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'gu');
    result = result.replace(re, () => {
      const sentinel = `__MAGTKN${counter++}__`;
      restore.set(sentinel, token);
      return sentinel;
    });
  }
  return { text: result, restore };
}

export function restoreTokens(text: string, restore: Map<string, string>): string {
  let result = text;
  for (const [sentinel, token] of restore.entries()) {
    result = result.split(sentinel).join(token);
  }
  return result;
}
