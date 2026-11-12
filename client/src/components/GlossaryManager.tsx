import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import PageHeader from './PageHeader';
import HouseTermManager from './HouseTermManager';
import WortlisteZeile, { WortlisteKennzeichen, type WortlisteFelder } from './WortlisteZeile';
import { currentLocale } from '../i18n';
import { useAuth } from '../hooks/useAuth';
import GlossarVorschlaege, { meldeFallsVorschlag, VORSCHLAG_EREIGNIS } from './GlossarVorschlaege';
import { einstellungen, orgName } from '../einstellungen';

interface Glossary {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  version: number;
  synced_version: number;
  deepl_glossary_id: string | null;
  entry_count: string;
  /** Zeilen ohne Übersetzung. Sie wirken nirgends, bis ein Mensch sie bestätigt. */
  zu_pflegen: string;
  /** Zeilen mit Prüfhinweis, ohne die mit ausschließlich mechanischen Schreibungs-Hinweisen. */
  hinweise: string;
  /** Zeilen, die nur mechanische Schreibungs-Hinweise tragen. */
  hinweise_schreibung: string;
  /** Zeilen, die gegenüber DeepL ohne Glossar nichts ändern. Zählt nicht als Hinweis. */
  unnoetig: string;
  /** Davon: Der ganze Begriff ist in allen Sprachen entbehrlich. */
  unnoetig_ueberall: string;
  created_at: string;
  updated_at: string;
}

const LAST_GLOSSARY_KEY = 'tt-glossary';

interface GlossaryEntry {
  id: string;
  glossary_id: string;
  source_term: string;
  /** null = noch ohne Übersetzung: Begriff aus dem Befüllen eines neuen Glossars. Die Zeile wirkt nicht. */
  target_term: string | null;
  context: string | null;
  approved: boolean;
  source: string;
  /** Channel-Overrides als Objekt: { SHOPA: 'X', SHOPB: 'Y', ... } */
  channels: Record<string, string>;
  hinweise?: Hinweis[];
  // Wortliste (PLAN-wortliste.md §2.1, §2.7): Art, Formen, Gruppenziele, Herkunft und Rückfrage einer offenen Zeile.
  art: WortlisteFelder['art'];
  an_deepl: boolean;
  wortart: WortlisteFelder['wortart'];
  genus: WortlisteFelder['genus'];
  formen: Record<string, string> | null;
  ziel_name: string | null;
  gruppen: WortlisteFelder['gruppen'];
  vorschlag: WortlisteFelder['vorschlag'];
  /** Offene Vorschläge von Nicht-Admins zu dieser Zeile (PLAN-glossar-freigabe.md). */
  offene_vorschlaege?: number;
  /** Wer die Zeile über die Anwendung angelegt hat; leer bei Seed-Einträgen (Migration 049). */
  angelegt_von?: string | null;
}

/** Prüfhinweis: wirkt nie von selbst, ein Vorschlag wird nur per Klick übernommen. */
interface Hinweis {
  id: string;
  kategorie: string;
  gewissheit: string;
  vorschlag: string | null;
  grund: string;
  quelle: string;
}

interface HinweisFacette {
  kategorie: string | null;
  gewissheit: string | null;
  zeilen: number;
  ohne_schreibflut: number;
}

const HINWEIS_KATEGORIEN = [
  'falsch', 'sprachlich', 'schreibung', 'zeichen', 'satz',
  'wert', 'mehrdeutig', 'dublette', 'eigenname', 'unuebersetzt',
  'unnoetig_ueberall', 'unnoetig_hier',
] as const;
const HINWEIS_GEWISSHEITEN = ['hoch', 'mittel', 'niedrig'] as const;
/** Voreinstellung des Filters: ohne die mechanischen Schreibungs-Hinweise, die sonst die Liste füllen. */
const OHNE_SCHREIBFLUT = 'ohne_schreibung';
/** Filterwert: beide Stufen von „unnötig“. */
const UNNOETIG = 'unnoetig';
const istSchreibflut = (h: Hinweis) => h.kategorie === 'schreibung' && h.quelle === 'mechanisch';
const istUnnoetig = (h: Hinweis) => h.kategorie === 'unnoetig_ueberall' || h.kategorie === 'unnoetig_hier';
const istNebensache = (h: Hinweis) => istSchreibflut(h) || istUnnoetig(h);
/** Feldnamen im Verlauf, die die Trigger schreiben (Migration 037, 039); Werte, die die Datenbank als deutschen Text ablegt. */
const HISTORY_FELDER = new Set(['freigabe', 'an_deepl', 'art', 'wortart', 'genus', 'formen', 'ziel_name', 'kontext', 'kategorie', 'rueckfrage', 'merkmal', 'vorschlag']);
const HISTORY_WERTE = new Set(['offen', 'freigegeben', 'ja', 'nein', 'wort', 'muster', 'wendung', 'fest']);
/** Was „Seite freigeben“ mitnimmt: offen, mit Übersetzung, ohne offene Rückfrage. */
const freigebbar = (e: GlossaryEntry) => !e.approved && e.target_term !== null && !e.vorschlag?.rueckfrage;

interface Channel {
  code: string;
  name: string;
  sort_order: number;
}

interface HistoryItem {
  id: string;
  source_term: string;
  field: string;
  action: 'created' | 'updated' | 'deleted' | 'vorschlag' | 'freigabe' | 'verworfen';
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

/**
 * Rückfrage vor dem × und vor dem Umbenennen. Beides gilt nur in diesem Glossar, und alles, was sie zeigt, steht schon in
 * der Liste. Den Konflikt beim Umbenennen meldet erst der Server.
 */
interface Rueckfrage {
  entryId: string;
  begriff: string;
  neu: string | null;
  target_term: string | null;
  channels: Record<string, string>;
  konflikte: { target_term_alt: string; target_term_neu: string }[];
}

/**
 * Zelle einer Zeile ohne Übersetzung. Ein Klick öffnet das Feld, wahlweise mit einem Vorschlag von DeepL.
 * Der Entwurf bleibt hier, bis jemand „Bestätigen" drückt: Anders als die übrigen Zellen speichert sie nicht
 * beim Verlassen, sonst würde ein DeepL-Vorschlag ohne Bestätigung zur Übersetzung (Entscheid Thomas 04.11.2026).
 */
function LeereZelle({ glossaryId, entryId, begriff, onBestaetigt }: {
  glossaryId: string;
  entryId: string;
  begriff: string;
  onBestaetigt: () => void;
}) {
  const { t } = useTranslation('glossary');
  const [entwurf, setEntwurf] = useState('');
  const [ausDeepL, setAusDeepL] = useState(false);
  const [fragt, setFragt] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [hinweis, setHinweis] = useState<string | null>(null);
  const [offen, setOffen] = useState(false);

  const schliessen = () => {
    setOffen(false);
    setEntwurf('');
    setAusDeepL(false);
    setHinweis(null);
  };

  const fehlertext = async (res: Response): Promise<string> => {
    const body = await res.json().catch(() => null);
    return t('glossaries.pflege.fehler', { error: body?.error ?? res.status });
  };

  const holeVorschlag = async () => {
    setFragt(true);
    setHinweis(null);
    try {
      const res = await fetch(`/api/glossaries/${glossaryId}/vorschlag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_term: begriff }),
      });
      if (!res.ok) {
        setHinweis(await fehlertext(res));
        return;
      }
      const v = await res.json();
      if (v.status === 'ok') {
        setEntwurf(v.vorschlag);
        setAusDeepL(true);
      } else if (v.status === 'wert_verloren') {
        setHinweis(t('glossaries.pflege.wertVerloren', { werte: (v.fehlend ?? []).join(', ') }));
      } else {
        setHinweis(t('glossaries.pflege.leer'));
      }
    } catch (err) {
      setHinweis(t('glossaries.pflege.fehler', { error: (err as Error).message }));
    } finally {
      setFragt(false);
    }
  };

  const bestaetige = async () => {
    const wert = entwurf.trim();
    if (!wert || speichert) return;
    setSpeichert(true);
    setHinweis(null);
    try {
      const res = await fetch(`/api/glossaries/${glossaryId}/entries/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_term: wert }),
      });
      if (res.ok) {
        await meldeFallsVorschlag(res);
        onBestaetigt();
      }
      else setHinweis(await fehlertext(res));
    } catch (err) {
      setHinweis(t('glossaries.pflege.fehler', { error: (err as Error).message }));
    } finally {
      setSpeichert(false);
    }
  };

  if (!offen) {
    return (
      <button
        type="button"
        onClick={() => setOffen(true)}
        title={t('glossaries.pflege.offenTitle')}
        className="block w-full text-left px-1.5 py-0.5 rounded text-sm text-gray-400 italic hover:bg-gray-100 transition-colors"
      >
        {t('glossaries.pflege.offen')}
      </button>
    );
  }

  return (
    <div className="min-w-[16rem]">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          type="text"
          value={entwurf}
          placeholder={t('glossaries.pflege.placeholder')}
          aria-label={t('glossaries.pflege.placeholder')}
          onChange={e => { setEntwurf(e.target.value); setAusDeepL(false); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); bestaetige(); }
            if (e.key === 'Escape') { e.preventDefault(); schliessen(); }
          }}
          className="flex-1 min-w-0 text-sm border border-gray-300 rounded px-1.5 py-0.5"
        />
        <button
          type="button"
          onClick={holeVorschlag}
          disabled={fragt}
          title={t('glossaries.pflege.deeplTitle')}
          className="text-xs px-2 py-0.5 rounded border border-primary-400 text-primary-700 hover:bg-primary-50 disabled:opacity-50 whitespace-nowrap"
        >
          {fragt ? t('glossaries.pflege.deeplBusy') : t('glossaries.pflege.deepl')}
        </button>
        <button
          type="button"
          onClick={bestaetige}
          disabled={!entwurf.trim() || speichert}
          title={t('glossaries.pflege.bestaetigenTitle')}
          className="text-xs px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300 whitespace-nowrap"
        >
          {t('glossaries.pflege.bestaetigen')}
        </button>
        <button
          type="button"
          onClick={schliessen}
          className="text-xs px-1.5 py-0.5 rounded text-gray-500 hover:bg-gray-100 whitespace-nowrap"
        >
          {t('glossaries.pflege.abbrechen')}
        </button>
      </div>
      {ausDeepL && <p className="mt-0.5 text-xs text-primary-700">{t('glossaries.pflege.istVorschlag')}</p>}
      {hinweis && <p className="mt-0.5 text-xs text-red-700" role="alert">{hinweis}</p>}
    </div>
  );
}

