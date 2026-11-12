/**
 * Prüfhinweise zu Glossareinträgen (Auftrag Thomas, 04.11.2026).
 *
 * Ein Hinweis markiert einen Eintrag, der aus Sicht der Prüfung nicht optimal ist. Er liegt in
 * `glossary_hints` und wirkt nie: Nur die Glossar-Oberfläche liest ihn, und einen Vorschlag übernimmt
 * nur ein Klick über den normalen Speicherweg. Warum er nach einer Änderung von selbst verschwindet,
 * steht in `migrations/028_glossar_hinweise.sql`.
 *
 * 🚨 Von 14.020 Hinweisen (04.11.2026) sind 9.270 mechanische Schreibungs-Hinweise, und 11.523 von
 * 18.312 Einträgen tragen einen Hinweis. Sie würden die 1.738 falschen Einträge verdecken. Deshalb
 * blendet die Voreinstellung des Filters genau diese aus (`OHNE_SCHREIBFLUT`), in der Liste stehen sie
 * hinter allen anderen, und die Zahl am Glossar führt sie getrennt.
 *
 * Dasselbe gilt für die Kategorien „unnötig“ (Gegencheck gegen DeepL ohne Glossar, 04.11.2026): Rund
 * 12.000 Zeilen, die an der Übersetzung nichts ändern. Sie sagen nichts über die Qualität, darum zählen
 * sie nicht als Hinweis und haben einen eigenen Filterwert (`UNNOETIG`). Gelöscht wird dadurch nichts.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/connection';
import { normalizeGlossaryLang } from './lang';
import { holeDeeplVorschlag } from './glossar-pflege';
import { AKRONYM_KENNWERTE } from './unit-protection';

export const KATEGORIEN = [
  'falsch', 'sprachlich', 'schreibung', 'zeichen', 'satz',
  'wert', 'mehrdeutig', 'dublette', 'eigenname', 'unuebersetzt',
  'unnoetig_ueberall', 'unnoetig_hier',
] as const;
export const GEWISSHEITEN = ['hoch', 'mittel', 'niedrig'] as const;
/** `satztest`: DeepL nimmt unser Wort auch im Satz. */
export const QUELLEN = ['mechanisch', 'fachlich', 'satztest'] as const;
/** Filterwert: alle Hinweise außer den mechanischen zur Schreibung. */
export const OHNE_SCHREIBFLUT = 'ohne_schreibung';
/** Filterwert: beide Stufen von „unnötig“. */
export const UNNOETIG = 'unnoetig';
/** Für Abfragen mit dem Alias `h`. */
const SCHREIBFLUT = `(h.kategorie = 'schreibung' AND h.quelle = 'mechanisch')`;
const NUR_UNNOETIG = `(h.kategorie IN ('unnoetig_ueberall', 'unnoetig_hier'))`;
/** Was die Voreinstellung ausblendet und was nicht als Hinweis am Glossar zählt. */
const NEBENSACHE = `(${SCHREIBFLUT} OR ${NUR_UNNOETIG})`;

type Abfrage = Pick<PoolClient, 'query'>;

/** Bedingung „dieser Hinweis gilt für die Zeile `ge`“. Erledigte und verworfene passen nicht. */
export const HINWEIS_PASST = `h.glossary_id = ge.glossary_id
  AND h.source_term = ge.source_term
  AND h.target_term = ge.target_term
  AND h.verworfen_am IS NULL`;

/** Spalte `hinweise` für die Einträge-Liste. */
export const HINWEISE_ALS_JSON = `COALESCE(
  (SELECT jsonb_agg(jsonb_build_object(
            'id', h.id, 'kategorie', h.kategorie, 'gewissheit', h.gewissheit,
            'vorschlag', h.vorschlag, 'grund', h.grund, 'quelle', h.quelle
          ) ORDER BY h.kategorie)
     FROM glossary_hints h WHERE ${HINWEIS_PASST}),
  '[]'::jsonb
)`;

// Alles andere vor der mechanischen Schreibung, innerhalb davon die sicheren zuerst.
const RANG = `(CASE WHEN ${NEBENSACHE} THEN 10 ELSE 0 END
  + CASE h.gewissheit WHEN 'hoch' THEN 0 WHEN 'mittel' THEN 1 ELSE 2 END)`;

