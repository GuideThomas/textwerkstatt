/**
 * Remediation: Segment-Cache-Eintraege invalidieren, in denen eine Magento-
 * Template-Direktive (`{{widget ...}}`, `{{media ...}}`, ...) beim Uebersetzen
 * veraendert wurde (z.B. `type="..."` → `tipo=&quot;...&quot;`).
 *
 * Hintergrund (01.06.2026): `protectMagentoDirectives()` lief bisher nur im
 * Magento-CSV-Zellen-Pfad. Im generischen HTML/Markup-Pfad (HTML-Datei-Upload)
 * waren `{{...}}`-Direktiven ungeschuetzt → DeepL hat Attribute uebersetzt und
 * `"` zu `&quot;` encodet. Der Fix schuetzt sie jetzt in allen Pfaden; dieser
 * Cache muss gezielt invalidiert werden, damit der naechste Re-Upload neu
 * uebersetzt (statt den kaputten Cache zu treffen).
 *
 * PRAEZISE: markiert nur Segmente, deren Quell-Direktive NICHT verbatim in der
 * Uebersetzung vorkommt (= wurde veraendert). Korrekt behandelte Direktiven
 * (CSV-Zellen-Pfad) bleiben unangetastet → keine unnoetige DeepL-Re-Kosten.
 *
 * Aufruf:
 *   node dist/scripts/restale-magento-directives.js            # dry-run
 *   node dist/scripts/restale-magento-directives.js --apply     # markieren
 */

import { pool } from '../db/connection';

const DIRECTIVE_RE = /\{\{[\s\S]*?\}\}/g;

function directivesAltered(source: string, translated: string | null): boolean {
  if (!translated) return false;
  const dirs = source.match(DIRECTIVE_RE);
  if (!dirs) return false;
  // Sobald EINE Quell-Direktive nicht 1:1 in der Uebersetzung steht → veraendert.
  return dirs.some((d) => !translated.includes(d));
}

async function main() {
  const apply = process.argv.includes('--apply');

  const rows = await pool.query<{
    id: string;
    target_lang: string;
    source_text: string;
    translated_text: string | null;
  }>(
    `SELECT id, target_lang, source_text, translated_text
       FROM segments
      WHERE source_text LIKE '%{{%' AND translated_text IS NOT NULL`,
  );

  const affected = rows.rows.filter((r) => directivesAltered(r.source_text, r.translated_text));
  const langs = [...new Set(affected.map((r) => r.target_lang))].sort();

  console.log(
    `[Remediation] ${rows.rows.length} Segmente mit {{-Direktiven geprueft, ` +
      `${affected.length} mit veraenderter Direktive (Sprachen: ${langs.join(', ') || '–'}) ` +
      `(${apply ? 'APPLY' : 'DRY-RUN'})`,
  );

  // Ein paar Beispiele zeigen
  for (const r of affected.slice(0, 5)) {
    const d = (r.source_text.match(DIRECTIVE_RE) || [])[0] || '';
    console.log(`  ⚠ ${r.target_lang}: ${d.slice(0, 90)}`);
  }

  if (apply && affected.length > 0) {
    const ids = affected.map((r) => r.id);
    const res = await pool.query(
      `UPDATE segments SET is_stale = TRUE, condensed_text = NULL WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    console.log(`[Remediation] ${res.rowCount} Segmente als stale markiert.`);
    console.log('[Remediation] Naechster Schritt: betroffene Dokumente neu hochladen → Direktiven-geschuetzte Neuuebersetzung.');
  } else if (!apply) {
    console.log('[Remediation] Dry-run — nichts geaendert. Mit --apply ausfuehren.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