/**
 * Neues Glossar für eine Sprache: Quelle fest Deutsch, der Name wird vorgeschlagen und bleibt änderbar. Die Liste kommt vom Server und
 * nennt nur, was DeepL kann und was es noch nicht gibt. Die Prüfung auf ein zweites Glossar liegt trotzdem dort.
 */
function NeuesGlossarDialog({ onClose, onAngelegt }: {
  onClose: () => void;
  onAngelegt: (g: { id: string; vorbefuellt: number }) => void;
}) {
  const { t } = useTranslation('glossary');
  const [sprachen, setSprachen] = useState<{ code: string; name: string }[] | null>(null);
  const [code, setCode] = useState('');
  // null: unberührt, dann gilt der Vorschlag und wechselt mit der Sprache.
  const [eigenerName, setEigenerName] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = eigenerName ?? (code ? `${einstellungen().organisationName || 'Glossar'} DE→${code}` : '');

  useEffect(() => {
    let abgebrochen = false;
    (async () => {
      try {
        const res = await fetch('/api/glossaries/zielsprachen');
        const body = await res.json().catch(() => null);
        if (abgebrochen) return;
        if (res.ok && Array.isArray(body)) {
          setSprachen(body);
        } else {
          setSprachen([]);
          setFehler(t('glossaries.pflege.fehler', { error: body?.error ?? res.status }));
        }
      } catch (err) {
        if (abgebrochen) return;
        setSprachen([]);
        setFehler(t('glossaries.pflege.fehler', { error: (err as Error).message }));
      }
    })();
    return () => { abgebrochen = true; };
  }, [t]);

  // Der Name der Sprache in der Oberflächensprache. `CZ` ist unser Code, die Sprache heißt `cs`.
  const anzeigeName = (s: { code: string; name: string }): string => {
    try {
      return new Intl.DisplayNames([currentLocale()], { type: 'language' }).of(s.code === 'CZ' ? 'cs' : s.code.toLowerCase()) ?? s.name;
    } catch {
      return s.name;
    }
  };

  const anlegen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !name.trim() || busy) return;
    setBusy(true);
    setFehler(null);
    try {
      const res = await fetch('/api/glossaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), source_lang: 'DE', target_lang: code }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) onAngelegt({ id: body.id, vorbefuellt: Number(body.vorbefuellt) || 0 });
      else setFehler(t('glossaries.pflege.fehler', { error: body?.error ?? res.status }));
    } catch (err) {
      setFehler(t('glossaries.pflege.fehler', { error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50" onClick={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t('glossaries.neu.titel')}
        onSubmit={anlegen}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4"
      >
        <div className="px-5 py-3 border-b border-gray-200">
          <h3 className="text-sm font-medium text-gray-900">{t('glossaries.neu.titel')}</h3>
          <p className="text-xs mt-1 text-gray-600">{t('glossaries.neu.text')}</p>
        </div>
        <div className="px-5 py-3 space-y-3">
          {sprachen === null ? (
            <p className="text-sm text-gray-500">{t('glossaries.neu.laden')}</p>
          ) : sprachen.length === 0 && !fehler ? (
            <p className="text-sm text-gray-500">{t('glossaries.neu.keineSprache')}</p>
          ) : sprachen.length > 0 && (
            <>
              <label className="block text-xs text-gray-600">
                {t('glossaries.neu.sprache')}
                <select
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="mt-1 block w-full text-sm border border-gray-300 rounded px-2 py-1"
                >
                  <option value="">{t('glossaries.neu.spracheWaehlen')}</option>
                  {sprachen
                    .map((s) => ({ code: s.code, anzeige: anzeigeName(s) }))
                    .sort((a, b) => a.anzeige.localeCompare(b.anzeige, currentLocale()))
                    .map((s) => <option key={s.code} value={s.code}>{s.anzeige}</option>)}
                </select>
              </label>
              <label className="block text-xs text-gray-600">
                {t('glossaries.neu.name')}
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setEigenerName(e.target.value)}
                  className="mt-1 block w-full text-sm border border-gray-300 rounded px-2 py-1"
                />
              </label>
            </>
          )}
          {fehler && <p className="text-xs text-red-700" role="alert">{fehler}</p>}
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-sm px-3 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            {t('glossaries.neu.abbrechen')}
          </button>
          <button
            type="submit"
            disabled={!code || !name.trim() || busy}
            className="text-sm px-3 py-1 rounded text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
          >
            {t('glossaries.neu.anlegen')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function GlossaryManager() {
  const { t } = useTranslation('glossary');
  // Freigeben, Löschen, Ablehnen nur Admins (PLAN-glossar-freigabe.md). Der Server prüft selbst; die Knöpfe fehlen hier, damit
  // niemand auf ein 403 klickt. Was ein Nicht-Admin speichert, wird ein Vorschlag.
  const { user } = useAuth();
  // Bei GLOSSAR_FREIGABE=alle (Demo) wirkt jede angemeldete Person wie ein Admin, löscht aber nur Einträge, die eine Person
  // angelegt hat (`angelegt_von`), nie die aus dem Beispiel-Glossar (PLAN-oeffentlich-und-demo.md Phase 2, E4).
  const echterAdmin = user?.role === 'admin';
  const istAdmin = echterAdmin || einstellungen().glossarFreigabe === 'alle';
  const darfLoeschen = (e: GlossaryEntry) => echterAdmin || (istAdmin && !!e.angelegt_von);
  const [vorschlagMeldung, setVorschlagMeldung] = useState(false);
  const [glossaries, setGlossaries] = useState<Glossary[]>([]);
  const [selectedGlossary, setSelectedGlossary] = useState<string | null>(null);
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [totalEntries, setTotalEntries] = useState(0);
  const [stats, setStats] = useState<{ total: number; zu_pflegen: number; pending: number; approved: number; rueckfragen?: number; nur_name?: number; vorschlaege?: number }>({ total: 0, zu_pflegen: 0, pending: 0, approved: 0 });
  // Wortliste: Filter nach Art, Rückfrage, „nur in Namen“, und welche Zeilen aufgeklappt sind.
  const [artFilter, setArtFilter] = useState('');
  const [nurRueckfrage, setNurRueckfrage] = useState(false);
  const [nurName, setNurName] = useState(false);
  const [offeneWortliste, setOffeneWortliste] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'all' | 'zu_pflegen' | 'pending' | 'approved' | 'vorschlaege'>('all');
  const [neuesGlossarOffen, setNeuesGlossarOffen] = useState(false);
  const [glossarMeldung, setGlossarMeldung] = useState<string | null>(null);
  const [rueckfrage, setRueckfrage] = useState<Rueckfrage | null>(null);
  const [rueckfrageBusy, setRueckfrageBusy] = useState(false);
  const [nurMitHinweis, setNurMitHinweis] = useState(false);
  const [hinweisKategorie, setHinweisKategorie] = useState<string>(OHNE_SCHREIBFLUT);
  const [hinweisGewissheit, setHinweisGewissheit] = useState<string>('');
  const [hinweisFacetten, setHinweisFacetten] = useState<HinweisFacette[]>([]);
  // In der normalen Ansicht steht je Zeile nur die Markierung; aufgeklappt wird auf Klick.
  const [offeneHinweise, setOffeneHinweise] = useState<Set<string>>(new Set());
  const [hinweisBusy, setHinweisBusy] = useState(false);
  const offeneZelle = useRef<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [newEntry, setNewEntry] = useState({ source_term: '', target_term: '' });
  // DeepL-Vorschlag für eine neue Abweichung. Gespeichert wird er erst mit dem Plus.
  const [vorschlagBusy, setVorschlagBusy] = useState(false);
  const [ausDeepL, setAusDeepL] = useState(false);
  const [vorschlagHinweis, setVorschlagHinweis] = useState<string | null>(null);
  // Bestätigung nach dem Anlegen: Ohne sie verschwand der neue Eintrag in einer der Seiten, und „+“ schien nichts zu tun
  // (Meldung Thomas 11.11.2026).
  const [angelegt, setAngelegt] = useState<string | null>(null);
  // Zählt hoch, wenn die Liste neu geladen werden soll, ohne dass sich ein Filter ändert (nach dem Anlegen).
  const [neuLaden, setNeuLaden] = useState(0);
  const [channels, setChannels] = useState<Channel[]>([]);
  // Welche Zelle wird gerade editiert? Key: `${entryId}:${channelCode}`
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState<string>('');
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // DE → DE ist kein Glossar, sondern die Hausschreibweise der Schreibhilfe —
  // hier nur als zweiter Zugang. Ein echter DE→DE-Eintrag in `glossaries` würde
  // in DeepL-Sync, /api/terminology und Terminologie-Scan als Übersetzung auftauchen.
  const [showHouseTerms, setShowHouseTerms] = useState(false);
  const PAGE_SIZE = 50;

  const fetchGlossaries = useCallback(async () => {
    const res = await fetch('/api/glossaries/stats');
    if (res.ok) setGlossaries(await res.json());
  }, []);

  // Rechts nie leer: zuletzt gewähltes Glossar wieder öffnen, sonst das erste der Liste.
  useEffect(() => {
    if (selectedGlossary || glossaries.length === 0) return;
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(LAST_GLOSSARY_KEY); } catch { /* Privat-Modus */ }
    const pick = glossaries.find((g) => g.id === remembered) ?? glossaries[0];
    setSelectedGlossary(pick.id);
  }, [glossaries, selectedGlossary]);

  const neuenEintragLeeren = () => {
    setNewEntry({ source_term: '', target_term: '' });
    setAusDeepL(false);
    setVorschlagHinweis(null);
    setAngelegt(null);
  };

  const selectGlossary = (id: string) => {
    setShowHouseTerms(false);
    setSelectedGlossary(id);
    setPage(0);
    setSearch('');
    setGlossarMeldung(null);
    setVorschlagMeldung(false);
    neuenEintragLeeren();
    try { localStorage.setItem(LAST_GLOSSARY_KEY, id); } catch { /* Privat-Modus */ }
  };

  const fetchEntries = useCallback(async () => {
    if (!selectedGlossary) return;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      status: statusFilter,
    });
    if (search) params.set('search', search);
    if (nurMitHinweis) {
      params.set('hinweis', '1');
      if (hinweisKategorie) params.set('hinweis_kategorie', hinweisKategorie);
      if (hinweisGewissheit) params.set('hinweis_gewissheit', hinweisGewissheit);
    }
    if (artFilter) params.set('art', artFilter);
    if (nurRueckfrage) params.set('rueckfrage', '1');
    if (nurName) params.set('nur_name', '1');

    const res = await fetch(`/api/glossaries/${selectedGlossary}/entries?${params}`);
    if (res.ok) {
      const data = await res.json();
      setEntries(data.entries);
      setTotalEntries(data.total);
      if (data.stats) setStats(data.stats);
      setHinweisFacetten(Array.isArray(data.hinweis_facetten) ? data.hinweis_facetten : []);
    }
  }, [selectedGlossary, page, search, statusFilter, nurMitHinweis, hinweisKategorie, hinweisGewissheit, artFilter, nurRueckfrage, nurName, neuLaden]);

  useEffect(() => {
    fetchGlossaries();
    fetch('/api/glossaries/channels')
      .then(r => r.json())
      .then((data: Channel[]) => setChannels(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [fetchGlossaries]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  useEffect(() => {
    const eingereicht = () => {
      setVorschlagMeldung(true);
      void fetchEntries();
      void fetchGlossaries();
    };
    window.addEventListener(VORSCHLAG_EREIGNIS, eingereicht);
    return () => window.removeEventListener(VORSCHLAG_EREIGNIS, eingereicht);
  }, [fetchEntries, fetchGlossaries]);

  // Das neue Glossar steht danach in der Liste und ist ausgewählt, alle Zeilen sichtbar: Seine Zeilen warten auf eine Übersetzung.
  const glossarAngelegt = async (g: { id: string; vorbefuellt: number }) => {
    setNeuesGlossarOffen(false);
    setStatusFilter('all');
    setNurMitHinweis(false);
    await fetchGlossaries();
    selectGlossary(g.id);
    setGlossarMeldung(t('glossaries.neu.angelegt', { anzahl: g.vorbefuellt }));
  };

  const handleSyncDeepL = async (glossaryId: string) => {
    setSyncing(glossaryId);
    try {
      const res = await fetch(`/api/glossaries/${glossaryId}/sync-deepl`, { method: 'POST' });
      if (res.ok) {
        await fetchGlossaries();
      } else {
        const err = await res.json();
        alert(t('glossaries.alerts.syncError', { error: err.error }));
      }
    } catch {
      alert(t('glossaries.alerts.syncFailed'));
    } finally {
      setSyncing(null);
    }
  };

  const handleExport = (glossaryId: string) => {
    window.open(`/api/glossaries/${glossaryId}/export`, '_blank');
  };

  const handleAddEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedGlossary) return;
    // Fehlt ein Feld, sagt das die Seite, statt still nichts zu tun (Meldung Thomas 11.11.2026). Der Server verlangt beide.
    const quelle = newEntry.source_term.trim();
    if (!quelle || !newEntry.target_term.trim()) {
      setAngelegt(null);
      setVorschlagHinweis(t(!quelle ? 'glossaries.form.quelleFehlt' : 'glossaries.form.zielFehlt'));
      return;
    }

    const res = await fetch(`/api/glossaries/${selectedGlossary}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newEntry),
    });

    if (res.ok && await meldeFallsVorschlag(res)) {
      neuenEintragLeeren();
      return;
    }
    if (res.ok) {
      neuenEintragLeeren();
      // Den neuen Eintrag zeigen: Ohne Suche stand er irgendwo in 21 Seiten, und ein Filter konnte ihn ganz verstecken.
      setStatusFilter('all');
      setArtFilter('');
      setNurRueckfrage(false);
      setNurName(false);
      setNurMitHinweis(false);
      setSearch(quelle);
      setPage(0);
      setAngelegt(quelle);
      // Ein Abruf mit den neuen Filtern, nicht zusätzlich einer mit den alten aus dieser Closure (Nachprüfung: Reihenfolge offen).
      setNeuLaden((n) => n + 1);
      fetchGlossaries();
    } else {
      const body = await res.json().catch(() => null);
      alert(t('glossaries.alerts.speichernFehler', { error: body?.error ?? res.status }));
    }
  };

  // Ein Aufruf je Klick, nichts wird gespeichert. Zeigt, was DeepL ohne eigene Vorgabe nähme.
  const holeVorschlag = async () => {
    const begriff = newEntry.source_term.trim();
    if (!selectedGlossary || !begriff || vorschlagBusy) return;
    setVorschlagBusy(true);
    setVorschlagHinweis(null);
    try {
      const res = await fetch(`/api/glossaries/${selectedGlossary}/vorschlag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_term: begriff }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setVorschlagHinweis(t('glossaries.pflege.fehler', { error: body?.error ?? res.status }));
      } else if (body?.status === 'ok') {
        setNewEntry(prev => ({ ...prev, target_term: body.vorschlag }));
        setAusDeepL(true);
      } else if (body?.status === 'wert_verloren') {
        setVorschlagHinweis(t('glossaries.pflege.wertVerloren', { werte: (body.fehlend ?? []).join(', ') }));
      } else {
        setVorschlagHinweis(t('glossaries.pflege.leer'));
      }
    } catch (err) {
      setVorschlagHinweis(t('glossaries.pflege.fehler', { error: (err as Error).message }));
    } finally {
      setVorschlagBusy(false);
    }
  };

  // Freigabe-Status eines Eintrags togglen (approved=true/false)
  const handleToggleApproved = async (entryId: string, next: boolean) => {
    if (!selectedGlossary) return;
    const res = await fetch(
      `/api/glossaries/${selectedGlossary}/entries/${entryId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: next }),
      },
    );
    if (res.ok) {
      setEntries(prev => prev.map(e => (e.id === entryId ? { ...e, approved: next } : e)));
      setStats(prev => ({
        ...prev,
        pending: prev.pending + (next ? -1 : 1),
        approved: prev.approved + (next ? 1 : -1),
      }));
    }
  };

  // Alle aktuell sichtbaren offenen Eintraege freigeben.
  const handleBulkApproveVisible = async () => {
    if (!selectedGlossary) return;
    // Zeilen ohne Übersetzung bleiben draußen: Sie haben noch nichts, das man freigeben könnte. Zeilen mit Rückfrage auch, die
    // Frage soll erst jemand beantworten (der Server lässt sie ebenfalls aus, PLAN-wortliste.md §2.7).
    const ids = entries.filter(freigebbar).map(e => e.id);
    if (ids.length === 0) return;
    if (!window.confirm(t('glossaries.alerts.bulkApproveConfirm', { count: ids.length }))) return;
    setBulkBusy(true);
    try {
      const res = await fetch(
        `/api/glossaries/${selectedGlossary}/entries/bulk-approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        },
      );
      if (res.ok) {
        await fetchEntries();
        await fetchGlossaries();
      }
    } finally {
      setBulkBusy(false);
    }
  };

  const nachAenderung = () => {
    fetchEntries();
    fetchGlossaries();
  };

  const rueckfrageAusfuehren = async (r: Rueckfrage) => {
    if (!selectedGlossary) return;
    setRueckfrageBusy(true);
    try {
      const res = await fetch(
        `/api/glossaries/${selectedGlossary}/entries/${r.entryId}`,
        r.neu
          ? {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source_term: r.neu }),
            }
          : { method: 'DELETE' },
      );
      if (res.ok) {
        setRueckfrage(null);
        await meldeFallsVorschlag(res);
        nachAenderung();
        return;
      }
      const body = await res.json().catch(() => null);
      if (res.status === 409 && Array.isArray(body?.konflikte)) {
        setRueckfrage({ ...r, konflikte: body.konflikte });
      } else {
        setRueckfrage(null);
        alert(t('glossaries.alerts.speichernFehler', { error: body?.error ?? res.status }));
      }
    } finally {
      setRueckfrageBusy(false);
    }
  };

  const frageLoeschen = (entry: GlossaryEntry) => {
    const r: Rueckfrage = {
      entryId: entry.id, begriff: entry.source_term, neu: null,
      target_term: entry.target_term, channels: entry.channels ?? {}, konflikte: [],
    };
    // Eine Zeile ohne Übersetzung trägt nichts, was verloren ginge: kein Zwischenschritt.
    if (entry.target_term === null) void rueckfrageAusfuehren(r);
    else setRueckfrage(r);
  };

  const frageUmbenennen = (entryId: string, neu: string) => {
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;
    setRueckfrage({
      entryId, begriff: entry.source_term, neu,
      target_term: entry.target_term, channels: entry.channels ?? {}, konflikte: [],
    });
  };

  // Zeilen je Filterauswahl, exakt vom Server gezählt: Eine Zeile mit zwei Hinweisen zählt nur einmal.
  const facette = (kategorie: string, gewissheit: string): number => {
    if (kategorie === UNNOETIG) return facette('unnoetig_ueberall', gewissheit) + facette('unnoetig_hier', gewissheit);
    const zeile = hinweisFacetten.find(f =>
      f.kategorie === (kategorie === OHNE_SCHREIBFLUT || kategorie === '' ? null : kategorie)
      && f.gewissheit === (gewissheit === '' ? null : gewissheit));
    if (!zeile) return 0;
    return kategorie === OHNE_SCHREIBFLUT ? zeile.ohne_schreibflut : zeile.zeilen;
  };

  // Filter „Unnötige Zeilen“ an oder aus. Zeilen ohne Übersetzung tragen keinen Hinweis, deshalb zurück auf „Alle“.
  const nurUnnoetig = nurMitHinweis && hinweisKategorie === UNNOETIG;
  const unnoetigUmschalten = () => {
    setNurMitHinweis(!nurUnnoetig);
    setHinweisKategorie(nurUnnoetig ? OHNE_SCHREIBFLUT : UNNOETIG);
    setHinweisGewissheit('');
    if (!nurUnnoetig) setStatusFilter('all');
    setPage(0);
  };

  const hinweisUmschalten = (entryId: string) => {
    setOffeneHinweise(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const wortlisteUmschalten = (entryId: string) => {
    setOffeneWortliste(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  // Der normale Speicherweg: mit Verlauf und gezielter Cache-Entwertung. Danach passt der Hinweis nicht mehr.
  const vorschlagUebernehmen = async (entryId: string, vorschlag: string) => {
    if (!selectedGlossary) return;
    setHinweisBusy(true);
    try {
      const res = await fetch(`/api/glossaries/${selectedGlossary}/entries/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_term: vorschlag }),
      });
      if (res.ok) {
        await meldeFallsVorschlag(res);
        nachAenderung();
      } else {
        const body = await res.json().catch(() => null);
        alert(t('glossaries.alerts.speichernFehler', { error: body?.error ?? res.status }));
      }
    } finally {
      setHinweisBusy(false);
    }
  };

  // Die Zeile fällt weg. Der Server lehnt Zeilen mit Channel-Wert ab und alles, was nicht mehr dem gezeigten Text entspricht.
  const eintragEntfernen = async (entryId: string, stand: string | null) => {
    if (!selectedGlossary) return;
    setHinweisBusy(true);
    try {
      const res = await fetch(`/api/glossaries/${selectedGlossary}/entries/${entryId}/entfernen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stand }),
      });
      if (res.ok) {
        nachAenderung();
      } else {
        const body = await res.json().catch(() => null);
        alert(t('glossaries.alerts.speichernFehler', { error: body?.error ?? res.status }));
      }
    } finally {
      setHinweisBusy(false);
    }
  };

  const hinweisVerwerfen = async (hinweisId: string) => {
    if (!selectedGlossary) return;
    setHinweisBusy(true);
    try {
      const res = await fetch(`/api/glossaries/${selectedGlossary}/hinweise/${hinweisId}/verwerfen`, { method: 'POST' });
      if (res.ok) {
        nachAenderung();
      } else {
        const body = await res.json().catch(() => null);
        alert(t('glossaries.alerts.speichernFehler', { error: body?.error ?? res.status }));
      }
    } finally {
      setHinweisBusy(false);
    }
  };

  // Channel-Override speichern (leerer String → Override löschen / Fallback auf Standard)
  const saveChannelOverride = async (entryId: string, channelCode: string, value: string) => {
    if (!selectedGlossary) return;
    const trimmed = value.trim();

    const res = await fetch(
      `/api/glossaries/${selectedGlossary}/entries/${entryId}/channels/${channelCode}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_term: trimmed }),
      }
    );

    if (res.ok && await meldeFallsVorschlag(res)) return;
    if (res.ok) {
      // Lokal patchen statt komplett neuzuladen
      setEntries(prev =>
        prev.map(e => {
          if (e.id !== entryId) return e;
          const next = { ...e.channels };
          if (trimmed === '') delete next[channelCode];
          else next[channelCode] = trimmed;
          return { ...e, channels: next };
        })
      );
    }
  };

  // Standard target_term (Spalte der Organisation) speichern. Leerer String wird abgelehnt
  // (Standard ist Pflicht-Fallback für alle Channels).
  const saveStandardTarget = async (entryId: string, value: string) => {
    if (!selectedGlossary) return;
    const trimmed = value.trim();
    if (trimmed === '') return;

    const res = await fetch(
      `/api/glossaries/${selectedGlossary}/entries/${entryId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_term: trimmed }),
      }
    );

    if (res.ok && await meldeFallsVorschlag(res)) return;
    if (res.ok) {
      setEntries(prev =>
        prev.map(e => (e.id === entryId ? { ...e, target_term: trimmed } : e))
      );
    }
  };

  const startEditChannel = (entryId: string, channelCode: string, currentValue: string) => {
    offeneZelle.current = `${entryId}:${channelCode}`;
    setEditingChannel(`${entryId}:${channelCode}`);
    setChannelDraft(currentValue);
  };

  const finishEditChannel = async (entryId: string, channelCode: string, currentValue: string) => {
    if (channelDraft !== currentValue) {
      if (channelCode === '__begriff__') {
        if (channelDraft.trim() && channelDraft.trim() !== currentValue) frageUmbenennen(entryId, channelDraft.trim());
      } else if (channelCode === '__standard__') {
        await saveStandardTarget(entryId, channelDraft);
      } else {
        await saveChannelOverride(entryId, channelCode, channelDraft);
      }
    }
    // Das Speichern kann bis zu 5 Sekunden auf DeepL warten. Ist inzwischen eine andere Zelle offen, bleibt sie offen.
    if (offeneZelle.current !== `${entryId}:${channelCode}`) return;
    offeneZelle.current = null;
    setEditingChannel(null);
    setChannelDraft('');
  };

  const openHistory = async (entryId: string) => {
    if (!selectedGlossary) return;
    setHistoryEntryId(entryId);
    setHistoryLoading(true);
    setHistory([]);
    try {
      const res = await fetch(`/api/glossaries/${selectedGlossary}/entries/${entryId}/history`);
      if (res.ok) setHistory(await res.json());
    } finally {
      setHistoryLoading(false);
    }
  };

  const closeHistory = () => {
    setHistoryEntryId(null);
    setHistory([]);
  };

  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    return d.toLocaleString(currentLocale(), {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const selected = glossaries.find(g => g.id === selectedGlossary);
  const totalPages = Math.ceil(totalEntries / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <PageHeader title={t('glossaries.header.title')} subtitle={t('glossaries.header.subtitle')} />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Glossar-Liste */}
        <div className="bg-white rounded-lg border border-gray-200 lg:col-span-1">
          <div className="px-4 py-3 border-b border-gray-200">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-gray-900">{t('glossaries.list.title')}</h3>
              {istAdmin && <button
                type="button"
                onClick={() => setNeuesGlossarOffen(true)}
                className="text-xs px-2 py-1 rounded border border-primary-400 text-primary-700 hover:bg-primary-50 whitespace-nowrap"
              >
                {t('glossaries.neu.knopf')}
              </button>}
            </div>
            {glossarMeldung && <p className="mt-1 text-xs text-green-700" role="status">{glossarMeldung}</p>}
          </div>
          <div className="divide-y divide-gray-100">
            {glossaries.length === 0 ? (
              <div className="p-4 text-center text-sm text-gray-500">{t('glossaries.list.empty')}</div>
            ) : (
              glossaries.map(g => {
                const needsSync = !g.deepl_glossary_id || g.synced_version < g.version;
                const zuPflegen = Number(g.zu_pflegen) || 0;
                const hinweise = Number(g.hinweise) || 0;
                const hinweiseSchreibung = Number(g.hinweise_schreibung) || 0;
                const unnoetig = Number(g.unnoetig) || 0;
                return (
                <div
                  key={g.id}
                  className={`px-4 py-3 cursor-pointer transition-colors ${
                    !showHouseTerms && selectedGlossary === g.id ? 'bg-primary-50 border-l-2 border-primary-500' : 'hover:bg-gray-50'
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-current={!showHouseTerms && selectedGlossary === g.id ? 'true' : undefined}
                  onClick={() => selectGlossary(g.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectGlossary(g.id); }
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {g.source_lang} &rarr; {g.target_lang}
                      </div>
                      <div className="text-xs text-gray-500">
                        {t('glossaries.list.entryCount', { count: Number(g.entry_count) })} &middot; v{g.version}
                      </div>
                      {hinweise > 0 && (
                        <div className="mt-1 text-xs text-amber-700" title={t('glossaries.list.hinweiseTitle')}>
                          {t('glossaries.list.hinweise', { count: hinweise })}
                        </div>
                      )}
                      {hinweiseSchreibung > 0 && (
                        <div className="text-xs text-gray-400">
                          {t('glossaries.list.hinweiseSchreibung', { count: hinweiseSchreibung })}
                        </div>
                      )}
                      {unnoetig > 0 && (
                        <div
                          className="text-xs text-gray-400"
                          title={t('glossaries.list.unnoetigTitle', { ueberall: Number(g.unnoetig_ueberall) || 0 })}
                        >
                          {t('glossaries.list.unnoetig', { count: unnoetig })}
                        </div>
                      )}
                      {zuPflegen > 0 && (
                        <div className="text-xs text-gray-400" title={t('glossaries.list.zuPflegenTitle', { count: zuPflegen })}>
                          {t('glossaries.list.zuPflegen', { count: zuPflegen })}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleExport(g.id); }}
                        className="text-xs text-gray-500 hover:text-gray-700 px-1"
                        title={t('glossaries.list.csvExportTitle')}
                      >
                        CSV
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between">
                    {needsSync ? (
                      <span className="text-xs text-amber-600">
                        {t('glossaries.list.notSynced')}
                      </span>
                    ) : (
                      <span className="text-xs text-green-600">
                        {t('glossaries.list.syncedAt', { version: g.synced_version })}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSyncDeepL(g.id); }}
                      disabled={syncing === g.id}
                      className={`text-xs px-2 py-0.5 rounded transition-colors ${
                        needsSync
                          ? 'bg-primary-600 text-white hover:bg-primary-700 disabled:bg-primary-300'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:bg-gray-50'
                      }`}
                    >
                      {syncing === g.id ? t('glossaries.list.syncing') : t('glossaries.list.sync')}
                    </button>
                  </div>
                </div>
                );
              })
            )}
            <div
              className={`px-4 py-3 cursor-pointer transition-colors ${
                showHouseTerms ? 'bg-primary-50 border-l-2 border-primary-500' : 'hover:bg-gray-50'
              }`}
              role="button"
              tabIndex={0}
              aria-current={showHouseTerms ? 'true' : undefined}
              onClick={() => setShowHouseTerms(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowHouseTerms(true); }
              }}
            >
              <div className="text-sm font-medium text-gray-900">DE &rarr; DE</div>
              <div className="text-xs text-gray-500">{t('glossaries.list.houseTerms')}</div>
              <div className="mt-1.5 text-xs text-gray-400">{t('glossaries.list.houseTermsHint')}</div>
            </div>
          </div>
        </div>

        {/* Einträge */}
        <div className="lg:col-span-3 bg-white rounded-lg border border-gray-200">
          {showHouseTerms ? (
            <div className="p-4">
              <HouseTermManager />
            </div>
          ) : selectedGlossary && selected ? (
            <>
              <div className="px-4 py-3 border-b border-gray-200">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-gray-900">
                    {selected.source_lang} &rarr; {selected.target_lang}
                    <span className="text-gray-400 font-normal ml-2">{t('glossaries.entries.count', { count: totalEntries })}</span>
                  </h3>
                  <input
                    type="text"
                    placeholder={t('glossaries.entries.searchPlaceholder')}
                    value={search}
                    onChange={e => { setSearch(e.target.value); setPage(0); }}
                    className="text-sm border border-gray-300 rounded px-2 py-1 w-full sm:w-48"
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {(['all', 'zu_pflegen', 'pending', 'approved'] as const).map(opt => {
                    const labels = { all: t('glossaries.filter.all'), zu_pflegen: t('glossaries.filter.zuPflegen'), pending: t('glossaries.filter.pending'), approved: t('glossaries.filter.approved') };
                    const counts = { all: stats.total, zu_pflegen: stats.zu_pflegen, pending: stats.pending, approved: stats.approved };
                    const active = statusFilter === opt;
                    const isPending = opt === 'pending';
                    if (opt === 'zu_pflegen' && stats.zu_pflegen === 0 && !active) return null;
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => { setStatusFilter(opt); setPage(0); }}
                        className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                          active
                            ? opt === 'zu_pflegen'
                              ? 'bg-gray-200 border-gray-400 text-gray-900'
                              : isPending
                                ? 'bg-amber-100 border-amber-400 text-amber-900'
                                : 'bg-primary-100 border-primary-400 text-primary-900'
                            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {labels[opt]}
                        <span className="ml-1 text-gray-400">({counts[opt]})</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => { setStatusFilter('vorschlaege'); setPage(0); }}
                    aria-pressed={statusFilter === 'vorschlaege'}
                    title={t('glossaries.vorschlaege.filterTitle')}
                    className={`text-xs px-2.5 py-1 rounded border transition-colors ${statusFilter === 'vorschlaege' ? 'bg-amber-100 border-amber-400 text-amber-900' : (stats.vorschlaege ?? 0) > 0 ? 'bg-white border-amber-300 text-amber-800 hover:bg-amber-50' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                  >
                    {t('glossaries.filter.vorschlaege')}
                    <span className="ml-1 text-gray-400">({stats.vorschlaege ?? 0})</span>
                  </button>
                  {stats.rueckfragen !== undefined && (stats.rueckfragen > 0 || nurRueckfrage) && (
                    <button
                      type="button"
                      onClick={() => { setNurRueckfrage(!nurRueckfrage); setPage(0); }}
                      aria-pressed={nurRueckfrage}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${nurRueckfrage ? 'bg-amber-100 border-amber-400 text-amber-900' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                    >
                      {t('glossaries.wortliste.filterRueckfrage')}
                      <span className="ml-1 text-gray-400">({stats.rueckfragen})</span>
                    </button>
                  )}
                  {stats.nur_name !== undefined && (stats.nur_name > 0 || nurName) && (
                    <button
                      type="button"
                      onClick={() => { setNurName(!nurName); setPage(0); }}
                      aria-pressed={nurName}
                      title={t('glossaries.wortliste.filterNurNameTitle')}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${nurName ? 'bg-sky-100 border-sky-400 text-sky-900' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                    >
                      {t('glossaries.wortliste.filterNurName')}
                      <span className="ml-1 text-gray-400">({stats.nur_name})</span>
                    </button>
                  )}
                  <select
                    value={artFilter}
                    onChange={e => { setArtFilter(e.target.value); setPage(0); }}
                    aria-label={t('glossaries.wortliste.art')}
                    className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-600"
                  >
                    <option value="">{t('glossaries.wortliste.filterAlleArten')}</option>
                    {(['wort', 'muster', 'wendung', 'fest'] as const).map(a => (
                      <option key={a} value={a}>{t(`glossaries.wortliste.artWerte.${a}`)}</option>
                    ))}
                  </select>
                  {istAdmin && statusFilter === 'pending' && entries.some(freigebbar) && (
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={handleBulkApproveVisible}
                      className="ml-auto text-xs px-2.5 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300"
                      title={t('glossaries.bulk.title')}
                    >
                      {bulkBusy ? t('glossaries.bulk.busy') : t('glossaries.bulk.button', { count: entries.filter(freigebbar).length })}
                    </button>
                  )}
                </div>
                {(facette('', '') > 0 || nurMitHinweis) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <label className="inline-flex items-center gap-1 text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={nurMitHinweis}
                        onChange={e => { setNurMitHinweis(e.target.checked); setPage(0); }}
                      />
                      {t('glossaries.hinweis.nurMit')}
                    </label>
                    {(facette(UNNOETIG, '') > 0 || nurUnnoetig) && (
                      <button
                        type="button"
                        aria-pressed={nurUnnoetig}
                        onClick={unnoetigUmschalten}
                        title={t('glossaries.hinweis.nurUnnoetigTitle')}
                        className={`px-2 py-0.5 rounded border transition-colors ${
                          nurUnnoetig
                            ? 'bg-gray-200 border-gray-400 text-gray-900'
                            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {t('glossaries.hinweis.nurUnnoetig')}
                        <span className="ml-1 text-gray-400">({facette(UNNOETIG, '')})</span>
                      </button>
                    )}
                    {nurMitHinweis && (
                      <>
                        <select
                          aria-label={t('glossaries.hinweis.kategorieLabel')}
                          value={hinweisKategorie}
                          onChange={e => { setHinweisKategorie(e.target.value); setPage(0); }}
                          className="border border-gray-300 rounded px-1.5 py-0.5"
                        >
                          <option value={OHNE_SCHREIBFLUT}>
                            {t('glossaries.hinweis.ohneSchreibung')} ({facette(OHNE_SCHREIBFLUT, hinweisGewissheit)})
                          </option>
                          <option value="">
                            {t('glossaries.hinweis.alleKategorien')} ({facette('', hinweisGewissheit)})
                          </option>
                          {(facette(UNNOETIG, hinweisGewissheit) > 0 || nurUnnoetig) && (
                            <option value={UNNOETIG}>
                              {t('glossaries.hinweis.nurUnnoetig')} ({facette(UNNOETIG, hinweisGewissheit)})
                            </option>
                          )}
                          {HINWEIS_KATEGORIEN.filter(k => k === hinweisKategorie || facette(k, hinweisGewissheit) > 0).map(k => (
                            <option key={k} value={k}>
                              {t(`glossaries.hinweis.kategorie.${k}`)} ({facette(k, hinweisGewissheit)})
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={t('glossaries.hinweis.gewissheitLabel')}
                          value={hinweisGewissheit}
                          onChange={e => { setHinweisGewissheit(e.target.value); setPage(0); }}
                          className="border border-gray-300 rounded px-1.5 py-0.5"
                        >
                          <option value="">
                            {t('glossaries.hinweis.alleGewissheiten')} ({facette(hinweisKategorie, '')})
                          </option>
                          {HINWEIS_GEWISSHEITEN.map(g => (
                            <option key={g} value={g}>
                              {t(`glossaries.hinweis.gewissheit.${g}`)} ({facette(hinweisKategorie, g)})
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                )}
                {channels.length > 0 && (
                  <p className="mt-2 text-xs text-gray-400">
                    {t('glossaries.entries.channelHint')}
                  </p>
                )}
              </div>

              {/* Neuer Eintrag */}
              <form onSubmit={handleAddEntry} className="px-4 py-2 border-b border-gray-100">
                <div className="flex flex-wrap gap-2">
                  <input
                    type="text"
                    placeholder={t('glossaries.form.sourcePlaceholder')}
                    value={newEntry.source_term}
                    onChange={e => { setNewEntry(prev => ({ ...prev, source_term: e.target.value })); setAngelegt(null); setVorschlagHinweis(null); }}
                    className="text-sm border border-gray-300 rounded px-2 py-1 flex-1 min-w-[9rem]"
                  />
                  <input
                    type="text"
                    placeholder={t('glossaries.form.targetPlaceholder')}
                    value={newEntry.target_term}
                    onChange={e => { setNewEntry(prev => ({ ...prev, target_term: e.target.value })); setAusDeepL(false); setVorschlagHinweis(null); setAngelegt(null); }}
                    className="text-sm border border-gray-300 rounded px-2 py-1 flex-1 min-w-[9rem]"
                  />
                  <button
                    type="button"
                    onClick={holeVorschlag}
                    disabled={!newEntry.source_term.trim() || vorschlagBusy}
                    title={t('glossaries.pflege.deeplTitle')}
                    className="text-xs px-2 py-1 rounded border border-primary-400 text-primary-700 hover:bg-primary-50 disabled:opacity-50 whitespace-nowrap"
                  >
                    {vorschlagBusy ? t('glossaries.pflege.deeplBusy') : t('glossaries.pflege.deepl')}
                  </button>
                  <button
                    type="submit"
                    className="text-sm bg-primary-600 text-white px-3 py-1 rounded hover:bg-primary-700"
                  >
                    +
                  </button>
                </div>
                {ausDeepL && <p className="mt-1 text-xs text-primary-700">{t('glossaries.pflege.istVorschlag')}</p>}
                {vorschlagHinweis && <p className="mt-1 text-xs text-red-700" role="alert">{vorschlagHinweis}</p>}
                {angelegt && <p className="mt-1 text-xs text-green-700" role="status">{t('glossaries.form.angelegt', { begriff: angelegt })}</p>}
                {vorschlagMeldung && <p className="mt-1 text-xs text-amber-800" role="status">{t('glossaries.vorschlaege.eingereicht')}</p>}
              </form>

              {statusFilter === 'vorschlaege' ? (
                <GlossarVorschlaege glossaryId={selectedGlossary} istAdmin={istAdmin} onEntschieden={nachAenderung} />
              ) : (
              /* Einträge-Tabelle mit Channel-Spalten */
              <div className="max-h-[32rem] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0 z-10">
                    <tr>
                      <th className="w-10 text-center px-2 py-2 text-gray-500 font-medium" title={t('glossaries.table.approvedHeaderTitle')}>✓</th>
                      <th className="w-10 text-center px-1 py-2 text-gray-500 font-medium" title={t('glossaries.hinweis.spalteTitle')}>⚑</th>
                      <th className="text-left px-4 py-2 text-gray-500 font-medium whitespace-nowrap">{selected.source_lang}</th>
                      <th className="text-left px-4 py-2 text-gray-500 font-medium whitespace-nowrap">
                        {selected.target_lang} <span className="text-gray-300 font-normal">({orgName()})</span>
                      </th>
                      {channels.map(ch => (
                        <th
                          key={ch.code}
                          className="text-left px-3 py-2 text-gray-500 font-medium whitespace-nowrap border-l border-gray-100"
                        >
                          {ch.name}
                        </th>
                      ))}
                      {/* Klebt am rechten Rand: Die Zelle „zu pflegen“ macht die Tabelle breiter als den Kasten, sonst läge das × abgeschnitten dahinter. */}
                      <th className="w-8 sticky right-0 bg-gray-50" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {entries.map(entry => {
                      const zuPflegen = entry.target_term === null;
                      const hinweise = entry.hinweise ?? [];
                      const aufgeklappt = hinweise.length > 0 && (nurMitHinweis || offeneHinweise.has(entry.id));
                      const wortlisteOffen = offeneWortliste.has(entry.id);
                      return (
                      <Fragment key={entry.id}>
                      <tr className={`group hover:bg-gray-50 ${!zuPflegen && !entry.approved ? 'bg-amber-50/40' : ''}`}>
                        <td className="px-2 py-1.5 text-center align-middle">
                          {zuPflegen ? (
                            <span
                              className="inline-flex w-5 h-5 text-gray-300 text-xs items-center justify-center"
                              title={t('glossaries.entry.zuPflegenTitle')}
                            >
                              –
                            </span>
                          ) : (
                          <button
                            type="button"
                            disabled={!istAdmin}
                            onClick={() => handleToggleApproved(entry.id, !entry.approved)}
                            title={
                              entry.approved
                                ? t('glossaries.entry.approvedTitle', { source: entry.source })
                                : t('glossaries.entry.pendingTitle', { source: entry.source })
                            }
                            className={`w-5 h-5 rounded border text-xs flex items-center justify-center transition-colors ${
                              entry.approved
                                ? 'bg-green-500 border-green-500 text-white enabled:hover:bg-green-600'
                                : 'bg-white border-amber-400 text-amber-500 enabled:hover:bg-amber-50'
                            } disabled:cursor-default`}
                          >
                            {entry.approved ? '✓' : '○'}
                          </button>
                          )}
                        </td>
                        <td className="px-1 py-1.5 text-center align-middle">
                          {hinweise.length > 0 && (
                            <button
                              type="button"
                              onClick={() => hinweisUmschalten(entry.id)}
                              aria-expanded={aufgeklappt}
                              title={hinweise.map(h => `${t(`glossaries.hinweis.kategorie.${h.kategorie}`)}: ${h.grund}`).join('\n')}
                              className={`text-xs rounded px-1 whitespace-nowrap ${
                                hinweise.every(istNebensache)
                                  ? 'text-gray-400 hover:bg-gray-100'
                                  : 'text-amber-700 bg-amber-50 border border-amber-300 hover:bg-amber-100'
                              }`}
                            >
                              {hinweise.every(istUnnoetig) ? '≈' : `⚑${hinweise.length > 1 ? ` ${hinweise.length}` : ''}`}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-1 text-gray-900 align-middle">
                          {editingChannel === `${entry.id}:__begriff__` ? (
                            <input
                              autoFocus
                              type="text"
                              value={channelDraft}
                              onChange={e => setChannelDraft(e.target.value)}
                              onBlur={() => finishEditChannel(entry.id, '__begriff__', entry.source_term)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  (e.target as HTMLInputElement).blur();
                                } else if (e.key === 'Escape') {
                                  setEditingChannel(null);
                                  setChannelDraft('');
                                }
                              }}
                              className="w-full text-sm border border-primary-400 rounded px-1.5 py-0.5"
                            />
                          ) : (
                            <div className="flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => wortlisteUmschalten(entry.id)}
                                aria-expanded={wortlisteOffen}
                                title={t('glossaries.wortliste.aufklappenTitle')}
                                className="shrink-0 w-4 text-xs text-gray-400 hover:text-primary-600"
                              >
                                {wortlisteOffen ? '▾' : '▸'}
                              </button>
                              <button
                                type="button"
                                onClick={() => startEditChannel(entry.id, '__begriff__', entry.source_term)}
                                title={t('glossaries.entry.editTermTitle')}
                                className="flex-1 min-w-0 text-left px-1.5 py-0.5 rounded text-sm text-gray-900 hover:bg-primary-50 transition-colors"
                              >
                                {entry.source_term}
                              </button>
                              <WortlisteKennzeichen entry={entry} />
                              {(entry.offene_vorschlaege ?? 0) > 0 && (
                                <span title={t('glossaries.vorschlaege.zeileTitle')} className="ml-1 text-[10px] leading-4 px-1 rounded border whitespace-nowrap bg-amber-50 text-amber-800 border-amber-300">
                                  {t('glossaries.vorschlaege.zeile', { n: entry.offene_vorschlaege })}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-1 text-gray-700 align-middle">
                          {zuPflegen ? (
                            <LeereZelle glossaryId={selectedGlossary} entryId={entry.id} begriff={entry.source_term} onBestaetigt={nachAenderung} />
                          ) : editingChannel === `${entry.id}:__standard__` ? (
                            <input
                              autoFocus
                              type="text"
                              value={channelDraft}
                              onChange={e => setChannelDraft(e.target.value)}
                              onBlur={() => finishEditChannel(entry.id, '__standard__', entry.target_term ?? '')}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  (e.target as HTMLInputElement).blur();
                                } else if (e.key === 'Escape') {
                                  setEditingChannel(null);
                                  setChannelDraft('');
                                }
                              }}
                              className="w-full text-sm border border-primary-400 rounded px-1.5 py-0.5"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => startEditChannel(entry.id, '__standard__', entry.target_term ?? '')}
                              title={t('glossaries.entry.editStandardTitle')}
                              className="block w-full text-left px-1.5 py-0.5 rounded text-sm text-gray-700 hover:bg-primary-50 transition-colors"
                            >
                              {entry.target_term}
                            </button>
                          )}
                        </td>
                        {channels.map(ch => {
                          const cellKey = `${entry.id}:${ch.code}`;
                          const isEditing = editingChannel === cellKey;
                          const currentValue = entry.channels?.[ch.code] ?? '';
                          return (
                            <td
                              key={ch.code}
                              className="px-3 py-1 border-l border-gray-100 align-middle"
                            >
                              {zuPflegen ? (
                                <span className="block px-1.5 py-0.5 text-sm text-gray-300 italic">–</span>
                              ) : isEditing ? (
                                <input
                                  autoFocus
                                  type="text"
                                  value={channelDraft}
                                  onChange={e => setChannelDraft(e.target.value)}
                                  onBlur={() => finishEditChannel(entry.id, ch.code, currentValue)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      (e.target as HTMLInputElement).blur();
                                    } else if (e.key === 'Escape') {
                                      setEditingChannel(null);
                                      setChannelDraft('');
                                    }
                                  }}
                                  className="w-full text-sm border border-primary-400 rounded px-1.5 py-0.5"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => startEditChannel(entry.id, ch.code, currentValue)}
                                  title={
                                    currentValue
                                      ? t('glossaries.entry.overrideTitle', { channel: ch.code, value: currentValue })
                                      : t('glossaries.entry.noOverrideTitle', { channel: ch.code })
                                  }
                                  className={`block w-full text-left px-1.5 py-0.5 rounded text-sm transition-colors ${
                                    currentValue
                                      ? 'text-gray-700 hover:bg-primary-50'
                                      : 'text-gray-300 hover:bg-gray-100 italic'
                                  }`}
                                >
                                  {currentValue || '–'}
                                </button>
                              )}
                            </td>
                          );
                        })}
                        <td className={`px-2 whitespace-nowrap sticky right-0 group-hover:bg-gray-50 ${!zuPflegen && !entry.approved ? 'bg-amber-50' : 'bg-white'}`}>
                          <button
                            onClick={() => openHistory(entry.id)}
                            className="text-gray-400 hover:text-primary-600 mr-1"
                            title={t('glossaries.entry.historyTitle')}
                          >
                            ⟲
                          </button>
                          {darfLoeschen(entry) && <button
                            onClick={() => frageLoeschen(entry)}
                            className="text-gray-400 hover:text-red-500"
                            title={t('glossaries.entry.deleteTitle')}
                          >
                            &times;
                          </button>}
                        </td>
                      </tr>
                      {aufgeklappt && (
                        <tr className="bg-amber-50/30">
                          <td colSpan={channels.length + 5} className="px-4 py-1.5">
                            <ul className="space-y-1">
                              {hinweise.map(h => (
                                <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                                  <span className="font-medium text-amber-800">
                                    {t(`glossaries.hinweis.kategorie.${h.kategorie}`)}
                                  </span>
                                  <span className="text-gray-400">
                                    {t(`glossaries.hinweis.gewissheit.${h.gewissheit}`)} · {t(`glossaries.hinweis.quelle.${h.quelle}`)}
                                  </span>
                                  <span className="text-gray-700">{h.grund}</span>
                                  {h.vorschlag && (
                                    <>
                                      <span className="text-gray-500">{t('glossaries.hinweis.vorschlag')}:</span>
                                      <span className="font-medium text-gray-900">{h.vorschlag}</span>
                                      <button
                                        type="button"
                                        disabled={hinweisBusy}
                                        onClick={() => vorschlagUebernehmen(entry.id, h.vorschlag as string)}
                                        title={t('glossaries.hinweis.uebernehmenTitle')}
                                        className="px-1.5 rounded border border-green-500 text-green-700 hover:bg-green-50 disabled:opacity-50"
                                      >
                                        {t('glossaries.hinweis.uebernehmen')}
                                      </button>
                                    </>
                                  )}
                                  {darfLoeschen(entry) && istUnnoetig(h) && (
                                    <button
                                      type="button"
                                      disabled={hinweisBusy}
                                      onClick={() => eintragEntfernen(entry.id, entry.target_term)}
                                      title={t('glossaries.hinweis.entfernenTitle')}
                                      className="px-1.5 rounded border border-primary-400 text-primary-700 hover:bg-primary-50 disabled:opacity-50"
                                    >
                                      {t('glossaries.hinweis.entfernen')}
                                    </button>
                                  )}
                                  {istAdmin && <button
                                    type="button"
                                    disabled={hinweisBusy}
                                    onClick={() => hinweisVerwerfen(h.id)}
                                    title={t('glossaries.hinweis.verwerfenTitle')}
                                    className="px-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                                  >
                                    {t('glossaries.hinweis.verwerfen')}
                                  </button>}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                      {wortlisteOffen && (
                        <tr className="bg-primary-50/30">
                          <td colSpan={channels.length + 5} className="px-4 py-2">
                            <WortlisteZeile glossaryId={selectedGlossary} entry={entry} istAdmin={darfLoeschen(entry)} onGeaendert={nachAenderung} />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              )}

              {statusFilter !== 'vorschlaege' && totalPages > 1 && (
                <div className="px-4 py-2 border-t border-gray-100 flex justify-between items-center text-xs text-gray-500">
                  <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="disabled:text-gray-300"
                  >
                    &larr; {t('glossaries.pagination.prev')}
                  </button>
                  <span>{t('glossaries.pagination.page', { page: page + 1, total: totalPages })}</span>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="disabled:text-gray-300"
                  >
                    {t('glossaries.pagination.next')} &rarr;
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="p-8 text-center text-gray-500 text-sm">
              {t('glossaries.empty.selectGlossary')}
            </div>
          )}
        </div>
      </div>

      {neuesGlossarOffen && <NeuesGlossarDialog onClose={() => setNeuesGlossarOffen(false)} onAngelegt={glossarAngelegt} />}

      {/* Rückfrage vor Löschen und Umbenennen */}
      {rueckfrage && (
        <div
          className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50"
          onClick={() => setRueckfrage(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-gray-200">
              <h3 className="text-sm font-medium text-gray-900">
                {rueckfrage.neu
                  ? t('glossaries.rueckfrage.umbenennenTitel', { begriff: rueckfrage.begriff, neu: rueckfrage.neu })
                  : t('glossaries.rueckfrage.loeschenTitel', { begriff: rueckfrage.begriff })}
              </h3>
              <p className={`text-xs mt-1 ${rueckfrage.konflikte.length > 0 ? 'text-red-700' : 'text-gray-600'}`}>
                {rueckfrage.konflikte.length > 0
                  ? t('glossaries.rueckfrage.konfliktText')
                  : rueckfrage.neu
                    ? t('glossaries.rueckfrage.umbenennenText')
                    : t('glossaries.rueckfrage.loeschenText')}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {rueckfrage.konflikte.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th className="py-1 pr-3 font-medium">{t('glossaries.rueckfrage.spalteAlt')}</th>
                      <th className="py-1 font-medium">{t('glossaries.rueckfrage.spalteNeu')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rueckfrage.konflikte.map((k, i) => (
                      <tr key={i}>
                        <td className="py-1 pr-3 text-gray-900">{k.target_term_alt}</td>
                        <td className="py-1 text-gray-900">{k.target_term_neu}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th className="py-1 pr-3 font-medium">{t('glossaries.rueckfrage.spalteBegriff')}</th>
                      <th className="py-1 font-medium">{t('glossaries.rueckfrage.spalteUebersetzung')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="py-1 pr-3 text-gray-900">{rueckfrage.begriff}</td>
                      <td className="py-1 text-gray-900">
                        {rueckfrage.target_term ?? <span className="italic text-gray-500">{t('glossaries.rueckfrage.leer')}</span>}
                        {Object.entries(rueckfrage.channels).map(([code, wert]) => (
                          <div key={code} className="text-xs text-gray-500">{code}: {wert}</div>
                        ))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRueckfrage(null)}
                className="text-sm px-3 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {rueckfrage.konflikte.length > 0 ? t('glossaries.rueckfrage.schliessen') : t('glossaries.rueckfrage.abbrechen')}
              </button>
              {rueckfrage.konflikte.length === 0 && (
                <button
                  type="button"
                  disabled={rueckfrageBusy}
                  onClick={() => rueckfrageAusfuehren(rueckfrage)}
                  className={`text-sm px-3 py-1 rounded text-white disabled:opacity-50 ${
                    rueckfrage.neu ? 'bg-primary-600 hover:bg-primary-700' : 'bg-red-600 hover:bg-red-700'
                  }`}
                >
                  {rueckfrage.neu ? t('glossaries.rueckfrage.umbenennen') : t('glossaries.rueckfrage.loeschen')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* History-Modal */}
      {historyEntryId && (
        <div
          className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50"
          onClick={closeHistory}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-gray-900">{t('glossaries.history.title')}</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {history[0]?.source_term ?? entries.find(e => e.id === historyEntryId)?.source_term ?? ''}
                </p>
              </div>
              <button
                onClick={closeHistory}
                className="text-gray-400 hover:text-gray-700 text-lg"
              >
                &times;
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {historyLoading ? (
                <p className="text-sm text-gray-400">{t('glossaries.history.loading')}</p>
              ) : history.length === 0 ? (
                <p className="text-sm text-gray-400">{t('glossaries.history.empty')}</p>
              ) : (
                <ul className="space-y-3">
                  {history.map((h) => {
                    // Feldnamen aus den Triggern (Migration 037/039) lesbar machen; ein Channel-Code bleibt, wie er ist.
                    const gruppe = /^gruppe:(\d+)$/.exec(h.field);
                    const fieldLabel = h.field === 'standard' ? t('glossaries.history.fieldStandard')
                      : h.field === 'begriff' ? t('glossaries.history.fieldBegriff')
                      : gruppe ? t('glossaries.history.feld.gruppe', { nr: gruppe[1] })
                      : HISTORY_FELDER.has(h.field) ? t(`glossaries.history.feld.${h.field}`)
                      : h.field;
                    // Freigabe, an_deepl und Art tragen feste Werte, die die Datenbank deutsch schreibt.
                    const wert = (x: string | null) => (x && HISTORY_WERTE.has(x) && ['freigabe', 'an_deepl', 'art'].includes(h.field)
                      ? t(`glossaries.history.wert.${x}`) : x);
                    const actionColor =
                      h.action === 'created' ? 'text-green-600'
                      : h.action === 'deleted' || h.action === 'verworfen' ? 'text-red-600'
                      : h.action === 'vorschlag' ? 'text-amber-700'
                      : 'text-primary-700';
                    const actionLabel =
                      h.action === 'created' ? t('glossaries.history.action.created')
                      : h.action === 'deleted' ? t('glossaries.history.action.deleted')
                      // Vorschläge der Nicht-Admins und ihr Entscheid (PLAN-glossar-freigabe.md).
                      : h.action === 'vorschlag' ? t('glossaries.history.action.vorschlag')
                      : h.action === 'freigabe' ? t('glossaries.history.action.freigabe')
                      : h.action === 'verworfen' ? t('glossaries.history.action.verworfen')
                      : t('glossaries.history.action.updated');
                    return (
                      <li key={h.id} className="border-l-2 border-gray-200 pl-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={`text-xs font-medium ${actionColor}`}>
                            {actionLabel} · {fieldLabel}
                          </span>
                          <span className="text-xs text-gray-400">{formatDate(h.changed_at)}</span>
                        </div>
                        <div className="mt-1 text-xs text-gray-700">
                          {(h.action === 'updated' || h.action === 'vorschlag' || h.action === 'freigabe' || h.action === 'verworfen') && (
                            <>
                              <span className="line-through text-gray-400">{wert(h.old_value) || '—'}</span>
                              {' → '}
                              <span className="font-medium">{wert(h.new_value) || '—'}</span>
                            </>
                          )}
                          {h.action === 'created' && (
                            <span className="font-medium">{wert(h.new_value) || '—'}</span>
                          )}
                          {h.action === 'deleted' && (
                            <span className="line-through text-gray-400">{wert(h.old_value) || '—'}</span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500">
                          {h.changed_by_name || t('glossaries.history.unknownUser')}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
