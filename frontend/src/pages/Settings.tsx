import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  useArticlesQuery,
  useCompanyQuery,
  useContractTemplatesQuery,
  useChangePasswordMutation,
  useCreateArticleMutation,
  useCreateManagementMutation,
  useCreatePartyMutation,
  useCreateUserMutation,
  useImportArticlesMutation,
  useImportManagementsMutation,
  useImportPartiesMutation,
  useLazyCompanyFromAnafQuery,
  useManagementsQuery,
  usePartiesQuery,
  usePreviewContractTemplateMutation,
  useUpdateCompanyMutation,
  useUpdateContractTemplatesMutation,
  useUpdatePartyMutation,
  useUpdateUserMutation,
  useUsersQuery,
} from '../store/api';
import type { ImportResult } from '../store/api';
import { apiUrl } from '../store/apiBase';
import { setCredentials } from '../store/authSlice';
import type { RootState } from '../store/store';

const ROLES = ['ACCOUNTANT', 'SALES', 'VIEWER'];
const ROLE_LABELS: Record<string, string> = {
  ACCOUNTANT: 'Contabil',
  SALES: 'Vânzări',
  VIEWER: 'Doar citire',
};
const VAT_RATE_LABELS: Record<string, string> = {
  ZERO: '0%',
  FIVE: '5%',
  NINE: '9%',
  ELEVEN: '11%',
  NINETEEN: '19%',
  TWENTYONE: '21%',
};

