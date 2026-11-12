import fs from 'fs';

/**
 * Markdown-Parser mit Code-Schutz.
 *
 * Strategie wie bei Markup: ein Segment pro Datei. Davor werden alle Code-Bloecke
 * durch Token (`__MDCODE_NNN__`) maskiert, damit DeepL sie nicht übersetzt.
 * Beim Schreiben werden die Token wieder durch das Original ersetzt.
 *
 * Geschützt werden:
 * - Fenced Code-Bloecke: ```lang\n...\n``` (auch ohne Lang-Hint, auch mit ~~~)
 * - Inline-Code: `code`
 *
 * Links/Bilder/Tabellen werden NICHT speziell maskiert — DeepL behandelt sie sauber.
 */

export interface MarkdownSegment {
  id: string;
  text: string;
}

export interface MarkdownParseResult {
  segments: MarkdownSegment[];
  internal: {
    masked: string;
    replacements: Map<string, string>;
    hasBom: boolean;
  };
}

const BOM = '﻿';
const TOKEN_PREFIX = '__MDCODE_';
const TOKEN_SUFFIX = '__';

function maskMarkdown(content: string): { masked: string; replacements: Map<string, string> } {
  const replacements = new Map<string, string>();
  let counter = 0;
  const nextToken = (): string => `${TOKEN_PREFIX}${counter++}${TOKEN_SUFFIX}`;

  // 1) Fenced Code-Bloecke (``` oder ~~~). Müssen am Zeilenanfang stehen, optional
  //    eingerueckt durch bis zu 3 Spaces. Schließende Fence muss exakt mit der
  //    oeffnenden übereinstimmen.
  let masked = content.replace(
    /^( {0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*(?=\n|$)/gm,
    (full) => {
      const token = nextToken();
      replacements.set(token, full);
      return token;
    },
  );

  // 2) Inline-Code mit beliebiger Anzahl Backticks (Pandoc-Style). Greedy gleich
  //    viele Backticks oeffnen + schließen.
  masked = masked.replace(
    /(`+)([^`\n]+?)\1/g,
    (full) => {
      const token = nextToken();
      replacements.set(token, full);
      return token;
    },
  );

  return { masked, replacements };
}

function unmaskMarkdown(translated: string, replacements: Map<string, string>): string {
  let result = translated;
  for (const [token, original] of replacements) {
    // Token kann mehrfach auftreten (sollte nicht, aber safe)
    result = result.split(token).join(original);
  }
  return result;
}

export function parseMarkdown(filePath: string): MarkdownParseResult {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const hasBom = raw.startsWith(BOM);
  const content = hasBom ? raw.slice(1) : raw;

  const { masked, replacements } = maskMarkdown(content);

  return {
    segments: [{ id: 'root', text: masked }],
    internal: { masked, replacements, hasBom },
  };
}

export function writeMarkdown(
  internal: MarkdownParseResult['internal'],
  translations: Array<{ segmentId: string; translatedText: string }>,
  outputPath: string,
): void {
  const root = translations.find((t) => t.segmentId === 'root');
  if (!root) throw new Error('Markdown-Output: kein "root"-Segment');
  const restored = unmaskMarkdown(root.translatedText, internal.replacements);
  const body = internal.hasBom ? BOM + restored : restored;
  fs.writeFileSync(outputPath, body, 'utf-8');
}
