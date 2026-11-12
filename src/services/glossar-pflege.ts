/**
 * Glossar-Pflege: Im Glossar steht nur, was wir ausdrücklich anders wollen als DeepL (Entscheid Thomas 04.11.2026,
 * `PLAN-glossar-nur-abweichungen.md`). Die Glossare DE→X führen nicht mehr dieselben Begriffe.
 *
 *  - Löschen und Umbenennen gelten nur im eigenen Glossar. Die Rückfrage zeigt die Oberfläche, sie kennt Übersetzung
 *    und Channel-Werte der Zeile. Channel-Werte gehen beim Löschen mit, jeder steht im Verlauf.
 *  - Die Kennwerte der Schutzkette (`AKRONYM_KENNWERTE`) lassen sich nicht löschen, die Schutzkette liest sie aus dem Glossar.
 *  - „Eintrag entfernen“ an einer Markierung löscht die Zeile, ist aber strenger als das ×: Es gilt nur für den gezeigten
 *    Text und lässt Zeilen mit Channel-Wert stehen, weil die Markierung sie nicht betrachtet hat.
 *  - Der DeepL-Vorschlag: ein Aufruf je Klick, nichts wird gespeichert.
 *
 * Eine leere Zeile (`target_term IS NULL`) ist ein gültiger Zustand: Der Begriff wartet auf eine Übersetzung und wirkt bis dahin
 * nirgends, eine leere Zeile entwertet deshalb nichts. Solche Zeilen entstehen nur noch beim Anlegen eines Glossars DE→X, das die
 * Begriffe aus mindestens der Hälfte der anderen bekommt (Migration 031). Später trägt nichts mehr nach. Die alten aus dem
 * Nachtragen fallen in Phase 3 weg.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { translateBatch, type TranslationResult, type BatchTranslationOptions } from './deepl';
import { protectPoleCounts, restorePoleCounts } from './conductor-protection';
import { protectUnits, restoreUnits, fehlendeWerte, PLATZHALTER_REST, AKRONYM_KENNWERTE } from './unit-protection';
import { protectAcronymsWithGlossary, restoreAcronyms } from './acronym-protection';
import { nenneBearbeiter, type Bearbeiter } from '../db/bearbeiter';
import { config } from '../config';

/** Gemeinsam mit dem Trigger `glossar_leere_zeile_ersetzen` aus Migration 027, auch dort `711027`. */
const SPERRE = 711027;

const SCHLUESSEL_GLEICH = (spalte: string, param: string) => `lower(btrim(${spalte})) = lower(btrim(${param}))`;

export interface Konflikt {
  target_term_alt: string;
  target_term_neu: string;
}

export type { Bearbeiter };

type Abfrage = Pick<PoolClient, 'query'>;

/**
 * Eine Transaktion unter der Sperre der Glossarpflege, in der der Bearbeiter genannt ist. Den Verlauf schreibt der Trigger aus
 * Migration 037; bis 10.11.2026 schrieb ihn hier `verlauf()` von Hand, Feld für Feld.
 */
