/**
 * Verwaltung „Stilprofile“ (Admin, Textwerkstatt Phase 5, Plan `PLAN-textwerkstatt.md` §4 Phase 5, #1841).
 *
 * Ein Profil ist eine Stilbeschreibung und ein paar Beispielsätze; im Schritt „Optimieren“ gehen beide als Teil der Anweisung an
 * das Modell. Einlesen: Adresse eingeben (die Seite holt der **Server**, der Browser bekommt nur Text ohne Adressen) oder einen
 * Text einfügen → die KI leitet eine Beschreibung ab (Vorgabe lokal; in die Cloud nur über die Vorschau, denn ein eingefügter
 * Text kann intern sein) → bearbeiten → speichern. Jede inhaltliche Änderung ist eine neue Fassung; der Verlauf zeigt alle.
 *
 * Ob ein Profil in die Cloud darf, entscheidet der Server beim Lauf (`STIL_MIT_WERTEN`); hier steht derselbe Befund vorab.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { currentLocale } from '../../i18n';
import { kiFetch, useKiStatus } from '../../hooks/useKiStatus';

interface CloudBefund { ok: boolean; klassen: Record<string, number>; rest: boolean }

interface Profil {
  id: string;
  name: string;
  channel_code: string | null;
  beschreibung: string;
  beispiele: string;
  quelle_art: 'hand' | 'url' | 'text';
  quelle_url: string | null;
  quelle_zeichen: number | null;
  fassung: number;
  aktiv: boolean;
  reihenfolge: number;
  geaendert_am?: string | null;
  cloud?: CloudBefund | null;
  /** Die Fassung, die ein Admin für die Cloud freigegeben hat; nur sie geht hinaus. */
  cloud_freigabe_fassung?: number | null;
  cloudFreigegeben?: boolean;
}

interface VerlaufZeile { fassung: number; aktion: 'angelegt' | 'geaendert'; felder: Partial<Profil>; von: string | null; am: string }
interface Seite { url: string; titel: string; text: string; zeichenGesamt: number; gekuerzt: boolean }
interface Ableitung {
  beschreibung: string; beispiele: string; erkannt: boolean; abgeschnitten: boolean; cloud: CloudBefund | null;
  weg: { id: string; art: 'lokal' | 'cloud'; modell: string }; ki: { dauerMs: number; kostenUsd: number | null };
}
interface VorschauKurz { vorschauId: string; ausgehend: string; restpruefung: { ok: boolean } }

const LEER: Profil = {
  id: '', name: '', channel_code: null, beschreibung: '', beispiele: '', quelle_art: 'hand', quelle_url: null, quelle_zeichen: null,
  fassung: 1, aktiv: false, reihenfolge: 0,
};
const REFERENZ_MAX = 8000;

