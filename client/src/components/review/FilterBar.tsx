import { useTranslation } from 'react-i18next';

type FilterValue = 'all' | 'condensed' | 'review' | 'approved' | 'clarification' | 'edited';

interface Props {
  active: FilterValue;
  onChange: (filter: FilterValue) => void;
  counts?: {
    condensed: number;
    needs_review: number;
    approved: number;
    clarification: number;
    edited: number;
    total: number;
  };
  visibleCount?: number;
  onBulkApprove?: () => void;
  bulkBusy?: boolean;
}

// labelKey: Übersetzungsschlüssel im Namespace `review`
const FILTERS: { value: FilterValue; labelKey: string; color?: string }[] = [
  { value: 'all', labelKey: 'filter.all' },
  { value: 'condensed', labelKey: 'filter.condensed', color: 'text-amber-600' },
  { value: 'review', labelKey: 'filter.review', color: 'text-red-600' },
  { value: 'clarification', labelKey: 'filter.clarification', color: 'text-orange-600' },
  { value: 'edited', labelKey: 'filter.edited', color: 'text-purple-600' },
  { value: 'approved', labelKey: 'filter.approved', color: 'text-green-600' },
];

export default function FilterBar({ active, onChange, counts, visibleCount, onBulkApprove, bulkBusy }: Props) {
  const { t } = useTranslation('review');
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 bg-gray-50 border-b">
      <div className="flex gap-1 flex-wrap">
        {FILTERS.map(f => {
          const isActive = active === f.value;
          const count = counts ? (
            f.value === 'all' ? counts.total :
            f.value === 'condensed' ? counts.condensed :
            f.value === 'review' ? counts.needs_review :
            f.value === 'clarification' ? counts.clarification :
            f.value === 'edited' ? counts.edited :
            f.value === 'approved' ? counts.approved : 0
          ) : null;

          // Filter mit 0 Treffern ausblenden (ausser "Alle")
          if (f.value !== 'all' && count === 0) return null;

          return (
            <button
              key={f.value}
              onClick={() => onChange(f.value)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-primary-100 text-primary-700'
                  : 'text-gray-600 hover:bg-gray-200'
              }`}
            >
              {t(f.labelKey)}
              {count !== null && count > 0 && (
                <span className={`ml-1 ${f.color || ''}`}>({count})</span>
              )}
            </button>
          );
        })}
      </div>

      {onBulkApprove && visibleCount !== undefined && visibleCount > 0 && (
        <button
          onClick={onBulkApprove}
          disabled={bulkBusy}
          className="text-xs px-3 py-1 rounded font-medium bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 disabled:opacity-50 whitespace-nowrap"
          title={t('filter.bulkApproveTitle', { count: visibleCount })}
        >
          {bulkBusy ? t('filter.saving') : `✓ ${t('filter.bulkApprove', { count: visibleCount })}`}
        </button>
      )}
    </div>
  );
}

export type { FilterValue };
