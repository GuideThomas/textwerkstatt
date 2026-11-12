/**
 * Magento PageBuilder HTML-Cell Verarbeitung + URL/CSS/Title-Schutz.
 *
 * Hintergrund: Magento CMS-Page Content-Cells haben ZWEI HTML-Layer
 *
 *  1. Outer (echtes HTML):  <div data-content-type="row">...<style>...</style>
 *  2. Inner (entity-encoded):  <div data-content-type="html">&lt;style&gt;...&lt;/style&gt;</div>
 *
 * DeepL HTML-Mode normalisiert entity-encoded HTML problematisch: Tag-Namen werden
 * uppercase, " wird zu &quot;, CSS-Comments werden mit-uebersetzt, URL-Slugs in
 * href-Attributen werden uebersetzt, ein Encoding-Layer geht verloren (&amp;lt; → &lt;).
 *
 * Strategie: Inner-Bloecke vor DeepL einmal entity-decoden, separat durch
 * DeepL schicken, danach wieder entity-enkoden. Sentinel-Wrapper haelt
 * den Outer-DeepL-Call von den Inner-Inhalten fern.
 */

const INNER_SENTINEL_TAG = 'isolinner';

/** ignoreTag-Name fuer DeepL HTML-Mode, damit der Outer-Sentinel intakt bleibt. */
export const MAGENTO_INNER_IGNORE_TAG = INNER_SENTINEL_TAG;

