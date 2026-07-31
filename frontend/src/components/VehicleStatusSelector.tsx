import { useEffect, useRef, useState } from 'react';
import {
  getVehicleStatus,
  VEHICLE_STATUSES,
  type VehicleStatus,
} from '../data/vehicleStatuses';

type VehicleStatusSelectorProps = {
  status: string;
  onChange: (status: VehicleStatus) => Promise<void>;
};

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    aria-hidden="true"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const CheckIcon = () => (
  <svg
    aria-hidden="true"
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m5 12 4 4L19 6" />
  </svg>
);

const Spinner = () => (
  <span
    aria-hidden="true"
    className="h-4 w-4 animate-spin rounded-full border-2 border-brand/25 border-t-brand"
  />
);

export function VehicleStatusSelector({
  status,
  onChange,
}: VehicleStatusSelectorProps) {
  const [open, setOpen] = useState(false);
  const [displayStatus, setDisplayStatus] = useState(status);
  const [pendingStatus, setPendingStatus] = useState<VehicleStatus | null>(null);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const current = getVehicleStatus(displayStatus) ?? VEHICLE_STATUSES[0];

  useEffect(() => {
    setDisplayStatus(status);
  }, [status]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.focus();
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const selectStatus = async (nextStatus: VehicleStatus) => {
    if (nextStatus === status || pendingStatus) {
      setOpen(false);
      return;
    }

    setError('');
    setPendingStatus(nextStatus);
    setDisplayStatus(nextStatus);
    setOpen(false);
    try {
      await onChange(nextStatus);
    } catch {
      setDisplayStatus(status);
      setError('Starea nu a putut fi actualizată. Încearcă din nou.');
      setOpen(true);
    } finally {
      setPendingStatus(null);
    }
  };

  return (
    <div ref={rootRef} className="relative w-full sm:w-auto">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Starea vehiculului: ${current.label}`}
        onClick={() => {
          setError('');
          setOpen((value) => !value);
        }}
        disabled={Boolean(pendingStatus)}
        className="group flex w-full min-w-[210px] items-center justify-between gap-5 rounded-card border border-line-strong bg-white px-3.5 py-2.5 text-left shadow-sm transition-all hover:border-brand/50 hover:shadow-md focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/15 disabled:cursor-wait sm:w-auto"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-black/[0.035] ${current.dotClass}`}
          />
          <span className="min-w-0">
            <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              Starea vehiculului
            </span>
            <span className="block truncate text-sm font-semibold text-ink">
              {pendingStatus ? 'Se actualizează…' : current.label}
            </span>
          </span>
        </span>
        <span className="text-muted transition-colors group-hover:text-brand">
          {pendingStatus ? <Spinner /> : <ChevronIcon open={open} />}
        </span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Închide selectorul de stare"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-slate-950/15 backdrop-blur-[1px] md:hidden"
          />
          <div className="fixed inset-x-3 bottom-3 z-40 flex max-h-[75dvh] min-w-[310px] flex-col overflow-hidden rounded-card border border-line bg-white shadow-[0_18px_45px_rgba(20,25,40,0.16)] md:absolute md:bottom-auto md:left-auto md:right-0 md:mt-2 md:w-[350px] md:max-h-none">
            <div className="border-b border-line px-4 py-3">
              <p className="text-sm font-semibold text-ink">Schimbă starea vehiculului</p>
              <p className="mt-0.5 text-xs text-muted">
                Selectează etapa curentă din flux.
              </p>
            </div>

            <div role="listbox" aria-label="Starea vehiculului" className="min-h-0 flex-1 overflow-y-auto p-1.5 md:max-h-[min(28rem,65vh)]">
              {VEHICLE_STATUSES.map((item, index) => {
                const selected = item.value === status;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => selectStatus(item.value)}
                    className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2.5 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand/20 ${
                      selected ? 'bg-brand/[0.07]' : 'hover:bg-canvas/70'
                    }`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas text-[11px] font-semibold text-muted">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <span className={`h-2 w-2 rounded-full ${item.dotClass}`} />
                        {item.label}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {item.description}
                      </span>
                    </span>
                    <span className={selected ? 'text-brand' : 'text-transparent'}>
                      <CheckIcon />
                    </span>
                  </button>
                );
              })}
            </div>

            {error && (
              <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700">
                {error}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
