import { useState, useEffect, FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { currentLocale } from '../i18n';

interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
  microsoft_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
  /** Cloud-KI der Textwerkstatt freigeschaltet (Migration 040, #1838) */
  darf_cloud_ki?: boolean;
  darf_cloud_ki_am?: string | null;
  darf_cloud_ki_von_name?: string | null;
}

const ROLE_COLORS: Record<string, string> = {
  admin: 'bg-red-100 text-red-700',
  user: 'bg-primary-100 text-primary-700',
  viewer: 'bg-gray-100 text-gray-700',
};

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

export default function UserManagement() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const { t } = useTranslation('admin');

  const loadUsers = async () => {
    try {
      const data = await apiFetch<User[]>('/users');
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadUsers(); }, []);

  if (loading) return <div className="text-gray-400 text-sm py-10 text-center">{t('users.loading')}</div>;
  if (error) return <div className="text-red-500 text-sm py-10 text-center">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{t('users.title')}</h3>
        <button
          onClick={() => { setShowCreate(true); setEditUser(null); }}
          className="px-3 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700"
        >
          {t('users.newButton')}
        </button>
      </div>

      {(showCreate || editUser) && (
        <UserForm
          user={editUser}
          onSave={() => { setShowCreate(false); setEditUser(null); loadUsers(); }}
          onCancel={() => { setShowCreate(false); setEditUser(null); }}
        />
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-2 pr-4">{t('common.name')}</th>
              <th className="py-2 pr-4">{t('common.email')}</th>
              <th className="py-2 pr-4">{t('users.colRole')}</th>
              <th className="py-2 pr-4">{t('common.status')}</th>
              <th className="py-2 pr-4">{t('users.colAuth')}</th>
              <th className="py-2 pr-4">{t('ki:freischaltung.spalte')}</th>
              <th className="py-2 pr-4">{t('users.colCreated')}</th>
              <th className="py-2">{t('users.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={`border-b border-gray-50 ${!u.active ? 'opacity-50' : ''}`}>
                <td className="py-2 pr-4 font-medium">{u.display_name || u.name || '–'}</td>
                <td className="py-2 pr-4 text-gray-600">{u.email}</td>
                <td className="py-2 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded ${ROLE_COLORS[u.role] || 'bg-gray-100'}`}>
                    {t(`roles.${u.role}`, { defaultValue: u.role })}
                  </span>
                </td>
                <td className="py-2 pr-4">
                  {u.active ? (
                    <span className="text-xs text-green-600">{t('users.active')}</span>
                  ) : (
                    <span className="text-xs text-red-500">{t('users.deactivated')}</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {u.microsoft_id ? (
                    <span className="text-xs text-primary-600">Microsoft</span>
                  ) : (
                    <span className="text-xs text-gray-400">{t('users.authLocal')}</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  <label
                    className="inline-flex items-center gap-1.5 text-xs"
                    title={u.darf_cloud_ki_am
                      ? t('ki:freischaltung.vermerk', {
                          von: u.darf_cloud_ki_von_name || '–',
                          am: new Date(u.darf_cloud_ki_am).toLocaleString(currentLocale()),
                        })
                      : t('ki:freischaltung.nie')}
                  >
                    <input
                      type="checkbox"
                      checked={!!u.darf_cloud_ki}
                      disabled={!u.active}
                      onChange={async (e) => {
                        try {
                          await apiFetch(`/users/${u.id}/cloud-ki`, {
                            method: 'PUT',
                            body: JSON.stringify({ erlaubt: e.target.checked }),
                          });
                          loadUsers();
                        } catch (err: any) {
                          alert(err.message);
                        }
                      }}
                    />
                    {u.darf_cloud_ki ? t('ki:freischaltung.an') : t('ki:freischaltung.aus')}
                  </label>
                </td>
                <td className="py-2 pr-4 text-xs text-gray-400">
                  {new Date(u.created_at).toLocaleDateString(currentLocale())}
                </td>
                <td className="py-2">
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setEditUser(u); setShowCreate(false); }}
                      className="text-xs text-primary-700 hover:underline"
                    >
                      {t('users.edit')}
                    </button>
                    {u.active && (
                      <button
                        onClick={async () => {
                          if (!confirm(t('users.confirmDeactivate', { email: u.email }))) return;
                          try {
                            await apiFetch(`/users/${u.id}`, { method: 'DELETE' });
                            loadUsers();
                          } catch (err: any) {
                            alert(err.message);
                          }
                        }}
                        className="text-xs text-red-500 hover:underline"
                      >
                        {t('users.deactivate')}
                      </button>
                    )}
                    {!u.active && (
                      <button
                        onClick={async () => {
                          try {
                            await apiFetch(`/users/${u.id}`, {
                              method: 'PUT',
                              body: JSON.stringify({ active: true }),
                            });
                            loadUsers();
                          } catch (err: any) {
                            alert(err.message);
                          }
                        }}
                        className="text-xs text-green-600 hover:underline"
                      >
                        {t('users.activate')}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {users.length === 0 && (
        <div className="text-center text-gray-400 text-sm py-8">
          {t('users.empty')}
        </div>
      )}
    </div>
  );
}

function UserForm({
  user,
  onSave,
  onCancel,
}: {
  user: User | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [email, setEmail] = useState(user?.email || '');
  const [name, setName] = useState(user?.name || user?.display_name || '');
  const [role, setRole] = useState(user?.role || 'user');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation('admin');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      if (user) {
        // Update
        const body: any = { name, role };
        if (password) body.password = password;
        await apiFetch(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        // Create
        await apiFetch('/users', {
          method: 'POST',
          body: JSON.stringify({ email, name, role, password: password || undefined }),
        });
      }
      onSave();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3">
      <h4 className="text-sm font-medium">{user ? t('users.formEditTitle') : t('users.formNewTitle')}</h4>

      {error && <div className="text-sm text-red-600 bg-red-50 p-2 rounded">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('common.email')}</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!!user}
            required
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md disabled:bg-gray-100"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('common.name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('users.colRole')}</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
          >
            <option value="admin">{t('roles.admin')}</option>
            <option value="user">{t('roles.user')}</option>
            <option value="viewer">{t('roles.viewer')}</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            {user ? t('users.passwordLabelEdit') : t('users.passwordLabelNew')}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-1.5 text-sm bg-primary-600 text-white font-semibold rounded-md hover:bg-primary-700 disabled:opacity-50"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md"
        >
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
