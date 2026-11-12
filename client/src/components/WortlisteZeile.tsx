/**
 * Aufklappzeile der Wortliste auf der Glossarseite (PLAN-wortliste.md §2.7, Phase 5, Cockpit #1833).
 *
 * Art, Wortart, Genus, Formen, „im Namen anders“ und der Schalter „an DeepL“; die Ziele je Produktgruppe; bei offenen Zeilen die
 * Vorschläge nebeneinander, die Rückfrage und das Ablehnen. Gespeichert wird über `routes/wortliste-pflege.ts`, den Verlauf mit Namen
 * schreibt die Datenbank.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { meldeFallsVorschlag } from './GlossarVorschlaege';

export interface Gruppenziel {
  produktgruppe: number;
  target_term: string;
  genus: string | null;
}

export interface Vorschlag {
  vorschlag_pruefung: string | null;
  vorschlag_glossar: string | null;
  vorschlag_markt: string | null;
  vorschlag_deepl: string | null;
  quelle: string;
  stelle: string | null;
  kopfwort: string | null;
  beispiele: string[];
  artikel_anzahl: number | null;
  rueckfrage: string | null;
  rueckfrage_von: string | null;
  rueckfrage_am: string | null;
}

export interface WortlisteFelder {
  id: string;
  source_term: string;
  target_term: string | null;
  approved: boolean;
  art: 'wort' | 'muster' | 'wendung' | 'fest';
  an_deepl: boolean;
  wortart: 'hauptwort' | 'adjektiv' | 'sonstiges' | null;
  genus: 'm' | 'f' | 'n' | null;
  formen: Record<string, string> | null;
  ziel_name: string | null;
  gruppen: Gruppenziel[];
  vorschlag: Vorschlag | null;
}

const ARTEN = ['wort', 'muster', 'wendung', 'fest'] as const;
const WORTARTEN = ['hauptwort', 'adjektiv', 'sonstiges'] as const;
const GENERA = ['m', 'f', 'n'] as const;
const QUELLEN = ['pruefung', 'glossar', 'markt', 'deepl'] as const;

/** Kennzeichen hinter dem Begriff: Art, „im Namen anders“, „nicht an DeepL“, offene Rückfrage. */
export function WortlisteKennzeichen({ entry }: { entry: WortlisteFelder }) {
  const { t } = useTranslation('glossary');
  const marken: { key: string; text: string; title: string; farbe: string }[] = [];
  if (entry.art !== 'wort') {
    marken.push({ key: 'art', text: t(`glossaries.wortliste.kennzeichen.${entry.art}`), title: t(`glossaries.wortliste.kennzeichenTitle.${entry.art}`),
      farbe: 'bg-violet-50 text-violet-700 border-violet-200' });
  }
  if (entry.ziel_name) {
    marken.push({ key: 'name', text: t('glossaries.wortliste.kennzeichen.nurName'), title: t('glossaries.wortliste.kennzeichenTitle.nurName', { wert: entry.ziel_name }),
      farbe: 'bg-sky-50 text-sky-700 border-sky-200' });
  }
  if (!entry.an_deepl) {
    marken.push({ key: 'deepl', text: t('glossaries.wortliste.kennzeichen.nichtDeepl'), title: t('glossaries.wortliste.kennzeichenTitle.nichtDeepl'),
      farbe: 'bg-gray-50 text-gray-600 border-gray-200' });
  }
  if (entry.vorschlag?.rueckfrage) {
    marken.push({ key: 'frage', text: t('glossaries.wortliste.kennzeichen.rueckfrage'), title: t('glossaries.wortliste.kennzeichenTitle.rueckfrage', { text: entry.vorschlag.rueckfrage }),
      farbe: 'bg-amber-50 text-amber-800 border-amber-300' });
  }
  if (marken.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 ml-1">
      {marken.map(m => (
        <span key={m.key} title={m.title} className={`text-[10px] leading-4 px-1 rounded border whitespace-nowrap ${m.farbe}`}>{m.text}</span>
      ))}
    </span>
  );
}

async function sende(url: string, methode: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method: methode,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) {
    // Ein Nicht-Admin speichert nur einen Vorschlag (PLAN-glossar-freigabe.md); die Seite meldet ihn.
    await meldeFallsVorschlag(res);
    return null;
  }
  const b = await res.json().catch(() => null);
  return String(b?.error ?? res.status);
}

