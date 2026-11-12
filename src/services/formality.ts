/**
 * Anredestufe (DeepL `formality`) — eine Wahrheit für alle Übersetzungspfade.
 *
 * Grundsatz: STRENGE Form `more`/`less`, nicht `prefer_more`/`prefer_less`.
 * `prefer_*` funktioniert für jede Sprache und tut dort, wo es nichts kann,
 * einfach nichts — der Anwender wählt "formell", bekommt eine normale
 * Übersetzung und GLAUBT, er habe formell bekommen. Die strenge Form antwortet
 * stattdessen mit einem lauten HTTP 400.
 *
 * Gemessen 14.08.2026 gegen den Produktivschlüssel:
 *   formality=more        auf EN-US → HTTP 400 "Target language 'en-US' doesn't support formality."
 *   formality=prefer_more auf EN-US → HTTP 200, still ignoriert
 *
 * Der laute Fehler ist hier die gewollte Eigenschaft. Deshalb prüft diese Datei
 * VOR dem Aufruf, ob die Zielsprache die Stufe kennt — und der 400 bleibt das
 * Sicherheitsnetz, falls diese Liste irrt.
 */

import * as deepl from 'deepl-node';
import { config } from '../config';

export type Formality = 'default' | 'more' | 'less';

export const FORMALITY_VALUES: readonly Formality[] = ['default', 'more', 'less'] as const;

/**
 * Rückfallliste, gemessen am 14.08.2026 über `GET /v2/languages?type=target`
 * (Feld `supports_formality`): 15 von 110 Zielsprachen, hier auf Basiscodes
 * normalisiert.
 *
 * ⚠️ Auf BASISCODES normalisieren ist Pflicht, nicht Kosmetik: DeepL führt
 * `DE-CH`, `DE-DE`, `ES-419`, `FR-CA`, `FR-FR`, `PT-BR`, `PT-PT` einzeln — und
 * `PT` gibt es NUR regional. Ein exakter Vergleich auf `PT` ginge ins Leere.
 *
 * Die Liste ist der Rückfall, nicht die Quelle: im Regelfall kommt sie zur
 * Laufzeit von DeepL (s. `refreshFormalityLanguages`). Ergänzt DeepL später eine
 * Sprache — etwa Englisch —, kommt das damit ohne Deploy an.
 */
const RUECKFALL_SPRACHEN: readonly string[] = [
  'DE', 'ES', 'FR', 'IT', 'JA', 'NL', 'PL', 'PT', 'RU',
];

let sprachen: Set<string> = new Set(RUECKFALL_SPRACHEN);
let quelle: 'rueckfall' | 'live' = 'rueckfall';
let gemessenAm: string | null = null;
let letzterFehler: string | null = null;

/** `de-DE` / `DE-CH` / `pt-BR` → `DE` / `PT`. */
function basiscode(lang: string): string {
  return (lang || '').toUpperCase().split('-')[0];
}

/**
 * Lädt die Sprachliste bei Serverstart von DeepL. Schlägt der Aufruf fehl,
 * bleibt die Rückfallliste stehen — der Start darf daran nicht scheitern.
 */
export async function refreshFormalityLanguages(): Promise<void> {
  if (!config.deepl.apiKey) {
    letzterFehler = 'DEEPL_API_KEY nicht gesetzt';
    return;
  }
  try {
    const t = new deepl.Translator(config.deepl.apiKey);
    const ziele = await t.getTargetLanguages();
    const gefunden = new Set<string>();
    for (const z of ziele) {
      if (z.supportsFormality) gefunden.add(basiscode(z.code));
    }
    if (gefunden.size === 0) {
      // Leere Antwort ist kein gueltiges Messergebnis — eine leere Liste wuerde
      // die Auswahl stillschweigend fuer JEDE Sprache abschalten.
      letzterFehler = 'DeepL lieferte keine Sprache mit supports_formality';
      return;
    }
    sprachen = gefunden;
    quelle = 'live';
    gemessenAm = new Date().toISOString();
    letzterFehler = null;
    console.log(
      `[Formality] ${gefunden.size} Basissprachen mit Anredestufe von DeepL geladen: ` +
        `${[...gefunden].sort().join(', ')}`,
    );
  } catch (err: any) {
    letzterFehler = err?.message || 'unbekannter Fehler';
    console.warn(
      `[Formality] Sprachliste konnte nicht geladen werden (${letzterFehler}) — ` +
        `Rückfallliste vom 14.08.2026 bleibt aktiv`,
    );
  }
}

/** Kennt DeepL für diese Zielsprache eine Anredestufe? */
export function supportsFormality(targetLang: string): boolean {
  return sprachen.has(basiscode(targetLang));
}

/** Für Oberfläche und Diagnose: welche Sprachen, woher, wann gemessen. */
export function formalityStatus(): {
  languages: string[];
  source: 'live' | 'rueckfall';
  measuredAt: string | null;
  error: string | null;
} {
  return {
    languages: [...sprachen].sort(),
    source: quelle,
    measuredAt: gemessenAm,
    error: letzterFehler,
  };
}

/**
 * Nimmt den Wert aus einer Anfrage entgegen. `null` bedeutet: unbrauchbar,
 * der Aufrufer soll mit 400 antworten. Fehlt der Wert ganz, gilt `'default'` —
 * das ist der Zustand von heute und sendet keinen Parameter.
 */
export function parseFormality(raw: unknown): Formality | null {
  if (raw === undefined || raw === null || raw === '') return 'default';
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return (FORMALITY_VALUES as readonly string[]).includes(v) ? (v as Formality) : null;
}

/**
 * Was tatsächlich an DeepL geht. `undefined` heißt: KEIN Parameter im Aufruf —
 * weder weil "Standard" gewählt wurde noch weil die Sprache die Stufe nicht kennt.
 *
 * Damit ist die Regressionsgarantie strukturell: Wer nichts wählt, erzeugt einen
 * Aufruf, der byteweise dem von heute entspricht.
 */
export function effectiveFormality(
  formality: Formality | undefined,
  targetLang: string,
): 'more' | 'less' | undefined {
  if (!formality || formality === 'default') return undefined;
  if (!supportsFormality(targetLang)) return undefined;
  return formality;
}

/**
 * Was die Oberfläche über dem Ergebnis anzeigt: die tatsächlich angewandte
 * Stufe — und bei nicht unterstützter Zielsprache ausdrücklich "nicht
 * angewandt" statt einfach nichts.
 */
export function formalityApplied(
  formality: Formality | undefined,
  targetLang: string,
): { requested: Formality; applied: 'more' | 'less' | null; supported: boolean } {
  const requested = formality ?? 'default';
  const supported = supportsFormality(targetLang);
  return {
    requested,
    applied: effectiveFormality(requested, targetLang) ?? null,
    supported,
  };
}
