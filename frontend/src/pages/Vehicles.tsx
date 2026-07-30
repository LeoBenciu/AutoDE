import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCreateVehicleMutation,
  usePartiesQuery,
  useVehiclesQuery,
} from '../store/api';
import { StatusChip } from '../components/StatusChip';
import { VehicleBrandLogo } from '../components/VehicleBrandLogo';
import {
  modelsForBrand,
  VEHICLE_BRANDS,
  VEHICLE_COUNTRIES,
} from '../data/vehicleCatalog';

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
        <div className="flex items-center gap-2">
          <Link
            to="/documente"
            className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover"
          >
            Încarcă factură / contract
          </Link>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 rounded-control border border-line-strong px-4 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:bg-surface"
          >
            <PlusIcon />
            Adaugă manual
          </button>
        </div>
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
            className="rounded-card border border-line bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <VehicleBrandLogo make={v.make} />
                <p className="truncate text-[15px] font-semibold text-ink">
                  {v.make} {v.model}
                </p>
              </div>
              <StatusChip status={v.status} />
            </div>
            <p className="mt-3 text-[12.5px] text-muted">
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
                : 'Încarcă factura sau contractul de achiziție; vehiculul va fi creat după ce verifici și aprobi datele extrase.'}
            </p>
            {!filtered && (
              <Link
                to="/documente"
                className="rounded-control bg-brand px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-hover"
              >
                Încarcă documentul de achiziție
              </Link>
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
  const { data: parties = [] } = usePartiesQuery();
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    vin: '', make: '', model: '', year: new Date().getFullYear(),
    mileageKm: '', purchasePrice: '', purchaseCurrency: 'EUR', originCountry: 'DE',
  });
  const [sellerMode, setSellerMode] = useState<'none' | 'existing' | 'new'>('none');
  const [sellerId, setSellerId] = useState('');
  const [seller, setSeller] = useState({
    kind: 'INDIVIDUAL',
    name: '',
    taxId: '',
    country: 'DE',
  });
  const availableModels = modelsForBrand(form.make);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await create({
        ...form,
        year: Number(form.year),
        mileageKm: form.mileageKm ? Number(form.mileageKm) : undefined,
        purchasePrice: Number(form.purchasePrice),
        ...(sellerMode === 'existing' && sellerId
          ? { sellerId: Number(sellerId) }
          : {}),
        ...(sellerMode === 'new' ? { seller } : {}),
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
      <div className="max-h-[94vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-6 shadow-[0_20px_60px_-15px_rgba(20,20,40,0.4)] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-[18px] flex items-center justify-between">
          <div>
            <h3 className="text-[17px] font-bold text-ink">Adaugă manual vehiculul</h3>
            <p className="mt-0.5 text-xs text-muted">
              Folosește această opțiune doar când nu ai un document de achiziție.
            </p>
          </div>
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
            <BrandSelector
              value={form.make}
              onChange={(make) => setForm({ ...form, make, model: '' })}
            />
            {form.make && availableModels.length === 0 ? (
              <input
                aria-label="Model"
                className={field}
                placeholder="Introdu modelul"
                value={form.model}
                onChange={set('model')}
                required
              />
            ) : (
              <select
                aria-label="Model"
                className={`${field} ${!form.make ? 'cursor-not-allowed bg-canvas text-muted-2' : ''}`}
                value={form.model}
                onChange={set('model')}
                disabled={!form.make}
                required
              >
                <option value="">{form.make ? 'Alege modelul' : 'Selectează marca întâi'}</option>
                {availableModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            )}
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
          <select
            aria-label="Țara de origine"
            className={field}
            value={form.originCountry}
            onChange={set('originCountry')}
            required
          >
            {VEHICLE_COUNTRIES.map((country) => (
              <option key={country.code} value={country.code}>
                {country.flag} {country.name} · {country.code}
              </option>
            ))}
          </select>
          <div className="rounded-xl border border-line bg-canvas p-3">
            <label className="text-xs font-semibold text-ink-soft">Vânzător inițial</label>
            <select
              aria-label="Mod selectare vânzător inițial"
              className={`${field} mt-1.5 bg-white`}
              value={sellerMode}
              onChange={(event) => setSellerMode(event.target.value as typeof sellerMode)}
            >
              <option value="none">Nespecificat</option>
              <option value="existing">Alege din parteneri</option>
              <option value="new">Adaugă după identificator</option>
            </select>
            {sellerMode === 'existing' && (
              <select
                aria-label="Vânzător inițial"
                className={`${field} mt-2 bg-white`}
                value={sellerId}
                onChange={(event) => setSellerId(event.target.value)}
                required
              >
                <option value="">Alege partenerul…</option>
                {parties.map((party: any) => (
                  <option key={party.id} value={party.id}>
                    {party.name} · {party.identifierType === 'FOREIGN_ID' ? 'ID extern' : party.identifierType || (party.kind === 'INDIVIDUAL' ? 'CNP' : 'CUI')} {party.taxId || '—'}
                  </option>
                ))}
              </select>
            )}
            {sellerMode === 'new' && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <select
                  aria-label="Tip vânzător"
                  className={`${field} bg-white`}
                  value={seller.kind}
                  onChange={(event) => setSeller({ ...seller, kind: event.target.value })}
                >
                  <option value="INDIVIDUAL">Persoană fizică</option>
                  <option value="COMPANY">Companie</option>
                </select>
                <input
                  aria-label="Nume vânzător"
                  className={field}
                  placeholder="Nume / denumire"
                  value={seller.name}
                  onChange={(event) => setSeller({ ...seller, name: event.target.value })}
                  required
                />
                <input
                  aria-label={seller.kind === 'INDIVIDUAL' ? (seller.country === 'RO' ? 'CNP vânzător' : 'Identificator extern vânzător') : 'CUI vânzător'}
                  className={field}
                  placeholder={seller.kind === 'INDIVIDUAL' ? (seller.country === 'RO' ? 'CNP' : 'Identificator extern') : 'CUI / CIF'}
                  value={seller.taxId}
                  onChange={(event) => setSeller({ ...seller, taxId: event.target.value })}
                  required
                />
                <input
                  aria-label="Țară vânzător"
                  className={field}
                  placeholder="Țară"
                  maxLength={2}
                  value={seller.country}
                  onChange={(event) => setSeller({ ...seller, country: event.target.value.toUpperCase() })}
                />
              </div>
            )}
            <p className="mt-2 text-xs text-muted">
              Dacă identificatorul există deja, partenerul este reutilizat; altfel este creat automat.
            </p>
          </div>
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

function BrandSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-label="Marcă"
        aria-controls="vehicle-brand-options"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-[42px] w-full items-center justify-between gap-2 rounded-control border border-line-strong bg-white px-2.5 py-1.5 text-left text-sm focus:border-brand focus:outline-none"
      >
        {value ? (
          <span className="flex min-w-0 items-center gap-2">
            <VehicleBrandLogo make={value} size="sm" />
            <span className="truncate text-ink">{value}</span>
          </span>
        ) : (
          <span className="text-muted">Alege marca</span>
        )}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          id="vehicle-brand-options"
          role="listbox"
          aria-label="Mărci auto"
          className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-72 min-w-full overflow-y-auto rounded-xl border border-line bg-white p-1.5 shadow-[0_18px_45px_-12px_rgba(20,20,40,0.3)]"
        >
          {VEHICLE_BRANDS.map((brand) => (
            <button
              key={brand.name}
              type="button"
              role="option"
              aria-selected={brand.name === value}
              onClick={() => {
                onChange(brand.name);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                brand.name === value ? 'bg-blue-50 font-semibold text-brand' : 'text-ink-soft hover:bg-surface'
              }`}
            >
              <VehicleBrandLogo make={brand.name} size="sm" />
              <span className="whitespace-nowrap">{brand.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
