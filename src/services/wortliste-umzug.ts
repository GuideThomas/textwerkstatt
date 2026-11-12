/**
 * Zieht die Namensbausteine einer Sprache ins Glossar um: die Wortliste je Sprache (Plan `PLAN-wortliste.md` §4, Cockpit #1831).
 *
 * Läuft in der Transaktion des Aufrufers (`src/scripts/wortliste-zusammenfuehren.ts`), schreibt also nur, wenn der committet. Je
 * Sprache, in dieser Reihenfolge:
 *
 *   1. Exakte Dubletten im Glossar zusammenlegen (gleiches Ziel, gleiche Freigabe; Channel-Werte gehen zur bleibenden Zeile). Weicht
 *      etwas ab, hält es an: Das entscheidet ein Mensch.
 *   2. Jeder freigegebene Baustein findet seine Zeile nach exakter Schreibung:
 *        gleiches Ziel        die Zeile bekommt Art, Wortart, Genus, Formen, Merkmalsklasse; `an_deepl` bleibt
 *        anderes Ziel         nur mit Entscheid (Datei der Sprache, Thomas 10.11.2026 für EN), sonst Halt
 *        keine Zeile          neue freigegebene Zeile mit `an_deepl = FALSE`: Für den Fließtext brauchte sie bisher niemand
 *        mit Produktgruppe    Gruppenziel an der allgemeinen Zeile; fehlt die, Halt
 *   3. Offene Vorschläge werden offene Zeilen mit `wortliste_vorschlag`, abgelehnte stehen in `wortliste_abgelehnt`.
 *   4. Herkunft je Zeile (`wortliste_herkunft`), Einleseprotokoll mit `entry_id`, Umzug vermerkt (`wortliste_umzug`), danach nimmt
 *      die alte Tabelle für diese Sprache nichts mehr an (Migration 038).
 *
 * Gezählt und gegengeprüft, ohne dass ein Fehler still durchgeht: jeder Baustein in `wortliste_freigegeben` mit dem erwarteten Ziel;
 * an DeepL ändert sich genau, was ein Entscheid ändert; die Fassung der Sprache steigt um genau eins.
 *
 * Den Verlauf schreibt der Trigger aus Migration 037 unter dem Namen des Laufs, die Fassung zählt Migration 038.
 */
import type { PoolClient } from 'pg';
import { nenneBearbeiter } from '../db/bearbeiter';
import { incrementGlossaryVersion } from './glossar-pflege';

export const UMZUG_SPRACHEN = ['EN', 'FR', 'IT', 'HU', 'SK', 'PL', 'ES', 'CZ'] as const;
export const UMZUG_NAME = 'Zusammenführung Wortliste';

export interface Entscheid {
  deutsch: string;
  ziel: string;
  zielName: string | null;
  art: string | null;
  quelle: string;
}

/** Liest eine Entscheiddatei (`wortliste/entscheide-<SPRACHE>.tsv`): Kopfzeile, Tabulator, `#` am Zeilenanfang ist Kommentar. */
export function leseEntscheide(text: string): Entscheid[] {
  const zeilen = text.replace(/^﻿/u, '').split(/\r?\n/u).filter((z) => z.trim() !== '' && !z.startsWith('#'));
  if (zeilen.length === 0) return [];
  const kopf = zeilen[0].split('\t').map((s) => s.trim());
  const spalte = (n: string) => {
    const i = kopf.indexOf(n);
    if (i < 0) throw new Error(`Entscheiddatei: Spalte „${n}“ fehlt`);
    return i;
  };
  const [d, z, zn, a, q] = ['deutsch', 'ziel', 'ziel_name', 'art', 'quelle'].map(spalte);
  const gesehen = new Set<string>();
  return zeilen.slice(1).map((zeile, i) => {
    const t = zeile.split('\t');
    if (t.length !== kopf.length) throw new Error(`Entscheiddatei Zeile ${i + 2}: ${t.length} Spalten, erwartet ${kopf.length}`);
    const deutsch = t[d].trim();
    const ziel = t[z].trim();
    if (!deutsch || !ziel) throw new Error(`Entscheiddatei Zeile ${i + 2}: deutsch und ziel sind Pflicht`);
    if (gesehen.has(deutsch)) throw new Error(`Entscheiddatei Zeile ${i + 2}: „${deutsch}“ doppelt`);
    gesehen.add(deutsch);
    const art = t[a].trim() || null;
    if (art && !['wort', 'muster', 'wendung', 'fest'].includes(art)) throw new Error(`Entscheiddatei Zeile ${i + 2}: Art „${art}“ unbekannt`);
    return { deutsch, ziel, zielName: t[zn].trim() || null, art, quelle: t[q].trim() || 'thomas' };
  });
}

