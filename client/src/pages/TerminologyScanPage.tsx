import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';
import ScanUpload from '../components/terminology-scan/ScanUpload';
import ScanProgress from '../components/terminology-scan/ScanProgress';
import PageHeader from '../components/PageHeader';

interface Scan {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  source_file_type: string;
  source_filename: string | null;
  translation_filename: string | null;
  status: string;
  total_segments: number;
  diff_segments: number;
  candidate_count: number;
  error: string | null;
  created_at: string;
}

interface Props {
  onNavigateToReview: (scanId: string, scanName: string) => void;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: 'scanStatus.pending', color: 'bg-gray-100 text-gray-700' },
  aligning: { label: 'scanStatus.aligning', color: 'bg-primary-100 text-primary-700' },
  translating: { label: 'scanStatus.translating', color: 'bg-yellow-100 text-yellow-700' },
  analyzing: { label: 'scanStatus.analyzing', color: 'bg-purple-100 text-purple-700' },
  completed: { label: 'scanStatus.completed', color: 'bg-green-100 text-green-700' },
  error: { label: 'scanStatus.error', color: 'bg-red-100 text-red-700' },
};

export default function TerminologyScanPage({ onNavigateToReview }: Props) {
  const { t } = useTranslation('terminology');
  const [scans, setScans] = useState<Scan[]>([]);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);

  const fetchScans = useCallback(async () => {
    try {
      const res = await fetch('/api/terminology-scan');
      if (res.ok) setScans(await res.json());
    } catch (err) {
      console.error('Failed to fetch scans:', err);
    }
  }, []);

  useEffect(() => {
    fetchScans();
    const interval = setInterval(fetchScans, 5000);
    return () => clearInterval(interval);
  }, [fetchScans]);

  const handleUploadComplete = (scanId: string) => {
    setActiveScanId(scanId);
    fetchScans();
  };

  const handleScanComplete = () => {
    setActiveScanId(null);
    fetchScans();
  };

  const handleDelete = async (scanId: string) => {
    if (!confirm(t('confirm.deleteScan'))) return;
    try {
      await fetch(`/api/terminology-scan/${scanId}`, { method: 'DELETE' });
      fetchScans();
    } catch (err) {
      console.error('Failed to delete scan:', err);
    }
  };

  const activeScan = scans.find(s => s.id === activeScanId);
  const isProcessing = activeScan && !['completed', 'error'].includes(activeScan.status);

  return (
    <div className="space-y-6">
      <PageHeader title={t('page.title')} subtitle={t('page.subtitle')} />
      {/* Upload */}
      <ScanUpload onUploadComplete={handleUploadComplete} disabled={!!isProcessing} />

      {/* Fortschritt */}
      {activeScanId && isProcessing && (
        <ScanProgress scanId={activeScanId} onComplete={handleScanComplete} />
      )}

      {/* Scan-Liste */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-medium text-gray-900">{t('list.title')}</h3>
        </div>
        {scans.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">
            {t('list.empty')}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {scans.map(scan => {
              const status = STATUS_LABELS[scan.status] || STATUS_LABELS.pending;
              return (
                <div key={scan.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-50">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900 truncate">{scan.name}</span>
                      <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded ${status.color}`}>
                        {t(status.label)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                      <span>{scan.source_lang} → {scan.target_lang}</span>
                      <span>{scan.source_file_type.toUpperCase()}</span>
                      {scan.total_segments > 0 && (
                        <span>{t('list.segments', { count: scan.total_segments })}</span>
                      )}
                      {scan.status === 'completed' && (
                        <span className="text-purple-600 font-medium">
                          {t('list.candidates', { count: scan.candidate_count, diffs: scan.diff_segments })}
                        </span>
                      )}
                      {scan.error && (
                        <span className="text-red-500 truncate max-w-xs">{scan.error}</span>
                      )}
                      <span>{new Date(scan.created_at).toLocaleDateString(currentLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    {scan.status === 'completed' && scan.candidate_count > 0 && (
                      <button
                        onClick={() => onNavigateToReview(scan.id, scan.name)}
                        className="px-3 py-1 text-xs font-medium text-primary-700 bg-primary-50 rounded-md hover:bg-primary-100"
                      >
                        {t('list.review')}
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(scan.id)}
                      className="px-2 py-1 text-xs text-gray-400 hover:text-red-500"
                      title={t('list.delete')}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
