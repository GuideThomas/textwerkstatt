import * as deepl from 'deepl-node';
import { config } from '../config';
import { pool } from '../db/connection';
import { normalizeGlossaryLang } from './lang';
import { verbrauche } from '../demo/grenzen';

let translator: deepl.Translator | null = null;

/**
 * DeepL läuft als Pay-as-you-go (€20/1M Zeichen über die monatliche Pauschale hinaus) —
 * es gibt kein hartes Zeichenlimit mehr. Diese Flags zeigen den letzten bekannten
 * Reachability-Status an, damit das Frontend ein Banner einblenden kann wenn die
 * DeepL-API ausfällt.
 */
let deeplReachable = true;
let deeplLastError = '';
let deeplLastCheck: Date | null = null;

export function isDeepLReachable(): boolean { return deeplReachable; }
export function getDeepLLastError(): string { return deeplLastError; }
export function getDeepLLastCheck(): Date | null { return deeplLastCheck; }

function markDeepLDown(reason: string): void {
  deeplReachable = false;
  deeplLastError = reason;
  deeplLastCheck = new Date();
  console.warn(`[DeepL] Nicht erreichbar: ${reason}`);
}

function markDeepLUp(): void {
  if (!deeplReachable) console.log('[DeepL] Wieder erreichbar');
  deeplReachable = true;
  deeplLastError = '';
  deeplLastCheck = new Date();
}

function getTranslator(): deepl.Translator {
  if (!translator) {
    if (!config.deepl.apiKey) {
      throw new Error('DEEPL_API_KEY is not configured');
    }
    translator = new deepl.Translator(config.deepl.apiKey);
  }
  return translator;
}

/**
 * Health-Check: Reichbarkeit der DeepL-API verifizieren.
 * Wird vor Übersetzungs-Batches und periodisch von der Health-Route aufgerufen.
 */
export async function checkDeepLHealth(): Promise<{ reachable: boolean; error?: string }> {
  try {
    const t = getTranslator();
    await t.getUsage();
    markDeepLUp();
    return { reachable: true };
  } catch (err: any) {
    const reason = err?.message || 'Unbekannter Fehler';
    markDeepLDown(reason);
    return { reachable: false, error: reason };
  }
}

/** DeepL-Sprachcodes: DE→DE, EN→EN-US, PT→PT-PT etc. */
function toDeepLSourceLang(lang: string): deepl.SourceLanguageCode {
  const map: Record<string, deepl.SourceLanguageCode> = {
    'DE': 'de', 'EN': 'en', 'FR': 'fr', 'IT': 'it',
    'ES': 'es', 'NL': 'nl', 'PL': 'pl', 'CS': 'cs',
    'CZ': 'cs', 'HU': 'hu', 'SK': 'sk', 'SL': 'sl',
  };
  return map[lang.toUpperCase()] || lang.toLowerCase() as deepl.SourceLanguageCode;
}

function toDeepLTargetLang(lang: string): deepl.TargetLanguageCode {
  const map: Record<string, deepl.TargetLanguageCode> = {
    'DE': 'de', 'EN': 'en-US', 'FR': 'fr', 'IT': 'it',
    'ES': 'es', 'NL': 'nl', 'PL': 'pl', 'CS': 'cs',
    'CZ': 'cs', 'HU': 'hu', 'SK': 'sk', 'SL': 'sl',
  };
  return map[lang.toUpperCase()] || lang.toLowerCase() as deepl.TargetLanguageCode;
}

/**
 * Zielsprachen, für die DeepL ein Glossar ab Deutsch annimmt und die wir auch übersetzen können, in unserer Schreibweise (`CZ`).
 *
 * Ein Glossar gilt je Sprache, deshalb nur Codes ohne Region. Ausnahme `EN`: `toDeepLTargetLang` macht daraus `en-US`. Eine Sprache,
 * die DeepL nur mit Region übersetzt (`pt-BR`, `pt-PT`), fehlt hier: Der Code `PT` schlüge bei jeder Übersetzung fehl.
 * Eine leere Antwort ist kein Ergebnis und wirft: Sie sähe sonst aus wie „alle Sprachen haben schon ein Glossar“.
 */
