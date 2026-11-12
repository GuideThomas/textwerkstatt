/**
 * Store-View-Behandlung interner Links + Schutz ALLER URL-Attribute.
 *
 * Zwei Vorgaben, ein Mechanismus:
 *
 *   Regel 3 — Interne Navigations-Links tragen die Store-View der Zielsprache:
 *             `/de/produkt-a` → `/en/produkt-a`, `/led-praxis` → `/fr/led-praxis`.
 *   Regel 4 — Ressourcen-URLs (Bilder, CSS, JS, Fonts, PDFs, Downloads, CDN)
 *             bleiben UNVERÄNDERT — auch wenn sie `/de/` enthalten.
 *
 * Umsetzung: JEDER URL-Attributwert (`href`, `src`, `srcset`, `data-src`,
 * `data-srcset`) wird vor DeepL durch einen inerten Sentinel ersetzt. Damit kann
 * DeepL weder URL-Slugs übersetzen (Vorfall 22.05.2026) noch `&` in
 * Query-Strings zu `&amp;` re-encoden (gleiche Fehlerklasse wie der
 * Apostroph-Bug in `<script>`, 01.06.2026). Beim Restore wird ausschließlich
 * für Navigations-`href`s die Store-View gesetzt — alles andere kommt verbatim
 * zurück. Regel 4 ist damit nicht mehr "wir fassen src nicht an", sondern
 * strukturell garantiert.
 *
 * Seit 28.07.2026 unkonditional für ALLE Projekte (Entscheidung Thomas). Der
 * früher nötige Projekt-Toggle `projects.inject_storeview_prefix` ist damit
 * bedeutungslos (Spalte bleibt für Alt-Projekte stehen, wird nicht mehr
 * gelesen — siehe Migration 020).
 */

import { config } from '../../config';
import { TAG_RE, ATTR_RE, readAttr, hasBooleanAttr } from './html-tags';

// ---------------------------------------------------------------------------
// Store-View-Segmente
// ---------------------------------------------------------------------------

/**
 * Die real existierenden Store-Views des Shops (Thomas, 29.07.2026).
 *
 * Diese Liste ist abschließend — sie ist KEINE Sammlung plausibler Sprachcodes.
 * Beides hat Konsequenzen:
 *   * Nur diese Segmente werden am Pfadanfang als Store-View erkannt und getauscht.
 *   * Nur in diese Segmente wird umgeschrieben; für eine Zielsprache ohne
 *     Store-View bleibt der Link unverändert (siehe `toStoreViewCode`).
 *
 * Vorher stand hier eine breite Sammlung (`at`, `ch`, `sl`, `no`, `is`, …). Das
 * war gefährlich: ein Inhaltspfad wie `/at/aktion` hätte als Store-View gegolten
 * und wäre zu `/it/aktion` **ersetzt** worden — das Segment wäre verschwunden.
 */
export const STOREVIEW_SEGMENTS = new Set([
  'de', 'en', 'it', 'fr', 'es', 'pl', 'cz', 'sk', 'hu',
]);

/**
 * Zusätzlich als Store-View-Präfix ERKANNT (aber nie erzeugt): `cs` ist der
 * ISO-Code für Tschechisch, den die UI verwendet, während der Shop `/cz/` fährt.
 * Taucht `/cs/` in Altbestand auf, ist es als Store-View gemeint und wird
 * getauscht — nicht als Inhaltspfad missverstanden.
 */
const LEGACY_STOREVIEW_SEGMENTS = new Set(['cs']);

/**
 * Sprachcode → Store-View-Segment.
 *
 * Tschechisch kommt im Stack unter ZWEI Codes an (`CZ` aus dem
 * Artikelanlage-Assistenten, `CS` aus allen UI-Dropdowns — siehe
 * `normalizeGlossaryLang()` in `../lang.ts`). Ohne Normalisierung erzeugt
 * derselbe Auftrag je Einstiegspunkt `/cz/` ODER `/cs/` — also zwei
 * verschiedene Store-Views für eine Sprache. Kanonisch ist `cz`, analog zur
 * Glossar-Entscheidung vom 27.07.2026.
 *
 * Kommt eine neue Store-View dazu, gehört sie in `STOREVIEW_SEGMENTS`; weicht
 * ihr Code vom Sprachcode ab, zusätzlich hier oder per
 * `STOREVIEW_LANG_MAP=nl=be` in der `.env` (dann ohne Code-Deploy).
 */
const DEFAULT_STOREVIEW_ALIASES: Record<string, string> = {
  cs: 'cz',
};

/** Erlaubte Form eines Store-View-Segments (für operator-gesetzte Overrides). */
const STOREVIEW_CODE_RE = /^[a-z0-9]([a-z0-9_-]{0,9})$/;

/**
 * Store-View-Code für eine Zielsprache. `null` = der Shop hat für diese Sprache
 * keine Store-View → Links bleiben unverändert.
 *
 * Das betrifft real jede Zielsprache außerhalb der neun (z.B. NL, SL, PT): der
 * Link zeigt dann weiter auf die Quell-Store-View. Das ist bewusst so — ein
 * erfundenes `/nl/` wäre ein 404, ein bestehender `/de/`-Link nur die falsche
 * Sprache. Sobald es die Store-View gibt, oben eintragen.
 */
