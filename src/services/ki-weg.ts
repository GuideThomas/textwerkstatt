/**
 * Aufrufweg der Textwerkstatt zu einem KI-Modell (Plan `PLAN-textwerkstatt.md` §4 Phase 2, Cockpit #1838).
 *
 * Bewusst NEBEN `callLlm` (`services/llm.ts`) und nicht darauf gebaut, weil `callLlm` bei jedem Fehler still auf ein
 * Ausweichmodell springt. Für die Textwerkstatt hieße das: Ein für die Station gedachter Klartext ginge bei einem Ausfall
 * in die Cloud. Hier gilt stattdessen:
 *
 *  - G2 Kein stiller Rückfall. Ein Aufruf geht an genau einen Weg. Scheitert er, kommt ein Fehler mit Grund, kein zweiter
 *    Versuch, kein anderes Modell. Auch das OpenAI-SDK wiederholt nicht (`maxRetries: 0`), sonst schickte es nach einem
 *    429 denselben Text zweimal.
 *  - G3 Der Server entscheidet. Freischaltung, Weg und Schlüssel kommen aus Datenbank und Umgebung, nie aus dem Browser.
 *  - G4 Fehlt etwas, ist es zu. Kein Weg, keine Freischaltung, kein Schlüssel, Budget aus: Fehler mit HTTP-Code, kein Aufruf.
 *  - Budgetsperre je Schlüssel statt prozessweit. Ist das Tagesbudget der Cloud erreicht, laufen die lokale KI und alle
 *    übrigen LLM-Funktionen der App (`callLlm`) weiter.
 *  - G5 Keine Werte einer Installation im Code. Wege, Modelle und die Namen der Umgebungsvariablen stehen in `ki_wege`.
 *
 * Der Text eines Aufrufs wird hier nie protokolliert, auch nicht im Fehlerfall.
 */
import OpenAI from 'openai';
import { pool } from '../db/connection';
import { verbrauche } from '../demo/grenzen';

export type KiArt = 'lokal' | 'cloud';

export interface KiWeg {
  id: string;
  name: string;
  art: KiArt;
  modell: string;
  endpunkt_variable: string;
  schluessel_variable: string;
  zeitlimit_s: number;
  zusatz_parameter: Record<string, unknown>;
  budget_lesen: boolean;
  aktiv: boolean;
  reihenfolge: number;
}

export type KiFehlerCode =
  | 'WEG_UNBEKANNT'
  | 'WEG_INAKTIV'
  | 'NICHT_FREIGESCHALTET'
  | 'KONFIGURATION'
  | 'SCHLUESSEL_FEHLT'
  | 'ENDPUNKT_FEHLT'
  | 'BUDGET_EIGEN'
  | 'BUDGET_GLOBAL'
  | 'SCHLUESSEL_ABGELEHNT'
  | 'ZEITLIMIT'
  | 'NICHT_ERREICHBAR'
  | 'ANBIETER_FEHLER'
  | 'LEERE_ANTWORT';

const HTTP_JE_CODE: Record<KiFehlerCode, number> = {
  WEG_UNBEKANNT: 404,
  WEG_INAKTIV: 409,
  NICHT_FREIGESCHALTET: 403,
  KONFIGURATION: 503,
  SCHLUESSEL_FEHLT: 503,
  ENDPUNKT_FEHLT: 503,
  BUDGET_EIGEN: 429,
  BUDGET_GLOBAL: 429,
  SCHLUESSEL_ABGELEHNT: 502,
  ZEITLIMIT: 504,
  NICHT_ERREICHBAR: 502,
  ANBIETER_FEHLER: 502,
  LEERE_ANTWORT: 502,
};

/** Was ein Aufruf verbraucht hat. Hängt auch an einem Fehler, der NACH einem bezahlten Aufruf entsteht (Review M8). */
export interface KiVerbrauch {
  modell: string;
  eingabeToken: number;
  ausgabeToken: number;
  denkToken: number | null;
  kostenUsd: number | null;
  dauerMs: number;
}