export interface HinweisFilter {
  /** Bedingung für die Einträge-Liste; ihre Parameter sind schon an `params` angehängt. */
  where: string;
  /** Sortierschlüssel, nur wenn nach Hinweisen gefiltert wird. */
  order: string;
}

/**
 * Baut den Filter aus den Abfrageparametern. `null`: Es wird nicht nach Hinweisen gefiltert.
 * Einen unbekannten Wert lehnt die Route ab: Er ergäbe sonst lautlos eine leere Liste.
 */
export function hinweisFilter(
  q: { nurMitHinweis: boolean; kategorie: string; gewissheit: string },
  params: unknown[],
): HinweisFilter | null {
  if (!q.nurMitHinweis && !q.kategorie && !q.gewissheit) return null;
  const teile = [HINWEIS_PASST];
  if (q.kategorie === OHNE_SCHREIBFLUT) {
    teile.push(`NOT ${NEBENSACHE}`);
  } else if (q.kategorie === UNNOETIG) {
    teile.push(NUR_UNNOETIG);
  } else if (q.kategorie) {
    params.push(q.kategorie);
    teile.push(`h.kategorie = $${params.length}`);
  }
  if (q.gewissheit) {
    params.push(q.gewissheit);
    teile.push(`h.gewissheit = $${params.length}`);
  }
  const bedingung = teile.join(' AND ');
  return {
    where: `EXISTS (SELECT 1 FROM glossary_hints h WHERE ${bedingung})`,
    order: `(SELECT min(${RANG}) FROM glossary_hints h WHERE ${bedingung}) ASC`,
  };
}

export function hinweisFilterGueltig(kategorie: string, gewissheit: string): boolean {
  const k = !kategorie || kategorie === OHNE_SCHREIBFLUT || kategorie === UNNOETIG || (KATEGORIEN as readonly string[]).includes(kategorie);
  const g = !gewissheit || (GEWISSHEITEN as readonly string[]).includes(gewissheit);
  return k && g;
}

export interface HinweisFacette {
  /** null: über alle Kategorien. */
  kategorie: string | null;
  /** null: über alle Gewissheiten. */
  gewissheit: string | null;
  zeilen: number;
  ohne_schreibflut: number;
}

/**
 * Zeilen mit Hinweis für die Zahlen im Filter, je Kombination einzeln gezählt: Eine Zeile mit zwei
 * Hinweisen zählt in jeder Kategorie, in der Summe aber nur einmal.
 */
export async function hinweisFacetten(glossaryId: string): Promise<HinweisFacette[]> {
  const f = await pool.query<HinweisFacette>(
    `SELECT h.kategorie, h.gewissheit,
            count(DISTINCT ge.id)::int AS zeilen,
            count(DISTINCT ge.id) FILTER (WHERE NOT ${NEBENSACHE})::int AS ohne_schreibflut
       FROM glossary_entries ge
       JOIN glossary_hints h ON ${HINWEIS_PASST}
      WHERE ge.glossary_id = $1
      GROUP BY GROUPING SETS ((h.kategorie, h.gewissheit), (h.kategorie), (h.gewissheit), ())`,
    [glossaryId],
  );
  return f.rows;
}

/** Spalten für die Glossarliste; der äußere Alias des Glossars ist `g`. */
export const HINWEIS_ZAHLEN = `
  (SELECT count(*) FROM glossary_entries ge WHERE ge.glossary_id = g.id
     AND EXISTS (SELECT 1 FROM glossary_hints h WHERE ${HINWEIS_PASST} AND NOT ${NEBENSACHE})) AS hinweise,
  (SELECT count(*) FROM glossary_entries ge WHERE ge.glossary_id = g.id
     AND EXISTS (SELECT 1 FROM glossary_hints h WHERE ${HINWEIS_PASST} AND ${SCHREIBFLUT})
     AND NOT EXISTS (SELECT 1 FROM glossary_hints h WHERE ${HINWEIS_PASST} AND NOT ${NEBENSACHE})) AS hinweise_schreibung,
  (SELECT count(*) FROM glossary_entries ge WHERE ge.glossary_id = g.id
     AND EXISTS (SELECT 1 FROM glossary_hints h WHERE ${HINWEIS_PASST} AND ${NUR_UNNOETIG})) AS unnoetig,
  (SELECT count(*) FROM glossary_entries ge WHERE ge.glossary_id = g.id
     AND EXISTS (SELECT 1 FROM glossary_hints h WHERE ${HINWEIS_PASST} AND h.kategorie = 'unnoetig_ueberall')) AS unnoetig_ueberall`;