export function toStoreViewCode(lang: string): string | null {
  const base = (lang || '').toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(base)) return null;

  const override = config.storeview.langMap[base];
  if (override) return STOREVIEW_CODE_RE.test(override) ? override : null;

  const aliased = DEFAULT_STOREVIEW_ALIASES[base] || base;
  return STOREVIEW_SEGMENTS.has(aliased) ? aliased : null;
}

// ---------------------------------------------------------------------------
// Navigations- vs. Ressourcen-URL
// ---------------------------------------------------------------------------

/**
 * Dateiendungen, die eine URL zur Ressource machen — auch als `<a href>`.
 * Regel 4 nennt Downloads und PDFs ausdrücklich: `<a href="/de/x.pdf">` darf
 * NICHT auf `/en/x.pdf` umgeschrieben werden, sonst 404 auf dem Datenblatt.
 */
const RESOURCE_EXT_RE =
  /\.(?:css|js|mjs|cjs|map|json|jsonld|xml|xsl|rss|atom|svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|ai|eps|woff2?|ttf|otf|eot|pdf|zip|rar|7z|tar|gz|tgz|docx?|xlsx?|pptx?|csv|txt|rtf|mp[34]|m4[av]|wav|ogg|oga|webm|mov|avi|mkv|dwg|dxf|ies|ldt|stp|step|3ds|obj)(?=$|[?#])/i;

/**
 * Pfad-Wurzeln, unter denen ausschließlich Assets liegen.
 * Bewusst NICHT enthalten: `/catalog/` (in Magento echte Navigation —
 * `/catalog/product/view/id/5`); Medien liegen dort unter `/media/catalog/...`.
 */
const ASSET_PATH_RE =
  /^\/(?:media|static|pub|assets?|skin|frontend|js|css|fonts?|img|images?|icons?|downloads?|files?|cdn)(?:\/|$)/i;

/** `rel`-Werte, die einen Link zur Ressource machen (Stylesheet, Preload, Icon). */
const RESOURCE_REL = new Set([
  'stylesheet', 'preload', 'prefetch', 'preconnect', 'dns-prefetch',
  'icon', 'shortcut', 'apple-touch-icon', 'mask-icon', 'manifest',
  'canonical', 'alternate', 'prev', 'next',
]);

/** Nur diese Elemente sind Navigation. `<link>`, `<base>`, `<use>` sind es nicht. */
const NAVIGATION_TAGS = new Set(['a', 'area']);

/** Interner, root-relativer Pfad? (`/x` ja; `//cdn`, `https://`, `#`, `?`, `foo` nein) */
export function isInternalPath(url: string): boolean {
  if (!url) return false;
  if (!url.startsWith('/')) return false;
  // Schema-relativ (`//cdn.example.com/...`) ist hier nicht gemeint — dafür
  // greift die Host-Prüfung in `splitAbsoluteUrl()`.
  if (url.startsWith('//')) return false;
  return true;
}

/**
 * Absolute (oder schema-relative) URL in Präfix + Pfad + Rest zerlegen, WENN der
 * Host zu den eigenen Shop-Hosts gehört. Sonst `null`.
 *
 * Hintergrund: ein absoluter Link auf die eigene Domain ist fachlich ein interner
 * Shop-Link — real beobachtet blieben IT-Segmente auf
 * `https://www.example.com/de/customer/account/create/` stehen, also auf der
 * deutschen Seite im italienischen Store. Fremde Hosts (CDN, Partner) bleiben
 * grundsätzlich unangetastet.
 */
function splitAbsoluteUrl(
  url: string,
): { prefix: string; path: string; rest: string } | null {
  if (config.storeview.internalHosts.length === 0) return null;
  const m = url.match(/^((?:https?:)?\/\/)([^/?#]+)(\/[^?#]*)([\s\S]*)$/i);
  if (!m) return null;
  const host = m[2].toLowerCase().split('@').pop()!.split(':')[0];
  if (!config.storeview.internalHosts.includes(host)) return null;
  // Nur mit echtem Pfad umschreiben — ein Link auf die bloße Domain (`/`) lassen
  // wir dem Shop-Redirect.
  if (m[3] === '/' || m[3] === '') return null;
  return { prefix: m[1] + m[2], path: m[3], rest: m[4] };
}

/** Zeigt die URL auf eine statische Ressource? */
export function isResourceUrl(url: string): boolean {
  if (RESOURCE_EXT_RE.test(url)) return true;
  if (ASSET_PATH_RE.test(url)) return true;
  return false;
}

/**
 * Store-View auf einen internen Navigationspfad anwenden. Drei Fälle:
 *
 *  1. Bekanntes Store-View-Präfix        → tauschen   (`/de/produkt` → `/en/produkt`)
 *  2. Anderes zweibuchstabiges Segment   → UNVERÄNDERT lassen
 *  3. Alles andere                       → injizieren (`/led-praxis` → `/en/led-praxis`)
 *
 * Fall 2 ist der Sicherheitsfall: `/at/aktion` könnte ein Inhaltspfad sein (es
 * gibt keine `at`-Store-View). Ersetzen würde das Segment verschlucken
 * (`/en/aktion`), Injizieren würde einen toten Pfad bauen (`/en/at/aktion`).
 * Bei Zweideutigkeit ist Nichtstun die einzige Variante, die nichts kaputt macht.
 */
export function applyStoreView(url: string, storeCode: string): string {
  const m = url.match(/^\/([a-zA-Z]{2})(?=$|[/?#])/);
  if (m) {
    const seg = m[1].toLowerCase();
    if (STOREVIEW_SEGMENTS.has(seg) || LEGACY_STOREVIEW_SEGMENTS.has(seg)) {
      return `/${storeCode}${url.slice(m[0].length)}`;
    }
    return url; // zweideutig → nicht anfassen
  }
  return `/${storeCode}${url}`;
}

// ---------------------------------------------------------------------------
// Schutz + Restore
// ---------------------------------------------------------------------------

const SENTINEL_PREFIX = '__ISOLURL';

/**
 * URL-tragende Attribute. Exakter Namensvergleich (siehe `html-tags.ts`) —
 * `data-src`/`data-srcset` stehen deshalb ausdrücklich in der Liste, während
 * z.B. `data-href-template` NICHT matcht.
 */
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'data-src', 'data-srcset']);

const URL_ATTR_HINT_RE = /(?:^|[\s"'])(?:href|src|srcset|data-src|data-srcset)\s*=/i;

export interface LinkProtection {
  protectedText: string;
  restoreMap: Map<string, string>;
  /** Wie viele Navigations-Links auf die Ziel-Store-View umgeschrieben wurden. */
  rewritten: number;
}

/**
 * Alle URL-Attribute durch Sentinels ersetzen; Navigations-`href`s dabei auf die
 * Store-View der Zielsprache umschreiben.
 *
 * MUSS vor allen sentinel-erzeugenden Schritten laufen (Akronym/Pol/Einheit/
 * Channel-Token) — sonst landen deren Sentinels IM Link und werden nach dem
 * Link-Restore nicht mehr aufgelöst.
 * MUSS nach `protectCodeBlocks()` laufen, damit URLs in `<script>`/`<style>`
 * unangetastet bleiben.
 */
export function protectLinkAttributes(text: string, targetLang: string): LinkProtection {
  const restoreMap = new Map<string, string>();
  if (!URL_ATTR_HINT_RE.test(text)) {
    return { protectedText: text, restoreMap, rewritten: 0 };
  }

  const storeCode = toStoreViewCode(targetLang);
  let counter = 0;
  let rewritten = 0;

  const protectedText = text.replace(
    TAG_RE,
    (fullTag, tagName: string, attrs: string, selfClose: string) => {
      if (!URL_ATTR_HINT_RE.test(attrs)) return fullTag;

      const tag = tagName.toLowerCase();
      const isNavTag = NAVIGATION_TAGS.has(tag);
      const download = hasBooleanAttr(attrs, 'download');
      const relIsResource = readAttr(attrs, 'rel')
        .split(/\s+/)
        .some((r) => RESOURCE_REL.has(r));

      const newAttrs = attrs.replace(
        ATTR_RE,
        (full, attrName: string, quote: string, value: string) => {
          if (!URL_ATTRS.has(attrName.toLowerCase())) return full;

          const sentinel = `${SENTINEL_PREFIX}${counter++}__`;
          let finalValue = value;

          // Grundvoraussetzung: Navigations-href eines <a>/<area>, kein Download,
          // kein Ressourcen-`rel`, und die Zielsprache hat eine Store-View.
          const navigable =
            attrName.toLowerCase() === 'href' && isNavTag && !download && !relIsResource && !!storeCode;

          if (navigable) {
            const code = storeCode as string;
            if (isInternalPath(value)) {
              // Root-relativ: `/de/produkt` bzw. `/produkt`
              if (!isResourceUrl(value)) {
                const next = applyStoreView(value, code);
                if (next !== value) rewritten++;
                finalValue = next;
              }
            } else {
              // Absolut auf einen eigenen Shop-Host: Pfadteil umschreiben,
              // Schema + Host + Query/Fragment bleiben unberührt.
              const abs = splitAbsoluteUrl(value);
              if (abs && !isResourceUrl(abs.path)) {
                const nextPath = applyStoreView(abs.path, code);
                if (nextPath !== abs.path) {
                  rewritten++;
                  finalValue = `${abs.prefix}${nextPath}${abs.rest}`;
                }
              }
            }
          }

          restoreMap.set(sentinel, `${attrName}=${quote}${finalValue}${quote}`);
          return sentinel;
        },
      );

      return `<${tagName}${newAttrs}${selfClose}>`;
    },
  );

  return { protectedText, restoreMap, rewritten };
}

export function restoreLinkAttributes(
  text: string,
  restoreMap: Map<string, string>,
): string {
  let result = text;
  for (const [sentinel, original] of restoreMap.entries()) {
    result = result.split(sentinel).join(original);
  }
  return result;
}