export default function WortlisteZeile({ glossaryId, entry, istAdmin, onGeaendert }: {
  glossaryId: string;
  entry: WortlisteFelder;
  /** Ablehnen nur Admins (PLAN-glossar-freigabe.md); die Rückfrage bleibt für alle. */
  istAdmin: boolean;
  /** Nach jeder gespeicherten Änderung: Liste neu laden. */
  onGeaendert: () => void;
}) {
  const { t } = useTranslation('glossary');
  const basis = `/api/glossaries/${glossaryId}/entries/${entry.id}`;
  const [art, setArt] = useState(entry.art);
  const [wortart, setWortart] = useState<string>(entry.wortart ?? '');
  const [genus, setGenus] = useState<string>(entry.genus ?? '');
  const [formen, setFormen] = useState<Record<string, string>>(entry.formen ?? {});
  const [zielName, setZielName] = useState(entry.ziel_name ?? '');
  const [anDeepl, setAnDeepl] = useState(entry.an_deepl);
  const [neueGruppe, setNeueGruppe] = useState('');
  const [neuesGruppenziel, setNeuesGruppenziel] = useState('');
  const [gruppenEntwurf, setGruppenEntwurf] = useState<Record<number, string>>({});
  const [frage, setFrage] = useState(entry.vorschlag?.rueckfrage ?? '');
  const [anmerkung, setAnmerkung] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [gespeichert, setGespeichert] = useState(false);

  const offen = !entry.approved;
  const geaendert = art !== entry.art || (wortart || null) !== entry.wortart || (genus || null) !== entry.genus
    || JSON.stringify(formen) !== JSON.stringify(entry.formen ?? {}) || (zielName.trim() || null) !== entry.ziel_name
    || anDeepl !== entry.an_deepl;

  const lauf = async (arbeit: () => Promise<string | null>) => {
    setBusy(true);
    setFehler(null);
    setGespeichert(false);
    try {
      const f = await arbeit();
      if (f) setFehler(t('glossaries.wortliste.fehler', { error: f }));
      else {
        setGespeichert(true);
        onGeaendert();
      }
    } catch (err) {
      setFehler(t('glossaries.wortliste.fehler', { error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const speichern = () => lauf(() => sende(`${basis}/wortliste`, 'PUT', {
    art,
    wortart: wortart || null,
    genus: wortart === 'hauptwort' ? (genus || null) : null,
    formen: wortart === 'adjektiv' ? formen : null,
    ziel_name: zielName.trim() || null,
    an_deepl: art === 'muster' ? false : anDeepl,
  }));

  const gruppeSpeichern = (nr: number, ziel: string) => lauf(() => sende(`${basis}/gruppen/${nr}`, 'PUT', { target_term: ziel }));
  const gruppeEntfernen = (nr: number) => lauf(() => sende(`${basis}/gruppen/${nr}`, 'DELETE'));
  const gruppeAnlegen = () => {
    const nr = neueGruppe.trim();
    if (!/^\d{1,4}$/.test(nr) || !neuesGruppenziel.trim()) {
      setFehler(t('glossaries.wortliste.gruppeUngueltig'));
      return;
    }
    void lauf(async () => {
      const f = await sende(`${basis}/gruppen/${nr}`, 'PUT', { target_term: neuesGruppenziel.trim() });
      if (!f) { setNeueGruppe(''); setNeuesGruppenziel(''); }
      return f;
    });
  };
  const frageSpeichern = (text: string) => lauf(() => sende(`${basis}/rueckfrage`, 'PUT', { text }));
  const ablehnen = () => {
    if (!window.confirm(t('glossaries.wortliste.ablehnenConfirm', { begriff: entry.source_term }))) return;
    void lauf(() => sende(`${basis}/ablehnen`, 'POST', { anmerkung: anmerkung.trim() || null }));
  };

  const feld = 'text-xs border border-gray-300 rounded px-1.5 py-0.5 bg-white';
  const knopf = 'text-xs px-2 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50';
  const v = entry.vorschlag;

  return (
    <div className="space-y-2 text-xs text-gray-700">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-gray-500">{t('glossaries.wortliste.art')}</span>
          <select value={art} onChange={e => setArt(e.target.value as typeof art)} className={feld} disabled={busy}>
            {ARTEN.map(a => <option key={a} value={a}>{t(`glossaries.wortliste.artWerte.${a}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-gray-500">{t('glossaries.wortliste.wortart')}</span>
          <select value={wortart} onChange={e => setWortart(e.target.value)} className={feld} disabled={busy}>
            <option value="">{t('glossaries.wortliste.leer')}</option>
            {WORTARTEN.map(w => <option key={w} value={w}>{t(`glossaries.wortliste.wortartWerte.${w}`)}</option>)}
          </select>
        </label>
        {wortart === 'hauptwort' && (
          <label className="flex flex-col gap-0.5">
            <span className="text-gray-500">{t('glossaries.wortliste.genus')}</span>
            <select value={genus} onChange={e => setGenus(e.target.value)} className={feld} disabled={busy}>
              <option value="">{t('glossaries.wortliste.leer')}</option>
              {GENERA.map(g => <option key={g} value={g}>{t(`glossaries.wortliste.genusWerte.${g}`)}</option>)}
            </select>
          </label>
        )}
        {wortart === 'adjektiv' && (
          <div className="flex flex-col gap-0.5">
            <span className="text-gray-500">{t('glossaries.wortliste.formen')}</span>
            <div className="flex gap-1">
              {GENERA.map(g => (
                <input key={g} type="text" value={formen[g] ?? ''} placeholder={g} aria-label={`${t('glossaries.wortliste.formen')} ${g}`}
                  onChange={e => setFormen(prev => ({ ...prev, [g]: e.target.value }))} className={`${feld} w-24`} disabled={busy} />
              ))}
            </div>
          </div>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="text-gray-500">{t('glossaries.wortliste.zielName')}</span>
          <input type="text" value={zielName} onChange={e => setZielName(e.target.value)} placeholder={t('glossaries.wortliste.zielNamePlaceholder')}
            className={`${feld} w-48`} disabled={busy} />
        </label>
        <label className="inline-flex items-center gap-1 pb-0.5" title={art === 'muster' ? t('glossaries.wortliste.anDeeplMuster') : t('glossaries.wortliste.anDeeplTitle')}>
          <input type="checkbox" checked={art === 'muster' ? false : anDeepl} disabled={busy || art === 'muster'} onChange={e => setAnDeepl(e.target.checked)} />
          {t('glossaries.wortliste.anDeepl')}
        </label>
        <button type="button" onClick={speichern} disabled={busy || !geaendert}
          className="text-xs px-2.5 py-0.5 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:bg-primary-300">
          {t('glossaries.wortliste.speichern')}
        </button>
        {gespeichert && !geaendert && <span className="text-green-700">{t('glossaries.wortliste.gespeichert')}</span>}
      </div>

      <div>
        <div className="text-gray-500 mb-0.5">{t('glossaries.wortliste.gruppen')}</div>
        <div className="flex flex-wrap items-center gap-2">
          {entry.gruppen.length === 0 && <span className="text-gray-400">{t('glossaries.wortliste.keineGruppen')}</span>}
          {entry.gruppen.map(g => {
            const entwurf = gruppenEntwurf[g.produktgruppe] ?? g.target_term;
            return (
              <span key={g.produktgruppe} className="inline-flex items-center gap-1 border border-gray-200 rounded px-1 py-0.5 bg-white">
                <span className="text-gray-500">{t('glossaries.wortliste.gruppeNr', { nr: g.produktgruppe })}</span>
                <input type="text" value={entwurf} className={`${feld} w-32`} disabled={busy}
                  aria-label={t('glossaries.wortliste.gruppeNr', { nr: g.produktgruppe })}
                  onChange={e => setGruppenEntwurf(prev => ({ ...prev, [g.produktgruppe]: e.target.value }))} />
                {entwurf.trim() !== g.target_term && entwurf.trim() !== '' && (
                  <button type="button" className={knopf} disabled={busy} onClick={() => gruppeSpeichern(g.produktgruppe, entwurf.trim())}>
                    {t('glossaries.wortliste.speichern')}
                  </button>
                )}
                <button type="button" className="text-gray-400 hover:text-red-500 px-0.5" disabled={busy}
                  title={t('glossaries.wortliste.gruppeEntfernen')} onClick={() => gruppeEntfernen(g.produktgruppe)}>
                  &times;
                </button>
              </span>
            );
          })}
          <span className="inline-flex items-center gap-1">
            <input type="text" inputMode="numeric" value={neueGruppe} onChange={e => setNeueGruppe(e.target.value)}
              placeholder={t('glossaries.wortliste.gruppeNrPlaceholder')} className={`${feld} w-16`} disabled={busy}
              aria-label={t('glossaries.wortliste.gruppeNrPlaceholder')} />
            <input type="text" value={neuesGruppenziel} onChange={e => setNeuesGruppenziel(e.target.value)}
              placeholder={t('glossaries.wortliste.gruppeZiel')} className={`${feld} w-32`} disabled={busy}
              aria-label={t('glossaries.wortliste.gruppeZiel')} />
            <button type="button" className={knopf} disabled={busy || !neueGruppe.trim() || !neuesGruppenziel.trim()} onClick={gruppeAnlegen}>
              {t('glossaries.wortliste.gruppeNeu')}
            </button>
          </span>
        </div>
      </div>

      {/* Eine freigegebene Zeile trägt eine Rückfrage nur aus dem Einlesen (Widerspruch zur Prüftabelle); dort lässt sie sich lösen. */}
      {(offen || v?.rueckfrage) && (
        <div className="border-t border-amber-200 pt-2 space-y-2">
          {v && (
            <div className="flex flex-wrap gap-3">
              {QUELLEN.map(q => {
                const wert = v[`vorschlag_${q}` as keyof Vorschlag] as string | null;
                if (!wert) return null;
                return (
                  <div key={q} className={`px-1.5 py-0.5 rounded border ${wert === entry.target_term ? 'border-primary-300 bg-primary-50' : 'border-gray-200 bg-white'}`}>
                    <span className="text-gray-500">{t(`glossaries.wortliste.quelle.${q}`)}:</span> <span className="font-medium">{wert}</span>
                  </div>
                );
              })}
              {v.artikel_anzahl !== null && <span className="text-gray-500 self-center">{t('glossaries.wortliste.artikel', { anzahl: v.artikel_anzahl })}</span>}
              {v.beispiele.length > 0 && (
                <span className="text-gray-500 self-center">{t('glossaries.wortliste.beispiele')}: {v.beispiele.join(' · ')}</span>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input type="text" value={frage} onChange={e => setFrage(e.target.value)} placeholder={t('glossaries.wortliste.rueckfragePlaceholder')}
              aria-label={t('glossaries.wortliste.rueckfrage')} className={`${feld} w-72`} disabled={busy || !offen} />
            {offen && (
              <button type="button" className={knopf} disabled={busy || !frage.trim() || frage.trim() === (v?.rueckfrage ?? '')}
                onClick={() => frageSpeichern(frage.trim())}>
                {v?.rueckfrage ? t('glossaries.wortliste.rueckfrageAendern') : t('glossaries.wortliste.rueckfrageStellen')}
              </button>
            )}
            {v?.rueckfrage && (
              <>
                <button type="button" className={knopf} disabled={busy} onClick={() => { setFrage(''); void frageSpeichern(''); }}>
                  {t('glossaries.wortliste.rueckfrageLoesen')}
                </button>
                {v.rueckfrage_von && <span className="text-gray-500">{t('glossaries.wortliste.rueckfrageVon', { von: v.rueckfrage_von })}</span>}
              </>
            )}
            {offen && istAdmin && <span className="ml-auto inline-flex items-center gap-1">
              <input type="text" value={anmerkung} onChange={e => setAnmerkung(e.target.value)} placeholder={t('glossaries.wortliste.anmerkungPlaceholder')}
                aria-label={t('glossaries.wortliste.anmerkungPlaceholder')} className={`${feld} w-48`} disabled={busy} />
              <button type="button" disabled={busy} onClick={ablehnen}
                className="text-xs px-2 py-0.5 rounded border border-red-300 text-red-700 bg-white hover:bg-red-50 disabled:opacity-50">
                {t('glossaries.wortliste.ablehnen')}
              </button>
            </span>}
          </div>
        </div>
      )}
      {fehler && <p className="text-red-700" role="alert">{fehler}</p>}
    </div>
  );
}
