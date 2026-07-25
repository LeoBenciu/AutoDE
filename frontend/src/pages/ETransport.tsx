import { FormEvent, useState } from 'react';
import {
  useCreateEtransportMutation,
  useEtransportQuery,
  useLazyEtransportPrefillQuery,
  useSubmitEtransportMutation,
  useUpdateEtransportMutation,
  useVehiclesQuery,
} from '../store/api';
import { StatusChip } from '../components/StatusChip';

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const TruckIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 17h9V7H3zM12 10h4l3 3v4h-7z" />
    <circle cx="7" cy="19" r="1.6" />
    <circle cx="17" cy="19" r="1.6" />
  </svg>
);

function TruckTile() {
  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
      style={{ backgroundColor: 'oklch(0.95 0.006 260)', color: 'oklch(0.45 0.01 260)' }}
    >
      <TruckIcon size={15} />
    </div>
  );
}

export default function ETransport() {
  const { data: declarations = [] } = useEtransportQuery();
  const [submitDecl] = useSubmitEtransportMutation();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState('');

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-ink">e-Transport</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover"
        >
          <PlusIcon />
          Generează cod UIT
        </button>
      </div>
      <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-muted">
        Transportul internațional al mașinilor spre România se declară la ANAF <b className="text-ink-soft">înainte</b> de plecare —
        lipsa codului UIT la control înseamnă <b className="text-red-600">amendă și confiscarea contravalorii mărfii</b>.
        Șoferul trebuie să aibă codul UIT asupra lui.
      </p>
      {error && <p className="mt-3 rounded-control bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-5 space-y-2">
        {declarations.map((d: any) => {
          // Loss framing: an expiring UIT is an actionable risk, show the countdown.
          const daysLeft =
            d.status === 'CONFIRMED' && d.validUntil
              ? Math.ceil((new Date(d.validUntil).getTime() - Date.now()) / (24 * 3600 * 1000))
              : null;
          return (
          <div key={d.id} className="rounded-card border border-line bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-3">
                <TruckTile />
                <div>
                  <p className={`text-[14.5px] font-semibold text-ink ${d.uit ? 'font-mono' : ''}`}>
                    {d.uit ? d.uit : `Declarație #${d.id}`}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-muted">
                    {d.vehicle ? `${d.vehicle.make} ${d.vehicle.model} · ` : ''}
                    {d.vehiclePlate ?? 'fără nr. camion'} · {d.operationType}
                    {daysLeft != null && daysLeft >= 0 && (
                      <span className={daysLeft <= 2 ? 'ml-1 font-semibold text-red-600' : 'ml-1 text-muted'}>
                        · UIT expiră în {daysLeft === 0 ? 'sub 24h' : `${daysLeft} zile`}
                      </span>
                    )}
                    {daysLeft != null && daysLeft < 0 && (
                      <span className="ml-1 font-semibold text-red-600">· UIT expirat</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusChip status={d.status} />
                {d.status !== 'SUBMITTED' && (
                  <button
                    onClick={() => setEditing(d)}
                    className="rounded-lg border border-line-strong bg-white px-3.5 py-2 text-[13px] text-ink-soft"
                    title="Modificarea regenerează codul UIT"
                  >
                    Modifică
                  </button>
                )}
                {(d.status === 'DRAFT' || d.status === 'REJECTED') && (
                  <button
                    onClick={async () => {
                      setError('');
                      try {
                        await submitDecl(d.id).unwrap();
                      } catch (err: any) {
                        setError(err?.data?.message ?? 'Eroare la trimitere');
                      }
                    }}
                    className="rounded-lg bg-sidebar px-3.5 py-2 text-[13px] font-semibold text-white"
                  >
                    Trimite la ANAF
                  </button>
                )}
                {d.uit && (
                  <a
                    href={`/api/etransport/${d.id}/uit-sheet`}
                    className="rounded-lg border border-line-strong bg-white px-3.5 py-2 text-[13px] text-ink-soft"
                  >
                    Fișă UIT
                  </a>
                )}
              </div>
            </div>
          </div>
          );
        })}
        {declarations.length === 0 && (
          <div className="rounded-card border-[1.5px] border-dashed border-line-strong bg-white p-12 text-center">
            <div className="mx-auto mb-3.5 flex h-11 w-11 items-center justify-center rounded-[11px] bg-canvas text-muted">
              <TruckIcon />
            </div>
            <p className="text-[15px] font-semibold text-ink-soft">Nicio declarație încă</p>
            <p className="mx-auto mt-1.5 mb-4 max-w-xs text-[13.5px] text-muted">
              Generează un cod UIT înainte de plecarea transportului.
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="rounded-control bg-brand px-4 py-2.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-hover"
            >
              + Generează cod UIT
            </button>
          </div>
        )}
      </div>

      {showForm && <NewDeclarationModal onClose={() => setShowForm(false)} />}
      {editing && <NewDeclarationModal declaration={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function NewDeclarationModal({ declaration, onClose }: { declaration?: any; onClose: () => void }) {
  const { data: vehicles = [] } = useVehiclesQuery();
  const [prefill] = useLazyEtransportPrefillQuery();
  const [create, { isLoading: creating }] = useCreateEtransportMutation();
  const [update, { isLoading: updating }] = useUpdateEtransportMutation();
  const isLoading = creating || updating;
  const [error, setError] = useState('');
  const [form, setForm] = useState(() =>
    declaration
      ? {
          vehicleId: declaration.vehicleId ? String(declaration.vehicleId) : '',
          transporterName: declaration.transporter?.name ?? '',
          transporterTaxId: declaration.transporter?.taxId ?? '',
          transporterCountry: declaration.transporter?.country ?? 'DE',
          vehiclePlate: declaration.vehiclePlate ?? '',
          trailerPlate: declaration.trailerPlate ?? '',
          loadingCity: declaration.loadingPlace?.city ?? '',
          loadingCountry: declaration.loadingPlace?.country ?? 'DE',
          unloadingCity: declaration.unloadingPlace?.city ?? '',
          unloadingCounty: declaration.unloadingPlace?.county ?? '',
          goodsDescription: declaration.goods?.[0]?.description ?? '',
          valueRon: declaration.goods?.[0]?.valueRon != null ? String(declaration.goods[0].valueRon) : '',
        }
      : {
          vehicleId: '',
          transporterName: '',
          transporterTaxId: '',
          transporterCountry: 'DE',
          vehiclePlate: '',
          trailerPlate: '',
          loadingCity: '',
          loadingCountry: 'DE',
          unloadingCity: '',
          unloadingCounty: '',
          goodsDescription: '',
          valueRon: '',
        },
  );

  const onVehicleChange = async (vehicleId: string) => {
    setForm((f) => ({ ...f, vehicleId }));
    if (!vehicleId) return;
    // Pre-fill from extracted CMR / invoice data
    try {
      const p = await prefill(Number(vehicleId)).unwrap();
      setForm((f) => ({
        ...f,
        vehicleId,
        transporterName: p.transporter?.name ?? f.transporterName,
        transporterTaxId: p.transporter?.taxId ?? f.transporterTaxId,
        transporterCountry: p.transporter?.country ?? f.transporterCountry,
        vehiclePlate: p.vehiclePlate ?? f.vehiclePlate,
        trailerPlate: p.trailerPlate ?? f.trailerPlate,
        loadingCity: p.loadingPlace?.city ?? f.loadingCity,
        loadingCountry: p.loadingPlace?.country ?? f.loadingCountry,
        unloadingCity: p.unloadingPlace?.city ?? f.unloadingCity,
        goodsDescription: p.goods?.[0]?.description ?? f.goodsDescription,
        valueRon: p.goods?.[0]?.valueRon != null ? String(p.goods[0].valueRon) : f.valueRon,
      }));
    } catch {
      /* prefill is best-effort */
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = {
      vehicleId: form.vehicleId ? Number(form.vehicleId) : undefined,
      operationType: 'AIC',
      transporter: { name: form.transporterName, taxId: form.transporterTaxId, country: form.transporterCountry },
      vehiclePlate: form.vehiclePlate,
      trailerPlate: form.trailerPlate || undefined,
      loadingPlace: { country: form.loadingCountry, city: form.loadingCity },
      unloadingPlace: { country: 'RO', county: form.unloadingCounty, city: form.unloadingCity },
      goods: [
        {
          description: form.goodsDescription || 'Autoturism second-hand',
          tariffCode: '8703',
          weightKg: 1500,
          valueRon: form.valueRon ? Number(form.valueRon) : undefined,
        },
      ],
    };
    try {
      if (declaration) await update({ id: declaration.id, body }).unwrap();
      else await create(body).unwrap();
      onClose();
    } catch (err: any) {
      setError(err?.data?.message ?? 'Eroare la salvare');
    }
  };

  const field = 'w-full box-border rounded-control border border-line-strong px-3 py-2.5 text-sm focus:border-brand focus:outline-none';
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center overflow-y-auto bg-[rgba(15,15,25,0.5)] sm:items-center sm:p-5" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-6 shadow-[0_20px_60px_-15px_rgba(20,20,40,0.4)] sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-bold text-ink">
            {declaration ? `Modifică declarația #${declaration.id}` : 'Declarație e-Transport nouă'}
          </h2>
          <button onClick={onClose} className="p-1 text-lg leading-none text-muted hover:text-ink">✕</button>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          {declaration
            ? declaration.uit
              ? `Atenție: modificarea invalidează codul UIT ${declaration.uit} — după salvare declarația revine în ciornă și trebuie retrimisă la ANAF pentru un cod nou.`
              : 'După salvare, declarația revine în ciornă și poate fi retrimisă la ANAF.'
            : 'Datele se pre-completează din CMR-ul și factura extrase pentru vehiculul ales.'}
        </p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <select className={field} value={form.vehicleId} onChange={(e) => onVehicleChange(e.target.value)}>
            <option value="">Vehicul (opțional, pentru pre-completare)…</option>
            {vehicles.map((v: any) => (
              <option key={v.id} value={v.id}>
                {v.make} {v.model} · {v.vin}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2.5">
            <input className={field} placeholder="Transportator" value={form.transporterName} onChange={set('transporterName')} required />
            <input className={field} placeholder="Cod fiscal transportator" value={form.transporterTaxId} onChange={set('transporterTaxId')} required />
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <input className={field} placeholder="Țară" value={form.transporterCountry} onChange={set('transporterCountry')} maxLength={2} />
            <input className={field} placeholder="Nr. camion" value={form.vehiclePlate} onChange={set('vehiclePlate')} required />
            <input className={field} placeholder="Nr. remorcă" value={form.trailerPlate} onChange={set('trailerPlate')} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <input className={field} placeholder="Loc încărcare (oraș)" value={form.loadingCity} onChange={set('loadingCity')} />
            <input className={field} placeholder="Țară încărcare" value={form.loadingCountry} onChange={set('loadingCountry')} maxLength={2} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <input className={field} placeholder="Loc descărcare (oraș, RO)" value={form.unloadingCity} onChange={set('unloadingCity')} />
            <input className={field} placeholder="Județ descărcare" value={form.unloadingCounty} onChange={set('unloadingCounty')} />
          </div>
          <input className={field} placeholder="Descriere marfă" value={form.goodsDescription} onChange={set('goodsDescription')} />
          <input className={field} type="number" step="0.01" placeholder="Valoare (RON, fără TVA)" value={form.valueRon} onChange={set('valueRon')} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2.5 pt-1">
            <button type="button" onClick={onClose} className="flex-1 rounded-control border border-line-strong py-2.5 text-sm font-semibold text-ink-soft">Anulează</button>
            <button disabled={isLoading} className="flex-1 rounded-control bg-brand py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50">
              {declaration ? 'Salvează → regenerează UIT' : 'Salvează ciorna →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
