/**
 * Remediation: Segment-Cache-Eintraege invalidieren, in denen ein
 * `<script>`- oder `<style>`-Block beim Uebersetzen veraendert wurde
 * (typisch: Apostrophe zu `&#x27;` encodet → JS/CSS kaputt).
 *
 * Hintergrund (01.06.2026): DeepL HTML-Mode encodet Anfuehrungszeichen in
 * `<script>`/`<style>` defensiv zu `&#x27;`, obwohl die Tags in ignoreTags
 * stehen (ignoreTags schuetzt nur vor Uebersetzung, nicht vor Re-Encoding).
 * Der Fix schuetzt die Bloecke jetzt als opake Sentinels; dieser Cache muss
 * gezielt invalidiert werden.
 *
 * PRAEZISE: markiert nur Segmente, deren Quell-Codeblock NICHT verbatim in der
 * Uebersetzung vorkommt (= wurde veraendert).
 *
 * Aufruf:
 *   node dist/scripts/restale-code-blocks.js            # dry-run
 *   node dist/scripts/restale-code-blocks.js --apply     # markieren
 */

import { pool } from '../db/connection';

const CODE_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;

function codeBlocksAltered(source: string, translated: string | null): boolean {
  if (!translated) return false;
  const blocks = source.match(CODE_BLOCK_RE);
  if (!blocks) return false;
  return blocks.some((b) => !translated.includes(b));
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
      WHERE (source_text ILIKE '%<script%' OR source_text ILIKE '%<style%')
        AND translated_text IS NOT NULL`,
  );

  const affected = rows.rows.filter((r) => codeBlocksAltered(r.source_text, r.translated_text));
  const langs = [...new Set(affected.map((r) => r.target_lang))].sort();

  console.log(
    `[Remediation] ${rows.rows.length} Segmente mit <script>/<style> geprueft, ` +
      `${affected.length} mit veraendertem Codeblock (Sprachen: ${langs.join(', ') || '–'}) ` +
      `(${apply ? 'APPLY' : 'DRY-RUN'})`,
  );

  for (const r of affected.slice(0, 5)) {
    const enc = (r.translated_text || '').includes('&#x27;') ? ' [&#x27;-Encoding]' : '';
    console.log(`  ⚠ ${r.target_lang}: ${r.source_text.slice(0, 60).replace(/\s+/g, ' ')}…${enc}`);
  }

  if (apply && affected.length > 0) {
    const ids = affected.map((r) => r.id);
    const res = await pool.query(
      `UPDATE segments SET is_stale = TRUE, condensed_text = NULL WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    console.log(`[Remediation] ${res.rowCount} Segmente als stale markiert.`);
    console.log('[Remediation] Naechster Schritt: betroffene Dokumente neu hochladen → Code-Block-geschuetzte Neuuebersetzung.');
  } else if (!apply) {
    console.log('[Remediation] Dry-run — nichts geaendert. Mit --apply ausfuehren.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
