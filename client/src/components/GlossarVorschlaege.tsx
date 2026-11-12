/**
 * Vorschläge zum Glossar (PLAN-glossar-freigabe.md, Cockpit #1874): Was Nicht-Admins eingereicht haben, alt und neu nebeneinander.
 * Freigeben und Verwerfen nur Admins; der Server prüft das selbst (`requireAdmin`), die Knöpfe fehlen hier nur, damit niemand auf
 * ein 403 klickt.
 *
 * `meldeFallsVorschlag` steht hier, weil jeder Speicherweg der Glossarseite es braucht: Antwortet der Server mit `vorschlag: true`,
 * ist nichts gespeichert, nur eingereicht. Die Seite darf die Zeile dann nicht lokal ändern, als gälte der neue Wert schon.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const VORSCHLAG_EREIGNIS = 'glossar:vorschlag';

/** `true`, wenn die Antwort ein eingereichter Vorschlag ist. Meldet es der Seite, liest den Body nur aus einer Kopie. */
export async function meldeFallsVorschlag(res: Response): Promise<boolean> {
  if (res.status !== 201) return false;
  const body = await res.clone().json().catch(() => null);
  if (!body?.vorschlag) return false;
  window.dispatchEvent(new CustomEvent(VORSCHLAG_EREIGNIS));
  return true;
}

interface Vorschlag {
  id: number;
  entry_id: string | null;
  weg: 'neu' | 'eintrag' | 'channel' | 'wortliste' | 'gruppe';
  schluessel: string;
  source_term: string;
  daten: Record<string, unknown>;
  aktuell: Record<string, unknown> | null;
  quelle: 'glossar' | 'quickadd' | 'review' | 'terminologie-scan';
  von: string;
  am: string;
  /** Zählt jedes Ergänzen. Freigegeben wird nur die Fassung, die hier zu sehen war. */
  fassung: number;
  status: 'offen' | 'in_arbeit';
}

const FELDER = ['target_term', 'source_term', 'context', 'category', 'channel_code', 'art', 'wortart', 'genus', 'formen', 'ziel_name', 'an_deepl'];

