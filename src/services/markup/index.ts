import fs from 'fs';
import {
  unprotectSpreadsheetML,
  SPREADSHEETML_IGNORE_TAG,
  assembleSpreadsheetML,
  isSpreadsheetML,
} from './spreadsheetml';
import { detectXmlProfile, getCsvProfileById } from '../text/csv-profiles';

/**
 * Markup-Parser für XML/HTML-Dateien.
 *
 * Strategie: Die ganze Datei wird als EIN Segment behandelt — DeepL bekommt sie
 * komplett mit `tagHandling: 'xml' | 'html'` und übersetzt nur Textknoten,
 * laesst Tags + Attribut-Namen unberuehrt. Bei HTML werden zusätzlich `<script>`
 * und `<style>` ignoriert (Inhalt wird nicht übersetzt).
 *
 * Vorteile:
 * - Keine eigene Parser-Pipeline noetig — DeepL kann das nativ.
 * - 1:1-Output garantiert, weil DeepL die Tag-Struktur preserviert.
 * - Cache via segment_hash funktioniert: dieselbe Datei zweimal hochgeladen
 *   = Cache-Hit, nur wenn der Inhalt sich ändert wird neu übersetzt.
 *
 * Limit: DeepL hat ein Request-Body-Limit (~128 KB). Groessere Files
 * werden mit klarem Fehler abgelehnt — typische Produkt-XML/HTML-Snippets
 * liegen weit darunter.
 */

export interface MarkupSegment {
  /** Stabile ID — für Markup immer "root" da nur ein Segment pro Datei. */
  id: string;
  text: string;
}

export interface MarkupParseResult {
  segments: MarkupSegment[];
  /** Original-Encoding-Hint aus XML-Deklaration, falls vorhanden. */
  encoding?: string;
  /** Wird für Cleanup nicht benoetigt — Markup haelt keine temp-Files. */
}

const MAX_DEEPL_BYTES = 120_000;

export function parseMarkup(filePath: string): MarkupParseResult {
  const content = fs.readFileSync(filePath, 'utf-8');

  const byteLen = Buffer.byteLength(content, 'utf-8');
  if (byteLen > MAX_DEEPL_BYTES) {
    throw new Error(
      `Markup-Datei zu gross (${(byteLen / 1024).toFixed(0)} KB > ${MAX_DEEPL_BYTES / 1024} KB). ` +
        `XML/HTML-Uploads sind aktuell auf einzelne Code-Bloecke ausgelegt.`,
    );
  }

  // Encoding aus XML-Deklaration extrahieren falls vorhanden
  let encoding: string | undefined;
  const xmlDecl = content.match(/^<\?xml[^>]*encoding=["']([^"']+)["']/);
  if (xmlDecl) encoding = xmlDecl[1];

  return {
    segments: [{ id: 'root', text: content }],
    encoding,
  };
}

/**
 * Übersetzte Markup-Datei schreiben. Da nur ein Segment pro Datei, schreiben
 * wir den translation-Text 1:1 ans Ziel.
 */
export function writeMarkup(
  translations: Array<{ segmentId: string; translatedText: string }>,
  outputPath: string,
  opts: { inputPath?: string; formatProfile?: string | null } = {},
): void {
  // SpreadsheetML-per-Zelle-Pfad: viele Segmente mit ID `cell:<row>:<col>` —
  // Original re-parsen, Cell-Texte einsetzen, Header bleibt unangetastet.
  const cellTranslations = translations.filter((t) => t.segmentId.startsWith('cell:'));
  if (cellTranslations.length > 0 && opts.inputPath) {
    const original = fs.readFileSync(opts.inputPath, 'utf-8');
    if (isSpreadsheetML(original)) {
      const profile =
        (opts.formatProfile && opts.formatProfile !== 'auto'
          ? getCsvProfileById(opts.formatProfile)
          : undefined) ?? detectXmlProfile(original);
      if (!profile) {
        throw new Error('SpreadsheetML: kein passendes Format-Profil gefunden für Reassembly');
      }
      const map = new Map<string, string>();
      for (const t of cellTranslations) map.set(t.segmentId, t.translatedText);
      const out = assembleSpreadsheetML(original, map, profile);
      fs.writeFileSync(outputPath, out, 'utf-8');
      return;
    }
  }

  const root = translations.find(t => t.segmentId === 'root');
  if (!root) {
    throw new Error('Markup-Output: kein "root"-Segment in den Übersetzungen gefunden');
  }
  let output = root.translatedText;
  if (output.includes(`<${SPREADSHEETML_IGNORE_TAG}>`)) {
    output = unprotectSpreadsheetML(output);
  }
  fs.writeFileSync(outputPath, output, 'utf-8');
}

/**
 * DeepL Tag-Handling-Optionen je Markup-Typ.
 * - XML: strikt, nur Textknoten. Keine ignoreTags noetig (Standard).
 * - HTML: zusätzlich `<script>`, `<style>`, `<code>`, `<pre>` als ignoreTags
 *   damit Code-/Stil-Inhalte unangetastet bleiben.
 */
export function getMarkupDeepLOptions(fileType: 'xml' | 'html'): {
  tagHandling: 'xml' | 'html';
  ignoreTags?: string[];
} {
  if (fileType === 'html') {
    return {
      tagHandling: 'html',
      ignoreTags: ['script', 'style', 'code', 'pre'],
    };
  }
  return { tagHandling: 'xml' };
}
