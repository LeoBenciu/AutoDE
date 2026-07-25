import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreateVehicleMutation, useVehiclesQuery } from '../store/api';
import { StatusChip } from '../components/StatusChip';

const STATUSES = ['', 'SOURCED', 'PURCHASED', 'IN_TRANSIT', 'CUSTOMS', 'IN_STOCK', 'RESERVED', 'SOLD', 'DELIVERED'];

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const CarIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 17h14M5 17a2 2 0 104 0M15 17a2 2 0 104 0M3 17V11l2-5h10l4 5v6" />
  </svg>
);

export default function Vehicles() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const { data: vehicles = [], isLoading } = useVehiclesQuery({ status: status || undefined, search: search || undefined });

  const filtered = Boolean(status || search);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Vehicule</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover"
        >
          <PlusIcon />
          Adaugă
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-2.5 sm:flex-row">
        <div className="relative flex-1 sm:max-w-xs">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-2"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Caută VIN, marcă, model…"
            className="w-full rounded-control border border-line-strong py-2.5 pl-9 pr-3 text-sm focus:border-brand focus:outline-none"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-control border border-line-strong px-3 py-2.5 text-sm text-ink-soft focus:border-brand focus:outline-none"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'Toate statusurile' : s}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        {vehicles.map((v) => (
          <Link
            key={v.id}
            to={`/vehicule/${v.id}`}
            className="rounded-card border border-line bg-white p-4 transition-colors hover:border-line-strong"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-[15px] font-semibold text-ink">
                {v.make} {v.model}
              </p>
              <StatusChip status={v.status} />
            </div>
            <p className="mt-1.5 text-[12.5px] text-muted">
              {v.year} · {v.mileageKm ? `${Number(v.mileageKm).toLocaleString('ro-RO')} km` : 'km n/a'} · {v.originCountry}
            </p>
            <p className="mt-1 font-mono text-xs text-muted-2">{v.vin}</p>
            <p className="mt-2.5 border-t border-line pt-2.5 text-sm text-ink-soft">
              Achiziție <b className="text-ink">{Number(v.purchasePrice).toLocaleString('ro-RO')} {v.purchaseCurrency}</b>
              {v.soldPrice && (
                <>
                  {' · '}Vândut <b className="text-ink">{Number(v.soldPrice).toLocaleString('ro-RO')} {v.soldCurrency}</b>
                </>
              )}
            </p>
          </Link>
        ))}

        {!isLoading && vehicles.length === 0 && (
          <div className="rounded-card border-[1.5px] border-dashed border-line-strong bg-white p-12 text-center sm:col-span-2 xl:col-span-3">
            <div className="mx-auto mb-3.5 flex h-11 w-11 items-center justify-center rounded-[11px] bg-canvas text-muted">
              <CarIcon />
            </div>
            <p className="text-[15px] font-semibold text-ink-soft">
              {filtered ? 'Niciun vehicul găsit' : 'Niciun vehicul în stoc'}
            </p>
            <p className="mx-auto mt-1.5 mb-4 max-w-xs text-[13.5px] text-muted">
              {filtered
                ? 'Încearcă alt filtru sau termen de căutare.'
                : 'Adaugă primul tău vehicul pentru a începe urmărirea.'}
            </p>
            {!filtered && (
              <button
                onClick={() => setShowForm(true)}
                className="rounded-control bg-brand px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-hover"
              >
                + Adaugă vehicul
              </button>
            )}
          </div>
        )}
      </div>

      {showForm && <NewVehicleModal onClose={() => setShowForm(false)} />}
    </div>
  );
}

function NewVehicleModal({ onClose }: { onClose: () => void }) {
  const [create, { isLoading }] = useCreateVehicleMutation();
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    vin: '', make: '', model: '', year: new Date().getFullYear(),
    mileageKm: '', purchasePrice: '', purchaseCurrency: 'EUR', originCountry: 'DE',
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await create({
        ...form,
        year: Number(form.year),
        mileageKm: form.mileageKm ? Number(form.mileageKm) : undefined,
        purchasePrice: Number(form.purchasePrice),
      }).unwrap();
      onClose();
    } catch (err: any) {
      setError(err?.data?.message ?? 'Eroare la salvare');
    }
  };

  const field = 'w-full box-border rounded-control border border-line-strong px-3 py-2.5 text-sm focus:border-brand focus:outline-none';
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-[rgba(15,15,25,0.5)] p-0 sm:items-center sm:p-5" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-6 shadow-[0_20px_60px_-15px_rgba(20,20,40,0.4)] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-[18px] flex items-center justify-between">
          <h3 className="text-[17px] font-bold text-ink">Adaugă vehicul</h3>
          <button onClick={onClose} className="p-1 text-lg leading-none text-muted hover:text-ink">✕</button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input
            className={`${field} font-mono uppercase`}
            placeholder="VIN (17 caractere)"
            value={form.vin}
            onChange={(e) => setForm({ ...form, vin: e.target.value.toUpperCase() })}
            required
            minLength={11}
            maxLength={17}
          />
          <div className="grid grid-cols-2 gap-2.5">
            <input className={field} placeholder="Marcă" value={form.make} onChange={set('make')} required />
            <input className={field} placeholder="Model" value={form.model} onChange={set('model')} required />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <input className={field} type="number" placeholder="An fabricație" value={form.year} onChange={set('year')} required />
            <input className={field} type="number" placeholder="Kilometraj" value={form.mileageKm} onChange={set('mileageKm')} />
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <input className={`${field} col-span-2`} type="number" step="0.01" placeholder="Preț achiziție" value={form.purchasePrice} onChange={set('purchasePrice')} required />
            <select className={field} value={form.purchaseCurrency} onChange={set('purchaseCurrency')}>
              <option>EUR</option>
              <option>RON</option>
            </select>
          </div>
          <input className={field} placeholder="Țară origine (DE, FR, NL…)" value={form.originCountry} onChange={set('originCountry')} maxLength={2} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2.5 pt-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-control border border-line-strong py-2.5 text-sm font-semibold text-ink-soft">
              Anulează
            </button>
            <button disabled={isLoading} className="flex-1 rounded-control bg-brand py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50">
              Salvează
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
