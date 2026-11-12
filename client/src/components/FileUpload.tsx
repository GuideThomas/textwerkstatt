import { useState, useEffect, useRef, DragEvent } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { currentLocale } from '../i18n';

const SUPPORTED_EXTENSIONS = ['.idml', '.docx', '.xlsx', '.pdf', '.xml', '.html', '.htm', '.txt', '.csv', '.md', '.markdown', '.aijson'];
// Anzeigename kommt aus `documents:languages.<code>`
const SOURCE_LANGUAGES = [
  { code: 'AUTO' },
  { code: 'DE' },
  { code: 'EN' },
  { code: 'IT' },
  { code: 'FR' },
  { code: 'ES' },
  { code: 'HU' },
  { code: 'PL' },
  { code: 'CS' },
  { code: 'SK' },
  { code: 'SL' },
];
const TARGET_LANGUAGES = SOURCE_LANGUAGES.filter(l => l.code !== 'AUTO');

/**
 * Anredestufe: sprachneutrale Beschriftung plus das konkrete Pronomen der
 * Zielsprache. Ein Upload kann MEHRERE Zielsprachen haben — die Wahl gilt dann
 * fuer alle, wirkt aber nur bei denen, die DeepL unterstuetzt. Genau das steht
 * unter der Auswahl, statt es dem Anwender zu ueberlassen.
 */
const FORMALITY_PRONOUNS: Record<string, { more: string; less: string }> = {
  DE: { more: 'Sie', less: 'du' },
  IT: { more: 'Lei', less: 'tu' },
  FR: { more: 'vous', less: 'tu' },
  ES: { more: 'usted', less: 'tú' },
  NL: { more: 'u', less: 'je' },
  PL: { more: 'Pan/Pani', less: 'ty' },
};

type FormalityChoice = 'default' | 'more' | 'less';

interface UploadResult {
  project_id: string;
  job_id: string;
  filename: string;
  file_type: string;
  status: string;
}

interface Topic {
  id: string;
  name: string;
  color: string;
}

interface Channel {
  code: string;
  name: string;
  sort_order: number;
}

interface FileUploadProps {
  onUploadComplete: () => void;
  topics?: Topic[];
  parentProject?: { id: string; name: string; source_lang: string; target_lang: string } | null;
  onCancelParent?: () => void;
}

