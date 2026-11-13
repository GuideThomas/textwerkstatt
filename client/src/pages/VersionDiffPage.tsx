import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';
import PageHeader from '../components/PageHeader';
import { WordDiff } from '../components/review/DiffView';
import { STYLE_MARKER_RE, renderWithMarkers } from '../components/review/HighlightedText';

interface Version {
  id: string;
  parent_project_id: string | null;
  name: string;
  source_lang: string;
  target_lang: string;
  version_number: number;
  status: string;
  created_at: string;
  segment_count: number;
  file_size_bytes: number;
}

interface DiffSegment {
  position: number;
  source_text: string;
}

interface DiffResult {
  counts: { added: number; removed: number; changed: number; unchanged: number };
  added: DiffSegment[];
  removed: DiffSegment[];
  changed: { from: DiffSegment; to: DiffSegment }[];
}

interface Props {
  projectId: string;
  onBack: () => void;
}

// IDML-Formatgrenzen (`<x id="N"/>`) wie im Review-Editor als „⁞“ statt als Roh-Tag.
// Für den Wortvergleich als Zeichen ersetzen, damit ein Tag nicht in zwei Wörter zerfällt.
const markers = (text: string) => text.replace(STYLE_MARKER_RE, '⁞');

const CHANGED_LIMIT = 50;
const LIST_LIMIT = 30;

