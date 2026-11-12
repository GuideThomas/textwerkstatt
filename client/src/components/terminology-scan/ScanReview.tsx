import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface Candidate {
  id: string;
  source_text: string;
  existing_translation: string;
  deepl_translation: string;
  source_term: string;
  existing_term: string;
  deepl_term: string;
  category: string;
  confidence: number;
  explanation: string | null;
  status: string;
  position: number;
}

interface Stats {
  total: string;
  pending: string;
  approved: string;
  rejected: string;
  /** Von Nicht-Admins als Glossar-Vorschlag eingereicht (PLAN-glossar-freigabe.md). */
  vorgeschlagen?: string;
  terminology: string;
  style: string;
  error_cat: string;
  context: string;
}

interface Props {
  scanId: string;
  scanName: string;
  onBack: () => void;
}

const CATEGORY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  TERMINOLOGY: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'category.TERMINOLOGY' },
  STYLE: { bg: 'bg-primary-100', text: 'text-primary-700', label: 'category.STYLE' },
  ERROR: { bg: 'bg-red-100', text: 'text-red-700', label: 'category.ERROR' },
  CONTEXT: { bg: 'bg-gray-100', text: 'text-gray-700', label: 'category.CONTEXT' },
};

export default function ScanReview({ scanId, scanName, onBack }: Props) {
  const { t } = useTranslation('terminology');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('pending');
  const [loading, setLoading] = useState(true);

  const fetchCandidates = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterCategory) params.set('category', filterCategory);
      if (filterStatus) params.set('status', filterStatus);
      params.set('limit', '500');

      const res = await fetch(`/api/terminology-scan/${scanId}/candidates?${params}`);
      if (res.ok) {
        const data = await res.json();
        setCandidates(data.candidates);
        setStats(data.stats);
      }
    } catch (err) {
      console.error('Failed to fetch candidates:', err);
    } finally {
      setLoading(false);
    }
  }, [scanId, filterCategory, filterStatus]);

  useEffect(() => {
    fetchCandidates();
  }, [fetchCandidates]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === candidates.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(candidates.map(c => c.id)));
    }
  };

  const handleBulkAction = async (action: 'approve' | 'reject', ids?: string[]) => {
    const targetIds = ids || Array.from(selected);
    if (targetIds.length === 0) return;

    try {
      const res = await fetch(`/api/terminology-scan/${scanId}/candidates/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: targetIds }),
      });

      if (res.ok) {
        // Nicht-Admins übernehmen nicht, sie schlagen vor (PLAN-glossar-freigabe.md).
        const body = await res.json().catch(() => null);
        if (body?.vorschlag) alert(t('review.vorschlagMeldung', { n: body.vorgeschlagen ?? 0 }));
        setSelected(new Set());
        fetchCandidates();
      } else {
        const body = await res.json().catch(() => null);
        alert(body?.error ?? res.status);
      }
    } catch (err) {
      console.error(`Failed to ${action} candidates:`, err);
    }
  };

  const approveAllTerminology = async () => {
    // Alle TERMINOLOGY-Kandidaten mit pending Status genehmigen
    const termIds = candidates.filter(c => c.category === 'TERMINOLOGY' && c.status === 'pending').map(c => c.id);
    if (termIds.length === 0) return;
    if (!confirm(t('confirm.approveTerminology', { count: termIds.length }))) return;
    await handleBulkAction('approve', termIds);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between max-w-full">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← {t('review.back')}
            </button>
            <span className="text-sm font-medium text-gray-900">{scanName}</span>
          </div>

          {/* Stats */}
          {stats && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-gray-500">{t('review.stats.total', { n: stats.total })}</span>
              <span className="text-purple-600">{t('review.stats.terminology', { n: stats.terminology })}</span>
              <span className="text-primary-700">{t('review.stats.style', { n: stats.style })}</span>
              <span className="text-red-600">{t('review.stats.error', { n: stats.error_cat })}</span>
              <span className="text-gray-500">{t('review.stats.context', { n: stats.context })}</span>
              <span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-xs">{t('review.stats.approved', { n: stats.approved })}</span>
              <span className="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-xs">{t('review.stats.rejected', { n: stats.rejected })}</span>
              {Number(stats.vorgeschlagen ?? 0) > 0 && <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-xs">{t('review.stats.vorgeschlagen', { n: stats.vorgeschlagen })}</span>}
            </div>
          )}
        </div>
      </header>

      {/* Filter + Actions */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <select
            value={filterCategory}
            onChange={e => setFilterCategory(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="">{t('review.filter.allCategories')}</option>
            <option value="TERMINOLOGY">{t('category.TERMINOLOGY')}</option>
            <option value="STYLE">{t('category.STYLE')}</option>
            <option value="ERROR">{t('category.ERROR')}</option>
            <option value="CONTEXT">{t('category.CONTEXT')}</option>
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="">{t('review.filter.allStatus')}</option>
            <option value="pending">{t('candidateStatus.pending')}</option>
            <option value="approved">{t('candidateStatus.approved')}</option>
            <option value="vorgeschlagen">{t('candidateStatus.vorgeschlagen')}</option>
            <option value="rejected">{t('candidateStatus.rejected')}</option>
          </select>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {selected.size > 0 && (
            <>
              <span className="text-xs text-gray-500">{t('review.selectedCount', { count: selected.size })}</span>
              <button
                onClick={() => handleBulkAction('approve')}
                className="px-2.5 py-1 text-xs font-medium text-green-700 bg-green-50 rounded hover:bg-green-100"
              >
                {t('review.approve')}
              </button>
              <button
                onClick={() => handleBulkAction('reject')}
                className="px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100"
              >
                {t('review.reject')}
              </button>
            </>
          )}
          <button
            onClick={approveAllTerminology}
            className="px-2.5 py-1 text-xs font-medium text-primary-700 bg-primary-50 rounded hover:bg-primary-100"
          >
            {t('review.approveAllTerminology')}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="text-center py-12 text-gray-500">{t('review.loading')}</div>
        ) : candidates.length === 0 ? (
          <div className="text-center py-12 text-gray-500">{t('review.empty')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === candidates.length && candidates.length > 0}
                    onChange={toggleAll}
                    className="rounded"
                  />
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-8">#</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">{t('review.table.source')}</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">{t('review.table.existing')}</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">{t('review.table.deeplRef')}</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">{t('review.table.term')}</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-24">{t('review.table.category')}</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-16">{t('review.table.confidence')}</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-24">{t('review.table.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {candidates.map((c, idx) => {
                const cat = CATEGORY_STYLES[c.category] || CATEGORY_STYLES.CONTEXT;
                const isSelected = selected.has(c.id);
                const isPending = c.status === 'pending';

                return (
                  <tr
                    key={c.id}
                    className={`hover:bg-gray-50 ${isSelected ? 'bg-primary-50' : ''} ${!isPending ? 'opacity-60' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(c.id)}
                        className="rounded"
                        disabled={!isPending}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-400">{idx + 1}</td>
                    <td className="px-3 py-2 text-xs text-gray-700 max-w-xs truncate" title={c.source_text}>
                      {c.source_text.slice(0, 80)}{c.source_text.length > 80 ? '...' : ''}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700 max-w-xs truncate" title={c.existing_translation}>
                      {c.existing_translation.slice(0, 80)}{c.existing_translation.length > 80 ? '...' : ''}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 max-w-xs truncate" title={c.deepl_translation}>
                      {c.deepl_translation.slice(0, 80)}{c.deepl_translation.length > 80 ? '...' : ''}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs">
                        <span className="font-medium text-gray-900">{c.source_term}</span>
                        <span className="text-gray-400 mx-1">→</span>
                        <span className="font-medium text-purple-700">{c.existing_term}</span>
                      </div>
                      <div className="text-xs text-gray-400">
                        {t('review.insteadOf', { term: c.deepl_term })}
                      </div>
                      {c.explanation && (
                        <div className="text-xs text-gray-400 mt-0.5 italic" title={c.explanation}>
                          {c.explanation.slice(0, 60)}{c.explanation.length > 60 ? '...' : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded ${cat.bg} ${cat.text}`}>
                        {t(cat.label)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <div className="w-8 bg-gray-200 rounded-full h-1.5">
                          <div
                            className="h-1.5 rounded-full bg-primary-500"
                            style={{ width: `${c.confidence * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">{(c.confidence * 100).toFixed(0)}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {isPending ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleBulkAction('approve', [c.id])}
                            className="p-1 text-green-600 hover:bg-green-50 rounded"
                            title={t('review.approve')}
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => handleBulkAction('reject', [c.id])}
                            className="p-1 text-red-500 hover:bg-red-50 rounded"
                            title={t('review.reject')}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <span className={`text-xs ${c.status === 'approved' ? 'text-green-600' : c.status === 'vorgeschlagen' ? 'text-amber-600' : 'text-red-500'}`}>
                          {c.status === 'approved' ? t('candidateStatus.approved') : c.status === 'vorgeschlagen' ? t('candidateStatus.vorgeschlagen') : t('candidateStatus.rejected')}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
