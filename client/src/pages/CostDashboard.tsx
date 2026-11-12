import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { currentLocale } from '../i18n';
import PageHeader from '../components/PageHeader';

// DeepL API Pro laut Abo-Seite (Stand Screenshot Thomas, 18.09.2026): 4,99 €/Monat + 20 € je 1 Mio. Zeichen.
// Bis 18.09.2026 rechnete die Schätzung mit 25 €, während die Beschriftung daneben 20 € nannte.
const DEEPL_BASE_EUR = 4.99;
const DEEPL_EUR_PER_MILLION = 20;

interface DailyCost {
  day: string;
  model: string;
  requests: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
}

interface ProjectCost {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  file_type: string;
  llm_requests: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
}

interface CostData {
  daily: DailyCost[];
  projects: ProjectCost[];
  totals: {
    total_requests: string;
    total_input_tokens: string;
    total_output_tokens: string;
    total_cost_usd: string;
    models_used: string;
  };
  byPurpose: { purpose: string; requests: string; cost_usd: string }[];
  byModel: { model: string; count: string; input_tokens: string; output_tokens: string; cost_usd: string }[];
}

interface CacheData {
  stats: {
    total_segments: string;
    segments_with_hits: string;
    total_hits: string;
    hit_rate_pct: string;
  };
  topCached: {
    source_preview: string;
    source_lang: string;
    target_lang: string;
    hit_count: number;
    is_stale: boolean;
  }[];
  staleCount: number;
}

interface DeeplData {
  deepl: {
    character_count?: number;
    character_limit?: number;
  } | null;
  reachable: boolean;
  lastError: string;
  lastCheck: string | null;
  segments: {
    total_translated: string;
    total_source_chars: string;
    total_translated_chars: string;
  };
}

interface OverviewData {
  projects: { total: string; completed: string; in_progress: string; errors: string };
  glossaries: number;
  glossaryEntries: { total: string; approved: string };
  segments: number;
}

