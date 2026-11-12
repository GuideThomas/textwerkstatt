import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';

/**
 * Alternativen zur Übersetzung (DeepL) und Wortstellung (Sprachmodell, nur auf Klick).
 * Übernommen aus der früheren Schnellübersetzung (bis 10.11.2026), Verhalten unverändert.
 *
 * DeepL liefert nur dann sichtbar verschiedene Varianten, wenn der Text kurz ist (Wort,
 * Phrase). Bei langem Text sind die drei Alternativen oft fast gleich und fallen beim
 * Entdoppeln weg. Deshalb kann man im Quelltext eine Phrase markieren; dann geht nur diese
 * an DeepL (`span`).
 */

type FormalityChoice = 'default' | 'more' | 'less';

interface Props {
  /** Markierte Phrase aus dem Quelltext, `null` = ganzer Text. */
  span: string | null;
  text: string;
  sourceLang: string;
  targetLang: string;
  channelCode: string;
  useGlossary: boolean;
  formality: FormalityChoice;
  /** Die aktuelle Übersetzung, falls vorhanden. */
  translatedText: string | null;
  onApply: (alt: string) => void;
  /** Nur bei markierter Phrase: Variante als Glossareintrag vormerken. */
  onSaveAsGlossary: (alt: string) => void;
  onClose: () => void;
}

