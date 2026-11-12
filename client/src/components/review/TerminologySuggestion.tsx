import { useTranslation } from 'react-i18next';

interface Candidate {
  sourceTerm: string;
  targetTerm: string;
  originalTargetTerm: string;
  confidence: number;
}

interface Props {
  candidates: Candidate[];
  projectId: string;
  onDismiss: () => void;
}

export default function TerminologySuggestion({ candidates, projectId, onDismiss }: Props) {
  const { t } = useTranslation('review');
  if (candidates.length === 0) return null;

  const accept = async (c: Candidate) => {
    try {
      await fetch(`/api/projects/${projectId}/terminology`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_term: c.sourceTerm,
          target_term: c.targetTerm,
        }),
      });
    } catch (err) {
      console.error('Failed to save terminology:', err);
    }
    onDismiss();
  };

  return (
    <div className="mx-2 mt-1 p-2 bg-purple-50 border border-purple-200 rounded text-xs">
      <div className="font-medium text-purple-700 mb-1">{t('terminology.title')}</div>
      {candidates.map((c, i) => (
        <div key={i} className="flex items-center justify-between py-0.5">
          <span className="text-gray-700">
            {c.sourceTerm} &rarr; <span className="font-medium">{c.targetTerm}</span>
            <span className="text-gray-400 ml-1">({t('terminology.insteadOf', { term: c.originalTargetTerm })})</span>
          </span>
          <div className="flex gap-1 ml-2">
            <button
              onClick={() => accept(c)}
              className="text-green-600 hover:text-green-800 px-1"
              title={t('terminology.accept')}
            >
              ✓
            </button>
            <button
              onClick={onDismiss}
              className="text-gray-400 hover:text-gray-600 px-1"
              title={t('terminology.dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
