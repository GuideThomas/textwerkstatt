/**
 * Übersetzungsprüfung Schicht 2 + 3 für interne Service-Calls.
 *
 * Nimmt fertige Tripel (Quelltext · vorhandene Übersetzung · DeepL-Referenz),
 * bestimmt die Abweichungen (Schicht 2) und lässt sie vom LLM einordnen
 * (Schicht 3). Keine DB-Schreibvorgänge ausser der Token-Buchführung — der
 * Aufrufer ist für Persistenz selbst zuständig, genau wie bei `/api/condense`.
 *
 * Auth: Optional via X-Service-Key Header (wie /api/batch-translate).
 *
 * Clients: Artikelanlage-Assistent (inhaltliche Prüfung vorhandener
 * SAP-Übersetzungen, PLAN-Stufe1-Delta)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🚨 DIE DEEPL-REFERENZ WIRD HIER NICHT GEHOLT, SONDERN MITGEBRACHT. Das ist
 * die zentrale Entscheidung dieses Endpunkts und keine Bequemlichkeit: Der
 * Aufrufer beschafft sie über `/api/batch-translate` — also über **genau den
 * Weg, auf dem seine echten Übersetzungen entstehen**, samt Glossar-Sync,
 * Pol-/Litzenzahl-Schutz, Einheiten-Schutz und Pipe-Zerlegung. Holte dieser
 * Endpunkt die Referenz selbst, müsste er diese Kette nachbauen — und jede
 * Regel, die dabei fehlt, erzeugt eine systematische Abweichung an jedem
 * Artikel mit einer Einheit im Namen. Das wäre kein Befund, sondern ein
 * Dauerfehlalarm.
 *
 * 🚨 WAS DAS LLM HIER NICHT WEISS: DAS GLOSSAR. Der Prompt aus
 * `terminology-scan.ts` nennt nur „LED-Beleuchtung". Die Kategorie
 * `TERMINOLOGY` heisst deshalb „das Modell hält das für Firmenterminologie" —
 * nicht „das Glossar verlangt etwas anderes". Das Glossar wirkt ausschliesslich
 * **indirekt**, nämlich über die DeepL-Referenz, die mit ihm erzeugt wurde.
 * Die ungekürzte Glossar-Liste in den Prompt zu geben ist am 16.08.2026
 * gemessen und zurückgenommen worden (Commit ad808ae: 21,3 % Streuung gegen
 * 7,5 % Eigenstreuung, ohne erkennbaren Gewinn) — nicht erneut versuchen, ohne
 * diese Messung zu lesen.
 *
 * 🚨 EIN LLM-AUSFALL DARF NICHT ALS „KEINE BEFUNDE" ANKOMMEN. Bricht die
 * Analyse ab (Budget, Key), stehen die Schicht-2-Abweichungen weiterhin — nur
 * ohne Einordnung. Die Antwort sagt das in `llm.ausgefallen` ausdrücklich,
 * statt eine leere Kandidatenliste zu liefern, die sich wie ein sauberes
 * Ergebnis liest ([[principle-anzeige-ohne-messung-behauptet]]).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { detectDifferences, analyzeBatch, textSimilarity } from '../services/terminology-scan';
import { LlmTerminalError } from '../services/llm';
import type { AlignedSegment, DiffSegment } from '../types';
import { requireServiceKeyOrLocal } from '../middleware/dienstzugang';

const router = Router();

/**
 * Obergrenze je Anfrage. Der Aufrufer kappt selbst kleiner (der
 * Artikelanlage-Assistent bei 500 Slots); diese Schranke ist die zweite Reihe
 * gegen einen Client, der es nicht tut — sonst hinge die Kostenobergrenze
 * dieses Dienstes an fremdem Code ([[principle-fail-open-default-trap]]).
 */
const MAX_PAARE = 2_000;

