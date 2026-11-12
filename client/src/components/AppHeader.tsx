import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher';
import thema from '@thema';

/**
 * Kopfzeile. Farben, Logo und Reiterstil kommen aus dem Thema (`thema.kopf`, client/themes/<name>/index.tsx).
 *
 * Aufgeräumt am 22.10.2026: Die Reiter stehen in zwei Gruppen (Übersetzen ·
 * Terminologie), die drei Admin-Punkte liegen gesammelt unter „Verwaltung“.
 * Statt acht gleichrangiger Reiter sieht ein Benutzer fünf, ein Admin sechs.
 */

// `panel` steht nicht in der Reiterleiste — erreichbar über das Personen-Kürzel rechts.
// Schnellübersetzung und Schreibhilfe sind seit 10.11.2026 die Textwerkstatt; ihre alten
// Kennungen führt `tabFromUrl()` dorthin (PLAN-textwerkstatt.md, Phase 1).
export const TABS = [
  'textwerkstatt', 'projects', 'glossaries',
  'terminology-scan', 'consistency', 'costs', 'admin', 'panel',
] as const;
export type Tab = (typeof TABS)[number];

/** Reiter, die nur Admins sehen. */
export const ADMIN_TABS: readonly Tab[] = ['consistency', 'costs', 'admin'];

/** Frühere Reiter-Kennungen, damit Lesezeichen und Links weiter ankommen. */
const TAB_ALIASES: Record<string, Tab> = {
  'quick-translate': 'textwerkstatt',
  schreibhilfe: 'textwerkstatt',
};

/** Reiter-Kennung → Reiter, frühere Kennungen eingeschlossen; Unbekanntes ergibt `null`. */
export function resolveTab(raw: string | null | undefined): Tab | null {
  const key = (raw || '').trim().toLowerCase();
  if (!key) return null;
  if ((TABS as readonly string[]).includes(key)) return key as Tab;
  return TAB_ALIASES[key] ?? null;
}

interface NavItem {
  key: Tab;
  labelKey: string;
  icon: string; // Heroicons v2 (outline), d-Attribut
}

const ICON = {
  write: 'M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10',
  document: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z',
  book: 'M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25',
  search: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z',
  blocks: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z',
  compare: 'M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  chart: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z',
  users: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z',
  manage: 'M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75',
  logout: 'M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9',
};

const WORK: NavItem[] = [
  { key: 'textwerkstatt',    labelKey: 'tabs.textwerkstatt',   icon: ICON.write },
  { key: 'projects',         labelKey: 'tabs.documents',       icon: ICON.document },
];
const TERMS: NavItem[] = [
  { key: 'glossaries',       labelKey: 'tabs.glossaries',      icon: ICON.book },
  { key: 'terminology-scan', labelKey: 'tabs.terminologyScan', icon: ICON.search },
];
const MANAGE: NavItem[] = [
  { key: 'consistency',      labelKey: 'tabs.consistency',     icon: ICON.compare },
  { key: 'costs',            labelKey: 'tabs.costs',           icon: ICON.chart },
  { key: 'admin',            labelKey: 'tabs.admin',           icon: ICON.users },
];

