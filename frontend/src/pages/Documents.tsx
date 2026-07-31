import { useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  useApproveDocumentMutation,
  useArchiveDocumentMutation,
  useAssignDocumentMutation,
  useCancelPendingUploadMutation,
  useChartOfAccountsQuery,
  useCorrectFieldMutation,
  useDocumentQuery,
  useDocumentsQuery,
  useLazyDownloadUrlQuery,
  usePartiesQuery,
  usePostingPreviewQuery,
  useReopenDocumentMutation,
  useRetryPendingUploadMutation,
  useUploadDocumentsMutation,
  useVehiclesQuery,
} from '../store/api';
import { StatusChip } from '../components/StatusChip';
import { DocumentPreview } from '../components/DocumentPreview';
import { API_BASE_URL } from '../store/apiBase';
import type { RootState } from '../store/store';

const DOC_TYPES = [
  'Invoice',
  'Receipt',
  'Bank Statement',
  'Contract',
  'CMR',
  'Vehicle Registration Certificate',
  'Sale Contract',
  'Handover Protocol',
  'UIT',
  'Other',
];

type SelectOption = [string, string];

const BOOLEAN_OPTIONS: SelectOption[] = [
  ['true', 'Da'],
  ['false', 'Nu'],
];

const CURRENCY_OPTIONS: SelectOption[] = [
  'RON',
  'EUR',
  'USD',
  'GBP',
  'CHF',
  'JPY',
  'CAD',
  'AUD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'BGN',
].map((currency) => [currency, currency]);

const EXTRACTED_FIELD_OPTIONS: Record<string, SelectOption[]> = {
  document_type: DOC_TYPES.map((type): SelectOption => [type, type]),
  direction: [
    ['incoming', 'Intrare'],
    ['outgoing', 'Ieșire'],
  ],
  currency: CURRENCY_OPTIONS,
  receipt_type: [
    ['independent_receipt', 'Document independent'],
    ['payment_receipt', 'Plată/încasare factură'],
  ],
  payment_method: [
    ['cash', 'Numerar'],
    ['bank', 'Bancă / card'],
  ],
  vehicle_transaction: [
    ['purchase', 'Achiziție vehicul'],
    ['cost', 'Cost asociat vehiculului'],
    ['other', 'Fără legătură cu vehiculul'],
  ],
  vendor_kind: [
    ['INDIVIDUAL', 'Persoană fizică'],
    ['COMPANY', 'Companie'],
  ],
  supplier_kind: [
    ['INDIVIDUAL', 'Persoană fizică'],
    ['COMPANY', 'Companie'],
  ],
  buyer_kind: [
    ['INDIVIDUAL', 'Persoană fizică'],
    ['COMPANY', 'Companie'],
  ],
  customer_kind: [
    ['INDIVIDUAL', 'Persoană fizică'],
    ['COMPANY', 'Companie'],
  ],
  vendor_identifier_type: [
    ['CUI', 'CUI'],
    ['CNP', 'CNP'],
    ['FOREIGN_ID', 'Identificator extern'],
  ],
  supplier_identifier_type: [
    ['CUI', 'CUI'],
    ['CNP', 'CNP'],
    ['FOREIGN_ID', 'Identificator extern'],
  ],
  buyer_identifier_type: [
    ['CUI', 'CUI'],
    ['CNP', 'CNP'],
    ['FOREIGN_ID', 'Identificator extern'],
  ],
  customer_identifier_type: [
    ['CUI', 'CUI'],
    ['CNP', 'CNP'],
    ['FOREIGN_ID', 'Identificator extern'],
  ],
  operation_type: [
    ['payment', 'Plată'],
    ['collection', 'Încasare'],
  ],
  transaction_type: [
    ['transfer', 'Transfer'],
    ['payment', 'Plată'],
    ['deposit', 'Depunere'],
    ['withdrawal', 'Retragere'],
  ],
};

const COST_CATEGORY_OPTIONS: Array<[string, string]> = [
  ['TRANSPORT', 'Transport'],
  ['CUSTOMS', 'Taxe vamale'],
  ['VAT', 'TVA nerecuperabilă'],
  ['ITP', 'ITP / inspecție'],
  ['REGISTRATION', 'Înmatriculare / RAR'],
  ['REFURB', 'Recondiționare / reparații'],
  ['OTHER', 'Alt cost'],
];

function defaultVehicleCostCategoryForAccount(accountCode: unknown): string {
  const account = String(accountCode ?? '').trim();
  if (/^624/.test(account)) return 'TRANSPORT';
  if (/^(611|6024)/.test(account)) return 'REFURB';
  return '';
}

const INTERNAL_EXTRACTED_FIELDS = new Set([
  'document_hash',
  'documentHash',
  'vehicle_transaction',
  // Legacy document-level fallback; vehicle cost categories now live on lines.
  'vehicle_cost_category',
]);

function ReviewChip() {
  return (
    <span
      className="rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold"
      style={{ backgroundColor: 'oklch(0.93 0.05 80)', color: 'oklch(0.45 0.13 80)' }}
    >
      De verificat
    </span>
  );
}

