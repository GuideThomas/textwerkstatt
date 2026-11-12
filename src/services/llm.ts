import OpenAI from 'openai';
import { config } from '../config';
import { pool } from '../db/connection';
import { verbrauche } from '../demo/grenzen';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (!config.llm.apiKey) {
      throw new Error('LLM_API_KEY is not configured');
    }
    client = new OpenAI({
      baseURL: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      timeout: config.llm.timeoutMs,
    });
  }
  return client;
}

export interface LlmResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  usedFallback: boolean;
}

/**
 * Berechnet Kosten basierend auf der Pricing-Map in config.
 */
/** Provider-Präfix entfernen: "deepseek/deepseek-chat" → "deepseek-chat". */
function stripProvider(model: string): string {
  const i = model.indexOf('/');
  return i === -1 ? model : model.slice(i + 1);
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  // Exakter Key, sonst präfix-tolerant (LiteLLM-Aliase kommen ohne "provider/"-Präfix).
  let pricing: { input: number; output: number } | undefined = config.pricing[model];
  if (!pricing) {
    const bare = stripProvider(model);
    pricing =
      config.pricing[bare] ??
      Object.entries(config.pricing).find(([k]) => stripProvider(k) === bare)?.[1];
  }
  if (!pricing) {
    // Nicht still 0 zurückgeben — sonst bleibt ein Modellnamen-Mismatch unbemerkt
    // und das Kosten-Dashboard steht dauerhaft auf 0,- (Bug 24.06.2026).
    console.warn(
      `[LLM] Keine Preis-Map für Modell "${model}" — cost_usd=0. ` +
        `config.pricing in config.ts um diesen Modellnamen ergänzen.`,
    );
    return 0;
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Echte Request-Kosten aus dem LiteLLM-Response-Header lesen.
 *
 * LiteLLM reicht die tatsächlichen Kosten im Proxy-Modus NICHT im JSON-Body durch
 * (`_hidden_params` wird beim HTTP-Serialisieren gestrippt — empirisch verifiziert
 * 11.07.2026), sondern ausschließlich im Header `x-litellm-response-cost`.
 * Dieser Wert ist LiteLLMs echte Preisberechnung für das TATSÄCHLICH geroutete
 * Deployment und damit genauer als unsere statische config.pricing-Map — die z.B.
 * nicht mitbekommt, dass der `deepseek-chat`-Alias serverseitig umgehängt wurde.
 * Fällt der Header weg (fehlt/unparsbar), greift calculateCost() als Fallback.
 */
function parseResponseCostHeader(response: Response | undefined): number | null {
  const raw = response?.headers?.get?.('x-litellm-response-cost');
  if (raw == null) return null;
  const cost = Number.parseFloat(raw);
  if (!Number.isFinite(cost) || cost < 0) return null;
  return cost;
}

/**
 * Fehler, den kein Wiederholen und kein anderes Modell heilt: das Tagesbudget des
 * Virtual Key ist erschöpft (429) oder der Key ist ungültig (401/403).
 *
 * Warum eigener Typ: Am 07.08.2026 setzte das Tool zwischen 09:07 und 09:11 **942
 * Requests** ab, die LiteLLM ausnahmslos mit 429 abwies — Ursache laut
 * DB-Traceback `_virtual_key_max_budget_check`, das $1-Tagesbudget war weg. Die
 * Zahl ist kein Zufall: jeder Aufruf probierte erst das primäre, dann das
 * Fallback-Modell (471 × 2). Beide hängen am selben Key, also scheiterte der
 * Fallback aus demselben Grund — und die aufrufenden Schleifen liefen weiter,
 * Segment für Segment. Ein Budget-Limit ist eine harte Grenze, kein wackelnder
 * Provider: Ausweichen und Wiederholen erzeugen dort nur Last und Lograuschen.
 */
export class LlmTerminalError extends Error {
  constructor(
    message: string,
    readonly kind: 'budget' | 'auth',
    readonly model: string,
  ) {
    super(message);
    this.name = 'LlmTerminalError';
  }
}

function classifyTerminal(err: any, model: string): LlmTerminalError | null {
  const status = err?.status ?? err?.response?.status;
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.error ?? '')}`.toLowerCase();
  if (status === 401 || status === 403) {
    return new LlmTerminalError(`LLM-Key abgelehnt (${status}): ${err?.message}`, 'auth', model);
  }
  // 429 ist zweideutig: Rate-Limit (transient, Wiederholen sinnvoll) vs.
  // Budget-Grenze (terminal). LiteLLM nennt das Budget im Fehlertext.
  if (status === 429 && /budget|max_budget|exceeded budget|spend/.test(text)) {
    return new LlmTerminalError(
      `LLM-Budget erschöpft (429): ${err?.message}`,
      'budget',
      model,
    );
  }
  return null;
}

/**
 * Sperre bis zum nächsten Budget-Reset (LiteLLM setzt täglich um 00:00 UTC zurück).
 * Ohne sie würde nach dem ersten erkannten Budget-Fehler jedes weitere Segment
 * denselben Aufruf erneut versuchen — der beobachtete Schaden vom 07.08. entstand
 * genau so. Prozessweit und bewusst ohne Persistenz: nach einem Neustart darf es
 * einen Versuch kosten, festzustellen, ob wieder Budget da ist.
 */
let budgetLockedUntil = 0;

function nextBudgetResetMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}

/** Nur für Tests/Diagnose: aktuelle Sperre aufheben. */
export function resetLlmBudgetLock(): void {
  budgetLockedUntil = 0;
}

/** Nur für Tests/Diagnose: bis wann `callLlm` gesperrt ist (0 = nicht gesperrt). Belegt in `check-ki-weg.ts`, dass eine
 *  Budgetsperre der Textwerkstatt (`services/ki-weg.ts`, je Schlüssel) diese prozessweite Sperre nicht auslöst. */
export function llmBudgetSperreBis(): number {
  return budgetLockedUntil;
}

/**
 * LLM-Call, auf Wunsch mit Ausweichmodell.
 *
 * Seit 11.11.2026 (Phase 6, Entscheid Thomas) weicht nur aus, wer `fallback: true` sagt: Kürzen und Namensfassung,
 * wo ein Ausfall eine Artikelanlage aufhält und nur Katalogtext hinausgeht. Alle anderen Wege melden den Fehler. Bis dahin
 * wich jeder Aufruf auf Gemini aus, also auch Freitext an einen anderen Anbieter.
 *
 * Ausnahme: terminale Key-/Budget-Fehler (siehe LlmTerminalError) übergehen den
 * Fallback und sperren weitere Aufrufe bis zum Budget-Reset.
 */
export async function callLlm(
  systemPrompt: string,
  userPrompt: string,
  options?: { model?: string; fallback?: boolean },
): Promise<LlmResult> {
  const primaryModel = options?.model || config.llm.primaryModel;
  const c = getClient();
  if (budgetLockedUntil > Date.now()) {
    throw new LlmTerminalError(
      `LLM-Budget erschöpft — gesperrt bis ${new Date(budgetLockedUntil).toISOString()}`,
      'budget',
      primaryModel,
    );
  }

  // Demo: der Text des Aufrufs zählt, nicht der feste Systemprompt (src/demo/grenzen.ts). Erst nach der Budgetsperre, sonst zählte
  // ein Aufruf, der nie hinausgeht.
  await verbrauche('ki', userPrompt.length);

  // Versuch 1: Primaeres Modell
  try {
    return await doCall(c, primaryModel, systemPrompt, userPrompt, false);
  } catch (err: any) {
    const terminal = classifyTerminal(err, primaryModel);
    if (terminal) {
      if (terminal.kind === 'budget') budgetLockedUntil = nextBudgetResetMs();
      console.error(`[LLM] ${terminal.message} — kein Fallback, kein Retry`);
      throw terminal;
    }
    console.warn(`[LLM] Primary model ${primaryModel} failed: ${err.message}`);
    if (options?.fallback !== true) {
      throw new Error(`LLM call failed (${primaryModel}, kein Ausweichmodell für diesen Weg): ${err.message}`);
    }
  }

  // Versuch 2: Fallback-Modell
  const fallbackModel = config.llm.fallbackModel;
  if (fallbackModel && fallbackModel !== primaryModel) {
    try {
      return await doCall(c, fallbackModel, systemPrompt, userPrompt, true);
    } catch (err: any) {
      const terminal = classifyTerminal(err, fallbackModel);
      if (terminal) {
        if (terminal.kind === 'budget') budgetLockedUntil = nextBudgetResetMs();
        console.error(`[LLM] ${terminal.message} (Fallback ${fallbackModel})`);
        throw terminal;
      }
      console.error(`[LLM] Fallback model ${fallbackModel} also failed: ${err.message}`);
      throw new Error(`LLM call failed (primary: ${primaryModel}, fallback: ${fallbackModel}): ${err.message}`);
    }
  }

  throw new Error(`LLM call failed for model ${primaryModel}`);
}

/**
 * Der Aufruf für Artikelnamen (Kürzen, Namensfassung): eigenes Modell (`config.llm.namenModel`) und als einzige Wege mit
 * Ausweichmodell. Als Funktion mit der Form von `callLlm`, damit Routen und Prüfskripte sie gleich einsetzen.
 */
export function callLlmNamen(systemPrompt: string, userPrompt: string): Promise<LlmResult> {
  return callLlm(systemPrompt, userPrompt, { model: config.llm.namenModel, fallback: true });
}

async function doCall(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  isFallback: boolean,
): Promise<LlmResult> {
  const start = Date.now();

  // LiteLLM Semantic-Cache fuer diesen Request DEAKTIVIEREN.
  // Alle callLlm-Nutzungen sind deterministische Kurz-Transformationen
  // (Condensing, Capitalization, Alternativen). LiteLLMs Semantic-Cache
  // matcht per Embedding-Aehnlichkeit und liefert bei aehnlichen Prompts den
  // FALSCHEN gecachten Output — Vorfall 18.06.2026: das Condensing einer
  // ungarischen Hebelklemme bekam die slowakische Gelbox-Kuerzung
  // ("Karos kábelkapocs…" → "Gélový box pre 2-dielnu…"). Korrektheit geht hier
  // vor Cache-Ersparnis; die echten Uebersetzungen cachen wir ohnehin selbst
  // (segments-Tabelle). Siehe Memory feedback_semantic_cache_stale_outputs.
  const besonders = config.llm.modellParameter[model] ?? {};
  const requestBody = {
    model,
    ...(besonders.ohneTemperatur ? {} : { temperature: config.llm.temperature }),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    cache: { 'no-cache': true },
    ...(besonders.extraBody ? { extra_body: besonders.extraBody } : {}),
  };

  // .withResponse() liefert zusätzlich zum geparsten Body die rohe HTTP-Response,
  // damit wir LiteLLMs echten Kosten-Header (x-litellm-response-cost) auslesen können.
  const { data: response, response: httpResponse } = await client.chat.completions
    .create(requestBody as any)
    .withResponse();

  const latencyMs = Date.now() - start;
  const choice = response.choices[0];
  const text = choice?.message?.content?.trim() || '';
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  // Echte LiteLLM-Kosten bevorzugen (deckt Alias-Umhängungen + reale Provider-Preise
  // ab); nur wenn der Header fehlt, auf die statische Pricing-Map zurückfallen.
  const costUsd =
    parseResponseCostHeader(httpResponse) ?? calculateCost(model, inputTokens, outputTokens);

  return {
    text,
    model,
    inputTokens,
    outputTokens,
    latencyMs,
    costUsd,
    usedFallback: isFallback,
  };
}

/**
 * Token-Usage in DB loggen.
 */
export async function logTokenUsage(
  result: LlmResult,
  purpose: 'condense' | 'terminology' | 'analyze' | 'word-order' | 'capitalization' | 'channel-fassung' | 'namensfassung',
  projectId?: string,
  segmentId?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO token_usage (project_id, segment_id, model, purpose, input_tokens, output_tokens, cost_usd, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      projectId || null,
      segmentId || null,
      result.model,
      purpose,
      result.inputTokens,
      result.outputTokens,
      result.costUsd,
      result.latencyMs,
    ],
  );
}
