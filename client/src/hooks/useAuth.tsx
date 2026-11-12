import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import i18n from '../i18n';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  /** Demo: gemeinsames Passwort, Gastsitzung (`POST /api/auth/demo`). */
  demoLogin: (passwort: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  microsoftEnabled: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers as Record<string, string> },
    ...options,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: i18n.t('common:auth.requestFailed') }));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return response.json();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [microsoftEnabled, setMicrosoftEnabled] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const data = await apiFetch<{ user: User }>('/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
    // Check Microsoft SSO availability
    apiFetch<{ enabled: boolean }>('/auth/microsoft/status')
      .then((data) => setMicrosoftEnabled(data.enabled))
      .catch(() => setMicrosoftEnabled(false));
  }, [checkAuth]);

  const login = async (email: string, password: string) => {
    setError(null);
    try {
      const data = await apiFetch<{ user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setUser(data.user);
    } catch (err) {
      const msg = err instanceof Error ? err.message : i18n.t('common:auth.loginFailed');
      setError(msg);
      throw err;
    }
  };

  const demoLogin = async (passwort: string, name: string) => {
    setError(null);
    try {
      const data = await apiFetch<{ user: User }>('/auth/demo', {
        method: 'POST',
        body: JSON.stringify({ passwort, name }),
      });
      setUser(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('common:auth.loginFailed'));
      throw err;
    }
  };

  const logout = async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, error, login, demoLogin, logout, microsoftEnabled }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