export default function Settings() {
  const me = useSelector((state: RootState) => state.auth.user);
  const canManageUsers = me?.role === 'ACCOUNTANT';
  const { data: users = [], isLoading: loadingUsers, error: usersError } =
    useUsersQuery(undefined, { skip: !canManageUsers });
  const [updateUser] = useUpdateUserMutation();
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [passwordUser, setPasswordUser] = useState<any | null>(null);

  const act = async (fn: () => Promise<any>) => {
    setMessage('');
    setNotice('');
    try {
      await fn();
    } catch (error: any) {
      setMessage(apiError(error));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-ink">Setări</h1>
      <p className="mt-1.5 text-sm text-muted">
        Datele firmei, configurarea SAGA și cataloagele folosite la aprobare și export.
      </p>
      {message && (
        <p className="mt-3 rounded-control bg-red-50 px-4 py-2 text-sm text-red-700">
          {message}
        </p>
      )}
      {notice && (
        <p className="mt-3 rounded-control bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      <OwnPasswordForm />

      <AccountingSettings
        onMessage={setMessage}
        canEditTemplates={canManageUsers}
      />

      {canManageUsers && (
        <section className="mt-8">
          <div>
            <h2 className="text-lg font-bold text-ink">Utilizatori</h2>
            <p className="mt-1 text-sm text-muted">
              Adaugă colegi, schimbă roluri și dezactivează accesul.
            </p>
          </div>
          {usersError && (
            <p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Lista utilizatorilor nu a putut fi încărcată.
            </p>
          )}
          <div className="mt-4 space-y-2">
            {users.map((user: any) => (
              <div
                key={user.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-white p-4"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-ink">
                    {user.name}{' '}
                    {user.id === me?.id && (
                      <span className="text-xs font-normal text-muted-2">(tu)</span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted">{user.email}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canManageUsers && user.id !== me?.id ? (
                    <>
                      <select
                        value={user.role}
                        onChange={(event) =>
                          act(() =>
                            updateUser({
                              id: user.id,
                              body: { role: event.target.value },
                            }).unwrap(),
                          )
                        }
                        className={fieldClass}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          setMessage('');
                          setNotice('');
                          setPasswordUser(user);
                        }}
                        className="rounded-control border border-line-strong px-3.5 py-2 text-sm font-semibold text-ink-soft"
                      >
                        Schimbă parola
                      </button>
                      <button
                        onClick={() =>
                          act(() =>
                            updateUser({
                              id: user.id,
                              body: { active: !user.active },
                            }).unwrap(),
                          )
                        }
                        className={`rounded-control px-3.5 py-2 text-sm font-semibold ${
                          user.active
                            ? 'border border-line-strong text-ink-soft'
                            : 'bg-emerald-600 text-white hover:bg-emerald-700'
                        }`}
                      >
                        {user.active ? 'Dezactivează' : 'Reactivează'}
                      </button>
                    </>
                  ) : (
                    <span className="rounded-full bg-canvas px-2.5 py-0.5 text-xs font-semibold text-ink-soft">
                      {ROLE_LABELS[user.role] ?? user.role}
                    </span>
                  )}
                  {!user.active && (
                    <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700">
                      Dezactivat
                    </span>
                  )}
                </div>
              </div>
            ))}
            {loadingUsers && <p className="text-sm text-muted">Se încarcă…</p>}
          </div>
          {canManageUsers && <NewUserForm onError={setMessage} />}
        </section>
      )}
      {passwordUser && (
        <AdminPasswordModal
          user={passwordUser}
          onClose={() => setPasswordUser(null)}
          onSuccess={() => {
            setPasswordUser(null);
            setMessage('');
            setNotice(`Parola utilizatorului ${passwordUser.name} a fost schimbată.`);
          }}
        />
      )}
    </div>
  );
}

function AccountingSettings({
  onMessage,
  canEditTemplates,
}: {
  onMessage: (message: string) => void;
  canEditTemplates: boolean;
}) {
  const {
    data: company,
    isLoading: loadingCompany,
    error: companyError,
    refetch: refetchCompany,
  } = useCompanyQuery();
  const [updateCompany, { isLoading: savingCompany }] =
    useUpdateCompanyMutation();
  const [loadCompanyFromAnaf, { isFetching: loadingCompanyFromAnaf }] =
    useLazyCompanyFromAnafQuery();
  const [tab, setTab] = useState<
    'company' | 'contracts' | 'partners' | 'articles' | 'managements'
  >('company');
  const [form, setForm] = useState<Record<string, any>>({});
  const [anafMessage, setAnafMessage] = useState('');

  useEffect(() => {
    if (company) {
      setForm({
        name: company.name ?? '',
        cui: company.cui ?? '',
        registrationNumber: company.registrationNumber ?? '',
        address: company.address ?? '',
        country: company.country ?? 'RO',
        county: company.county ?? '',
        city: company.city ?? '',
        iban: company.iban ?? '',
        bankName: company.bankName ?? '',
        email: company.email ?? '',
        phone: company.phone ?? '',
        defaultCurrency: company.defaultCurrency ?? 'RON',
        isVatPayer: company.isVatPayer ?? true,
        hasTvaLaIncasare: company.hasTvaLaIncasare ?? false,
      });
    }
  }, [company]);

  const saveCompany = async (event: FormEvent) => {
    event.preventDefault();
    onMessage('');
    try {
      await updateCompany(form).unwrap();
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };

  const importCompanyFromAnaf = async () => {
    onMessage('');
    setAnafMessage('');
    const cui = String(form.cui ?? '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/^RO/i, '');

    if (!/^\d{2,10}$/.test(cui)) {
      onMessage(
        'CUI invalid. Folosește între 2 și 10 cifre, opțional cu prefixul RO.',
      );
      return;
    }

    const requestId = createRequestId();
    const endpoint = apiUrl(
      `/accounting/company/anaf/${encodeURIComponent(cui)}`,
    );
    const startedAt = performance.now();
    console.info('[ANAF company import] request started', {
      requestId,
      cui,
      endpoint,
      timestamp: new Date().toISOString(),
    });

    try {
      const details = await loadCompanyFromAnaf({ cui, requestId }).unwrap();
      console.info('[ANAF company import] request succeeded', {
        requestId,
        cui,
        endpoint,
        durationMs: Math.round(performance.now() - startedAt),
        returnedFields: Object.entries(details)
          .filter(([, value]) => value !== null && value !== '')
          .map(([key]) => key),
      });
      setForm((current) => ({
        ...current,
        cui: details.cui ?? cui,
        name: details.name || current.name,
        registrationNumber:
          details.registrationNumber || current.registrationNumber,
        address: details.address || current.address,
        country: details.country || current.country,
        county: details.county || current.county,
        city: details.city || current.city,
        iban: details.iban || current.iban,
        email: details.email || current.email,
        phone: details.phone || current.phone,
        ...(typeof details.isVatPayer === 'boolean'
          ? { isVatPayer: details.isVatPayer }
          : {}),
        ...(typeof details.hasTvaLaIncasare === 'boolean'
          ? { hasTvaLaIncasare: details.hasTvaLaIncasare }
          : {}),
      }));
      setAnafMessage(
        'Datele disponibile au fost preluate din ANAF. Verifică-le, apoi salvează compania.',
      );
    } catch (error: any) {
      console.error('[ANAF company import] request failed', {
        requestId,
        cui,
        endpoint,
        durationMs: Math.round(performance.now() - startedAt),
        status: error?.status,
        originalStatus: error?.originalStatus,
        response: compactErrorData(error?.data),
        errorMessage: error?.error ?? error?.message ?? null,
        rawError: error,
      });
      onMessage(`${apiError(error)} · ID diagnostic: ${requestId}`);
    }
  };

  const tabs = [
    ['company', 'Companie & SAGA'],
    ['contracts', 'Contracte PDF'],
    ['partners', 'Parteneri'],
    ['articles', 'Articole'],
    ['managements', 'Gestiuni'],
  ] as const;

  return (
    <section className="mt-5 overflow-hidden rounded-card border border-line bg-white">
      <div className="flex overflow-x-auto border-b border-line">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-semibold ${
              tab === value
                ? 'border-brand text-brand'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'company' && loadingCompany && (
        <p className="p-5 text-sm text-muted">Se încarcă datele companiei…</p>
      )}
      {tab === 'company' && companyError && (
        <div className="m-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-semibold">Datele companiei nu au putut fi încărcate.</p>
          <p className="mt-1">{apiError(companyError)}</p>
          <button
            type="button"
            onClick={() => refetchCompany()}
            className="mt-3 rounded-control border border-red-300 bg-white px-3 py-2 font-semibold hover:bg-red-100"
          >
            Reîncearcă
          </button>
        </div>
      )}
      {tab === 'company' && company && (
        <form onSubmit={saveCompany} className="p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Denumire firmă" value={form.name} onChange={(name) => setForm({ ...form, name })} required />
            <label className="text-xs font-medium text-muted">
              CUI / CIF
              <div className="mt-1 flex gap-2">
                <input
                  aria-label="CUI / CIF"
                  required
                  value={form.cui ?? ''}
                  onChange={(event) => {
                    setForm({ ...form, cui: event.target.value });
                    setAnafMessage('');
                  }}
                  className={`min-w-0 flex-1 ${fieldClass}`}
                />
                <button
                  type="button"
                  onClick={importCompanyFromAnaf}
                  disabled={loadingCompanyFromAnaf}
                  className="shrink-0 rounded-control border border-brand px-3 py-2 text-sm font-semibold text-brand hover:bg-blue-50 disabled:opacity-50"
                >
                  {loadingCompanyFromAnaf ? 'Se caută…' : 'Importă ANAF'}
                </button>
              </div>
            </label>
            <Field label="Nr. registrul comerțului" value={form.registrationNumber} onChange={(registrationNumber) => setForm({ ...form, registrationNumber })} />
            <Field label="Țară" value={form.country} onChange={(country) => setForm({ ...form, country })} />
            <Field label="Județ" value={form.county} onChange={(county) => setForm({ ...form, county })} />
            <Field label="Localitate" value={form.city} onChange={(city) => setForm({ ...form, city })} />
            <Field label="Adresă" value={form.address} onChange={(address) => setForm({ ...form, address })} className="sm:col-span-2" />
            <Field label="IBAN" value={form.iban} onChange={(iban) => setForm({ ...form, iban })} />
            <Field label="Bancă" value={form.bankName} onChange={(bankName) => setForm({ ...form, bankName })} />
            <Field label="Email" value={form.email} onChange={(email) => setForm({ ...form, email })} type="email" />
            <Field label="Telefon" value={form.phone} onChange={(phone) => setForm({ ...form, phone })} />
            <Field label="Monedă implicită" value={form.defaultCurrency} onChange={(defaultCurrency) => setForm({ ...form, defaultCurrency })} />
          </div>
          {anafMessage && (
            <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {anafMessage}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-5">
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(form.isVatPayer)}
                onChange={(event) => setForm({ ...form, isVatPayer: event.target.checked })}
              />
              Firmă plătitoare de TVA
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={Boolean(form.hasTvaLaIncasare)}
                onChange={(event) => setForm({ ...form, hasTvaLaIncasare: event.target.checked })}
              />
              TVA la încasare
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-xs text-muted">
              Data activării contabilității: {company?.accountingCutoverAt ? new Date(company.accountingCutoverAt).toLocaleString('ro-RO') : '—'}.
              Documentele anterioare rămân istorice.
            </p>
            <button
              disabled={savingCompany}
              className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {savingCompany ? 'Se salvează…' : 'Salvează compania'}
            </button>
          </div>
        </form>
      )}
      {tab === 'contracts' && (
        <ContractTemplatesSettings
          canEdit={canEditTemplates}
          onError={onMessage}
        />
      )}
      {tab === 'partners' && <PartnersCatalogue onMessage={onMessage} />}
      {tab === 'articles' && <ArticlesCatalogue onMessage={onMessage} />}
      {tab === 'managements' && <ManagementsCatalogue onMessage={onMessage} />}
    </section>
  );
}

function ContractTemplatesSettings({
  canEdit,
  onError,
}: {
  canEdit: boolean;
  onError: (message: string) => void;
}) {
  const { data, isLoading, error } = useContractTemplatesQuery();
  const [updateTemplates, { isLoading: saving }] =
    useUpdateContractTemplatesMutation();
  const [previewTemplate, { isLoading: previewing }] =
    usePreviewContractTemplateMutation();
  const [kind, setKind] = useState<'sale' | 'handover'>('sale');
  const [sale, setSale] = useState('');
  const [handover, setHandover] = useState('');
  const [status, setStatus] = useState<{
    tone: 'success' | 'error';
    text: string;
  }>();
  const [pdfPreview, setPdfPreview] = useState<{
    url: string;
    kind: 'sale' | 'handover';
    source: string;
  }>();
  const [placeholderSearch, setPlaceholderSearch] = useState('');
  const [placeholderGroup, setPlaceholderGroup] = useState('all');
  const [showFormattingHelp, setShowFormattingHelp] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!data) return;
    setSale(data.templates.sale);
    setHandover(data.templates.handover);
  }, [data]);

  useEffect(
    () => () => {
      if (pdfPreview?.url) URL.revokeObjectURL(pdfPreview.url);
    },
    [pdfPreview?.url],
  );

  const activeTemplate = kind === 'sale' ? sale : handover;
  const setActiveTemplate = (value: string) => {
    setStatus(undefined);
    if (kind === 'sale') setSale(value);
    else setHandover(value);
  };
  const documentKind =
    kind === 'sale' ? 'vanzare-cumparare' : 'proces-verbal';
  const saleDirty = Boolean(data && sale !== data.templates.sale);
  const handoverDirty = Boolean(data && handover !== data.templates.handover);
  const dirtyCount = Number(saleDirty) + Number(handoverDirty);

  const placeholderGroups = [
    { id: 'all', label: 'Toate' },
    { id: 'blocks', label: 'Blocuri' },
    { id: 'document', label: 'Document' },
    { id: 'seller', label: 'Vânzător' },
    { id: 'buyer', label: 'Cumpărător' },
    { id: 'vehicle', label: 'Vehicul' },
    { id: 'price', label: 'Preț' },
  ];

  const visiblePlaceholders = useMemo(() => {
    if (!data) return [];
    const search = placeholderSearch.trim().toLocaleLowerCase('ro-RO');
    return data.placeholders.filter((placeholder: any) => {
      const group = contractPlaceholderGroup(placeholder);
      const inGroup = placeholderGroup === 'all' || placeholderGroup === group;
      const matchesSearch =
        !search ||
        placeholder.label.toLocaleLowerCase('ro-RO').includes(search) ||
        placeholder.token.toLocaleLowerCase('ro-RO').includes(search);
      return inGroup && matchesSearch;
    });
  }, [data, placeholderGroup, placeholderSearch]);

  const saleValidation = useMemo(
    () => contractTemplateValidation(sale, data?.placeholders ?? []),
    [data?.placeholders, sale],
  );
  const handoverValidation = useMemo(
    () => contractTemplateValidation(handover, data?.placeholders ?? []),
    [data?.placeholders, handover],
  );
  const activeValidation = kind === 'sale' ? saleValidation : handoverValidation;
  const hasValidationErrors =
    saleValidation.errors.length > 0 || handoverValidation.errors.length > 0;
  const activeDirty = kind === 'sale' ? saleDirty : handoverDirty;
  const activeCustomized = Boolean(
    data && activeTemplate !== data.defaults[kind],
  );
  const previewIsCurrent = Boolean(
    pdfPreview &&
      pdfPreview.kind === kind &&
      pdfPreview.source === activeTemplate,
  );
  const outline = useMemo(
    () =>
      Array.from(activeTemplate.matchAll(/^##\s+(.+)$/gm)).map((match) => ({
        label: match[1],
        position: match.index ?? 0,
      })),
    [activeTemplate],
  );

  const save = async () => {
    onError('');
    setStatus(undefined);
    if (hasValidationErrors) {
      setStatus({
        tone: 'error',
        text: 'Corectează erorile semnalate înainte de salvare.',
      });
      return;
    }
    try {
      await updateTemplates({ sale, handover }).unwrap();
      setStatus({
        tone: 'success',
        text: 'Șabloanele au fost salvate. Se aplică automat documentelor noi; pentru un document existent folosește „Regenerează PDF” din fișa vehiculului.',
      });
    } catch (requestError: any) {
      setStatus({ tone: 'error', text: apiError(requestError) });
    }
  };

  const preview = async () => {
    onError('');
    setStatus(undefined);
    try {
      const result = await previewTemplate({
        kind: documentKind,
        template: activeTemplate,
      }).unwrap();
      const bytes = Uint8Array.from(atob(result.data), (character) =>
        character.charCodeAt(0),
      );
      const nextUrl = URL.createObjectURL(
        new Blob([bytes], { type: result.contentType }),
      );
      setPdfPreview({ url: nextUrl, kind, source: activeTemplate });
    } catch (requestError: any) {
      setStatus({ tone: 'error', text: apiError(requestError) });
    }
  };

  const replaceEditorSelection = (
    replacement: (before: string, selected: string, after: string) => {
      text: string;
      selectionStart: number;
      selectionEnd: number;
    },
  ) => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const result = replacement(
      activeTemplate.slice(0, start),
      activeTemplate.slice(start, end),
      activeTemplate.slice(end),
    );
    setActiveTemplate(result.text);
    requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  const insertPlaceholder = (placeholder: any) => {
    const { token, block } = placeholder;
    const editor = editorRef.current;
    if (!editor) {
      setActiveTemplate(`${activeTemplate}${block ? `\n${token}\n` : token}`);
      return;
    }
    replaceEditorSelection((before, _selected, after) => {
      const prefix = block && before && !before.endsWith('\n') ? '\n' : '';
      const suffix = block && after && !after.startsWith('\n') ? '\n' : '';
      const insertion = `${prefix}${token}${suffix}`;
      const cursor = before.length + insertion.length;
      return {
        text: `${before}${insertion}${after}`,
        selectionStart: cursor,
        selectionEnd: cursor,
      };
    });
  };

  const formatSelectedLines = (prefix: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;
    const lineStart = activeTemplate.lastIndexOf('\n', selectionStart - 1) + 1;
    const nextLine = activeTemplate.indexOf('\n', selectionEnd);
    const lineEnd = nextLine === -1 ? activeTemplate.length : nextLine;
    const selectedLines = activeTemplate.slice(lineStart, lineEnd);
    const formatted = selectedLines
      .split('\n')
      .map((line) => {
        const content = line.replace(/^(?:#{1,2}|>|-)\s+/, '');
        return `${prefix}${content}`;
      })
      .join('\n');
    const next = `${activeTemplate.slice(0, lineStart)}${formatted}${activeTemplate.slice(lineEnd)}`;
    setActiveTemplate(next);
    requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(lineStart, lineStart + formatted.length);
    });
  };

  const insertStandaloneLine = (value: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    replaceEditorSelection((before, _selected, after) => {
      const prefix = before && !before.endsWith('\n') ? '\n' : '';
      const suffix = after && !after.startsWith('\n') ? '\n' : '';
      const insertion = `${prefix}${value}${suffix}`;
      const cursor = before.length + insertion.length;
      return {
        text: `${before}${insertion}${after}`,
        selectionStart: cursor,
        selectionEnd: cursor,
      };
    });
  };

  const changeKind = (nextKind: 'sale' | 'handover') => {
    setKind(nextKind);
    setConfirmReset(false);
    setStatus(undefined);
    setPlaceholderSearch('');
  };

  const jumpToOutline = (position: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    editor.setSelectionRange(position, position);
    const line = activeTemplate.slice(0, position).split('\n').length;
    const lineHeight = 20;
    editor.scrollTop = Math.max(0, line * lineHeight - 80);
  };

  if (isLoading) {
    return <p className="p-5 text-sm text-muted">Se încarcă șabloanele…</p>;
  }
  if (error || !data) {
    return (
      <div className="m-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Șabloanele contractelor nu au putut fi încărcate: {apiError(error)}
      </div>
    );
  }

  const documentOptions = [
    {
      id: 'sale' as const,
      short: 'CV',
      title: 'Contract de vânzare',
      description: 'Clauze, părți, preț și semnături',
      value: sale,
      dirty: saleDirty,
    },
    {
      id: 'handover' as const,
      short: 'PV',
      title: 'Proces-verbal',
      description: 'Predarea vehiculului și documentelor',
      value: handover,
      dirty: handoverDirty,
    },
  ];

  return (
    <div>
      <div className="border-b border-line bg-slate-50/60 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-xs font-bold text-white">
                1
              </span>
              <h3 className="font-semibold text-ink">Alege documentul</h3>
            </div>
            <p className="ml-9 mt-1 max-w-3xl text-sm text-muted">
              Configurează o singură dată textele folosite la toate vânzările viitoare.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {dirtyCount > 0 && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
                {dirtyCount === 1
                  ? '1 document nesalvat'
                  : '2 documente nesalvate'}
              </span>
            )}
            {!canEdit && (
              <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                Mod doar citire
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {documentOptions.map((option) => {
            const selected = option.id === kind;
            const customized = option.value !== data.defaults[option.id];
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => changeKind(option.id)}
                className={`flex items-center gap-3 rounded-xl border p-3.5 text-left transition ${
                  selected
                    ? 'border-brand bg-white shadow-sm ring-1 ring-brand/15'
                    : 'border-line-strong bg-white/70 hover:border-slate-300 hover:bg-white'
                }`}
              >
                <span
                  className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-extrabold ${
                    selected ? 'bg-brand text-white' : 'bg-slate-100 text-ink-soft'
                  }`}
                >
                  {option.short}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">
                    {option.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {option.description}
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${
                    option.dirty
                      ? 'bg-amber-100 text-amber-800'
                      : customized
                        ? 'bg-blue-50 text-brand'
                        : 'bg-slate-100 text-muted'
                  }`}
                >
                  {option.dirty
                    ? 'Nesalvat'
                    : customized
                      ? 'Personalizat'
                      : 'Standard'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-5">
        <div className="grid gap-5 xl:grid-cols-[minmax(560px,1.08fr)_minmax(400px,0.92fr)]">
          <div className="min-w-0 space-y-4">
            <section className="overflow-hidden rounded-card border border-line-strong bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-[11px] font-bold text-white">
                      2
                    </span>
                    <h4 className="text-sm font-semibold text-ink">Editează conținutul</h4>
                    {activeDirty && (
                      <span className="h-2 w-2 rounded-full bg-amber-500" title="Modificări nesalvate" />
                    )}
                  </div>
                  <p className="ml-8 mt-0.5 text-xs text-muted">
                    {activeCustomized ? 'Șablon personalizat' : 'Șablon standard'} ·{' '}
                    {activeTemplate.split('\n').length} rânduri ·{' '}
                    {activeTemplate.length.toLocaleString('ro-RO')} caractere
                  </p>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    {confirmReset && (
                      <button
                        type="button"
                        onClick={() => setConfirmReset(false)}
                        className="rounded-control px-2.5 py-1.5 text-xs font-semibold text-muted hover:bg-slate-100"
                      >
                        Renunță
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!activeCustomized && !activeDirty}
                      onClick={() => {
                        if (!confirmReset) {
                          setConfirmReset(true);
                          return;
                        }
                        setActiveTemplate(data.defaults[kind]);
                        setConfirmReset(false);
                      }}
                      className={`rounded-control border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
                        confirmReset
                          ? 'border-red-300 bg-red-50 text-red-700'
                          : 'border-line-strong text-ink-soft hover:bg-slate-50'
                      }`}
                    >
                      {confirmReset ? 'Confirmă resetarea' : 'Revino la standard'}
                    </button>
                  </div>
                )}
              </div>

              {canEdit && (
                <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-slate-50 px-3 py-2">
                  <span className="mr-1 shrink-0 text-[10px] font-bold uppercase tracking-wider text-muted-2">
                    Formatare
                  </span>
                  {[
                    ['Titlu', '# ', 'Titlu principal'],
                    ['Secțiune', '## ', 'Titlu de secțiune'],
                    ['Centrat', '> ', 'Text centrat'],
                    ['Listă', '- ', 'Element de listă'],
                  ].map(([label, prefix, title]) => (
                    <button
                      key={label}
                      type="button"
                      title={title}
                      onClick={() => formatSelectedLines(prefix)}
                      className="shrink-0 rounded-md border border-line-strong bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:border-brand hover:text-brand"
                    >
                      {label}
                    </button>
                  ))}
                  <span className="mx-1 h-5 w-px shrink-0 bg-line-strong" />
                  <button
                    type="button"
                    onClick={() => insertStandaloneLine('---')}
                    className="shrink-0 rounded-md border border-line-strong bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:border-brand hover:text-brand"
                  >
                    Linie
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      insertPlaceholder({ token: '{{page_break}}', block: true })
                    }
                    className="shrink-0 rounded-md border border-line-strong bg-white px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:border-brand hover:text-brand"
                  >
                    Pagină nouă
                  </button>
                  <button
                    type="button"
                    aria-expanded={showFormattingHelp}
                    onClick={() => setShowFormattingHelp(!showFormattingHelp)}
                    className="ml-auto shrink-0 rounded-md px-2 py-1.5 text-xs font-semibold text-brand hover:bg-blue-50"
                  >
                    Ajutor
                  </button>
                </div>
              )}

              {showFormattingHelp && (
                <div className="border-b border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
                  Selectează unul sau mai multe rânduri și aplică formatarea din bara de mai sus.
                  Câmpurile automate sunt completate cu datele vânzării, iar blocurile trebuie să
                  rămână singure pe rând.
                </div>
              )}

              {outline.length > 0 && (
                <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-3 py-2">
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-muted-2">
                    Cuprins
                  </span>
                  {outline.map((section) => (
                    <button
                      key={`${section.position}-${section.label}`}
                      type="button"
                      onClick={() => jumpToOutline(section.position)}
                      className="max-w-[190px] shrink-0 truncate rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:bg-blue-50 hover:text-brand"
                      title={section.label}
                    >
                      {section.label.replace(/^\w+\.\s*/, '')}
                    </button>
                  ))}
                </div>
              )}

              <textarea
                ref={editorRef}
                id="contract-template-editor"
                aria-label={kind === 'sale' ? 'Șablon contract vânzare' : 'Șablon proces-verbal'}
                value={activeTemplate}
                readOnly={!canEdit}
                onChange={(event) => setActiveTemplate(event.target.value)}
                onKeyDown={(event) => {
                  if (canEdit && (event.metaKey || event.ctrlKey) && event.key === 's') {
                    event.preventDefault();
                    void save();
                  }
                }}
                spellCheck
                className="min-h-[590px] w-full resize-y border-0 bg-white p-5 font-mono text-[12px] leading-5 text-ink outline-none focus:bg-blue-50/10 read-only:bg-slate-50"
              />

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-slate-50 px-4 py-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      activeValidation.errors.length > 0
                        ? 'bg-red-500'
                        : activeValidation.warnings.length > 0
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                    }`}
                  />
                  <span className="font-semibold text-ink-soft">
                    {activeValidation.errors.length > 0
                      ? `${activeValidation.errors.length} ${activeValidation.errors.length === 1 ? 'eroare' : 'erori'}`
                      : activeValidation.warnings.length > 0
                        ? `${activeValidation.warnings.length} atenționări`
                        : 'Șablon gata de generare'}
                  </span>
                </div>
                <span className="text-[11px] text-muted">⌘S / Ctrl+S pentru salvare</span>
              </div>
            </section>

            {(activeValidation.errors.length > 0 ||
              activeValidation.warnings.length > 0) && (
              <section
                className={`rounded-xl border p-3 ${
                  activeValidation.errors.length > 0
                    ? 'border-red-200 bg-red-50'
                    : 'border-amber-200 bg-amber-50'
                }`}
              >
                <p
                  className={`text-xs font-semibold ${
                    activeValidation.errors.length > 0 ? 'text-red-800' : 'text-amber-800'
                  }`}
                >
                  Verificare șablon
                </p>
                <ul
                  className={`mt-1.5 space-y-1 text-xs ${
                    activeValidation.errors.length > 0 ? 'text-red-700' : 'text-amber-700'
                  }`}
                >
                  {[...activeValidation.errors, ...activeValidation.warnings].map((issue) => (
                    <li key={issue}>• {issue}</li>
                  ))}
                </ul>
              </section>
            )}

            {canEdit && (
              <section className="rounded-card border border-line-strong bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-ink">Câmpuri automate</h4>
                    <p className="mt-0.5 text-xs text-muted">
                      Apasă pe un câmp pentru a-l insera la poziția cursorului.
                    </p>
                  </div>
                  <input
                    type="search"
                    aria-label="Caută câmpuri automate"
                    placeholder="Caută nume, VIN, preț…"
                    value={placeholderSearch}
                    onChange={(event) => setPlaceholderSearch(event.target.value)}
                    className="w-full rounded-control border border-line-strong px-3 py-2 text-xs text-ink outline-none focus:border-brand sm:w-60"
                  />
                </div>
                <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
                  {placeholderGroups.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => setPlaceholderGroup(group.id)}
                      className={`shrink-0 rounded-full px-2.5 py-1.5 text-[11px] font-semibold ${
                        placeholderGroup === group.id
                          ? 'bg-brand text-white'
                          : 'bg-slate-100 text-ink-soft hover:bg-slate-200'
                      }`}
                    >
                      {group.label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2">
                  {visiblePlaceholders.map((placeholder: any) => (
                    <button
                      key={placeholder.token}
                      type="button"
                      onClick={() => insertPlaceholder(placeholder)}
                      className="group flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2 text-left hover:border-brand hover:bg-blue-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-ink-soft group-hover:text-brand">
                          {placeholder.label}
                        </span>
                        <code className="mt-0.5 block truncate text-[9px] text-muted">
                          {placeholder.token}
                        </code>
                      </span>
                      {placeholder.block && (
                        <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted">
                          bloc
                        </span>
                      )}
                    </button>
                  ))}
                  {visiblePlaceholders.length === 0 && (
                    <p className="col-span-full rounded-lg bg-slate-50 p-4 text-center text-xs text-muted">
                      Nu am găsit niciun câmp pentru această căutare.
                    </p>
                  )}
                </div>
              </section>
            )}
          </div>

          <section className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            <div className="overflow-hidden rounded-card border border-line-strong bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-brand text-[11px] font-bold text-white">
                      3
                    </span>
                    <h4 className="text-sm font-semibold text-ink">Verifică documentul</h4>
                  </div>
                  <p className="ml-8 mt-0.5 text-xs text-muted">
                    Vezi documentul exact așa cum îl va primi clientul.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {pdfPreview?.url && pdfPreview.kind === kind && (
                    <a
                      href={pdfPreview.url}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-control px-2.5 py-2 text-xs font-semibold text-ink-soft hover:bg-slate-100"
                    >
                      Deschide separat
                    </a>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      aria-label="Previzualizează PDF"
                      onClick={preview}
                      disabled={
                        previewing ||
                        !activeTemplate.trim() ||
                        activeValidation.errors.length > 0
                      }
                      className="rounded-control bg-brand px-3.5 py-2 text-xs font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {previewing
                        ? 'Se generează…'
                        : pdfPreview?.kind === kind
                          ? 'Actualizează PDF'
                          : 'Previzualizează PDF'}
                    </button>
                  )}
                </div>
              </div>

              {pdfPreview?.url && pdfPreview.kind === kind ? (
                <div className="relative bg-slate-100 p-2">
                  {!previewIsCurrent && (
                    <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <span>Previzualizarea nu include ultimele modificări.</span>
                      <button
                        type="button"
                        onClick={preview}
                        className="shrink-0 font-semibold underline underline-offset-2"
                      >
                        Actualizează
                      </button>
                    </div>
                  )}
                  <iframe
                    title="Previzualizare șablon PDF"
                    src={pdfPreview.url}
                    className="h-[760px] w-full rounded-lg border border-line bg-white"
                  />
                </div>
              ) : (
                <div className="flex h-[520px] flex-col items-center justify-center bg-slate-50 p-8 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line-strong bg-white text-sm font-extrabold text-brand shadow-sm">
                    PDF
                  </div>
                  <p className="mt-4 text-sm font-semibold text-ink">Documentul este gata de verificat</p>
                  <p className="mt-1 max-w-xs text-xs leading-5 text-muted">
                    Generează o previzualizare cu date demonstrative pentru a verifica textul,
                    diacriticele, paginarea și semnăturile.
                  </p>
                  <p className="mt-4 text-[11px] font-medium text-brand">
                    {canEdit
                      ? 'Folosește butonul „Previzualizează PDF” de mai sus.'
                      : 'Doar contabilul poate genera o previzualizare.'}
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>

        {status && (
          <p
            className={`mt-4 rounded-xl px-4 py-3 text-sm ${
              status.tone === 'success'
                ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {status.text}
          </p>
        )}

        {canEdit && (
          <div className="sticky bottom-3 z-10 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line-strong bg-white/95 p-3 shadow-lg shadow-slate-900/10 backdrop-blur">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">
                {dirtyCount === 0
                  ? 'Toate modificările sunt salvate'
                  : dirtyCount === 1
                    ? 'Ai modificări nesalvate într-un document'
                    : 'Ai modificări nesalvate în ambele documente'}
              </p>
              <p className="text-xs text-muted">
                Salvarea se aplică documentelor generate de acum înainte.
              </p>
            </div>
            <button
              type="button"
              onClick={save}
              disabled={
                saving ||
                dirtyCount === 0 ||
                hasValidationErrors ||
                !sale.trim() ||
                !handover.trim()
              }
              className="rounded-control bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Se salvează…' : 'Salvează modificările'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function contractPlaceholderGroup(placeholder: {
  token: string;
  block?: boolean;
}) {
  if (placeholder.block) return 'blocks';
  if (placeholder.token.startsWith('{{seller_')) return 'seller';
  if (placeholder.token.startsWith('{{buyer_')) return 'buyer';
  if (placeholder.token.startsWith('{{vehicle_')) return 'vehicle';
  if (
    placeholder.token.startsWith('{{price_') ||
    placeholder.token === '{{currency}}'
  ) {
    return 'price';
  }
  return 'document';
}

function contractTemplateValidation(
  template: string,
  placeholders: Array<{ token: string; label: string; block?: boolean }>,
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowed = new Set(placeholders.map(({ token }) => token));

  if (!template.trim()) errors.push('Documentul nu poate fi gol.');
  if (template.length > 30_000) {
    errors.push('Documentul depășește limita de 30.000 de caractere.');
  }

  const unknown = new Set<string>();
  for (const match of template.matchAll(/{{([^{}]+)}}/g)) {
    const token = `{{${match[1].trim()}}}`;
    if (!allowed.has(token)) unknown.add(token);
  }
  if (unknown.size > 0) {
    errors.push(`Câmpuri necunoscute: ${[...unknown].join(', ')}.`);
  }

  const misplacedBlocks = new Set<string>();
  for (const line of template.split('\n')) {
    for (const placeholder of placeholders) {
      if (
        placeholder.block &&
        line.includes(placeholder.token) &&
        line.trim() !== placeholder.token
      ) {
        misplacedBlocks.add(placeholder.token);
      }
    }
  }
  if (misplacedBlocks.size > 0) {
    errors.push(
      `Aceste blocuri trebuie să fie singure pe rând: ${[
        ...misplacedBlocks,
      ].join(', ')}.`,
    );
  }

  if (!template.includes('{{vehicle_details}}')) {
    warnings.push('Lipsește tabelul cu detaliile vehiculului.');
  }
  if (!template.includes('{{signature_block}}')) {
    warnings.push('Lipsește blocul pentru semnăturile părților.');
  }
  if (!template.includes('{{contract_number}}')) {
    warnings.push('Numărul documentului nu va apărea în PDF.');
  }

  return { errors, warnings };
}

function PartnersCatalogue({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) {
  const { data: parties = [] } = usePartiesQuery();
  const [createParty, { isLoading }] = useCreatePartyMutation();
  const [updateParty] = useUpdatePartyMutation();
  const [importParties] = useImportPartiesMutation();
  const empty = {
    kind: 'COMPANY',
    name: '',
    taxId: '',
    country: 'RO',
    isSupplier: true,
    isClient: false,
    supplierAnalytic: '',
    clientAnalytic: '',
  };
  const [form, setForm] = useState(empty);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await createParty(form).unwrap();
      setForm(empty);
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };
  return (
    <div className="p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <CsvImport
          label="Importă furnizori (CSV/XML SAGA)"
          hint="Reimportul completează numărul de identificare după codul SAGA, fără duplicate."
          onImport={(file) => importParties({ file, role: 'supplier' }).unwrap()}
          onMessage={onMessage}
        />
        <CsvImport
          label="Importă clienți (CSV/XML SAGA)"
          hint="Coloane: cod, denumire, număr de identificare, analitic, adresă, IBAN…"
          onImport={(file) => importParties({ file, role: 'client' }).unwrap()}
          onMessage={onMessage}
        />
      </div>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <select
          aria-label="Tip partener"
          className={fieldClass}
          value={form.kind}
          onChange={(event) => setForm({ ...form, kind: event.target.value })}
        >
          <option value="COMPANY">Companie</option>
          <option value="INDIVIDUAL">Persoană fizică</option>
        </select>
        <input className={fieldClass} placeholder="Denumire partener" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input
          aria-label="Număr de identificare"
          className={fieldClass}
          placeholder="CUI / CNP / ID extern"
          required={form.kind === 'INDIVIDUAL' && form.isSupplier}
          value={form.taxId}
          onChange={(event) => setForm({ ...form, taxId: event.target.value })}
        />
        <input
          aria-label="Țară partener"
          className={fieldClass}
          placeholder="Țară (ISO)"
          maxLength={2}
          required
          value={form.country}
          onChange={(event) =>
            setForm({ ...form, country: event.target.value.toUpperCase() })
          }
        />
        <input className={fieldClass} placeholder="Analitic furnizor (401.x)" value={form.supplierAnalytic} onChange={(event) => setForm({ ...form, supplierAnalytic: event.target.value })} />
        <input className={fieldClass} placeholder="Analitic client (411.x)" value={form.clientAnalytic} onChange={(event) => setForm({ ...form, clientAnalytic: event.target.value })} />
        <div className="flex items-center gap-4 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={form.isSupplier} onChange={(event) => setForm({ ...form, isSupplier: event.target.checked })} /> Furnizor
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={form.isClient} onChange={(event) => setForm({ ...form, isClient: event.target.checked })} /> Client
          </label>
        </div>
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Adaugă partener
        </button>
      </form>
      <div className="mt-4 divide-y divide-line rounded-xl border border-line">
        {parties.map((party: any) => (
          <PartyRow
            key={party.id}
            party={party}
            onSave={(body) => updateParty({ id: party.id, body }).unwrap()}
          />
        ))}
        {parties.length === 0 && <p className="p-4 text-sm text-muted">Catalogul este gol.</p>}
      </div>
    </div>
  );
}

function PartyRow({
  party,
  onSave,
}: {
  party: any;
  onSave: (body: any) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState({
    kind: party.kind ?? 'COMPANY',
    taxId: party.taxId ?? '',
    country: party.country ?? 'RO',
    isSupplier: party.isSupplier,
    isClient: party.isClient,
    supplierAnalytic: party.supplierAnalytic ?? '',
    clientAnalytic: party.clientAnalytic ?? '',
  });
  const [saving, setSaving] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-44 flex-1">
        <p className="text-sm font-semibold text-ink">{party.name}</p>
        <p className="text-xs text-muted">
          {party.kind === 'INDIVIDUAL' ? 'Persoană fizică' : 'Companie'} ·{' '}
          Nr. identificare: {party.taxId || 'Lipsă'}
        </p>
      </div>
      <select
        aria-label={`Tip partener ${party.name}`}
        className={`${fieldClass} w-36`}
        value={draft.kind}
        onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
      >
        <option value="COMPANY">Companie</option>
        <option value="INDIVIDUAL">Persoană fizică</option>
      </select>
      <input
        aria-label={`Țară ${party.name}`}
        className={`${fieldClass} w-20`}
        maxLength={2}
        value={draft.country}
        onChange={(event) =>
          setDraft({ ...draft, country: event.target.value.toUpperCase() })
        }
      />
      <input
        aria-label={`Număr de identificare ${party.name}`}
        className={`${fieldClass} w-40`}
        placeholder="CUI / CNP / ID extern"
        value={draft.taxId}
        onChange={(event) => setDraft({ ...draft, taxId: event.target.value })}
      />
      <label className="flex items-center gap-1 text-xs text-muted">
        <input type="checkbox" checked={draft.isSupplier} onChange={(event) => setDraft({ ...draft, isSupplier: event.target.checked })} /> Furnizor
      </label>
      <label className="flex items-center gap-1 text-xs text-muted">
        <input type="checkbox" checked={draft.isClient} onChange={(event) => setDraft({ ...draft, isClient: event.target.checked })} /> Client
      </label>
      <input className={`${fieldClass} w-32`} placeholder="401.x" value={draft.supplierAnalytic} onChange={(event) => setDraft({ ...draft, supplierAnalytic: event.target.value })} />
      <input className={`${fieldClass} w-32`} placeholder="411.x" value={draft.clientAnalytic} onChange={(event) => setDraft({ ...draft, clientAnalytic: event.target.value })} />
      <button
        onClick={async () => {
          setSaving(true);
          try {
            await onSave(draft);
          } finally {
            setSaving(false);
          }
        }}
        className="rounded-control border border-line-strong px-3 py-2 text-xs font-semibold text-ink-soft disabled:opacity-50"
        disabled={saving}
      >
        {saving ? 'Se salvează…' : 'Salvează'}
      </button>
    </div>
  );
}

function ArticlesCatalogue({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) {
  const { data: articles = [] } = useArticlesQuery();
  const [create, { isLoading }] = useCreateArticleMutation();
  const [importArticles] = useImportArticlesMutation();
  const empty = {
    code: '',
    name: '',
    analyticCode: '',
    vatRate: 'TWENTYONE',
    unit: 'BUCATA',
    type: 'MARFURI',
    accountCode: '371',
  };
  const [form, setForm] = useState(empty);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await create(form).unwrap();
      setForm(empty);
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };
  return (
    <div className="p-5">
      <CsvImport
        label="Importă articole (CSV)"
        hint="Coloane: cod, denumire, um, tva, den_tip, analitic, cont"
        onImport={(file) => importArticles(file).unwrap()}
        onMessage={onMessage}
      />
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input className={fieldClass} placeholder="Cod intern" required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        <input className={fieldClass} placeholder="Denumire" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input className={fieldClass} placeholder="Cod analitic SAGA" value={form.analyticCode} onChange={(event) => setForm({ ...form, analyticCode: event.target.value })} />
        <input className={fieldClass} placeholder="Cont" value={form.accountCode} onChange={(event) => setForm({ ...form, accountCode: event.target.value })} />
        <select className={fieldClass} value={form.vatRate} onChange={(event) => setForm({ ...form, vatRate: event.target.value })}>
          {Object.entries(VAT_RATE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>TVA {label}</option>
          ))}
        </select>
        <input className={fieldClass} placeholder="UM" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} />
        <input className={fieldClass} placeholder="Tip SAGA" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} />
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Adaugă articol</button>
      </form>
      <CatalogueTable
        columns={['Cod', 'Denumire', 'Analitic SAGA', 'TVA', 'UM', 'Cont']}
        rows={articles.map((article: any) => [
          article.code,
          article.name,
          article.analyticCode || '—',
          VAT_RATE_LABELS[article.vatRate] ?? article.vatRate,
          article.unit,
          article.accountCode || '—',
        ])}
      />
    </div>
  );
}