export class KiWegFehler extends Error {
  readonly http: number;
  /** Gesetzt, wenn der Endpunkt geantwortet hat (etwa leere Antwort): Dann kostete der Aufruf trotzdem. */
  verbrauch: KiVerbrauch | null = null;
  constructor(
    readonly code: KiFehlerCode,
    message: string,
    readonly wegId: string | null,
    /** Bei einer Budgetsperre: bis wann sie gilt (ISO). */
    readonly bis: string | null = null,
  ) {
    super(message);
    this.name = 'KiWegFehler';
    this.http = HTTP_JE_CODE[code];
  }
}

/** Namen der Umgebungsvariablen, dieselben Muster wie die CHECKs in Migration 040. */
export const ENDPUNKT_VARIABLE_MUSTER = /^(LLM_BASE_URL|KI_WEG_[A-Z0-9_]{1,40}_URL)$/;
export const SCHLUESSEL_VARIABLE_MUSTER = /^KI_WEG_[A-Z0-9_]{1,40}_KEY$/;
export const WEG_ID_MUSTER = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Ein lokaler Weg liest einen Schlüssel mit diesem Präfix, ein Cloud-Weg nie (CHECK `ki_wege_art_passt_zum_schluessel`).
 * Sonst wäre „lokal“ nur eine Beschriftung: Stellte ein Admin den Weg `lokal` auf den Cloud-Schlüssel um, ginge Text ohne
 * Freischaltung in die Cloud. Welche Modelle ein Schlüssel erreicht, belegt seine Positivliste in LiteLLM.
 */
export const LOKAL_SCHLUESSEL_PRAEFIX = 'KI_WEG_LOKAL';

export function artPasstZumSchluessel(art: KiArt, schluesselVariable: string): boolean {
  return (art === 'lokal') === schluesselVariable.startsWith(LOKAL_SCHLUESSEL_PRAEFIX);
}

