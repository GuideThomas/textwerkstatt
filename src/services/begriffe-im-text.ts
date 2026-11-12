/**
 * Begriffe aus Glossar und Wortliste, die zu EINEM Text passen — für die Anweisungen an ein Sprachmodell.
 *
 * 🚨 BIS 11.11.2026 bekam das Kürzen die ersten 100 Zielbegriffe des Glossars in alphabetischer Reihenfolge
 * („Verwende zwingend diese Fachbegriffe: …“), unabhängig vom Text, bei Glossaren mit 890 bis 1.904 Einträgen. Ein
 * passender Begriff stand also nur zufällig in der Liste, und ob er danach noch dastand, prüfte niemand. Entscheid Thomas
 * 11.11.2026: Ein Sprachmodell bekommt nur die Begriffe, die im Text stehen, und zwar je Channel (Plan
 * `PLAN-textwerkstatt.md` §4 Phase 6).
 *
 * Glossar und Wortliste sind dieselbe Tabelle (`glossary_entries`): `an_deepl` heißt „geht an DeepL“; die Wortliste
 * führt zusätzlich Einträge nur für Artikelnamen (`an_deepl = FALSE`) und eine eigene Namensform (`ziel_name`). Der
 * Channel-Wert steht in `glossary_entry_channels` und ersetzt den Standard. `art = 'muster'` sind Muster, keine Begriffe.
 *
 * Ein Paar gilt nur, wenn der DEUTSCHE Begriff im Quelltext steht UND der Zielbegriff in der Übersetzung: Dann ist er
 * dort angekommen und muss erhalten bleiben. Hat DeepL anders übersetzt, bleibt das Paar draußen — die Anweisungen sagen
 * dem Modell, nur Wörter der Übersetzung zu verwenden, und ein Begriff, der nicht dasteht, wäre ein Widerspruch dazu.
 *
 * Treffer wie bei der Hausschreibweise (`findHouseTermMatches`): Groß/klein egal, links eine Wortgrenze (ein Bindestrich
 * zählt als Grenze), rechts darf das Wort weitergehen (Beugung, Zusammensetzung). Bei Überlappung gewinnt der längere.
 */
import { pool } from '../db/connection';
import { normalizeGlossaryLang } from './lang';

export interface Begriff {
  deutsch: string;
  ziel: string;
}

const WORT = /[\p{L}\p{N}]/u;
/** Kürzer trifft zu viel („Lux“ in „Luxus“ wäre noch eine Grenze, „AC“ in „ACCU“ nicht mehr). */
const MIN_LAENGE = 3;
/** Mehr passt nicht sinnvoll in eine Anweisung; die längsten Treffer gewinnen. */
export const MAX_BEGRIFFE = 25;
const CACHE_MS = 5 * 60_000;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Alle Stellen, an denen `begriff` im Text beginnt (Groß/klein egal, links Wortgrenze, rechts frei). */
function stellen(text: string, begriff: string): Array<{ von: number; bis: number }> {
  const b = begriff.trim();
  if (b.length < MIN_LAENGE) return [];
  const out: Array<{ von: number; bis: number }> = [];
  for (const m of text.matchAll(new RegExp(escapeRegex(b), 'giu'))) {
    const von = m.index ?? 0;
    if (von > 0 && WORT.test(text[von - 1])) continue;
    out.push({ von, bis: von + m[0].length });
  }
  return out;
}

/** Steht der Begriff im Text (Regeln wie oben)? */
export function stehtImText(text: string, begriff: string): boolean {
  return stellen(text, begriff).length > 0;
}

/**
 * Die Paare, die zu Quelltext und Übersetzung passen. Längere deutsche Begriffe zuerst; ein kürzerer, dessen Stelle im
 * Quelltext ganz in einem längeren liegt („Profil“ in „Aluprofil-Abdeckung“), zählt nicht extra.
 */