export async function glossarZielsprachenBeiDeepL(): Promise<{ code: string; name: string }[]> {
  const t = getTranslator();
  const [ziele, paare] = await Promise.all([t.getTargetLanguages(), t.getGlossaryLanguagePairs()]);
  const mitGlossar = new Set(
    paare.filter((p) => p.sourceLang.toLowerCase() === 'de').map((p) => p.targetLang.toUpperCase()),
  );
  const sprachen = new Map<string, string>();
  for (const z of ziele) {
    const code = z.code.toUpperCase();
    const basis = code.split('-')[0];
    if (code.includes('-') && basis !== 'EN') continue;
    if (basis === 'DE' || !mitGlossar.has(basis)) continue;
    const unsere = normalizeGlossaryLang(basis);
    if (!sprachen.has(unsere)) sprachen.set(unsere, z.name.replace(/\s*\(.*\)$/, ''));
  }
  if (sprachen.size === 0) throw new Error('DeepL lieferte keine Zielsprache für Glossare');
  return [...sprachen].map(([code, name]) => ({ code, name }));
}

export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  detectedSourceLang?: string;
}

export interface BatchTranslationOptions {
  sourceLang: string;
  targetLang: string;
  glossaryId?: string;
  /**
   * XML/HTML Tag-Handling für Style-Marker (IDML) o.ae.
   * 'xml' aktiviert DeepL XML-Modus.
   */
  tagHandling?: 'xml' | 'html';
  /** Tags, deren Inhalt NICHT übersetzt wird (aber erhalten bleibt). */
  ignoreTags?: string[];
  /** Tags, an denen nicht gesplittet werden soll. */
  nonSplittingTags?: string[];
  /** Tags, an denen gesplittet werden soll. */
  splittingTags?: string[];
  /**
   * Per-Call-Override der Tag-Handling-Version (Default: config.deepl.tagHandlingVersion).
   * KRITISCH für IDML-Style-Marker (`<x id="N"/>`): v2 repositioniert Inline-Tags
   * frei und fügt Leerzeichen/Satzzeichen um sie herum ein (Vorfall 01.06.2026:
   * "Cover <x/>20" → "Cover<x/>. 20", Zahlen-Offset-Shift). v1 hält Tags
   * positionsgebunden → muss für den `ignoreTags:['x']`-Pfad erzwungen werden.
   */
  tagHandlingVersion?: 'v1' | 'v2';
  /**
   * Anredestufe. NUR die strenge Form: `more`/`less`, nie `prefer_*`.
   * Die Sprachpruefung passiert vorher in `services/formality.ts`; kommt hier
   * doch eine Sprache ohne Unterstuetzung an, antwortet DeepL mit HTTP 400 —
   * und dieser laute Fehler ist gewollt (ein still verworfener Parameter
   * erzeugt eine plausible Nullmessung, die niemandem auffaellt).
   * `undefined` heisst: kein Parameter im Aufruf.
   */
  formality?: 'more' | 'less';
  /**
   * Text, der die Übersetzung lenkt, selbst aber weder übersetzt noch berechnet wird (DeepL `context`). Er gilt für **jeden** Text
   * des Aufrufs: Wer je Text einen eigenen Kontext braucht, ruft je Text einzeln. Leer heißt: kein Parameter im Aufruf.
   * Erster Nutzer ist der Vorschlag für einen unbekannten Namensbaustein, dort mit dem ganzen deutschen Artikelnamen
   * (Bauplan Bausteine Phase 2 §8).
   */
  context?: string;
}

/**
 * Setzt tagHandlingVersion auf den DeepL-Optionen. v2 verlangt zwingend
 * modelType 'quality_optimized'. v1 wird explizit gesetzt (nicht weggelassen),
 * damit der globale Default die positionsgebundenen IDML-Marker nicht doch
 * auf v2 zieht.
 */
function applyTagVersion(opts: deepl.TranslateTextOptions, version: 'v1' | 'v2'): void {
  if (version === 'v2') {
    opts.tagHandlingVersion = 'v2';
    opts.modelType = 'quality_optimized';
  } else {
    opts.tagHandlingVersion = 'v1';
  }
}

/**
 * Einzelnes Segment übersetzen.
 */