function ManagementsCatalogue({
  onMessage,
}: {
  onMessage: (message: string) => void;
}) {
  const { data: managements = [] } = useManagementsQuery();
  const [create, { isLoading }] = useCreateManagementMutation();
  const [importManagements] = useImportManagementsMutation();
  const [form, setForm] = useState({
    code: '',
    name: '',
    analyticCode: '',
    type: 'CANTITATIV_VALORICA',
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await create(form).unwrap();
      setForm({ code: '', name: '', analyticCode: '', type: 'CANTITATIV_VALORICA' });
    } catch (error: any) {
      onMessage(apiError(error));
    }
  };
  return (
    <div className="p-5">
      <CsvImport
        label="Importă gestiuni (CSV)"
        hint="Coloane: cod, denumire, tip_gestiune, analitic"
        onImport={(file) => importManagements(file).unwrap()}
        onMessage={onMessage}
      />
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input className={fieldClass} placeholder="Cod gestiune" required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
        <input className={fieldClass} placeholder="Denumire" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input className={fieldClass} placeholder="Cod analitic" value={form.analyticCode} onChange={(event) => setForm({ ...form, analyticCode: event.target.value })} />
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Adaugă gestiune</button>
      </form>
      <CatalogueTable
        columns={['Cod', 'Denumire', 'Tip', 'Analitic']}
        rows={managements.map((management: any) => [
          management.code,
          management.name,
          management.type,
          management.analyticCode || '—',
        ])}
      />
    </div>
  );
}

