/**
 * Die Markup-Schutzschicht als EIN Baustein — für alle Übersetzungspfade.
 *
 * Warum dieses Modul existiert: die Schutzschritte lagen dreifach kopiert in
 * drei Pfaden, und jeder Fix landete jeweils nur in einem davon:
 *
 *   Pfad A  Magento-Zellen (CSV/SpreadsheetML `content`)  — `translateProtectedHtml`
 *   Pfad B  HTML-/XML-Datei-Upload                        — Batch-Schleife in queue.ts
 *   Pfad C  Schnellübersetzung (`/api/quick-translate`)   — eigene Route
 *
 * Belegte Fälle dieser Fehlerklasse: Magento-Direktiven (01.06.2026, fehlten in B),
 * JSON-LD (29.06.2026, fehlte in B), Store-View + Attribute (28.07.2026, fehlten
 * in B), und schließlich ALLES davon in C (29.07.2026, gemeldet von Thomas an
 * einem `/de/`-Link, der in der spanischen Ausgabe stehen blieb).
 *
 * Die Reihenfolge ist keine Stilfrage, sondern Korrektheit — deshalb steht sie
 * hier einmal und nirgends sonst:
 *
 *   1. `<script>`/`<style>` auslagern     ZUERST, sonst landen fremde Sentinels
 *                                         im Code, der erst ganz am Ende
 *                                         verbatim zurückkommt.
 *   ── hier macht der Aufrufer sein Channel-Pre-Replacement ──
 *   2. URL-Attribute + Store-View         vor allen weiteren Sentinels, sonst
 *                                         steckt ein `__ISOLUNIT3__` in der URL.
 *   3. Magento-Direktiven `{{…}}`
 *   4. CSS-Kommentare
 *   ── hier macht der Aufrufer Akronym-/Pol-/Einheiten-/Token-Schutz ──
 *   5. Attribut-Pre-Pass (eigener DeepL-Batch)
 *   ── DeepL ──
 *   Restore exakt spiegelbildlich; `<script>`/`<style>` ganz zuletzt, nach
 *   Post-Replacement und Groß-/Kleinschreibungs-Korrektur.
 *
 * Wer einen Schritt ergänzt, ergänzt ihn hier — dann haben ihn alle drei Pfade.
 */

import {
  protectMagentoDirectives,
  restoreMagentoDirectives,
  protectCodeBlocks,
  restoreCodeBlocks,
  protectCssComments,
  restoreCssComments,
} from './magento-html';
import { protectLinkAttributes, restoreLinkAttributes } from './storeview';
import {
  protectHtmlAttributes,
  restoreHtmlAttributes,
  type HtmlAttrProtection,
} from './html-attributes';
import { translateJsonLdBlocks } from './jsonld';

// ---------------------------------------------------------------------------
// Stufe 0: JSON-LD (schema.org) — vor allem anderen
// ---------------------------------------------------------------------------

/**
 * Übersetzt die natürlichsprachlichen Felder in `<script type="application/ld+json">`
 * und serialisiert den Block neu. MUSS vor `protectCodeBlocks()` laufen, sonst ist
 * der Block bereits ausgelagert; und vor dem Channel-Pre-Replacement, sonst landen
 * `__TERM_n__`-Tokens im neu serialisierten JSON.
 *
 * No-op ohne ld+json-Block.
 */
export async function translateJsonLd(
  text: string,
  translate: (values: string[]) => Promise<string[]>,
): Promise<string> {
  return translateJsonLdBlocks(text, translate);
}

// ---------------------------------------------------------------------------
// Stufe 1 + 2–4: Markup-Schutz
// ---------------------------------------------------------------------------

export interface CodeBlockCtx {
  restoreMap: Map<string, string>;
}

/** Stufe 1 — ZUERST, vor jedem anderen Schritt des Aufrufers. */
export function protectCode(text: string): { text: string; ctx: CodeBlockCtx } {
  const prot = protectCodeBlocks(text);
  return { text: prot.protectedText, ctx: { restoreMap: prot.restoreMap } };
}

/** Gegenstück zu `protectCode` — ganz zuletzt, nach ALLEN anderen Restores. */
export function restoreCode(text: string, ctx: CodeBlockCtx): string {
  return restoreCodeBlocks(text, ctx.restoreMap);
}

export interface MarkupCtx {
  urls: Map<string, string>;
  directives: Map<string, string>;
  cssComments: Map<string, string>;
  /** Wie viele Navigationslinks auf die Ziel-Store-View umgeschrieben wurden. */
  urlsRewritten: number;
}

/**
 * Stufen 2–4 — nach dem Channel-Pre-Replacement, vor Akronym-/Pol-/Einheiten-Schutz.
 */
export function protectMarkup(text: string, targetLang: string): { text: string; ctx: MarkupCtx } {
  const urlProt = protectLinkAttributes(text, targetLang);
  const dirProt = protectMagentoDirectives(urlProt.protectedText);
  const cssProt = protectCssComments(dirProt.protectedText);
  return {
    text: cssProt.protectedText,
    ctx: {
      urls: urlProt.restoreMap,
      directives: dirProt.restoreMap,
      cssComments: cssProt.restoreMap,
      urlsRewritten: urlProt.rewritten,
    },
  };
}

