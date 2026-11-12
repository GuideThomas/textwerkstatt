import { Router, Request, Response } from 'express';
import { translateText, ensureGlossarySynced } from '../services/deepl';
import { pool } from '../db/connection';
import { config } from '../config';
import { getMarkupDeepLOptions } from '../services/markup';
import { logTokenUsage } from '../services/llm';
import { callLlmGeschuetzt } from '../services/pseudonym/maschine';
import { begriffeImText, ladeBegriffe, stehtImText } from '../services/begriffe-im-text';
import {
  getChannelOverrides,
  applyPreReplacement,
  applyPostReplacement,
} from '../services/channel-overrides';
import {
  protectAcronymsWithGlossary,
  restoreAcronyms,
} from '../services/acronym-protection';
import { protectPoleCounts, restorePoleCounts } from '../services/conductor-protection';
import { protectUnits, restoreUnits } from '../services/unit-protection';
import {
  translateJsonLd,
  protectCode,
  restoreCode,
  protectMarkup,
  restoreMarkup,
  protectAttributes,
  restoreAttributes,
  warnOnSentinelLeak,
} from '../services/text/html-pipeline';
import { correctTargetCapitalization } from '../services/languagetool';
import { isChannelFassung, rewriteTextForChannel } from '../services/channel-fassung';
import { llmCorrectCapitalization, HONORIFIC_PRONOUNS } from '../services/capitalization-llm';
import { verbrauche } from '../demo/grenzen';
import {
  parseFormality,
  effectiveFormality,
  formalityApplied,
  formalityStatus,
  type Formality,
} from '../services/formality';

const LANG_NAMES: Record<string, string> = {
  DE: 'Deutsch', EN: 'Englisch', FR: 'Französisch', IT: 'Italienisch',
  ES: 'Spanisch', NL: 'Niederländisch', PL: 'Polnisch', CS: 'Tschechisch',
  CZ: 'Tschechisch', HU: 'Ungarisch', SK: 'Slowakisch', SL: 'Slowenisch',
};

const DEEPL_LANG_SOURCE: Record<string, string> = {
  DE: 'DE', EN: 'EN', FR: 'FR', IT: 'IT', ES: 'ES',
  NL: 'NL', PL: 'PL', CS: 'CS', CZ: 'CS', HU: 'HU', SK: 'SK', SL: 'SL',
};
const DEEPL_LANG_TARGET: Record<string, string> = {
  DE: 'DE', EN: 'EN-US', FR: 'FR', IT: 'IT', ES: 'ES',
  NL: 'NL', PL: 'PL', CS: 'CS', CZ: 'CS', HU: 'HU', SK: 'SK', SL: 'SL',
};

const router = Router();

