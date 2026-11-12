/**
 * Attribut-Pre-Pass für HTML/XML (Regel 2: sichtbare Attributtexte übersetzen).
 *
 * Hintergrund: DeepL HTML-Mode soll laut Spec `alt`/`title`/`placeholder`/
 * `aria-label` mit-übersetzen, lässt sie in der Praxis aber oft unangetastet
 * (Meldung Sabrina 27.05.2026). Deshalb: Werte vor DeepL durch Sentinels
 * ersetzen, separat im TEXT-Mode übersetzen, danach einsetzen — unabhängig
 * vom DeepL-Default.
 *
 * 28.07.2026: von einer flachen Attribut-Regex auf tag-bewusstes Scannen
 * umgestellt. Notwendig, weil `value` und `content` NUR in bestimmten Elementen
 * sichtbaren Text tragen:
 *   - `value` → nur `<input type=submit|button|reset>` (Button-Beschriftung).
 *     Bei `hidden`/`checkbox`/`radio`/`<option>` ist es ein Formular-Schlüssel
 *     und darf niemals übersetzt werden.
 *   - `content` → nur `<meta>` mit Namen aus der Allowlist (Description,
 *     Keywords, OpenGraph/Twitter). `content` auf `<meta name="viewport">`
 *     würde das Layout zerstören.
 *
 * Der Pass läuft NACH `protectLinkAttributes()` — `href`/`src` sind dann
 * bereits Sentinels und können hier nicht mehr auftauchen.
 */

import { TAG_RE, ATTR_RE, parseAttrMap } from './html-tags';

/** Immer übersetzen, unabhängig vom Element. */
const ALWAYS_TRANSLATABLE = new Set([
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
]);

/** `label` ist nur in diesen Elementen ein sichtbarer Text. */
const LABEL_TAGS = new Set(['option', 'optgroup', 'track']);

/** `value` trägt nur bei diesen Input-Typen eine sichtbare Beschriftung. */
const VALUE_INPUT_TYPES = new Set(['submit', 'button', 'reset']);

/** `<meta name="...">`, deren `content` dem Nutzer präsentiert wird. */
const META_CONTENT_NAMES = new Set(['description', 'keywords', 'title', 'subject', 'abstract']);

/** `<meta property="...">` (OpenGraph/Twitter) — Social-/SERP-Vorschau. */
const META_CONTENT_PROPS = new Set([
  'og:title',
  'og:description',
  'og:site_name',
  'og:image:alt',
  'twitter:title',
  'twitter:description',
  'twitter:image:alt',
]);

/** Kandidaten-Namen exakt (kein `\b`-Match — sonst matcht `data-title` als `title`). */
const CANDIDATE_ATTRS = new Set([...ALWAYS_TRANSLATABLE, 'label', 'value', 'content']);

const CANDIDATE_HINT_RE = new RegExp(
  `(?:^|[\\s"'])(?:${[...CANDIDATE_ATTRS].join('|')})\\s*=`,
  'i',
);

const ATTR_SENTINEL_PREFIX = '__ISOLATTR';

/** Reiner Sentinel aus einer anderen Pipeline (`__ISOLURL0__`, `__MAGTKN3__`, …). */
const ONLY_SENTINELS_RE = /^(?:__(?:ISOL[A-Z]+|MAGTKN|TERM)_?\d+__|\s)+$/;

