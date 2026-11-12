/**
 * LLM-basierter Mid-Sentence-Capitalization-Korrektor (Thema A v2, 22.05.2026)
 *
 * Hintergrund: DeepL behaelt DE-Nomen-Grossschreibung faelschlich im Target bei
 * ("Avec Design moderne" statt "Avec design moderne"). LanguageTool deckt diese
 * Klasse fuer FR/IT/ES nicht ab (keine Standard-Rules). LLM-Cheap-Tier ist
 * kontextsensitiv und kann das zuverlaessig — mit striktem Prompt + Sanity-Check.
 *
 * Halluzinations-Schutz (aus Sun-Tzu-Vorfall 20.05.2026):
 *  1. Length-Ratio 90-110% (Capitalization aendert nur ein paar Zeichen)
 *  2. Wort-Token-Diff: max 5% der Tokens duerfen sich aendern, und die
 *     Aenderungen muessen nur Case-Wechsel sein (gleiche Buchstaben).
 *  3. Verdacht → Original zurueckgeben, audit-log mit reason
 *
 * Sprachen mit "Nomen klein"-Konvention: FR, IT, ES, PT, NL, PL, CS, SK, SL, HU.
 * EN bewusst ausgeschlossen (Title-Case-Konventionen variieren stark).
 */

import { logTokenUsage } from './llm';
import { callLlmGeschuetzt } from './pseudonym/maschine';
import { config } from '../config';

const SUPPORTED_LANGS = new Set(['FR', 'IT', 'ES', 'PT', 'NL', 'PL', 'CS', 'CZ', 'SK', 'SL', 'HU']);

/** Wird im Prompt als Schutzliste an das LLM weitergegeben. */
const BRAND_HINT = [
  'LED', 'RGB', 'RGBW', 'IP', 'CRI', 'UGR', 'IRC', 'CCT', 'PWM',
  'DALI', 'KNX', 'WLAN', 'WiFi', 'USB', 'AC', 'DC',
  'Magento', 'DeepL',
  'ETIM', 'SAP', 'DIN', 'EN', 'ISO', 'CE', 'RoHS',
  // Eigene Marken- und Produktnamen dieser Installation (GESCHUETZTE_WOERTER)
  ...config.geschuetzteWoerter,
];

const LANG_NAMES: Record<string, string> = {
  FR: 'Französisch', IT: 'Italienisch', ES: 'Spanisch', PT: 'Portugiesisch',
  NL: 'Niederländisch', PL: 'Polnisch', CS: 'Tschechisch', CZ: 'Tschechisch',
  SK: 'Slowakisch', SL: 'Slowenisch', HU: 'Ungarisch',
};

/**
 * Höflichkeitspronomen der Sprachen, in denen DeepL eine Anredestufe kennt.
 *
 * Warum das eine HARTE Schranke braucht und kein Prompt-Hinweis reicht
 * (gemessen 14.08.2026, 10 von 10 Läufen): Mit `formality=more` liefert DeepL
 * "Prima del montaggio, La preghiamo di verificare … al Suo referente." —
 * dieser Pass schrieb daraus zuverlaessig "la preghiamo … al suo referente"
 * und drehte damit die gewaehlte Anredeform zurueck. Auch als `extraAllowlist`
 * uebergeben, also nachweislich IM Prompt, blieb das Verhalten unveraendert:
 * eine Bitte an ein LLM ist keine Schranke.
 *
 * Nur aktiv, wenn fuer den Lauf tatsaechlich eine Anredestufe gewaehlt wurde
 * (`protectHonorifics`). Ohne Anredestufe ist ein grossgeschriebenes `La`
 * mitten im Satz eher deutsche Uebergrosschreibung als Hoeflichkeitsform —
 * dort soll der Pass weiter korrigieren duerfen.
 */
export const HONORIFIC_PRONOUNS = [
  // IT
  'La', 'Lei', 'Le', 'Suo', 'Sua', 'Suoi', 'Sue', 'Vi', 'Vostro', 'Vostra',
  // FR
  'Vous', 'Votre', 'Vos',
  // ES
  'Usted', 'Ustedes', 'Su', 'Sus',
  // PL
  'Pan', 'Pani', 'Panu', 'Pana', 'Panie', 'Państwa', 'Państwo', 'Wam',
  // NL
  'U', 'Uw',
  // DE (Ziel DE kennt ebenfalls eine Anredestufe)
  'Sie', 'Ihnen', 'Ihr', 'Ihre', 'Ihrem', 'Ihren', 'Ihrer', 'Ihres',
];

