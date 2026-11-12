import { pool } from '../db/connection';
import { normalizeGlossaryLang } from './lang';

/**
 * Sales-Channel-Overrides: Pro Glossar-Eintrag können abweichende Zielbegriffe
 * für Verkaufschannels (Tabelle channels, z. B. SHOPA, B2C) hinterlegt werden.
 *
 * Mechanik (Variante B — Pre-/Post-Replacement, ein DeepL-Glossar pro Sprachpaar):
 *   1. Vor dem DeepL-Call werden Quellbegriffe mit Channel-Override durch neutrale
 *      Token (`__TERM_NNN__`) ersetzt. Damit findet DeepL den Standard-Glossar-Eintrag
 *      nicht und übersetzt den Rest normal.
 *   2. Nach DeepL werden die Token durch den Channel-spezifischen Zielbegriff ersetzt.
 *   3. Begriffe ohne Channel-Override durchlaufen DeepL normal — der Standard-Glossar-
 *      Treffer wird automatisch von DeepL via glossary_id angewandt.
 */

export interface ChannelOverride {
  sourceTerm: string;
  channelTargetTerm: string;
}

export interface PreReplacementResult {
  /** Quelltext mit Token statt der Override-Quellbegriffe. */
  text: string;
  /** Token → Channel-Zielbegriff Mapping für Post-Replacement. */
  replacements: Map<string, string>;
}

const TOKEN_PREFIX = '__TERM_';
const TOKEN_SUFFIX = '__';

/**
 * Channel-Overrides für ein Sprachpaar laden.
 * Liefert eine Liste von { sourceTerm, channelTargetTerm }, sortiert nach Laenge
 * absteigend (laengste zuerst → verhindert Teilstring-Konflikte beim Replacement).
 *
 * Begriffe OHNE Override für den Channel sind NICHT enthalten — die werden vom
 * DeepL-Standard-Glossar automatisch behandelt.
 */
export async function getChannelOverrides(
  sourceLang: string,
  targetLang: string,
  channelCode: string,
): Promise<ChannelOverride[]> {
  const result = await pool.query<{ source_term: string; channel_target_term: string }>(
    `SELECT ge.source_term, gec.target_term AS channel_target_term
       FROM glossar_an_deepl ge
       JOIN glossaries g ON g.id = ge.glossary_id
       JOIN glossary_entry_channels gec ON gec.entry_id = ge.id
      WHERE g.source_lang = $1
        AND g.target_lang = $2
        AND gec.channel_code = $3
      ORDER BY LENGTH(ge.source_term) DESC, ge.source_term`,
    [normalizeGlossaryLang(sourceLang), normalizeGlossaryLang(targetLang), channelCode],
  );
  return result.rows.map(r => ({
    sourceTerm: r.source_term,
    channelTargetTerm: r.channel_target_term,
  }));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Heuristik für Wortgrenzen: Wenn der Quellbegriff am Anfang/Ende ein Buchstaben-
 * oder Ziffern-Zeichen hat, verwenden wir `\b`. Sonst (z.B. "3-Phasen") fällt das
 * `\b` ggf. nicht zwischen "3" und "-", deshalb verwenden wir Lookaround mit
 * Nicht-Wort-Zeichen-Klasse, die auch deutsche Umlaute beruecksichtigt.
 */
function buildTermRegex(term: string): RegExp {
  // Zeichen, die als Teil eines "Worts" gelten — inkl. deutscher Umlaute
  const wordChar = '[A-Za-zÄÖÜäöüß0-9]';
  const escaped = escapeRegex(term);
  // Negative Lookbehind/-ahead: Begriff darf nicht von einem Wortzeichen umschlossen sein
  return new RegExp(`(?<!${wordChar})${escaped}(?!${wordChar})`, 'g');
}

/**
 * Quelltext für DeepL vorbereiten: Override-Quellbegriffe durch Token ersetzen.
 * Token-Format: `__TERM_<idx>__` — DeepL laesst diese unangetastet, weil sie keine
 * Wort-Tokens darstellen.
 *
 * Verarbeitet Begriffe in der Reihenfolge der Liste (laengste zuerst). Token-Index
 * wird pro Aufruf vergeben, sodass mehrere Vorkommen desselben Begriffs denselben
 * Token bekommen — das spart Mappings und macht den Post-Replacement deterministisch.
 */
export function applyPreReplacement(
  text: string,
  overrides: ChannelOverride[],
): PreReplacementResult {
  if (overrides.length === 0) {
    return { text, replacements: new Map() };
  }

  let workingText = text;
  const replacements = new Map<string, string>();
  // Wiederverwendbares Mapping: gleicher Quellbegriff → gleicher Token
  const termToToken = new Map<string, string>();

  for (let i = 0; i < overrides.length; i++) {
    const { sourceTerm, channelTargetTerm } = overrides[i];

    // Token nur vergeben wenn der Begriff im Text vorkommt
    const regex = buildTermRegex(sourceTerm);
    if (!regex.test(workingText)) continue;

    let token = termToToken.get(sourceTerm);
    if (!token) {
      token = `${TOKEN_PREFIX}${replacements.size.toString().padStart(3, '0')}${TOKEN_SUFFIX}`;
      termToToken.set(sourceTerm, token);
      replacements.set(token, channelTargetTerm);
    }

    // Neuer Regex weil .test() den lastIndex bei /g verschiebt
    workingText = workingText.replace(buildTermRegex(sourceTerm), token);
  }

  return { text: workingText, replacements };
}

/**
 * Token im übersetzten Text durch Channel-Zielbegriffe ersetzen.
 * Token sind so gewaehlt, dass DeepL sie nicht übersetzt (`__TERM_NNN__`).
 */
export function applyPostReplacement(
  translatedText: string,
  replacements: Map<string, string>,
): string {
  if (replacements.size === 0) return translatedText;

  let result = translatedText;
  for (const [token, target] of replacements.entries()) {
    // Token kann mehrfach vorkommen → globales Replace
    const tokenRegex = new RegExp(escapeRegex(token), 'g');
    result = result.replace(tokenRegex, target);
  }
  return result;
}

/**
 * Convenience-Wrapper: Quelltext channel-spezifisch vorbereiten, Replacement-Map
 * zwischenspeichern. Ruft der Caller zwei separate Phasen auf, ist das nicht noetig.
 */
export interface BatchPreReplacement {
  texts: string[];
  replacementsPerText: Array<Map<string, string>>;
}

export function applyPreReplacementBatch(
  texts: string[],
  overrides: ChannelOverride[],
): BatchPreReplacement {
  const result: BatchPreReplacement = {
    texts: [],
    replacementsPerText: [],
  };
  for (const t of texts) {
    const r = applyPreReplacement(t, overrides);
    result.texts.push(r.text);
    result.replacementsPerText.push(r.replacements);
  }
  return result;
}

export function applyPostReplacementBatch(
  translatedTexts: string[],
  replacementsPerText: Array<Map<string, string>>,
): string[] {
  return translatedTexts.map((t, i) =>
    applyPostReplacement(t, replacementsPerText[i] ?? new Map()),
  );
}
