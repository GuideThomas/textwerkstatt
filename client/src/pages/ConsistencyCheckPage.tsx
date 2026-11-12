import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import PageHeader from '../components/PageHeader';

// Anzeigename kommt aus `documents:languages.<code>`
const LANGUAGES = [
  { code: 'DE' },
  { code: 'EN' },
  { code: 'IT' },
  { code: 'FR' },
  { code: 'ES' },
  { code: 'HU' },
  { code: 'PL' },
  { code: 'CS' },
  { code: 'SK' },
  { code: 'SL' },
];

interface InconsistencyItem {
  source_text: string;
  normalized_hash: string;
  variant_count: number;
  variants: string[];
  total_hits: number;
}

export default function ConsistencyCheckPage() {
  const { t } = useTranslation('documents');
  const [sourceLang, setSourceLang] = useState('DE');
  const [targetLang, setTargetLang] = useState('IT');
  const [items, setItems] = useState<InconsistencyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  const runCheck = async () => {
    setLoading(true);
    setRan(true);
    try {
      const res = await fetch(`/api/projects/consistency-check?source_lang=${sourceLang}&target_lang=${targetLang}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <PageHeader title={t('consistency.title')} subtitle={t('consistency.subtitle')} />

      <div className="card card-content mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">{t('consistency.sourceLang')}</label>
            <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}
                    className="border border-gray-300 rounded text-sm p-2">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{t(`languages.${l.code}`)}</option>)}
            </select>
          </div>
          <div className="text-gray-400 pb-2">→</div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">{t('consistency.targetLang')}</label>
            <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)}
                    className="border border-gray-300 rounded text-sm p-2">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{t(`languages.${l.code}`)}</option>)}
            </select>
          </div>
          <button onClick={runCheck} disabled={loading || sourceLang === targetLang}
                  className="bg-primary-600 text-white text-sm px-4 py-2 rounded hover:bg-primary-700 disabled:bg-gray-300">
            {loading ? t('consistency.checking') : t('consistency.run')}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-3">
          {t('consistency.help')}
        </p>
      </div>

      {ran && !loading && items.length === 0 && (
        <div className="card card-content text-center text-gray-500 text-sm py-12">
          {t('consistency.none', { source: sourceLang, target: targetLang })}
        </div>
      )}

      {items.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-header-title">{t('consistency.found', { count: items.length })}</h2>
          </div>
          <div className="divide-y divide-gray-100">
            {items.map((it) => (
              <div key={it.normalized_hash} className="px-6 py-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-500">
                    <span className="font-semibold text-gray-700">{t('consistency.variants', { count: Number(it.variant_count) })}</span>
                    {' · '}{t('consistency.cacheHits', { count: Number(it.total_hits) })}
                  </span>
                </div>
                <div className="text-sm text-gray-900 mb-2 italic">„{it.source_text}"</div>
                <ul className="space-y-1 ml-4">
                  {it.variants.map((v, i) => (
                    <li key={i} className="text-sm text-primary-700">
                      → „{v}"
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
