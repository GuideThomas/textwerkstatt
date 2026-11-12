import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import PageHeader from '../components/PageHeader';

/**
 * Verbindungen des Illustrator-Panels (28.10.2026, PLAN-panel-anmeldung.md P2).
 *
 * Ohne `all`: die eigenen Rechner — erreichbar über das Personen-Kürzel in der
 * Kopfleiste. Mit `all` (Verwaltung): alle Verbindungen, mit Person.
 * „Trennen" macht den Schlüssel sofort ungültig; das Panel meldet sich dann ab.
 */

interface PanelToken {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  expired: boolean;
  user_name: string;
  user_email: string;
}

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T | null> {
  const res = await fetch(`/api${endpoint}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: i18n.t('panel:connections.error') }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : null);

export default function PanelConnectionsPage({ all = false }: { all?: boolean }) {
  const { t } = useTranslation('panel');
  const [tokens, setTokens] = useState<PanelToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await apiFetch<{ tokens: PanelToken[] }>(`/panel/tokens${all ? '?all=1' : ''}`);
      setTokens(data?.tokens ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  const revoke = async (tok: PanelToken) => {
    if (!window.confirm(t('connections.confirmRevoke', { label: tok.label || t('connect.deviceUnknown') }))) return;
    try {
      await apiFetch(`/panel/tokens/${tok.id}`, { method: 'DELETE' });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const table = (
    <>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
      {loading ? (
        <div className="text-sm text-gray-500">{t('connections.loading')}</div>
      ) : tokens.length === 0 ? (
        <div className="text-sm text-gray-500">{t('connections.empty')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
                <th className="py-2 pr-4">{t('connections.colDevice')}</th>
                {all && <th className="py-2 pr-4">{t('connections.colUser')}</th>}
                <th className="py-2 pr-4">{t('connections.colCreated')}</th>
                <th className="py-2 pr-4">{t('connections.colLastUsed')}</th>
                <th className="py-2 pr-4">{t('connections.colExpires')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((tok) => (
                <tr key={tok.id} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium text-gray-800">{tok.label || t('connect.deviceUnknown')}</td>
                  {all && (
                    <td className="py-2 pr-4 text-gray-700" title={tok.user_email}>{tok.user_name}</td>
                  )}
                  <td className="py-2 pr-4 text-gray-600">{fmt(tok.created_at)}</td>
                  <td className="py-2 pr-4 text-gray-600">{fmt(tok.last_used_at) ?? t('connections.never')}</td>
                  <td className={`py-2 pr-4 ${tok.expired ? 'text-red-600' : 'text-gray-600'}`}>
                    {tok.expired ? t('connections.expired') : fmt(tok.expires_at)}
                  </td>
                  <td className="py-2 text-right">
                    <button type="button" className="btn-danger" onClick={() => revoke(tok)}>
                      {t('connections.revoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  if (all) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-4">{t('connections.adminTitle')}</h3>
        {table}
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t('connections.title')} subtitle={t('connections.subtitle')} />
      <div className="card card-content">
        <p className="text-sm text-gray-600 mb-4">{t('connections.howto')}</p>
        {table}
      </div>
    </div>
  );
}