async function imVorgang<T>(wer: Bearbeiter, arbeit: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await nenneBearbeiter(client, wer);
    await client.query('SELECT pg_advisory_xact_lock($1)', [SPERRE]);
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Begriffe als ILIKE-Muster, Platzhalterzeichen des Begriffs maskiert. */
export function staleMuster(begriffe: string[]): string[] {
  const eindeutig = [...new Set(begriffe.map((b) => (b ?? '').trim()).filter((b) => b.length > 0))];
  return eindeutig.map((b) => `%${b.replace(/[\\%_]/g, '\\$&')}%`);
}

/**
 * Glossar-Version erhöhen und nur die Cache-Segmente als stale markieren, die einen geänderten
 * Begriff enthalten.
 *
 * 🚨 Bis 04.11.2026 traf jede Änderung das ganze Sprachpaar: 90 % des Cache standen auf stale, und am
 * 04.11. entwerteten zwei neue italienische Begriffe je 4.793 Zeilen, obwohl sie nur in 643 und in
 * 0 davon vorkommen. Jede entwertete Zeile geht beim nächsten Lauf erneut an DeepL und kann anders
 * ausfallen. Treffer mit ILIKE, also eher zu viel als zu wenig; ohne Begriff wird nichts markiert.
 */
export async function incrementGlossaryVersion(glossaryId: string, betroffeneBegriffe: string[], q: Abfrage = pool): Promise<void> {
  const result = await q.query(
    `UPDATE glossaries SET version = version + 1, updated_at = NOW() WHERE id = $1
     RETURNING source_lang, target_lang, version`,
    [glossaryId]
  );

  if (result.rows.length > 0) {
    const { source_lang, target_lang, version } = result.rows[0];

    // Segmente mit älterer Glossar-Version als stale markieren
    const staleResult = await q.query(
      `UPDATE segments SET is_stale = TRUE
       WHERE source_lang = $1 AND target_lang = $2
         AND glossary_version < $3
         AND translated_text IS NOT NULL
         AND source_text ILIKE ANY($4::text[])`,
      [source_lang, target_lang, version, staleMuster(betroffeneBegriffe)]
    );

    if (staleResult.rowCount && staleResult.rowCount > 0) {
      console.log(`[Glossary] Marked ${staleResult.rowCount} segments as stale (v${version})`);
    }
  }
}

export type GlossarAnlegenErgebnis =
  | { status: 'vorhanden'; glossary_id: string }
  | { status: 'neu'; glossar: Record<string, unknown>; vorbefuellt: number };

/**
 * Legt ein Glossar an, je Sprachpaar nur eines: Ein Lookup wüsste sonst nicht, welches gilt. Prüfung und Einfügen stehen unter
 * derselben Sperre; der Index aus Migration 032 fängt, was ein anderer Schreibweg ohne Sperre dazwischen anlegt, und fehlt, wenn der
 * Bestand eine Dublette führt. Die Sprachcodes kommen schon normalisiert (`CZ`). Das Befüllen erledigt der Trigger aus Migration 031.
 */
export async function legeGlossarAn(name: string, sourceLang: string, targetLang: string, wer: Bearbeiter): Promise<GlossarAnlegenErgebnis> {
  const vorhandenes = async (c: Abfrage): Promise<string | null> => {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM glossaries WHERE source_lang = $1 AND target_lang = $2 ORDER BY created_at, id LIMIT 1`,
      [sourceLang, targetLang],
    );
    return r.rows[0]?.id ?? null;
  };
  try {
    return await imVorgang<GlossarAnlegenErgebnis>(wer, async (c) => {
      const id = await vorhandenes(c);
      if (id) return { status: 'vorhanden', glossary_id: id };
      const neu = await c.query(
        `INSERT INTO glossaries (name, source_lang, target_lang) VALUES ($1, $2, $3) RETURNING *`,
        [name, sourceLang, targetLang],
      );
      const zeilen = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM glossary_entries WHERE glossary_id = $1`,
        [neu.rows[0].id],
      );
      return { status: 'neu', glossar: neu.rows[0], vorbefuellt: zeilen.rows[0].n };
    });
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code !== '23505' || e.constraint !== 'uq_glossaries_sprachpaar') throw err;
    return { status: 'vorhanden', glossary_id: (await vorhandenes(pool)) as string };
  }
}

/**
 * Legt einen Begriff in diesem Glossar an, in keinem anderen. Prüfung und Einfügen stehen unter derselben Sperre, sonst
 * ergäbe ein doppeltes Absenden zwei gefüllte Zeilen. Eine leere Zeile ersetzt der Trigger.
 */
