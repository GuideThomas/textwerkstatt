/**
 * Hinweis, sobald das Budget eines Cloud-Wegs erreicht ist (Textwerkstatt Phase 2, #1838).
 *
 * Unterscheidet die eigene Tagesgrenze des Schlüssels von der Gesamtgrenze des KI-Proxys: Sonst nennt die Seite den falschen
 * Grund, und wer die Grenze sucht, sucht am falschen Ort. Die lokale KI läuft in beiden Fällen weiter.
 */
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';
import { KiWegZustand, uhrzeit } from '../hooks/useKiStatus';

export default function KiBudgetHinweis({ wege }: { wege: KiWegZustand[] }) {
  const { t } = useTranslation('ki');
  const gesperrt = wege.filter((w) => w.art === 'cloud' && (w.grund === 'BUDGET_EIGEN' || w.grund === 'BUDGET_GLOBAL'));
  if (gesperrt.length === 0) return null;
  return (
    <div className="space-y-2">
      {gesperrt.map((w) => {
        const zeit = uhrzeit(w.gesperrtBis, currentLocale());
        const grenze = w.budget?.grenzeUsd;
        const text = w.grund === 'BUDGET_GLOBAL'
          ? t('budget.global', { zeit })
          : grenze != null
            ? t('budget.eigen', { grenze: grenze.toLocaleString(currentLocale()), zeit })
            : t('budget.eigenOhneBetrag', { zeit });
        return (
          <div key={w.id} role="status" className="bg-amber-50 border border-amber-200 text-amber-900 text-sm px-4 py-3 rounded-md">
            <span className="font-semibold">{w.name}:</span> {text} {t('budget.lokalLaeuft')}
          </div>
        );
      })}
    </div>
  );
}
