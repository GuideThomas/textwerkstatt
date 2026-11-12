import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import LanguageSwitcher from '../LanguageSwitcher';

interface Stats {
  total: number;
  translated: number;
  condensed: number;
  approved: number;
  edited: number;
  needs_review: number;
  total_cache_hits: number;
}

interface TokenStats {
  totalCost: number;
  totalCalls: number;
}

interface NativeSpeaker {
  id: string;
  name: string;
  email: string;
  languages: string[];
}

const FILE_TYPE_LABELS: Record<string, string> = {
  idml: 'IDML',
  docx: 'DOCX',
  xlsx: 'XLSX',
  pdf: 'PDF',
};

interface Props {
  projectId: string;
  projectName: string;
  fileType?: string;
  targetLang?: string;
  onBack: () => void;
  onDownload: () => void;
  onRequestSent?: () => void;
}

export default function ReviewStatsBar({ projectId, projectName, fileType, targetLang, onBack, onDownload, onRequestSent }: Props) {
  const { t } = useTranslation('review');
  const [stats, setStats] = useState<Stats | null>(null);
  const [tokenStats, setTokenStats] = useState<TokenStats | null>(null);
  const [speakers, setSpeakers] = useState<NativeSpeaker[]>([]);
  const [selectedSpeakers, setSelectedSpeakers] = useState<Set<string>>(new Set());
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [requestMessage, setRequestMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/projects/${projectId}/segments/stats`).then(r => r.json()),
      fetch(`/api/projects/${projectId}/token-usage`).then(r => r.json()),
    ]).then(([s, t]) => {
      setStats(s);
      setTokenStats(t);
    });
  }, [projectId]);

  useEffect(() => {
    if (!targetLang) return;
    fetch(`/api/native-speakers?language=${encodeURIComponent(targetLang)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: NativeSpeaker[]) => setSpeakers(rows))
      .catch(() => setSpeakers([]));
  }, [targetLang]);

  // COUNT() kommt aus Postgres als Text — ohne Number() wurde aus 50 + 0 „500“.
  const reviewed = stats ? (Number(stats.approved) || 0) + (Number(stats.edited) || 0) : 0;

  const toggleSpeaker = (id: string) => {
    setSelectedSpeakers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sendRequest = async () => {
    if (selectedSpeakers.size === 0) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch('/api/native-speakers/request-review', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          speaker_ids: Array.from(selectedSpeakers),
          message: requestMessage.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendResult({ ok: false, msg: data.error || t('request.failed') });
        return;
      }
      const results: Array<{ speaker_name: string; ok: boolean }> = data.results || [];
      const okNames = results.filter(r => r.ok).map(r => r.speaker_name);
      const failedNames = results.filter(r => !r.ok).map(r => r.speaker_name);
      setSendResult({
        ok: failedNames.length === 0,
        msg: t('request.sent', { names: okNames.join(', ') })
          + (failedNames.length ? ' ' + t('request.notDelivered', { names: failedNames.join(', ') }) : ''),
      });
      setShowRequestForm(false);
      setRequestMessage('');
      setSelectedSpeakers(new Set());
      onRequestSent?.();
    } catch (e: any) {
      setSendResult({ ok: false, msg: e.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-white border-b px-4 py-2 flex items-center justify-between sticky top-0 z-10">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="text-gray-500 hover:text-gray-700 text-sm">
          &larr; {t('actions.back')}
        </button>
        <span className="font-semibold text-sm truncate max-w-xs">{projectName}</span>
      </div>

      <div className="flex items-center gap-6 text-xs text-gray-500">
        {stats && (
          <>
            <span>
              <Trans t={t} i18nKey="stats.checked" values={{ done: reviewed, total: stats.total }}
                     components={{ n: <span className="font-medium text-gray-700" /> }} />
            </span>
            {stats.condensed > 0 && (
              <span>
                <Trans t={t} i18nKey="stats.condensed" values={{ count: stats.condensed }}
                       components={{ n: <span className="text-amber-600 font-medium" /> }} />
              </span>
            )}
            {stats.needs_review > 0 && (
              <span>
                <Trans t={t} i18nKey="stats.needsReview" values={{ count: stats.needs_review }}
                       components={{ n: <span className="text-red-600 font-medium" /> }} />
              </span>
            )}
            <span>
              <Trans t={t} i18nKey="stats.cacheHits" values={{ count: stats.total_cache_hits || 0 }}
                     components={{ n: <span className="font-medium" /> }} />
            </span>
          </>
        )}
        {tokenStats && tokenStats.totalCost > 0 && (
          <span>LLM: ${tokenStats.totalCost.toFixed(4)}</span>
        )}
      </div>

      <div className="flex items-center gap-2 relative">
        {/* Reviewer kommen per Mail-Link direkt hierher, ohne die Kopfleiste der App —
            ohne Umschalter hier könnten sie die Sprache nicht wechseln. */}
        <LanguageSwitcher variant="light" />
        <button
          onClick={() => setShowShortcuts(v => !v)}
          className="text-xs text-gray-600 border border-gray-200 px-2 py-1.5 rounded hover:bg-gray-50"
          title={t('shortcuts.buttonTitle')}
        >
          ⌨ {t('shortcuts.button')}
        </button>

        {speakers.length > 0 && (
          <button
            onClick={() => setShowRequestForm(v => !v)}
            className="text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-1.5 rounded hover:bg-amber-100"
            title={t('request.title')}
          >
            ✉ {t('request.button')}
          </button>
        )}

        {showShortcuts && (
          <div className="absolute top-full right-0 mt-2 w-80 bg-white border border-gray-200 shadow-lg rounded-lg p-4 z-20">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-900">{t('shortcuts.title')}</h4>
              <button onClick={() => setShowShortcuts(false)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
            </div>
            <table className="w-full text-xs">
              <tbody className="divide-y divide-gray-100">
                {[
                  { keys: ['J', '↓'], label: t('shortcuts.next') },
                  { keys: ['K', '↑'], label: t('shortcuts.previous') },
                  { keys: [t('shortcuts.spaceKey')], label: t('shortcuts.approveNext') },
                  { keys: ['E', 'Enter'], label: t('shortcuts.edit') },
                  { keys: ['?'], label: t('shortcuts.clarification') },
                  { keys: ['Tab'], label: t('shortcuts.nextReview') },
                  { keys: ['Esc'], label: t('shortcuts.cancelEdit') },
                ].map((row, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {row.keys.map((k, j) => (
                        <span key={j}>
                          <kbd className="px-1.5 py-0.5 bg-gray-100 border border-gray-300 rounded text-[10px] font-mono">{k}</kbd>
                          {j < row.keys.length - 1 && <span className="text-gray-400 mx-1">/</span>}
                        </span>
                      ))}
                    </td>
                    <td className="py-1.5 text-gray-700">{row.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-500 mt-3 leading-relaxed">
              <Trans t={t} i18nKey="shortcuts.bonus" components={{ b: <strong /> }} />
            </p>
          </div>
        )}

        <button
          onClick={onDownload}
          className="bg-primary-600 text-white px-3 py-1.5 rounded text-sm hover:bg-primary-700 transition-colors"
        >
          {t('download.button', { format: FILE_TYPE_LABELS[fileType || 'idml'] || fileType?.toUpperCase() || t('download.fileFallback') })}
        </button>

        {showRequestForm && (
          <div className="absolute top-full right-0 mt-2 w-96 bg-white border border-gray-200 shadow-lg rounded-lg p-4 z-20">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-900">{t('request.title')}</h4>
              <button onClick={() => setShowRequestForm(false)} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              {t('request.intro')}
            </p>

            <div className="block text-xs font-medium text-gray-700 mb-1">
              {t('request.speakersLabel', { lang: targetLang })}
            </div>
            <div className="max-h-48 overflow-y-auto border border-gray-300 rounded mb-3 divide-y divide-gray-100">
              {speakers.map((s) => (
                <label key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedSpeakers.has(s.id)}
                    onChange={() => toggleSpeaker(s.id)}
                  />
                  <span className="text-gray-900">{s.name}</span>
                  <span className="text-gray-500 text-xs truncate">{s.email}</span>
                </label>
              ))}
            </div>

            <label className="block text-xs font-medium text-gray-700 mb-1">
              {t('request.messageLabel')}
            </label>
            <textarea
              value={requestMessage}
              onChange={(e) => setRequestMessage(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={t('request.messagePlaceholder')}
              className="w-full text-sm px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
            />

            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setShowRequestForm(false)}
                className="text-xs text-gray-600 px-3 py-1.5 hover:underline"
              >
                {t('actions.cancel')}
              </button>
              <button
                onClick={sendRequest}
                disabled={selectedSpeakers.size === 0 || sending}
                className="text-xs bg-primary-600 text-white px-4 py-1.5 rounded hover:bg-primary-700 disabled:bg-gray-300"
              >
                {sending
                  ? t('request.sending')
                  : selectedSpeakers.size > 1 ? t('request.sendToMany', { count: selectedSpeakers.size }) : t('request.send')}
              </button>
            </div>
          </div>
        )}
      </div>

      {sendResult && (
        <div
          className={`absolute top-full right-4 mt-2 px-3 py-2 rounded text-xs shadow-lg border ${
            sendResult.ok
              ? 'bg-green-50 text-green-800 border-green-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
          role="status"
        >
          {sendResult.msg}
          <button onClick={() => setSendResult(null)} className="ml-3 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}
    </div>
  );
}
