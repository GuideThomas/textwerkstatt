/**
 * Verwaltung „Optimierungsarten“ (Admin, Textwerkstatt Phase 4, #1840).
 *
 * Eine Art ist die Anweisung an das Modell und die Strenge der Prüfungen danach. DASS geprüft wird (Zahlen, Platzhalter,
 * Hausschreibweise, Anrede, Länge), legt der Server fest; hier lässt sich nur lockern, was eine Art braucht (Kürzen darf eine
 * Zahl weglassen). Für das öffentliche Repo sind die Arten Einstellungen, keine Werte im Code (Plan §3 G5).
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { kiFetch } from '../../hooks/useKiStatus';

interface Art {
  id: string;
  name: string;
  beschreibung: string;
  anweisung: string;
  zahlen: 'alle' | 'keine_neuen';
  platzhalter_fehlen_erlaubt: boolean;
  anrede: 'beibehalten' | 'du' | 'sie';
  umstellen_erlaubt: boolean;
  laenge_min: number;
  laenge_max: number;
  zielzeichen: boolean;
  aktiv: boolean;
  reihenfolge: number;
}

const LEER: Art = {
  id: '', name: '', beschreibung: '', anweisung: '', zahlen: 'alle', platzhalter_fehlen_erlaubt: false, anrede: 'beibehalten',
  umstellen_erlaubt: true, laenge_min: 0.8, laenge_max: 1.5, zielzeichen: false, aktiv: true, reihenfolge: 0,
};

export default function Optimierungsarten() {
  const { t } = useTranslation('textwerkstatt');
  const [arten, setArten] = useState<Art[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [form, setForm] = useState<Art | null>(null);
  const [neu, setNeu] = useState(false);
  const [speichert, setSpeichert] = useState(false);

  const laden = useCallback(async () => {
    const r = await kiFetch<Art[]>('/arten/alle');
    if (r.ok) { setArten(r.body); setFehler(null); } else { setFehler(r.body.error || `HTTP ${r.status}`); }
  }, []);
  useEffect(() => { laden(); }, [laden]);

  const speichern = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSpeichert(true);
    const { id, ...felder } = form;
    const r = neu
      ? await kiFetch<Art>('/arten', { method: 'POST', body: JSON.stringify(form) })
      : await kiFetch<Art>(`/arten/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(felder) });
    setSpeichert(false);
    if (!r.ok) { setFehler(r.body.error || `HTTP ${r.status}`); return; }
    setForm(null);
    setNeu(false);
    laden();
  };

  const feld = <K extends keyof Art>(k: K, v: Art[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{t('arten.titel')}</h3>
          <p className="text-xs text-gray-500 mt-1 max-w-3xl">{t('arten.hinweis')}</p>
        </div>
        <button
          type="button"
          onClick={() => { setForm({ ...LEER }); setNeu(true); }}
          className="text-xs text-primary-700 hover:underline whitespace-nowrap"
        >
          {t('arten.neu')}
        </button>
      </div>

      {fehler && <div role="alert" className="text-sm text-red-600 bg-red-50 p-2 rounded">{fehler}</div>}

      {form && (
        <form onSubmit={speichern} className="border border-gray-200 rounded-md p-4 space-y-3 bg-gray-50">
          <h4 className="text-sm font-medium">{neu ? t('arten.formular.titelNeu') : t('arten.formular.titel', { name: form.name })}</h4>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {neu && (
              <label className="block text-xs text-gray-500">
                {t('arten.formular.kennung')}
                <input value={form.id} onChange={(e) => feld('id', e.target.value)} required pattern="[a-z][a-z0-9-]{0,31}"
                  className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1 font-mono" />
              </label>
            )}
            <label className="block text-xs text-gray-500">
              {t('arten.formular.name')}
              <input value={form.name} onChange={(e) => feld('name', e.target.value)} required maxLength={60}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
            </label>
            <label className="block text-xs text-gray-500">
              {t('arten.formular.reihenfolge')}
              <input type="number" min={0} max={1000} value={form.reihenfolge} onChange={(e) => feld('reihenfolge', Number(e.target.value))}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
            </label>
          </div>
          <label className="block text-xs text-gray-500">
            {t('arten.formular.beschreibung')}
            <input value={form.beschreibung} onChange={(e) => feld('beschreibung', e.target.value)} maxLength={300}
              className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
          </label>
          <label className="block text-xs text-gray-500">
            {t('arten.formular.anweisung')}
            <textarea value={form.anweisung} onChange={(e) => feld('anweisung', e.target.value)} required minLength={10} maxLength={4000} rows={4}
              className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
          </label>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="block text-xs text-gray-500">
              {t('arten.formular.zahlen')}
              <select value={form.zahlen} onChange={(e) => feld('zahlen', e.target.value as Art['zahlen'])}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1">
                <option value="alle">{t('arten.formular.zahlenAlle')}</option>
                <option value="keine_neuen">{t('arten.formular.zahlenKeineNeuen')}</option>
              </select>
            </label>
            <label className="block text-xs text-gray-500">
              {t('arten.formular.anrede')}
              <select value={form.anrede} onChange={(e) => feld('anrede', e.target.value as Art['anrede'])}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1">
                <option value="beibehalten">{t('arten.formular.anredeBeibehalten')}</option>
                <option value="du">{t('arten.formular.anredeDu')}</option>
                <option value="sie">{t('arten.formular.anredeSie')}</option>
              </select>
            </label>
            <label className="block text-xs text-gray-500">
              {t('arten.formular.laengeMin')}
              <input type="number" step={0.05} min={0.05} max={5} value={form.laenge_min} onChange={(e) => feld('laenge_min', Number(e.target.value))}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
            </label>
            <label className="block text-xs text-gray-500">
              {t('arten.formular.laengeMax')}
              <input type="number" step={0.05} min={0.05} max={5} value={form.laenge_max} onChange={(e) => feld('laenge_max', Number(e.target.value))}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
            </label>
          </div>
          <div className="flex flex-wrap gap-4 text-sm text-gray-700">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.platzhalter_fehlen_erlaubt} onChange={(e) => feld('platzhalter_fehlen_erlaubt', e.target.checked)} className="accent-primary-600" />
              {t('arten.formular.platzhalter')}
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.umstellen_erlaubt} onChange={(e) => feld('umstellen_erlaubt', e.target.checked)} className="accent-primary-600" />
              {t('arten.formular.umstellen')}
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.zielzeichen} onChange={(e) => feld('zielzeichen', e.target.checked)} className="accent-primary-600" />
              {t('arten.formular.zielzeichen')}
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.aktiv} onChange={(e) => feld('aktiv', e.target.checked)} className="accent-primary-600" />
              {t('arten.formular.aktiv')}
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setForm(null); setNeu(false); }} className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
              {t('arten.formular.abbrechen')}
            </button>
            <button type="submit" disabled={speichert} className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-50">
              {t('arten.formular.speichern')}
            </button>
          </div>
        </form>
      )}

      {arten && arten.length === 0 && <p className="py-6 text-center text-gray-400 text-sm">{t('arten.leer')}</p>}
      {arten && arten.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-4">{t('arten.spalteArt')}</th>
              <th className="py-2 pr-4">{t('arten.spalteRegeln')}</th>
              <th className="py-2">{t('arten.spalteAktionen')}</th>
            </tr>
          </thead>
          <tbody>
            {arten.map((a) => (
              <tr key={a.id} className={`border-b border-gray-50 align-top ${a.aktiv ? '' : 'opacity-60'}`}>
                <td className="py-2 pr-4">
                  <div className="font-medium">{a.name} <span className="font-mono text-xs text-gray-400">{a.id}</span></div>
                  {!a.aktiv && <div className="text-xs text-gray-500">{t('arten.aus')}</div>}
                  <div className="text-xs text-gray-500 mt-0.5 max-w-xl">{a.anweisung}</div>
                </td>
                <td className="py-2 pr-4 text-xs text-gray-600">
                  <div>{a.zahlen === 'alle' ? t('arten.regelZahlenAlle') : t('arten.regelZahlenKeineNeuen')}</div>
                  {a.platzhalter_fehlen_erlaubt && <div>{t('arten.regelPlatzhalter')}</div>}
                  {!a.umstellen_erlaubt && <div>{t('arten.regelReihenfolge')}</div>}
                  <div>{t(`arten.regelAnrede_${a.anrede}`)}</div>
                  <div>{t('arten.regelLaenge', { von: a.laenge_min, bis: a.laenge_max })}</div>
                  {a.zielzeichen && <div>{t('arten.regelZiel')}</div>}
                </td>
                <td className="py-2">
                  <button type="button" onClick={() => { setForm({ ...a }); setNeu(false); }} className="text-xs text-primary-700 hover:underline">
                    {t('arten.bearbeiten')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
