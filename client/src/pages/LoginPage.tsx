import { useState, FormEvent, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { einstellungen } from '../einstellungen';
import thema from '@thema';

/**
 * LoginPage — Karte, Logo, Titel und Feldstil aus dem Thema (`thema.anmeldung`), Farben der Texte aus `--login-*`.
 * Microsoft-Auth primaer, E-Mail/Passwort hinter Accordion "Alternative Anmeldemethoden".
 */

// Fehlercode aus `?auth_error=` → Übersetzungsschlüssel (Namespace common).
const AUTH_ERROR_KEYS: Record<string, string> = {
  microsoft_denied: 'login.errors.microsoftDenied',
  invalid_state: 'login.errors.invalidState',
  no_code: 'login.errors.noCode',
  token_exchange: 'login.errors.tokenExchange',
  no_id_token: 'login.errors.noIdToken',
  missing_claims: 'login.errors.missingClaims',
  account_inactive: 'login.errors.accountInactive',
  internal_error: 'login.errors.internalError',
};

// Eingabefeld auf der Anmeldekarte mit sichtbarem Fokus: ohne ihn war bei Tastaturbedienung
// nicht zu erkennen, welches Feld aktiv ist (22.10.2026).
const DARK_INPUT =
  'w-full px-3 py-2 rounded-[5px] text-sm outline-none transition-colors ' + thema.anmeldung.feld;

const FEHLER_STIL = {
  backgroundColor: 'var(--login-fehler-grund)',
  border: '1px solid var(--login-fehler-rand)',
  color: 'var(--login-fehler-text)',
};

/**
 * Demo: ein gemeinsames Passwort und ein frei wählbarer Anzeigename statt Anmeldung (PLAN-oeffentlich-und-demo.md Phase 2).
 * Der Server kennt in der Demo keinen anderen Weg hinein.
 */
function DemoTor() {
  const { t } = useTranslation('common');
  const { demoLogin, error } = useAuth();
  const [name, setName] = useState('');
  const [passwort, setPasswort] = useState('');
  const [laeuft, setLaeuft] = useState(false);
  const absenden = async (e: FormEvent) => {
    e.preventDefault();
    setLaeuft(true);
    try {
      await demoLogin(passwort, name);
    } catch {
      // Fehler steht in useAuth
    } finally {
      setLaeuft(false);
    }
  };
  return (
    <form onSubmit={absenden} className="space-y-3">
      <p className="text-sm" style={{ color: 'var(--login-text-hell)' }}>{t('demo.torText')}</p>
      {error && (
        <div role="alert" className="p-3 rounded-[5px] text-sm" style={FEHLER_STIL}>
          {error}
        </div>
      )}
      <div>
        <label htmlFor="demo-name" className="block text-xs font-medium mb-1" style={{ color: 'var(--login-text-leise)' }}>{t('demo.name')}</label>
        <input id="demo-name" type="text" value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
          autoComplete="nickname" className={DARK_INPUT} />
      </div>
      <div>
        <label htmlFor="demo-passwort" className="block text-xs font-medium mb-1" style={{ color: 'var(--login-text-leise)' }}>{t('demo.passwort')}</label>
        <input id="demo-passwort" type="password" value={passwort} required onChange={(e) => setPasswort(e.target.value)}
          autoComplete="current-password" className={DARK_INPUT} autoFocus />
      </div>
      <button type="submit" disabled={laeuft}
        className="w-full inline-flex items-center justify-center px-4 py-2.5 rounded-[5px] text-sm font-semibold text-white mt-1 bg-[var(--pal-primary-btn)] hover:bg-[var(--pal-primary-btn-hover)] disabled:opacity-60">
        {laeuft ? t('login.submitting') : t('demo.hinein')}
      </button>
    </form>
  );
}

export default function LoginPage() {
  const { t } = useTranslation('common');
  const { login, error, microsoftEnabled } = useAuth();
  const istDemo = einstellungen().demo !== null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Nur der Code wird gespeichert — der Text folgt so einem Sprachwechsel.
  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
  const [showAlternative, setShowAlternative] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get('auth_error');
    if (errorCode) {
      setAuthErrorCode(errorCode);
      window.history.replaceState({}, '', '/login');
    }
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setAuthErrorCode(null);
    try {
      await login(email, password);
    } catch {
      // error is set in useAuth
    } finally {
      setIsSubmitting(false);
    }
  };

  const alternativeVisible = !microsoftEnabled || showAlternative;
  const authError = authErrorCode
    ? (AUTH_ERROR_KEYS[authErrorCode] ? t(AUTH_ERROR_KEYS[authErrorCode]) : t('login.errorUnknown', { code: authErrorCode }))
    : null;

  return (
    <div
      className="relative min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--pal-main-bg)' }}
    >
      {/* Sprachwahl schon vor der Anmeldung */}
      <div className="absolute top-4 right-4">
        <LanguageSwitcher variant="light" />
      </div>
      <div className="w-full max-w-md">
        {/* Anmeldekarte des Themas */}
        <div className="rounded-[8px] overflow-hidden" style={thema.anmeldung.karte}>
          <div className="px-8 py-9">
            <div className="mb-7">
              <thema.AnmeldeLogo />
            </div>

            {/* App-Name + Subline */}
            <div className={`${thema.anmeldung.kopf} mb-7`}>
              <h1 className={thema.anmeldung.titel} style={thema.anmeldung.titelStil}>
                {thema.anmeldung.titelText ?? einstellungen().appName}
              </h1>
              <p className="text-sm mt-1" style={{ color: 'var(--login-text-leise)' }}>
                {t('app.subtitle')}
              </p>
            </div>

            {istDemo ? <DemoTor /> : <>
            {(authError || error) && (
              <div className="mb-4 p-3 rounded-[5px] text-sm" style={FEHLER_STIL}>
                {authError || error}
              </div>
            )}

            {/* Microsoft Login — Primaer */}
            {microsoftEnabled && (
              <a
                href="/api/auth/microsoft"
                className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-3 rounded-[5px] text-sm font-semibold text-white transition-colors bg-[var(--pal-primary-btn)] hover:bg-[var(--pal-primary-btn-hover)]"
              >
                {/* Weißes Feld hinter dem Logo: Microsofts Vorgabe, und das blaue Viertel
                    verschwände sonst im Cyan des Knopfs. */}
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-[3px] bg-white" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 21 21">
                  <rect x="1" y="1" width="9" height="9" fill="#F25022" />
                  <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
                  <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
                  <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
                </svg>
                </span>
                {t('login.microsoft')}
              </a>
            )}

            {/* Accordion-Toggle */}
            {microsoftEnabled && (
              <button
                type="button"
                onClick={() => setShowAlternative(!showAlternative)}
                aria-expanded={showAlternative}
                className="w-full inline-flex items-center justify-center gap-2 mt-5 py-2 text-xs transition-colors"
                style={{ color: showAlternative ? 'var(--login-text-hell)' : 'var(--login-text-leise)' }}
              >
                <svg
                  className="transition-transform duration-300"
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  style={{ transform: showAlternative ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {t('login.alternative')}
              </button>
            )}

            {/* Alternative-Login-Form (Slide-Down) */}
            <div
              className="grid transition-all duration-300 ease-out"
              style={{
                gridTemplateRows: alternativeVisible ? '1fr' : '0fr',
                opacity: alternativeVisible ? 1 : 0,
                marginTop: alternativeVisible && microsoftEnabled ? '0.75rem' : 0,
              }}
            >
              <div className="overflow-hidden">
                <form onSubmit={handleSubmit} className="space-y-3">
                  <div>
                    <label
                      htmlFor="email"
                      className="block text-xs font-medium mb-1"
                      style={{ color: 'var(--login-text-leise)' }}
                    >
                      {t('login.email')}
                    </label>
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required={alternativeVisible}
                      autoComplete="email"
                      className={DARK_INPUT}
                      autoFocus={!microsoftEnabled}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="password"
                      className="block text-xs font-medium mb-1"
                      style={{ color: 'var(--login-text-leise)' }}
                    >
                      {t('login.password')}
                    </label>
                    <input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required={alternativeVisible}
                      autoComplete="current-password"
                      className={DARK_INPUT}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-[5px] text-sm font-semibold transition-colors mt-1"
                    style={{
                      backgroundColor: microsoftEnabled
                        ? 'var(--login-zweitknopf-grund)'
                        : 'var(--pal-primary-btn)',
                      border: microsoftEnabled ? 'var(--login-zweitknopf-rand)' : 'none',
                      color: microsoftEnabled ? 'var(--login-zweitknopf-text)' : '#fff',
                      opacity: isSubmitting ? 0.6 : 1,
                      cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {isSubmitting ? t('login.submitting') : t('login.submit')}
                  </button>
                </form>
              </div>
            </div>
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}
