/**
 * Remediation: Segment-Cache-Eintraege invalidieren, in denen die kompakte
 * Wert+Einheit-Schreibweise (`12W`, `CRI90`, `14,4W/m`) beim Uebersetzen
 * verloren ging (DeepL macht daraus `12 W`, `CRI 90`, EN sogar `5-meter`).
 *
 * Hintergrund (21.07.2026): Der Einheiten-Schutz (`unit-protection.ts`) ist neu.
 * Bereits gecachte Uebersetzungen wurden OHNE Schutz erzeugt; ohne Invalidierung
 * liefert der Cache sie weiter aus und der Fix bliebe wirkungslos
 * (siehe Memory `translationtool-segment-cache-stale-after-fix`).
 *
 * ANSATZ (bewusst enger als beim Pol-Fix): markiert nur Segmente, in denen ein
 * im Quelltext kompakt geschriebener Token in der Uebersetzung NICHT mehr
 * wortgleich vorkommt. Der Vergleich ist hier — anders als bei der Pol-Angabe —
 * verlaesslich, weil der Token verbatim erhalten bleiben MUSS: steht er drin,
 * ist das Segment nachweislich in Ordnung. Das spart DeepL-Zeichen gegenueber
 * einer pauschalen Neuuebersetzung aller Einheiten-Segmente.
 *
 * Manuell korrigierte Segmente (`edited_by_user`) werden NICHT angefasst — dort
 * wuerde eine Neuuebersetzung die Korrektur des Muttersprachlers verwerfen.
 * Sie werden als Hinweis ausgegeben, damit sie bei Bedarf manuell nachgezogen
 * werden koennen.
 *
 * Aufruf:
 *   node dist/scripts/restale-unit-segments.js             # dry-run
 *   node dist/scripts/restale-unit-segments.js --apply      # markieren
 */

import { pool } from '../db/connection';
import { protectUnits } from '../services/unit-protection';

/**
 * Tokens, die im Quelltext kompakt stehen, in der Uebersetzung aber fehlen.
 * Verglichen wird gegen die ZIELSPRACHEN-Form (restoreMap-Werte), damit ein
 * englisches Segment mit korrektem `3.5W` nicht faelschlich als Verlust zaehlt.
 */
function lostTokens(sourceText: string, translatedText: string, targetLang: string): string[] {
  const { restoreMap } = protectUnits(sourceText, targetLang);
  if (restoreMap.size === 0) return [];
  return [...new Set(restoreMap.values())].filter((tok) => !translatedText.includes(tok));
}

async function main() {
  const apply = process.argv.includes('--apply');

  const rows = await pool.query<{
    id: string;
    target_lang: string;
    source_text: string;
    translated_text: string;
    edited_by_user: boolean;
  }>(
    `SELECT id, target_lang, source_text, translated_text, COALESCE(edited_by_user, FALSE) AS edited_by_user
       FROM segments
      WHERE translated_text IS NOT NULL`,
  );

  const withLoss = rows.rows
    .map((r) => ({ ...r, lost: lostTokens(r.source_text, r.translated_text, r.target_lang) }))
    .filter((r) => r.lost.length > 0);

  const affected = withLoss.filter((r) => !r.edited_by_user);
  const edited = withLoss.filter((r) => r.edited_by_user);
  const langs = [...new Set(affected.map((r) => r.target_lang))].sort();

  console.log(
    `[Remediation] ${rows.rows.length} uebersetzte Segmente geprueft, ` +
      `${withLoss.length} mit verlorener Kompaktschreibweise ` +
      `(davon ${edited.length} manuell bearbeitet → uebersprungen) → ` +
      `${affected.length} zur Neuuebersetzung ` +
      `(Sprachen: ${langs.join(', ') || '–'}) (${apply ? 'APPLY' : 'DRY-RUN'})`,
  );

  for (const r of affected.slice(0, 8)) {
    console.log(
      `  • ${r.target_lang} [${r.lost.join(', ')}]: "${r.source_text.slice(0, 45)}" → "${r.translated_text.slice(0, 45)}"`,
    );
  }
  if (edited.length > 0) {
    console.log(`[Remediation] Manuell bearbeitete Segmente (bitte pruefen, NICHT automatisch geaendert):`);
    for (const r of edited.slice(0, 10)) {
      console.log(`  ! ${r.target_lang} [${r.lost.join(', ')}]: "${r.source_text.slice(0, 45)}"`);
    }
  }

  if (apply && affected.length > 0) {
    const ids = affected.map((r) => r.id);
    const res = await pool.query(
      `UPDATE segments SET is_stale = TRUE, condensed_text = NULL WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    console.log(`[Remediation] ${res.rowCount} Segmente als stale markiert.`);
    console.log(
      '[Remediation] Naechster Schritt: betroffene Exporte/Dokumente neu laufen lassen → Einheiten-geschuetzte Neuuebersetzung.',
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