function Icon({ d, className = 'w-4 h-4' }: { d: string; className?: string }) {
  return (
    <svg className={`${className} shrink-0`} fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

const tabCls = (active: boolean) =>
  `shrink-0 inline-flex items-center gap-1.5 px-2 xl:px-3 py-1.5 rounded-[5px] text-xs xl:text-sm font-semibold whitespace-nowrap transition-colors ${
    active ? thema.kopf.reiterAktiv : thema.kopf.reiterInaktiv
  }`;

function Divider() {
  return <span className={`shrink-0 w-px h-5 mx-1.5 ${thema.kopf.trenner}`} aria-hidden="true" />;
}

function initialsOf(name: string): string {
  const words = name.split(/[\s@._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?';
}

interface Props {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  user: { name?: string | null; email: string; role: string };
  onLogout: () => void;
}

export default function AppHeader({ activeTab, onTabChange, user, onLogout }: Props) {
  const { t } = useTranslation('common');
  const isAdmin = user.role === 'admin';
  const [manageOpen, setManageOpen] = useState(false);
  const manageRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const manageActive = MANAGE.some((m) => m.key === activeTab);
  const displayName = user.name || user.email;

  // Unter lg scrollt die Reiterzeile seitlich: Der aktive Reiter soll sichtbar sein, auch „Verwaltung“ ganz rechts.
  useEffect(() => {
    const aktiv = navRef.current?.querySelector('[aria-current="page"]') as HTMLElement | null;
    aktiv?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  // Ausklappmenü schließt bei Klick daneben und mit Escape.
  useEffect(() => {
    if (!manageOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!manageRef.current?.contains(e.target as Node)) setManageOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setManageOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [manageOpen]);

  const renderTab = (item: NavItem) => (
    <button
      key={item.key}
      type="button"
      onClick={() => onTabChange(item.key)}
      aria-current={activeTab === item.key ? 'page' : undefined}
      className={tabCls(activeTab === item.key)}
    >
      <span className="hidden xl:inline-flex"><Icon d={item.icon} /></span>
      {t(item.labelKey)}
    </button>
  );

  return (
    <header
      className="sticky top-0 z-30"
      style={thema.kopf.stil}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap lg:flex-nowrap items-center justify-between gap-x-3 min-h-14 py-1">
          {/* Links: Logo. Der App-Name stand bis 22.10.2026 daneben (ab 2xl) und schob sich
              dort in die Reiter — er steht ohnehin im Browser-Tab. */}
          <button
            type="button"
            onClick={() => onTabChange('textwerkstatt')}
            className="flex items-center rounded-[5px] shrink-0"
            title={t('tabs.textwerkstatt')}
          >
            <thema.Logo />
          </button>

          {/* Mitte: Reiter. Unter lg eine eigene, seitlich scrollbare Zeile — untereinander
              gestapelt war die klebende Kopfzeile am Handy 261 px hoch, bei 800 px brach die
              Reiterzeile neben dem Logo in zwei Zeilen um (gemessen 22.10.2026). Dort stehen die
              Verwaltungspunkte direkt in der Zeile, weil ein Ausklappmenü im scrollenden
              Container abgeschnitten würde. */}
          {/* Der Verlauf am rechten Rand zeigt am Handy, dass es weitergeht (gemessen 11.11.2026: bei 390 px endete die Zeile mitten
              in „Terminologie-Scan“, „Verwaltung“ war nicht zu sehen und nichts deutete auf Scrollen hin). */}
          <nav ref={navRef} className="order-last lg:order-none basis-full lg:basis-auto flex items-center gap-1 lg:flex-1 min-w-0 overflow-x-auto scrollbar-hide lg:overflow-visible lg:flex-wrap lg:justify-center pb-1.5 lg:pb-0 pr-6 lg:pr-0 [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] lg:[mask-image:none] lg:[-webkit-mask-image:none]">
            {WORK.map(renderTab)}
            <Divider />
            {TERMS.map(renderTab)}

            {isAdmin && (
              <>
                <Divider />
                <div className="contents lg:hidden">{MANAGE.map(renderTab)}</div>
                <div ref={manageRef} className="relative hidden lg:block">
                  <button
                    type="button"
                    onClick={() => setManageOpen((o) => !o)}
                    aria-haspopup="menu"
                    aria-expanded={manageOpen}
                    className={tabCls(manageActive)}
                  >
                    <span className="hidden xl:inline-flex"><Icon d={ICON.manage} /></span>
                    {manageActive
                      ? t(MANAGE.find((m) => m.key === activeTab)!.labelKey)
                      : t('tabs.manage')}
                    <svg className={`w-3 h-3 transition-transform ${manageOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {manageOpen && (
                    <div
                      role="menu"
                      className={`absolute right-0 top-full mt-2 min-w-[200px] rounded-[5px] py-1 z-40 ${thema.kopf.menue}`}
                      style={thema.kopf.menueStil}
                    >
                      <div className={`px-3 pt-1.5 pb-1 ${thema.kopf.menueTitel}`}>
                        {t('tabs.manage')}
                      </div>
                      {MANAGE.map((item) => {
                        const active = activeTab === item.key;
                        return (
                          <button
                            key={item.key}
                            type="button"
                            role="menuitem"
                            onClick={() => { onTabChange(item.key); setManageOpen(false); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                              active ? thema.kopf.menueEintragAktiv : thema.kopf.menueEintragInaktiv
                            }`}
                          >
                            <Icon d={item.icon} />
                            {t(item.labelKey)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </nav>

          {/* Rechts: Sprache · Person · Abmelden */}
          <div className={`flex items-center gap-2 shrink-0 lg:pl-3 lg:border-l ${thema.kopf.rechts}`}>
            <LanguageSwitcher variant={thema.kopf.sprachwahl} />
            {/* Personen-Kürzel führt zu den eigenen Illustrator-Panel-Verbindungen (28.10.2026). */}
            <button
              type="button"
              onClick={() => onTabChange('panel')}
              aria-current={activeTab === 'panel' ? 'page' : undefined}
              className={`w-7 h-7 rounded-full inline-flex items-center justify-center text-[11px] font-bold select-none transition-colors ${thema.kopf.kuerzel} ${
                activeTab === 'panel' ? thema.kopf.kuerzelAktiv : ''
              }`}
              title={`${user.name ? `${user.name} · ${user.email}` : user.email}\n${t('connections.menuTitle', { ns: 'panel' })}`}
              aria-label={`${displayName} — ${t('connections.menuTitle', { ns: 'panel' })}`}
            >
              {initialsOf(displayName)}
            </button>
            <button
              type="button"
              onClick={onLogout}
              className={`p-2 rounded-[5px] transition-colors ${thema.kopf.abmelden}`}
              title={t('app.logout')}
              aria-label={t('app.logout')}
            >
              <Icon d={ICON.logout} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
