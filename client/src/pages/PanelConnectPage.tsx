import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

/**
 * Bestätigungsseite der Panel-Kopplung (28.10.2026, PLAN-panel-anmeldung.md P2).
 *
 * Das Panel öffnet `/?panel=<id>` im Browser; App.tsx parkt die ID über den
 * Microsoft-Login hinweg (wie `?review=`) und zeigt danach diese Seite. Die
 * Person vergleicht den Code mit dem im Panel und bestätigt. Der Warnhinweis
 * ist die eigentliche Schranke gegen einen untergeschobenen Kopplungslink:
 * Wer bestätigt, lässt ein fremdes Panel in seinem Namen übersetzen.
 */

interface Pairing {
  code: string;
  label: string | null;
  expiresAt: string;
  state: 'pending' | 'confirmed' | 'used' | 'expired';
  confirmedByMe: boolean;
}

type View = 'loading' | 'ask' | 'done' | 'cancelled' | 'expired' | 'used' | 'confirmedOther' | 'error';

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${endpoint}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || i18n.t('panel:connections.error')), { status: res.status });
  return data as T;
}

function viewOf(p: Pairing): View {
  if (p.state === 'pending') return 'ask';
  if (p.state === 'expired') return 'expired';
  if (p.state === 'used') return p.confirmedByMe ? 'done' : 'used';
  return p.confirmedByMe ? 'done' : 'confirmedOther';
}

export default function PanelConnectPage({ pairingId, onClose }: { pairingId: string; onClose: () => void }) {
  const { t } = useTranslation('panel');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [view, setView] = useState<View>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    apiFetch<Pairing>(`/panel/pairings/${encodeURIComponent(pairingId)}`)
      .then((p) => { setPairing(p); setView(viewOf(p)); })
      .catch((e) => { setError(e.message); setView('error'); });
  }, [pairingId]);

  // Restlaufzeit mitzählen; läuft sie ab, ist die Anfrage verfallen.
  useEffect(() => {
    if (view !== 'ask') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view]);
  const secondsLeft = pairing ? Math.max(0, Math.floor((new Date(pairing.expiresAt).getTime() - now) / 1000)) : 0;
  useEffect(() => {
    if (view === 'ask' && pairing && secondsLeft === 0) setView('expired');
  }, [view, pairing, secondsLeft]);

  const confirm = async () => {
    setBusy(true);
    try {
      await apiFetch(`/panel/pairings/${encodeURIComponent(pairingId)}/confirm`, { method: 'POST' });
      setView('done');
    } catch (e: any) {
      if (e.status === 410) setView('expired');
      else if (e.status === 409) setView('confirmedOther');
      else { setError(e.message); setView('error'); }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    await apiFetch(`/panel/pairings/${encodeURIComponent(pairingId)}/cancel`, { method: 'POST' }).catch(() => {});
    setBusy(false);
    setView('cancelled');
  };

  const message = (titleKey: string, textKey: string, tone: 'ok' | 'info' | 'warn') => (
    <div className="text-center">
      <div className={`text-lg font-semibold mb-2 ${tone === 'ok' ? 'text-green-700' : tone === 'warn' ? 'text-amber-700' : 'text-gray-800'}`}>
        {t(titleKey)}
      </div>
      <p className="text-sm text-gray-600 mb-6">{t(textKey)}</p>
      <button type="button" className="btn-secondary" onClick={onClose}>{t('connect.continue')}</button>
    </div>
  );

  return (
    <div className="max-w-lg mx-auto">
      <div className="card card-content">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">{t('connect.title')}</h1>

        {view === 'loading' && <div className="text-sm text-gray-500 py-6">{t('connections.loading')}</div>}

        {view === 'ask' && pairing && (
          <>
            <p className="text-sm text-gray-600 mb-5">{t('connect.intro')}</p>
            <div className="text-xs uppercase tracking-wide text-gray-500">{t('connect.codeLabel')}</div>
            <div className="font-mono text-4xl font-bold tracking-[0.2em] text-[color:var(--pal-akzent-text)] my-2" aria-live="polite">
              {pairing.code}
            </div>
            <div className="text-sm text-gray-600 mb-1">
              {t('connect.device')}: <span className="font-medium text-gray-800">{pairing.label || t('connect.deviceUnknown')}</span>
            </div>
            <div className="text-xs text-gray-500 mb-5">
              {t('connect.expiresIn', { minutes: Math.floor(secondsLeft / 60), seconds: String(secondsLeft % 60).padStart(2, '0') })}
            </div>
            <div className="rounded-[5px] border border-amber-300 bg-amber-50 text-amber-900 text-sm p-3 mb-6">
              {t('connect.warning')}
            </div>
            <div className="flex gap-3 justify-end">
              <button type="button" className="btn-secondary" disabled={busy} onClick={cancel}>{t('connect.cancel')}</button>
              <button type="button" className="btn-primary" disabled={busy} onClick={confirm}>{t('connect.confirm')}</button>
            </div>
          </>
        )}

        {view === 'done' && message('connect.doneTitle', 'connect.doneText', 'ok')}
        {view === 'cancelled' && message('connect.cancelledTitle', 'connect.cancelledText', 'info')}
        {view === 'expired' && message('connect.expiredTitle', 'connect.expiredText', 'warn')}
        {view === 'used' && message('connect.usedTitle', 'connect.usedText', 'warn')}
        {view === 'confirmedOther' && message('connect.confirmedOtherTitle', 'connect.confirmedOtherText', 'warn')}
        {view === 'error' && (
          <div className="text-center">
            <p className="text-sm text-red-600 mb-6">{error}</p>
            <button type="button" className="btn-secondary" onClick={onClose}>{t('connect.continue')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
