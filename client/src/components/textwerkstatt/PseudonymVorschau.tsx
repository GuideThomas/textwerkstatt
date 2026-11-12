/**
 * Vorschau „so sieht es das Cloud-Modell“ (Textwerkstatt Phase 3, Plan `PLAN-textwerkstatt.md` §4 Phase 3, #1839).
 *
 * Zeigt genau den Text, den der Server hinausschicken würde, mit den Platzhaltern farbig nach Klasse. Ein Klick auf einen
 * Platzhalter deckt ihn auf (außer Bankverbindung, Mail, Telefon), ein markiertes Wort wird verdeckt. Jede Änderung
 * erzeugt am Server eine neue Vorschau; gesendet wird später nur deren Kennung (`vorschauId`), nie ein Text aus dem
 * Browser (G3). Die Komponente sendet selbst nichts an ein Modell.
 *
 * Die Masken (verdeckt, aufgedeckt) kann die Seite halten (`masken`, `onMasken`): Dann überleben sie eine Textänderung,
 * etwa die Übernahme eines Ergebnisses, und den Wechsel zwischen Schritten. Ohne diese Angaben gelten sie nur für den Text,
 * für den sie gesetzt wurden (Review M1, 11.11.2026).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../../i18n';
import { kiFetch, uhrzeit } from '../../hooks/useKiStatus';

export type Schutzklasse =
  | 'BANK' | 'MAIL' | 'TELEFON' | 'PERSON' | 'ANSCHRIFT' | 'URL' | 'FIRMA' | 'PROJEKT' | 'PREIS' | 'ARTIKELNR' | 'BELEGNR'
  | 'EIGEN';

export interface VorschauTreffer {
  platzhalter: string;
  art: string;
  klasse: Schutzklasse;
  wert: string;
  pflicht: boolean;
  /** Nicht in einer Pflichtklasse und nicht aus der Schutzliste. Entscheidet der Server. */
  aufdeckbar: boolean;
}

export interface Vorschau {
  vorschauId: string;
  gueltigBis: string;
  ausgehend: string;
  segmente: ({ text: string } | VorschauTreffer)[];
  zaehler: Partial<Record<Schutzklasse, number>>;
  aufgedeckt: string[];
  nichtAufdeckbar: string[];
  klassenAus: Schutzklasse[];
  restpruefung: { ok: boolean; funde: { klasse: Schutzklasse; art: string; anzahl: number }[] };
}

/** Feste Farbe je Klasse; Pflichtklassen in Rottönen. */
export const KLASSEN_FARBE: Record<Schutzklasse, string> = {
  BANK: 'bg-red-100 text-red-800 border-red-300',
  MAIL: 'bg-pink-100 text-pink-800 border-pink-300',
  TELEFON: 'bg-orange-100 text-orange-800 border-orange-300',
  PERSON: 'bg-blue-100 text-blue-800 border-blue-300',
  ANSCHRIFT: 'bg-cyan-100 text-cyan-800 border-cyan-300',
  URL: 'bg-slate-100 text-slate-800 border-slate-300',
  FIRMA: 'bg-violet-100 text-violet-800 border-violet-300',
  PROJEKT: 'bg-indigo-100 text-indigo-800 border-indigo-300',
  PREIS: 'bg-amber-100 text-amber-800 border-amber-300',
  ARTIKELNR: 'bg-lime-100 text-lime-800 border-lime-300',
  BELEGNR: 'bg-teal-100 text-teal-800 border-teal-300',
  EIGEN: 'bg-gray-200 text-gray-800 border-gray-400',
};

const istTreffer = (s: { text: string } | VorschauTreffer): s is VorschauTreffer => 'platzhalter' in s;

export interface Masken {
  verdecken: string[];
  aufdecken: string[];
}

