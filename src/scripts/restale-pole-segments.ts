/**
 * Remediation: Segment-Cache-Eintraege invalidieren, in denen eine Pol-/
 * Litzenzahl-Angabe (`4-polig`, `2-pol.`, ...) beim Uebersetzen verloren ging.
 *
 * Hintergrund (18.06.2026): Der Pol-/Litzenzahl-Schutz (`conductor-protection.ts`)
 * ist neu. Bereits gecachte Uebersetzungen (v.a. SAP-ItemNames via
 * /api/batch-translate) wurden OHNE Schutz erzeugt — DeepL hat die Litzenanzahl
 * teils verschluckt. Diese Eintraege muessen stale markiert werden, damit der
 * naechste Re-Run sie mit der neuen, geschuetzten Logik neu uebersetzt (sonst
 * Stale-Cache-Treffer, siehe Memory `translationtool-segment-cache-stale-after-fix`).
 *
 * ANSATZ: markiert ALLE Segmente, deren Quelltext eine echte Pol-Angabe enthaelt
 * (`hasPolePattern`). Bewusst NICHT nur die heuristisch als "verschluckt"
 * erkannten — die Erkennung "Zahl korrekt an Pol-Wort gebunden" ist unzuverlaessig
 * (Vorfall 18.06.2026: SK `3-polig` → `pólová`, Zahl weg, Wortstamm aber present →
 * Heuristik gibt False-OK). Bei der geringen Segmentzahl (Artikelnamen) ist eine
 * deterministische Neuuebersetzung aller Pol-Segmente die robuste Wahl;
 * korrekt gecachte Eintraege werden lediglich identisch neu erzeugt.
 *
 * Aufruf:
 *   node dist/scripts/restale-pole-segments.js            # dry-run
 *   node dist/scripts/restale-pole-segments.js --apply     # markieren
 */

import { pool } from '../db/connection';
import { hasPolePattern } from '../services/conductor-protection';

async function main() {
  const apply = process.argv.includes('--apply');

  // Kandidaten grob per LIKE vorfiltern (Index-schonend), dann praezise per Regex.
  const rows = await pool.query<{
    id: string;
    target_lang: string;
    source_text: string;
    translated_text: string | null;
  }>(
    `SELECT id, target_lang, source_text, translated_text
       FROM segments
      WHERE source_text ILIKE '%pol%' AND translated_text IS NOT NULL`,
  );

  const affected = rows.rows.filter((r) => hasPolePattern(r.source_text));
  const langs = [...new Set(affected.map((r) => r.target_lang))].sort();

  console.log(
    `[Remediation] ${rows.rows.length} Segmente mit "pol" geprueft, ` +
      `${affected.length} mit echter Pol-Angabe → Neuuebersetzung ` +
      `(Sprachen: ${langs.join(', ') || '–'}) (${apply ? 'APPLY' : 'DRY-RUN'})`,
  );

  for (const r of affected.slice(0, 8)) {
    console.log(
      `  • ${r.target_lang}: "${r.source_text.slice(0, 55)}" → "${(r.translated_text || '').slice(0, 55)}"`,
    );
  }

  if (apply && affected.length > 0) {
    const ids = affected.map((r) => r.id);
    const res = await pool.query(
      `UPDATE segments SET is_stale = TRUE, condensed_text = NULL WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    console.log(`[Remediation] ${res.rowCount} Segmente als stale markiert.`);
    console.log(
      '[Remediation] Naechster Schritt: betroffene Exporte/Dokumente neu laufen lassen → Pol-geschuetzte Neuuebersetzung.',
    );
  } else if (!apply) {
    console.log('[Remediation] Dry-run — nichts geaendert. Mit --apply ausfuehren.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
