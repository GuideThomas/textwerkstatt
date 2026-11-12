/**
 * Batch-Translate Endpoint für interne Service-Calls.
 *
 * Nutzt den Segment-Cache für maximale Cache-Hits (projektübergreifend)
 * und unterstützt Pipe-Split ("|") für zerlegbare Felder wie U_besonderheiten.
 *
 * Auth: Optional via X-Service-Key Header. Wenn config.serviceKey leer ist,
 * wird keine Auth geprüft (Localhost-Vertrauen zwischen internen Services).
 *
 * Clients: Artikelanlage-Assistent (SAP B1 Import-CSV-Generierung)
 */
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { pool } from '../db/connection';
import { translateBatch, ensureGlossarySynced } from '../services/deepl';
import { protectPoleCounts, restorePoleCounts } from '../services/conductor-protection';
import { protectUnits, restoreUnits, fehlendeWerte, zahlenVollstaendig, PLATZHALTER_REST, AKRONYM_KENNWERTE } from '../services/unit-protection';
import { protectAcronymsWithGlossary, restoreAcronyms } from '../services/acronym-protection';
import { anfangWieQuelle } from '../services/anfang-gross';
import { blockWieGlossar, nurBlockEintraege } from '../services/block-woerter';

const router = Router();

/**
 * Das Feld aus seinen Teilen. Fehlt ein Teil, weil dabei ein Wert verloren ging, bleibt das ganze
 * Feld leer: Ein Aufrufer liefert ein leeres Feld nicht, einen lückenhaften Text schon.
 */
export function feldAusTeilen(teile: string[], split: boolean): string {
  if (teile.some((t) => !t)) return '';
  return split ? teile.join(' | ') : teile.join('');
}

interface BatchSegment {
  id: string;
  text: string;
  splitOnPipe?: boolean;
}

interface BatchTranslateRequest {
  segments: BatchSegment[];
  sourceLang: string;
  targetLangs: string[];
  /**
   * Herkunft jeder Übersetzung mitliefern: `cache` oder `deepl`.
   *
   * 🚨 GEBAUT FÜR DIE ÜBERSETZUNGSPRÜFUNG, UND DORT IST ES KEINE ZUSATZANGABE,
   * SONDERN DIE VORAUSSETZUNG FÜR EHRLICHKEIT. Der Segment-Cache ist mit genau
   * den Übersetzungen gefüllt, die der Artikelanlage-Assistent selbst erzeugt
   * hat. Kommt die „Referenz" von dort, vergleicht die Prüfung eine Übersetzung
   * mit sich selbst: Ähnlichkeit 1,0, kein Befund — und das sieht aus wie
   * „geprüft und gut". Ohne diese Angabe wäre die Nicht-Messung unsichtbar
   * ([[principle-pruefer-teilt-quelle-mit-erzeuger]]).
   *
   * Vorgabe `false` — die bestehenden Aufrufer bekommen das Feld nicht.
   */
  withOrigin?: boolean;
}

/** Woher eine einzelne Übersetzung stammt. */
type Herkunft = 'cache' | 'deepl';

interface BatchTranslateResponse {
  translations: Record<string, Record<string, string>>;
  /**
   * Nur bei `withOrigin: true`. Segmente ohne Text fehlen hier — für sie gibt es
   * nichts zu übersetzen und damit auch keine Herkunft.
   *
   * ⚠️ Bei zerlegten Segmenten (`splitOnPipe`) gilt `cache` nur, wenn **jedes**
   * Teilstück aus dem Cache kam. Ein einziges frisch übersetztes Teil macht die
   * Zeile zu `deepl` — sonst behauptete die Angabe eine Unabhängigkeit, die nur
   * für einen Teil des Textes gilt.
   */
  origin?: Record<string, Record<string, Herkunft>>;
  stats: {
    totalSegments: number;
    totalSubSegments: number;
    uniqueSubSegments: number;
    cacheHits: number;
    deeplCalls: number;
    charactersUsed: number;
    /** Texte, bei denen ein geschützter Wert verloren ging; sie kommen nicht in den Cache. */
    wertVerloren: number;
  };
}

