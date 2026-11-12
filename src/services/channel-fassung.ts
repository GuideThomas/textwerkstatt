import { logTokenUsage } from './llm';
import { callLlmGeschuetzt } from './pseudonym/maschine';
import { config } from '../config';
import { pool } from '../db/connection';
import { loadHouseTerms, findHouseTermMatches, type HouseTerm } from './house-terms';
import type { LtMatch } from './languagetool';

/**
 * Channel-Fassung: einen deutschen Text der Organisation in die Sprache eines Channels
 * umschreiben („LED-Trafo" → SHOPA „Netzteil"). Grundlage ist die
 * Hausschreibweise mit ihren Channel-Spalten. Plan: PLAN-channel-fassung.md.
 *
 * EIN Baustein für Schnellübersetzung, Dokumente und Shop-Texte — dieselbe Lehre
 * wie html-pipeline.ts: drei Kopien hätten drei verschiedene Fehlerstände.
 *
 * Ablauf je Text:
 *   1. Erkennung nach Regel (`findHouseTermMatches`). Kein Treffer → Text
 *      unverändert, kein Modellaufruf.
 *   2. Treffer → Sprachmodell ersetzt die Begriffe und passt Artikel, Adjektive
 *      und Endungen an („ein kompaktes Lichtband" → „ein kompakter LED-Streifen").
 *   3. Harte Prüfung (`checkRewrite`). Eine Bitte im Prompt ist keine Schranke —
 *      fällt eine Bedingung, wird das Modellergebnis verworfen.
 *   4. Verworfen oder kein Modell erreichbar → Ersatz nach Regel, Kennzeichen
 *      `pruefen` (Entscheid Thomas 27.10.2026: lieber ersetzt und markiert als
 *      stehen gelassen).
 */

export type Herkunft = 'unverändert' | 'sprachmodell' | 'regel';

export interface Treffer {
  /** So stand es im Text */
  original: string;
  /** Begriff des Channels */
  ersatz: string;
}

export interface ChannelFassung {
  text: string;
  herkunft: Herkunft;
  treffer: Treffer[];
  /** Grund, die Stelle von Hand anzusehen — null, wenn nichts auffiel */
  pruefen: string | null;
}

/** Umschreiben durch das Modell; null = nicht erreichbar oder Fehler. */
export type Umschreiber = (text: string, hits: LtMatch[]) => Promise<string | null>;

/**
 * Was das Modell nicht anfassen darf: Tags (auch IDML-Marker `<x id="1"/>`),
 * Sentinels der Schutzschichten (`__ISOLUNIT0__`, `__TERM_1__`), Magento-
 * Direktiven `{{…}}` und ganze `<script>`/`<style>`-Blöcke.
 */
const PROTECTED_RE =
  /<(script|style)\b[\s\S]*?<\/\1\s*>|<[^<>]+>|__[A-Z][A-Z0-9_]*?__|\{\{[\s\S]*?\}\}/gi;

function protectedSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(PROTECTED_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/** Geschützte Zeichenfolgen in ihrer Reihenfolge; die Textwerkstatt prüft damit dieselbe Bedingung a) (`optimieren/pruefung.ts`). */
export function placeholders(text: string): string[] {
  return [...text.matchAll(PROTECTED_RE)].map((m) => m[0]);
}

/**
 * Treffer der Regel, ohne die in geschützten Bereichen — ein „LED-Treiber" in
 * einer URL oder einem Tag-Attribut darf auch der Ersatz nach Regel nicht anfassen.
 */
export function findChannelHits(text: string, terms: HouseTerm[]): LtMatch[] {
  const spans = protectedSpans(text);
  return findHouseTermMatches(text, terms).filter(
    (h) => !spans.some(([s, e]) => h.offset < e && s < h.offset + h.length),
  );
}

/** Ersatz nach Regel — wie „Vorschlag übernehmen" in der Schreibhilfe. */
export function applyRuleReplacements(text: string, hits: LtMatch[]): string {
  let out = text;
  for (const h of [...hits].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, h.offset) + h.replacements[0].value + out.slice(h.offset + h.length);
  }
  return out;
}

const fold = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss');

interface Token { word: string; start: number; end: number }