// ── Zusatzparameter: Positivliste ────────────────────────────────────────────────────────────────────────────────────
// Bewusst keine Sperrliste: Über `extra_body.model` bekäme der Anbieter ein anderes Modell als das, das LiteLLM gegen die
// Positivliste des Schlüssels prüft; über `fallbacks` wiche LiteLLM selbst aus; über `user` oder `prediction` ginge freier
// Text hinaus (Befunde des Code-Reviews 10.11.2026). Erlaubt ist nur, was steuert, mit eng begrenzten Werten.
type Pruefer = (v: unknown) => boolean;
const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const istBool: Pruefer = (v) => typeof v === 'boolean';
const ganzzahl = (min: number, max: number): Pruefer => (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const kommazahl = (min: number, max: number): Pruefer => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const eines = (...werte: string[]): Pruefer => (v) => typeof v === 'string' && werte.includes(v);
const objektMit = (felder: Record<string, Pruefer>): Pruefer => (v) =>
  istObjekt(v) && Object.entries(v).every(([k, x]) => Object.prototype.hasOwnProperty.call(felder, k) && felder[k](x));

const ERLAUBT_IN_EXTRA_BODY: Record<string, Pruefer> = {
  // Werte nur ja/nein: Über eine Zeichenkette ginge Text in die Vorlage des Modells.
  chat_template_kwargs: (v) => istObjekt(v) && Object.keys(v).length <= 10 && Object.values(v).every(istBool),
  reasoning_effort: eines('none', 'minimal', 'low', 'medium', 'high'),
  thinking: objektMit({ type: eines('enabled', 'disabled'), budget_tokens: ganzzahl(0, 100_000) }),
  top_k: ganzzahl(1, 1000),
};
const ERLAUBT_OBEN: Record<string, Pruefer> = {
  'no-log': istBool,
  cache: objektMit({ 'no-cache': istBool }),
  // Nur 0: LiteLLM wiederholt sonst nach `router_settings.num_retries` (am Proxy 3) denselben Text.
  num_retries: (v) => v === 0,
  temperature: kommazahl(0, 2),
  top_p: kommazahl(0, 1),
  max_tokens: ganzzahl(1, 32_000),
  extra_body: objektMit(ERLAUBT_IN_EXTRA_BODY),
};

/** `null`, wenn die Zusatzparameter zulässig sind, sonst der Grund. */
export function zusatzPruefen(z: unknown): string | null {
  if (!istObjekt(z)) return 'Zusatzparameter: ein JSON-Objekt';
  for (const [k, v] of Object.entries(z)) {
    if (!Object.prototype.hasOwnProperty.call(ERLAUBT_OBEN, k)) {
      return `Zusatzparameter: Feld ${k} ist nicht erlaubt (erlaubt: ${Object.keys(ERLAUBT_OBEN).join(', ')})`;
    }
    if (!ERLAUBT_OBEN[k](v)) {
      return k === 'extra_body'
        ? `Zusatzparameter: extra_body erlaubt nur ${Object.keys(ERLAUBT_IN_EXTRA_BODY).join(', ')} mit festen Werten`
        : `Zusatzparameter: Wert für ${k} ist nicht zulässig`;
    }
  }
  return null;
}

export interface KiAntwortRoh {
  data: any;
  response?: { headers?: { get?: (name: string) => string | null } };
}

export interface KiClient {
  create(body: Record<string, unknown>): Promise<KiAntwortRoh>;
}

export interface KiAbhaengigkeiten {
  wegLaden(id: string): Promise<KiWeg | null>;
  wegeLaden(): Promise<KiWeg[]>;
  darfCloud(nutzerId: string): Promise<boolean>;
  /** Liest die Umgebung beim Aufruf, nie auf Modulebene (ESM lädt vor der `.env`). */
  env(name: string): string | undefined;
  client(baseURL: string, apiKey: string, timeoutMs: number): KiClient;
  holeJson(url: string, apiKey: string, timeoutMs: number): Promise<{ status: number; body: any }>;
  jetzt(): number;
}

const WEG_SPALTEN = `id, name, art, modell, endpunkt_variable, schluessel_variable, zeitlimit_s, zusatz_parameter,
  budget_lesen, aktiv, reihenfolge`;

export const standardAbhaengigkeiten: KiAbhaengigkeiten = {
  async wegLaden(id) {
    const r = await pool.query(`SELECT ${WEG_SPALTEN} FROM ki_wege WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  },
  async wegeLaden() {
    const r = await pool.query(`SELECT ${WEG_SPALTEN} FROM ki_wege ORDER BY reihenfolge, id`);
    return r.rows;
  },
  async darfCloud(nutzerId) {
    const r = await pool.query('SELECT darf_cloud_ki FROM users WHERE id = $1 AND active = TRUE', [nutzerId]);
    return r.rows[0]?.darf_cloud_ki === true;
  },
  env: (name) => process.env[name],
  client(baseURL, apiKey, timeoutMs) {
    // logLevel 'off': Sonst protokolliert das SDK bei OPENAI_LOG=debug den Anfragekörper samt Text.
    const c = new OpenAI({ baseURL, apiKey, timeout: timeoutMs, maxRetries: 0, logLevel: 'off' });
    return {
      create: (body) => c.chat.completions.create(body as any).withResponse() as Promise<KiAntwortRoh>,
    };
  },
  async holeJson(url, apiKey, timeoutMs) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  },
  jetzt: () => Date.now(),
};

// ── Budgetsperre je Schlüssel ────────────────────────────────────────────────────────────────────────────────────────

export type BudgetArt = 'eigen' | 'global';
interface Sperre { art: BudgetArt; bis: number }

/** Schlüssel ist der NAME der Schlüsselvariable: Zwei Wege mit demselben Schlüssel teilen sich die Sperre. */
const sperren = new Map<string, Sperre>();

function naechsterResetUtc(jetzt: number): number {
  const d = new Date(jetzt);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export function sperreLesen(schluesselVariable: string, jetzt: number): Sperre | null {
  const s = sperren.get(schluesselVariable);
  if (!s) return null;
  if (s.bis <= jetzt) {
    sperren.delete(schluesselVariable);
    return null;
  }
  return s;
}

/** Nur für Prüfskripte: alle Sperren und den Budget-Zwischenspeicher leeren. */
export function kiZustandZuruecksetzen(): void {
  sperren.clear();
  budgetCache.clear();
}

/** Nur für Prüfskripte: den Budget-Zwischenspeicher leeren, Sperren behalten (wie nach Ablauf der 60 s). */
export function budgetCacheLeeren(): void {
  budgetCache.clear();
}

// ── Aufruf ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface KiAufrufEingabe {
  wegId: string;
  nutzerId: string;
  system: string;
  text: string;
  maxTokens?: number;
  /**
   * Welche Art der Weg haben muss. Wer Klartext schickt, verlangt `lokal`: Dann geht nichts hinaus, falls derselbe Weg beim
   * Aufruf anders geladen wird als bei der Entscheidung, was gesendet wird (Review N1).
   */
  erwarteteArt?: KiArt;
}

export interface KiErgebnis {
  text: string;
  wegId: string;
  art: KiArt;
  modell: string;
  eingabeToken: number;
  ausgabeToken: number;
  /** Denk-Token laut Antwort. Ist der Schalter „Denken aus“ wirksam, steht hier 0. `null`, wenn der Anbieter nichts meldet. */
  denkToken: number | null;
  dauerMs: number;
  /** Kosten laut Kopfzeile `x-litellm-response-cost`. Fehlt bei kostenlosen Wegen, `null` ist dann kein Fehler. */
  kostenUsd: number | null;
  /** Die Antwort endete an der Obergrenze (`finish_reason: length`): Der Text ist abgeschnitten. */
  abgeschnitten: boolean;
}

/** Prüft, ob ein Weg vollständig eingerichtet ist und der Nutzer ihn nehmen darf. Wirft `KiWegFehler`, ruft nichts. */
async function wegFreigeben(
  wegId: string,
  nutzerId: string,
  deps: KiAbhaengigkeiten,
  erwarteteArt?: KiArt,
): Promise<{ weg: KiWeg; baseURL: string; apiKey: string }> {
  const weg = await deps.wegLaden(wegId);
  if (!weg) throw new KiWegFehler('WEG_UNBEKANNT', `KI-Weg ${wegId} gibt es nicht`, wegId);
  if (erwarteteArt && weg.art !== erwarteteArt) {
    throw new KiWegFehler('KONFIGURATION', `KI-Weg ${wegId} ist ${weg.art}, erwartet war ${erwarteteArt}`, wegId);
  }
  if (!weg.aktiv) throw new KiWegFehler('WEG_INAKTIV', `KI-Weg ${wegId} ist ausgeschaltet`, wegId);
  if (weg.art === 'cloud' && !(await deps.darfCloud(nutzerId))) {
    throw new KiWegFehler('NICHT_FREIGESCHALTET', 'Für die Cloud-KI ist dieser Zugang nicht freigeschaltet', wegId);
  }
  if (!ENDPUNKT_VARIABLE_MUSTER.test(weg.endpunkt_variable) || !SCHLUESSEL_VARIABLE_MUSTER.test(weg.schluessel_variable)) {
    throw new KiWegFehler('KONFIGURATION', `KI-Weg ${wegId}: Name einer Umgebungsvariable ist nicht zulässig`, wegId);
  }
  if (!artPasstZumSchluessel(weg.art, weg.schluessel_variable)) {
    throw new KiWegFehler('KONFIGURATION', `KI-Weg ${wegId}: Art ${weg.art} passt nicht zum Schlüssel ${weg.schluessel_variable}`, wegId);
  }
  const zusatzFehler = zusatzPruefen(weg.zusatz_parameter ?? {});
  if (zusatzFehler) throw new KiWegFehler('KONFIGURATION', `KI-Weg ${wegId}: ${zusatzFehler}`, wegId);
  const apiKey = deps.env(weg.schluessel_variable)?.trim();
  if (!apiKey) {
    throw new KiWegFehler('SCHLUESSEL_FEHLT', `KI-Weg ${wegId}: Schlüssel ${weg.schluessel_variable} ist nicht gesetzt`, wegId);
  }
  const baseURL = deps.env(weg.endpunkt_variable)?.trim();
  if (!baseURL) {
    throw new KiWegFehler('ENDPUNKT_FEHLT', `KI-Weg ${wegId}: Endpunkt ${weg.endpunkt_variable} ist nicht gesetzt`, wegId);
  }
  const sperre = sperreLesen(weg.schluessel_variable, deps.jetzt());
  if (sperre) {
    throw new KiWegFehler(
      sperre.art === 'eigen' ? 'BUDGET_EIGEN' : 'BUDGET_GLOBAL',
      sperre.art === 'eigen'
        ? `KI-Weg ${wegId}: Tagesbudget erreicht`
        : `KI-Weg ${wegId}: Gesamtbudget des KI-Proxys erreicht`,
      wegId,
      new Date(sperre.bis).toISOString(),
    );
  }
  return { weg, baseURL, apiKey };
}

/** Ordnet einen Fehler des Endpunkts ein und setzt bei einem Budgetfehler die Sperre des Schlüssels. */
function einordnen(err: any, weg: KiWeg, jetzt: number): KiWegFehler {
  const status: number | undefined = err?.status ?? err?.response?.status;
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.error ?? '')}`;
  if (status === 429 && /budget/i.test(text)) {
    // LiteLLM v1.91.0 nennt bei der Schlüsselgrenze den Schlüssel („Budget has been exceeded! Key=<alias> …“), bei der
    // globalen Proxy-Grenze nicht (`auth_checks.py`, gelesen 10.11.2026). Beides kommt als 429.
    // Team- oder Nutzerbudgets gibt es hier nicht; gäbe es sie, meldeten auch sie sich ohne `Key=` und hießen hier „global“.
    const art: BudgetArt = /Key=/.test(text) ? 'eigen' : 'global';
    const gemerkt = budgetCache.get(weg.schluessel_variable)?.budget?.resetAm;
    const ausInfo = art === 'eigen' && gemerkt ? Date.parse(gemerkt) : NaN;
    const bis = Number.isFinite(ausInfo) && ausInfo > jetzt ? ausInfo : naechsterResetUtc(jetzt);
    sperren.set(weg.schluessel_variable, { art, bis });
    return new KiWegFehler(
      art === 'eigen' ? 'BUDGET_EIGEN' : 'BUDGET_GLOBAL',
      art === 'eigen' ? `KI-Weg ${weg.id}: Tagesbudget erreicht` : `KI-Weg ${weg.id}: Gesamtbudget des KI-Proxys erreicht`,
      weg.id,
      new Date(bis).toISOString(),
    );
  }
  if (status === 401 || status === 403) {
    return new KiWegFehler('SCHLUESSEL_ABGELEHNT', `KI-Weg ${weg.id}: Schlüssel abgelehnt (${status})`, weg.id);
  }
  if (err?.name === 'APIConnectionTimeoutError' || status === 408 || /timed out|timeout/i.test(err?.message ?? '')) {
    return new KiWegFehler('ZEITLIMIT', `KI-Weg ${weg.id}: keine Antwort binnen ${weg.zeitlimit_s} s`, weg.id);
  }
  if (typeof status === 'number') {
    return new KiWegFehler('ANBIETER_FEHLER', `KI-Weg ${weg.id}: Endpunkt meldet Fehler ${status}`, weg.id);
  }
  return new KiWegFehler('NICHT_ERREICHBAR', `KI-Weg ${weg.id}: Endpunkt nicht erreichbar`, weg.id);
}

function zahl(v: unknown): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Baut den Anfragekörper. Die Zusatzparameter müssen die Positivliste bestehen (sonst Fehler, nicht still weglassen);
 * `model`, `messages` und `stream` stehen danach und lassen sich so nicht überschreiben.
 */
export function anfrageBauen(weg: KiWeg, system: string, text: string, maxTokens?: number): Record<string, unknown> {
  const zusatz = weg.zusatz_parameter ?? {};
  const fehler = zusatzPruefen(zusatz);
  if (fehler) throw new KiWegFehler('KONFIGURATION', `KI-Weg ${weg.id}: ${fehler}`, weg.id);
  return {
    ...zusatz,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    // Lokal geht Klartext hinaus: Kein Protokoll in Tempo, und das steht im Code, nicht nur in der Tabelle. Fehlte der Eintrag
    // in `zusatz_parameter`, schriebe LiteLLM sonst still mit (Review N2, Entscheid Thomas 10.11.2026: Protokoll nur Cloud).
    ...(weg.art === 'lokal' ? { 'no-log': true } : {}),
    model: weg.modell,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
  };
}

export async function kiAufrufen(eingabe: KiAufrufEingabe, deps: KiAbhaengigkeiten = standardAbhaengigkeiten): Promise<KiErgebnis> {
  const { weg, baseURL, apiKey } = await wegFreigeben(eingabe.wegId, eingabe.nutzerId, deps, eingabe.erwarteteArt);
  const client = deps.client(baseURL, apiKey, weg.zeitlimit_s * 1000);
  // Demo: Zeichen buchen, bevor sie hinausgehen (src/demo/grenzen.ts); ohne Demo kehrt das sofort zurück.
  await verbrauche('ki', eingabe.text.length);
  const start = deps.jetzt();
  let roh: KiAntwortRoh;
  try {
    roh = await client.create(anfrageBauen(weg, eingabe.system, eingabe.text, eingabe.maxTokens));
  } catch (err) {
    const fehler = einordnen(err, weg, deps.jetzt());
    // Kein Text im Log, nur Weg und Grund.
    console.warn(`[KI-Weg] ${weg.id} (${weg.art}, ${weg.modell}): ${fehler.code}, kein Ausweichen`);
    throw fehler;
  }
  const dauerMs = deps.jetzt() - start;
  const data = roh.data ?? {};
  const textAntwort = String(data?.choices?.[0]?.message?.content ?? '').trim();
  const usage = data?.usage ?? {};
  const verbrauch: KiVerbrauch = {
    modell: weg.modell,
    eingabeToken: zahl(usage.prompt_tokens) ?? 0,
    ausgabeToken: zahl(usage.completion_tokens) ?? 0,
    denkToken: zahl(usage.completion_tokens_details?.reasoning_tokens),
    kostenUsd: zahl(roh.response?.headers?.get?.('x-litellm-response-cost') ?? null),
    dauerMs,
  };
  if (!textAntwort) {
    const f = new KiWegFehler('LEERE_ANTWORT', `KI-Weg ${weg.id}: leere Antwort`, weg.id);
    f.verbrauch = verbrauch;
    throw f;
  }
  return {
    text: textAntwort,
    wegId: weg.id,
    art: weg.art,
    ...verbrauch,
    abgeschnitten: data?.choices?.[0]?.finish_reason === 'length',
  };
}

// ── Budget und Zustand je Weg ────────────────────────────────────────────────────────────────────────────────────────

export interface KiBudget {
  verbrauchtUsd: number;
  grenzeUsd: number | null;
  resetAm: string | null;
  erreicht: boolean;
}

const BUDGET_CACHE_MS = 60_000;
const budgetCache = new Map<string, { am: number; budget: KiBudget | null }>();

/** `…/v1` → Wurzel des Proxys, dort liegt `/key/info`. */
function wurzel(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Restbudget des Schlüssels aus LiteLLM (`GET /key/info` mit dem eigenen Schlüssel, ohne Parameter, belegt 10.11.2026).
 * `null`, wenn der Weg kein Budget liest, etwas fehlt oder der Endpunkt nicht antwortet: Dann zeigt die App kein Budget,
 * sie erfindet keines.
 */
export async function budgetLesen(weg: KiWeg, deps: KiAbhaengigkeiten = standardAbhaengigkeiten): Promise<KiBudget | null> {
  if (!weg.budget_lesen) return null;
  if (!ENDPUNKT_VARIABLE_MUSTER.test(weg.endpunkt_variable) || !SCHLUESSEL_VARIABLE_MUSTER.test(weg.schluessel_variable)) return null;
  const apiKey = deps.env(weg.schluessel_variable)?.trim();
  const baseURL = deps.env(weg.endpunkt_variable)?.trim();
  if (!apiKey || !baseURL) return null;
  const jetzt = deps.jetzt();
  const gemerkt = budgetCache.get(weg.schluessel_variable);
  if (gemerkt && jetzt - gemerkt.am < BUDGET_CACHE_MS) return gemerkt.budget;
  let budget: KiBudget | null = null;
  try {
    const { status, body } = await deps.holeJson(`${wurzel(baseURL)}/key/info`, apiKey, 5000);
    const info = body?.info;
    if (status === 200 && info) {
      const verbraucht = zahl(info.spend) ?? 0;
      const grenze = zahl(info.max_budget);
      budget = {
        verbrauchtUsd: verbraucht,
        grenzeUsd: grenze,
        resetAm: typeof info.budget_reset_at === 'string' ? new Date(info.budget_reset_at).toISOString() : null,
        erreicht: grenze !== null && verbraucht >= grenze,
      };
      // Die Sperre folgt dem Proxy: erreicht → bis zum Reset zu, auch nach einem Neustart, ohne erst einen Aufruf zu
      // verbrennen; nicht erreicht → eine eigene Sperre aufheben (Grenze tagsüber erhöht oder Reset vorbei).
      const s = sperren.get(weg.schluessel_variable);
      if (budget.erreicht) {
        const bis = budget.resetAm ? Date.parse(budget.resetAm) : NaN;
        sperren.set(weg.schluessel_variable, { art: 'eigen', bis: Number.isFinite(bis) && bis > jetzt ? bis : naechsterResetUtc(jetzt) });
      } else if (s?.art === 'eigen') {
        sperren.delete(weg.schluessel_variable);
      }
    } else {
      console.warn(`[KI-Weg] ${weg.id}: /key/info antwortet ${status}`);
    }
  } catch {
    console.warn(`[KI-Weg] ${weg.id}: /key/info nicht erreichbar`);
  }
  budgetCache.set(weg.schluessel_variable, { am: jetzt, budget });
  return budget;
}

export interface KiWegZustand {
  id: string;
  name: string;
  art: KiArt;
  verfuegbar: boolean;
  /** Warum nicht verfügbar; `null`, wenn verfügbar. */
  grund: KiFehlerCode | null;
  /** Bis wann eine Budgetsperre gilt (ISO). */
  gesperrtBis: string | null;
  budget: KiBudget | null;
}

/**
 * Zustand eines Wegs für einen Nutzer, ohne einen Aufruf. Dieselben Prüfungen wie beim Aufruf; dazu das Budget aus
 * `/key/info`. Eine dort erreichte Grenze sperrt ab dann auch den Aufruf (`budgetLesen`).
 */
export async function wegZustand(weg: KiWeg, nutzerId: string, deps: KiAbhaengigkeiten = standardAbhaengigkeiten): Promise<KiWegZustand> {
  const budget = weg.aktiv ? await budgetLesen(weg, deps) : null;
  const basis = { id: weg.id, name: weg.name, art: weg.art, budget };
  try {
    await wegFreigeben(weg.id, nutzerId, { ...deps, wegLaden: async () => weg });
  } catch (err) {
    if (err instanceof KiWegFehler) return { ...basis, verfuegbar: false, grund: err.code, gesperrtBis: err.bis };
    throw err;
  }
  if (budget?.erreicht) {
    return { ...basis, verfuegbar: false, grund: 'BUDGET_EIGEN', gesperrtBis: budget.resetAm };
  }
  return { ...basis, verfuegbar: true, grund: null, gesperrtBis: null };
}