export interface UmzugBericht {
  sprache: string;
  glossarVorher: number;
  glossarNachher: number;
  dublettenEntfernt: number;
  /** Neu angelegte Zeilen: Bausteine ohne Glossarzeile und offene Vorschläge ohne Zeile. */
  eingefuegt: number;
  bausteine: { gesamt: number; schonUmgezogen: number; gleich: number; entschieden: number; neu: number; gruppe: number };
  vorlaeufig: { offen: number; abgelehnt: number; schonInDerListe: number };
  entscheideUngenutzt: string[];
  deepl: { vorher: number; nachher: number; geaendert: string[] };
  fassungVorher: number;
  fassungNachher: number;
  abweichungen: string[];
}

interface Baustein {
  id: string;
  art: string;
  deutsch: string;
  ziel: string;
  produktgruppe: number | null;
  wortart: string | null;
  genus: string | null;
  formen: Record<string, string> | null;
  merkmalsklasse: string | null;
  quelle: string;
}

interface Zeile {
  id: string;
  source_term: string;
  target_term: string | null;
  approved: boolean | null;
  art: string;
  an_deepl: boolean;
  wortart: string | null;
  genus: string | null;
  formen: Record<string, string> | null;
  merkmalsklasse: string | null;
  ziel_name: string | null;
}

const jsonOderNull = (x: unknown) => (x === null || x === undefined ? null : JSON.stringify(x));

async function anDeepL(c: PoolClient, glossaryId: string): Promise<Map<string, string>> {
  const r = await c.query<{ source_term: string; target_term: string }>(
    `SELECT source_term, target_term FROM glossar_an_deepl WHERE glossary_id = $1`, [glossaryId]);
  return new Map(r.rows.map((x) => [x.source_term, x.target_term]));
}

async function fassung(c: PoolClient, sprache: string): Promise<number> {
  return (await c.query<{ n: number }>(
    `SELECT COALESCE(max(nummer), 0)::int AS n FROM namens_bausteine_fassung WHERE sprache = $1`, [sprache])).rows[0].n;
}

/** Legt die exakten Dubletten eines Glossars zusammen. Liefert die Zahl entfernter Zeilen; Abweichungen kommen in `abw`. */
async function legeDublettenZusammen(c: PoolClient, glossaryId: string, abw: string[]): Promise<number> {
  const gruppen = await c.query<{ k: string; ids: string[] }>(
    `SELECT btrim(source_term) AS k, array_agg(id ORDER BY created_at, id) AS ids
       FROM glossary_entries WHERE glossary_id = $1 GROUP BY btrim(source_term) HAVING count(*) > 1`, [glossaryId]);
  let entfernt = 0;
  for (const g of gruppen.rows) {
    const z = (await c.query<{ id: string; target_term: string | null; approved: boolean | null }>(
      `SELECT id, target_term, approved FROM glossary_entries WHERE id = ANY($1::uuid[]) FOR UPDATE`, [g.ids])).rows;
    const bleibt = z.find((x) => x.id === g.ids[0])!;
    const andere = z.filter((x) => x.id !== bleibt.id);
    if (andere.some((x) => x.target_term !== bleibt.target_term || x.approved !== bleibt.approved)) {
      abw.push(`Dublette „${g.k}“: verschiedene Ziele oder Freigaben, das entscheidet ein Mensch`);
      continue;
    }
    for (const o of andere) {
      const k = await c.query<{ channel_code: string; target_term: string; bleibt: string | null }>(
        `SELECT o.channel_code, o.target_term, b.target_term AS bleibt
           FROM glossary_entry_channels o
           LEFT JOIN glossary_entry_channels b ON b.entry_id = $2 AND b.channel_code = o.channel_code
          WHERE o.entry_id = $1`, [o.id, bleibt.id]);
      if (k.rows.some((x) => x.bleibt !== null && x.bleibt !== x.target_term)) {
        abw.push(`Dublette „${g.k}“: Channel-Werte widersprechen sich`);
        continue;
      }
      for (const x of k.rows.filter((y) => y.bleibt === null)) {
        await c.query(`UPDATE glossary_entry_channels SET entry_id = $2 WHERE entry_id = $1 AND channel_code = $3`, [o.id, bleibt.id, x.channel_code]);
      }
      await c.query(`UPDATE terminology_candidates SET glossary_entry_id = $2 WHERE glossary_entry_id = $1`, [o.id, bleibt.id]);
      await c.query(`DELETE FROM glossary_entries WHERE id = $1`, [o.id]);
      entfernt += 1;
    }
  }
  return entfernt;
}