function DocIconTile() {
  return (
    <div
      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg"
      style={{ backgroundColor: 'oklch(0.95 0.006 260)', color: 'oklch(0.45 0.01 260)' }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 3h7l5 5v13H7z" />
        <path d="M14 3v5h5" />
      </svg>
    </div>
  );
}

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
  const [retryPending] = useRetryPendingUploadMutation();
  const [cancelPending] = useCancelPendingUploadMutation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const onFiles = async (files: File[]) => {
    console.log(
      '[upload] onFiles called with',
      files.length,
      'file(s):',
      files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    );
    if (!files.length) {
      console.warn('[upload] no files selected — aborting');
      return;
    }
    setUploadError('');
    console.log('[upload] POST', `${API_BASE_URL}/documents/upload`);
    try {
      const result = await upload({ files }).unwrap();
      console.log('[upload] SUCCESS', result);
    } catch (error: any) {
      console.error('[upload] FAILED', {
        status: error?.status,
        data: error?.data,
        error,
      });
      setUploadError(
        error?.data?.message ??
          error?.error ??
          error?.message ??
          `Încărcarea a eșuat (status ${error?.status ?? '?'}). Verifică consola pentru detalii.`,
      );
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Documente</h1>
        <label className="flex items-center gap-2 text-[13.5px] text-ink-soft">
          <input type="checkbox" checked={needsReviewOnly} onChange={(e) => setNeedsReviewOnly(e.target.checked)} />
          Doar de verificat
        </label>
      </div>

      {/* Search & filters */}
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Caută după nume, tip, VIN, client…"
          className="w-full rounded-control border border-line-strong px-3 py-2.5 text-sm focus:border-brand focus:outline-none sm:max-w-xs"
        />
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-control border border-line-strong px-2.5 py-2.5 text-sm text-ink-soft focus:border-brand focus:outline-none">
          <option value="">Toate tipurile</option>
          {DOC_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted">
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
        className={`mt-5 cursor-pointer rounded-card border-[1.5px] border-dashed p-8 text-center transition-colors ${
          dragging ? 'border-brand bg-surface' : 'border-line-strong bg-white'
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
        <div
          className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-[10px]"
          style={{ backgroundColor: 'oklch(0.93 0.03 250)', color: 'oklch(0.45 0.13 250)' }}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
          </svg>
        </div>
        <p className="text-[14.5px] font-semibold text-ink-soft">
          {uploading ? 'Se încarcă…' : 'Trage fișierele aici sau apasă pentru a fotografia/alege'}
        </p>
        <p className="mt-1.5 text-[12.5px] text-muted">Facturi, contracte, chitanțe, dispoziții, CMR și taloane — PDF sau poze</p>
      </div>

      {uploadError && (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <span>{uploadError}</span>
          <button
            onClick={() => setUploadError('')}
            aria-label="Închide"
            className="shrink-0 text-red-400 hover:text-red-600"
          >
            ×
          </button>
        </div>
      )}

      {/* Processing queue */}
      {(data?.pending?.length ?? 0) > 0 && (
        <div className="mt-4 space-y-2">
          {data!.pending.map((p: any) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-xl px-4 py-2.5 text-sm"
              style={{ backgroundColor: 'oklch(0.96 0.03 80)' }}
            >
              <span className="min-w-0">
                <span className="block truncate text-ink-soft">{p.fileName}</span>
                <span className="block text-xs text-muted">
                  {pendingStageLabel(p)}
                  {p.phase0Data?.document_type ? ` · ${p.phase0Data.document_type}` : ''}
                  {p.segmentIndex ? ` · segment ${p.segmentIndex}/${p.segmentCount}` : ''}
                </span>
              </span>
              <span className="ml-3 flex shrink-0 items-center gap-2">
                {p.errorMessage && (
                  <span className="hidden max-w-56 truncate text-xs text-red-600 sm:inline">
                    {p.errorMessage}
                  </span>
                )}
                {p.status === 'ERROR' && (
                  <button
                    onClick={() => retryPending(p.id)}
                    className="rounded-control border border-line-strong px-2.5 py-1 text-xs font-semibold text-ink-soft"
                  >
                    Reîncearcă
                  </button>
                )}
                {['QUEUED', 'UPLOADED', 'PROCESSING', 'PHASE0_COMPLETE'].includes(p.status) && (
                  <button
                    onClick={() => cancelPending(p.id)}
                    className="rounded-control border border-line-strong px-2.5 py-1 text-xs text-muted"
                  >
                    Anulează
                  </button>
                )}
                <StatusChip status={p.status} />
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Document list */}
      <div className="mt-5 space-y-2">
        {(data?.documents ?? []).map((d: any) => (
          <button
            key={d.id}
            onClick={() => setSelectedId(d.id)}
            className="flex w-full items-center justify-between rounded-xl border border-line bg-white p-3.5 text-left transition-colors hover:border-line-strong"
          >
            <div className="flex min-w-0 items-center gap-3">
              <DocIconTile />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{d.name}</p>
                <p className="text-xs text-muted">
                  {d.type ?? 'Necategorisit'}
                  {d.vehicle ? ` · ${d.vehicle.make} ${d.vehicle.model} (${d.vehicle.vin.slice(-6)})` : ''}
                  {d.party ? ` · ${d.party.name}` : ''}
                </p>
              </div>
            </div>
            <div className="ml-3 flex shrink-0 items-center gap-2">
              {d.reviewStatus === 'APPROVED' ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-700">
                  Aprobat
                </span>
              ) : d.needsReview ? (
                <ReviewChip />
              ) : null}
              <StatusChip status={d.processingStatus} />
            </div>
          </button>
        ))}
        {!isLoading && (data?.documents ?? []).length === 0 && (
          <div className="rounded-card border border-dashed border-line-strong bg-white p-8 text-center">
            <p className="text-[13.5px] text-muted">Niciun document încărcat încă.</p>
          </div>
        )}
      </div>

      {selectedId && <DocumentReviewModal id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function pendingStageLabel(pending: any): string {
  if (pending.status === 'SPLIT') return 'Scan împărțit în documente';
  if (pending.status === 'ERROR') return `Eroare în faza ${pending.processingPhase ?? 0}`;
  if (pending.status === 'PHASE0_COMPLETE') return 'Clasificare finalizată';
  if (pending.status === 'PHASE1_COMPLETE') return 'Extragere finalizată';
  if (pending.processingPhase === 1) return 'Faza 2 din 2 · extragere și validare';
  if (pending.status === 'PROCESSING') return 'Faza 1 din 2 · clasificare';
  return 'În așteptarea procesării';
}

function DocumentReviewModal({ id, onClose }: { id: number; onClose: () => void }) {
  const user = useSelector((state: RootState) => state.auth.user);
  const canApprove = user?.role === 'ACCOUNTANT';
  const { data: doc } = useDocumentQuery(id);
  const { data: posting, isFetching: postingLoading } = usePostingPreviewQuery(id, {
    skip: !canApprove,
  });
  const { data: vehicles = [] } = useVehiclesQuery();
  const { data: parties = [] } = usePartiesQuery();
  const { data: accounts = [] } = useChartOfAccountsQuery();
  const [correct] = useCorrectFieldMutation();
  const [approve, { isLoading: approving }] = useApproveDocumentMutation();
  const [reopen, { isLoading: reopening }] = useReopenDocumentMutation();
  const [assign] = useAssignDocumentMutation();
  const [archive] = useArchiveDocumentMutation();
  const [getUrl] = useLazyDownloadUrlQuery();
  const [editing, setEditing] = useState<{ field: string; value: string } | null>(null);
  const [actionMessage, setActionMessage] = useState('');
  const [hideAccepted, setHideAccepted] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    let active = true;
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewUrl(undefined);
    getUrl(id)
      .unwrap()
      .then((result) => {
        if (active) setPreviewUrl(result.url);
      })
      .catch((error: any) => {
        if (active) {
          setPreviewError(error?.data?.message ?? error?.message ?? 'URL-ul documentului nu a putut fi generat.');
        }
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [getUrl, id]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  if (!doc) return null;
  const fields = (doc.processedData?.extractedFields ?? {}) as Record<string, any>;
  const contractVendor = Array.isArray(fields.parties)
    ? fields.parties.find((party: any) =>
        ['vendor', 'seller', 'vanzator', 'vânzător'].includes(
          String(party?.role ?? '').toLowerCase(),
        ),
      )
    : undefined;
  const vendorKind = fields.vendor_kind ?? contractVendor?.kind ?? 'INDIVIDUAL';
  const vendorCountry = String(
    fields.vendor_country ?? contractVendor?.country ?? 'RO',
  ).toUpperCase();
  const vendorIdentifierType =
    fields.vendor_identifier_type ??
    contractVendor?.identifier_type ??
    (vendorKind === 'COMPANY'
      ? 'CUI'
      : vendorCountry === 'RO'
        ? 'CNP'
        : 'FOREIGN_ID');
  const isPurchaseContract =
    doc.type === 'Contract' &&
    (fields.vehicle_transaction === 'purchase' ||
      (Boolean(fields.vin) &&
        /(vanzare|vânzare|sale|achiz)/i.test(String(fields.contract_type ?? ''))));
  const isAccountingDocument = [
    'Invoice',
    'Receipt',
    'Payment Disposition',
    'Collection Disposition',
  ].includes(doc.type) || isPurchaseContract;
  const confidence = (doc.processedData?.fieldConfidence ?? {}) as Record<string, number>;
  const issues: any[] = (doc.processedData?.validationIssues ?? []) as any[];
  const issueFields = new Set(issues.map((i) => i.field));

  const entries = Object.entries(fields).filter(
    ([key, value]) =>
      !key.startsWith('_') &&
      !INTERNAL_EXTRACTED_FIELDS.has(key) &&
      key !== 'vehicle_cost_categories_reviewed' &&
      value != null &&
      typeof value !== 'object',
  );
  const isFlagged = (key: string) =>
    issueFields.has(key) || (confidence[key] != null && confidence[key] < 0.7);
  const isAccepted = (key: string) =>
    !issueFields.has(key) && confidence[key] != null && confidence[key] >= 0.9;
  // Finova review order: flagged → neutral → high-confidence/auto-accepted.
  entries.sort(([a], [b]) => {
    const rank = (key: string) => (isFlagged(key) ? 0 : isAccepted(key) ? 2 : 1);
    return rank(a) - rank(b);
  });
  const visibleEntries = hideAccepted ? entries.filter(([key]) => !isAccepted(key)) : entries;
  const acceptedCount = entries.filter(([key]) => isAccepted(key)).length;
  const reviewFields = new Set([
    ...Array.from(issueFields),
    ...Object.entries(confidence)
      .filter(([, value]) => Number(value) < 0.7)
      .map(([key]) => key),
  ]);
  const confidenceValues = Object.values(confidence).filter(Number.isFinite);
  const globalConfidence =
    confidenceValues.length > 0
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : doc.processedData?.typeConfidence ?? 0;
  const lineItems = Array.isArray(fields.line_items) ? fields.line_items : [];
  const hasExtractedVehicleCostCategory = lineItems.some((line: any) =>
    COST_CATEGORY_OPTIONS.some(
      ([category]) => category === line?.vehicle_cost_category,
    ),
  );
  const isVehicleCostDocument =
    ['Invoice', 'Receipt'].includes(doc.type) &&
    fields.receipt_type !== 'payment_receipt' &&
    fields.vehicle_transaction !== 'purchase' &&
    (fields.vehicle_transaction === 'cost' ||
      hasExtractedVehicleCostCategory ||
      doc.vehicleId != null);
  const hasAmbiguousVehicleCostAccounts = lineItems.some(
    (line: any) =>
      defaultVehicleCostCategoryForAccount(line?.account_code) === '',
  );
  const runAccountingAction = async (action: 'approve' | 'reopen') => {
    setActionMessage('');
    try {
      if (action === 'approve') {
        await approve(id).unwrap();
        setActionMessage('Document aprobat și înregistrat în jurnal.');
      } else {
        await reopen(id).unwrap();
        setActionMessage('Document redeschis. Notele contabile au fost eliminate.');
      }
    } catch (error: any) {
      const details = error?.data?.errors;
      setActionMessage(
        Array.isArray(details)
          ? details.join(' · ')
          : error?.data?.message ?? error?.message ?? 'Acțiunea nu a putut fi finalizată',
      );
    }
  };

  const openFile = async () => {
    if (previewUrl) {
      window.open(previewUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const res = await getUrl(id).unwrap();
    window.open(res.url, '_blank', 'noopener,noreferrer');
  };

  const selectClass = 'rounded-control border border-line-strong px-2.5 py-2 text-sm focus:border-brand focus:outline-none';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,15,25,0.55)] p-0 md:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Date extrase pentru ${doc.name}`}
        className="flex h-full w-full max-w-[1680px] flex-col overflow-hidden bg-white shadow-[0_28px_80px_rgba(15,15,25,0.28)] md:h-[min(92vh,920px)] md:rounded-[18px] md:border md:border-line"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-line bg-white px-4 py-3 md:px-5">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-control px-2 py-1.5 text-sm font-medium text-muted hover:bg-surface hover:text-ink"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Înapoi
          </button>

          <span className="hidden h-5 w-px bg-line-strong md:block" />

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-bold text-ink md:text-[15px]">{doc.name}</h2>
            <p className="truncate text-xs text-muted">
              {doc.type ?? 'Necategorisit'} · clasificare {Math.round((doc.processedData?.typeConfidence ?? 0) * 100)}%
            </p>
          </div>

          <div className="hidden min-w-48 items-center gap-2 md:flex">
            <span className="shrink-0 text-xs text-muted">Încredere globală</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <div
                className={`h-full ${globalConfidence < 0.7 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.max(0, Math.min(100, globalConfidence * 100))}%` }}
              />
            </div>
            <span className="text-xs font-bold tabular-nums text-ink-soft">{Math.round(globalConfidence * 100)}%</span>
          </div>

          <button onClick={openFile} className="rounded-control border border-line-strong px-3 py-2 text-xs font-semibold text-ink-soft hover:bg-surface">
            Deschide separat
          </button>
          {doc.reviewStatus === 'LEGACY' && (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
              Istoric · fără postare
            </span>
          )}
          {doc.reviewStatus === 'APPROVED' && (
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              {doc.postingStatus === 'POSTED' ? 'Aprobat și postat' : 'Aprobat'}
            </span>
          )}
          {canApprove && doc.reviewStatus === 'APPROVED' && (
            <button
              onClick={() => runAccountingAction('reopen')}
              disabled={reopening}
              className="rounded-control border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
            >
              {reopening ? 'Se redeschide…' : 'Redeschide pentru corectare'}
            </button>
          )}
          {canApprove &&
            doc.reviewStatus !== 'APPROVED' &&
            doc.reviewStatus !== 'LEGACY' && (
              <button
                onClick={() => runAccountingAction('approve')}
                disabled={approving || postingLoading || (posting?.errors?.length ?? 0) > 0}
                className="rounded-control bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {approving
                  ? 'Se aprobă…'
                  : isAccountingDocument
                    ? '✓ Aprobă și postează'
                    : '✓ Aprobă documentul'}
              </button>
            )}
          <button
            onClick={async () => {
              await archive({ id, archived: !doc.archivedAt });
              onClose();
            }}
            className="hidden rounded-control border border-line-strong px-3 py-2 text-xs text-ink-soft hover:bg-surface sm:block"
          >
            {doc.archivedAt ? 'Restaurează' : 'Arhivează'}
          </button>
          <button onClick={onClose} aria-label="Închide" className="flex h-9 w-9 items-center justify-center rounded-control text-xl leading-none text-muted-2 hover:bg-surface hover:text-ink">
            ×
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[42%_minmax(0,1fr)] lg:grid-cols-2 lg:grid-rows-1">
          <DocumentPreview
            url={previewUrl}
            fileName={doc.name}
            contentType={doc.contentType}
            loading={previewLoading}
            error={previewError}
          />

          <div className="min-h-0 overflow-y-auto bg-white p-4 md:p-5">
            {/* Asociere cu vehicul / client */}
            <div className="flex flex-wrap items-center gap-2">
          <select
            value={doc.vehicleId ?? ''}
            onChange={(e) => assign({ id, vehicleId: e.target.value ? Number(e.target.value) : null })}
            className={selectClass}
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
            className={selectClass}
          >
            <option value="">Fără client/partener</option>
            {parties.map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {['Invoice', 'Receipt', 'Payment Disposition', 'Collection Disposition', 'Contract'].includes(doc.type) && (
          <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-line bg-slate-50 p-3 lg:grid-cols-4">
            <LineField
              label="Direcție"
              value={fields.direction ?? ''}
              options={[
                ['incoming', 'Intrare'],
                ['outgoing', 'Ieșire'],
              ]}
              disabled={doc.reviewStatus === 'APPROVED'}
              onSave={(value) => correct({ id, field: 'direction', newValue: value }).unwrap()}
            />
            {doc.type === 'Invoice' && (
              <LineField
                label="Rol în fluxul vehiculului"
                value={fields.vehicle_transaction ?? 'other'}
                options={[
                  ['purchase', 'Achiziție vehicul'],
                  ['cost', 'Cost asociat vehiculului'],
                  ['other', 'Fără legătură cu vehiculul'],
                ]}
                disabled={doc.reviewStatus === 'APPROVED'}
                onSave={(value) =>
                  correct({
                    id,
                    field: 'vehicle_transaction',
                    newValue: value,
                  }).unwrap()
                }
              />
            )}
            {isVehicleCostDocument && hasAmbiguousVehicleCostAccounts && (
              <label
                className={`col-span-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold lg:col-span-4 ${
                  fields.vehicle_cost_categories_reviewed === true
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-amber-300 bg-amber-50 text-amber-800'
                }`}
              >
                <input
                  type="checkbox"
                  checked={fields.vehicle_cost_categories_reviewed === true}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onChange={(event) =>
                    correct({
                      id,
                      field: 'vehicle_cost_categories_reviewed',
                      newValue: event.target.checked,
                    }).unwrap()
                  }
                />
                Am verificat categoriile pentru conturile ambigue
              </label>
            )}
            {doc.type === 'Contract' && (
              <>
                <LineField
                  label="Rolul contractului"
                  value={fields.vehicle_transaction ?? 'other'}
                  options={[
                    ['purchase', 'Achiziție vehicul'],
                    ['other', 'Alt contract'],
                  ]}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) =>
                    correct({
                      id,
                      field: 'vehicle_transaction',
                      newValue: value,
                    }).unwrap()
                  }
                />
                <LineField
                  label="Vânzător"
                  value={fields.vendor ?? contractVendor?.name ?? ''}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) =>
                    correct({ id, field: 'vendor', newValue: value }).unwrap()
                  }
                />
                <LineField
                  label="Tip vânzător"
                  value={vendorKind}
                  options={[
                    ['INDIVIDUAL', 'Persoană fizică'],
                    ['COMPANY', 'Companie'],
                  ]}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) =>
                    correct({
                      id,
                      field: 'vendor_kind',
                      newValue: value,
                    }).unwrap()
                  }
                />
                <LineField
                  label="Țară vânzător (ISO)"
                  value={vendorCountry}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) =>
                    correct({
                      id,
                      field: 'vendor_country',
                      newValue: value.toUpperCase(),
                    }).unwrap()
                  }
                />
                <LineField
                  label="Tip identificator"
                  value={vendorIdentifierType}
                  options={[
                    ['CNP', 'CNP'],
                    ['FOREIGN_ID', 'Identificator extern'],
                    ['CUI', 'CUI'],
                  ]}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) =>
                    correct({
                      id,
                      field: 'vendor_identifier_type',
                      newValue: value,
                    }).unwrap()
                  }
                />
                <LineField
                  label={
                    vendorKind === 'INDIVIDUAL'
                      ? vendorCountry === 'RO'
                        ? 'CNP vânzător'
                        : 'Identificator extern vânzător'
                      : 'CUI vânzător'
                  }
                  value={
                    fields.vendor_ein ??
                    contractVendor?.ein ??
                    contractVendor?.tax_id ??
                    ''
                  }
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) =>
                    correct({
                      id,
                      field: 'vendor_ein',
                      newValue: value,
                    }).unwrap()
                  }
                />
                {fields.vehicle_transaction === 'purchase' && (
                  <p className="col-span-2 text-xs text-muted lg:col-span-4">
                    Pentru achiziția de la persoană fizică: CNP obligatoriu
                    pentru România; identificator personal extern obligatoriu
                    pentru altă țară.
                  </p>
                )}
              </>
            )}
            {doc.type === 'Receipt' && (
              <>
                <LineField
                  label="Tip chitanță / bon"
                  value={fields.receipt_type ?? 'independent_receipt'}
                  options={[
                    ['independent_receipt', 'Document independent'],
                    ['payment_receipt', 'Plată/încasare factură'],
                  ]}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) => correct({ id, field: 'receipt_type', newValue: value }).unwrap()}
                />
                <LineField
                  label="Metodă plată"
                  value={fields.payment_method ?? 'cash'}
                  options={[
                    ['cash', 'Numerar'],
                    ['bank', 'Bancă / card'],
                  ]}
                  disabled={doc.reviewStatus === 'APPROVED'}
                  onSave={(value) => correct({ id, field: 'payment_method', newValue: value }).unwrap()}
                />
              </>
            )}
            {['Receipt', 'Payment Disposition', 'Collection Disposition'].includes(doc.type) && (
              <LineField
                label="Facturi și sume alocate"
                value={formatReferences(fields)}
                disabled={doc.reviewStatus === 'APPROVED'}
                className="col-span-2"
                onSave={(value) => {
                  const allocations = parseReferences(value);
                  return correct({
                    id,
                    field: 'referenced_invoices',
                    newValue: allocations,
                  }).unwrap();
                }}
              />
            )}
          </div>
        )}

        {actionMessage && (
          <div
            className={`mt-4 rounded-xl border p-3 text-sm ${
              actionMessage.includes('aprobat') || actionMessage.includes('redeschis')
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {actionMessage}
          </div>
        )}

        {(reviewFields.size > 0 || fields._needs_type_review) && (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm font-semibold text-amber-800">
              {reviewFields.size > 0
                ? `${reviewFields.size} ${reviewFields.size === 1 ? 'câmp necesită' : 'câmpuri necesită'} verificare`
                : 'Documentul necesită verificare'}
            </p>
            {issues.map((i, idx) => (
              <p key={idx} className="mt-1 text-xs text-amber-800">• {humanField(i.field)}: {i.issue}</p>
            ))}
            {Array.from(reviewFields)
              .filter((field) => !issueFields.has(field))
              .map((field) => (
                <p key={field} className="mt-1 text-xs text-amber-800">
                  • {humanField(field)}: încredere redusă ({Math.round(Number(confidence[field]) * 100)}%)
                </p>
              ))}
            {fields._needs_type_review && (
              <p className="mt-1 text-xs text-amber-800">• Tipul documentului necesită confirmare.</p>
            )}
          </div>
        )}

        <JournalPreview posting={posting} loading={postingLoading} legacy={doc.reviewStatus === 'LEGACY'} />

        <div className="mt-5 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink">Date extrase</h3>
          {acceptedCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={hideAccepted}
                onChange={(event) => setHideAccepted(event.target.checked)}
              />
              Ascunde {acceptedCount} acceptate automat
            </label>
          )}
        </div>
        <div className="mt-2 divide-y divide-line">
          {visibleEntries.map(([key, value]) => {
            const conf = confidence[key];
            const flagged = isFlagged(key);
            const options = extractedFieldOptions(key, value);
            return (
              <div key={key} className={`py-2 ${flagged ? '-mx-2 rounded bg-amber-50/60 px-2' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted">
                    {humanField(key)}
                    {conf != null && <span className={flagged ? 'ml-1 text-amber-600' : 'ml-1 text-muted-2'}> · {Math.round(conf * 100)}%</span>}
                  </p>
                  <button
                    disabled={doc.reviewStatus === 'APPROVED'}
                    onClick={() =>
                      setEditing({
                        field: key,
                        value: extractedFieldDraftValue(key, value),
                      })
                    }
                    title={doc.reviewStatus === 'APPROVED' ? 'Redeschide documentul pentru a-l corecta' : 'Editează'}
                    className="text-xs text-muted-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    ✏️
                  </button>
                </div>
                {editing?.field === key ? (
                  <form
                    className="mt-1 flex gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await correct({
                        id,
                        field: key,
                        newValue: extractedFieldCorrectionValue(
                          key,
                          value,
                          editing.value,
                        ),
                      });
                      setEditing(null);
                    }}
                  >
                    {options ? (
                      <select
                        autoFocus
                        className="flex-1 rounded-control border border-line-strong bg-white px-2.5 py-1.5 text-sm focus:border-brand focus:outline-none"
                        value={editing.value}
                        onChange={(e) =>
                          setEditing({ field: key, value: e.target.value })
                        }
                      >
                        {!options.some(([option]) => option === editing.value) && (
                          <option value={editing.value}>
                            {editing.value || '—'}
                          </option>
                        )}
                        {options.map(([option, label]) => (
                          <option key={option} value={option}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        autoFocus
                        className="flex-1 rounded-control border border-line-strong px-2.5 py-1.5 text-sm focus:border-brand focus:outline-none"
                        value={editing.value}
                        onChange={(e) =>
                          setEditing({ field: key, value: e.target.value })
                        }
                      />
                    )}
                    <button className="rounded-control bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-hover">Salvează</button>
                  </form>
                ) : (
                  <p className="text-sm font-medium text-ink">
                    {displayExtractedFieldValue(key, value)}
                  </p>
                )}
              </div>
            );
          })}
          {visibleEntries.length === 0 && <p className="py-3 text-sm text-muted">Nu s-au extras câmpuri.</p>}
        </div>

        {['Invoice', 'Receipt'].includes(doc.type) && (
          <div className="mt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">Linii document ({lineItems.length})</h3>
              <button
                disabled={doc.reviewStatus === 'APPROVED'}
                onClick={() =>
                  correct({
                    id,
                    field: 'line_items',
                    newValue: [
                      ...lineItems,
                      {
                        name: 'Articol nou',
                        quantity: 1,
                        unit_price: 0,
                        total: 0,
                        vat_amount: 0,
                        vat: 'TWENTYONE',
                        vat_deductibility: 'FULL',
                        um: 'BUCATA',
                        articleCode: '',
                        management: '',
                        account_code: doc.type === 'Invoice' ? '628' : '628',
                        vehicle_cost_category: isVehicleCostDocument ? '' : null,
                      },
                    ],
                  })
                }
                className="rounded-control border border-line-strong px-2.5 py-1.5 text-xs font-semibold text-ink-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                + Adaugă linie
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {lineItems.map((item: any, index: number) => {
                const low = Number(item?._confidence) < 0.7;
                const explicitCostCategory = item.vehicle_cost_category ?? '';
                const automaticCostCategory =
                  explicitCostCategory === ''
                    ? defaultVehicleCostCategoryForAccount(item.account_code)
                    : '';
                return (
                  <div
                    key={index}
                    className={`rounded-xl border p-3 ${low ? 'border-amber-300 bg-amber-50' : 'border-line bg-surface'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Linia {index + 1}</p>
                      <div className="flex items-center gap-2">
                        {Number.isFinite(Number(item?._confidence)) && (
                          <span className={`text-xs font-semibold ${low ? 'text-amber-700' : 'text-emerald-700'}`}>
                            {Math.round(Number(item._confidence) * 100)}%
                          </span>
                        )}
                        <button
                          disabled={doc.reviewStatus === 'APPROVED'}
                          onClick={() =>
                            correct({
                              id,
                              field: 'line_items',
                              newValue: lineItems.filter((_: any, lineIndex: number) => lineIndex !== index),
                            })
                          }
                          className="text-xs text-red-500 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Elimină
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-4">
                      <LineField
                        label="Descriere"
                        value={item.name ?? item.description ?? ''}
                        disabled={doc.reviewStatus === 'APPROVED'}
                        className="col-span-2"
                        onSave={(value) => correct({ id, field: `line_items[${index}].name`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Cantitate"
                        value={item.quantity ?? ''}
                        type="number"
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].quantity`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Preț unitar"
                        value={item.unit_price ?? ''}
                        type="number"
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].unit_price`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Valoare netă"
                        value={item.total ?? item.net_amount ?? ''}
                        type="number"
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].total`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="TVA"
                        value={item.vat_amount ?? ''}
                        type="number"
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].vat_amount`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Cotă TVA"
                        value={item.vat ?? item.vat_rate ?? ''}
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].vat`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Deductibilitate"
                        value={item.vat_deductibility ?? 'FULL'}
                        options={[
                          ['FULL', 'Integral'],
                          ['PARTIAL_50', '50%'],
                          ['NONE', 'Nedeductibil'],
                        ]}
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].vat_deductibility`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="UM"
                        value={item.um ?? 'BUCATA'}
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].um`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Cod articol"
                        value={item.articleCode ?? ''}
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].articleCode`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Gestiune"
                        value={item.management ?? ''}
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].management`, newValue: value }).unwrap()}
                      />
                      <LineField
                        label="Cont"
                        value={item.account_code ?? ''}
                        options={accounts.map((account: any) => [
                          account.accountCode,
                          `${account.accountCode} · ${account.accountName}`,
                        ])}
                        disabled={doc.reviewStatus === 'APPROVED'}
                        onSave={(value) => correct({ id, field: `line_items[${index}].account_code`, newValue: value }).unwrap()}
                      />
                      {isVehicleCostDocument && (
                        <LineField
                          label={`Categorie cost vehicul${automaticCostCategory ? ' · automată' : ''}`}
                          value={explicitCostCategory || automaticCostCategory}
                          options={COST_CATEGORY_OPTIONS}
                          disabled={doc.reviewStatus === 'APPROVED'}
                          onSave={(value) =>
                            correct({
                              id,
                              field: `line_items[${index}].vehicle_cost_category`,
                              newValue: value,
                            }).unwrap()
                          }
                        />
                      )}
                    </div>
                  </div>
                );
              })}
              {lineItems.length === 0 && (
                <p className="rounded-xl border border-dashed border-line-strong p-4 text-center text-xs text-muted">
                  Nu există linii. Adaugă cel puțin o linie înainte de aprobarea unei facturi.
                </p>
              )}
            </div>
          </div>
        )}
          </div>
        </div>
      </div>
    </div>
  );
}

