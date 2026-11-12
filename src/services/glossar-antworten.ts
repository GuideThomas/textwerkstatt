/**
 * Antworten der Muttersprachler auf das Glossar-Blatt ins Glossar einspielen.
 *
 * Plan `Artikelanlage-Assistent/docs/PLAN-Artikelnamen-Bausteine.md` Phase 1 („Die Antworten … korrigieren die falschen
 * Glossareinträge“), erste Sprache EN am 06.11.2026 (Entscheid Thomas: sofort, nicht auf alle Sprachen warten). Die Antwortdatei
 * und ihre Prüfung liegen unter `Artikelanlage-Assistent/docs/analyse-artikelnamen/antworten/<SPRACHE>/`.
 *
 * Je Zeile des Glossar-Blatts hat der Prüfer entschieden:
 *   - „Vorschlag“: Der Standardwert wird zum Vorschlag. Channel-Werte bleiben, wie sie sind; der Prüfer hat sie nicht gesehen.
 *     Führt das Glossar daneben die Blockschrift-Zeile (`AUFBAU` neben `Aufbau`) mit dem großgeschriebenen alten Wert, zieht sie
 *     großgeschrieben nach, sonst widerspräche der Blockwert dem Standardwert (`batch-translate`, `blockWieGlossar`).
 *   - „OK“: Der Eintrag bleibt. Prüfhinweise zu genau diesem Stand werden verworfen (Migration 028: „Hält ein Mensch den Eintrag
 *     für richtig, … fällt nur der Hinweis weg“). Hinweise zu einem geänderten Wert erledigen sich von selbst.
 *
 * 🚨 ALLES ODER NICHTS. Weicht eine Zeile vom Stand des Blatts ab (Wert inzwischen anders, Zeile fehlt, nicht freigegeben, zwei
 * Zeilen zum Begriff, Blockzeile mit unerwartetem Wert), wird nichts geschrieben. Der Prüfer hat einen Stand beurteilt; einen
 * anderen zu überschreiben hieße, seine Entscheidung auf etwas anzuwenden, das er nicht gesehen hat.
 *
 * Läuft in der Transaktion des Aufrufers. Die Version des Glossars steigt einmal, die betroffenen Cache-Zeilen werden veraltet.
 */
import type { PoolClient } from 'pg';
import { incrementGlossaryVersion } from './glossar-pflege';
import { hinweiseZumStandVerwerfen } from './glossar-hinweise';
import { nenneBearbeiter } from '../db/bearbeiter';

import { leseAntworten, type AntwortZeile } from './glossar-antworten-lesen';

export { entscheidungAus, leseAntworten } from './glossar-antworten-lesen';
export type { AntwortEntscheidung, AntwortZeile } from './glossar-antworten-lesen';

export interface Aenderung {
  entryId: string;
  begriff: string;
  alt: string;
  neu: string;
  block: boolean;
  kanalBleibt: boolean;
}

export interface AntwortErgebnis {
  abweichungen: string[];
  aenderungen: Aenderung[];
  okZeilen: number;
  hinweiseVerworfen: number;
  beruehrt: string[];
}

interface Eintrag {
  id: string;
  source_term: string;
  target_term: string | null;
  approved: boolean | null;
  kanal: boolean;
}

export async function spieleAntwortenEin(
  c: PoolClient,
  glossaryId: string,
  zeilen: AntwortZeile[],
  wer: string,
): Promise<AntwortErgebnis> {
  const stand = await c.query<Eintrag>(
    `SELECT e.id, e.source_term, e.target_term, e.approved,
            EXISTS (SELECT 1 FROM glossary_entry_channels k WHERE k.entry_id = e.id) AS kanal
       FROM glossary_entries e
      WHERE e.glossary_id = $1
      FOR UPDATE OF e`,
    [glossaryId],
  );
  const nachBegriff = new Map<string, Eintrag[]>();
  for (const r of stand.rows) nachBegriff.set(r.source_term, [...(nachBegriff.get(r.source_term) ?? []), r]);

  const abweichungen: string[] = [];
  const aenderungen: Aenderung[] = [];
  const okStaende: Array<{ begriff: string; wert: string }> = [];
  const geplant = new Set<string>();

  for (const z of zeilen) {
    const name = `Blatt-Zeile ${z.zeile} „${z.deutsch}“`;
    const treffer = nachBegriff.get(z.deutsch) ?? [];
    if (treffer.length === 0) { abweichungen.push(`${name}: keine Zeile mit genau diesem Begriff`); continue; }
    if (treffer.length > 1) { abweichungen.push(`${name}: ${treffer.length} Zeilen mit genau diesem Begriff`); continue; }
    const t = treffer[0];
    if ((t.target_term ?? '') !== z.heute) {
      abweichungen.push(`${name}: Eintrag ist jetzt „${t.target_term ?? ''}“, der Prüfer sah „${z.heute}“`);
      continue;
    }
    if (t.approved !== true) { abweichungen.push(`${name}: Eintrag ist nicht freigegeben`); continue; }

    if (z.entscheidung === 'ok') {
      okStaende.push({ begriff: t.source_term, wert: z.heute });
      continue;
    }
    aenderungen.push({ entryId: t.id, begriff: t.source_term, alt: z.heute, neu: z.vorschlag, block: false, kanalBleibt: t.kanal });
    geplant.add(t.id);

    const blockBegriff = z.deutsch.toUpperCase();
    if (blockBegriff === z.deutsch) continue;
    const block = nachBegriff.get(blockBegriff) ?? [];
    if (block.length === 0) continue;
    if (block.length > 1) { abweichungen.push(`${name}: ${block.length} Blockzeilen „${blockBegriff}“`); continue; }
    const b = block[0];
    const blockNeu = z.vorschlag.toUpperCase();
    if (b.target_term === blockNeu) continue;
    if (b.target_term !== z.heute.toUpperCase()) {
      abweichungen.push(`${name}: Blockzeile „${blockBegriff}“ trägt „${b.target_term ?? ''}“, erwartet „${z.heute.toUpperCase()}“`);
      continue;
    }
    if (geplant.has(b.id)) { abweichungen.push(`${name}: Blockzeile „${blockBegriff}“ steht selbst auf dem Blatt`); continue; }
    aenderungen.push({ entryId: b.id, begriff: b.source_term, alt: b.target_term, neu: blockNeu, block: true, kanalBleibt: b.kanal });
    geplant.add(b.id);
  }

  const ergebnis: AntwortErgebnis = { abweichungen, aenderungen, okZeilen: okStaende.length, hinweiseVerworfen: 0, beruehrt: [...geplant] };
  if (abweichungen.length > 0) return ergebnis;

  // Den Verlauf je Zeile schreibt der Trigger aus Migration 037 unter diesem Namen (Plan Wortliste §2.6); bis 10.11.2026 stand hier
  // ein eigener Eintrag, der danach doppelt dagestanden hätte.
  await nenneBearbeiter(c, { id: null, name: wer });
  for (const a of aenderungen) {
    await c.query(`UPDATE glossary_entries SET target_term = $2 WHERE id = $1`, [a.entryId, a.neu]);
  }
  for (const s of okStaende) {
    ergebnis.hinweiseVerworfen += await hinweiseZumStandVerwerfen(c, glossaryId, s.begriff, s.wert, wer);
  }
  if (aenderungen.length > 0) await incrementGlossaryVersion(glossaryId, aenderungen.map((a) => a.begriff), c);
  return ergebnis;
}