/** Werte, die keine Übersetzung brauchen/vertragen (URLs, Direktiven, Zahlen). */
const NON_TRANSLATABLE_VALUE_RE = /^(?:https?:|mailto:|tel:|\/|#|\{\{|__)/;

export interface HtmlAttrProtection {
  protectedText: string;
  /** Pro Sentinel: der zu übersetzende Wert. Reihenfolge == Translation-Reihenfolge. */
  pending: Array<{ sentinel: string; attrName: string; quote: string; sourceText: string }>;
}

/** Trägt dieses Attribut in diesem Element sichtbaren Text? */
function isTranslatableAttr(tag: string, attrs: Map<string, string>, attrName: string): boolean {
  const name = attrName.toLowerCase();
  if (ALWAYS_TRANSLATABLE.has(name)) return true;
  if (name === 'label') return LABEL_TAGS.has(tag);
  if (name === 'value') {
    const type = (attrs.get('type') || '').trim().toLowerCase();
    return tag === 'input' && VALUE_INPUT_TYPES.has(type);
  }
  if (name === 'content') {
    if (tag !== 'meta') return false;
    const metaName = (attrs.get('name') || '').trim().toLowerCase();
    if (metaName && META_CONTENT_NAMES.has(metaName)) return true;
    const prop = (attrs.get('property') || '').trim().toLowerCase();
    return !!prop && META_CONTENT_PROPS.has(prop);
  }
  return false;
}

function isWorthTranslating(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (ONLY_SENTINELS_RE.test(trimmed)) return false;
  if (NON_TRANSLATABLE_VALUE_RE.test(trimmed)) return false;
  // Ohne Buchstaben (reine Zahlen/Maße wie "100") gibt es nichts zu übersetzen.
  if (!/\p{L}/u.test(trimmed)) return false;
  return true;
}

/**
 * Extrahiert übersetzungswürdige Attributwerte und ersetzt sie durch Sentinels.
 *
 * Caller-Verantwortung:
 *  1. `protectHtmlAttributes(html)` aufrufen
 *  2. `pending[].sourceText` per DeepL TEXT-Mode übersetzen (Batch)
 *  3. `restoreHtmlAttributes(translatedHtml, pending, translations)` aufrufen
 */
export function protectHtmlAttributes(text: string): HtmlAttrProtection {
  const pending: HtmlAttrProtection['pending'] = [];
  if (!CANDIDATE_HINT_RE.test(text)) return { protectedText: text, pending };

  let counter = 0;
  const protectedText = text.replace(
    TAG_RE,
    (fullTag, tagName: string, attrs: string, selfClose: string) => {
      if (!CANDIDATE_HINT_RE.test(attrs)) return fullTag;
      const tag = tagName.toLowerCase();
      const attrMap = parseAttrMap(attrs);

      const newAttrs = attrs.replace(
        ATTR_RE,
        (full, attrName: string, quote: string, value: string) => {
          if (!CANDIDATE_ATTRS.has(attrName.toLowerCase())) return full;
          if (!isTranslatableAttr(tag, attrMap, attrName)) return full;
          if (!isWorthTranslating(value)) return full;
          const sentinel = `${ATTR_SENTINEL_PREFIX}${counter++}__`;
          pending.push({
            sentinel,
            attrName: attrName.toLowerCase(),
            quote,
            sourceText: value,
          });
          return `${attrName}=${quote}${sentinel}${quote}`;
        },
      );

      return `<${tagName}${newAttrs}${selfClose}>`;
    },
  );

  return { protectedText, pending };
}

/**
 * Setzt übersetzte Attributwerte ein. `translations` muss in gleicher
 * Reihenfolge wie `pending` sein (i-ter Sentinel ↔ i-te Translation).
 * Fehlende Translation → Quelltext bleibt stehen (nie ein nackter Sentinel).
 */
export function restoreHtmlAttributes(
  text: string,
  pending: HtmlAttrProtection['pending'],
  translations: string[],
): string {
  let result = text;
  for (let i = 0; i < pending.length; i++) {
    const { sentinel, quote, sourceText } = pending[i];
    let translated = translations[i] ?? sourceText;
    // Das Quote-Zeichen des Attributs darf im Wert nicht unescaped vorkommen,
    // sonst bricht das Attribut auf (DeepL liefert z.B. im FR gerne Apostrophe).
    if (quote === '"') {
      translated = translated.replace(/"/g, '&quot;');
    } else if (quote === "'") {
      translated = translated.replace(/'/g, '&#39;');
    } else {
      // Quote war `&quot;` → wir sind eine Encoding-Ebene tiefer (Magento-XML).
      // Ein `"` muss hier als `&amp;quot;` stehen, damit nach dem Decode der
      // umgebenden Ebene wieder `&quot;` übrig bleibt.
      translated = translated.replace(/"/g, '&amp;quot;');
    }
    result = result.split(sentinel).join(translated);
  }
  return result;
}