/**
 * Führt eine Sprache zusammen. `wer` steht im Verlauf und in der Fassung (`Zusammenführung Wortliste: <wer>`). Mit Abweichungen
 * kommt der Bericht zurück; der Aufrufer rollt dann zurück.
 */
export async function fuehreSpracheZusammen(c: PoolClient, sprache: string, entscheide: Entscheid[], wer: string): Promise<UmzugBericht> {
  if (!(UMZUG_SPRACHEN as readonly string[]).includes(sprache)) throw new Error(`Sprache ${sprache} gibt es für Namen nicht`);
  if (!wer.trim()) throw new Error('Wer zusammenführt, muss genannt sein');
  const name = `${UMZUG_NAME}: ${wer.trim()}`;
  await nenneBearbeiter(c, { id: null, name });

  const g = await c.query<{ id: string }>(
    `SELECT id FROM glossaries WHERE source_lang = 'DE' AND target_lang = $1 FOR UPDATE`, [sprache]);
  if (g.rows.length !== 1) throw new Error(`Glossar DE→${sprache}: ${g.rows.length} gefunden, erwartet genau eines`);
  const glossaryId = g.rows[0].id;

  const abw: string[] = [];
  const zaehle = async () => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM glossary_entries WHERE glossary_id = $1`, [glossaryId])).rows[0].n;
  const bericht: UmzugBericht = {
    sprache, glossarVorher: await zaehle(), glossarNachher: 0, dublettenEntfernt: 0, eingefuegt: 0,
    bausteine: { gesamt: 0, schonUmgezogen: 0, gleich: 0, entschieden: 0, neu: 0, gruppe: 0 },
    vorlaeufig: { offen: 0, abgelehnt: 0, schonInDerListe: 0 },
    entscheideUngenutzt: [], deepl: { vorher: 0, nachher: 0, geaendert: [] },
    fassungVorher: await fassung(c, sprache), fassungNachher: 0, abweichungen: abw,
  };
  const deeplVorher = await anDeepL(c, glossaryId);
  bericht.deepl.vorher = deeplVorher.size;

  // Die Umstellung der Quelle zählt selbst als Fassung: Ab jetzt kennt `bildeName` die Glossarwörter dieser Sprache, auch wenn
  // sonst nichts zu tun ist. Ein zweiter Lauf ohne Neues zieht keine.
  const schonUmgestellt = (await c.query(`SELECT 1 FROM namens_bausteine_fassung WHERE sprache = $1 AND von LIKE $2 LIMIT 1`,
    [sprache, `${UMZUG_NAME}%`])).rows.length > 0;

  bericht.dublettenEntfernt = await legeDublettenZusammen(c, glossaryId, abw);

  const entscheid = new Map(entscheide.map((e) => [e.deutsch, e]));
  const genutzt = new Set<string>();
  const zeileZu = async (deutsch: string): Promise<Zeile | undefined> => (await c.query<Zeile>(
    `SELECT id, source_term, target_term, approved, art, an_deepl, wortart, genus, formen, merkmalsklasse, ziel_name
       FROM glossary_entries WHERE glossary_id = $1 AND btrim(source_term) = btrim($2) FOR UPDATE`, [glossaryId, deutsch])).rows[0];
  const herkunft = (entryId: string, o: { baustein?: string; vorlaeufig?: string }, wie: string) => c.query(
    `INSERT INTO wortliste_herkunft (entry_id, baustein_id, vorlaeufig_id, sprache, wie) VALUES ($1, $2, $3, $4, $5)`,
    [entryId, o.baustein ?? null, o.vorlaeufig ?? null, sprache, wie]);
  /** Was nach dem Umzug für einen Baustein in der Liste stehen muss; geprüft am Ende gegen `wortliste_freigegeben`. */
  const erwartet: Array<{ deutsch: string; ziel: string; zielName: string | null; art: string; gruppe: number | null }> = [];

  const bausteine = (await c.query<Baustein>(
    `SELECT b.id, b.art, b.deutsch, b.ziel, b.produktgruppe, b.wortart, b.genus, b.formen, b.merkmalsklasse, b.quelle
       FROM namens_bausteine b
      WHERE b.sprache = $1 AND NOT EXISTS (SELECT 1 FROM wortliste_herkunft h WHERE h.baustein_id = b.id)
      ORDER BY b.produktgruppe NULLS FIRST, b.deutsch, b.id`, [sprache])).rows;
  bericht.bausteine.gesamt = bausteine.length;
  bericht.bausteine.schonUmgezogen = (await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wortliste_herkunft h JOIN namens_bausteine b ON b.id = h.baustein_id WHERE b.sprache = $1`, [sprache])).rows[0].n;

  for (const b of bausteine) {
    const d = entscheid.get(b.deutsch.trim());
    const e = await zeileZu(b.deutsch);
    if (b.produktgruppe !== null) {
      if (!e || e.approved !== true) { abw.push(`„${b.deutsch}“ (Gruppe ${b.produktgruppe}): keine freigegebene allgemeine Zeile für das Gruppenziel`); continue; }
      await c.query(
        `INSERT INTO glossary_entry_gruppen (entry_id, produktgruppe, target_term, genus, formen) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (entry_id, produktgruppe) DO NOTHING`,
        [e.id, b.produktgruppe, b.ziel, b.genus, jsonOderNull(b.formen)]);
      const n = (await c.query<{ target_term: string }>(`SELECT target_term FROM glossary_entry_gruppen WHERE entry_id = $1 AND produktgruppe = $2`, [e.id, b.produktgruppe])).rows[0];
      if (n.target_term !== b.ziel) { abw.push(`„${b.deutsch}“ (Gruppe ${b.produktgruppe}): Gruppenziel steht schon mit „${n.target_term}“`); continue; }
      await herkunft(e.id, { baustein: b.id }, 'gruppe');
      bericht.bausteine.gruppe += 1;
      erwartet.push({ deutsch: e.source_term, ziel: b.ziel, zielName: null, art: e.art, gruppe: b.produktgruppe });
      continue;
    }
    const art = d?.art ?? b.art;
    const ziel = d?.ziel ?? b.ziel;
    const zielName = d?.zielName ?? null;
    if (d) genutzt.add(d.deutsch);
    if (e) {
      if (e.approved !== true) { abw.push(`„${b.deutsch}“: die Glossarzeile ist nicht freigegeben`); continue; }
      if (e.target_term !== b.ziel && !d) { abw.push(`„${b.deutsch}“: Baustein „${b.ziel}“, Glossar „${e.target_term}“, ohne Entscheid`); continue; }
      if (art === 'muster' && e.an_deepl) { abw.push(`„${b.deutsch}“: Muster mit Zeile an DeepL, das entscheidet ein Mensch`); continue; }
      await c.query(
        `UPDATE glossary_entries
            SET target_term = $2, ziel_name = $3, art = $4,
                wortart = COALESCE(wortart, $5), genus = COALESCE(genus, $6), formen = COALESCE(formen, $7::jsonb),
                merkmalsklasse = COALESCE(merkmalsklasse, $8)
          WHERE id = $1`,
        [e.id, ziel, zielName, art, b.wortart, b.genus, jsonOderNull(b.formen), b.merkmalsklasse]);
      await herkunft(e.id, { baustein: b.id }, d ? 'entschieden' : 'gleich');
      if (d) bericht.bausteine.entschieden += 1; else bericht.bausteine.gleich += 1;
      erwartet.push({ deutsch: e.source_term, ziel, zielName, art, gruppe: null });
    } else {
      const neu = await c.query<{ id: string }>(
        `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source, an_deepl, art, wortart, genus, formen,
                                       merkmalsklasse, ziel_name)
         VALUES ($1, $2, $3, TRUE, 'baustein', FALSE, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [glossaryId, b.deutsch, ziel, art, b.wortart, b.genus, jsonOderNull(b.formen), b.merkmalsklasse, zielName]);
      bericht.eingefuegt += 1;
      await herkunft(neu.rows[0].id, { baustein: b.id }, d ? 'entschieden' : 'neu');
      if (d) bericht.bausteine.entschieden += 1; else bericht.bausteine.neu += 1;
      erwartet.push({ deutsch: b.deutsch, ziel, zielName, art, gruppe: null });
    }
  }
  bericht.entscheideUngenutzt = entscheide.map((e) => e.deutsch).filter((x) => !genutzt.has(x));

  // Offene Vorschläge und abgelehnte. Eine Produktgruppe am Vorschlag gibt es in der Wortliste nicht als eigene Zeile: Halt.
  const vorl = (await c.query<{
    id: string; art: string; deutsch: string; produktgruppe: number | null; stelle: string | null; kopfwort: string | null;
    vorschlag_pruefung: string | null; vorschlag_glossar: string | null; vorschlag_markt: string | null; vorschlag_deepl: string | null;
    wortart: string | null; genus: string | null; formen: Record<string, string> | null; merkmalsklasse: string | null; quelle: string;
    beispiele: string[]; artikel_anzahl: number | null; status: string; anmerkung: string | null; bearbeitet_von: string | null;
    ziel: string | null;
  }>(
    `SELECT v.* FROM namens_bausteine_vorlaeufig v
      WHERE v.sprache = $1 AND v.status IN ('vorschlag', 'rueckfrage', 'abgelehnt')
        AND NOT EXISTS (SELECT 1 FROM wortliste_herkunft h WHERE h.vorlaeufig_id = v.id)
      ORDER BY v.deutsch, v.id`, [sprache])).rows;
  for (const v of vorl) {
    if (v.status === 'abgelehnt') {
      await c.query(
        `INSERT INTO wortliste_abgelehnt (glossary_id, art, source_term, ziel, anmerkung, von)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [glossaryId, v.art, v.deutsch, v.ziel, v.anmerkung, v.bearbeitet_von ?? name]);
      // Eine abgelehnte hat keine Zeile; die Herkunft zeigt aufs Glossar.
      await herkunft(glossaryId, { vorlaeufig: v.id }, 'abgelehnt');
      bericht.vorlaeufig.abgelehnt += 1;
      continue;
    }
    if (v.produktgruppe !== null) { abw.push(`Vorschlag „${v.deutsch}“ mit Gruppe ${v.produktgruppe}: in der Wortliste gibt es dafür keine offene Zeile`); continue; }
    const e = await zeileZu(v.deutsch);
    if (e && e.approved === true) {
      await herkunft(e.id, { vorlaeufig: v.id }, 'vorschlag');
      bericht.vorlaeufig.schonInDerListe += 1;
      continue;
    }
    let id = e?.id;
    if (!id) {
      id = (await c.query<{ id: string }>(
        `INSERT INTO glossary_entries (glossary_id, source_term, target_term, approved, source, an_deepl, art, wortart, genus, formen, merkmalsklasse)
         VALUES ($1, $2, NULL, FALSE, 'baustein', FALSE, $3, $4, $5, $6, $7) RETURNING id`,
        [glossaryId, v.deutsch, v.art, v.wortart, v.genus, jsonOderNull(v.formen), v.merkmalsklasse])).rows[0].id;
      bericht.eingefuegt += 1;
    }
    await c.query(
      `INSERT INTO wortliste_vorschlag (entry_id, vorschlag_pruefung, vorschlag_glossar, vorschlag_markt, vorschlag_deepl, quelle,
                                        stelle, kopfwort, beispiele, artikel_anzahl, rueckfrage, rueckfrage_von, rueckfrage_am)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CASE WHEN $11::text IS NULL THEN NULL ELSE NOW() END)
       ON CONFLICT (entry_id) DO NOTHING`,
      [id, v.vorschlag_pruefung, v.vorschlag_glossar, v.vorschlag_markt, v.vorschlag_deepl, v.quelle, v.stelle, v.kopfwort,
        v.beispiele, v.artikel_anzahl, v.status === 'rueckfrage' ? (v.anmerkung ?? 'Rückfrage aus dem Einlesen') : null,
        v.status === 'rueckfrage' ? (v.bearbeitet_von ?? name) : null]);
    await herkunft(id, { vorlaeufig: v.id }, 'vorschlag');
    bericht.vorlaeufig.offen += 1;
  }

  await c.query(
    `UPDATE namens_einlesen_protokoll p SET entry_id = h.entry_id
       FROM wortliste_herkunft h WHERE h.baustein_id = p.baustein_id AND p.sprache = $1 AND p.entry_id IS NULL`, [sprache]);
  const umgezogen = bausteine.length + vorl.length;
  if (umgezogen > 0) {
    await c.query(
      `INSERT INTO wortliste_umzug (sprache, bausteine, vorlaeufig, von) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sprache) DO UPDATE SET bausteine = wortliste_umzug.bausteine + EXCLUDED.bausteine,
                                           vorlaeufig = wortliste_umzug.vorlaeufig + EXCLUDED.vorlaeufig, von = EXCLUDED.von, am = NOW()`,
      [sprache, bausteine.length, vorl.length, name]);
  }

  // ── Gegenprüfungen ────────────────────────────────────────────────────────────────────────────────────────────────────
  const frei = await c.query<{ deutsch: string; ziel: string; ziel_name: string | null; art: string; gruppen: Array<{ produktgruppe: number; ziel: string }> }>(
    `SELECT deutsch, ziel, ziel_name, art, gruppen FROM wortliste_freigegeben WHERE sprache = $1`, [sprache]);
  const nachDeutsch = new Map(frei.rows.map((r) => [r.deutsch, r]));
  for (const x of erwartet) {
    const r = nachDeutsch.get(x.deutsch);
    if (!r) { abw.push(`Prüfung: „${x.deutsch}“ fehlt in wortliste_freigegeben`); continue; }
    if (x.gruppe !== null) {
      if (!r.gruppen.some((gz) => gz.produktgruppe === x.gruppe && gz.ziel === x.ziel)) abw.push(`Prüfung: Gruppenziel „${x.deutsch}“ ${x.gruppe} fehlt`);
    } else if (r.ziel !== x.ziel || r.ziel_name !== x.zielName || r.art !== x.art) {
      abw.push(`Prüfung: „${x.deutsch}“ steht als „${r.ziel}“/${r.ziel_name ?? '–'}/${r.art}, erwartet „${x.ziel}“/${x.zielName ?? '–'}/${x.art}`);
    }
  }

  const deeplNachher = await anDeepL(c, glossaryId);
  bericht.deepl.nachher = deeplNachher.size;
  const alle = new Set([...deeplVorher.keys(), ...deeplNachher.keys()]);
  for (const k of alle) if (deeplVorher.get(k) !== deeplNachher.get(k)) bericht.deepl.geaendert.push(k);
  for (const k of bericht.deepl.geaendert) {
    const d = entscheid.get(k.trim());
    if (!d || deeplNachher.get(k) !== d.ziel) abw.push(`Prüfung: an DeepL änderte sich „${k}“ ohne Entscheid (${deeplVorher.get(k) ?? '–'} → ${deeplNachher.get(k) ?? '–'})`);
  }
  if (bericht.deepl.geaendert.length > 0) await incrementGlossaryVersion(glossaryId, bericht.deepl.geaendert, c);

  if (!schonUmgestellt || umgezogen > 0 || bericht.dublettenEntfernt > 0) {
    await c.query(`SELECT namens_fassung_der_transaktion($1, $2)`, [sprache, name]);
  }
  bericht.fassungNachher = await fassung(c, sprache);
  const fassungErwartet = bericht.fassungVorher + (!schonUmgestellt || umgezogen > 0 || bericht.dublettenEntfernt > 0 ? 1 : 0);
  if (bericht.fassungNachher !== fassungErwartet) abw.push(`Prüfung: Fassung ${bericht.fassungNachher}, erwartet ${fassungErwartet}`);

  bericht.glossarNachher = await zaehle();
  const zeilenErwartet = bericht.glossarVorher - bericht.dublettenEntfernt + bericht.eingefuegt;
  if (bericht.glossarNachher !== zeilenErwartet) abw.push(`Prüfung: ${bericht.glossarNachher} Zeilen im Glossar, erwartet ${zeilenErwartet}`);
  return bericht;
}
