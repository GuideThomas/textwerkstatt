/**
 * Remediation: Segment-Cache-Einträge invalidieren, deren interne Links nicht
 * der Store-View-Regel entsprechen.
 *
 * Hintergrund (28.07.2026): Bis zu diesem Fix
 *   (a) lief der Store-View-Tausch NUR im Magento-Zellen-Pfad — bei HTML-/XML-
 *       Datei-Uploads blieb `/de/` in jedem `href` stehen, und
 *   (b) präfixierte die Injection JEDEN relativen `href`, also auch
 *       Ressourcen-Links (`/media/...`, `*.pdf`) → `/fr/media/...` = 404.
 *
 * Das Skript findet beide Klassen im Cache und markiert sie als stale, damit der
 * nächste Re-Upload neu übersetzt statt den falschen Cache zu treffen. Ohne
 * diesen Schritt bleibt der Fix für Bestandsdokumente unsichtbar — ein
 * Cache-Hit umgeht die Pipeline komplett.
 *
 * Aufruf:
 *   node dist/scripts/restale-storeview-links.js            # dry-run
 *   node dist/scripts/restale-storeview-links.js --apply     # markieren
 */

import { pool } from '../db/connection';
import { config } from '../config';
import {
  STOREVIEW_SEGMENTS,
  toStoreViewCode,
  isResourceUrl,
} from '../services/text/storeview';

/** Navigations-`href`s (nur `<a>`/`<area>`) mit ihrem URL-Wert. */
const NAV_HREF_RE =
  /<(?:a|area)\b[^>]*?\bhref\s*=\s*("|'|&quot;)(\/[^"'&\s>]*)\1/gi;

/**
 * Navigations-`href`s mit ABSOLUTER URL — für den Fall „eigener Shop-Host, aber
 * Quellsprachen-Store-View" (real beobachtet: IT-Segmente mit
 * `https://www.example.com/de/customer/account/create/`).
 */
const NAV_ABS_HREF_RE =
  /<(?:a|area)\b[^>]*?\bhref\s*=\s*("|'|&quot;)((?:https?:)?\/\/[^"'\s>]*)\1/gi;

/** Beliebiges `href`/`src` mit führendem Pfad — für die Ressourcen-Prüfung. */
const ANY_URL_RE =
  /\b(?:href|src|data-src)\s*=\s*("|'|&quot;)(\/[^"'&\s>]*)\1/gi;

type Reason = 'nicht-getauscht' | 'ressource-präfixiert';

interface Finding {
  id: string;
  target_lang: string;
  reason: Reason;
  sample: string;
}

/** Erstes Pfadsegment, wenn es eine Store-View ist. */
function leadingStoreView(url: string): string | null {
  const m = url.match(/^\/([a-zA-Z]{2})(?=$|[/?#])/);
  if (!m) return null;
  const seg = m[1].toLowerCase();
  return STOREVIEW_SEGMENTS.has(seg) ? seg : null;
}

/**
 * Prüft eine Übersetzung und liefert Grund + Beispiel-URL, oder `null` wenn die
 * Links in Ordnung sind. Beides in EINEM Durchlauf, damit das Beispiel garantiert
 * der Fund ist (und nicht nur der erste Link im Text).
 */
function inspect(
  targetLang: string,
  translated: string | null,
): { reason: Reason; sample: string } | null {
  if (!translated) return null;
  const expected = toStoreViewCode(targetLang);
  if (!expected) return null;

  // (a) Navigationslink mit FREMDER Store-View → wurde nie getauscht.
  for (const m of translated.matchAll(NAV_HREF_RE)) {
    const url = m[2];
    if (isResourceUrl(url)) continue;
    const seg = leadingStoreView(url);
    if (seg && seg !== expected) {
      return { reason: 'nicht-getauscht', sample: url.slice(0, 90) };
    }
  }

  // (a2) Absoluter Link auf einen eigenen Shop-Host mit fremder Store-View.
  for (const m of translated.matchAll(NAV_ABS_HREF_RE)) {
    const url = m[2];
    const parts = url.match(/^(?:https?:)?\/\/([^/?#]+)(\/[^?#]*)/i);
    if (!parts) continue;
    const host = parts[1].toLowerCase().split('@').pop()!.split(':')[0];
    if (!config.storeview.internalHosts.includes(host)) continue;
    const path = parts[2];
    if (isResourceUrl(path)) continue;
    const seg = leadingStoreView(path);
    if (seg && seg !== expected) {
      return { reason: 'nicht-getauscht', sample: url.slice(0, 90) };
    }
  }

  // (b) Ressourcen-URL mit Ziel-Store-View davor → wurde falsch präfixiert.
  for (const m of translated.matchAll(ANY_URL_RE)) {
    const url = m[2];
    const seg = leadingStoreView(url);
    if (seg !== expected) continue;
    const rest = url.slice(seg.length + 1);
    if (rest && isResourceUrl(rest)) {
      return { reason: 'ressource-präfixiert', sample: url.slice(0, 90) };
    }
  }

  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');

  // Nur Segmente, die überhaupt einen internen Link enthalten können.
  const rows = await pool.query<{
    id: string;
    target_lang: string;
    translated_text: string | null;
  }>(
    `SELECT id, target_lang, translated_text
       FROM segments
      WHERE translated_text IS NOT NULL
        AND translated_text LIKE '%href%'`,
  );

  const findings: Finding[] = [];
  for (const r of rows.rows) {
    const hit = inspect(r.target_lang, r.translated_text);
    if (!hit) continue;
    findings.push({
      id: r.id,
      target_lang: r.target_lang,
      reason: hit.reason,
      sample: hit.sample,
    });
  }

  const byReason = new Map<Reason, number>();
  const byLang = new Map<string, number>();
  for (const f of findings) {
    byReason.set(f.reason, (byReason.get(f.reason) || 0) + 1);
    byLang.set(f.target_lang, (byLang.get(f.target_lang) || 0) + 1);
  }

  console.log(
    `[Remediation] ${rows.rows.length} Segmente mit href geprüft, ${findings.length} betroffen ` +
      `(${apply ? 'APPLY' : 'DRY-RUN'})`,
  );
  for (const [reason, count] of byReason) console.log(`  ${reason}: ${count}`);
  if (byLang.size > 0) {
    console.log(
      `  Sprachen: ${[...byLang.entries()].map(([l, c]) => `${l}=${c}`).sort().join(', ')}`,
    );
  }
  for (const f of findings.slice(0, 8)) {
    console.log(`  ⚠ ${f.target_lang} [${f.reason}]: ${f.sample}`);
  }

  if (apply && findings.length > 0) {
    const res = await pool.query(
      `UPDATE segments SET is_stale = TRUE, condensed_text = NULL WHERE id = ANY($1::uuid[])`,
      [findings.map((f) => f.id)],
    );
    console.log(`[Remediation] ${res.rowCount} Segmente als stale markiert.`);
    console.log(
      '[Remediation] Nächster Schritt: betroffene Dokumente neu hochladen → Links werden neu gesetzt.',
    );
  } else if (!apply) {
    console.log('[Remediation] Dry-run — nichts geändert. Mit --apply ausführen.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
