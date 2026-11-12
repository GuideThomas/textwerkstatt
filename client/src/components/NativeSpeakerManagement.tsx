import { useState, useEffect, FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

interface NativeSpeaker {
  id: string;
  name: string;
  email: string;
  languages: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

// DeepL-Sprachcodes, die das Tool unterstuetzt — als Vorschlagsliste fuer das
// Formular. Freitext bleibt moeglich (Person kann beliebige Codes pflegen).
// Anzeigenamen kommen aus dem Namespace `admin` (languages.<CODE>).
const LANGUAGE_OPTIONS: { code: string }[] = [
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
  { code: 'NL' },
  { code: 'PT' },
];

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${endpoint}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: i18n.t('admin:errors.generic') }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export default function NativeSpeakerManagement() {
  const [speakers, setSpeakers] = useState<NativeSpeaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<NativeSpeaker | null>(null);
  const { t } = useTranslation('admin');

  const load = async () => {
    try {
      const data = await apiFetch<NativeSpeaker[]>('/native-speakers/admin');
      setSpeakers(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleDelete = async (s: NativeSpeaker) => {
    if (!confirm(t('speakers.confirmDelete', { name: s.name }))) return;
    try {
      await apiFetch(`/native-speakers/${s.id}`, { method: 'DELETE' });
      await load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleToggleActive = async (s: NativeSpeaker) => {
    try {
      await apiFetch(`/native-speakers/${s.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: !s.active }),
      });
      await load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (loading) {
    return <div className="text-sm text-gray-500">{t('speakers.loading')}</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{t('speakers.title')}</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {t('speakers.intro')}
          </p>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
          className="text-xs bg-primary-600 text-white px-3 py-1.5 rounded hover:bg-primary-700"
        >
          {t('speakers.addButton')}
        </button>
      </div>

      {error && (
        <div className="mb-3 text-xs bg-red-50 text-red-700 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}

      {speakers.length === 0 ? (
        <div className="text-sm text-gray-500 text-center py-8 border border-dashed border-gray-200 rounded">
          {t('speakers.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-2 pr-4 font-medium">{t('common.name')}</th>
                <th className="py-2 pr-4 font-medium">{t('common.email')}</th>
                <th className="py-2 pr-4 font-medium">{t('speakers.colLanguages')}</th>
                <th className="py-2 pr-4 font-medium">{t('common.status')}</th>
                <th className="py-2 pr-4 font-medium text-right">{t('speakers.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {speakers.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium text-gray-900">{s.name}</td>
                  <td className="py-2 pr-4 text-gray-600">{s.email}</td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {s.languages.map((l) => (
                        <span
                          key={l}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-primary-50 text-primary-700 font-medium"
                        >
                          {l}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    <button
                      onClick={() => handleToggleActive(s)}
                      className={`text-xs px-2 py-0.5 rounded ${
                        s.active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'
                      }`}
                    >
                      {s.active ? t('speakers.active') : t('speakers.inactive')}
                    </button>
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <button
                      onClick={() => {
                        setEditing(s);
                        setShowForm(true);
                      }}
                      className="text-xs text-primary-700 hover:underline mr-3"
                    >
                      {t('speakers.edit')}
                    </button>
                    <button
                      onClick={() => handleDelete(s)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      {t('speakers.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <NativeSpeakerForm
          speaker={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setShowForm(false);
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function NativeSpeakerForm({
  speaker,
  onClose,
  onSaved,
}: {
  speaker: NativeSpeaker | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(speaker?.name ?? '');
  const [email, setEmail] = useState(speaker?.email ?? '');
  const [languages, setLanguages] = useState<string[]>(speaker?.languages ?? []);
  const [active, setActive] = useState(speaker?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation('admin');

  const toggleLang = (code: string) => {
    setLanguages((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code],
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({ name, email, languages, active });
      if (speaker) {
        await apiFetch(`/native-speakers/${speaker.id}`, { method: 'PUT', body });
      } else {
        await apiFetch('/native-speakers', { method: 'POST', body });
      }
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <form
        onSubmit={submit}
        className="bg-white rounded-lg shadow-xl max-w-md w-full p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">
            {speaker ? t('speakers.formEditTitle') : t('speakers.formNewTitle')}
          </h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>

        {error && (
          <div className="text-xs bg-red-50 text-red-700 border border-red-200 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">{t('common.name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full text-sm px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder={t('speakers.namePlaceholder')}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">{t('common.email')}</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full text-sm px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
            placeholder="marco.rossi@example.com"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            {t('speakers.languagesLabel')}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {LANGUAGE_OPTIONS.map((opt) => {
              const selected = languages.includes(opt.code);
              return (
                <button
                  key={opt.code}
                  type="button"
                  onClick={() => toggleLang(opt.code)}
                  className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                    selected
                      ? 'bg-primary-600 border-primary-600 text-white'
                      : 'bg-white border-gray-300 text-gray-700 hover:border-primary-400'
                  }`}
                >
                  {t(`languages.${opt.code}`)}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            {t('speakers.languagesHint')}
          </p>
        </div>

        {speaker && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="rounded"
            />
            {t('speakers.activeCheckbox')}
          </label>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-gray-600 px-3 py-1.5 hover:underline"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy || !name || !email || languages.length === 0}
            className="text-xs bg-primary-600 text-white px-4 py-1.5 rounded hover:bg-primary-700 disabled:bg-gray-300"
          >
            {busy ? t('speakers.saving') : speaker ? t('common.save') : t('speakers.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
