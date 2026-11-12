import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface ProgressEvent {
  phase: string;
  progress: number;
  detail: string;
  cacheHits?: number;
  candidates?: number;
}

// Übersetzungsschlüssel je Phase (Namespace `terminology`)
const PHASE_LABELS: Record<string, string> = {
  connected: 'progress.phase.connected',
  aligning: 'progress.phase.aligning',
  translating: 'progress.phase.translating',
  analyzing: 'progress.phase.analyzing',
  completed: 'progress.phase.completed',
  error: 'progress.phase.error',
};

interface Props {
  scanId: string;
  onComplete: () => void;
}

export default function ScanProgress({ scanId, onComplete }: Props) {
  const { t } = useTranslation('terminology');
  const [event, setEvent] = useState<ProgressEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/terminology-scan/${scanId}/progress`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const data: ProgressEvent = JSON.parse(e.data);
        setEvent(data);
        if (data.phase === 'completed' || data.phase === 'error') {
          es.close();
          setTimeout(onComplete, 1500);
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
    };

    return () => {
      es.close();
    };
  }, [scanId, onComplete]);

  if (!event) return null;

  const phaseLabel = PHASE_LABELS[event.phase] ? t(PHASE_LABELS[event.phase]) : event.phase;
  const isError = event.phase === 'error';
  const isDone = event.phase === 'completed';

  return (
    <div className={`rounded-lg border p-4 ${isError ? 'border-red-200 bg-red-50' : isDone ? 'border-green-200 bg-green-50' : 'border-primary-200 bg-primary-50'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-sm font-medium ${isError ? 'text-red-700' : isDone ? 'text-green-700' : 'text-primary-800'}`}>
          {phaseLabel}
        </span>
        <span className="text-xs text-gray-500">{event.progress}%</span>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${isError ? 'bg-red-500' : isDone ? 'bg-green-500' : 'bg-primary-500'}`}
          style={{ width: `${event.progress}%` }}
        />
      </div>

      <div className="text-xs text-gray-600">
        {event.detail}
        {event.cacheHits !== undefined && event.cacheHits > 0 && (
          <span className="ml-2 text-green-600">({t('progress.cacheHits', { count: event.cacheHits })})</span>
        )}
        {event.candidates !== undefined && (
          <span className="ml-2 text-purple-600 font-medium">{t('progress.candidates', { count: event.candidates })}</span>
        )}
      </div>
    </div>
  );
}
