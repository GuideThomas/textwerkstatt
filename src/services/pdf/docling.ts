/**
 * Docling HTTP Client — Phase 8
 *
 * Kommuniziert mit dem Docling-Service (docling-serve) zur PDF-Text-Extraktion.
 * Endpunkt: POST /v1/convert/file (multipart/form-data)
 *
 * Docling liefert ein DoclingDocument mit Textbloecken und Bounding Boxes.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { pdfNacheinander } from '../../demo/grenzen';

/** Rohe Docling-API Response */
export interface DoclingConvertResponse {
  document?: DoclingExportResponse;
  status?: string;
  errors?: string[];
}

/** docling-serve wraps the actual document inside json_content */
export interface DoclingExportResponse {
  filename?: string;
  json_content?: DoclingDocument;
  md_content?: string;
}

export interface DoclingDocument {
  /** Text items array (docling-serve v2) */
  texts?: DoclingTextItem[];
  /** Legacy: Haupttext-Items (ältere Docling-Versionen) */
  main_text?: DoclingTextItem[];
  /** Body with $ref children (docling-serve v2 uses refs, not inline) */
  body?: { children?: DoclingTextItem[] };
  /** Seitendimensionen */
  pages?: Record<string, DoclingPageInfo>;
}

export interface DoclingTextItem {
  text?: string;
  orig?: string;     // docling-serve v2 uses 'orig' instead of 'text'
  label?: string;    // 'text', 'title', 'section_header', 'list_item', 'caption', etc.
  prov?: DoclingProv[];
  self_ref?: string;
  children?: DoclingTextItem[];
  $ref?: string;     // Reference pointer in body.children
}

export interface DoclingProv {
  page_no: number;   // 1-indexed
  bbox: {
    l: number;       // left
    t: number;       // top
    r: number;       // right
    b: number;       // bottom
    coord_origin?: string;  // 'BOTTOMLEFT' or 'TOPLEFT'
  };
}

export interface DoclingPageInfo {
  size?: { width: number; height: number };
  width?: number;   // Legacy format
  height?: number;  // Legacy format
}

/**
 * Sendet eine PDF-Datei an Docling und gibt die strukturierte Response zurück.
 *
 * Versucht zuerst /v1/convert/file (stabile API),
 * dann Fallback auf /v1alpha/convert/file (ältere Versionen).
 */
export function convertPdfWithDocling(filePath: string): Promise<DoclingConvertResponse> {
  // Demo: ein PDF nach dem anderen, Docling teilt sich den Speicher mit der Produktion (E3, src/demo/grenzen.ts).
  return pdfNacheinander(() => doclingLesen(filePath));
}

async function doclingLesen(filePath: string): Promise<DoclingConvertResponse> {
  const baseUrl = config.docling.url.replace(/\/$/, '');
  const timeoutMs = config.docling.timeoutMs;

  // File lesen
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  // Endpoints zum Probieren (v1 stabil, dann v1alpha Fallback)
  const endpoints = [
    '/v1/convert/file',
    '/v1alpha/convert/file',
  ];

  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const result = await callDoclingEndpoint(baseUrl, endpoint, fileBuffer, fileName, timeoutMs);
      return result;
    } catch (err: any) {
      lastError = err;
      // 404 = Endpoint existiert nicht → nächsten probieren
      if (err.message?.includes('404') || err.message?.includes('Not Found')) {
        console.log(`[Docling] ${endpoint} nicht verfügbar, probiere nächsten...`);
        continue;
      }
      // Andere Fehler → sofort abbrechen
      throw err;
    }
  }

  throw lastError || new Error('Docling: Kein verfügbarer Endpoint gefunden');
}

async function callDoclingEndpoint(
  baseUrl: string,
  endpoint: string,
  fileBuffer: Buffer,
  fileName: string,
  timeoutMs: number,
): Promise<DoclingConvertResponse> {
  const url = `${baseUrl}${endpoint}`;
  console.log(`[Docling] POST ${url} (${(fileBuffer.length / 1024).toFixed(0)} KB)`);

  // FormData aufbauen (Node 18+ native)
  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  formData.append('files', blob, fileName);

  // Optionen als separate Form-Felder (docling-serve erwartet keine JSON-String)
  formData.append('to_formats', 'json');
  formData.append('do_ocr', 'true');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Docling ${response.status}: ${response.statusText} - ${body.slice(0, 200)}`);
    }

    const data = await response.json() as DoclingConvertResponse;
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extrahiert alle Text-Items aus der Docling-Response.
 * Handhabt verschiedene Docling-Versionen:
 * - v2 (docling-serve): texts[] array mit orig/text Feldern
 * - Legacy: main_text[] oder body.children[]
 */
export function extractTextItems(doc: DoclingDocument): DoclingTextItem[] {
  const items: DoclingTextItem[] = [];

  // Variante 1: texts[] (docling-serve v2 — primaere Quelle)
  if (doc.texts && doc.texts.length > 0) {
    for (const item of doc.texts) {
      // v2 uses 'orig' field, normalize to 'text'
      if (!item.text && item.orig) {
        item.text = item.orig;
      }
      if (item.text && item.text.trim().length > 0) {
        items.push(item);
      }
    }
    return items;
  }

  // Variante 2: main_text (ältere Docling-Versionen)
  if (doc.main_text && doc.main_text.length > 0) {
    flattenItems(doc.main_text, items);
    return items;
  }

  // Variante 3: body.children (neuere Versionen, aber mit $ref — skip refs)
  if (doc.body?.children && doc.body.children.length > 0) {
    flattenItems(doc.body.children, items);
    return items;
  }

  return items;
}

/** Rekursiv verschachtelte Items flach machen */
function flattenItems(items: DoclingTextItem[], result: DoclingTextItem[]): void {
  for (const item of items) {
    // Normalize orig → text
    if (!item.text && item.orig) {
      item.text = item.orig;
    }
    // Skip $ref pointers (they have no text)
    if (item.$ref && !item.text) {
      continue;
    }
    if (item.text && item.text.trim().length > 0) {
      result.push(item);
    }
    if (item.children && item.children.length > 0) {
      flattenItems(item.children, result);
    }
  }
}
