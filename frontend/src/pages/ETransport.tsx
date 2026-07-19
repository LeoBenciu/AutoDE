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

export default function ETransport() {
  const { data: declarations = [] } = useEtransportQuery();
  const [submitDecl] = useSubmitEtransportMutation();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState('');

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">e-Transport</h1>
        <button
          onClick={() => setShowForm(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
        >
          + Generează cod UIT
        </button>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Transportul internațional al mașinilor spre România se declară la ANAF <b>înainte</b> de plecare —
        lipsa codului UIT la control înseamnă <b className="text-red-600">amendă și confiscarea contravalorii mărfii</b>.
        Șoferul trebuie să aibă codul UIT asupra lui.
      </p>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 space-y-2">
        {declarations.map((d: any) => {
          // Loss framing: an expiring UIT is an actionable risk, show the countdown.
          const daysLeft =
            d.status === 'CONFIRMED' && d.validUntil
              ? Math.ceil((new Date(d.validUntil).getTime() - Date.now()) / (24 * 3600 * 1000))
              : null;
          return (
          <div key={d.id} className="rounded-xl bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold text-slate-900">
                  {d.uit ? <span className="font-mono">{d.uit}</span> : `Declarație #${d.id}`}
                </p>
                <p className="text-xs text-slate-500">
                  {d.vehicle ? `${d.vehicle.make} ${d.vehicle.model} · ` : ''}
                  {d.vehiclePlate ?? 'fără nr. camion'} · {d.operationType}
                  {daysLeft != null && daysLeft >= 0 && (
                    <span className={daysLeft <= 2 ? 'ml-1 font-semibold text-red-600' : 'ml-1 text-slate-500'}>
                      · UIT expiră în {daysLeft === 0 ? 'sub 24h' : `${daysLeft} zile`}
                    </span>
                  )}
                  {daysLeft != null && daysLeft < 0 && (
                    <span className="ml-1 font-semibold text-red-600">· UIT expirat</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusChip status={d.status} />
                {d.status !== 'SUBMITTED' && (
                  <button
                    onClick={() => setEditing(d)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
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
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white"
                  >
                    Trimite la ANAF
                  </button>
                )}
                {d.uit && (
                  <a
                    href={`/api/etransport/${d.id}/uit-sheet`}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
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
          <p className="rounded-xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm">Nicio declarație încă.</p>
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

  const field = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center overflow-y-auto bg-black/40 sm:items-center" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-900">
          {declaration ? `Modifică declarația #${declaration.id}` : 'Declarație e-Transport nouă'}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
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
          <div className="grid grid-cols-2 gap-3">
            <input className={field} placeholder="Transportator" value={form.transporterName} onChange={set('transporterName')} required />
            <input className={field} placeholder="Cod fiscal transportator" value={form.transporterTaxId} onChange={set('transporterTaxId')} required />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <input className={field} placeholder="Țară" value={form.transporterCountry} onChange={set('transporterCountry')} maxLength={2} />
            <input className={field} placeholder="Nr. camion" value={form.vehiclePlate} onChange={set('vehiclePlate')} required />
            <input className={field} placeholder="Nr. remorcă" value={form.trailerPlate} onChange={set('trailerPlate')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input className={field} placeholder="Loc încărcare (oraș)" value={form.loadingCity} onChange={set('loadingCity')} />
            <input className={field} placeholder="Țară încărcare" value={form.loadingCountry} onChange={set('loadingCountry')} maxLength={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input className={field} placeholder="Loc descărcare (oraș, RO)" value={form.unloadingCity} onChange={set('unloadingCity')} />
            <input className={field} placeholder="Județ descărcare" value={form.unloadingCounty} onChange={set('unloadingCounty')} />
          </div>
          <input className={field} placeholder="Descriere marfă" value={form.goodsDescription} onChange={set('goodsDescription')} />
          <input className={field} type="number" step="0.01" placeholder="Valoare (RON, fără TVA)" value={form.valueRon} onChange={set('valueRon')} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm">Renunță</button>
            <button disabled={isLoading} className="flex-1 rounded-lg bg-slate-900 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {declaration ? 'Salvează → regenerează UIT' : 'Salvează ciorna →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
