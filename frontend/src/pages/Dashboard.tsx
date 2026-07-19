import { Link } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useContractsQuery, useDocumentsQuery, useEtransportQuery, useVehiclesQuery } from '../store/api';
import { StatusChip } from '../components/StatusChip';
import type { RootState } from '../store/store';

export default function Dashboard() {
  const me = useSelector((s: RootState) => s.auth.user);
  const { data: vehicles = [] } = useVehiclesQuery();
  const { data: docs } = useDocumentsQuery();
  const { data: contracts = [] } = useContractsQuery();
  const { data: declarations = [] } = useEtransportQuery();

  const documents = docs?.documents ?? [];
  const pending = docs?.pending ?? [];

  const inStock = vehicles.filter((v) => v.status === 'IN_STOCK').length;
  const inTransit = vehicles.filter((v) => ['PURCHASED', 'IN_TRANSIT', 'CUSTOMS'].includes(v.status)).length;
  const sold = vehicles.filter((v) => ['SOLD', 'DELIVERED'].includes(v.status)).length;
  const needsReview = documents.filter((d: any) => d.needsReview).length;

  const cards = [
    { label: 'În stoc', value: inStock, to: '/vehicule' },
    { label: 'În tranzit', value: inTransit, to: '/vehicule' },
    { label: 'Vândute', value: sold, to: '/vehicule' },
    { label: 'Documente de verificat', value: needsReview, to: '/documente' },
  ];

  // Situația documentelor
  const docsProcessing = pending.filter((p: any) => ['UPLOADED', 'PROCESSING'].includes(p.status)).length;
  const docsFailed = pending.filter((p: any) => p.status === 'ERROR').length;
  const docsByType = new Map<string, number>();
  for (const d of documents) docsByType.set(d.type ?? 'Necategorisit', (docsByType.get(d.type ?? 'Necategorisit') ?? 0) + 1);

  // Situația facturilor
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const invoices = documents.filter((d: any) => d.type === 'Invoice');
  const withDue = invoices
    .map((d: any) => ({ doc: d, due: d.processedData?.extractedFields?.due_date as string | undefined }))
    .filter((x: any) => x.due);
  const overdue = withDue.filter((x: any) => x.due < today);
  const dueSoon = withDue.filter((x: any) => x.due >= today && x.due <= soon);
  const totalsByCurrency = new Map<string, number>();
  for (const d of invoices) {
    const f = d.processedData?.extractedFields ?? {};
    if (f.total_amount != null) {
      const cur = String(f.currency ?? 'RON');
      totalsByCurrency.set(cur, (totalsByCurrency.get(cur) ?? 0) + Number(f.total_amount));
    }
  }

  // Loss framing: cars already on the road without a confirmed UIT are a fine
  // + confiscation risk — surface it before anything else.
  const confirmedVehicleIds = new Set(
    declarations.filter((d: any) => d.status === 'CONFIRMED' && d.vehicleId).map((d: any) => d.vehicleId),
  );
  const transitWithoutUit = vehicles.filter(
    (v) => ['IN_TRANSIT', 'CUSTOMS'].includes(v.status) && !confirmedVehicleIds.has(v.id),
  );

  // Goal gradient: the checklist never starts at 0 — the created account is step 1.
  const steps = [
    { label: 'Cont creat', done: true },
    { label: 'Primul vehicul adăugat', done: vehicles.length > 0, to: '/vehicule' },
    { label: 'Primul document încărcat', done: documents.length > 0 || pending.length > 0, to: '/documente' },
    { label: 'Primul contract generat', done: contracts.length > 0, to: '/vehicule' },
  ];
  const doneSteps = steps.filter((s) => s.done).length;
  const firstName = me?.name?.split(' ')[0];

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Bună{firstName ? `, ${firstName}` : ' ziua'} 👋</h1>
      <p className="mt-1 text-sm text-slate-500">Situația afacerii tale pe scurt.</p>

      {transitWithoutUit.length > 0 && (
        <Link
          to="/e-transport"
          className="mt-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-4 transition hover:bg-red-100"
        >
          <div>
            <p className="font-semibold text-red-700">
              ⚠ {transitWithoutUit.length === 1 ? 'O mașină este' : `${transitWithoutUit.length} mașini sunt`} în tranzit fără cod UIT confirmat
            </p>
            <p className="mt-0.5 text-sm text-red-600">
              Transportul fără UIT riscă amendă și confiscarea contravalorii mărfii la control.
            </p>
          </div>
          <span className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white">
            Generează acum →
          </span>
        </Link>
      )}

      {doneSteps < steps.length && (
        <div className="mt-4 rounded-xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-slate-900">Primii pași</p>
            <p className="text-sm text-slate-500">{Math.round((doneSteps / steps.length) * 100)}% configurat</p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${(doneSteps / steps.length) * 100}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {steps.map((s) =>
              s.done ? (
                <span key={s.label} className="text-sm text-slate-400 line-through">✓ {s.label}</span>
              ) : (
                <Link key={s.label} to={s.to ?? '/'} className="text-sm font-medium text-slate-700 hover:text-slate-900">
                  ○ {s.label} →
                </Link>
              ),
            )}
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.label} to={c.to} className="rounded-xl bg-white p-4 shadow-sm transition hover:shadow-md">
            <p className="text-3xl font-bold text-slate-900">{c.value}</p>
            <p className="mt-1 text-sm text-slate-500">{c.label}</p>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-3 lg:grid-cols-3">
        {/* Situația documentelor */}
        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="font-semibold text-slate-900">Situația documentelor</h2>
          <div className="mt-3 space-y-1.5 text-sm">
            <Row label="Procesate" value={documents.length} />
            <Row label="În procesare" value={docsProcessing} warn={docsProcessing > 0} />
            <Row label="Erori de procesare" value={docsFailed} danger={docsFailed > 0} />
            <Row label="Necesită verificare" value={needsReview} warn={needsReview > 0} />
          </div>
          {docsByType.size > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {[...docsByType.entries()].slice(0, 8).map(([type, count]) => (
                <span key={type} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {type}: {count}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Situația contractelor */}
        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="font-semibold text-slate-900">Situația contractelor</h2>
          <div className="mt-3 space-y-1.5 text-sm">
            <Row label="Total contracte" value={contracts.length} />
            <Row label="Vânzare-cumpărare" value={contracts.filter((c: any) => c.contractType === 'vanzare-cumparare').length} />
            <Row label="Procese-verbale" value={contracts.filter((c: any) => c.contractType === 'proces-verbal').length} />
          </div>
          <div className="mt-3 space-y-1">
            {contracts.slice(0, 3).map((c: any) => (
              <p key={c.id} className="truncate text-xs text-slate-500">
                {c.contractNumber} · {c.vehicle ? `${c.vehicle.make} ${c.vehicle.model}` : ''}
                {c.totalValue ? ` · ${Number(c.totalValue).toLocaleString('ro-RO')} ${c.currency}` : ''}
              </p>
            ))}
          </div>
        </section>

        {/* Situația facturilor */}
        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="font-semibold text-slate-900">Situația facturilor</h2>
          <div className="mt-3 space-y-1.5 text-sm">
            <Row label="Facturi procesate" value={invoices.length} />
            <Row label="Scadență depășită" value={overdue.length} danger={overdue.length > 0} />
            <Row label="Scadente în 7 zile" value={dueSoon.length} warn={dueSoon.length > 0} />
          </div>
          {totalsByCurrency.size > 0 && (
            <div className="mt-3 space-y-0.5">
              {[...totalsByCurrency.entries()].map(([cur, total]) => (
                <p key={cur} className="text-xs text-slate-500">
                  Total {cur}: <b className="text-slate-700">{total.toLocaleString('ro-RO', { maximumFractionDigits: 0 })}</b>
                </p>
              ))}
            </div>
          )}
        </section>
      </div>

      <h2 className="mt-8 text-lg font-semibold text-slate-900">Vehicule recente</h2>
      <div className="mt-3 space-y-2">
        {vehicles.slice(0, 6).map((v) => (
          <Link
            key={v.id}
            to={`/vehicule/${v.id}`}
            className="flex items-center justify-between rounded-xl bg-white p-4 shadow-sm transition hover:shadow-md"
          >
            <div>
              <p className="font-semibold text-slate-900">
                {v.make} {v.model} <span className="font-normal text-slate-400">({v.year})</span>
              </p>
              <p className="text-xs text-slate-500">{v.vin}</p>
            </div>
            <StatusChip status={v.status} />
          </Link>
        ))}
        {vehicles.length === 0 && (
          <p className="rounded-xl bg-white p-6 text-center text-sm text-slate-500 shadow-sm">
            Niciun vehicul încă — adaugă primul din pagina Vehicule.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, warn, danger }: { label: string; value: number; warn?: boolean; danger?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-600">{label}</span>
      <span className={`font-semibold ${danger && value > 0 ? 'text-red-600' : warn && value > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
        {value}
      </span>
    </div>
  );
}