export async function legeBegriffAn(
  glossaryId: string,
  e: { sourceTerm: string; targetTerm: string; context: string | null; category: string | null; quelle?: string },
  wer: Bearbeiter,
): Promise<{ status: 'vorhanden'; entry_id: string } | { status: 'neu'; zeile: Record<string, unknown> }> {
  return imVorgang(wer, async (c) => {
    const vorhanden = await c.query<{ id: string }>(
      `SELECT id FROM glossary_entries
        WHERE glossary_id = $1 AND ${SCHLUESSEL_GLEICH('source_term', '$2')} AND target_term IS NOT NULL
        LIMIT 1`,
      [glossaryId, e.sourceTerm],
    );
    if (vorhanden.rows.length > 0) return { status: 'vorhanden', entry_id: vorhanden.rows[0].id };

    const neu = await c.query(
      `INSERT INTO glossary_entries (glossary_id, source_term, target_term, context, category, approved, source)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6) RETURNING *`,
      [glossaryId, e.sourceTerm, e.targetTerm, e.context, e.category, e.quelle ?? 'manual'],
    );
    await incrementGlossaryVersion(glossaryId, [e.sourceTerm], c);
    return { status: 'neu', zeile: neu.rows[0] };
  });
}

export type EntfernenErgebnis =
  | { status: 'channel' }
  | { status: 'schutzkette' }
  | { status: 'veraltet' }
  | { status: 'entfernt'; begriff: string; alt: string };

/**
 * Eintrag entfernen an einer Markierung „unnötig“: Die Zeile fällt weg, hier übersetzt künftig DeepL frei.
 *
 * Zeilen mit Channel-Wert bleiben stehen: Die Markierung hat nur den Standard betrachtet, die Channel-Werte fielen sonst
 * ungesehen mit weg. Das × dagegen zeigt sie in der Rückfrage. Die Kennwerte der Schutzkette ebenso, sie liest
 * `AKRONYM_KENNWERTE` aus dem Glossar. Entfernt wird nur der gezeigte Text (`stand`): Zwischen Anzeige und Klick kann
 * jemand ihn geändert haben.
 */
export async function entferneEintrag(glossaryId: string, entryId: string, stand: string | null, wer: Bearbeiter): Promise<EntfernenErgebnis | null> {
  return imVorgang(wer, async (c) => {
    const r = await c.query<{ source_term: string; target_term: string | null; hat_channel: boolean }>(
      `SELECT e.source_term, e.target_term,
              EXISTS (SELECT 1 FROM glossary_entry_channels k WHERE k.entry_id = e.id) AS hat_channel
         FROM glossary_entries e
        WHERE e.id = $1 AND e.glossary_id = $2
        FOR UPDATE OF e`,
      [entryId, glossaryId],
    );
    if (r.rows.length === 0) return null;
    const z = r.rows[0];
    if (z.hat_channel) return { status: 'channel' };
    if (AKRONYM_KENNWERTE.includes(z.source_term)) return { status: 'schutzkette' };
    // Eine leere Zeile hat keinen gezeigten Text, also auch keinen, der noch gelten könnte. Sie entfernt das ×.
    if (z.target_term === null || z.target_term !== stand) return { status: 'veraltet' };

    await c.query(`DELETE FROM glossary_entries WHERE id = $1`, [entryId]);
    await incrementGlossaryVersion(glossaryId, [z.source_term], c);
    return { status: 'entfernt', begriff: z.source_term, alt: z.target_term };
  });
}

export type LoeschenErgebnis = { status: 'schutzkette' } | { status: 'geloescht' };

/**
 * Das ×: Löscht diese eine Zeile samt Channel-Werten, in keinem anderen Glossar etwas. Bei einer Dublette bleibt die andere
 * Zeile stehen. Eine leere Zeile darf weg, auch zu einem Kennwert: Sie schützt nichts und wirkt nicht.
 */
