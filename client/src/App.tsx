import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './hooks/useAuth';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import CostDashboard from './pages/CostDashboard';
import AdminSettings from './pages/AdminSettings';
import GlossaryManager from './components/GlossaryManager';
import ReviewEditor from './components/review/ReviewEditor';
import TerminologyScanPage from './pages/TerminologyScanPage';
import ScanReview from './components/terminology-scan/ScanReview';
import TextwerkstattPage from './pages/TextwerkstattPage';
import ConsistencyCheckPage from './pages/ConsistencyCheckPage';
import VersionDiffPage from './pages/VersionDiffPage';
import PanelConnectPage from './pages/PanelConnectPage';
import PanelConnectionsPage from './pages/PanelConnectionsPage';
import ErrorBoundary from './components/ErrorBoundary';
import AppHeader, { type Tab, ADMIN_TABS, resolveTab } from './components/AppHeader';

/**
 * Textwerkstatt — Rahmen der Anwendung. Das Erscheinungsbild kommt aus dem Thema (client/themes/<name>/).
 */

// Beim allerersten App-Render `?review=<id>` aus der URL lesen und in
// sessionStorage parken — der Microsoft-OAuth-Redirect strippt Query-Params,
// sonst geht der Deep-Link nach dem Login verloren.
const PENDING_REVIEW_KEY = 'pendingReviewProjectId';
(function captureReviewDeepLink() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  // `review` = Link für Reviewer (mit Willkommens-Hinweis), `project` = Link aus
  // den Freigabe-Meldungen an die anfragende Person (ohne Hinweis).
  const reviewId = params.get('review');
  const projectId = params.get('project');
  const target = reviewId || projectId;
  if (!target) return;
  try {
    sessionStorage.setItem(PENDING_REVIEW_KEY, target);
    // Marker fuer Welcome-Banner im ReviewEditor
    if (reviewId) sessionStorage.setItem('cameFromReviewLink', '1');
  } catch { /* sessionStorage evtl. blockiert (Privat-Modus) — egal */ }
  // URL bereinigen, damit Refresh nicht erneut triggert
  params.delete('review');
  params.delete('project');
  const cleanQuery = params.toString();
  const cleanUrl = window.location.pathname + (cleanQuery ? `?${cleanQuery}` : '') + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
})();

// Dasselbe für `?panel=<id>`: Das Illustrator-Panel öffnet diesen Link zum
// Verbinden (PLAN-panel-anmeldung.md). Die ID überlebt so den Microsoft-Login.
const PENDING_PANEL_KEY = 'pendingPanelPairing';
(function capturePanelPairingLink() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const pairingId = params.get('panel');
  if (!pairingId) return;
  try { sessionStorage.setItem(PENDING_PANEL_KEY, pairingId); } catch { /* Privat-Modus — egal */ }
  params.delete('panel');
  const cleanQuery = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (cleanQuery ? `?${cleanQuery}` : '') + window.location.hash);
})();

function readPendingPanel(): string | null {
  try { return sessionStorage.getItem(PENDING_PANEL_KEY); } catch { return null; }
}

// Reiter aus der Adresse: `#glossaries`, `?tab=glossaries` oder `/glossaries`. Frühere
// Kennungen (`schreibhilfe`, `quick-translate`) führen in die Textwerkstatt (Phase 1,
// 10.11.2026). Bis dahin hatte kein Reiter eine Adresse; jetzt steht der aktive im `#`,
// damit Lesezeichen und Neuladen auf demselben Reiter landen, auch über die Anmeldung hinweg.
const DEFAULT_TAB: Tab = 'textwerkstatt';

function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