interface GlossaryHit {
  source: string;
  target: string;
  start: number;
  end: number;
  channel?: string | null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findAllOccurrences(haystack: string, needle: string): Array<[number, number]> {
  if (!needle) return [];
  const ranges: Array<[number, number]> = [];
  // Word-boundary via lookarounds that work for Unicode letters
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?![\\p{L}\\p{N}])`, 'giu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return ranges;
}

function detectGlossaryHits(
  input: string,
  output: string,
  entries: Array<{ source_term: string; target_term: string; channel?: string | null }>,
): GlossaryHit[] {
  // Sort entries by source_term length DESC for greedy longest-match preference
  const sorted = [...entries].sort((a, b) => b.source_term.length - a.source_term.length);
  const usedRanges: Array<[number, number]> = [];
  const hits: GlossaryHit[] = [];
  const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

  for (const e of sorted) {
    if (!e.source_term || !e.target_term) continue;
    if (e.source_term === e.target_term) continue;
    // Source must appear in input
    const inputHit = findAllOccurrences(input, e.source_term);
    if (inputHit.length === 0) continue;
    // Find target in output, prefer first not-yet-marked occurrence
    const targetRanges = findAllOccurrences(output, e.target_term);
    for (const r of targetRanges) {
      if (usedRanges.some((u) => overlaps(u, r))) continue;
      usedRanges.push(r);
      hits.push({
        source: e.source_term,
        target: e.target_term,
        start: r[0],
        end: r[1],
        channel: e.channel ?? null,
      });
      // Mark up to inputHit.length occurrences (one per source occurrence)
      if (hits.filter((h) => h.source === e.source_term).length >= inputHit.length) break;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

/**
 * Welche Zielsprachen kennen eine Anredestufe? Die Oberflaeche braucht das,
 * um die Auswahl bei EN/CZ/SK/HU sichtbar zu deaktivieren statt sie
 * stillschweigend zu schlucken. `source` sagt dazu, ob die Liste live von
 * DeepL kam oder die eingecheckte Rueckfallliste ist.
 */
router.get('/formality', (_req: Request, res: Response) => {
  res.json(formalityStatus());
});

router.post('/', async (req: Request, res: Response) => {
  const {
    text,
    sourceLang,
    targetLang,
    mode,
    channelCode: rawChannelCode,
    useGlossary: rawUseGlossary,
    optimizeTargetCasing: rawOptimizeCasing,
    protectAcronymSuffixes: rawProtectAcronyms,
    formality: rawFormality,
  } = req.body as {
    text?: string;
    sourceLang?: string;
    targetLang?: string;
    mode?: 'text' | 'xml' | 'html';
    channelCode?: string | null;
    useGlossary?: boolean;
    optimizeTargetCasing?: boolean;
    protectAcronymSuffixes?: boolean;
    formality?: string;
  };
  // Defaults: an, wenn nicht explizit aus.
  const optimizeTargetCasing = rawOptimizeCasing !== false;
  const protectAcronymSuffixes = rawProtectAcronyms !== false;
  // Default true (Backwards-Compat). Nur explizites false aktiviert den Neutral-Modus.
  const useGlossary = rawUseGlossary !== false;
  const channelCode = !useGlossary
    ? null
    : typeof rawChannelCode === 'string' && rawChannelCode.trim() !== ''
      ? rawChannelCode.trim().toUpperCase()
      : null;

  if (!text || !sourceLang || !targetLang) {
    res.status(400).json({ error: 'text, sourceLang und targetLang sind erforderlich' });
    return;
  }

  // Anredestufe: ein unbrauchbarer Wert wird abgewiesen statt still auf
  // 'default' zu fallen. Ein stiller Rueckfall saehe fuer den Anwender aus wie
  // eine wirkungslose Wahl — genau die Fehlerklasse, gegen die diese Funktion
  // mit der strengen Form antritt.
  const formality: Formality | null = parseFormality(rawFormality);
  if (formality === null) {
    res.status(400).json({
      error: `formality muss 'default', 'more' oder 'less' sein (erhalten: ${String(rawFormality)})`,
    });
    return;
  }
  // EINMAL berechnet und an ALLE DeepL-Aufrufe dieser Route durchgereicht.
  // Ein Aufruf der Schnellübersetzung setzt bis zu drei getrennte Anfragen ab
  // (Fliesstext, Attributwerte, JSON-LD) — wird eine vergessen, traegt ein
  // Dokument zwei Anredeformen.
  const deeplFormality = effectiveFormality(formality, targetLang);
  const formalityInfo = formalityApplied(formality, targetLang);

  if (text.length > 10000) {
    res.status(400).json({ error: 'Text darf maximal 10.000 Zeichen lang sein' });
    return;
  }

  const markupMode: 'xml' | 'html' | null =
    mode === 'xml' || mode === 'html' ? mode : null;

  // Deutsch → Deutsch = Channel-Fassung (PLAN-channel-fassung.md): kein DeepL,
  // sondern die Hausschreibweise des Channels. Der Channel gilt hier auch ohne
  // Glossar-Häkchen — ohne ihn gäbe es nichts umzuschreiben. Tags, Sentinels und
  // `{{…}}` schützt der Baustein selbst; Begriffe in Attributwerten bleiben stehen.
  if (isChannelFassung(sourceLang, targetLang)) {
    const fassungChannel =
      typeof rawChannelCode === 'string' && rawChannelCode.trim() ? rawChannelCode.trim().toUpperCase() : null;
    if (!fassungChannel) {
      res.status(400).json({ error: 'Für Deutsch → Deutsch einen Channel wählen' });
      return;
    }
    try {
      const known = await pool.query(`SELECT 1 FROM channels WHERE code = $1`, [fassungChannel]);
      if (known.rows.length === 0) {
        res.status(400).json({ error: `Unbekannter Channel ${fassungChannel}` });
        return;
      }
      const f = await rewriteTextForChannel(text, fassungChannel);
      res.json({
        translatedText: f.text,
        glossaryUsed: null,
        glossaryHits: f.stellen.map((s) => ({
          source: s.original, target: s.ersatz, start: s.start, end: s.end, channel: fassungChannel,
        })),
        channelCode: fassungChannel,
        charCount: text.length,
        mode: markupMode ?? 'text',
        channelFassung: {
          begriffe: f.begriffe,
          eigene: f.eigene,
          stellen: f.stellen.length,
          sprachmodell: f.sprachmodell,
          regel: f.regel,
          pruefen: f.pruefen,
        },
      });
    } catch (err: any) {
      console.error('[QuickTranslate] Channel-Fassung:', err.message);
      res.status(500).json({ error: 'Channel-Fassung fehlgeschlagen' });
    }
    return;
  }

  try {
    const glossaryId = useGlossary ? await ensureGlossarySynced(sourceLang, targetLang) : undefined;

    let glossaryName: string | null = null;
    let glossaryDbId: string | null = null;
    if (useGlossary && glossaryId) {
      const g = await pool.query(
        `SELECT id, name FROM glossaries WHERE deepl_glossary_id = $1`,
        [glossaryId],
      );
      glossaryName = g.rows[0]?.name || null;
      glossaryDbId = g.rows[0]?.id || null;
    }

    // Bei XML/HTML-Mode wird DeepLs natives Tag-Handling aktiviert,
    // Tags und Attribute bleiben 1:1 erhalten.
    const extraOptions = markupMode ? getMarkupDeepLOptions(markupMode) : undefined;

    // ── Markup-Schutzschicht (services/text/html-pipeline.ts) ────────────────
    // Bis 29.07.2026 lief in dieser Route KEIN Markup-Schutz: Store-View-Links,
    // {{widget}}-Direktiven, <script>/<style> und Attribute wurden hier anders
    // behandelt als im Projekt-Upload — gemeldet an einem `/de/`-Link, der in der
    // spanischen Ausgabe stehen blieb. Jetzt derselbe Baustein wie in queue.ts.
    // Nur im XML-/HTML-Modus: im Text-Modus gibt es kein Markup zu schützen.
    let working = text;
    let jsonLdApplied = false;
    if (markupMode) {
      const before = working;
      working = await translateJsonLd(working, async (values) => {
        const results = await Promise.all(
          values.map((v) =>
            translateText(v, sourceLang, targetLang, glossaryId, {
              tagHandling: 'html',
              formality: deeplFormality,
            }),
          ),
        );
        return results.map((r) => r.translatedText);
      });
      jsonLdApplied = working !== before;
    }

    const codeProt = markupMode ? protectCode(working) : null;
    if (codeProt) working = codeProt.text;

    // Channel-Overrides anwenden (Pre-Replacement vor DeepL).
    // Im Neutral-Modus (useGlossary=false) entfällt das komplett.
    let textForDeepL = working;
    let channelReplacements = new Map<string, string>();
    let channelOverrides: Array<{ sourceTerm: string; channelTargetTerm: string }> = [];
    if (useGlossary && channelCode) {
      channelOverrides = await getChannelOverrides(sourceLang, targetLang, channelCode);
      const pre = applyPreReplacement(working, channelOverrides);
      textForDeepL = pre.text;
      channelReplacements = pre.replacements;
    }

    // URL-Attribute + Store-View, Magento-Direktiven, CSS-Kommentare.
    // Vor Akronym-/Pol-/Einheiten-Schutz, damit deren Sentinels nicht in einer
    // URL landen und dort nach dem Link-Restore unaufgelöst stehen bleiben.
    const markupProt = markupMode ? protectMarkup(textForDeepL, targetLang) : null;
    if (markupProt) textForDeepL = markupProt.text;

    // Akronym-Pre-Pass (Thema B): Glossar-Akronyme mit angehaengter Zahl
    // (CRI90 → IRC90) durch Sentinels schuetzen. Greift nur bei aktivem Glossar.
    let acronymRestore = new Map<string, string>();
    let glossaryEntriesForRouter: Array<{ source_term: string; target_term: string }> = [];
    if (useGlossary && protectAcronymSuffixes && glossaryDbId) {
      const allGloss = await pool.query(
        `SELECT source_term, target_term FROM glossar_an_deepl
          WHERE glossary_id = $1`,
        [glossaryDbId],
      );
      glossaryEntriesForRouter = allGloss.rows;
      const acronymProt = protectAcronymsWithGlossary(textForDeepL, glossaryEntriesForRouter);
      textForDeepL = acronymProt.protectedText;
      acronymRestore = acronymProt.restoreMap;
    }

    // Pol-/Litzenzahl-Schutz: `4-polig` → Sentinel, Restore als Zielsprachen-Form
    // (EN `4-pole`, ...) — DeepL verschluckt sonst die Litzenanzahl.
    const poleProt = protectPoleCounts(textForDeepL, targetLang);
    textForDeepL = poleProt.protectedText;

    // Einheiten-Schutz: `12W`/`CRI90` verbatim erhalten (DeepL trennt sonst).
    const unitProt = protectUnits(textForDeepL, targetLang);
    textForDeepL = unitProt.protectedText;

    // Attribut-Pre-Pass (alt/title/aria-*/placeholder/value/meta-content):
    // DeepL fasst Attributwerte in der Praxis nicht an, deshalb gehen sie als
    // eigener Text-Mode-Batch durch.
    const attrProt = markupMode
      ? await protectAttributes(textForDeepL, async (values) => {
          const results = await Promise.all(
            values.map((v) =>
              translateText(v, sourceLang, targetLang, glossaryId, { formality: deeplFormality }),
            ),
          );
          return results.map((r) => r.translatedText);
        })
      : null;
    if (attrProt) textForDeepL = attrProt.text;

    const deeplResult = await translateText(
      textForDeepL,
      sourceLang,
      targetLang,
      glossaryId,
      { ...(extraOptions ?? {}), formality: deeplFormality },
    );

    let finalText = deeplResult.translatedText;

    // Attribut-Restore ZUERST — die Werte können Akronym-/Channel-Sentinels
    // enthalten, die von den folgenden Schritten noch aufgelöst werden.
    if (attrProt) finalText = restoreAttributes(finalText, attrProt.ctx);

    // Markup-Restore VOR dem Post-Replacement, damit ein Channel-Token in einem
    // URL-Slug noch ersetzt wird (gleiche Reihenfolge wie in queue.ts).
    if (markupProt) finalText = restoreMarkup(finalText, markupProt.ctx);

    if (channelReplacements.size > 0) {
      finalText = applyPostReplacement(finalText, channelReplacements);
    }

    // Akronym-Restore (Thema B): Sentinels → Glossar-Target + Original-Suffix
    if (acronymRestore.size > 0) {
      finalText = restoreAcronyms(finalText, acronymRestore);
    }

    // Einheiten-Restore: Sentinel → Original-Token (verbatim)
    if (unitProt.restoreMap.size > 0) {
      finalText = restoreUnits(finalText, unitProt.restoreMap);
    }

    // Pol-/Litzenzahl-Restore: Sentinel → Zielsprachen-Form
    if (poleProt.restoreMap.size > 0) {
      finalText = restorePoleCounts(finalText, poleProt.restoreMap);
    }

    // Capitalization-Post-Pass (Thema A): LLM primaer + LT als Sicherheitsnetz.
    // Sprachen: FR/IT/ES/PT/NL/PL/CS/SK/SL/HU automatisch — EN ausgeschlossen
    // (Title-Case-Konventionen).
    let capFixesAudit: Array<{ from: string; to: string }> = [];
    let capSkipReason: string | undefined;
    let capLlmCostUsd: number | undefined;
    if (optimizeTargetCasing) {
      const protectedTerms: string[] = [
        ...channelOverrides.map((c) => c.channelTargetTerm),
        ...glossaryEntriesForRouter.map((e) => e.target_term),
      ];
      try {
        const llmFix = await llmCorrectCapitalization(finalText, targetLang, {
          extraAllowlist: protectedTerms,
          // Nur wenn wirklich eine Stufe rausging. Sonst ist ein
          // grossgeschriebenes `La` mitten im Satz eher deutsche
          // Uebergrosschreibung als Hoeflichkeitsform — und die soll der Pass
          // weiter korrigieren duerfen (gemessen 14.08.2026).
          protectHonorifics: deeplFormality !== undefined,
        });
        if (!llmFix.skipped) {
          finalText = llmFix.corrected;
          capFixesAudit = llmFix.fixes.map((f) => ({ from: f.from, to: f.to }));
        } else {
          capSkipReason = llmFix.skipReason;
        }
        capLlmCostUsd = llmFix.costUsd;
      } catch (err: any) {
        console.warn('[QuickTranslate] LLM-Cap-Pass error:', err.message);
        capSkipReason = `llm error: ${err.message}`;
      }
      try {
        const ltFix = await correctTargetCapitalization(
          finalText,
          targetLang,
          protectedTerms,
          deeplFormality !== undefined ? HONORIFIC_PRONOUNS : [],
        );
        finalText = ltFix.corrected;
        if (ltFix.fixes.length > 0) {
          capFixesAudit.push(...ltFix.fixes.map((f) => ({ from: f.from, to: f.to })));
        }
      } catch (err: any) {
        console.warn('[QuickTranslate] LT-Target-Pass skipped:', err.message);
      }
    }

    // <script>/<style> ganz zuletzt verbatim zurück — nach Post-Replacement und
    // Groß-/Kleinschreibungs-Korrektur, damit niemand den Code-Inhalt anfasst.
    if (codeProt) finalText = restoreCode(finalText, codeProt.ctx);
    if (markupMode) warnOnSentinelLeak(finalText, 'QuickTranslate');

    if (markupProt && markupProt.ctx.urlsRewritten > 0) {
      console.log(
        `[QuickTranslate] Store-View: ${markupProt.ctx.urlsRewritten} Link(s) auf ${targetLang} umgeschrieben` +
          (jsonLdApplied ? ', JSON-LD übersetzt' : ''),
      );
    }

    // Glossar-Treffer im Output finden (Heuristik: source_term in Input + target_term in Output)
    let glossaryHits: GlossaryHit[] = [];
    if (useGlossary && glossaryDbId) {
      const entries = await pool.query(
        `SELECT source_term, target_term FROM glossar_an_deepl
         WHERE glossary_id = $1`,
        [glossaryDbId],
      );
      // Channel-Overrides überschreiben Standard-Eintrag für Detection
      const channelMap = new Map(
        channelOverrides.map((o) => [o.sourceTerm.toLowerCase(), o.channelTargetTerm]),
      );
      const detectionEntries = entries.rows.map((e: any) => {
        const channelTarget = channelMap.get(e.source_term.toLowerCase());
        return channelTarget
          ? { source_term: e.source_term, target_term: channelTarget, channel: channelCode }
          : { source_term: e.source_term, target_term: e.target_term, channel: null };
      });
      glossaryHits = detectGlossaryHits(text, finalText, detectionEntries);
    }

    res.json({
      translatedText: finalText,
      detectedSourceLang: deeplResult.detectedSourceLang,
      glossaryUsed: glossaryName,
      glossaryHits,
      channelCode,
      charCount: text.length,
      mode: markupMode ?? 'text',
      capitalizationFixes: capFixesAudit,
      capitalizationSkipReason: capSkipReason,
      capitalizationLlmCostUsd: capLlmCostUsd,
      // Die TATSAECHLICH angewandte Stufe. Ohne diese Angabe ist hinterher
      // nicht erkennbar, ob eine Uebersetzung mit oder ohne Anredestufe
      // entstanden ist — und bei nicht unterstuetzter Zielsprache steht hier
      // ausdruecklich `applied: null` samt `supported: false`.
      formality: formalityInfo,
    });
  } catch (err: any) {
    console.error('[QuickTranslate] Error:', err.message);
    res.status(500).json({ error: err.message || 'Übersetzung fehlgeschlagen' });
  }
});

// Alternative Übersetzungen (DeepL `alternatives`-Parameter, 1-3 Varianten)
// Wird vom QuickTranslate-UI für den Wort-/Phrasen-Picker genutzt.
router.post('/alternatives', async (req: Request, res: Response) => {
  const {
    text,
    sourceLang,
    targetLang,
    n: rawN,
    channelCode: rawChannelCode,
    useGlossary: rawUseGlossary,
    formality: rawFormality,
  } = req.body as {
    text?: string;
    sourceLang?: string;
    targetLang?: string;
    n?: number;
    channelCode?: string | null;
    useGlossary?: boolean;
    formality?: string;
  };
  const useGlossary = rawUseGlossary !== false;

  if (!text || !sourceLang || !targetLang) {
    res.status(400).json({ error: 'text, sourceLang und targetLang sind erforderlich' });
    return;
  }
  if (text.length > 5000) {
    res.status(400).json({ error: 'Text darf maximal 5.000 Zeichen lang sein' });
    return;
  }

  // VIERTER DeepL-Aufruf dieser Datei — ein roher REST-Call am `deepl.ts`
  // vorbei, den der Plan nicht mitzaehlt. Ohne die Stufe kaemen die
  // Wort-Alternativen neutral zurueck, waehrend der Fliesstext daneben formell
  // ist: dieselbe Register-Mischung innerhalb eines Ergebnisses, gegen die
  // dieses Vorhaben antritt, nur eine Ebene tiefer.
  const altFormality: Formality | null = parseFormality(rawFormality);
  if (altFormality === null) {
    res.status(400).json({
      error: `formality muss 'default', 'more' oder 'less' sein (erhalten: ${String(rawFormality)})`,
    });
    return;
  }
  if (!config.deepl.apiKey) {
    res.status(500).json({ error: 'DEEPL_API_KEY ist nicht konfiguriert' });
    return;
  }

  const n = Math.min(Math.max(parseInt(String(rawN ?? 3), 10) || 3, 1), 3);
  const channelCode = !useGlossary
    ? null
    : typeof rawChannelCode === 'string' && rawChannelCode.trim() !== ''
      ? rawChannelCode.trim().toUpperCase()
      : null;

  try {
    const glossaryId = useGlossary ? await ensureGlossarySynced(sourceLang, targetLang) : undefined;

    // Channel-Overrides per Pre/Post-Replacement absichern, damit gelockte Begriffe
    // auch in Alternativen unverändert bleiben. Im Neutral-Modus übersprungen.
    let textForDeepL = text;
    let channelReplacements = new Map<string, string>();
    if (useGlossary && channelCode) {
      const overrides = await getChannelOverrides(sourceLang, targetLang, channelCode);
      const pre = applyPreReplacement(text, overrides);
      textForDeepL = pre.text;
      channelReplacements = pre.replacements;
    }

    const sourceCode = DEEPL_LANG_SOURCE[sourceLang.toUpperCase()] || sourceLang.toUpperCase();
    const targetCode = DEEPL_LANG_TARGET[targetLang.toUpperCase()] || targetLang.toUpperCase();
    const baseUrl = config.deepl.apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com'
      : 'https://api.deepl.com';

    const params = new URLSearchParams();
    params.append('text', textForDeepL);
    params.append('source_lang', sourceCode);
    params.append('target_lang', targetCode);
    params.append('alternatives', String(n));
    if (glossaryId) params.append('glossary_id', glossaryId);
    const altDeeplFormality = effectiveFormality(altFormality, targetLang);
    if (altDeeplFormality) params.append('formality', altDeeplFormality);

    // Demo: dieser Weg geht am Zähler in deepl.ts vorbei, also hier buchen (src/demo/grenzen.ts; Review 12.11.2026).
    await verbrauche('deepl', textForDeepL.length);
    const deeplRes = await fetch(`${baseUrl}/v2/translate`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${config.deepl.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!deeplRes.ok) {
      const errText = await deeplRes.text().catch(() => '');
      console.error('[QuickTranslate/alternatives] DeepL HTTP', deeplRes.status, errText);
      res.status(502).json({ error: `DeepL ${deeplRes.status}` });
      return;
    }

    const data = (await deeplRes.json()) as {
      translations?: Array<{ text: string; detected_source_language?: string }>;
    };
    const raw = (data.translations || []).map((t) => t.text);
    const alternatives = raw.map((t) =>
      channelReplacements.size > 0 ? applyPostReplacement(t, channelReplacements) : t,
    );

    // Duplikate entfernen, Reihenfolge erhalten
    const seen = new Set<string>();
    const unique = alternatives.filter((a) => {
      if (seen.has(a)) return false;
      seen.add(a);
      return true;
    });

    res.json({ alternatives: unique, channelCode, formality: formalityApplied(altFormality, targetLang) });
  } catch (err: any) {
    console.error('[QuickTranslate/alternatives] Error:', err.message);
    res.status(500).json({ error: err.message || 'Alternativen-Abruf fehlgeschlagen' });
  }
});

// Wortstellungs-Varianten via LLM (Cheap-Tier).
// Token-sparend: nur auf expliziten Klick, kurze Phrasen, knapper Prompt.
// Im Gegensatz zu /alternatives geht es hier um syntaktische Reorder-Varianten,
// nicht um lexikalische Synonyme — DeepLs `alternatives` liefert Letzteres,
// Word-Order braucht ein LLM.
router.post('/word-order', async (req: Request, res: Response) => {
  const { text, sourceLang, targetLang, baseTranslation, channelCode: rawChannelCode } = req.body as {
    text?: string;
    sourceLang?: string;
    targetLang?: string;
    baseTranslation?: string;
    channelCode?: string | null;
  };

  if (!text || !sourceLang || !targetLang) {
    res.status(400).json({ error: 'text, sourceLang und targetLang sind erforderlich' });
    return;
  }
  if (text.length > 200) {
    res.status(400).json({ error: 'Phrase darf maximal 200 Zeichen lang sein (Token-Schutz)' });
    return;
  }
  if (!config.llm.apiKey) {
    res.status(503).json({ error: 'LLM-Service ist nicht konfiguriert' });
    return;
  }

  const channelCode =
    typeof rawChannelCode === 'string' && rawChannelCode.trim() !== ''
      ? rawChannelCode.trim().toUpperCase()
      : null;

  try {
    // Channel-Overrides als Begriffsvorgabe an das LLM weiterreichen,
    // damit Wortstellungs-Varianten dieselben Termini behalten.
    // Seit 12.11.2026 nur die Glossarbegriffe, die in dieser Phrase stehen (Standard und Channel), nicht mehr alle
    // Channel-Abweichungen des Sprachpaars (`begriffe-im-text.ts`, Phase 6).
    const alle = await ladeBegriffe(sourceLang, targetLang, { channel: channelCode ?? null }).catch(() => []);
    const paare = baseTranslation ? begriffeImText(text, baseTranslation, alle)
      : alle.filter((b) => stehtImText(text, b.deutsch)).slice(0, 25);
    const lockedTerms = paare.map((b) => ({ source: b.deutsch, target: b.ziel }));

    const sourceName = LANG_NAMES[sourceLang.toUpperCase()] || sourceLang;
    const targetName = LANG_NAMES[targetLang.toUpperCase()] || targetLang;
    const lockedHint =
      lockedTerms.length > 0
        ? `\nFeste Begriffe (NICHT verändern): ${lockedTerms.map((t) => `"${t.source}" → "${t.target}"`).join(', ')}`
        : '';
    const baseHint = baseTranslation
      ? `\nReferenz-Übersetzung: "${baseTranslation}"`
      : '';

    const systemPrompt =
      'Du bist Übersetzer für technische LED-Texte. Du lieferst NUR Wortstellungs-Varianten ' +
      'einer Phrase — gleiche Woerter, andere Reihenfolge. KEINE Synonyme, KEINE Begriffsvariation. ' +
      'Antwort: AUSSCHLIESSLICH JSON-Array von 3 Strings, ohne Kommentar, ohne Markdown.';
    const userPrompt =
      `${sourceName} → ${targetName}\nPhrase: "${text}"${baseHint}${lockedHint}\n` +
      `Liefere 3 Varianten mit unterschiedlicher Wortreihenfolge.`;

    const llmResult = await callLlmGeschuetzt(systemPrompt, userPrompt);
    const match = llmResult.text.match(/\[[\s\S]*\]/);
    let alternatives: string[] = [];
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          alternatives = parsed
            .filter((s) => typeof s === 'string')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s.length <= 300);
        }
      } catch {
        /* JSON-Parse-Fehler ignorieren, leer zurückgeben */
      }
    }

    // Case-insensitive Dedup, Referenz-Übersetzung rausfiltern (waere keine Variante)
    const baseKey = baseTranslation?.toLowerCase().trim();
    const seen = new Set<string>();
    const unique = alternatives.filter((a) => {
      const key = a.toLowerCase().trim();
      if (!key || seen.has(key) || key === baseKey) return false;
      seen.add(key);
      return true;
    });

    await logTokenUsage(llmResult, 'word-order').catch(() => {});

    res.json({
      alternatives: unique,
      model: llmResult.model,
      tokens: { input: llmResult.inputTokens, output: llmResult.outputTokens },
      costUsd: llmResult.costUsd,
    });
  } catch (err: any) {
    console.error('[QuickTranslate/word-order] Error:', err.message);
    res.status(500).json({ error: err.message || 'Wortstellungs-Abruf fehlgeschlagen' });
  }
});

export default router;
