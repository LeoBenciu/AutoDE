import { useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  useArchiveDocumentMutation,
  useAssignDocumentMutation,
  useCorrectFieldMutation,
  useDocumentQuery,
  useDocumentsQuery,
  useLazyDownloadUrlQuery,
  useMarkReviewedMutation,
  usePartiesQuery,
  useUploadDocumentsMutation,
  useVehiclesQuery,
} from '../store/api';
import { StatusChip } from '../components/StatusChip';
import type { RootState } from '../store/store';

const DOC_TYPES = [
  'Invoice',
  'Receipt',
  'Bank Statement',
  'Contract',
  'CMR',
  'Customs Declaration',
  'Vehicle Registration Certificate',
  'Technical Inspection (ITP)',
  'Insurance',
  'Sale Contract',
  'Handover Protocol',
  'UIT',
  'Other',
];

export default function Documents() {
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [archived, setArchived] = useState(false);
  const { data, isLoading } = useDocumentsQuery(
    {
      ...(needsReviewOnly ? { needsReview: true } : {}),
      ...(search ? { search } : {}),
      ...(type ? { type } : {}),
      ...(archived ? { archived: true } : {}),
    },
    { pollingInterval: 8000 },
  );
  const [upload, { isLoading: uploading }] = useUploadDocumentsMutation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onFiles = (files: File[]) => {
    if (files.length) upload({ files });
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Documente</h1>
      </div>

      {/* Search & filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Caută după nume, tip, VIN, client…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:max-w-xs"
        />
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-2 text-sm">
          <option value="">Toate tipurile</option>
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={needsReviewOnly} onChange={(e) => setNeedsReviewOnly(e.target.checked)} />
          De verificat
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Arhivate
        </label>
      </div>

      {/* Drop zone / camera upload */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(Array.from(e.dataTransfer.files)); }}
        onClick={() => fileRef.current?.click()}
        className={`mt-4 cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
          dragging ? 'border-slate-900 bg-slate-50' : 'border-slate-300 bg-white'
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}
        />
        <p className="text-sm font-medium text-slate-700">
          {uploading ? 'Se încarcă…' : '📄 Trage fișierele aici sau apasă pentru a fotografia/alege'}
        </p>
        <p className="mt-1 text-xs text-slate-500">Facturi, CMR, declarații vamale, talon, ITP, extrase — PDF sau poze</p>
      </div>

      <SagaExport />

      {/* Processing queue */}
      {(data?.pending?.length ?? 0) > 0 && (
        <div className="mt-4 space-y-2">
          {data!.pending.map((p: any) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg bg-amber-50 px-4 py-2 text-sm">
              <span className="truncate text-slate-700">{p.fileName}</span>
              <span className="flex items-center gap-2">
                {p.errorMessage && <span className="max-w-56 truncate text-xs text-red-600">{p.errorMessage}</span>}
                <StatusChip status={p.status} />
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Document list */}
      <div className="mt-4 space-y-2">
        {(data?.documents ?? []).map((d: any) => (
          <button
            key={d.id}
            onClick={() => setSelectedId(d.id)}
            className="flex w-full items-center justify-between rounded-xl bg-white p-4 text-left shadow-sm transition hover:shadow-md"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-900">{d.name}</p>
              <p className="text-xs text-slate-500">
                {d.type ?? 'Necategorisit'}
                {d.vehicle ? ` · ${d.vehicle.make} ${d.vehicle.model} (${d.vehicle.vin.slice(-6)})` : ''}
                {d.party ? ` · ${d.party.name}` : ''}
              </p>
            </div>
            <div className="ml-3 flex shrink-0 items-center gap-2">
              {d.needsReview && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">De verificat</span>}
              <StatusChip status={d.processingStatus} />
            </div>
          </button>
        ))}
        {!isLoading && (data?.documents ?? []).length === 0 && (
          <p className="rounded-xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm">Niciun document încă.</p>
        )}
      </div>

      {selectedId && <DocumentDrawer id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function SagaExport() {
  const token = useSelector((s: RootState) => s.auth.accessToken);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const download = async (path: string) => {
    setBusy(true);
    setMessage('');
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`/api/saga/${path}${path.includes('?') ? '&' : '?'}${params}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `Export eșuat (${res.status})`);
      }
      const blob = await res.blob();
      const count = res.headers.get('X-Invoice-Count');
      const name = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ?? 'saga_export.xml';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setMessage(`Export generat: ${count ?? '?'} înregistrări ✔`);
    } catch (err: any) {
      setMessage(err.message ?? 'Eroare la export');
    } finally {
      setBusy(false);
    }
  };

  const field = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm';
  return (
    <div className="mt-4 rounded-xl bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-2 text-sm font-semibold text-slate-900">Export SAGA (facturi)</p>
        <input type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} title="De la data facturii" />
        <span className="text-sm text-slate-400">–</span>
        <input type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} title="Până la data facturii" />
        <button
          onClick={() => download('export.xml')}
          disabled={busy}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Facturi XML
        </button>
        <button
          onClick={() => download('export.csv')}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
        >
          Facturi CSV
        </button>
        <button
          onClick={() => download('parteneri.xml?tip=furnizori')}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
        >
          Furnizori XML
        </button>
        <button
          onClick={() => download('parteneri.xml?tip=clienti')}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
        >
          Clienți XML
        </button>
        {message && <span className="text-sm text-slate-600">{message}</span>}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Export în formatul de import SAGA C — facturile cu furnizor străin sunt marcate automat cu taxare
        inversă (Da), iar partenerii poartă Guid_cod pentru re-identificare. În SAGA: Operații → Preluare date.
      </p>
    </div>
  );
}

function DocumentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: doc } = useDocumentQuery(id);
  const { data: vehicles = [] } = useVehiclesQuery();
  const { data: parties = [] } = usePartiesQuery();
  const [correct] = useCorrectFieldMutation();
  const [markReviewed] = useMarkReviewedMutation();
  const [assign] = useAssignDocumentMutation();
  const [archive] = useArchiveDocumentMutation();
  const [getUrl] = useLazyDownloadUrlQuery();
  const [editing, setEditing] = useState<{ field: string; value: string } | null>(null);

  if (!doc) return null;
  const fields = (doc.processedData?.extractedFields ?? {}) as Record<string, any>;
  const confidence = (doc.processedData?.fieldConfidence ?? {}) as Record<string, number>;
  const issues: any[] = (doc.processedData?.validationIssues ?? []) as any[];
  const issueFields = new Set(issues.map((i) => i.field));

  const entries = Object.entries(fields).filter(([, v]) => v != null && typeof v !== 'object');
  // Flagged fields first — that's what the reviewer needs to see.
  entries.sort(([a], [b]) => Number(issueFields.has(b)) - Number(issueFields.has(a)));

  const openFile = async () => {
    const res = await getUrl(id).unwrap();
    window.open(res.url, '_blank');
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-900">{doc.name}</h2>
            <p className="text-xs text-slate-500">
              {doc.type ?? 'Necategorisit'} · încredere clasificare {Math.round((doc.processedData?.typeConfidence ?? 0) * 100)}%
            </p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400">×</button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={openFile} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">Deschide fișierul</button>
          {doc.needsReview && (
            <button onClick={() => markReviewed(id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
              ✓ Marchează verificat
            </button>
          )}
          <button
            onClick={async () => {
              await archive({ id, archived: !doc.archivedAt });
              onClose();
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700"
          >
            {doc.archivedAt ? '↩ Restaurează' : '🗄 Arhivează'}
          </button>
        </div>

        {/* Asociere cu vehicul / client */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={doc.vehicleId ?? ''}
            onChange={(e) => assign({ id, vehicleId: e.target.value ? Number(e.target.value) : null })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">Fără vehicul</option>
            {vehicles.map((v: any) => (
              <option key={v.id} value={v.id}>
                {v.make} {v.model} · {v.vin.slice(-6)}
              </option>
            ))}
          </select>
          <select
            value={doc.partyId ?? ''}
            onChange={(e) => assign({ id, partyId: e.target.value ? Number(e.target.value) : null })}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">Fără client/partener</option>
            {parties.map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {issues.length > 0 && (
          <div className="mt-4 rounded-lg bg-red-50 p-3">
            <p className="text-sm font-semibold text-red-700">Verificări eșuate:</p>
            {issues.map((i, idx) => (
              <p key={idx} className="mt-1 text-xs text-red-600">• {i.field}: {i.issue}</p>
            ))}
          </div>
        )}

        <h3 className="mt-5 text-sm font-semibold text-slate-900">Date extrase</h3>
        <div className="mt-2 divide-y divide-slate-100">
          {entries.map(([key, value]) => {
            const conf = confidence[key];
            const flagged = issueFields.has(key) || (conf != null && conf < 0.7);
            return (
              <div key={key} className={`py-2 ${flagged ? 'bg-amber-50/60 -mx-2 px-2 rounded' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-slate-500">
                    {key}
                    {conf != null && <span className={flagged ? 'ml-1 text-amber-600' : 'ml-1 text-slate-400'}> · {Math.round(conf * 100)}%</span>}
                  </p>
                  <button
                    onClick={() => setEditing({ field: key, value: String(value) })}
                    className="text-xs text-slate-400 hover:text-slate-900"
                  >
                    ✏️
                  </button>
                </div>
                {editing?.field === key ? (
                  <form
                    className="mt-1 flex gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await correct({ id, field: key, newValue: editing.value });
                      setEditing(null);
                    }}
                  >
                    <input
                      autoFocus
                      className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                      value={editing.value}
                      onChange={(e) => setEditing({ field: key, value: e.target.value })}
                    />
                    <button className="rounded bg-slate-900 px-2 py-1 text-xs font-semibold text-white">Salvează</button>
                  </form>
                ) : (
                  <p className="text-sm font-medium text-slate-900">{String(value)}</p>
                )}
              </div>
            );
          })}
          {entries.length === 0 && <p className="py-3 text-sm text-slate-500">Nu s-au extras câmpuri.</p>}
        </div>
      </div>
    </div>
  );
}
