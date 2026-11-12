import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { currentLocale } from '../../i18n';
import ReviewStatsBar from './ReviewStatsBar';
import FilterBar from './FilterBar';
import type { FilterValue } from './FilterBar';
import TerminologySuggestion from './TerminologySuggestion';
import HighlightedText from './HighlightedText';
import type { GlossaryHit } from './HighlightedText';
import DiffView from './DiffView';
import ReleaseBar, { fetchReleaseStatus } from './ReleaseBar';

interface Segment {
  id: string;
  segment_id: string;
  idml_segment_id: string;
  position: number;
  max_chars: number | null;
  source_text: string;
  translated_text: string | null;
  condensed_text: string | null;
  condense_status: string | null;
  review_status: string;
  edited_by_user: boolean;
  original_translation: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  clarification_note: string | null;
  clarification_at: string | null;
  clarification_by_name: string | null;
  /** Nur Deutsch → Deutsch: wie die Channel-Fassung entstand (Migration 025). */
  channel_rewrite?: {
    herkunft: 'sprachmodell' | 'regel';
    treffer: Array<{ original: string; ersatz: string }>;
    pruefen: string | null;
  } | null;
  source_glossary_hits?: GlossaryHit[];
  target_glossary_hits?: GlossaryHit[];
}

function formatTs(ts: string | null): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString(currentLocale(), {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

interface Candidate {
  sourceTerm: string;
  targetTerm: string;
  originalTargetTerm: string;
  confidence: number;
}

interface Props {
  projectId: string;
  projectName: string;
  fileType?: string;
  onBack: () => void;
}

export default function ReviewEditor({ projectId, projectName, fileType, onBack }: Props) {
  const { t } = useTranslation('review');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateSegId, setCandidateSegId] = useState<string | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [projectMeta, setProjectMeta] = useState<{ source_lang: string; target_lang: string } | null>(null);
  const [placeholderWarning, setPlaceholderWarning] = useState<{
    triggered: boolean;
    totalSegments: number;
    placeholderCount: number;
    loremIpsumDetected: boolean;
    samples: Array<{ id: string; preview: string; matchedTokens: string[] }>;
  } | null>(null);
  const [placeholderDismissed, setPlaceholderDismissed] = useState(false);
  const [quickaddOpen, setQuickaddOpen] = useState<{ segId: string; sourceTerm: string; targetTerm: string } | null>(null);
  const [quickaddBusy, setQuickaddBusy] = useState(false);
  const [quickaddMsg, setQuickaddMsg] = useState<string | null>(null);
  // Fehler-Kennung getrennt vom Text — der Text ist übersetzt, ein startsWith('Fehler') griffe nicht mehr.
  const [quickaddIsError, setQuickaddIsError] = useState(false);
  // Welcome-Banner zeigen wenn User via Deep-Link (E-Mail) angekommen ist
  const [showWelcome, setShowWelcome] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('cameFromReviewLink') === '1';
    } catch {
      return false;
    }
  });
  const [bulkBusy, setBulkBusy] = useState(false);
  const [clarificationFor, setClarificationFor] = useState<Segment | null>(null);
  const [clarificationNote, setClarificationNote] = useState('');
  const [expandedDiff, setExpandedDiff] = useState<Set<string>>(new Set());
  // Bulk-Select via Shift-Click: speichert die letzte angeklickte Checkbox
  const lastCheckedIdxRef = useRef<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Freigabe: nach jeder neuen Review-Anfrage neu laden; Download ohne Freigabe nur nach Bestätigung.
  const [requestCounter, setRequestCounter] = useState(0);
  const [downloadWarning, setDownloadWarning] = useState(false);
  const [downloadAck, setDownloadAck] = useState(false);

  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const scrollingRef = useRef(false);

  // Projekt-Metadaten für Glossar-Quickadd
  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then(r => r.ok ? r.json() : null)
      .then(p => {
        if (!p) return;
        setProjectMeta({ source_lang: p.source_lang, target_lang: p.target_lang });
        if (p.placeholder_warning?.triggered) {
          setPlaceholderWarning(p.placeholder_warning);
        }
      })
      .catch(() => {});
  }, [projectId]);

  // Segmente laden
  const loadSegments = useCallback(async () => {
    const filterParam = filter !== 'all' ? `&filter=${filter}` : '';
    const res = await fetch(`/api/projects/${projectId}/segments?limit=500${filterParam}`);
    const data = await res.json();
    setSegments(data.segments);

    const statsRes = await fetch(`/api/projects/${projectId}/segments/stats`);
    setStats(await statsRes.json());
    setLoading(false);
  }, [projectId, filter]);

  const submitQuickadd = async () => {
    if (!quickaddOpen || !projectMeta) return;
    setQuickaddBusy(true);
    setQuickaddMsg(null);
    setQuickaddIsError(false);
    try {
      const res = await fetch('/api/glossaries/quickadd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_term: quickaddOpen.sourceTerm.trim(),
          target_term: quickaddOpen.targetTerm.trim(),
          source_lang: projectMeta.source_lang,
          target_lang: projectMeta.target_lang,
          project_id: projectId,
          segment_id: quickaddOpen.segId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('quickadd.errorGeneric'));
      const labels: Record<string, string> = {
        created: t('quickadd.result.created'),
        updated: t('quickadd.result.updated'),
        unchanged: t('quickadd.result.unchanged'),
        // Nicht-Admins schlagen nur vor (PLAN-glossar-freigabe.md).
        vorschlag: t('quickadd.result.vorschlag'),
      };
      setQuickaddMsg(labels[data.action] || t('quickadd.result.done'));
      setTimeout(() => { setQuickaddOpen(null); setQuickaddMsg(null); }, 1500);
    } catch (err: any) {
      setQuickaddIsError(true);
      setQuickaddMsg(t('quickadd.error', { message: err?.message || t('quickadd.errorUnknown') }));
    } finally {
      setQuickaddBusy(false);
    }
  };

  useEffect(() => { loadSegments(); }, [loadSegments]);

  // Scroll-Sync
  const handleScroll = useCallback((source: 'left' | 'right') => {
    if (scrollingRef.current) return;
    scrollingRef.current = true;

    const from = source === 'left' ? leftRef.current : rightRef.current;
    const to = source === 'left' ? rightRef.current : leftRef.current;

    if (from && to) {
      const ratio = from.scrollTop / (from.scrollHeight - from.clientHeight || 1);
      to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    }

    requestAnimationFrame(() => { scrollingRef.current = false; });
  }, []);

  // Keyboard-Navigation: J/K/Space + Pfeiltasten
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editingId) return; // Nicht navigieren während Edit
      // Wenn ein Eingabefeld den Fokus hat, Shortcuts deaktivieren
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, segments.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === ' ' && activeIdx >= 0) {
        // Space toggelt Approval und springt zum nächsten Segment
        e.preventDefault();
        const cur = segments[activeIdx];
        if (cur && cur.translated_text) {
          toggleApproval(cur, { index: activeIdx });
          // Direkt weiter zum nächsten — flüssiger Arbeitsfluss
          setActiveIdx(i => Math.min(i + 1, segments.length - 1));
        }
      } else if ((e.key === 'Enter' || e.key === 'e' || e.key === 'E') && activeIdx >= 0) {
        e.preventDefault();
        startEdit(segments[activeIdx]);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        // Zum nächsten Review-Segment springen
        const nextIdx = segments.findIndex((s, i) =>
          i > activeIdx && (s.condense_status === 'still_long' || s.condense_status === 'manual_review' || s.review_status === 'pending')
        );
        if (nextIdx >= 0) setActiveIdx(nextIdx);
      } else if (e.key === '?' && activeIdx >= 0) {
        // ?-Taste öffnet Clarification-Dialog für aktives Segment
        e.preventDefault();
        const cur = segments[activeIdx];
        if (cur && cur.translated_text) {
          setClarificationFor(cur);
          setClarificationNote(cur.clarification_note || '');
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, activeIdx, segments]);

  // Scroll to active segment
  useEffect(() => {
    if (activeIdx >= 0) {
      const el = document.getElementById(`seg-right-${activeIdx}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeIdx]);

  const startEdit = (seg: Segment) => {
    setEditingId(seg.id);
    setEditText(seg.condensed_text || seg.translated_text || '');
    setCandidates([]);
    setCandidateSegId(null);
  };

  const saveEdit = async (seg: Segment) => {
    const finalText = editText.trim();
    if (!finalText || finalText === (seg.condensed_text || seg.translated_text)) {
      setEditingId(null);
      return;
    }

    try {
      const res = await fetch(`/api/projects/${projectId}/segments/${seg.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ translated_text: finalText }),
      });
      const data = await res.json();

      // Segment lokal aktualisieren
      setSegments(prev => prev.map(s =>
        s.id === seg.id
          ? { ...s, translated_text: finalText, condensed_text: null, review_status: 'edited', edited_by_user: true }
          : s
      ));

      // Terminology-Kandidaten anzeigen
      if (data.candidates && data.candidates.length > 0) {
        setCandidates(data.candidates);
        setCandidateSegId(seg.id);
      }
    } catch (err) {
      console.error('Save failed:', err);
    }

    setEditingId(null);
  };

  const approveSegment = async (seg: Segment) => {
    try {
      await fetch(`/api/projects/${projectId}/segments/${seg.id}/approve`, { method: 'POST' });
      const now = new Date().toISOString();
      setSegments(prev => prev.map(s =>
        s.id === seg.id
          ? { ...s, review_status: 'approved', approved_at: now, approved_by_name: t('you'), clarification_note: null }
          : s
      ));
    } catch (err) {
      console.error('Approve failed:', err);
    }
  };

  const unapproveSegment = async (seg: Segment) => {
    try {
      await fetch(`/api/projects/${projectId}/segments/${seg.id}/unapprove`, { method: 'POST' });
      setSegments(prev => prev.map(s =>
        s.id === seg.id
          ? { ...s, review_status: s.edited_by_user ? 'edited' : 'pending', approved_at: null, approved_by_name: null }
          : s
      ));
    } catch (err) {
      console.error('Unapprove failed:', err);
    }
  };

  const toggleApproval = (seg: Segment, opts?: { index?: number; shiftKey?: boolean }) => {
    // Shift-Click: Range-Select von letzter Checkbox bis hier — bulk-approve
    if (opts?.shiftKey && opts.index !== undefined && lastCheckedIdxRef.current !== null) {
      const from = Math.min(lastCheckedIdxRef.current, opts.index);
      const to = Math.max(lastCheckedIdxRef.current, opts.index);
      const range = segments.slice(from, to + 1).filter(s => s.translated_text && s.review_status !== 'approved');
      if (range.length > 0) {
        bulkApprove(range.map(s => s.id), t('toast.approvedRange', { count: range.length }));
        lastCheckedIdxRef.current = opts.index;
        return;
      }
    }
    if (opts?.index !== undefined) lastCheckedIdxRef.current = opts.index;
    if (seg.review_status === 'approved') {
      unapproveSegment(seg);
    } else {
      approveSegment(seg);
    }
  };

  const bulkApprove = async (ids: string[], successMsg?: string) => {
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/segments/bulk-approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_segment_ids: ids }),
      });
      const data = await res.json();
      const now = new Date().toISOString();
      const idSet = new Set(ids);
      setSegments(prev => prev.map(s =>
        idSet.has(s.id) && s.translated_text
          ? { ...s, review_status: 'approved', approved_at: now, approved_by_name: t('you'), clarification_note: null }
          : s
      ));
      setToast(successMsg || t('toast.approved', { count: data.approved }));
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      console.error('Bulk approve failed:', err);
      setToast(t('toast.bulkApproveFailed'));
      setTimeout(() => setToast(null), 3000);
    } finally {
      setBulkBusy(false);
    }
  };

  const approveAllVisible = async () => {
    const toApprove = segments.filter(s => s.translated_text && s.review_status !== 'approved');
    if (toApprove.length === 0) return;
    if (toApprove.length > 5 && !confirm(t('confirm.approveVisible', { count: toApprove.length }))) return;
    await bulkApprove(toApprove.map(s => s.id), t('toast.approved', { count: toApprove.length }));
  };

  const flagClarification = async (seg: Segment, note: string) => {
    try {
      await fetch(`/api/projects/${projectId}/segments/${seg.id}/clarification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      const now = new Date().toISOString();
      setSegments(prev => prev.map(s =>
        s.id === seg.id
          ? { ...s, review_status: 'needs_clarification', clarification_note: note, clarification_at: now, clarification_by_name: t('you'), approved_at: null, approved_by_name: null }
          : s
      ));
    } catch (err) {
      console.error('Flag clarification failed:', err);
    }
  };

  const clearClarification = async (seg: Segment) => {
    try {
      await fetch(`/api/projects/${projectId}/segments/${seg.id}/clarification`, { method: 'DELETE' });
      setSegments(prev => prev.map(s =>
        s.id === seg.id
          ? { ...s, review_status: s.edited_by_user ? 'edited' : 'pending', clarification_note: null, clarification_at: null, clarification_by_name: null }
          : s
      ));
    } catch (err) {
      console.error('Clear clarification failed:', err);
    }
  };

  const toggleDiff = (segId: string) => {
    setExpandedDiff(prev => {
      const next = new Set(prev);
      if (next.has(segId)) next.delete(segId);
      else next.add(segId);
      return next;
    });
  };

  // Fortschritts-Statistik für die Native-Speaker-Progressbar
  const approvedCount = segments.filter(s => s.review_status === 'approved').length;
  const translatedCount = segments.filter(s => s.translated_text).length;
  const progressPct = translatedCount > 0 ? Math.round((approvedCount / translatedCount) * 100) : 0;

  // Jede Statusänderung eines Segments kann eine Freigabe berühren.
  const releaseRefreshKey = `${requestCounter}|${segments.map(s => s.review_status).join(',')}`;

  const openDownload = () => {
    window.open(`/api/projects/${projectId}/download`, '_blank');
  };

  const handleDownload = async () => {
    // Frisch abfragen statt den angezeigten Stand zu nehmen — der kann veraltet sein.
    const status = await fetchReleaseStatus(projectId).catch(() => null);
    if (status?.released) {
      openDownload();
      return;
    }
    setDownloadAck(false);
    setDownloadWarning(true);
  };

  const getStatusColor = (seg: Segment): string => {
    if (seg.review_status === 'approved') return 'bg-green-500';
    if (seg.condense_status === 'still_long' || seg.condense_status === 'manual_review') return 'bg-red-500';
    if (seg.condense_status === 'condensed' || seg.condensed_text) return 'bg-amber-500';
    if (seg.translated_text) return 'bg-primary-400';
    return 'bg-gray-300';
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">{t('loading')}</div>;
  }

  return (
    // overflow-hidden: das Fenster selbst darf nie scrollen — sonst schiebt ein
    // fokussiertes Element den Editor aus dem Bild (graue Fläche statt Editor).
    <div className="flex flex-col h-screen overflow-hidden bg-gray-100">
      <ReviewStatsBar
        projectId={projectId}
        projectName={projectName}
        fileType={fileType}
        targetLang={projectMeta?.target_lang}
        onBack={onBack}
        onDownload={handleDownload}
        onRequestSent={() => setRequestCounter(c => c + 1)}
      />

      <ReleaseBar projectId={projectId} refreshKey={releaseRefreshKey} />

      {placeholderWarning && !placeholderDismissed && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="text-amber-600 text-lg leading-none mt-0.5">⚠</span>
            <div className="flex-1 text-sm">
              <div className="font-semibold text-amber-900">
                {t('placeholder.title', { found: placeholderWarning.placeholderCount, total: placeholderWarning.totalSegments })}
              </div>
              <p className="text-amber-800 mt-1">
                {placeholderWarning.loremIpsumDetected
                  ? t('placeholder.bodyLorem')
                  : t('placeholder.bodyIndesign')}
              </p>
              {placeholderWarning.samples.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-amber-900 hover:underline text-xs">
                    {t('placeholder.showSamples', { count: placeholderWarning.samples.length })}
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs text-amber-900 max-h-40 overflow-y-auto">
                    {placeholderWarning.samples.map((s, i) => (
                      <li key={i} className="bg-white/60 rounded px-2 py-1 border border-amber-200">
                        <span className="font-mono text-amber-700">{s.id}:</span>{' '}
                        <span className="italic">{s.preview}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <button
              onClick={() => setPlaceholderDismissed(true)}
              className="text-amber-700 hover:text-amber-900 text-sm"
              title={t('placeholder.dismiss')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {showWelcome && (
        <div className="bg-gradient-to-r from-cyan-50 to-primary-50 border-b border-cyan-200 px-4 py-3">
          <div className="flex items-start gap-3 max-w-5xl mx-auto">
            <span className="text-2xl leading-none">👋</span>
            <div className="flex-1 text-sm text-gray-800">
              <div className="font-semibold text-cyan-900 mb-1">
                {t('welcome.title')}
              </div>
              <p className="text-gray-700 mb-2">
                <Trans t={t} i18nKey="welcome.howTo" components={{ b: <strong /> }} />
              </p>
              <p className="text-xs text-gray-600 mb-1">
                <span className="inline-block w-3 h-3 align-middle bg-cyan-50 border-b-2 border-cyan-400 mr-1" style={{ borderBottomStyle: 'dotted' }}></span>
                <Trans t={t} i18nKey="welcome.glossaryHint" components={{ b: <strong /> }} />
              </p>
              <p className="text-xs text-gray-500">
                <Trans
                  t={t}
                  i18nKey="welcome.shortcuts"
                  components={{
                    b: <strong />,
                    k: <kbd className="px-1 py-0.5 bg-white border border-gray-300 rounded text-[10px]" />,
                  }}
                />
              </p>
            </div>
            <button
              onClick={() => {
                setShowWelcome(false);
                try { sessionStorage.removeItem('cameFromReviewLink'); } catch {}
              }}
              className="text-cyan-700 hover:text-cyan-900 text-sm font-medium"
            >
              {t('welcome.dismiss')} ✕
            </button>
          </div>
        </div>
      )}

      {/* Fortschritts-Balken (kompakt, zwischen Banner und Filtern) */}
      {translatedCount > 0 && (
        <div className="bg-white border-b px-4 py-2">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-600 font-medium whitespace-nowrap">
              {t('progress.label', { done: approvedCount, total: translatedCount })}
            </span>
            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-400 to-green-500 transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-xs font-semibold text-gray-700 w-10 text-right">{progressPct}%</span>
          </div>
        </div>
      )}

      <FilterBar
        active={filter}
        onChange={setFilter}
        counts={stats ? {
          condensed: parseInt(stats.condensed) || 0,
          needs_review: parseInt(stats.needs_review) || 0,
          approved: parseInt(stats.approved) || 0,
          clarification: parseInt(stats.clarification) || 0,
          edited: parseInt(stats.edited) || 0,
          total: parseInt(stats.total) || 0,
        } : undefined}
        visibleCount={segments.filter(s => s.translated_text && s.review_status !== 'approved').length}
        onBulkApprove={approveAllVisible}
        bulkBusy={bulkBusy}
      />

      {/* Split Pane */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Source */}
        <div
          ref={leftRef}
          onScroll={() => handleScroll('left')}
          className="w-1/2 overflow-y-auto border-r bg-gray-50"
        >
          <div className="p-2 space-y-1">
            {segments.map((seg, idx) => (
              <div
                key={seg.id}
                id={`seg-left-${idx}`}
                onClick={() => setActiveIdx(idx)}
                className={`p-2 rounded text-sm cursor-pointer transition-colors ${
                  activeIdx === idx ? 'bg-primary-50 ring-1 ring-primary-300' : 'hover:bg-gray-100'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-gray-400 font-mono">#{seg.position + 1}</span>
                  {seg.max_chars && (
                    <span className="text-xs bg-gray-200 text-gray-600 px-1 rounded">
                      {t('segment.maxChars', { max: seg.max_chars })}
                    </span>
                  )}
                </div>
                <div className="text-gray-800 break-words whitespace-pre-wrap">
                  <HighlightedText
                    text={seg.source_text}
                    hits={seg.source_glossary_hits || []}
                    side="source"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Translation */}
        <div
          ref={rightRef}
          onScroll={() => handleScroll('right')}
          className="w-1/2 overflow-y-auto bg-white"
        >
          <div className="p-2 space-y-1">
            {segments.map((seg, idx) => {
              const isApproved = seg.review_status === 'approved';
              const isClarification = seg.review_status === 'needs_clarification';
              const canApprove = !!seg.translated_text;
              const hasDiff = seg.edited_by_user && !!seg.original_translation;
              const diffOpen = expandedDiff.has(seg.id);
              const approvedTooltip = isApproved
                ? (seg.approved_by_name && seg.approved_at
                    ? t('tooltip.checkedByAt', { name: seg.approved_by_name, date: formatTs(seg.approved_at) })
                    : seg.approved_by_name
                    ? t('tooltip.checkedBy', { name: seg.approved_by_name })
                    : seg.approved_at
                    ? t('tooltip.checkedAt', { date: formatTs(seg.approved_at) })
                    : t('tooltip.checked'))
                : canApprove
                ? t('tooltip.markChecked')
                : t('tooltip.noTranslation');
              return (
              <div key={seg.id} id={`seg-right-${idx}`}>
                <div
                  className={`p-2 rounded text-sm transition-colors flex gap-2 ${
                    activeIdx === idx ? 'bg-primary-50 ring-1 ring-primary-300' : 'hover:bg-gray-50'
                  } ${isApproved ? 'bg-green-50/30' : ''} ${isClarification ? 'bg-orange-50/40 ring-1 ring-orange-200' : ''}`}
                >
                  {/* Prominente Approve-Checkbox links neben dem Text.
                      `relative` ist Pflicht: das sr-only-Input ist absolut positioniert und
                      säße sonst an seiner Dokumentposition weit unterhalb des Panels —
                      beim Fokus nach dem Klick scrollte das ganze Fenster dorthin
                      (Rückmeldung Native Speaker 18.09.2026: „Fenster schließt"). */}
                  <label
                    className={`relative flex-shrink-0 mt-0.5 cursor-pointer select-none ${
                      !canApprove ? 'opacity-30 cursor-not-allowed' : ''
                    }`}
                    onClick={(e) => e.stopPropagation()}
                    title={approvedTooltip}
                  >
                    <input
                      type="checkbox"
                      checked={isApproved}
                      disabled={!canApprove}
                      onChange={() => {}}
                      onClick={(e) => {
                        if (!canApprove) return;
                        toggleApproval(seg, { index: idx, shiftKey: (e as any).shiftKey });
                      }}
                      className="sr-only peer"
                    />
                    <span
                      className={`block w-6 h-6 rounded border-2 flex items-center justify-center transition-all ${
                        isApproved
                          ? 'bg-green-500 border-green-500 text-white shadow-sm'
                          : 'bg-white border-gray-300 hover:border-green-400 hover:bg-green-50'
                      }`}
                    >
                      {isApproved && (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                  </label>

                  {/* Klickbarer Textbereich */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => {
                      setActiveIdx(idx);
                      if (editingId !== seg.id) startEdit(seg);
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`w-2 h-2 rounded-full ${getStatusColor(seg)}`} />
                        <span className="text-xs text-gray-400 font-mono">#{seg.position + 1}</span>
                        {seg.edited_by_user && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleDiff(seg.id); }}
                            className="text-xs text-purple-600 hover:text-purple-800 underline-offset-2 hover:underline"
                            title={hasDiff ? t('tooltip.showDiff') : t('tooltip.edited')}
                          >
                            {t('segment.edited')} {hasDiff && (diffOpen ? '▲' : '▼')}
                          </button>
                        )}
                        {seg.condensed_text && (
                          <span className="text-xs text-amber-600" title={t('tooltip.condensed')}>{t('segment.condensed')}</span>
                        )}
                        {seg.channel_rewrite && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${seg.channel_rewrite.pruefen ? 'text-amber-800 bg-amber-100 font-medium' : 'text-teal-700 bg-teal-50'}`}
                            title={[
                              ...seg.channel_rewrite.treffer.map((h) => `${h.original} → ${h.ersatz}`),
                              seg.channel_rewrite.pruefen ?? '',
                            ].filter(Boolean).join('\n')}
                          >
                            {seg.channel_rewrite.pruefen ? `⚠ ${t('segment.channelRewriteCheck')}` : t('segment.channelRewrite')}
                          </span>
                        )}
                        {(seg.target_glossary_hits?.length || 0) > 0 && (
                          <span className="text-[10px] text-cyan-700 bg-cyan-50 px-1.5 py-0.5 rounded" title={t('tooltip.glossaryTerms')}>
                            📖 {seg.target_glossary_hits!.length}
                          </span>
                        )}
                        {isClarification && (
                          <span className="text-[10px] text-orange-700 bg-orange-100 px-1.5 py-0.5 rounded font-medium" title={t('tooltip.clarificationBy', { name: seg.clarification_by_name || '?', date: formatTs(seg.clarification_at) })}>
                            ❓ {t('segment.clarification')}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {seg.translated_text && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setClarificationFor(seg);
                              setClarificationNote(seg.clarification_note || '');
                            }}
                            className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                              isClarification
                                ? 'text-orange-700 bg-orange-100 hover:bg-orange-200'
                                : 'text-gray-400 hover:text-orange-600 hover:bg-orange-50'
                            }`}
                            title={isClarification ? t('tooltip.clarificationEdit') : t('tooltip.clarificationAsk')}
                          >
                            ?
                          </button>
                        )}
                        {seg.translated_text && projectMeta && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const sel = window.getSelection()?.toString().trim() || '';
                              setQuickaddOpen({
                                segId: seg.id,
                                sourceTerm: '',
                                targetTerm: sel,
                              });
                            }}
                            className="text-primary-600 hover:text-primary-800 text-xs px-1"
                            title={t('tooltip.quickadd')}
                          >
                            📖
                          </button>
                        )}
                      </div>
                    </div>

                    {editingId === seg.id ? (
                      <div>
                        <textarea
                          autoFocus
                          value={editText}
                          onChange={e => setEditText(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(seg); }
                            if (e.key === 'Escape') { setEditingId(null); }
                          }}
                          onBlur={() => saveEdit(seg)}
                          className="w-full p-1 border rounded text-sm resize-none focus:ring-1 focus:ring-primary-400 focus:outline-none"
                          rows={Math.max(2, Math.ceil((editText.length || 1) / 60))}
                        />
                        {seg.max_chars && (
                          <div className={`text-xs mt-0.5 ${editText.length > seg.max_chars ? 'text-red-500' : 'text-gray-400'}`}>
                            {t('editor.charCount', { len: editText.length, max: seg.max_chars })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-gray-800 break-words whitespace-pre-wrap">
                        {seg.condensed_text || seg.translated_text ? (
                          <HighlightedText
                            text={seg.condensed_text || seg.translated_text || ''}
                            hits={seg.target_glossary_hits || []}
                            side="target"
                          />
                        ) : (
                          <span className="text-gray-300 italic">{t('segment.noTranslation')}</span>
                        )}
                      </div>
                    )}

                    {/* Diff zur Original-Übersetzung */}
                    {hasDiff && diffOpen && (
                      <DiffView
                        original={seg.original_translation!}
                        current={seg.condensed_text || seg.translated_text || ''}
                      />
                    )}

                    {/* Clarification-Note inline anzeigen */}
                    {isClarification && seg.clarification_note && (
                      <div
                        className="mt-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded text-xs"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <div className="text-[10px] uppercase tracking-wide text-orange-700 font-semibold mb-1">
                              {seg.clarification_by_name
                                ? t('clarificationNote.headerBy', { name: seg.clarification_by_name })
                                : t('clarificationNote.header')}
                            </div>
                            <div className="text-orange-900 italic">{seg.clarification_note}</div>
                          </div>
                          <button
                            onClick={() => clearClarification(seg)}
                            className="text-orange-600 hover:text-orange-900 text-xs"
                            title={t('clarificationDialog.remove')}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Terminology-Vorschläge */}
                {candidateSegId === seg.id && candidates.length > 0 && (
                  <TerminologySuggestion
                    candidates={candidates}
                    projectId={projectId}
                    onDismiss={() => { setCandidates([]); setCandidateSegId(null); }}
                  />
                )}
              </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Clarification-Dialog */}
      {clarificationFor && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={() => setClarificationFor(null)}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('clarificationDialog.title')}</h3>
            <p className="text-xs text-gray-500 mb-3">
              {t('clarificationDialog.intro', { num: clarificationFor.position + 1 })}
            </p>
            <div className="mb-3 p-2 bg-gray-50 rounded text-xs text-gray-700 border border-gray-200">
              <div className="font-medium text-gray-500 mb-1">{t('clarificationDialog.sourceText')}</div>
              <div className="line-clamp-3">{clarificationFor.source_text}</div>
            </div>
            <label className="block text-xs font-medium text-gray-700 mb-1">{t('clarificationDialog.noteLabel')}</label>
            <textarea
              autoFocus
              value={clarificationNote}
              onChange={(e) => setClarificationNote(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder={t('clarificationDialog.notePlaceholder')}
              className="w-full text-sm px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <div className="flex justify-between items-center mt-4">
              {clarificationFor.review_status === 'needs_clarification' ? (
                <button
                  onClick={async () => {
                    await clearClarification(clarificationFor);
                    setClarificationFor(null);
                  }}
                  className="text-xs text-red-600 hover:underline"
                >
                  {t('clarificationDialog.remove')}
                </button>
              ) : <span />}
              <div className="flex gap-2">
                <button
                  onClick={() => setClarificationFor(null)}
                  className="text-xs text-gray-600 px-3 py-1.5 hover:underline"
                >
                  {t('actions.cancel')}
                </button>
                <button
                  onClick={async () => {
                    if (!clarificationFor) return;
                    await flagClarification(clarificationFor, clarificationNote.trim());
                    setClarificationFor(null);
                  }}
                  disabled={!clarificationNote.trim()}
                  className="text-xs bg-orange-600 text-white px-4 py-1.5 rounded hover:bg-orange-700 disabled:bg-gray-300"
                >
                  {t('clarificationDialog.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast für Bulk-Aktionen */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-gray-900 text-white px-4 py-2 rounded shadow-lg text-sm z-50">
          {toast}
        </div>
      )}

      {downloadWarning && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
             onClick={() => setDownloadWarning(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-5"
               onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-amber-800 mb-2">⚠ {t('downloadWarning.title')}</h3>
            <p className="text-sm text-gray-700 mb-4">
              {t('downloadWarning.body')}
            </p>
            <label className="flex items-start gap-2 text-sm text-gray-800 mb-5 cursor-pointer">
              <input type="checkbox" checked={downloadAck} onChange={e => setDownloadAck(e.target.checked)}
                     className="mt-0.5" />
              <span>{t('downloadWarning.ack')}</span>
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDownloadWarning(false)}
                      className="text-sm px-4 py-2 rounded text-gray-700 hover:bg-gray-100">
                {t('actions.cancel')}
              </button>
              <button onClick={() => { setDownloadWarning(false); openDownload(); }}
                      disabled={!downloadAck}
                      className="text-sm px-4 py-2 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:bg-gray-200 disabled:text-gray-400">
                {t('downloadWarning.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {quickaddOpen && projectMeta && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
             onClick={() => !quickaddBusy && setQuickaddOpen(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-5"
               onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('quickadd.title')}</h3>
            <p className="text-xs text-gray-500 mb-4">
              {projectMeta.source_lang} → {projectMeta.target_lang}
              <span className="text-gray-400"> · {t('quickadd.syncHint')}</span>
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t('quickadd.sourceLabel', { lang: projectMeta.source_lang })}
                </label>
                <input type="text" value={quickaddOpen.sourceTerm} autoFocus
                       onChange={e => setQuickaddOpen({ ...quickaddOpen, sourceTerm: e.target.value })}
                       className="w-full rounded-md border border-gray-300 text-sm p-2"
                       placeholder={t('quickadd.sourcePlaceholder')} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t('quickadd.targetLabel', { lang: projectMeta.target_lang })}
                </label>
                <input type="text" value={quickaddOpen.targetTerm}
                       onChange={e => setQuickaddOpen({ ...quickaddOpen, targetTerm: e.target.value })}
                       className="w-full rounded-md border border-gray-300 text-sm p-2" />
              </div>
            </div>
            {quickaddMsg && (
              <p className={`mt-3 text-sm ${quickaddIsError ? 'text-red-600' : 'text-green-700'}`}>
                {quickaddMsg}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setQuickaddOpen(null)} disabled={quickaddBusy}
                      className="text-sm px-4 py-2 rounded text-gray-700 hover:bg-gray-100">
                {t('actions.cancel')}
              </button>
              <button onClick={submitQuickadd}
                      disabled={quickaddBusy || !quickaddOpen.sourceTerm.trim() || !quickaddOpen.targetTerm.trim()}
                      className="text-sm px-4 py-2 rounded bg-primary-600 text-white hover:bg-primary-700 disabled:bg-gray-200 disabled:text-gray-400">
                {quickaddBusy ? t('quickadd.saving') : t('quickadd.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