export async function loescheZeile(glossaryId: string, entryId: string, wer: Bearbeiter): Promise<LoeschenErgebnis | null> {
  return imVorgang(wer, async (c) => {
    const r = await c.query<{ source_term: string; target_term: string | null }>(
      `SELECT e.source_term, e.target_term
         FROM glossary_entries e
        WHERE e.id = $1 AND e.glossary_id = $2
        FOR UPDATE OF e`,
      [entryId, glossaryId],
    );
    if (r.rows.length === 0) return null;
    const z = r.rows[0];
    if (z.target_term !== null && AKRONYM_KENNWERTE.includes(z.source_term)) return { status: 'schutzkette' };

    // Ziel, Channel-Werte und Gruppenziele vermerkt der Trigger vor dem Löschen einzeln (Migration 037).
    await c.query(`DELETE FROM glossary_entries WHERE id = $1`, [entryId]);
    // Eine leere Zeile war nie aktiv und entwertet nichts. In derselben Transaktion: Schlüge es danach fehl, wäre gelöscht,
    // die Version stiege nie, und das DeepL-Glossar gälte weiter als aktuell.
    if (z.target_term !== null) await incrementGlossaryVersion(glossaryId, [z.source_term], c);
    return { status: 'geloescht' };
  });
}

export type UmbenennenErgebnis =
  | { status: 'konflikt'; konflikte: Konflikt[] }
  /** Bei `GLOSSAR_FREIGABE=alle` fiele dabei eine Seed-Zeile weg, und ein Nicht-Admin darf keine löschen (E4). */
  | { status: 'geschuetzt' }
  | { status: 'umbenannt'; umbenannt: number };

/**
 * Benennt diese eine Zeile um, nur in diesem Glossar; Übersetzung und Channel-Werte bleiben an der Zeile.
 *
 * Steht der neue Begriff im Glossar schon mit einer Übersetzung, wird nicht umbenannt, denn das wäre eine neue Dublette mit
 * womöglich widersprüchlichem Ziel. Das entscheidet ein Mensch. Ändert sich nur die Schreibweise, entsteht keine neue
 * Dublette, auch wenn eine zweite Zeile zum Begriff schon besteht. Leere Zeilen fallen dabei weg, sie tragen nichts.
 */
export async function benenneBegriffUm(
  glossaryId: string,
  entryId: string,
  neu: string,
  wer: Bearbeiter,
): Promise<UmbenennenErgebnis | null> {
  return imVorgang(wer, async (c) => {
    const r = await c.query<{ source_term: string; target_term: string | null; nur_schreibweise: boolean }>(
      `SELECT source_term, target_term, ${SCHLUESSEL_GLEICH('source_term', '$3')} AS nur_schreibweise
         FROM glossary_entries WHERE id = $1 AND glossary_id = $2 FOR UPDATE`,
      [entryId, glossaryId, neu],
    );
    if (r.rows.length === 0) return null;
    const z = r.rows[0];

    const andere = (await c.query<{ id: string; target_term: string | null }>(
      `SELECT id, target_term FROM glossary_entries
        WHERE glossary_id = $1 AND id <> $2 AND ${SCHLUESSEL_GLEICH('source_term', '$3')}
        ORDER BY created_at, id FOR UPDATE`,
      [glossaryId, entryId, neu],
    )).rows;
    const gefuellt = andere.filter((a) => a.target_term !== null);

    if (z.target_term !== null && gefuellt.length > 0 && !z.nur_schreibweise) {
      return {
        status: 'konflikt',
        konflikte: gefuellt.map((a) => ({ target_term_alt: z.target_term as string, target_term_neu: a.target_term as string })),
      };
    }

    // Erst löschen: Eine zweite leere Zeile zum selben Begriff verbietet der Index.
    const leere = andere.filter((a) => a.target_term === null).map((a) => a.id);
    if (z.target_term === null && gefuellt.length > 0) leere.push(entryId);
    // Auch Umbenennen löscht (leere Zeilen). Bei `GLOSSAR_FREIGABE=alle` gilt dafür dieselbe Schranke wie fürs Löschen
    // (`middleware/glossar-recht.ts`): ein Nicht-Admin nur Zeilen, die eine Person angelegt hat. Die Rolle kommt aus der Datenbank,
    // so gilt es für die Route und für die Freigabe eines Vorschlags gleich.
    if (leere.length > 0 && config.glossarFreigabe === 'alle') {
      const admin = wer.id
        ? (await c.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [wer.id])).rows[0]?.role === 'admin'
        : false;
      if (!admin) {
        const seed = await c.query(`SELECT 1 FROM glossary_entries WHERE id = ANY($1::uuid[]) AND angelegt_von IS NULL LIMIT 1`, [leere]);
        if ((seed.rowCount ?? 0) > 0) return { status: 'geschuetzt' };
      }
    }
    await c.query(`DELETE FROM glossary_entries WHERE id = ANY($1::uuid[])`, [leere]);
    if (leere.includes(entryId)) return { status: 'umbenannt', umbenannt: 0 };

    await c.query(`UPDATE glossary_entries SET source_term = $2 WHERE id = $1`, [entryId, neu]);
    if (z.target_term !== null) await incrementGlossaryVersion(glossaryId, [z.source_term, neu], c);
    return { status: 'umbenannt', umbenannt: 1 };
  });
}

