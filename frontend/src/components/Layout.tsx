import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { logout } from '../store/authSlice';
import type { RootState } from '../store/store';

const NAV = [
  { to: '/', label: 'Acasă', icon: '🏠' },
  { to: '/vehicule', label: 'Vehicule', icon: '🚗' },
  { to: '/documente', label: 'Documente', icon: '📄' },
  { to: '/e-transport', label: 'e-Transport', icon: '🚚' },
  { to: '/setari', label: 'Setări', icon: '⚙️' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const dispatch = useDispatch();
  const user = useSelector((s: RootState) => s.auth.user);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
    }`;

  return (
    <div className="min-h-full bg-slate-100">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-slate-900 p-4 md:flex">
        <div className="mb-8 flex items-center gap-2 px-2">
          <span className="text-2xl">🚗</span>
          <span className="text-lg font-bold text-white">AutoImport</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className={linkClass}>
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto border-t border-slate-800 pt-3">
          <p className="truncate px-2 text-xs text-slate-400">{user?.email}</p>
          <button
            onClick={() => dispatch(logout())}
            className="mt-2 w-full rounded-lg px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800"
          >
            Deconectare
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between bg-slate-900 px-4 py-3 md:hidden">
        <span className="font-bold text-white">🚗 AutoImport</span>
        <button onClick={() => dispatch(logout())} className="text-sm text-slate-300">
          Ieșire
        </button>
      </header>

      <main className="px-4 py-6 pb-24 md:ml-60 md:pb-8 lg:px-8">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-slate-200 bg-white py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-2 py-1 text-[11px] ${
                isActive ? 'font-semibold text-slate-900' : 'text-slate-500'
              }`
            }
          >
            <span className="text-lg leading-none">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