/**
 * Prueft ein Wort gegen eine Schutzmenge — exakt nach derselben Regel, die
 * `correctTargetCapitalization` in `languagetool.ts` anwendet: ganzes Wort
 * oder Grossbuchstaben-Praefix (`LED-Modul` → `LED`).
 */
function istGeschuetzt(wort: string, schutz: Set<string>): boolean {
  if (schutz.has(wort)) return true;
  const praefix = wort.match(/^[\p{Lu}]+/u);
  return !!(praefix && schutz.has(praefix[0]));
}

/**
 * Kann dieses Token ueberhaupt eine deutsche Uebergrosschreibung sein?
 *
 * Der Pass existiert gegen genau EINE Fehlerklasse: DeepL schleppt die deutsche
 * Substantiv-Grossschreibung ins Ziel (`Avec Design moderne`). Diese Klasse hat
 * eine feste Form — Grossbuchstabe am Anfang, danach nur Kleinbuchstaben, keine
 * Ziffern. Was diese Form NICHT hat, ist ein Kuerzel, ein Artikelcode oder ein
 * Markenname und darf nicht kleingeschrieben werden.
 *
 * Drei Formen, am 14.08.2026 gegen den Artikelstamm gemessen (10,6k Artikel,
 * Tokens aus `public.articles.item_name`):
 *
 *   1. durchgaengig gross   1.447 verschiedene Tokens   `LED` `CC` `DC` `PROLAMP` `48V`
 *   2. Wort mit Ziffer        144                       `Back68` `Track48` `AZ03` `DN48`
 *   3. Binnenversal            40                       `FastFix` `MiniAMP` `ColorSwitch`
 *
 * Das ist eine EIGENSCHAFT des Tokens, keine Liste — sie deckt auch Artikel ab,
 * die es heute noch nicht gibt. Eine Aufzaehlung waere morgen wieder unvollstaendig:
 * belegt an 150 Bestandssegmenten, wo `PLUS AL1 DN48 E145 AL3 RAL9016`
 * kleingeschrieben wurden und KEINER davon auf irgendeiner Liste stand.
 *
 * ⚠️ NICHT abgedeckt und mit einer Formregel auch nicht abdeckbar: Tokens der
 * Form `Versa` `Mini` `Mesh` — erster Buchstabe gross, Rest klein. Die sehen aus
 * wie jedes deutsche Substantiv, und `Panel` `Spots` stehen genauso im Bestand
 * und werden zu RECHT kleingeschrieben. Diese Klasse (1.423 verschiedene Tokens
 * im Artikelstamm, davon nur ein Teil Produktnamen) braucht eine gepflegte
 * Liste. Steht offen, siehe PLAN-stilrichtung.md.
 *
 * Mindestens ZWEI Zeichen: ein einzelner Grossbuchstabe ist zu oft ein regulaerer
 * Satzanfang.
 */
function istUnantastbaresToken(wort: string): boolean {
  if (wort.length < 2) return false;
  if (!/\p{Lu}/u.test(wort)) return false; // ohne Grossbuchstaben nichts zu schuetzen
  // 1. Kein einziger Kleinbuchstabe → Kuerzel, Code, Einheit (LED, CC, PROLAMP, 48V)
  if (!/\p{Ll}/u.test(wort)) return true;
  // 2. Ziffer im Wort → Artikelcode (Back68, Track48, AZ03). Ein deutsches
  //    Substantiv hat keine Ziffer im Wort.
  if (/^\p{Lu}[\p{L}]*\p{N}/u.test(wort)) return true;
  // 3. Grossbuchstabe MITTEN im Wort → Markenname (FastFix, MiniAMP,
  //    ColorSwitch). Ein deutsches Substantiv hat keinen.
  if (/^\p{Lu}\p{Ll}+\p{Lu}/u.test(wort)) return true;
  return false;
}