function tokenize(text: string): Token[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({
    word: m[0],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

/** Längster gemeinsamer Teil zweier Wortfolgen, als Paare (i, j). */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Fenster um einen Treffer: 4 Wörter davor (Artikel, Adjektivkette), 1 danach. */
const WINDOW_BEFORE = 4;
const WINDOW_AFTER = 1;
/** Über dieser Wortzahl wird nicht verglichen, sondern nach Regel ersetzt. */
const MAX_DIFF_WORDS = 600;

/**
 * Prüft ein Modellergebnis. Liefert den Grund der Ablehnung oder null.
 *
 *   a) Platzhalter, Tags und Marker in derselben Folge
 *   b) kein zu vermeidender Begriff mehr, jeder Channel-Begriff steht drin
 *   c) geändert nur im Fenster um die Treffer — alles andere wortgleich
 *   d) Länge 70–160 % des Originals
 */
export function checkRewrite(
  original: string,
  candidate: string,
  terms: HouseTerm[],
  hits: LtMatch[],
): string | null {
  if (!candidate.trim()) return 'leere Antwort';

  if (JSON.stringify(placeholders(original)) !== JSON.stringify(placeholders(candidate))) {
    return 'Platzhalter oder Tags verändert';
  }

  if (findChannelHits(candidate, terms).length > 0) return 'Begriff nicht ersetzt';
  const foldedCandidate = fold(candidate);
  for (const preferred of new Set(hits.map((h) => h.replacements[0].value))) {
    if (!foldedCandidate.includes(fold(preferred))) return `„${preferred}" fehlt`;
  }

  const ratio = candidate.length / Math.max(1, original.length);
  if (ratio < 0.7 || ratio > 1.6) return 'Länge auffällig';

  const a = tokenize(original);
  const b = tokenize(candidate);
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) return 'Text zu lang für den Wortvergleich';

  const windows = hits.map((h) => {
    const covered = a
      .map((t, i) => (t.start < h.offset + h.length && h.offset < t.end ? i : -1))
      .filter((i) => i >= 0);
    const first = covered.length ? covered[0] : 0;
    const last = covered.length ? covered[covered.length - 1] : 0;
    return [first - WINDOW_BEFORE, last + WINDOW_AFTER] as const;
  });
  const inWindow = (i: number) => windows.some(([s, e]) => i >= s && i <= e);

  // Jedes geänderte, gelöschte oder eingefügte Wort muss in einem Fenster liegen.
  const pairs = lcsPairs(a.map((t) => t.word), b.map((t) => t.word));
  let ai = 0;
  let bi = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    const deleted = pi - ai;
    const inserted = pj - bi;
    if (deleted > 0) {
      for (let i = ai; i < pi; i++) if (!inWindow(i)) return 'Text außerhalb der Begriffe verändert';
    } else if (inserted > 0) {
      // Reine Einfügung zwischen Wort ai-1 und ai
      if (!inWindow(ai) && !inWindow(ai - 1)) return 'Text außerhalb der Begriffe verändert';
    }
    ai = pi + 1;
    bi = pj + 1;
  }
  return null;
}

/** Auch für den Channel-Schritt der Textwerkstatt (`optimieren.ts`), dort über den eigenen KI-Weg statt `callLlm`. */
export const SYSTEM_PROMPT = [
  'Du überarbeitest deutsche Produkt- und Marketingtexte eines Herstellers von LED-Beleuchtung für einen anderen Vertriebskanal.',
  'Ersetze ausschließlich die genannten Begriffe durch die vorgegebenen Begriffe.',
  'Passe dabei Artikel, Adjektivendungen, Pronomen und Wortendungen grammatisch an (Genus, Numerus, Kasus). Steht der Begriff in einem zusammengesetzten Wort, ersetze ihn dort ebenfalls.',
  'Ändere sonst nichts: keine anderen Wörter, keine Satzstellung, keine Zeichensetzung, keine Leerzeichen, keine Zeilenumbrüche.',
  'Zeichenfolgen wie <x id="1"/>, <b>, </p>, __ISOLUNIT0__, __TERM_1__ oder {{widget …}} sind Platzhalter und bleiben exakt so stehen, wie sie sind.',
  'Antworte nur mit dem überarbeiteten Text, ohne Anführungszeichen, ohne Erklärung.',
].join('\n');

export function userPrompt(text: string, hits: LtMatch[]): string {
  const lines = hits.map((h) => `- „${text.slice(h.offset, h.offset + h.length)}" → „${h.replacements[0].value}"`);
  return `Ersetzungen:\n${[...new Set(lines)].join('\n')}\n\nText zwischen <<< und >>>:\n<<<\n${text}\n>>>`;
}

export function stripFence(answer: string): string {
  return answer.replace(/^\s*<<<\s*\n?/, '').replace(/\n?\s*>>>\s*$/, '');
}

/** Das Sprachmodell über LiteLLM, mit verdecktem Text und ohne Ausweichmodell (Phase 6, `pseudonym/maschine.ts`). */
export function llmUmschreiber(projectId?: string): Umschreiber {
  return async (text, hits) => {
    if (!config.llm.apiKey) return null;
    try {
      const result = await callLlmGeschuetzt(SYSTEM_PROMPT, userPrompt(text, hits));
      await logTokenUsage(result, 'channel-fassung', projectId).catch(() => { /* Kostenlog darf nicht blockieren */ });
      return stripFence(result.text);
    } catch (err: any) {
      console.warn(`[Channel-Fassung] Sprachmodell nicht erreichbar: ${err.message}`);
      return null;
    }
  };
}

/** Ein Text, gegebene Liste — ohne Datenbank, deshalb prüfbar. */
export async function rewriteOne(
  text: string,
  terms: HouseTerm[],
  umschreiber: Umschreiber,
): Promise<ChannelFassung> {
  const hits = findChannelHits(text, terms);
  if (hits.length === 0) return { text, herkunft: 'unverändert', treffer: [], pruefen: null };

  const treffer = hits.map((h) => ({
    original: text.slice(h.offset, h.offset + h.length),
    ersatz: h.replacements[0].value,
  }));

  const candidate = await umschreiber(text, hits);
  const grund = candidate === null ? 'Sprachmodell nicht erreichbar' : checkRewrite(text, candidate, terms, hits);
  if (candidate !== null && grund === null) {
    return { text: candidate, herkunft: 'sprachmodell', treffer, pruefen: null };
  }
  return {
    text: applyRuleReplacements(text, hits),
    herkunft: 'regel',
    treffer,
    pruefen: `Nach Regel ersetzt (${grund}) — Artikel und Endungen prüfen`,
  };
}

const PARALLEL = 4;

/** Mehrere Texte, gegebene Liste. Reihenfolge bleibt erhalten. */
export async function rewriteMany(
  texts: string[],
  terms: HouseTerm[],
  umschreiber: Umschreiber,
): Promise<ChannelFassung[]> {
  const out: ChannelFassung[] = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      out[i] = await rewriteOne(texts[i], terms, umschreiber);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, texts.length) }, worker));
  return out;
}

