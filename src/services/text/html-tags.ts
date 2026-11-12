/**
 * Minimaler, gemeinsamer Tag-/Attribut-Scanner für die HTML-Schutzschichten.
 *
 * Warum kein echter DOM-Parser: die Pipeline muss den Input BYTE-genau
 * zurückgeben können (Regel 6 — keine Tags hinzufügen, entfernen oder
 * umsortieren). Jeder re-serialisierende Parser normalisiert (Attribut-
 * Reihenfolge, Quotes, Selbstschluss, Entities) und verletzt das. Deshalb
 * arbeiten wir textuell und ersetzen nur exakt die gematchten Bereiche.
 *
 * Warum ein eigenes Modul: die Attribut-Erkennung per `\bname=` ist eine Falle —
 * in `data-title="…"` liegt vor `title` eine Wortgrenze, `\btitle=` matcht also.
 * Genauso matcht `\bsrcset=` in `data-srcset=`. Hier wird deshalb JEDES Attribut
 * mit vollem Namen gematcht und der Name danach EXAKT verglichen; `data-*`- und
 * Framework-Attribute (`x-`, `v-`, `ng-`) fallen damit von selbst raus, sofern
 * sie nicht ausdrücklich in der jeweiligen Liste stehen.
 */

/**
 * Öffnende Tags (inkl. selbstschließend). `[^>]*` heißt: ein `>` INNERHALB
 * eines Attributwerts beendet den Match zu früh — die folgenden Attribute des
 * Tags bleiben dann ungeschützt (Status quo im Bestand), es entsteht aber keine
 * Korruption. Closing-Tags (`</a>`), Kommentare (`<!--`) und Doctype (`<!`)
 * matchen nicht, weil nach `<` ein Buchstabe stehen muss.
 */
export const TAG_RE = /<([a-zA-Z][a-zA-Z0-9:._-]*)((?:[^>])*?)(\/?)>/g;

/**
 * Ein Attribut mit Wert. Quote-Formen: `"`, `'` und `&quot;` — letzteres, weil
 * Magento-XML-Exporte entity-encoded HTML enthalten.
 * Gruppen: 1 = Name, 2 = Quote, 3 = Wert.
 */
export const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("|'|&quot;)([\s\S]*?)\2/g;

/** Alle Attribute eines Tag-Attribut-Strings als Map (Name lowercase → Wert). */
export function parseAttrMap(attrs: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of attrs.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!map.has(name)) map.set(name, m[3]);
  }
  return map;
}

/** Wert eines Attributs, getrimmt + lowercase. Leerstring wenn nicht vorhanden. */
export function readAttr(attrs: string, name: string): string {
  return (parseAttrMap(attrs).get(name.toLowerCase()) || '').trim().toLowerCase();
}

/**
 * Boolean-Attribut ohne Wert (`<a download href=…>`) ODER mit Wert
 * (`download="datenblatt.pdf"`). Exakter Name, damit `data-download` nicht matcht.
 */
export function hasBooleanAttr(attrs: string, name: string): boolean {
  const re = new RegExp(`(?:^|\\s)${name}(?=$|[\\s=])`, 'i');
  return re.test(attrs);
}