export default function FileUpload({ onUploadComplete, topics = [], parentProject, onCancelParent }: FileUploadProps) {
  const { t } = useTranslation('documents');
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sourceLang, setSourceLang] = useState('DE');
  const [targetLangs, setTargetLangs] = useState<string[]>(['IT']);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  // '' = Standard der Organisation, sonst Channel-Code (z. B. SHOPA/B2C)
  const [channelCode, setChannelCode] = useState<string>('');
  const [channels, setChannels] = useState<Channel[]>([]);
  // Neutral-Modus: ohne Glossar/Channel übersetzen (z. B. Vergleichs-Run)
  const [glossaryDisabled, setGlossaryDisabled] = useState<boolean>(false);
  // Deutsch → Deutsch = Channel-Fassung (services/channel-fassung.ts)
  const deToDe = sourceLang === 'DE' && targetLangs.includes('DE');
  // Anredestufe. Voreinstellung 'default' — es geht kein Parameter raus.
  const [formality, setFormality] = useState<FormalityChoice>('default');
  const [formalityLangs, setFormalityLangs] = useState<string[]>([]);
  // LanguageTool Pre-Pass: silent High-Confidence-Korrekturen vor DeepL
  const [optimizeSource, setOptimizeSource] = useState<boolean>(false);
  // Format-Profil für CSV/XML — schützt Header und technische Spalten/Attribute
  const [formatProfile, setFormatProfile] = useState<string>('auto');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/glossaries/channels')
      .then(r => r.json())
      .then((data: Channel[]) => setChannels(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/quick-translate/formality')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => Array.isArray(d?.languages) && setFormalityLangs(d.languages))
      .catch(() => {});
  }, []);

  // Ein Upload kann mehrere Zielsprachen haben. Die Wahl gilt fuer alle —
  // wirksam ist sie nur bei denen, die DeepL kennt.
  const formalityWirksam = targetLangs.filter((l) => formalityLangs.includes(l.toUpperCase()));
  const formalityOhneWirkung = targetLangs.filter((l) => !formalityLangs.includes(l.toUpperCase()));
  const formalityMoeglich = formalityWirksam.length > 0;

  useEffect(() => {
    if (!formalityMoeglich && formality !== 'default') setFormality('default');
  }, [formalityMoeglich, formality]);

  const validateFile = (f: File): boolean => {
    const ext = '.' + f.name.split('.').pop()?.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      setError(t('upload.errors.unsupportedFormat', { ext, allowed: SUPPORTED_EXTENSIONS.join(', ') }));
      return false;
    }
    setError(null);
    return true;
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && validateFile(droppedFile)) {
      setFile(droppedFile);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && validateFile(selectedFile)) {
      setFile(selectedFile);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    if (targetLangs.length === 0) {
      setError(t('upload.errors.noTarget'));
      return;
    }
    // Deutsch → Deutsch ist erlaubt: das ist die Channel-Fassung (Hausschreibweise
    // des Channels) und braucht deshalb einen Channel.
    if (sourceLang !== 'AUTO' && sourceLang !== 'DE' && targetLangs.includes(sourceLang)) {
      setError(t('upload.errors.targetIsSource'));
      return;
    }
    if (deToDe && (!channelCode || glossaryDisabled)) {
      setError(t('upload.errors.channelFassungNeedsChannel'));
      return;
    }

    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('source_lang', sourceLang);
    // target_lang (singular) für Kompatibilität bei N=1, target_langs (Array) bei N>1
    formData.append('target_lang', targetLangs[0]);
    if (targetLangs.length > 1) {
      formData.append('target_langs', JSON.stringify(targetLangs));
    }
    if (selectedTopics.length > 0) {
      formData.append('topic_ids', JSON.stringify(selectedTopics));
    }
    if (parentProject) {
      formData.append('parent_project_id', parentProject.id);
    }
    if (channelCode && !glossaryDisabled) {
      formData.append('channel_code', channelCode);
    }
    if (formality !== 'default') {
      formData.append('formality', formality);
    }
    if (glossaryDisabled) {
      formData.append('glossary_disabled', 'true');
    }
    if (optimizeSource) {
      formData.append('optimize_source', 'true');
    }
    if (formatProfile && formatProfile !== 'auto') {
      formData.append('format_profile', formatProfile);
    }

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('upload.errors.uploadFailed'));
      }

      const result: UploadResult = await res.json();
      console.log('Upload successful:', result);
      setFile(null);
      setSelectedTopics([]);
      setChannelCode('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      onUploadComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('upload.errors.unknown'));
    } finally {
      setUploading(false);
    }
  };

  const toggleTarget = (code: string) => {
    setTargetLangs(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  };

  const formatFileSize = (bytes: number): string => {
    const fmt = (v: number) =>
      v.toLocaleString(currentLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${fmt(bytes / 1024)} KB`;
    return `${fmt(bytes / (1024 * 1024))} MB`;
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <h2 className="text-lg font-medium text-gray-900 mb-4">
        {parentProject ? t('upload.titleNewVersion') : t('upload.title')}
      </h2>

      {parentProject && (
        <div className="mb-4 p-3 bg-primary-50 border border-primary-200 rounded text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-medium text-primary-900">{t('upload.parentInfo', { name: parentProject.name })}</div>
              <div className="text-xs text-primary-700 mt-0.5">
                {t('upload.parentHint', { source: parentProject.source_lang, target: parentProject.target_lang })}
              </div>
            </div>
            {onCancelParent && (
              <button onClick={onCancelParent} className="text-xs text-primary-700 hover:underline">{t('upload.cancel')}</button>
            )}
          </div>
        </div>
      )}

      {/* Quellsprache */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">{t('upload.sourceLang')}</label>
        <select
          value={sourceLang}
          onChange={(e) => setSourceLang(e.target.value)}
          className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm p-2 border"
        >
          {SOURCE_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{t(`languages.${l.code}`)}</option>
          ))}
        </select>
      </div>

      {/* Zielsprachen — Multi-Select */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('upload.targetLangs')}
          {targetLangs.length > 1 && (
            <span className="ml-2 text-xs text-primary-700 font-normal">
              · {t('upload.parallelCount', { count: targetLangs.length })}
            </span>
          )}
        </label>
        <div className="flex flex-wrap gap-2">
          {TARGET_LANGUAGES.map((l) => {
            const active = targetLangs.includes(l.code);
            const fassung = sourceLang === 'DE' && l.code === 'DE';
            const disabled = sourceLang !== 'AUTO' && l.code === sourceLang && !fassung;
            return (
              <button key={l.code} type="button"
                      disabled={disabled}
                      aria-pressed={active}
                      onClick={() => !disabled && toggleTarget(l.code)}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                        disabled ? 'bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed' :
                        active ? 'bg-primary-600 text-white border-primary-600' :
                        'text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}>
                {active ? '✓ ' : ''}{fassung ? t('upload.channelFassungChip') : t(`languages.${l.code}`)}
              </button>
            );
          })}
        </div>
        {deToDe && (
          <p className="mt-1 text-xs text-gray-500">{t('upload.channelFassungHint')}</p>
        )}
      </div>

      {/* Sales-Channel (optional) */}
      {channels.length > 0 && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('upload.channel.label')}
            <span className="ml-2 text-xs text-gray-400 font-normal">
              {glossaryDisabled
                ? t('upload.channel.neutralDisabled')
                : channelCode
                  ? t('upload.channel.specific')
                  : t('upload.channel.standard')}
            </span>
          </label>
          <select
            value={channelCode}
            onChange={(e) => setChannelCode(e.target.value)}
            disabled={glossaryDisabled}
            className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm p-2 border disabled:bg-gray-100 disabled:text-gray-400"
          >
            <option value="">{t('upload.channel.defaultOption')}</option>
            {channels.map((ch) => (
              <option key={ch.code} value={ch.code}>{ch.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Anredestufe. Bei nicht unterstuetzten Zielsprachen wird die Auswahl
          DEAKTIVIERT und der Grund danebengeschrieben — nicht ausgeblendet. */}
      <div className="mb-3">
        <label className="block text-sm font-medium text-gray-700 mb-1">{t('upload.formality.label')}</label>
        <div className="inline-flex flex-wrap rounded-[5px] border border-gray-300 bg-white p-0.5 gap-0.5">
          {(['default', 'more', 'less'] as FormalityChoice[]).map((f) => {
            const beschriftung =
              f === 'default' ? t('upload.formality.default') : f === 'more' ? t('upload.formality.more') : t('upload.formality.less');
            // Pronomen nur zeigen, wenn GENAU EINE wirksame Zielsprache gewaehlt
            // ist — bei mehreren waere `Lei` neben `vous` neben `Pan/Pani` mehr
            // Rauschen als Hilfe.
            const pron =
              formalityWirksam.length === 1
                ? FORMALITY_PRONOUNS[formalityWirksam[0].toUpperCase()]
                : undefined;
            const hinweis = f === 'default' || !pron ? null : f === 'more' ? pron.more : pron.less;
            return (
              <button
                key={f}
                type="button"
                disabled={f !== 'default' && !formalityMoeglich}
                aria-pressed={formality === f}
                onClick={() => setFormality(f)}
                className={`text-xs px-3 py-1.5 rounded-[4px] transition-colors disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed ${
                  formality === f
                    ? 'bg-primary-600 text-white font-semibold'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
                title={
                  f === 'default'
                    ? t('upload.formality.titleDefault')
                    : formalityMoeglich
                      ? t('upload.formality.titleActive')
                      : t('upload.formality.titleUnsupported')
                }
              >
                {beschriftung}
                {hinweis && <span className="ml-1 opacity-70">{hinweis}</span>}
              </button>
            );
          })}
        </div>
        {formality !== 'default' && formalityOhneWirkung.length > 0 && (
          <p className="mt-1 text-xs text-amber-600">
            {t('upload.formality.partialNoEffect', { langs: formalityOhneWirkung.join(', ') })}
          </p>
        )}
        {!formalityMoeglich && targetLangs.length > 0 && (
          <p className="mt-1 text-xs text-gray-400">
            {t('upload.formality.noneSupported', { langs: targetLangs.join(', ') })}
          </p>
        )}
        {channelCode && formality !== 'default' && (
          <p className="mt-1 text-xs text-amber-600">
            {t('upload.formality.channelWarning')}
          </p>
        )}
      </div>

      {/* Neutral-Modus (kein Glossar, keine Channel-Overrides) */}
      <div className="mb-3">
        <label
          className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none"
          title={t('upload.neutral.title')}
        >
          <input
            type="checkbox"
            checked={glossaryDisabled}
            onChange={(e) => setGlossaryDisabled(e.target.checked)}
            className="accent-primary-600"
          />
          <span>{t('upload.neutral.label')}</span>
        </label>
      </div>

      {/* Format-Profil — nur sichtbar wenn CSV/XML-Datei ausgewählt */}
      {file && /\.(csv|xml)$/i.test(file.name) && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t('upload.formatProfile.label')}
            <span className="ml-2 text-xs text-gray-400 font-normal">
              {formatProfile === 'auto'
                ? t('upload.formatProfile.autoDetect')
                : t('upload.formatProfile.manual')}
            </span>
          </label>
          <select
            value={formatProfile}
            onChange={(e) => setFormatProfile(e.target.value)}
            className="w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 text-sm p-2 border"
            title={t('upload.formatProfile.title')}
          >
            <option value="auto">{t('upload.formatProfile.optAuto')}</option>
            <option value="magento-cms-page">{t('upload.formatProfile.optCmsPage')}</option>
            <option value="magento-cms-block">{t('upload.formatProfile.optCmsBlock')}</option>
            <option value="magento-product">{t('upload.formatProfile.optProduct')}</option>
            <option value="generic-csv">{t('upload.formatProfile.optGeneric')}</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">
            <Trans
              t={t}
              i18nKey="upload.formatProfile.help"
              components={{ c: <code className="text-gray-600" /> }}
            />
          </p>
        </div>
      )}

      {/* Store-View-Anpassung: seit 28.07.2026 immer aktiv, kein Toggle mehr */}
      {file && /\.(csv|xml|html?)$/i.test(file.name) && (
        <div className="mb-4 rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-sm text-gray-700">
            {t('upload.storeView.info')}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            <code className="text-gray-600">&lt;a href="/de/led-praxis"&gt;</code> →{' '}
            <code className="text-gray-600">
              &lt;a href="/{targetLangs[0]?.toLowerCase() || 'fr'}/led-praxis"&gt;
            </code>
            {' '}
            <Trans
              t={t}
              i18nKey="upload.storeView.detail"
              values={{ directive: '{{widget}}' }}
              components={{ c: <code className="text-gray-600" /> }}
            />
          </p>
        </div>
      )}

      {/* LanguageTool Pre-Pass: Quelltext optimieren */}
      <div className="mb-4">
        <label
          className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none"
          title={t('upload.optimize.title')}
        >
          <input
            type="checkbox"
            checked={optimizeSource}
            onChange={(e) => setOptimizeSource(e.target.checked)}
            className="accent-primary-600"
          />
          <span>{t('upload.optimize.label')} <span className="text-xs text-gray-400">(LanguageTool)</span></span>
        </label>
      </div>

      {/* Drop-Zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          dragOver
            ? 'border-primary-500 bg-primary-50'
            : file
              ? 'border-green-300 bg-green-50'
              : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".idml,.docx,.xlsx,.pdf,.xml,.html,.htm,.txt,.csv,.md,.markdown,.aijson"
          onChange={handleFileSelect}
          className="hidden"
        />

        {file ? (
          <div>
            <div className="text-3xl mb-2">
              {file.name.endsWith('.idml') ? '📐' :
               file.name.endsWith('.docx') ? '📝' :
               file.name.endsWith('.xlsx') ? '📊' :
               file.name.endsWith('.xml') ? '🧩' :
               file.name.endsWith('.aijson') ? '🎨' :
               (file.name.endsWith('.html') || file.name.endsWith('.htm')) ? '🌐' : '📄'}
            </div>
            <p className="text-sm font-medium text-gray-900">{file.name}</p>
            <p className="text-xs text-gray-500 mt-1">{formatFileSize(file.size)}</p>
            <button
              onClick={(e) => { e.stopPropagation(); setFile(null); }}
              className="mt-2 text-xs text-red-600 hover:text-red-800"
            >
              {t('upload.drop.remove')}
            </button>
          </div>
        ) : (
          <div>
            <div className="text-3xl mb-2 text-gray-400">📁</div>
            <p className="text-sm text-gray-600">
              <Trans
                t={t}
                i18nKey="upload.drop.prompt"
                components={{ b: <span className="text-primary-700 font-medium" /> }}
              />
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {t('upload.drop.formats')}
            </p>
          </div>
        )}
      </div>

      {/* Themen */}
      {topics.length > 0 && (
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('upload.topics')}</label>
          <div className="flex flex-wrap gap-2">
            {topics.map(t => {
              const active = selectedTopics.includes(t.id);
              return (
                <button key={t.id} type="button"
                        onClick={() => setSelectedTopics(prev => active ? prev.filter(id => id !== t.id) : [...prev, t.id])}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${active ? 'text-white' : 'text-gray-700 hover:bg-gray-50'}`}
                        style={active ? { backgroundColor: t.color, borderColor: t.color } : { borderColor: t.color }}>
                  {active ? '✓ ' : ''}{t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Fehler */}
      {error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Upload-Button */}
      <button
        onClick={handleUpload}
        disabled={!file || uploading}
        className={`mt-4 w-full py-2.5 px-4 rounded-md text-sm font-medium transition-colors ${
          !file || uploading
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : 'bg-primary-600 text-white hover:bg-primary-700'
        }`}
      >
        {uploading ? t('upload.uploading') : t('upload.start')}
      </button>
    </div>
  );
}
