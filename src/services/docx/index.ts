/**
 * DOCX Pipeline Orchestrator — Phase 6
 *
 * Koordiniert den DOCX-Workflow:
 * 1. Entpacken (ZIP) → 2. Parsen (XML) → 3. Segmente extrahieren
 * 4. Zurückschreiben → 5. Re-Packen
 *
 * DOCX-Struktur:
 *   datei.docx (ZIP)
 *   ├── word/document.xml     ← Haupttext
 *   ├── word/header1.xml      ← Header (optional)
 *   ├── word/footer1.xml      ← Footer (optional)
 *   ├── word/styles.xml       ← Styles (nicht anfassen)
 *   └── [Content_Types].xml   ← Manifest
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import { parseDocxXml } from './parser';
import { writeDocxTranslations } from './writer';
import type { DocxSegment, DocxParseResult, DocxTranslationMapping } from './types';

export type { DocxSegment, DocxParseResult, DocxTranslationMapping };

/**
 * Entpackt und parst eine DOCX-Datei.
 * Gibt Segmente und tempDir zurück (muss mit cleanupDocx aufgeräumt werden).
 */
export function parseDocx(docxPath: string): DocxParseResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx_'));

  // ZIP entpacken
  const zip = new AdmZip(docxPath);
  zip.extractAllTo(tempDir, true);

  const segments: DocxSegment[] = [];
  const contentFiles: string[] = [];

  // 1. Hauptdokument
  const documentXml = 'word/document.xml';
  if (fs.existsSync(path.join(tempDir, documentXml))) {
    contentFiles.push(documentXml);
    const bodySegs = parseDocxXml(tempDir, documentXml, 'body', 'p');
    segments.push(...bodySegs);
  }

  // 2. Header-Dateien
  const wordDir = path.join(tempDir, 'word');
  if (fs.existsSync(wordDir)) {
    const files = fs.readdirSync(wordDir);
    for (const file of files) {
      if (/^header\d+\.xml$/i.test(file)) {
        const xmlFile = `word/${file}`;
        contentFiles.push(xmlFile);
        const headerSegs = parseDocxXml(tempDir, xmlFile, 'header', `h${file.match(/\d+/)?.[0]}`);
        segments.push(...headerSegs);
      }
      if (/^footer\d+\.xml$/i.test(file)) {
        const xmlFile = `word/${file}`;
        contentFiles.push(xmlFile);
        const footerSegs = parseDocxXml(tempDir, xmlFile, 'footer', `f${file.match(/\d+/)?.[0]}`);
        segments.push(...footerSegs);
      }
    }
  }

  return { segments, tempDir, contentFiles };
}

/**
 * Schreibt Übersetzungen in das entpackte DOCX und packt es neu als ZIP.
 */
export function writeAndPackDocx(
  parseResult: DocxParseResult,
  translations: DocxTranslationMapping[],
  outputPath: string,
): void {
  writeDocxTranslations(parseResult.tempDir, parseResult.segments, translations);
  packDocx(parseResult.tempDir, outputPath);
}

/**
 * Packt den temp-Ordner zurück als DOCX (ZIP).
 */
function packDocx(tempDir: string, outputPath: string): void {
  const zip = new AdmZip();

  // Rekursiv alle Dateien hinzufügen
  function addDir(dir: string, zipPath: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        addDir(fullPath, entryZipPath);
      } else {
        const content = fs.readFileSync(fullPath);
        const dirPart = entryZipPath.includes('/') ? entryZipPath.slice(0, entryZipPath.lastIndexOf('/')) : '';
        zip.addFile(entryZipPath, content);
      }
    }
  }

  addDir(tempDir, '');
  zip.writeZip(outputPath);
}

/**
 * Räumt die temporaeren Dateien auf.
 */
export function cleanupDocx(parseResult: DocxParseResult): void {
  try {
    fs.rmSync(parseResult.tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