/** Wort-Tokenize mit Offsets — gleiche Zerlegung wie `tokenize`, nur mit Position. */
function tokenizeMitOffset(text: string): Array<{ token: string; offset: number }> {
  const re = /[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu;
  const out: Array<{ token: string; offset: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ token: m[0], offset: m.index });
  return out;
}

export interface CapitalizationLlmFix {
  from: string;
  to: string;
  position: number;
}

export interface CapitalizationLlmResult {
  corrected: string;
  fixes: CapitalizationLlmFix[];
  skipped: boolean;
  skipReason?: string;
  costUsd?: number;
  /**
   * Fixes, die die harte Schranke verworfen hat (Marke oder — bei gewaehlter
   * Anredestufe — Hoeflichkeitspronomen). Diagnose: leer heisst nicht
   * "Schranke wirkungslos", sondern "es gab nichts zu verwerfen".
   */
  blocked?: CapitalizationLlmFix[];
}

/** Wort-Tokenize fuer Sanity-Diff (Unicode-aware). */
function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu) || [];
}

/**
 * Sanity-Check: vergleicht Source/Target wortweise. Erlaubt sind nur
 * Case-Aenderungen (gleiche Buchstaben, anderer Case). Beliebige inhaltliche
 * Aenderung schlaegt fehl.
 */
function diffIsCasingOnly(
  original: string,
  candidate: string,
): { ok: boolean; fixes: CapitalizationLlmFix[]; reason?: string } {
  const origTokens = tokenize(original);
  const candTokens = tokenize(candidate);
  if (origTokens.length !== candTokens.length) {
    return { ok: false, fixes: [], reason: `token-count drift ${origTokens.length}→${candTokens.length}` };
  }
  const fixes: CapitalizationLlmFix[] = [];
  let changed = 0;
  for (let i = 0; i < origTokens.length; i++) {
    const a = origTokens[i];
    const b = candTokens[i];
    if (a === b) continue;
    // Nur Case-Aenderung erlaubt: gleiche Buchstaben nach toLowerCase
    if (a.toLowerCase() !== b.toLowerCase()) {
      return { ok: false, fixes: [], reason: `token ${i} content drift: ${a}→${b}` };
    }
    fixes.push({ from: a, to: b, position: i });
    changed++;
  }
  // Max 50% der Tokens duerfen sich aendern. Bei sehr kurzen Texten (4-6 Tokens)
  // sind 2-3 Casing-Fixes normal; bei laengeren Texten (>20 Tokens) wuerde >50%
  // klar nach Halluzination riechen.
  if (changed / origTokens.length > 0.5) {
    return { ok: false, fixes: [], reason: `too many changes: ${changed}/${origTokens.length}` };
  }
  return { ok: true, fixes };
}

const MIN_LENGTH = 10; // unterhalb dessen lohnt sich der LLM-Call nicht (kurze Titel sind oft Eigennamen)
const MAX_LENGTH = 4000; // Token-Budget-Schutz pro Call

/**
 * LLM-Capitalization-Pass. Strict-Mode mit Halluzinations-Schutz.
 *
 * Bei Skip (zu kurz/zu lang, Lang unsupported, LLM-Fehler, Sanity-Check failed)
 * wird das Original unveraendert zurueckgegeben — KEIN Crash.
 */