export async function translateText(
  text: string,
  sourceLang: string,
  targetLang: string,
  glossaryId?: string,
  extraOptions?: {
    tagHandling?: 'xml' | 'html';
    ignoreTags?: string[];
    tagHandlingVersion?: 'v1' | 'v2';
    /** Anredestufe, strenge Form. Siehe `BatchTranslationOptions.formality`. */
    formality?: 'more' | 'less';
  },
): Promise<TranslationResult> {
  const t = getTranslator();
  const options: deepl.TranslateTextOptions = {};
  if (glossaryId) {
    options.glossary = glossaryId;
  }
  // An DERSELBEN Stelle wie das Glossar gesetzt — beide Setzstellen (hier und
  // in `translateBatch`) muessen sich decken, sonst traegt ein Dokument zwei
  // Anredeformen.
  if (extraOptions?.formality) {
    options.formality = extraOptions.formality;
  }
  if (extraOptions?.tagHandling) {
    options.tagHandling = extraOptions.tagHandling;
    applyTagVersion(options, extraOptions.tagHandlingVersion ?? config.deepl.tagHandlingVersion);
  }
  if (extraOptions?.ignoreTags && extraOptions.ignoreTags.length > 0) {
    options.ignoreTags = extraOptions.ignoreTags;
  }

  // Demo: Zeichen buchen, bevor sie hinausgehen; an der Grenze geht nichts hinaus (src/demo/grenzen.ts).
  await verbrauche('deepl', text.length);

  try {
    const result = await t.translateText(
      text,
      sourceLang === 'AUTO' ? null : toDeepLSourceLang(sourceLang),
      toDeepLTargetLang(targetLang),
      options,
    );
    markDeepLUp();
    return {
      sourceText: text,
      translatedText: result.text,
      detectedSourceLang: result.detectedSourceLang,
    };
  } catch (err: any) {
    markDeepLDown(err?.message || 'translateText fehlgeschlagen');
    throw err;
  }
}

/**
 * Batch-Übersetzung: Segmente in Batches an DeepL senden.
 * Gibt Ergebnisse in gleicher Reihenfolge zurück.
 */
export async function translateBatch(
  texts: string[],
  options: BatchTranslationOptions,
): Promise<TranslationResult[]> {
  if (texts.length === 0) return [];

  const t = getTranslator();
  const translateOptions: deepl.TranslateTextOptions = {};
  if (options.glossaryId) {
    translateOptions.glossary = options.glossaryId;
  }
  if (options.formality) {
    translateOptions.formality = options.formality;
  }
  if (options.context?.trim()) {
    translateOptions.context = options.context.trim();
  }
  if (options.tagHandling) {
    translateOptions.tagHandling = options.tagHandling;
    // Tag-Handling-Version: Per-Call-Override (z.B. IDML-Marker → v1) hat
    // Vorrang vor dem globalen Default.
    applyTagVersion(translateOptions, options.tagHandlingVersion ?? config.deepl.tagHandlingVersion);
  }
  if (options.ignoreTags && options.ignoreTags.length > 0) {
    translateOptions.ignoreTags = options.ignoreTags;
  }
  if (options.nonSplittingTags && options.nonSplittingTags.length > 0) {
    translateOptions.nonSplittingTags = options.nonSplittingTags;
  }
  if (options.splittingTags && options.splittingTags.length > 0) {
    translateOptions.splittingTags = options.splittingTags;
  }

  const results: TranslationResult[] = [];
  const batchSize = config.deepl.batchSize;
  // Demo: alle Zeichen dieses Stapels vorab. Ein Dokument ruft das je Teilstapel auf und kann deshalb mitten in der Übersetzung an
  // der Grenze stehen bleiben; der Fehler steht dann am Projekt.
  await verbrauche('deepl', texts.reduce((n, s) => n + s.length, 0));

  try {
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);

      const batchResults = await t.translateText(
        batch,
        options.sourceLang === 'AUTO' ? null : toDeepLSourceLang(options.sourceLang),
        toDeepLTargetLang(options.targetLang),
        translateOptions,
      );

      const resultsArray = Array.isArray(batchResults) ? batchResults : [batchResults];

      for (let j = 0; j < resultsArray.length; j++) {
        results.push({
          sourceText: batch[j],
          translatedText: resultsArray[j].text,
          detectedSourceLang: resultsArray[j].detectedSourceLang,
        });
      }
    }
    markDeepLUp();
    return results;
  } catch (err: any) {
    markDeepLDown(err?.message || 'translateBatch fehlgeschlagen');
    throw err;
  }
}

/**
 * Glossar bei DeepL erstellen/aktualisieren.
 * Legt ein neues DeepL-Glossar an und gibt die glossary_id zurück.
 */