export type VorschlagErgebnis =
  | { status: 'ok'; vorschlag: string }
  /** Ein geschützter Wert fehlt danach. Ohne Schutz nachzufragen wäre ein zweiter Aufruf je Klick. */
  | { status: 'wert_verloren'; fehlend: string[] }
  | { status: 'leer' };

type Uebersetzer = (texte: string[], o: BatchTranslationOptions) => Promise<TranslationResult[]>;

/**
 * Holt einen Vorschlag von DeepL für einen einzelnen Begriff. Schreibt nichts.
 *
 * Dieselbe Schutzkette wie in `batch-translate.ts`, sonst schlüge DeepL hier etwas vor, das im
 * echten Lauf anders ausfiele. Das Glossar geht nur mit, wenn es bei DeepL schon liegt: Wer Zeile
 * für Zeile bestätigt, erhöht jedes Mal die Version, und ein Sync je Klick lüde das ganze Glossar neu.
 *
 * `kontext` geht als DeepL-`context` mit: Er lenkt die Wortwahl, wird nicht übersetzt und nicht berechnet. Ohne ihn liest DeepL
 * ein einzelnes Wort in seiner häufigsten Bedeutung, so entstanden `rund → aproximadamente` (ES), `Rolle → úloha` (SK) und
 * `Cover → Obálka` (CZ). Der Kontext ist ungeschützter Klartext; Platzhalter braucht er nicht, weil nichts aus ihm zurückkommt.
 */
export async function holeDeeplVorschlag(
  p: { begriff: string; sourceLang: string; targetLang: string; deeplGlossaryId: string | null; kontext?: string | null },
  uebersetze: Uebersetzer = translateBatch,
): Promise<VorschlagErgebnis> {
  const akronyme = await pool.query<{ source_term: string; target_term: string }>(
    `SELECT e.source_term, e.target_term
       FROM glossar_an_deepl e JOIN glossaries g ON g.id = e.glossary_id
      WHERE g.source_lang = $1 AND g.target_lang = $2
        AND e.source_term = ANY($3::text[]) AND e.source_term <> e.target_term`,
    [p.sourceLang, p.targetLang, AKRONYM_KENNWERTE],
  );
  const akronym = protectAcronymsWithGlossary(p.begriff, akronyme.rows);
  const pol = protectPoleCounts(akronym.protectedText, p.targetLang);
  const einheit = protectUnits(pol.protectedText, p.targetLang);

  const [antwort] = await uebersetze([einheit.protectedText], {
    sourceLang: p.sourceLang,
    targetLang: p.targetLang,
    glossaryId: p.deeplGlossaryId ?? undefined,
    context: p.kontext?.trim() || undefined,
  });

  const text = restoreAcronyms(
    restorePoleCounts(restoreUnits(antwort?.translatedText ?? '', einheit.restoreMap), pol.restoreMap),
    akronym.restoreMap,
  ).trim();

  const fehlend = [
    ...fehlendeWerte(text, einheit.restoreMap),
    ...fehlendeWerte(text, pol.restoreMap),
    ...fehlendeWerte(text, akronym.restoreMap),
  ];
  if (fehlend.length > 0 || PLATZHALTER_REST.test(text)) return { status: 'wert_verloren', fehlend };
  if (text === '') return { status: 'leer' };
  return { status: 'ok', vorschlag: text };
}
