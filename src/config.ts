import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * `STOREVIEW_LANG_MAP=cs=cz,sl=si` → `{ cs: 'cz', sl: 'si' }`.
 * Unbrauchbare Paare werden still verworfen (Fehlkonfiguration darf den
 * Server-Start nicht verhindern — ohne Eintrag gilt der Code-Default).
 */
function parseLangMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const [from, to] = pair.split('=').map((s) => (s || '').trim().toLowerCase());
    if (!from || !to) continue;
    map[from] = to;
  }
  return map;
}

/** `GLOSSAR_FREIGABE`: nur das Wort `alle` öffnet, alles andere (auch leer, `ja`, Tippfehler) ist `admin`. */
export function glossarFreigabe(raw: string | undefined): 'admin' | 'alle' {
  const wert = (raw ?? '').trim().toLowerCase();
  if (wert !== '' && wert !== 'admin' && wert !== 'alle') {
    console.warn(`GLOSSAR_FREIGABE="${raw}" ist unbekannt, es gilt "admin"`);
  }
  return wert === 'alle' ? 'alle' : 'admin';
}

function ganzzahl(env: NodeJS.ProcessEnv, key: string, vorgabe: number): number {
  const roh = (env[key] ?? '').trim();
  if (roh === '') return vorgabe;
  const n = Number(roh);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${key}="${roh}" ist keine ganze Zahl ≥ 0`);
  return n;
}

/**
 * `DEMO_MODUS` (`PLAN-oeffentlich-und-demo.md` Phase 2): `an` öffnet ein Tor mit gemeinsamem Passwort und schließt alles, was
 * eine öffentliche Demo nicht braucht. Leer, fehlend oder `aus` = keine Demo, kein Tor, kein Gastzugang. 🚨 Jeder andere Wert und
 * `an` ohne `DEMO_PASSWORT` verweigern den Start (Grundsatz G4): Eine halb eingerichtete Demo soll nicht laufen, auch nicht offen.
 */
export function demoEinstellungen(env: NodeJS.ProcessEnv = process.env) {
  const roh = (env.DEMO_MODUS ?? '').trim().toLowerCase();
  if (roh !== '' && roh !== 'an' && roh !== 'aus') {
    throw new Error(`DEMO_MODUS="${env.DEMO_MODUS}" ist unbekannt (erlaubt: an, aus oder leer)`);
  }
  const an = roh === 'an';
  const passwort = env.DEMO_PASSWORT ?? '';
  if (an && passwort.trim() === '') throw new Error('DEMO_MODUS=an verlangt DEMO_PASSWORT');
  // Ohne Demo werden die Zahlen nicht gelesen: Ein liegengebliebener, kaputter Wert darf die Produktion nicht am Start hindern.
  const zahl = (key: string, vorgabe: number) => (an ? ganzzahl(env, key, vorgabe) : vorgabe);
  // Der Chat-Schlüssel öffnet Übersetzen und Terminologie ohne Sitzung, also an Tor und Zählern je Sitzung vorbei.
  if (an && (env.CHAT_SERVICE_KEY ?? '').trim() !== '') throw new Error('DEMO_MODUS=an verträgt keinen CHAT_SERVICE_KEY');
  return {
    an,
    /** Nur zum Vergleich am Tor; nie ausgeben. */
    passwort: an ? passwort : '',
    /** DeepL-Zeichen am Tag für die ganze Demo: Die Demo nutzt das Kontingent der Firma (Entscheid E5). */
    deeplZeichenTag: zahl('DEMO_DEEPL_ZEICHEN_TAG', 20000),
    deeplZeichenJeSitzung: zahl('DEMO_DEEPL_ZEICHEN_JE_SITZUNG', 5000),
    kiZeichenTag: zahl('DEMO_KI_ZEICHEN_TAG', 100000),
    kiZeichenJeSitzung: zahl('DEMO_KI_ZEICHEN_JE_SITZUNG', 20000),
    uploadMb: zahl('DEMO_MAX_UPLOAD_MB', 5),
    aufrufeJeMinute: zahl('DEMO_AUFRUFE_JE_MINUTE', 120),
    torVersucheJeStunde: zahl('DEMO_TOR_VERSUCHE_JE_STUNDE', 10),
  };
}

const demo = demoEinstellungen();

/** `MAX_FILE_SIZE_MB`; keine Zahl heißt die Vorgabe 100, nicht „ohne Grenze“ (`Math.min(NaN, …)` wäre NaN). */
const maxDateiMb = (() => {
  const n = parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

export const config = {
  demo,

  port: parseInt(process.env.PORT || '3006', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5434', 10),
    database: process.env.DB_NAME || 'translationtool',
    user: process.env.DB_USER || 'translationtool',
    password: required('DB_PASSWORD'),
  },

  upload: {
    dir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
    // In der Demo gilt die kleinere der beiden Grenzen.
    maxFileSizeMb: demo.an ? Math.min(maxDateiMb, demo.uploadMb) : maxDateiMb,
  },

  deepl: {
    apiKey: process.env.DEEPL_API_KEY || '',
    batchSize: parseInt(process.env.DEEPL_BATCH_SIZE || '50', 10),
    /** Tag-Handling-Version. v2 (Default seit 21.05.2026) loest Tags besser auf,
     *  natuerlichere Uebersetzung — funktioniert aber NUR mit modelType='quality_optimized'.
     *  Bei Problemen via env auf 'v1' zuruecksetzen. */
    tagHandlingVersion: (process.env.DEEPL_TAG_HANDLING_VERSION || 'v2') as 'v1' | 'v2',
  },

  llm: {
    /** LiteLLM Proxy Base-URL (OpenAI-kompatibel) */
    baseUrl: process.env.LLM_BASE_URL || 'http://localhost:4000/v1',
    apiKey: process.env.LLM_API_KEY || '',
    primaryModel: process.env.LLM_PRIMARY_MODEL || 'deepseek/deepseek-chat',
    fallbackModel: process.env.LLM_FALLBACK_MODEL || 'gemini/gemini-2.5-flash',
    /**
     * Modell für Artikelnamen: Kürzen (`/api/condense`, Dokumente) und Namensfassung. Entscheid Thomas 11.11.2026 nach dem
     * Vergleich in `messung/textwerkstatt-phase6/` (Kürzen gültig 49 von 64 gegen 16 mit Grok). Nur diese Wege weichen bei
     * einem Fehler auf `fallbackModel` aus; die übrigen melden den Fehler (`callLlm` Option `fallback`).
     */
    namenModel: process.env.LLM_NAMEN_MODEL || 'gpt-5.6-luna',
    /**
     * Was ein Modell im Aufruf anders braucht. `gpt-5.6-luna` lehnt `temperature: 0` mit HTTP 400 ab (gemessen 11.11.2026,
     * 88 von 88 Aufrufen) und denkt ohne Vorgabe länger; `reasoning_effort` geht in `extra_body`, weil LiteLLM mit
     * `drop_params` es sonst verwirft.
     */
    modellParameter: {
      'gpt-5.6-luna': { ohneTemperatur: true, extraBody: { reasoning_effort: 'low' } },
    } as Record<string, { ohneTemperatur?: boolean; extraBody?: Record<string, unknown> }>,
    temperature: parseFloat(process.env.LLM_TEMPERATURE || '0'),
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10),
    /** Längen-Schwellwert: Ab wann Condensing greift (1.15 = 115%) */
    condensingThreshold: parseFloat(process.env.CONDENSING_THRESHOLD || '1.15'),
  },

  docling: {
    url: process.env.DOCLING_URL || 'http://localhost:5001',
    timeoutMs: parseInt(process.env.DOCLING_TIMEOUT_MS || '120000', 10),
  },

  storeview: {
    /** Sprachcode → Magento-Store-View-Segment, falls der Shop abweichend benennt.
     *  Format: `STOREVIEW_LANG_MAP=cs=cz,sl=si`. Überschreibt die Defaults in
     *  `services/text/storeview.ts` — damit ist eine Korrektur der Store-View-Codes
     *  ohne Code-Deploy möglich. */
    langMap: parseLangMap(process.env.STOREVIEW_LANG_MAP),

    /** Eigene Shop-Hosts: bei ABSOLUTEN Links auf diese Hosts wird die Store-View
     *  ebenfalls angepasst (`https://www.example.com/de/x` → `.../it/x`). Ohne diese
     *  Liste bliebe ein absoluter Link auf die eigene Domain auf der Quellsprache
     *  stehen — real beobachtet: IT-Segmente verlinkten auf
     *  `https://www.example.com/de/customer/account/create/`.
     *  Format `STOREVIEW_INTERNAL_HOSTS=example.com,www.example.com`; leer (Vorgabe) =
     *  absolute Links bleiben unangetastet. */
    internalHosts: (process.env.STOREVIEW_INTERNAL_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  },

  languagetool: {
    /** LanguageTool-API (selbst betrieben, kein Auth-Header). Leer = Prüfen ist aus,
     *  der Aufruf scheitert mit Grund statt still (services/languagetool.ts). */
    url: (process.env.LANGUAGETOOL_URL || '').replace(/\/$/, ''),
    /** Welche Match-Kategorien als "high confidence" gelten — silent angewandt
     *  im Document-Upload Pre-Optimize-Pfad. Stil-Regeln (STYLE, REDUNDANCY) bewusst
     *  ausgeschlossen, weil zu invasiv für Batch-Pipeline. */
    silentCategories: (process.env.LT_SILENT_CATEGORIES || 'TYPOS,TYPOGRAPHY,PUNCTUATION').split(','),
    timeoutMs: parseInt(process.env.LT_TIMEOUT_MS || '15000', 10),
  },

  /** Shared Secret für interne Service-Calls (z.B. Artikelanlage-Assistent → /api/batch-translate).
   *  Wenn leer: keine Auth erforderlich (Localhost-Vertrauen). */
  serviceKey: process.env.TRANSLATION_SERVICE_KEY || '',

  /** Dedizierter Key NUR für das Illustrator-CEP-Panel (/api/cep/*). Getrennt vom
   *  serviceKey, damit Designer-Zugänge separat rotier-/widerrufbar sind, ohne
   *  batch-translate/condense (interne Services) zu beeinflussen. Das CEP-Auth
   *  akzeptiert diesen Key ODER (als Fallback) den serviceKey. */
  cepServiceKey: process.env.CEP_SERVICE_KEY || '',

  /** Zugang für den Mitarbeiter-Chat (Open WebUI auf dem KI-Mini-Server).
   *  Eigener Schlüssel, weil er in einer Open-WebUI-„Valve" liegt (für jeden
   *  WebUI-Admin lesbar) und von einem Werkzeug benutzt wird, das die ganze
   *  Belegschaft aufrufen kann — separat rotierbar, ohne die internen Dienste
   *  mitzureißen. Anders als serviceKey/cepServiceKey gilt hier LEER =
   *  GESCHLOSSEN (Begründung in middleware/chat-service.ts). */
  chatService: {
    key: process.env.CHAT_SERVICE_KEY || '',
    maxRequestsPerMinute: parseInt(process.env.CHAT_MAX_REQUESTS_PER_MINUTE || '30', 10),
    /** Zeichen/Tag über den Chat-Pfad. Bremse gegen einen abhanden gekommenen
     *  Schlüssel, keine Buchhaltung (In-Memory, siehe Middleware). */
    maxCharsPerDay: parseInt(process.env.CHAT_MAX_CHARS_PER_DAY || '200000', 10),
  },

  auth: {
    sessionSecret:
      process.env.NODE_ENV === 'production' ? required('SESSION_SECRET') : process.env.SESSION_SECRET || 'nur-fuer-die-entwicklung',
    azure: {
      clientId: process.env.AZURE_CLIENT_ID || '',
      clientSecret: process.env.AZURE_CLIENT_SECRET || '',
      tenantId: process.env.AZURE_TENANT_ID || '',
    },
    get microsoftEnabled() {
      return !!(this.azure.clientId && this.azure.clientSecret && this.azure.tenantId);
    },
  },

  /** Öffentliche Adresse der App für absolute Links in E-Mails und für das Illustrator-Panel.
   *  Ohne Angabe gilt die lokale Adresse; jede echte Installation setzt `APP_URL`. */
  publicUrl: process.env.APP_URL || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3006'}`,

  /** Mail-Absender. Versand laeuft ueber lokales Postfix (127.0.0.1:25, kein Auth).
   *  Leer = es wird keine Mail verschickt, der Aufrufer bekommt einen Fehler mit Grund. */
  mailFrom: process.env.MAIL_FROM || '',

  /** Name der Organisation, die das Werkzeug betreibt: Spalte „Standard (<Name>)“ im Glossar,
   *  Absender und Fußzeile der Mails, Name neuer Glossare. Leer = neutrale Bezeichnung. */
  organisationName: (process.env.ORGANISATION_NAME || '').trim(),

  /** Name des Werkzeugs im Browser-Tab. */
  appName: (process.env.APP_NAME || 'Textwerkstatt').trim(),

  /**
   * Wer schreibt direkt ins Glossar (`PLAN-oeffentlich-und-demo.md` Phase 2): `admin` (Vorgabe) — Nicht-Admins schlagen nur vor
   * (`PLAN-glossar-freigabe.md`); `alle` — jeder Angemeldete wirkt wie ein Admin, löscht aber nur Einträge, die eine Person
   * angelegt hat, nie die aus einem Seed. 🚨 Fehlt der Schalter oder hat er einen anderen Wert, gilt `admin` (Grundsatz G4).
   */
  glossarFreigabe: glossarFreigabe(process.env.GLOSSAR_FREIGABE),

  /** Eigene Marken- und Produktnamen, die weder LanguageTool noch das LLM umschreiben dürfen
   *  (zusätzlich zur eingebauten Liste technischer Begriffe). Format `GESCHUETZTE_WOERTER=Marke,Produkt`. */
  geschuetzteWoerter: (process.env.GESCHUETZTE_WOERTER || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean),

  /**
   * Modell-Preise pro 1M Tokens (USD) für Token-Tracking — FALLBACK.
   * Seit 11.07.2026 liest llm.ts primär LiteLLMs echten Header `x-litellm-response-cost`
   * (genauer, deckt Alias-Umhängungen ab, z.B. deepseek-chat → xAI/Grok). Diese Map
   * greift nur noch, falls der Header mal fehlt (fehlt/unparsbar).
   * WICHTIG: Keys müssen die TATSÄCHLICH genutzten Modellnamen abdecken
   * (= LLM_PRIMARY_MODEL/LLM_FALLBACK_MODEL aus .env, die als LiteLLM-Aliase
   * OHNE Provider-Präfix kommen, z.B. "deepseek-chat" statt "deepseek/deepseek-chat").
   * Fehlt der Key, liefert calculateCost() still 0 → Dashboard zeigt 0,- (Bug 24.06.2026).
   * calculateCost() matcht zusätzlich präfix-tolerant; diese Aliase sind das Sicherheitsnetz.
   */
  pricing: {
    'deepseek/deepseek-chat': { input: 0.28, output: 0.42 },
    'deepseek-chat': { input: 0.28, output: 0.42 },          // LiteLLM-Alias (LLM_PRIMARY_MODEL)
    'gemini/gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-flash': { input: 0.15, output: 0.60 },           // LiteLLM-Alias (LLM_FALLBACK_MODEL)
    'gpt-5.6-luna': { input: 0.20, output: 1.20 },           // LLM_NAMEN_MODEL, Preis aus scripts/litellm/config.yaml
    'grok': { input: 1.25, output: 2.50 },                   // ehrlicher Alias für xai/grok-4.20 (= heute deepseek-chat)
  } as Record<string, { input: number; output: number }>,
} as const;
