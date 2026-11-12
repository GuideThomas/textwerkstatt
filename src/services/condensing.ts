import { config } from '../config';
import { pool } from '../db/connection';
import { normalizeGlossaryLang } from './lang';
import { callLlmNamen, logTokenUsage } from './llm';
import type { LlmResult } from './llm';
import { begriffeHinweis, begriffeImText, fehlendeBegriffe } from './begriffe-im-text';
import type { Begriff } from './begriffe-im-text';

export interface CondenseCandidate {
  segmentId: string;
  sourceText: string;
  translatedText: string;
  maxChars: number | null;
  projectId: string;
}

export interface CondenseResult {
  segmentId: string;
  condensedText: string | null;
  status: 'ok' | 'condensed' | 'still_long' | 'manual_review';
  attempts: number;
  totalCostUsd: number;
}

export const LANGUAGE_NAMES: Record<string, string> = {
  DE: 'Deutsch', EN: 'Englisch', IT: 'Italienisch', FR: 'Franzoesisch',
  ES: 'Spanisch', NL: 'Niederlaendisch', PL: 'Polnisch', CS: 'Tschechisch',
  CZ: 'Tschechisch', HU: 'Ungarisch', SK: 'Slowakisch',
};

/**
 * Die Dimmbarkeit, wie der SAP-Bestand sie je Sprache schreibt (gezählt 03.11.2026).
 *
 * 🚨 Hier stand seit 29.10.2026 für alle Sprachen das Beispiel „dimmable" im Prompt. Alle
 * 46 Namen außerhalb von EN und FR, die dieses Wort tragen (PL 35, CZ 10, ES 1), stammen aus
 * der Lieferung vom 30.10. Ein Beispiel im Prompt ist ein Vorschlag, und er wurde angenommen.
 */
const DIMMWORT: Record<string, string> = {
  EN: 'dimmable', FR: 'dimmable', IT: 'dimmerabile', ES: 'regulable', HU: 'dimmelhető',
  PL: 'z regulacją jasności', CZ: 's možností stmívání', CS: 's možností stmívání', SK: 'stmievateľné',
};

/**
 * Zeichengrenze, die tatsächlich gilt: der IDML-Schätzwert, aber nie weniger
 * als Quelllänge × Condensing-Schwelle (Vorgabe 115 %).
 *
 * Der Schätzwert aus spreads.ts (Rahmenbreite ÷ 6 pt × Höhe ÷ 14 pt) kennt
 * weder Schriftgröße noch Spalten noch verkettete Rahmen und lag im Review
 * einer Bedienungsanleitung (16.09.2026) bei 41 Zeichen für einen deutschen
 * Absatz mit 78 — der nachweislich in den Rahmen passt. Das LLM kürzte die
 * englische Übersetzung darauf zusammen, bis sie sinnlos war. Eine Grenze
 * unter der Länge des Originals kann nicht stimmen.
 *
 * Ohne maxChars bleibt es bei null; der Verhältnis-Check in needsCondensing()
 * greift dann wie bisher.
 */
export function effectiveMaxChars(sourceText: string, maxChars: number | null): number | null {
  if (!maxChars) return null;
  const floor = Math.ceil(sourceText.length * config.llm.condensingThreshold);
  return Math.max(maxChars, floor);
}

/**
 * Prüft ob ein Segment Condensing braucht.
 * Kriterien: Übersetzung > 115% der Quelllänge ODER > maxChars.
 */
export function needsCondensing(
  sourceText: string,
  translatedText: string,
  maxChars: number | null,
): boolean {
  // Einzelwoerter und kurze Labels (z.B. "Abdeckung, Seite 64", "Prizma")
  // NICHT kuerzen. Das LLM erzeugt sonst sinnlose Abkuerzungen mit erfundenen
  // Satzzeichen ("oldal" -> "O.", "Seite" -> "S.,") und verstuemmelt den Text.
  // Bei so kurzen Segmenten ist ein leichter Box-Ueberlauf das kleinere Uebel
  // (der Designer korrigiert in InDesign per Schriftgroesse/Boxbreite).
  const wordCount = (sourceText.trim().match(/\S+/g) || []).length;
  if (wordCount <= 2) {
    return false;
  }

  // maxChars hat Prioritaet (aus IDML-Textbox-Größe), aber nie unter der
  // Quelllänge — siehe effectiveMaxChars()
  const limit = effectiveMaxChars(sourceText, maxChars);
  if (limit && translatedText.length > limit) {
    return true;
  }
  // Fallback: Längen-Verhältnis prüfen. Zusaetzlich ein absoluter Mindest-
  // Ueberhang, damit nicht schon 9->11 Zeichen als "zu lang" gewertet werden
  // (bei kurzen Texten ueberschreitet ein einzelnes laengeres Wort sonst die
  // 115%-Schwelle, ohne dass echtes Kuerzen sinnvoll waere).
  const ratio = translatedText.length / sourceText.length;
  return ratio > config.llm.condensingThreshold
    && translatedText.length - sourceText.length >= 12;
}

