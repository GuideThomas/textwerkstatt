import type { LlmResult } from './llm';
import { LANGUAGE_NAMES } from './condensing';
import { begriffeImText, fehlendeBegriffe } from './begriffe-im-text';
import type { Begriff } from './begriffe-im-text';

/**
 * Namensfassung — einen übersetzten ARTIKELNAMEN umstellen bzw. eine Wortwiederholung
 * auflösen (Route `POST /api/namensfassung`, Aufrufer: Artikelanlage-Assistent).
 *
 * ── DER ANLASS (29.10.2026, Thomas) ─────────────────────────────────────────
 *
 * 1. „Am Anfang steht im Deutschen stets ‚LED' oder ‚GU10' oder ‚E27' — in den
 *    Übersetzungen oft erst als drittes oder viertes Wort." Gemessen: in EN, HU, CZ, SK
 *    beginnt der Bestand zu 91–96 % mit der Kennung, die neuen DeepL-Lieferungen in EN
 *    nur zu 57 %, in HU zu 67 % („120-watt LED floodlight"). In FR, IT, ES, PL steht in
 *    Mitbewerber-Shops das Produktwort vorn („Ruban LED") — dort bleibt es so
 *    (Entscheid Thomas: sprachgerecht).
 * 2. „Wortwiederholung innerhalb der fremdsprachigen Artikelübersetzung sollten
 *    ebenfalls vermieden werden" — „GU5.3 Socket with Ceramic Socket",
 *    „Kinkiet/kinkiet sufitowy". Ausnahme: Gehäusefarbe + Lichtfarbe
 *    („blanco RAL 9016, blanco neutro") sind zwei Angaben und bleiben.
 *
 * 🚨 DIESER DIENST SCHREIBT NUR DEN PROMPT UND HOLT DIE ANTWORT. Welche Aufgabe
 * ansteht und ob die Antwort taugt, entscheidet der Aufrufer — mit harten Prüfungen
 * (nur umgestellt? nur ein wiederholtes Wort ersetzt? Zahlen, Kommas, Dimmung,
 * Lichtfarbe da?). Eine Bitte an das Modell ist keine Schranke.
 *
 * Eine Prüfung steht seit 11.11.2026 doch hier, weil nur dieser Dienst das Glossar kennt: Die Glossarbegriffe, die im
 * bisherigen Namen stehen, gehen als „bleibt“ in die Anweisung und müssen im Ergebnis stehen, sonst kommt ein leerer
 * Text zurück (der Assistent behält dann den Namen, wie er war). Im Modellvergleich setzte Grok sonst deutsche Wörter
 * ein („Flexband“ im Italienischen, `messung/textwerkstatt-phase6/`).
 */

export interface NamensfassungAuftrag {
  deutsch: string;
  uebersetzung: string;
  zielsprache: string;
  /** Die Kennung, mit der der Name beginnen soll („LED", „GU10") — oder leer. */
  kennungVorn?: string;
  /** Wörter, die doppelt stehen und aufgelöst werden sollen — oder leer. */
  wiederholt?: string[];
  maxChars: number;
  /** Alle Glossarpaare des Sprachpaars (`ladeBegriffe`); hier wird auf die gefiltert, die zu diesem Namen passen. */
  begriffe?: Begriff[];
}

/** Die Glossarpaare, die zu Original und bisherigem Namen passen. */
export function passendeBegriffe(a: NamensfassungAuftrag): Begriff[] {
  return begriffeImText(a.deutsch, a.uebersetzung, a.begriffe ?? []);
}

function paareHinweis(a: NamensfassungAuftrag): string {
  const p = passendeBegriffe(a);
  if (p.length === 0) return '';
  return '\n- Diese Fachbegriffe aus dem Glossar stehen schon im Namen und bleiben genau so (mindestens einmal): ' +
    p.map((x) => `„${x.ziel}“`).join(', ') + '. Ein anderes Wort aus einer anderen Sprache ist nie richtig.';
}

export function buildNamensfassungPrompt(a: NamensfassungAuftrag): { system: string; user: string } {
  const sprache = LANGUAGE_NAMES[a.zielsprache.toUpperCase()] || a.zielsprache;
  const aufgaben: string[] = [];
  if (a.kennungVorn) {
    aufgaben.push(
      `- Stelle den Namen so um, dass er mit „${a.kennungVorn}" beginnt, wie das deutsche Original. ` +
        'Ändere dabei KEIN Wort — nur die Reihenfolge. Was vor der Kennung stand (Serie, Leistung, Eigenschaft), ' +
        'kommt dorthin, wo es grammatisch hingehört.',
    );
  }
  if (a.wiederholt && a.wiederholt.length > 0) {
    aufgaben.push(
      `- Das Wort ${a.wiederholt.map((w) => `„${w}"`).join(', ')} steht mehrfach. Löse die Wiederholung auf: ` +
        'ersetze EIN Vorkommen durch den treffenden Fachbegriff oder streiche es, wenn es überflüssig ist. ' +
        'Alle anderen Wörter bleiben.',
    );
  }
  const system = `Du bist technischer Redakteur für LED-Artikelnamen auf ${sprache}.
Du überarbeitest einen bestehenden Artikelnamen — du übersetzt nicht neu.

ABSOLUTE REGELN:
- Alle Zahlen, Einheiten, Kürzel, Serien- und Markennamen bleiben unverändert erhalten.
- Alle Kommas bleiben (sie trennen die Merkmale); du darfst sie mit ihrem Merkmal verschieben.
- Dimmbarkeit (z. B. "dimmable") und Lichtfarbe (z. B. "warm white") bleiben.
- Gehäusefarbe und Lichtfarbe sind zwei Angaben ("white, warm white") — das ist keine Wiederholung.
- Nur das erste Wort und Eigennamen groß, sonst Kleinschreibung wie im Original.
- Höchstens ${a.maxChars} Zeichen.${paareHinweis(a)}
- Antworte NUR mit dem Namen — keine Erklärung, kein Markdown, keine Anführungszeichen.`;
  const user = `Deutsches Original:
${a.deutsch}

Bisheriger Name (${sprache}):
${a.uebersetzung}

Aufgabe:
${aufgaben.join('\n')}`;
  return { system, user };
}

/**
 * Holt die überarbeitete Fassung. Gibt den Text zurück, wie ihn das Modell liefert
 * (getrimmt, umschliessende Anführungszeichen entfernt) — geprüft wird beim Aufrufer.
 */
export async function namensfassung(
  a: NamensfassungAuftrag,
  llm: (system: string, user: string) => Promise<LlmResult>,
  nachAufruf?: (r: LlmResult) => Promise<void>,
): Promise<{ text: string; tokens: number; fehlendeBegriffe?: string[] }> {
  const p = buildNamensfassungPrompt(a);
  const r = await llm(p.system, p.user);
  if (nachAufruf) await nachAufruf(r).catch(() => undefined);
  const text = r.text.trim().replace(/^["„“'«]+|["“”'»]+$/gu, '').trim();
  const tokens = (r.inputTokens || 0) + (r.outputTokens || 0);
  const fehlt = fehlendeBegriffe(text, passendeBegriffe(a));
  if (fehlt.length > 0) return { text: '', tokens, fehlendeBegriffe: fehlt };
  return { text, tokens };
}
