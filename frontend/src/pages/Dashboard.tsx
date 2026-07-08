import { Link } from 'react-router-dom';
import { useDocumentsQuery, usePayablesQuery, useVehiclesQuery } from '../store/api';
import { StatusChip } from '../components/StatusChip';

export default function Dashboard() {
  const { data: vehicles = [] } = useVehiclesQuery();
  const { data: payables = [] } = usePayablesQuery();
  const { data: docs } = useDocumentsQuery({ needsReview: true });

  const inStock = vehicles.filter((v) => v.status === 'IN_STOCK').length;
  const inTransit = vehicles.filter((v) => ['PURCHASED', 'IN_TRANSIT', 'CUSTOMS'].includes(v.status)).length;
  const duePayables = payables.filter((p) => ['DRAFT', 'APPROVED'].includes(p.status));
  const needsReview = docs?.documents?.length ?? 0;

  const cards = [
    { label: 'În stoc', value: inStock, to: '/vehicule' },
    { label: 'În tranzit', value: inTransit, to: '/vehicule' },
    { label: 'Plăți de făcut', value: duePayables.length, to: '/plati' },
    { label: 'Documente de verificat', value: needsReview, to: '/documente' },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Bună ziua 👋</h1>
      <p className="mt-1 text-sm text-slate-500">Situația afacerii tale pe scurt.</p>

      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.label} to={c.to} className="rounded-xl bg-white p-4 shadow-sm transition hover:shadow-md">
            <p className="text-3xl font-bold text-slate-900">{c.value}</p>
            <p className="mt-1 text-sm text-slate-500">{c.label}</p>
          </Link>
        ))}
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
