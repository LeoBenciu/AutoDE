import { FormEvent, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useAddCostMutation,
  useGenerateContractMutation,
  usePartiesQuery,
  useUpdateVehicleMutation,
  useUploadDocumentsMutation,
  useVehicleQuery,
} from '../store/api';
import { StatusChip } from '../components/StatusChip';

const STATUSES = ['SOURCED', 'PURCHASED', 'IN_TRANSIT', 'CUSTOMS', 'IN_STOCK', 'RESERVED', 'SOLD', 'DELIVERED'];
const COST_CATEGORIES = ['TRANSPORT', 'CUSTOMS', 'VAT', 'ITP', 'REGISTRATION', 'REFURB', 'OTHER'];

export default function VehicleDetail() {
  const { id } = useParams();
  const vehicleId = Number(id);
  const { data: v, isLoading } = useVehicleQuery(vehicleId);
  const [updateVehicle] = useUpdateVehicleMutation();
  const [upload, { isLoading: uploading }] = useUploadDocumentsMutation();
  const fileRef = useRef<HTMLInputElement>(null);

  if (isLoading || !v) return <p className="text-sm text-slate-500">Se încarcă…</p>;

  const fmt = (n: any, cur?: string) => (n != null ? `${Number(n).toLocaleString('ro-RO')} ${cur ?? ''}` : '—');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {v.make} {v.model} {v.variant ?? ''}
          </h1>
          <p className="font-mono text-xs text-slate-500">{v.vin}</p>
        </div>
        <select
          value={v.status}
          onChange={(e) => updateVehicle({ id: vehicleId, body: { status: e.target.value } })}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Money summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Preț achiziție" value={fmt(v.purchasePrice, v.purchaseCurrency)} />
        <Stat label="Cost total (landed)" value={fmt(v.computedLandedCost, v.purchaseCurrency)} />
        <Stat label="Preț vânzare" value={fmt(v.soldPrice ?? v.listPrice, v.soldCurrency)} />
        <Stat label="Marjă" value={v.margin != null ? fmt(v.margin, v.soldCurrency) : '—'} highlight={v.margin != null && v.margin > 0} />
      </div>

      {/* Documents */}
      <section className="rounded-xl bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">Documente ({v.documents?.length ?? 0})</h2>
          <div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="application/pdf,image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) upload({ files, vehicleId });
                e.target.value = '';
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {uploading ? 'Se încarcă…' : '📷 Încarcă'}
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {(v.documents ?? []).map((d: any) => (
            <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-100 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{d.name}</p>
                <p className="text-xs text-slate-500">{d.type ?? 'Necategorisit'}</p>
              </div>
              <div className="flex items-center gap-2">
                {d.needsReview && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">De verificat</span>}
                <StatusChip status={d.processingStatus} />
              </div>
            </div>
          ))}
          {(v.documents ?? []).length === 0 && <p className="text-sm text-slate-500">Niciun document — fotografiază factura, CMR-ul sau talonul.</p>}
        </div>
      </section>

      {/* Costs */}
      <CostsSection vehicle={v} vehicleId={vehicleId} />

      {/* Contract generation */}
      <ContractSection vehicleId={vehicleId} contracts={v.contracts ?? []} />

      {/* e-Transport */}
      <section className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="font-semibold text-slate-900">e-Transport</h2>
        <div className="mt-3 space-y-2">
          {(v.transports ?? []).map((t: any) => (
            <div key={t.id} className="flex items-center justify-between rounded-lg border border-slate-100 p-3 text-sm">
              <span>
                {t.uit ? <b className="font-mono">{t.uit}</b> : `Declarație #${t.id}`} · {t.vehiclePlate ?? '—'}
              </span>
              <StatusChip status={t.status} />
            </div>
          ))}
          {(v.transports ?? []).length === 0 && (
            <p className="text-sm text-slate-500">
              Nicio declarație. Generează codul UIT din pagina <b>e-Transport</b> înainte ca mașina să intre în țară.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${highlight ? 'text-emerald-600' : 'text-slate-900'}`}>{value}</p>
    </div>
  );
}

function CostsSection({ vehicle, vehicleId }: { vehicle: any; vehicleId: number }) {
  const [addCost] = useAddCostMutation();
  const [form, setForm] = useState({ category: 'TRANSPORT', amount: '', note: '' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.amount) return;
    await addCost({ id: vehicleId, body: { category: form.category, amount: Number(form.amount), note: form.note || undefined } });
    setForm({ category: 'TRANSPORT', amount: '', note: '' });
  };

  return (
    <section className="rounded-xl bg-white p-4 shadow-sm">
      <h2 className="font-semibold text-slate-900">Costuri</h2>
      <div className="mt-3 space-y-1">
        {(vehicle.costs ?? []).map((c: any) => (
          <div key={c.id} className="flex justify-between border-b border-slate-50 py-1.5 text-sm">
            <span className="text-slate-600">
              {c.category} {c.note ? `· ${c.note}` : ''}
            </span>
            <span className="font-medium">{Number(c.amount).toLocaleString('ro-RO')} {c.currency}</span>
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        >
          {COST_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input
          type="number"
          step="0.01"
          placeholder="Sumă"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          className="w-28 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          placeholder="Notă"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white">Adaugă</button>
      </form>
    </section>
  );
}

function ContractSection({ vehicleId, contracts }: { vehicleId: number; contracts: any[] }) {
  const { data: parties = [] } = usePartiesQuery();
  const [generate, { isLoading }] = useGenerateContractMutation();
  const [buyerId, setBuyerId] = useState('');
  const [price, setPrice] = useState('');
  const [message, setMessage] = useState('');

  const submit = async (kind: string) => {
    setMessage('');
    if (!buyerId) {
      setMessage('Alege cumpărătorul (adaugă-l întâi la Parteneri dacă lipsește).');
      return;
    }
    try {
      const res = await generate({
        vehicleId,
        buyerId: Number(buyerId),
        kind,
        price: price ? Number(price) : undefined,
      }).unwrap();
      setMessage(`Contract ${res.contract.contractNumber} generat și atașat la documente ✔`);
    } catch (err: any) {
      setMessage(err?.data?.message ?? 'Eroare la generare');
    }
  };

  return (
    <section className="rounded-xl bg-white p-4 shadow-sm">
      <h2 className="font-semibold text-slate-900">Contracte</h2>
      <div className="mt-2 space-y-1">
        {contracts.map((c: any) => (
          <p key={c.id} className="text-sm text-slate-600">
            {c.contractNumber} · {c.contractType} · {c.totalValue ? `${Number(c.totalValue).toLocaleString('ro-RO')} ${c.currency}` : ''}
          </p>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
          <option value="">Cumpărător…</option>
          {parties.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input
          type="number"
          step="0.01"
          placeholder="Preț (RON)"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          onClick={() => submit('vanzare-cumparare')}
          disabled={isLoading}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Contract vânzare
        </button>
        <button
          onClick={() => submit('proces-verbal')}
          disabled={isLoading}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
        >
          Proces-verbal
        </button>
      </div>
      {message && <p className="mt-2 text-sm text-slate-600">{message}</p>}
    </section>
  );
}