/**
 * Wie viele Abweichungen höchstens ans LLM gehen.
 *
 * 🚨 GEMESSEN AM 28.08.2026 AN 203 ECHTEN SAP-SLOTS: **78,3 % lagen unter der
 * Schwelle 0,95**, Median der Abweichungen 0,486. Die Schwelle stammt aus dem
 * Terminologie-Scan, der **Fliesstext aus Dokumenten** vergleicht — dort ist
 * eine menschliche Fassung der Maschinenfassung strukturell ähnlich.
 * SAP-Artikelnamen sind das Gegenteil: kurz, abgekürzt, technisch dicht, und
 * die gepflegte Übersetzung folgt eigenen Konventionen. Levenshtein auf solchen
 * Zeichenketten schlägt fast immer aus.
 *
 * **Konsequenz: Schicht 2 ist für diese Textsorte ein Rangordner, kein
 * Detektor.** „Weicht ab" ist hier die Regel; interessant ist, *wie stark*.
 * Ans Modell gehen deshalb die **auffälligsten** Abweichungen — nicht alle.
 * Ohne diese Kappung kostete ein Klick auf 500 Slots rund 390 LLM-Bewertungen
 * für eine Liste, die niemand liest ([[principle-metrik-passt-zur-fehlerklasse]]).
 */
const LLM_OBERGRENZE_VORGABE = 40;
const LLM_OBERGRENZE_MAX = 200;

export interface PruefPaar {
  /** Kennung des Aufrufers, unverändert zurückgegeben. */
  id: string;
  targetLang: string;
  sourceText: string;
  existingTranslation: string;
  deeplTranslation: string;
  /**
   * Harte Zeichengrenze des Zielfeldes, falls es eine gibt (SAP `ItemName`: 100).
   *
   * 🚨 OHNE DIESE ANGABE MELDET SCHICHT 2 DIE VERDICHTUNG ALS FEHLER. Der echte
   * Übersetzungslauf kürzt zu lange Artikelnamen per LLM auf die Feldgrenze; die
   * vorhandene Übersetzung ist dann bewusst kürzer als die ungekürzte Referenz.
   * Ein Ähnlichkeitsvergleich sieht davon nur die Abweichung. Solche Paare
   * werden deshalb als **nicht auswertbar** ausgewiesen statt als Befund.
   */
  maxChars?: number;
  /** Herkunft der Referenz aus `/api/batch-translate` (`withOrigin: true`). */
  referenzHerkunft?: 'cache' | 'deepl';
}

/** Ein Paar, das Schicht 2 nicht beurteilen kann — mit dem Grund dafür. */
export interface NichtAuswertbar {
  id: string;
  targetLang: string;
  grund: 'verdichtet' | 'referenz_aus_eigenem_cache' | 'referenz_leer';
}

/**
 * Trennt die Paare, bevor irgendetwas verglichen wird.
 *
 * 🚨 EIGENE FUNKTION, WEIL HIER DIE FEHLALARME ENTSTEHEN — und weil sie ohne
 * Datenbank, ohne DeepL und ohne LLM prüfbar sein muss. Drei Fälle:
 *
 *   `referenz_leer`   Keine Referenz erhalten. Als „gleich" durchzulassen
 *                     hiesse, ein fehlendes Ergebnis wie ein gutes aussehen zu
 *                     lassen ([[principle-anzeige-ohne-messung-behauptet]]).
 *   `verdichtet`      Der echte Übersetzungslauf kürzt zu lange Artikelnamen
 *                     per LLM auf die Feldgrenze; die vorhandene Übersetzung
 *                     ist dann bewusst kürzer als die ungekürzte Referenz. Ein
 *                     Ähnlichkeitsvergleich sähe davon nur die Abweichung und
 *                     meldete jeden gekürzten Namen als Befund.
 *   `referenz_aus_eigenem_cache`
 *                     ⚠️ Dieser Fall wird NICHT aussortiert, sondern nur
 *                     markiert: Der Vergleich bleibt gültig (die vorhandene
 *                     Übersetzung muss nicht aus diesem Cache stammen), aber die
 *                     Referenz ist möglicherweise nicht unabhängig. Diese
 *                     Unterscheidung gehört in die Anzeige, nicht in einen
 *                     stillen Filter.
 */
export function teilePaareAuf(paare: PruefPaar[]): {
  auswertbar: PruefPaar[];
  nichtAuswertbar: NichtAuswertbar[];
} {
  const auswertbar: PruefPaar[] = [];
  const nichtAuswertbar: NichtAuswertbar[] = [];

  for (const p of paare) {
    if (p.deeplTranslation.trim() === '') {
      nichtAuswertbar.push({ id: p.id, targetLang: p.targetLang, grund: 'referenz_leer' });
      continue;
    }
    if (p.maxChars && p.deeplTranslation.length > p.maxChars
        && p.existingTranslation.length <= p.maxChars) {
      nichtAuswertbar.push({ id: p.id, targetLang: p.targetLang, grund: 'verdichtet' });
      continue;
    }
    if (p.referenzHerkunft === 'cache') {
      nichtAuswertbar.push({
        id: p.id, targetLang: p.targetLang, grund: 'referenz_aus_eigenem_cache',
      });
    }
    auswertbar.push(p);
  }

  return { auswertbar, nichtAuswertbar };
}