/**
 * Gegenstück zu `protectMarkup`. MUSS vor dem Channel-Post-Replacement laufen,
 * damit ein Channel-Token, das in einem URL-Slug steckt, noch aufgelöst wird.
 */
export function restoreMarkup(text: string, ctx: MarkupCtx): string {
  let result = restoreCssComments(text, ctx.cssComments);
  result = restoreMagentoDirectives(result, ctx.directives);
  result = restoreLinkAttributes(result, ctx.urls);
  return result;
}

// ---------------------------------------------------------------------------
// Stufe 5: Attribut-Pre-Pass
// ---------------------------------------------------------------------------

export interface AttrCtx {
  pending: HtmlAttrProtection['pending'];
  translations: string[];
}

/**
 * Stufe 5 für MEHRERE Texte — direkt vor dem DeepL-Aufruf.
 *
 * Die Attributwerte aller Texte gehen in EINEN `translate`-Aufruf und werden
 * danach wieder den Texten zugeordnet. Das ist der Grund, warum es diese
 * Batch-Variante gibt: ein Aufruf je Text würde bei 50 Segmenten 50 statt einer
 * DeepL-Anfrage erzeugen.
 */
export async function protectAttributesBatch(
  texts: string[],
  translate: (values: string[]) => Promise<string[]>,
): Promise<{ texts: string[]; ctxs: AttrCtx[] }> {
  const prots = texts.map((t) => protectHtmlAttributes(t));
  const flat: string[] = [];
  for (const prot of prots) for (const p of prot.pending) flat.push(p.sourceText);

  if (flat.length === 0) {
    return {
      texts: prots.map((p) => p.protectedText),
      ctxs: prots.map(() => ({ pending: [], translations: [] })),
    };
  }

  const flatTranslations = await translate(flat);
  const ctxs: AttrCtx[] = [];
  let cursor = 0;
  for (const prot of prots) {
    ctxs.push({
      pending: prot.pending,
      translations: flatTranslations.slice(cursor, cursor + prot.pending.length),
    });
    cursor += prot.pending.length;
  }
  return { texts: prots.map((p) => p.protectedText), ctxs };
}

/**
 * Stufe 5 für EINEN Text. Kommt beim Übersetzen der Werte ein Fehler, bleibt der
 * Quelltext stehen (nie ein nackter Sentinel) — siehe `restoreHtmlAttributes`.
 */
export async function protectAttributes(
  text: string,
  translate: (values: string[]) => Promise<string[]>,
): Promise<{ text: string; ctx: AttrCtx }> {
  const { texts, ctxs } = await protectAttributesBatch([text], translate);
  return { text: texts[0], ctx: ctxs[0] };
}

/** Gegenstück zu `protectAttributes` — als erster Restore nach DeepL. */
export function restoreAttributes(text: string, ctx: AttrCtx): string {
  if (ctx.pending.length === 0) return text;
  return restoreHtmlAttributes(text, ctx.pending, ctx.translations);
}

// ---------------------------------------------------------------------------
// Sicherheitsnetz
// ---------------------------------------------------------------------------

/**
 * Alle Sentinel-Präfixe, die in der Pipeline erzeugt werden — die Schutzschichten
 * hier plus die der Aufrufer (Akronyme, Pol-/Litzenzahl, Einheiten,
 * Magento-Konstanten, Channel-Overrides).
 */
const SENTINEL_LEAK_RE = /__(?:ISOL[A-Z]+\d+|MAGTKN\d+|TERM_\d+)__/g;

/**
 * Meldet Sentinels, die es bis in den fertigen Text geschafft haben.
 *
 * Genau so sieht ein Reihenfolge-Fehler aus: wird ein Bereich ausgelagert,
 * NACHDEM eine andere Schicht dort einen Sentinel hinterlassen hat, kommt der
 * Bereich am Ende verbatim zurück — mit dem Sentinel darin, nachdem dessen
 * Restore längst gelaufen ist. Zwei solche Fälle lagen unbemerkt im Bestand
 * (Channel-Tokens und Einheiten-Sentinels in `<script>`-Blöcken).
 *
 * Bewusst nur eine Warnung: den Text zu verwerfen wäre schlimmer als ihn
 * auszuliefern — aber im Log steht dann, wo es klemmt.
 */
export function warnOnSentinelLeak(text: string, context: string): number {
  const leaks = text.match(SENTINEL_LEAK_RE);
  if (!leaks) return 0;
  const unique = [...new Set(leaks)];
  console.warn(
    `[Sentinel-Leak] ${context}: ${leaks.length} nicht aufgelöste(r) Sentinel im Ergebnis ` +
      `(${unique.slice(0, 5).join(', ')}${unique.length > 5 ? ', …' : ''}) — Reihenfolge der ` +
      `Schutzschichten prüfen (services/text/html-pipeline.ts).`,
  );
  return leaks.length;
}
