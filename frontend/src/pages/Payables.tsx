import { useState } from 'react';
import { useSelector } from 'react-redux';
import { useApprovePayableMutation, usePayablesQuery, useSubmitPayableMutation } from '../store/api';
import { StatusChip } from '../components/StatusChip';
import type { RootState } from '../store/store';

export default function Payables() {
  const { data: payables = [], isLoading } = usePayablesQuery();
  const [approve] = useApprovePayableMutation();
  const [submit] = useSubmitPayableMutation();
  const role = useSelector((s: RootState) => s.auth.user?.role);
  const canApprove = role === 'OWNER' || role === 'MANAGER';
  const [error, setError] = useState('');

  const act = async (fn: () => Promise<any>) => {
    setError('');
    try {
      await fn();
    } catch (err: any) {
      setError(err?.data?.message ?? 'Eroare');
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Plăți</h1>
      <p className="mt-1 text-sm text-slate-500">
        Inbox-ul de plăți — create automat din facturile extrase sau manual. Aprobarea este permisă doar
        rolurilor OWNER/MANAGER.
      </p>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}

      <div className="mt-4 space-y-2">
        {payables.map((p: any) => (
          <div key={p.id} className="rounded-xl bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-slate-900">{p.payeeName}</p>
                <p className="text-xs text-slate-500">
                  {p.reference ?? '—'} · scadență {p.dueDate ? new Date(p.dueDate).toLocaleDateString('ro-RO') : '—'}
                  {p.sourceDocument ? ` · din ${p.sourceDocument.name}` : ''}
                </p>
                {p.iban && <p className="font-mono text-xs text-slate-400">{p.iban}</p>}
              </div>
              <div className="flex items-center gap-3">
                <p className="text-lg font-bold text-slate-900">
                  {Number(p.amount).toLocaleString('ro-RO')} {p.currency}
                </p>
                <StatusChip status={p.status} />
              </div>
            </div>
            {canApprove && (
              <div className="mt-3 flex gap-2">
                {p.status === 'DRAFT' && (
                  <button
                    onClick={() => act(() => approve(p.id).unwrap())}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white"
                  >
                    Aprobă
                  </button>
                )}
                {p.status === 'APPROVED' && (
                  <button
                    onClick={() => act(() => submit(p.id).unwrap())}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white"
                  >
                    Plătește (SCA la bancă)
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {!isLoading && payables.length === 0 && (
          <p className="rounded-xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
            Nicio plată. Deschide o factură extrasă din Documente și apasă „Creează plată”.
          </p>
        )}
      </div>
    </div>
  );
}