export default function AlternativenDialog({
  span, text, sourceLang, targetLang, channelCode, useGlossary, formality, translatedText,
  onApply, onSaveAsGlossary, onClose,
}: Props) {
  const { t } = useTranslation('quick');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<string[] | null>(null);
  const [wordOrderLoading, setWordOrderLoading] = useState(false);
  const [wordOrderAlts, setWordOrderAlts] = useState<string[] | null>(null);
  const [wordOrderError, setWordOrderError] = useState<string | null>(null);

  // Beim Öffnen einmal bei DeepL nachfragen. Späte Antworten nach dem Schließen verwerfen.
  useEffect(() => {
    let aktiv = true;
    const textToTranslate = span ?? text.trim();
    if (!textToTranslate) { setLoading(false); return; }
    (async () => {
      try {
        const res = await fetch('/api/quick-translate/alternatives', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: textToTranslate,
            sourceLang,
            targetLang,
            n: 3,
            channelCode: useGlossary ? (channelCode || null) : null,
            useGlossary,
            // Auch die Alternativen tragen die Anredestufe, sonst steht neben formellem
            // Fließtext eine neutrale Vorschlagsliste.
            formality,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || t('errors.http', { status: res.status }));
        }
        const data = await res.json();
        const list: string[] = Array.isArray(data.alternatives) ? data.alternatives : [];
        // Bei markierter Phrase kennen wir deren Standardübersetzung nicht — nur entdoppeln.
        const filtered = span
          ? list
          : translatedText
            ? list.filter((a) => a.trim() !== translatedText.trim())
            : list;
        if (aktiv) setAlternatives(filtered);
      } catch (err: any) {
        if (aktiv) setError(err.message || t('errors.alternativesFailed'));
      } finally {
        if (aktiv) setLoading(false);
      }
    })();
    return () => { aktiv = false; };
    // Der Dialog fragt genau einmal je Öffnung; neue Eingaben öffnen ihn neu.
    // eslint-disable-next-line
  }, []);

  const fetchWordOrder = async () => {
    const phrase = span || text.trim();
    if (!phrase || phrase.length > 200) {
      setWordOrderError(t('errors.phraseTooLong'));
      return;
    }
    setWordOrderLoading(true);
    setWordOrderError(null);
    setWordOrderAlts(null);
    try {
      const res = await fetch('/api/quick-translate/word-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: phrase,
          sourceLang,
          targetLang,
          baseTranslation: span ? null : translatedText || null,
          channelCode: useGlossary ? (channelCode || null) : null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || t('errors.http', { status: res.status }));
      }
      const data = await res.json();
      setWordOrderAlts(Array.isArray(data.alternatives) ? data.alternatives : []);
    } catch (err: any) {
      setWordOrderError(err.message || t('errors.wordOrderFailed'));
    } finally {
      setWordOrderLoading(false);
    }
  };

  // Wörter, die in der aktuellen Übersetzung nicht vorkommen, gelb hervorheben.
  const renderDiff = (alt: string) => {
    if (!translatedText) return alt;
    const origSet = new Set(translatedText.split(/(\s+)/).filter((tok) => tok.trim().length > 0));
    return (
      <>
        {alt.split(/(\s+)/).map((tok, i) =>
          tok.trim().length === 0 || origSet.has(tok) ? (
            <span key={i}>{tok}</span>
          ) : (
            <span key={i} className="bg-yellow-100 text-yellow-900 rounded px-0.5">{tok}</span>
          ),
        )}
      </>
    );
  };

  const glossaryTitle = t('altModal.saveAsGlossary', {
    source: sourceLang,
    target: targetLang,
    channel: channelCode ? ` · ${channelCode}` : '',
  });

  const renderList = (list: string[], keyPrefix: string, withDiff: boolean) => (
    <ul className="space-y-2">
      {list.map((alt, idx) => (
        <li key={`${keyPrefix}-${idx}`} className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={() => onApply(alt)}
            className="flex-1 text-left text-sm text-gray-800 border border-gray-200 hover:border-primary-400 hover:bg-primary-50 rounded px-3 py-2 transition-colors"
          >
            {withDiff ? renderDiff(alt) : alt}
          </button>
          {span && (
            <button
              type="button"
              onClick={() => onSaveAsGlossary(alt)}
              title={glossaryTitle}
              className="text-sm text-gray-500 border border-gray-200 hover:border-green-500 hover:text-green-700 hover:bg-green-50 rounded px-2 py-2 transition-colors whitespace-nowrap"
            >
              📖+
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="fixed inset-0 bg-black/30 flex items-start justify-center z-40 pt-24" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-lg w-full max-w-xl p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('altModal.title')}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-gray-800">
            {t('altModal.title')} <span className="text-xs font-normal text-gray-400">(DeepL)</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
            title={t('altModal.close')}
          >
            ×
          </button>
        </div>
        {span ? (
          <p className="text-xs text-gray-500 mb-3">
            {t('altModal.forPhrase')} <span className="text-gray-700">„{span}“</span>
          </p>
        ) : (
          <p className="text-xs text-gray-400 mb-3">{t('altModal.wholeText')}</p>
        )}

        {loading && (
          <div className="text-sm text-gray-400 flex items-center gap-2">
            <span className="animate-spin">&#9696;</span> {t('altModal.loading')}
          </div>
        )}
        {error && <div className="text-sm text-red-600">{error}</div>}
        {!loading && !error && alternatives && alternatives.length === 0 && (
          <div className="text-sm text-gray-500">
            {span ? t('altModal.onlyOneVariant') : (
              <>
                {t('altModal.noVariants')}<br />
                <span className="text-gray-400">{t('altModal.noVariantsTip')}</span>
              </>
            )}
          </div>
        )}
        {!loading && !error && alternatives && alternatives.length > 0 && (
          <>
            <p className="text-xs text-gray-500 mb-2">
              {span ? t('altModal.spanHint') : (
                <Trans
                  t={t}
                  i18nKey="altModal.fullHint"
                  components={{ hl: <span className="bg-yellow-100 text-yellow-900 rounded px-1 mx-1" /> }}
                />
              )}
            </p>
            {renderList(alternatives, 'alt', true)}
          </>
        )}

        {/* Wortstellung: nur Sprachmodell, nur auf Klick */}
        {!loading && !error && (
          <div className="mt-4 pt-3 border-t border-gray-100">
            {!wordOrderAlts && !wordOrderLoading && !wordOrderError && (
              <button
                type="button"
                onClick={fetchWordOrder}
                className="text-xs text-primary-700 hover:text-primary-900 transition-colors"
                title={t('wordOrder.showTitle')}
              >
                + {t('wordOrder.show')}
              </button>
            )}
            {wordOrderLoading && (
              <div className="text-sm text-gray-400 flex items-center gap-2">
                <span className="animate-spin">&#9696;</span> {t('wordOrder.loading')}
              </div>
            )}
            {wordOrderError && <div className="text-sm text-red-600">{wordOrderError}</div>}
            {wordOrderAlts && wordOrderAlts.length === 0 && (
              <div className="text-sm text-gray-500">{t('wordOrder.none')}</div>
            )}
            {wordOrderAlts && wordOrderAlts.length > 0 && (
              <>
                <p className="text-xs text-gray-500 mb-2">
                  {span ? t('wordOrder.headingSpan') : t('wordOrder.headingFull')}
                </p>
                {renderList(wordOrderAlts, 'wo', !span)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
