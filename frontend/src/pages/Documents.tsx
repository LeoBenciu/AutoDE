import { useRef, useState } from 'react';
import {
  useCorrectFieldMutation,
  useDocumentQuery,
  useDocumentsQuery,
  useLazyDownloadUrlQuery,
  useMarkReviewedMutation,
  usePayableFromDocumentMutation,
  useUploadDocumentsMutation,
} from '../store/api';
import { StatusChip } from '../components/StatusChip';

export default function Documents() {
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const { data, isLoading } = useDocumentsQuery(needsReviewOnly ? { needsReview: true } : undefined, {
    pollingInterval: 8000,
  });
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
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={needsReviewOnly} onChange={(e) => setNeedsReviewOnly(e.target.checked)} />
          Doar de verificat
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

function DocumentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: doc } = useDocumentQuery(id);
  const [correct] = useCorrectFieldMutation();
  const [markReviewed] = useMarkReviewedMutation();
  const [createPayable, { isLoading: creatingPayable }] = usePayableFromDocumentMutation();
  const [getUrl] = useLazyDownloadUrlQuery();
  const [editing, setEditing] = useState<{ field: string; value: string } | null>(null);
  const [note, setNote] = useState('');

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
          {doc.type === 'Invoice' && (
            <button
              onClick={async () => {
                try {
                  await createPayable(id).unwrap();
                  setNote('Plată creată în inbox-ul de plăți ✔');
                } catch (err: any) {
                  setNote(err?.data?.message ?? 'Eroare');
                }
              }}
              disabled={creatingPayable}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              → Creează plată
            </button>
          )}
          {doc.needsReview && (
            <button onClick={() => markReviewed(id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white">
              ✓ Marchează verificat
            </button>
          )}
        </div>
        {note && <p className="mt-2 text-sm text-slate-600">{note}</p>}

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