/**
 * Berechnet die Ziellänge für Condensing.
 */
function getTargetLength(sourceText: string, maxChars: number | null): number {
  const limit = effectiveMaxChars(sourceText, maxChars);
  if (limit) return limit;
  // Wenn keine maxChars: Ziellänge = Quelllänge (1:1)
  return sourceText.length;
}

/**
 * Baut den Condensing-Prompt zusammen.
 */
export function buildCondensingPrompt(
  targetLang: string,
  sourceText: string,
  translatedText: string,
  targetLength: number,
  begriffe?: Begriff[],
  retryHint?: string,
): { system: string; user: string } {
  const langName = LANGUAGE_NAMES[targetLang.toUpperCase()] || targetLang;

  // Nur die Glossarbegriffe, die in DIESER Übersetzung stehen (`begriffe-im-text.ts`). Bis 11.11.2026 stand hier die
  // alphabetisch erste Hundertschaft des Glossars, unabhängig vom Text.
  const glossarHint = begriffeHinweis(begriffe ?? []);

  const dimmwort = DIMMWORT[targetLang.toUpperCase()];
  const dimmHinweis = dimmwort ? ` (Dimmbarkeit: „${dimmwort}")` : '';

  const system = `Du bist ein professioneller technischer Redakteur für ${langName}.
Deine einzige Aufgabe: Eine bestehende Übersetzung verkürzen, OHNE die Bedeutung zu verändern.

ABSOLUTE REGELN:
- Verwende NUR Wörter und Konzepte, die schon in der gegebenen Übersetzung vorkommen.
- Erfinde NICHTS dazu. Keine neuen Beispiele, keine Zitate, keine Füllsätze.
- Füge KEINE neuen Satzzeichen (Punkte, Kommas) hinzu, die nicht schon in der Übersetzung stehen.
- Entferne KEINE Kommas. Die Kommas gliedern die technischen Merkmale und müssen exakt erhalten bleiben — kürze stattdessen Wörter (Füllwörter weglassen, Fachbegriffe abkürzen).
- Erzeuge KEINE neuen Abkürzungen mit Punkt (z.B. nicht "Seite" → "S." oder "oldal" → "O."), wenn die abgekürzte Form nicht schon in der Übersetzung steht.
- Die Angaben am ENDE des Textes (Maße, Längen, Leistungen, IP-Klassen, Farbtemperaturen, Lichtfarbe, Dimmbarkeit, Typbezeichnungen) müssen unverändert am Ende stehen bleiben. Kürze ausschliesslich den Teil DAVOR.
- Die Dimmbarkeit und die Lichtfarbe dürfen NIE wegfallen — auch nicht, wenn sie das letzte Wort sind. Sie stehen auf ${langName}${dimmHinweis}, nie auf Deutsch und nie in einer anderen Sprache.
- Der Quelltext dient nur dem Verständnis. Übernimm KEIN Wort daraus, das nicht in der Übersetzung steht — ausgenommen Kennungen wie DALI, Push/DALI oder 1-10V.
- Wenn du den Text nicht sinnvoll kürzen kannst, gib die Übersetzung 1:1 zurück.
- Antworte NUR mit dem gekürzten Text — keine Erklärung, kein Markdown, keine Anführungszeichen.${glossarHint}`;

  const user = `Quelltext (Original):
${sourceText}

Übersetzung (bereits ${langName}, diese soll gekürzt werden):
${translatedText}

Ziel: maximal ${targetLength} Zeichen.

Liefere die gekürzte Version der OBIGEN Übersetzung. Beibehalten: alle Eigennamen, Produktnamen, Zahlen, Einheiten, Fachbegriffe — und zwar an ihrer bisherigen Stelle. Was am Ende steht, bleibt am Ende.${retryHint ? `

${retryHint}` : ''}`;

  return { system, user };
}