interface Befund {
  id: string;
  targetLang: string;
  aehnlichkeit: number;
  sourceText: string;
  existingTranslation: string;
  deeplTranslation: string;
  /** Schicht 3 — fehlt, wenn das LLM abgeschaltet war oder nichts fand. */
  kategorie?: 'TERMINOLOGY' | 'STYLE' | 'ERROR' | 'CONTEXT';
  zuversicht?: number;
  quellTerm?: string;
  bestandTerm?: string;
  deeplTerm?: string;
  begruendung?: string;
}

/**
 * Welche Abweichungen ans Modell gehen — die auffälligsten zuerst.
 *
 * 🚨 EIGENE FUNKTION, WEIL HIER DIE KOSTEN ENTSTEHEN und weil die Ordnung
 * prüfbar sein muss. Bei einer gemessenen Abweichungsquote von 78 % ist „alle
 * einordnen" eine Rechnung über fast jeden Slot; die Auswahl entscheidet also,
 * was der Nutzer für sein Geld sieht. Aufsteigend nach Ähnlichkeit: das
 * Unähnlichste zuerst, weil dort die Aussicht auf einen echten Fehler am
 * grössten ist.
 *
 * ⚠️ Die Übersprungenen verschwinden NICHT — sie stehen weiterhin in `befunde`,
 * nur ohne Einordnung, und die Antwort nennt ihre Zahl.
 */
export function waehleFuerLlm(diffs: DiffSegment[], obergrenze: number): DiffSegment[] {
  return [...diffs]
    .sort((a, b) =>
      textSimilarity(a.existingTranslation, a.deeplTranslation)
      - textSimilarity(b.existingTranslation, b.deeplTranslation))
    .slice(0, Math.max(0, obergrenze));
}

function requireServiceKey(req: Request, res: Response, next: NextFunction): void {
  const expected = config.serviceKey;
  if (!expected) {
    // Kein Schlüssel heißt zu, nicht offen (Grundsatz G4, Review 13.11.2026): dann nur direkt vom selben Rechner.
    requireServiceKeyOrLocal(req, res, next);
    return;
  }
  const provided = req.header('X-Service-Key') || '';
  if (provided !== expected) {
    res.status(401).json({ error: 'Invalid or missing X-Service-Key' });
    return;
  }
  next();
}