function tabFromUrl(): Tab | null {
  if (typeof window === 'undefined') return null;
  const { hash, search, pathname } = window.location;
  return (
    resolveTab(safeDecode(hash.replace(/^#\/?/, ''))) ??
    resolveTab(new URLSearchParams(search).get('tab')) ??
    resolveTab(safeDecode(pathname.replace(/^\/+|\/+$/g, '')))
  );
}

// Der Microsoft-Login endet in `redirect('/')` und verliert `#` und `?tab=`. Wie beim
// Review-Link wird der Reiter deshalb vorher geparkt und nach der Anmeldung eingelöst.
const PENDING_TAB_KEY = 'pendingTab';
(function captureTabLink() {
  const tab = tabFromUrl();
  if (!tab) return;
  try { sessionStorage.setItem(PENDING_TAB_KEY, tab); } catch { /* Privat-Modus — egal */ }
})();

function readPendingTab(): Tab | null {
  try { return resolveTab(sessionStorage.getItem(PENDING_TAB_KEY)); } catch { return null; }
}

/** Schreibt den aktiven Reiter in den `#` und räumt `?tab=` und einen Reiterpfad weg. */
function writeTabToUrl(tab: Tab) {
  const params = new URLSearchParams(window.location.search);
  params.delete('tab');
  const query = params.toString();
  const path = resolveTab(safeDecode(window.location.pathname.replace(/^\/+|\/+$/g, '')))
    ? '/'
    : window.location.pathname;
  const next = `${path}${query ? `?${query}` : ''}#${tab}`;
  if (next !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.replaceState(window.history.state, '', next);
  }
}

function App() {
  const { t } = useTranslation('common');
  const { user, isLoading, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>(() => tabFromUrl() ?? readPendingTab() ?? DEFAULT_TAB);
  const [reviewProject, setReviewProject] = useState<{ id: string; name: string; fileType: string } | null>(null);
  const [reviewScan, setReviewScan] = useState<{ id: string; name: string } | null>(null);
  const [versionsProject, setVersionsProject] = useState<string | null>(null);
  const [panelPairing, setPanelPairing] = useState<string | null>(readPendingPanel);
  const closePanelPairing = () => {
    try { sessionStorage.removeItem(PENDING_PANEL_KEY); } catch { /* ignore */ }
    setPanelPairing(null);
  };

  // Ein neuer Reiter beginnt oben — sonst öffnete „Admin“ mitten in der Benutzerliste,
  // weil die Scrollposition des vorigen Reiters stehen blieb.
  useEffect(() => { window.scrollTo(0, 0); }, [activeTab]);

  // Verwaltungsreiter über die Adresse nur für Admins. `shownTab` gilt schon beim Rendern,
  // damit ein Nicht-Admin die Verwaltung nicht einmal kurz eingehängt bekommt.
  const shownTab: Tab =
    user && user.role !== 'admin' && ADMIN_TABS.includes(activeTab) ? DEFAULT_TAB : activeTab;
  useEffect(() => {
    if (shownTab !== activeTab) setActiveTab(shownTab);
  }, [shownTab, activeTab]);

  // Erst nach der Anmeldung schreiben: Die Anmeldeseite soll die Adresse nicht verändern.
  useEffect(() => {
    if (!user) return;
    try { sessionStorage.removeItem(PENDING_TAB_KEY); } catch { /* ignore */ }
    writeTabToUrl(shownTab);
  }, [user, shownTab]);

  // Ändert jemand den `#` im offenen Tab (Lesezeichen, Link), folgt der Reiter.
  useEffect(() => {
    const onHash = () => { const tab = tabFromUrl(); if (tab) setActiveTab(tab); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Pending Review-Deep-Link einloesen, sobald der User eingeloggt ist
  useEffect(() => {
    if (!user || reviewProject) return;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_REVIEW_KEY);
    } catch { /* ignore */ }
    if (!pending) return;
    fetch(`/api/projects/${pending}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (p && p.id) {
          setReviewProject({ id: p.id, name: p.name, fileType: p.file_type });
        }
      })
      .catch(() => { /* Projekt evtl. geloescht — still ignorieren */ })
      .finally(() => {
        try { sessionStorage.removeItem(PENDING_REVIEW_KEY); } catch { /* ignore */ }
      });
  }, [user, reviewProject]);

  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: 'var(--pal-main-bg)' }}
      >
        <div className="text-[color:var(--pal-text-muted)] text-sm">{t('app.loading')}</div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  // Panel verbinden hat Vorrang: Wer aus Illustrator kommt, soll zuerst diese Frage sehen.
  if (panelPairing) {
    return (
      <div className="min-h-screen" style={{ backgroundColor: 'var(--pal-main-bg)' }}>
        <AppHeader
          activeTab="panel"
          onTabChange={(tab) => { closePanelPairing(); setActiveTab(tab); }}
          user={user}
          onLogout={logout}
        />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <PanelConnectPage
            pairingId={panelPairing}
            onClose={() => { closePanelPairing(); setActiveTab('panel'); }}
          />
        </main>
      </div>
    );
  }

  if (reviewProject) {
    return (
      <ReviewEditor
        projectId={reviewProject.id}
        projectName={reviewProject.name}
        fileType={reviewProject.fileType}
        onBack={() => setReviewProject(null)}
      />
    );
  }

  if (reviewScan) {
    return (
      <ScanReview
        scanId={reviewScan.id}
        scanName={reviewScan.name}
        onBack={() => setReviewScan(null)}
      />
    );
  }

  // Der Versionsvergleich hatte bis 22.10.2026 keine Kopfzeile — man kam nur über
  // „Zurück“ wieder heraus. Jetzt steht er unter „Dokumente“, jeder Reiter führt hinaus.
  if (versionsProject) {
    return (
      <div className="min-h-screen" style={{ backgroundColor: 'var(--pal-main-bg)' }}>
        <AppHeader
          activeTab="projects"
          onTabChange={(tab) => { setVersionsProject(null); setActiveTab(tab); }}
          user={user}
          onLogout={logout}
        />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <VersionDiffPage projectId={versionsProject} onBack={() => setVersionsProject(null)} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--pal-main-bg)' }}>
      <AppHeader activeTab={shownTab} onTabChange={setActiveTab} user={user} onLogout={logout} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ErrorBoundary key={shownTab} context={shownTab}>
          {shownTab === 'projects' && (
            <Dashboard
              onNavigateToReview={(id, name, fileType) => setReviewProject({ id, name, fileType })}
              onNavigateToVersions={(id) => setVersionsProject(id)}
            />
          )}
          {shownTab === 'textwerkstatt' && <TextwerkstattPage />}
          {shownTab === 'glossaries' && <GlossaryManager />}
          {shownTab === 'terminology-scan' && (
            <TerminologyScanPage onNavigateToReview={(id, name) => setReviewScan({ id, name })} />
          )}
          {shownTab === 'consistency' && <ConsistencyCheckPage />}
          {shownTab === 'costs' && <CostDashboard />}
          {shownTab === 'admin' && <AdminSettings />}
          {shownTab === 'panel' && <PanelConnectionsPage />}
        </ErrorBoundary>
      </main>
    </div>
  );
}

export default App;
