import crypto from 'crypto';

/**
 * Normalisiert einen Text für robustere Cache-Lookups.
 * - NFKC-Unicode-Normalisierung (NBSP → Space, ligierte Zeichen → einzeln)
 * - Smart-Quotes → gerade Quotes
 * - Em/En-Dashes → Hyphen
 * - Whitespace zusammenfassen + trim
 *
 * Wichtig: Der Original-Text wird NICHT verändert. Nur der Hash zum Lookup.
 * Beim Cache-Treffer wird die gefundene Übersetzung mit dem Original-Hash
 * neu eingefügt, damit weitere identische Treffer den schnellen Pfad nehmen.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[   ]/g, ' ')        // NBSP-Varianten → Space
    .replace(/[‘’‚‹›]/g, "'")  // Smart-Single-Quotes → '
    .replace(/[“”„«»]/g, '"')  // Smart-Double-Quotes → "
    .replace(/[–—−]/g, '-')        // En/Em-Dash, Minus → Hyphen
    .replace(/[…]/g, '...')                  // Horizontal Ellipsis → ...
    .replace(/\s+/g, ' ')                         // Mehrfach-Whitespace → Single Space
    .trim();
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function normalizedHash(text: string): string {
  return hashText(normalizeText(text));
}