router.post('/', requireServiceKey, async (req: Request, res: Response) => {
  const body = req.body as { paare?: unknown; mitLlm?: boolean; llmObergrenze?: number };

  if (!body || !Array.isArray(body.paare)) {
    res.status(400).json({ error: 'paare (array) erforderlich' });
    return;
  }
  if (body.paare.length > MAX_PAARE) {
    res.status(413).json({
      error: `Zu viele Paare (${body.paare.length}). Hoechstens ${MAX_PAARE} je Anfrage.`,
    });
    return;
  }

  const paare = (body.paare as PruefPaar[]).filter(
    (p) => p && typeof p.id === 'string' && typeof p.targetLang === 'string'
      && typeof p.sourceText === 'string' && typeof p.existingTranslation === 'string'
      && typeof p.deeplTranslation === 'string',
  );
  const mitLlm = body.mitLlm !== false;
  const llmObergrenze = Math.min(
    LLM_OBERGRENZE_MAX,
    Math.max(0, Number.isFinite(body.llmObergrenze) ? Number(body.llmObergrenze) : LLM_OBERGRENZE_VORGABE),
  );

  try {
    const { auswertbar, nichtAuswertbar } = teilePaareAuf(paare);

    // Schicht 2: Abweichung ja/nein über dieselbe Schwelle wie der
    // Terminologie-Scan (0,95) — `detectDifferences` wird aufgerufen, nicht
    // nachgebaut. Die Ähnlichkeitszahl kommt aus derselben Funktion, die die
    // Schwelle zieht.
    const aligned: AlignedSegment[] = auswertbar.map((p, i) => ({
      position: i,
      sourceText: p.sourceText,
      existingTranslation: p.existingTranslation,
    }));
    const diffs = detectDifferences(aligned, auswertbar.map((p) => p.deeplTranslation));

    const befundJeIndex = new Map<number, Befund>();
    for (const d of diffs) {
      const p = auswertbar[d.position];
      befundJeIndex.set(d.position, {
        id: p.id,
        targetLang: p.targetLang,
        aehnlichkeit: Number(textSimilarity(p.existingTranslation, p.deeplTranslation).toFixed(4)),
        sourceText: p.sourceText,
        existingTranslation: p.existingTranslation,
        deeplTranslation: p.deeplTranslation,
      });
    }

    // Schicht 3: je Zielsprache getrennt. Der Prompt nennt die Sprache nicht —
    // ein Batch aus EN, FR und IT nebeneinander zwingt das Modell, sie aus dem
    // Text zu erraten. Getrennt kostet dasselbe (abgerechnet wird je Token) und
    // stellt die Frage sauber.
    let llmBatches = 0;
    let llmKostenUsd = 0;
    let ausgefallen = false;
    let llmFehler: string | undefined;

    const angesehen = waehleFuerLlm(diffs, llmObergrenze);
    const uebersprungen = diffs.length - angesehen.length;

    if (mitLlm && angesehen.length > 0) {
      const jeSprache = new Map<string, typeof diffs>();
      for (const d of angesehen) {
        const lang = auswertbar[d.position].targetLang;
        if (!jeSprache.has(lang)) jeSprache.set(lang, []);
        jeSprache.get(lang)!.push(d);
      }

      for (const [lang, gruppe] of jeSprache) {
        if (ausgefallen) break;   // ein Budget-/Key-Fehler heilt keine zweite Sprache
        try {
          const { candidates, totalCost } = await analyzeBatch(gruppe, `sap-slots-${lang}`);
          llmKostenUsd += totalCost;
          llmBatches += Math.ceil(gruppe.length / 6);
          for (const c of candidates) {
            const b = befundJeIndex.get(c.position);
            if (!b) continue;
            b.kategorie = c.category as Befund['kategorie'];
            b.zuversicht = c.confidence;
            b.quellTerm = c.source_term;
            b.bestandTerm = c.existing_term;
            b.deeplTerm = c.deepl_term;
            b.begruendung = c.explanation || undefined;
          }
        } catch (err: any) {
          // 🚨 Nicht schlucken. Ohne diese Meldung sähe eine abgebrochene
          // Analyse aus wie „das LLM hat nichts gefunden".
          ausgefallen = true;
          llmFehler = err instanceof LlmTerminalError
            ? `LLM-Analyse abgebrochen (${err.kind}): ${err.message}`
            : `LLM-Analyse fehlgeschlagen: ${err?.message ?? 'unbekannt'}`;
          console.error(`[UebersetzungPruefung] ${llmFehler}`);
        }
      }
    }

    // Auffälligstes zuerst — dieselbe Ordnung, in der das Modell gefragt wurde.
    const befunde = [...befundJeIndex.values()].sort((a, b) => a.aehnlichkeit - b.aehnlichkeit);
    res.json({
      geprueft: paare.length,
      verglichen: auswertbar.length,
      abweichungen: befunde.length,
      eingeordnet: befunde.filter((b) => b.kategorie).length,
      nichtAuswertbar,
      befunde,
      llm: {
        angefragt: mitLlm,
        // 🚨 Wieviele das Modell gesehen hat und wieviele nicht — ohne diese
        // beiden Zahlen sähe eine gekappte Einordnung aus wie eine vollständige
        // ([[principle-metrik-passt-zur-fehlerklasse]]).
        angesehen: mitLlm ? angesehen.length : 0,
        uebersprungen: mitLlm ? uebersprungen : befunde.length,
        obergrenze: llmObergrenze,
        batches: llmBatches,
        kostenUsd: Number(llmKostenUsd.toFixed(6)),
        ausgefallen,
        ...(llmFehler ? { fehler: llmFehler } : {}),
      },
      schwelle: 0.95,
    });
  } catch (err: any) {
    console.error('[UebersetzungPruefung] Error:', err);
    res.status(500).json({ error: err?.message || 'Uebersetzungspruefung fehlgeschlagen' });
  }
});

export default router;
