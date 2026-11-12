import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';
import FileUpload from '../components/FileUpload';
import SegmentList from '../components/SegmentList';
import TranslationProgress from '../components/TranslationProgress';
import PageHeader from '../components/PageHeader';

interface Topic {
  id: string;
  name: string;
  color: string;
}

interface PlaceholderWarning {
  triggered: boolean;
  totalSegments: number;
  placeholderCount: number;
  ratio: number;
  loremIpsumDetected: boolean;
  samples: Array<{ id: string; preview: string; matchedTokens: string[] }>;
}

interface Project {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  file_type: string;
  status: string;
  original_filename: string | null;
  segment_count: number;
  created_at: string;
  file_size_bytes: number | string | null;
  version_chain_size_bytes?: number | string | null;
  version_chain_count?: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_by_email: string | null;
  topics: Topic[];
  placeholder_warning?: PlaceholderWarning | null;
}

interface UserOption {
  id: string;
  label: string;
  email: string;
  project_count: number;
}

interface StorageStats {
  file_count: number;
  total_bytes: string | number;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: 'status.pending', color: 'bg-yellow-100 text-yellow-800' },
  processing: { label: 'status.processing', color: 'bg-primary-100 text-primary-800' },
  translating: { label: 'status.translating', color: 'bg-primary-100 text-primary-800' },
  condensing: { label: 'status.condensing', color: 'bg-purple-100 text-purple-800' },
  completed: { label: 'status.completed', color: 'bg-green-100 text-green-800' },
  error: { label: 'status.error', color: 'bg-red-100 text-red-800' },
};

const FILE_TYPE_ICONS: Record<string, string> = {
  idml: '📐', docx: '📝', xlsx: '📊', pdf: '📄', xml: '🧩', html: '🌐', txt: '📃', csv: '📋', md: '📑',
};

type SortKey = 'date' | 'size' | 'name';
type SortOrder = 'asc' | 'desc';

interface DashboardProps {
  onNavigateToReview?: (projectId: string, projectName: string, fileType: string) => void;
  onNavigateToVersions?: (projectId: string) => void;
}