export default function GlossarVorschlaege({ glossaryId, istAdmin, onEntschieden }: {
  glossaryId: string;
  istAdmin: boolean;
  /** Nach Freigeben oder Verwerfen: Zähler und Liste der Seite neu laden. */
  onEntschieden: () => void;
}) {
  const { t, i18n } = useTranslation('glossary');
  const [liste, setListe] = useState<Vorschlag[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [fehler, setFehler] = useState<{ id: number; text: string } | null>(null);

  const laden = useCallback(async () => {
    const res = await fetch(`/api/glossaries/${glossaryId}/vorschlaege`);
    setListe(res.ok ? await res.json() : []);
  }, [glossaryId]);

  useEffect(() => { void laden(); }, [laden]);
  useEffect(() => {
    const neu = () => { void laden(); };
    window.addEventListener(VORSCHLAG_EREIGNIS, neu);
    return () => window.removeEventListener(VORSCHLAG_EREIGNIS, neu);
  }, [laden]);

  const wert = (w: unknown): string => {
    if (w === null || w === undefined || w === '') return '–';
    if (typeof w === 'boolean') return t(w ? 'glossaries.vorschlaege.ja' : 'glossaries.vorschlaege.nein');
    if (typeof w === 'object') return Object.entries(w as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`).join(', ');
    return String(w);
  };

  const was = (v: Vorschlag): string => {
    if (v.weg === 'eintrag' && v.schluessel === 'begriff') return t('glossaries.vorschlaege.weg.begriff');
    if (v.weg === 'channel') return t('glossaries.vorschlaege.weg.channel', { code: v.schluessel });
    if (v.weg === 'gruppe') return t('glossaries.vorschlaege.weg.gruppe', { nr: v.schluessel });
    return t(`glossaries.vorschlaege.weg.${v.weg}`);
  };

  const entscheide = async (v: Vorschlag, wie: 'freigeben' | 'verwerfen') => {
    if (wie === 'verwerfen' && !window.confirm(t('glossaries.vorschlaege.verwerfenConfirm', { begriff: v.source_term }))) return;
    setBusy(v.id);
    setFehler(null);
    try {
      const res = await fetch(`/api/glossaries/${glossaryId}/vorschlaege/${v.id}/${wie}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fassung: v.fassung }),
      });
      if (res.ok) {
        await laden();
        onEntschieden();
      } else {
        const body = await res.json().catch(() => null);
        setFehler({ id: v.id, text: t('glossaries.vorschlaege.fehler', { error: body?.error ?? res.status }) });
        // Ergänzt oder von jemand anderem entschieden: den Stand von jetzt zeigen, die Meldung bleibt stehen.
        if (res.status === 409) await laden();
      }
    } finally {
      setBusy(null);
    }
  };

  if (liste === null) return <p className="px-4 py-6 text-sm text-gray-500">{t('glossaries.history.loading')}</p>;
  if (liste.length === 0) return <p className="px-4 py-6 text-sm text-gray-500">{t('glossaries.vorschlaege.leer')}</p>;

  return (
    <div className="max-h-[32rem] overflow-auto">
      {!istAdmin && <p className="px-4 pt-3 text-xs text-gray-500">{t('glossaries.vorschlaege.nurAdmin')}</p>}
      <table className="w-full text-sm">
        <thead className="bg-gray-50 sticky top-0 z-10">
          <tr>
            <th className="text-left px-4 py-2 text-gray-500 font-medium">{t('glossaries.vorschlaege.spalte.begriff')}</th>
            <th className="text-left px-4 py-2 text-gray-500 font-medium">{t('glossaries.vorschlaege.spalte.jetzt')}</th>
            <th className="text-left px-4 py-2 text-gray-500 font-medium">{t('glossaries.vorschlaege.spalte.neu')}</th>
            <th className="text-left px-4 py-2 text-gray-500 font-medium">{t('glossaries.vorschlaege.spalte.von')}</th>
            {istAdmin && <th className="px-4 py-2" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {liste.map(v => {
            const felder = FELDER.filter(k => k in v.daten);
            return (
              <tr key={v.id} className="align-top">
                <td className="px-4 py-2">
                  <div className="font-medium text-gray-900">{v.source_term}</div>
                  <div className="text-xs text-gray-500">{was(v)}</div>
                </td>
                <td className="px-4 py-2 text-gray-600">
                  {felder.map(k => (
                    <div key={k}><span className="text-xs text-gray-400">{t(`glossaries.vorschlaege.feld.${k}`)}: </span>
                      {v.weg === 'neu' ? '–' : wert(v.aktuell?.[k])}</div>
                  ))}
                </td>
                <td className="px-4 py-2 text-gray-900">
                  {felder.map(k => (
                    <div key={k}><span className="text-xs text-gray-400">{t(`glossaries.vorschlaege.feld.${k}`)}: </span>
                      <span className="bg-amber-50">{wert(v.daten[k])}</span></div>
                  ))}
                </td>
                <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                  <div>{v.von}</div>
                  <div>{new Date(v.am).toLocaleString(i18n.language)}</div>
                  <div>{t(`glossaries.vorschlaege.quelle.${v.quelle === 'terminologie-scan' ? 'scan' : v.quelle}`)}</div>
                </td>
                {istAdmin && (
                  <td className="px-4 py-2 whitespace-nowrap text-right">
                    {v.status === 'in_arbeit' && <p className="mb-1 text-xs text-gray-500">{t('glossaries.vorschlaege.inArbeit')}</p>}
                    <button type="button" disabled={busy !== null || v.status === 'in_arbeit'} onClick={() => entscheide(v, 'freigeben')}
                      className="text-xs px-2.5 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300">
                      {t('glossaries.vorschlaege.freigeben')}
                    </button>
                    <button type="button" disabled={busy !== null || v.status === 'in_arbeit'} onClick={() => entscheide(v, 'verwerfen')}
                      className="ml-2 text-xs px-2.5 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      {t('glossaries.vorschlaege.verwerfen')}
                    </button>
                    {fehler?.id === v.id && <p className="mt-1 text-xs text-red-700" role="alert">{fehler.text}</p>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