export async function syncGlossaryToDeepL(
  glossaryDbId: string,
  name: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const t = getTranslator();

  // Einträge aus der Sicht für DeepL: freigegeben, mit Ziel, `an_deepl` (Migration 036, Plan Wortliste §2.3). Reine Namenswörter,
  // Muster und Wörter mit zweiter Bedeutung im Satz gehen nie an DeepL.
  const entriesResult = await pool.query(
    `SELECT source_term, target_term FROM glossar_an_deepl
     WHERE glossary_id = $1
     ORDER BY source_term`,
    [glossaryDbId],
  );

  if (entriesResult.rows.length === 0) {
    throw new Error('Glossary has no approved entries');
  }

  // Altes DeepL-Glossar löschen falls vorhanden
  const glossaryResult = await pool.query(
    `SELECT deepl_glossary_id FROM glossaries WHERE id = $1`,
    [glossaryDbId],
  );

  if (glossaryResult.rows[0]?.deepl_glossary_id) {
    try {
      await t.deleteGlossary(glossaryResult.rows[0].deepl_glossary_id);
    } catch {
      // Ignorieren falls das alte Glossar nicht mehr existiert
    }
  }

  // Entries als Record für GlossaryEntries
  const entriesRecord: Record<string, string> = {};
  for (const r of entriesResult.rows as any[]) {
    entriesRecord[r.source_term] = r.target_term;
  }
  const glossaryEntries = new deepl.GlossaryEntries({ entries: entriesRecord });

  // Neues DeepL-Glossar erstellen
  // Demo: Die Glossare liegen im DeepL-Konto der Firma (E5) und sollen dort als Demo erkennbar sein.
  const deeplGlossary = await t.createGlossary(
    config.demo.an ? `Textwerkstatt-Demo: ${name}` : name,
    toDeepLSourceLang(sourceLang),
    toDeepLTargetLang(targetLang),
    glossaryEntries,
  );

  // DeepL glossary_id + synced_version in DB speichern
  const versionResult = await pool.query(
    `UPDATE glossaries SET deepl_glossary_id = $2, synced_version = version, updated_at = NOW()
     WHERE id = $1 RETURNING version`,
    [glossaryDbId, deeplGlossary.glossaryId],
  );

  const syncedVersion = versionResult.rows[0]?.version ?? 0;
  console.log(`[DeepL] Glossary synced: ${name} v${syncedVersion} (${entriesResult.rows.length} entries) → ${deeplGlossary.glossaryId}`);

  return deeplGlossary.glossaryId;
}

/**
 * Einträge eines Glossars so, wie DeepL sie hält. Zum Zurücklesen nach einem Abgleich; kostet kein Zeichenkontingent.
 */
export async function leseDeepLGlossarEintraege(deeplGlossaryId: string): Promise<Record<string, string>> {
  const eintraege = await getTranslator().getGlossaryEntries(deeplGlossaryId);
  return eintraege.entries();
}

/**
 * DeepL API Usage abfragen.
 */
export async function getDeepLUsage(): Promise<{ characterCount: number; characterLimit: number }> {
  const t = getTranslator();
  const usage = await t.getUsage();
  return {
    characterCount: usage.character?.count ?? 0,
    characterLimit: usage.character?.limit ?? 0,
  };
}

/**
 * Passendes DeepL-Glossar für ein Sprachpaar finden.
 * Gibt die DeepL glossary_id zurück oder undefined.
 */
export async function findDeepLGlossaryId(
  sourceLang: string,
  targetLang: string,
): Promise<string | undefined> {
  const result = await pool.query(
    `SELECT deepl_glossary_id FROM glossaries
     WHERE source_lang = $1 AND target_lang = $2 AND deepl_glossary_id IS NOT NULL
     LIMIT 1`,
    [sourceLang.toUpperCase(), targetLang.toUpperCase()],
  );
  return result.rows[0]?.deepl_glossary_id || undefined;
}

/**
 * Auto-Sync: Prüft ob das Glossar für ein Sprachpaar bei DeepL aktuell ist.
 * Wenn version > synced_version → automatisch neu bei DeepL hochladen.
 * Gibt die aktuelle DeepL glossary_id zurück oder undefined wenn kein Glossar existiert.
 */
export async function ensureGlossarySynced(
  sourceLang: string,
  targetLang: string,
): Promise<string | undefined> {
  const result = await pool.query(
    `SELECT id, name, source_lang, target_lang, version, synced_version, deepl_glossary_id
     FROM glossaries
     WHERE source_lang = $1 AND target_lang = $2
     LIMIT 1`,
    [normalizeGlossaryLang(sourceLang), normalizeGlossaryLang(targetLang)],
  );

  if (result.rows.length === 0) return undefined;

  const g = result.rows[0];

  // Glossar ist aktuell bei DeepL
  if (g.deepl_glossary_id && g.synced_version >= g.version) {
    return g.deepl_glossary_id;
  }

  // Auto-Sync nötig
  console.log(`[DeepL] Auto-sync glossary ${g.name}: v${g.synced_version} → v${g.version}`);
  try {
    return await syncGlossaryToDeepL(g.id, g.name, g.source_lang, g.target_lang);
  } catch (err: any) {
    console.error(`[DeepL] Auto-sync failed for ${g.name}:`, err.message);
    // Fallback: Altes Glossar verwenden falls vorhanden
    return g.deepl_glossary_id || undefined;
  }
}
