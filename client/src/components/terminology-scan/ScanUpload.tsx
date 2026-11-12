import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../../i18n';

const SUPPORTED_EXTENSIONS = ['.idml', '.docx', '.xlsx', '.txt'];
// Anzeigename kommt aus `terminology:languages.<code>`
const LANGUAGES = [
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

interface Glossary {
  id: string;
  name: string;
  source_lang: string;
  target_lang: string;
  entry_count: number;
}

interface Props {
  onUploadComplete: (scanId: string) => void;
  disabled?: boolean;
}

export default function ScanUpload({ onUploadComplete, disabled }: Props) {
  const { t } = useTranslation('terminology');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [translationFile, setTranslationFile] = useState<File | null>(null);
  const [sourceLang, setSourceLang] = useState('DE');
  const [targetLang, setTargetLang] = useState('IT');
  const [glossaryId, setGlossaryId] = useState('');
  const [glossaries, setGlossaries] = useState<Glossary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<HTMLInputElement>(null);
  const transRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/glossaries')
      .then(r => r.json())
      .then(setGlossaries)
      .catch(() => {});
  }, []);

  const filteredGlossaries = glossaries.filter(
    g => g.source_lang === sourceLang && g.target_lang === targetLang,
  );

  const validateFile = (file: File): boolean => {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(ext);
  };

  const handleDrop = useCallback((e: React.DragEvent, target: 'source' | 'translation') => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && validateFile(file)) {
      if (target === 'source') setSourceFile(file);
      else setTranslationFile(file);
      setError(null);
    } else {
      setError(t('upload.errors.unsupported', { allowed: SUPPORTED_EXTENSIONS.join(', ') }));
    }
  }, [t]);

  const handleSubmit = async () => {
    if (!sourceFile || !translationFile) return;
    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append('source', sourceFile);
    formData.append('translation', translationFile);
    formData.append('source_lang', sourceLang);
    formData.append('target_lang', targetLang);
    if (glossaryId) formData.append('glossary_id', glossaryId);

    try {
      const res = await fetch('/api/terminology-scan/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('upload.errors.uploadFailed'));
      }

      const data = await res.json();
      setSourceFile(null);
      setTranslationFile(null);
      onUploadComplete(data.scan_id);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const DropZone = ({ label, file, target, inputRef }: {
    label: string;
    file: File | null;
    target: 'source' | 'translation';
    inputRef: React.RefObject<HTMLInputElement | null>;
  }) => (
    <div
      className={`flex-1 border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors
        ${file ? 'border-primary-300 bg-primary-50' : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => e.preventDefault()}
      onDrop={e => handleDrop(e, target)}
    >
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={SUPPORTED_EXTENSIONS.join(',')}
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) {
            if (target === 'source') setSourceFile(f);
            else setTranslationFile(f);
            setError(null);
          }
        }}
      />
      {file ? (
        <div>
          <div className="text-sm font-medium text-primary-700">{file.name}</div>
          <div className="text-xs text-gray-500 mt-1">{(file.size / 1024).toLocaleString(currentLocale(), { maximumFractionDigits: 0 })} KB</div>
        </div>
      ) : (
        <div>
          <div className="text-sm text-gray-600">{label}</div>
          <div className="text-xs text-gray-400 mt-1">{t('upload.dropHint')}</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-medium text-gray-900 mb-3">{t('upload.title')}</h3>

      {/* Dropzones */}
      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <DropZone label={t('upload.sourceFile')} file={sourceFile} target="source" inputRef={sourceRef} />
        <DropZone label={t('upload.translationFile')} file={translationFile} target="translation" inputRef={transRef} />
      </div>

      {/* Optionen — brechen am Handy um (gemessen 11.11.2026: die Zeile war bei 390 px 746 px breit) */}
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">{t('upload.sourceLang')}</label>
          <select
            value={sourceLang}
            onChange={e => setSourceLang(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          >
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{t(`languages.${l.code}`)}</option>)}
          </select>
        </div>
        <span className="text-gray-400">→</span>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">{t('upload.targetLang')}</label>
          <select
            value={targetLang}
            onChange={e => setTargetLang(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          >
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{t(`languages.${l.code}`)}</option>)}
          </select>
        </div>
        {filteredGlossaries.length > 0 && (
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-gray-500">{t('upload.glossary')}</label>
            <select
              value={glossaryId}
              onChange={e => setGlossaryId(e.target.value)}
              className="text-sm border border-gray-300 rounded px-2 py-1 max-w-[14rem]"
            >
              <option value="">{t('upload.noGlossary')}</option>
              {filteredGlossaries.map(g => (
                <option key={g.id} value={g.id}>{g.name} ({g.entry_count})</option>
              ))}
            </select>
          </div>
        )}
        <button
          onClick={handleSubmit}
          disabled={!sourceFile || !translationFile || uploading || disabled}
          className="ml-auto px-4 py-1.5 text-sm font-medium text-white bg-primary-600 font-semibold rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? t('upload.uploading') : t('upload.start')}
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">{error}</div>
      )}

      <div className="text-xs text-gray-400">
        {t('upload.formats')}
      </div>
    </div>
  );
}
