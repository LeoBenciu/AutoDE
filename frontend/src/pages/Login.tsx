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

  const field =
    'w-full box-border rounded-control border border-line-strong px-3.5 py-3 text-sm focus:border-brand focus:outline-none';

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas p-4 md:p-7">
      <div className="flex w-full max-w-4xl flex-col overflow-hidden rounded-3xl shadow-[0_20px_60px_-20px_rgba(20,20,40,0.35)] md:min-h-[640px] md:flex-row">
        {/* Brand panel */}
        <div className="flex flex-col justify-between gap-8 bg-sidebar p-10 text-white md:flex-1 md:p-14">
          <div className="flex items-center gap-2.5">
            <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] bg-brand text-base font-extrabold text-white">
              A
            </div>
            <span className="text-base font-bold">AutoImport</span>
          </div>
          <div>
            <h1 className="text-3xl font-bold leading-tight md:text-[34px]">
              Rulează-ți importurile din birou, nu din inbox.
            </h1>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-sidebar-fg">
              Documente, vamă, e-Transport și plăți — totul extras automat și centralizat într-un
              singur loc.
            </p>
          </div>
          <p className="text-[13px] text-sidebar-muted">© 2026 AutoImport</p>
        </div>

        {/* Auth panel */}
        <div className="flex flex-col justify-center bg-white p-10 md:flex-1 md:p-14">
          <div className="mx-auto w-full max-w-[340px]">
            <h2 className="text-[22px] font-bold text-ink">
              {mode === 'login' ? 'Autentificare' : 'Creează contul firmei'}
            </h2>
            <p className="mt-1.5 mb-7 text-sm text-muted">
              {mode === 'login'
                ? 'Intră în contul firmei tale.'
                : 'Contul se creează instant — fără card, fără instalare.'}
            </p>

            <form onSubmit={submit} className="flex flex-col gap-3">
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
                className="mt-1 w-full rounded-control bg-brand py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
                disabled={loggingIn || registering}
              >
                {mode === 'login' ? 'Autentificare' : 'Creează contul firmei →'}
              </button>
            </form>

            <button
              onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              className="mt-5 w-full text-center text-[13px] text-muted hover:text-ink"
            >
              {mode === 'login' ? (
                <>
                  Firmă nouă? <span className="font-semibold text-brand">Creează un cont</span>
                </>
              ) : (
                <>
                  Ai deja cont? <span className="font-semibold text-brand">Autentifică-te</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