function formatBytes(bytes: number | string | null | undefined): string {
  // file_size_bytes / version_chain_size_bytes sind in Postgres bigint —
  // node-postgres liefert bigint als STRING. Ohne Coercion bleibt `value`
  // bei Werten < 1024 (while-Schleife laeuft nicht) ein String → .toFixed
  // wirft "is not a function". Daher hier hart in Number wandeln.
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!n || n <= 0 || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toLocaleString(currentLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[unitIndex]}`;
}

export default function Dashboard({ onNavigateToReview, onNavigateToVersions }: DashboardProps) {
  const { t } = useTranslation('documents');
  const [projects, setProjects] = useState<Project[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [storage, setStorage] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  // Filter / Sort State
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [userFilter, setUserFilter] = useState<string>('');
  const [topicFilter, setTopicFilter] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => {
      const name = (p.name || '').toLowerCase();
      const orig = (p.original_filename || '').toLowerCase();
      return name.includes(q) || orig.includes(q);
    });
  }, [projects, searchQuery]);

  // Dieselbe Datei in mehreren Zielsprachen = eine Karte. Schlüssel ist die Datei
  // (Name, Quellsprache, Format), nicht `sibling_group_id`: auch Einzel-Uploads
  // derselben Datei an verschiedenen Tagen gehören zusammen. Die Reihenfolge folgt
  // der Sortierung des Servers — eine Gruppe steht dort, wo ihr erstes Mitglied steht.
  const groupedProjects = useMemo(() => {
    const groups = new Map<string, Project[]>();
    for (const p of filteredProjects) {
      const key = `${p.name}\u0000${p.source_lang}\u0000${p.file_type}`;
      const members = groups.get(key);
      if (members) members.push(p);
      else groups.set(key, [p]);
    }
    return Array.from(groups, ([key, members]) => ({ key, members }));
  }, [filteredProjects]);

  // Bulk-Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Topic-Editor (per Projekt)
  const [topicEditorOpen, setTopicEditorOpen] = useState<string | null>(null);

  // Neue-Version-Modus: Wenn gesetzt, wird Upload als Kind-Projekt angelegt
  const [parentProject, setParentProject] = useState<{ id: string; name: string; source_lang: string; target_lang: string } | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set('sort', sortKey);
    params.set('order', sortOrder);
    if (userFilter) params.set('user', userFilter);
    if (topicFilter.length > 0) params.set('topics', topicFilter.join(','));
    return params.toString();
  }, [sortKey, sortOrder, userFilter, topicFilter]);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects?${queryString}`);
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
      }
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  const fetchTopics = useCallback(async () => {
    try {
      const res = await fetch('/api/topics');
      if (res.ok) setTopics(await res.json());
    } catch (err) { console.error('Failed to fetch topics:', err); }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/users/list');
      if (res.ok) setUsers(await res.json());
    } catch (err) { console.error('Failed to fetch users:', err); }
  }, []);

  const fetchStorage = useCallback(async () => {
    try {
      const res = await fetch('/api/projects/storage-stats');
      if (res.ok) setStorage(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchTopics(); fetchUsers(); }, [fetchTopics, fetchUsers]);

  useEffect(() => {
    fetchProjects();
    fetchStorage();
    const interval = setInterval(() => { fetchProjects(); fetchStorage(); }, 5000);
    return () => clearInterval(interval);
  }, [fetchProjects, fetchStorage]);

  const handleDelete = async (id: string) => {
    if (!confirm(t('confirm.deleteOne'))) return;
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== id));
        setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
      }
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!confirm(t('confirm.deleteMany', { count: ids.length }))) return;
    try {
      const res = await fetch('/api/projects/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (res.ok) {
        setProjects((prev) => prev.filter((p) => !selected.has(p.id)));
        setSelected(new Set());
      }
    } catch (err) {
      console.error('Bulk-delete failed:', err);
    }
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleGroup = (ids: string[], allChecked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allChecked) next.delete(id); else next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filteredProjects.length) setSelected(new Set());
    else setSelected(new Set(filteredProjects.map(p => p.id)));
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortOrder('desc'); }
  };

  const toggleTopicFilter = (id: string) => {
    setTopicFilter((prev) => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  // Ein Thema beschreibt die Datei: im Kartenkopf gilt es für alle Sprachen der Karte.
  const updateProjectTopics = async (projectIds: string[], topicIds: string[]) => {
    try {
      const results = await Promise.all(projectIds.map((id) => fetch(`/api/projects/${id}/topics`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic_ids: topicIds }),
      })));
      if (results.some((r) => r.ok)) await fetchProjects();
    } catch (err) {
      console.error('Failed to update topics:', err);
    }
  };

  const topicIdsOf = (p: Project) => (p.topics ?? []).map((x) => x.id);

  const renderTopicEditor = (assignedIds: string[], projectIds: string[], className: string) => (
    <div className={`flex flex-wrap gap-2 items-center ${className}`}>
      <span className="text-xs text-gray-500">{t('topics.assign')}</span>
      {topics.map((tp) => {
        const assigned = assignedIds.includes(tp.id);
        return (
          <button key={tp.id} type="button" aria-pressed={assigned}
                  onClick={() => {
                    const next = assigned ? assignedIds.filter((id) => id !== tp.id) : [...assignedIds, tp.id];
                    updateProjectTopics(projectIds, next);
                  }}
                  className={`text-xs px-2 py-0.5 rounded border ${assigned ? 'text-white' : 'text-gray-700 hover:bg-gray-50'}`}
                  style={assigned ? { backgroundColor: tp.color, borderColor: tp.color } : { borderColor: tp.color }}>
            {assigned ? '✓ ' : ''}{tp.name}
          </button>
        );
      })}
      {topics.length === 0 && (
        <span className="text-xs text-gray-400">{t('topics.none')}</span>
      )}
    </div>
  );

  const renderTopicChips = (list: Topic[], editorKey: string) => (
    <div className="flex items-center gap-1.5 flex-wrap">
      {list.map((tp) => (
        <span key={tp.id} className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white whitespace-nowrap"
              style={{ backgroundColor: tp.color }}>
          {tp.name}
        </span>
      ))}
      <button type="button"
              onClick={() => setTopicEditorOpen(topicEditorOpen === editorKey ? null : editorKey)}
              aria-expanded={topicEditorOpen === editorKey}
              className="text-[11px] text-primary-700 hover:underline whitespace-nowrap px-1 rounded">
        {list.length ? t('project.editTopics') : t('project.addTopic')}
      </button>
    </div>
  );

  const formatDate = (dateStr: string) => new Date(dateStr).toLocaleString(currentLocale(), {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  // Eigene Größe, bei mehreren Versionen mit der Summe der ganzen Kette im Tooltip.
  const renderSize = (project: Project) => {
    const ownRaw = project.file_size_bytes ?? 0;
    const own = typeof ownRaw === 'string' ? parseInt(ownRaw, 10) || 0 : ownRaw;
    const chainRaw = project.version_chain_size_bytes;
    const chain = typeof chainRaw === 'string' ? parseInt(chainRaw, 10) || 0 : chainRaw ?? 0;
    const versions = project.version_chain_count ?? 1;
    const hasOlder = versions > 1 && chain > own;
    return hasOlder ? (
      <span title={t('project.sizeTitle', { own: formatBytes(own), count: versions, chain: formatBytes(chain) })}>
        {formatBytes(own)}
        <span className="text-gray-400"> · {t('project.sizeTotal', { size: formatBytes(chain) })}</span>
      </span>
    ) : (
      <span>{formatBytes(own)}</span>
    );
  };

  const sortIndicator = (key: SortKey) => sortKey !== key ? '' : (sortOrder === 'asc' ? ' ▲' : ' ▼');
  const totalBytes = storage ? Number(storage.total_bytes) : 0;

  return (
    <>
      <PageHeader title={t('page.title')} subtitle={t('page.subtitle')} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Das Formular bleibt beim Scrollen durch die Liste stehen; ist es höher als
            das Fenster, scrollt es in sich. */}
        <div className="lg:col-span-1 lg:sticky lg:top-20 lg:self-start lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
          <FileUpload
            onUploadComplete={() => { fetchProjects(); fetchStorage(); setParentProject(null); }}
            topics={topics}
            parentProject={parentProject}
            onCancelParent={() => setParentProject(null)}
          />
        </div>

        <div className="lg:col-span-2">
          <div className="card">
            <div className="card-header flex flex-wrap items-center gap-3 justify-between">
              <h2 className="card-header-title">{t('list.title')}</h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <div className="relative">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('list.searchPlaceholder')}
                    className="border border-gray-300 rounded pl-2 pr-6 py-1 text-xs w-44"
                    title={t('list.searchTitle')}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm leading-none"
                      title={t('list.searchClear')}
                    >
                      ×
                    </button>
                  )}
                </div>
                <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1">
                  <option value="">{t('list.allEditors')}</option>
                  <option value="me">{t('list.mine')}</option>
                  <optgroup label={t('list.users')}>
                    {users.map(u => (
                      <option key={u.id} value={u.id}>{u.label} ({u.project_count})</option>
                    ))}
                  </optgroup>
                </select>
                <button onClick={() => toggleSort('date')} className="border border-gray-300 rounded px-2 py-1 hover:bg-gray-50">
                  {t('sort.date')}{sortIndicator('date')}
                </button>
                <button onClick={() => toggleSort('size')} className="border border-gray-300 rounded px-2 py-1 hover:bg-gray-50">
                  {t('sort.size')}{sortIndicator('size')}
                </button>
                <button onClick={() => toggleSort('name')} className="border border-gray-300 rounded px-2 py-1 hover:bg-gray-50">
                  {t('sort.name')}{sortIndicator('name')}
                </button>
                {storage && (
                  <span className="text-gray-500 ml-2">
                    {t('list.storage', { count: Number(storage.file_count), size: formatBytes(totalBytes) })}
                  </span>
                )}
              </div>
            </div>

            {topics.length > 0 && (
              <div className="px-6 py-2 border-b border-gray-100 flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">{t('topics.label')}</span>
                {topics.map(t => {
                  const active = topicFilter.includes(t.id);
                  return (
                    <button key={t.id} onClick={() => toggleTopicFilter(t.id)}
                            className={`text-xs px-2 py-0.5 rounded border transition-colors ${active ? 'text-white' : 'text-gray-700 hover:bg-gray-50'}`}
                            style={active ? { backgroundColor: t.color, borderColor: t.color } : { borderColor: t.color }}>
                      {t.name}
                    </button>
                  );
                })}
                {topicFilter.length > 0 && (
                  <button onClick={() => setTopicFilter([])} className="text-xs text-gray-500 underline ml-1">
                    {t('topics.reset')}
                  </button>
                )}
              </div>
            )}

            {selected.size > 0 && (
              <div className="px-6 py-2 bg-red-50 border-b border-red-200 flex items-center justify-between">
                <span className="text-sm text-red-800">{t('selection.count', { count: selected.size })}</span>
                <div className="flex gap-2">
                  <button onClick={() => setSelected(new Set())} className="text-xs text-gray-700 hover:underline">{t('selection.clear')}</button>
                  <button onClick={handleBulkDelete} className="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700">
                    {t('selection.delete', { count: selected.size })}
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="p-8 text-center text-gray-500">{t('list.loading')}</div>
            ) : filteredProjects.length === 0 ? (
              <div className="p-8 text-center">
                <div className="text-3xl mb-2">📂</div>
                <p className="text-gray-500">
                  {searchQuery
                    ? t('list.emptySearch', { query: searchQuery })
                    : t('list.empty')}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                <div className="px-6 py-2 bg-gray-50 flex items-center gap-3 text-xs text-gray-500">
                  <input type="checkbox" checked={selected.size === filteredProjects.length && filteredProjects.length > 0}
                         onChange={toggleSelectAll} className="cursor-pointer accent-primary-600"
                         aria-label={t('list.selectAll')} />
                  <span>
                    {t('list.selectAll')}
                    {searchQuery && (
                      <span className="ml-2 text-gray-400">
                        {t('list.filteredCount', { shown: filteredProjects.length, total: projects.length })}
                      </span>
                    )}
                  </span>
                </div>
                {groupedProjects.map(({ key, members }) => {
                  const head = members[0];
                  const memberIds = members.map((m) => m.id);
                  const groupChecked = memberIds.every((id) => selected.has(id));
                  const groupPartly = !groupChecked && memberIds.some((id) => selected.has(id));
                  // Segmentzahl und Größe stehen im Kopf, solange sie für alle Sprachen gleich
                  // sind — sonst (z. B. neuere Version in einer Sprache) je Zeile.
                  const uniform = members.every((m) =>
                    m.segment_count === head.segment_count &&
                    String(m.file_size_bytes ?? '') === String(head.file_size_bytes ?? ''));
                  // Gleiche Themen in allen Sprachen (der Normalfall) stehen einmal im Kopf statt
                  // in jeder Zeile — dort verdrängten sie Datum und Bearbeiter.
                  const headTopicKey = topicIdsOf(head).sort().join(',');
                  const sharedTopics = members.every((m) => topicIdsOf(m).sort().join(',') === headTopicKey);
                  const groupEditorKey = `group:${key}`;
                  return (
                    <div key={key} className="px-6 py-4">
                      <div className="flex items-start gap-3">
                        <input type="checkbox" checked={groupChecked}
                               ref={(el) => { if (el) el.indeterminate = groupPartly; }}
                               onChange={() => toggleGroup(memberIds, groupChecked)}
                               className="mt-1 cursor-pointer accent-primary-600"
                               title={t('list.selectGroup')} aria-label={t('list.selectGroup')} />
                        <span className="text-xl leading-none" aria-hidden="true">{FILE_TYPE_ICONS[head.file_type] || '📄'}</span>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-semibold text-gray-900 break-words">{head.name}</h3>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs text-gray-500">
                            <span className="uppercase">{head.file_type}</span>
                            {uniform && head.segment_count > 0 && (
                              <>
                                <span className="text-gray-300">·</span>
                                <span>{t('project.segments', { count: head.segment_count })}</span>
                              </>
                            )}
                            {uniform && (
                              <>
                                <span className="text-gray-300">·</span>
                                {renderSize(head)}
                              </>
                            )}
                          </div>
                        </div>
                        {sharedTopics && renderTopicChips(head.topics ?? [], groupEditorKey)}
                      </div>
                      {sharedTopics && topicEditorOpen === groupEditorKey &&
                        renderTopicEditor(topicIdsOf(head), memberIds, 'mt-2 sm:ml-7')}

                      <div className="mt-3 sm:ml-7 rounded-[5px] border border-gray-100 divide-y divide-gray-100">
                        {members.map((project) => {
                          const status = STATUS_LABELS[project.status] || STATUS_LABELS.pending;
                          const isExpanded = expandedProject === project.id;
                          const isChecked = selected.has(project.id);
                          const canExpand = project.segment_count > 0;
                          return (
                            <div key={project.id}>
                              <div className={`px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 transition-colors ${
                                isChecked ? 'bg-primary-50/60' : 'hover:bg-gray-50'
                              }`}>
                                <input type="checkbox" checked={isChecked}
                                       onChange={() => toggleSelected(project.id)}
                                       className="cursor-pointer accent-primary-600"
                                       aria-label={`${head.name} ${project.source_lang} → ${project.target_lang}`} />

                                {/* Aufklappen: ganze linke Zeilenhälfte, nicht nur der Pfeil */}
                                <button type="button"
                                        onClick={() => canExpand && setExpandedProject(isExpanded ? null : project.id)}
                                        aria-expanded={canExpand ? isExpanded : undefined}
                                        className={`flex items-center gap-3 min-w-0 flex-1 text-left rounded-[5px] ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}>
                                  <svg className={`w-3.5 h-3.5 shrink-0 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''} ${canExpand ? '' : 'invisible'}`}
                                       fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                                  </svg>
                                  <span className="text-xs font-semibold text-gray-800 whitespace-nowrap w-16 shrink-0">
                                    {project.source_lang} → {project.target_lang}
                                  </span>
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap ${status.color}`}>
                                    {t(status.label)}
                                  </span>
                                  {project.placeholder_warning?.triggered && (
                                    <span
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-300 whitespace-nowrap"
                                      title={t(
                                        project.placeholder_warning.loremIpsumDetected
                                          ? 'placeholder.tooltipLorem'
                                          : 'placeholder.tooltipIndesign',
                                        {
                                          count: project.placeholder_warning.placeholderCount,
                                          total: project.placeholder_warning.totalSegments,
                                        },
                                      )}
                                    >
                                      ⚠ {t('placeholder.badge')}
                                    </span>
                                  )}
                                  <span className="text-xs text-gray-400 truncate min-w-0"
                                        title={[
                                          formatDate(project.created_at),
                                          project.created_by_name,
                                          !uniform && project.segment_count > 0 ? t('project.segments', { count: project.segment_count }) : null,
                                        ].filter(Boolean).join(' · ')}>
                                    {formatDate(project.created_at)}
                                    {project.created_by_name && <> · {project.created_by_name}</>}
                                    {!uniform && project.segment_count > 0 && <> · {t('project.segments', { count: project.segment_count })}</>}
                                  </span>
                                  {!uniform && <span className="text-xs text-gray-400 whitespace-nowrap">{renderSize(project)}</span>}
                                </button>

                                {!sharedTopics && renderTopicChips(project.topics ?? [], project.id)}

                                <div className="flex items-center gap-1 ml-auto whitespace-nowrap">
                                  {project.status === 'completed' && onNavigateToReview && (
                                    <button type="button"
                                            onClick={() => onNavigateToReview(project.id, project.name, project.file_type)}
                                            className="text-xs font-semibold bg-primary-50 text-primary-700 px-2.5 py-1 rounded hover:bg-primary-100">
                                      {t('actions.review')}
                                    </button>
                                  )}
                                  {onNavigateToVersions && (
                                    <button type="button"
                                            onClick={() => onNavigateToVersions(project.id)}
                                            className="text-xs text-gray-500 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100"
                                            title={t('actions.versionsTitle')}>
                                      {t('actions.versions')}
                                    </button>
                                  )}
                                  <button type="button"
                                          onClick={() => {
                                            setParentProject({
                                              id: project.id, name: project.name,
                                              source_lang: project.source_lang, target_lang: project.target_lang,
                                            });
                                            window.scrollTo({ top: 0, behavior: 'smooth' });
                                          }}
                                          className="text-xs text-gray-500 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100"
                                          title={t('actions.newVersionTitle')}>
                                    {t('actions.newVersion')}
                                  </button>
                                  <button type="button"
                                          onClick={() => handleDelete(project.id)}
                                          className="text-gray-400 hover:text-red-600 hover:bg-red-50 p-1 rounded"
                                          title={t('actions.delete')} aria-label={t('actions.delete')}>
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              {!sharedTopics && topicEditorOpen === project.id &&
                                renderTopicEditor(topicIdsOf(project), [project.id], 'px-3 pb-3 pt-1 ml-6')}
                              <TranslationProgress projectId={project.id} status={project.status} />
                              {isExpanded && canExpand && (
                                <SegmentList projectId={project.id} segmentCount={project.segment_count} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
