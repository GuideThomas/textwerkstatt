import { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import i18n, { currentLocale } from '../i18n';
import { orgName } from '../einstellungen';

/**
 * Hausschreibweise pflegen: „nicht verwenden" → „stattdessen", Standard (Organisation)
 * plus optionaler Begriff je Verkaufschannel. Aufbau und Bedienung wie die
 * Channel-Spalten im GlossaryManager: Zelle anklicken, Enter speichert,
 * Escape bricht ab, Channel-Zelle leeren = Standard gilt.
 *
 * „Stattdessen (Organisation)" leer = der Begriff bleibt bei der Organisation, nur die Channels
 * weichen ab. Der Server speichert dann denselben Begriff in beiden Feldern;
 * die Zelle zeigt dafür „bleibt".
 */

interface HouseTermRow {
  id: string;
  avoid_term: string;
  preferred_term: string;
  note: string | null;
  updated_at: string;
  channels: Record<string, string>;
  last_changed_by: string | null;
}

interface Channel {
  code: string;
  name: string;
}

interface HistoryRow {
  field: string;
  action: 'created' | 'updated' | 'deleted';
  old_value: string | null;
  new_value: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

// Übersetzungsschlüssel (Namespace `glossary`) je Verlaufsfeld bzw. -aktion.
const FIELD_LABEL: Record<string, string> = {
  avoid: 'houseTerms.history.field.avoid',
  standard: 'houseTerms.history.field.standard',
  note: 'houseTerms.history.field.note',
};

const ACTION_LABEL: Record<string, string> = {
  created: 'houseTerms.history.action.created',
  updated: 'houseTerms.history.action.updated',
  deleted: 'houseTerms.history.action.deleted',
};

type EditField = 'avoid_term' | 'preferred_term' | 'note' | `channel:${string}`;

const sameTerm = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  return data?.error || i18n.t('glossary:houseTerms.errors.status', { status: res.status });
}

export default function HouseTermManager() {
  const { t } = useTranslation('glossary');
  const [rows, setRows] = useState<HouseTermRow[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [newAvoid, setNewAvoid] = useState('');
  const [newPreferred, setNewPreferred] = useState('');
  const [newNote, setNewNote] = useState('');
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<{ id: string; field: EditField } | null>(null);
  const [draft, setDraft] = useState('');

  const [historyFor, setHistoryFor] = useState<HouseTermRow | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const load = async () => {
    try {
      const res = await fetch('/api/house-terms');
      if (!res.ok) throw new Error(await readError(res));
      setRows(await res.json());
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    fetch('/api/glossaries/channels')
      .then((r) => r.json())
      .then((data: Channel[]) => setChannels(Array.isArray(data) ? data : []))
      .catch(() => setChannels([]));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.avoid_term, r.preferred_term, r.note || '', ...Object.values(r.channels)]
        .some((v) => v.toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAvoid.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/house-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avoid_term: newAvoid, preferred_term: newPreferred, note: newNote }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setNewAvoid('');
      setNewPreferred('');
      setNewNote('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (id: string, field: EditField, current: string) => {
    setEditing({ id, field });
    setDraft(current);
  };

  const cancelEdit = () => {
    setEditing(null);
    setDraft('');
  };

  const finishEdit = async (row: HouseTermRow, field: EditField, current: string) => {
    if (draft.trim() === current.trim()) {
      cancelEdit();
      return;
    }
    try {
      let res: Response;
      if (field.startsWith('channel:')) {
        const code = field.slice('channel:'.length);
        res = await fetch(`/api/house-terms/${row.id}/channels/${code}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preferred_term: draft }),
        });
      } else {
        res = await fetch(`/api/house-terms/${row.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: draft }),
        });
      }
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      cancelEdit();
    }
  };

  const handleDelete = async (row: HouseTermRow) => {
    if (!confirm(t('houseTerms.deleteConfirm', { term: row.avoid_term }))) return;
    try {
      const res = await fetch(`/api/house-terms/${row.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res));
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const openHistory = async (row: HouseTermRow) => {
    setHistoryFor(row);
    setHistory([]);
    try {
      const res = await fetch(`/api/house-terms/${row.id}/history`);
      if (!res.ok) throw new Error(await readError(res));
      setHistory(await res.json());
    } catch (err: any) {
      setError(err.message);
    }
  };

  const renderCell = (row: HouseTermRow, field: EditField, current: string, opts: { required: boolean; emptyLabel: string; title: string }) => {
    const isEditing = editing?.id === row.id && editing.field === field;
    if (isEditing) {
      return (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (opts.required && !draft.trim()) { cancelEdit(); return; }
            finishEdit(row, field, current);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              cancelEdit();
            }
          }}
          className="w-full text-sm border border-primary-400 rounded px-1.5 py-0.5"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => startEdit(row.id, field, current)}
        title={opts.title}
        className={`block w-full text-left px-1.5 py-0.5 rounded text-sm transition-colors ${
          current ? 'text-gray-700 hover:bg-primary-50' : 'text-gray-300 hover:bg-gray-100 italic'
        }`}
      >
        {current || opts.emptyLabel}
      </button>
    );
  };

  return (
    <div>
      <div className="mb-4 text-sm text-gray-600 max-w-3xl">
        <Trans t={t} i18nKey="houseTerms.intro" components={{ b: <strong /> }} />
      </div>

      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3 mb-4 bg-white border border-gray-200 rounded-lg px-4 py-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('houseTerms.form.avoidLabel')}</label>
          <input
            value={newAvoid}
            onChange={(e) => setNewAvoid(e.target.value)}
            placeholder={t('houseTerms.form.example', { term: 'LED-Treiber' })}
            className="text-sm border border-gray-300 rounded px-3 py-1.5 w-56"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('houseTerms.form.preferredLabel')}</label>
          <input
            value={newPreferred}
            onChange={(e) => setNewPreferred(e.target.value)}
            placeholder={t('houseTerms.form.preferredPlaceholder')}
            className="text-sm border border-gray-300 rounded px-3 py-1.5 w-56"
          />
        </div>
        <div className="flex-1 min-w-[12rem]">
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('houseTerms.form.noteLabel')}</label>
          <input
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder={t('houseTerms.form.notePlaceholder')}
            className="text-sm border border-gray-300 rounded px-3 py-1.5 w-full"
          />
        </div>
        <button
          type="submit"
          disabled={saving || !newAvoid.trim()}
          className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-40"
        >
          {saving ? t('houseTerms.form.saving') : t('houseTerms.form.add')}
        </button>
      </form>

      {error && (
        <div className="mb-3 text-sm text-red-600 flex items-center gap-2">
          {error}
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-gray-700">
            {t('houseTerms.list.count', { count: rows.length })}
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('houseTerms.list.searchPlaceholder')}
            className="text-sm border border-gray-300 rounded px-3 py-1 w-56"
          />
        </div>
        <div className="max-h-[32rem] overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th className="text-left px-4 py-2 text-gray-500 font-medium whitespace-nowrap">{t('houseTerms.table.avoid')}</th>
                <th className="text-left px-4 py-2 text-gray-500 font-medium whitespace-nowrap">
                  {t('houseTerms.table.preferred')} <span className="text-gray-300 font-normal">({orgName()})</span>
                </th>
                {channels.map((ch) => (
                  <th key={ch.code} className="text-left px-3 py-2 text-gray-500 font-medium whitespace-nowrap border-l border-gray-100">
                    {ch.name}
                  </th>
                ))}
                <th className="text-left px-3 py-2 text-gray-500 font-medium border-l border-gray-100">{t('houseTerms.table.note')}</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading && (
                <tr><td colSpan={4 + channels.length} className="px-4 py-6 text-center text-gray-400">{t('houseTerms.list.loading')}</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={4 + channels.length} className="px-4 py-6 text-center text-gray-400">
                    {rows.length === 0 ? t('houseTerms.list.empty') : t('houseTerms.list.noMatches')}
                  </td>
                </tr>
              )}
              {filtered.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-1 align-middle">
                    {renderCell(row, 'avoid_term', row.avoid_term, {
                      required: true, emptyLabel: '–', title: t('houseTerms.cell.editAvoid'),
                    })}
                  </td>
                  <td className="px-4 py-1 align-middle">
                    {renderCell(row, 'preferred_term', sameTerm(row.preferred_term, row.avoid_term) ? '' : row.preferred_term, {
                      required: false, emptyLabel: t('houseTerms.cell.keeps'), title: t('houseTerms.cell.editPreferred'),
                    })}
                  </td>
                  {channels.map((ch) => {
                    const current = row.channels?.[ch.code] ?? '';
                    return (
                      <td key={ch.code} className="px-3 py-1 border-l border-gray-100 align-middle">
                        {renderCell(row, `channel:${ch.code}`, current, {
                          required: false,
                          emptyLabel: '–',
                          title: current
                            ? t('houseTerms.cell.channelSet', { channel: ch.name, value: current })
                            : t('houseTerms.cell.channelEmpty', { channel: ch.name, term: row.preferred_term }),
                        })}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1 border-l border-gray-100 align-middle">
                    {renderCell(row, 'note', row.note || '', {
                      required: false, emptyLabel: '–', title: t('houseTerms.cell.editNote'),
                    })}
                  </td>
                  <td className="px-2 whitespace-nowrap">
                    <button
                      onClick={() => openHistory(row)}
                      className="text-gray-400 hover:text-primary-600 mr-1"
                      title={row.last_changed_by ? t('houseTerms.row.historyTitleLast', { name: row.last_changed_by }) : t('houseTerms.row.historyTitle')}
                    >
                      ⟲
                    </button>
                    <button
                      onClick={() => handleDelete(row)}
                      className="text-gray-400 hover:text-red-500"
                      title={t('houseTerms.row.deleteTitle')}
                    >
                      &times;
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {historyFor && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 px-4" onClick={() => setHistoryFor(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-800">{t('houseTerms.history.title', { term: historyFor.avoid_term })}</span>
              <button onClick={() => setHistoryFor(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
            </div>
            <ul className="divide-y divide-gray-50 text-sm">
              {history.length === 0 && <li className="px-4 py-4 text-gray-400">{t('houseTerms.history.empty')}</li>}
              {history.map((h, i) => (
                <li key={i} className="px-4 py-2">
                  <div className="text-gray-800">
                    {t('houseTerms.history.entry', {
                      field: FIELD_LABEL[h.field] ? t(FIELD_LABEL[h.field]) : t('houseTerms.history.field.channel', { code: h.field }),
                      action: ACTION_LABEL[h.action] ? t(ACTION_LABEL[h.action]) : h.action,
                    })}
                    {h.old_value !== null && <span className="text-red-600 line-through ml-2">{h.old_value}</span>}
                    {h.new_value !== null && <span className="text-green-700 ml-2">{h.new_value}</span>}
                  </div>
                  <div className="text-xs text-gray-400">
                    {h.changed_by_name || t('houseTerms.history.unknownUser')} · {new Date(h.changed_at).toLocaleString(currentLocale(), { timeZone: 'Europe/Vienna' })}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