async function fetchApi<T>(endpoint: string): Promise<T> {
  const res = await fetch(`/api/dashboard${endpoint}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatNumber(n: string | number): string {
  return Number(n).toLocaleString(currentLocale());
}

function formatCost(n: string | number): string {
  return `$${Number(n).toLocaleString(currentLocale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

export default function CostDashboard() {
  const [costs, setCosts] = useState<CostData | null>(null);
  const [cache, setCache] = useState<CacheData | null>(null);
  const [deepl, setDeepl] = useState<DeeplData | null>(null);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation('admin');

  useEffect(() => {
    Promise.all([
      fetchApi<CostData>('/costs'),
      fetchApi<CacheData>('/cache'),
      fetchApi<DeeplData>('/deepl'),
      fetchApi<OverviewData>('/overview'),
    ])
      .then(([c, ca, d, o]) => {
        setCosts(c);
        setCache(ca);
        setDeepl(d);
        setOverview(o);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-gray-400 text-sm">{t('costs.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('costs.title')} subtitle={t('costs.subtitle')} />
      {/* Overview Cards */}
      {overview && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label={t('costs.overview.documents')} value={overview.projects.total} sub={t('costs.overview.completed', { n: formatNumber(overview.projects.completed) })} />
          <StatCard label={t('costs.overview.segmentsCache')} value={formatNumber(overview.segments)} sub={cache ? t('costs.overview.hitRate', { pct: formatNumber(cache.stats.hit_rate_pct || 0) }) : ''} />
          <StatCard label={t('costs.overview.glossaries')} value={String(overview.glossaries)} sub={t('costs.overview.entries', { count: Number(overview.glossaryEntries.total), n: formatNumber(overview.glossaryEntries.total) })} />
          <StatCard
            label={t('costs.overview.llmTotal')}
            value={costs ? formatCost(costs.totals.total_cost_usd) : '$0'}
            sub={costs ? t('costs.overview.requests', { count: Number(costs.totals.total_requests), n: formatNumber(costs.totals.total_requests) }) : ''}
            highlight
          />
        </div>
      )}

      {/* DeepL-Reachability-Banner — nur sichtbar bei Ausfall */}
      {deepl && !deepl.reachable && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-4 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-red-800">{t('costs.deeplDown.title')}</div>
            <div className="text-sm text-red-600">{deepl.lastError}</div>
            <div className="text-xs text-red-500 mt-1">
              {t('costs.deeplDown.hint')}
            </div>
          </div>
          <button
            onClick={async () => {
              try {
                await fetch('/api/dashboard/deepl/health', { credentials: 'include' });
                window.location.reload();
              } catch { alert(i18n.t('admin:costs.deeplDown.healthFailed')); }
            }}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 whitespace-nowrap ml-4"
          >
            {t('costs.deeplDown.recheck')}
          </button>
        </div>
      )}

      {/* DeepL Usage */}
      {deepl && (
        <Section title={t('costs.deepl.title')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {deepl.deepl && (
              <>
                <StatCard
                  label={t('costs.deepl.charsUsed')}
                  value={formatNumber(deepl.deepl.character_count ?? 0)}
                  sub={t('costs.deepl.plan')}
                />
              </>
            )}
            <StatCard
              label={t('costs.deepl.translatedSegments')}
              value={formatNumber(deepl.segments.total_translated)}
              sub={t('costs.deepl.sourceChars', { n: formatNumber(deepl.segments.total_source_chars || 0) })}
            />
            <StatCard
              label={t('costs.deepl.translatedChars')}
              value={formatNumber(deepl.segments.total_translated_chars || 0)}
            />
            {deepl.deepl && (
              <StatCard
                label={t('costs.deepl.estCost')}
                value={`€${(DEEPL_BASE_EUR + (deepl.deepl.character_count ?? 0) / 1_000_000 * DEEPL_EUR_PER_MILLION).toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                sub={t('costs.deepl.estCostHint')}
              />
            )}
          </div>
        </Section>
      )}

      {/* LLM API Kosten */}
      {costs && (
        <Section title={t('costs.llm.title')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <StatCard
              label={t('costs.overview.llmTotal')}
              value={formatCost(costs.totals.total_cost_usd)}
              sub={t('costs.overview.requests', { count: Number(costs.totals.total_requests), n: formatNumber(costs.totals.total_requests) })}
              highlight
            />
            <StatCard
              label={t('costs.llm.inputTokens')}
              value={formatNumber(costs.totals.total_input_tokens)}
            />
            <StatCard
              label={t('costs.llm.outputTokens')}
              value={formatNumber(costs.totals.total_output_tokens)}
            />
            <StatCard
              label={t('costs.llm.modelsUsed')}
              value={costs.totals.models_used}
            />
          </div>
          {costs.byModel.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-4">{t('costs.llm.model')}</th>
                    <th className="py-2 pr-4 text-right">{t('costs.llm.requests')}</th>
                    <th className="py-2 pr-4 text-right">{t('costs.llm.inputTokens')}</th>
                    <th className="py-2 pr-4 text-right">{t('costs.llm.outputTokens')}</th>
                    <th className="py-2 text-right">{t('costs.llm.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.byModel.map((m) => (
                    <tr key={m.model} className="border-b border-gray-50">
                      <td className="py-2 pr-4 font-mono text-xs">{m.model}</td>
                      <td className="py-2 pr-4 text-right">{formatNumber(m.count)}</td>
                      <td className="py-2 pr-4 text-right">{formatNumber(m.input_tokens)}</td>
                      <td className="py-2 pr-4 text-right">{formatNumber(m.output_tokens)}</td>
                      <td className="py-2 text-right font-medium">{formatCost(m.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {/* Costs by Purpose */}
      {costs && costs.byPurpose.length > 0 && (
        <Section title={t('costs.purpose.title')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 pr-4">{t('costs.purpose.purpose')}</th>
                  <th className="py-2 pr-4 text-right">{t('costs.llm.requests')}</th>
                  <th className="py-2 text-right">{t('costs.llm.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {costs.byPurpose.map((p) => (
                  <tr key={p.purpose} className="border-b border-gray-50">
                    <td className="py-2 pr-4 capitalize">{t(`costs.purposes.${p.purpose}`, { defaultValue: p.purpose })}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(p.requests)}</td>
                    <td className="py-2 text-right">{formatCost(p.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Project Costs */}
      {costs && costs.projects.length > 0 && (
        <Section title={t('costs.projects.title')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 pr-4">{t('costs.projects.document')}</th>
                  <th className="py-2 pr-4">{t('costs.projects.languages')}</th>
                  <th className="py-2 pr-4">{t('costs.projects.format')}</th>
                  <th className="py-2 pr-4 text-right">{t('costs.projects.llmCalls')}</th>
                  <th className="py-2 pr-4 text-right">{t('costs.daily.inputTokens')}</th>
                  <th className="py-2 text-right">{t('costs.llm.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {costs.projects.map((p) => (
                  <tr key={p.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 max-w-[200px] truncate" title={p.name}>{p.name}</td>
                    <td className="py-2 pr-4 uppercase text-xs text-gray-500">{p.source_lang} → {p.target_lang}</td>
                    <td className="py-2 pr-4 uppercase text-xs">{p.file_type}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(p.llm_requests)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(p.input_tokens)}</td>
                    <td className="py-2 text-right font-medium">{formatCost(p.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Cache Stats */}
      {cache && (
        <Section title={t('costs.cache.title')}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <StatCard label={t('costs.cache.total')} value={formatNumber(cache.stats.total_segments)} />
            <StatCard label={t('costs.cache.withHits')} value={formatNumber(cache.stats.segments_with_hits)} />
            <StatCard label={t('costs.cache.totalHits')} value={formatNumber(cache.stats.total_hits)} />
            <StatCard label={t('costs.cache.stale')} value={formatNumber(cache.staleCount)} />
          </div>

          {cache.topCached.length > 0 && (
            <>
              <h4 className="text-sm font-medium text-gray-700 mb-2">{t('costs.cache.top')}</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-2 pr-4">{t('costs.cache.segment')}</th>
                      <th className="py-2 pr-4">{t('costs.projects.languages')}</th>
                      <th className="py-2 pr-4 text-right">{t('costs.cache.hits')}</th>
                      <th className="py-2">{t('common.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cache.topCached.map((s, i) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="py-2 pr-4 max-w-[300px] truncate text-xs" title={s.source_preview}>
                          {s.source_preview}
                        </td>
                        <td className="py-2 pr-4 uppercase text-xs text-gray-500">
                          {s.source_lang} → {s.target_lang}
                        </td>
                        <td className="py-2 pr-4 text-right font-medium">{formatNumber(s.hit_count)}</td>
                        <td className="py-2">
                          {s.is_stale ? (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-700">{t('costs.cache.staleBadge')}</span>
                          ) : (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">{t('costs.cache.current')}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Section>
      )}

      {/* Daily Costs */}
      {costs && costs.daily.length > 0 && (
        <Section title={t('costs.daily.title')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 pr-4">{t('costs.daily.day')}</th>
                  <th className="py-2 pr-4">{t('costs.llm.model')}</th>
                  <th className="py-2 pr-4 text-right">{t('costs.llm.requests')}</th>
                  <th className="py-2 pr-4 text-right">{t('costs.daily.inputTokens')}</th>
                  <th className="py-2 pr-4 text-right">{t('costs.daily.outputTokens')}</th>
                  <th className="py-2 text-right">{t('costs.llm.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {costs.daily.map((d, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-2 pr-4">{new Date(d.day).toLocaleDateString(currentLocale(), { timeZone: 'UTC' })}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{d.model}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(d.requests)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(d.input_tokens)}</td>
                    <td className="py-2 pr-4 text-right">{formatNumber(d.output_tokens)}</td>
                    <td className="py-2 text-right font-medium">{formatCost(d.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function StatCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? 'border-primary-200 bg-primary-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${highlight ? 'text-primary-700' : 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}
