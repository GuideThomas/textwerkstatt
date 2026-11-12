import fs from 'fs';

/**
 * Illustrator-Austauschformat (`*.translation.json`).
 *
 * Erzeugt von `illustrator-scripts/export-text.jsx`: eine flache Liste von
 * Text-Segmenten mit stabilen IDs (gespeichert im `note`-Feld der TextFrames).
 * Reimport via `import-text.jsx` matcht ueber dieselben IDs.
 *
 * Strategie: Jedes Segment = ein TextFrame-Inhalt (echter, editierbarer Text —
 * KEIN glyph-zerlegtes SVG). DeepL bekommt reinen Text, das Layout entsteht
 * beim Reimport neu durch Illustrators eigene Composition-Engine.
 */

export const AIJSON_SCHEMA_PREFIX = 'textwerkstatt/illustrator-exchange';

/** Angenommen wird jede Kennung der Form `<name>/illustrator-exchange@…`: Ältere Exportskripte schreiben noch den
 *  früheren Namen des Werkzeugs, und eine Installation darf ihre Skripte umbenennen, ohne den Server anzufassen. */
const AIJSON_SCHEMA_RE = /^[a-z0-9-]+\/illustrator-exchange@/;

export interface AijsonSegment {
  /** Stabile ID aus dem note-Feld des TextFrames. */
  id: string;
  text: string;
}

export interface AijsonParseResult {
  schema: string;
  source?: string;
  segments: AijsonSegment[];
}

interface AijsonRaw {
  schema?: unknown;
  source?: unknown;
  segments?: unknown;
}

function isValidSegment(x: unknown): x is AijsonSegment {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as any).id === 'string' &&
    (x as any).id.length > 0 &&
    typeof (x as any).text === 'string'
  );
}

/**
 * Austauschdatei einlesen + validieren.
 * Wirft mit klarer Meldung bei falschem Schema oder kaputter Struktur.
 */
export function parseAijson(filePath: string): AijsonParseResult {
  const content = fs.readFileSync(filePath, 'utf-8');

  let raw: AijsonRaw;
  try {
    raw = JSON.parse(content);
  } catch (e: any) {
    throw new Error(`Illustrator-Austauschdatei ist kein gueltiges JSON: ${e.message}`);
  }

  const schema = typeof raw.schema === 'string' ? raw.schema : '';
  if (!AIJSON_SCHEMA_RE.test(schema)) {
    throw new Error(
      `Unerwartetes Schema "${schema}". Erwartet wird "${AIJSON_SCHEMA_PREFIX}@…" ` +
        `(erzeugt von export-text.jsx).`,
    );
  }

  if (!Array.isArray(raw.segments)) {
    throw new Error('Austauschdatei enthaelt kein "segments"-Array.');
  }

  const segments = raw.segments.filter(isValidSegment);
  if (segments.length === 0) {
    throw new Error('Keine gueltigen Segmente (id + text) in der Austauschdatei.');
  }

  // Doppelte IDs wuerden den Reimport mehrdeutig machen — hart ablehnen.
  const seen = new Set<string>();
  for (const s of segments) {
    if (seen.has(s.id)) {
      throw new Error(`Doppelte Segment-ID "${s.id}" — Export-Datei ist inkonsistent.`);
    }
    seen.add(s.id);
  }

  return {
    schema,
    source: typeof raw.source === 'string' ? raw.source : undefined,
    segments,
  };
}

/**
 * Uebersetzte Austauschdatei schreiben: Original re-parsen (Reihenfolge +
 * `source`/`schema` erhalten), `text` pro ID durch die Uebersetzung ersetzen.
 * IDs ohne Uebersetzung behalten den Originaltext (defensive — kein Datenverlust).
 */
export function writeAijson(
  inputPath: string,
  translations: Array<{ segmentId: string; translatedText: string }>,
  outputPath: string,
): void {
  const original = parseAijson(inputPath);
  const byId = new Map<string, string>();
  for (const t of translations) byId.set(t.segmentId, t.translatedText);

  const out = {
    schema: original.schema,
    source: original.source,
    segments: original.segments.map((s) => ({
      id: s.id,
      text: byId.has(s.id) ? (byId.get(s.id) as string) : s.text,
    })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(out, null, 2), 'utf-8');
}