export default function VersionDiffPage({ projectId, onBack }: Props) {
  const { t } = useTranslation('common');
  const [versions, setVersions] = useState<Version[]>([]);
  const [otherId, setOtherId] = useState<string>('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/versions`)
      .then(r => r.json())
      .then(data => {
        const list: Version[] = data.versions || [];
        setVersions(list);
        // Default-Vergleich: aktuellster Vorgänger
        const current = list.find((v) => v.id === projectId);
        const candidates = list.filter((v) => v.id !== projectId && v.target_lang === current?.target_lang);
        if (candidates.length > 0) {
          setOtherId(candidates[candidates.length - 1].id);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId]);

  const computeDiff = async () => {
    if (!otherId) return;
    // Immer ältere gegen neuere Version: Die Route zählt als „hinzugekommen“, was nur im
    // zweiten Projekt steht. Bis 22.10.2026 ging die aktuelle Version zuerst — gegen
    // ihren Vorgänger gerechnet waren hinzugekommen und entfernt vertauscht, und
    // „vorher/nachher“ stand verkehrt herum.
    const current = versions.find((v) => v.id === projectId);
    const other = versions.find((v) => v.id === otherId);
    const otherIsOlder = !!current && !!other && other.version_number < current.version_number;
    const [olderId, newerId] = otherIsOlder ? [otherId, projectId] : [projectId, otherId];
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/projects/${olderId}/diff/${newerId}`);
      // Eine Fehlerantwort ist kein Vergleich: `{ error }` als Vergleich ließe die Ansicht beim Lesen von `counts` abstürzen.
      if (!res.ok) throw new Error(`Vergleich: HTTP ${res.status}`);
      setDiff(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setDiffLoading(false);
    }
  };

  const fmtDate = (s: string) => new Date(s).toLocaleString(currentLocale(), {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  if (loading) return <div className="text-center py-20 text-gray-500 text-sm">{t('versions.loading')}</div>;

  const hasOthers = versions.some((v) => v.id !== projectId);

  return (
    <>
      <PageHeader
        title={t('versions.title')}
        subtitle={t('versions.subtitle')}
        actions={
          <button type="button" onClick={onBack} className="btn-secondary">
            {t('versions.back')}
          </button>
        }
      />

      <div className="card mb-6">
        <div className="card-header">
          <h2 className="card-header-title">{t('versions.chain')}</h2>
        </div>
        <div className="card-content">
          {versions.length === 0 ? (
            <p className="text-sm text-gray-500">{t('versions.empty')}</p>
          ) : (
            <ol className="space-y-2">
              {versions.map((v) => {
                const isCurrent = v.id === projectId;
                const isSelected = otherId === v.id;
                return (
                  <li
                    key={v.id}
                    className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 rounded-[5px] border text-sm transition-colors ${
                      isCurrent
                        ? 'bg-primary-50 border-primary-200'
                        : isSelected
                          ? 'bg-white border-primary-300'
                          : 'bg-white border-gray-200'
                    }`}
                  >
                    <span className="inline-flex items-center justify-center min-w-[2.25rem] px-1.5 py-0.5 rounded text-xs font-bold font-mono bg-gray-100 text-gray-700">
                      v{v.version_number}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">{v.name}</div>
                      <div className="text-xs text-gray-500">
                        {v.source_lang} → {v.target_lang}
                        <span className="text-gray-300 mx-1.5">·</span>
                        {t('segments.count', { count: v.segment_count })}
                        <span className="text-gray-300 mx-1.5">·</span>
                        {fmtDate(v.created_at)}
                      </div>
                    </div>
                    {isCurrent ? (
                      <span className="badge badge-primary">{t('versions.current')}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setOtherId(v.id); setDiff(null); }}
                        aria-pressed={isSelected}
                        className={`text-xs font-semibold px-3 py-1 rounded-[5px] border transition-colors ${
                          isSelected
                            ? 'bg-primary-600 text-white border-primary-600'
                            : 'text-gray-700 border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {isSelected ? `✓ ${t('versions.selected')}` : t('versions.compare')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {hasOthers ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={computeDiff} disabled={!otherId || diffLoading} className="btn-primary">
                {diffLoading ? t('versions.computing') : t('versions.showDiff')}
              </button>
              {otherId && <span className="text-xs text-gray-500">{t('versions.compareHint')}</span>}
            </div>
          ) : versions.length > 0 && (
            // Der Normalfall: Am 22.10.2026 hatte keines der 100 Dokumente eine zweite Version.
            // Ohne diesen Hinweis stand dort ein grauer Knopf ohne Erklärung.
            <p className="mt-4 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-[5px] px-3 py-2.5">
              {t('versions.onlyOne')}
            </p>
          )}
        </div>
      </div>

      {diff && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-header-title">{t('versions.result')}</h2>
          </div>
          <div className="card-content">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-2">
              <Stat label={t('versions.stats.unchanged')} value={diff.counts.unchanged} valueCls="text-gray-900" />
              <Stat label={t('versions.stats.changed')} value={diff.counts.changed} valueCls="text-amber-700" />
              <Stat label={t('versions.stats.added')} value={diff.counts.added} valueCls="text-green-700" />
              <Stat label={t('versions.stats.removed')} value={diff.counts.removed} valueCls="text-red-700" />
            </div>

            {diff.changed.length > 0 && (
              <Section title={t('versions.sections.changed', { count: diff.changed.length })}>
                {diff.changed.slice(0, CHANGED_LIMIT).map((c, i) => (
                  <Row key={i} marker="~" markerCls="text-amber-600" label={t('versions.position', { position: c.to.position })}>
                    <WordDiff original={markers(c.from.source_text)} current={markers(c.to.source_text)} />
                  </Row>
                ))}
                {diff.changed.length > CHANGED_LIMIT && (
                  <MoreHidden text={t('versions.moreHidden', { count: diff.changed.length - CHANGED_LIMIT })} />
                )}
              </Section>
            )}

            {diff.added.length > 0 && (
              <Section title={t('versions.sections.added', { count: diff.added.length })}>
                {diff.added.slice(0, LIST_LIMIT).map((a, i) => (
                  <Row key={i} marker="+" markerCls="text-green-700" label={t('versions.position', { position: a.position })}>
                    <span className="text-green-800">{renderWithMarkers(a.source_text, `a${i}`)}</span>
                  </Row>
                ))}
                {diff.added.length > LIST_LIMIT && (
                  <MoreHidden text={t('versions.moreHidden', { count: diff.added.length - LIST_LIMIT })} />
                )}
              </Section>
            )}

            {diff.removed.length > 0 && (
              <Section title={t('versions.sections.removed', { count: diff.removed.length })}>
                {diff.removed.slice(0, LIST_LIMIT).map((r, i) => (
                  <Row key={i} marker="−" markerCls="text-red-600" label={t('versions.position', { position: r.position })}>
                    <span className="text-red-700 line-through">{renderWithMarkers(r.source_text, `r${i}`)}</span>
                  </Row>
                ))}
                {diff.removed.length > LIST_LIMIT && (
                  <MoreHidden text={t('versions.moreHidden', { count: diff.removed.length - LIST_LIMIT })} />
                )}
              </Section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Kennzahl im Stil der Kosten-Seite
function Stat({ label, value, valueCls }: { label: string; value: number; valueCls: string }) {
  return (
    <div className="rounded-[5px] border border-gray-200 bg-gray-50 p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-semibold ${valueCls}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-gray-800 mb-2">{title}</h3>
      <div className="rounded-[5px] border border-gray-200 divide-y divide-gray-100 max-h-96 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

function Row({ marker, markerCls, label, children }: {
  marker: string; markerCls: string; label: string; children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 px-3 py-2 text-sm">
      <span className={`w-3 shrink-0 font-bold ${markerCls}`} aria-hidden="true">{marker}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-gray-400 mb-0.5">{label}</div>
        <div className="text-gray-800 break-words leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function MoreHidden({ text }: { text: string }) {
  return <p className="px-3 py-2 text-xs text-gray-400 italic">{text}</p>;
}