// data-content-type="html" Bloecke. Non-greedy bis zum naechsten `</div>`.
// Hinweis: Im PageBuilder sind html-Bloecke immer einzelne Leaf-Divs ohne
// verschachtelte <div>-Children, daher reicht der einfache non-greedy Match.
const HTML_BLOCK_RE =
  /<div\s+([^>]*?data-content-type=["']html["'][^>]*?)>([\s\S]*?)<\/div>/gi;

export function decodeXmlEntities(s: string): string {
  // Reihenfolge wichtig: &amp; ZULETZT, sonst wird &amp;lt; faelschlich zu < statt
  // zu &lt; literal.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function encodeXmlEntities(s: string): string {
  // Reihenfolge wichtig: & ZUERST, sonst wird & in nachfolgenden Entities doppelt encoded.
  //
  // ABER: bereits bestehende Entities (named oder numerisch) duerfen NICHT erneut
  // encoded werden. DeepL HTML-Mode escaped z.B. Apostrophe defensiv zu &#x27; —
  // wenn wir das blind durch /&/g jagen, entsteht &amp;#x27; und Magentos PageBuilder-
  // Parser bricht beim Lesen ab (Endlos-Spinner). Negative-Lookahead schliesst
  // bestehende Entities aus.
  return s
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface MagentoHtmlPipeline {
  /** Outer-Text mit Sentinels (durch DeepL HTML-Mode zu schicken). */
  outerWithSentinels: string;
  /** Pro Sentinel: der entity-decoded Inner (durch DeepL HTML-Mode zu schicken). */
  innerBlocks: Array<{ sentinelId: string; decoded: string }>;
}

/**
 * Magento CMS-Page Content-Cell in Outer + Inner-Bloecke zerlegen.
 * Outer enthaelt Sentinel-Wrapper statt der entity-encoded Inner-Texte.
 *
 * Aufruf-Site muss den Outer mit ignoreTags=[MAGENTO_INNER_IGNORE_TAG, ...]
 * durch DeepL schicken, damit der Sentinel-Inhalt intakt bleibt.
 */
export function prepareMagentoHtmlCell(cellText: string): MagentoHtmlPipeline {
  const innerBlocks: Array<{ sentinelId: string; decoded: string }> = [];
  let counter = 0;

  const outer = cellText.replace(HTML_BLOCK_RE, (full, attrs, innerEncoded) => {
    // Nur Bloecke verarbeiten, die tatsaechlich entity-encoded HTML enthalten.
    // Reine Text-Bloecke (Magento z.B. text/heading) kommen mit data-content-type="text",
    // nicht "html". Aber falls "html" ohne entities vorkommt, lassen wir die Cell unveraendert.
    if (!/&lt;|&gt;/.test(innerEncoded)) {
      return full;
    }
    const sentinelId = `ISOLINNER${counter++}`;
    const decoded = decodeXmlEntities(innerEncoded);
    innerBlocks.push({ sentinelId, decoded });
    return `<div ${attrs}><${INNER_SENTINEL_TAG} id="${sentinelId}"></${INNER_SENTINEL_TAG}></div>`;
  });

  return { outerWithSentinels: outer, innerBlocks };
}

/**
 * Outer mit uebersetzten Inner-Bloecken wieder zusammensetzen.
 * Inner wird vor dem Einsetzen entity-enkodiert.
 */
export function assembleMagentoHtmlCell(
  translatedOuter: string,
  translatedInners: Array<{ sentinelId: string; translated: string }>,
): string {
  let result = translatedOuter;
  for (const { sentinelId, translated } of translatedInners) {
    const reEncoded = encodeXmlEntities(translated);
    // DeepL kann den Sentinel-Tag self-closed oder mit Whitespace ausgeben.
    const pattern = new RegExp(
      `<${INNER_SENTINEL_TAG}\\s+id=["']${sentinelId}["']\\s*(?:/>|>\\s*</${INNER_SENTINEL_TAG}>)`,
      'gi',
    );
    result = result.replace(pattern, reEncoded);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fix #2 (22.05.2026) → abgeloest am 28.07.2026
// ---------------------------------------------------------------------------
//
// `protectUrlSlugs()`/`restoreUrlSlugs()`/`injectStoreviewPrefix()` sind in das
// Modul `./storeview.ts` gewandert und dort zu EINEM Mechanismus
// (`protectLinkAttributes`/`restoreLinkAttributes`) zusammengefasst:
//   - schuetzt jetzt ALLE URL-Attribute (href/src/srcset/data-src/data-srcset)
//     statt nur href-mit-Locale → Ressourcenpfade sind strukturell sicher,
//   - unterscheidet Navigations- von Ressourcen-Links (kein `/en/x.pdf` mehr),
//   - laeuft ohne Projekt-Toggle fuer alle Projekte,
//   - kennt EINE Store-View-Liste statt zweier divergierender.

// ---------------------------------------------------------------------------
// Fix #2b: Magento-Template-Direktiven-Schutz ({{widget ...}}, {{media ...}}, ...)
// ---------------------------------------------------------------------------

const MAGENTO_DIRECTIVE_SENTINEL_PREFIX = '__ISOLMDIR';
// Greedy bis zum NAECHSTEN }}. Magento-Direktiven sind nie verschachtelt, also
// non-greedy mit }} als Ende ist sicher. Multiline=true wegen Direktiven, die
// ueber Zeilen gehen koennen.
const MAGENTO_DIRECTIVE_RE = /\{\{[\s\S]*?\}\}/g;

export interface MagentoDirectiveProtection {
  protectedText: string;
  restoreMap: Map<string, string>;
}

/**
 * Schuetzt Magento-Template-Direktiven (`{{widget type="..." block_id="685"}}`,
 * `{{media url=...}}`, `{{config path=...}}`, ...) vor DeepL HTML-Mode.
 *
 * Hintergrund: DeepL sieht `{{widget ...}}` als Text-Content im DOM und
 * encoded `"` defensiv zu `&quot;`. Magentos Template-Parser erwartet
 * literal `"` — Widget-Aufloesung schlaegt fehl → Block laedt nicht
 * (siehe Vorfall 22.05.2026: Video-Block `block_id=&quot;685&quot;`).
 */
export function protectMagentoDirectives(text: string): MagentoDirectiveProtection {
  const restoreMap = new Map<string, string>();
  let counter = 0;
  const result = text.replace(MAGENTO_DIRECTIVE_RE, (match) => {
    const sentinel = `${MAGENTO_DIRECTIVE_SENTINEL_PREFIX}${counter++}__`;
    restoreMap.set(sentinel, match);
    return sentinel;
  });
  return { protectedText: result, restoreMap };
}

export function restoreMagentoDirectives(
  text: string,
  restoreMap: Map<string, string>,
): string {
  let result = text;
  for (const [sentinel, original] of restoreMap.entries()) {
    result = result.split(sentinel).join(original);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fix #2c (01.06.2026): <script>/<style>-Block-Schutz
// ---------------------------------------------------------------------------

const CODE_BLOCK_SENTINEL_PREFIX = '__ISOLCODE';
// <script ...>...</script> und <style ...>...</style> als Ganzes (mit Attributen,
// case-insensitive, ueber Zeilen). Non-greedy bis zum passenden Close-Tag.
const CODE_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

export interface CodeBlockProtection {
  protectedText: string;
  restoreMap: Map<string, string>;
}

/**
 * Schuetzt komplette `<script>`- und `<style>`-Bloecke vor DeepL.
 *
 * Hintergrund (01.06.2026): DeepL HTML-Mode laesst zwar mit `ignoreTags=['script']`
 * den Inhalt UNUEBERSETZT, re-serialisiert aber den HTML-Baum und encodet dabei
 * Anfuehrungszeichen defensiv zu `&#x27;` (`'click'` → `&#x27;click&#x27;`). Das
 * zerstoert ausfuehrbaren JS-Code. `ignoreTags` schuetzt nur vor Uebersetzung,
 * NICHT vor Entity-Re-Encoding — daher muss der ganze Block als opaker Sentinel
 * raus und verbatim wieder rein. (Beschwerde: JS-Tab-Init im iso-lp-Template.)
 */
/**
 * Fix (14.08.2026): Ein Sentinel UNMITTELBAR hinter `</a>` kostet den Anker.
 *
 * DeepL verwirft im Tag-Handling **v2** das `<a>`-Element, wenn direkt dahinter ein
 * nackter Text-Token steht — und genau das erzeugt `protectCodeBlocks()`, sobald ein
 * `<script>`/`<style>`-Block hinter einem Link liegt. Gemessen (DE→IT, tag_handling=html):
 *
 *   `<div>LINK__ISOLCODE0__</div>`                 v2 → `<div>Link__ISOLCODE0__</div>`  Anker WEG
 *   `<div>LINK<span>__ISOLCODE0__</span></div>`    v2 → Anker WEG   (inline genuegt NICHT)
 *   `<div>LINK<div>__ISOLCODE0__</div></div>`      v2 → Anker BLEIBT, Sentinel bleibt draussen
 *   `<div>LINK__ISOLCODE0__</div>`                 v1 → Anker bleibt, Sentinel wandert IN den Anker
 *
 * Der Sentinel bekommt deshalb einen Block-Wrapper — aber NUR im Ausloeserfall, damit die
 * Aenderung nicht ueber alle Texte laeuft (`protectCodeBlocks` sieht auch Nicht-HTML, wo ein
 * Block-Element in Inline-Kontext strukturell falsch waere). Auf v1 umzustellen ist KEINE
 * Loesung: dort landet der Sentinel im Anker — das ist die Fehlerklasse des IDML-Vorfalls
 * vom 01.06.2026, nur andersherum.
 *
 * ⚠️ Der Wrapper MUSS im Restore wieder verschwinden, sonst wird aus einem fehlenden Anker
 * ein Struktur-Fehler im Kundendokument. Siehe `restoreCodeBlocks()`.
 */
const ANCHOR_BEFORE_RE = /<\/a>\s*$/i;

export function protectCodeBlocks(text: string): CodeBlockProtection {
  const restoreMap = new Map<string, string>();
  if (!/<(?:script|style)\b/i.test(text)) return { protectedText: text, restoreMap };
  let counter = 0;
  const protectedText = text.replace(CODE_BLOCK_RE, (match, _tag: string, offset: number) => {
    const sentinel = `${CODE_BLOCK_SENTINEL_PREFIX}${counter++}__`;
    restoreMap.set(sentinel, match);
    // Nur der Ausloeserfall bekommt den Wrapper: Block steht direkt hinter einem `</a>`.
    // 40 Zeichen Rueckschau genuegen — `</a>` plus etwaiger Whitespace.
    const davor = text.slice(Math.max(0, offset - 40), offset);
    return ANCHOR_BEFORE_RE.test(davor) ? `<div>${sentinel}</div>` : sentinel;
  });
  return { protectedText, restoreMap };
}

/** Sentinel besteht aus `__ISOLCODE<n>__` — trotzdem escapen, damit die Regex nicht raet. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function restoreCodeBlocks(text: string, restoreMap: Map<string, string>): string {
  let result = text;
  for (const [sentinel, original] of restoreMap.entries()) {
    // Stufe 1: gewrappte Form zuerst — sonst bliebe das `<div>` im Dokument stehen.
    // `<div[^>]*>` statt `<div>`, falls DeepL Attribute ergaenzt oder umformatiert.
    // Ersetzung als Callback, damit `$&`/`$1` im Original NICHT als Muster gelten.
    const wrapped = new RegExp(`<div[^>]*>\\s*${escapeRe(sentinel)}\\s*</div>`, 'gi');
    result = result.replace(wrapped, () => original);
    // Stufe 2: nackter Sentinel — ungewrappte Bloecke, und Rueckfall falls DeepL den
    // Wrapper doch entfernt. Ohne diese Stufe bliebe der Sentinel im Text sichtbar.
    result = result.split(sentinel).join(original);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fix #3: CSS-Comment-Schutz
// ---------------------------------------------------------------------------

const CSS_COMMENT_SENTINEL_PREFIX = '__ISOLCSS';

export interface CssCommentProtection {
  protectedText: string;
  restoreMap: Map<string, string>;
}

/**
 * Schuetzt /* ... *\/ CSS-Kommentare vor DeepL-Uebersetzung.
 * Greift als Sicherheitsnetz fuer inner <style>-Bloecke, die nach dem
 * Cell-Decode normal als <style> erkannt werden — falls DeepL aus anderen
 * Gruenden den style-Block doch ankratzt, sind die Comments trotzdem sicher.
 */
export function protectCssComments(text: string): CssCommentProtection {
  const restoreMap = new Map<string, string>();
  let counter = 0;
  // Non-greedy: erstes */ schliesst den Comment.
  const result = text.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const sentinel = `${CSS_COMMENT_SENTINEL_PREFIX}${counter++}__`;
    restoreMap.set(sentinel, match);
    return sentinel;
  });
  return { protectedText: result, restoreMap };
}

export function restoreCssComments(text: string, restoreMap: Map<string, string>): string {
  let result = text;
  for (const [sentinel, original] of restoreMap.entries()) {
    result = result.split(sentinel).join(original);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fix #4: Title-Suffix-Mapping
// ---------------------------------------------------------------------------

// Strikter Match: WORT-GRENZE + Leerzeichen + LANG-CODE am Stringende.
// Wir matchen nur sehr kurze Cells (siehe MAX_TITLE_LEN), damit das nicht
// versehentlich in Fliesstext greift, der zufaellig auf " DE" endet.
const TITLE_LANG_SUFFIX_RE = /\s+(DE|EN|FR|IT|ES|NL|PL|CS|HU|SK|SL|CZ|AT|GB|US)$/;
const MAX_TITLE_LEN = 120;

/**
 * Wenn der Source-Text auf einen Lang-Code endet (" DE", " EN", ...) und
 * kurz genug ist, gib die Target-Variante zurueck — dann skippt der Worker
 * DeepL fuer diese Cell und vermeidet Halluzinationen wie
 * "Test Translate Tool DE" → "Exemples formats".
 */
export function tryTitleSuffixMap(text: string, targetLang: string): string | null {
  if (!text || text.length > MAX_TITLE_LEN) return null;
  if (!TITLE_LANG_SUFFIX_RE.test(text)) return null;
  const targetCode = (targetLang || '').toUpperCase().split('-')[0];
  if (!targetCode) return null;
  return text.replace(TITLE_LANG_SUFFIX_RE, ` ${targetCode}`);
}

// ---------------------------------------------------------------------------
// Fix #6 (27.05.2026) + Fix #7 (27.05.2026) → abgeloest am 28.07.2026
// ---------------------------------------------------------------------------
//
// Der Attribut-Pre-Pass (`protectHtmlAttributes`) liegt jetzt in
// `./html-attributes.ts` — tag-bewusst, damit `value` (nur Submit-Buttons) und
// `content` (nur `<meta>` per Allowlist) entscheidbar sind, und ergaenzt um
// `aria-description`/`aria-placeholder`/`aria-roledescription`/`aria-valuetext`/
// `label`. Die Storeview-Injection ist Teil von `./storeview.ts` (siehe oben).

// ---------------------------------------------------------------------------
// Fix #5: Output-Sanity-Check
// ---------------------------------------------------------------------------

// Erkennt offensichtlich korrupte Tokens wie `<\n`, `<\s`, `<\div`, `<\` —
// die kommen als DeepL-Artefakt bei Mega-Cells vor.
// Pattern: Backslash + (Letter | space | string-end), optional als HTML-entity.
const STRAY_TOKEN_RE = /<\\(?:[a-z]+|\s+|$)/gi;
const STRAY_TOKEN_ENTITY_RE = /&lt;\\(?:[a-z]+|\s+|$)/gi;

export interface SanityResult {
  cleaned: string;
  strayCount: number;
}

export function sanitizeStrayEscapes(text: string): SanityResult {
  let strayCount = 0;
  let cleaned = text.replace(STRAY_TOKEN_RE, () => {
    strayCount++;
    return '';
  });
  cleaned = cleaned.replace(STRAY_TOKEN_ENTITY_RE, () => {
    strayCount++;
    return '';
  });
  return { cleaned, strayCount };
}
