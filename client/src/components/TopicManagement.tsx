import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import thema from '@thema';

interface Topic {
  id: string;
  name: string;
  color: string;
  project_count: number;
  created_at?: string;
  updated_at?: string;
}

// Startfarbe eines neuen Themas kommt aus dem Erscheinungsbild (wird als Hexwert gespeichert)
const DEFAULT_COLOR = thema.kategorieFarbe;

export default function TopicManagement() {
  const { t } = useTranslation('glossary');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_COLOR);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState(DEFAULT_COLOR);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/topics');
      if (res.ok) setTopics(await res.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setError(null);
    try {
      const res = await fetch('/api/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), color: newColor }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('topics.errors.createFailed'));
      }
      setNewName('');
      setNewColor(DEFAULT_COLOR);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('topics.errors.unknown'));
    }
  };

  const startEdit = (t: Topic) => {
    setEditing(t.id);
    setEditName(t.name);
    setEditColor(t.color);
  };

  const handleUpdate = async () => {
    if (!editing) return;
    setError(null);
    try {
      const res = await fetch(`/api/topics/${editing}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), color: editColor }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || t('topics.errors.saveFailed'));
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('topics.errors.unknown'));
    }
  };

  const handleDelete = async (topic: Topic) => {
    const msg = topic.project_count > 0
      ? t('topics.deleteConfirmWithDocs', { name: topic.name, count: topic.project_count })
      : t('topics.deleteConfirm', { name: topic.name });
    if (!confirm(msg)) return;
    try {
      const res = await fetch(`/api/topics/${topic.id}`, { method: 'DELETE' });
      if (res.ok) await load();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-800 mb-4">{t('topics.title')}</h3>
      <p className="text-xs text-gray-500 mb-4">
        {t('topics.intro')}
      </p>

      {/* Neu anlegen */}
      <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-gray-100">
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs font-medium text-gray-700 mb-1">{t('topics.form.newLabel')}</label>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                 placeholder={t('topics.form.namePlaceholder')}
                 className="w-full rounded-md border border-gray-300 text-sm p-2" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">{t('topics.form.color')}</label>
          <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)}
                 className="h-9 w-14 border border-gray-300 rounded cursor-pointer" />
        </div>
        <button onClick={handleCreate}
                disabled={!newName.trim()}
                className="bg-primary-600 text-white text-sm px-4 py-2 rounded hover:bg-primary-700 disabled:bg-gray-200 disabled:text-gray-400">
          {t('topics.form.create')}
        </button>
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">{t('topics.list.loading')}</p>
      ) : topics.length === 0 ? (
        <p className="text-sm text-gray-400 italic">{t('topics.list.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-gray-500 border-b">
            <tr>
              <th className="py-2 pr-4">{t('topics.table.name')}</th>
              <th className="py-2 pr-4">{t('topics.table.color')}</th>
              <th className="py-2 pr-4 text-right">{t('topics.table.documents')}</th>
              <th className="py-2 text-right">{t('topics.table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {topics.map((topic) => (
              <tr key={topic.id} className="border-b border-gray-50">
                <td className="py-2 pr-4">
                  {editing === topic.id ? (
                    <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                           className="w-full rounded border border-gray-300 text-sm p-1" />
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: topic.color }} />
                      {topic.name}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {editing === topic.id ? (
                    <input type="color" value={editColor} onChange={(e) => setEditColor(e.target.value)}
                           className="h-7 w-12 border border-gray-300 rounded cursor-pointer" />
                  ) : (
                    <code className="text-xs text-gray-500">{topic.color}</code>
                  )}
                </td>
                <td className="py-2 pr-4 text-right text-gray-600">{topic.project_count}</td>
                <td className="py-2 text-right space-x-2">
                  {editing === topic.id ? (
                    <>
                      <button onClick={handleUpdate} className="text-xs text-primary-700 hover:underline">{t('topics.actions.save')}</button>
                      <button onClick={() => setEditing(null)} className="text-xs text-gray-500 hover:underline">{t('topics.actions.cancel')}</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startEdit(topic)} className="text-xs text-primary-700 hover:underline">{t('topics.actions.edit')}</button>
                      <button onClick={() => handleDelete(topic)} className="text-xs text-red-600 hover:underline">{t('topics.actions.delete')}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