/** Deutsch → Deutsch heißt in allen Pfaden: Channel-Fassung statt DeepL. */
export function isChannelFassung(sourceLang: string, targetLang: string): boolean {
  const base = (l: string) => l.trim().toUpperCase().split('-')[0];
  return base(sourceLang) === 'DE' && base(targetLang) === 'DE';
}

export interface ListenStand {
  /** Einträge, die in diesem Channel etwas ersetzen (eigene + geerbte Standard-Einträge) */
  begriffe: number;
  /** davon mit eigenem Channel-Begriff; 0 = es gilt nur die Hausschreibweise der Organisation */
  eigene: number;
}

async function eigeneBegriffe(channelCode: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM house_term_channels WHERE channel_code = $1`,
    [channelCode],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * Einstieg für Segmente (Dokumente, Shop-Texte): Liste des Channels laden und
 * jedes Segment für sich umschreiben. Die Aufrufer zeigen `begriffe`/`eigene` an,
 * statt bei leerer Liste still nichts zu ändern.
 */
export async function rewriteForChannel(
  texts: string[],
  channelCode: string,
  opts: { projectId?: string } = {},
): Promise<{ fassungen: ChannelFassung[] } & ListenStand> {
  const terms = await loadHouseTerms(channelCode);
  const fassungen = await rewriteMany(texts, terms, llmUmschreiber(opts.projectId));
  return { fassungen, begriffe: terms.length, eigene: await eigeneBegriffe(channelCode) };
}

export interface TextFassung extends ListenStand {
  text: string;
  /** nur die Abschnitte mit Treffer */
  stellen: Array<{ start: number; end: number; ersatz: string; original: string; herkunft: Herkunft }>;
  sprachmodell: number;
  regel: number;
  pruefen: string[];
}

/**
 * Einstieg für einen ganzen Text (Schnellübersetzung): zeilenweise umschreiben —
 * ein Absatz ist die Einheit, in der das Modell Artikel und Endungen anpasst, und
 * die Wortdiff-Prüfung bleibt auch bei langen Texten unter ihrer Grenze.
 */
export async function rewriteTextForChannel(text: string, channelCode: string): Promise<TextFassung> {
  const parts = text.split(/(\n+)/);
  const contentIdx = parts.map((p, i) => (i % 2 === 0 && p.trim() ? i : -1)).filter((i) => i >= 0);
  const { fassungen, begriffe, eigene } = await rewriteForChannel(contentIdx.map((i) => parts[i]), channelCode);

  const out = [...parts];
  contentIdx.forEach((partIdx, k) => { out[partIdx] = fassungen[k].text; });

  const stellen: TextFassung['stellen'] = [];
  let cursor = 0;
  const byPart = new Map(contentIdx.map((partIdx, k) => [partIdx, fassungen[k]]));
  out.forEach((part, partIdx) => {
    const f = byPart.get(partIdx);
    if (f && f.herkunft !== 'unverändert') {
      const lower = part.toLowerCase();
      for (const t of f.treffer) {
        let from = 0;
        let at: number;
        while ((at = lower.indexOf(t.ersatz.toLowerCase(), from)) >= 0) {
          if (!stellen.some((s) => s.start === cursor + at)) {
            stellen.push({ start: cursor + at, end: cursor + at + t.ersatz.length, ersatz: t.ersatz, original: t.original, herkunft: f.herkunft });
          }
          from = at + t.ersatz.length;
        }
      }
    }
    cursor += part.length;
  });

  return {
    text: out.join(''),
    stellen: stellen.sort((a, b) => a.start - b.start),
    sprachmodell: fassungen.filter((f) => f.herkunft === 'sprachmodell').length,
    regel: fassungen.filter((f) => f.herkunft === 'regel').length,
    pruefen: fassungen.flatMap((f) => (f.pruefen ? [f.pruefen] : [])),
    begriffe,
    eigene,
  };
}
