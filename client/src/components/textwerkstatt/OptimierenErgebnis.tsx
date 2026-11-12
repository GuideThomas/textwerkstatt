/**
 * Ergebnis des Schritts „Optimieren“ (Textwerkstatt Phase 4, Plan `PLAN-textwerkstatt.md` §4 Phase 4, #1840):
 * Prüfbefund, Gegenüberstellung alt/neu auf Wortebene, Übernahme ganz oder je Absatz, Verwerfen.
 *
 * Ob übernommen werden darf, entscheidet der Befund des Servers (G1): Bei „verworfen“ gibt es keine Übernahme, nur die
 * Anzeige mit Grund. Ist der Text seit dem Lauf geändert, gibt es auch keine, denn die Absätze passten nicht mehr.
 * Ob ein Absatz einzeln wählbar ist, sagt ebenfalls der Server (`waehlbar` mit Grund): nur, wenn der Absatz für sich dieselben
 * Zahlen, Tags und Werte trägt, keinen vermiedenen Begriff bringt und erkennbar dieselbe Stelle ist (Review M9).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { einstellungen } from '../../einstellungen';
import { currentLocale } from '../../i18n';
import { absaetzeEinsetzen, wortDiff, type DiffTeil } from './wortDiff';
import { kiFetch } from '../../hooks/useKiStatus';

export type PruefStufe = 'ok' | 'hinweis' | 'verstoss';

export interface PruefPunkt {
  pruefung: 'antwort' | 'zahlen' | 'platzhalter' | 'werte' | 'markup' | 'hausschreibweise' | 'anrede' | 'laenge' | 'zielzeichen' | 'channel';
  stufe: PruefStufe;
  code: string | null;
  fehlt?: string[];
  neu?: string[];
  ist?: number;
  soll?: number | [number, number];
}

export interface OptimierAntwort {
  text: string;
  original: string;
  art: { id: string; name: string };
  weg: { id: string; art: 'lokal' | 'cloud'; modell: string };
  befund: { ergebnis: 'ok' | 'hinweis' | 'verworfen'; punkte: PruefPunkt[]; gruende: string[] };
  absaetze: { alt: string; neu: string; waehlbar: boolean; grund: string | null }[] | null;
  fehlend: { platzhalter: string; klasse: string; wert: string }[];
  zielzeichen: number | null;
  ki: { dauerMs: number; eingabeToken: number; ausgabeToken: number; denkToken: number | null; kostenUsd: number | null };
  /** Phase 5: Stilprofil und Fassung, mit denen optimiert wurde. */
  stil: { id: string; name: string; fassung: number } | null;
  /** Phase 5: Was die Channel-Fassung danach tat; `regel` heißt nach Regel ersetzt, Artikel und Endungen ansehen. */
  channel: { code: string; herkunft: 'unverändert' | 'sprachmodell' | 'regel' | 'offen'; treffer: { original: string; ersatz: string }[] } | null;
}

function Diff({ teile, fallback }: { teile: DiffTeil[] | null; fallback: string }) {
  if (!teile) return <span>{fallback}</span>;
  return (
    <>
      {teile.map((d, i) =>
        d.art === 'gleich' ? (
          <span key={i}>{d.text}</span>
        ) : d.art === 'weg' ? (
          <del key={i} className="bg-red-50 text-red-700 line-through decoration-red-400">{d.text}</del>
        ) : (
          <ins key={i} className="bg-green-50 text-green-800 no-underline font-medium">{d.text}</ins>
        ),
      )}
    </>
  );
}

const STUFE_ZEICHEN: Record<PruefStufe, string> = { ok: '✓', hinweis: '⚠', verstoss: '✗' };
const STUFE_FARBE: Record<PruefStufe, string> = {
  ok: 'bg-green-50 border-green-200 text-green-800',
  hinweis: 'bg-amber-50 border-amber-200 text-amber-800',
  verstoss: 'bg-red-50 border-red-200 text-red-800',
};

