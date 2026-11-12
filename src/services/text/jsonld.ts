/**
 * JSON-LD (`<script type="application/ld+json">`) Uebersetzungs-Pipeline.
 *
 * Hintergrund (29.06.2026, Sabrina): `protectCodeBlocks()` schuetzt ALLE
 * `<script>`-Bloecke verbatim vor DeepL — korrekt fuer ausfuehrbares JS, FALSCH
 * fuer strukturierte FAQ-Daten (schema.org `FAQPage`). Die `name`/`text`-Felder
 * sind natuersprachlich und gehoeren uebersetzt, damit Googles Rich-Results die
 * FAQ in der Zielsprache anzeigen. Bisher blieb der ganze Block unangetastet.
 *
 * Strategie (analog HTML-Attribut-Pre-Pass, Fix #6 in magento-html.ts):
 *   1. JSON-LD-Block finden, Steuerzeichen in Strings escapen, JSON parsen.
 *   2. Uebersetzbare String-Werte ueber eine Schluessel-Whitelist sammeln.
 *   3. Werte separat uebersetzen (HTML-Mode → `<br>` in Antworten bleibt erhalten).
 *   4. JSON mit uebersetzten Werten neu serialisieren, Block in-place ersetzen.
 *
 * Schlaegt das JSON-Parsing fehl (z.B. echtes JS statt Daten), bleibt der Block
 * UNVERAENDERT — der nachgelagerte `protectCodeBlocks()` schuetzt ihn dann wie
 * bisher verbatim. Kein Regress gegenueber dem heutigen Verhalten.
 *
 * Der re-serialisierte Block startet weiterhin mit `<script ...>` und endet mit
 * `</script>`, wird also vom anschliessenden `protectCodeBlocks()` als bereits
 * uebersetzter Block vor dem Haupt-DeepL-Pass geschuetzt.
 */

// `<script ... type="application/ld+json" ...>JSON</script>`.
// Tolerant gegenueber Attribut-Reihenfolge und Quote-Stil. Non-greedy bis zum
// ersten </script>. case-insensitive + multiline.
const JSONLD_BLOCK_RE =
  /(<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi;

// Schema.org-Schluessel, deren String-Werte IMMER natuersprachlich sind.
const ALWAYS_TRANSLATABLE_KEYS = new Set([
  'text',
  'headline',
  'description',
  'articleBody',
  'caption',
  'reviewBody',
  'alternativeHeadline',
  'disambiguatingDescription',
]);

// `name` ist mehrdeutig (Eigenname vs. Frage). Nur uebersetzen, wenn das
// umschliessende Objekt KEINE Eigennamen-Entitaet ist (Marke/Person/URL/Adresse).
const PROPER_NOUN_TYPES = new Set([
  'Organization',
  'Brand',
  'Person',
  'WebSite',
  'WebPage',
  'ImageObject',
  'Offer',
  'PostalAddress',
  'ContactPoint',
  'Product',
]);

interface TranslatableTarget {
  obj: Record<string, unknown>;
  key: string;
  value: string;
}

/**
 * Escaped rohe Steuerzeichen (CR/LF/TAB) INNERHALB von JSON-String-Literalen,
 * damit handgeschriebenes JSON-LD (FAQ-Texte mit echten Zeilenumbruechen) von
 * `JSON.parse` akzeptiert wird. Ausserhalb von Strings bleibt alles unangetastet.
 */
export function escapeRawControlCharsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }
  return out;
}

/**
 * Sammelt rekursiv alle uebersetzbaren String-Werte eines geparsten JSON-LD-Baums.
 * Gibt Referenzen auf (Objekt, Schluessel) zurueck, damit nach der Uebersetzung
 * direkt in den Baum zurueckgeschrieben werden kann.
 */