/**
 * Halluzinations-Sanity-Check.
 *
 * Vergleicht den gekürzten Text mit der Original-Übersetzung. Wenn fast kein
 * Wort-Overlap besteht, ist der Output mit hoher Wahrscheinlichkeit eine
 * Halluzination (LLM hat einen komplett neuen Satz erfunden statt zu kürzen).
 *
 * Beispiel: DeepL-Übersetzung "There are 40 dynamic modes including ..."
 * LLM-Output "But since I've decided to leave, those who live or wish to live..."
 * → 0 gemeinsame Inhaltswörter → Halluzination.
 *
 * @returns true wenn der Output verdaechtig ist und VERWORFEN werden sollte
 */
export function looksHallucinated(translatedText: string, condensedText: string): boolean {
  if (!condensedText || condensedText.length === 0) return true;

  // Halluzinationen sind meist genauso lang ODER laenger als das Original
  // (LLM ersetzt einen Satz durch einen anderen Satz). Echte Kuerzungen sind
  // immer DEUTLICH kuerzer. Wenn das "Kuerzungsergebnis" ueber 90% der
  // Originallaenge hat, ist es verdaechtig.
  const lengthRatio = condensedText.length / translatedText.length;

  // FRUEHER wurde lengthRatio < 0.9 blind als "echte Kuerzung" durchgewunken und
  // der Wort-Overlap-Check uebersprungen. DAS war die Luecke (Vorfall 18.06.2026):
  // ein vertauschter LiteLLM-Semantic-Cache-Treffer aus ANDERER Sprache/anderem
  // Produkt (HU-Hebelklemme -> SK-Gelbox, ratio 0.84) ist auch kuerzer und rutschte
  // ungeprueft durch. Jetzt wird der Overlap AUCH bei kuerzeren Outputs geprueft —
  // eine echte Kuerzung ist eine Teilmenge des Originals (Overlap ~1.0), ein
  // Cross-Sprache/Produkt-Treffer hat ~0 Overlap. Schwelle unten laengenabhaengig.

  // Wenn deutlich laenger als Original — Halluzination
  if (lengthRatio > 1.5) return true;

  // Bei kurzen Texten (<40 Zeichen) ist Token-Overlap unzuverlaessig — wir
  // verzichten dann auf den Check (Risiko der Halluzination dort sehr gering,
  // weil DeepL-Output sowieso schon kurz ist und nicht gekuerzt werden muss).
  if (translatedText.length < 40 || condensedText.length < 40) return false;

  // Token-Overlap fuer aehnlich-lange Texte (echte Kuerzung waere DEUTLICH kuerzer).
  // Hier gilt: Sun-Tzu-Filler hat 0% Overlap, legitime Umformulierungen >60%.
  const tokens = (s: string): Set<string> => {
    const matches = s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
    return new Set(matches);
  };

  const orig = tokens(translatedText);
  const cond = tokens(condensedText);
  if (orig.size < 3 || cond.size < 3) return false;

  // Substring-Match: wenn ein Cond-Token ein Praefix eines Orig-Tokens ist,
  // gilt es als Match (Abkuerzung: "Tens" ist Praefix von "Tensione")
  let common = 0;
  for (const t of cond) {
    if (orig.has(t)) { common++; continue; }
    // Praefix-Match (Abkuerzung) — Cond-Token >=3 Zeichen muss Praefix eines
    // Orig-Tokens sein
    if (t.length >= 3) {
      for (const o of orig) {
        if (o.startsWith(t) || t.startsWith(o)) { common++; break; }
      }
    }
  }
  const overlapRatio = common / cond.size;

  // Schwelle laengenabhaengig:
  //  - aehnliche Laenge (ratio >= 0.9): echte Kuerzung selten, behaelt meist >70%
  //    Overlap -> 0.25 (faengt Sun-Tzu-Filler).
  //  - deutliche Kuerzung (ratio < 0.9): mehr Wortdrops erlaubt, aber eine legitime
  //    Kuerzung ist Teilmenge des Originals (Overlap ~1.0); ~0 Overlap = Cross-
  //    Sprache/Produkt -> Floor 0.15 (faengt vertauschte Cache-Treffer).
  const threshold = lengthRatio < 0.9 ? 0.15 : 0.25;
  return overlapRatio < threshold;
}

/**
 * Satzzeichen-Sanity-Check.
 *
 * Eine echte Kürzung entfernt Wörter, fügt aber niemals neue Punkte oder Kommas
 * hinzu. Wenn der gekürzte Text MEHR Punkte oder Kommas als das Original hat,
 * hat das LLM Abkürzungen ("Seite" → "S.") oder Aufzählungs-Kommas erfunden —
 * das wollen wir nicht (Beschwerde 01.06.2026: erfundene Punkte/Beistriche im
 * übersetzten Dokument).
 *
 * @returns true wenn der Output neue Satzzeichen einführt und VERWORFEN werden sollte
 */
