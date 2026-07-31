import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { logout } from '../store/authSlice';
import type { RootState } from '../store/store';

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const Icons = {
  home: (
    <svg {...iconProps}>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </svg>
  ),
  car: (
    <svg {...iconProps}>
      <path d="M5 17h14M5 17a2 2 0 104 0M15 17a2 2 0 104 0M3 17V11l2-5h10l4 5v6" />
    </svg>
  ),
  doc: (
    <svg {...iconProps}>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  ),
  card: (
    <svg {...iconProps}>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M2 10h20" />
    </svg>
  ),
  ledger: (
    <svg {...iconProps}>
      <path d="M4 4h16v16H4z" />
      <path d="M8 4v16M12 8h5M12 12h5M12 16h5" />
    </svg>
  ),
  export: (
    <svg {...iconProps}>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M5 21h14a2 2 0 002-2v-3M3 16v3a2 2 0 002 2" />
    </svg>
  ),
  truck: (
    <svg {...iconProps}>
      <path d="M3 17h9V7H3zM12 10h4l3 3v4h-7z" />
      <circle cx="7" cy="19" r="1.6" />
      <circle cx="17" cy="19" r="1.6" />
    </svg>
  ),
  gear: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
};

const NAV = [
  { to: '/', label: 'Acasă', icon: Icons.home },
  { to: '/vehicule', label: 'Vehicule', icon: Icons.car },
  { to: '/documente', label: 'Documente', icon: Icons.doc },
  { to: '/jurnal', label: 'Jurnal contabil', icon: Icons.ledger, accounting: true },
  { to: '/exporturi', label: 'Exporturi SAGA', icon: Icons.export, accounting: true },
  { to: '/e-transport', label: 'e-Transport', icon: Icons.truck },
  { to: '/setari', label: 'Setări', icon: Icons.gear },
];

function initials(user?: { name?: string; email?: string } | null) {
  const source = user?.name?.trim() || user?.email || '';
  if (!source) return '·';
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export default function Layout({ children }: { children: ReactNode }) {
  const dispatch = useDispatch();
  const user = useSelector((s: RootState) => s.auth.user);
  const nav = NAV.filter(
    (item) =>
      !item.accounting ||
      user?.role === 'ACCOUNTANT',
  );

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-colors ${
      isActive
        ? 'bg-sidebar-active text-white'
        : 'text-sidebar-fg hover:bg-sidebar-active/60 hover:text-white'
    }`;

  const brandMark = (
    <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-sm font-extrabold text-white">
      A
    </div>
  );

  return (
    <div className="min-h-full bg-canvas">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[252px] flex-col gap-6 bg-sidebar px-3.5 py-5 md:flex">
        <div className="flex items-center gap-2.5 px-2">
          {brandMark}
          <span className="text-[15px] font-bold text-white">AutoImport</span>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className={linkClass}>
              <span className="shrink-0">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex items-center gap-2.5 border-t border-sidebar-line pt-3.5">
          <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-sidebar-active text-xs font-semibold text-white">
            {initials(user)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-medium text-white">{user?.email}</p>
            <button
              onClick={() => dispatch(logout())}
              className="text-[11.5px] text-sidebar-muted transition-colors hover:text-white"
            >
              Deconectare
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 flex items-center justify-between bg-sidebar px-4 py-3 md:hidden">
        <span className="flex items-center gap-2 font-bold text-white">
          {brandMark}
          AutoImport
        </span>
        <button onClick={() => dispatch(logout())} className="text-sm text-sidebar-fg">
          Ieșire
        </button>
      </header>

      <main className="bg-surface px-4 py-6 pb-24 md:ml-[252px] md:min-h-screen md:px-10 md:py-9">
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex justify-around overflow-x-auto border-t border-line bg-white py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 px-2 py-1 text-[11px] ${
                isActive ? 'font-semibold text-brand' : 'text-muted'
              }`
            }
          >
            <span>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
