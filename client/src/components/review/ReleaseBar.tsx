import { useEffect, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { currentLocale } from '../../i18n';

interface ReleaseInfo {
  released_by_name: string;
  released_by_email: string;
  released_at: string;
  segment_count: number;
  revoked_at: string | null;
  revoked_reason: string | null;
  revoked_by_name: string | null;
}

export interface ReleaseStatus {
  released: boolean;
  release: ReleaseInfo | null;
  last_revoked: ReleaseInfo | null;
  invitations: Array<{ speaker_name: string; speaker_email: string; sent_at: string }>;
  readiness: { translated: number; approved: number; open: number; clarification: number; ready: boolean };
  viewer_is_reviewer: boolean;
  can_release: boolean;
}

// Grund-Code aus der DB → Übersetzungsschlüssel (Namespace `review`).
const REVOKE_REASONS: Record<string, string> = {
  text_changed: 'release.revokeReason.textChanged',
  unapproved: 'release.revokeReason.unapproved',
  clarification: 'release.revokeReason.clarification',
};

function formatTs(ts: string | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(currentLocale(), {
    timeZone: 'Europe/Vienna',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export async function fetchReleaseStatus(projectId: string): Promise<ReleaseStatus | null> {
  const res = await fetch(`/api/projects/${projectId}/release`, { credentials: 'include' });
  return res.ok ? res.json() : null;
}

interface Props {
  projectId: string;
  /** Ändert sich bei jeder Aktion, die die Freigabe berühren kann. */
  refreshKey: string;
  onStatus?: (status: ReleaseStatus | null) => void;
}

/**
 * Freigabe-Leiste im Review-Editor: zeigt, ob und von wem die Übersetzung
 * freigegeben ist, und lässt angefragte Reviewer freigeben.
 */
export default function ReleaseBar({ projectId, refreshKey, onStatus }: Props) {
  const { t } = useTranslation('review');
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const load = async () => {
    const s = await fetchReleaseStatus(projectId).catch(() => null);
    setStatus(s);
    onStatusRef.current?.(s);
  };

  // Im Flow-Modus wird Segment für Segment abgehakt — nicht jede Taste einzeln abfragen.
  useEffect(() => {
    const t = setTimeout(load, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshKey]);

  const release = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/release`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('release.failed'));
      } else if (data.mail_failures?.length) {
        setError(t('release.mailFailures', { names: data.mail_failures.join(', ') }));
      }
      setConfirming(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const { release: rel, last_revoked: revoked, readiness, invitations } = status;

  // Ohne Anfrage und ohne Freigabe-Historie gibt es nichts zu zeigen.
  if (!rel && !revoked && invitations.length === 0) return null;

  const blockers: string[] = [];
  if (readiness.open > 0) blockers.push(t('release.blockerOpen', { count: readiness.open }));
  if (readiness.clarification > 0) blockers.push(t('release.blockerClarification', { count: readiness.clarification }));

  return (
    <div
      className={`border-b px-4 py-2 text-sm ${
        rel ? 'bg-green-50 border-green-200' : revoked ? 'bg-amber-50 border-amber-200' : 'bg-white'
      }`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        {rel ? (
          <span className="text-green-800">
            <Trans
              t={t}
              i18nKey="release.releasedBy"
              values={{ name: rel.released_by_name, date: formatTs(rel.released_at) }}
              components={{ b: <span className="font-semibold" /> }}
            />
          </span>
        ) : (
          <span className="text-gray-700">
            <span className="font-semibold">{t('release.notReleased')}</span>
            {revoked && (
              <span className="text-amber-800">
                {' '}· {t('release.revoked', { name: revoked.released_by_name, date: formatTs(revoked.revoked_at) })}
                {revoked.revoked_reason && ' ' + (revoked.revoked_by_name
                  ? t('release.revokedReasonBy', {
                      reason: REVOKE_REASONS[revoked.revoked_reason] ? t(REVOKE_REASONS[revoked.revoked_reason]) : revoked.revoked_reason,
                      by: revoked.revoked_by_name,
                    })
                  : t('release.revokedReason', {
                      reason: REVOKE_REASONS[revoked.revoked_reason] ? t(REVOKE_REASONS[revoked.revoked_reason]) : revoked.revoked_reason,
                    }))}
              </span>
            )}
          </span>
        )}

        {!rel && invitations.length > 0 && (
          <span className="text-xs text-gray-500">
            {t('release.requested', { names: invitations.map((i) => i.speaker_name).join(', ') })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!rel && status.viewer_is_reviewer && !confirming && (
            <>
              {blockers.length > 0 && <span className="text-xs text-gray-500">{blockers.join(' · ')}</span>}
              <button
                onClick={() => setConfirming(true)}
                disabled={!status.can_release}
                className="text-sm bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 disabled:bg-gray-200 disabled:text-gray-500"
                title={status.can_release ? t('release.buttonTitle') : t('release.buttonTitleBlocked')}
              >
                {t('release.button')}
              </button>
            </>
          )}
          {confirming && (
            <>
              <span className="text-xs text-gray-700">
                {t('release.confirmText', { count: readiness.translated })}
              </span>
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="text-xs text-gray-600 px-2 py-1.5 hover:underline"
              >
                {t('actions.cancel')}
              </button>
              <button
                onClick={release}
                disabled={busy}
                className="text-sm bg-green-600 text-white px-3 py-1.5 rounded hover:bg-green-700 disabled:bg-gray-300"
              >
                {busy ? t('release.releasing') : t('release.confirmYes')}
              </button>
            </>
          )}
        </div>
      </div>
      {error && <div className="text-xs text-red-700 mt-1">{error}</div>}
    </div>
  );
}