/**
 * Legitime Abkuerzung? `raffredd.` ist eine Kuerzung von `raffreddamento` —
 * das Wort vor dem Punkt muss mindestens 4 Zeichen haben UND Praefix eines
 * laengeren Wortes aus der Original-Uebersetzung sein.
 *
 * Damit bleibt der Schutz gegen die erfundenen Ein-/Zwei-Buchstaben-Abkuerzungen
 * aus dem Vorfall 20.05.2026 (`oldal` → `O.`, `Seite` → `S.`) erhalten, waehrend
 * fachlich korrekte Kuerzungen durchgehen. Vorher wurde JEDER neue Punkt
 * verworfen — das war die Ursache fuer 144 hart abgeschnittene Artikelnamen
 * (Befund 21.07.2026).
 */
function isLegitAbbreviation(word: string, translatedText: string): boolean {
  if (word.length < 4) return false;
  const lower = word.toLowerCase();
  const origWords = translatedText.toLowerCase().match(/\p{L}{4,}/gu) || [];
  return origWords.some((o) => o.length > lower.length && o.startsWith(lower));
}

export function addsNewPunctuation(translatedText: string, condensedText: string): boolean {
  const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

  // Neue Kommas bleiben verboten — eine Kuerzung erfindet keine Aufzaehlung.
  if (count(condensedText, /,/g) > count(translatedText, /,/g)) return true;

  // Punkte: Abkuerzungspunkte hinter einem erkennbaren Wortstamm nicht mitzaehlen.
  const legitAbbrevDots = [...condensedText.matchAll(/(\p{L}{4,})\./gu)].filter((m) =>
    isLegitAbbreviation(m[1], translatedText),
  ).length;

  return count(condensedText, /\./g) - legitAbbrevDots > count(translatedText, /\./g);
}

/**
 * Entfernt die Kuerzung Kommas? In Artikelnamen gliedern Kommas die technischen
 * Merkmale (`948x25x13,4mm, 24V DC, 7500K`) und muessen wie im deutschen Original
 * erhalten bleiben (Vorgabe Thomas, 21.07.2026). Das LLM sparte sie zuvor als
 * billigste Kuerzung weg.
 *
 * Dezimalkommas (`13,4`) zaehlen nicht mit — die stehen zwischen Ziffern.
 */
export function removesCommas(translatedText: string, condensedText: string): boolean {
  const structural = (s: string): number => (s.match(/,(?!\d)/g) || []).length;
  return structural(condensedText) < structural(translatedText);
}

/**
 * Wörter der Kürzung, die in eine andere Sprache gehören: aus dem deutschen Quelltext kopiert
 * (nicht in der Übersetzung, wohl aber im Quelltext) oder „dimmable" außerhalb von EN und FR.
 *
 * Anlass 03.11.2026: 115173 PL, DeepL schrieb „z regulacją jasności za pomocą przycisku lub
 * protokołu DALI", das Modell kürzte auf „Push/DALI dimmbar". Kennungen (`DALI`, `Push/DALI`)
 * zählen nicht, Abkürzungen eines Worts der Übersetzung auch nicht („Alu" für „aluminiowa").
 * Der Assistent prüft dasselbe selbst noch einmal (`pruefeKuerzung`); hier geht es um den
 * zweiten Versuch, solange das Modell noch gefragt werden kann.
 */
