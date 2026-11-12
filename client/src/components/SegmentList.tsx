import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface SegmentData {
  id: string;
  idml_segment_id: string;
  story_file: string | null;
  paragraph_index: number | null;
  max_chars: number | null;
  position: number;
  source_text: string;
  translated_text: string | null;
  condensed_text: string | null;
  hit_count: number;
  is_stale: boolean;
}

interface SegmentStats {
  total: number;
  translated: number;
  condensed: number;
  stale: number;
  total_cache_hits: number;
  avg_source_length: number;
}

interface Props {
  projectId: string;
  segmentCount: number;
}

export default function SegmentList({ projectId, segmentCount }: Props) {
  const { t } = useTranslation('common');
  const [segments, setSegments] = useState<SegmentData[]>([]);
  const [stats, setStats] = useState<SegmentStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [segRes, statsRes] = await Promise.all([
          fetch(`/api/projects/${projectId}/segments?limit=50`),
          fetch(`/api/projects/${projectId}/segments/stats`),
        ]);

        if (segRes.ok) {
          const data = await segRes.json();
          setSegments(data.segments);
        }
        if (statsRes.ok) {
          setStats(await statsRes.json());
        }
      } catch (err) {
        console.error('Failed to load segments:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [projectId]);

  if (loading) {
    return <div className="px-6 py-3 text-sm text-gray-400">{t('segments.loading')}</div>;
  }

  return (
    <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
      {/* Stats */}
      {stats && (
        <div className="flex gap-4 mb-4 text-xs text-gray-500">
          <span>{t('segments.count', { count: stats.total })}</span>
          <span>{t('segments.translated', { count: stats.translated })}</span>
          {stats.condensed > 0 && <span>{t('segments.condensed', { count: stats.condensed })}</span>}
          {stats.total_cache_hits > 0 && <span>{t('segments.cacheHits', { count: stats.total_cache_hits })}</span>}
          {stats.avg_source_length && <span>{t('segments.avgLength', { value: stats.avg_source_length })}</span>}
        </div>
      )}

      {/* Segment-Tabelle */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {segments.map((seg, idx) => (
          <div key={seg.id} className="bg-white rounded border border-gray-200 p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-gray-400">#{idx + 1}</span>
                  <span className="text-xs text-gray-400">{seg.idml_segment_id}</span>
                  {seg.max_chars && (
                    <span className="text-xs text-gray-300">{t('segments.maxChars', { count: seg.max_chars })}</span>
                  )}
                </div>
                <p className="text-sm text-gray-800 break-words">{seg.source_text}</p>
                {seg.translated_text && (
                  <p className="text-sm text-primary-700 mt-1 break-words">
                    {seg.condensed_text || seg.translated_text}
                  </p>
                )}
              </div>
              <div className="flex-shrink-0">
                {seg.translated_text ? (
                  <span className="inline-block w-2 h-2 rounded-full bg-green-400" title={t('segments.statusTranslated')} />
                ) : (
                  <span className="inline-block w-2 h-2 rounded-full bg-gray-300" title={t('segments.statusPending')} />
                )}
              </div>
            </div>
          </div>
        ))}
        {segmentCount > 50 && (
          <p className="text-xs text-gray-400 text-center py-2">
            {t('segments.showingOf', { shown: 50, total: segmentCount })}
          </p>
        )}
      </div>
    </div>
  );
}