export default function OptimierenErgebnis({
  ergebnis, laeuft, fehler, veraltet, uebernommen, wegName, channelCode, onUebernehmen, onVerwerfen, onWeiter,
}: {
  ergebnis: OptimierAntwort | null;
  laeuft: boolean;
  fehler: string | null;
  veraltet: boolean;
  uebernommen: boolean;
  wegName: string | null;
  /** Channel, gegen dessen Hausschreibweise geprüft wurde; dieselbe Prüfung gilt für die zusammengesetzte Fassung. */
  channelCode: string | null;
  /** Übernimmt `text`; `basis` ist das Ergebnis, aus dem er stammt. Die Seite prüft, ob es noch gilt. */
  onUebernehmen: (text: string, basis: OptimierAntwort) => void;
  onVerwerfen: () => void;
  onWeiter: () => void;
}) {
  const { t } = useTranslation('textwerkstatt');
  const { t: tp } = useTranslation('pseudonym');
  const [auswahl, setAuswahl] = useState<Set<number>>(new Set());
  const aktuell = useRef(ergebnis);
  aktuell.current = ergebnis;
  const [kombi, setKombi] = useState<{ laeuft: boolean; fehler: string | null; punkte: PruefPunkt[] }>({ laeuft: false, fehler: null, punkte: [] });
  useEffect(() => {
    setAuswahl(new Set());
    setKombi({ laeuft: false, fehler: null, punkte: [] });
  }, [ergebnis]);

  /**
   * Einzelne Absätze: Die zusammengesetzte Fassung geht vorher durch dieselbe Prüfung am Server, ohne Modell. Die Prüfung je
   * Absatz kann eine Summe nicht absichern (Review M9-Rest: ein Absatz um einen erfundenen Satz länger, ein anderer kürzer).
   */
  const absaetzeUebernehmen = async () => {
    if (!ergebnis?.absaetze) return;
    const text = absaetzeEinsetzen(ergebnis.original, ergebnis.absaetze.map((a) => a.neu), auswahl);
    setKombi({ laeuft: true, fehler: null, punkte: [] });
    try {
      const r = await kiFetch<{ befund: OptimierAntwort['befund'] }>('/optimieren/kombination', {
        method: 'POST',
        body: JSON.stringify({ art: ergebnis.art.id, original: ergebnis.original, text, channelCode, zielzeichen: ergebnis.zielzeichen }),
      });
      // Während der Prüfung kann der Nutzer verworfen, neu optimiert oder weitergetippt haben (Review K1): Dann gilt die Antwort
      // nicht mehr. Die Seite prüft das ein zweites Mal in `onUebernehmen`.
      if (aktuell.current !== ergebnis) return;
      if (!r.ok) { setKombi({ laeuft: false, fehler: r.body.error || `HTTP ${r.status}`, punkte: [] }); return; }
      if (r.body.befund.ergebnis === 'verworfen') {
        setKombi({ laeuft: false, fehler: t('optimieren.kombinationVerworfen'), punkte: r.body.befund.punkte.filter((p) => p.stufe === 'verstoss') });
        return;
      }
      setKombi({ laeuft: false, fehler: null, punkte: [] });
      onUebernehmen(text, ergebnis);
    } catch {
      if (aktuell.current === ergebnis) setKombi({ laeuft: false, fehler: t('optimieren.netzFehler'), punkte: [] });
    }
  };

  const verworfen = ergebnis?.befund.ergebnis === 'verworfen';
  const gesperrt = !ergebnis || verworfen || veraltet;

  const diffGanz = useMemo(() => (ergebnis && !ergebnis.absaetze ? wortDiff(ergebnis.original, ergebnis.text) : null), [ergebnis]);
  const diffAbsaetze = useMemo(() => ergebnis?.absaetze?.map((a) => wortDiff(a.alt, a.neu)) ?? null, [ergebnis]);

  const meldung = (p: PruefPunkt) => {
    const soll = Array.isArray(p.soll) ? p.soll : null;
    const zahl = (n: number) => n.toLocaleString(currentLocale(), { maximumFractionDigits: 2 });
    return t(`optimieren.code.${p.code}`, {
      neu: (p.neu ?? []).join(', '),
      fehlt: (p.fehlt ?? []).join(', '),
      ist: p.ist !== undefined ? zahl(p.ist) : '',
      von: soll ? zahl(soll[0]) : '',
      bis: soll ? zahl(soll[1]) : '',
      soll: typeof p.soll === 'number' ? zahl(p.soll) : '',
    });
  };

  const umschalten = (i: number) =>
    setAuswahl((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i); else n.add(i);
      return n;
    });

  return (
    <div className="bg-white rounded-lg border border-gray-200 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-700">
          {ergebnis ? t('optimieren.kopf', { art: ergebnis.art.name, weg: wegName ?? ergebnis.weg.id }) : t('steps.optimieren')}
          {ergebnis?.stil && <> · {t('optimieren.kopfStil', { name: ergebnis.stil.name, fassung: ergebnis.stil.fassung })}</>}
          {/* Demo: das Ergebnis ist als KI-Text gekennzeichnet (PLAN-oeffentlich-und-demo.md Phase 2). */}
          {ergebnis && einstellungen().demo && (
            <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-900 align-middle">
              {t('optimieren.kiText')}
            </span>
          )}
        </span>
        {ergebnis && (
          <span className="text-xs text-gray-400">
            {t('optimieren.dauer', { sek: (ergebnis.ki.dauerMs / 1000).toLocaleString(currentLocale(), { maximumFractionDigits: 1 }) })}
            {ergebnis.ki.kostenUsd != null && <> · {t('optimieren.kosten', { usd: ergebnis.ki.kostenUsd.toLocaleString(currentLocale(), { maximumSignificantDigits: 2 }) })}</>}
          </span>
        )}
      </div>

      {veraltet && ergebnis && (
        <div className="px-4 py-2 border-b border-amber-100 bg-amber-50 text-xs text-amber-800">{t('optimieren.veraltet')}</div>
      )}

      <div className="h-80 px-4 py-3 overflow-y-auto space-y-3">
        {laeuft && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <span className="animate-spin">&#9696;</span> {t('optimieren.laeuft')}
          </div>
        )}
        {fehler && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-md">{fehler}</div>}
        {uebernommen && !ergebnis && !laeuft && (
          <div role="status" className="text-sm text-green-800 bg-green-50 border border-green-200 p-3 rounded-md space-y-2">
            <p>{t('optimieren.uebernommen')}</p>
            <button type="button" onClick={onWeiter} className="text-xs font-semibold text-primary-700 hover:text-primary-900">
              {t('optimieren.weiterUebersetzen')} ➜
            </button>
          </div>
        )}
        {!laeuft && !fehler && !ergebnis && !uebernommen && <p className="text-sm text-gray-300">{t('optimieren.placeholder')}</p>}

        {ergebnis && (
          <>
            {ergebnis.channel && ergebnis.channel.herkunft !== 'unverändert' && (
              <p className={`text-xs ${ergebnis.channel.herkunft === 'sprachmodell' ? 'text-gray-500' : 'text-amber-800'}`}>
                {t(`optimieren.channelSchritt.${ergebnis.channel.herkunft}`, {
                  code: ergebnis.channel.code,
                  liste: ergebnis.channel.treffer.length
                    ? [...new Set(ergebnis.channel.treffer.map((x) => `${x.original} → ${x.ersatz}`))].join(', ')
                    : '—',
                })}
              </p>
            )}
            {/* Befund: ein Zeichen je Prüfung, Gründe darunter */}
            <div role="status" className={`text-sm px-3 py-2 rounded-md border ${STUFE_FARBE[verworfen ? 'verstoss' : ergebnis.befund.ergebnis === 'hinweis' ? 'hinweis' : 'ok']}`}>
              <p className="font-medium">{t(`optimieren.befund.${ergebnis.befund.ergebnis}`)}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs">
                {ergebnis.befund.punkte.map((p) => (
                  <span key={p.pruefung} title={p.code ? meldung(p) : undefined}>
                    {STUFE_ZEICHEN[p.stufe]} {t(`optimieren.pruefung.${p.pruefung}`)}
                  </span>
                ))}
              </div>
              {ergebnis.befund.punkte.some((p) => p.code) && (
                <ul className="mt-1 text-xs list-disc pl-5">
                  {ergebnis.befund.punkte.filter((p) => p.code).map((p) => (
                    <li key={p.pruefung} className={p.stufe === 'verstoss' ? 'text-red-800' : 'text-amber-800'}>{meldung(p)}</li>
                  ))}
                </ul>
              )}
            </div>

            {kombi.fehler && (
              <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 p-3 rounded-md">
                <p>{kombi.fehler}</p>
                {kombi.punkte.length > 0 && (
                  <ul className="mt-1 text-xs list-disc pl-5">{kombi.punkte.map((p) => <li key={p.pruefung}>{meldung(p)}</li>)}</ul>
                )}
              </div>
            )}

            {ergebnis.fehlend.length > 0 && (
              <p className="text-xs text-amber-800">
                {t('optimieren.fehlend', {
                  liste: ergebnis.fehlend.map((f) => `${tp(`klasse.${f.klasse}`, { defaultValue: f.klasse })} „${f.wert}“`).join(', '),
                })}
              </p>
            )}

            {/* Gegenüberstellung: links steht das Original im Eingabefeld, hier das Ergebnis mit den Änderungen */}
            {ergebnis.absaetze ? (
              <div className="space-y-3">
                {ergebnis.absaetze.map((a, i) => {
                  const waehlbar = !gesperrt && a.waehlbar;
                  const grund = a.grund ? t(`optimieren.absatzGrund.${a.grund}`) : t('optimieren.absatz', { n: i + 1 });
                  return (
                    <div key={i} className="flex gap-2 items-start">
                      <input
                        type="checkbox"
                        className="mt-1 accent-primary-600"
                        checked={auswahl.has(i)}
                        disabled={!waehlbar}
                        onChange={() => umschalten(i)}
                        aria-label={t('optimieren.absatz', { n: i + 1 })}
                        title={grund}
                      />
                      <p className="text-sm text-gray-900 whitespace-pre-wrap flex-1">
                        <Diff teile={diffAbsaetze?.[i] ?? null} fallback={a.neu} />
                        {a.grund && a.grund !== 'gleich' && <span className="ml-1 text-xs text-amber-700" title={grund}>⚠</span>}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-900 whitespace-pre-wrap"><Diff teile={diffGanz} fallback={ergebnis.text} /></p>
                {/* Nur, wenn es mehrere Absätze gibt: Bei einem einzigen ist „ganz übernehmen“ selbstverständlich (Übergabe 11.11.2026). */}
                {ergebnis.original.split(/\n+/).filter((x) => x.trim()).length > 1 && (
                  <p className="text-xs text-gray-400">{t('optimieren.nurGanz')}</p>
                )}
              </>
            )}
          </>
        )}
      </div>

      {ergebnis && (
        <div className="px-4 py-3 border-t border-gray-100 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onVerwerfen} disabled={kombi.laeuft} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md disabled:opacity-40">
            {t('optimieren.verwerfen')}
          </button>
          {ergebnis.absaetze && (
            <button
              type="button"
              disabled={gesperrt || auswahl.size === 0 || kombi.laeuft}
              onClick={absaetzeUebernehmen}
              className="px-3 py-1.5 text-sm border border-primary-300 text-primary-700 rounded-md hover:bg-primary-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {kombi.laeuft ? t('optimieren.kombinationLaeuft') : t('optimieren.auswahl', { count: auswahl.size })}
            </button>
          )}
          <button
            type="button"
            disabled={gesperrt}
            onClick={() => onUebernehmen(ergebnis.text, ergebnis)}
            title={verworfen ? t('optimieren.befund.verworfen') : veraltet ? t('optimieren.veraltet') : undefined}
            className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('optimieren.ganz')}
          </button>
        </div>
      )}
    </div>
  );
}