/** Shared-Secret-Guard (optional). */
function requireServiceKey(req: Request, res: Response, next: NextFunction): void {
  const expected = config.serviceKey;
  if (!expected) {
    // Kein Key konfiguriert → Auth übersprungen (Localhost-Interne-Services)
    next();
    return;
  }
  const provided = req.header('X-Service-Key') || '';
  if (provided !== expected) {
    res.status(401).json({ error: 'Invalid or missing X-Service-Key' });
    return;
  }
  next();
}

/** SHA-256 Hash eines Textes. */
function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Quelltext in Sub-Segmente zerlegen. */
function splitSegment(text: string, splitOnPipe: boolean): string[] {
  if (!splitOnPipe) return [text];
  return text
    .split('|')
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

router.post('/', requireServiceKey, async (req: Request, res: Response) => {
  const body = req.body as BatchTranslateRequest;

  if (!body || !Array.isArray(body.segments) || typeof body.sourceLang !== 'string' || !Array.isArray(body.targetLangs)) {
    res.status(400).json({ error: 'segments (array), sourceLang (string) und targetLangs (array) erforderlich' });
    return;
  }
  if (body.segments.length === 0) {
    res.json({
      translations: {},
      stats: { totalSegments: 0, totalSubSegments: 0, uniqueSubSegments: 0, cacheHits: 0, deeplCalls: 0, charactersUsed: 0 },
    } as BatchTranslateResponse);
    return;
  }
  if (body.targetLangs.length === 0) {
    res.status(400).json({ error: 'targetLangs darf nicht leer sein' });
    return;
  }

  const sourceLang = body.sourceLang.toUpperCase();
  const targetLangs = body.targetLangs.map(l => l.toUpperCase());

  try {
    // 1) Sub-Segmente extrahieren und hash-basiert deduplizieren.
    //    segmentSubs: originaler segment.id → Array der Sub-Hashes (Reihenfolge relevant für Reassembly)
    //    segmentSplit: segment.id → splitOnPipe-Flag (für Reassembly-Join)
    //    uniqueTextByHash: hash → Quelltext (dedupliziert)
    const segmentSubs: Record<string, string[]> = {};
    const segmentSplit: Record<string, boolean> = {};
    const uniqueTextByHash = new Map<string, string>();
    let totalSubSegments = 0;

    for (const seg of body.segments) {
      if (!seg || typeof seg.id !== 'string' || typeof seg.text !== 'string') continue;
      if (seg.text.trim() === '') {
        segmentSubs[seg.id] = [];
        segmentSplit[seg.id] = !!seg.splitOnPipe;
        continue;
      }
      const parts = splitSegment(seg.text, !!seg.splitOnPipe);
      const hashes: string[] = [];
      for (const p of parts) {
        const h = hashText(p);
        hashes.push(h);
        if (!uniqueTextByHash.has(h)) uniqueTextByHash.set(h, p);
      }
      segmentSubs[seg.id] = hashes;
      segmentSplit[seg.id] = !!seg.splitOnPipe;
      totalSubSegments += parts.length;
    }

    const uniqueHashes = Array.from(uniqueTextByHash.keys());

    // 2) Cache-Lookup: für jede (hash, targetLang) Kombination.
    //    Ergebnis: translationMap[hash][targetLang] = translatedText | null
    const translationMap: Record<string, Record<string, string>> = {};
    // Herkunft je (hash, targetLang) — wird immer mitgefuehrt, aber nur bei
    // `withOrigin` ausgeliefert. Zwei Buchfuehrungen fuer dieselbe Sache waeren
    // die groessere Fehlerquelle als ein ungenutztes Objekt.
    const originMap: Record<string, Record<string, Herkunft>> = {};
    for (const h of uniqueHashes) { translationMap[h] = {}; originMap[h] = {}; }

    // Wir nehmen das Risiko von 9x N Einzelabfragen — bleibt pro Request
    // deutlich unter DB-Roundtrip-Kosten der DeepL-Calls selbst.
    // Für bessere Performance könnte man IN (...) mit GROUP BY target nutzen.
    let cacheHits = 0;
    const missesByTarget: Record<string, { hashes: string[]; texts: string[] }> = {};
    for (const t of targetLangs) missesByTarget[t] = { hashes: [], texts: [] };

    if (uniqueHashes.length > 0) {
      for (const targetLang of targetLangs) {
        const cacheResult = await pool.query(
          // VOLLSTAENDIGE Schluesselbedingung. Diese Route geht mit eigenem SQL
          // an `upsertSegment` vorbei — der Typecheck sieht sie also nicht, wenn
          // dort eine Cache-Dimension dazukommt. Bis 14.08.2026 fehlten hier
          // `channel_code` und `glossary_disabled`; folgenlos blieb das nur,
          // weil praktisch kein Bestand eine abweichende Dimension trug
          // (0 von 5.880 mit glossary_disabled, 34 mit channel_code).
          // `formality` waere die erste Dimension, die tatsaechlich zwei Zeilen
          // zu einem Text erzeugt — und damit die erste, bei der diese Route
          // eine formelle Fassung als Produktdaten-Treffer ausliefern wuerde.
          // Artikeldaten sind immer neutral: channel_code IS NULL,
          // glossary_disabled = FALSE, formality = 'default'.
          `SELECT segment_hash, translated_text, is_stale, edited_by_user
           FROM segments
           WHERE segment_hash = ANY($1::text[])
             AND source_lang = $2
             AND target_lang = $3
             AND channel_code IS NULL
             AND glossary_disabled = FALSE
             AND formality = 'default'`,
          [uniqueHashes, sourceLang, targetLang],
        );
        const cached = new Map<string, { text: string | null; stale: boolean; edited: boolean }>();
        for (const row of cacheResult.rows as Array<{ segment_hash: string; translated_text: string | null; is_stale: boolean; edited_by_user: boolean | null }>) {
          cached.set(row.segment_hash, { text: row.translated_text, stale: row.is_stale, edited: row.edited_by_user === true });
        }

        for (const h of uniqueHashes) {
          const hit = cached.get(h);
          // Eine von Menschen bearbeitete Fassung gilt auch dann, wenn sie als veraltet markiert ist.
          // Bis 04.11.2026 überschrieb die Neuübersetzung sie wortlos.
          if (hit && hit.text && (!hit.stale || hit.edited)) {
            translationMap[h][targetLang] = hit.text;
            originMap[h][targetLang] = 'cache';
            cacheHits++;
          } else {
            missesByTarget[targetLang].hashes.push(h);
            missesByTarget[targetLang].texts.push(uniqueTextByHash.get(h)!);
          }
        }
      }
    }

    // 3) Cache-Misses: DeepL-Übersetzung pro Zielsprache (mit Glossar-Sync).
    let deeplCalls = 0;
    let charactersUsed = 0;
    let wertVerloren = 0;

    for (const targetLang of targetLangs) {
      const miss = missesByTarget[targetLang];
      if (miss.hashes.length === 0) continue;

      const glossaryId = await ensureGlossarySynced(sourceLang, targetLang);
      const glossaryVersionResult = await pool.query(
        `SELECT version FROM glossaries WHERE source_lang = $1 AND target_lang = $2 LIMIT 1`,
        [sourceLang, targetLang],
      );
      const currentGlossaryVersion = glossaryVersionResult.rows[0]?.version ?? 0;

      // Akronym-Pass: `CRI90` mit Glossar `CRI → IRC` wird `IRC90`. Muss VOR dem Einheiten-Schutz
      // laufen, der `CRI90` sonst maskiert: DeepL und Glossar sehen den Begriff dann nie.
      // Im Projektweg (`queue.ts`) gibt es den Pass seit 22.05.2026, hier fehlte er bis 04.11.2026;
      // französisch fiel IRC seit Mai von 317 auf 10 Namen.
      const akronymEintraege = await pool.query(
        `SELECT e.source_term, e.target_term
         FROM glossar_an_deepl e JOIN glossaries g ON g.id = e.glossary_id
         WHERE g.source_lang = $1 AND g.target_lang = $2
           AND e.source_term = ANY($3::text[]) AND e.source_term <> e.target_term`,
        [sourceLang, targetLang, AKRONYM_KENNWERTE],
      );
      const akronymProts = miss.texts.map((t) => protectAcronymsWithGlossary(t, akronymEintraege.rows));

      // Begriffe in Blockbuchstaben: Die Schreibung des Glossarwerts setzt erst der Schritt nach der Übersetzung durch.
      const blockEintraege = nurBlockEintraege((await pool.query<{ source_term: string; target_term: string }>(
        `SELECT e.source_term, e.target_term
         FROM glossar_an_deepl e JOIN glossaries g ON g.id = e.glossary_id
         WHERE g.source_lang = $1 AND g.target_lang = $2
           AND e.source_term = upper(e.source_term) AND e.target_term = upper(e.target_term)`,
        [sourceLang, targetLang],
      )).rows);

      // Pol-/Litzenzahl-Schutz: `4-polig`, `2-pol.` etc. vor DeepL durch
      // Sentinels ersetzen und mit der Zielsprachen-Form (EN `4-pole`, ...)
      // restoren — sonst verschluckt DeepL die Litzenanzahl im Artikelnamen.
      const poleProts = akronymProts.map((a) => protectPoleCounts(a.protectedText, targetLang));
      // Einheiten-Schutz: kompakt geschriebene Tokens (`12W`, `CRI90`) bleiben
      // verbatim erhalten — DeepL wuerde sie sonst zielsprachen-typisch trennen.
      const unitProts = poleProts.map((p) => protectUnits(p.protectedText, targetLang));
      const protectedTexts = unitProts.map((p) => p.protectedText);

      const results = await translateBatch(protectedTexts, {
        sourceLang,
        targetLang,
        glossaryId,
      });
      deeplCalls += miss.texts.length;
      charactersUsed += miss.texts.reduce((sum, t) => sum + t.length, 0);

      // 4) Ergebnisse in Cache persistieren (UPSERT auf (hash, source, target)).
      for (let i = 0; i < results.length; i++) {
        const h = miss.hashes[i];
        const text = miss.texts[i];
        let translated = anfangWieQuelle(text, blockWieGlossar(text, restoreAcronyms(
          restorePoleCounts(
            restoreUnits(results[i].translatedText, unitProts[i].restoreMap),
            poleProts[i].restoreMap,
          ),
          akronymProts[i].restoreMap,
        ), blockEintraege));
        translationMap[h][targetLang] = translated;
        originMap[h][targetLang] = 'deepl';

        // Fehlt ein geschützter Wert oder steht noch ein Platzhalter da, kommt der Text nicht in den
        // Cache: Ein zweiter Versuch ohne Platzhalter, und es geht eine Meldung an den Aufrufer.
        const fehlend = [
          ...fehlendeWerte(translated, unitProts[i].restoreMap),
          ...fehlendeWerte(translated, poleProts[i].restoreMap),
          ...fehlendeWerte(translated, akronymProts[i].restoreMap),
        ];
        if (fehlend.length > 0 || PLATZHALTER_REST.test(translated)) {
          wertVerloren++;
          console.warn(`[BatchTranslate] ${targetLang}: Wert verloren (${fehlend.join(', ') || 'Platzhalter'}): „${text.slice(0, 80)}“`);
          const [ohneSchutz] = await translateBatch([text], { sourceLang, targetLang, glossaryId });
          deeplCalls += 1;
          charactersUsed += text.length;
          if (ohneSchutz && zahlenVollstaendig(text, ohneSchutz.translatedText)) {
            translated = anfangWieQuelle(text, blockWieGlossar(text, ohneSchutz.translatedText, blockEintraege));
            translationMap[h][targetLang] = translated;
          } else {
            // Auch der zweite Versuch trägt nicht alle Werte: nicht ausliefern. Das leere Feld
            // zählt beim Aufrufer als „ohne Übersetzung", die Zeile geht nicht nach SAP.
            delete translationMap[h][targetLang];
          }
          continue;
        }

        // Prüfen ob bereits ein Cache-Eintrag existiert (z.B. stale)
        const existing = await pool.query(
          // Dieselbe vollstaendige Bedingung wie oben: ohne sie wuerde das
          // folgende UPDATE eine formelle Zeile mit der neutralen Uebersetzung
          // ueberschreiben.
          `SELECT id FROM segments
            WHERE segment_hash = $1 AND source_lang = $2 AND target_lang = $3
              AND channel_code IS NULL AND glossary_disabled = FALSE
              AND formality = 'default'`,
          [h, sourceLang, targetLang],
        );
        if (existing.rows.length > 0) {
          await pool.query(
            `UPDATE segments
             SET translated_text = $2, glossary_version = $3, is_stale = FALSE
             WHERE id = $1 AND edited_by_user IS NOT TRUE`,
            [existing.rows[0].id, translated, currentGlossaryVersion],
          );
        } else {
          await pool.query(
            // channel_code/glossary_disabled/formality ausdruecklich neutral —
            // die Spalten-Defaults leisten dasselbe, aber ausgeschrieben faellt
            // beim naechsten Lesen auf, dass diese Route eine Dimension hat.
            `INSERT INTO segments (segment_hash, source_lang, target_lang, channel_code, glossary_disabled, formality,
                                   source_text, translated_text, glossary_version, is_stale)
             VALUES ($1, $2, $3, NULL, FALSE, 'default', $4, $5, $6, FALSE)
             ON CONFLICT DO NOTHING`,
            [h, sourceLang, targetLang, text, translated, currentGlossaryVersion],
          );
        }
      }
    }

    // 5) Reassembly: pro Segment × pro Zielsprache die Sub-Übersetzungen joinen.
    const outTranslations: Record<string, Record<string, string>> = {};
    const outOrigin: Record<string, Record<string, Herkunft>> = {};
    for (const seg of body.segments) {
      if (!seg || typeof seg.id !== 'string') continue;
      const hashes = segmentSubs[seg.id] || [];
      const split = segmentSplit[seg.id];
      outTranslations[seg.id] = {};
      for (const targetLang of targetLangs) {
        if (hashes.length === 0) {
          outTranslations[seg.id][targetLang] = '';
          continue;
        }
        const parts = hashes.map(h => translationMap[h]?.[targetLang] ?? '');
        outTranslations[seg.id][targetLang] = feldAusTeilen(parts, split);

        // `cache` nur, wenn JEDES Teilstueck aus dem Cache kam — siehe origin.
        if (!outOrigin[seg.id]) outOrigin[seg.id] = {};
        outOrigin[seg.id][targetLang] =
          hashes.every(h => originMap[h]?.[targetLang] === 'cache') ? 'cache' : 'deepl';
      }
    }

    const response: BatchTranslateResponse = {
      translations: outTranslations,
      ...(body.withOrigin ? { origin: outOrigin } : {}),
      stats: {
        totalSegments: body.segments.length,
        totalSubSegments,
        uniqueSubSegments: uniqueHashes.length,
        cacheHits,
        deeplCalls,
        charactersUsed,
        wertVerloren,
      },
    };

    res.json(response);
  } catch (err: any) {
    console.error('[BatchTranslate] Error:', err);
    res.status(500).json({ error: err.message || 'Batch-translate fehlgeschlagen' });
  }
});

export default router;
