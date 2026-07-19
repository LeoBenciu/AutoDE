const STYLES: Record<string, string> = {
  SOURCED: 'bg-slate-100 text-slate-700',
  PURCHASED: 'bg-blue-100 text-blue-700',
  IN_TRANSIT: 'bg-amber-100 text-amber-700',
  CUSTOMS: 'bg-orange-100 text-orange-700',
  IN_STOCK: 'bg-emerald-100 text-emerald-700',
  RESERVED: 'bg-purple-100 text-purple-700',
  SOLD: 'bg-green-100 text-green-800',
  DELIVERED: 'bg-slate-200 text-slate-600',
  DRAFT: 'bg-slate-100 text-slate-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  SUBMITTED: 'bg-amber-100 text-amber-700',
  FAILED: 'bg-red-100 text-red-700',
  REJECTED: 'bg-red-100 text-red-700',
  CONFIRMED: 'bg-emerald-100 text-emerald-700',
  VALIDATED: 'bg-blue-100 text-blue-700',
  EXPIRED: 'bg-slate-200 text-slate-600',
  PENDING: 'bg-slate-100 text-slate-600',
  PROCESSING: 'bg-amber-100 text-amber-700',
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  UPLOADED: 'bg-slate-100 text-slate-600',
  ERROR: 'bg-red-100 text-red-700',
};

const LABELS: Record<string, string> = {
  SOURCED: 'Identificat',
  PURCHASED: 'Cumpărat',
  IN_TRANSIT: 'În tranzit',
  CUSTOMS: 'În vamă',
  IN_STOCK: 'În stoc',
  RESERVED: 'Rezervat',
  SOLD: 'Vândut',
  DELIVERED: 'Livrat',
  DRAFT: 'Ciornă',
  APPROVED: 'Aprobat',
  SUBMITTED: 'Trimis',
  FAILED: 'Eșuat',
  REJECTED: 'Respins',
  CONFIRMED: 'Confirmat',
  VALIDATED: 'Validat',
  EXPIRED: 'Expirat',
  PENDING: 'În așteptare',
  PROCESSING: 'Se procesează',
  COMPLETED: 'Procesat',
  UPLOADED: 'Încărcat',
  ERROR: 'Eroare',
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {LABELS[status] ?? status}
    </span>
  );
}