function CsvImport({
  label,
  hint,
  onImport,
  onMessage,
}: {
  label: string;
  hint: string;
  onImport: (file: File) => Promise<ImportResult>;
  onMessage: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const handle = async (file?: File | null) => {
    if (!file) return;
    setBusy(true);
    setResult(null);
    onMessage('');
    try {
      setResult(await onImport(file));
    } catch (error: any) {
      onMessage(apiError(error));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="mb-4 rounded-xl border border-dashed border-line-strong bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.xml,text/csv,text/tab-separated-values,application/xml,text/xml"
          className="hidden"
          onChange={(event) => handle(event.target.files?.[0])}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="rounded-control border border-line-strong px-3 py-2 text-sm font-semibold text-ink-soft disabled:opacity-50"
        >
          {busy ? 'Se importă…' : label}
        </button>
        <p className="text-xs text-muted">{hint}</p>
      </div>
      {result && (
        <p className="mt-2 text-xs text-emerald-700">
          Import finalizat: {result.created} adăugate, {result.updated} actualizate din {result.total} rânduri.
          {(result.identifiersFilled ?? 0) > 0 &&
            ` ${result.identifiersFilled} numere de identificare completate.`}
          {result.errors.length > 0 && ` ${result.errors.length} rânduri ignorate.`}
        </p>
      )}
      {result && result.errors.length > 0 && (
        <ul className="mt-1 max-h-24 list-disc overflow-y-auto pl-5 text-xs text-amber-700">
          {result.errors.slice(0, 10).map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CatalogueTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: string[][];
}) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-muted">
          <tr>{columns.map((column) => <th key={column} className="px-3 py-2 font-semibold">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-line">
              {row.map((value, cell) => <td key={cell} className="px-3 py-2 text-ink-soft">{value}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="p-4 text-sm text-muted">Catalogul este gol.</p>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  type = 'text',
  className = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  className?: string;
}) {
  return (
    <label className={`text-xs font-medium text-muted ${className}`}>
      {label}
      <input
        type={type}
        required={required}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 block w-full ${fieldClass}`}
      />
    </label>
  );
}

function OwnPasswordForm() {
  const dispatch = useDispatch();
  const [changePassword, { isLoading }] = useChangePasswordMutation();
  const [form, setForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmation: '',
  });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setOk('');
    if (form.newPassword !== form.confirmation) {
      setError('Confirmarea nu coincide cu parola nouă.');
      return;
    }
    try {
      const credentials = await changePassword({
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      }).unwrap();
      dispatch(setCredentials(credentials));
      setForm({ currentPassword: '', newPassword: '', confirmation: '' });
      setOk('Parola a fost schimbată, iar sesiunile vechi nu mai pot fi reînnoite.');
    } catch (changeError: any) {
      setError(apiError(changeError));
    }
  };

  return (
    <section className="mt-5 rounded-card border border-line bg-white p-5">
      <h2 className="text-lg font-bold text-ink">Securitate</h2>
      <p className="mt-1 text-sm text-muted">
        Schimbă parola contului autentificat. Parola curentă este necesară.
      </p>
      <form onSubmit={submit} className="mt-4 grid gap-2.5 sm:grid-cols-3">
        <input
          className={fieldClass}
          type="password"
          autoComplete="current-password"
          placeholder="Parola curentă"
          value={form.currentPassword}
          onChange={(event) =>
            setForm({ ...form, currentPassword: event.target.value })
          }
          required
        />
        <input
          className={fieldClass}
          type="password"
          autoComplete="new-password"
          placeholder="Parola nouă (min. 8)"
          minLength={8}
          maxLength={72}
          value={form.newPassword}
          onChange={(event) =>
            setForm({ ...form, newPassword: event.target.value })
          }
          required
        />
        <input
          className={fieldClass}
          type="password"
          autoComplete="new-password"
          placeholder="Confirmă parola nouă"
          minLength={8}
          maxLength={72}
          value={form.confirmation}
          onChange={(event) =>
            setForm({ ...form, confirmation: event.target.value })
          }
          required
        />
        <div className="sm:col-span-3">
          <button
            disabled={isLoading}
            className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {isLoading ? 'Se schimbă…' : 'Schimbă parola mea'}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {ok && <p className="mt-2 text-sm text-emerald-700">{ok}</p>}
    </section>
  );
}

function AdminPasswordModal({
  user,
  onClose,
  onSuccess,
}: {
  user: any;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [updateUser, { isLoading }] = useUpdateUserMutation();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (password !== confirmation) {
      setError('Confirmarea nu coincide cu parola nouă.');
      return;
    }
    try {
      await updateUser({ id: user.id, body: { password } }).unwrap();
      onSuccess();
    } catch (updateError: any) {
      setError(apiError(updateError));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(15,15,25,0.5)] sm:items-center sm:p-5"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-t-2xl bg-white p-6 shadow-[0_20px_60px_-15px_rgba(20,20,40,0.4)] sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-ink">Schimbă parola</h2>
            <p className="mt-1 text-sm text-muted">
              {user.name} · {user.email}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-lg leading-none text-muted hover:text-ink"
            aria-label="Închide"
          >
            ✕
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Tokenurile de reînnoire existente ale utilizatorului vor fi revocate.
        </p>
        <div className="mt-4 space-y-2.5">
          <input
            className={`w-full ${fieldClass}`}
            type="password"
            autoComplete="new-password"
            placeholder="Parola nouă (min. 8)"
            minLength={8}
            maxLength={72}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoFocus
          />
          <input
            className={`w-full ${fieldClass}`}
            type="password"
            autoComplete="new-password"
            placeholder="Confirmă parola nouă"
            minLength={8}
            maxLength={72}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-control border border-line-strong py-2.5 text-sm font-semibold text-ink-soft"
          >
            Anulează
          </button>
          <button
            disabled={isLoading}
            className="flex-1 rounded-control bg-brand py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {isLoading ? 'Se salvează…' : 'Salvează parola'}
          </button>
        </div>
      </form>
    </div>
  );
}

function NewUserForm({ onError }: { onError: (message: string) => void }) {
  const [createUser, { isLoading }] = useCreateUserMutation();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'SALES',
  });
  const [ok, setOk] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    onError('');
    setOk('');
    try {
      await createUser(form).unwrap();
      setOk(`Cont creat pentru ${form.email}.`);
      setForm({ name: '', email: '', password: '', role: 'SALES' });
    } catch (error: any) {
      onError(apiError(error));
    }
  };

  return (
    <form onSubmit={submit} className="mt-4 rounded-card border border-line bg-white p-4">
      <h3 className="font-semibold text-ink">Adaugă utilizator</h3>
      <div className="mt-3 flex flex-wrap gap-2.5">
        <input className={fieldClass} placeholder="Nume" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
        <input className={fieldClass} type="email" placeholder="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
        <input className={fieldClass} type="password" placeholder="Parolă (min. 8)" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required minLength={8} />
        <select className={fieldClass} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
          {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
        </select>
        <button disabled={isLoading} className="rounded-control bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-50">
          Creează cont
        </button>
      </div>
      {ok && <p className="mt-2 text-sm text-emerald-700">{ok}</p>}
    </form>
  );
}

const fieldClass =
  'rounded-control border border-line-strong px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none';

function apiError(error: any): string {
  const body = error?.data;
  if (Array.isArray(body?.message)) return body.message.join(' · ');
  if (body?.message) return body.message;
  if (error?.status === 401) {
    return 'Sesiunea a expirat. Deconectează-te și autentifică-te din nou.';
  }
  if (error?.status === 'FETCH_ERROR') {
    return 'Backend-ul nu poate fi contactat. Verifică dacă serviciul API este pornit și publicat.';
  }
  if (error?.status === 'PARSING_ERROR') {
    const status = error?.originalStatus;
    if (typeof body === 'string' && /<!doctype html|<html[\s>]/i.test(body)) {
      return `Serverul frontend a returnat aplicația HTML pentru o cerere API${
        status ? ` (HTTP ${status})` : ''
      }. Configurează VITE_API_URL către backend și reconstruiește frontendul.`;
    }
    return status === 404
      ? 'Endpoint-ul solicitat nu există pe versiunea de backend publicată (HTTP 404).'
      : `Serverul a returnat un răspuns nevalid${status ? ` (HTTP ${status})` : ''}.`;
  }
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 240);
  return (
    error?.error ??
    error?.message ??
    `Acțiunea nu a putut fi finalizată${
      typeof error?.status === 'number' ? ` (HTTP ${error.status})` : ''
    }`
  );
}

function createRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `anaf-${uuid}`
    : `anaf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function compactErrorData(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 500);
  return value;
}
