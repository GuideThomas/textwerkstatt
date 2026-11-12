/**
 * Wendet eine Entscheidungsliste auf die Glossarzeilen an (PLAN-glossar-nur-abweichungen.md, Phase 3).
 *
 * Eine Zeile der Liste trägt den Stand, von dem aus entschieden wurde. Weicht die Datenbank davon ab, hat seither jemand
 * die Zeile geändert: Dann läuft gar nichts, denn die Entscheidung galt einem anderen Wert. Channel-Werte und Kennwerte
 * der Schutzkette fasst die Liste nie an, auch wenn eine Zeile sie nennt.
 */
import type { PoolClient } from 'pg';
import { incrementGlossaryVersion } from './glossar-pflege';
import { AKRONYM_KENNWERTE } from './unit-protection';
import { nenneBearbeiter } from '../db/bearbeiter';

export const FOLGEN = ['leer_entfernen', 'weg', 'neu'] as const;
export type ListenFolge = (typeof FOLGEN)[number];

export interface ListenZeile {
  entryId: string;
  folge: ListenFolge;
  deutsch: string;
  eintrag: string;
  neu: string;
}

export interface ListenErgebnis {
  abweichungen: string[];
  leerEntfernt: number;
  entfernt: number;
  ersetzt: number;
  beruehrt: string[];
  glossare: number;
}

const SPALTEN = ['entry_id', 'folge', 'deutsch', 'eintrag', 'neu'];

/** Liest die Tabulator-Datei. Wirft bei falschem Kopf, unbekannter Folge oder doppelter Zeile: Das ist ein Fehler der Liste. */
export function leseListe(inhalt: string): ListenZeile[] {
  const [kopf, ...rest] = inhalt.replace(/^﻿/, '').split(/\r?\n/).filter((z) => z !== '');
  const spalten = (kopf ?? '').split('\t');
  const fehlt = SPALTEN.filter((s) => !spalten.includes(s));
  if (fehlt.length > 0) throw new Error(`Der Liste fehlen Spalten: ${fehlt.join(', ')}`);
  const stelle = (s: string): number => spalten.indexOf(s);
  const gesehen = new Set<string>();
  return rest.map((z, i) => {
    const t = z.split('\t');
    const folge = t[stelle('folge')] as ListenFolge;
    const entryId = t[stelle('entry_id')];
    if (!FOLGEN.includes(folge)) throw new Error(`Zeile ${i + 2}: unbekannte Folge „${folge}“`);
    if (gesehen.has(entryId)) throw new Error(`Zeile ${i + 2}: entry_id doppelt`);
    gesehen.add(entryId);
    const neu = t[stelle('neu')] ?? '';
    if (folge === 'neu' && neu.trim() === '') throw new Error(`Zeile ${i + 2}: Folge „neu“ ohne Wert`);
    return { entryId, folge, deutsch: t[stelle('deutsch')] ?? '', eintrag: t[stelle('eintrag')] ?? '', neu };
  });
}

/** Läuft in der Transaktion des Aufrufers. Mit Abweichungen wird nichts geschrieben. */
export async function wendeListeAn(c: PoolClient, zeilen: ListenZeile[], wer: string): Promise<ListenErgebnis> {
  const ids = zeilen.map((z) => z.entryId);
  const stand = await c.query<{ id: string; glossary_id: string; source_term: string; target_term: string | null; kanal: boolean }>(
    `SELECT e.id, e.glossary_id, e.source_term, e.target_term,
            EXISTS (SELECT 1 FROM glossary_entry_channels k WHERE k.entry_id = e.id) AS kanal
       FROM glossary_entries e
      WHERE e.id = ANY($1::uuid[])
      FOR UPDATE OF e`,
    [ids],
  );
  const db = new Map(stand.rows.map((r) => [r.id, r]));
  const abweichungen: string[] = [];
  for (const z of zeilen) {
    const r = db.get(z.entryId);
    const name = `${z.entryId} ${z.deutsch}`;
    if (!r) abweichungen.push(`${name}: Zeile gibt es nicht mehr`);
    else if (r.source_term !== z.deutsch) abweichungen.push(`${name}: Begriff heißt jetzt „${r.source_term}“`);
    else if ((r.target_term ?? '') !== z.eintrag) abweichungen.push(`${name}: Eintrag ist jetzt „${r.target_term ?? ''}“, die Liste kennt „${z.eintrag}“`);
    else if (r.kanal) abweichungen.push(`${name}: Zeile hat einen Channel-Wert`);
    else if (AKRONYM_KENNWERTE.includes(r.source_term) && r.target_term !== null) abweichungen.push(`${name}: Kennwert der Schutzkette`);
    else if (z.folge === 'leer_entfernen' && r.target_term !== null) abweichungen.push(`${name}: Zeile ist nicht leer`);
    else if (z.folge !== 'leer_entfernen' && r.target_term === null) abweichungen.push(`${name}: Zeile ist leer`);
  }
  const ergebnis: ListenErgebnis = { abweichungen, leerEntfernt: 0, entfernt: 0, ersetzt: 0, beruehrt: ids, glossare: 0 };
  if (abweichungen.length > 0) return ergebnis;

  // Den Verlauf je Zeile schreibt der Trigger aus Migration 037 unter diesem Namen; bis 10.11.2026 stand hier ein eigener Eintrag.
  await nenneBearbeiter(c, { id: null, name: wer });
  const begriffe = new Map<string, string[]>();
  for (const z of zeilen) {
    const r = db.get(z.entryId)!;
    if (z.folge === 'neu') {
      await c.query(`UPDATE glossary_entries SET target_term = $2 WHERE id = $1`, [z.entryId, z.neu]);
      ergebnis.ersetzt += 1;
    } else {
      await c.query(`DELETE FROM glossary_entries WHERE id = $1`, [z.entryId]);
      if (z.folge === 'weg') ergebnis.entfernt += 1;
      else ergebnis.leerEntfernt += 1;
    }
    // Eine leere Zeile war nie aktiv und entwertet nichts.
    if (r.target_term !== null) begriffe.set(r.glossary_id, [...(begriffe.get(r.glossary_id) ?? []), r.source_term]);
  }
  for (const [glossarId, liste] of begriffe) await incrementGlossaryVersion(glossarId, liste, c);
  ergebnis.glossare = begriffe.size;
  return ergebnis;
}
