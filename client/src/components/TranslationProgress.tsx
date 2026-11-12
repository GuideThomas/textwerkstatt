import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface ProgressEvent {
  phase: string;
  progress: number;
  detail: string;
  cacheHits?: number;
  translated?: number;
  total?: number;
}

interface TranslationProgressProps {
  projectId: string;
  status: string;
}

// Phase (vom Server) → Übersetzungsschlüssel im Namespace common.
const PHASE_KEYS: Record<string, string> = {
  connected: 'progress.phases.connected',
  parsing: 'progress.phases.parsing',
  translating: 'progress.phases.translating',
  finalizing: 'progress.phases.finalizing',
  completed: 'progress.phases.completed',
  error: 'progress.phases.error',
};

export default function TranslationProgress({ projectId, status }: TranslationProgressProps) {
  const { t } = useTranslation('common');
  const [progress, setProgress] = useState<ProgressEvent | null>(null);

  useEffect(() => {
    // Nur bei aktiven Status SSE verbinden
    if (!['processing', 'translating', 'condensing'].includes(status)) return;

    const eventSource = new EventSource(`/api/projects/${projectId}/progress`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ProgressEvent;
        setProgress(data);

        // Bei completed/error EventSource schließen
        if (data.phase === 'completed' || data.phase === 'error') {
          eventSource.close();
        }
      } catch {
        // Parsing-Fehler ignorieren
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => eventSource.close();
  }, [projectId, status]);

  if (!progress || !['processing', 'translating', 'condensing'].includes(status)) {
    return null;
  }

  const cacheHitsPct = progress.cacheHits !== undefined && progress.total
    ? Math.round((progress.cacheHits / progress.total) * 100)
    : null;

  return (
    <div className="px-6 py-3 bg-primary-50 border-t border-primary-100">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-primary-700">
          {PHASE_KEYS[progress.phase] ? t(PHASE_KEYS[progress.phase]) : progress.phase}
        </span>
        <span className="text-xs text-primary-700">{progress.progress}%</span>
      </div>
      <div className="h-1.5 bg-primary-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-primary-500 rounded-full transition-all duration-300"
          style={{ width: `${progress.progress}%` }}
        />
      </div>
      <p className="text-xs text-primary-700 mt-1">{progress.detail}</p>
      {progress.cacheHits !== undefined && progress.total !== undefined && (
        <div className="mt-1.5 flex items-center gap-3 text-xs text-primary-700">
          <span className="inline-flex items-center gap-1">
            <span className="font-semibold">{progress.cacheHits}</span>
            <span className="text-primary-600">{t('progress.fromCache', { total: progress.total })}</span>
            {cacheHitsPct !== null && (
              <span className="text-green-700 font-semibold ml-1">({cacheHitsPct} %)</span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