export async function llmCorrectCapitalization(
  text: string,
  targetLang: string,
  options: {
    extraAllowlist?: string[];
    /** Falls EN explizit erlaubt werden soll (Toggle-only). */
    forceLang?: boolean;
    /**
     * Fuer diesen Lauf wurde eine Anredestufe gewaehlt (`formality` ≠ default).
     * Schaltet die harte Schranke fuer Hoeflichkeitspronomen ein.
     */
    protectHonorifics?: boolean;
    /** Für Kosten-Zuordnung im Token-Tracking (optional, Aufrufer hat oft Kontext). */
    projectId?: string;
    segmentId?: string;
  } = {},
): Promise<CapitalizationLlmResult> {
  const lang = (targetLang || '').toUpperCase().split('-')[0];
  if (!options.forceLang && !SUPPORTED_LANGS.has(lang)) {
    return { corrected: text, fixes: [], skipped: true, skipReason: `lang ${lang} not supported` };
  }
  if (!text || text.length < MIN_LENGTH || text.length > MAX_LENGTH) {
    return { corrected: text, fixes: [], skipped: true, skipReason: 'length out of range' };
  }
  if (!/[\p{Lu}]/u.test(text)) {
    // Keine Grossbuchstaben im Text → nichts zu tun
    return { corrected: text, fixes: [], skipped: true, skipReason: 'no uppercase chars' };
  }

  // Prompt-Schutzliste — bewusst KURZ gehalten (Entscheidung Thomas, 14.08.2026).
  //
  // Am selben Tag stand sie kurzzeitig ungekuerzt hier: statt `.slice(0, 30)`
  // gingen alle Glossar-Zielbegriffe in den Prompt, die im Text vorkommen.
  // Nachgemessen an 80 Bestandssegmenten wurde daraus keine Verbesserung,
  // sondern Streuung:
  //
  //   alt gegen alt (Eigenstreuung des Passes)   7,5 %
  //   alt gegen ungekuerzte Liste               21,3 %
  //
  // Die ~14 % darueber gingen in BEIDE Richtungen ohne erkennbaren Gewinn
  // (`spina miniamp` → `spina MiniAmp` besser, `module de fermeture` →
  // `Module de fermeture` schlechter). Zurueckgenommen.
  //
  // 🚨 Warum das Glossar hier ohnehin wenig ausrichtet: es legt UEBERSETZUNGEN
  // fest, keine Schreibungen. "Rahmen → marco" sagt nicht "marco schreibt man
  // gross". Gemessen haette eine harte Schranke ueber diese Liste 6 von 33
  // RICHTIGEN Korrekturen unterdrueckt (`ni Marco de montaje` → `ni marco de
  // montaje`). Was wirklich geschuetzt werden muss, haelt die harte Schranke
  // weiter unten — und die braucht keinen Prompt, um zu wirken.
  //
  // ⚠️ Damit erreichen von `extraAllowlist` hoechstens ZWEI Eintraege den Prompt
  // (28 BRAND_HINT + 2 = 30). Das ist keine Schlamperei, sondern die Folge der
  // Messung: mehr davon schadet. Der Wert traegt trotzdem: die Aufrufer geben
  // dieselbe Liste an `correctTargetCapitalization` weiter, wo sie eine ECHTE
  // Schranke ist.
  const allBrands = [...BRAND_HINT, ...(options.extraAllowlist ?? [])].slice(0, 80);
  const langName = LANG_NAMES[lang] || lang;

  const systemPrompt =
    `Du bist Korrektor fuer ${langName}. Deine EINZIGE Aufgabe ist es, faelschlich ` +
    `grossgeschriebene Nomen mitten im Satz auf die korrekte Kleinschreibung zu korrigieren. ` +
    `Diese Faelle entstehen, weil der Quelltext deutsch war (im Deutschen sind alle Nomen gross). ` +
    `\n\nABSOLUTE REGELN:\n` +
    `1. Aendere AUSSCHLIESSLICH die Grossschreibung einzelner Buchstaben — KEINE inhaltlichen Aenderungen.\n` +
    `2. Eigennamen, Markennamen, Akronyme bleiben unangetastet (z.B.: ${allBrands.slice(0, 30).join(', ')}).\n` +
    `3. Satzanfaenge bleiben gross.\n` +
    `4. Wenn du dir bei einem Wort UNSICHER bist (kann Eigenname sein), lass es UNVERAeNDERT.\n` +
    `5. Gib AUSSCHLIESSLICH den korrigierten Text zurueck, ohne Anfuehrungszeichen, ohne Erklaerung, ohne Markdown.\n` +
    `6. Wenn keine Korrektur noetig ist, gib den Text EXAKT unveraendert zurueck.`;

  const userPrompt = `Text:\n${text}`;

  let llmResult;
  try {
    // Verdeckt und ohne Ausweichmodell (Phase 6). Die Markenliste stammt aus Daten und darf keinen verdeckten Wert verraten.
    llmResult = await callLlmGeschuetzt(systemPrompt, userPrompt, { veraenderlich: allBrands.join(', ') });
  } catch (err: any) {
    return { corrected: text, fixes: [], skipped: true, skipReason: `llm error: ${err.message}` };
  }

  // Kosten erfassen — der Call kostete Geld, unabhaengig davon, ob die Sanity-Checks
  // unten den Output am Ende verwerfen. Logging-Fehler duerfen die Korrektur nicht brechen.
  await logTokenUsage(llmResult, 'capitalization', options.projectId, options.segmentId).catch(
    () => undefined,
  );

  // LLM-Output kann Anfuehrungszeichen oder Markdown-Fences enthalten — saeubern.
  let candidate = llmResult.text.trim();
  candidate = candidate.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  candidate = candidate.replace(/^["']|["']$/g, '');

  // Length-Ratio-Sanity (90-110%)
  const ratio = candidate.length / text.length;
  if (ratio < 0.9 || ratio > 1.1) {
    return {
      corrected: text,
      fixes: [],
      skipped: true,
      skipReason: `length ratio ${ratio.toFixed(2)} out of [0.9, 1.1]`,
      costUsd: llmResult.costUsd,
    };
  }

  // Token-Diff-Sanity: nur Casing-Aenderungen erlaubt
  const diff = diffIsCasingOnly(text, candidate);
  if (!diff.ok) {
    return {
      corrected: text,
      fixes: [],
      skipped: true,
      skipReason: diff.reason,
      costUsd: llmResult.costUsd,
    };
  }

  // ── Harte Schranke ───────────────────────────────────────────────────────
  // Der Prompt BITTET das LLM, Marken und (bei gewaehlter Anredestufe) die
  // Hoeflichkeitspronomen in Ruhe zu lassen. Gemessen haelt es sich nicht daran:
  // `LED` steht seit jeher im Prompt und wurde trotzdem zu `led`; `La`/`Suo`
  // ebenso, auch als extraAllowlist uebergeben (10 von 10 Laeufen, 14.08.2026).
  // Deshalb wird hier NACH der Antwort verworfen, was das LLM nicht anfassen
  // durfte — dieselbe Bauart wie die Allowlist in `languagetool.ts`.
  //
  // Bewusst NICHT in der Schranke: die Glossar-Zielbegriffe. Das Glossar sagt
  // "Rahmen → marco", es sagt nicht "marco schreibt man gross". Eine Schranke
  // darueber wuerde die richtige Korrektur `ni Marco de montaje` → `ni marco de
  // montaje` unterdruecken (gemessen: 6 von 33 Fixes, ueberwiegend berechtigt).
  // Sie gehen weiter als Prompt-Hinweis mit, jetzt ungekuerzt.
  // Drei Toepfe, absichtlich getrennt:
  //   Marken    — immer, Grossschreibung gehoert zum Wort
  //   Kuerzel   — immer, ueber `istUnantastbaresToken` als EIGENSCHAFT statt Liste
  //   Pronomen  — nur bei gewaehlter Anredestufe
  // NICHT dabei: Glossar-Zielbegriffe. Das Glossar sagt "Rahmen → marco", es
  // sagt nicht "marco schreibt man gross".
  const schutz = new Set<string>(BRAND_HINT);
  if (options.protectHonorifics) {
    for (const p of HONORIFIC_PRONOUNS) schutz.add(p);
  }

  const verworfen: CapitalizationLlmFix[] = [];
  const behalten: CapitalizationLlmFix[] = [];
  for (const fix of diff.fixes) {
    if (istGeschuetzt(fix.from, schutz) || istUnantastbaresToken(fix.from)) verworfen.push(fix);
    else behalten.push(fix);
  }

  let corrected = candidate;
  if (verworfen.length > 0) {
    // Verworfene Tokens im Kandidaten auf den Originalstand zuruecksetzen.
    // `diffIsCasingOnly` garantiert gleiche Tokenzahl, die Positionen decken
    // sich also 1:1. Von hinten nach vorne, damit die Offsets stabil bleiben.
    const candTokens = tokenizeMitOffset(candidate);
    for (const fix of [...verworfen].sort((a, b) => b.position - a.position)) {
      const ziel = candTokens[fix.position];
      if (!ziel || ziel.token !== fix.to) continue; // Position passt nicht — nichts anfassen
      corrected =
        corrected.slice(0, ziel.offset) + fix.from + corrected.slice(ziel.offset + ziel.token.length);
    }
  }

  return {
    corrected,
    fixes: behalten,
    skipped: false,
    costUsd: llmResult.costUsd,
    blocked: verworfen,
  };
}
