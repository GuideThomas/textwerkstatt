/**
 * Hinweisband der Demo über jeder Seite (`PLAN-oeffentlich-und-demo.md` Phase 2): keine vertraulichen Texte, wohin die Texte gehen,
 * wann die Demo sich zurücksetzt. Ohne Demo (`einstellungen().demo === null`) rendert es nichts.
 */
import { useTranslation } from 'react-i18next';
import { einstellungen } from '../einstellungen';
import { currentLocale } from '../i18n';

export default function DemoHinweis() {
  const { t } = useTranslation('common');
  const demo = einstellungen().demo;
  if (!demo) return null;
  const reset = demo.naechsterReset ? new Date(demo.naechsterReset) : null;
  const datum = reset && !Number.isNaN(reset.getTime())
    // Der Reset läuft um 03:00 Wiener Zeit. Ohne `timeZone` läse ein Besucher westlich davon den Vortag.
    ? reset.toLocaleDateString(currentLocale(), { timeZone: 'Europe/Vienna', day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  return (
    <div role="note" className="w-full bg-amber-50 border-b border-amber-200 text-amber-900 text-xs px-4 py-2">
      <p className="max-w-7xl mx-auto">
        <strong className="font-semibold">{t('demo.titel')}</strong>
        {' · '}{t('demo.vertraulich')}
        {' · '}{t('demo.dienste')}
        {' · '}{datum ? t('demo.reset', { datum }) : t('demo.resetOhneDatum')}
      </p>
    </div>
  );
}
