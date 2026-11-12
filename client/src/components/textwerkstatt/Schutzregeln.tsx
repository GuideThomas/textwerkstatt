/**
 * Verwaltung „Schutzregeln“ (Admin, Textwerkstatt Phase 3, #1839): welche Klassen vor dem Senden an ein Cloud-Modell
 * verdeckt werden, das Muster der Artikelnummer, die Schutzliste, und eine Probe mit der echten Vorschau.
 * Pflichtklassen (Bankverbindung, Mail, Telefon) lassen sich nicht abschalten; das prüft auch der Server.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { kiFetch } from '../../hooks/useKiStatus';
import PseudonymVorschau, { KLASSEN_FARBE, Schutzklasse } from './PseudonymVorschau';

interface KlasseZeile {
  klasse: Exclude<Schutzklasse, 'EIGEN'>;
  aktiv: boolean;
  pflicht: boolean;
  muster: string | null;
}

type BegriffArt = 'PERSON' | 'FIRMA' | 'PROJEKT' | 'BEGRIFF';
interface ListenZeile {
  id: number;
  begriff: string;
  art: BegriffArt;
}

const ARTEN: BegriffArt[] = ['FIRMA', 'PROJEKT', 'PERSON', 'BEGRIFF'];

export default function Schutzregeln() {
  const { t } = useTranslation('pseudonym');
  const [klassen, setKlassen] = useState<KlasseZeile[]>([]);
  const [liste, setListe] = useState<ListenZeile[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [muster, setMuster] = useState('');
  const [begriff, setBegriff] = useState('');
  const [art, setArt] = useState<BegriffArt>('FIRMA');
  const [entwurf, setEntwurf] = useState('');
  const [probeText, setProbeText] = useState('');

  const laden = useCallback(async () => {
    const r = await kiFetch<{ klassen: KlasseZeile[]; liste: ListenZeile[] }>('/schutz');
    if (!r.ok) { setFehler(r.body.error || `HTTP ${r.status}`); return; }
    setKlassen(r.body.klassen);
    setListe(r.body.liste);
    setMuster(r.body.klassen.find((k) => k.klasse === 'ARTIKELNR')?.muster ?? '');
    setFehler(null);
  }, []);
  useEffect(() => { laden(); }, [laden]);

  const antwort = (r: { ok: boolean; status: number; body: { error?: string } }) => {
    if (r.ok) { setMeldung(t('verwaltung.gespeichert')); setFehler(null); } else { setFehler(r.body.error || `HTTP ${r.status}`); setMeldung(null); }
  };

  const umschalten = async (k: KlasseZeile) => {
    if (k.pflicht) return;
    antwort(await kiFetch(`/schutz/klassen/${k.klasse}`, { method: 'PUT', body: JSON.stringify({ aktiv: !k.aktiv }) }));
    laden();
  };

  const musterSpeichern = async (e: FormEvent) => {
    e.preventDefault();
    antwort(await kiFetch('/schutz/klassen/ARTIKELNR', { method: 'PUT', body: JSON.stringify({ muster: muster.trim() || null }) }));
    laden();
  };

  const begriffAnlegen = async (e: FormEvent) => {
    e.preventDefault();
    const r = await kiFetch('/schutz/liste', { method: 'POST', body: JSON.stringify({ begriff, art }) });
    antwort(r);
    if (r.ok) setBegriff('');
    laden();
  };

  const begriffLoeschen = async (id: number) => {
    antwort(await kiFetch(`/schutz/liste/${id}`, { method: 'DELETE' }));
    laden();
  };

  const eingabe = 'px-3 py-1.5 text-sm border border-gray-300 rounded-md';
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{t('verwaltung.titel')}</h3>
        <p className="text-xs text-gray-500 mt-1">{t('verwaltung.hinweis')}</p>
      </div>
      {fehler && <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 p-2 rounded">{fehler}</div>}
      {meldung && <div role="status" className="text-sm text-green-800 bg-green-50 border border-green-200 p-2 rounded">{meldung}</div>}

      <section className="space-y-2">
        <h4 className="text-sm font-medium">{t('verwaltung.klassen')}</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {klassen.map((k) => (
            <label key={k.klasse} className={`flex items-center justify-between gap-2 px-3 py-2 rounded border ${KLASSEN_FARBE[k.klasse]}`}>
              <span className="text-sm">{t(`klasse.${k.klasse}`)}</span>
              <span className="flex items-center gap-2 text-xs">
                {k.pflicht && <span className="font-semibold">{t('verwaltung.pflicht')}</span>}
                <input type="checkbox" checked={k.aktiv} disabled={k.pflicht} onChange={() => umschalten(k)} aria-label={t(`klasse.${k.klasse}`)} />
              </span>
            </label>
          ))}
        </div>
        <form onSubmit={musterSpeichern} className="flex flex-wrap items-end gap-2">
          <label className="block text-xs text-gray-500 flex-1 min-w-[16rem]">
            {t('verwaltung.muster')}
            <input className={`${eingabe} w-full font-mono`} value={muster} onChange={(e) => setMuster(e.target.value)} maxLength={200} />
          </label>
          <button type="submit" className="px-3 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700">
            {t('verwaltung.speichern')}
          </button>
        </form>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium">{t('verwaltung.liste')}</h4>
        <p className="text-xs text-gray-500">{t('verwaltung.listeHinweis')}</p>
        <form onSubmit={begriffAnlegen} className="flex flex-wrap items-end gap-2">
          <label className="block text-xs text-gray-500 flex-1 min-w-[12rem]">
            {t('verwaltung.begriff')}
            <input className={`${eingabe} w-full`} value={begriff} onChange={(e) => setBegriff(e.target.value)} minLength={2} maxLength={200} required />
          </label>
          <label className="block text-xs text-gray-500">
            {t('verwaltung.art')}
            <select className={`${eingabe} block`} value={art} onChange={(e) => setArt(e.target.value as BegriffArt)}>
              {ARTEN.map((a) => <option key={a} value={a}>{t(`art.${a}`)}</option>)}
            </select>
          </label>
          <button type="submit" className="px-3 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700">
            {t('verwaltung.hinzufuegen')}
          </button>
        </form>
        {liste.length === 0 ? (
          <p className="text-xs text-gray-400">{t('verwaltung.listeLeer')}</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm border border-gray-100 rounded">
            {liste.map((l) => (
              <li key={l.id} className="flex items-center justify-between px-3 py-1.5">
                <span>{l.begriff} <span className="text-xs text-gray-500">· {t(`art.${l.art}`)}</span></span>
                <button type="button" onClick={() => begriffLoeschen(l.id)} className="text-xs text-red-600 hover:underline">
                  {t('verwaltung.loeschen')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium">{t('verwaltung.probe')}</h4>
        <p className="text-xs text-gray-500">{t('verwaltung.probeHinweis')}</p>
        <textarea className={`${eingabe} w-full h-32`} value={entwurf} onChange={(e) => setEntwurf(e.target.value)} maxLength={10000} />
        <button
          type="button"
          onClick={() => setProbeText(entwurf)}
          disabled={!entwurf.trim()}
          className="px-3 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:bg-gray-300"
        >
          {t('verwaltung.probeZeigen')}
        </button>
        {probeText && <PseudonymVorschau text={probeText} />}
      </section>
    </div>
  );
}
