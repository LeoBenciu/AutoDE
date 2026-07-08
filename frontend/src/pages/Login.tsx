import { FormEvent, useState } from 'react';
import { useDispatch } from 'react-redux';
import { useLoginMutation, useRegisterMutation } from '../store/api';
import { setCredentials } from '../store/authSlice';

export default function Login() {
  const dispatch = useDispatch();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ companyName: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [login, { isLoading: loggingIn }] = useLoginMutation();
  const [register, { isLoading: registering }] = useRegisterMutation();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const result =
        mode === 'login'
          ? await login({ email: form.email, password: form.password }).unwrap()
          : await register(form).unwrap();
      dispatch(setCredentials(result));
    } catch (err: any) {
      setError(err?.data?.message ?? 'A apărut o eroare. Încearcă din nou.');
    }
  };

  const field = 'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-900 focus:outline-none';

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg">
        <div className="mb-6 text-center">
          <div className="text-3xl">🚗</div>
          <h1 className="mt-1 text-xl font-bold text-slate-900">AutoImport</h1>
          <p className="text-sm text-slate-500">Platforma dealerului de mașini importate</p>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {mode === 'register' && (
            <>
              <input
                className={field}
                placeholder="Numele firmei (SRL)"
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                required
              />
              <input
                className={field}
                placeholder="Numele tău"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </>
          )}
          <input
            className={field}
            type="email"
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <input
            className={field}
            type="password"
            placeholder="Parolă"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={mode === 'register' ? 8 : undefined}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            disabled={loggingIn || registering}
          >
            {mode === 'login' ? 'Autentificare' : 'Creează cont'}
          </button>
        </form>
        <button
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          className="mt-4 w-full text-center text-sm text-slate-500 hover:text-slate-900"
        >
          {mode === 'login' ? 'Firmă nouă? Creează un cont' : 'Ai deja cont? Autentifică-te'}
        </button>
      </div>
    </div>
  );
}
