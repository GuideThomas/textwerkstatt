/**
 * Atelier-Thema nach dem TW-CD-Guide (Projekte/TW-CD-Guide/TW_CD_GUIDE.md, Stand 12.11.2026): warmes Papier, Tusche,
 * Graphit und ein einziger Lichtakzent in Messing. Rahmenlos, linksbündig, Jost für Überschriften, keine fremden Anfragen.
 *
 * Farben als Tailwind-Tokens (`paper`, `ink`, `graphite`, `hairline`, `brass`, `sage`, `rust`) in `tailwind.json`, die
 * Variablen der gemeinsamen Bausteine in `thema.css`. Vorgabe des öffentlichen Repos (client/thema.config.js).
 */
import { useTranslation } from 'react-i18next';
import type { Thema } from '../../src/thema/typ';
import { einstellungen } from '../../src/einstellungen';
import Skizzen from './Skizzen';

const SCHWESTERN = [
  { name: 'Luminaire Inspirator', href: 'https://thomaswinkler.art/' },
  { name: 'Blog', href: 'https://blog.thomaswinkler.art/' },
  { name: 'SEO vs. GEO', href: 'https://thomaswinkler.art/SEOvsGEO.html' },
];

const link = 'text-graphite-600 underline-offset-4 hover:text-ink-950 hover:underline';

/** Footer mit Querverlinkung (§8): links die Schwesterseiten, rechts Herkunft und Rechtliches. */
function Fuss() {
  const { t } = useTranslation('common');
  return (
    <footer className="relative mt-12 border-t border-hairline-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between text-sm">
        <nav aria-label={t('fuss.navigation')} className="flex flex-wrap gap-x-5 gap-y-2">
          {SCHWESTERN.map((s) => (
            <a key={s.href} href={s.href} className={link}>{s.name}</a>
          ))}
        </nav>
        <p className="flex flex-wrap gap-x-2 gap-y-1 text-graphite-600">
          <a href="https://thomaswinkler.art/" className={link}>thomaswinkler.art</a>
          <span aria-hidden="true">·</span>
          <a href="https://thomaswinkler.art/impressum.html" className={link}>{t('fuss.impressum')}</a>
          <span aria-hidden="true">·</span>
          <a href="https://thomaswinkler.art/datenschutz.html" className={link}>{t('fuss.datenschutz')}</a>
          <span aria-hidden="true">·</span>
          <a href="https://www.linkedin.com/in/thomas-winkler/" target="_blank" rel="noopener noreferrer" className={link}>LinkedIn</a>
        </p>
      </div>
    </footer>
  );
}

const thema: Thema = {
  name: 'atelier',

  // Wortmarke statt Bild: der Name der Anwendung in Jost
  Logo: () => (
    <span className="font-display text-[19px] font-medium leading-none text-ink-950">
      {einstellungen().appName || 'Textwerkstatt'}
    </span>
  ),

  // Dachzeile über dem Titel (§3): Jost 500, leicht gesperrt, Messing 700, normale Schreibung
  AnmeldeLogo: () => (
    <p className="font-display text-sm font-medium tracking-[0.04em] text-brass-700">Thomas Winkler</p>
  ),

  // Helle Kopfzeile auf Papier, aktiver Reiter mit Messing-Marker unten (Farbe nie allein: dazu Tusche statt Graphit)
  kopf: {
    stil: { background: 'rgba(251, 249, 245, 0.95)', borderBottom: '1px solid #dfd9cd' },
    reiterAktiv: 'text-ink-950 shadow-[inset_0_-2px_0_#b88228]',
    reiterInaktiv: 'text-graphite-700 hover:bg-paper-100 hover:text-ink-950',
    trenner: 'bg-hairline-200',
    menue: 'border border-hairline-200',
    menueStil: { background: '#fbf9f5' },
    menueTitel: 'font-display text-xs font-medium tracking-[0.04em] text-brass-700',
    menueEintragAktiv: 'text-ink-950 bg-brass-100',
    menueEintragInaktiv: 'text-graphite-700 hover:bg-paper-100 hover:text-ink-950',
    kuerzel: 'text-ink-950 bg-paper-200 hover:bg-hairline-200',
    kuerzelAktiv: 'ring-2 ring-brass-500',
    abmelden: 'text-graphite-600 hover:text-ink-950 hover:bg-paper-100',
    rechts: 'lg:border-hairline-200',
    sprachwahl: 'light',
  },

  // Rahmenlos auf dem Papiergrund, linksbündig
  anmeldung: {
    karte: { backgroundColor: 'rgba(251, 249, 245, 0.95)' },
    feld: 'text-ink-950 bg-paper-50 border border-hairline-300 focus:border-brass-500',
    kopf: 'text-left',
    titel: 'font-display text-ink-950',
    titelStil: { fontWeight: 400, fontSize: 32, letterSpacing: '-0.01em', lineHeight: 1.1 },
    titelText: null,
  },

  Seitentitel: ({ title, subtitle }) => (
    <div className="min-w-0">
      <h1 className="font-display font-normal text-ink-950 leading-[1.1] tracking-[-0.01em] break-words text-[26px] sm:text-[32px]">
        {title}
      </h1>
      {subtitle && <p className="text-graphite-600 text-sm mt-2">{subtitle}</p>}
    </div>
  ),

  unterreiterAktiv: 'border-brass-500',
  Fuss,
  Hintergrund: Skizzen,
  kategorieFarbe: '#b88228',
};

export default thema;
