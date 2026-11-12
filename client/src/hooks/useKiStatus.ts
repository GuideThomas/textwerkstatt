/**
 * Zustand der KI-Wege der Textwerkstatt für den angemeldeten Nutzer (`GET /api/textwerkstatt/ki-status`, Phase 2, #1838).
 *
 * Was der Nutzer nehmen darf, entscheidet der Server je Aufruf. Diese Daten dienen nur der Anzeige: welcher Weg wählbar ist,
 * warum ein Weg gesperrt ist, und wann das Tagesbudget wieder frei wird.
 */
import { useCallback, useEffect, useState } from 'react';

export type KiFehlerCode =
  | 'WEG_UNBEKANNT' | 'WEG_INAKTIV' | 'NICHT_FREIGESCHALTET' | 'KONFIGURATION' | 'SCHLUESSEL_FEHLT' | 'ENDPUNKT_FEHLT'
  | 'BUDGET_EIGEN' | 'BUDGET_GLOBAL' | 'SCHLUESSEL_ABGELEHNT' | 'ZEITLIMIT' | 'NICHT_ERREICHBAR' | 'ANBIETER_FEHLER'
  | 'LEERE_ANTWORT';

export interface KiBudget {
  verbrauchtUsd: number;
  grenzeUsd: number | null;
  resetAm: string | null;
  erreicht: boolean;
}

export interface KiWegZustand {
  id: string;
  name: string;
  art: 'lokal' | 'cloud';
  verfuegbar: boolean;
  grund: KiFehlerCode | null;
  gesperrtBis: string | null;
  budget: KiBudget | null;
}

export interface KiStatus {
  darfCloud: boolean;
  wege: KiWegZustand[];
}

/** Antwort einer Textwerkstatt-Route samt Fehlercode, ohne zu werfen. */
export async function kiFetch<T>(pfad: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T & { error?: string; code?: KiFehlerCode; bis?: string } }> {
  const res = await fetch(`/api/textwerkstatt${pfad}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export function useKiStatus() {
  const [status, setStatus] = useState<KiStatus | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const laden = useCallback(async () => {
    const r = await kiFetch<KiStatus>('/ki-status');
    if (r.ok) { setStatus(r.body); setFehler(null); } else { setFehler(r.body.error || `HTTP ${r.status}`); }
  }, []);
  useEffect(() => { laden(); }, [laden]);
  return { status, fehler, laden };
}

/** Uhrzeit in der Zeitzone des Browsers („01:00“). Der Server liefert den Zeitpunkt in UTC; kein fester Versatz. */
export function uhrzeit(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
