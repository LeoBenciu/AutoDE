import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLedgerQuery } from '../store/api';

const currentMonth = () => {
  const today = new Date().toISOString().slice(0, 10);
  return { from: `${today.slice(0, 8)}01`, to: today };
};

export default function Journal() {
  const initial = useMemo(currentMonth, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [accountCode, setAccountCode] = useState('');
  const { data, isLoading, error } = useLedgerQuery({
    from,
    to,
    ...(accountCode ? { accountCode } : {}),
    size: 200,
  });
  const entries = data?.entries ?? [];
  const debit = entries.reduce((sum: number, entry: any) => sum + Number(entry.debit), 0);
  const credit = entries.reduce((sum: number, entry: any) => sum + Number(entry.credit), 0);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Jurnal contabil</h1>
          <p className="mt-1.5 text-sm text-muted">
            Notele generate numai după aprobarea documentelor. Jurnalul este disponibil doar pentru consultare.
          </p>
        </div>
        <Link
          to="/exporturi"
          className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover"
        >
          Exportă în SAGA
        </Link>
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-2.5 rounded-card border border-line bg-white p-4">
        <DateInput label="De la" value={from} onChange={setFrom} />
        <DateInput label="Până la" value={to} onChange={setTo} />
        <label className="text-xs font-medium text-muted">
          Cont
          <input
            value={accountCode}
            onChange={(event) => setAccountCode(event.target.value)}
            placeholder="ex. 401, 5311"
            className="mt-1 block rounded-control border border-line-strong px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
          />
        </label>
        <div className="ml-auto flex gap-6 rounded-xl bg-slate-50 px-4 py-2.5 text-sm">
          <span><span className="text-muted">Debit</span> <b>{amount(debit)}</b></span>
          <span><span className="text-muted">Credit</span> <b>{amount(credit)}</b></span>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-card border border-line bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Data</th>
                <th className="px-4 py-3 font-semibold">Document</th>
                <th className="px-4 py-3 font-semibold">Tip sursă</th>
                <th className="px-4 py-3 font-semibold">Cont</th>
                <th className="px-4 py-3 font-semibold">Explicație</th>
                <th className="px-4 py-3 text-right font-semibold">Debit</th>
                <th className="px-4 py-3 text-right font-semibold">Credit</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry: any) => (
                <tr key={entry.id} className="border-t border-line">
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{date(entry.postingDate)}</td>
                  <td className="max-w-52 truncate px-4 py-3 font-medium text-ink">
                    {entry.document?.name ?? entry.reference ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">{sourceLabel(entry.sourceType)}</td>
                  <td className="px-4 py-3 font-bold text-ink">{entry.accountCode}</td>
                  <td className="max-w-64 truncate px-4 py-3 text-muted">{entry.description || '—'}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink">{cellAmount(entry.debit)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink">{cellAmount(entry.credit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isLoading && <p className="p-8 text-center text-sm text-muted">Se încarcă jurnalul…</p>}
        {!isLoading && entries.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">Nu există note contabile în perioada selectată.</p>
        )}
        {error && <p className="p-8 text-center text-sm text-red-600">Jurnalul nu a putut fi încărcat.</p>}
      </div>
      {data?.total > entries.length && (
        <p className="mt-2 text-right text-xs text-muted">
          Sunt afișate primele {entries.length} din {data.total} poziții.
        </p>
      )}
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-medium text-muted">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block rounded-control border border-line-strong px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
      />
    </label>
  );
}

function amount(value: number): string {
  return value.toLocaleString('ro-RO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function cellAmount(value: unknown): string {
  const numeric = Number(value);
  return numeric ? amount(numeric) : '—';
}

function date(value: string): string {
  return new Date(value).toLocaleDateString('ro-RO');
}

function sourceLabel(value: string): string {
  const labels: Record<string, string> = {
    INVOICE_IN: 'Factură intrare',
    INVOICE_OUT: 'Factură ieșire',
    RECEIPT: 'Chitanță',
    RECEIPT_IN: 'Plată chitanță',
    RECEIPT_OUT: 'Încasare chitanță',
    PAYMENT_DISPOSITION: 'Dispoziție plată',
    COLLECTION_DISPOSITION: 'Dispoziție încasare',
  };
  return labels[value] ?? value;
}
