/**
 * IDML Re-Packer — Phase 2.2.7
 *
 * Packt ein temporaeres Verzeichnis zurück in eine .idml-Datei (ZIP).
 * Bewahrt die originale Dateistruktur und Kompression.
 *
 * Wichtig: IDML erwartet eine spezifische Struktur:
 * - mimetype als erste Datei (unkomprimiert, wie bei EPUB)
 * - META-INF/ Verzeichnis
 * - designmap.xml
 * - Stories/, Spreads/, Resources/ etc.
 */

import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';

/**
 * Packt ein entpacktes IDML-Verzeichnis zu einer .idml-Datei.
 *
 * @param tempDir Pfad zum entpackten Verzeichnis
 * @param outputPath Zielpfad für die .idml-Datei
 */
export function packIdml(tempDir: string, outputPath: string): void {
  const zip = new AdmZip();

  // mimetype Datei zuerst (muss erste Entry sein, unkomprimiert)
  const mimetypePath = path.join(tempDir, 'mimetype');
  if (fs.existsSync(mimetypePath)) {
    const content = fs.readFileSync(mimetypePath);
    zip.addFile('mimetype', content);
  }

  // Alle anderen Dateien rekursiv hinzufügen
  addDirectoryToZip(zip, tempDir, '', ['mimetype']);

  // ZIP schreiben
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  zip.writeZip(outputPath);
  console.log(`[IDML Packer] Created ${outputPath}`);
}

/**
 * Fügt alle Dateien eines Verzeichnisses rekursiv zum ZIP hinzu.
 */
function addDirectoryToZip(
  zip: AdmZip,
  rootDir: string,
  currentRelative: string,
  exclude: string[]
): void {
  const currentDir = path.join(rootDir, currentRelative);
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = currentRelative
      ? `${currentRelative}/${entry.name}`
      : entry.name;

    if (exclude.includes(relativePath)) continue;

    if (entry.isDirectory()) {
      addDirectoryToZip(zip, rootDir, relativePath, exclude);
    } else {
      const fullPath = path.join(rootDir, relativePath);
      const content = fs.readFileSync(fullPath);
      // Vorwaerts-Slashes für ZIP-Einträge (plattformunabhaengig)
      zip.addFile(relativePath.replace(/\\/g, '/'), content);
    }
  }
}