export default function PseudonymVorschau({ text, onVorschau, masken, onMasken }: {
  text: string;
  onVorschau?: (v: Vorschau | null) => void;
  masken?: Masken;
  onMasken?: (m: Masken) => void;
}) {
  const { t } = useTranslation('pseudonym');
  const [eigeneVerdecken, setEigeneVerdecken] = useState<string[]>([]);
  const [eigeneAufdecken, setEigeneAufdecken] = useState<string[]>([]);
  const gesteuert = !!masken && !!onMasken;
  const verdecken = gesteuert ? masken!.verdecken : eigeneVerdecken;
  const aufdecken = gesteuert ? masken!.aufdecken : eigeneAufdecken;
  const setVerdecken = (f: (v: string[]) => string[]) =>
    gesteuert ? onMasken!({ verdecken: f(masken!.verdecken), aufdecken: masken!.aufdecken }) : setEigeneVerdecken(f);
  const setAufdecken = (f: (v: string[]) => string[]) =>
    gesteuert ? onMasken!({ verdecken: masken!.verdecken, aufdecken: f(masken!.aufdecken) }) : setEigeneAufdecken(f);
  const [vorschau, setVorschau] = useState<Vorschau | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [auswahl, setAuswahl] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const anfrage = useRef(0);
  const meldung = useRef(onVorschau);
  meldung.current = onVorschau;

  // Ein neuer Text: Die Masken des alten gelten nicht mehr — außer die Seite hält sie und entscheidet selbst.
  useEffect(() => {
    if (gesteuert) return;
    setEigeneVerdecken([]);
    setEigeneAufdecken([]);
  }, [text, gesteuert]);

  useEffect(() => {
    if (!text.trim()) {
      setVorschau(null);
      meldung.current?.(null);
      return;
    }
    const nr = ++anfrage.current;
    setLaeuft(true);
    // Sofort melden, dass die alte Vorschau nicht mehr gilt: Sonst schickte ein schnelles „Senden“ die Fassung ohne das
    // eben verdeckte Wort (Review M7).
    meldung.current?.(null);
    const warte = setTimeout(async () => {
      let r: Awaited<ReturnType<typeof kiFetch<Vorschau>>>;
      try {
        r = await kiFetch<Vorschau>('/vorschau', { method: 'POST', body: JSON.stringify({ text, verdecken, aufdecken }) });
      } catch {
        if (nr !== anfrage.current) return;
        setLaeuft(false);
        setVorschau(null);
        setFehler(t('vorschau.netzFehler'));
        return;
      }
      if (nr !== anfrage.current) return; // eine neuere Anfrage läuft
      setLaeuft(false);
      if (r.ok) {
        setVorschau(r.body);
        setFehler(null);
        meldung.current?.(r.body);
      } else {
        setVorschau(null);
        setFehler(r.body.code ? t(`fehler.${r.body.code}`, { defaultValue: r.body.error }) : r.body.error || `HTTP ${r.status}`);
        meldung.current?.(null);
      }
    }, 300);
    return () => clearTimeout(warte);
  }, [text, verdecken, aufdecken, t]);

  const auswahlLesen = () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !box.current || !s.anchorNode || !box.current.contains(s.anchorNode)) {
      setAuswahl(null);
      return;
    }
    setAuswahl(s.toString().replace(/\s+/g, ' ').trim() || null);
  };
  const auswahlGueltig = !!auswahl && auswahl.length >= 2 && auswahl.length <= 100 && !/[[\]]/.test(auswahl);

  const verdeckeAuswahl = () => {
    if (!auswahl || !auswahlGueltig) return;
    setVerdecken((v) => (v.includes(auswahl) ? v : [...v, auswahl]));
    setAuswahl(null);
    window.getSelection()?.removeAllRanges();
  };

  const treffer = vorschau?.segmente.filter(istTreffer) ?? [];
  const klassen = Object.entries(vorschau?.zaehler ?? {}) as [Schutzklasse, number][];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-gray-900">{t('vorschau.titel')}</h4>
        {laeuft && <span className="text-xs text-gray-500">{t('vorschau.laeuft')}</span>}
        {!laeuft && vorschau && (
          <span className="text-xs text-gray-400">{t('vorschau.gueltigBis', { zeit: uhrzeit(vorschau.gueltigBis, currentLocale()) })}</span>
        )}
      </div>
      <p className="text-xs text-gray-500">{t('vorschau.erklaerung')}</p>

      {fehler && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-md">{fehler}</div>}

      {vorschau && (
        <>
          <div
            ref={box}
            onMouseUp={auswahlLesen}
            onKeyUp={auswahlLesen}
            className="whitespace-pre-wrap text-sm leading-relaxed border border-gray-200 rounded-md p-3 bg-white"
            aria-label={t('vorschau.titel')}
          >
            {vorschau.segmente.map((s, i) =>
              istTreffer(s) ? (
                <button
                  key={i}
                  type="button"
                  onClick={() => s.aufdeckbar && setAufdecken((a) => (a.includes(s.wert) ? a : [...a, s.wert]))}
                  title={`${t(`klasse.${s.klasse}`)}: ${s.wert} · ${s.aufdeckbar ? t('vorschau.trefferAufdecken') : t('vorschau.trefferPflicht')}`}
                  aria-disabled={!s.aufdeckbar}
                  className={`inline px-1 mx-px rounded border font-mono text-xs align-baseline ${KLASSEN_FARBE[s.klasse]} ${
                    s.aufdeckbar ? 'hover:line-through' : 'cursor-not-allowed'
                  }`}
                >
                  {s.platzhalter}
                </button>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </div>

          {auswahl && (
            <div className="flex items-center gap-3 text-sm">
              {auswahlGueltig ? (
                <button type="button" onClick={verdeckeAuswahl} className="px-3 py-1 bg-primary-600 text-white rounded-md hover:bg-primary-700">
                  {t('vorschau.verdecken', { wort: auswahl.length > 40 ? `${auswahl.slice(0, 40)} …` : auswahl })}
                </button>
              ) : (
                <span className="text-xs text-gray-500">{t('vorschau.auswahlUngueltig')}</span>
              )}
            </div>
          )}

          {treffer.length === 0 && <p className="text-xs text-gray-500">{t('vorschau.keineTreffer')}</p>}

          {klassen.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs">
              {klassen.map(([k, n]) => (
                <span key={k} className={`px-2 py-0.5 rounded border ${KLASSEN_FARBE[k]}`}>
                  {t(`klasse.${k}`)}: {n}
                </span>
              ))}
            </div>
          )}

          {(verdecken.length > 0 || aufdecken.length > 0) && (
            <div className="space-y-1 text-xs">
              {verdecken.length > 0 && (
                <MaskenListe titel={t('vorschau.verdeckt')} werte={verdecken} entfernen={(w) => setVerdecken((v) => v.filter((x) => x !== w))} />
              )}
              {aufdecken.length > 0 && (
                <MaskenListe titel={t('vorschau.aufgedeckt')} werte={aufdecken} entfernen={(w) => setAufdecken((v) => v.filter((x) => x !== w))} />
              )}
            </div>
          )}

          {vorschau.nichtAufdeckbar.length > 0 && <p className="text-xs text-amber-800">{t('vorschau.nichtAufdeckbar')}</p>}

          <div
            role="status"
            className={`text-sm px-3 py-2 rounded-md border ${
              vorschau.restpruefung.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            {vorschau.restpruefung.ok
              ? t('vorschau.restOk')
              : t('vorschau.restFehler', {
                  funde: vorschau.restpruefung.funde.map((f) => `${t(`klasse.${f.klasse}`)} (${f.anzahl})`).join(', '),
                })}
          </div>
        </>
      )}

      <ul className="text-xs text-gray-500 list-disc pl-5 space-y-1">
        <li>{t('hinweis.rest')}</li>
        <li>{t('hinweis.deepl')}</li>
        <li>{t('hinweis.lokal')}</li>
      </ul>
    </div>
  );
}

function MaskenListe({ titel, werte, entfernen }: { titel: string; werte: string[]; entfernen: (w: string) => void }) {
  const { t } = useTranslation('pseudonym');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-gray-500">{titel}:</span>
      {werte.map((w) => (
        <span key={w} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 border border-gray-300 rounded">
          {w}
          <button type="button" onClick={() => entfernen(w)} className="text-gray-500 hover:text-red-600" aria-label={`${t('vorschau.entfernen')}: ${w}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
