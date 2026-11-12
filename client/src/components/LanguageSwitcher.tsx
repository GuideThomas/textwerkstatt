import { useTranslation } from 'react-i18next';
import { LANG_LABELS, SUPPORTED_LANGS, currentLang, type UiLang } from '../i18n';

interface Props {
  /** `dark` für die dunkle Kopfleiste, `light` für helle Flächen (Anmeldeseite). */
  variant?: 'dark' | 'light';
}

/** Sprachumschalter — die Wahl bleibt im Browser gespeichert (localStorage `tt-lang`). */
export default function LanguageSwitcher({ variant = 'dark' }: Props) {
  const { t, i18n } = useTranslation('common');
  const dark = variant === 'dark';
  // Beide Varianten gleich gebaut: Globus + rahmenlose Auswahl; hell mit eigenem Rahmen
  // um beides (Anmeldeseite, Review-Leiste), dunkel ohne (Kopfzeile).
  const cls = dark
    ? 'text-white/80 hover:text-white focus:ring-white/30'
    : 'text-gray-700 focus:ring-primary-400';
  const wrapCls = dark
    ? 'text-white/50 hover:text-white hover:bg-white/5'
    : 'bg-white text-gray-400 hover:text-gray-600 border border-gray-300';
  return (
    <label
      className={`flex items-center gap-1 pl-2 rounded-[5px] transition-colors ${wrapCls}`}
      title={t('language.label')}
    >
      <span className="sr-only">{t('language.label')}</span>
      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
      <select
        value={currentLang()}
        onChange={(e) => i18n.changeLanguage(e.target.value as UiLang)}
        className={`text-xs bg-transparent border-0 rounded-[5px] pl-0 pr-2 py-1 cursor-pointer focus:outline-none focus:ring-1 ${cls}`}
        aria-label={t('language.label')}
      >
        {SUPPORTED_LANGS.map((l) => (
          <option key={l} value={l} className="text-gray-900">
            {LANG_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
