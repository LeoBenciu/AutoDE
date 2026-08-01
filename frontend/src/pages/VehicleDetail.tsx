import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useAddCostMutation,
  useGenerateContractMutation,
  useLazyDownloadUrlQuery,
  usePartiesQuery,
  useRegenerateContractMutation,
  useUpdateVehicleMutation,
  useUploadDocumentsMutation,
  useVehicleQuery,
} from '../store/api';
import { StatusChip } from '../components/StatusChip';
import { VehicleBrandLogo } from '../components/VehicleBrandLogo';
import { VehicleStatusSelector } from '../components/VehicleStatusSelector';
import type { VehicleStatus } from '../data/vehicleStatuses';

const COST_CATEGORIES = ['TRANSPORT', 'CUSTOMS', 'VAT', 'ITP', 'REGISTRATION', 'REFURB', 'OTHER'];

export default function VehicleDetail() {
  const { id } = useParams();
  const vehicleId = Number(id);
  const { data: v, isLoading } = useVehicleQuery(vehicleId);
  const [updateVehicle] = useUpdateVehicleMutation();
  const [upload, { isLoading: uploading }] = useUploadDocumentsMutation();
  const [getDownloadUrl] = useLazyDownloadUrlQuery();
  const [openingDocumentId, setOpeningDocumentId] = useState<number>();
  const [documentOpenError, setDocumentOpenError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const openDocument = async (documentId: number) => {
    setDocumentOpenError('');

    // Open the tab during the click event. Waiting for the signed URL first
    // makes browsers treat window.open as an unsolicited popup and block it.
    const documentTab = window.open('about:blank', '_blank');
    if (!documentTab) {
      setDocumentOpenError('Browserul a blocat fila nouă. Permite ferestrele pop-up pentru această aplicație și încearcă din nou.');
      return;
    }
    setOpeningDocumentId(documentId);
    try {
      const { url } = await getDownloadUrl(documentId).unwrap();
      documentTab.location.replace(url);
    } catch (error: any) {
      documentTab.close();
      setDocumentOpenError(
        error?.data?.message ?? error?.message ?? 'PDF-ul nu a putut fi deschis.',
      );
    } finally {
      setOpeningDocumentId(undefined);
    }
  };

  if (isLoading || !v) return <p className="text-sm text-muted">Se încarcă…</p>;

  const fmt = (n: any, cur?: string) => (n != null ? `${Number(n).toLocaleString('ro-RO')} ${cur ?? ''}` : '—');

  // Dosarul mașinii — never starts at 0: the vehicle data itself is step 1.
  const documents = v.documents ?? [];
  const docTypes = new Set(documents.map((d: any) => d.type));
  const hasAcquisitionDocument = documents.some((document: any) =>
    document.type === 'Invoice' || isVehiclePurchaseContract(document),
  );
  const hasUit = (v.transports ?? []).some((t: any) => t.status === 'CONFIRMED') || docTypes.has('UIT');
  const dosar = [
    { label: 'Date vehicul', done: true },
    { label: 'Factură achiziție', done: hasAcquisitionDocument },
    { label: 'CMR', done: docTypes.has('CMR') },
    { label: 'Talon / certificat', done: docTypes.has('Vehicle Registration Certificate') },
    { label: 'Cod UIT', done: hasUit },
    { label: 'Contract vânzare', done: docTypes.has('Sale Contract') },
  ];
  const dosarDone = dosar.filter((s) => s.done).length;

  const marginPct =
    v.margin != null && v.computedLandedCost > 0 ? Math.round((v.margin / v.computedLandedCost) * 100) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <VehicleBrandLogo make={v.make} size="lg" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">
              {v.make} {v.model} {v.variant ?? ''}
            </h1>
            <p className="font-mono text-xs text-muted">{v.vin}</p>
          </div>
        </div>
        <VehicleStatusSelector
          status={v.status}
          onChange={async (status: VehicleStatus) => {
            await updateVehicle({
              id: vehicleId,
              body: { status },
            }).unwrap();
          }}
        />
      </div>

      {/* Dosarul mașinii — progress toward a complete file */}
      <div className="rounded-card border border-line bg-white p-4">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-ink">Dosarul mașinii</p>
          <p className="text-sm text-muted">{dosarDone}/{dosar.length} complete</p>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${(dosarDone / dosar.length) * 100}%` }}
          />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
          {dosar.map((s) => (
            <span key={s.label} className={`text-xs ${s.done ? 'text-muted-2 line-through' : 'font-medium text-amber-700'}`}>
              {s.done ? '✓' : '○'} {s.label}
            </span>
          ))}
        </div>
      </div>

      {/* Money summary */}
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <Stat label="Preț achiziție" value={fmt(v.purchasePrice, v.purchaseCurrency)} />
        <Stat label="Cost total (landed)" value={fmt(v.computedLandedCost, v.purchaseCurrency)} />
        <Stat label="Preț vânzare" value={fmt(v.soldPrice ?? v.listPrice, v.soldCurrency)} />
        <Stat
          label="Marjă"
          value={v.margin != null ? `${fmt(v.margin, v.soldCurrency)}${marginPct != null ? ` (${marginPct > 0 ? '+' : ''}${marginPct}%)` : ''}` : '—'}
          highlight={v.margin != null && v.margin > 0}
        />
      </div>

      <OriginalSellerSection vehicle={v} />

      {/* Documents */}
      <section className="rounded-card border border-line bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-ink">Documente ({v.documents?.length ?? 0})</h2>
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
              className="rounded-control bg-brand px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
            >
              {uploading ? 'Se încarcă…' : '📷 Încarcă'}
            </button>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          {(v.documents ?? []).map((d: any) => (
            <div key={d.id} className="flex items-center justify-between rounded-xl border border-line p-3">
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => openDocument(d.id)}
                  disabled={openingDocumentId === d.id}
                  className="block max-w-full truncate text-left text-sm font-medium text-brand hover:underline disabled:cursor-wait disabled:opacity-60"
                  aria-label={`Deschide ${d.name} într-o filă nouă`}
                >
                  {openingDocumentId === d.id ? 'Se deschide…' : d.name}
                </button>
                <p className="text-xs text-muted">{d.type ?? 'Necategorisit'}</p>
              </div>
              <div className="flex items-center gap-2">
                {d.needsReview && <NeedsReviewChip />}
                <StatusChip status={d.processingStatus} />
              </div>
            </div>
          ))}
          {(v.documents ?? []).length === 0 && <p className="text-sm text-muted">Niciun document — fotografiază factura, CMR-ul sau talonul.</p>}
          {documentOpenError && <p className="text-sm text-red-600">{documentOpenError}</p>}
        </div>
      </section>

      {/* Costs */}
      <CostsSection vehicle={v} vehicleId={vehicleId} />

      {/* Contract generation */}
      <ContractSection
        vehicleId={vehicleId}
        contracts={v.contracts ?? []}
        defaultPrice={v.soldPrice ?? v.listPrice ?? undefined}
        onOpenDocument={openDocument}
        openingDocumentId={openingDocumentId}
      />

      {/* e-Transport */}
      <section className="rounded-card border border-line bg-white p-4">
        <h2 className="font-semibold text-ink">e-Transport</h2>
        <div className="mt-3 space-y-2">
          {(v.transports ?? []).map((t: any) => (
            <div key={t.id} className="flex items-center justify-between rounded-xl border border-line p-3 text-sm">
              <span className="text-ink-soft">
                {t.uit ? <b className="font-mono text-ink">{t.uit}</b> : `Declarație #${t.id}`} · {t.vehiclePlate ?? '—'}
              </span>
              <StatusChip status={t.status} />
            </div>
          ))}
          {(v.transports ?? []).length === 0 && (
            <p className="text-sm text-muted">
              Nicio declarație. Generează codul UIT din pagina <b className="text-ink-soft">e-Transport</b> înainte ca mașina să intre în țară.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function isVehiclePurchaseContract(document: any): boolean {
  if (document.type !== 'Contract') return false;

  const storedFields = document.processedData?.extractedFields;
  const fields =
    storedFields?.result && typeof storedFields.result === 'object'
      ? storedFields.result
      : storedFields ?? {};
  const direction = String(fields.direction ?? '').toLowerCase();
  if (direction === 'outgoing') return false;
  if (String(fields.vehicle_transaction ?? '').toLowerCase() === 'purchase') {
    return true;
  }

  return (
    Boolean(fields.vin) &&
    /(vanzare|vânzare|sale|achiz)/i.test(String(fields.contract_type ?? ''))
  );
}

function OriginalSellerSection({ vehicle }: { vehicle: any }) {
  const { data: parties = [] } = usePartiesQuery();
  const [update, { isLoading }] = useUpdateVehicleMutation();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [sellerId, setSellerId] = useState(vehicle.sellerId ? String(vehicle.sellerId) : '');
  const [seller, setSeller] = useState({
    kind: 'INDIVIDUAL',
    name: '',
    taxId: '',
    country: vehicle.originCountry || 'DE',
  });
  const [message, setMessage] = useState('');

  useEffect(() => {
    setSellerId(vehicle.sellerId ? String(vehicle.sellerId) : '');
  }, [vehicle.sellerId]);

  const save = async () => {
    setMessage('');
    try {
      await update({
        id: vehicle.id,
        body:
          mode === 'existing'
            ? { sellerId: sellerId ? Number(sellerId) : null }
            : { seller },
      }).unwrap();
      setMessage('Vânzătorul inițial a fost salvat.');
      if (mode === 'new') setMode('existing');
    } catch (error: any) {
      setMessage(error?.data?.message ?? 'Vânzătorul nu a putut fi salvat');
    }
  };

  const field = 'rounded-control border border-line-strong px-2.5 py-2 text-sm focus:border-brand focus:outline-none';
  return (
    <section className="rounded-card border border-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-ink">Vânzător inițial</h2>
          <p className="text-xs text-muted">
            {vehicle.seller
              ? `${vehicle.seller.name} · ${vehicle.seller.identifierType === 'FOREIGN_ID' ? 'ID extern' : vehicle.seller.identifierType || (vehicle.seller.kind === 'INDIVIDUAL' ? 'CNP' : 'CUI')} ${vehicle.seller.taxId || '—'}`
              : 'Nu este selectat'}
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <button
            type="button"
            onClick={() => setMode('existing')}
            className={`rounded-control px-2.5 py-1.5 ${mode === 'existing' ? 'bg-brand text-white' : 'border border-line-strong text-ink-soft'}`}
          >
            Partener existent
          </button>
          <button
            type="button"
            onClick={() => setMode('new')}
            className={`rounded-control px-2.5 py-1.5 ${mode === 'new' ? 'bg-brand text-white' : 'border border-line-strong text-ink-soft'}`}
          >
            Identificator nou
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {mode === 'existing' ? (
          <select
            aria-label="Vânzător inițial"
            className={`${field} min-w-64 flex-1`}
            value={sellerId}
            onChange={(event) => setSellerId(event.target.value)}
          >
            <option value="">Fără vânzător inițial</option>
            {parties.map((party: any) => (
              <option key={party.id} value={party.id}>
                {party.name} · {party.identifierType === 'FOREIGN_ID' ? 'ID extern' : party.identifierType || (party.kind === 'INDIVIDUAL' ? 'CNP' : 'CUI')} {party.taxId || '—'}
              </option>
            ))}
          </select>
        ) : (
          <>
            <select
              aria-label="Tip vânzător"
              className={field}
              value={seller.kind}
              onChange={(event) => setSeller({ ...seller, kind: event.target.value })}
            >
              <option value="INDIVIDUAL">Persoană fizică</option>
              <option value="COMPANY">Companie</option>
            </select>
            <input
              aria-label="Nume vânzător"
              className={`${field} flex-1`}
              placeholder="Nume / denumire"
              value={seller.name}
              onChange={(event) => setSeller({ ...seller, name: event.target.value })}
            />
            <input
              aria-label={seller.kind === 'INDIVIDUAL' ? (seller.country === 'RO' ? 'CNP vânzător' : 'Identificator extern vânzător') : 'CUI vânzător'}
              className={field}
              placeholder={seller.kind === 'INDIVIDUAL' ? (seller.country === 'RO' ? 'CNP' : 'Identificator extern') : 'CUI / CIF'}
              value={seller.taxId}
              onChange={(event) => setSeller({ ...seller, taxId: event.target.value })}
            />
            <input
              aria-label="Țară vânzător"
              className={`${field} w-24`}
              placeholder="Țară"
              maxLength={2}
              value={seller.country}
              onChange={(event) =>
                setSeller({ ...seller, country: event.target.value.toUpperCase() })
              }
            />
          </>
        )}
        <button
          type="button"
          onClick={save}
          disabled={isLoading || (mode === 'new' && (!seller.name || !seller.taxId))}
          className="rounded-control bg-brand px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {isLoading ? 'Se salvează…' : 'Salvează'}
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-muted">{message}</p>}
    </section>
  );
}

function NeedsReviewChip() {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ backgroundColor: 'oklch(0.93 0.05 80)', color: 'oklch(0.45 0.13 80)' }}
    >
      De verificat
    </span>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-card border border-line bg-white p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-lg font-bold ${highlight ? 'text-emerald-600' : 'text-ink'}`}>{value}</p>
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
    <section className="rounded-card border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-ink">Costuri din documente</h2>
          <p className="mt-0.5 text-xs text-muted">
            Facturile și bonurile atașate vehiculului intră aici după aprobare și pot fi exportate în SAGA.
          </p>
        </div>
        <Link to="/documente" className="text-xs font-semibold text-brand hover:underline">
          Încarcă document contabil
        </Link>
      </div>
      <div className="mt-3 space-y-1">
        {(vehicle.costs ?? []).map((c: any) => {
          // Contrast effect: each cost is anchored against the purchase price.
          const pct = Number(vehicle.purchasePrice) > 0 ? (Number(c.amount) / Number(vehicle.purchasePrice)) * 100 : null;
          return (
            <div key={c.id} className="flex justify-between border-b border-line py-1.5 text-sm">
              <span className="text-muted">
                {c.category} {c.note ? `· ${c.note}` : ''}
                {c.autoGenerated && (
                  <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                    din document
                  </span>
                )}
              </span>
              <span className="font-medium text-ink">
                {Number(c.amount).toLocaleString('ro-RO')} {c.currency}
                {pct != null && <span className="ml-1 font-normal text-muted-2">({pct.toFixed(1).replace('.', ',')}%)</span>}
              </span>
            </div>
          );
        })}
      </div>
      <details className="mt-3 rounded-control border border-dashed border-line-strong p-2.5">
        <summary className="cursor-pointer text-xs font-semibold text-muted">
          Adaugă manual un cost excepțional
        </summary>
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="rounded-control border border-line-strong px-2.5 py-2 text-sm focus:border-brand focus:outline-none"
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
          className="w-28 rounded-control border border-line-strong px-2.5 py-2 text-sm focus:border-brand focus:outline-none"
        />
        <input
          placeholder="Notă"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          className="flex-1 rounded-control border border-line-strong px-2.5 py-2 text-sm focus:border-brand focus:outline-none"
        />
        <button className="rounded-control bg-brand px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-hover">Adaugă</button>
      </form>
      </details>
    </section>
  );
}

function ContractSection({
  vehicleId,
  contracts,
  defaultPrice,
  onOpenDocument,
  openingDocumentId,
}: {
  vehicleId: number;
  contracts: any[];
  defaultPrice?: number;
  onOpenDocument: (documentId: number) => void;
  openingDocumentId?: number;
}) {
  const { data: parties = [] } = usePartiesQuery();
  const [generate, { isLoading }] = useGenerateContractMutation();
  const [regenerate] = useRegenerateContractMutation();
  const [regeneratingId, setRegeneratingId] = useState<number>();
  const [buyerId, setBuyerId] = useState('');
  // Smart default: the vehicle's sale/list price is pre-filled, adjust if needed.
  const [price, setPrice] = useState(defaultPrice != null ? String(defaultPrice) : '');
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
    <section className="rounded-card border border-line bg-white p-4">
      <h2 className="font-semibold text-ink">Contracte</h2>
      <div className="mt-2 space-y-1">
        {contracts.map((c: any) => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={() => onOpenDocument(c.documentId)}
              disabled={!c.documentId || openingDocumentId === c.documentId}
              className="text-left text-sm text-brand hover:underline disabled:cursor-wait disabled:text-muted disabled:no-underline"
              aria-label={`Deschide ${c.contractType === 'proces-verbal' ? 'procesul-verbal' : 'contractul'} ${c.contractNumber} într-o filă nouă`}
            >
              {c.contractNumber} · {c.contractType} · {c.totalValue ? `${Number(c.totalValue).toLocaleString('ro-RO')} ${c.currency}` : ''}
            </button>
            <button
              type="button"
              disabled={!c.documentId || regeneratingId === c.id}
              onClick={async () => {
                setMessage('');
                setRegeneratingId(c.id);
                try {
                  await regenerate(c.id).unwrap();
                  setMessage(`${c.contractNumber} a fost regenerat cu șablonul curent.`);
                } catch (error: any) {
                  setMessage(error?.data?.message ?? 'PDF-ul nu a putut fi regenerat');
                } finally {
                  setRegeneratingId(undefined);
                }
              }}
              className="text-xs font-semibold text-muted hover:text-brand disabled:cursor-wait disabled:opacity-50"
              aria-label={`Regenerează PDF ${c.contractNumber}`}
            >
              {regeneratingId === c.id ? 'Se regenerează…' : 'Regenerează PDF'}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} className="rounded-control border border-line-strong px-2.5 py-2 text-sm focus:border-brand focus:outline-none">
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
          className="w-32 rounded-control border border-line-strong px-2.5 py-2 text-sm focus:border-brand focus:outline-none"
        />
        <button
          onClick={() => submit('vanzare-cumparare')}
          disabled={isLoading}
          className="rounded-control bg-brand px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
        >
          Contract vânzare
        </button>
        <button
          onClick={() => submit('proces-verbal')}
          disabled={isLoading}
          className="rounded-control border border-line-strong px-3.5 py-2 text-sm font-semibold text-ink-soft disabled:opacity-50"
        >
          Proces-verbal
        </button>
      </div>
      {message && <p className="mt-2 text-sm text-muted">{message}</p>}
    </section>
  );
}
