import { FormEvent, useState } from 'react';
import { useSelector } from 'react-redux';
import { useCreateUserMutation, useUpdateUserMutation, useUsersQuery } from '../store/api';
import type { RootState } from '../store/store';

const ROLES = ['OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT', 'VIEWER'];
const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Proprietar',
  MANAGER: 'Manager',
  SALES: 'Vânzări',
  ACCOUNTANT: 'Contabil',
  VIEWER: 'Doar citire',
};

export default function Settings() {
  const me = useSelector((s: RootState) => s.auth.user);
  const { data: users = [], isLoading, error } = useUsersQuery();
  const [updateUser] = useUpdateUserMutation();
  const [message, setMessage] = useState('');
  const isOwner = me?.role === 'OWNER';

  const act = async (fn: () => Promise<any>) => {
    setMessage('');
    try {
      await fn();
    } catch (err: any) {
      setMessage(err?.data?.message ?? 'Eroare');
    }
  };

  if (error) {
    return (
      <p className="rounded-xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
        Doar OWNER și MANAGER pot vedea utilizatorii firmei.
      </p>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Setări · Utilizatori</h1>
      <p className="mt-1 text-sm text-slate-500">
        Administrează conturile firmei: adaugă colegi, schimbă roluri, dezactivează accesul.
      </p>
      {message && <p className="mt-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{message}</p>}

      <div className="mt-4 space-y-2">
        {users.map((u: any) => (
          <div key={u.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 shadow-sm">
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">
                {u.name} {u.id === me?.id && <span className="text-xs font-normal text-slate-400">(tu)</span>}
              </p>
              <p className="truncate text-xs text-slate-500">{u.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {isOwner && u.id !== me?.id ? (
                <>
                  <select
                    value={u.role}
                    onChange={(e) => act(() => updateUser({ id: u.id, body: { role: e.target.value } }).unwrap())}
                    className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => act(() => updateUser({ id: u.id, body: { active: !u.active } }).unwrap())}
                    className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
                      u.active ? 'border border-slate-300 text-slate-700' : 'bg-emerald-600 text-white'
                    }`}
                  >
                    {u.active ? 'Dezactivează' : 'Reactivează'}
                  </button>
                </>
              ) : (
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                  {ROLE_LABELS[u.role] ?? u.role}
                </span>
              )}
              {!u.active && <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs text-red-700">Dezactivat</span>}
            </div>
          </div>
        ))}
        {isLoading && <p className="text-sm text-slate-500">Se încarcă…</p>}
      </div>

      {isOwner && <NewUserForm onError={setMessage} />}
    </div>
  );
}

function NewUserForm({ onError }: { onError: (m: string) => void }) {
  const [createUser, { isLoading }] = useCreateUserMutation();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'SALES' });
  const [ok, setOk] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    onError('');
    setOk('');
    try {
      await createUser(form).unwrap();
      setOk(`Cont creat pentru ${form.email} ✔ — transmite-i parola pe un canal sigur.`);
      setForm({ name: '', email: '', password: '', role: 'SALES' });
    } catch (err: any) {
      onError(err?.data?.message ?? 'Eroare la crearea contului');
    }
  };

  const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm';
  return (
    <form onSubmit={submit} className="mt-6 rounded-xl bg-white p-4 shadow-sm">
      <h2 className="font-semibold text-slate-900">Adaugă utilizator</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className={field} placeholder="Nume" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input className={field} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <input className={field} type="password" placeholder="Parolă (min. 8)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
        <select className={field} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
          ))}
        </select>
        <button disabled={isLoading} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Creează cont
        </button>
      </div>
      {ok && <p className="mt-2 text-sm text-emerald-700">{ok}</p>}
    </form>
  );
}