function JournalPreview({
  posting,
  loading,
  legacy,
}: {
  posting: any;
  loading: boolean;
  legacy: boolean;
}) {
  if (legacy) {
    return (
      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm font-semibold text-slate-700">Document istoric</p>
        <p className="mt-1 text-xs text-slate-600">
          A fost încărcat înainte de activarea contabilității și nu intră în jurnal sau în exportul SAGA unificat.
        </p>
      </div>
    );
  }
  if (loading && !posting) {
    return <p className="mt-4 text-xs text-muted">Se calculează nota contabilă propusă…</p>;
  }
  if (!posting) return null;
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-line">
      <div className="flex items-center justify-between bg-slate-50 px-3 py-2.5">
        <div>
          <p className="text-sm font-semibold text-ink">Nota contabilă propusă</p>
          <p className="text-[11px] text-muted">
            {posting.sourceType ?? 'Fără postare'} · {posting.postingDate ?? 'dată lipsă'} · curs {Number(posting.exchangeRate ?? 1).toFixed(4)}
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            (posting.errors?.length ?? 0) > 0
              ? 'bg-red-100 text-red-700'
              : 'bg-emerald-100 text-emerald-700'
          }`}
        >
          {(posting.errors?.length ?? 0) > 0 ? 'Blocat' : 'Echilibrat'}
        </span>
      </div>
      {(posting.errors?.length ?? 0) > 0 && (
        <div className="border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {posting.errors.map((error: string) => <p key={error}>• {error}</p>)}
        </div>
      )}
      {(posting.warnings?.length ?? 0) > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {posting.warnings.map((warning: string) => <p key={warning}>• {warning}</p>)}
        </div>
      )}
      {(posting.entries?.length ?? 0) > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-t border-line bg-white text-left text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Cont</th>
                  <th className="px-3 py-2 font-medium">Explicație</th>
                  <th className="px-3 py-2 text-right font-medium">Debit</th>
                  <th className="px-3 py-2 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody>
                {posting.entries.map((entry: any, index: number) => (
                  <tr key={`${entry.accountCode}-${index}`} className="border-t border-line">
                    <td className="px-3 py-2 font-semibold text-ink">{entry.accountCode}</td>
                    <td className="px-3 py-2 text-muted">{entry.description}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">{money(entry.debit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">{money(entry.credit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-6 border-t border-line bg-slate-50 px-3 py-2 text-xs font-bold text-ink">
            <span>Debit {money(posting.totalDebit)}</span>
            <span>Credit {money(posting.totalCredit)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function LineField({
  label,
  value,
  onSave,
  disabled,
  type = 'text',
  options,
  className = '',
}: {
  label: string;
  value: string | number;
  onSave: (value: string) => Promise<unknown>;
  disabled?: boolean;
  type?: 'text' | 'number';
  options?: Array<[string, string]>;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setDraft(String(value ?? '')), [value]);

  const save = async () => {
    if (disabled || draft === String(value ?? '')) return;
    setSaving(true);
    setFailed(false);
    try {
      await onSave(draft);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  const controlClass = `mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-xs text-ink focus:border-brand focus:outline-none disabled:bg-slate-100 ${
    failed ? 'border-red-400' : 'border-line-strong'
  }`;
  return (
    <label className={`min-w-0 text-[10px] font-medium uppercase tracking-wide text-muted ${className}`}>
      {label}{saving ? ' · se salvează' : ''}
      {options ? (
        <select
          value={draft}
          disabled={disabled || saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          className={controlClass}
        >
          {!options.some(([option]) => option === draft) && <option value={draft}>{draft || '—'}</option>}
          {options.map(([option, optionLabel]) => (
            <option key={option} value={option}>{optionLabel}</option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          step={type === 'number' ? '0.01' : undefined}
          value={draft}
          disabled={disabled || saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
          className={controlClass}
        />
      )}
    </label>
  );
}

function money(value: unknown): string {
  const number = Number(value ?? 0);
  if (!number) return '—';
  return number.toLocaleString('ro-RO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatReferences(fields: Record<string, any>): string {
  if (Array.isArray(fields.referenced_invoices) && fields.referenced_invoices.length > 0) {
    return fields.referenced_invoices
      .map((reference: any) => {
        if (typeof reference === 'string') return reference;
        const number =
          reference.number ??
          reference.document_number ??
          reference.invoice_number ??
          '';
        const amount =
          reference.amount ?? reference.payment_amount ?? reference.paid_amount;
        return amount != null ? `${number}: ${amount}` : number;
      })
      .filter(Boolean)
      .join(', ');
  }
  const numbers = Array.isArray(fields.referenced_numbers)
    ? fields.referenced_numbers
    : fields.invoice_reference
      ? [fields.invoice_reference]
      : [];
  return numbers.join(', ');
}

function parseReferences(value: string): Array<{ number: string; amount?: number }> {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^(.*?):\s*(-?\d+(?:[.,]\d+)?)$/);
      if (!match) return { number: item };
      return {
        number: match[1].trim(),
        amount: Number(match[2].replace(',', '.')),
      };
    });
}

function extractedFieldOptions(
  field: string,
  value: unknown,
): SelectOption[] | undefined {
  if (isBooleanExtractedField(value)) return BOOLEAN_OPTIONS;
  return EXTRACTED_FIELD_OPTIONS[field];
}

function isBooleanExtractedField(value: unknown): boolean {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'string' && /^(true|false)$/i.test(value.trim()))
  );
}

function extractedFieldDraftValue(field: string, value: unknown): string {
  if (extractedFieldOptions(field, value) === BOOLEAN_OPTIONS) {
    return String(value).trim().toLowerCase();
  }
  return String(value ?? '');
}

function extractedFieldCorrectionValue(
  field: string,
  originalValue: unknown,
  draft: string,
): unknown {
  if (extractedFieldOptions(field, originalValue) === BOOLEAN_OPTIONS) {
    return draft === 'true';
  }
  return draft;
}

function displayExtractedFieldValue(field: string, value: unknown): string {
  const options = extractedFieldOptions(field, value);
  const draft = extractedFieldDraftValue(field, value);
  return options?.find(([option]) => option === draft)?.[1] ?? String(value);
}

function humanField(field: string): string {
  return String(field)
    .replace(/\[(\d+)\]/g, ' #$1')
    .replace(/[._]/g, ' ')
    .trim();
}
