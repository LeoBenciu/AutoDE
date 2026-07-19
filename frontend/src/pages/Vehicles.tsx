import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCreateVehicleMutation, useVehiclesQuery } from '../store/api';
import { StatusChip } from '../components/StatusChip';

const STATUSES = ['', 'SOURCED', 'PURCHASED', 'IN_TRANSIT', 'CUSTOMS', 'IN_STOCK', 'RESERVED', 'SOLD', 'DELIVERED'];

export default function Vehicles() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const { data: vehicles = [], isLoading } = useVehiclesQuery({ status: status || undefined, search: search || undefined });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Vehicule</h1>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          + Adaugă
        </button>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Caută VIN, marcă, model…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:max-w-xs"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === '' ? 'Toate statusurile' : s}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {vehicles.map((v) => (
          <Link key={v.id} to={`/vehicule/${v.id}`} className="rounded-xl bg-white p-4 shadow-sm transition hover:shadow-md">
            <div className="flex items-start justify-between">
              <p className="font-semibold text-slate-900">
                {v.make} {v.model}
              </p>
              <StatusChip status={v.status} />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {v.year} · {v.mileageKm ? `${Number(v.mileageKm).toLocaleString('ro-RO')} km` : 'km n/a'} · {v.originCountry}
            </p>
            <p className="mt-1 font-mono text-xs text-slate-400">{v.vin}</p>
            <p className="mt-2 text-sm text-slate-700">
              Achiziție: <b>{Number(v.purchasePrice).toLocaleString('ro-RO')} {v.purchaseCurrency}</b>
              {v.soldPrice && (
                <>
                  {' · '}Vândut: <b>{Number(v.soldPrice).toLocaleString('ro-RO')} {v.soldCurrency}</b>
                </>
              )}
            </p>
          </Link>
        ))}
      </div>
      {!isLoading && vehicles.length === 0 && (
        <p className="mt-8 rounded-xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm">Niciun vehicul găsit.</p>
      )}

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

  const field = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-900">Vehicul nou</h2>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <input
            className={`${field} font-mono uppercase`}
            placeholder="VIN (17 caractere)"
            value={form.vin}
            onChange={(e) => setForm({ ...form, vin: e.target.value.toUpperCase() })}
            required
            minLength={11}
            maxLength={17}
          />
          <div className="grid grid-cols-2 gap-3">
            <input className={field} placeholder="Marcă" value={form.make} onChange={set('make')} required />
            <input className={field} placeholder="Model" value={form.model} onChange={set('model')} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input className={field} type="number" placeholder="An" value={form.year} onChange={set('year')} required />
            <input className={field} type="number" placeholder="Kilometraj" value={form.mileageKm} onChange={set('mileageKm')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <input className={`${field} col-span-2`} type="number" step="0.01" placeholder="Preț achiziție" value={form.purchasePrice} onChange={set('purchasePrice')} required />
            <select className={field} value={form.purchaseCurrency} onChange={set('purchaseCurrency')}>
              <option>EUR</option>
              <option>RON</option>
            </select>
          </div>
          <input className={field} placeholder="Țara de origine (DE, FR, NL…)" value={form.originCountry} onChange={set('originCountry')} maxLength={2} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">
              Renunță
            </button>
            <button disabled={isLoading} className="flex-1 rounded-lg bg-slate-900 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Adaugă vehiculul →
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