export function begriffeImText(quelltext: string, uebersetzung: string, alle: Begriff[], max = MAX_BEGRIFFE): Begriff[] {
  const belegt: Array<{ von: number; bis: number }> = [];
  const gesehen = new Set<string>();
  const out: Begriff[] = [];
  const sortiert = [...alle]
    .filter((b) => b.deutsch.trim().length >= MIN_LAENGE && b.ziel.trim().length >= MIN_LAENGE)
    .sort((a, b) => b.deutsch.trim().length - a.deutsch.trim().length);
  for (const b of sortiert) {
    if (out.length >= max) break;
    const s = stellen(quelltext, b.deutsch).filter((x) => !belegt.some((y) => x.von >= y.von && x.bis <= y.bis));
    if (s.length === 0) continue;
    if (!stehtImText(uebersetzung, b.ziel)) continue;
    const schluessel = b.ziel.trim().toLowerCase();
    belegt.push(...s);
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    out.push({ deutsch: b.deutsch.trim(), ziel: b.ziel.trim() });
  }
  return out;
}

/** Die Zielbegriffe der Paare, die im Ergebnis fehlen. */
export function fehlendeBegriffe(ergebnis: string, paare: Begriff[]): string[] {
  return paare.filter((p) => !stehtImText(ergebnis, p.ziel)).map((p) => p.ziel);
}

/** Der Teil der Anweisung: leer, wenn kein Paar passt. */
export function begriffeHinweis(paare: Begriff[]): string {
  if (paare.length === 0) return '';
  return (
    '\nFachbegriffe aus dem Glossar, die in der Übersetzung stehen und genau so erhalten bleiben müssen ' +
    '(nicht abkürzen, nicht ersetzen, nicht streichen): ' +
    paare.map((p) => `„${p.ziel}“`).join(', ')
  );
}

const cache = new Map<string, { bis: number; begriffe: Promise<Begriff[]> }>();

/** Nur für Tests. */
export function begriffeCacheLeeren(): void {
  cache.clear();
}

/**
 * Alle Paare eines Sprachpaars, mit dem Channel-Wert, wo es einen gibt. `fuerNamen` nimmt die Einträge nur für
 * Artikelnamen dazu und deren Namensform (`ziel_name`); ohne gilt, was an DeepL geht. Fünf Minuten zwischengespeichert:
 * Das Kürzen läuft je Artikel und Sprache, eine Abfrage je Aufruf wäre unnötig.
 */
export function ladeBegriffe(
  quellsprache: string,
  zielsprache: string,
  opt: { channel?: string | null; fuerNamen?: boolean } = {},
): Promise<Begriff[]> {
  const q = normalizeGlossaryLang(quellsprache), z = normalizeGlossaryLang(zielsprache);
  const channel = opt.channel ? opt.channel.toUpperCase() : null;
  const fuerNamen = opt.fuerNamen === true;
  const schluessel = `${q}|${z}|${channel ?? ''}|${fuerNamen ? 'n' : 't'}`;
  const jetzt = Date.now();
  const da = cache.get(schluessel);
  if (da && da.bis > jetzt) return da.begriffe;
  const begriffe = pool
    .query<{ deutsch: string; ziel: string }>(
      `SELECT e.source_term AS deutsch,
              COALESCE(c.target_term, CASE WHEN $4 THEN NULLIF(e.ziel_name, '') END, e.target_term) AS ziel
         FROM glossary_entries e
         JOIN glossaries g ON g.id = e.glossary_id
         LEFT JOIN glossary_entry_channels c ON c.entry_id = e.id AND c.channel_code = $3
        WHERE g.source_lang = $1 AND g.target_lang = $2
          AND e.approved = TRUE AND e.target_term IS NOT NULL
          AND COALESCE(e.art, 'wort') <> 'muster'
          AND (e.an_deepl OR $4)`,
      [q, z, channel, fuerNamen],
    )
    .then((r) => r.rows.filter((x) => x.deutsch && x.ziel));
  cache.set(schluessel, { bis: jetzt + CACHE_MS, begriffe });
  // Ein Fehler darf nicht fünf Minuten lang zwischengespeichert bleiben.
  begriffe.catch(() => cache.delete(schluessel));
  return begriffe;
}