export function fremdeWoerter(sourceText: string, translatedText: string, condensedText: string, targetLang: string): string[] {
  const teile = (s: string): string[] => (s.match(/[^\s,;:()"„“”«»]+/gu) || []).map((t) => t.replace(/^[.'’]+|[.'’]+$/gu, ''));
  const inUebersetzung = teile(translatedText).map((w) => w.toLowerCase());
  const imQuelltext = new Set(teile(sourceText).map((w) => w.toLowerCase()));
  const dimmableFremd = !['EN', 'FR'].includes(targetLang.toUpperCase());
  return teile(condensedText).filter((w) => {
    if (!/^\p{L}{3,}$/u.test(w) || /\p{Lu}.*\p{Lu}/u.test(w)) return false;
    const klein = w.toLowerCase();
    if (inUebersetzung.some((v) => v.startsWith(klein))) return false;
    return imQuelltext.has(klein) || (dimmableFremd && klein === 'dimmable');
  });
}

export interface GrenzKuerzung {
  condensedText: string;
  attempts: number;
  status: 'condensed' | 'still_long' | 'manual_review';
  charactersUsed: number;
  /** Nur wenn das Sprachmodell nicht antworten konnte. Der Aufrufer macht den Notweg damit sichtbar. */
  grund?: 'budget' | 'llm_fehler';
}

/**
 * Das erste Wort eines Artikelnamens, das keine Kennung ist — meist das Produktwort („Faretto“, „Lámpara“, „Panel“).
 * Kennung heißt: enthält eine Ziffer, ist ganz groß geschrieben („LED“, „DALI“, „RGBW“) oder hat keinen Buchstaben.
 *
 * 🚨 Anlass (11.11.2026, Live-Aufruf nach dem Umstieg auf gpt-5.6-luna): „Faretto da incasso LED BACK45 rotondo per
 * controsoffitti in cartongesso“ wurde zu „incasso LED BACK45 rotondo cartongesso“, das Produktwort war weg, und die
 * Glossarprüfung sah es nicht, weil „Einbaustrahler“ in keinem Glossar steht. Im Modellvergleich ebenso: „Lámpara LED
 * empotrable Back68“ → „LED Back68“, „Temperatura barwowa …“ → „barwowa fal“. Entscheid Thomas 12.11.2026: Regel im Code.
 *
 * ⚠️ Grenze: In EN, HU, CZ und SK steht das Hauptwort oft hinten („LED mennyezeti lámpa“); dort schützt die Regel das erste
 * Beiwort, nicht das Hauptwort.
 */
export function produktwort(name: string): string | null {
  // Auch am Bindestrich trennen: In „LED-panel-készlet“ ist „LED“ Kennung und „panel“ das Produktwort.
  for (const w of name.split(/[\s,;:()/|\-‐–]+/u)) {
    const t = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!/\p{L}/u.test(t) || /\d/.test(t)) continue;
    if (t.length > 1 && t === t.toUpperCase()) continue;
    if (t.length < 3) continue;
    return t;
  }
  return null;
}

/** Steht das Produktwort des Originals noch im Ergebnis (groß/klein egal, als eigenes Wort am Anfang)? */
export function behaeltProduktwort(original: string, ergebnis: string): boolean {
  const p = produktwort(original);
  if (!p) return true;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu').test(ergebnis);
}

/**
 * Kürzen auf eine HARTE Grenze — die Logik hinter `POST /api/condense`
 * (Artikelnamen des Artikelanlage-Assistenten, 100 Zeichen).
 *
 * 🚨 BIS 29.10.2026 PRÜFTE DIESE ROUTE DIE KOMMAS NICHT. Der Prompt verbietet seit
 * 21.07.2026, sie zu streichen, und `condenseSegment()` (Dokumente) hält das mit
 * `removesCommas()` und einem zweiten Versuch nach. Die Route übernahm dagegen jede
 * passende Antwort. Gezählt an 4.627 gelieferten Artikelnamen: 581 ohne ein
 * einziges Komma, und in 66 von 82 Namen, denen „dimmbar" fehlte, waren auch die
 * Kommas weg. Eine Bitte an das Modell ist keine Schranke.
 *
 * Jetzt dieselben drei Kriterien wie in `condenseSegment()`: gültig (keine
 * Halluzination, keine erfundenen Satzzeichen), passt, behält die Kommas. Ein
 * Ergebnis ohne Kommas wird NIE als `condensed` zurückgegeben — reicht kein
 * Versuch, kommt `manual_review` mit der Original-Übersetzung, und der Aufrufer
 * kürzt selbst.
 *
 * `llm` ist austauschbar, damit sich die Schranken ohne Modell prüfen lassen
 * (`scripts/condense-grenze.test.mjs`).
 */
export async function condenseAufGrenze(
  eingabe: {
    sourceText: string;
    translatedText: string;
    targetLang: string;
    maxChars: number;
    /** Alle Paare des Sprachpaars (`ladeBegriffe`); gefiltert wird hier auf die, die zu diesem Namen passen. */
    begriffe?: Begriff[];
  },
  llm: (system: string, user: string) => Promise<LlmResult>,
  nachAufruf?: (r: LlmResult) => Promise<void>,
): Promise<GrenzKuerzung> {
  const { sourceText, translatedText, targetLang, maxChars } = eingabe;
  const paare = begriffeImText(sourceText, translatedText, eingabe.begriffe ?? []);
  let verbraucht = 0;
  const bewerte = (text: string) => ({
    text,
    valid: !looksHallucinated(translatedText, text) && !addsNewPunctuation(translatedText, text),
    fits: text.length <= maxChars,
    keepsCommas: !removesCommas(translatedText, text),
    fremd: fremdeWoerter(sourceText, translatedText, text, targetLang),
    // Ein Glossarbegriff, der in der Übersetzung stand, muss im Ergebnis stehen (Entscheid Thomas 11.11.2026).
    // Und das Produktwort am Anfang bleibt (Entscheid Thomas 12.11.2026, `produktwort`). Es zählt wie ein fehlender Begriff.
    fehlt: [...fehlendeBegriffe(text, paare), ...(behaeltProduktwort(translatedText, text) ? [] : [produktwort(translatedText)!])],
  });
  const versuch = async (ziel: number, hinweis?: string) => {
    const p = buildCondensingPrompt(targetLang, sourceText, translatedText, ziel, paare, hinweis);
    const r = await llm(p.system, p.user);
    verbraucht += (r.inputTokens || 0) + (r.outputTokens || 0);
    if (nachAufruf) await nachAufruf(r).catch(() => undefined);
    return bewerte(r.text);
  };
  let grund: GrenzKuerzung['grund'];
  const merkeGrund = (err: any) => { grund = err?.kind === 'budget' ? 'budget' : 'llm_fehler'; };
  const original = (attempts: number): GrenzKuerzung => ({
    condensedText: translatedText,
    attempts,
    status: 'manual_review',
    charactersUsed: verbraucht,
    ...(grund ? { grund } : {}),
  });

  let c1: ReturnType<typeof bewerte>;
  try {
    c1 = await versuch(maxChars);
  } catch (err: any) {
    console.error('[Condense] LLM failed (attempt 1):', err.message);
    merkeGrund(err);
    return original(1);
  }
  if (c1.valid && c1.fits && c1.keepsCommas && c1.fremd.length === 0 && c1.fehlt.length === 0) {
    return { condensedText: c1.text, attempts: 1, status: 'condensed', charactersUsed: verbraucht };
  }
  if (!c1.valid) {
    console.warn(
      `[Condense] Verworfen (Halluzination/erfundene Satzzeichen) ${targetLang}: ` +
        `original="${translatedText.slice(0, 60)}…" → output="${c1.text.slice(0, 60)}…"`,
    );
  }

  // Versuch 2 — der Grund bestimmt Ziellänge und Hinweis (wie `condenseSegment`).
  const kuerzer = !c1.valid || !c1.fits;
  const hinweis = !c1.valid
    ? undefined
    : c1.fremd.length > 0
      ? `WICHTIG: Dein vorheriger Versuch enthielt Wörter aus einer anderen Sprache: ${c1.fremd.join(', ')}. Verwende nur Wörter der Übersetzung und kürze andere.`
      : c1.fehlt.length > 0
        ? `WICHTIG: Dein vorheriger Versuch hat Fachbegriffe oder das Produktwort verändert oder gestrichen: ${c1.fehlt.map((b) => `„${b}“`).join(', ')}. Behalte sie genau so und kürze andere Wörter.`
      : !c1.keepsCommas
        ? 'WICHTIG: Dein vorheriger Versuch hat Kommas entfernt. Behalte JEDES Komma der Übersetzung — kürze stattdessen Wörter.'
        : 'WICHTIG: Dein vorheriger Versuch war noch zu lang. Kürze Wörter weiter, aber behalte alle Kommas, Zahlen und Einheiten.';
  let c2: ReturnType<typeof bewerte> | null = null;
  try {
    c2 = await versuch(kuerzer ? Math.max(1, Math.floor(maxChars * 0.9)) : maxChars, hinweis);
  } catch (err: any) {
    console.error('[Condense] LLM failed (attempt 2):', err.message);
    merkeGrund(err);
  }
  const attempts = c2 ? 2 : 1;

  // Nur gültige Kandidaten MIT allen Kommas und ohne fremde Wörter zählen. Passt einer →
  // condensed; sonst der kürzeste → still_long (der Aufrufer kürzt ihn); sonst Original.
  const brauchbar = [c2, c1].filter(
    (c): c is NonNullable<typeof c> => !!c && c.valid && c.keepsCommas && c.fremd.length === 0 && c.fehlt.length === 0,
  );
  const passt = brauchbar.find((c) => c.fits);
  if (passt) return { condensedText: passt.text, attempts, status: 'condensed', charactersUsed: verbraucht };
  const kuerzester = brauchbar
    .filter((c) => c.text.length < translatedText.length)
    .sort((a, b) => a.text.length - b.text.length)[0];
  if (kuerzester) {
    return { condensedText: kuerzester.text, attempts, status: 'still_long', charactersUsed: verbraucht };
  }
  if ([c1, c2].some((c) => c && c.valid && !c.keepsCommas)) {
    console.warn(`[Condense] ${targetLang}: Kürzung strich Kommas — verworfen, Original zurück`);
  }
  return original(attempts);
}

/**
 * Smart Condensing für ein einzelnes Segment.
 * Max 2 Versuche mit progressiv strengerem Limit.
 */
export async function condenseSegment(
  candidate: CondenseCandidate,
  targetLang: string,
  alleBegriffe?: Begriff[],
): Promise<CondenseResult> {
  const targetLength = getTargetLength(candidate.sourceText, candidate.maxChars);
  let totalCost = 0;
  let attempts = 0;
  const paare = begriffeImText(candidate.sourceText, candidate.translatedText, alleBegriffe ?? []);

  // Versuch 1: Normales Limit
  const prompt1 = buildCondensingPrompt(
    targetLang, candidate.sourceText, candidate.translatedText,
    targetLength, paare,
  );

  let result: LlmResult;
  try {
    result = await callLlmNamen(prompt1.system, prompt1.user);
  } catch (err: any) {
    console.error(`[Condensing] LLM failed for segment ${candidate.segmentId}: ${err.message}`);
    return {
      segmentId: candidate.segmentId,
      condensedText: null,
      status: 'manual_review',
      attempts: 1,
      totalCostUsd: 0,
    };
  }

  attempts = 1;
  totalCost += result.costUsd;

  await logTokenUsage(result, 'condense', candidate.projectId, candidate.segmentId);

  // Ein Kandidat wird nach drei Kriterien bewertet:
  //  valid       — keine Halluzination, keine erfundenen Satzzeichen (harte Sperre)
  //  fits        — innerhalb der Ziellaenge
  //  keepsCommas — Komma-Gliederung wie im Original erhalten (Vorgabe 21.07.2026)
  const evaluate = (text: string) => ({
    text,
    valid:
      !looksHallucinated(candidate.translatedText, text) &&
      !addsNewPunctuation(candidate.translatedText, text),
    fits: text.length <= targetLength,
    keepsCommas: !removesCommas(candidate.translatedText, text),
    keepsBegriffe: fehlendeBegriffe(text, paare).length === 0,
  });

  const c1 = evaluate(result.text);

  // Perfekter Treffer im ersten Versuch — fertig.
  if (c1.valid && c1.fits && c1.keepsCommas && c1.keepsBegriffe) {
    await saveCondensedText(candidate.segmentId, c1.text);
    return {
      segmentId: candidate.segmentId,
      condensedText: c1.text,
      status: 'condensed',
      attempts,
      totalCostUsd: totalCost,
    };
  }

  if (!c1.valid) {
    console.warn(
      `[Condensing] Versuch 1 verworfen für Segment ${candidate.segmentId} ` +
        `(Halluzination/erfundene Satzzeichen): ` +
        `original="${candidate.translatedText.slice(0, 60)}…" → ` +
        `output="${result.text.slice(0, 60)}…"`,
    );
  }

  // Versuch 2 — der Grund bestimmt Ziellaenge und Hinweis:
  //  zu lang        → 10% strenger
  //  Kommas fehlen  → gleiche Laenge, aber expliziter Hinweis
  const needsShorter = !c1.valid || !c1.fits;
  const stricterLength = needsShorter ? Math.floor(targetLength * 0.9) : targetLength;
  const retryHint = !c1.valid
    ? undefined
    : !c1.keepsBegriffe
      ? `WICHTIG: Dein vorheriger Versuch hat Glossarbegriffe verändert oder gestrichen: ${fehlendeBegriffe(c1.text, paare).map((b) => `„${b}“`).join(', ')}. Behalte sie genau so und kürze andere Wörter.`
    : !c1.keepsCommas
      ? 'WICHTIG: Dein vorheriger Versuch hat Kommas entfernt. Behalte JEDES Komma der Übersetzung — kürze stattdessen Wörter.'
      : 'WICHTIG: Dein vorheriger Versuch war noch zu lang. Kürze Wörter weiter, aber behalte alle Kommas, Zahlen und Einheiten.';
  const prompt2 = buildCondensingPrompt(
    targetLang, candidate.sourceText, candidate.translatedText,
    stricterLength, paare, retryHint,
  );

  let c2: ReturnType<typeof evaluate> | null = null;
  try {
    result = await callLlmNamen(prompt2.system, prompt2.user);
    attempts = 2;
    totalCost += result.costUsd;
    await logTokenUsage(result, 'condense', candidate.projectId, candidate.segmentId);
    c2 = evaluate(result.text);
    if (!c2.valid) {
      console.warn(
        `[Condensing] Versuch 2 verworfen für Segment ${candidate.segmentId} ` +
          `(Halluzination/erfundene Satzzeichen)`,
      );
    }
  } catch (err: any) {
    console.error(
      `[Condensing] LLM-Fehler im 2. Versuch für Segment ${candidate.segmentId}: ${err.message}`,
    );
  }

  // Bestes gueltiges Ergebnis waehlen. Rangfolge:
  //   1. passt UND behaelt Kommas
  //   2. passt (Kommas verloren — vollstaendiger Text schlaegt Komma-Treue,
  //      weil die Alternative ein hart abgeschnittener Name waere)
  //   3. kuerzester gueltiger Text → still_long, der Aufrufer kuerzt hart
  // WICHTIG: Versuch 1 bleibt als Fallback im Rennen. Frueher verwarf ein
  // schlechter zweiter Versuch auch ein brauchbares erstes Ergebnis.
  const valid = [c2, c1].filter((c): c is NonNullable<typeof c> => !!c && c.valid);
  // Glossarbegriffe gehen vor Kommas: ein verändertes Fachwort ist ein falscher Name, ein fehlendes Komma nur Gliederung.
  const best =
    valid.find((c) => c.fits && c.keepsCommas && c.keepsBegriffe) ??
    valid.find((c) => c.fits && c.keepsBegriffe) ??
    valid.find((c) => c.fits && c.keepsCommas) ??
    valid.find((c) => c.fits) ??
    valid.sort((a, b) => a.text.length - b.text.length)[0];

  if (!best) {
    return {
      segmentId: candidate.segmentId,
      condensedText: null,
      status: 'manual_review',
      attempts,
      totalCostUsd: totalCost,
    };
  }

  if (best.fits && !best.keepsCommas) {
    console.warn(
      `[Condensing] Segment ${candidate.segmentId}: Kürzung passt, aber Kommas gingen ` +
        `verloren (vollständiger Text bevorzugt gegenüber hartem Abschneiden): "${best.text.slice(0, 60)}…"`,
    );
  }
  if (!best.fits) {
    console.warn(
      `[Condensing] Segment ${candidate.segmentId}: still_long — bestes Ergebnis ` +
        `${best.text.length} Zeichen bei Ziel ${targetLength}. Der Aufrufer kürzt hart.`,
    );
  }

  await saveCondensedText(candidate.segmentId, best.text);

  return {
    segmentId: candidate.segmentId,
    condensedText: best.text,
    status: best.fits ? 'condensed' : 'still_long',
    attempts,
    totalCostUsd: totalCost,
  };
}

/**
 * Batch-Condensing für alle Segmente die zu lang sind.
 */
export async function condenseSegments(
  candidates: CondenseCandidate[],
  targetLang: string,
  alleBegriffe?: Begriff[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ results: CondenseResult[]; totalCost: number }> {
  const results: CondenseResult[] = [];
  let totalCost = 0;

  for (let i = 0; i < candidates.length; i++) {
    const result = await condenseSegment(candidates[i], targetLang, alleBegriffe);
    results.push(result);
    totalCost += result.totalCostUsd;

    if (onProgress) {
      onProgress(i + 1, candidates.length);
    }
  }

  return { results, totalCost };
}

async function saveCondensedText(segmentId: string, condensedText: string): Promise<void> {
  await pool.query(
    `UPDATE segments SET condensed_text = $2 WHERE id = $1`,
    [segmentId, condensedText],
  );
}

/**
 * Holt Glossar-Terme für ein Sprachpaar (für Condensing-Prompt).
 */
export async function getGlossaryTerms(
  sourceLang: string,
  targetLang: string,
): Promise<string[]> {
  const result = await pool.query(
    `SELECT ge.target_term FROM glossar_an_deepl ge
     JOIN glossaries g ON ge.glossary_id = g.id
     WHERE g.source_lang = $1 AND g.target_lang = $2
     ORDER BY ge.target_term
     LIMIT 100`,
    [normalizeGlossaryLang(sourceLang), normalizeGlossaryLang(targetLang)],
  );
  return result.rows.map((r: any) => r.target_term);
}