export function collectTranslatableStrings(node: unknown): TranslatableTarget[] {
  const targets: TranslatableTarget[] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    const typeRaw = obj['@type'];
    const types = new Set(
      (Array.isArray(typeRaw) ? typeRaw : [typeRaw])
        .filter((t): t is string => typeof t === 'string'),
    );

    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        if (!val.trim()) continue;
        const translatable =
          ALWAYS_TRANSLATABLE_KEYS.has(key) ||
          (key === 'name' && ![...types].some((t) => PROPER_NOUN_TYPES.has(t)));
        if (translatable) {
          targets.push({ obj, key, value: val });
        }
      } else if (val && typeof val === 'object') {
        walk(val);
      }
    }
  };

  walk(node);
  return targets;
}

export interface JsonLdBlock {
  /** Voller Original-Match `<script ...>...</script>` (fuer den Replace). */
  fullMatch: string;
  /** Oeffnender Tag `<script ...>` — verbatim fuer den Wieder-Aufbau. */
  openTag: string;
  /** Schliessender Tag `</script>`. */
  closeTag: string;
  /** Geparster JSON-Baum (mutierbar). */
  parsed: unknown;
  /** Referenzen auf alle uebersetzbaren Werte im Baum. */
  targets: TranslatableTarget[];
}

/**
 * Findet alle parsebaren JSON-LD-Bloecke in einem HTML-Fragment und extrahiert
 * deren uebersetzbare Werte. Nicht-parsebare Bloecke werden ausgelassen (sie
 * bleiben damit dem verbatim-Schutz ueberlassen).
 */
export function collectJsonLdBlocks(html: string): JsonLdBlock[] {
  if (!html || !/application\/ld\+json/i.test(html)) return [];
  const blocks: JsonLdBlock[] = [];
  const re = new RegExp(JSONLD_BLOCK_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [fullMatch, openTag, body, closeTag] = m;
    let parsed: unknown;
    try {
      parsed = JSON.parse(escapeRawControlCharsInStrings(body));
    } catch {
      continue; // Kein gueltiges JSON → verbatim-Schutz uebernimmt.
    }
    const targets = collectTranslatableStrings(parsed);
    if (targets.length === 0) continue;
    blocks.push({ fullMatch, openTag, closeTag, parsed, targets });
  }
  return blocks;
}

/**
 * Uebersetzt die natuersprachlichen Felder aller JSON-LD-Bloecke in `html`
 * (schema.org `FAQPage` etc.) in-place und gibt das HTML mit re-serialisierten
 * Bloecken zurueck. Enthaelt das HTML keine (parsebaren) JSON-LD-Bloecke, wird
 * der Input unveraendert zurueckgegeben.
 *
 * @param translate Uebersetzt eine Werteliste in gleicher Reihenfolge. Caller
 *   nutzt typischerweise DeepL HTML-Mode (damit `<br>` in Antworten erhalten
 *   bleibt) mit dem Projekt-Glossar.
 */
export async function translateJsonLdBlocks(
  html: string,
  translate: (texts: string[]) => Promise<string[]>,
): Promise<string> {
  const blocks = collectJsonLdBlocks(html);
  if (blocks.length === 0) return html;

  // Alle Werte aller Bloecke in EINEM Batch uebersetzen (Reihenfolge erhalten).
  const flatSources: string[] = [];
  for (const block of blocks) {
    for (const t of block.targets) flatSources.push(t.value);
  }

  const flatTranslations = await translate(flatSources);
  if (flatTranslations.length !== flatSources.length) {
    // Defensive: bei Laengen-Mismatch nichts kaputtmachen, Original behalten.
    console.warn(
      `[JSON-LD] Uebersetzungs-Mismatch (${flatTranslations.length} != ${flatSources.length}) — Bloecke unveraendert.`,
    );
    return html;
  }

  let cursor = 0;
  let result = html;
  for (const block of blocks) {
    for (const t of block.targets) {
      const translated = flatTranslations[cursor++];
      if (typeof translated === 'string' && translated.length > 0) {
        t.obj[t.key] = translated;
      }
    }
    const rebuilt = `${block.openTag}\n${JSON.stringify(block.parsed, null, 2)}\n${block.closeTag}`;
    // split/join statt replace: kein Sonderzeichen-Handling im Replacement noetig.
    result = result.split(block.fullMatch).join(rebuilt);
  }

  return result;
}
