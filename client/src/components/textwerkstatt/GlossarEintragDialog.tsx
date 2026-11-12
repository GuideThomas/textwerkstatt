import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Glossar-Schnelleintrag der Textwerkstatt (früher in der Schnellübersetzung, bis
 * 10.11.2026). Schreibt über `POST /api/glossaries/quickadd`; die Route selbst bleibt
 * unverändert (PLAN-textwerkstatt.md G6, Berührungspunkt Wortliste).
 */

export interface GlossarEntwurf {
  source: string;
  target: string;
  channel: string;
}

interface Props {
  entwurf: GlossarEntwurf;
  sourceLang: string;
  targetLang: string;
  channels: Array<{ code: string; name: string }>;
  langName: (code: string) => string;
  onClose: () => void;
}

export default function GlossarEintragDialog({ entwurf, sourceLang, targetLang, channels, langName, onClose }: Props) {
  const { t } = useTranslation('quick');
  const [source, setSource] = useState(entwurf.source);
  const [target, setTarget] = useState(entwurf.target);
  const [channel, setChannel] = useState(entwurf.channel);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Farbe der Meldung über ein eigenes Kennzeichen, nicht über den Wortlaut — der ist übersetzt.
  const [messageIsError, setMessageIsError] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const handleSave = async () => {
    if (!source.trim() || !target.trim()) {
      setMessage(t('errors.fillBoth'));
      setMessageIsError(true);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/glossaries/quickadd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_term: source.trim(),
          target_term: target.trim(),
          source_lang: sourceLang,
          target_lang: targetLang,
          channel_code: channel || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || t('errors.http', { status: res.status }));
      }
      const data = await res.json();
      setMessage(
        data.action === 'created' ? t('editor.created') :
        data.action === 'updated' ? t('editor.updated') :
        data.action === 'vorschlag' ? t('editor.vorschlag') :
        t('editor.unchanged'),
      );
      setMessageIsError(false);
      closeTimer.current = setTimeout(onClose, 1200);
    } catch (err: any) {
      setMessage(err.message || t('errors.saveFailed'));
      setMessageIsError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-lg w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('editor.title')}
      >
        <h2 className="text-base font-semibold text-gray-800 mb-3">{t('editor.title')}</h2>

        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-500 mb-1">
            {t('editor.source', { lang: langName(sourceLang) })}
          </label>
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
            placeholder={t('editor.sourcePlaceholder')}
          />
        </div>

        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-500 mb-1">
            {t('editor.target', { lang: langName(targetLang) })}
          </label>
          <input
            type="text"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
            placeholder={t('editor.targetPlaceholder')}
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('channel.label')}</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="w-full text-sm border border-gray-300 rounded px-3 py-1.5"
          >
            <option value="">{t('channel.default')}</option>
            {channels.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            {channel ? t('editor.channelOverrideHint', { channel }) : t('editor.standardHint')}
          </p>
        </div>

        {message && (
          <div className={`text-xs mb-3 ${messageIsError ? 'text-red-600' : 'text-green-600'}`}>{message}</div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-sm text-gray-600 hover:text-gray-800 px-3 py-1.5"
          >
            {t('editor.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !source.trim() || !target.trim()}
            className="text-sm bg-primary-600 text-white font-semibold px-4 py-1.5 rounded hover:bg-primary-700 disabled:opacity-40"
          >
            {saving ? t('editor.saving') : t('editor.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
