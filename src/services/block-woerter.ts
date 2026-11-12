/**
 * Was im deutschen Artikelnamen in Blockbuchstaben steht, steht auch in der Übersetzung so (Thomas, 05.11.2026).
 *
 * Der Glossareintrag allein reicht nicht: DeepL übernimmt den Wert, aber nicht immer die Schreibung, gemessen `SET` → `SADA`
 * in 3 von 16 Proben. Deshalb hier nach der Übersetzung: Steht ein Begriff in Blockbuchstaben in der Quelle und führt das
 * Glossar für ihn einen Wert in Blockbuchstaben, wird dieser Wert in der Übersetzung großgeschrieben.
 *
 * Gesucht wird der ganze Wert als ganzes Wort. Gebeugte Formen (`povrchovou montáž` statt `POVRCHOVÁ MONTÁŽ`) erreicht das nicht,
 * und Teile eines längeren Wortes (`KIT` in `kitten`) bleiben unberührt. Begriffe in normaler Schreibung wirken hier nie.
 */
export interface BlockEintrag {
  source_term: string;
  target_term: string;
}

const istBlock = (t: string): boolean => /\p{Lu}.*\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t);
// Kein Bindestrich in der Liste: Mit dem Flag `u` wirft `\-` außerhalb einer Zeichenklasse einen Fehler (05.11.2026, 500 bei WI-FI).
const maskiere = (t: string): string => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const kommtVor = (text: string, wort: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${maskiere(wort)}(?![\\p{L}\\p{N}])`, 'u').test(text);

/** Nur Einträge, deren Begriff und Wert beide in Blockbuchstaben stehen, längster Begriff zuerst. */
export function nurBlockEintraege(eintraege: BlockEintrag[]): BlockEintrag[] {
  return eintraege
    .filter((e) => istBlock(e.source_term) && istBlock(e.target_term))
    .sort((a, b) => b.source_term.length - a.source_term.length);
}

export function blockWieGlossar(quelle: string, ziel: string, eintraege: BlockEintrag[]): string {
  if (/^\s*</.test(ziel)) return ziel;
  let text = ziel;
  for (const e of eintraege) {
    if (!quelle.includes(e.source_term) || !kommtVor(quelle, e.source_term)) continue;
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${maskiere(e.target_term)}(?![\\p{L}\\p{N}])`, 'giu'), e.target_term);
  }
  return text;
}