/** Ein Mensch hält den Eintrag für richtig. Der Eintrag selbst bleibt unberührt. */
export async function hinweisVerwerfen(glossaryId: string, hinweisId: string, wer: string | null): Promise<boolean> {
  const r = await pool.query(
    `UPDATE glossary_hints SET verworfen_am = NOW(), verworfen_von = $3, updated_at = NOW()
      WHERE id = $1 AND glossary_id = $2 AND verworfen_am IS NULL`,
    [hinweisId, glossaryId, wer],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Ein Muttersprachler hat den Eintrag in genau diesem Stand bestätigt („OK“ auf dem Glossar-Blatt): Hinweise zu Begriff und Wert
 * fallen weg, der Eintrag bleibt. Läuft in der Transaktion des Aufrufers (`glossar-antworten.ts`). Steht hier, weil nur dieses
 * Modul die Hinweise anfasst (Bauprüfung in `scripts/glossar-pflege.test.mjs`).
 */
export async function hinweiseZumStandVerwerfen(c: PoolClient, glossaryId: string, begriff: string, wert: string, wer: string): Promise<number> {
  const r = await c.query(
    `UPDATE glossary_hints SET verworfen_am = NOW(), verworfen_von = $4, updated_at = NOW()
      WHERE glossary_id = $1 AND source_term = $2 AND target_term = $3 AND verworfen_am IS NULL`,
    [glossaryId, begriff, wert, wer],
  );
  return r.rowCount ?? 0;
}

export type DeeplVergleich = 'gleich' | 'nur_gross_klein' | 'nur_zeichen' | 'anders';

const normal = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
const ohneSchreibzeichen = (s: string) =>
  // Ein Zeichen zwischen Ziffern ist Teil des Werts: „1,5 m“ und „15 m“ sind nicht nur anders geschrieben.
  normal(s).toLocaleLowerCase().replace(/(\d)[.,](\d)/g, '$1#$2').replace(/[\s\-\u2010\u2011\u2013\u2014_.,;:'\u2019"\u201E\u201C\u201D()/]+/g, '');

/** Derselbe Vergleich wie im Gegencheck `scripts/glossar-deepl-gegencheck.js`. */
export function vergleicheMitDeepL(unser: string, vonDeepL: string): DeeplVergleich {
  const a = normal(unser);
  const b = normal(vonDeepL);
  if (a === b) return 'gleich';
  if (a.toLocaleLowerCase() === b.toLocaleLowerCase()) return 'nur_gross_klein';
  if (ohneSchreibzeichen(a) === ohneSchreibzeichen(b)) return 'nur_zeichen';
  return 'anders';
}

/**
 * Nach dem Befüllen einer Zeile (Entscheid Thomas 04.11.2026): Liefert DeepL ohne Glossar dasselbe, ist die
 * Zeile unnötig und wird wieder so markiert. Die Markierung wirkt nicht, die Übersetzung bleibt gespeichert.
 * Geprüft wird am einzelnen Wort, deshalb Stufe `unnoetig_hier`, Gewissheit `niedrig`, Quelle `mechanisch`. Ein Verwerfen
 * bleibt bestehen.
 */
export async function markiereFallsWieDeepL(
  p: { glossaryId: string; sourceTerm: string; targetTerm: string },
): Promise<'markiert' | 'anders' | 'uebersprungen'> {
  const g = await pool.query<{ source_lang: string; target_lang: string }>(
    `SELECT source_lang, target_lang FROM glossaries WHERE id = $1 AND source_lang = 'DE' AND target_lang <> 'DE'`,
    [p.glossaryId],
  );
  if (g.rows.length === 0 || AKRONYM_KENNWERTE.includes(p.sourceTerm)) return 'uebersprungen';
  const kanal = await pool.query(
    `SELECT 1 FROM glossary_entries e JOIN glossary_entry_channels k ON k.entry_id = e.id
      WHERE e.glossary_id = $1 AND e.source_term = $2 LIMIT 1`,
    [p.glossaryId, p.sourceTerm],
  );
  if (kanal.rows.length > 0) return 'uebersprungen';

  const v = await holeDeeplVorschlag({
    begriff: p.sourceTerm,
    sourceLang: g.rows[0].source_lang,
    targetLang: g.rows[0].target_lang,
    deeplGlossaryId: null,
  });
  if (v.status !== 'ok') return 'uebersprungen';
  const vergleich = vergleicheMitDeepL(p.targetTerm, v.vorschlag);
  if (vergleich === 'anders') return 'anders';

  const tag = new Date().toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Vienna' });
  const kern = vergleich === 'gleich'
    ? 'DeepL ohne Glossar liefert dasselbe'
    : `DeepL ohne Glossar liefert „${v.vorschlag}“, nur die Schreibung weicht ab`;
  await pool.query(
    `INSERT INTO glossary_hints (glossary_id, source_term, target_term, kategorie, gewissheit, quelle, grund)
     VALUES ($1, $2, $3, 'unnoetig_hier', $4, 'mechanisch', $5)
     ON CONFLICT (glossary_id, source_term, target_term, kategorie)
     DO UPDATE SET gewissheit = EXCLUDED.gewissheit, quelle = EXCLUDED.quelle, grund = EXCLUDED.grund, updated_at = NOW()`,
    [p.glossaryId, p.sourceTerm, p.targetTerm, 'niedrig',
      `${kern} (am einzelnen Wort geprüft, im Satz nicht, ${tag}). Der Eintrag kann weg, dann übersetzt DeepL frei.`],
  );
  return 'markiert';
}

export interface HinweisZeile {
  zeile: number;
  target_lang: string;
  source_term: string;
  target_term: string;
  kategorie: string;
  gewissheit: string;
  quelle: string;
  vorschlag: string | null;
  grund: string;
}

const SPALTEN = ['target_lang', 'source_term', 'target_term', 'kategorie', 'gewissheit', 'quelle', 'vorschlag', 'grund'];

/**
 * Liest die Prüfdatei: UTF-8, Tabulator als Trenner, erste Zeile die Spaltennamen, keine Anführungszeichen.
 * Sammelt alle Fehler statt beim ersten abzubrechen, damit die Datei in einem Durchgang zu reparieren ist.
 */
export function leseHinweisDatei(text: string): { zeilen: HinweisZeile[]; fehler: string[] } {
  const roh = text.replace(/^﻿/, '').split(/\r?\n/);
  const kopf = (roh[0] ?? '').split('\t').map((s) => s.trim());
  const fehlend = SPALTEN.filter((s) => !kopf.includes(s));
  if (fehlend.length > 0) return { zeilen: [], fehler: [`Spalten fehlen: ${fehlend.join(', ')}`] };

  const zeilen: HinweisZeile[] = [];
  const fehler: string[] = [];
  const gesehen = new Set<string>();
  roh.slice(1).forEach((inhalt, i) => {
    const nr = i + 2;
    if (inhalt.trim() === '') return;
    const felder = inhalt.split('\t');
    if (felder.length !== kopf.length) {
      fehler.push(`Zeile ${nr}: ${felder.length} statt ${kopf.length} Spalten`);
      return;
    }
    const roh1 = (name: string) => felder[kopf.indexOf(name)];
    const wert = (name: string) => roh1(name).trim();
    const z: HinweisZeile = {
      zeile: nr,
      target_lang: normalizeGlossaryLang(wert('target_lang')),
      // Wörtlich, auch mit unsichtbaren Zeichen: Die Zuordnung zum Eintrag ist exakt.
      source_term: roh1('source_term'),
      target_term: roh1('target_term'),
      kategorie: wert('kategorie'),
      gewissheit: wert('gewissheit'),
      quelle: wert('quelle'),
      vorschlag: wert('vorschlag') || null,
      grund: wert('grund'),
    };
    if (!z.target_lang || !z.source_term || !z.target_term) fehler.push(`Zeile ${nr}: Sprache, Begriff oder Übersetzung fehlt`);
    if (!(KATEGORIEN as readonly string[]).includes(z.kategorie)) fehler.push(`Zeile ${nr}: unbekannte Kategorie „${z.kategorie}“`);
    if (!(GEWISSHEITEN as readonly string[]).includes(z.gewissheit)) fehler.push(`Zeile ${nr}: unbekannte Gewissheit „${z.gewissheit}“`);
    if (!(QUELLEN as readonly string[]).includes(z.quelle)) fehler.push(`Zeile ${nr}: unbekannte Quelle „${z.quelle}“`);
    if (!z.grund) fehler.push(`Zeile ${nr}: Grund fehlt`);
    if (z.vorschlag === z.target_term) fehler.push(`Zeile ${nr}: Vorschlag ist gleich der Übersetzung`);
    const schluessel = [z.target_lang, z.source_term, z.target_term, z.kategorie].join('\t');
    if (gesehen.has(schluessel)) fehler.push(`Zeile ${nr}: zweiter Hinweis derselben Kategorie zum selben Eintrag`);
    gesehen.add(schluessel);
    zeilen.push(z);
  });
  return { zeilen, fehler };
}

export interface EinspielErgebnis {
  neu: number;
  aktualisiert: number;
  /** Ein Mensch hat „unnötig“ zu diesem Stand verworfen, auch in der anderen Stufe. Das bleibt. */
  bleibtVerworfen: number;
  ohneEintrag: HinweisZeile[];
  sprachenOhneGlossar: string[];
}

/** Schreibt die Hinweise. Ein neuer Stand der Prüfung ersetzt den Text, ein Verwerfen bleibt bestehen. */
export async function spieleHinweiseEin(c: Abfrage, zeilen: HinweisZeile[]): Promise<EinspielErgebnis> {
  const glossare = await c.query<{ id: string; target_lang: string; n: string }>(
    `SELECT id, target_lang, count(*) OVER (PARTITION BY target_lang) AS n
       FROM glossaries
      WHERE source_lang = 'DE' AND target_lang <> 'DE'`,
  );
  const jeSprache = new Map(glossare.rows.filter((g) => Number(g.n) === 1).map((g) => [g.target_lang, g.id]));
  const sprachen = [...new Set(zeilen.map((z) => z.target_lang))];
  const sprachenOhneGlossar = sprachen.filter((s) => !jeSprache.has(s));

  let neu = 0;
  let aktualisiert = 0;
  let bleibtVerworfen = 0;
  const ohneEintrag: HinweisZeile[] = [];
  for (const z of zeilen) {
    const glossaryId = jeSprache.get(z.target_lang);
    if (!glossaryId) continue;
    const eintrag = await c.query(
      `SELECT 1 FROM glossary_entries WHERE glossary_id = $1 AND source_term = $2 AND target_term = $3 LIMIT 1`,
      [glossaryId, z.source_term, z.target_term],
    );
    // Der Eintrag hat sich seit der Prüfung geändert: Der Hinweis gälte nicht mehr.
    if (eintrag.rows.length === 0) {
      ohneEintrag.push(z);
      continue;
    }
    if (z.kategorie.startsWith('unnoetig_')) {
      const verworfen = await c.query(
        `SELECT 1 FROM glossary_hints h
          WHERE h.glossary_id = $1 AND h.source_term = $2 AND h.target_term = $3 AND h.verworfen_am IS NOT NULL AND ${NUR_UNNOETIG}
          LIMIT 1`,
        [glossaryId, z.source_term, z.target_term],
      );
      if (verworfen.rows.length > 0) {
        bleibtVerworfen += 1;
        continue;
      }
    }
    const r = await c.query<{ neu: boolean }>(
      `INSERT INTO glossary_hints (glossary_id, source_term, target_term, kategorie, gewissheit, quelle, vorschlag, grund)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (glossary_id, source_term, target_term, kategorie)
       DO UPDATE SET gewissheit = EXCLUDED.gewissheit, quelle = EXCLUDED.quelle, vorschlag = EXCLUDED.vorschlag,
                     grund = EXCLUDED.grund, updated_at = NOW()
       RETURNING (xmax = 0) AS neu`,
      [glossaryId, z.source_term, z.target_term, z.kategorie, z.gewissheit, z.quelle, z.vorschlag, z.grund],
    );
    if (r.rows[0].neu) neu += 1;
    else aktualisiert += 1;
  }
  return { neu, aktualisiert, bleibtVerworfen, ohneEintrag, sprachenOhneGlossar };
}

/** Sprachen mit aktiver Markierung „unnötig“, die in der Datei gar nicht vorkommen. */
export async function sprachenOhneErsatz(c: Abfrage, behalten: HinweisZeile[]): Promise<string[]> {
  const r = await c.query<{ target_lang: string }>(
    `SELECT DISTINCT g.target_lang FROM glossary_hints h JOIN glossaries g ON g.id = h.glossary_id
      WHERE ${NUR_UNNOETIG} AND h.verworfen_am IS NULL`,
  );
  const inDatei = new Set(behalten.map((z) => z.target_lang));
  return r.rows.map((z) => z.target_lang).filter((s) => !inDatei.has(s));
}

/** Nach dem Entfernen: Die Markierung zu diesem Stand ist verbraucht. Sonst lebte sie auf, wenn jemand denselben Text wieder einträgt. */
export async function entferneMarkierungenDerZeile(glossaryId: string, sourceTerm: string, targetTerm: string): Promise<void> {
  await pool.query(
    `DELETE FROM glossary_hints h
      WHERE h.glossary_id = $1 AND h.source_term = $2 AND h.target_term = $3 AND h.verworfen_am IS NULL AND ${NUR_UNNOETIG}`,
    [glossaryId, sourceTerm, targetTerm],
  );
}

/**
 * Eine neue Prüfdatei ersetzt die maschinellen Markierungen „unnötig“: Was nicht mehr darin steht, ist widerlegt
 * und fällt weg. Ein Verwerfen durch einen Menschen bleibt stehen.
 */
export async function entferneWiderlegteUnnoetige(c: Abfrage, behalten: HinweisZeile[]): Promise<number> {
  const r = await c.query(
    `DELETE FROM glossary_hints h
      USING glossaries g
      WHERE g.id = h.glossary_id AND ${NUR_UNNOETIG} AND h.verworfen_am IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS d(sprache, begriff, ziel, kategorie)
           WHERE d.sprache = g.target_lang AND d.begriff = h.source_term AND d.ziel = h.target_term AND d.kategorie = h.kategorie)`,
    [behalten.map((z) => z.target_lang), behalten.map((z) => z.source_term), behalten.map((z) => z.target_term), behalten.map((z) => z.kategorie)],
  );
  return r.rowCount ?? 0;
}

export interface HinweisStand {
  aktiv: number;
  verworfen: number;
  /** Der Eintrag hat sich geändert oder ist weg. */
  erledigt: number;
  /** Fingerabdruck aller Einträge und Versionen: ändert sich beim Einspielen nicht. */
  eintraege: string;
  versionen: number;
  stale: number;
}

export async function hinweisStand(c: Abfrage): Promise<HinweisStand> {
  const r = await c.query<HinweisStand>(
    `SELECT
       (SELECT count(*)::int FROM glossary_hints hh WHERE hh.verworfen_am IS NULL AND EXISTS (
          SELECT 1 FROM glossary_entries ge
           WHERE ge.glossary_id = hh.glossary_id AND ge.source_term = hh.source_term AND ge.target_term = hh.target_term)) AS aktiv,
       (SELECT count(*)::int FROM glossary_hints WHERE verworfen_am IS NOT NULL) AS verworfen,
       (SELECT count(*)::int FROM glossary_hints hh WHERE hh.verworfen_am IS NULL AND NOT EXISTS (
          SELECT 1 FROM glossary_entries ge
           WHERE ge.glossary_id = hh.glossary_id AND ge.source_term = hh.source_term AND ge.target_term = hh.target_term)) AS erledigt,
       (SELECT md5(COALESCE(string_agg(e.id::text || '|' || e.source_term || '|' || COALESCE(e.target_term, '') || '|' || COALESCE(e.approved::text, ''), ',' ORDER BY e.id), ''))
          FROM glossary_entries e) AS eintraege,
       (SELECT COALESCE(sum(version), 0)::int FROM glossaries) AS versionen,
       (SELECT count(*)::int FROM segments WHERE is_stale = TRUE) AS stale`,
  );
  return r.rows[0];
}
