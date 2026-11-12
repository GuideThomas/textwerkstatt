/**
 * Mehrsprachige Oberfläche (18.09.2026).
 *
 * Viele Native Speaker sprechen kaum Deutsch — die Bedienung gibt es deshalb in
 * DE · EN · IT · FR · HU · SK. Deutsch ist die Quellsprache und immer vollständig.
 *
 * Aufbau:
 *   locales/<sprache>/<namespace>.json  — ein Namespace je Bereich (common, review, …)
 *   Schlüssel sind sprechend (`review.welcome.title`), nie der deutsche Satz selbst.
 *   Fehlt ein Schlüssel in einer Sprache, kommt Englisch, dann Deutsch.
 *
 * Sprachwahl: zuerst die gespeicherte Wahl (localStorage `tt-lang`), sonst die
 * Browsersprache; alles Unbekannte (z. B. Tschechisch) fällt auf Englisch.
 *
 * Der Server übersetzt seine Fehlermeldungen selbst — dafür bekommt jede
 * `/api`-Anfrage den Header `X-UI-Lang` (siehe `installLangHeader`).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { orgName } from '../einstellungen';

export const SUPPORTED_LANGS = ['de', 'en', 'it', 'fr', 'hu', 'sk'] as const;
export type UiLang = (typeof SUPPORTED_LANGS)[number];

/** Anzeige im Umschalter — jede Sprache in ihrer eigenen Schreibweise. */
export const LANG_LABELS: Record<UiLang, string> = {
  de: 'Deutsch',
  en: 'English',
  it: 'Italiano',
  fr: 'Français',
  hu: 'Magyar',
  sk: 'Slovenčina',
};

const LANG_STORAGE_KEY = 'tt-lang';

// Alle JSON-Dateien fest ins Bundle — kein Nachladen, kein Flackern beim Start.
const modules = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*/*.json', { eager: true });
const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, mod] of Object.entries(modules)) {
  const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m) continue;
  const [, lng, ns] = m;
  (resources[lng] ??= {})[ns] = mod.default;
}
const namespaces = Array.from(new Set(Object.values(resources).flatMap((r) => Object.keys(r))));

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    ns: namespaces,
    defaultNS: 'common',
    fallbackNS: 'common',
    supportedLngs: [...SUPPORTED_LANGS],
    nonExplicitSupportedLngs: true, // „de-AT" → de, „en-GB" → en
    load: 'languageOnly',
    fallbackLng: { de: ['de'], default: ['en', 'de'] },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
    },
    // React escaped selbst. {{org}} = Name der Organisation, steht vor dem Start fest (main.tsx).
    interpolation: { escapeValue: false, defaultVariables: { org: orgName() } },
    returnNull: false,
  });

/** Die aktuell aktive Sprache als einer der unterstützten Codes. */
export function currentLang(): UiLang {
  const l = (i18n.resolvedLanguage || i18n.language || 'en').slice(0, 2) as UiLang;
  return (SUPPORTED_LANGS as readonly string[]).includes(l) ? l : 'en';
}

/** Datums-/Zahlenformat passend zur Oberflächensprache (de-AT für Deutsch). */
export function currentLocale(): string {
  const map: Record<UiLang, string> = { de: 'de-AT', en: 'en-GB', it: 'it-IT', fr: 'fr-FR', hu: 'hu-HU', sk: 'sk-SK' };
  return map[currentLang()];
}

function syncHtmlLang() {
  try { document.documentElement.lang = currentLang(); } catch { /* SSR/Test */ }
}
syncHtmlLang();
i18n.on('languageChanged', syncHtmlLang);

/**
 * Hängt `X-UI-Lang` an jede Anfrage an die eigene API. Einmal zentral statt an
 * über 100 fetch-Aufrufen — der Server übersetzt damit seine Fehlermeldungen.
 */
function installLangHeader() {
  if (typeof window === 'undefined' || (window as any).__ttLangHeader) return;
  (window as any).__ttLangHeader = true;
  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const sameOriginApi = url.startsWith('/api') || url.startsWith(`${window.location.origin}/api`);
    if (!sameOriginApi) return orig(input, init);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has('X-UI-Lang')) headers.set('X-UI-Lang', currentLang());
    return orig(input, { ...init, headers });
  };
}
installLangHeader();

export default i18n;
