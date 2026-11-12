import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import thema from '@thema';
import { ladeEinstellungen } from './einstellungen';

// Erst die öffentlichen Einstellungen, dann i18n und App: Der Organisationsname ist die Vorgabe für {{org}} in
// den Texten und muss stehen, bevor i18n startet. Deshalb kommen i18n und alles, was es mitlädt, dynamisch.
ladeEinstellungen().then(async () => {
  await import('./i18n'); // vor App: Sprache steht fest, bevor der erste Text rendert
  const [{ AuthProvider }, { default: App }, { default: ErrorBoundary }, { default: DemoHinweis }] = await Promise.all([
    import('./hooks/useAuth'),
    import('./App'),
    import('./components/ErrorBoundary'),
    import('./components/DemoHinweis'),
  ]);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary context="App">
        {/* Hintergrund und Footer des Themas (Atelier: Skizzen, Querverlinkung); ein Thema ohne setzt `null` */}
        {thema.Hintergrund && <thema.Hintergrund />}
        {/* Nur in der Demo sichtbar, über jeder Seite (PLAN-oeffentlich-und-demo.md Phase 2) */}
        <DemoHinweis />
        <AuthProvider>
          <App />
        </AuthProvider>
        {thema.Fuss && <thema.Fuss />}
      </ErrorBoundary>
    </React.StrictMode>
  );
});
