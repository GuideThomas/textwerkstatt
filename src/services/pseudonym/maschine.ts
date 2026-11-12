/**
 * Pseudonymisierung für Maschinenwege ohne Vorschau (Textwerkstatt Phase 6, Entscheid Thomas 11.11.2026).
 *
 * Die Wege Channel-Fassung, Wortstellung, Anrede erzwingen und Terminologie-Scan schicken Freitext an ein Cloud-Modell, ohne
 * dass ein Mensch vorher sieht, was hinausgeht. Bis 11.11.2026 im Klartext. Jetzt dieselbe Erkennung wie die Vorschau der
 * Textwerkstatt (Phase 3), aber mit festen Einstellungen statt einer Nutzerentscheidung:
 *   1. Schutzeinstellungen laden (abgeschaltete Klassen, Schutzliste, Muster der Artikelnummer). Nicht lesbar: nichts gesendet.
 *   2. Den Auftrag (die Benutzernachricht) verdecken. Ein Platzhalter schon im Text: nichts gesendet (die Zuordnung wäre
 *      mehrdeutig).
 *   3. Restprüfung (Bank, Mail, Telefon): bleibt etwas stehen, nichts gesendet.
 *   4. Die veränderlichen Teile der Anweisung (Begriffe, Marken) dürfen keinen verdeckten Wert verraten.
 *   5. Senden über `callLlm` ohne Ausweichmodell, dann zurücksetzen. `[REDACTED]` vom Proxy oder erfundene Platzhalter:
 *      verworfen. Fehlt ein gesendeter Platzhalter, ist die Antwort verworfen, außer der Aufrufer erlaubt es.
 *
 * Grenze: Die Regeln erkennen nicht jeden Namen (Plan §5 R1). Für diese Wege gibt es keine zweite Schicht, weil niemand
 * dazwischen sitzt. Was nicht erkannt wird, geht im Klartext hinaus, wie bisher alles.
 */
import { callLlm } from '../llm';
import type { LlmResult } from '../llm';
import { PSEUDONYM_HINT, PLACEHOLDER_RE, PFLICHTKLASSEN, SCHUTZKLASSEN, PseudonymSession, PseudonymizationError,
  enthaeltPlatzhalter, restpruefung, vereinheitlichen } from './pseudonymize';
import type { Schutzklasse } from './pseudonymize';
import { standardSchutzQuelle } from './vorschau';
import type { SchutzQuelle } from './vorschau';
import { verrateneWerte } from '../optimieren/werte';

export type MaschinenFehlerCode =
  | 'EINSTELLUNGEN' | 'PLATZHALTER_IM_TEXT' | 'PFLICHT_UEBRIG' | 'WERT_IN_ANWEISUNG' | 'PROXY_GESCHWAERZT'
  | 'PLATZHALTER_UNBEKANNT' | 'PLATZHALTER_FEHLT';

export class MaschinenPseudonymFehler extends Error {
  constructor(readonly code: MaschinenFehlerCode, message: string) {
    super(message);
    this.name = 'MaschinenPseudonymFehler';
  }
}

export interface GeschuetztErgebnis extends LlmResult {
  /** Anzahl der Platzhalter, die hinausgingen (für Protokoll und Prüfskript, keine Werte). */
  platzhalter: number;
  /** Gesendete Platzhalter, die in der Antwort fehlen (nur bei `fehlendErlaubt`). */
  fehlend: number;
}

export type LlmAufruf = (system: string, user: string) => Promise<LlmResult>;

/**
 * Ein Aufruf mit verdecktem Auftrag. `veraenderlich` sind die Teile der Anweisung, die aus Daten kommen (Glossarbegriffe,
 * Markenliste); ohne Angabe wird die ganze Anweisung geprüft. `llm` ist austauschbar für die Prüfskripte.
 */
export async function callLlmGeschuetzt(
  system: string,
  user: string,
  opt: { veraenderlich?: string; fehlendErlaubt?: boolean; quelle?: SchutzQuelle; llm?: LlmAufruf } = {},
): Promise<GeschuetztErgebnis> {
  let einst;
  try {
    einst = await (opt.quelle ?? standardSchutzQuelle).laden();
  } catch {
    throw new MaschinenPseudonymFehler('EINSTELLUNGEN', 'Schutzeinstellungen nicht lesbar, nichts gesendet');
  }
  if (enthaeltPlatzhalter(vereinheitlichen(user))) {
    throw new MaschinenPseudonymFehler('PLATZHALTER_IM_TEXT', 'Der Text enthält schon Platzhalter, nichts gesendet');
  }
  const aus = einst.aus.filter((k: Schutzklasse) => (SCHUTZKLASSEN as readonly string[]).includes(k) && !PFLICHTKLASSEN.has(k));
  let sitzung: PseudonymSession;
  let ausgehend: string;
  try {
    sitzung = new PseudonymSession({ schutzliste: einst.liste, aus, artikelnummer: einst.artikelnummer });
    ausgehend = sitzung.text(user);
  } catch (err) {
    if (err instanceof PseudonymizationError) throw new MaschinenPseudonymFehler('EINSTELLUNGEN', err.message);
    throw err;
  }
  const rest = restpruefung(ausgehend);
  if (!rest.ok) throw new MaschinenPseudonymFehler('PFLICHT_UEBRIG', 'Bank, Mail oder Telefon im Text übrig, nichts gesendet');
  const werte = sitzung.replacements().map((r) => r.value);
  const volleAnweisung = `${system}\n\n${PSEUDONYM_HINT}`;
  if (verrateneWerte(opt.veraenderlich ?? system, werte).length > 0) {
    throw new MaschinenPseudonymFehler('WERT_IN_ANWEISUNG', 'Die Anweisung verrät eine verdeckte Angabe, nichts gesendet');
  }
  const platzhalter = new Set(ausgehend.match(new RegExp(PLACEHOLDER_RE.source, 'g')) ?? []).size;
  const r = await (opt.llm ?? ((s, u) => callLlm(s, u)))(platzhalter > 0 ? volleAnweisung : system, ausgehend);
  if (platzhalter === 0) return { ...r, platzhalter: 0, fehlend: 0 };
  const z = sitzung.zuruecksetzen(r.text, ausgehend);
  if (z.geschwaerzt > 0) throw new MaschinenPseudonymFehler('PROXY_GESCHWAERZT', 'Der Proxy hat Teile geschwärzt, Antwort verworfen');
  if (z.unbekannt.length > 0) throw new MaschinenPseudonymFehler('PLATZHALTER_UNBEKANNT', 'Erfundene Platzhalter, Antwort verworfen');
  if (z.fehlend.length > 0 && !opt.fehlendErlaubt) {
    throw new MaschinenPseudonymFehler('PLATZHALTER_FEHLT', `${z.fehlend.length} Angabe(n) fehlen in der Antwort, verworfen`);
  }
  return { ...r, text: z.text, platzhalter, fehlend: z.fehlend.length };
}
