/**
 * Verwaltung „KI-Anbindung“ (Admin, Textwerkstatt Phase 2, #1838).
 *
 * Zeigt je KI-Weg Modell, Zeitlimit, ob Schlüssel und Endpunkt gesetzt sind (nur der NAME der Variable, nie der Wert),
 * Budget und Sperre, und erlaubt einen Probeaufruf mit festem Text. Schlüssel stehen nur in der `.env` des Servers.
 */
import { useCallback, useEffect, useState, FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';
import { kiFetch, useKiStatus, uhrzeit, KiBudget, KiFehlerCode } from '../hooks/useKiStatus';
import KiBudgetHinweis from './KiBudgetHinweis';

interface KiWegAdmin {
  id: string;
  name: string;
  art: 'lokal' | 'cloud';
  modell: string;
  endpunkt_variable: string;
  schluessel_variable: string;
  zeitlimit_s: number;
  zusatz_parameter: Record<string, unknown>;
  budget_lesen: boolean;
  aktiv: boolean;
  reihenfolge: number;
  schluesselGesetzt: boolean;
  endpunktGesetzt: boolean;
  budget: KiBudget | null;
  sperre: { art: 'eigen' | 'global'; bis: string } | null;
}

interface ProbeErgebnis {
  ok: boolean;
  antwort?: string;
  dauerMs?: number;
  eingabeToken?: number;
  ausgabeToken?: number;
  denkToken?: number | null;
  kostenUsd?: number | null;
  code?: KiFehlerCode;
  error?: string;
}

const LEER: Partial<KiWegAdmin> = {
  id: '', name: '', art: 'lokal', modell: '', endpunkt_variable: 'LLM_BASE_URL', schluessel_variable: 'KI_WEG_',
  zeitlimit_s: 60, zusatz_parameter: {}, budget_lesen: false, aktiv: true, reihenfolge: 0,
};

export default function KiAnbindung() {
  const { t } = useTranslation('ki');
  const { status, laden: statusLaden } = useKiStatus();
  const [wege, setWege] = useState<KiWegAdmin[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [bearbeiten, setBearbeiten] = useState<Partial<KiWegAdmin> | null>(null);
  const [neu, setNeu] = useState(false);
  const [probe, setProbe] = useState<Record<string, ProbeErgebnis | 'laeuft'>>({});

  const laden = useCallback(async () => {
    const r = await kiFetch<KiWegAdmin[]>('/ki-wege');
    if (r.ok) { setWege(r.body); setFehler(null); } else { setFehler(r.body.error || `HTTP ${r.status}`); }
    statusLaden();
  }, [statusLaden]);
  useEffect(() => { laden(); }, [laden]);

  const fehlerText = (code?: KiFehlerCode, error?: string) => (code ? t(`fehler.${code}`, { defaultValue: error }) : error);

  const probeStarten = async (id: string) => {
    setProbe((p) => ({ ...p, [id]: 'laeuft' }));
    const r = await kiFetch<ProbeErgebnis>(`/ki-wege/${encodeURIComponent(id)}/probe`, { method: 'POST' });
    setProbe((p) => ({ ...p, [id]: { ...r.body, ok: r.ok } }));
    laden();
  };

  const budgetText = (b: KiBudget | null) => {
    if (!b) return '–';
    const loc = currentLocale();
    const v = b.verbrauchtUsd.toLocaleString(loc, { maximumFractionDigits: 4 });
    const g = b.grenzeUsd != null ? b.grenzeUsd.toLocaleString(loc) : '∞';
    return t('verwaltung.budgetWert', { verbraucht: v, grenze: g, zeit: uhrzeit(b.resetAm, loc) });
  };

  if (fehler) return <div className="text-red-500 text-sm py-10 text-center">{fehler}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{t('verwaltung.titel')}</h3>
        <button
          onClick={() => { setNeu(true); setBearbeiten({ ...LEER }); }}
          className="px-3 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700"
        >
          {t('verwaltung.neu')}
        </button>
      </div>
      <p className="text-xs text-gray-500">{t('verwaltung.hinweis')}</p>

      {status && <KiBudgetHinweis wege={status.wege} />}

      {bearbeiten && (
        <WegFormular
          // key: Ohne ihn behielte das Formular beim Wechsel die Felder des vorigen Wegs und speicherte sie in den neuen.
          key={neu ? 'neu' : String(bearbeiten.id)}
          weg={bearbeiten}
          neu={neu}
          onSave={() => { setBearbeiten(null); setNeu(false); laden(); }}
          onCancel={() => { setBearbeiten(null); setNeu(false); }}
        />
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-4">{t('verwaltung.spalteWeg')}</th>
              <th className="py-2 pr-4">{t('verwaltung.spalteModell')}</th>
              <th className="py-2 pr-4">{t('verwaltung.spalteZeitlimit')}</th>
              <th className="py-2 pr-4">{t('verwaltung.spalteSchluessel')}</th>
              <th className="py-2 pr-4">{t('verwaltung.spalteBudget')}</th>
              <th className="py-2">{t('verwaltung.spalteAktionen')}</th>
            </tr>
          </thead>
          <tbody>
            {wege.map((w) => {
              const p = probe[w.id];
              return (
                <tr key={w.id} className={`border-b border-gray-50 align-top ${!w.aktiv ? 'opacity-50' : ''}`}>
                  <td className="py-2 pr-4">
                    <div className="font-medium">{w.name}</div>
                    <span className={`text-xs px-2 py-0.5 rounded ${w.art === 'cloud' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>
                      {t(`art.${w.art}`)}
                    </span>
                    {!w.aktiv && <span className="ml-2 text-xs text-gray-500">{t('verwaltung.aus')}</span>}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{w.modell}</td>
                  <td className="py-2 pr-4">{t('verwaltung.sekunden', { s: w.zeitlimit_s })}</td>
                  <td className="py-2 pr-4 text-xs">
                    <div><code>{w.schluessel_variable}</code> {w.schluesselGesetzt
                      ? <span className="text-green-700">{t('verwaltung.gesetzt')}</span>
                      : <span className="text-red-600 font-semibold">{t('verwaltung.fehlt')}</span>}</div>
                    <div className="text-gray-500"><code>{w.endpunkt_variable}</code> {w.endpunktGesetzt
                      ? t('verwaltung.gesetzt')
                      : <span className="text-red-600 font-semibold">{t('verwaltung.fehlt')}</span>}</div>
                  </td>
                  <td className="py-2 pr-4 text-xs">
                    {w.budget_lesen ? budgetText(w.budget) : <span className="text-gray-400">{t('verwaltung.budgetAus')}</span>}
                    {w.sperre && (
                      <div className="text-amber-800">
                        {t(w.sperre.art === 'eigen' ? 'verwaltung.sperreEigen' : 'verwaltung.sperreGlobal', { zeit: uhrzeit(w.sperre.bis, currentLocale()) })}
                      </div>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-3">
                      <button onClick={() => { setNeu(false); setBearbeiten(w); }} className="text-xs text-primary-700 hover:underline">
                        {t('verwaltung.bearbeiten')}
                      </button>
                      <button
                        onClick={() => probeStarten(w.id)}
                        disabled={p === 'laeuft' || !w.aktiv}
                        className="text-xs text-primary-700 hover:underline disabled:text-gray-400"
                      >
                        {p === 'laeuft' ? t('verwaltung.probeLaeuft') : t('verwaltung.probe')}
                      </button>
                    </div>
                    {p && p !== 'laeuft' && (
                      <div className={`mt-1 text-xs ${p.ok ? 'text-gray-700' : 'text-red-600'}`}>
                        {p.ok
                          ? t('verwaltung.probeOk', {
                              ms: p.dauerMs, ein: p.eingabeToken, aus: p.ausgabeToken,
                              denk: p.denkToken ?? '–',
                              kosten: p.kostenUsd != null ? `${p.kostenUsd.toLocaleString(currentLocale(), { maximumFractionDigits: 6 })} $` : '–',
                            })
                          : fehlerText(p.code, p.error)}
                        {p.ok && p.antwort && <div className="text-gray-500 italic mt-0.5">„{p.antwort}“</div>}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {wege.length === 0 && (
              <tr><td colSpan={6} className="py-6 text-center text-gray-400">{t('verwaltung.leer')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WegFormular({ weg, neu, onSave, onCancel }: {
  weg: Partial<KiWegAdmin>; neu: boolean; onSave: () => void; onCancel: () => void;
}) {
  const { t } = useTranslation('ki');
  const [f, setF] = useState<Partial<KiWegAdmin>>(weg);
  const [zusatz, setZusatz] = useState(JSON.stringify(weg.zusatz_parameter ?? {}, null, 2));
  const [fehler, setFehler] = useState<string | null>(null);
  const [speichert, setSpeichert] = useState(false);
  const feld = (k: keyof KiWegAdmin) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const absenden = async (e: FormEvent) => {
    e.preventDefault();
    let zusatzObj: unknown;
    try { zusatzObj = JSON.parse(zusatz || '{}'); } catch { setFehler(t('formular.zusatzKeinJson')); return; }
    // Art und Variablen nur beim Anlegen: Danach sind sie am Server fest.
    const koerper = {
      ...(neu ? { id: f.id, art: f.art, endpunkt_variable: f.endpunkt_variable, schluessel_variable: f.schluessel_variable } : {}),
      name: f.name, modell: f.modell,
      zeitlimit_s: Number(f.zeitlimit_s), zusatz_parameter: zusatzObj, budget_lesen: !!f.budget_lesen, aktiv: !!f.aktiv,
      reihenfolge: Number(f.reihenfolge ?? 0),
    };
    setSpeichert(true);
    const r = await kiFetch(neu ? '/ki-wege' : `/ki-wege/${encodeURIComponent(String(weg.id))}`, {
      method: neu ? 'POST' : 'PUT', body: JSON.stringify(koerper),
    });
    setSpeichert(false);
    if (r.ok) onSave(); else setFehler(r.body.error || `HTTP ${r.status}`);
  };

  const eingabe = 'w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md';
  return (
    <form onSubmit={absenden} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
      <h4 className="text-sm font-medium">{neu ? t('formular.titelNeu') : t('formular.titel', { name: weg.name })}</h4>
      {fehler && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{fehler}</div>}
      <p className="text-xs text-gray-500">{neu ? t('formular.hinweisNeu') : t('formular.hinweisFest')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {neu && (
          <label className="block text-xs text-gray-500">{t('formular.kennung')}
            <input className={eingabe} value={f.id ?? ''} onChange={feld('id')} required pattern="[a-z][a-z0-9-]{0,31}" />
          </label>
        )}
        <label className="block text-xs text-gray-500">{t('formular.name')}
          <input className={eingabe} value={f.name ?? ''} onChange={feld('name')} required maxLength={80} />
        </label>
        <label className="block text-xs text-gray-500">{t('formular.art')}
          <select className={eingabe} value={f.art} onChange={feld('art')} disabled={!neu}>
            <option value="lokal">{t('art.lokal')}</option>
            <option value="cloud">{t('art.cloud')}</option>
          </select>
        </label>
        <label className="block text-xs text-gray-500">{t('formular.modell')}
          <input className={eingabe} value={f.modell ?? ''} onChange={feld('modell')} required maxLength={120} />
        </label>
        <label className="block text-xs text-gray-500">{t('formular.endpunkt')}
          <input className={`${eingabe} font-mono`} value={f.endpunkt_variable ?? ''} onChange={feld('endpunkt_variable')} required disabled={!neu} />
        </label>
        <label className="block text-xs text-gray-500">{t('formular.schluessel')}
          <input className={`${eingabe} font-mono`} value={f.schluessel_variable ?? ''} onChange={feld('schluessel_variable')} required disabled={!neu} />
        </label>
        <label className="block text-xs text-gray-500">{t('formular.zeitlimit')}
          <input className={eingabe} type="number" min={1} max={900} value={f.zeitlimit_s ?? 60} onChange={feld('zeitlimit_s')} required />
        </label>
        <label className="block text-xs text-gray-500">{t('formular.reihenfolge')}
          <input className={eingabe} type="number" min={0} max={1000} value={f.reihenfolge ?? 0} onChange={feld('reihenfolge')} />
        </label>
      </div>
      <label className="block text-xs text-gray-500">{t('formular.zusatz')}
        <textarea className={`${eingabe} font-mono text-xs`} rows={4} value={zusatz} onChange={(e) => setZusatz(e.target.value)} />
        <span className="text-gray-400">{t('formular.zusatzHinweis')}</span>
      </label>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!f.aktiv} onChange={(e) => setF((x) => ({ ...x, aktiv: e.target.checked }))} />
          {t('formular.aktiv')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!f.budget_lesen} onChange={(e) => setF((x) => ({ ...x, budget_lesen: e.target.checked }))} />
          {t('formular.budgetLesen')}
        </label>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={speichert}
          className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-50">
          {t('formular.speichern')}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
          {t('formular.abbrechen')}
        </button>
      </div>
    </form>
  );
}