export default function Stilprofile() {
  const { t } = useTranslation('textwerkstatt');
  const { t: tp } = useTranslation('pseudonym');
  const { status: kiStatus } = useKiStatus();
  const [profile, setProfile] = useState<Profil[] | null>(null);
  const [channels, setChannels] = useState<{ code: string; name: string }[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [form, setForm] = useState<Profil | null>(null);
  const [neu, setNeu] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [verlauf, setVerlauf] = useState<{ id: string; zeilen: VerlaufZeile[] } | null>(null);
  // Freigegeben wird nur aus einer Ansicht mit dem vollen Text der Fassung: Die Listenzeile kürzt die Beschreibung und zeigt die
  // Beispiele nicht, und genau die gehen an die Cloud (Nachprüfung M4-Rest, 11.11.2026).
  const [freigabeAnsicht, setFreigabeAnsicht] = useState<Profil | null>(null);

  // Einlesen
  const [quelleArt, setQuelleArt] = useState<'url' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [seite, setSeite] = useState<Seite | null>(null);
  const [referenz, setReferenz] = useState('');
  const [holt, setHolt] = useState(false);
  const [wegId, setWegId] = useState('');
  const [vorschau, setVorschau] = useState<VorschauKurz | null>(null);
  const [leitetAb, setLeitetAb] = useState(false);
  const [ableitung, setAbleitung] = useState<Ableitung | null>(null);
  const [einleseFehler, setEinleseFehler] = useState<string | null>(null);

  const laden = useCallback(async () => {
    const r = await kiFetch<Profil[]>('/stilprofile/alle');
    if (r.ok) { setProfile(r.body); setFehler(null); } else { setFehler(r.body.error || `HTTP ${r.status}`); }
  }, []);
  useEffect(() => { laden(); }, [laden]);
  useEffect(() => {
    fetch('/api/glossaries/channels', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setChannels(Array.isArray(d) ? d : []))
      .catch(() => setChannels([]));
  }, []);

  const wege = kiStatus?.wege ?? [];
  // Vorgabe lokal, wie im Schritt „Optimieren“: Ein vergessener Schalter darf nicht in die Cloud führen.
  useEffect(() => {
    if (wegId && wege.some((w) => w.id === wegId)) return;
    const lokal = wege.find((w) => w.art === 'lokal' && w.verfuegbar) ?? wege.find((w) => w.art === 'lokal');
    if (lokal) setWegId(lokal.id);
  }, [wege, wegId]);
  const weg = wege.find((w) => w.id === wegId) ?? null;
  const istCloud = weg?.art === 'cloud';

  const einlesenZuruecksetzen = () => {
    setSeite(null); setReferenz(''); setUrl(''); setVorschau(null); setAbleitung(null); setEinleseFehler(null);
  };
  const oeffnen = (p: Profil, istNeu: boolean) => {
    setForm({ ...p }); setNeu(istNeu); setVerlauf(null); einlesenZuruecksetzen();
  };
  const feld = <K extends keyof Profil>(k: K, v: Profil[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const aendereReferenz = (v: string) => { setReferenz(v); setVorschau(null); setAbleitung(null); };

  const seiteHolen = async () => {
    setHolt(true); setEinleseFehler(null); setVorschau(null); setAbleitung(null);
    const r = await kiFetch<Seite>('/stilprofile/quelle', { method: 'POST', body: JSON.stringify({ url }) });
    setHolt(false);
    if (!r.ok) { setEinleseFehler(fehlerText(r.body)); return; }
    setSeite(r.body);
    setReferenz(r.body.text);
  };

  const vorschauErstellen = async () => {
    setEinleseFehler(null);
    const r = await kiFetch<VorschauKurz>('/vorschau', { method: 'POST', body: JSON.stringify({ text: referenz }) });
    if (!r.ok) { setEinleseFehler(fehlerText(r.body)); return; }
    setVorschau(r.body);
  };

  const ableiten = async () => {
    if (!weg) return;
    setLeitetAb(true); setEinleseFehler(null); setAbleitung(null);
    const body = istCloud ? { wegId: weg.id, vorschauId: vorschau?.vorschauId } : { wegId: weg.id, text: referenz };
    const r = await kiFetch<Ableitung>('/stilprofile/ableiten', { method: 'POST', body: JSON.stringify(body) });
    setLeitetAb(false);
    if (!r.ok) { setEinleseFehler(fehlerText(r.body)); return; }
    setAbleitung(r.body);
    // Übernommen wird in das Formular; gespeichert erst, wenn der Admin speichert.
    setForm((f) => (f ? {
      ...f,
      beschreibung: r.body.beschreibung,
      beispiele: r.body.beispiele,
      quelle_art: quelleArt === 'url' && seite ? 'url' : 'text',
      quelle_url: quelleArt === 'url' && seite ? seite.url : null,
      quelle_zeichen: referenz.length,
    } : f));
  };

  const fehlerText = (b: { error?: string; code?: string }) => {
    if (b.code === 'EINGABE' && b.error) return b.error;
    // Codes aus dem Einlesen, dem Optimieren, dem KI-Weg und der Pseudonymisierung; die Texte stehen je Namespace.
    if (b.code) {
      for (const k of [`textwerkstatt:stil.fehler.${b.code}`, `textwerkstatt:optimieren.fehler.${b.code}`, `ki:fehler.${b.code}`, `pseudonym:fehler.${b.code}`]) {
        if (i18n.exists(k)) return i18n.t(k);
      }
    }
    return b.error || t('stil.fehler.allgemein');
  };

  const speichern = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSpeichert(true);
    const { id, fassung, geaendert_am: _g, cloud: _c, cloud_freigabe_fassung: _cf, cloudFreigegeben: _cg, ...felder } = form;
    // Beim Ändern geht die Fassung mit, auf der der Admin gearbeitet hat: Hat inzwischen jemand anderes gespeichert, kommt 409
    // statt eines stillen Überschreibens (Review N4).
    const r = neu
      ? await kiFetch<Profil>('/stilprofile', { method: 'POST', body: JSON.stringify({ id, ...felder }) })
      : await kiFetch<Profil>(`/stilprofile/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ...felder, fassung }) });
    setSpeichert(false);
    if (!r.ok) { setFehler(fehlerText(r.body)); return; }
    setForm(null); setNeu(false); einlesenZuruecksetzen();
    laden();
  };

  /** Genau die angezeigte Fassung freigeben oder die Freigabe entziehen. */
  const freigabe = async (p: Profil, freigeben: boolean) => {
    const r = await kiFetch<Profil>(`/stilprofile/${encodeURIComponent(p.id)}/cloud`, { method: 'POST', body: JSON.stringify({ freigeben, fassung: p.fassung }) });
    if (!r.ok) { setFehler(fehlerText(r.body)); return; }
    setFehler(null);
    setFreigabeAnsicht(null);
    laden();
  };

  const verlaufZeigen = async (id: string) => {
    const r = await kiFetch<VerlaufZeile[]>(`/stilprofile/${encodeURIComponent(id)}/verlauf`);
    if (r.ok) setVerlauf({ id, zeilen: r.body }); else setFehler(r.body.error || `HTTP ${r.status}`);
  };

  const befundText = (b: CloudBefund | null | undefined) => {
    if (!b) return t('stil.cloudUngeprueft');
    if (b.ok) return t('stil.cloudFrei');
    const liste = Object.entries(b.klassen).map(([k, n]) => `${tp(`klasse.${k}`, { defaultValue: k })} ${n}`);
    if (b.rest) liste.push(t('stil.cloudRest'));
    return t('stil.cloudGesperrt', { liste: liste.join(', ') });
  };
  const zeit = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString(currentLocale(), { dateStyle: 'short', timeStyle: 'short' }) : '';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{t('stil.titel')}</h3>
          <p className="text-xs text-gray-500 mt-1 max-w-3xl">{t('stil.hinweis')}</p>
          <p className="text-xs text-gray-500 mt-1 max-w-3xl">{t('stil.freigabe.hinweis')}</p>
        </div>
        <button type="button" onClick={() => oeffnen({ ...LEER }, true)} className="text-xs text-primary-700 hover:underline whitespace-nowrap">
          {t('stil.neu')}
        </button>
      </div>

      {fehler && <div role="alert" className="text-sm text-red-600 bg-red-50 p-2 rounded">{fehler}</div>}

      {form && (
        <form onSubmit={speichern} className="border border-gray-200 rounded-md p-4 space-y-3 bg-gray-50">
          <h4 className="text-sm font-medium">
            {neu ? t('stil.formular.titelNeu') : t('stil.formular.titel', { name: form.name, fassung: form.fassung })}
          </h4>

          {/* Einlesen: Seite oder Text → Beschreibung ableiten → unten bearbeiten */}
          <fieldset className="border border-gray-200 rounded-md p-3 bg-white space-y-2">
            <legend className="text-xs font-medium text-gray-600 px-1">{t('stil.einlesen.titel')}</legend>
            <div className="inline-flex rounded-[5px] border border-gray-300 bg-white p-0.5 gap-0.5" role="radiogroup" aria-label={t('stil.einlesen.titel')}>
              {(['url', 'text'] as const).map((a) => (
                <button key={a} type="button" role="radio" aria-checked={quelleArt === a}
                  onClick={() => { setQuelleArt(a); einlesenZuruecksetzen(); }}
                  className={`text-xs px-3 py-1 rounded-[4px] ${quelleArt === a ? 'bg-primary-600 text-white font-semibold' : 'text-gray-700 hover:bg-gray-100'}`}>
                  {t(`stil.einlesen.${a}`)}
                </button>
              ))}
            </div>
            {quelleArt === 'url' && (
              <div className="flex gap-2">
                <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://"
                  aria-label={t('stil.einlesen.url')} className="flex-1 text-sm border border-gray-300 rounded px-2 py-1" />
                <button type="button" onClick={seiteHolen} disabled={holt || !url.trim()}
                  className="px-3 py-1 text-xs font-semibold border border-primary-600 text-primary-700 rounded hover:bg-primary-50 disabled:opacity-50">
                  {holt ? t('stil.einlesen.holt') : t('stil.einlesen.holen')}
                </button>
              </div>
            )}
            {quelleArt === 'url' && <p className="text-xs text-gray-400">{t('stil.einlesen.serverHinweis')}</p>}
            {(quelleArt === 'text' || seite) && (
              <label className="block text-xs text-gray-500">
                {seite ? t('stil.einlesen.seitenText', { titel: seite.titel || seite.url }) : t('stil.einlesen.textEinfuegen')}
                <textarea value={referenz} onChange={(e) => aendereReferenz(e.target.value)} rows={6} maxLength={REFERENZ_MAX}
                  className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
                <span className="text-gray-400">
                  {t('stil.einlesen.zeichen', { n: referenz.length.toLocaleString(currentLocale()), max: REFERENZ_MAX.toLocaleString(currentLocale()) })}
                  {seite?.gekuerzt && ` · ${t('stil.einlesen.gekuerzt', { gesamt: seite.zeichenGesamt.toLocaleString(currentLocale()) })}`}
                </span>
              </label>
            )}
            {referenz.trim().length >= 100 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">{t('optimieren.weg')}</span>
                <div className="inline-flex rounded-[5px] border border-gray-300 bg-white p-0.5 gap-0.5" role="radiogroup" aria-label={t('optimieren.weg')}>
                  {wege.map((w) => (
                    <button key={w.id} type="button" role="radio" aria-checked={wegId === w.id} disabled={!w.verfuegbar}
                      onClick={() => { setWegId(w.id); setVorschau(null); }}
                      className={`text-xs px-3 py-1 rounded-[4px] disabled:text-gray-300 ${wegId === w.id ? 'bg-primary-600 text-white font-semibold' : 'text-gray-700 hover:bg-gray-100'}`}>
                      {w.name}
                    </button>
                  ))}
                </div>
                {istCloud && !vorschau && (
                  <button type="button" onClick={vorschauErstellen} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100">
                    {t('stil.einlesen.vorschau')}
                  </button>
                )}
                <button type="button" onClick={ableiten}
                  disabled={leitetAb || !weg || (istCloud && (!vorschau || !vorschau.restpruefung.ok))}
                  className="px-3 py-1 text-xs font-semibold bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50">
                  {leitetAb ? t('stil.einlesen.leitetAb') : t('stil.einlesen.ableiten')}
                </button>
              </div>
            )}
            {istCloud && referenz.trim().length >= 100 && <p className="text-xs text-gray-500">{t('optimieren.cloudHinweis')}</p>}
            {vorschau && (
              <div className="text-xs">
                <p className="text-gray-500 mb-1">{t('stil.einlesen.soSiehtEsDasModell')}</p>
                <pre className="whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded p-2 max-h-40 overflow-y-auto font-sans">{vorschau.ausgehend}</pre>
                {!vorschau.restpruefung.ok && <p className="text-red-700 mt-1">{t('optimieren.cloudRest')}</p>}
              </div>
            )}
            {einleseFehler && <div role="alert" className="text-xs text-red-700 bg-red-50 p-2 rounded">{einleseFehler}</div>}
            {ableitung && (
              <div role="status" className={`text-xs p-2 rounded border ${ableitung.cloud?.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
                <p>{t('stil.einlesen.abgeleitet', { sek: (ableitung.ki.dauerMs / 1000).toLocaleString(currentLocale(), { maximumFractionDigits: 1 }) })}</p>
                {!ableitung.erkannt && <p>{t('stil.einlesen.ohneMarken')}</p>}
                {ableitung.abgeschnitten && <p>{t('stil.einlesen.abgeschnitten')}</p>}
                <p>{befundText(ableitung.cloud)}</p>
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
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
              {t('stil.formular.channel')}
              <select value={form.channel_code ?? ''} onChange={(e) => feld('channel_code', e.target.value || null)}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1">
                <option value="">{t('stil.formular.ohneChannel')}</option>
                {channels.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label className="block text-xs text-gray-500">
              {t('arten.formular.reihenfolge')}
              <input type="number" min={0} max={1000} value={form.reihenfolge} onChange={(e) => feld('reihenfolge', Number(e.target.value))}
                className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
            </label>
          </div>
          <label className="block text-xs text-gray-500">
            {t('stil.formular.beschreibung')}
            <textarea value={form.beschreibung} onChange={(e) => feld('beschreibung', e.target.value)} maxLength={3000} rows={7}
              className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
          </label>
          <label className="block text-xs text-gray-500">
            {t('stil.formular.beispiele')}
            <textarea value={form.beispiele} onChange={(e) => feld('beispiele', e.target.value)} maxLength={2000} rows={4}
              className="mt-1 w-full text-sm border border-gray-300 rounded px-2 py-1" />
          </label>
          <p className="text-xs text-gray-500">
            {t(`stil.quelle.${form.quelle_art}`, { url: form.quelle_url ?? '', n: (form.quelle_zeichen ?? 0).toLocaleString(currentLocale()) })}
          </p>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.aktiv} onChange={(e) => feld('aktiv', e.target.checked)} className="accent-primary-600" />
            {t('arten.formular.aktiv')}
            <span className="text-xs text-gray-400">{t('stil.formular.aktivHinweis')}</span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setForm(null); setNeu(false); einlesenZuruecksetzen(); }} className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
              {t('arten.formular.abbrechen')}
            </button>
            <button type="submit" disabled={speichert} className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-50">
              {t('arten.formular.speichern')}
            </button>
          </div>
        </form>
      )}

      {freigabeAnsicht && (
        <div role="dialog" aria-label={t('stil.freigabe.ansichtTitel', { name: freigabeAnsicht.name, n: freigabeAnsicht.fassung })}
          className="border border-primary-300 rounded-md p-3 space-y-2 bg-primary-50/40">
          <h4 className="text-sm font-medium">{t('stil.freigabe.ansichtTitel', { name: freigabeAnsicht.name, n: freigabeAnsicht.fassung })}</h4>
          <p className="text-xs text-gray-600">{t('stil.freigabe.ansichtHinweis')}</p>
          <div className="text-xs text-gray-500">{t('stil.formular.beschreibung')}</div>
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 bg-white border border-gray-200 rounded p-2">{freigabeAnsicht.beschreibung}</pre>
          <div className="text-xs text-gray-500">{t('stil.formular.beispiele')}</div>
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 bg-white border border-gray-200 rounded p-2">{freigabeAnsicht.beispiele || '—'}</pre>
          <p className="text-xs text-gray-600">{befundText(freigabeAnsicht.cloud)}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setFreigabeAnsicht(null)} className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
              {t('arten.formular.abbrechen')}
            </button>
            <button type="button" onClick={() => freigabe(freigabeAnsicht, true)} disabled={!freigabeAnsicht.cloud?.ok}
              className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-50">
              {t('stil.freigabe.bestaetigen', { n: freigabeAnsicht.fassung })}
            </button>
          </div>
        </div>
      )}

      {verlauf && (
        <div className="border border-gray-200 rounded-md p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">{t('stil.verlauf.titel', { id: verlauf.id })}</h4>
            <button type="button" onClick={() => setVerlauf(null)} className="text-xs text-gray-500 hover:underline">{t('stil.verlauf.schliessen')}</button>
          </div>
          {verlauf.zeilen.length === 0 && <p className="text-xs text-gray-400">{t('stil.verlauf.leer')}</p>}
          {verlauf.zeilen.map((z, i) => (
            <details key={i} className="text-xs border-b border-gray-100 pb-1">
              <summary className="cursor-pointer">
                {t('stil.verlauf.zeile', { fassung: z.fassung, aktion: t(`stil.verlauf.${z.aktion}`), am: zeit(z.am), von: z.von ?? '—' })}
              </summary>
              <pre className="whitespace-pre-wrap font-sans text-gray-600 mt-1">{z.felder.beschreibung || '—'}</pre>
              {z.felder.beispiele && <pre className="whitespace-pre-wrap font-sans text-gray-500 mt-1 italic">{z.felder.beispiele}</pre>}
            </details>
          ))}
        </div>
      )}

      {profile && profile.length === 0 && <p className="py-6 text-center text-gray-400 text-sm">{t('stil.leer')}</p>}
      {profile && profile.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-4">{t('stil.spalteProfil')}</th>
              <th className="py-2 pr-4">{t('stil.spalteStand')}</th>
              <th className="py-2">{t('arten.spalteAktionen')}</th>
            </tr>
          </thead>
          <tbody>
            {profile.map((p) => (
              <tr key={p.id} className={`border-b border-gray-50 align-top ${p.aktiv ? '' : 'opacity-60'}`}>
                <td className="py-2 pr-4">
                  <div className="font-medium">
                    {p.name} <span className="font-mono text-xs text-gray-400">{p.id}</span>
                    {p.channel_code && <span className="ml-2 text-xs text-gray-500">{t('stil.channel', { code: p.channel_code })}</span>}
                  </div>
                  {!p.aktiv && <div className="text-xs text-gray-500">{p.beschreibung.trim() ? t('arten.aus') : t('stil.leerProfil')}</div>}
                  {p.beschreibung && <div className="text-xs text-gray-500 mt-0.5 max-w-xl whitespace-pre-line line-clamp-4">{p.beschreibung}</div>}
                </td>
                <td className="py-2 pr-4 text-xs text-gray-600">
                  <div>{t('stil.fassung', { n: p.fassung })} · {zeit(p.geaendert_am)}</div>
                  <div>{t(`stil.quelle.${p.quelle_art}`, { url: p.quelle_url ?? '', n: (p.quelle_zeichen ?? 0).toLocaleString(currentLocale()) })}</div>
                  <div className={p.cloud?.ok ? 'text-gray-600' : 'text-amber-700'}>{befundText(p.cloud)}</div>
                  <div className={p.cloudFreigegeben ? 'text-green-700' : 'text-gray-500'}>
                    {p.cloudFreigegeben
                      ? t('stil.freigabe.frei', { n: p.fassung })
                      : p.cloud_freigabe_fassung
                        ? t('stil.freigabe.alt', { alt: p.cloud_freigabe_fassung, n: p.fassung })
                        : t('stil.freigabe.nicht')}
                  </div>
                </td>
                <td className="py-2 space-x-3 whitespace-nowrap">
                  <button type="button" onClick={() => oeffnen(p, false)} className="text-xs text-primary-700 hover:underline">{t('arten.bearbeiten')}</button>
                  <button type="button" onClick={() => verlaufZeigen(p.id)} className="text-xs text-primary-700 hover:underline">{t('stil.fassungen')}</button>
                  {p.cloudFreigegeben ? (
                    <button type="button" onClick={() => freigabe(p, false)} className="text-xs text-gray-600 hover:underline">{t('stil.freigabe.entziehen')}</button>
                  ) : (
                    <button type="button" onClick={() => { setFreigabeAnsicht(p); setVerlauf(null); }} disabled={!p.cloud?.ok || !p.beschreibung.trim()}
                      title={t('stil.freigabe.hinweis')} className="text-xs text-primary-700 hover:underline disabled:text-gray-300 disabled:no-underline">
                      {t('stil.freigabe.freigeben', { n: p.fassung })}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
